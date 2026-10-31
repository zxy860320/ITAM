import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ZabbixCollector } from './collector/zabbixClient.js';
import { DbmpClient } from './collector/dbmpClient.js';
import { summary, topProblems, eventTrend, listFilter, paginate, byDomain, DOMAIN_LABEL } from './collector/aggregate.js';
import { GROUP_MAPPING } from './collector/mockData.js';
import { Notifier } from './alerter/alerter.js';
import { mountOps } from './ops/opsRoutes.js';
import { mountMcp } from './ai/mcpServer.js';
import { AssetStore } from './assets/assetStore.js';
import { mountAssets } from './assets/assetRoutes.js';

const PORT = process.env.PORT || 8787;
// 数据源开关：mock | zabbix（真实 Zabbix JSON-RPC 2.0）
// 持久化：data/source.json 保存对接页配置（含 token），重启后自动恢复，不再丢配置
const SRC_CFG = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'source.json');
const DS = {
  mode: process.env.DS_MODE || 'mock',
  endpoint: process.env.ZBX_ENDPOINT || 'http://10.0.0.10/zabbix/api_jsonrpc.php',
  token: process.env.ZBX_TOKEN || '',
  freq: Number(process.env.COLLECT_FREQ || 60),
};
// zCloud(dbmp) 北向API 数据源配置 —— 补齐「数据库」域（Zabbix 现网无 DB 模板）
// 实测通道：GET :8023/dbaasInfrastructure/customApi/getDbInfo|getCustomInfo（免鉴权，见 tmp/dbmp_integration_analysis.md）
const DBMP = {
  enabled: (process.env.DBMP_ENABLED || '1') !== '0',
  base: process.env.DBMP_BASE || 'http://10.70.0.94:8023',
};
try {
  const c = JSON.parse(fs.readFileSync(SRC_CFG, 'utf-8'));
  Object.assign(DS, { mode: c.mode ?? DS.mode, endpoint: c.endpoint ?? DS.endpoint, token: c.token ?? DS.token, freq: c.freq ?? DS.freq });
  if (c.dbmp) Object.assign(DBMP, { enabled: c.dbmp.enabled ?? DBMP.enabled, base: c.dbmp.base ?? DBMP.base });
  console.log(`[ityw-server] 已加载持久化数据源配置: mode=${DS.mode} endpoint=${DS.endpoint} dbmp=${DBMP.enabled ? DBMP.base : 'off'}`);
} catch { /* 首次运行无配置文件 */ }
function persistSource() {
  try {
    fs.mkdirSync(path.dirname(SRC_CFG), { recursive: true });
    fs.writeFileSync(SRC_CFG, JSON.stringify({ mode: DS.mode, endpoint: DS.endpoint, token: DS.token, freq: DS.freq, dbmp: DBMP }, null, 2));
  } catch (e) { console.warn('[ityw-server] source.json 持久化失败:', e.message); }
}

const collector = new ZabbixCollector(DS);
// 告警出口：钉钉/飞书/企业微信/邮件。配置持久化 data/notify.json，差分状态 data/notify_state.json
const NOTIFY_CFG = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'notify.json');
const notifier = new Notifier(NOTIFY_CFG, path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'notify_state.json'));
/** 事件→主机可读名（告警消息用） */
function evHostName(ev) {
  const ds = collector.dataset;
  if (!ds) return '';
  const ent = ds.hosts.find(h => h.hostid === ev.hostid) || ds.services.find(s => s.serviceid === ev.hostid || s.serviceid === ev.objectid);
  return ent ? (ent.name || ent.host || '') : '';
}
const dbmp = new DbmpClient({
  base: DBMP.base, enabled: DBMP.enabled, freq: DS.freq,
  sampleFile: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'dbmp_samples.json'),
});

/** 主数据源（Zabbix/mock）+ dbmp 数据库域实体合并视图 */
function mergedData() {
  const ds = collector.data;
  if (!dbmp.enabled || !dbmp.entities.length) return ds;
  return { ...ds, hosts: [...ds.hosts, ...dbmp.entities] };
}
const isDbmpId = id => String(id).startsWith('dbmp-');

const app = express();
app.use(express.json());
app.use((req, res, next) => { res.set('Access-Control-Allow-Origin', '*'); next(); });

const guard = (req, res, next) => {
  if (!collector.dataset) return res.status(503).json({ error: 'collector syncing, retry' });
  next();
};

// ---------- 总览 / 大屏 ----------
app.get('/api/summary', guard, (req, res) => {
  const ds = mergedData();
  res.json({
    ...summary(ds),
    collector: {
      mode: collector.mode, freq: collector.freq,
      lastSync: collector.lastSync, syncCount: collector.syncCount, lastError: collector.lastError,
    },
  });
});

app.get('/api/dashboard', guard, (req, res) => {
  const ds = mergedData();
  res.json({
    ...summary(ds),
    collector: {
      mode: collector.mode, freq: collector.freq,
      lastSync: collector.lastSync, syncCount: collector.syncCount, lastError: collector.lastError,
    },
    topProblems: topProblems(ds, 10),
    eventTrend: eventTrend(ds, 24),
    recent: [...ds.events].sort((a, b) => b.clock - a.clock).slice(0, 15),
    topCpu: [...ds.hosts].filter(h => h.status === 'on' && h.cpu != null).sort((a, b) => b.cpu - a.cpu).slice(0, 8)
      .map(h => ({ name: h.name, domain: h.domain, cpu: h.cpu, mem: h.mem })),
    topRt: [...ds.services].filter(s => s.status === 'up' && s.rt).sort((a, b) => b.rt - a.rt).slice(0, 8)
      .map(s => ({ name: s.label || s.name, rt: s.rt, qps: s.qps })),
  });
});

// ---------- 实体列表（主机/网络/数据库/服务 通用） ----------
app.get('/api/entities', guard, (req, res) => {
  const ds = mergedData();
  const all = [...ds.hosts, ...ds.services];
  const filtered = listFilter(all, req.query);
  const sorted = filtered.sort((a, b) => {
    const rank = x => x.availability === 'critical' ? 0 : x.availability === 'warning' ? 1 : 2;
    return rank(a) - rank(b) || (b.problems - a.problems) || a.name.localeCompare(b.name);
  });
  res.json(paginate(sorted, Number(req.query.page || 1), Number(req.query.size || 20)));
});

// ---------- 单实体详情 + 时序 ----------
app.get('/api/entities/:id', guard, (req, res) => {
  const ds = mergedData();
  const ent = [...ds.hosts, ...ds.services].find(x => x.hostid === req.params.id || x.serviceid === req.params.id);
  if (!ent) return res.status(404).json({ error: 'not found' });
  // 生成近 6 小时分钟级时序（借用确定性 rng 保证刷新稳定）
  res.json({ entity: ent, events: ds.events.filter(e => (e.hostid || e.objectid) === (ent.hostid || ent.serviceid)).slice(0, 20) });
});

// ---------- 设备深度详情（Zabbix 按需实时拉取：档案/接口/全监控项/6h时序；dbmp 实体走 DB 专属详情） ----------
app.get('/api/entities/:id/detail', guard, async (req, res) => {
  const ds = mergedData();
  const ent = [...ds.hosts, ...ds.services].find(x => x.hostid === req.params.id || x.serviceid === req.params.id);
  if (!ent) return res.status(404).json({ error: 'not found' });
  // dbmp（zCloud）数据库实体：详情来自北向API实时快照，不走 mock 兜底（避免伪造）
  if (isDbmpId(req.params.id)) {
    const d = dbmp.detail(req.params.id.slice(5));
    if (d) return res.json({ detail: d });
    return res.json({ detail: { kind: 'db', source: 'zCloud(dbmp) 北向API', profile: { instanceName: ent.name, hostIp: ent.ip, dbType: ent.dbType, version: ent.version, dbRole: ent.dbRole, dbState: ent.dbState }, keyStatus: [], config: {}, databases: [], users: [], allStatusVars: [], allConfigVars: [], note: '该集群暂无 getCustomInfo 快照数据' } });
  }
  try {
    const detail = await collector.detail(req.params.id);
    // mock 模式（detail 返回 null）→ 从本地数据集拼一份轻量详情，保证 UI 不空
    res.json({ detail: detail || mockDetail(ent) });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e), detail: mockDetail(ent) });
  }
});

function mockDetail(ent) {
  const line = (base, jit) => Array.from({ length: 60 }, (_, i) => ({ t: Date.now() - (59 - i) * 60e3, v: +Math.max(0, base + (Math.random() - 0.5) * jit).toFixed(2) }));
  return {
    profile: { sysName: ent.host || ent.name, model: ent.os || '', swOs: '', location: ent.location || '', descr: '', serial: '', contact: '', uname: '', arch: '', cpuNum: '', memTotal: '', memAvail: '', processes: '', temp: '' },
    netIfs: [], itemCount: 0, interfaces: [],
    series: {
      cpu: line(ent.cpu ?? 30, 30),
      mem: line(ent.mem ?? 50, 20),
      ping: line(2, 3),
    },
    items: [
      { name: 'CPU utilization', key: 'system.cpu.util', value: String(ent.cpu ?? ''), units: '%', lastclock: Date.now(), valueType: 0 },
      { name: 'Memory utilization', key: 'vm.memory.util', value: String(ent.mem ?? ''), units: '%', lastclock: Date.now(), valueType: 0 },
    ],
  };
}

// ---------- 时间窗时序（range=6h/24h/7d/30d；till=结束锚点秒，回看过去某段；iface=流量接口；dev=磁盘设备；mnt=磁盘分区挂载点） ----------
app.get('/api/entities/:id/series', guard, async (req, res) => {
  const ds = mergedData();
  const ent = [...ds.hosts, ...ds.services].find(x => x.hostid === req.params.id || x.serviceid === req.params.id);
  if (!ent) return res.status(404).json({ error: 'not found' });
  const range = String(req.query.range || '6h');
  const till = Number(req.query.till || 0);
  const iface = String(req.query.iface || '');
  const dev = String(req.query.dev || '');
  const mnt = String(req.query.mnt || '');
  const ap = String(req.query.ap || '');
  // dbmp 实体：本地真实采样差值序列（不调 Zabbix、不走 mockSeries 伪造）
  if (isDbmpId(req.params.id)) {
    return res.json({ series: dbmp.series(req.params.id.slice(5), range, till) });
  }
  try {
    const s = await collector.series(req.params.id, range, till, iface, dev, mnt, ap);
    res.json({ series: s || mockSeries(ent, range, till, iface, dev, mnt) });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e), series: mockSeries(ent, range, till, iface, dev, mnt) });
  }
});

function mockSeries(ent, range, till, iface, dev, mnt) {
  const SPAN = { '6h': 6 * 3600, '24h': 24 * 3600, '7d': 7 * 86400, '30d': 30 * 86400 };
  const span = SPAN[range] || SPAN['6h'];
  const now = Math.floor(Date.now() / 1000);
  const t2 = Math.min(Math.max(0, Math.floor(+till || 0)), now) || now;
  const t1 = t2 - span;
  const step = span > 86400 ? 3600 : Math.max(60, Math.floor(span / 120));
  const mk = (base, jit, withBand) => {
    const avg = [], max = [], min = [];
    for (let c = t1; c <= t2; c += step) {
      const v = Math.max(0, base + Math.sin(c / 5000) * jit + (Math.random() - 0.5) * jit * 0.4);
      avg.push({ t: c * 1000, v: +v.toFixed(2) });
      if (withBand) { max.push(+(v + jit * 0.3).toFixed(2)); min.push(+Math.max(0, v - jit * 0.3).toFixed(2)); }
    }
    return withBand ? { avg, max, min } : { avg };
  };
  const band = span > 86400;
  const empty = band ? { avg: [], max: [], min: [] } : { avg: [] };
  const isNet = ent.domain === 'network';
  const dioDev = dev || 'vda';
  const mntList = !isNet && ent.disk != null
    ? [{ mnt: '/', label: 'FS [/]: Space: Used, in %', cur: ent.disk }, { mnt: '/data', label: 'FS [/data]: Space: Used, in %', cur: Math.min(99, (ent.disk ?? 0) + 5) }]
    : [];
  const fsMnt = mnt || (mntList[0]?.mnt || '');
  const fsBase = mnt ? (mntList.find(x => x.mnt === mnt)?.cur ?? ent.disk) : ent.disk;
  const series = {
    cpu: ent.cpu == null ? empty : mk(ent.cpu, 20, band),
    mem: ent.mem == null ? empty : mk(ent.mem, 15, band),
    temp: !isNet ? empty : mk(55, 8, band),
    load: isNet ? empty : mk(1.2, 0.8, band),
    proc: isNet ? empty : mk(420, 60, band),
    fs: fsBase == null ? empty : mk(fsBase, 3, band),
    ping: ent.ping == null ? empty : mk(3, 2, band),
    traffic: {
      iface: iface || 'eth0', label: iface || 'eth0',
      in: isNet ? mk(240e6, 120e6, band) : empty,
      out: isNet ? mk(180e6, 90e6, band) : empty,
    },
    dio: {
      dev: dioDev,
      read: !isNet && ent.disk != null ? mk(35, 30, band) : empty,
      write: !isNet && ent.disk != null ? mk(60, 50, band) : empty,
    },
  };
  return {
    window: { from: t1 * 1000, to: t2 * 1000, range },
    grain: band ? 'hour' : 'raw',
    points: ['cpu', 'mem', 'temp', 'load', 'proc', 'fs', 'ping']
      .reduce((n, k) => n + (series[k]?.avg?.length || 0), 0)
      + (series.traffic.in.avg?.length || 0) + (series.traffic.out.avg?.length || 0)
      + (series.dio.read.avg?.length || 0) + (series.dio.write.avg?.length || 0),
    retention: { history: '31d', trends: '365d' },
    meta: { fs: { label: mntList.find(x => x.mnt === fsMnt)?.label || '磁盘使用', units: '%', mnt: fsMnt }, traffic: { units: 'bps' }, dio: { units: 'ops/s' } },
    ifaces: isNet ? [{ iface: 'eth0', label: 'eth0' }, { iface: 'eth1', label: 'eth1' }] : [],
    devs: !isNet && ent.disk != null ? [{ dev: 'vda' }, { dev: 'vdb' }] : [],
    mnts: mntList,
    series,
  };
}

// ---------- 告警 ----------
app.get('/api/events', guard, (req, res) => {
  const ds = collector.data;
  let evs = [...ds.events];
  if (req.query.severity) evs = evs.filter(e => e.severity === req.query.severity);
  if (req.query.status) evs = evs.filter(e => e.status === req.query.status);
  // wlan 伪域过滤：事件本身不带 wlan 标记，按主机集合映射（与列表拆分口径一致）
  const dq = String(req.query.domain || '');
  if (dq === 'wlan' || dq === 'network') {
    const wlanIds = new Set(collector.data.hosts.filter(h => h.domain === 'network' && h.wlan).map(h => h.hostid));
    evs = evs.filter(e => e.domain === 'network' && (dq === 'wlan' ? wlanIds.has(e.hostid) : !wlanIds.has(e.hostid)));
  } else if (dq) evs = evs.filter(e => e.domain === dq);
  res.json(paginate(evs.sort((a, b) => b.clock - a.clock), Number(req.query.page || 1), Number(req.query.size || 20)));
});

app.post('/api/events/:id/ack', guard, (req, res) => {
  const ev = collector.data.events.find(e => e.eventid === req.params.id);
  if (!ev) return res.status(404).json({ error: 'not found' });
  ev.status = 'acked';
  ev.ackBy = req.body?.user || 'operator';
  res.json({ ok: true, event: ev });
});

// ---------- 告警出口（钉钉/飞书/企业微信/邮件） ----------
app.get('/api/notify', (req, res) => res.json(notifier.publicView()));

app.post('/api/notify/save', (req, res) => {
  try {
    notifier.saveConfig(req.body || {});
    res.json({ ok: true, channels: notifier.cfg.channels.length, enabled: notifier.cfg.enabled });
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

app.post('/api/notify/test', async (req, res) => {
  try {
    const r = await notifier.testChannel(String(req.body?.id || ''));
    res.json(r);
  } catch (e) { res.status(502).json({ ok: false, error: String(e.message || e) }); }
});

// ---------- 监控源对接 ----------
app.get('/api/source', (req, res) => {
  res.json({
    mode: collector.mode,
    endpoint: collector.mode === 'zabbix' ? collector.endpoint : '(mock 数据源)',
    version: collector.mode === 'zabbix'
      ? (collector.version ? `Zabbix ${collector.version}` : 'Zabbix（版本待探测）')
      : 'Mock v1（对齐 Zabbix 7.2.5 基线）',
    freq: collector.freq,
    lastSync: collector.lastSync, syncCount: collector.syncCount, lastError: collector.lastError,
    classifyStats: collector.classifyStats,
    mapping: collector.groupMapping || GROUP_MAPPING,
    // 数据库域数据源：zCloud(dbmp) 北向API
    dbmp: {
      enabled: dbmp.enabled, base: DBMP.base,
      lastSync: dbmp.lastSync, syncCount: dbmp.syncCount, lastError: dbmp.lastError,
      instances: dbmp.entities.length, counts: dbmp.counts,
    },
  });
});

app.post('/api/source/test', async (req, res) => {
  const t0 = Date.now();
  const r = await collector.sync();
  const dr = await dbmp.sync().catch(e => ({ ok: false, error: String(e.message || e) }));
  res.json({ ...r, latencyMs: Date.now() - t0, counts: collector.dataset ? {
    hosts: collector.dataset.hosts.length, services: collector.dataset.services.length,
    events: collector.dataset.events.length,
  } : null, dbmp: { ...dr, instances: dbmp.entities.length, counts: dbmp.counts } });
});

app.post('/api/source/save', (req, res) => {
  const { mode, endpoint, token, freq, dbmp: dbmpCfg } = req.body || {};
  if (mode) collector.mode = DS.mode = mode === 'zabbix' ? 'zabbix' : 'mock';
  if (endpoint) collector.endpoint = DS.endpoint = endpoint;
  if (token) collector.token = DS.token = token;
  if (freq) collector.freq = DS.freq = Math.max(30, Math.min(120, Number(freq)));
  if (dbmpCfg && typeof dbmpCfg === 'object') {
    if (typeof dbmpCfg.enabled === 'boolean') { DBMP.enabled = dbmpCfg.enabled; dbmp.enabled = dbmpCfg.enabled; }
    if (dbmpCfg.base) DBMP.base = dbmp.base = String(dbmpCfg.base).replace(/\/+$/, '');
  }
  persistSource();
  res.json({ ok: true, mode: collector.mode, freq: collector.freq, dbmp: DBMP });
});

// ---------- 设备操作（经跳板机 JumpServer MCP：配置备份/只读巡检） ----------
const opsHandle = mountOps(app, { notifier });

// ---------- 资产管理（台账 + 加密凭据；数据 data/assets.json，密钥 data/cred.key 或 ITYW_CRED_KEY） ----------
const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const assetStore = new AssetStore(DATA_DIR);
mountAssets(app, { store: assetStore, mergedData });

// ---------- AI 工具层（MCP Streamable HTTP，供 Open WebUI 等客户端调用） ----------
mountMcp(app, { collector, dbmp, ops: opsHandle, assets: assetStore });

// AI 助手前端配置：内嵌 Open WebUI 的地址（前端 iframe 用）。
// AI_ASSISTANT_URL 未设时前端按 http://<当前主机>:<AI_ASSISTANT_PORT 默认3001> 拼装
app.get('/api/ai/config', (req, res) => {
  res.json({
    enabled: (process.env.AI_ENABLED || '1') !== '0',
    url: process.env.AI_ASSISTANT_URL || '',
    port: Number(process.env.AI_ASSISTANT_PORT || 3001),
    mcpEndpoint: '/mcp',
  });
});

// ---------- 系统管理 ----------
app.get('/api/system', (req, res) => {
  res.json({
    roles: [
      { role: 'admin',    label: '管理员',   perms: ['查看', '确认告警', '配置监控源', '用户管理'] },
      { role: 'operator', label: '运维员',   perms: ['查看', '确认告警', '重启服务(模拟)'] },
      { role: 'viewer',   label: '只读用户', perms: ['查看'] },
      { role: 'auditor',  label: '审计员',   perms: ['查看', '导出审计日志'] },
    ],
    auditLog: [
      { at: Date.now() - 3600e3 * 1.2, user: '张伟(admin)',    action: '确认告警 EVT-300004' },
      { at: Date.now() - 3600e3 * 2.5, user: '李娜(admin)',    action: '修改采集频率 120s→60s' },
      { at: Date.now() - 3600e3 * 5.0, user: 'system',         action: '群组映射同步完成（5 条）' },
      { at: Date.now() - 3600e3 * 8.2, user: '王强(operator)', action: '重启服务 svc-19-短信通道（模拟）' },
      { at: Date.now() - 3600e3 * 26,  user: '李娜(admin)',    action: '新增监控源 zbx-prod-01' },
    ],
  });
});

// ---------- 启动 ----------
async function main() {
  await collector.sync();
  dbmp.sync().then(r => console.log(`[ityw-server] dbmp(zCloud) 采集: ${r.ok ? `ok 实例=${r.instances ?? 0}` : `失败: ${r.error}`}`)).catch(() => {});
  setInterval(() => collector.sync().then(r => {
    // 每轮采集后对活动告警差分推送（首轮只建基线不补发；失败不影响采集主链路）
    if (r?.ok && collector.dataset) notifier.diffAndSend(collector.dataset.events, evHostName).catch(() => {});
  }).catch(() => {}), collector.freq * 1000);
  setInterval(() => dbmp.sync().catch(() => {}), Math.max(collector.freq, 60) * 1000);
  app.listen(PORT, () => console.log(`[ityw-server] http://localhost:${PORT}  dataSource=${DS.mode} dbmp=${DBMP.enabled ? DBMP.base : 'off'} notify=${notifier.cfg.enabled ? notifier.cfg.channels.filter(c => c.enabled).length + '通道' : 'off'}`));
}
main();

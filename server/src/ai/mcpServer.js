// /mcp —— ITYW 对 AI 暴露的工具层（MCP Streamable HTTP，无状态、零第三方依赖）
// 设计：
//  1) 手写 JSON-RPC 2.0（initialize / tools/list / tools/call），不引入 SDK——依赖面最小、行为可控；
//  2) 工具全部是对现有内部数据的只读/受控封装：监控快照走 collector 内存（不另打 Zabbix），
//     备份/diff 走 ops store（出接口内容一律脱敏，与 Web 同一红线）；
//  3) 写操作只有「一键备份」（复用 /api/ops/backup 的防抖与入库口径），不做任何设备配置修改能力；
//  4) 每次 tools/call 打审计日志（工具名/参数摘要/耗时），与 ops 审计同源习惯。
// Open WebUI 侧配置：Settings > Admin > Integrations > External Tool Servers，
//   Type = MCP (Streamable HTTP)，URL = http://server:8787/mcp，Auth = None。
//   可选 ITYW_MCP_TOKEN 环境变量开启 Bearer 鉴权（OWUI 侧 Auth 选 Bearer 填同一 key）。
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { summary, topProblems, listFilter, DOMAIN_LABEL } from '../collector/aggregate.js';
import { redact } from '../ops/config.js';

const p = sub => fileURLToPath(new URL(sub, import.meta.url));
const AUDIT_FILE = p('../../data/ai_audit.jsonl');

function audit(entry) {
  try {
    fs.mkdirSync(path.dirname(AUDIT_FILE), { recursive: true });
    fs.appendFileSync(AUDIT_FILE, JSON.stringify({ at: Date.now(), ...entry }) + '\n');
  } catch { /* 审计失败不影响调用 */ }
}

const TOOL_DEFS = [
  {
    name: 'monitor_summary',
    description: '监控总览：各域（服务器/网络设备/无线网络/数据库/服务）实体数与健康分布、活动告警总数、采集器状态。回答"现在整体状况怎么样"先调这个。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'query_events',
    description: '查询告警事件。domain 可选 server/network/wlan/database/service；severity 可选 critical/severe/warning/info；status 可选 active/acked/resolved。返回按时间倒序。',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', enum: ['server', 'network', 'wlan', 'database', 'service'] },
        severity: { type: 'string', enum: ['critical', 'severe', 'warning', 'info'] },
        status: { type: 'string', enum: ['active', 'acked', 'resolved'], description: '默认 active' },
        limit: { type: 'number', description: '最多返回条数，默认 20，上限 100' },
      },
    },
  },
  {
    name: 'query_devices',
    description: '查询设备/主机/数据库实例列表。domain 同上；q 按名称或 IP 模糊搜索；availability 可选 critical/warning/healthy。返回名称、IP、分组、健康度、活动告警数。',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', enum: ['server', 'network', 'wlan', 'database', 'service'] },
        q: { type: 'string', description: '名称/IP 关键词' },
        availability: { type: 'string', enum: ['critical', 'warning', 'healthy'] },
        limit: { type: 'number', description: '默认 20，上限 100' },
      },
    },
  },
  {
    name: 'device_detail',
    description: '单设备实时详情：按 hostid（如 "10919"）或 IP 或名称精确查找一台设备，返回型号、位置、系统、ping 连通、CPU/内存、活动告警摘要。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'hostid / IP / 名称' } },
      required: ['id'],
    },
  },
  {
    name: 'backup_history',
    description: '设备配置备份历史（经跳板机）。assetKey 传设备 IP（推荐）或名称；不传则列出所有设备最近一次备份。',
    inputSchema: {
      type: 'object',
      properties: { assetKey: { type: 'string' }, limit: { type: 'number', description: '默认 20，上限 200' } },
    },
  },
  {
    name: 'backup_diff',
    description: '比对两份配置备份的差异（行级 diff，已脱敏，密文不会出现）。a/b 为备份记录 id（backup_history 可查）。回答"这台设备配置最近变过吗/改了什么"用这个。',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'string' } },
      required: ['a', 'b'],
    },
  },
  {
    name: 'backup_device_now',
    description: '立即备份一台设备的配置（经跳板机执行只读命令 display current-configuration，不修改设备）。参数 asset=设备 IP（推荐）或名称。与监控页「备份」按钮同一通道。',
    inputSchema: {
      type: 'object',
      properties: { asset: { type: 'string', description: '设备 IP 或名称' } },
      required: ['asset'],
    },
  },
];

// 资产台账工具（assets store 存在时启用）：只读台账元数据，永不返回账号密码
const ASSET_TOOL_DEF = {
  name: 'query_assets',
  description: '查询资产台账（CMDB）：类别含服务器/网络设备/虚拟机/数据库/电脑终端/办公软件/Web服务。type 按类别过滤；q 按名称/IP/负责人模糊搜索。返回名称、IP、型号、位置、负责人、环境、状态、凭据数量——不含任何账号密码。',
  inputSchema: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['server', 'network', 'vm', 'database', 'pc', 'office', 'web', 'other'] },
      q: { type: 'string', description: '名称/IP/负责人 关键词' },
    },
  },
};

export function mountMcp(app, { collector, dbmp, ops, assets }) {
  const TOKEN = process.env.ITYW_MCP_TOKEN || '';

  function merged() {
    const ds = collector.data;
    if (!dbmp.enabled || !dbmp.entities.length) return ds;
    return { ...ds, hosts: [...ds.hosts, ...dbmp.entities] };
  }

  // ---------- 工具实现（返回给 LLM 的都是瘦身后的纯数据，绝不回原始大对象） ----------
  const TOOL_IMPL = {
    monitor_summary() {
      if (!collector.dataset) throw new Error('采集器尚未完成首轮采集');
      const ds = merged();
      const s = summary(ds);
      return {
        domains: s.domains.map(d => ({ domain: DOMAIN_LABEL[d.domain] || d.domain, total: d.total, healthy: d.healthy, warning: d.warning, critical: d.critical })),
        problemsActive: s.totals.problemsActive,
        collector: { mode: collector.mode, lastSync: new Date(collector.lastSync).toISOString(), lastError: collector.lastError || null },
        topProblems: topProblems(ds, 8).map(e => ({ severity: e.severity, host: ds.hosts.find(h => h.hostid === e.hostid)?.name || e.hostid, message: e.message, at: new Date(e.clock).toISOString() })),
      };
    },
    query_events(a) {
      if (!collector.dataset) throw new Error('采集器尚未完成首轮采集');
      let evs = [...collector.data.events];
      if (a.status) evs = evs.filter(e => e.status === a.status); else evs = evs.filter(e => e.status !== 'resolved');
      if (a.severity) evs = evs.filter(e => e.severity === a.severity);
      const dq = a.domain || '';
      if (dq === 'wlan' || dq === 'network') {
        const wlanIds = new Set(collector.data.hosts.filter(h => h.domain === 'network' && h.wlan).map(h => h.hostid));
        evs = evs.filter(e => e.domain === 'network' && (dq === 'wlan' ? wlanIds.has(e.hostid) : !wlanIds.has(e.hostid)));
      } else if (dq) evs = evs.filter(e => e.domain === dq);
      const limit = Math.min(100, a.limit || 20);
      const rows = evs.sort((x, y) => y.clock - x.clock).slice(0, limit)
        .map(e => ({ eventid: e.eventid, severity: e.severity, status: e.status, domain: e.domain, host: collector.data.hosts.find(h => h.hostid === e.hostid)?.name || e.hostid, message: e.message, at: new Date(e.clock).toISOString() }));
      return { total: evs.length, returned: rows.length, events: rows };
    },
    query_devices(a) {
      if (!collector.dataset) throw new Error('采集器尚未完成首轮采集');
      const ds = merged();
      const all = [...ds.hosts, ...ds.services];
      let out = listFilter(all, { domain: a.domain, q: a.q, availability: a.availability });
      const rank = x => x.availability === 'critical' ? 0 : x.availability === 'warning' ? 1 : 2;
      out = out.sort((x, y) => rank(x) - rank(y) || (y.problems - x.problems) || String(x.name).localeCompare(String(y.name)));
      const limit = Math.min(100, a.limit || 20);
      return {
        total: out.length, returned: Math.min(limit, out.length),
        devices: out.slice(0, limit).map(h => ({
          hostid: h.hostid || h.serviceid, name: h.name, ip: h.ip || '', domain: h.wlan ? 'wlan' : h.domain, group: h.group || '',
          availability: h.availability, problems: h.problems, os: h.os || '', model: h.model || '',
          ...(h.wlan ? { apTotal: h.apTotal, apStates: h.apStates, wlanUsers: h.wlanUsers } : {}),
        })),
      };
    },
    device_detail(a) {
      if (!collector.dataset) throw new Error('采集器尚未完成首轮采集');
      const ds = merged();
      const key = String(a.id || '');
      const ent = [...ds.hosts, ...ds.services].find(x => (x.hostid || x.serviceid) === key || x.ip === key || x.name === key);
      if (!ent) return { found: false, hint: '未找到设备。可先用 query_devices 按名称/IP 搜索。' };
      const evs = ds.events.filter(e => (e.hostid || e.objectid) === (ent.hostid || ent.serviceid) && e.status !== 'resolved');
      return {
        found: true,
        hostid: ent.hostid || ent.serviceid, name: ent.name, ip: ent.ip || '', domain: ent.wlan ? 'wlan' : ent.domain, group: ent.group || '',
        availability: ent.availability, os: ent.os || '', model: ent.model || '', location: ent.location || '',
        ping: ent.ping, pingMs: ent.pingMs, pingLoss: ent.pingLoss, cpu: ent.cpu, mem: ent.mem, uptimeDays: ent.uptimeDays,
        ...(ent.wlan ? { apTotal: ent.apTotal, apStates: ent.apStates, wlanUsers: ent.wlanUsers } : {}),
        activeProblems: evs.length,
        problemSample: evs.sort((x, y) => y.clock - x.clock).slice(0, 6).map(e => ({ severity: e.severity, message: e.message, at: new Date(e.clock).toISOString() })),
      };
    },
    backup_history(a) {
      if (!ops.jmsConfigured()) return { error: '跳板机 MCP 未配置，暂无备份数据' };
      if (a.assetKey) {
        const limit = Math.min(200, a.limit || 20);
        return {
          items: ops.list({ assetKey: String(a.assetKey), limit }).map(x => ({
            id: x.id, at: new Date(x.at).toISOString(), assetKey: x.assetKey, assetName: x.assetName, changed: x.changed, bytes: x.bytes, sha1: x.sha1.slice(0, 12),
          })),
        };
      }
      const meta = ops.meta();
      return {
        latestByAsset: Object.entries(meta.byAsset).map(([k, v]) => ({
          assetKey: k, at: new Date(v.at).toISOString(), id: v.id, changed: v.changed, bytes: v.bytes,
        })).sort((x, y) => new Date(y.at) - new Date(x.at)),
      };
    },
    backup_diff(a) {
      const d = ops.diff(String(a.a || ''), String(a.b || ''));
      if (!d.ok) return { error: d.error };
      // 与 Web 同一红线：逐行脱敏后出接口
      return {
        same: d.same, added: d.added, removed: d.removed, truncated: d.truncated,
        a: { id: d.a.id, assetName: d.a.assetName, at: new Date(d.a.at).toISOString() },
        b: { id: d.b.id, assetName: d.b.assetName, at: new Date(d.b.at).toISOString() },
        lines: d.lines.slice(0, 400).map(x => ({ t: x.t, na: x.na, nb: x.nb, l: redact(x.l) })),
      };
    },
    query_assets(a) {
      if (!assets) throw new Error('资产台账未启用');
      const rows = assets.mcpList({ type: a.type, q: a.q });
      return { total: rows.length, assets: rows, note: '台账含凭据时 credCount>0；账号密码不通过本工具提供（安全红线）' };
    },
    async backup_device_now(a) {
      const r = await ops.backup(String(a.asset || '')); // ops.backup 内部含 未配置400/参数400/并发409 校验
      return {
        ok: true, asset: r.asset, command: r.command, elapsedMs: r.elapsedMs,
        backup: r.backup ? { id: r.backup.id, changed: r.backup.changed, sha1: r.backup.sha1.slice(0, 12), bytes: r.backup.bytes } : null,
        note: '备份全文只存服务器磁盘，本接口不返回内容；需要差异请用 backup_diff',
      };
    },
  };

  // ---------- JSON-RPC over Streamable HTTP（无状态：每个 POST 独立响应） ----------
  const PROTOCOL_FALLBACK = '2024-11-05';
  /** 返回 JSON-RPC 响应对象；notification 返回 null（endpoint 层回 202） */
  async function handleRpc(req, msg) {
    const { id, method, params } = msg || {};
    const wrap = r => (id == null ? null : { jsonrpc: '2.0', id, ...r });
    const err = (code, message) => wrap({ error: { code, message } });
    if (method?.startsWith('notifications/')) return null;
    try {
      if (method === 'initialize') {
        return wrap({ result: {
          protocolVersion: params?.protocolVersion || PROTOCOL_FALLBACK,
          capabilities: { tools: {} },
          serverInfo: { name: 'ityw-monitor', version: '1.0.0' },
          instructions: 'ITYW 运维监控平台工具集：监控总览/告警/设备查询走实时采集快照；备份与 diff 走跳板机备份库（内容已脱敏）。备份设备配置是只读操作可直接执行；本工具集不提供任何修改设备配置的能力。回答告警问题时优先引用 message 原文，不要编造数值。',
        } });
      }
      if (method === 'ping') return wrap({ result: {} });
      if (method === 'tools/list') return wrap({ result: { tools: assets ? [...TOOL_DEFS, ASSET_TOOL_DEF] : TOOL_DEFS } });
      if (method === 'tools/call') {
        const name = params?.name;
        const impl = TOOL_IMPL[name];
        if (!impl) return err(-32602, `未知工具: ${name}`);
        const t0 = Date.now();
        const args = params?.arguments || {};
        try {
          const out = await impl(args);
          audit({ via: 'mcp', tool: name, args: String(JSON.stringify(args)).slice(0, 200), ms: Date.now() - t0, user: String(req.headers['x-openwebui-user-name'] || '') });
          return wrap({ result: { content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out, null, 1) }], isError: false } });
        } catch (e) {
          audit({ via: 'mcp', tool: name, args: String(JSON.stringify(args)).slice(0, 200), ms: Date.now() - t0, error: String(e.message || e) });
          // 工具级错误走 result.isError（MCP 规范），LLM 能看到并自我修正
          return wrap({ result: { content: [{ type: 'text', text: `工具执行失败: ${e.message || e}` }], isError: true } });
        }
      }
      return err(-32601, `method not found: ${method}`);
    } catch (e) {
      return err(-32603, String(e.message || e));
    }
  }

  app.get('/mcp', (req, res) => res.status(405).json({ name: 'ityw-monitor-mcp', hint: 'MCP Streamable HTTP：POST JSON-RPC 到本地址' }));

  app.post('/mcp', async (req, res) => {
    if (TOKEN) {
      const auth = String(req.headers.authorization || '');
      if (!auth.endsWith(TOKEN)) return res.status(401).json({ error: 'unauthorized' });
    }
    const msg = req.body;
    if (Array.isArray(msg)) {
      const results = (await Promise.all(msg.map(m => handleRpc(req, m)))).filter(Boolean);
      return res.json(results.length ? results : []);
    }
    const out = await handleRpc(req, msg);
    if (out === null) return res.status(202).end();
    res.json(out);
  });
}

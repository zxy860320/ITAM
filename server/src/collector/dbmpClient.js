// ============================================================
// DbmpClient —— zCloud(dbmp v6.7.2) 北向 API 数据源，补齐「数据库」域监控
import fs from 'fs';
import path from 'path';
// 通道（2026-10-26 实测，全文 .workbuddy/tmp/dbmp_integration_analysis.md）：
//   GET :8023/dbaasInfrastructure/customApi/getDbInfo?dbType=<t>
//       → 实例资产清单（groupId/hostIp/dbPort/instanceId/version/dbRole/dbState）
//   GET :8023/dbaasInfrastructure/customApi/getCustomInfo?businessId=ZCLOUD_CMDB&dbType=<t>&clusterId=<groupId>
//       → 每实例实时快照（databasestatus≈SHOW GLOBAL STATUS / databasevariable≈SHOW VARIABLES / databases / 账号）
// 诚实原则：
//   - 只呈现 zCloud 真实返回的数据；拉不到标 unknown，绝不编造。
//   - zCloud 自带 Prometheus(:8093) 需 Basic 账密（未配置）→ 趋势由本地按采样周期
//     读真实累计计数器（Questions/Com_commit…）差值所得，属真实采样；
//     采样开始之前的区间如实为空，meta.samplesFrom 标注可回溯起点。
// ============================================================
const DB_TYPES = ['mysql', 'oracle', 'postgresql', 'sqlserver', 'mongodb', 'vastbase'];
export const DB_SPAN = { '6h': 6 * 3600, '24h': 24 * 3600, '7d': 7 * 86400, '30d': 30 * 86400 };
const SAMPLE_MAX = 2016;        // 每实例最多保留采样点（~7d@5min 等效；超限 2:1 抽稀，计数器差值仍精确）
const SAMPLE_MAX_AGE_MS = 8 * 86400e3;

const num = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };
/** databasestatus/databasevariable 行数组 → {变量名: 数值或字符串} */
function _varMap(rows) {
  const m = {};
  for (const r of rows || []) if (r && r.variablename != null) m[r.variablename] = num(r.variablevalue) ?? r.variablevalue;
  return m;
}

export class DbmpClient {
  constructor({ base = 'http://10.70.0.94:8023', enabled = true, freq = 60, sampleFile = null } = {}) {
    this.base = base.replace(/\/+$/, '');
    this.enabled = enabled;
    this.freq = freq;
    this.sampleFile = sampleFile;
    this.entities = [];
    this.dataset = null;        // { hosts, services:[], events:[] } —— server.js merge 用
    this.lastSync = null;
    this.lastError = null;
    this.syncCount = 0;
    this.counts = null;         // 各库型实例数（对接页展示）
    this._infoById = new Map(); // instanceId → getCustomInfo data[] 行
    this._samples = new Map();  // instanceId → [{t, 计数器原值…}]
    this._lastRates = new Map();// instanceId → 最近一次算好的速率（详情卡现值用）
    this._saveTick = 0;
    this._loadSamples();
  }

  // ---------- 抓取 ----------
  async _get(url) {
    const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`dbmp HTTP ${r.status} ${url.split('?')[0]}`);
    const j = await r.json().catch(() => { throw new Error('dbmp 非 JSON 响应'); });
    if (String(j?.code) !== '1000') throw new Error(`dbmp code=${j?.code} ${j?.msg || ''}`);
    return j.data || [];
  }

  /** 一次完整采集：六库型资产 + 按集群实时快照 → 实体 + 采样入库 */
  async sync() {
    const ts = Date.now();
    if (!this.enabled) return { ok: true, skipped: true };
    try {
      const counts = {};
      const assets = [];
      for (const t of DB_TYPES) {
        let list = [];
        try { list = await this._get(`${this.base}/dbaasInfrastructure/customApi/getDbInfo?dbType=${t}`); }
        catch (e) { counts[t] = { n: 0, error: String(e.message || e) }; continue; }
        counts[t] = { n: list.length };
        for (const it of list) assets.push({ ...it, _dbType: t });
      }
      // 六库型全失败＝北向API 完全不可达：必须升为整体错误（徽标转"异常"、页面显示原因），
      // 否则每库型 catch 吞错会让 lastSync/syncCount 照常滚动，前端看不出断连。
      const allFailed = DB_TYPES.every(t => counts[t].error);
      if (allFailed) {
        this.counts = counts;
        this.lastError = `北向API不可达（6/6 库型失败）：${counts[DB_TYPES[0]].error}`;
        return { ok: false, at: ts, error: this.lastError };
      }
      const infoRows = [];
      const gkeys = new Set(assets.map(a => `${a._dbType}|${a.groupId || a.clusterId}`));
      for (const gk of gkeys) {
        const [t, gid] = gk.split('|');
        if (!gid) continue;
        try {
          const rows = await this._get(`${this.base}/dbaasInfrastructure/customApi/getCustomInfo?businessId=ZCLOUD_CMDB&dbType=${t}&clusterId=${encodeURIComponent(gid)}`);
          infoRows.push(...rows);
        } catch { /* 某集群无快照 → 该集群实例只挂资产不带指标 */ }
      }
      this._map(assets, infoRows);
      this._sample(ts);
      if (++this._saveTick % 3 === 0) this._saveSamples();
      this.counts = counts;
      this.dataset = { hosts: this.entities, services: [], events: [] };
      this.lastSync = ts;
      this.lastError = null;
      this.syncCount++;
      return { ok: true, at: ts, instances: this.entities.length };
    } catch (e) {
      this.lastError = String(e.message || e);
      if (!this.dataset && this.entities.length) this.dataset = { hosts: this.entities, services: [], events: [] };
      return { ok: false, at: ts, error: this.lastError };
    }
  }

  // ---------- 资产 + 快照 → 平台实体（domain=database，cpu/mem/disk 置 null 不假装有） ----------
  _map(assets, infoRows) {
    this._infoById = new Map(infoRows.map(r => [r.instanceId, r]));
    const ents = [];
    for (const a of assets) {
      const info = this._infoById.get(a.instanceId) || {};
      const vars = _varMap(info.databasestatus);
      const cfg = _varMap(info.databasevariable);
      const maxConn = num(cfg.max_connections);
      const tc = num(vars.Threads_connected), tr = num(vars.Threads_running);
      const connPct = (tc != null && maxConn) ? +((tc / maxConn) * 100).toFixed(1) : null;
      const dbState = info.dbState || (String(a.dbState) === '1' ? '运行中' : '未知');
      const dstat = String(info.databaseStatus ?? a.runtimeState ?? '');
      const availability = dstat === '0' ? 'critical'
        : (dstat === '1' || String(dbState).includes('运行')) ? 'healthy' : 'warning';
      const bpReq = num(vars.Innodb_buffer_pool_read_requests), bpRead = num(vars.Innodb_buffer_pool_reads);
      const rates = this._lastRates.get(a.instanceId) || {};
      const sp = this._spark(a.instanceId);
      ents.push({
        hostid: 'dbmp-' + a.instanceId,
        name: `${a.instanceName}(${a.hostIp}:${a.dbPort})`,
        host: 'dbmp-' + a.instanceId,
        domain: 'database', via: 'dbmp:北向API', dbSource: 'zCloud',
        group: a.clusterName || a.groupName || '',
        ip: a.hostIp || '',
        status: dstat === '0' ? 'off' : 'on',
        os: `${String(info.job || a._dbType || '').toUpperCase()} ${info.version || a.version || ''}`.trim(),
        availability,
        dbType: a._dbType,
        version: info.version || a.version || '',
        dbRole: info.dbRole || a.dbRole || '',
        dbState,
        dbUpdatetime: info.updatetime || null,
        dbMetrics: {
          threads_connected: tc, threads_running: tr, threads_cached: num(vars.Threads_cached),
          max_connections: maxConn, conn_pct: connPct,
          uptime_seconds: num(vars.Uptime),
          questions_total: num(vars.Questions), slow_queries_total: num(vars.Slow_queries),
          aborted_connects: num(vars.Aborted_connects),
          bp_hit_pct: (bpReq && bpRead != null) ? +((1 - bpRead / bpReq) * 100).toFixed(2) : null,
          qps: rates.qps ?? null, tps: rates.tps ?? null,
          slow_rate: rates.slow ?? null, rows_read: rates.rowsRead ?? null, rows_written: rates.rowsWritten ?? null,
        },
        cpu: null, mem: null, disk: null, uptimeDays: null,
        ping: null, pingMs: null, pingLoss: null, model: '', swOs: '', location: '', temp: null,
        description: info.alertObj ? `zCloud 告警对象：${info.alertObj}` : '',
        problems: 0, items: (info.databasestatus || []).length || 0,
        qpsSpark: sp.qps.map(x => x.v), connSpark: sp.conn.map(x => x.v),
        cpuSpark: [], memSpark: [],
      });
    }
    this.entities = ents;
  }

  // ---------- 采样：读真实累计计数器，本地存样本；差值算速率（真实采样非伪造） ----------
  _sample(ts) {
    for (const [iid, info] of this._infoById) {
      const v = _varMap(info.databasestatus);
      const s = {
        t: Math.floor(ts / 1000),
        Q: num(v.Questions), CC: num(v.Com_commit), CR: num(v.Com_rollback),
        SQ: num(v.Slow_queries), TC: num(v.Threads_connected), TR: num(v.Threads_running),
        RR: num(v.Innodb_rows_read), RW: num(v.Innodb_rows_written),
        BPreq: num(v.Innodb_buffer_pool_read_requests), BPread: num(v.Innodb_buffer_pool_reads),
      };
      if (s.Q == null) continue; // 无状态数据（非 mysql 或集群无快照）→ 采了也没意义
      const arr = this._samples.get(iid) || [];
      const last = arr[arr.length - 1];
      // 去抖：计数器与时间和上次完全相同则跳过（zCloud 快照未刷新）
      if (last && last.t === s.t) arr[arr.length - 1] = s;
      else if (last && last.Q === s.Q && last.CC === s.CC && last.TC === s.TC && s.TR === last.TR) {
        // 累计值没变，只保留时间推进的最后一条
        arr[arr.length - 1] = s;
      } else arr.push(s);
      if (last && last.t < s.t) {
        const dt = s.t - last.t;
        const d = (x, y) => { const r = x != null && y != null ? x - y : null; return r != null && r >= 0 ? r : null; };
        if (dt > 0) {
          const q = d(s.Q, last.Q), c = d(s.CC, last.CC), rb = d(s.CR, last.CR);
          this._lastRates.set(iid, {
            qps: q != null ? +(q / dt).toFixed(2) : null,
            tps: (c != null || rb != null) ? +(((c || 0) + (rb || 0)) / dt).toFixed(2) : null,
            slow: (() => { const x = d(s.SQ, last.SQ); return x != null ? +(x / dt).toFixed(3) : null; })(),
            rowsRead: (() => { const x = d(s.RR, last.RR); return x != null ? +(x / dt).toFixed(0) : null; })(),
            rowsWritten: (() => { const x = d(s.RW, last.RW); return x != null ? +(x / dt).toFixed(0) : null; })(),
          });
        }
      }
      // 修剪：时间窗 + 点数（超限 2:1 抽稀，保留计数器原值，差值不失真）
      let keep = arr.filter(x => ts - x.t * 1000 <= SAMPLE_MAX_AGE_MS);
      while (keep.length > SAMPLE_MAX) keep = keep.filter((_, i) => i % 2 === 0);
      this._samples.set(iid, keep);
    }
  }

  /** 列表页迷你趋势：最近 40 个采样点的 qps / 连接数 */
  _spark(iid) {
    const arr = this._samples.get(iid) || [];
    const out = { qps: [], conn: [] };
    const n = Math.min(40, arr.length);
    for (let i = arr.length - n; i < arr.length; i++) {
      const p = arr[i], prev = arr[i - 1];
      if (prev && p.t > prev.t && p.Q != null && prev.Q != null && p.Q >= prev.Q) {
        out.qps.push({ t: p.t * 1000, v: +((p.Q - prev.Q) / (p.t - prev.t)).toFixed(2) });
      }
      if (p.TC != null) out.conn.push({ t: p.t * 1000, v: p.TC });
    }
    return out;
  }

  // ---------- 采样持久化（重启续接趋势，跨重启的计数器差值仍然真实） ----------
  _loadSamples() {
    if (!this.sampleFile) return;
    try {
      const j = JSON.parse(fs.readFileSync(this.sampleFile, 'utf-8'));
      for (const [iid, arr] of Object.entries(j.samples || {})) this._samples.set(iid, arr);
      for (const [iid, r] of Object.entries(j.rates || {})) this._lastRates.set(iid, r);
    } catch { /* 首次无文件 */ }
  }
  _saveSamples() {
    if (!this.sampleFile) return;
    try {
      fs.mkdirSync(path.dirname(this.sampleFile), { recursive: true });
      const samples = {};
      for (const [iid, arr] of this._samples) samples[iid] = arr;
      const rates = {};
      for (const [iid, r] of this._lastRates) rates[iid] = r;
      fs.writeFileSync(this.sampleFile, JSON.stringify({ savedAt: Date.now(), samples, rates }));
    } catch { /* 写盘失败不影响采集 */ }
  }

  // ---------- 详情：DB 专属档案 + 状态变量 + 库/账号列表 ----------
  detail(dbmpId) {
    const info = this._infoById.get(dbmpId);
    if (!info) return null;
    const vars = _varMap(info.databasestatus);
    const cfg = _varMap(info.databasevariable);
    const rates = this._lastRates.get(dbmpId) || {};
    const arr = this._samples.get(dbmpId) || [];
    const dbs = (info.databases || []).map(x => x.Database).filter(Boolean);
    const users = (info.userInfo || []).map(x => x.name).filter(Boolean);
    const bpReq = num(vars.Innodb_buffer_pool_read_requests), bpRead = num(vars.Innodb_buffer_pool_reads);
    return {
      kind: 'db', source: 'zCloud(dbmp) 北向API :8023',
      profile: {
        instanceName: info.instanceName, clusterName: info.clusterName, hostIp: info.hostIp, dbPort: info.dbPort,
        dbType: info.job || 'mysql', version: info.version, dbRole: info.dbRole, dbState: info.dbState,
        databaseStatus: info.databaseStatus, updatetime: info.updatetime, objType: info.objType,
        currentlogged: (info.databaseinfo || [])[0]?.currentlogged || '',
        defaultstorageengine: (info.databaseinfo || [])[0]?.defaultstorageengine || '',
        hostname: (info.databaseinfo || [])[0]?.hostname || '', system: (info.databaseinfo || [])[0]?.system || '',
      },
      keyStatus: [
        { name: 'Uptime', value: vars.Uptime, unit: 's' },
        { name: 'Threads_connected', value: vars.Threads_connected, unit: '' },
        { name: 'Threads_running', value: vars.Threads_running, unit: '' },
        { name: 'Threads_cached', value: vars.Threads_cached, unit: '' },
        { name: 'Max_used_connections', value: vars.Max_used_connections, unit: '' },
        { name: 'Questions', value: vars.Questions, unit: '累计' },
        { name: 'Slow_queries', value: vars.Slow_queries, unit: '累计' },
        { name: 'Aborted_connects', value: vars.Aborted_connects, unit: '累计' },
        { name: 'Innodb_row_lock_waits', value: vars.Innodb_row_lock_waits, unit: '累计' },
        { name: 'Innodb_buffer_pool_reads', value: vars.Innodb_buffer_pool_reads, unit: '累计' },
        { name: 'Innodb_buffer_pool_read_requests', value: vars.Innodb_buffer_pool_read_requests, unit: '累计' },
        { name: 'Table_open_cache_misses', value: vars.Table_open_cache_misses, unit: '累计' },
      ],
      rates,
      config: {
        max_connections: cfg.max_connections, wait_timeout: cfg.wait_timeout,
        version_comment: cfg.version_comment, version_compile_os: cfg.version_compile_os,
        character_set_server: cfg.character_set_server, collation_server: cfg.collation_server,
        datadir: cfg.datadir, basedir: cfg.basedir, port: cfg.port, server_id: cfg.server_id,
        innodb_buffer_pool_size: cfg.innodb_buffer_pool_size,
      },
      bpHitPct: (bpReq && bpRead != null) ? +((1 - bpRead / bpReq) * 100).toFixed(2) : null,
      databases: dbs, users,
      statusVarCount: (info.databasestatus || []).length,
      samplesFrom: arr.length ? arr[0].t * 1000 : null,
      sampleCount: arr.length,
      allStatusVars: (info.databasestatus || []).map(r => ({ name: r.variablename, value: r.variablevalue })),
      allConfigVars: (info.databasevariable || []).map(r => ({ name: r.variablename, value: r.variablevalue })),
    };
  }

  /**
   * DB 时序（本地真实采样差值）。range/till 对齐通用接口签名；iface/dev/mnt 忽略。
   * 返回自描述结构：series 为 {key:{label,unit,avg:[{t,v}]}}，前端 DB 分支消费。
   */
  series(dbmpId, range = '6h', till = 0) {
    const span = DB_SPAN[range] || DB_SPAN['6h'];
    const now = Math.floor(Date.now() / 1000);
    const t2 = Math.min(Math.max(0, Math.floor(+till || 0)), now) || now;
    const t1 = t2 - span;
    const arr = (this._samples.get(dbmpId) || []).filter(x => x.t >= t1 && x.t <= t2);
    const def = (label, unit) => ({ label, unit, avg: [] });
    const out = {
      qps: def('QPS（Questions/s）', '/s'), tps: def('TPS（commit+rollback/s）', '/s'),
      conn: def('连接数 Threads_connected', ''), running: def('活跃线程 Threads_running', ''),
      slow: def('慢查询/s', '/s'), rows: def('InnoDB 行读/s', '/s'), rowsWritten: def('InnoDB 行写/s', '/s'),
      bufhit: def('Buffer Pool 命中率', '%'),
    };
    for (let i = 1; i < arr.length; i++) {
      const p = arr[i], q = arr[i - 1], dt = p.t - q.t;
      if (dt <= 0) continue;
      const T = p.t * 1000;
      const d = (x, y) => (x != null && y != null && x >= y) ? x - y : null;
      const push = (k, v) => { if (v != null) out[k].avg.push({ t: T, v }); };
      const dq = d(p.Q, q.Q); push('qps', dq != null ? +(dq / dt).toFixed(2) : null);
      const dc = d(p.CC, q.CC), dr = d(p.CR, q.CR);
      push('tps', (dc != null || dr != null) ? +(((dc || 0) + (dr || 0)) / dt).toFixed(2) : null);
      const ds = d(p.SQ, q.SQ); push('slow', ds != null ? +(ds / dt).toFixed(3) : null);
      const drr = d(p.RR, q.RR); push('rows', drr != null ? +(drr / dt).toFixed(0) : null);
      const drw = d(p.RW, q.RW); push('rowsWritten', drw != null ? +(drw / dt).toFixed(0) : null);
      if (p.BPreq != null && q.BPreq != null && p.BPread != null && q.BPread != null && p.BPreq >= q.BPreq) {
        const dreq = p.BPreq - q.BPreq, dread = p.BPread - q.BPread;
        if (dreq > 0) out.bufhit.avg.push({ t: T, v: +((1 - dread / dreq) * 100).toFixed(2) });
      }
      if (p.TC != null) out.conn.avg.push({ t: T, v: p.TC });
      if (p.TR != null) out.running.avg.push({ t: T, v: p.TR });
    }
    const first = arr[0]?.t * 1000 || null;
    return {
      kind: 'db',
      window: { from: t1 * 1000, to: t2 * 1000, range },
      grain: 'sample',
      points: Object.values(out).reduce((n, s) => n + s.avg.length, 0),
      retention: { note: '本地按采集周期采样 zCloud 北向API（:8093 Prometheus 账密待配置后可切原生历史）' },
      sampleSec: Math.max(this.freq, 60),
      samplesFrom: this._samples.get(dbmpId)?.[0] ? this._samples.get(dbmpId)[0].t * 1000 : null,
      sampleCount: (this._samples.get(dbmpId) || []).length,
      windowDataFrom: first,
      series: out,
    };
  }

  get data() {
    if (!this.dataset) throw new Error('dbmp collector not synced yet');
    return this.dataset;
  }
}

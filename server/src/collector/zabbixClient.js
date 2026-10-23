// ============================================================
// ZabbixCollector —— Zabbix JSON-RPC 2.0 真实源 + Mock 双模
// 分类策略（对齐真实 Zabbix 结构）：
//   拉取全部主机组的主机 → 按 模板特征 → 命名特征 → 群组名 三级判断类型
//   （不再按固定群组白名单过滤——真实环境群组是"办公网/数据中心网络设备"这类业务命名）
// ============================================================
import { buildDataset } from './mockData.js';

// —— 三级分类规则（顺序即优先级：数据库 > 服务 > 网络 > 服务器）——
const TEMPLATE_RULES = [
  // 数据库/中间件类模板 → database
  [/MySQL|PostgreSQL|Oracle by|MSSQL|Redis|Elasticsearch|Mongo|ClickHouse|Ceph|RabbitMQ|Kafka|Zookeeper|Etcd|Cassandra|Hadoop|Memcached|NetApp/i, 'database', '模板:数据库'],
  // 应用服务类模板 → service
  [/Nginx|Apache|Tomcat|HAProxy|PHP-FPM|Docker|IIS|JMX|GitLab|Vault|Asterisk|Exchange/i, 'service', '模板:应用'],
  // 网络设备类模板 → network
  [/Comware|VRP|HH3C|Network Generic|Cisco IOS|Juniper|Mikrotik|TP-LINK|Brocade|Extreme|Netgear|Arista|HP Enterprise Switch|Squid|Alcatel|Ubiquiti|D-Link|Force|Huawei/i, 'network', '模板:网络设备'],
  // 操作系统类模板 → server
  [/Linux|Windows|Zabbix server|macOS|FreeBSD|OpenBSD|AIX|HP-UX|Solaris|VMware/i, 'server', '模板:操作系统'],
];
const NAME_RULES = [
  [/(SW\d|-SW\b|SW\d+$|IDC-|biandiansuo|变电所|jiguijian|机柜间|weichu|门卫|guanqu|岗亭|dianxinjian|电信间|交换机|core|POE|JR-)/i, 'network', '命名:网络设备'],
  [/(mysql|^db-|redis|oracle|mssql|postgres|database)/i, 'database', '命名:数据库'],
];
const GROUP_HINTS = [
  [/网络设备|network/i, 'network'],
  [/数据库|database|mysql/i, 'database'],
  [/服务|service|应用/i, 'service'],
  [/Linux|Windows|Zabbix|server|主机/i, 'server'],
];

// —— 真实指标 item key（跨模板族候选，取最新值）——
// filter 是精确匹配，故用 search 通配 + 代码端精确/前缀过滤兜底
const CPU_KEYS = ['system.cpu.util', 'hwCPUUsage', 'hrProcessorLoad', 'hwEntityCPUUtilization'];
const MEM_KEYS = ['vm.memory.util', 'hrMemoryLoad'];
const DISK_KEYS = ['vfs.fs.size[/,pused]', 'vfs.fs.size[c:\\,pused]'];
const UPTIME_KEYS = ['system.uptime'];
// 设备摘要类 item（列表同步顺带取，点开详情再拉全量）
const INFO_KEYS = ['system.hw.model', 'system.sw.os', 'system.location', 'sensor.temp.value', 'icmpping'];
// search 部分匹配会把 icmpping* 三个都带回来：icmpping / icmppingloss / icmppingsec

// Zabbix severity 0–5 → 平台四态
function mapSev(s) {
  s = Number(s);
  return s >= 4 ? 'critical' : s === 3 ? 'severe' : s === 2 ? 'warning' : 'info';
}

export class ZabbixCollector {
  constructor({ mode = 'mock', endpoint = '', token = '', freq = 60 } = {}) {
    this.mode = mode;
    this.endpoint = endpoint;
    this.token = token;
    this.freq = freq;
    this.dataset = null;
    this.lastSync = null;
    this.lastError = null;
    this.syncCount = 0;
    this.version = null;         // apiinfo.version 实测缓存
    this.groupMapping = null;    // 同步后的 群组→域 实际映射（对接页展示）
    this.classifyStats = null;   // 分类判定依据统计
    this._seed = 20261022;
  }

  async rpc(method, params) {
    // Zabbix 规定 apiinfo.version 必须「不带 Authorization 头」调用，带 Bearer 反而报 -32602
    const headers = { 'Content-Type': 'application/json-rpc' };
    if (method !== 'apiinfo.version') headers['Authorization'] = `Bearer ${this.token}`;
    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', method, params, id: Date.now() }),
    });
    if (!res.ok) throw new Error(`Zabbix HTTP ${res.status}`);
    const j = await res.json();
    if (j.error) throw new Error(`Zabbix RPC ${j.error.code}: ${j.error.message}`);
    return j.result;
  }

  /** 一次完整采集：全部群组的主机 + 活动告警 + 关键指标最新值 */
  async sync() {
    const ts = Date.now();
    try {
      if (this.mode === 'zabbix') {
        if (!this.version) { try { this.version = await this.rpc('apiinfo.version', []); } catch { /* 版本查询失败不阻塞 */ } }
        // 实测 Zabbix 7.0.32 host.get 的 selectHostInterfaces 不返回数据，接口必须单独查
        const [hosts, problems, triggers, metricItems, infoItems, totalItems, ifaces] = await Promise.all([
          this.rpc('host.get', {
            output: ['hostid', 'host', 'name', 'status', 'description'],
            selectGroups: ['groupid', 'name'],
            selectParentTemplates: ['host', 'name'],
          }),
          this.rpc('problem.get', {
            output: ['eventid', 'name', 'severity', 'clock', 'object', 'objectid'],
            selectTags: 'extend',
            recent: true,
          }),
          // problem.objectid 是 triggerid → 需要 trigger→host 映射才能把告警挂到主机
          this.rpc('trigger.get', {
            output: ['triggerid'],
            selectHosts: ['hostid'],
            only_triggered: true,
          }).catch(() => []),
          // search 部分匹配可命中多核/多盘变体（如 system.cpu.util[myCPUUtilization5Min.0]）
          // output extend 直接带 lastvalue/lastclock；lastclock=0 = 从未采集，忽略
          this.rpc('item.get', {
            output: 'extend',
            state: 0,
            status: 0,
            search: { key_: [...CPU_KEYS, ...MEM_KEYS, ...DISK_KEYS, ...UPTIME_KEYS] },
            searchByAny: true,
          }),
          // 设备摘要：型号/软件版本/位置/温度/ICMP 可达 —— 点开前列表就能展示
          this.rpc('item.get', {
            output: ['itemid', 'hostid', 'key_', 'lastvalue', 'lastclock', 'units'],
            state: 0,
            status: 0,
            search: { key_: INFO_KEYS },
            searchByAny: true,
          }).catch(() => []),
          this.rpc('item.get', { countOutput: true }).catch(() => null),
          // 监控接口（Agent/SNMP 的 IP）：type 1=Agent 2=SNMP；main=1 优先
          this.rpc('hostinterface.get', { output: ['hostid', 'ip', 'dns', 'main', 'type'] }).catch(() => []),
        ]);
        this.dataset = this._mapZabbix(hosts, problems, metricItems, triggers, ifaces, infoItems);
        if (totalItems != null) this.dataset.totalItems = Number(totalItems);
      } else {
        // mock：每次同步基于时间扰动，制造"数据在流动"的观感
        this._seed = 20261022 + Math.floor(ts / 30000);
        this.dataset = buildDataset(this._seed);
        this.groupMapping = null;
        this.classifyStats = null;
      }
      this.lastSync = ts;
      this.lastError = null;
      this.syncCount++;
      return { ok: true, at: ts };
    } catch (e) {
      this.lastError = String(e.message || e);
      // 真实源失败时回退 mock，保证控制台不白屏
      if (!this.dataset) this.dataset = buildDataset(this._seed);
      return { ok: false, at: ts, error: this.lastError };
    }
  }

  /** 三级分类：模板特征 → 主机命名 → 群组名（兜底 server） */
  classify(h) {
    const tpl = (h.parentTemplates || []).map(t => `${t.host} ${t.name}`).join(' ; ');
    for (const [re, domain, via] of TEMPLATE_RULES) if (re.test(tpl)) return { domain, via };
    const nm = `${h.host} ; ${h.name}`;
    for (const [re, domain, via] of NAME_RULES) if (re.test(nm)) return { domain, via };
    const gn = (h.groups || []).map(g => g.name).join(' ; ');
    for (const [re, domain] of GROUP_HINTS) if (re.test(gn)) return { domain, via: '群组名' };
    return { domain: 'server', via: '默认' };
  }

  /** Zabbix 原始对象 → 平台内部模型（全群组主机分类在此生效） */
  _mapZabbix(rawHosts, rawProblems, metricItems, rawTriggers, rawIfaces, rawInfo) {
    // 0) 监控接口 IP：main 优先，其次 Agent(1)/SNMP(2)；无接口时从主机名提取（如 h3c-10.14.0.127/xx）
    const IPRE = /(?<![0-9.])(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})(?![0-9.])/;
    const validIP = s => s && /^\d{1,3}(\.\d{1,3}){3}$/.test(s) && s.split('.').every(x => +x <= 255);
    const ifByHost = {};
    for (const i of rawIfaces || []) {
      const cur = ifByHost[i.hostid];
      const score = (String(i.main) === '1' ? 4 : 0) + (String(i.type) === '1' ? 2 : String(i.type) === '2' ? 1 : 0);
      if (!cur || score > cur.score) ifByHost[i.hostid] = { ip: i.ip, dns: i.dns, score };
    }
    // 1) 指标现值按主机聚合（多核/多盘取最大值；lastclock=0 表示从未采集，跳过）
    const mBy = {};
    for (const it of metricItems || []) {
      if (!Number(it.lastclock)) continue;
      const rec = (mBy[it.hostid] = mBy[it.hostid] || {});
      const v = Number(it.lastvalue);
      if (!Number.isFinite(v)) continue;
      const k = it.key_;
      if (CPU_KEYS.some(x => k === x || k.startsWith(x + '['))) rec.cpu = Math.max(rec.cpu ?? -1, v);
      else if (MEM_KEYS.some(x => k === x || k.startsWith(x + '['))) rec.mem = Math.max(rec.mem ?? -1, v);
      else if (DISK_KEYS.some(x => k === x || k.startsWith(x + '['))) rec.disk = Math.max(rec.disk ?? -1, v);
      else if (UPTIME_KEYS.some(x => k === x || k.startsWith(x + '['))) rec.uptime = v;
    }

    // 1b) 设备摘要按主机聚合（ICMP 三件套 + 型号/版本/位置/温度）
    const infoBy = {};
    for (const it of rawInfo || []) {
      if (!Number(it.lastclock)) continue;
      const rec = (infoBy[it.hostid] = infoBy[it.hostid] || {});
      const k = it.key_, v = it.lastvalue;
      if (k === 'icmpping') rec.ping = String(v) === '1';
      else if (k === 'icmppingsec') rec.pingMs = +v != null ? Math.round(+v * 1000 * 100) / 100 : null;
      else if (k === 'icmppingloss') rec.pingLoss = +v;
      else if (k.startsWith('system.hw.model')) rec.model = v;
      else if (k === 'system.sw.os') rec.sw_os = v;
      else if (k === 'system.location') rec.location = v;
      else if (k.startsWith('sensor.temp.value')) rec.temp = +v;
    }

    // 2) 全群组主机 → 三级分类
    const hosts = [], services = [];
    const hostDomain = {};               // hostid → domain（事件关联用）
    const grpAgg = {};                   // 群组 → 各域计数
    const viaAgg = {};                   // 判定依据 → 计数
    for (const h of rawHosts) {
      const { domain, via } = this.classify(h);
      hostDomain[h.hostid] = domain;
      viaAgg[via] = (viaAgg[via] || 0) + 1;
      for (const g of (h.groups || [])) {
        const s = (grpAgg[g.name] = grpAgg[g.name] || { counts: {}, total: 0 });
        s.counts[domain] = (s.counts[domain] || 0) + 1;
        s.total++;
      }
      const m = mBy[h.hostid] || {};
      const inf = infoBy[h.hostid] || {};
      const ifc = ifByHost[h.hostid];
      const ip = (ifc && (validIP(ifc.ip) ? ifc.ip : validIP(ifc.dns) ? ifc.dns : ''))
        || ((h.host.match(IPRE) || h.name?.match(IPRE) || [])[1]) || '';
      const rec = {
        hostid: h.hostid, name: h.name || h.host, host: h.host, domain, via,
        group: (h.groups || []).map(x => x.name).join(' / '),
        ip,
        status: String(h.status) === '0' ? 'on' : 'off',
        os: (h.parentTemplates || [])[0]?.name || '',
        availability: 'healthy',
        cpu: m.cpu != null ? +m.cpu.toFixed(1) : null,
        mem: m.mem != null ? +m.mem.toFixed(1) : null,
        disk: m.disk != null ? +m.disk.toFixed(1) : null,
        uptimeDays: m.uptime ? Math.floor(m.uptime / 86400) : null,
        items: 0, problems: 0,
        // 摘要扩展（列表即可见）：ICMP 可达 + 设备档案
        ping: inf.ping, pingMs: inf.pingMs ?? null, pingLoss: inf.pingLoss ?? null,
        model: inf.model || '', swOs: inf.sw_os || '', location: inf.location || '', temp: inf.temp ?? null,
        description: h.description || '',
        cpuSpark: [], memSpark: [],
      };
      if (domain === 'service') services.push(rec); else hosts.push(rec);
    }

    // 3) 事件 → triggerid→hostid 解析 → 关联域 + 主机告警计数 → 三态可用性
    const trigHost = {};                          // triggerid → hostid（首台关联主机）
    for (const t of rawTriggers || []) {
      const hid = (t.hosts || [])[0]?.hostid;
      if (hid) trigHost[t.triggerid] = hid;
    }
    const events = (rawProblems || []).map(p => {
      const hostid = trigHost[p.objectid] || (hostDomain[p.objectid] ? p.objectid : null);
      return {
        eventid: p.eventid,
        clock: Number(p.clock) * 1000,
        severity: mapSev(p.severity),
        object: p.object,
        objectid: p.objectid,
        hostid: hostid || '',
        domain: hostid ? (hostDomain[hostid] || 'server') : 'server',
        message: p.name,
        tags: (p.tags || []).map(t => (t.value ? `${t.tag}:${t.value}` : t.tag)),
        status: 'active',
      };
    });
    const entIndex = new Map([...hosts, ...services].map(x => [x.hostid, x]));
    const SEV_NUM = { info: 1, warning: 2, severe: 3, critical: 4 };
    for (const ev of events) {
      const ent = entIndex.get(ev.hostid);
      if (ent) { ent.problems++; ent._sev = Math.max(ent._sev || 0, SEV_NUM[ev.severity] || 0); }
    }
    for (const ent of entIndex.values()) {
      if (ent.status === 'off' || (ent._sev || 0) >= 4) ent.availability = 'critical';
      else if (ent.problems > 0) ent.availability = 'warning';
      else ent.availability = 'healthy';
      delete ent._sev;
    }

    // 4) 群组→域 实际映射表（对接页展示：群组内按多数域标注）
    this.groupMapping = Object.entries(grpAgg)
      .sort((a, b) => b[1].total - a[1].total)
      .map(([zbxGroup, s]) => {
        const [topDomain, topCount] = Object.entries(s.counts).sort((a, b) => b[1] - a[1])[0];
        return {
          zbxGroup, total: s.total, counts: s.counts,
          domain: topDomain, domainLabel: DOMAIN_LABELS[topDomain],
          mixed: Object.keys(s.counts).length > 1,
          freq: this.freq,
        };
      });
    this.classifyStats = viaAgg;

    return { hosts, services, events, totalItems: 0, mock: false };
  }

  /** 按需详情：点开设备时实时向 Zabbix 拉该主机的全量信息（TTL 缓存 60s） */
  async detail(hostid) {
    if (this.mode !== 'zabbix') return null;
    const cache = (this._detailCache = this._detailCache || new Map());
    const hit = cache.get(hostid);
    if (hit && Date.now() - hit.at < 60e3) return hit.data;

    const num = k => k.split('[')[0];
    const [items, ifaces] = await Promise.all([
      // 该主机全部启用 item 现值（含名称/单位/取值类型）
      this.rpc('item.get', {
        output: ['itemid', 'name', 'key_', 'lastvalue', 'lastclock', 'value_type', 'units', 'state'],
        hostids: [hostid], state: 0, status: 0, sortfield: 'name',
      }),
      this.rpc('hostinterface.get', { output: 'extend', hostids: [hostid] }).catch(() => []),
    ]);

    // 数值型 item 现值索引 → 找 CPU/内存/时延 的 itemid 去拉 history 时序
    const byKey = {};
    for (const it of items) (byKey[num(it.key_)] = byKey[num(it.key_)] || []).push(it);
    const pick = keys => {
      for (const k of keys) {
        const hit2 = (byKey[k] || []).find(i => Number(i.lastclock) && Number.isFinite(+i.lastvalue));
        if (hit2) return hit2;
      }
      return null;
    };
    const cpuIt = pick(CPU_KEYS);
    const memIt = pick(MEM_KEYS);
    const pingIt = byKey['icmppingsec']?.[0] || null;
    const histIds = [cpuIt, memIt, pingIt].filter(Boolean).map(i => i.itemid);
    const history = histIds.length
      ? await this.rpc('history.get', {
          output: ['itemid', 'clock', 'value'],
          history: 0, itemids: histIds,
          time_from: Math.floor(Date.now() / 1000) - 6 * 3600,
          sortfield: 'clock', sortorder: 'ASC', limit: 1000,
        }).catch(() => [])
      : [];

    // —— 网络接口聚合：兼容两种 key 格式 ——
    //   SNMP: net.if.in[ifHCInOctets.1]      → 名称从 item name "Interface xxx(...): field" 提取
    //   Agent: net.if.in["enp4s1",errors]    → 名称取引号里的接口名
    const IFRE = /^net\.if\.(in|out|status|speed|type|duplex)(?:\.(errors|discards))?\[([^\]]+)\]$/;
    const ifcMap = new Map();
    for (const it of items) {
      const m = IFRE.exec(it.key_);
      if (!m) continue;
      const args = m[3];
      const qm = /^"(.+?)"(?:,|$)/.exec(args);
      let idx, nm;
      if (qm) { idx = qm[1]; nm = qm[1]; }
      else {
        const dot = args.lastIndexOf('.');
        idx = dot >= 0 ? args.slice(dot + 1) : args;
        const n2 = /^Interface (.+?)\(/.exec(it.name);
        nm = n2 ? n2[1] : `if#${idx}`;
      }
      const rec = ifcMap.get(idx) || { name: '', status: null, speed: null, in: null, out: null, inErr: 0, outErr: 0, inDsc: 0, outDsc: 0 };
      if (!rec.name || rec.name.startsWith('if#')) rec.name = nm;
      const [base, sub] = [m[1], m[2]];
      const v = it.lastvalue;
      if (base === 'status') rec.status = +v;              // 1=up 2=down
      else if (base === 'speed') rec.speed = +v;
      else if (base === 'in' && !sub) rec.in = +v;
      else if (base === 'out' && !sub) rec.out = +v;
      else if (sub === 'errors') { if (base === 'in') rec.inErr = +v; else rec.outErr = +v; }
      else if (sub === 'discards') { if (base === 'in') rec.inDsc = +v; else rec.outDsc = +v; }
      ifcMap.set(idx, rec);
    }
    const netIfs = [...ifcMap.values()].filter(x => x.name && !x.name.startsWith('if#'))
      .sort((a, b) => (b.status === 1) - (a.status === 1) || a.name.localeCompare(b.name));

    // —— 设备档案（字符串/标量类 item 摊平）——
    const txt = k => (byKey[k]?.[0]?.lastvalue || '').replace(/[\r\n]+/g, ' ').trim();
    const profile = {
      sysName: txt('system.name'),
      model: txt('system.hw.model'),
      swOs: txt('system.sw.os'),
      hwVersion: txt('system.hw.version'),
      firmware: txt('system.hw.firmware'),
      serial: txt('system.hw.serialnumber'),
      location: txt('system.location'),
      contact: txt('system.contact'),
      descr: txt('system.descr'),
      uname: txt('system.uname'),
      arch: txt('system.sw.arch'),
      cpuNum: byKey['system.cpu.num']?.[0]?.lastvalue || '',
      memTotal: byKey['vm.memory.size[total]']?.[0]?.lastvalue
        || (byKey['vm.memory.size'] || []).find(i => i.key_.includes('total'))?.lastvalue || '',
      memAvail: (byKey['vm.memory.size'] || []).find(i => i.key_.includes('available') && !i.key_.includes('pavailable'))?.lastvalue || '',
      processes: byKey['proc.num']?.[0]?.lastvalue || '',
      temp: byKey['sensor.temp.value']?.[0]?.lastvalue || '',
    };

    // —— 全监控项清单（数值+字符，带现值），前端做表格展示；截 300 条防爆 ——
    const itemList = items.slice(0, 300).map(it => ({
      name: it.name, key: it.key_, value: it.lastvalue, units: it.units || '',
      lastclock: Number(it.lastclock) * 1000, valueType: +it.value_type,
    }));

    const spark = (itemid) => history.filter(h => h.itemid === itemid)
      .map(h => ({ t: Number(h.clock) * 1000, v: +h.value }));

    const data = {
      profile,
      netIfs,
      itemCount: items.length,
      interfaces: (ifaces || []).map(i => ({
        ip: i.ip, dns: i.dns, port: i.port, type: +i.type, useip: +i.useip,
        available: +i.available, error: i.error || '',
      })),
      series: {
        cpu: cpuIt ? spark(cpuIt.itemid) : [],
        mem: memIt ? spark(memIt.itemid) : [],
        ping: pingIt ? spark(pingIt.itemid) : [],
      },
      items: itemList,
    };
    cache.set(hostid, { at: Date.now(), data });
    return data;
  }

  /**
   * 时间窗时序：range=6h/24h（history 原始，分钟级）或 7d/30d（trend 小时聚合，带 min/avg/max）。
   * till = 窗口结束锚点（epoch 秒，0=现在），用于回看过去某个时间段。
   * 一次返回该设备全部可用指标（cpu/mem/temp/load/proc/fs/ping + 选定接口的流量）。
   */
  async series(hostid, range = '6h', till = 0, iface = '') {
    if (this.mode !== 'zabbix') return null;
    const SPAN = { '6h': 6 * 3600, '24h': 24 * 3600, '7d': 7 * 86400, '30d': 30 * 86400 };
    const span = SPAN[range] || SPAN['6h'];
    const now = Math.floor(Date.now() / 1000);
    const t2 = Math.min(Math.max(0, Math.floor(+till || 0)), now) || now;
    const t1 = t2 - span;

    const cache = (this._seriesCache = this._seriesCache || new Map());
    const ck = `${hostid}|${range}|${t2}|${iface}`;
    const hit = cache.get(ck);
    if (hit && Date.now() - hit.at < (span > 86400 ? 300e3 : 60e3)) return hit.data;

    const searchKeys = ['system.cpu.util', 'hwCPUUsage', 'hrProcessorLoad', 'hwEntityCPUUtilization',
      'vm.memory.util', 'hrMemoryLoad', 'vm.memory.size', 'icmppingsec', 'sensor.temp.value',
      'system.cpu.load', 'proc.num', 'vfs.fs', 'net.if.in', 'net.if.out'];
    const num = k => k.split('[')[0];
    const items = await this.rpc('item.get', {
      output: ['itemid', 'key_', 'name', 'lastclock', 'lastvalue', 'value_type', 'history', 'trends', 'units'],
      hostids: [hostid], state: 0, status: 0,
      search: { key_: searchKeys }, searchByAny: true,
    });

    // —— 接口流量清单（net.if.in/out 精确形态，排除 errors/discards 变体）——
    // SNMP 设备 in/out 参数不对称：ifHCInOctets.10 vs ifHCOutOctets.10 → 归一化到 ifIndex 配对；
    // agent 设备两侧同参（net.if.in["enp4s1"]）→ 直接用去引号后的接口名
    const SNMP_PARAM = /^(?:ifHCInOctets|ifHCOutOctets|ifInOctets|ifOutOctets)\.(.+)$/;
    const pairKey = p => { const m = p.match(SNMP_PARAM); return m ? 'ifidx:' + m[1] : p; };
    const ifaceMap = {};
    for (const it of items) {
      const m = it.key_.match(/^net\.if\.(in|out)\[([^\]]+)\]$/);
      if (!m || m[2].includes(',')) continue;
      const raw = m[2].replace(/^"|"$/g, '');
      const pk = pairKey(raw);
      const rec = (ifaceMap[pk] = ifaceMap[pk] || { iface: pk, raw, in: null, out: null, label: '' });
      const nm = String(it.name).match(/Interface\s+([^(（:：]+)/);
      if (nm && !rec.label) rec.label = nm[1].trim();
      if (!rec.label) rec.label = raw;
      if (m[1] === 'in') rec.in = it; else rec.out = it;
    }
    const liveIfaces = Object.values(ifaceMap).filter(x => x.in && x.out && Number(x.in.lastclock));
    const ifaces = liveIfaces
      .map(x => ({ iface: x.iface, label: x.label, act: Math.abs(+x.in.lastvalue) + Math.abs(+x.out.lastvalue) }))
      .sort((a, b) => (b.act > 0 ? 1 : 0) - (a.act > 0 ? 1 : 0)
        || a.label.localeCompare(b.label, 'en', { numeric: true }))
      .map(x => ({ iface: x.iface, label: x.label }));
    let ifaceRec = iface ? ifaceMap[iface] : null;
    if (!iface && liveIfaces.length) {
      // 自动选择活跃接口：现值收发之和最大（如上联口）
      ifaceRec = liveIfaces
        .sort((a, b) => (Math.abs(+b.in.lastvalue) + Math.abs(+b.out.lastvalue))
          - (Math.abs(+a.in.lastvalue) + Math.abs(+a.out.lastvalue)))[0] || null;
    }

    const byKey = {};
    for (const it of items) (byKey[num(it.key_)] = byKey[num(it.key_)] || []).push(it);
    const live = arr => arr.filter(i => Number(i.lastclock));
    const pick = (keys, pref) => {
      for (const k of keys) {
        const h = live(byKey[k] || []);
        if (!h.length) continue;
        if (pref) { const p = h.find(pref); if (p) return p; }
        return h[0];
      }
      return null;
    };
    const chosen = {
      cpu: pick(['system.cpu.util', 'hwCPUUsage', 'hrProcessorLoad', 'hwEntityCPUUtilization']),
      mem: pick(['vm.memory.util', 'hrMemoryLoad']),
      temp: pick(['sensor.temp.value']),
      load: pick(['system.cpu.load'], i => i.key_.includes('avg5')),
      proc: pick(['proc.num'], i => i.key_ === 'proc.num'),
      fs: pick(['vfs.fs.size', 'vfs.fs.dependent.size'], i => i.key_.includes('pused') && i.units === '%'),
      ping: pick(['icmppingsec']),
    };
    const tIn = ifaceRec?.in || null, tOut = ifaceRec?.out || null;
    const all = [...Object.values(chosen), tIn, tOut].filter(Boolean);

    let grain = 'raw', mk = null;
    if (!all.length) {
      mk = () => ({ avg: [] });
    } else if (span > 86400) {
      // —— trend：小时级聚合（min/avg/max），保留期通常一年 ——
      grain = 'hour';
      const tr = await this.rpc('trend.get', {
        output: ['itemid', 'clock', 'value_min', 'value_avg', 'value_max'],
        itemids: all.map(i => i.itemid),
        time_from: t1, time_till: t2,
        sortfield: 'clock', sortorder: 'ASC', limit: 9000,
      }).catch(() => []);
      mk = it => {
        if (!it) return { avg: [], max: [], min: [] };
        const rows = tr.filter(x => x.itemid === it.itemid);
        return {
          avg: rows.map(x => ({ t: Number(x.clock) * 1000, v: +(+x.value_avg).toFixed(2) })),
          max: rows.map(x => +x.value_max),
          min: rows.map(x => +x.value_min),
        };
      };
    } else {
      // —— history：原始值（按 value_type 分组：float=0 / unsigned=3）——
      // 注意 limit 是对整个请求所有 item 的总点数，多指标下要够大
      const groups = {};
      for (const it of all) (groups[it.value_type] = groups[it.value_type] || []).push(it);
      const hist = (await Promise.all(Object.entries(groups).map(([vt, its]) =>
        this.rpc('history.get', {
          output: ['itemid', 'clock', 'value'],
          history: +vt, itemids: its.map(i => i.itemid),
          time_from: t1, time_till: t2,
          sortfield: 'clock', sortorder: 'ASC', limit: 16000,
        }).catch(() => [])
      ))).flat();
      mk = it => it
        ? { avg: hist.filter(h => h.itemid === it.itemid).map(h => ({ t: Number(h.clock) * 1000, v: +h.value })) }
        : { avg: [] };
    }

    const series = {
      cpu: mk(chosen.cpu), mem: mk(chosen.mem), temp: mk(chosen.temp),
      load: mk(chosen.load), proc: mk(chosen.proc), fs: mk(chosen.fs), ping: mk(chosen.ping),
      traffic: { iface: ifaceRec?.iface || '', label: ifaceRec?.label || '', in: mk(tIn), out: mk(tOut) },
    };
    const refIt = chosen.cpu || chosen.mem || chosen.temp || chosen.ping || tIn;
    const data = {
      window: { from: t1 * 1000, to: t2 * 1000, range },
      grain,
      points: ['cpu', 'mem', 'temp', 'load', 'proc', 'fs', 'ping']
        .reduce((n, k) => n + (series[k]?.avg?.length || 0), 0)
        + (series.traffic.in.avg?.length || 0) + (series.traffic.out.avg?.length || 0),
      retention: { history: refIt?.history || '', trends: refIt?.trends || '' },
      meta: {
        fs: { label: chosen.fs?.name || '磁盘使用', units: chosen.fs?.units || '' },
        traffic: { units: 'bps' },
      },
      ifaces: ifaces.slice(0, 24),
      series,
    };
    cache.set(ck, { at: Date.now(), data });
    return data;
  }

  get data() {
    if (!this.dataset) throw new Error('collector not synced yet');
    return this.dataset;
  }
}

const DOMAIN_LABELS = { server: '服务器', database: '数据库', network: '网络设备', service: '服务' };

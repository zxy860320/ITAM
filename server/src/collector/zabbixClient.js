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

// —— 无线控制器识别（仍归 network 域，但打上 wlan 标记走无线专属形态）——
// 模板特征：华为 "Huawei wireless Access Controller (AC)"；命名特征：wuxiankongzhiqui / wlan-ac 等
const WLAN_TPL_RE = /wireless access controller/i;
const WLAN_NAME_RE = /wuxian|无线|wlan[-_]?ac|ac[-_]wlan/i;
// AC 级汇总项（列表列直接展示）：ac-users-total / ac-users-2.4 / ac-users-5；AP 状态名计数（ap-state-name-*）
const WLAN_ITEM_KEYS = ['ac-users', 'ap-state-name'];

// —— 真实指标 item key（跨模板族候选，取最新值）——
// filter 是精确匹配，故用 search 通配 + 代码端精确/前缀过滤兜底
const CPU_KEYS = ['system.cpu.util', 'hwCPUUsage', 'hrProcessorLoad', 'hwEntityCPUUtilization'];
// 陷阱：system.cpu.util 的"分量细分"变体（[,idle]/[,user]/[,iowait]…）参数以逗号开头，
// idle=空闲时间≠使用率。search 部分匹配会把它们全带回来，Math.max 后 idle(99.5%) 冒充 CPU 使用率。
// 汇总使用率取不带逗号参数的 key（system.cpu.util / system.cpu.util[多核变体]）。
const CPU_COMPONENT_RE = /^system\.cpu\.util\[,/;
const MEM_KEYS = ['vm.memory.util', 'hrMemoryLoad'];
// 陷阱：Zabbix 7.x 新版 Linux agent 模板把文件系统项改为依赖项 vfs.fs.dependent.size[/,pused]
// （旧模板才是 vfs.fs.size[/,pused]），旧 DISK_KEYS 精确匹配带不上 → 概览"磁盘使用"显示"—"。
// 正则兼容两代 key；根分区（/ 或 c:\）优先，没有根分区时取所有挂载点最大值（最差分区）。
const DISK_RE = /^vfs\.fs\.(?:dependent\.)?size\[[^\]]+,pused\]$/;
const DISK_ROOT_RE = /^vfs\.fs\.(?:dependent\.)?size\[\/,pused\]$|^vfs\.fs\.(?:dependent\.)?size\[c:\\,pused\]$/i;
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
            search: { key_: [...CPU_KEYS, ...MEM_KEYS, 'vfs.fs.size', 'vfs.fs.dependent.size', ...UPTIME_KEYS] },
            searchByAny: true,
          }),
          // 设备摘要：型号/软件版本/位置/温度/ICMP 可达 + 无线 AC 汇总（ac-users-*、ap-state-name-*）—— 点开前列表就能展示
          this.rpc('item.get', {
            output: ['itemid', 'hostid', 'key_', 'lastvalue', 'lastclock', 'units'],
            state: 0,
            status: 0,
            search: { key_: [...INFO_KEYS, ...WLAN_ITEM_KEYS] },
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

  /** 三级分类：模板特征 → 主机命名 → 群组名（兜底 server）；附带无线控制器标记 */
  classify(h) {
    const tpl = (h.parentTemplates || []).map(t => `${t.host} ${t.name}`).join(' ; ');
    const nm = `${h.host} ; ${h.name}`;
    let out = null;
    for (const [re, domain, via] of TEMPLATE_RULES) if (re.test(tpl)) { out = { domain, via }; break; }
    if (!out) {
      for (const [re, domain, via] of NAME_RULES) if (re.test(nm)) { out = { domain, via }; break; }
    }
    if (!out) {
      const gn = (h.groups || []).map(g => g.name).join(' ; ');
      for (const [re, domain] of GROUP_HINTS) if (re.test(gn)) { out = { domain, via: '群组名' }; break; }
    }
    if (!out) out = { domain: 'server', via: '默认' };
    // 无线控制器：仍归 network 域，wlan=true 供前端切换无线专属形态
    if (out.domain === 'network' && (WLAN_TPL_RE.test(tpl) || WLAN_NAME_RE.test(nm))) out.wlan = true;
    return out;
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
      if (CPU_COMPONENT_RE.test(k)) continue; // 跳过 [,idle]/[,user] 等分量项（手册 §7.4 坑：idle≠使用率）
      else if (CPU_KEYS.some(x => k === x || k.startsWith(x + '['))) rec.cpu = Math.max(rec.cpu ?? -1, v);
      else if (MEM_KEYS.some(x => k === x || k.startsWith(x + '['))) rec.mem = Math.max(rec.mem ?? -1, v);
      else if (DISK_RE.test(k)) { if (DISK_ROOT_RE.test(k)) rec.diskRoot = Math.max(rec.diskRoot ?? -1, v); else rec.diskMax = Math.max(rec.diskMax ?? -1, v); }
      else if (UPTIME_KEYS.some(x => k === x || k.startsWith(x + '['))) rec.uptime = v;
    }

    // 1b) 设备摘要按主机聚合（ICMP 三件套 + 型号/版本/位置/温度 + 无线 AC 汇总）
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
      // 无线 AC：AP 状态名计数（ap-state-name-[AP]）+ 接入用户数（ac-users-total/2.4/5）
      // 华为备机侧状态文本有 "IdleIdle" 变体（双射频拼接），归并到 Idle
      else if (k.startsWith('ap-state-name')) {
        let st = String(v || '').trim() || '未知';
        if (st === 'IdleIdle') st = 'Idle';
        (rec.apStates = rec.apStates || {})[st] = (rec.apStates[st] || 0) + 1;
      }
      else if (k === 'ac-users-total') rec.wlanUsersTotal = +v;
      else if (k === 'ac-users-2.4') rec.wlanUsers24 = +v;
      else if (k === 'ac-users-5') rec.wlanUsers5 = +v;
    }

    // 2) 全群组主机 → 三级分类
    const hosts = [], services = [];
    const hostDomain = {};               // hostid → domain（事件关联用）
    const hostWlan = {};                 // hostid → 是否无线控制器（事件噪声标注用）
    const grpAgg = {};                   // 群组 → 各域计数
    const viaAgg = {};                   // 判定依据 → 计数
    for (const h of rawHosts) {
      const { domain, via, wlan } = this.classify(h);
      hostDomain[h.hostid] = domain;
      if (wlan) hostWlan[h.hostid] = true;
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
        disk: (() => { const d = m.diskRoot ?? m.diskMax; return d != null ? +d.toFixed(1) : null; })(),
        uptimeDays: m.uptime ? Math.floor(m.uptime / 86400) : null,
        items: 0, problems: 0,
        // 摘要扩展（列表即可见）：ICMP 可达 + 设备档案
        ping: inf.ping, pingMs: inf.pingMs ?? null, pingLoss: inf.pingLoss ?? null,
        model: inf.model || '', swOs: inf.sw_os || '', location: inf.location || '', temp: inf.temp ?? null,
        description: h.description || '',
        cpuSpark: [], memSpark: [],
        // 无线控制器扩展（wlan=true → 前端走无线形态）：AP 状态汇总 + 接入用户数
        ...(wlan ? {
          wlan: true,
          apStates: inf.apStates || null,
          apTotal: inf.apStates ? Object.values(inf.apStates).reduce((a, b) => a + b, 0) : null,
          wlanUsers: inf.wlanUsersTotal ?? null,
          wlanUsers24: inf.wlanUsers24 ?? null,
          wlanUsers5: inf.wlanUsers5 ?? null,
        } : {}),
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
      const ev = {
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
      // 无线设备哨兵值噪声标注：华为 AP 温度传感器不可读时上报 255（并非真过温），
      // 触发器照常报警。展示层如实标注 noise 并从"异常计数"剔除，不改 Zabbix 配置。
      if (hostid && hostWlan[hostid] && /TEMP=255\b/.test(p.name)) ev.noise = '哨兵值：AP 温度传感器不可读（255），非真实过温';
      return ev;
    });
    const entIndex = new Map([...hosts, ...services].map(x => [x.hostid, x]));
    const SEV_NUM = { info: 1, warning: 2, severe: 3, critical: 4 };
    for (const ev of events) {
      const ent = entIndex.get(ev.hostid);
      if (!ent) continue;
      if (ev.noise) { ent.noiseProblems = (ent.noiseProblems || 0) + 1; continue; }
      ent.problems++; ent._sev = Math.max(ent._sev || 0, SEV_NUM[ev.severity] || 0);
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
        const arr = byKey[k] || [];
        // 优先非分量变体（避开 system.cpu.util[,idle]），找不到再回退首个有效项
        const hit2 = arr.find(i => !CPU_COMPONENT_RE.test(i.key_) && Number(i.lastclock) && Number.isFinite(+i.lastvalue))
          || arr.find(i => Number(i.lastclock) && Number.isFinite(+i.lastvalue));
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

    // —— 网络接口聚合：兼容三种 key 形态 ——
    //   SNMP:  net.if.in[ifHCInOctets.1]          → 名称从 item name "Interface xxx(...): field" 提取
    //   Agent: net.if.in["enp4s1"]                → 名称取引号里的接口名
    //   变体（点式或逗号）: net.if.in.errors[k] / net.if.in["eth0",errors] / net.if.in[ifHCInOctets.10,dropped]
    //   ⚠ 逗号变体若不识别会被当主项，errors=0 覆盖真实 bps 现值（显示"—"的根因）
    const IFRE = /^net\.if\.(in|out|status|speed|type|duplex)(?:\.(errors|discards))?\[([^\]]+?)(?:,(errors|discards|dropped))?\]$/;
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
      const [base, sub] = [m[1], m[2] || m[4]];
      const v = it.lastvalue;
      if (base === 'status') rec.status = +v;              // 1=up 2=down
      else if (base === 'speed') rec.speed = +v;
      else if (base === 'in' && !sub) rec.in = +v;
      else if (base === 'out' && !sub) rec.out = +v;
      else if (sub === 'errors') { if (base === 'in') rec.inErr = +v; else rec.outErr = +v; }
      else if (sub === 'discards' || sub === 'dropped') { if (base === 'in') rec.inDsc = +v; else rec.outDsc = +v; }
      ifcMap.set(idx, rec);
    }
    const netIfs = [...ifcMap.values()].filter(x => x.name && !x.name.startsWith('if#'))
      .sort((a, b) => (b.status === 1) - (a.status === 1) || a.name.localeCompare(b.name));

    // —— 无线 AP 实例表（华为 AC 模板 LLD）——
    // key 形态：ap-<指标>-[<AP标识>]，同一 AP 所有指标共用同一方括号标识。
    // ⚠ Zabbix search 对含字面 "]" 的值匹配失效（模板里有个 AP 名带中文+"]AP"），
    //   所以这里不用 search，直接扫该主机全量 items 按正则归组（detail 本就拉全量）。
    const APRE = /^ap-(MAC|NAME|group|model|id|state|state-name|clients|clients-2\.4GHz|clientes-5|cpu|memory|temp|eth-download|eth-upload|latitude|longitude|remote-neighbor-interface-id|remote-neighbor-system-name|2\.4GHz-channel-interference-rate|2\.4GHz-radio-noise|5GHz-channel-interference-rate|5GHz-radio-noise)-\[(.+)\]$/;
    const apMap = new Map();
    for (const it of items) {
      const m = APRE.exec(it.key_);
      if (!m) continue;
      let ap = apMap.get(m[2]);
      if (!ap) { ap = { id: m[2], name: '', mac: '', group: '', model: '', state: null, stateName: '', clients: null, clients24: null, clients5: null, cpu: null, mem: null, temp: null, ethIn: null, ethOut: null }; apMap.set(m[2], ap); }
      const v = it.lastvalue;
      switch (m[1]) {
        case 'NAME': if (v) ap.name = v; break;
        case 'MAC': if (v) ap.mac = v; break;
        case 'group': if (v) ap.group = v; break;
        case 'model': if (v) ap.model = v; break;
        case 'state': ap.state = v; break;
        case 'state-name': if (v) ap.stateName = v; break;
        case 'clients': ap.clients = +v; break;
        case 'clients-2.4GHz': if (Number(it.state) !== 1) ap.clients24 = +v; break;
        case 'clientes-5': if (Number(it.state) !== 1) ap.clients5 = +v; break;
        case 'cpu': ap.cpu = +v; break;
        case 'memory': ap.mem = +v; break;
        case 'temp': ap.temp = +v; break;
        case 'eth-download': ap.ethIn = +v; break;
        case 'eth-upload': ap.ethOut = +v; break;
      }
    }
    const apList = [...apMap.values()]
      .map(x => {
        // 名称回退链：ap-name 常空 → 从实例标识提取（"办公间-面封AP 68.xx.xx" 或纯 MAC 形态）
        const idName = x.id.replace(/-\d{1,3}(\.\d{1,3}){3}\.\d+(\.\d+)?$/, '').replace(/\s+[\w.-]*AP\s*$/i, '').trim();
        x.label = x.name || idName || x.mac || x.id;
        // 温度 255=传感器不可读哨兵值（华为 AP 常见），如实置 null
        if (x.temp === 255) x.temp = null;
        // 华为备机侧状态文本 "IdleIdle" 变体（双射频拼接），归并到 Idle
        if (x.stateName === 'IdleIdle') x.stateName = 'Idle';
        // 实例标识里常带 AP 管理 IP（尾段 x.x.x.x.NN.NN）
        const ipm = x.id.match(/(\d{1,3}(?:\.\d{1,3}){3})\.\d+(?:\.\d+)?$/);
        x.ip = ipm ? ipm[1] : '';
        return x;
      })
      .sort((a, b) => (a.stateName === 'Normal' ? 0 : 1) - (b.stateName === 'Normal' ? 0 : 1) || a.label.localeCompare(b.label, 'en', { numeric: true }));

    // —— AP 名称索引 → 供 series 的 ap/apmetric 参数定位具体 AP 的指标 ——
    const apItemIdx = {};
    if (apList.length) {
      apList.forEach((ap, i) => { apItemIdx[`ap#${i}|${ap.id}`] = ap; });
    }

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
      apList,
      wlanSummary: apList.length ? {
        apTotal: apList.length,
        apNormal: apList.filter(x => x.stateName === 'Normal').length,
        apFault: apList.filter(x => x.stateName && x.stateName !== 'Normal' && x.stateName !== 'Idle').length,
        apIdle: apList.filter(x => x.stateName === 'Idle').length,
        usersTotal: byKey['ac-users-total']?.[0]?.lastvalue || '',
        users24: byKey['ac-users-2.4']?.[0]?.lastvalue || '',
        users5: byKey['ac-users-5']?.[0]?.lastvalue || '',
      } : null,
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
  async series(hostid, range = '6h', till = 0, iface = '', dev = '', mnt = '', ap = '') {
    if (this.mode !== 'zabbix') return null;
    const SPAN = { '6h': 6 * 3600, '24h': 24 * 3600, '7d': 7 * 86400, '30d': 30 * 86400 };
    const span = SPAN[range] || SPAN['6h'];
    const now = Math.floor(Date.now() / 1000);
    const t2 = Math.min(Math.max(0, Math.floor(+till || 0)), now) || now;
    const t1 = t2 - span;

    const cache = (this._seriesCache = this._seriesCache || new Map());
    const ck = `${hostid}|${range}|${t2}|${iface}|${dev}|${mnt}|${ap}`;
    const hit = cache.get(ck);
    if (hit && Date.now() - hit.at < (span > 86400 ? 300e3 : 60e3)) return hit.data;

    const searchKeys = ['system.cpu.util', 'hwCPUUsage', 'hrProcessorLoad', 'hwEntityCPUUtilization',
      'vm.memory.util', 'hrMemoryLoad', 'vm.memory.size', 'icmppingsec', 'sensor.temp.value',
      'system.cpu.load', 'proc.num', 'vfs.fs', 'net.if.in', 'net.if.out',
      'vfs.dev.read.rate', 'vfs.dev.write.rate', 'ac-users'];
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

    // —— 磁盘 I/O 设备清单（vfs.dev.read.rate[dev] / vfs.dev.write.rate[dev]，读写同参天然配对）——
    // Linux 模板提供 r/s、w/s（IOPS）；网络设备等无此类 item → 前端自动隐藏该指标卡
    const devMap = {};
    for (const it of items) {
      const m = it.key_.match(/^vfs\.dev\.(read|write)\.rate\[([^\]]+)\]$/);
      if (!m) continue;
      const rec = (devMap[m[2]] = devMap[m[2]] || { dev: m[2], read: null, write: null });
      if (m[1] === 'read') rec.read = it; else rec.write = it;
    }
    const liveDevs = Object.values(devMap).filter(x => x.read && x.write && (Number(x.read.lastclock) || Number(x.write.lastclock)));
    const devs = liveDevs
      .map(x => ({ dev: x.dev, act: Math.abs(+x.read.lastvalue || 0) + Math.abs(+x.write.lastvalue || 0) }))
      .sort((a, b) => (b.act > 0 ? 1 : 0) - (a.act > 0 ? 1 : 0)
        || a.dev.localeCompare(b.dev, 'en', { numeric: true }))
      .map(x => ({ dev: x.dev }));
    let devRec = dev ? devMap[dev] : null;
    if (!dev && liveDevs.length) {
      devRec = liveDevs
        .sort((a, b) => (Math.abs(+b.read.lastvalue || 0) + Math.abs(+b.write.lastvalue || 0))
          - (Math.abs(+a.read.lastvalue || 0) + Math.abs(+a.write.lastvalue || 0)))[0] || null;
    }

    // —— 磁盘分区清单（vfs.fs[.dependent].size[挂载点,pused]，% 单位；两代模板 key 都认）——
    const FS_PUSED_RE = /^vfs\.fs\.(?:dependent\.)?size\[([^\]]+),pused\]$/;
    const isRootMnt = m => m === '/' || /^c:\\$/i.test(m);
    const mntMap = {};
    for (const it of items) {
      const m = it.key_.match(FS_PUSED_RE);
      if (!m || it.units !== '%') continue;
      const key = m[1].replace(/^"|"$/g, '');
      if (!mntMap[key] || Number(it.lastclock) > Number(mntMap[key].it.lastclock)) mntMap[key] = { mnt: key, label: (it.name || key).replace(/^FS \[(.*)\]:\s*/, ''), it };
    }
    const mnts = Object.values(mntMap)
      .filter(x => Number(x.it.lastclock))
      .sort((a, b) => (isRootMnt(b.mnt) - isRootMnt(a.mnt))
        || (Number(b.it.lastvalue || 0) - Number(a.it.lastvalue || 0))
        || a.mnt.localeCompare(b.mnt))
      .map(x => ({ mnt: x.mnt, label: x.label, cur: +(+x.it.lastvalue || 0).toFixed(1) }));

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
      // cpu 优先非分量变体（避开 system.cpu.util[,idle] 等，pref 找不到时仍回退首个）
      cpu: pick(['system.cpu.util', 'hwCPUUsage', 'hrProcessorLoad', 'hwEntityCPUUtilization'], i => !CPU_COMPONENT_RE.test(i.key_)),
      mem: pick(['vm.memory.util', 'hrMemoryLoad']),
      temp: pick(['sensor.temp.value']),
      load: pick(['system.cpu.load'], i => i.key_.includes('avg5')),
      proc: pick(['proc.num'], i => i.key_ === 'proc.num'),
      // fs：指定挂载点优先（mnt 参数）；否则根分区优先、再退 pused 首个
      fs: (mnt && mntMap[mnt]?.it) || pick(['vfs.fs.size', 'vfs.fs.dependent.size'], i => i.key_.includes('pused') && i.units === '%' && (isRootMnt((i.key_.match(FS_PUSED_RE) || [])[1] || '')))
        || pick(['vfs.fs.size', 'vfs.fs.dependent.size'], i => i.key_.includes('pused') && i.units === '%'),
      ping: pick(['icmppingsec']),
    };

    // —— 无线指标（华为 AC）——
    //  AC 级：ac-users-total/2.4/5（search 已带）；AP 级：按 ap 参数（LLD 实例标识）取该 AP 的
    //  clients/上下行流量/CPU/内存。AP key 方括号含点号等，用不带括号的指标前缀 search 再代码端精确匹配。
    const apUsers = {
      total: pick(['ac-users-total']), u24: pick(['ac-users-2.4']), u5: pick(['ac-users-5']),
    };
    let apItems = [];
    if (ap) {
      apItems = await this.rpc('item.get', {
        output: ['itemid', 'key_', 'name', 'lastclock', 'lastvalue', 'value_type', 'history', 'trends', 'units'],
        hostids: [hostid], state: 0, status: 0,
        search: { key_: ['ap-clients-', 'ap-cpu-', 'ap-memory-', 'ap-temp-', 'ap-eth-'] }, searchByAny: true,
      }).catch(() => []);
    }
    const apChosen = {};
    if (ap) {
      for (const it of apItems) {
        const m = /^ap-(clients-2\.4GHz|clientes-5|clients|cpu|memory|temp|eth-download|eth-upload)-\[(.+)\]$/.exec(it.key_);
        if (m && m[2] === ap && Number(it.lastclock)) {
          const slot = { clients: 'clients', 'clients-2.4GHz': 'clients24', 'clientes-5': 'clients5', cpu: 'cpu', memory: 'mem', temp: 'temp', 'eth-download': 'ethIn', 'eth-upload': 'ethOut' }[m[1]];
          if (slot && !apChosen[slot]) apChosen[slot] = it;
        }
      }
    }
    const tIn = ifaceRec?.in || null, tOut = ifaceRec?.out || null;
    const dR = devRec?.read || null, dW = devRec?.write || null;
    const all = [...Object.values(chosen), tIn, tOut, dR, dW,
      apUsers.total, apUsers.u24, apUsers.u5, ...Object.values(apChosen)].filter(Boolean);

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
          sortfield: 'clock', sortorder: 'ASC', limit: 20000,
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
      dio: { dev: devRec?.dev || '', read: mk(dR), write: mk(dW) },
      // 无线：AC 接入用户数（总数/2.4G/5G）+ 选定 AP 的客户端与上下行流量等
      wlanUsers: { total: mk(apUsers.total), u24: mk(apUsers.u24), u5: mk(apUsers.u5) },
      ap: { id: ap, clients: mk(apChosen.clients), clients24: mk(apChosen.clients24), clients5: mk(apChosen.clients5),
        ethIn: mk(apChosen.ethIn), ethOut: mk(apChosen.ethOut), cpu: mk(apChosen.cpu), mem: mk(apChosen.mem), temp: mk(apChosen.temp) },
    };
    const refIt = chosen.cpu || chosen.mem || chosen.temp || chosen.ping || tIn;
    const data = {
      window: { from: t1 * 1000, to: t2 * 1000, range },
      grain,
      points: ['cpu', 'mem', 'temp', 'load', 'proc', 'fs', 'ping']
        .reduce((n, k) => n + (series[k]?.avg?.length || 0), 0)
        + (series.traffic.in.avg?.length || 0) + (series.traffic.out.avg?.length || 0)
        + (series.dio.read.avg?.length || 0) + (series.dio.write.avg?.length || 0),
      retention: { history: refIt?.history || '', trends: refIt?.trends || '' },
      meta: {
        fs: { label: chosen.fs?.name || '磁盘使用', units: chosen.fs?.units || '', mnt: chosen.fs ? ((chosen.fs.key_.match(FS_PUSED_RE) || [])[1] || '').replace(/^"|"$/g, '') : '' },
        traffic: { units: 'bps' },
        dio: { units: 'ops/s' },
      },
      ifaces: ifaces.slice(0, 24),
      devs: devs.slice(0, 16),
      mnts: mnts.slice(0, 16),
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

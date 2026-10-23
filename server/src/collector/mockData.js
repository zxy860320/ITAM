// ============================================================
// 确定性 Mock 数据集 —— 对齐产品文档基线：
//   318 台主机（Linux 186 + Windows 72 + 网络 42 + 数据库 18）
//   36 个应用服务；4,872 监控项；群组映射五条
// ============================================================

// 可复现随机数（mulberry32）
export function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const GROUP_MAPPING = [
  { zbxGroup: 'Linux servers',       domain: 'server',   domainLabel: '服务器',   count: 186, freq: 60 },
  { zbxGroup: 'Windows servers',     domain: 'server',   domainLabel: '服务器',   count: 72,  freq: 60 },
  { zbxGroup: 'Network devices',     domain: 'network',  domainLabel: '网络设备', count: 42,  freq: 120 },
  { zbxGroup: 'MySQL databases',     domain: 'database', domainLabel: '数据库',   count: 18,  freq: 60 },
  { zbxGroup: 'Application services',domain: 'service',  domainLabel: '服务',     count: 36,  freq: 30 },
];

const SEV_ORDER = ['info', 'warning', 'severe', 'critical'];

function pick(r, arr) { return arr[Math.floor(r() * arr.length)]; }
function between(r, lo, hi, dp = 1) { return +(lo + r() * (hi - lo)).toFixed(dp); }
function ip(r, seg) { return `10.${seg}.${Math.floor(r() * 254) + 1}.${Math.floor(r() * 250) + 2}`; }
function spark(r, base, amp, n = 24) {
  const out = []; let v = base;
  for (let i = 0; i < n; i++) { v = Math.max(2, Math.min(98, v + (r() - 0.5) * amp)); out.push(+v.toFixed(1)); }
  return out;
}

// 依据指标值推断可用性
function avail(cpu, mem, disk) {
  const worst = Math.max(cpu, mem, disk);
  if (worst >= 92) return 'critical';
  if (worst >= 80) return 'warning';
  return 'healthy';
}

export function buildDataset(seed = 20261022) {
  const r = rng(seed);
  const hosts = [];
  let hid = 10000;

  const mkHost = (name, domain, group, seg, opts = {}) => {
    const cpu = opts.dead ? 0 : between(r, 8, opts.hot ? 97 : 78);
    const mem = opts.dead ? 0 : between(r, 20, opts.hot ? 98 : 82);
    const disk = opts.dead ? 0 : between(r, 30, 86, 0);
    const h = {
      hostid: String(hid++),
      name,
      domain,
      group,
      ip: ip(r, seg),
      os: opts.os,
      status: opts.dead ? 'off' : 'on',
      availability: opts.dead ? 'critical' : avail(cpu, mem, disk),
      cpu, mem, disk,
      netIn: between(r, 1, 400), netOut: between(r, 1, 260),
      uptimeDays: opts.dead ? 0 : Math.floor(r() * 400) + 1,
      items: opts.items ?? Math.floor(r() * 8) + 8,
      problems: 0,
      cpuSpark: opts.dead ? Array(24).fill(0) : spark(r, cpu, 18),
      memSpark: opts.dead ? Array(24).fill(0) : spark(r, mem, 12),
    };
    return h;
  };

  // 186 台 Linux 服务器
  for (let i = 1; i <= 186; i++)
    hosts.push(mkHost(`srv-lnx-${String(i).padStart(3, '0')}`, 'server', 'Linux servers', 21, { os: 'CentOS 7.9 / Rocky 9' }));
  // 72 台 Windows 服务器
  for (let i = 1; i <= 72; i++)
    hosts.push(mkHost(`srv-win-${String(i).padStart(3, '0')}`, 'server', 'Windows servers', 22, { os: 'Windows Server 2019/2022' }));
  // 42 台网络设备
  const netVendors = ['H3C S6800 核心交换', 'H3C S5130 接入交换', 'H3C SR6600 路由器', 'Huawei CE6881'];
  for (let i = 1; i <= 42; i++) {
    const kind = i <= 6 ? 'core' : i <= 12 ? 'rt' : 'acc';
    hosts.push(mkHost(
      kind === 'core' ? `net-core-sw-${String(i).padStart(2, '0')}` :
      kind === 'rt'   ? `net-edge-rt-${String(i - 6).padStart(2, '0')}` :
                        `net-acc-sw-${String(i - 12).padStart(2, '0')}`,
      'network', 'Network devices', 30, { os: pick(r, netVendors), items: Math.floor(r() * 30) + 30 }));
  }
  // 18 台 MySQL 数据库
  for (let i = 1; i <= 18; i++)
    hosts.push(mkHost(`db-mysql-${String(i).padStart(2, '0')}`, 'database', 'MySQL databases', 40, { os: 'MySQL 8.0.36 / 5.7.44' }));

  // 少量热点/离线，制造告警素材
  const deadIdx = [37, 152, 240];            // 2 台服务器 + 1 台交换机离线
  deadIdx.forEach(i => { hosts[i].status = 'off'; hosts[i].availability = 'critical'; hosts[i].cpu = 0; hosts[i].mem = 0; hosts[i].disk = 0; });
  [12, 90, 205, 261, 301].forEach(i => { hosts[i].cpu = between(r, 92, 98); hosts[i].availability = 'critical'; });
  [5, 33, 61, 110, 188, 230, 270, 310].forEach(i => { hosts[i].mem = between(r, 82, 91); hosts[i].availability = 'warning'; });

  // 36 个应用服务
  const apps = ['订单中心', '用户中心', '支付网关', '库存服务', '消息推送', '认证网关', '报表引擎', '文件服务',
    '搜索服务', '购物车', '营销引擎', '风控服务', '网关 BFF', '对账服务', '日志采集器', '调度中心',
    '配置中心', '缓存代理', '短信通道', '工作流引擎', '合同服务', '发票服务', '客户主数据', '价格中心',
    '促销服务', '评价服务', '物流对接', '仓储 WMS', '结算中心', '客服工作台', '坐席路由', '知识库检索',
    'BI 抽取', '数据同步', '开放平台', '容器镜像代理'];
  const services = apps.map((cn, i) => {
    const rt = between(r, 18, 480);
    const sr = between(r, 96.5, 99.99, 2);
    const dead = i === 18 || i === 29;
    const hot = i === 2 || i === 7;
    return {
      serviceid: String(20000 + i),
      name: `svc-${String(i + 1).padStart(2, '0')}-${cn}`,
      label: cn,
      domain: 'service',
      group: 'Application services',
      status: dead ? 'down' : 'up',
      availability: dead ? 'critical' : (rt > 430 || sr < 97.6) ? 'warning' : 'healthy',
      rt: dead ? 0 : rt,
      qps: dead ? 0 : between(r, 5, 1800),
      successRate: dead ? 0 : sr,
      instances: dead ? '0/2' : `${Math.floor(r() * 3) + 2}/${Math.floor(r() * 2) + 3}`,
      problems: 0,
      rtSpark: dead ? Array(24).fill(0) : spark(r, Math.min(rt, 90), 40),
    };
  });

  // 告警事件流（四态分级）
  const events = [];
  let evid = 300000;
  const now = Date.now();
  const addEvent = (obj, objid, domain, severity, message, agoMin, status = 'active', ackBy = null) => {
    events.push({ eventid: String(evid++), clock: now - agoMin * 60000, severity, object: obj, objectid: objid, domain, message, status, ackBy });
  };
  const crit = hosts.filter(h => h.status === 'off');
  crit.forEach((h, i) => addEvent(h.name, h.hostid, h.domain, 'critical', `${h.name} 不可用（Zabbix agent 无响应）`, 9 + i * 17));
  addEvent(services.find(s => s.status === 'down').name, services.find(s => s.status === 'down').serviceid, 'service', 'critical', '短信通道 实例 0/2，服务完全不可用', 26);
  hosts.filter(h => h.availability === 'critical' && h.status === 'on').forEach((h, i) =>
    addEvent(h.name, h.hostid, h.domain, 'severe', `高 CPU 使用率：${h.cpu}%（阈值 90%，持续 5m）`, 4 + i * 23));
  services.filter(s => s.availability === 'warning').forEach((s, i) =>
    addEvent(s.name, s.serviceid, 'service', 'severe', `响应时间劣化 P95=${Math.round(s.rt * 3)}ms（基线 ${Math.round(s.rt)}ms）`, 12 + i * 31));
  hosts.filter(h => h.availability === 'warning').forEach((h, i) =>
    addEvent(h.name, h.hostid, h.domain, 'warning', `内存使用率 ${h.mem}%（阈值 80%）`, 6 + i * 19, i % 3 === 0 ? 'acked' : 'active', i % 3 === 0 ? '张伟(operator)' : null));
  const infoMsgs = [
    ['net-acc-sw-05', 300000, 'network', '端口 Gi1/0/24 双工模式变更'],
    ['db-mysql-03', 400000, 'database', '慢查询数量上升：12 条/5m'],
    ['srv-lnx-044', 100044, 'server', '磁盘 /data 使用率 78%，接近阈值'],
    ['svc-05-消息推送', 20004, 'service', 'QPS 峰值 1,860，触发容量提醒'],
    ['srv-win-011', 10186 + 11, 'server', 'Windows Update 重启计划已排程'],
    ['net-core-sw-02', 300002, 'network', 'BGP 邻居短暂闪断已自恢复'],
    ['db-mysql-11', 400011, 'database', '主从复制延迟 3.2s'],
  ];
  infoMsgs.forEach(([o, id, d, m], i) => addEvent(o, String(id), d, 'info', m, 15 + i * 44, i % 2 ? 'acked' : 'active', i % 2 ? '李娜(admin)' : null));
  // 历史已确认（用于趋势）
  for (let i = 0; i < 22; i++) {
    const h = pick(r, hosts);
    addEvent(h.name, h.hostid, h.domain, pick(r, SEV_ORDER), `自动恢复：${pick(r, ['CPU 回落至阈值以下', '磁盘空间已清理', '端口流量回归正常', '连接数恢复正常'])}`, 60 + Math.floor(r() * 1380), 'resolved');
  }

  // 主机 problem 计数
  events.filter(e => e.status === 'active').forEach(e => {
    const h = hosts.find(x => x.hostid === e.objectid);
    if (h) h.problems++;
    const s = services.find(x => x.serviceid === e.objectid);
    if (s) s.problems++;
  });

  return { hosts, services, events };
}

// 聚合层：原始数据集 → 各页面所需视图模型
const SEV_RANK = { info: 0, warning: 1, severe: 2, critical: 3 };
export const DOMAIN_LABEL = { server: '服务器', database: '数据库', network: '网络设备', wlan: '无线网络', service: '服务' };

export function byDomain(ds) {
  // wlan = 无线伪域：采集层仍归 network（wlan=true 标记），视图层拆出独立分组
  const out = { server: [], network: [], wlan: [], database: [], service: [] };
  ds.hosts.forEach(h => out[h.domain === 'network' && h.wlan ? 'wlan' : h.domain].push(h));
  out.service = ds.services;
  return out;
}

export function summary(ds) {
  const groups = byDomain(ds);
  const active = ds.events.filter(e => e.status !== 'resolved');
  const sevCount = { critical: 0, severe: 0, warning: 0, info: 0 };
  active.forEach(e => sevCount[e.severity] = (sevCount[e.severity] || 0) + 1);
  const all = [...ds.hosts, ...ds.services];
  return {
    totals: {
      hosts: ds.hosts.length + ds.services.length,
      items: ds.totalItems || all.reduce((s, x) => s + (x.items || 0), 0),
      problemsActive: active.length,
      avgAvail: +(all.reduce((s, x) => s + (x.availability === 'critical' ? 97.2 : x.availability === 'warning' ? 99.1 : 99.95), 0) / all.length).toFixed(2),
    },
    domains: Object.entries(groups).map(([k, arr]) => ({
      domain: k, label: DOMAIN_LABEL[k],
      total: arr.length,
      healthy: arr.filter(x => x.availability === 'healthy').length,
      warning: arr.filter(x => x.availability === 'warning').length,
      critical: arr.filter(x => x.availability === 'critical').length,
    })),
    severity: sevCount,
  };
}

export function topProblems(ds, n = 10) {
  return [...ds.events]
    .filter(e => e.status === 'active')
    .sort((a, b) => (SEV_RANK[b.severity] - SEV_RANK[a.severity]) || (b.clock - a.clock))
    .slice(0, n);
}

export function eventTrend(ds, hours = 24) {
  const now = Date.now();
  const buckets = Array.from({ length: hours }, () => ({ critical: 0, severe: 0, warning: 0, info: 0 }));
  ds.events.forEach(e => {
    const h = Math.floor((now - e.clock) / 3600000);
    if (h >= 0 && h < hours) buckets[hours - 1 - h][e.severity]++;
  });
  return buckets;
}

export function listFilter(qs, { domain, q, status, availability, severity, group }) {
  let out = qs;
  if (domain === 'network') out = out.filter(x => x.domain === 'network' && !x.wlan);
  else if (domain === 'wlan') out = out.filter(x => x.domain === 'network' && x.wlan);
  else if (domain) out = out.filter(x => x.domain === domain);
  if (q) out = out.filter(x => x.name.toLowerCase().includes(q.toLowerCase()) || (x.label || '').includes(q) || (x.ip || '').includes(q));
  if (status) out = out.filter(x => x.status === status);
  if (availability) out = out.filter(x => x.availability === availability);
  // 群组过滤：实体 group 字段可能是多群组 ' / ' 连接（Zabbix 主机组可多个），任一匹配即命中
  if (group) out = out.filter(x => (x.group || '').split(' / ').includes(group));
  return out;
}

// 群组选项：从（未经 group 过滤的）实体集汇聚去重，供前端下拉
export function groupOptions(rows) {
  const set = new Set();
  rows.forEach(x => (x.group || '').split(' / ').forEach(g => g && set.add(g)));
  return [...set].sort((a, b) => a.localeCompare(b));
}

// ---------- 列表排序（白名单字段，防注入；服务端分页故排序必须在后端做） ----------
const AVAIL_RANK = { critical: 0, warning: 1, healthy: 2 };
const SORT_GET = Object.assign(Object.create(null), {
  name: x => x.name || '',
  ip: x => x.ip || '',
  group: x => x.group || '',
  availability: x => AVAIL_RANK[x.availability] ?? 3,
  problems: x => x.problems ?? null,
  noiseProblems: x => x.noiseProblems ?? null,
  cpu: x => x.cpu ?? null,
  mem: x => x.mem ?? null,
  disk: x => x.disk ?? null,
  uptimeDays: x => x.uptimeDays ?? null,
  pingMs: x => x.pingMs ?? null,
  temp: x => x.temp ?? null,
  rt: x => x.rt ?? null,
  qps: x => x.qps ?? x.dbMetrics?.qps ?? null,
  successRate: x => x.successRate ?? null,
  instances: x => x.instances ?? null,
  conn: x => x.dbMetrics?.threads_connected ?? null,
  threads: x => x.dbMetrics?.threads_running ?? null,
  dbRole: x => x.dbRole || '',
  version: x => x.version || '',
  apTotal: x => x.apTotal ?? null,
  wlanUsers: x => x.wlanUsers ?? null,
});

// sort 不在白名单内时不排序（返回原数组）；null/空值恒沉底（不随方向翻转）
export function sortEntities(rows, sort, dir) {
  const get = SORT_GET[sort];
  if (!get) return rows;
  const sign = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = get(a), vb = get(b);
    const na = va == null || va === '', nb = vb == null || vb === '';
    if (na && nb) return String(a.name || '').localeCompare(String(b.name || ''));
    if (na) return 1;
    if (nb) return -1;
    if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * sign;
    return String(va).localeCompare(String(vb)) * sign;
  });
}

export function paginate(arr, page = 1, size = 20) {
  const total = arr.length;
  const start = (page - 1) * size;
  return { total, page, size, rows: arr.slice(start, start + size) };
}

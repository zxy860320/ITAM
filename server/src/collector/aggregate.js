// 聚合层：原始数据集 → 各页面所需视图模型
const SEV_RANK = { info: 0, warning: 1, severe: 2, critical: 3 };
export const DOMAIN_LABEL = { server: '服务器', database: '数据库', network: '网络设备', service: '服务' };

export function byDomain(ds) {
  const out = { server: [], network: [], database: [], service: [] };
  ds.hosts.forEach(h => out[h.domain].push(h));
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

export function listFilter(qs, { domain, q, status, availability, severity }) {
  let out = qs;
  if (domain) out = out.filter(x => x.domain === domain);
  if (q) out = out.filter(x => x.name.toLowerCase().includes(q.toLowerCase()) || (x.label || '').includes(q) || (x.ip || '').includes(q));
  if (status) out = out.filter(x => x.status === status);
  if (availability) out = out.filter(x => x.availability === availability);
  return out;
}

export function paginate(arr, page = 1, size = 20) {
  const total = arr.length;
  const start = (page - 1) * size;
  return { total, page, size, rows: arr.slice(start, start + size) };
}

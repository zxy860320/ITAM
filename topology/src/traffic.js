// 链路/接口流量取数：metric_mapping → Zabbix history/trend（>86400s 走 trend 包络）
// 继承 P0 series() 窗口规则：range≤86400 → history raw；>86400 → trend hour min/avg/max
const SPAN = { '6h': 21600, '24h': 86400, '7d': 604800, '30d': 2592000 };

export async function itemSeries(zbx, itemid, range, till = 0) {
  const span = SPAN[range] || SPAN['6h'];
  const now = Math.floor(Date.now() / 1000);
  const t2 = Math.min(Math.max(0, Math.floor(+till || 0)), now) || now;
  const t1 = t2 - span;
  if (span > 86400) {
    const rows = await zbx.call('trend.get', {
      output: ['clock', 'value_min', 'value_avg', 'value_max'],
      itemids: [itemid], time_from: t1, time_till: t2, sortfield: 'clock', sortorder: 'ASC', limit: 9000,
    });
    return {
      grain: 'hour',
      avg: rows.map(r => ({ t: +r.clock * 1000, v: +(+r.value_avg).toFixed(2) })),
      max: rows.map(r => +(+r.value_max).toFixed(2)),
      min: rows.map(r => +(+r.value_min).toFixed(2)),
    };
  }
  const rows = await zbx.call('history.get', {
    output: ['clock', 'value'], itemids: [itemid], history: 3,
    time_from: t1, time_till: t2, sortfield: 'clock', sortorder: 'ASC', limit: 20000,
  });
  return { grain: 'raw', avg: rows.map(r => ({ t: +r.clock * 1000, v: +(+r.value).toFixed(2) })) };
}

export async function getIfaceMappings(db, ifaceId) {
  return db.prepare('SELECT metric, zbx_itemid, stale FROM topology_metric_mapping WHERE interface_id=?').all(ifaceId);
}

export async function ifaceTraffic(zbx, db, ifaceId, range, till) {
  const maps = await getIfaceMappings(db, ifaceId);
  const out = { units: 'bps', stale_mapping: maps.some(m => m.stale) };
  for (const metric of ['if_in', 'if_out']) {
    const m = maps.find(x => x.metric === metric);
    if (!m || m.stale) { out[metric] = { avg: [] }; continue; }
    try { out[metric] = await itemSeries(zbx, m.zbx_itemid, range, till); }
    catch { out[metric] = { avg: [] }; }
  }
  return out;
}

// topology-svc 入口（独立进程 :8790；P0 代码零改动）
// API 设计见 docs/TOPOLOGY-P1-DESIGN.md §5
import express from 'express';
import { openDb, metaGet, metaSet } from './db.js';
import { CFG } from './config.js';
import { Zbx } from './zbx.js';
import { syncTopology } from './sync.js';
import { runDiscovery, cleanupManagedItems } from './discovery.js';
import { ifaceTraffic } from './traffic.js';
import { refreshRouteSnapshots, snapshotStatus, tracePath, cleanupRouteItems } from './pathtrace.js';

const db = openDb(CFG.dbFile);
const zbx = new Zbx(CFG.zbx);
const app = express();
app.use(express.json());
app.use((req, res, next) => { res.set('Access-Control-Allow-Origin', '*'); next(); });

let syncRunning = false, discRunning = false, rtRunning = false;

// 统一的发现启动器：异步排队执行，完成后写 last_disc（供 /discovery/summary 展示）
function startDiscovery(nodeIds) {
  if (discRunning) return false;
  discRunning = true;
  runDiscovery(db, zbx, CFG, { nodeIds, log: m => console.log('[disc]', m) })
    .then(r => metaSet(db, 'last_disc', JSON.stringify({ ...r, at: Math.floor(Date.now() / 1000) })))
    .catch(e => metaSet(db, 'last_disc', JSON.stringify({ error: String(e.message || e), at: Math.floor(Date.now() / 1000) })))
    .finally(() => { discRunning = false; });
  return true;
}

// ---------- 健康 ----------
app.get('/health', async (req, res) => {
  let version = null, err = null;
  if (zbx.ok()) { try { version = await zbx.version(); } catch (e) { err = e.message; } }
  res.json({
    svc: 'topology-svc', zbx_connected: !!version, zbx_version: version, zbx_error: err,
    db: CFG.dbFile,
    nodes: db.prepare('SELECT COUNT(*) c FROM topology_node').get().c,
    interfaces: db.prepare('SELECT COUNT(*) c FROM topology_interface WHERE stale=0').get().c,
    links: db.prepare("SELECT status, COUNT(*) c FROM topology_link GROUP BY status").all(),
    last_sync: metaGet(db, 'last_sync'),
  });
});

// ---------- 同步 ----------
app.post('/api/topology/sync', async (req, res) => {
  if (syncRunning) return res.status(409).json({ error: 'sync running' });
  syncRunning = true;
  try {
    const stat = await syncTopology(db, zbx, CFG, m => console.log('[sync]', m));
    metaSet(db, 'last_sync', Math.floor(Date.now() / 1000));
    // 同步入库后自动对「从未被 LLDP 发现过」的新节点补一轮定向发现
    // （根因修复：发现运行取启动时刻节点快照，晚同步入库的设备不会被上一轮覆盖）
    const fresh = db.prepare(
      `SELECT node_id FROM topology_node n WHERE n.status='active'
        AND NOT EXISTS (SELECT 1 FROM topology_discovery_record r WHERE r.node_id=n.node_id)`
    ).all().map(r => String(r.node_id));
    let autoDiscovered = 0;
    if (fresh.length && startDiscovery(fresh)) autoDiscovered = fresh.length;
    res.json({ ok: true, stat, auto_discovery_queued: autoDiscovered });
  } catch (e) { res.status(502).json({ error: String(e.message || e) }); }
  finally { syncRunning = false; }
});

// ---------- 节点 ----------
app.get('/api/topology/nodes', (req, res) => {
  const { status, vendor, q } = req.query;
  const page = Math.max(1, Number(req.query.page || 1)), size = Math.min(200, Number(req.query.size || 50));
  let sql = `SELECT n.*,
      (SELECT COUNT(*) FROM topology_interface i WHERE i.node_id=n.node_id AND i.stale=0) iface_count,
      (SELECT COUNT(*) FROM topology_link l WHERE (l.a_node=n.node_id OR l.b_node=n.node_id) AND l.status NOT IN ('stale','rejected')) link_count
    FROM topology_node n WHERE 1=1`;
  let where = ' WHERE 1=1';
  const args = [];
  if (status) { sql += ' AND n.status=?'; where += ' AND n.status=?'; args.push(status); }
  if (vendor) { sql += ' AND n.vendor=?'; where += ' AND n.vendor=?'; args.push(vendor); }
  if (q) { sql += ' AND (n.display_name LIKE ? OR n.mgmt_ip LIKE ?)'; where += ' AND (n.display_name LIKE ? OR n.mgmt_ip LIKE ?)'; args.push(`%${q}%`, `%${q}%`); }
  const total = db.prepare('SELECT COUNT(*) c FROM topology_node n' + where).get(...args).c;
  const rows = db.prepare(sql + ' ORDER BY n.status DESC, n.display_name LIMIT ? OFFSET ?').all(...args, size, (page - 1) * size);
  res.json({ data: rows.map(r => ({ ...r, health_flags: JSON.parse(r.health_flags || '{}') })), meta: { page, size, total } });
});

app.get('/api/topology/nodes/:id', (req, res) => {
  const n = db.prepare('SELECT * FROM topology_node WHERE node_id=?').get(+req.params.id);
  if (!n) return res.status(404).json({ error: 'not found' });
  // CAST speed_bps AS REAL：部分设备 ifHighSpeed 异常值（如 4e16）超 JS 安全整数，node:sqlite 读 INTEGER 会 RangeError
  const ifaces = db.prepare(`SELECT i.*, CAST(i.speed_bps AS REAL) AS speed_bps,
      (SELECT l.status FROM topology_link l WHERE l.a_iface=i.interface_id OR l.b_iface=i.interface_id
        ORDER BY CASE l.status WHEN 'confirmed' THEN 0 WHEN 'manual' THEN 1 WHEN 'half' THEN 2 ELSE 3 END LIMIT 1) link_status
    FROM topology_interface i WHERE i.node_id=? AND i.stale=0 ORDER BY i.if_index`).all(n.node_id);
  const recs = db.prepare(`SELECT record_id, run_id, result, neighbors_found, error, started_at FROM topology_discovery_record
    WHERE node_id=? ORDER BY record_id DESC LIMIT 5`).all(n.node_id);
  res.json({ data: { ...n, health_flags: JSON.parse(n.health_flags || '{}'), interfaces: ifaces, discovery_recent: recs } });
});

// ---------- 接口 ----------
app.get('/api/topology/interfaces', (req, res) => {
  const { node_id, if_type, has_link } = req.query;
  const page = Math.max(1, Number(req.query.page || 1)), size = Math.min(500, Number(req.query.size || 100));
  let sql = `SELECT i.*, n.display_name FROM topology_interface i JOIN topology_node n ON n.node_id=i.node_id WHERE i.stale=0`;
  const args = [];
  if (node_id) { sql += ' AND i.node_id=?'; args.push(+node_id); }
  if (if_type) { sql += ' AND i.if_type=?'; args.push(if_type); }
  if (has_link === '1') sql += ' AND EXISTS (SELECT 1 FROM topology_link l WHERE (l.a_iface=i.interface_id OR l.b_iface=i.interface_id) AND l.status NOT IN (\'stale\',\'rejected\'))';
  if (has_link === '0') sql += ' AND NOT EXISTS (SELECT 1 FROM topology_link l WHERE (l.a_iface=i.interface_id OR l.b_iface=i.interface_id) AND l.status NOT IN (\'stale\',\'rejected\'))';
  const total = db.prepare(sql.replace('SELECT i.*, n.display_name FROM', 'SELECT COUNT(*) c FROM')).get(...args).c;
  const rows = db.prepare(sql + ' ORDER BY n.display_name, i.if_index LIMIT ? OFFSET ?').all(...args, size, (page - 1) * size);
  res.json({ data: rows, meta: { page, size, total } });
});

// ---------- 链路 ----------
const linkSql = `SELECT l.*, na.display_name a_name, ia.if_name a_ifname, ia.oper_status a_oper, ia.speed_bps a_speed,
    nb.display_name b_name, ib.if_name b_ifname, ib.oper_status b_oper, ib.speed_bps b_speed
  FROM topology_link l
  LEFT JOIN topology_node na ON na.node_id=l.a_node
  LEFT JOIN topology_interface ia ON ia.interface_id=l.a_iface
  LEFT JOIN topology_node nb ON nb.node_id=l.b_node
  LEFT JOIN topology_interface ib ON ib.interface_id=l.b_iface`;
function shapeLink(r) {
  return {
    link_id: r.link_id,
    a: { node_id: r.a_node, name: r.a_name, iface: r.a_ifname, iface_id: r.a_iface, oper: r.a_oper ?? null, speed: r.a_speed ?? null },
    b: r.b_iface ? { node_id: r.b_node, name: r.b_name, iface: r.b_ifname, iface_id: r.b_iface, oper: r.b_oper ?? null, speed: r.b_speed ?? null }
      : { node_id: r.b_node, name: r.b_name || (r.b_snapshot && JSON.parse(r.b_snapshot).sys_name) || null,
          iface: r.b_snapshot && JSON.parse(r.b_snapshot).port_id || null, iface_id: null },
    b_snapshot: r.b_snapshot ? JSON.parse(r.b_snapshot) : null,
    status: r.status, source: r.source, confidence: r.confidence,
    last_seen: r.last_seen, missing_rounds: r.missing_rounds,
  };
}
app.get('/api/topology/links', (req, res) => {
  const { status, source, node_id } = req.query;
  const page = Math.max(1, Number(req.query.page || 1)), size = Math.min(500, Number(req.query.size || 100));
  let sql = linkSql + ' WHERE 1=1'; const args = [];
  if (status) { sql += ' AND l.status=?'; args.push(status); }
  if (source) { sql += ' AND l.source=?'; args.push(source); }
  if (node_id) { sql += ' AND (l.a_node=? OR l.b_node=?)'; args.push(+node_id, +node_id); }
  const total = db.prepare(sql.replace(linkSql.split(' FROM')[0] + ' FROM', 'SELECT COUNT(*) c FROM')).get(...args).c;
  const rows = db.prepare(sql + ' ORDER BY CASE l.status WHEN \'confirmed\' THEN 0 WHEN \'manual\' THEN 1 WHEN \'half\' THEN 2 WHEN \'conflict\' THEN 3 ELSE 4 END, l.link_id LIMIT ? OFFSET ?').all(...args, size, (page - 1) * size);
  res.json({ data: rows.map(shapeLink), meta: { page, size, total } });
});
// 审核页专用：分页 + total + 过滤（status/node_id/置信带/对端搜索），默认高置信在前（先审最容易确认的）
// 附带 summary：按状态、置信带、a 端设备的聚合，供审核页做过滤下拉与"按设备批量"操作
app.get('/api/topology/links/pending', (req, res) => {
  const statuses = String(req.query.status || 'half,conflict').split(',').map(s => s.trim()).filter(s => ['half', 'conflict', 'stale'].includes(s));
  if (!statuses.length) return res.status(400).json({ error: 'status 仅支持 half/conflict/stale 组合' });
  const page = Math.max(1, Number(req.query.page || 1)), size = Math.min(500, Number(req.query.size || 100));
  let where = ` WHERE l.status IN (${statuses.map(() => '?').join(',')})`; const args = [...statuses];
  if (req.query.node_id) { where += ' AND l.a_node=?'; args.push(+req.query.node_id); }
  const minConf = req.query.min_confidence, maxConf = req.query.max_confidence;
  if (minConf !== undefined) { where += ' AND l.confidence>=?'; args.push(Number(minConf)); }
  if (maxConf !== undefined) { where += ' AND l.confidence<=?'; args.push(Number(maxConf)); }
  if (req.query.q) { // 对端线索搜索：已解析 b 端名称 / b_snapshot 原始证据 / a 端设备名与接口
    const like = `%${req.query.q}%`;
    where += ` AND (nb.display_name LIKE ? OR na.display_name LIKE ? OR ia.if_name LIKE ? OR ib.if_name LIKE ? OR l.b_snapshot LIKE ?)`;
    args.push(like, like, like, like, like);
  }
  const from = linkSql + where;
  const total = db.prepare(from.replace(linkSql.split(' FROM')[0] + ' FROM', 'SELECT COUNT(*) c FROM')).get(...args).c;
  const rows = db.prepare(from + ' ORDER BY l.confidence DESC, l.link_id DESC LIMIT ? OFFSET ?').all(...args, size, (page - 1) * size);
  // summary 不受 q 影响（用于过滤控件本身），但受 status 影响
  let w2 = ` WHERE l.status IN (${statuses.map(() => '?').join(',')})`; const a2 = [...statuses];
  if (req.query.node_id) { w2 += ' AND l.a_node=?'; a2.push(+req.query.node_id); }
  const by_status = db.prepare(`SELECT l.status, COUNT(*) c FROM topology_link l${w2} GROUP BY l.status`).all(...a2);
  const by_conf = db.prepare(`SELECT CASE WHEN l.confidence>=0.9 THEN '>=0.9' WHEN l.confidence>=0.5 THEN '0.5-0.89' ELSE '<0.5' END band, COUNT(*) c
    FROM topology_link l${w2} GROUP BY band ORDER BY band`).all(...a2);
  const by_node = db.prepare(`SELECT l.a_node node_id, na.display_name name, COUNT(*) c FROM topology_link l
    JOIN topology_node na ON na.node_id=l.a_node${w2} GROUP BY l.a_node ORDER BY c DESC LIMIT 100`).all(...a2);
  res.json({ data: rows.map(shapeLink), meta: { page, size, total, by_status, by_conf, by_node } });
});
// 批量确认/忽略：ids 显式列表，或 match={node_id,min_confidence,max_confidence} 按过滤条件圈定（二选一，operator 必填）
function bulkAction(req, res, action) {
  const operator = req.body?.operator; if (!operator) return res.status(400).json({ error: 'operator required' });
  const now = Math.floor(Date.now() / 1000);
  let ids = [];
  if (Array.isArray(req.body?.link_ids) && req.body.link_ids.length) ids = req.body.link_ids.map(Number);
  else if (req.body?.match) {
    const m = req.body.match;
    let where = ` WHERE l.status IN ('half','conflict','stale')`; const args = [];
    if (m.node_id) { where += ' AND l.a_node=?'; args.push(+m.node_id); }
    if (m.min_confidence !== undefined) { where += ' AND l.confidence>=?'; args.push(Number(m.min_confidence)); }
    if (m.max_confidence !== undefined) { where += ' AND l.confidence<=?'; args.push(Number(m.max_confidence)); }
    ids = db.prepare(`SELECT l.link_id FROM topology_link l${where}`).all(...args).map(r => Number(r.link_id));
  } else return res.status(400).json({ error: 'link_ids 或 match 必填' });
  if (!ids.length) return res.json({ ok: true, affected: 0 });
  const ph = ids.map(() => '?').join(',');
  let affected;
  if (action === 'confirm') {
    affected = db.prepare(`UPDATE topology_link SET status='confirmed', confirmed_by=?, confirmed_at=?, note=COALESCE(?,note)
      WHERE link_id IN (${ph}) AND status IN ('half','conflict','stale')`).run(operator, now, req.body?.note || null, ...ids).changes;
  } else {
    affected = db.prepare(`UPDATE topology_link SET status='rejected', confirmed_by=?, confirmed_at=?, note=COALESCE(?,note)
      WHERE link_id IN (${ph}) AND status IN ('half','conflict','stale')`).run(operator, now, req.body?.reason || null, ...ids).changes;
  }
  res.json({ ok: true, affected, requested: ids.length });
}
app.post('/api/topology/links/bulk-confirm', (req, res) => bulkAction(req, res, 'confirm'));
app.post('/api/topology/links/bulk-reject', (req, res) => bulkAction(req, res, 'reject'));
app.post('/api/topology/links/:id/confirm', (req, res) => {
  const operator = req.body?.operator; if (!operator) return res.status(400).json({ error: 'operator required' });
  const l = db.prepare('SELECT * FROM topology_link WHERE link_id=?').get(+req.params.id);
  if (!l) return res.status(404).json({ error: 'not found' });
  if (!['half', 'conflict', 'stale'].includes(l.status)) return res.status(400).json({ error: `status=${l.status} 不可确认` });
  db.prepare("UPDATE topology_link SET status='confirmed', confirmed_by=?, confirmed_at=?, note=COALESCE(?,note) WHERE link_id=?")
    .run(operator, Math.floor(Date.now() / 1000), req.body?.note || null, l.link_id);
  res.json({ ok: true });
});
app.post('/api/topology/links/:id/reject', (req, res) => {
  const operator = req.body?.operator; if (!operator) return res.status(400).json({ error: 'operator required' });
  const l = db.prepare('SELECT * FROM topology_link WHERE link_id=?').get(+req.params.id);
  if (!l) return res.status(404).json({ error: 'not found' });
  db.prepare("UPDATE topology_link SET status='rejected', confirmed_by=?, confirmed_at=?, note=? WHERE link_id=?")
    .run(operator, Math.floor(Date.now() / 1000), req.body?.reason || null, l.link_id);
  res.json({ ok: true });
});
app.post('/api/topology/links', (req, res) => {
  const { a_node_id, a_interface_id, b_node_id, b_interface_id, operator, note } = req.body || {};
  if (!a_node_id || !a_interface_id || !b_node_id || !b_interface_id || !operator)
    return res.status(400).json({ error: 'a/b 两端节点与接口、operator 必填' });
  if (+a_interface_id === +b_interface_id) return res.status(400).json({ error: '自环不允许' });
  const ia = db.prepare('SELECT * FROM topology_interface WHERE interface_id=? AND node_id=? AND stale=0').get(+a_interface_id, +a_node_id);
  const ib = db.prepare('SELECT * FROM topology_interface WHERE interface_id=? AND node_id=? AND stale=0').get(+b_interface_id, +b_node_id);
  if (!ia || !ib) return res.status(404).json({ error: '接口不存在或已 stale（须与节点匹配）' });
  const pair = [[+a_node_id, +a_interface_id], [+b_node_id, +b_interface_id]].sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const normKey = `L:${pair[0][0]}:${pair[0][1]}|${pair[1][0]}:${pair[1][1]}`;
  if (db.prepare('SELECT link_id FROM topology_link WHERE norm_key=?').get(normKey))
    return res.status(409).json({ error: '该端点对链路已存在' });
  const now = Math.floor(Date.now() / 1000);
  const r = db.prepare(`INSERT INTO topology_link(norm_key,a_node,a_iface,b_node,b_iface,status,source,confidence,confirmed_by,confirmed_at,discovered_at,last_seen,note)
    VALUES(?,?,?,?,?,'manual','manual',1,?,?,?, ?,?)`)
    .run(normKey, pair[0][0], pair[0][1], pair[1][0], pair[1][1], operator, now, now, now, note || null);
  res.status(201).json({ ok: true, link_id: Number(r.lastInsertRowid) });
});
app.delete('/api/topology/links/:id', (req, res) => {
  const l = db.prepare('SELECT * FROM topology_link WHERE link_id=?').get(+req.params.id);
  if (!l) return res.status(404).json({ error: 'not found' });
  if (l.source !== 'manual') return res.status(403).json({ error: '仅 manual 链路可删除；LLDP 链路请用 reject' });
  db.prepare('DELETE FROM topology_link WHERE link_id=?').run(l.link_id);
  res.json({ ok: true });
});

// ---------- 链路流量 ----------
app.get('/api/topology/links/:id/traffic', async (req, res) => {
  const l = db.prepare('SELECT * FROM topology_link WHERE link_id=?').get(+req.params.id);
  if (!l) return res.status(404).json({ error: 'not found' });
  const range = String(req.query.range || '6h'), till = Number(req.query.till || 0);
  const get = async (nodeId, ifaceId) => {
    if (!ifaceId) return { node_id: nodeId, in: { avg: [] }, out: { avg: [] }, unavailable: true };
    const t = await ifaceTraffic(zbx, db, ifaceId, range, till);
    return { node_id: nodeId, iface_id: ifaceId, ...t };
  };
  try {
    const a = await get(l.a_node, l.a_iface);
    const b = l.b_iface ? await get(l.b_node, l.b_iface) : { unavailable: true };
    res.json({ data: { a, b }, meta: { range, grain: a.grain || null, units: 'bps', stale_mapping: !!(a.stale_mapping) } });
  } catch (e) { res.status(502).json({ error: String(e.message || e) }); }
});

// ---------- 图 ----------
app.get('/api/topology/graph', (req, res) => {
  const inc = new Set(String(req.query.include || '').split(','));
  const linkStatusOk = ["'confirmed'", "'manual'", "'half'"];
  if (inc.has('stale')) linkStatusOk.push("'stale'");
  if (inc.has('conflict')) linkStatusOk.push("'conflict'");
  // max_speed_bps 仅作前端视觉分层（核心/汇聚/接入），不作为拓扑事实
  const nodes = db.prepare(`SELECT node_id, display_name, node_type, vendor, mgmt_ip, chassis_id, status,
      (SELECT COUNT(*) FROM topology_interface i WHERE i.node_id=n.node_id AND i.stale=0) iface_count,
      (SELECT CAST(MAX(i.speed_bps) AS REAL) FROM topology_interface i WHERE i.node_id=n.node_id AND i.stale=0 AND i.speed_bps>0 AND i.speed_bps<=10000000000000) max_speed_bps
    FROM topology_node n`).all();
  // 只读证据字段：norm_key / seen_* / 双端 oper / b_snapshot 原样解析。
  // b_if 不再回退 sys_name（名称≠接口，前端按 b_snapshot 快照单独渲染"未纳管对端"）。
  const links = db.prepare(`SELECT l.link_id, l.norm_key, l.a_node, a.if_name a_ifname, a.oper_status a_oper, na.display_name a_name,
      l.b_node, b.if_name b_ifname, b.oper_status b_oper, nb.display_name b_name,
      l.b_snapshot, l.status, l.source, l.confidence, l.seen_a_at, l.seen_b_at
    FROM topology_link l
    LEFT JOIN topology_interface a ON a.interface_id=l.a_iface
    LEFT JOIN topology_interface b ON b.interface_id=l.b_iface
    LEFT JOIN topology_node na ON na.node_id=l.a_node
    LEFT JOIN topology_node nb ON nb.node_id=l.b_node
    WHERE l.status IN (${linkStatusOk.join(',')})`).all()
    .map(r => ({
      link_id: r.link_id, norm_key: r.norm_key,
      a: r.a_node, a_if: r.a_ifname, a_oper: r.a_oper, a_name: r.a_name,
      b: r.b_node, b_if: r.b_ifname, b_oper: r.b_oper, b_name: r.b_name,
      b_snapshot: r.b_snapshot ? JSON.parse(r.b_snapshot) : null,
      status: r.status, source: r.source, confidence: r.confidence,
      seen_a_at: r.seen_a_at, seen_b_at: r.seen_b_at,
    }));
  res.json({ data: { nodes, links }, meta: { node_count: nodes.length, link_count: links.length, include: [...inc] } });
});

// ---------- 发现 ----------
app.post('/api/topology/discovery/run', async (req, res) => {
  if (discRunning) return res.status(409).json({ error: 'discovery running' });
  const nodeIds = req.body?.node_ids || null;
  startDiscovery(nodeIds);
  res.status(202).json({ queued: (nodeIds || db.prepare("SELECT node_id FROM topology_node WHERE status<>'stale'").all()).length, note: '异步执行，GET /api/topology/discovery/summary 查看进度' });
});
app.get('/api/topology/discovery/runs', (req, res) => {
  const rows = db.prepare(`SELECT run_id, MIN(started_at) started_at, MAX(finished_at) finished_at,
      COUNT(*) nodes, SUM(neighbors_found) neighbors,
      SUM(CASE WHEN result='ok' THEN 1 ELSE 0 END) ok,
      SUM(CASE WHEN result<>'ok' THEN 1 ELSE 0 END) not_ok
    FROM topology_discovery_record GROUP BY run_id ORDER BY run_id DESC LIMIT ?`).all(Math.min(50, Number(req.query.size || 20)));
  res.json({ data: rows });
});
app.get('/api/topology/discovery/records', (req, res) => {
  const { run_id, result } = req.query;
  let sql = `SELECT r.*, n.display_name FROM topology_discovery_record r LEFT JOIN topology_node n ON n.node_id=r.node_id WHERE 1=1`;
  const args = [];
  if (run_id) { sql += ' AND r.run_id=?'; args.push(run_id); }
  if (result) { sql += ' AND r.result=?'; args.push(result); }
  const rows = db.prepare(sql + ' ORDER BY r.record_id DESC LIMIT ?').all(...args, Math.min(500, Number(req.query.size || 100)));
  res.json({ data: rows.map(r => ({ ...r, raw_snapshot: r.raw_snapshot ? `<${r.raw_snapshot.length} bytes>` : null })) });
});
app.get('/api/topology/discovery/summary', (req, res) => {
  const lastRun = metaGet(db, 'last_disc');
  res.json({ data: {
    nodes_total: db.prepare('SELECT COUNT(*) c FROM topology_node').get().c,
    nodes_active: db.prepare("SELECT COUNT(*) c FROM topology_node WHERE status='active'").get().c,
    nodes_degraded: db.prepare("SELECT COUNT(*) c FROM topology_node WHERE status='degraded'").get().c,
    links: db.prepare('SELECT status, COUNT(*) c FROM topology_link GROUP BY status').all(),
    // P2-M1：按最新一轮各节点 result 分布（ok/rem_empty_indeterminate/rem_empty_aged/mib_unsupported/snmp_unreachable/walk_empty/...）
    latest_results: db.prepare(`SELECT r.result, COUNT(*) c FROM topology_discovery_record r
      WHERE r.record_id IN (SELECT MAX(record_id) FROM topology_discovery_record GROUP BY node_id)
      GROUP BY r.result ORDER BY c DESC`).all(),
    walk_empty_nodes: db.prepare(`SELECT n.display_name FROM topology_discovery_record r JOIN topology_node n ON n.node_id=r.node_id
      WHERE r.result='walk_empty' AND r.record_id IN (SELECT MAX(record_id) FROM topology_discovery_record GROUP BY node_id) LIMIT 50`).all().map(r => r.display_name),
    last_run: lastRun ? JSON.parse(lastRun) : null,
    discovery_running: discRunning,
  } });
});
app.post('/api/topology/discovery/cleanup', async (req, res) => {
  try { res.json({ ok: true, deleted: await cleanupManagedItems(zbx) }); }
  catch (e) { res.status(502).json({ error: String(e.message || e) }); }
});

// ---------- 接口流量（pathtrace 中无链路证据的 hop 用本端接口视角看流量） ----------
app.get('/api/topology/interfaces/:id/traffic', async (req, res) => {
  const i = db.prepare('SELECT interface_id, node_id FROM topology_interface WHERE interface_id=? AND stale=0').get(+req.params.id);
  if (!i) return res.status(404).json({ error: 'not found' });
  const range = String(req.query.range || '6h'), till = Number(req.query.till || 0);
  try {
    const t = await ifaceTraffic(zbx, db, i.interface_id, range, till);
    res.json({ data: { node_id: i.node_id, iface_id: i.interface_id, ...t }, meta: { range, units: 'bps' } });
  } catch (e) { res.status(502).json({ error: String(e.message || e) }); }
});

// ---------- 路径追踪（流量走势页数据源；只读，快照缓存 topo_meta） ----------
app.get('/api/topology/pathtrace', (req, res) => {
  const { src, dst } = req.query;
  if (!src || !dst) return res.status(400).json({ error: 'src/dst 必填（IPv4）' });
  const r = tracePath(db, String(src), String(dst));
  if (r.error) return res.status(422).json({ error: r.error });
  res.json({ data: r });
});
app.get('/api/topology/pathtrace/status', (req, res) => {
  const s = snapshotStatus(db);
  res.json({ data: s.data, meta: { last_refresh: s.last_refresh, refreshing: rtRunning } });
});
app.post('/api/topology/pathtrace/refresh', (req, res) => {
  if (rtRunning) return res.status(409).json({ error: 'route snapshot refresh running' });
  rtRunning = true;
  const nodeIds = req.body?.node_ids || null;
  refreshRouteSnapshots(db, zbx, { nodeIds, log: m => console.log('[rt]', m) })
    .catch(e => console.error('[rt]', e))
    .finally(() => { rtRunning = false; });
  res.status(202).json({ queued: (nodeIds || db.prepare("SELECT node_id FROM topology_node WHERE status<>'stale' AND (display_name LIKE '%核心%' OR display_name LIKE '%CORE%' OR display_name LIKE '%汇聚%' OR display_name LIKE '%AGG%' OR display_name LIKE '%FW%' OR display_name LIKE '%防火墙%' OR display_name LIKE '%互联网%' OR display_name LIKE '%接入区%')").all()).length, note: '异步执行（每批创建托管项→等待首轮→读取→删除），GET /api/topology/pathtrace/status 查看' });
});
app.post('/api/topology/pathtrace/cleanup', async (req, res) => {
  try { res.json({ ok: true, deleted: await cleanupRouteItems(zbx) }); }
  catch (e) { res.status(502).json({ error: String(e.message || e) }); }
});

app.listen(CFG.port, () => console.log(`[topology-svc] http://localhost:${CFG.port}  db=${CFG.dbFile}`));

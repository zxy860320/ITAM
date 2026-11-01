// topology-svc 入口（独立进程 :8790；P0 代码零改动）
// API 设计见 docs/TOPOLOGY-P1-DESIGN.md §5；V2 权限见 docs/TOPOLOGY-V2-DESIGN.md §10
import express from 'express';
import { openDb, metaGet, metaSet } from './db.js';
import { CFG } from './config.js';
import { Zbx } from './zbx.js';
import { syncTopology } from './sync.js';
import { runDiscovery, cleanupManagedItems } from './discovery.js';
import { ifaceTraffic } from './traffic.js';
import { refreshRouteSnapshots, snapshotStatus, tracePath, cleanupRouteItems } from './pathtrace.js';
import { initAuth, authMiddleware, requireRole, loginRateLimited, setSessionCookie, clearSessionCookie, newToken, scryptVerify, COOKIE, SESSION_TTL } from './auth.js';

const db = await openDb(CFG);
console.log(`[topology-svc] db engine=${db.kind} @ ${db.location}`);
await initAuth(db);
const zbx = new Zbx(CFG.zbx);
const app = express();
app.use(express.json());
// V2：生产走 nginx /topo-api 同源代理、开发走 vite 代理——本就不依赖跨域。
// 通配 CORS + 凭据是危险组合，收紧为显式白名单（直连调试用）。
const CORS_ALLOW = (process.env.TOPO_CORS_ORIGINS || 'http://localhost:5273,http://127.0.0.1:5273').split(',').map(s => s.trim()).filter(Boolean);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && CORS_ALLOW.includes(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Access-Control-Allow-Credentials', 'true');
    res.set('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') {
    res.set('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    return res.sendStatus(204);
  }
  next();
});
app.use(authMiddleware(db));

// 兼容期：body.operator 自报一律忽略（会话为唯一事实）；出现即 WARN 便于发现旧调用方
function sessionOperator(req, bodyOperator) {
  if (bodyOperator && bodyOperator !== req.auth?.user)
    console.warn(`[auth] body.operator "${bodyOperator}" ignored; session user = ${req.auth?.user}`);
  return req.auth?.user || 'unknown';
}

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

// ---------- 认证（V2 §10）----------
app.post('/api/topology/auth/login', async (req, res) => {
  try {
    const ip = req.ip || req.socket.remoteAddress || '?';
    if (loginRateLimited(ip)) return res.status(429).json({ error: '登录过于频繁，稍后再试' });
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'username/password 必填' });
    const u = await db.prepare('SELECT username, pass_hash, role FROM topo_user WHERE username=?').get(String(username));
    if (!u || !scryptVerify(password, u.pass_hash)) {
      await new Promise(r => setTimeout(r, 400)); // 抹平用户不存在/密码错的时间差
      return res.status(401).json({ error: '用户名或密码错误' });
    }
    const now = Math.floor(Date.now() / 1000);
    const tok = newToken();
    await db.prepare('INSERT INTO auth_session(token,username,expires_at,created_at,last_seen_at) VALUES(?,?,?,?,?)')
      .run(tok, u.username, now + SESSION_TTL, now, now);
    setSessionCookie(res, tok);
    res.json({ ok: true, user: u.username, role: u.role });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.post('/api/topology/auth/logout', async (req, res) => {
  try {
    const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(req.headers.cookie || '');
    if (m) await db.prepare('DELETE FROM auth_session WHERE token=?').run(decodeURIComponent(m[1]));
    clearSessionCookie(res);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.get('/api/topology/auth/me', async (req, res) => {
  const users = (await db.prepare('SELECT COUNT(*) AS n FROM topo_user').get()).n;
  if (!req.auth) return res.json({ data: { authed: false, users_exist: users > 0 } });
  res.json({ data: { authed: true, user: req.auth.user, role: req.auth.role } });
});

// ---------- 健康 ----------
app.get('/health', async (req, res) => {
  let version = null, err = null;
  if (zbx.ok()) { try { version = await zbx.version(); } catch (e) { err = e.message; } }
  res.json({
    svc: 'topology-svc', zbx_connected: !!version, zbx_version: version, zbx_error: err,
    db: db.location, db_kind: db.kind,
    nodes: (await db.prepare('SELECT COUNT(*) c FROM topology_node').get()).c,
    interfaces: (await db.prepare('SELECT COUNT(*) c FROM topology_interface WHERE stale=0').get()).c,
    links: await db.prepare("SELECT status, COUNT(*) c FROM topology_link GROUP BY status").all(),
    last_sync: await metaGet(db, 'last_sync'),
  });
});

// ---------- 同步 ----------
app.post('/api/topology/sync', requireRole('admin'), async (req, res) => {
  if (syncRunning) return res.status(409).json({ error: 'sync running' });
  syncRunning = true;
  try {
    const stat = await syncTopology(db, zbx, CFG, m => console.log('[sync]', m));
    await metaSet(db, 'last_sync', Math.floor(Date.now() / 1000));
    // 同步入库后自动对「从未被 LLDP 发现过」的新节点补一轮定向发现
    // （根因修复：发现运行取启动时刻节点快照，晚同步入库的设备不会被上一轮覆盖）
    const fresh = (await db.prepare(
      `SELECT node_id FROM topology_node n WHERE n.status='active'
        AND NOT EXISTS (SELECT 1 FROM topology_discovery_record r WHERE r.node_id=n.node_id)`
    ).all()).map(r => String(r.node_id));
    let autoDiscovered = 0;
    if (fresh.length && startDiscovery(fresh)) autoDiscovered = fresh.length;
    res.json({ ok: true, stat, auto_discovery_queued: autoDiscovered });
  } catch (e) { res.status(502).json({ error: String(e.message || e) }); }
  finally { syncRunning = false; }
});

// ---------- 节点 ----------
app.get('/api/topology/nodes', async (req, res) => {
  try {
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
  const total = (await db.prepare('SELECT COUNT(*) c FROM topology_node n' + where).get(...args)).c;
  const rows = await db.prepare(sql + ' ORDER BY n.status DESC, n.display_name LIMIT ? OFFSET ?').all(...args, size, (page - 1) * size);
  res.json({ data: rows.map(r => ({ ...r, health_flags: JSON.parse(r.health_flags || '{}') })), meta: { page, size, total } });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

app.get('/api/topology/nodes/:id', async (req, res) => {
  try {
  const n = await db.prepare('SELECT * FROM topology_node WHERE node_id=?').get(+req.params.id);
  if (!n) return res.status(404).json({ error: 'not found' });
  // CAST speed_bps AS REAL：部分设备 ifHighSpeed 异常值（如 4e16）超 JS 安全整数，node:sqlite 读 INTEGER 会 RangeError
  const ifaces = await db.prepare(`SELECT i.*, CAST(i.speed_bps AS REAL) AS speed_bps,
      (SELECT l.status FROM topology_link l WHERE l.a_iface=i.interface_id OR l.b_iface=i.interface_id
        ORDER BY CASE l.status WHEN 'confirmed' THEN 0 WHEN 'manual' THEN 1 WHEN 'half' THEN 2 ELSE 3 END LIMIT 1) link_status
    FROM topology_interface i WHERE i.node_id=? AND i.stale=0 ORDER BY i.if_index`).all(n.node_id);
  const recs = await db.prepare(`SELECT record_id, run_id, result, neighbors_found, error, started_at FROM topology_discovery_record
    WHERE node_id=? ORDER BY record_id DESC LIMIT 5`).all(n.node_id);
  res.json({ data: { ...n, health_flags: JSON.parse(n.health_flags || '{}'), interfaces: ifaces, discovery_recent: recs } });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ---------- 接口 ----------
app.get('/api/topology/interfaces', async (req, res) => {
  try {
  const { node_id, if_type, has_link } = req.query;
  const page = Math.max(1, Number(req.query.page || 1)), size = Math.min(500, Number(req.query.size || 100));
  let sql = `SELECT i.*, n.display_name FROM topology_interface i JOIN topology_node n ON n.node_id=i.node_id WHERE i.stale=0`;
  const args = [];
  if (node_id) { sql += ' AND i.node_id=?'; args.push(+node_id); }
  if (if_type) { sql += ' AND i.if_type=?'; args.push(if_type); }
  if (has_link === '1') sql += ' AND EXISTS (SELECT 1 FROM topology_link l WHERE (l.a_iface=i.interface_id OR l.b_iface=i.interface_id) AND l.status NOT IN (\'stale\',\'rejected\'))';
  if (has_link === '0') sql += ' AND NOT EXISTS (SELECT 1 FROM topology_link l WHERE (l.a_iface=i.interface_id OR l.b_iface=i.interface_id) AND l.status NOT IN (\'stale\',\'rejected\'))';
  const total = (await db.prepare(sql.replace('SELECT i.*, n.display_name FROM', 'SELECT COUNT(*) c FROM')).get(...args)).c;
  const rows = await db.prepare(sql + ' ORDER BY n.display_name, i.if_index LIMIT ? OFFSET ?').all(...args, size, (page - 1) * size);
  res.json({ data: rows, meta: { page, size, total } });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
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
    // V2（§4）：关系语义 + VLAN/聚合上下文
    relation_type: r.relation_type || 'lldp_half', vlan_id: r.vlan_id ?? null,
    bandwidth_bps: r.bandwidth_bps ?? null, parent_link_id: r.parent_link_id ?? null,
    last_seen: r.last_seen, missing_rounds: r.missing_rounds,
  };
}
app.get('/api/topology/links', async (req, res) => {
  try {
  const { status, source, node_id, relation_type } = req.query;
  const page = Math.max(1, Number(req.query.page || 1)), size = Math.min(500, Number(req.query.size || 100));
  let sql = linkSql + ' WHERE 1=1'; const args = [];
  if (status) { sql += ' AND l.status=?'; args.push(status); }
  if (source) { sql += ' AND l.source=?'; args.push(source); }
  if (relation_type) { sql += ' AND l.relation_type=?'; args.push(relation_type); }
  if (node_id) { sql += ' AND (l.a_node=? OR l.b_node=?)'; args.push(+node_id, +node_id); }
  const total = (await db.prepare(sql.replace(linkSql.split(' FROM')[0] + ' FROM', 'SELECT COUNT(*) c FROM')).get(...args)).c;
  const rows = await db.prepare(sql + ' ORDER BY CASE l.status WHEN \'confirmed\' THEN 0 WHEN \'manual\' THEN 1 WHEN \'half\' THEN 2 WHEN \'conflict\' THEN 3 ELSE 4 END, l.link_id LIMIT ? OFFSET ?').all(...args, size, (page - 1) * size);
  res.json({ data: rows.map(shapeLink), meta: { page, size, total } });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
// 审核页专用：分页 + total + 过滤（status/node_id/置信带/对端搜索），默认高置信在前（先审最容易确认的）
// 附带 summary：按状态、置信带、a 端设备的聚合，供审核页做过滤下拉与"按设备批量"操作
app.get('/api/topology/links/pending', async (req, res) => {
  try {
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
  const total = (await db.prepare(from.replace(linkSql.split(' FROM')[0] + ' FROM', 'SELECT COUNT(*) c FROM')).get(...args)).c;
  const rows = await db.prepare(from + ' ORDER BY l.confidence DESC, l.link_id DESC LIMIT ? OFFSET ?').all(...args, size, (page - 1) * size);
  // summary 不受 q 影响（用于过滤控件本身），但受 status 影响
  let w2 = ` WHERE l.status IN (${statuses.map(() => '?').join(',')})`; const a2 = [...statuses];
  if (req.query.node_id) { w2 += ' AND l.a_node=?'; a2.push(+req.query.node_id); }
  const by_status = await db.prepare(`SELECT l.status, COUNT(*) c FROM topology_link l${w2} GROUP BY l.status`).all(...a2);
  const by_conf = await db.prepare(`SELECT CASE WHEN l.confidence>=0.9 THEN '>=0.9' WHEN l.confidence>=0.5 THEN '0.5-0.89' ELSE '<0.5' END band, COUNT(*) c
    FROM topology_link l${w2} GROUP BY band ORDER BY band`).all(...a2);
  const by_node = await db.prepare(`SELECT l.a_node node_id, na.display_name name, COUNT(*) c FROM topology_link l
    JOIN topology_node na ON na.node_id=l.a_node${w2} GROUP BY l.a_node ORDER BY c DESC LIMIT 100`).all(...a2);
  res.json({ data: rows.map(shapeLink), meta: { page, size, total, by_status, by_conf, by_node } });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
// 批量确认/忽略：ids 显式列表，或 match={node_id,min_confidence,max_confidence} 按过滤条件圈定（二选一，operator 必填）
async function bulkAction(req, res, action) {
  try {
  const operator = sessionOperator(req, req.body?.operator); // V2：会话即操作者，body 自报忽略
  const now = Math.floor(Date.now() / 1000);
  let ids = [];
  if (Array.isArray(req.body?.link_ids) && req.body.link_ids.length) ids = req.body.link_ids.map(Number);
  else if (req.body?.match) {
    const m = req.body.match;
    let where = ` WHERE l.status IN ('half','conflict','stale')`; const args = [];
    if (m.node_id) { where += ' AND l.a_node=?'; args.push(+m.node_id); }
    if (m.min_confidence !== undefined) { where += ' AND l.confidence>=?'; args.push(Number(m.min_confidence)); }
    if (m.max_confidence !== undefined) { where += ' AND l.confidence<=?'; args.push(Number(m.max_confidence)); }
    ids = (await db.prepare(`SELECT l.link_id FROM topology_link l${where}`).all(...args)).map(r => Number(r.link_id));
  } else return res.status(400).json({ error: 'link_ids 或 match 必填' });
  if (!ids.length) return res.json({ ok: true, affected: 0 });
  const ph = ids.map(() => '?').join(',');
  let affected;
  if (action === 'confirm') {
    // V2 语义（设计 §4.2）：人工确认半链 = 语义改写为 manual_physical（LLDP 证据保留在 evidence 表）
    affected = (await db.prepare(`UPDATE topology_link SET status='confirmed',
      relation_type=CASE WHEN relation_type='lldp_half' THEN 'manual_physical' ELSE relation_type END,
      confirmed_by=?, confirmed_at=?, note=COALESCE(?,note)
      WHERE link_id IN (${ph}) AND status IN ('half','conflict','stale')`).run(operator, now, req.body?.note || null, ...ids)).changes;
    if (req.body?.note) {
      // 证据追加式（§4.3）：每次审核备注一条 manual_note 证据行
      for (const id of ids) {
        await db.prepare("INSERT INTO topology_link_evidence(link_id,kind,payload,observed_at) SELECT ?,'manual_note',?,? WHERE EXISTS(SELECT 1 FROM topology_link WHERE link_id=?)")
          .run(id, req.body.note, now, id);
      }
    }
  } else {
    affected = (await db.prepare(`UPDATE topology_link SET status='rejected', confirmed_by=?, confirmed_at=?, note=COALESCE(?,note)
      WHERE link_id IN (${ph}) AND status IN ('half','conflict','stale')`).run(operator, now, req.body?.reason || null, ...ids)).changes;
  }
  res.json({ ok: true, affected, requested: ids.length });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
}
app.post('/api/topology/links/bulk-confirm', requireRole('admin'), (req, res) => bulkAction(req, res, 'confirm'));
app.post('/api/topology/links/bulk-reject', requireRole('admin'), (req, res) => bulkAction(req, res, 'reject'));
app.post('/api/topology/links/:id/confirm', requireRole('admin'), async (req, res) => {
  try {
  const operator = sessionOperator(req, req.body?.operator);
  const l = await db.prepare('SELECT * FROM topology_link WHERE link_id=?').get(+req.params.id);
  if (!l) return res.status(404).json({ error: 'not found' });
  if (!['half', 'conflict', 'stale'].includes(l.status)) return res.status(400).json({ error: `status=${l.status} 不可确认` });
  // V2 语义（§4.2）：半链人工确认 → relation_type 改写 manual_physical，证据链保留
  await db.prepare(`UPDATE topology_link SET status='confirmed',
    relation_type=CASE WHEN relation_type='lldp_half' THEN 'manual_physical' ELSE relation_type END,
    confirmed_by=?, confirmed_at=?, note=COALESCE(?,note) WHERE link_id=?`)
    .run(operator, Math.floor(Date.now() / 1000), req.body?.note || null, l.link_id);
  if (req.body?.note) await db.prepare('INSERT INTO topology_link_evidence(link_id,kind,payload,observed_at) VALUES(?,?,?,?)')
    .run(l.link_id, 'manual_note', req.body.note, Math.floor(Date.now() / 1000));
  res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.post('/api/topology/links/:id/reject', requireRole('admin'), async (req, res) => {
  try {
  const operator = sessionOperator(req, req.body?.operator);
  const l = await db.prepare('SELECT * FROM topology_link WHERE link_id=?').get(+req.params.id);
  if (!l) return res.status(404).json({ error: 'not found' });
  await db.prepare("UPDATE topology_link SET status='rejected', confirmed_by=?, confirmed_at=?, note=? WHERE link_id=?")
    .run(operator, Math.floor(Date.now() / 1000), req.body?.reason || null, l.link_id);
  res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.post('/api/topology/links', requireRole('admin'), async (req, res) => {
  try {
  const { a_node_id, a_interface_id, b_node_id, b_interface_id, note } = req.body || {};
  const operator = sessionOperator(req, req.body?.operator);
  if (!a_node_id || !a_interface_id || !b_node_id || !b_interface_id)
    return res.status(400).json({ error: 'a/b 两端节点与接口必填（operator 由会话决定）' });
  if (+a_interface_id === +b_interface_id) return res.status(400).json({ error: '自环不允许' });
  const ia = await db.prepare('SELECT * FROM topology_interface WHERE interface_id=? AND node_id=? AND stale=0').get(+a_interface_id, +a_node_id);
  const ib = await db.prepare('SELECT * FROM topology_interface WHERE interface_id=? AND node_id=? AND stale=0').get(+b_interface_id, +b_node_id);
  if (!ia || !ib) return res.status(404).json({ error: '接口不存在或已 stale（须与节点匹配）' });
  const pair = [[+a_node_id, +a_interface_id], [+b_node_id, +b_interface_id]].sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const normKey = `L:${pair[0][0]}:${pair[0][1]}|${pair[1][0]}:${pair[1][1]}`;
  if (await db.prepare('SELECT link_id FROM topology_link WHERE norm_key=?').get(normKey))
    return res.status(409).json({ error: '该端点对链路已存在' });
  const now = Math.floor(Date.now() / 1000);
  const r = await db.prepare(`INSERT INTO topology_link(norm_key,a_node,a_iface,b_node,b_iface,status,source,confidence,confirmed_by,confirmed_at,discovered_at,last_seen,note,relation_type)
    VALUES(?,?,?,?,?,'manual','manual',1,?,?,?, ?,?,'manual_physical')`)
    .run(normKey, pair[0][0], pair[0][1], pair[1][0], pair[1][1], operator, now, now, now, note || null);
  // V2：人工建链即证据（note 必填语义由前端约束；有 note 就落证据行）
  if (note) await db.prepare('INSERT INTO topology_link_evidence(link_id,kind,payload,observed_at) VALUES(?,?,?,?)')
    .run(Number(r.lastInsertRowid), 'manual_note', note, now);
  res.status(201).json({ ok: true, link_id: Number(r.lastInsertRowid) });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.delete('/api/topology/links/:id', requireRole('admin'), async (req, res) => {
  try {
  const l = await db.prepare('SELECT * FROM topology_link WHERE link_id=?').get(+req.params.id);
  if (!l) return res.status(404).json({ error: 'not found' });
  if (l.source !== 'manual') return res.status(403).json({ error: '仅 manual 链路可删除；LLDP 链路请用 reject' });
  await db.prepare('DELETE FROM topology_link WHERE link_id=?').run(l.link_id);
  res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ---------- 链路流量 ----------
app.get('/api/topology/links/:id/traffic', async (req, res) => {
  try {
  const l = await db.prepare('SELECT * FROM topology_link WHERE link_id=?').get(+req.params.id);
  if (!l) return res.status(404).json({ error: 'not found' });
  const range = String(req.query.range || '6h'), till = Number(req.query.till || 0);
  const get = async (nodeId, ifaceId) => {
    if (!ifaceId) return { node_id: nodeId, in: { avg: [] }, out: { avg: [] }, unavailable: true };
    const t = await ifaceTraffic(zbx, db, ifaceId, range, till);
    return { node_id: nodeId, iface_id: ifaceId, ...t };
  };
  const a = await get(l.a_node, l.a_iface);
  const b = l.b_iface ? await get(l.b_node, l.b_iface) : { unavailable: true };
  res.json({ data: { a, b }, meta: { range, grain: a.grain || null, units: 'bps', stale_mapping: !!(a.stale_mapping) } });
  } catch (e) { res.status(502).json({ error: String(e.message || e) }); }
});

// ---------- V2：链路证据（§4.3 只读；写路径在 discovery/bulk/人工建链处） ----------
app.get('/api/topology/links/:id/evidence', async (req, res) => {
  try {
  const l = await db.prepare('SELECT link_id FROM topology_link WHERE link_id=?').get(+req.params.id);
  if (!l) return res.status(404).json({ error: 'not found' });
  const rows = await db.prepare('SELECT evidence_id, kind, payload, source_run_id, observed_at, expires_at FROM topology_link_evidence WHERE link_id=? ORDER BY observed_at DESC, evidence_id DESC').all(l.link_id);
  res.json({ data: rows.map(r => ({ ...r, payload: r.payload ? safeJson(r.payload) : null })) });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
function safeJson(s) { try { return JSON.parse(s); } catch { return s; } }

// ---------- 图 ----------
app.get('/api/topology/graph', async (req, res) => {
  try {
  const inc = new Set(String(req.query.include || '').split(','));
  const linkStatusOk = ["'confirmed'", "'manual'", "'half'"];
  if (inc.has('stale')) linkStatusOk.push("'stale'");
  if (inc.has('conflict')) linkStatusOk.push("'conflict'");
  // max_speed_bps 仅作前端视觉分层（核心/汇聚/接入），不作为拓扑事实
  const nodes = await db.prepare(`SELECT node_id, display_name, node_type, vendor, mgmt_ip, chassis_id, status,
      (SELECT COUNT(*) FROM topology_interface i WHERE i.node_id=n.node_id AND i.stale=0) iface_count,
      (SELECT CAST(MAX(i.speed_bps) AS REAL) FROM topology_interface i WHERE i.node_id=n.node_id AND i.stale=0 AND i.speed_bps>0 AND i.speed_bps<=10000000000000) max_speed_bps
    FROM topology_node n`).all();
  // 只读证据字段：norm_key / seen_* / 双端 oper / b_snapshot 原样解析。
  // b_if 不再回退 sys_name（名称≠接口，前端按 b_snapshot 快照单独渲染"未纳管对端"）。
  const links = (await db.prepare(`SELECT l.link_id, l.norm_key, l.a_node, a.if_name a_ifname, a.oper_status a_oper, na.display_name a_name,
      l.b_node, b.if_name b_ifname, b.oper_status b_oper, nb.display_name b_name,
      l.b_snapshot, l.status, l.source, l.confidence, l.seen_a_at, l.seen_b_at,
      l.relation_type, l.vlan_id, l.bandwidth_bps, l.parent_link_id
    FROM topology_link l
    LEFT JOIN topology_interface a ON a.interface_id=l.a_iface
    LEFT JOIN topology_interface b ON b.interface_id=l.b_iface
    LEFT JOIN topology_node na ON na.node_id=l.a_node
    LEFT JOIN topology_node nb ON nb.node_id=l.b_node
    WHERE l.status IN (${linkStatusOk.join(',')})`).all())
    .map(r => ({
      link_id: r.link_id, norm_key: r.norm_key,
      a: r.a_node, a_if: r.a_ifname, a_oper: r.a_oper, a_name: r.a_name,
      b: r.b_node, b_if: r.b_ifname, b_oper: r.b_oper, b_name: r.b_name,
      b_snapshot: r.b_snapshot ? JSON.parse(r.b_snapshot) : null,
      status: r.status, source: r.source, confidence: r.confidence,
      relation_type: r.relation_type || 'lldp_half', vlan_id: r.vlan_id ?? null,
      bandwidth_bps: r.bandwidth_bps ?? null, parent_link_id: r.parent_link_id ?? null,
      seen_a_at: r.seen_a_at, seen_b_at: r.seen_b_at,
    }));
    res.json({ data: { nodes, links }, meta: { node_count: nodes.length, link_count: links.length, include: [...inc] } });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ---------- P3 全局共享布局（布局与设备真实属性分离；DB 是布局唯一存储，G6 只是渲染器） ----------
// 约定：layout_source auto|manual；position_locked 0|1；
// 设备删除不级联删布局行（无外键），仅 /layout/reset 显式清空——布局历史不丢。
app.get('/api/topology/layout', async (req, res) => {
  try {
    const nodes = await db.prepare('SELECT node_id, group_key, zone_id, x, y, layout_source, `position_locked`, updated_by, updated_at FROM topology_layout').all();
    // V2 读路径切 zone：zones 为新权威；groups 为兼容 shim（保留一个版本）。
    // zone 表为空且旧 topology_group 有数据（生产未跑迁移脚本的过渡态）→ shim 直接回退读旧表
    const zones = await db.prepare(`SELECT zone_id, name, bg_color, border_color, border_style, border_width, parent_zone_id, note, collapsed, x, y, w, h, sort_hint,
      (SELECT COUNT(*) FROM topology_layout l WHERE l.zone_id = topology_zone.zone_id) AS member_count
      FROM topology_zone ORDER BY sort_hint ASC, zone_id ASC`).all();
    let groups;
    if (zones.length) {
      groups = zones.map(z => ({
        group_key: `z${z.zone_id}`, label: z.name, collapsed: z.collapsed,
        x: z.x, y: z.y, w: z.w, h: z.h, zone_id: z.zone_id,
      }));
    } else {
      groups = await db.prepare('SELECT group_key, label, collapsed, x, y, w, h FROM topology_group').all();
    }
    res.json({ data: { nodes, groups, zones }, meta: { node_layout_count: nodes.length, group_count: groups.length, zone_count: zones.length } });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
// 保存布局：逐行 upsert（ON CONFLICT→toMysqlSql 翻译成 ON DUPLICATE KEY UPDATE）
app.put('/api/topology/layout', requireRole('admin'), async (req, res) => {
  try {
    const operator = sessionOperator(req, req.body?.operator); // V2：操作者来自会话
    const list = Array.isArray(req.body?.nodes) ? req.body.nodes : null;
    if (!list) return res.status(400).json({ error: 'nodes 数组必填' });
    if (list.length > 2000) return res.status(400).json({ error: '单批最多 2000 个节点' });
    for (const nd of list) {
      if (!Number.isFinite(+nd.node_id) || !Number.isFinite(+nd.x) || !Number.isFinite(+nd.y))
        return res.status(400).json({ error: `节点 ${nd.node_id}：node_id/x/y 必须是有限数值` });
      if (!['auto', 'manual', 'suggested'].includes(nd.layout_source))
        return res.status(400).json({ error: `节点 ${nd.node_id}：layout_source 仅 auto|manual|suggested` });
    }
    const now = Math.floor(Date.now() / 1000);
    let up = 0;
    for (const nd of list) {
      await db.prepare(`INSERT INTO topology_layout(node_id,group_key,x,y,layout_source,\`position_locked\`,updated_by,updated_at)
        VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(node_id) DO UPDATE SET group_key=excluded.group_key, x=excluded.x, y=excluded.y, layout_source=excluded.layout_source, \`position_locked\`=excluded.\`position_locked\`, updated_by=excluded.updated_by, updated_at=excluded.updated_at`)
        .run(+nd.node_id, nd.group_key || null, +nd.x, +nd.y, nd.layout_source, nd.position_locked ? 1 : 0, String(operator), now);
      up++;
    }
    res.json({ ok: true, upserted: up, at: now });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
// 区域（折叠态 / 容器人工位置）——同样逐行 upsert
app.put('/api/topology/layout/groups', requireRole('admin'), async (req, res) => {
  try {
    const operator = sessionOperator(req, req.body?.operator);
    const list = Array.isArray(req.body?.groups) ? req.body.groups : null;
    if (!list) return res.status(400).json({ error: 'groups 数组必填' });
    if (list.length > 100) return res.status(400).json({ error: '单批最多 100 个区域' });
    for (const g of list) {
      if (!/^[a-z][a-z0-9_-]{0,63}$/.test(String(g.group_key || '')))
        return res.status(400).json({ error: `group_key 非法：${g.group_key}（^[a-z][a-z0-9_-]{0,63}$）` });
    }
    const now = Math.floor(Date.now() / 1000);
    let up = 0;
    for (const g of list) {
      const num = (v) => (v === null || v === undefined || !Number.isFinite(+v)) ? null : +v;
      await db.prepare(`INSERT INTO topology_group(group_key,label,collapsed,x,y,w,h,updated_at)
        VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(group_key) DO UPDATE SET label=excluded.label, collapsed=excluded.collapsed, x=excluded.x, y=excluded.y, w=excluded.w, h=excluded.h, updated_at=excluded.updated_at`)
        .run(String(g.group_key), String(g.label || g.group_key), g.collapsed ? 1 : 0, num(g.x), num(g.y), num(g.w), num(g.h), now);
      up++;
    }
    res.json({ ok: true, upserted: up, at: now });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
// V2 §8.2 /layout/batch：拖动落点批量写（坐标 + zone 隶属，逐行 upsert 幂等）
// 与 PUT /layout 的区别：行可带 zone_id（拖入/拖出区域即时语义）；x/y 可为 null（新入区未定位）
app.put('/api/topology/layout/batch', requireRole('admin'), async (req, res) => {
  try {
    const operator = sessionOperator(req, req.body?.operator);
    const list = Array.isArray(req.body?.nodes) ? req.body.nodes : null;
    if (!list) return res.status(400).json({ error: 'nodes 数组必填' });
    if (list.length > 2000) return res.status(400).json({ error: '单批最多 2000 个节点' });
    for (const nd of list) {
      if (!Number.isFinite(+nd.node_id)) return res.status(400).json({ error: `node_id 非法：${nd.node_id}` });
      if (nd.x !== null && nd.x !== undefined && !Number.isFinite(+nd.x)) return res.status(400).json({ error: `节点 ${nd.node_id}：x 需为数值或 null` });
      if (nd.y !== null && nd.y !== undefined && !Number.isFinite(+nd.y)) return res.status(400).json({ error: `节点 ${nd.node_id}：y 需为数值或 null` });
      if (nd.layout_source !== undefined && !['auto', 'manual', 'suggested'].includes(nd.layout_source))
        return res.status(400).json({ error: `节点 ${nd.node_id}：layout_source 仅 auto|manual|suggested` });
    }
    // zone_id 引用校验（一次性取全部有效 zone）
    const validZones = new Set((await db.prepare('SELECT zone_id FROM topology_zone').all()).map(z => z.zone_id));
    const now = Math.floor(Date.now() / 1000);
    let up = 0;
    for (const nd of list) {
      const zid = nd.zone_id === undefined || nd.zone_id === null ? null : +nd.zone_id;
      if (zid !== null && !validZones.has(zid)) return res.status(400).json({ error: `zone_id ${zid} 不存在` });
      const x = nd.x === undefined || nd.x === null ? null : +nd.x;
      const y = nd.y === undefined || nd.y === null ? null : +nd.y;
      const src = nd.layout_source || 'manual';
      const row = await db.prepare('SELECT node_id FROM topology_layout WHERE node_id=?').get(+nd.node_id);
      if (row) {
        await db.prepare('UPDATE topology_layout SET x=?, y=?, layout_source=?, `position_locked`=?, zone_id=?, updated_by=?, updated_at=? WHERE node_id=?')
          .run(x, y, src, nd.position_locked ? 1 : 0, zid, String(operator), now, +nd.node_id);
      } else {
        await db.prepare('INSERT INTO topology_layout(node_id, group_key, x, y, layout_source, `position_locked`, zone_id, updated_by, updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
          .run(+nd.node_id, null, x, y, src, nd.position_locked ? 1 : 0, zid, String(operator), now);
      }
      up++;
    }
    res.json({ ok: true, upserted: up, at: now });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// 显式重置：唯一允许清除人工布局的入口（设计规则：管理员主动重置才清）
app.post('/api/topology/layout/reset', requireRole('admin'), async (req, res) => {
  try {
    const operator = sessionOperator(req, req.body?.operator);
    // 重置前自动快照护栏（V2 §5.5：破坏性批量操作前留退路）
    const zones = await db.prepare('SELECT * FROM topology_zone').all();
    const layouts = await db.prepare('SELECT * FROM topology_layout').all();
    await db.prepare('INSERT INTO topology_layout_snapshot(name,kind,zones_json,layout_json,created_by,created_at) VALUES(?,?,?,?,?,?)')
      .run('pre-reset auto', 'auto_pre', JSON.stringify(zones), JSON.stringify(layouts), operator, Math.floor(Date.now() / 1000));
    const r1 = await db.prepare('DELETE FROM topology_layout').run();
    const r2 = await db.prepare('DELETE FROM topology_group').run();
    const r3 = await db.prepare('DELETE FROM topology_zone').run();
    console.log(`[layout] reset by ${operator}: nodes=${r1.changes} groups=${r2.changes} zones=${r3.changes}`);
    res.json({ ok: true, cleared: { layout_rows: r1.changes, group_rows: r2.changes, zone_rows: r3.changes } });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ---------- V2 区域 Zone（§5/§8.2：管理员资产；系统只出建议、绝不自动建行）----------
const ZONE_BORDER_STYLES = ['solid', 'dashed', 'none'];
const ZONE_COLS = 'zone_id, name, bg_color, border_color, border_style, border_width, parent_zone_id, note, collapsed, x, y, w, h, sort_hint, created_by, created_at, updated_by, updated_at';
const isZoneColor = (v) => typeof v === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(v);
const znum = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(+v)) ? null : +v;

app.get('/api/topology/zones', async (req, res) => {
  try {
    const zones = await db.prepare(`SELECT ${ZONE_COLS},
      (SELECT COUNT(*) FROM topology_layout l WHERE l.zone_id = z.zone_id) AS member_count
      FROM topology_zone z ORDER BY sort_hint ASC, zone_id ASC`).all();
    let members = null;
    if (['1', 'true'].includes(String(req.query.members || '')))
      members = await db.prepare('SELECT zone_id, node_id FROM topology_layout WHERE zone_id IS NOT NULL').all();
    res.json({ data: { zones, members }, meta: { zone_count: zones.length } });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// 只读建议（§5.1「不自动创建虚假区域」）：未分区设备按既有确认链路聚类，只返回、不落库
app.get('/api/topology/zones/suggestions', async (req, res) => {
  try {
    const unassigned = await db.prepare(`
      SELECT n.node_id, n.display_name FROM topology_node n
      WHERE n.node_id NOT IN (SELECT node_id FROM topology_layout WHERE zone_id IS NOT NULL)`).all();
    const ids = new Set(unassigned.map(n => n.node_id));
    const nameOf = new Map(unassigned.map(n => [n.node_id, n.display_name]));
    const adj = new Map();
    const links = await db.prepare(`SELECT a_node, b_node FROM topology_link
      WHERE status IN ('confirmed','manual') AND relation_type IN ('lldp_confirmed','manual_physical')`).all();
    for (const l of links) {
      if (ids.has(l.a_node) && ids.has(l.b_node) && l.a_node !== l.b_node) {
        if (!adj.has(l.a_node)) adj.set(l.a_node, new Set());
        if (!adj.has(l.b_node)) adj.set(l.b_node, new Set());
        adj.get(l.a_node).add(l.b_node); adj.get(l.b_node).add(l.a_node);
      }
    }
    const seen = new Set(); const clusters = [];
    for (const start of ids) {
      if (seen.has(start)) continue;
      const comp = []; const stack = [start]; seen.add(start);
      while (stack.length) {
        const cur = stack.pop(); comp.push(cur);
        for (const nb of (adj.get(cur) || [])) if (!seen.has(nb)) { seen.add(nb); stack.push(nb); }
      }
      if (comp.length >= 2) {
        const names = comp.map(id => nameOf.get(id) || String(id));
        // 公共前缀做建议名（去尾部数字/分隔符后 ≥3 字符才用，否则用首个名称）
        let pre = names[0];
        for (const nm of names.slice(1)) {
          let i = 0; while (i < pre.length && i < nm.length && pre[i] === nm[i]) i++;
          pre = pre.slice(0, i);
        }
        pre = pre.replace(/[\s\-_.]+$/, '');
        clusters.push({
          node_ids: comp.sort((a, b) => a - b),
          suggested_name: pre.length >= 3 ? pre : names[0],
          size: comp.length,
        });
      }
    }
    clusters.sort((a, b) => b.size - a.size);
    res.json({
      data: clusters.slice(0, 30),
      meta: { unassigned_count: ids.size, cluster_count: clusters.length, note: '建议仅供人工采纳（POST /zones 建行），系统不自动创建区域' },
    });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

app.post('/api/topology/zones', requireRole('admin'), async (req, res) => {
  try {
    const operator = sessionOperator(req, req.body?.operator);
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name || name.length > 64) return res.status(400).json({ error: 'name 必填（1-64 字符）' });
    if (b.bg_color != null && !isZoneColor(b.bg_color)) return res.status(400).json({ error: 'bg_color 需为 #hex 色值' });
    if (b.border_color != null && !isZoneColor(b.border_color)) return res.status(400).json({ error: 'border_color 需为 #hex 色值' });
    const border_style = b.border_style ?? 'solid';
    if (!ZONE_BORDER_STYLES.includes(border_style)) return res.status(400).json({ error: `border_style 仅 ${ZONE_BORDER_STYLES.join('|')}` });
    const bw = b.border_width == null ? 1 : +b.border_width;
    if (!Number.isFinite(bw) || bw < 0 || bw > 8) return res.status(400).json({ error: 'border_width 需为 0-8' });
    const parent = b.parent_zone_id == null ? null : +b.parent_zone_id;
    if (parent !== null) {
      const p = await db.prepare('SELECT zone_id FROM topology_zone WHERE zone_id=?').get(parent);
      if (!p) return res.status(400).json({ error: `parent_zone_id ${parent} 不存在` });
    }
    const now = Math.floor(Date.now() / 1000);
    const r = await db.prepare(`INSERT INTO topology_zone(name,bg_color,border_color,border_style,border_width,parent_zone_id,note,collapsed,x,y,w,h,sort_hint,created_by,created_at,updated_by,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(name, isZoneColor(b.bg_color) ? b.bg_color : '#f0f5ff', isZoneColor(b.border_color) ? b.border_color : null,
        border_style, bw, parent, b.note ? String(b.note).slice(0, 200) : null, b.collapsed ? 1 : 0,
        znum(b.x), znum(b.y), znum(b.w), znum(b.h),
        Number.isFinite(+b.sort_hint) ? +b.sort_hint : 0, String(operator), now, String(operator), now);
    const zone = await db.prepare(`SELECT ${ZONE_COLS} FROM topology_zone WHERE zone_id=?`).get(Number(r.lastInsertRowid));
    console.log(`[zone] created #${zone.zone_id} "${name}" by ${operator}`);
    res.json({ ok: true, zone });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// PUT：语义字段（名称/颜色/边框/note/sort_hint/父子）；几何高频写走 PATCH geometry
app.put('/api/topology/zones/:id', requireRole('admin'), async (req, res) => {
  try {
    const operator = sessionOperator(req, req.body?.operator);
    const zid = +req.params.id;
    const z = await db.prepare('SELECT zone_id FROM topology_zone WHERE zone_id=?').get(zid);
    if (!z) return res.status(404).json({ error: 'zone not found' });
    const b = req.body || {};
    if (['x', 'y', 'w', 'h', 'collapsed'].some(k => b[k] !== undefined))
      return res.status(400).json({ error: '几何/折叠请用 PATCH /zones/:id/geometry' });
    const sets = []; const args = [];
    if (b.name !== undefined) {
      const nm = String(b.name).trim();
      if (!nm || nm.length > 64) return res.status(400).json({ error: 'name 需为 1-64 字符' });
      sets.push('name=?'); args.push(nm);
    }
    if (b.bg_color !== undefined) { if (b.bg_color !== null && !isZoneColor(b.bg_color)) return res.status(400).json({ error: 'bg_color 需为 #hex' }); sets.push('bg_color=?'); args.push(b.bg_color); }
    if (b.border_color !== undefined) { if (b.border_color !== null && !isZoneColor(b.border_color)) return res.status(400).json({ error: 'border_color 需为 #hex' }); sets.push('border_color=?'); args.push(b.border_color); }
    if (b.border_style !== undefined) { if (!ZONE_BORDER_STYLES.includes(b.border_style)) return res.status(400).json({ error: `border_style 仅 ${ZONE_BORDER_STYLES.join('|')}` }); sets.push('border_style=?'); args.push(b.border_style); }
    if (b.border_width !== undefined) { const w = +b.border_width; if (!Number.isFinite(w) || w < 0 || w > 8) return res.status(400).json({ error: 'border_width 需为 0-8' }); sets.push('border_width=?'); args.push(w); }
    if (b.note !== undefined) { sets.push('note=?'); args.push(b.note === null ? null : String(b.note).slice(0, 200)); }
    if (b.sort_hint !== undefined) { if (!Number.isFinite(+b.sort_hint)) return res.status(400).json({ error: 'sort_hint 需为数值' }); sets.push('sort_hint=?'); args.push(+b.sort_hint); }
    if (b.parent_zone_id !== undefined) {
      const p = b.parent_zone_id === null ? null : +b.parent_zone_id;
      if (p !== null) {
        if (p === zid) return res.status(400).json({ error: '父区域不能是自身' });
        const pc = await db.prepare('SELECT COUNT(*) AS c FROM topology_zone WHERE parent_zone_id=?').get(zid);
        if (p && pc && pc.c > 0) return res.status(400).json({ error: '该区域有子区域，不支持再嵌套一层（当前限两级）' });
        const pp = await db.prepare('SELECT zone_id FROM topology_zone WHERE zone_id=?').get(p);
        if (!pp) return res.status(400).json({ error: `parent_zone_id ${p} 不存在` });
      }
      sets.push('parent_zone_id=?'); args.push(p);
    }
    if (!sets.length) return res.status(400).json({ error: '无可用更新字段' });
    const now = Math.floor(Date.now() / 1000);
    sets.push('updated_by=?', 'updated_at=?'); args.push(String(operator), now);
    await db.prepare(`UPDATE topology_zone SET ${sets.join(',')} WHERE zone_id=?`).run(...args, zid);
    const zone = await db.prepare(`SELECT ${ZONE_COLS} FROM topology_zone WHERE zone_id=?`).get(zid);
    res.json({ ok: true, zone });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// PATCH geometry：拖动/缩放/折叠（前端 debounce 500ms 合并后高频写；幂等 set）
app.patch('/api/topology/zones/:id/geometry', requireRole('admin'), async (req, res) => {
  try {
    const operator = sessionOperator(req, req.body?.operator);
    const zid = +req.params.id;
    const z = await db.prepare('SELECT zone_id FROM topology_zone WHERE zone_id=?').get(zid);
    if (!z) return res.status(404).json({ error: 'zone not found' });
    const b = req.body || {};
    const sets = []; const args = [];
    for (const k of ['x', 'y', 'w', 'h']) if (b[k] !== undefined) {
      if (b[k] !== null && !Number.isFinite(+b[k])) return res.status(400).json({ error: `${k} 需为数值或 null` });
      if ((k === 'w' || k === 'h') && b[k] !== null && +b[k] < 40) return res.status(400).json({ error: `${k} 不得小于 40` });
      sets.push(`${k}=?`); args.push(b[k] === null ? null : +b[k]);
    }
    if (b.collapsed !== undefined) { sets.push('collapsed=?'); args.push(b.collapsed ? 1 : 0); }
    if (!sets.length) return res.status(400).json({ error: '至少提供 x/y/w/h/collapsed 之一' });
    const now = Math.floor(Date.now() / 1000);
    sets.push('updated_by=?', 'updated_at=?'); args.push(String(operator), now);
    await db.prepare(`UPDATE topology_zone SET ${sets.join(',')} WHERE zone_id=?`).run(...args, zid);
    const zone = await db.prepare(`SELECT ${ZONE_COLS} FROM topology_zone WHERE zone_id=?`).get(zid);
    res.json({ ok: true, zone });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// 删除区域：成员设备转未分区（清 zone_id，不动坐标）；有子区域需先处理
app.delete('/api/topology/zones/:id', requireRole('admin'), async (req, res) => {
  try {
    const operator = sessionOperator(req, req.body?.operator);
    const zid = +req.params.id;
    const z = await db.prepare('SELECT zone_id, name FROM topology_zone WHERE zone_id=?').get(zid);
    if (!z) return res.status(404).json({ error: 'zone not found' });
    const kids = await db.prepare('SELECT COUNT(*) AS c FROM topology_zone WHERE parent_zone_id=?').get(zid);
    if (kids && kids.c > 0) return res.status(409).json({ error: `该区域有 ${kids.c} 个子区域，请先删除或改挂子区域` });
    const r1 = await db.prepare('UPDATE topology_layout SET zone_id=NULL WHERE zone_id=?').run(zid);
    const r2 = await db.prepare('DELETE FROM topology_zone WHERE zone_id=?').run(zid);
    console.log(`[zone] deleted #${zid} "${z.name}" by ${operator}: members detached=${r1.changes}`);
    res.json({ ok: true, detached: r1.changes });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// 设备入区/移区（placement 改写；坐标缺省补 null，前端渲染时给网格位）
app.post('/api/topology/zones/:id/members', requireRole('admin'), async (req, res) => {
  try {
    const operator = sessionOperator(req, req.body?.operator);
    const zid = +req.params.id;
    const z = await db.prepare('SELECT zone_id, name FROM topology_zone WHERE zone_id=?').get(zid);
    if (!z) return res.status(404).json({ error: 'zone not found' });
    const ids = Array.isArray(req.body?.node_ids) ? req.body.node_ids.map(Number) : null;
    if (!ids || !ids.length) return res.status(400).json({ error: 'node_ids 数组必填' });
    if (ids.length > 500) return res.status(400).json({ error: '单批最多 500 个节点' });
    const now = Math.floor(Date.now() / 1000);
    let moved = 0, missing = [];
    for (const nid of ids) {
      if (!Number.isFinite(nid)) return res.status(400).json({ error: `node_id 非法：${nid}` });
      const n = await db.prepare('SELECT node_id FROM topology_node WHERE node_id=?').get(nid);
      if (!n) { missing.push(nid); continue; }
      const row = await db.prepare('SELECT node_id FROM topology_layout WHERE node_id=?').get(nid);
      if (row) await db.prepare('UPDATE topology_layout SET zone_id=?, updated_by=?, updated_at=? WHERE node_id=?').run(zid, String(operator), now, nid);
      else await db.prepare('INSERT INTO topology_layout(node_id, group_key, x, y, layout_source, `position_locked`, zone_id, updated_by, updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(nid, null, null, null, 'auto', 0, zid, String(operator), now);
      moved++;
    }
    res.json({ ok: true, moved, missing });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ---------- 发现 ----------
app.post('/api/topology/discovery/run', requireRole('admin'), async (req, res) => {
  if (discRunning) return res.status(409).json({ error: 'discovery running' });
  const nodeIds = req.body?.node_ids || null;
  startDiscovery(nodeIds);
  res.status(202).json({ queued: (nodeIds || (await db.prepare("SELECT node_id FROM topology_node WHERE status<>'stale'").all())).length, note: '异步执行，GET /api/topology/discovery/summary 查看进度' });
});
app.get('/api/topology/discovery/runs', async (req, res) => {
  try {
  const rows = await db.prepare(`SELECT run_id, MIN(started_at) started_at, MAX(finished_at) finished_at,
      COUNT(*) nodes, SUM(neighbors_found) neighbors,
      SUM(CASE WHEN result='ok' THEN 1 ELSE 0 END) ok,
      SUM(CASE WHEN result<>'ok' THEN 1 ELSE 0 END) not_ok
    FROM topology_discovery_record GROUP BY run_id ORDER BY run_id DESC LIMIT ?`).all(Math.min(50, Number(req.query.size || 20)));
  res.json({ data: rows });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.get('/api/topology/discovery/records', async (req, res) => {
  try {
  const { run_id, result } = req.query;
  let sql = `SELECT r.*, n.display_name FROM topology_discovery_record r LEFT JOIN topology_node n ON n.node_id=r.node_id WHERE 1=1`;
  const args = [];
  if (run_id) { sql += ' AND r.run_id=?'; args.push(run_id); }
  if (result) { sql += ' AND r.result=?'; args.push(result); }
  const rows = await db.prepare(sql + ' ORDER BY r.record_id DESC LIMIT ?').all(...args, Math.min(500, Number(req.query.size || 100)));
  res.json({ data: rows.map(r => ({ ...r, raw_snapshot: r.raw_snapshot ? `<${r.raw_snapshot.length} bytes>` : null })) });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.get('/api/topology/discovery/summary', async (req, res) => {
  try {
  const lastRun = await metaGet(db, 'last_disc');
  res.json({ data: {
    nodes_total: (await db.prepare('SELECT COUNT(*) c FROM topology_node').get()).c,
    nodes_active: (await db.prepare("SELECT COUNT(*) c FROM topology_node WHERE status='active'").get()).c,
    nodes_degraded: (await db.prepare("SELECT COUNT(*) c FROM topology_node WHERE status='degraded'").get()).c,
    links: await db.prepare('SELECT status, COUNT(*) c FROM topology_link GROUP BY status').all(),
    // P2-M1：按最新一轮各节点 result 分布（ok/rem_empty_indeterminate/rem_empty_aged/mib_unsupported/snmp_unreachable/walk_empty/...）
    latest_results: await db.prepare(`SELECT r.result, COUNT(*) c FROM topology_discovery_record r
      WHERE r.record_id IN (SELECT MAX(record_id) FROM topology_discovery_record GROUP BY node_id)
      GROUP BY r.result ORDER BY c DESC`).all(),
    walk_empty_nodes: (await db.prepare(`SELECT n.display_name FROM topology_discovery_record r JOIN topology_node n ON n.node_id=r.node_id
      WHERE r.result='walk_empty' AND r.record_id IN (SELECT MAX(record_id) FROM topology_discovery_record GROUP BY node_id) LIMIT 50`).all()).map(r => r.display_name),
    last_run: lastRun ? JSON.parse(lastRun) : null,
    discovery_running: discRunning,
  } });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.post('/api/topology/discovery/cleanup', requireRole('admin'), async (req, res) => {
  try { res.json({ ok: true, deleted: await cleanupManagedItems(zbx) }); }
  catch (e) { res.status(502).json({ error: String(e.message || e) }); }
});

// ---------- 接口流量（pathtrace 中无链路证据的 hop 用本端接口视角看流量） ----------
app.get('/api/topology/interfaces/:id/traffic', async (req, res) => {
  try {
  const i = await db.prepare('SELECT interface_id, node_id FROM topology_interface WHERE interface_id=? AND stale=0').get(+req.params.id);
  if (!i) return res.status(404).json({ error: 'not found' });
  const range = String(req.query.range || '6h'), till = Number(req.query.till || 0);
  const t = await ifaceTraffic(zbx, db, i.interface_id, range, till);
  res.json({ data: { node_id: i.node_id, iface_id: i.interface_id, ...t }, meta: { range, units: 'bps' } });
  } catch (e) { res.status(502).json({ error: String(e.message || e) }); }
});

// ---------- 路径追踪（流量走势页数据源；只读，快照缓存 topo_meta） ----------
app.get('/api/topology/pathtrace', async (req, res) => {
  try {
  const { src, dst } = req.query;
  if (!src || !dst) return res.status(400).json({ error: 'src/dst 必填（IPv4）' });
  const r = await tracePath(db, String(src), String(dst));
  if (r.error) return res.status(422).json({ error: r.error });
  res.json({ data: r });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.get('/api/topology/pathtrace/status', async (req, res) => {
  try {
  const s = await snapshotStatus(db);
  res.json({ data: s.data, meta: { last_refresh: s.last_refresh, refreshing: rtRunning } });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.post('/api/topology/pathtrace/refresh', requireRole('admin'), async (req, res) => {
  try {
  if (!zbx.ok()) return res.status(400).json({ error: 'Zabbix 凭据缺失：检查挂载文件 /app/config/source.json（宿主机 ./server/data/source.json）是否含 endpoint 与 token' });
  if (rtRunning) return res.status(409).json({ error: 'route snapshot refresh running' });
  rtRunning = true;
  const nodeIds = req.body?.node_ids || null;
  refreshRouteSnapshots(db, zbx, { nodeIds, log: m => console.log('[rt]', m) })
    .catch(e => console.error('[rt]', e))
    .finally(() => { rtRunning = false; });
  res.status(202).json({ queued: (nodeIds || (await db.prepare("SELECT node_id FROM topology_node WHERE status<>'stale' AND (display_name LIKE '%核心%' OR display_name LIKE '%CORE%' OR display_name LIKE '%汇聚%' OR display_name LIKE '%AGG%' OR display_name LIKE '%FW%' OR display_name LIKE '%防火墙%' OR display_name LIKE '%互联网%' OR display_name LIKE '%接入区%')").all())).length, note: '异步执行（每批创建托管项→等待首轮→读取→删除），GET /api/topology/pathtrace/status 查看' });
  } catch (e) { rtRunning = false; res.status(500).json({ error: String(e.message || e) }); }
});
app.post('/api/topology/pathtrace/cleanup', requireRole('admin'), async (req, res) => {
  try { res.json({ ok: true, deleted: await cleanupRouteItems(zbx) }); }
  catch (e) { res.status(502).json({ error: String(e.message || e) }); }
});

app.listen(CFG.port, () => console.log(`[topology-svc] http://localhost:${CFG.port}  db=${db.location}`));

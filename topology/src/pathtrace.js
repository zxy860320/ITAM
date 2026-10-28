// P2 路径追踪（pathtrace）：源/目的 IP → 依据 SNMP 路由表逐跳推出经过的纳管设备链。
// 数据来源（全部只读，经 Zabbix 托管临时项，用后即删——同 discovery 模式）：
//   路由（2026-10-26 数据源切换，用户规则"最长前缀匹配"）：
//     ipCidrRouteTable（行根 .1.3.6.1.2.1.4.24.4.1，H3C/Huawei 实测同构）——完整路由表。
//     根因：legacy ipRouteTable 索引只有 dest，同一设备对同 dest 多掩码静态路由（如
//     10.21.0.0/16 与 /24）只回报一条——rt.6 实测只有 /16，cidr 表却有 /16+/24 多条
//     不同下一跳。cidr 行 index 13 段 = dest(4) mask(4) tos(1) nexthop(4)，天然无冲突。
//     列 .1=dest、.2=mask、.4=nexthop、.5=ifIndex；dest/mask/nexthop 全在 index 里，
//     只采 .5 一列即可（值=ifIndex）。实测字节：办公网核心 c1=390行34.5KB、三列合并
//     65535B **截断**——所以采集只用单列 .5（约33KB，余量充足；>740行设备会截断，
//     快照如实标 truncated，不猜数据）。
//   ipAddrTable (RFC1213 .1.3.6.1.2.1.4.20，索引=本机IP)：列 .1=本机IP、.2=ifIndex、.3=掩码
// 快照存 topo_meta（k='rt.<node_id>' JSON，带时间戳）——不建新表、不改 DB 结构。
// 红线：hop 的物理链路只认 topology_link 的 LLDP/人工证据；路由下一跳只能证明
// "路由指向"，无链路证据时如实标 link=null + evidence='route-only'，绝不伪造连线。

const OID_ROUTE = '1.3.6.1.2.1.4.24.4.1.';  // cidr 行根（实测厂商在 entry 下多一层 .1）
const OID_ADDR  = '1.3.6.1.2.1.4.20.1.';   // ipAddrEntry：index=本机IP
export const RT_WALK_ROUTE = `walk[${OID_ROUTE}5]`; // ifIndex 列（dest/mask/nexthop 已在 index）
export const RT_WALK_ADDR = `walk[${OID_ADDR}1,${OID_ADDR}2,${OID_ADDR}3]`;

// ---------- walk 文本解析 ----------
// Zabbix walk 文本行形如：.1.3.6.1.2.1.4.21.1.7.10.25.250.41 = IpAddress: 10.25.250.41
const WALK_LINE = /^\.?((?:\d+\.){2,}\d+)\s*=\s*[\w() ]*?:\s*(\S+)/;

function* walkLines(text) {
  for (const raw of String(text || '').split('\n')) {
    const m = WALK_LINE.exec(raw.trim());
    if (m) yield { oid: m[1], value: m[2] };
  }
}

/**
 * 解析 ipCidrRouteTable walk（采集列=.5 ifIndex）→ [{dest, mask, if_index, next_hop}]
 * 行根 '1.3.6.1.2.1.4.24.4.1.'；行 index 13 段 = dest(4) mask(4) tos/proto(1) nexthop(4)
 * （probe_cidr/probe_cidr2 实测 H3C 与华为同构）。dest/mask/nexthop 都在 index 里，
 * 列 .5 只补 if_index；兼容 .1(dest) 列旧样本。13 段不齐的畸形行丢弃（不猜）。
 */
export function parseRouteWalk(text) {
  const byRow = new Map();
  for (const { oid, value } of walkLines(text)) {
    if (!oid.startsWith(OID_ROUTE)) continue;
    const rest = oid.slice(OID_ROUTE.length).split('.');
    const col = rest[0];
    const idx = rest.slice(1);
    if (col !== '1' && col !== '5') continue;
    if (idx.length !== 13) continue; // dest4 mask4 tos1 nexthop4，行序不齐/畸形行丢弃
    const key = idx.join('.');
    let e = byRow.get(key);
    if (!e) {
      e = {
        dest: idx.slice(0, 4).join('.'),
        mask: idx.slice(4, 8).join('.'),
        next_hop: idx.slice(9, 13).join('.'),
      };
      byRow.set(key, e);
    }
    if (col === '5') e.if_index = Number(value);
  }
  return [...byRow.values()].filter(e => isIp(e.dest) && isIp(e.mask));
}

/**
 * 路由选择（用户规则 2026-10-26）：在所有覆盖目的IP的路由里取**最长前缀**（LPM）。
 * 例：目的 10.21.0.41 同时被 10.21.0.0/16 与 10.21.0.0/24 覆盖时必选 /24。
 * 等长前缀（ECMP）取 walk 行序首条，保证结果确定性。
 */
export function pickRoute(routes, dstIp) {
  let best = null;
  for (const r of routes) {
    if (!isIp(r.dest) || !isIp(r.mask)) continue;
    if (covers(r.dest, r.mask, dstIp)) {
      const p = plen(r.mask);
      if (!best || p > best._p) best = { ...r, _p: p };
    }
  }
  return best;
}

/** 解析接口IP三列 walk → [{ip, if_index, mask}] */
export function parseAddrWalk(text) {
  const byIp = new Map();
  for (const { oid, value } of walkLines(text)) {
    if (!oid.startsWith(OID_ADDR)) continue;
    const rest = oid.slice(OID_ADDR.length).split('.');
    const col = rest[0];
    const ip = rest.slice(1).join('.');
    if (rest.length !== 5 || !/^\d+$/.test(col)) continue;
    let e = byIp.get(ip);
    if (!e) { e = { ip }; byIp.set(ip, e); }
    if (col === '2') e.if_index = Number(value);
    else if (col === '3') e.mask = value;
  }
  return [...byIp.values()].filter(e => e.mask);
}

// ---------- IPv4 工具 ----------
export function ip2u(s) {
  const p = String(s).split('.');
  return p.length === 4 && p.every(x => /^\d{1,3}$/.test(x) && +x <= 255)
    ? (((+p[0] << 24) + (+p[1] << 16) + (+p[2] << 8) + +p[3]) >>> 0) : null;
}
export const isIp = s => ip2u(s) !== null;
const plen = mask => { const m = ip2u(mask); let n = 0; for (let i = 31; i >= 0 && ((m >>> i) & 1); i--) n++; return n; };
const covers = (dest, mask, ip) => ((ip2u(dest) & ip2u(mask)) >>> 0) === ((ip2u(ip) & ip2u(mask)) >>> 0);

// ---------- 快照刷新（托管临时项 → 轮询 → 读取 → 删除 → 存 topo_meta） ----------
/**
 * 目标节点：nodeIds（node_id 或 zbx_hostid）显式指定；缺省 = 名称含 核心/CORE/汇聚/AGG/FW/防火墙 的 active 节点
 * （候选清单只是"值得读路由表的 L3 设备"启发式，不构成任何拓扑断言）。
 */
export async function refreshRouteSnapshots(db, zbx, { nodeIds = null, batchSize = 8, waitMs = 150000, pollMs = 15000, log = () => {} } = {}) {
  const runId = 'rt' + Date.now().toString(36);
  const strs = [], ints = [];
  for (const v of (nodeIds || [])) { strs.push(String(v)); if (/^\d+$/.test(String(v))) ints.push(Number(v)); }
  let nodes;
  if (strs.length) {
    const conds = [], args = [];
    if (strs.length) { conds.push(`zbx_hostid IN (${strs.map(() => '?').join(',')})`); args.push(...strs); }
    if (ints.length) { conds.push(`node_id IN (${ints.map(() => '?').join(',')})`); args.push(...ints); }
    nodes = db.prepare(`SELECT node_id, zbx_hostid, display_name FROM topology_node WHERE status<>'stale' AND (${conds.join(' OR ')})`).all(...args);
  } else {
    nodes = db.prepare(`SELECT node_id, zbx_hostid, display_name FROM topology_node
      WHERE status<>'stale' AND (display_name LIKE '%核心%' OR display_name LIKE '%CORE%' OR display_name LIKE '%汇聚%'
        OR display_name LIKE '%AGG%' OR display_name LIKE '%FW%' OR display_name LIKE '%防火墙%'
        OR display_name LIKE '%互联网%' OR display_name LIKE '%接入区%')`).all();
  }
  nodes = nodes.filter(n => n.zbx_hostid);
  log(`${runId}: 路由快照目标 ${nodes.length} 台`);
  const stat = { runId, ok: 0, error: 0, no_iface: 0 };
  const now = () => Math.floor(Date.now() / 1000);

  for (let i = 0; i < nodes.length; i += batchSize) {
    const batch = nodes.slice(i, i + batchSize);
    const ifaces = await zbx.hostSnmpInterfaces(batch.map(n => n.zbx_hostid));
    const byHost = {};
    for (const f of ifaces) (byHost[f.hostid] ||= []).push(f);
    const created = [];
    for (const n of batch) {
      const snmpIf = (byHost[n.zbx_hostid] || [])[0];
      if (!snmpIf) { stat.no_iface++; continue; }
      for (const [tag, oid] of [['route', RT_WALK_ROUTE], ['addr', RT_WALK_ADDR]]) {
        try {
          const itemid = await zbx.createTempItem({
            name: `UOCP pathtrace ${tag} (managed)`, hostid: n.zbx_hostid, key_: `${runId}.${tag}.${n.node_id}`,
            type: 20, snmp_oid: oid, value_type: 4, interfaceid: snmpIf.interfaceid,
            delay: '1m', status: 0, timeout: '30s',
          });
          if (itemid) created.push({ n, tag, itemid });
          else throw new Error('item.create no id');
        } catch (e) { log(`${runId}: create fail ${n.display_name} ${tag}: ${e.message}`); }
      }
    }
    // 轮询等首轮采集（最长 waitMs；每项 lastclock>0 或有 error 即止）
    const deadline = Date.now() + waitMs;
    let pending = created.map(c => c.itemid);
    while (pending.length && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, pollMs));
      try {
        const info = await zbx.call('item.get', { output: ['itemid', 'error', 'lastclock'], itemids: pending });
        pending = info.filter(g => !+g.lastclock && !g.error).map(g => g.itemid);
      } catch { /* 查询抖动下轮再试 */ }
    }
    // 读取 → 存 topo_meta（route 与 addr 同节点合并成一份快照）
    const snap = new Map(batch.map(n => [n.node_id, { ts: now(), status: 'ok' }]));
    for (const c of created) {
      if (!snap.has(c.n.node_id)) continue;
      let itemErr = '';
      try { const info = await zbx.call('item.get', { output: ['itemid', 'error'], itemids: [c.itemid] }); itemErr = (info[0] && info[0].error) || ''; } catch { /* */ }
      try {
        const rows = await zbx.historyText([c.itemid], 1);
        const v = rows[0] && rows[0].value;
        if (v) {
          snap.get(c.n.node_id)[c.tag] = v;
          // Zabbix log 值 64KB 上限——65535B 即截断（实测全表 cidr walk 必截；
          // 单列 .5 目前 <35KB 安全，超限设备如实标 truncated，trace 时不猜数据）
          if (v.length >= 65500) { const s = snap.get(c.n.node_id); s.truncated = ((s.truncated || '') + ` ${c.tag}`).trim(); }
        }
        else if (itemErr) snap.get(c.n.node_id).error = ((snap.get(c.n.node_id).error || '') + `${c.tag}: ${itemErr.slice(0, 200)} `).trim();
      } catch (e) {
        const s = snap.get(c.n.node_id);
        s.error = ((s.error || '') + `${c.tag}: ${String(e.message).slice(0, 200)} `).trim();
      }
    }
    for (const n of batch) {
      const s = snap.get(n.node_id);
      if (!s.route && !s.addr) { s.status = 'error'; s.error = s.error || 'no data'; stat.error++; }
      else if (!s.route || !s.addr) { s.status = 'partial'; stat.error++; }
      else stat.ok++;
      db.prepare('INSERT INTO topo_meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v')
        .run(`rt.${n.node_id}`, JSON.stringify(s));
    }
    const ids = created.map(c => c.itemid);
    if (ids.length) { try { await zbx.deleteItems(ids); } catch (e) { log(`${runId}: cleanup warn ${e.message}`); } }
    log(`${runId}: 批次 ${i / batchSize + 1} 完成 ok=${stat.ok} err=${stat.error}`);
  }
  db.prepare('INSERT INTO topo_meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v')
    .run('rt.last_refresh', JSON.stringify({ at: now(), ...stat }));
  return stat;
}

/** 清理异常中断遗留的托管快照项（key_ 前缀 rt<base36 时间戳>.） */
export async function cleanupRouteItems(zbx) {
  const items = await zbx.call('item.get', {
    output: ['itemid', 'hostid', 'key_'], search: { key_: 'pathtrace' }, searchByAnd: false, limit: 1000,
  });
  const ids = items.filter(i => /^rt[0-9a-z]+\.(route|addr)\./.test(i.key_)).map(i => i.itemid);
  if (ids.length) await zbx.deleteItems(ids);
  return ids.length;
}

/** 快照状态一览（前端显示新鲜度） */
export function snapshotStatus(db) {
  const rows = db.prepare(`SELECT k, v FROM topo_meta WHERE k LIKE 'rt.%' AND k<>'rt.last_refresh'`).all();
  const data = rows.map(r => {
    const nodeId = Number(r.k.slice(3));
    const n = db.prepare('SELECT node_id, display_name, mgmt_ip FROM topology_node WHERE node_id=?').get(nodeId);
    let s = null; try { s = JSON.parse(r.v); } catch { /* */ }
    return {
      node_id: nodeId, name: n?.display_name || null, mgmt_ip: n?.mgmt_ip || null,
      ts: s?.ts || null, status: s?.status || 'bad_json',
      routes: s?.route ? parseRouteWalk(s.route).length : 0,
      addrs: s?.addr ? parseAddrWalk(s.addr).length : 0,
      error: s?.error || null,
    };
  });
  const lr = db.prepare("SELECT v FROM topo_meta WHERE k='rt.last_refresh'").get();
  return { data: data.sort((a, b) => (b.ts || 0) - (a.ts || 0)), last_refresh: lr ? JSON.parse(lr.v) : null };
}

// ---------- 追踪算法 ----------
const MAX_HOPS = 10;

function loadSnapshots(db) {
  const rows = db.prepare(`SELECT k, v FROM topo_meta WHERE k LIKE 'rt.%' AND k<>'rt.last_refresh'`).all();
  const snaps = [];
  for (const r of rows) {
    const nodeId = Number(r.k.slice(3));
    let s = null; try { s = JSON.parse(r.v); } catch { /* */ }
    if (!s || !s.route || !s.addr) continue;
    const node = db.prepare('SELECT node_id, zbx_hostid, display_name, mgmt_ip FROM topology_node WHERE node_id=?').get(nodeId);
    if (!node) continue;
    snaps.push({ node, routes: parseRouteWalk(s.route), addrs: parseAddrWalk(s.addr), ts: s.ts || 0 });
  }
  return snaps;
}

/**
 * 追踪 src→dst 的设备链。返回 {chains:[…], meta:{…}}。
 * 入口 = 源IP落在其直连网段（本机IP+掩码）的快照设备（VRRP/双核心会各出一条链）。
 * 每跳：最长前缀匹配查路由 → 下一跳IP用全局 ipAddr 快照反查纳管设备；
 * 出/入接口经 if_index→topology_interface，物理链路只取 topology_link 已有证据（无证据 link=null）。
 */
export function tracePath(db, src, dst) {
  const srcU = ip2u(src), dstU = ip2u(dst);
  if (srcU === null || dstU === null) return { error: 'src/dst 须为合法 IPv4 地址' };
  const snaps = loadSnapshots(db);
  if (!snaps.length) return { error: '暂无路由快照，请先 POST /api/topology/pathtrace/refresh' };

  // 下一跳IP → 拥有该地址的快照设备
  const ipToSnap = new Map();
  for (const s of snaps) for (const a of s.addrs) if (!ipToSnap.has(a.ip)) ipToSnap.set(a.ip, { snap: s, addr: a });

  const ifaceByIndex = db.prepare('SELECT interface_id, if_name, if_index FROM topology_interface WHERE node_id=? AND if_index=? AND stale=0 LIMIT 1');
  const ifaceName = db.prepare('SELECT if_name FROM topology_interface WHERE interface_id=?');

  const findLink = (fromNodeId, outIfaceId, toNodeId) => {
    if (!outIfaceId || !toNodeId || fromNodeId === toNodeId) return null;
    const rows = db.prepare(`SELECT l.link_id, l.status, l.a_iface, l.b_iface FROM topology_link l
      WHERE l.status NOT IN ('rejected','stale')
        AND ((l.a_node=? AND l.b_node=? AND l.a_iface=?) OR (l.b_node=? AND l.a_node=? AND l.b_iface=?))
      LIMIT 1`).get(fromNodeId, toNodeId, outIfaceId, fromNodeId, toNodeId, outIfaceId);
    return rows || null;
  };

  // 出接口的 LLDP 物理对端候选（对端必须是 active 纳管节点；排除来路接口与已访问设备；confirmed/manual 优先）
  const findPhysNext = (fromNodeId, outIfaceId, excludeIfaceId, visitedSet) => {
    if (!outIfaceId) return [];
    const rows = db.prepare(`SELECT l.link_id, l.status,
        CASE WHEN l.a_node=? THEN l.b_node ELSE l.a_node END AS peer,
        CASE WHEN l.a_iface=? THEN l.b_iface ELSE l.a_iface END AS peer_iface
      FROM topology_link l
      WHERE l.status NOT IN ('rejected','stale') AND (l.a_iface=? OR l.b_iface=?)
        AND CASE WHEN l.a_node=? THEN l.b_node ELSE l.a_node END IS NOT NULL
        AND CASE WHEN l.a_iface=? THEN l.b_iface ELSE l.a_iface END IS NOT NULL
        AND CASE WHEN l.a_iface=? THEN l.b_iface ELSE l.a_iface END <> ?
      ORDER BY CASE l.status WHEN 'confirmed' THEN 0 WHEN 'manual' THEN 1 ELSE 2 END, l.confidence DESC, l.link_id DESC`).all(
        fromNodeId, outIfaceId, outIfaceId, outIfaceId, fromNodeId, outIfaceId, outIfaceId, excludeIfaceId ?? -1);
    const out = [];
    for (const r of rows) {
      if (visitedSet.has(r.peer)) continue;
      const pn = db.prepare("SELECT node_id, display_name, mgmt_ip FROM topology_node WHERE node_id=? AND status='active'").get(r.peer);
      if (!pn) continue;
      const snap = snaps.find(s => s.node.node_id === r.peer) || null;
      out.push({ link_id: r.link_id, status: r.status, peer_iface: r.peer_iface, node: snap, node_id: pn.node_id, display_name: pn.display_name, mgmt_ip: pn.mgmt_ip });
    }
    return out;
  };

  const lpm = (s, dstIp) => pickRoute(s.routes, dstIp);

  // 入口设备：src 落在其直连网段的快照设备
  const entries = [];
  for (const s of snaps) {
    for (const a of s.addrs) {
      if (a.mask && isIp(a.mask) && covers(a.ip, a.mask, src)) { entries.push({ snap: s, via: a }); break; }
    }
  }
  // 出口判定（dst 直连在哪台快照设备上）供前端展示
  const dstOn = [];
  for (const s of snaps) for (const a of s.addrs) {
    if (a.mask && isIp(a.mask) && covers(a.ip, a.mask, dst)) { dstOn.push(s.node.display_name); break; }
  }
  const meta = {
    src, dst, snapshot_nodes: snaps.length,
    oldest_snapshot: Math.min(...snaps.map(s => s.ts)),
    dst_direct_on: dstOn,
    entry_candidates: entries.map(e => e.snap.node.display_name),
    warnings: [],
  };

  const chains = [];
  for (const ent of entries.slice(0, 6)) {
    const hops = [];
    const visited = new Set();
    let cur = ent.snap, note = null;
    let inName = null, inId = null; // 本跳的入接口（上一跳链路对端）
    for (let hop = 0; hop <= MAX_HOPS; hop++) {
      if (visited.has(cur.node.node_id)) { note = '检测到路由环路，已停止'; break; }
      visited.add(cur.node.node_id);

      const route = lpm(cur, dst);
      // 目的直连在本机 → 末跳（交付跳）
      const directToDst = cur.addrs.find(a => a.mask && isIp(a.mask) && covers(a.ip, a.mask, dst));
      const entryIface = hop === 0 && ent.via ? ifaceByIndex.get(cur.node.node_id, ent.via.if_index) : null;
      const hopRec = {
        node_id: cur.node.node_id, name: cur.node.display_name, mgmt_ip: cur.node.mgmt_ip,
        in_iface: hop === 0 ? (entryIface?.if_name || (ent.via ? `if${ent.via.if_index}` : null)) : inName,
        iface_id_in: hop === 0 ? (entryIface?.interface_id ?? null) : inId,
      };
      if (directToDst) {
        const ai = ifaceByIndex.get(cur.node.node_id, directToDst.if_index);
        hopRec.out_iface = ai?.if_name || `if${directToDst.if_index}`;
        hopRec.out_iface_id = ai?.interface_id ?? null;
        hopRec.action = 'direct';   // 目的直连本机
        hops.push(hopRec);
        break;
      }
      if (!route) { note = `${cur.node.display_name} 路由表无匹配目的（快照缺失或路由缺失）`; hopRec.action = 'no-route'; hops.push(hopRec); break; }
      if (route.next_hop === '0.0.0.0' || !isIp(route.next_hop)) {
        // 直连路由但本机地址表没有该网段接口（如 from 表/黑洞）——不猜下一跳
        hopRec.action = 'route-guess';
        hopRec.route = { dest: route.dest, mask: route.mask, next_hop: route.next_hop, if_index: route.if_index };
        const ai = ifaceByIndex.get(cur.node.node_id, route.if_index);
        hopRec.out_iface = ai?.if_name || null;
        hopRec.out_iface_id = ai?.interface_id ?? null;
        hops.push(hopRec);
        note = `路由出接口 ${hopRec.out_iface || 'if' + route.if_index} 但下一跳未定，停止（不伪造）`;
        break;
      }
      const ai = ifaceByIndex.get(cur.node.node_id, route.if_index);
      hopRec.out_iface = ai?.if_name || (route.if_index != null ? `if${route.if_index}` : null);
      hopRec.out_iface_id = ai?.interface_id ?? null;
      hopRec.route = { dest: route.dest, mask: route.mask, next_hop: route.next_hop, if_index: route.if_index };
      hopRec.action = 'forward';

      const nxt = ipToSnap.get(route.next_hop);
      if (nxt) {
        // 物理链路证据：本端出接口 → 下一跳设备
        const link = findLink(cur.node.node_id, hopRec.out_iface_id, nxt.snap.node.node_id);
        hopRec.link = link ? { link_id: link.link_id, status: link.status } : null;
        hopRec.evidence = link ? (link.status === 'confirmed' || link.status === 'manual' ? 'lldp-confirmed' : link.status) : 'route-only';
        hops.push(hopRec);
        // 下一跳的"入接口"= 链路对端接口（若有证据；a/b 端不定，取非出接口的一端）
        cur = nxt.snap;
        inId = link ? (link.a_iface === hopRec.out_iface_id ? link.b_iface : link.a_iface) : null;
        inName = inId ? ifaceName.get(inId)?.if_name || null : null;
        continue;
      }
      // 下一跳 IP 不在任何快照地址表（常见：SNMP 只采到管理口 IP，三层互连 IP 采不到）
      // → 按用户核定方法：看本跳路由出接口的 LLDP 物理对端是哪台纳管设备，跳过去继续查其路由表。
      hopRec.next_hop_unresolved = route.next_hop; // IP 归属未知，如实标注
      const cands = findPhysNext(cur.node.node_id, hopRec.out_iface_id, inId, visited);
      if (!cands.length) {
        hopRec.evidence = 'route-only';
        hopRec.next_hop_unmanaged = route.next_hop; // 且出接口无任何 LLDP 对端证据：设备边界，停止
        hops.push(hopRec);
        note = `下一跳 ${route.next_hop} 不在任何快照地址表，且出接口 ${hopRec.out_iface} 无 LLDP 邻居证据，停止（不伪造）`;
        break;
      }
      // 多候选优先级：有快照且路由可达目的 > 有快照 > L2/无路由条目对端（作链末展示）
      const chosen = cands.find(c => c.node && lpm(c.node, dst)) || cands.find(c => c.node) || cands[0];
      hopRec.link = { link_id: chosen.link_id, status: chosen.status };
      hopRec.evidence = chosen.status === 'confirmed' || chosen.status === 'manual' ? 'lldp-confirmed' : 'lldp-half';
      hopRec.via = 'lldp-peer'; // 本跳按物理邻居续跳（IP 归属未知）
      if (cands.length > 1) hopRec.peer_candidates = cands.map(c => ({ node_id: c.node_id, name: c.display_name, link_id: c.link_id }));
      hops.push(hopRec);
      inId = chosen.peer_iface;
      inName = ifaceName.get(inId)?.if_name || null;
      if (!chosen.node) {
        hops.push({ node_id: chosen.node_id, name: chosen.display_name, mgmt_ip: chosen.mgmt_ip, in_iface: inName, iface_id_in: inId,
          action: 'no-snapshot', evidence: hopRec.evidence, link: { link_id: chosen.link_id, status: chosen.status } });
        note = `下一跳 ${route.next_hop} IP 未知；沿 LLDP 证据到达 ${chosen.display_name}，该设备暂无路由快照，无法继续（可刷新路由快照）`;
        break;
      }
      cur = chosen.node;
    }
    if (note) meta.warnings.push(`${ent.snap.node.display_name} 入口链：${note}`);
    chains.push({ entry: ent.snap.node.node_id, hops, complete: hops.length && hops[hops.length - 1].action === 'direct' });
  }
  if (!entries.length) meta.warnings.push('没有任何已快照设备的直连网段包含源地址——源可能在接入 VLAN 内（需该 VLAN 网关设备的路由快照），或快照过期');
  return { chains, meta };
}

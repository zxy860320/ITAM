/* 网络拓扑 PoC —— ELK layered + 设备卡片 + 正交连线
 * 数据：window.TOPO_SNAPSHOT（只读导出自生产 topology.db，绝非模拟） */
'use strict';
const SNAP = window.TOPO_SNAPSHOT;
const N0 = document.getElementById('svg'), VP = document.getElementById('viewport');
const SVGNS = 'http://www.w3.org/2000/svg';
const NODE_W = 210, NODE_H = 64;
const byId = new Map(SNAP.nodes.map(n => [n.node_id, n]));
const linkById = new Map(SNAP.links.map(l => [l.link_id, l]));

/* ---------- 邻接 ---------- */
const adj = new Map();
for (const l of SNAP.links) {
  if (l.a_node != null) { if (!adj.has(l.a_node)) adj.set(l.a_node, []); adj.get(l.a_node).push(l); }
  if (l.b_node != null) { if (!adj.has(l.b_node)) adj.set(l.b_node, []); adj.get(l.b_node).push(l); }
}
function ends(l, from) {
  if (l.a_node === from) return { own: { node: l.a_node, ifName: l.a_if, oper: l.a_oper }, peer: { node: l.b_node, ifName: l.b_if, snap: l.b_snapshot } };
  return { own: { node: l.b_node, ifName: l.b_if, oper: l.b_oper }, peer: { node: l.a_node, ifName: l.a_if, snap: null } };
}
const extKeyOf = (l) => (l.b_snapshot && l.b_snapshot.chassis_id) || ('lk' + l.link_id);

/* ---------- 状态 ---------- */
const DEFAULT_FOCUS = 54;
let state = { focus: DEFAULT_FOCUS, hop: 1 };
try { const s = JSON.parse(localStorage.getItem('topo.poc.view') || 'null'); if (s && s.focus) state = s; } catch (e) {}
// URL 参数覆盖（便于验收测试：?focus=54&hop=2）
try {
  const q = new URLSearchParams(location.search);
  if (q.get('focus')) state.focus = +q.get('focus');
  if (q.get('hop')) state.hop = +q.get('hop');
} catch (e) {}
let selection = { kind: null, id: null };
let graph = null;
let view = { x: 0, y: 0, k: 1 };

/* ---------- 子图 ---------- */
function computeSubgraph() {
  const managed = new Set([state.focus]);
  const exts = new Map();
  let frontier = [state.focus];
  for (let d = 0; d < state.hop; d++) {
    const next = [];
    for (const nid of frontier) {
      for (const l of (adj.get(nid) || [])) {
        const { peer } = ends(l, nid);
        if (peer.node == null) {
          const k = extKeyOf(l);
          if (!exts.has(k)) exts.set(k, { key: k, snap: l.b_snapshot, attach: new Set([nid]) });
          exts.get(k).attach.add(nid);
        } else if (!managed.has(peer.node)) { managed.add(peer.node); next.push(peer.node); }
      }
    }
    frontier = next;
  }
  // 补齐：挂在任意 managed 节点上的未纳管对端也建 EXT 卡（BFS 只探索了 frontier 的链路）
  for (const l of SNAP.links) {
    if (l.b_node == null && managed.has(l.a_node)) {
      const k = extKeyOf(l);
      if (!exts.has(k)) exts.set(k, { key: k, snap: l.b_snapshot, attach: new Set([l.a_node]) });
      exts.get(k).attach.add(l.a_node);
    }
  }
  // 只保留两端都在图内的链路（避免 ELK 边引用缺失 shape；"邻居↔邻居"链路需两跳才出现）
  const links = SNAP.links.filter(l =>
    managed.has(l.a_node) &&
    (l.b_node == null ? exts.has(extKeyOf(l)) : managed.has(l.b_node)));
  const sig = state.focus + '|' + state.hop + '|' +
    [...managed].sort((a, b) => a - b).join(',') + '|' + [...exts.keys()].sort().join(',') + '|' + links.map(l => l.link_id).join(',');
  return { managed, exts, links, sig };
}

/* ---------- ELK ---------- */
const gidToElk = new Map(); // 'EXT:cid:..:..' -> 'EXT_cid_.._..'(ELK 不接受 id 中的冒号，会被解析为 node:port)
function elkIdOf(gid) { if (!gidToElk.has(gid)) gidToElk.set(gid, gid.replace(/:/g, '_')); return gidToElk.get(gid); }
const elkToGid = new Map();
function buildElk(sg) {
  elkToGid.clear();
  const children = [];
  for (const nid of sg.managed) { const g = 'N' + nid; elkToGid.set(elkIdOf(g), g); children.push({ id: elkIdOf(g), width: NODE_W, height: NODE_H, labels: [{ text: byId.get(nid).display_name }] }); }
  for (const ec of sg.exts.values()) {
    const nm = (ec.snap && ec.snap.sys_name) || '未命名邻居';
    const g = 'EXT:' + ec.key;
    elkToGid.set(elkIdOf(g), g);
    children.push({ id: elkIdOf(g), width: NODE_W, height: NODE_H, labels: [{ text: nm + '（未纳管）' }] });
  }
  const edges = sg.links.map(l => ({
    id: 'E' + l.link_id,
    sources: [elkIdOf('N' + l.a_node)],
    targets: [elkIdOf(l.b_node != null ? 'N' + l.b_node : 'EXT:' + extKeyOf(l))],
  }));
  return {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'DOWN',
      'elk.spacing.nodeNode': '42',
      'elk.layered.spacing.nodeNodeBetweenLayers': '110',
      'elk.spacing.edgeNode': '20',
      'elk.spacing.edgeEdge': '12',
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
      'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
      'elk.layered.mergeEdges': 'false',
      'elk.layered.mergeHierarchyEdges': 'false',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.padding': '[top=30,left=30,bottom=30,right=30]',
    },
    children, edges,
  };
}
function sectionsToPts(e) {
  const pts = [];
  if (e.sections && e.sections.length) for (const s of e.sections) { pts.push(s.startPoint); for (const b of (s.bendPoints || [])) pts.push(b); pts.push(s.endPoint); }
  else if (e.startPoint && e.endPoint) pts.push(e.startPoint, e.endPoint);
  return pts.map(p => ({ x: p.x, y: p.y }));
}

/* ---------- 持久化 ---------- */
function savedLayout(sg) {
  try { const s = JSON.parse(localStorage.getItem('topo.poc.layout.' + state.focus) || 'null'); if (s && s.sig === sg.sig) return s; } catch (e) {}
  return null;
}
function persistLayout() {
  if (!graph) return;
  const nodes = {}, edges = {};
  for (const [id, g] of graph.nodeGeo) nodes[id] = { x: g.x, y: g.y };
  for (const [id, pts] of graph.edgeGeo) edges[id] = pts;
  localStorage.setItem('topo.poc.layout.' + state.focus, JSON.stringify({ sig: graph.sig, nodes, edges, view }));
}

/* ---------- 拖拽后的 Manhattan 重路由 ---------- */
function geoCenter(id) { const g = graph.nodeGeo.get(id); return { x: g.x + NODE_W / 2, y: g.y + NODE_H / 2 }; }
function manhattanPts(aId, bId) {
  const a = geoCenter(aId), b = geoCenter(bId);
  const down = b.y >= a.y;
  const s = { x: a.x, y: down ? a.y + NODE_H / 2 : a.y - NODE_H / 2 };
  const t = { x: b.x, y: down ? b.y - NODE_H / 2 : b.y + NODE_H / 2 };
  if (Math.abs(s.x - t.x) < 1) return [s, t];
  const midY = (s.y + t.y) / 2;
  return [s, { x: s.x, y: midY }, { x: t.x, y: midY }, t];
}

/* ---------- SVG ---------- */
function el(t, a) { const e = document.createElementNS(SVGNS, t); for (const k in a) e.setAttribute(k, a[k]); return e; }
function trunc(s, n) { return s && s.length > n ? s.slice(0, n - 1) + '…' : (s || ''); }
function iconOf(ext) {
  const g = el('g', { class: 'icon', transform: 'translate(12,18)' });
  if (ext) {
    g.appendChild(el('rect', { x: 0, y: 0, width: 26, height: 20, rx: 3 }));
    const t = el('text', { x: 13, y: 15, 'text-anchor': 'middle', fill: '#B388FF', 'font-size': '12', stroke: 'none' }); t.textContent = '?'; g.appendChild(t);
  } else {
    g.appendChild(el('rect', { x: 0, y: 1, width: 28, height: 8, rx: 2 }));
    g.appendChild(el('rect', { x: 0, y: 13, width: 28, height: 8, rx: 2 }));
    g.appendChild(el('line', { x1: 6, y1: 9, x2: 6, y2: 13 }));
    g.appendChild(el('line', { x1: 22, y1: 9, x2: 22, y2: 13 }));
  }
  return g;
}
function drawNode(id) {
  const g = graph.nodeGeo.get(id);
  const ext = id.startsWith('EXT:');
  const gg = el('g', { class: 'node' + (ext ? ' ext' : ''), transform: `translate(${g.x},${g.y})` });
  gg.dataset.gid = id;
  gg.appendChild(el('rect', { class: 'card', x: 0, y: 0, width: NODE_W, height: NODE_H, rx: 8 }));
  gg.appendChild(iconOf(ext));
  let name, ip, role, dot = '#4CAF50';
  if (ext) {
    const ec = graph.sg.exts.get(id.slice(4));
    const s = (ec && ec.snap) || {};
    name = s.sys_name || '未命名邻居'; ip = s.port_id ? ('对端端口 ' + s.port_id) : '对端未纳管';
    role = '未纳管 · 仅 LLDP 快照'; dot = '#B388FF';
  } else {
    const n = byId.get(+id.slice(1));
    name = n.display_name; ip = n.mgmt_ip || '—';
    role = '未分类 · ' + (n.vendor || '?') + ' · ' + (n.iface_count || 0) + ' 接口';
    if (n.status === 'degraded') dot = '#F2C94C';
  }
  const t1 = el('text', { class: 'nm', x: 48, y: 22 }); t1.textContent = trunc(name, 17); gg.appendChild(t1);
  const t2 = el('text', { class: 'ip', x: 48, y: 38 }); t2.textContent = trunc(ip, 26); gg.appendChild(t2);
  const t3 = el('text', { class: 'role', x: 48, y: 52 }); t3.textContent = trunc(role, 30); gg.appendChild(t3);
  gg.appendChild(el('circle', { cx: NODE_W - 14, cy: 13, r: 4, fill: dot }));
  return gg;
}
function drawEdge(linkId) {
  const l = linkById.get(linkId);
  const pts = graph.edgeGeo.get(linkId);
  if (!pts || pts.length < 2) return null;
  const d = 'M' + pts.map(p => p.x + ' ' + p.y).join(' L ');
  const grp = el('g', {}); grp.dataset.link = String(linkId);
  const cls = l.status === 'confirmed' ? 'confirmed' : 'half';
  grp.appendChild(el('path', { class: 'edge ' + cls, d }));
  grp.appendChild(el('path', { class: 'edge hit', d }));
  const aIf = l.a_if || '?';
  const bIf = l.b_if || (l.b_snapshot && l.b_snapshot.port_id) || '?';
  const s = pts[0], t = pts[pts.length - 1];
  const lbl = (x, y, txt) => { const tt = el('text', { class: 'elbl', x, y }); tt.textContent = txt; return tt; };
  grp.appendChild(lbl(s.x + 4, s.y + (pts[1] && pts[1].y < s.y ? -4 : 11), aIf));
  grp.appendChild(lbl(t.x + 4, t.y + (pts[pts.length - 2] && pts[pts.length - 2].y < t.y ? -4 : 11), bIf));
  return grp;
}
function redraw() {
  const eg = el('g', { id: 'edges' }), ng = el('g', { id: 'nodes' });
  for (const lid of graph.edgeGeo.keys()) { const e = drawEdge(lid); if (e) eg.appendChild(e); }
  for (const id of graph.nodeGeo.keys()) ng.appendChild(drawNode(id));
  VP.innerHTML = ''; VP.appendChild(eg); VP.appendChild(ng);
  applyTransform(); applyHighlight();
}

/* ---------- 高亮 ---------- */
function neighborGidsOf(nid) {
  const set = new Set(['N' + nid]);
  for (const l of (adj.get(nid) || [])) {
    const { peer } = ends(l, nid);
    set.add(peer.node != null ? 'N' + peer.node : 'EXT:' + extKeyOf(l));
  }
  return set;
}
function applyHighlight() {
  const sel = selection;
  VP.querySelectorAll('.node').forEach(n => {
    n.classList.remove('sel', 'dim');
    if (sel.kind === 'node') {
      const gid = typeof sel.id === 'number' ? 'N' + sel.id : sel.id;
      if (n.dataset.gid === gid) n.classList.add('sel');
      else if (!neighborGidsOf(state.focus).has(n.dataset.gid) && !(graph.sg.exts.size && n.dataset.gid.startsWith('EXT:') && (graph.sg.exts.get(n.dataset.gid.slice(4)) || {}).attach && graph.sg.exts.get(n.dataset.gid.slice(4)).attach.has(sel.id))) n.classList.add('dim');
    } else if (sel.kind === 'edge') {
      const l = linkById.get(sel.id);
      const keep = new Set(['N' + l.a_node, l.b_node != null ? 'N' + l.b_node : 'EXT:' + extKeyOf(l)]);
      if (!keep.has(n.dataset.gid)) n.classList.add('dim');
    }
  });
  VP.querySelectorAll('g[data-link]').forEach(eg => {
    const lid = +eg.dataset.link;
    const vis = eg.querySelector('.edge:not(.hit)');
    vis.classList.remove('sel'); eg.classList.remove('dim');
    if (sel.kind === 'edge' && lid === sel.id) vis.classList.add('sel');
    else if (sel.kind === 'node') {
      const l = linkById.get(lid);
      const touch = l.a_node === sel.id || l.b_node === sel.id ||
        (l.b_node == null && l.a_node === sel.id);
      if (!touch) eg.classList.add('dim');
    }
  });
}

/* ---------- 主绘制 ---------- */
async function draw(useSaved = true) {
  const sg = computeSubgraph();
  graph = { sg, nodeGeo: new Map(), edgeGeo: new Map(), sig: sg.sig };
  const saved = useSaved ? savedLayout(sg) : null;
  if (saved) {
    for (const id in saved.nodes) graph.nodeGeo.set(id, saved.nodes[id]);
    for (const id in saved.edges) graph.edgeGeo.set(+id, saved.edges[id]);
    if (saved.view) view = saved.view;
  } else {
    const elk = new ELK();
    let lay;
    try { lay = await elk.layout(buildElk(sg)); }
    catch (e) { console.error('ELK layout failed', e); PB.innerHTML = '<div class="note">ELK 布局失败：' + e.message + '</div>'; return; }
    for (const c of lay.children) graph.nodeGeo.set(elkToGid.get(c.id) || c.id, { x: c.x, y: c.y });
    for (const e of lay.edges) { const p = sectionsToPts(e); if (p.length) graph.edgeGeo.set(+e.id.slice(1), p); }
  }
  document.getElementById('focusTag').textContent = '聚焦：' + (byId.get(state.focus) ? byId.get(state.focus).display_name : '#' + state.focus);
  document.getElementById('focusId').textContent = '#' + state.focus;
  localStorage.setItem('topo.poc.view', JSON.stringify(state));
  redraw(); renderPanel();
}

/* ---------- 平移缩放 ---------- */
function applyTransform() { VP.setAttribute('transform', `translate(${view.x},${view.y}) scale(${view.k})`); }
function fitView() {
  const bb = VP.getBBox(); const w = N0.clientWidth, h = N0.clientHeight;
  if (!bb.width || !bb.height) return;
  const k = Math.min((w - 60) / bb.width, (h - 80) / bb.height, 1.2);
  view.k = k; view.x = (w - bb.width * k) / 2 - bb.x * k; view.y = (h - bb.height * k) / 2 - bb.y * k;
  applyTransform();
}
let pan = null, drag = null;
N0.addEventListener('wheel', e => {
  e.preventDefault(); const r = N0.getBoundingClientRect();
  const mx = e.clientX - r.left, my = e.clientY - r.top;
  const f = e.deltaY < 0 ? 1.12 : 0.89; const k2 = Math.max(0.15, Math.min(2.5, view.k * f));
  view.x = mx - (mx - view.x) * (k2 / view.k); view.y = my - (my - view.y) * (k2 / view.k); view.k = k2;
  applyTransform();
}, { passive: false });
function svgPoint(e) { const r = N0.getBoundingClientRect(); return { x: (e.clientX - r.left - view.x) / view.k, y: (e.clientY - r.top - view.y) / view.k }; }
N0.addEventListener('mousedown', e => {
  const nEl = e.target.closest('.node');
  if (nEl) { const p = svgPoint(e); const g = graph.nodeGeo.get(nEl.dataset.gid); if (g) drag = { gid: nEl.dataset.gid, dx: p.x - g.x, dy: p.y - g.y, moved: false }; return; }
  pan = { x: e.clientX - view.x, y: e.clientY - view.y }; N0.classList.add('panning');
});
window.addEventListener('mousemove', e => {
  if (drag) {
    const p = svgPoint(e); drag.moved = true;
    const g = graph.nodeGeo.get(drag.gid); g.x = p.x - drag.dx; g.y = p.y - drag.dy;
    for (const l of graph.sg.links) {
      const a = 'N' + l.a_node, b = l.b_node != null ? 'N' + l.b_node : 'EXT:' + extKeyOf(l);
      if (a === drag.gid || b === drag.gid) graph.edgeGeo.set(l.link_id, manhattanPts(a, b));
    }
    redraw();
  } else if (pan) { view.x = e.clientX - pan.x; view.y = e.clientY - pan.y; applyTransform(); }
});
window.addEventListener('mouseup', () => {
  if (drag) {
    if (!drag.moved) {
      const gid = drag.gid;
      if (gid.startsWith('EXT:')) { selection = { kind: 'ext', id: gid.slice(4) }; applyHighlight(); renderPanel(); }
      else { const nid = +gid.slice(1); if (nid !== state.focus) { state.focus = nid; selection = { kind: 'node', id: nid }; draw(); return; } selection = { kind: 'node', id: nid }; applyHighlight(); renderPanel(); }
    }
    drag = null;
  }
  pan = null; N0.classList.remove('panning');
});
N0.addEventListener('click', e => {
  const eg = e.target.closest('g[data-link]');
  if (eg) { selection = { kind: 'edge', id: +eg.dataset.link }; applyHighlight(); renderPanel(); }
});

/* ---------- 右侧面板 ---------- */
const PB = document.getElementById('panelBody');
let tab = 'detail';
function fmtTs(ts) { if (!ts) return '—'; return new Date(ts * 1000).toLocaleString('zh-CN', { hour12: false }); }
function operTxt(o) { return o === 1 ? '<span class="st-ok">up</span>' : o === 2 ? '<span class="st-crit">down</span>' : '<span class="st-dim">未知</span>'; }
function stTxt(s) {
  return s === 'confirmed' ? '<span class="st-ok">已确认（双端各自观察到对端）</span>'
    : s === 'half' ? '<span class="st-warn">单端发现（half）· 待网络组核实</span>' : s;
}
function linkCard(l) {
  const a = byId.get(l.a_node);
  const bM = l.b_node != null ? byId.get(l.b_node) : null;
  const snap = l.b_snapshot;
  return '<div class="linkcard"><div class="t">' + trunc(a ? a.display_name : '#' + l.a_node, 20) + ' ⇄ ' +
    (bM ? trunc(bM.display_name, 20) : (snap && snap.sys_name ? trunc(snap.sys_name, 20) : '未纳管对端') + '<span class="st-ext">（未纳管）</span>') + '</div>' +
    '<div class="kv">' +
    '<span class="k">链路 ID</span><span class="v mono">#' + l.link_id + '</span>' +
    '<span class="k">状态</span><span class="v">' + stTxt(l.status) + '</span>' +
    '<span class="k">发现来源</span><span class="v">' + (l.source === 'lldp_zbx' ? 'LLDP（Zabbix SNMP 只读采集）' : l.source === 'manual' ? '人工确认' : l.source) + '</span>' +
    '<span class="k">置信度</span><span class="v">' + l.confidence + '</span>' +
    '<span class="k">A 端</span><span class="v">' + (a ? trunc(a.display_name, 22) + ' <span class="mono st-dim">' + (a.mgmt_ip || '') + '</span><br>' : '') + '<span class="mono">' + (l.a_if || '?') + '</span> · ' + operTxt(l.a_oper) + '</span>' +
    '<span class="k">B 端</span><span class="v">' + (bM
      ? trunc(bM.display_name, 22) + ' <span class="mono st-dim">' + (bM.mgmt_ip || '') + '</span><br><span class="mono">' + (l.b_if || '?') + '</span> · ' + operTxt(l.b_oper)
      : (snap ? '<span class="st-ext">未纳管</span> 快照邻居名 <span class="mono">' + (snap.sys_name || '?') + '</span><br>快照端口 <span class="mono">' + (snap.port_id || '?') + '</span><br>chassis-id <span class="mono">' + (snap.chassis_id || '?') + '</span>' : '—')) + '</span>' +
    '<span class="k">A 侧观察于</span><span class="v mono">' + fmtTs(l.seen_a_at) + '</span>' +
    '<span class="k">B 侧观察于</span><span class="v mono">' + fmtTs(l.seen_b_at) + (l.seen_b_at ? '' : '（B 端未观察到）') + '</span>' +
    '<span class="k">证据键</span><span class="v mono st-dim">' + l.norm_key + '</span>' +
    '</div></div>';
}
function renderPanel() {
  if (tab === 'unlinked') {
    const withLink = new Set();
    for (const l of SNAP.links) { withLink.add(l.a_node); if (l.b_node != null) withLink.add(l.b_node); }
    const list = SNAP.nodes.filter(n => !withLink.has(n.node_id));
    PB.innerHTML = '<div class="note">以下 <b>' + list.length + '</b> 台纳管设备当前<b>没有任何已发现的真实链路</b>（LLDP 未开启 / 对端不支持 / 尚未被发现轮覆盖）。按重构要求，它们不进入任何连线图，绝不伪造连接。点击可在上方聚焦查看其发现记录。</div><div class="devlist">' +
      list.map(n => '<div class="devrow" data-nid="' + n.node_id + '"><div class="nm">' + n.display_name + '</div><div class="sub mono">' + (n.mgmt_ip || '—') + ' · ' + n.vendor + ' · ' + n.iface_count + ' 接口' + (n.status === 'degraded' ? ' · 降级' : '') + '</div></div>').join('') + '</div>';
    PB.querySelectorAll('.devrow').forEach(r => r.onclick = () => { state.focus = +r.dataset.nid; selection = { kind: 'node', id: state.focus }; draw(); });
    return;
  }
  if (tab === 'neighbors') {
    const rows = [];
    for (const l of (adj.get(state.focus) || [])) {
      const { peer } = ends(l, state.focus);
      const pn = peer.node != null ? byId.get(peer.node) : null;
      rows.push('<div class="devrow" data-lid="' + l.link_id + '"><div class="nm">' + (pn ? pn.display_name : ((peer.snap && peer.snap.sys_name) || '未纳管对端') + '（未纳管）') + '</div>' +
        '<div class="sub mono">' + (l.a_node === state.focus ? l.a_if : l.b_if || '?') + ' ⇄ ' + (pn ? (l.a_node === state.focus ? l.b_if : l.a_if) : (peer.snap && peer.snap.port_id) || '?') + ' · ' + l.status + '</div></div>');
    }
    PB.innerHTML = '<div class="note">聚焦设备的全部真实链路（' + rows.length + ' 条）。点链路行查看证据。切换上方"一跳/两跳"可扩大画布范围。</div><div class="devlist">' + rows.join('') + '</div>';
    PB.querySelectorAll('.devrow').forEach(r => r.onclick = () => { selection = { kind: 'edge', id: +r.dataset.lid }; tab = 'detail'; syncTabs(); applyHighlight(); renderPanel(); });
    return;
  }
  if (selection.kind === 'edge') {
    PB.innerHTML = '<div style="font-size:13px;font-weight:700;margin-bottom:8px">链路详情与 LLDP 证据（可追溯）</div>' + linkCard(linkById.get(selection.id));
    return;
  }
  if (selection.kind === 'ext') {
    const ec = graph && graph.sg.exts.get(selection.id);
    const s = (ec && ec.snap) || {};
    PB.innerHTML = '<div style="font-size:13px;font-weight:700;margin-bottom:8px">未纳管对端（仅 LLDP 快照证据）</div>' +
      '<div class="kv"><span class="k">邻居名</span><span class="v mono">' + (s.sys_name || '?') + '</span>' +
      '<span class="k">端口</span><span class="v mono">' + (s.port_id || '?') + '</span>' +
      '<span class="k">端口描述</span><span class="v mono">' + (s.port_desc || '?') + '</span>' +
      '<span class="k">chassis-id</span><span class="v mono">' + (s.chassis_id || '?') + '</span></div>' +
      '<div class="note">该对端不在 Zabbix 纳管范围，无法读取其接口/状态。链路保留为 half（单端证据），等待网络组核查纳管后自动升级。不猜测其 IP / 型号 / 层级。</div>';
    return;
  }
  const n = byId.get(state.focus);
  const ls = (adj.get(state.focus) || []).slice().sort((x, y) => (x.status === y.status ? 0 : x.status === 'confirmed' ? -1 : 1));
  const nm = ls.filter(l => l.b_node == null && l.a_node === state.focus).length;
  PB.innerHTML = '<div style="font-size:14px;font-weight:700;margin-bottom:4px">' + n.display_name + '</div>' +
    '<div class="kv">' +
    '<span class="k">管理 IP</span><span class="v mono">' + (n.mgmt_ip || '—') + '</span>' +
    '<span class="k">设备类型</span><span class="v">交换机（node_type=switch）</span>' +
    '<span class="k">网络角色</span><span class="v st-warn">未分类（network_role 尚未人工核定，不强行归层）</span>' +
    '<span class="k">厂商</span><span class="v">' + (n.vendor || '?') + '</span>' +
    '<span class="k">监控状态</span><span class="v">' + (n.status === 'degraded' ? '<span class="st-warn">降级（无接口监控项）</span>' : '<span class="st-ok">正常（active）</span>') + '</span>' +
    '<span class="k">接口数</span><span class="v">' + n.iface_count + '</span>' +
    '<span class="k">真实链路</span><span class="v">' + ls.length + ' 条（其中 ' + nm + ' 条对端未纳管）</span>' +
    '</div><div style="font-size:12px;font-weight:700;margin:8px 0 6px">全部链路</div>' + ls.map(linkCard).join('');
}
function syncTabs() { document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.t === tab)); }
document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => { tab = b.dataset.t; syncTabs(); renderPanel(); });

/* ---------- 工具栏 ---------- */
document.getElementById('fitBtn').onclick = fitView;
document.getElementById('relayoutBtn').onclick = () => { localStorage.removeItem('topo.poc.layout.' + state.focus); draw(false).then(fitView); };
document.getElementById('saveBtn').onclick = () => { persistLayout(); const b = document.getElementById('saveBtn'); const t = b.textContent; b.textContent = '已保存'; setTimeout(() => b.textContent = t, 1500); };
document.getElementById('clearPosBtn').onclick = () => { localStorage.removeItem('topo.poc.layout.' + state.focus); draw(false).then(fitView); };
document.getElementById('fullBtn').onclick = () => { const w = document.getElementById('canvasWrap'); if (!document.fullscreenElement) w.requestFullscreen().then(() => setTimeout(fitView, 100)); else document.exitFullscreen(); };
document.getElementById('hopSeg').querySelectorAll('button').forEach(b => b.onclick = () => {
  state.hop = +b.dataset.h;
  document.getElementById('hopSeg').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
  draw().then(fitView);
});
const searchBox = document.getElementById('search'), searchList = document.getElementById('searchList');
searchBox.addEventListener('input', () => {
  const q = searchBox.value.trim().toLowerCase();
  if (!q) { searchList.style.display = 'none'; return; }
  const hits = SNAP.nodes.filter(n => (n.display_name || '').toLowerCase().includes(q) || (n.mgmt_ip || '').includes(q)).slice(0, 15);
  searchList.innerHTML = hits.map(n => '<div class="it" data-nid="' + n.node_id + '"><div>' + n.display_name + '</div><div class="s mono">' + (n.mgmt_ip || '—') + ' · 节点 #' + n.node_id + '</div></div>').join('') || '<div class="it"><div class="s">无匹配</div></div>';
  searchList.style.display = 'block';
  searchList.querySelectorAll('.it[data-nid]').forEach(it => it.onclick = () => {
    state.focus = +it.dataset.nid; selection = { kind: 'node', id: state.focus };
    searchList.style.display = 'none'; searchBox.value = '';
    draw().then(fitView);
  });
});
searchBox.addEventListener('keydown', e => { if (e.key === 'Enter') { const first = searchList.querySelector('.it[data-nid]'); if (first) first.click(); } });
document.addEventListener('click', e => { if (!e.target.closest('.toolbar')) searchList.style.display = 'none'; });
window.addEventListener('resize', () => applyTransform());

/* ---------- 页脚统计 ---------- */
(function foot() {
  const f = document.getElementById('foot');
  const extPeers = new Set(SNAP.links.filter(l => l.b_node == null).map(extKeyOf)).size;
  f.innerHTML = '快照导出：' + new Date(SNAP.exported_at * 1000).toLocaleString('zh-CN', { hour12: false }) +
    ' · 纳管节点 ' + SNAP.stats.nodes + ' · 真实链路 ' + SNAP.stats.links +
    '（已确认 ' + SNAP.stats.confirmed + ' / 单端 half ' + SNAP.stats.half + '）· 未纳管对端 ' + extPeers +
    ' · 无链路设备 ' + (SNAP.stats.nodes - new Set(SNAP.links.flatMap(l => l.b_node != null ? [l.a_node, l.b_node] : [l.a_node])).size) +
    ' · 默认聚焦 #' + DEFAULT_FOCUS + '（证据最充分的汇聚交换机）';
})();

/* ---------- 初始化 ---------- */
document.getElementById('hopSeg').querySelectorAll('button').forEach(x => x.classList.toggle('on', +x.dataset.h === state.hop));
draw().then(fitView);
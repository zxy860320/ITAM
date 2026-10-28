/* TopoCanvas —— 企业网络架构图画布引擎（由 poc/app.js 移植，ELK layered + 正交连线）
 * 命令式 SVG 渲染；React 只负责容器与右侧面板。数据全部来自 topology-svc 真实 LLDP 证据。 */
import ELK from 'elkjs/lib/elk.bundled.js';

export interface TopoNode {
  node_id: number; display_name: string; node_type?: string; vendor?: string | null;
  mgmt_ip?: string | null; status?: string; iface_count?: number;
  chassis_id?: string | null;
}
export interface TopoLink {
  link_id: number; norm_key?: string;
  a: number; a_if?: string | null; a_oper?: number | null; a_name?: string | null;
  b: number | null; b_if?: string | null; b_oper?: number | null; b_name?: string | null;
  b_snapshot?: { sys_name?: string; port_id?: string; port_desc?: string; chassis_id?: string } | null;
  status: string; source?: string; confidence?: number;
  seen_a_at?: number | null; seen_b_at?: number | null;
}
export type TopoSel = { kind: 'node' | 'edge' | 'ext'; id: number | string } | null;
export interface TopoCallbacks {
  onNodeClick?: (nid: number, isFocus: boolean) => void;
  onLinkClick?: (linkId: number) => void;
  onExtClick?: (key: string) => void;
}

const NODE_W = 210, NODE_H = 64;
const SVGNS = 'http://www.w3.org/2000/svg';
const LS_LAYOUT_PREFIX = 'topo.uocp.layout.';

const extKeyOf = (l: TopoLink) => (l.b_snapshot && l.b_snapshot.chassis_id) || ('lk' + l.link_id);
const gidOf = (l: TopoLink, side: 'a' | 'b') =>
  side === 'a' ? 'N' + l.a : (l.b != null ? 'N' + l.b : 'EXT:' + extKeyOf(l));

function el(t: string, a: Record<string, any>) {
  const e = document.createElementNS(SVGNS, t);
  for (const k in a) e.setAttribute(k, a[k]);
  return e;
}
function trunc(s: string | null | undefined, n: number) {
  return s && s.length > n ? s.slice(0, n - 1) + '…' : (s || '');
}

export class TopoCanvas {
  private svg: SVGSVGElement;
  private vp: SVGGElement;
  private cb: TopoCallbacks;
  private nodes: TopoNode[] = [];
  private links: TopoLink[] = [];
  private byId = new Map<number, TopoNode>();
  private linkById = new Map<number, TopoLink>();
  private adj = new Map<number, TopoLink[]>();
  private focus = 0; private hop = 1;
  private selection: TopoSel = null;
  private graph: any = null;
  private view = { x: 0, y: 0, k: 1 };
  private pan: any = null; private drag: any = null;
  private gidToElk = new Map<string, string>();
  private elkToGid = new Map<string, string>();
  private showExt = true;
  private destroyed = false;
  /* 缩略图（minimap）：右下角全景 + 视口框，点选/拖拽跳转 */
  private mmBox: HTMLDivElement | null = null;
  private mmSvg: SVGSVGElement | null = null;
  private mmVp: SVGRectElement | null = null;
  private mmMap: { minX: number; minY: number; k: number; offX: number; offY: number } | null = null;
  private mmDrag = false;

  constructor(svg: SVGSVGElement, cb: TopoCallbacks) {
    this.svg = svg; this.cb = cb;
    this.vp = el('g', { id: 'vp' }) as SVGGElement;
    svg.appendChild(this.vp);
    svg.addEventListener('wheel', this.onWheel as any, { passive: false });
    svg.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('mouseup', this.onMouseUp);
    svg.addEventListener('click', this.onClick);
    this.initMinimap();
  }
  destroy() {
    this.destroyed = true;
    this.svg.removeEventListener('wheel', this.onWheel as any);
    this.svg.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('mouseup', this.onMouseUp);
    this.svg.removeEventListener('click', this.onClick);
    this.vp.remove();
    if (this.mmBox) { this.mmBox.remove(); this.mmBox = null; this.mmSvg = null; this.mmVp = null; }
    window.removeEventListener('mousemove', this.onMinimapMove);
    window.removeEventListener('mouseup', this.onMinimapUp);
  }

  setData(nodes: TopoNode[], links: TopoLink[]) {
    this.nodes = nodes; this.links = links;
    this.byId = new Map(nodes.map(n => [n.node_id, n]));
    this.linkById = new Map(links.map(l => [l.link_id, l]));
    this.adj = new Map();
    for (const l of links) {
      if (l.a != null) { if (!this.adj.has(l.a)) this.adj.set(l.a, []); this.adj.get(l.a)!.push(l); }
      if (l.b != null) { if (!this.adj.has(l.b)) this.adj.set(l.b, []); this.adj.get(l.b)!.push(l); }
    }
  }
  /** 建议默认聚焦：证据链路最多的纳管节点 */
  suggestFocus(): number {
    let best = 0, bestC = -1;
    for (const [nid, ls] of this.adj) if (ls.length > bestC) { bestC = ls.length; best = nid; }
    return best;
  }
  hasNode(nid: number) { return this.byId.has(nid); }
  setSelection(s: TopoSel) { this.selection = s; if (!this.destroyed) this.applyHighlight(); }
  nodeById(nid: number) { return this.byId.get(nid); }
  linkByIdGet(id: number) { return this.linkById.get(id); }
  extSnapshot(key: string) {
    for (const l of this.links) if (l.b == null && extKeyOf(l) === key) return l.b_snapshot;
    return null;
  }
  linksOf(nid: number) { return this.adj.get(nid) || []; }
  unlinkedNodes() {
    const withLink = new Set<number>();
    for (const l of this.links) { withLink.add(l.a); if (l.b != null) withLink.add(l.b); }
    return this.nodes.filter(n => !withLink.has(n.node_id));
  }
  extPeerCount() { return new Set(this.links.filter(l => l.b == null).map(extKeyOf)).size; }

  /* ---------- 子图（两端闭包，绝不引用缺失 shape / 绝不伪造连线）
   * focus===0 为全网总览模式：全部纳管节点 + 全部未纳管对端（EXT 卡）+ 全部真实证据链路。 */
  private computeSubgraph() {
    const full = this.focus === 0;
    const managed = new Set<number>(full ? this.nodes.map(n => n.node_id) : [this.focus]);
    const exts = new Map<string, { key: string; snap: any; attach: Set<number> }>();
    let frontier = full ? [] : [this.focus];
    for (let d = 0; d < (full ? 0 : this.hop); d++) {
      const next: number[] = [];
      for (const nid of frontier) {
        for (const l of (this.adj.get(nid) || [])) {
          const peerN = l.a === nid ? l.b : l.a;
          const peerSnap = l.a === nid ? l.b_snapshot : null;
          if (peerN == null) {
            const k = extKeyOf(l);
            if (!exts.has(k)) exts.set(k, { key: k, snap: peerSnap, attach: new Set([nid]) });
            exts.get(k)!.attach.add(nid);
          } else if (!managed.has(peerN)) { managed.add(peerN); next.push(peerN); }
        }
      }
      frontier = next;
    }
    for (const l of this.links) {
      if (l.b == null && managed.has(l.a)) {
        if (full && !this.showExt) continue; // 全网总览默认不画未纳管对端（369 个会淹没结构）；开关可开
        const k = extKeyOf(l);
        if (!exts.has(k)) exts.set(k, { key: k, snap: l.b_snapshot, attach: new Set([l.a]) });
        exts.get(k)!.attach.add(l.a);
      }
    }
    let links = this.links.filter(l =>
      managed.has(l.a) && (l.b == null ? exts.has(extKeyOf(l)) : managed.has(l.b)));
    if (full && !this.showExt) links = links.filter(l => l.b != null);
    // 全网总览：无任何真实链路的纳管设备不进 ELK（会把图拉成超长条），改在底部网格陈列
    const linked = new Set<number>();
    for (const l of links) { linked.add(l.a); if (l.b != null) linked.add(l.b); }
    const noLink = full ? this.nodes.filter(n => !linked.has(n.node_id)).map(n => n.node_id) : [];
    const sig = this.focus + '|' + this.hop + '|' + (this.showExt ? 'x' : '') + '|' +
      [...managed].sort((a, b) => a - b).join(',') + '|' + [...exts.keys()].sort().join(',') + '|' + links.map(l => l.link_id).join(',');
    return { managed, exts, links, sig, noLink: new Set<number>(noLink) };
  }

  private elkIdOf(gid: string) {
    if (!this.gidToElk.has(gid)) this.gidToElk.set(gid, gid.replace(/:/g, '_'));
    return this.gidToElk.get(gid)!;
  }
  private buildElk(sg: any) {
    this.elkToGid.clear();
    const children: any[] = [];
    for (const nid of sg.managed) {
      if (sg.noLink && sg.noLink.has(nid)) continue; // 全网总览：无连线设备走底部网格，不进 ELK
      const g = 'N' + nid; this.elkToGid.set(this.elkIdOf(g), g);
      children.push({ id: this.elkIdOf(g), width: NODE_W, height: NODE_H, labels: [{ text: this.byId.get(nid)?.display_name || ('#' + nid) }] });
    }
    for (const ec of sg.exts.values()) {
      const nm = (ec.snap && ec.snap.sys_name) || '未命名邻居';
      const g = 'EXT:' + ec.key; this.elkToGid.set(this.elkIdOf(g), g);
      children.push({ id: this.elkIdOf(g), width: NODE_W, height: NODE_H, labels: [{ text: nm + '（未纳管）' }] });
    }
    const edges = sg.links.map((l: TopoLink) => ({
      id: 'E' + l.link_id,
      sources: [this.elkIdOf('N' + l.a)],
      targets: [this.elkIdOf(l.b != null ? 'N' + l.b : 'EXT:' + extKeyOf(l))],
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
        // 全网总览：无连线设备会堆在同一层形成超长单行——MULTILAYER 自动换行成多段
        ...(this.focus === 0 ? {
          'elk.layered.wrapping.strategy': 'MULTILAYER',
          'elk.layered.wrapping.additionalLayerSpacing': '80',
          'elk.layered.wrapping.surroundConnections': 'true',
        } : {}),
      },
      children, edges,
    };
  }
  private sectionsToPts(e: any) {
    const pts: any[] = [];
    if (e.sections && e.sections.length) for (const s of e.sections) { pts.push(s.startPoint); for (const b of (s.bendPoints || [])) pts.push(b); pts.push(s.endPoint); }
    else if (e.startPoint && e.endPoint) pts.push(e.startPoint, e.endPoint);
    return pts.map((p: any) => ({ x: p.x, y: p.y }));
  }

  /* ---------- 位置持久化（localStorage，不写生产库） ---------- */
  private savedLayout(sg: any) {
    try { const s = JSON.parse(localStorage.getItem(LS_LAYOUT_PREFIX + this.focus) || 'null'); if (s && s.sig === sg.sig) return s; } catch (e) {}
    return null;
  }
  saveLayout() {
    if (!this.graph) return;
    const nodes: any = {}, edges: any = {};
    for (const [id, g] of this.graph.nodeGeo) nodes[id] = { x: g.x, y: g.y };
    for (const [id, pts] of this.graph.edgeGeo) edges[id] = pts;
    localStorage.setItem(LS_LAYOUT_PREFIX + this.focus, JSON.stringify({ sig: this.graph.sig, nodes, edges, view: this.view }));
  }
  clearSaved() { localStorage.removeItem(LS_LAYOUT_PREFIX + this.focus); }

  private geoCenter(id: string) { const g = this.graph.nodeGeo.get(id); return { x: g.x + NODE_W / 2, y: g.y + NODE_H / 2 }; }
  private manhattanPts(aId: string, bId: string) {
    const a = this.geoCenter(aId), b = this.geoCenter(bId);
    const down = b.y >= a.y;
    const s = { x: a.x, y: down ? a.y + NODE_H / 2 : a.y - NODE_H / 2 };
    const t = { x: b.x, y: down ? b.y - NODE_H / 2 : b.y + NODE_H / 2 };
    if (Math.abs(s.x - t.x) < 1) return [s, t];
    const midY = (s.y + t.y) / 2;
    return [s, { x: s.x, y: midY }, { x: t.x, y: midY }, t];
  }

  /* ---------- 绘制 ---------- */
  async draw(useSaved = true): Promise<string | null> {
    if (this.destroyed) return null;
    if (this.focus !== 0 && !this.byId.has(this.focus)) return null;
    const sg = this.computeSubgraph();
    this.graph = { sg, nodeGeo: new Map(), edgeGeo: new Map(), sig: sg.sig };
    const saved = useSaved ? this.savedLayout(sg) : null;
    if (saved) {
      for (const id in saved.nodes) this.graph.nodeGeo.set(id, saved.nodes[id]);
      for (const id in saved.edges) this.graph.edgeGeo.set(+id, saved.edges[id]);
      if (saved.view) this.view = saved.view;
    } else {
      let lay: any;
      try { lay = await new (ELK as any)().layout(this.buildElk(sg)); }
      catch (e: any) { console.error('ELK layout failed', e); return 'ELK 布局失败：' + (e.message || e); }
      for (const c of lay.children) this.graph.nodeGeo.set(this.elkToGid.get(c.id) || c.id, { x: c.x, y: c.y });
      for (const e of lay.edges) { const p = this.sectionsToPts(e); if (p.length) this.graph.edgeGeo.set(+e.id.slice(1), p); }
      // 全网总览：无真实链路设备 → 图下方按行网格陈列（有卡片、无连线，绝不伪造）
      if (sg.noLink && sg.noLink.size) {
        const layW = lay.width || 1200;
        const perRow = Math.max(4, Math.min(12, Math.floor(layW / (NODE_W + 42))));
        const baseY = (lay.height || 0) + 140;
        let i = 0;
        for (const nid of sg.noLink) {
          const col = i % perRow, row = Math.floor(i / perRow);
          this.graph.nodeGeo.set('N' + nid, { x: 30 + col * (NODE_W + 42), y: baseY + row * (NODE_H + 36) });
          i++;
        }
        this.graph.gridBaseY = baseY;
      }
    }
    this.redraw();
    return null;
  }
  setView(focus: number, hop: number) { this.focus = focus; this.hop = hop; }
  setShowExt(v: boolean) { this.showExt = v; }

  private iconOf(ext: boolean) {
    const g = el('g', { class: 'tc-icon', transform: 'translate(12,18)' });
    if (ext) {
      g.appendChild(el('rect', { x: 0, y: 0, width: 26, height: 20, rx: 3 }));
      const t = el('text', { x: 13, y: 15, 'text-anchor': 'middle', fill: 'var(--ext, #B388FF)', 'font-size': '12', stroke: 'none' });
      t.textContent = '?'; g.appendChild(t);
    } else {
      g.appendChild(el('rect', { x: 0, y: 1, width: 28, height: 8, rx: 2 }));
      g.appendChild(el('rect', { x: 0, y: 13, width: 28, height: 8, rx: 2 }));
      g.appendChild(el('line', { x1: 6, y1: 9, x2: 6, y2: 13 }));
      g.appendChild(el('line', { x1: 22, y1: 9, x2: 22, y2: 13 }));
    }
    return g;
  }
  private drawNode(id: string) {
    const g = this.graph.nodeGeo.get(id);
    const ext = id.startsWith('EXT:');
    const gg = el('g', { class: 'tc-node' + (ext ? ' ext' : ''), transform: `translate(${g.x},${g.y})` });
    (gg as any).dataset.gid = id;
    gg.appendChild(el('rect', { class: 'card', x: 0, y: 0, width: NODE_W, height: NODE_H, rx: 8 }));
    gg.appendChild(this.iconOf(ext));
    let name: string, ip: string, role: string, dot = '#4CAF50';
    if (ext) {
      const ec = this.graph.sg.exts.get(id.slice(4));
      const s = (ec && ec.snap) || {};
      name = s.sys_name || '未命名邻居'; ip = s.port_id ? ('对端端口 ' + s.port_id) : '对端未纳管';
      role = '未纳管 · 仅 LLDP 快照'; dot = '#B388FF';
    } else {
      const n = this.byId.get(+id.slice(1))!;
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
  private drawEdge(linkId: number) {
    const l = this.linkById.get(linkId)!;
    const pts = this.graph.edgeGeo.get(linkId);
    if (!pts || pts.length < 2) return null;
    const d = 'M' + pts.map((p: any) => p.x + ' ' + p.y).join(' L ');
    const grp: any = el('g', {}); grp.dataset.link = String(linkId);
    const cls = l.status === 'confirmed' || l.status === 'manual' ? 'confirmed' : l.status === 'conflict' ? 'conflict' : 'half';
    grp.appendChild(el('path', { class: 'tc-edge ' + cls, d }));
    grp.appendChild(el('path', { class: 'tc-edge hit', d }));
    const aIf = l.a_if || '?';
    const bIf = l.b_if || (l.b_snapshot && l.b_snapshot.port_id) || '?';
    const s = pts[0], t = pts[pts.length - 1];
    const lbl = (x: number, y: number, txt: string) => { const tt = el('text', { class: 'tc-elbl', x, y }); tt.textContent = txt; return tt; };
    grp.appendChild(lbl(s.x + 4, s.y + (pts[1] && pts[1].y < s.y ? -4 : 11), aIf));
    grp.appendChild(lbl(t.x + 4, t.y + (pts[pts.length - 2] && pts[pts.length - 2].y < t.y ? -4 : 11), bIf));
    return grp;
  }
  private redraw() {
    const eg = el('g', {}), ng = el('g', {});
    for (const lid of this.graph.edgeGeo.keys()) { const e = this.drawEdge(lid); if (e) eg.appendChild(e); }
    for (const id of this.graph.nodeGeo.keys()) ng.appendChild(this.drawNode(id));
    if (this.graph.gridBaseY) {
      const t = el('text', { class: 'tc-gridlabel', x: 30, y: this.graph.gridBaseY - 34 });
      t.textContent = `未关联设备（${this.graph.sg.noLink.size} 台）· 尚无已发现的真实链路 · 不连线、不伪造`;
      eg.appendChild(t);
    }
    this.vp.innerHTML = ''; this.vp.appendChild(eg); this.vp.appendChild(ng);
    this.buildMinimap();
    this.applyTransform(); this.applyHighlight();
  }
  private neighborGidsOf(nid: number) {
    const set = new Set<string>(['N' + nid]);
    for (const l of (this.adj.get(nid) || [])) set.add(gidOf(l, l.a === nid ? 'b' : 'a'));
    return set;
  }
  private applyHighlight() {
    if (!this.graph) return;
    const sel = this.selection;
    this.vp.querySelectorAll('.tc-node').forEach(n => {
      n.classList.remove('sel', 'dim');
      const gid = (n as any).dataset.gid;
      if (sel && sel.kind === 'node') {
        const sgid = 'N' + sel.id;
        if (gid === sgid) n.classList.add('sel');
        else {
          const ec = gid.startsWith('EXT:') ? this.graph.sg.exts.get(gid.slice(4)) : null;
          const attached = ec && ec.attach && ec.attach.has(sel.id as number);
          // 全网总览下以"被选节点"为高亮中心；聚焦模式下仍以聚焦设备为参照
          const center = this.focus === 0 ? (sel.id as number) : this.focus;
          if (!this.neighborGidsOf(center).has(gid) && !attached) n.classList.add('dim');
        }
      } else if (sel && sel.kind === 'edge') {
        const l = this.linkById.get(sel.id as number);
        if (!l) return;
        const keep = new Set<string>(['N' + l.a, gidOf(l, 'b')]);
        if (!keep.has(gid)) n.classList.add('dim');
      } else if (sel && sel.kind === 'ext') {
        const ec = this.graph.sg.exts.get(sel.id as string);
        const keep = new Set<string>(['EXT:' + sel.id]);
        if (ec) for (const nid of ec.attach) keep.add('N' + nid);
        if (!keep.has(gid)) n.classList.add('dim');
      }
    });
    this.vp.querySelectorAll('g[data-link]').forEach(eg => {
      const lid = +(eg as any).dataset.link;
      const vis = eg.querySelector('.tc-edge:not(.hit)') as Element | null;
      if (!vis) return;
      vis.classList.remove('sel'); eg.classList.remove('dim');
      if (sel && sel.kind === 'edge' && lid === sel.id) vis.classList.add('sel');
      else if (sel && sel.kind === 'node') {
        const l = this.linkById.get(lid);
        const touch = l && (l.a === sel.id || l.b === sel.id);
        if (!touch) eg.classList.add('dim');
      }
    });
  }

  /* ---------- 平移缩放 / 拖拽 ---------- */
  private applyTransform() {
    this.vp.setAttribute('transform', `translate(${this.view.x},${this.view.y}) scale(${this.view.k})`);
    // LOD 降级：k<0.55 隐藏次要文字；k<0.3 只留卡片与连线颜色（全网总览远看结构不糊字）
    this.vp.classList.toggle('lod-mid', this.view.k < 0.55);
    this.vp.classList.toggle('lod-far', this.view.k < 0.3);
    this.updateMinimapViewport();
  }

  /* ---------- 缩略图（minimap）：右下角全景 + 视口框；点选/拖拽跳转 ---------- */
  private initMinimap() {
    const parent = this.svg.parentElement;
    if (!parent) return;
    const box = document.createElement('div');
    box.className = 'tc-mm';
    const tip = document.createElement('div');
    tip.className = 'tc-mm-tip'; tip.textContent = '缩略图 · 点击/拖动跳转';
    const msvg = document.createElementNS(SVGNS, 'svg') as SVGSVGElement;
    msvg.setAttribute('width', '220'); msvg.setAttribute('height', '150');
    box.appendChild(tip); box.appendChild(msvg);
    parent.appendChild(box);
    this.mmBox = box; this.mmSvg = msvg;
    msvg.addEventListener('mousedown', this.onMinimapDown);
    window.addEventListener('mousemove', this.onMinimapMove);
    window.addEventListener('mouseup', this.onMinimapUp);
  }
  /** 每次重布局后重建缩略图内容（小矩形=节点，细线=链路） */
  private buildMinimap() {
    if (!this.mmSvg || !this.graph) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const g of this.graph.nodeGeo.values()) {
      minX = Math.min(minX, g.x); minY = Math.min(minY, g.y);
      maxX = Math.max(maxX, g.x + NODE_W); maxY = Math.max(maxY, g.y + NODE_H);
    }
    if (!isFinite(minX)) { this.mmSvg.innerHTML = ''; this.mmMap = null; return; }
    const W = 220, H = 150, pad = 8;
    const gw = maxX - minX, gh = maxY - minY;
    const k = Math.min((W - pad * 2) / gw, (H - pad * 2) / gh);
    const offX = (W - gw * k) / 2, offY = (H - gh * k) / 2;
    this.mmMap = { minX, minY, k, offX, offY };
    const g = el('g', {});
    for (const pts of this.graph.edgeGeo.values()) {
      if (!pts || pts.length < 2 || pts.some((p: any) => !isFinite(p.x) || !isFinite(p.y))) continue;
      const d = 'M' + pts.map((p: any) => (offX + (p.x - minX) * k) + ' ' + (offY + (p.y - minY) * k)).join(' L ');
      g.appendChild(el('path', { class: 'tc-mm-edge', d }));
    }
    for (const n of this.graph.nodeGeo.values()) {
      g.appendChild(el('rect', {
        class: 'tc-mm-node',
        x: offX + (n.x - minX) * k, y: offY + (n.y - minY) * k,
        width: Math.max(1.5, NODE_W * k), height: Math.max(1, NODE_H * k),
      }));
    }
    const r = el('rect', { class: 'tc-mm-vp', x: 0, y: 0, width: 0, height: 0, rx: 2 });
    g.appendChild(r);
    this.mmSvg.innerHTML = ''; this.mmSvg.appendChild(g);
    this.mmVp = r as unknown as SVGRectElement;
    // 小图（聚焦模式或节点很少）不必配缩略图
    if (this.mmBox) this.mmBox.classList.toggle('off', this.focus !== 0 || this.graph.nodeGeo.size < 25);
    this.updateMinimapViewport();
  }
  /** 视口框 = 当前 svg 可见区域换算到缩略图坐标 */
  private updateMinimapViewport() {
    if (!this.mmVp || !this.mmMap) return;
    const { minX, minY, k, offX, offY } = this.mmMap;
    const w = this.svg.clientWidth, h = this.svg.clientHeight;
    // 主画布可见 world 坐标：sx = (X - view.x)/view.k
    const x0 = (0 - this.view.x) / this.view.k, y0 = (0 - this.view.y) / this.view.k;
    const x1 = (w - this.view.x) / this.view.k, y1 = (h - this.view.y) / this.view.k;
    this.mmVp.setAttribute('x', String(offX + (x0 - minX) * k));
    this.mmVp.setAttribute('y', String(offY + (y0 - minY) * k));
    this.mmVp.setAttribute('width', String(Math.max(2, (x1 - x0) * k)));
    this.mmVp.setAttribute('height', String(Math.max(2, (y1 - y0) * k)));
  }
  /** 缩略图坐标 → 把该点设为主画布中心 */
  private jumpFromMinimap(e: MouseEvent) {
    if (!this.mmSvg || !this.mmMap) return;
    const r = this.mmSvg.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const wx = this.mmMap.minX + (mx - this.mmMap.offX) / this.mmMap.k;
    const wy = this.mmMap.minY + (my - this.mmMap.offY) / this.mmMap.k;
    this.view.x = this.svg.clientWidth / 2 - wx * this.view.k;
    this.view.y = this.svg.clientHeight / 2 - wy * this.view.k;
    this.applyTransform();
  }
  private onMinimapDown = (e: MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    this.mmDrag = true;
    this.jumpFromMinimap(e);
  };
  private onMinimapMove = (e: MouseEvent) => { if (this.mmDrag) this.jumpFromMinimap(e); };
  private onMinimapUp = () => { this.mmDrag = false; };
  /** 适应画布；minK>0 时为可读下限——fit 缩放不足则改为以聚焦节点居中（其余平移查看） */
  fitView(minK = 0) {
    const bb = this.vp.getBBox(); const w = this.svg.clientWidth, h = this.svg.clientHeight;
    if (!bb.width || !bb.height) return;
    const k = Math.min((w - 60) / bb.width, (h - 80) / bb.height, 1.2);
    if (k >= minK) {
      this.view.k = k; this.view.x = (w - bb.width * k) / 2 - bb.x * k; this.view.y = (h - bb.height * k) / 2 - bb.y * k;
    } else {
      const kc = Math.min(minK, 1.2);
      this.view.k = kc;
      const fg = this.graph && this.graph.nodeGeo.get('N' + this.focus);
      const cx = fg ? fg.x + NODE_W / 2 : bb.x + bb.width / 2;
      const cy = fg ? fg.y + NODE_H / 2 : bb.y + bb.height / 2;
      this.view.x = w / 2 - cx * kc; this.view.y = h / 2 - cy * kc;
    }
    this.applyTransform();
  }
  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const r = this.svg.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const f = e.deltaY < 0 ? 1.12 : 0.89;
    const k2 = Math.max(0.15, Math.min(2.5, this.view.k * f));
    this.view.x = mx - (mx - this.view.x) * (k2 / this.view.k);
    this.view.y = my - (my - this.view.y) * (k2 / this.view.k);
    this.view.k = k2;
    this.applyTransform();
  };
  private svgPoint(e: MouseEvent) {
    const r = this.svg.getBoundingClientRect();
    return { x: (e.clientX - r.left - this.view.x) / this.view.k, y: (e.clientY - r.top - this.view.y) / this.view.k };
  }
  private onMouseDown = (e: MouseEvent) => {
    const nEl = (e.target as Element).closest && (e.target as Element).closest('.tc-node');
    if (nEl) {
      const p = this.svgPoint(e);
      const gid = (nEl as any).dataset.gid;
      const g = this.graph && this.graph.nodeGeo.get(gid);
      if (g) { this.drag = { gid, dx: p.x - g.x, dy: p.y - g.y, moved: false }; return; }
    }
    this.pan = { x: e.clientX - this.view.x, y: e.clientY - this.view.y };
    this.svg.classList.add('panning');
  };
  private onMouseMove = (e: MouseEvent) => {
    if (this.drag) {
      const p = this.svgPoint(e); this.drag.moved = true;
      const g = this.graph.nodeGeo.get(this.drag.gid);
      g.x = p.x - this.drag.dx; g.y = p.y - this.drag.dy;
      for (const l of this.graph.sg.links) {
        const a = 'N' + l.a, b = gidOf(l, 'b');
        if (a === this.drag.gid || b === this.drag.gid) this.graph.edgeGeo.set(l.link_id, this.manhattanPts(a, b));
      }
      this.redraw();
    } else if (this.pan) {
      this.view.x = e.clientX - this.pan.x; this.view.y = e.clientY - this.pan.y;
      this.applyTransform();
    }
  };
  private onMouseUp = () => {
    if (this.drag) {
      if (!this.drag.moved) {
        const gid = this.drag.gid;
        if (gid.startsWith('EXT:')) {
          this.selection = { kind: 'ext', id: gid.slice(4) };
          this.applyHighlight();
          this.cb.onExtClick && this.cb.onExtClick(gid.slice(4));
        } else {
          const nid = +gid.slice(1);
          const isFocus = nid === this.focus;
          this.selection = { kind: 'node', id: nid };
          this.applyHighlight();
          this.cb.onNodeClick && this.cb.onNodeClick(nid, isFocus);
        }
      }
      this.drag = null;
    }
    this.pan = null; this.svg.classList.remove('panning');
  };
  private onClick = (e: MouseEvent) => {
    const eg = (e.target as Element).closest && (e.target as Element).closest('g[data-link]');
    if (eg) {
      const lid = +(eg as any).dataset.link;
      this.selection = { kind: 'edge', id: lid };
      this.applyHighlight();
      this.cb.onLinkClick && this.cb.onLinkClick(lid);
    }
  };
}


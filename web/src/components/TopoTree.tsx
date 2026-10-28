/* TopoTree —— 架构钻取画布（全览页专用）
 * 初始只显示"核心"层；点设备卡片向下展开它的真实 LLDP 邻居（汇聚），再点汇聚展开接入……
 * 层级 = 从核心根出发沿真实链路的最短跳数（显示层推断）；绝不伪造连线、不写库，
 * network_role 仍属台账核定范畴，本视图不落库。
 *
 * 真实连线三原则（用户核定 2026-10）：
 *  ① 只画两端均有真实 LLDP 证据的链路——含 half 快照按 chassis_id 升格：
 *     快照 chassis_id 与某纳管节点一致 = 该半链路真实对端就是这台纳管设备（强证据，样式仍按 half）；
 *  ② 快照对端未纳管 → 生成 EXT 虚拟卡片（按 chassis_id 去重，紫色虚线，仅由真实快照证据连线）；
 *  ③ 不人为把设备钉进统一层带——每台/每对（聚合对）都跟随其真实对端的跳数定位；
 *     互联网接入区（INET/互联网 语义）EXT 例外钉到其最浅真实邻居的上一层（上联语义）。 */
import { TopoNode, TopoLink } from './TopoCanvas';

const NODE_W = 210, NODE_H = 64;
const BAND_H = NODE_H + 140;   // 层间垂直间距
const COL_GAP = 44;            // 同层水平间距
const SVGNS = 'http://www.w3.org/2000/svg';

function el(t: string, a: Record<string, any>) {
  const e = document.createElementNS(SVGNS, t);
  for (const k in a) e.setAttribute(k, a[k]);
  return e;
}
function trunc(s: string | null | undefined, n: number) {
  return s && s.length > n ? s.slice(0, n - 1) + '…' : (s || '');
}
export const isCoreName = (n: TopoNode) => /核心|core/i.test(n.display_name || '');
export const isAggName = (n: TopoNode) => /汇聚|HJ[-_.]|S5590/i.test(n.display_name || '');
// 防火墙/上游设备命名证据（FW6625F、FW6585F、防火墙…；CSW/核心名不含 FW 不会误配）
export const isFwName = (n: TopoNode) => /FW\d|FW-|-FW|防火墙|firewall/i.test(n.display_name || '');
// 互联网接入区语义（EXT 钉层用）：INET_Line 等"互联网/接入区/出口"快照
const isInternetSnap = (s: string) => /INET|互联网|接入区|出口|internet/i.test(s || '');
// 已纳管节点的互联网接入区语义：命名含"互联网/接入区"；排除 FW 命名（INET-FW 属防火墙层，不是接入交换机）
const isInternetMgmt = (n: TopoNode) => !isFwName(n) && /互联网|接入区|internet/i.test(n.display_name || '');

export interface TreeCallbacks {
  onNodeClick?: (nid: number) => void;
  onToggle?: (nid: number, expanded: boolean) => void;
}

export class TopoTree {
  private svg: SVGSVGElement;
  private vp: SVGGElement;
  private cb: TreeCallbacks;
  private nodes: TopoNode[] = [];
  private byId = new Map<number, TopoNode>();
  private adj = new Map<number, { nid: number; link: TopoLink }[]>();
  private roots: number[] = [];
  private rootOverrideIps: string[] = [];   // 用户核定核心（管理IP，localStorage 显示层配置，不落库）
  private rootIds = new Set<number>();      // 本轮生效的核心根（含核定标记判断）
  private peerIpPairs: [string, string][] = []; // 用户核定同层聚合对（管理IP对，localStorage 显示层配置，不落库）
  private peerPairs: [number, number][] = [];   // 核定对 + FW 主从证据对（最终生效）
  private expanded = new Set<number>();
  private pos = new Map<number, { x: number; y: number; depth: number }>();
  private edges: { l: TopoLink; a: number; b: number; upgraded?: boolean }[] = [];
  private extByNid = new Map<number, { key: string; snap: any }>();  // EXT 伪节点 → 快照（display_name 即快照 sys_name）
  private view = { x: 0, y: 0, k: 1 };
  private pan: any = null; private dragNode: any = null; private pressed: any = null;
  private depthNow = new Map<number, number>();
  private destroyed = false;

  constructor(svg: SVGSVGElement, cb: TreeCallbacks) {
    this.svg = svg; this.cb = cb;
    this.vp = el('g', { id: 'tvp' }) as SVGGElement;
    svg.appendChild(this.vp);
    svg.addEventListener('wheel', this.onWheel as any, { passive: false });
    svg.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('mouseup', this.onMouseUp);
  }
  destroy() {
    this.destroyed = true;
    this.svg.removeEventListener('wheel', this.onWheel as any);
    this.svg.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('mouseup', this.onMouseUp);
    this.vp.remove();
  }

  /** EXT 伪节点（未纳管对端）以负数 node_id 表示 */
  isExt(nid: number) { return nid < 0; }

  setData(nodes: TopoNode[], links: TopoLink[]) {
    this.nodes = nodes;
    this.byId = new Map(nodes.map(n => [n.node_id, n]));
    this.adj = new Map();
    this.edges = [];
    this.extByNid = new Map();
    const MGMT_IF = /^(MEth|M-Eth|Vlanif|Vlan-interface|Bdi|BVI|Loopback|Null|Aux)/i;
    // chassis_id → 纳管节点（half 快照升格用：LLDP chassis 唯一标识设备，快照 chassis 与纳管一致=真实对端在册）
    const chassisToNode = new Map<string, number>();
    for (const n of nodes) if (n.chassis_id) chassisToNode.set(String(n.chassis_id).toLowerCase(), n.node_id);
    // 未纳管快照对端 → EXT 伪节点（按 chassis_id 去重；无 chassis 按快照哈希退化到 link 粒度）
    let extSeq = 0;
    const extCache = new Map<string, number>();
    const extNodeOf = (key: string, snap: any): number => {
      if (extCache.has(key)) return extCache.get(key)!;
      const nid = -(++extSeq);
      extCache.set(key, nid);
      this.extByNid.set(nid, { key, snap });
      this.byId.set(nid, { node_id: nid, display_name: snap.sys_name || ('未纳管 ' + key), node_type: 'ext', mgmt_ip: null, vendor: null });
      return nid;
    };
    const cands: { l: TopoLink; a: number; b: number; upgraded: boolean }[] = [];
    for (const l of links) {
      if (l.a == null || !this.byId.has(l.a)) continue;
      if (l.a === l.b) continue;
      if (MGMT_IF.test(l.a_if || '')) continue; // 管理口/VLANIF 端点=三层发现证据，不是物理跳线
      if (l.b != null && l.b !== l.a && this.byId.has(l.b)) {
        if (MGMT_IF.test(l.b_if || '')) continue;
        cands.push({ l, a: l.a, b: l.b, upgraded: false });
        continue;
      }
      // 单端半链路 → 按快照定位真实对端
      const s = l.b_snapshot;
      if (!s || !s.chassis_id) continue; // 无快照证据的孤立半链路：不画（不伪造）
      if (MGMT_IF.test(s.port_id || '')) continue; // 对端管理口发现，不是物理跳线
      // 名称尾号防呆：快照名与纳管名尾号编号冲突（SW1 vs SW2）→ 不升格，宁可显示为未纳管也不连错
      const tailConflict = (snapName: string, dispName: string) => {
        const sn = /(SW|CSW|DSW|ASW)[-_ ]?(\d+)\s*$/i.exec(snapName || '');
        const dn = /(SW|CSW|DSW|ASW)[-_ ]?(\d+)\s*$/i.exec(dispName || '');
        if (sn && dn) return +sn[2] !== +dn[2];
        const sm = /-(\d+(?:\.\d+)?)\s*$/.exec(snapName || '');
        const dm = /-(\d+(?:\.\d+)?)\s*$/.exec(dispName || '');
        if (sm && dm) return sm[1] !== dm[1];
        return false;
      };
      const cid = String(s.chassis_id).toLowerCase();
      const match = chassisToNode.get(cid);
      if (match != null && match !== l.a && !tailConflict(s.sys_name || '', (this.byId.get(match) || {}).display_name || '')) {
        cands.push({ l, a: l.a, b: match, upgraded: true }); // 真实对端在册：升格连线（样式仍 half）
      } else {
        const b = extNodeOf('c' + cid, s); // 未纳管对端 → EXT 虚拟卡片（真实快照证据）
        if (b !== l.a) cands.push({ l, a: l.a, b, upgraded: false });
      }
    }
    // 端口仲裁：一个物理端口只接一台设备。同端口多邻居 = LLDP 误配，只留最强证据：
    //   双端确认(manual/confirmed) > conflict > half；同级取最近可见。
    const score = (l: TopoLink) => (l.status === 'confirmed' || l.status === 'manual') ? 3 : l.status === 'conflict' ? 2 : 1;
    const rec = (l: TopoLink) => Math.max(l.seen_a_at || 0, l.seen_b_at || 0);
    const sorted = [...cands].sort((x, y) => score(y.l) - score(x.l) || rec(y.l) - rec(x.l) || x.l.link_id - y.l.link_id);
    const usedPort = new Set<string>();
    for (const e of sorted) {
      const bIf = e.upgraded ? (e.l.b_snapshot && e.l.b_snapshot.port_id) : e.l.b_if;
      const ka = e.a + '|' + (e.l.a_if || ('#' + e.l.link_id + 'a'));
      const kb = e.b + '|' + (bIf || ('#' + e.l.link_id + 'b'));
      if (usedPort.has(ka) || usedPort.has(kb)) continue; // 该端口已被更强证据占用——此线不画
      usedPort.add(ka); usedPort.add(kb);
      if (!this.adj.has(e.a)) this.adj.set(e.a, []);
      if (!this.adj.has(e.b)) this.adj.set(e.b, []);
      this.adj.get(e.a)!.push({ nid: e.b, link: e.l });
      this.adj.get(e.b)!.push({ nid: e.a, link: e.l });
      this.edges.push(e);
    }
    this.rebuildPeerPairs();
    this.computeRoots();
  }

  /** 用户核定核心根（管理IP列表）：所在分量以此为顶，其余分量仍走命名/度数启发。仅显示层配置，不落库。 */
  setRootOverride(ips: string[]) {
    this.rootOverrideIps = ips.map(s => s.trim()).filter(Boolean);
    this.computeRoots();
  }
  /** 用户核定同层聚合对（如 M-LAG/堆叠双核心）：两台强制同层，互联线按同层互联样式。仅显示层配置，不落库。 */
  setPeerPairs(pairs: [string, string][]) {
    this.peerIpPairs = pairs;
    this.rebuildPeerPairs();
  }
  /** 聚合对 = 用户核定对 + 证据自动识别的防火墙主从对（两端 FW 命名证据 + 双端确认互联线，真实 LLDP 证据非伪造）。 */
  private rebuildPeerPairs() {
    const m = new Map<string, [number, number]>();
    const put = (x: number, y: number) => m.set(Math.min(x, y) + '|' + Math.max(x, y), [x, y]);
    for (const [x, y] of this.peerIpPairs) {
      const xi = (this.nodes.find(n => n.mgmt_ip === x.trim()) || {}).node_id;
      const yi = (this.nodes.find(n => n.mgmt_ip === y.trim()) || {}).node_id;
      if (xi !== undefined && yi !== undefined) put(xi, yi);
    }
    for (const e of this.edges) {
      if ((e.l.status === 'confirmed' || e.l.status === 'manual')
        && isFwName(this.byId.get(e.a)!) && isFwName(this.byId.get(e.b)!)) put(e.a, e.b);
    }
    this.peerPairs = [...m.values()];
  }
  isPeerEdge(a: number, b: number) {
    return this.peerPairs.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
  }
  peerOf(nid: number): number | null {
    for (const [x, y] of this.peerPairs) if (x === nid) return y; else if (y === nid) return x;
    return null;
  }
  isRootId(nid: number) { return this.rootIds.has(nid); }

  /** 核心根：用户核定IP优先；命名证据（核心/CORE）次之；无命名证据的连通分量取度数最高节点（证据启发，仅显示层）。
   *  EXT 伪节点（node_id<0）不参与根选择。 */
  private computeRoots() {
    this.roots = [];
    this.rootIds = new Set(
      this.rootOverrideIps
        .map(ip => (this.nodes.find(n => n.mgmt_ip === ip) || {}).node_id)
        .filter(x => x !== undefined) as number[]
    );
    const seen = new Set<number>();
    for (const n of this.nodes) {
      if (seen.has(n.node_id) || !this.adj.has(n.node_id)) continue;
      const comp: number[] = []; const st = [n.node_id]; seen.add(n.node_id);
      while (st.length) {
        const x = st.pop()!; comp.push(x);
        for (const nb of (this.adj.get(x) || [])) if (!seen.has(nb.nid)) { seen.add(nb.nid); st.push(nb.nid); }
      }
      const mgmt = comp.filter(id => id > 0); // EXT 不选根
      const ov = mgmt.filter(id => this.rootIds.has(id));
      if (ov.length) this.roots.push(...ov); // 用户核定核心 → 该分量顶层
      else if (mgmt.length) {
        const cores = mgmt.filter(id => isCoreName(this.byId.get(id)!));
        if (cores.length) this.roots.push(...cores);
        else {
          let best = mgmt[0], bd = -1;
          for (const id of mgmt) { const d = (this.adj.get(id) || []).length; if (d > bd) { bd = d; best = id; } }
          this.roots.push(best);
        }
      }
    }
  }

  /** 可见集 + 分层（用户核定层级 2026-10-26）：
   *  自上而下：互联网接入区交换机（EXT 快照 + 已纳管同类实卡）→ 防火墙 → 核心交换机(0层) → 办公网/数据中心核心及其下联。
   *  ① 沿真实链路向下 BFS，层级=跳数；聚合/主从对钉合同深度；
   *  ② FW 命名节点不参与 BFS——钉到其最浅可见邻居的上一层且恒在核心上方（防火墙是核心的上联，非下联）；
   *  ③ 互联网接入区（EXT 快照卡 + 命名含"互联网/接入区"的已纳管实卡）最后钉：恒在全部可见设备之上（最顶层）；
   *  ④ 折叠即隐藏其下游；邻居全部不可见的 FW/EXT/接入区实卡同样隐藏——不产生孤立卡片、不伪造。 */
  private computeVisible() {
    const depth = new Map<number, number>();
    // 互联网接入区置顶集合：未纳管 EXT 快照 + 已纳管实卡（用户：10.25.1.11/1.12 纳管后仍须最上层）
    const internetTop = new Set<number>();
    for (const nid of this.extByNid.keys()) if (isInternetSnap(this.byId.get(nid)!.display_name)) internetTop.add(nid);
    for (const nid of this.byId.keys()) if (nid > 0 && isInternetMgmt(this.byId.get(nid)!)) internetTop.add(nid);
    const fwSet = new Set<number>();
    for (const nid of this.byId.keys()) if (nid > 0 && isFwName(this.byId.get(nid)!)) fwSet.add(nid);
    const add = (nid: number, d: number, queue: number[]) => {
      if (depth.has(nid)) return;
      depth.set(nid, d); queue.push(nid);
      const p = this.peerOf(nid);
      if (p != null && !depth.has(p)) { depth.set(p, d); queue.push(p); }
    };
    for (const r of this.roots) add(r, 0, []);
    const q = [...this.roots];
    while (q.length) {
      const u = q.shift()!;
      if (!this.expanded.has(u)) continue;
      for (const nb of (this.adj.get(u) || [])) {
        // FW 与互联网区（EXT + 实卡）都不参与 BFS 排层——各自按上联语义事后钉层，防止被拉进核心下方
        if (depth.has(nb.nid) || internetTop.has(nb.nid) || fwSet.has(nb.nid)) continue;
        add(nb.nid, depth.get(u)! + 1, q);
      }
    }
    // ② 防火墙钉层：最浅可见邻居上一层，且恒在核心(0)之上；主从对钉合同层
    const pin = (nid: number, d: number, queue: number[]) => {
      if (depth.has(nid)) return;
      depth.set(nid, d);
      const p = this.peerOf(nid);
      if (p != null) { if (!depth.has(p)) { depth.set(p, d); } queue.push(p); }
      queue.push(nid);
    };
    for (const nid of fwSet) {
      let md = Infinity;
      for (const nb of (this.adj.get(nid) || [])) { const d = depth.get(nb.nid); if (d !== undefined) md = Math.min(md, d); }
      if (md === Infinity) continue; // 邻居全部折叠 → 隐藏（无孤立卡片）
      pin(nid, Math.min(md - 1, -1), q);
    }
    // FW 展开后其真实下联继续向下 BFS（对尚未定层的邻居）
    while (q.length) {
      const u = q.shift()!;
      if (!this.expanded.has(u)) continue;
      for (const nb of (this.adj.get(u) || [])) {
        if (depth.has(nb.nid) || internetTop.has(nb.nid) || fwSet.has(nb.nid)) continue;
        add(nb.nid, depth.get(u)! + 1, q);
      }
    }
    // ③ 互联网接入区最后钉：恒在全部可见设备之上（用户："这两台是最上层交换机"，纳管后仍是）。
    //    整组钉同深度：md 只参考非接入区邻居——防止 1014↔1020 互联链把彼此再拉上一层。
    let minDev = Infinity;
    for (const [nid, d] of depth) if (!internetTop.has(nid)) minDev = Math.min(minDev, d);
    let globalMd = Infinity;
    for (const nid of internetTop)
      for (const nb of (this.adj.get(nid) || []))
        if (!internetTop.has(nb.nid)) { const d = depth.get(nb.nid); if (d !== undefined) globalMd = Math.min(globalMd, d); }
    const inetDepth = Math.min(globalMd - 1, minDev - 1, -1);
    for (const nid of internetTop) {
      let visibleNb = false;
      for (const nb of (this.adj.get(nid) || [])) if (depth.has(nb.nid) && !internetTop.has(nb.nid)) visibleNb = true;
      if (!visibleNb) continue; // 邻居全部折叠 → 隐藏
      if (!depth.has(nid)) pin(nid, inetDepth, q);
      if (this.expanded.has(nid)) { // 已展开：其真实下联（未在 FW/置顶语义层的）继续向下 BFS
        const q2 = [nid];
        while (q2.length) {
          const u = q2.shift()!;
          if (!this.expanded.has(u)) continue;
          for (const nb of (this.adj.get(u) || [])) {
            if (depth.has(nb.nid) || internetTop.has(nb.nid) || fwSet.has(nb.nid)) continue;
            add(nb.nid, depth.get(u)! + 1, q2);
          }
        }
      }
    }
    return depth;
  }

  isExpanded(nid: number) { return this.expanded.has(nid); }
  toggle(nid: number) {
    if (this.expanded.has(nid)) {
      this.expanded.delete(nid);
    } else {
      // 同层互斥（手风琴）：点开一台设备时，收起同层其它已展开的设备
      const d = this.depthNow.get(nid);
      if (d !== undefined) {
        for (const x of [...this.expanded]) {
          if (x !== nid && this.depthNow.get(x) === d) this.expanded.delete(x);
        }
      }
      this.expanded.add(nid);
    }
    // 清理因上游收起而不再可见的展开态，避免重新展开父级时下游突然全开
    const vis = this.computeVisible();
    for (const x of [...this.expanded]) if (!vis.has(x)) this.expanded.delete(x);
    this.cb.onToggle && this.cb.onToggle(nid, this.expanded.has(nid));
    this.draw();
  }
  expandAll() {
    for (let i = 0; i < 24; i++) {
      const d = this.computeVisible();
      const before = this.expanded.size;
      for (const nid of d.keys()) if (nid > 0 || this.isExt(nid)) this.expanded.add(nid);
      if (this.expanded.size === before) break;
    }
    this.draw();
  }
  collapseAll() { this.expanded.clear(); this.draw(); }
  /** 展开全部核心根（默认进入时：核心层可见且已展开一层 → 看到核心+直接邻居） */
  expandCores() { for (const r of this.roots) this.expanded.add(r); this.draw(); }
  getRoots() { return [...this.roots]; }
  nodeDisplayName(nid: number) { return this.byId.get(nid)?.display_name || ('#' + nid); }

  private hiddenChildren(nid: number, depth: Map<number, number>) {
    let c = 0;
    for (const nb of (this.adj.get(nid) || [])) if (!depth.has(nb.nid)) c++;
    return c;
  }

  layout() {
    const depth = this.computeVisible();
    this.depthNow = depth;
    this.pos.clear();
    const byDepth = new Map<number, number[]>();
    for (const [nid, d] of depth) { if (!byDepth.has(d)) byDepth.set(d, []); byDepth.get(d)!.push(nid); }
    const minD = Math.min(...[...depth.values()], 0), maxD = Math.max(...[...depth.values()], 0);
    const place = (d: number) => {
      const pd = d <= 0 ? d + 1 : d - 1; // 上游层(d<0)锚定下方(d+1)，下游层锚定上方(d-1)
      // 相邻层锚点均值；聚合对两台取"两台父锚合并均值"→ 排在一起、并排居中
      const anchors = (x: number): number[] => {
        let xs = (this.adj.get(x) || []).filter(nb => depth.get(nb.nid) === pd && this.pos.has(nb.nid))
          .map(nb => this.pos.get(nb.nid)!.x + NODE_W / 2);
        const p = this.peerOf(x);
        if (p != null && depth.get(p) === d && this.pos.has(p)) {
          xs = xs.concat((this.adj.get(p) || []).filter(nb => depth.get(nb.nid) === pd && this.pos.has(nb.nid))
            .map(nb => this.pos.get(nb.nid)!.x + NODE_W / 2));
        }
        return xs;
      };
      const key = (x: number) => { const xs = anchors(x); return xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : Number.MAX_SAFE_INTEGER; };
      const arr = (byDepth.get(d) || []).sort((a, b) => {
        if (d === 0) {
          const ca = isCoreName(this.byId.get(a)!), cb2 = isCoreName(this.byId.get(b)!);
          if (ca !== cb2) return ca ? -1 : 1;
          return (this.adj.get(b) || []).length - (this.adj.get(a) || []).length || a - b;
        }
        const ka = key(a), kb = key(b);
        return ka !== kb ? ka - kb : a - b;
      });
      const ordered: number[] = [];
      const placed = new Set<number>();
      for (const nid of arr) {
        if (placed.has(nid)) continue;
        ordered.push(nid); placed.add(nid);
        const p = this.peerOf(nid); // 聚合对强制相邻排布，互联线不穿过中间卡片
        if (p != null && arr.indexOf(p) >= 0 && !placed.has(p)) { ordered.push(p); placed.add(p); }
      }
      let prevRight = -NODE_W - COL_GAP; // 首个节点 ideal=0 起排，避免 -Infinity
      for (const nid of ordered) {
        const pars = anchors(nid);
        const ideal = pars.length ? pars.reduce((s, v) => s + v, 0) / pars.length - NODE_W / 2 : prevRight + COL_GAP;
        const x = Math.max(ideal, prevRight + COL_GAP);
        this.pos.set(nid, { x, y: d * BAND_H, depth: d });
        prevRight = x + NODE_W;
      }
      // —— 整层重居中：同层作为整体居中到其相邻层锚点均值正下/上方（核心层居中于 x=0）
      let anchorSum = 0, anchorCnt = 0;
      if (d === 0) { anchorSum = 0; anchorCnt = 1; }
      else {
        for (const nid of arr) {
          const pars = anchors(nid);
          if (pars.length) { anchorSum += pars.reduce((s, v) => s + v, 0) / pars.length; anchorCnt++; }
        }
      }
      if (anchorCnt) {
        let minX = Infinity, maxX = -Infinity;
        for (const nid of arr) { const p = this.pos.get(nid)!; minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x + NODE_W); }
        const shift = anchorSum / anchorCnt - (minX + maxX) / 2;
        if (isFinite(shift)) for (const nid of arr) { const p = this.pos.get(nid)!; p.x += shift; }
      }
    };
    for (let d = 0; d <= maxD; d++) place(d);
    for (let d = -1; d >= minD; d--) place(d);
    return depth;
  }

  draw() {
    if (this.destroyed) return;
    const depth = this.layout();
    const eg = el('g', {}), ng = el('g', {});
    const minD = Math.min(...[...depth.values()], 0), maxD = Math.max(...[...depth.values()], 0);
    for (let d = minD; d <= maxD; d++) {
      const ids = [...depth.keys()].filter(nid => depth.get(nid) === d);
      const cnt = ids.length;
      const hasExt = ids.some(nid => nid < 0);
      const hasInetMgmt = ids.some(nid => nid > 0 && isInternetMgmt(this.byId.get(nid)!));
      const hasFw = ids.some(nid => nid > 0 && isFwName(this.byId.get(nid)!));
      const lbl = d === 0 ? (this.rootOverrideIps.length ? '核心层（用户核定）' : '核心层（命名/度数证据）')
        : d < 0 ? (hasInetMgmt ? '最上层 · 互联网接入区（已纳管 · 真实 LLDP 证据）'
            : hasExt ? '最上层 · 互联网接入区（未纳管 · LLDP 快照证据）'
            : hasFw ? '防火墙层（核心的上联 · 真实 LLDP 证据）'
            : `上联 ${-d} 跳 · 沿真实 LLDP 链路`)
        : `向下 ${d} 跳 · 沿真实 LLDP 链路（层级为跳数推断）`;
      const [bx0, bx1] = this.bandExtent(d);
      const t = el('text', { class: 'tc-band', x: bx0, y: d * BAND_H - 18 });
      t.textContent = `${lbl} · 本层 ${cnt} 台`;
      eg.appendChild(t);
      eg.appendChild(el('line', { class: 'tc-bandline', x1: bx0, y1: d * BAND_H - 34, x2: bx1, y2: d * BAND_H - 34 }));
    }
    const drawnPeer = new Set<string>();
    this.drawnEdges = new Map();
    for (const { l, a, b, upgraded } of this.edges) {
      if (!depth.has(a) || !depth.has(b)) continue; // 两端均可见才画——绝不伪造
      const peer = this.isPeerEdge(a, b); // 核定聚合对/主从对：同层水平互联线
      if (peer) {
        const pk = Math.min(a, b) + '|' + Math.max(a, b);
        if (drawnPeer.has(pk)) continue; // 同对多条互联（含仲裁前冗余）只画一条样式线
        drawnPeer.add(pk);
      }
      const pts = peer ? this.sidebar(a, b) : this.diagonal(a, b);
      const dPath = 'M' + pts.map(p => p.x + ' ' + p.y).join(' L ');
      const grp: any = el('g', { 'data-led': String(l.link_id) });
      const cls = peer ? 'peer' : l.status === 'confirmed' || l.status === 'manual' ? 'confirmed' : l.status === 'conflict' ? 'conflict' : 'half';
      grp.appendChild(el('path', { class: 'tc-edgehit', d: dPath })); // 透明宽命中区：连线可点
      grp.appendChild(el('path', { class: 'tc-edge ' + cls, d: dPath }));
      // 对端端口：双端在册取 b_if；EXT/升格端来自快照 port_id
      const bIf = (l.b != null && l.b_if) ? l.b_if : (l.b_snapshot && l.b_snapshot.port_id) || null;
      this.drawnEdges.set(l.link_id, { a, b, peer, aIf: l.a_if, bIf, upgraded });
      if (peer) {
        const pa = this.geoCenter(a), pb = this.geoCenter(b);
        const t = el('text', { class: 'tc-peerlbl', x: (pa.x + pb.x) / 2, y: pa.y - 6 });
        const bothFw = isFwName(this.byId.get(a)!) && isFwName(this.byId.get(b)!);
        t.textContent = bothFw ? '主从互联' : '聚合互联';
        grp.appendChild(t);
      } else if (upgraded) {
        // chassis 升格链路：端口对标注（本端端口 ↔ 对端快照端口），真实证据可核对
        const pa = this.geoCenter(a), pb = this.geoCenter(b);
        const t = el('text', { class: 'tc-uplbl', x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 - 4 });
        t.textContent = trunc((l.a_if || '?') + ' ↔ ' + (bIf || '?'), 34);
        grp.appendChild(t);
      }
      eg.appendChild(grp);
    }
    for (const [nid, p] of this.pos) ng.appendChild(this.drawNode(nid, p, depth));
    this.vp.innerHTML = ''; this.vp.appendChild(eg); this.vp.appendChild(ng);
    this.applySel();
    this.applyTransform();
  }

  /** 连线点选高亮：选中链路加粗高亮，两端卡片描边高亮 + 端口气泡；其余连线/卡片变暗。仅显示层交互。 */
  private selLink: number | null = null;
  private drawnEdges = new Map<number, { a: number; b: number; peer: boolean; aIf?: string | null; bIf?: string | null; upgraded?: boolean }>();
  selectEdge(linkId: number | null) {
    this.selLink = linkId != null && this.drawnEdges.has(linkId) ? linkId : null;
    this.applySel();
  }
  private applySel() {
    // 先清旧高亮
    this.vp.classList.remove('sel-mode');
    for (const g of Array.from(this.vp.querySelectorAll('.tc-node.hi'))) g.classList.remove('hi');
    for (const g of Array.from(this.vp.querySelectorAll('[data-led].esel'))) g.classList.remove('esel');
    for (const t of Array.from(this.vp.querySelectorAll('.tc-selport'))) t.remove();
    const sel = this.selLink;
    if (sel == null) return;
    const info = this.drawnEdges.get(sel);
    if (!info) { this.selLink = null; return; }
    this.vp.classList.add('sel-mode');
    for (const g of Array.from(this.vp.querySelectorAll('[data-led]'))) {
      if (+g.getAttribute('data-led')! === sel) g.classList.add('esel');
    }
    for (const nid of [info.a, info.b]) {
      const g = this.vp.querySelector(`.tc-node[data-tnid="${nid}"]`);
      if (g) g.classList.add('hi');
    }
    // 端口气泡：设备 [端口] ↔ 设备 [端口]（升格线对端端口来自快照）
    const ea = this.vp.querySelector(`[data-led="${sel}"] path.tc-edge`);
    if (!ea) return;
    const pa = this.geoCenter(info.a), pb = this.geoCenter(info.b);
    const an = trunc((this.byId.get(info.a) || {}).display_name, 14);
    const bn = trunc((this.byId.get(info.b) || {}).display_name, 14);
    const txt = `${an} [${info.aIf || '?'}] ↔ ${bn} [${info.bIf || (info.upgraded ? '快照端口?' : '?')}]${info.upgraded ? ' · chassis 升格' : ''}`;
    const bg = el('rect', { class: 'tc-selportbg', x: (pa.x + pb.x) / 2 - txt.length * 3.1 - 6, y: (pa.y + pb.y) / 2 - 26, width: txt.length * 6.2 + 12, height: 17, rx: 4 });
    const t = el('text', { class: 'tc-selport', x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 - 14 });
    t.textContent = txt;
    (ea.parentNode as Element).appendChild(bg);
    (ea.parentNode as Element).appendChild(t);
  }
  private bandExtent(d: number): [number, number] {
    let minX = Infinity, maxX = -Infinity;
    for (const p of this.pos.values()) if (p.depth === d) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x + NODE_W); }
    if (!isFinite(minX)) return [0, 400];
    return [minX - 10, maxX + 10];
  }

  private drawNode(nid: number, p: { x: number; y: number; depth: number }, depth: Map<number, number>) {
    const n = this.byId.get(nid)!;
    const ext = nid < 0;
    const gg = el('g', { class: 'tc-node' + (ext ? ' ext' : '') + (p.depth === 0 ? ' troot' : ''), transform: `translate(${p.x},${p.y})` });
    (gg as any).dataset.tnid = String(nid);
    gg.appendChild(el('rect', { class: 'card', x: 0, y: 0, width: NODE_W, height: NODE_H, rx: 8 }));
    if (ext) gg.appendChild(this.iconExt()); else gg.appendChild(this.icon(isFwName(n)));
    const roleSrc = ext ? '未纳管对端 · LLDP 快照证据'
      : p.depth === 0 && this.rootIds.has(nid) ? '核心·用户核定'
      : isCoreName(n) ? '核心·命名证据'
      : p.depth < 0 ? '上联·真实 LLDP 链路'
      : p.depth === 1 ? (isAggName(n) ? '汇聚·命名证据' : '下层·跳数推断')
      : p.depth === 2 ? (isAggName(n) ? '汇聚·命名证据' : '接入/下联·跳数推断')
      : `下联 ${p.depth} 跳·推断`;
    const t1 = el('text', { class: 'nm', x: 48, y: 22 }); t1.textContent = trunc(n.display_name, 17); gg.appendChild(t1);
    const t2 = el('text', { class: 'ip', x: 48, y: 38 }); t2.textContent = ext
      ? trunc('chassis ' + ((this.extByNid.get(nid) || {}).snap?.chassis_id || '—'), 26)
      : trunc(n.mgmt_ip || '—', 26);
    gg.appendChild(t2);
    const t3 = el('text', { class: 'role', x: 48, y: 52 }); t3.textContent = trunc(roleSrc + (ext ? '' : ' · ' + (n.vendor || '?')), 30); gg.appendChild(t3);
    // 展开状态徽标：已展开=收起(▲)；未展开且有隐藏邻居=展开(▼ n)
    const hidden = this.hiddenChildren(nid, depth);
    const exp = this.expanded.has(nid);
    if (exp || hidden > 0) {
      const bx = NODE_W - 34, by = NODE_H - 20;
      gg.appendChild(el('rect', { class: 'tgl', x: bx, y: by, width: 26, height: 14, rx: 4 }));
      const tt = el('text', { class: 'tgl-t', x: bx + 13, y: by + 11 });
      tt.textContent = exp ? '▲' : ('▼' + (hidden > 99 ? '99' : hidden));
      gg.appendChild(tt);
    }
    return gg;
  }
  private iconExt() {
    const g = el('g', { class: 'tc-icon extq', transform: 'translate(12,18)' });
    const t = el('text', { x: 14, y: 17, 'text-anchor': 'middle', 'font-size': '16', 'font-weight': '700' });
    t.textContent = '?'; g.appendChild(t);
    return g;
  }
  private icon(isFw = false) {
    if (isFw) {
      // 防火墙：盾牌 + 中央分隔缝（区别于交换机的两层矩形）
      const g = el('g', { class: 'tc-icon fw', transform: 'translate(12,16)' });
      g.appendChild(el('path', { d: 'M14 0 L27 4 V15 C27 22 21 26 14 28 C7 26 1 22 1 15 V4 Z', rx: 2 }));
      g.appendChild(el('line', { x1: 14, y1: 3, x2: 14, y2: 25 }));
      g.appendChild(el('line', { x1: 4, y1: 10, x2: 24, y2: 10 }));
      g.appendChild(el('line', { x1: 4, y1: 17, x2: 24, y2: 17 }));
      return g;
    }
    const g = el('g', { class: 'tc-icon', transform: 'translate(12,18)' });
    g.appendChild(el('rect', { x: 0, y: 1, width: 28, height: 8, rx: 2 }));
    g.appendChild(el('rect', { x: 0, y: 13, width: 28, height: 8, rx: 2 }));
    g.appendChild(el('line', { x1: 6, y1: 9, x2: 6, y2: 13 }));
    g.appendChild(el('line', { x1: 22, y1: 9, x2: 22, y2: 13 }));
    return g;
  }

  private geoCenter(id: number) { const g = this.pos.get(id)!; return { x: g.x + NODE_W / 2, y: g.y + NODE_H / 2 }; }
  /** 同层聚合互联线：从两台卡片相邻侧边中点直连（水平） */
  private sidebar(a: number, b: number) {
    const pa = this.pos.get(a)!, pb = this.pos.get(b)!;
    const y = pa.y + NODE_H / 2;
    return pa.x <= pb.x
      ? [{ x: pa.x + NODE_W, y }, { x: pb.x, y }]
      : [{ x: pa.x, y }, { x: pb.x + NODE_W, y }];
  }
  /** 跨层连线：斜线直连（用户草图核定）——中心连线与两台卡片矩形边界的交点直连一段，
   *  正交折线在密集层带里反而错乱；线只出卡片边缘，不穿自身卡片。 */
  private diagonal(a: number, b: number) {
    const ca = this.geoCenter(a), cb = this.geoCenter(b);
    return [this.edgePoint(a, ca, cb), this.edgePoint(b, cb, ca)];
  }
  private edgePoint(nid: number, from: { x: number; y: number }, toward: { x: number; y: number }) {
    const p = this.pos.get(nid)!;
    const dx = toward.x - from.x, dy = toward.y - from.y;
    const hw = NODE_W / 2, hh = NODE_H / 2;
    let tx = Infinity, ty = Infinity;
    if (dx !== 0) tx = hw / Math.abs(dx);
    if (dy !== 0) ty = hh / Math.abs(dy);
    const t = Math.min(tx, ty);
    return { x: p.x + hw + dx * t, y: p.y + hh + dy * t };
  }

  fitView(minK = 0) {
    const bb = this.vp.getBBox(); const w = this.svg.clientWidth, h = this.svg.clientHeight;
    if (!bb.width || !bb.height) return;
    const k = Math.max(0.15, Math.min((w - 60) / bb.width, (h - 80) / bb.height, 1.2));
    if (k >= minK) {
      this.view.k = k; this.view.x = (w - bb.width * k) / 2 - bb.x * k; this.view.y = (h - bb.height * k) / 2 - bb.y * k;
    } else {
      this.view.k = Math.min(minK, 1.2);
      this.view.x = w / 2 - (bb.x + bb.width / 2) * this.view.k;
      this.view.y = h / 2 - (bb.y + bb.height / 2) * this.view.k;
    }
    this.applyTransform();
  }
  private applyTransform() {
    this.vp.setAttribute('transform', `translate(${this.view.x},${this.view.y}) scale(${this.view.k})`);
    this.vp.classList.toggle('lod-mid', this.view.k < 0.55);
    this.vp.classList.toggle('lod-far', this.view.k < 0.3);
  }
  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const r = this.svg.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const f = e.deltaY < 0 ? 1.12 : 0.89;
    const k2 = Math.max(0.12, Math.min(2.5, this.view.k * f));
    this.view.x = mx - (mx - this.view.x) * (k2 / this.view.k);
    this.view.y = my - (my - this.view.y) * (k2 / this.view.k);
    this.view.k = k2;
    this.applyTransform();
  };
  private onMouseDown = (e: MouseEvent) => {
    const nEl = (e.target as Element).closest && (e.target as Element).closest('.tc-node');
    if (nEl) { this.pressed = { nid: +(nEl as any).dataset.tnid, x: e.clientX, y: e.clientY }; return; }
    const eEl = (e.target as Element).closest && (e.target as Element).closest('[data-led]');
    if (eEl) { this.pressed = { led: +eEl.getAttribute('data-led')!, x: e.clientX, y: e.clientY }; return; }
    this.pressed = { blank: true, x: e.clientX, y: e.clientY };
    this.pan = { x: e.clientX - this.view.x, y: e.clientY - this.view.y };
    this.svg.classList.add('panning');
  };
  private onMouseMove = (e: MouseEvent) => {
    if (this.pressed && Math.abs(e.clientX - this.pressed.x) + Math.abs(e.clientY - this.pressed.y) > 6) {
      this.pressed.moved = true;
    }
    if (this.pan) {
      this.view.x = e.clientX - this.pan.x; this.view.y = e.clientY - this.pan.y;
      this.applyTransform();
    }
  };
  private onMouseUp = (e: MouseEvent) => {
    if (this.pressed && !this.pressed.moved) {
      if (this.pressed.nid != null) {
        const nid = this.pressed.nid;
        this.cb.onNodeClick && this.cb.onNodeClick(nid);
        this.toggle(nid);
      } else if (this.pressed.led != null) {
        // 点击连线：高亮两端设备与端口（再点同一条取消）
        this.selectEdge(this.selLink === this.pressed.led ? null : this.pressed.led);
      } else if (this.pressed.blank) {
        this.selectEdge(null); // 点空白：清除高亮
      }
    }
    this.pressed = null; this.pan = null; this.svg.classList.remove('panning');
    void e;
  };
}

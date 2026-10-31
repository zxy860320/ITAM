/* G6 全局拓扑画布（AntV G6 5.1.1，API 逐个查 node_modules 核实）
 * - 设备卡片节点：自定义 DeviceCardNode（继承 Rect，render 内 upsert 文本图形）
 * - 区域容器：内置 rect combo（折叠=collapsedMarker 计数徽标，dblclick 折叠/展开）
 * - 正交连线：polyline + router {type:'orth'}；平行链路 bundle 错开（transform process-parallel-edges）
 * - 插件：grid-line / minimap / fullscreen；行为：drag-canvas / zoom-canvas / drag-element(编辑态且未锁定) / click-select
 * - 画布只是渲染器：位置状态以外部 layout Map 为准，保存走 DB（layoutStore） */
import {
  Graph, Rect, ExtensionCategory, register, register as _reg,
  NodeEvent, ComboEvent, GraphEvent,
} from '@antv/g6';
import { Rect as GRect, Text as GText } from '@antv/g';
import { Band, BAND_LABEL, GROUP_LABEL, GroupKey } from '../topology/classifier';
import { NODE_H, NODE_W, PlacedNode } from '../topology/autoLayout';
import { edgeVisual, PARALLEL_EDGE_TRANSFORM } from '../topology/edgeRouter';

export interface TopoLinkV2 {
  link_id: number; a: number | null; b: number | null;
  a_if?: string | null; b_if?: string | null; a_oper?: number | null; b_oper?: number | null;
  b_snapshot?: any; status: string; source?: string; confidence?: string | number;
  seen_a_at?: number; seen_b_at?: number;
}

/* ---------- 自定义设备卡片节点 ---------- */
class DeviceCardNode extends Rect {
  render(attributes: any = this.parsedAttributes, container = this) {
    super.render(attributes, container); // key 形状（rect）+ label（此处关掉内置 label，自绘两行）
    const w = attributes.size?.[0] ?? NODE_W;
    const h = attributes.size?.[1] ?? NODE_H;
    const dname = String(attributes.dname ?? '');
    const sub = String(attributes.sub ?? '');
    const title = dname.length > 20 ? dname.slice(0, 19) + '…' : dname;
    const wpx = Math.max(10, w - 16);

    this.upsert('card-title', GText as any, {
      x: -w / 2 + 8, y: -h / 2 + 18, text: title,
      fontSize: 12, fontWeight: 600, fill: attributes.titleFill || '#E4E4E7',
      textBaseline: 'middle', wordWrap: true, wordWrapWidth: wpx, maxLines: 1,
    } as any, container);
    this.upsert('card-sub', GText as any, {
      x: -w / 2 + 8, y: -h / 2 + 36, text: sub,
      fontSize: 10, fill: '#71717A', textBaseline: 'middle',
    } as any, container);
    // 锁定/人工位置角标（确定性视觉，不遮挡点击）
    this.upsert('card-mark', GText as any,
      attributes.position_locked
        ? { x: w / 2 - 10, y: -h / 2 + 12, text: '🔒', fontSize: 11, textBaseline: 'middle', textAlign: 'right' }
        : (attributes.layout_source === 'manual'
          ? { x: w / 2 - 10, y: -h / 2 + 12, text: '✎', fontSize: 11, fill: '#22D3EE', textBaseline: 'middle', textAlign: 'right' }
          : false) as any,
      container);
  }
  // 内置 label 置空（标题已自绘）
  drawLabelShape(attributes: any, container: any) { return this.upsert('label', 'label' as any, false as any, container); }
}

let registered = false;
function ensureRegister() {
  if (registered) return;
  registered = true;
  register(ExtensionCategory.NODE, 'device-card', DeviceCardNode as any);
  void _reg;
}

/* ---------- 画布封装 ---------- */

export interface LivePos { x: number; y: number; source: 'auto' | 'manual'; locked: boolean; group: GroupKey }
export interface LiveGroupPos { collapsed: boolean; x: number | null; y: number | null }

export interface G6Callbacks {
  onNodeClick?: (nodeId: number) => void;
  onEdgeClick?: (linkId: number) => void;
  onGroupToggle?: (g: GroupKey, collapsed: boolean) => void;
  onDirty?: () => void; // 有未保存变更时通知页面（保存按钮高亮）
}

export class TopoG6View {
  graph: Graph;
  private nodes: any[] = [];
  private links: TopoLinkV2[] = [];
  private pos = new Map<number, LivePos>();
  private gpos = new Map<string, LiveGroupPos>();
  private dirtyNodes = new Set<number>();
  private dirtyGroups = new Set<string>();
  private editable = false;
  private cb: G6Callbacks;

  constructor(container: HTMLElement, cb: G6Callbacks) {
    ensureRegister();
    this.cb = cb;
    this.graph = new Graph({
      container,
      autoResize: true,
      data: { nodes: [], edges: [], combos: [] },
      node: {
        type: 'device-card',
        style: {
          size: [NODE_W, NODE_H],
          radius: 6,
          fill: '#141417',
          stroke: '#27272A',
          lineWidth: 1,
          labelText: '',
          cursor: 'pointer',
        },
        state: {
          selected: { stroke: '#22D3EE', lineWidth: 2, halo: true, haloStroke: '#22D3EE', haloLineWidth: 6, haloStrokeOpacity: 0.18 },
          highlight: { stroke: '#22D3EE', lineWidth: 1.6 },
          dim: { fillOpacity: 0.35, strokeOpacity: 0.35, labelOpacity: 0.35 },
        },
      },
      edge: {
        type: 'polyline',
        style: {
          router: { type: 'orth', padding: 24 },
          endArrow: false,
          cursor: 'pointer',
          labelText: '',
        },
        state: {
          selected: { stroke: '#22D3EE', lineWidth: 2.2 },
          dim: { opacity: 0.15 },
        },
      },
      combo: {
        type: 'rect',
        style: {
          radius: 10,
          fill: 'rgba(96,165,250,0.06)',
          stroke: '#3F3F46',
          lineWidth: 1.5,
          lineDash: [6, 4],
          zIndex: -1,
          labelText: '', // 区域标题自绘于 updateGraphData（label 位置随折叠变化，直接给 labelText 更稳，这里留默认）
          labelFontSize: 12,
          labelFontWeight: 700,
          labelFill: '#A1A1AA',
          labelPlacement: 'top',
          labelOffsetY: -8,
          padding: [34, 18, 14, 18],
          collapsedSize: [230, 56],
          collapsedMarker: true,
          collapsedMarkerType: 'child-count',
          collapsedMarkerFontSize: 11,
          collapsedMarkerFill: '#A1A1AA',
        },
      },
      behaviors: [
        'drag-canvas',
        { type: 'zoom-canvas', sensitivity: 1.2 },
        {
          type: 'drag-element',
          enable: (e: any) => {
            if (!this.editable) return false;
            // 锁定节点不可拖动（红线：locked=固定约束）
            if (e.targetType === 'node') {
              const p = this.pos.get(Number(String(e.target?.id ?? '').slice(1)));
              if (p?.locked) return false;
            }
            return true;
          },
          shadowStyle: { fill: 'rgba(34,211,238,0.15)' },
        },
        { type: 'click-select' },
        {
          type: 'collapse-expand',
          trigger: 'dblclick',
          enable: (e: any) => e.targetType === 'combo',
          // animation:false —— 实测 G6 折叠动画偶发不 resolve，会永久占住 isCollapsingExpanding 锁导致后续折叠/展开静默失效
          animation: false,
        },
      ],
      plugins: [
        { type: 'grid-line', size: 24, stroke: 'rgba(255,255,255,0.045)' },
        { type: 'minimap', size: [190, 130] as [number, number], className: 'g6-minimap' },
        { type: 'fullscreen' },
      ],
      transforms: [PARALLEL_EDGE_TRANSFORM as any],
    });
    (window as any).__tg6 = this.graph; // E2E 调试钩子（只读诊断用）

    this.graph.on(NodeEvent.CLICK, (e: any) => {
      const id = e.target?.id;
      if (id != null) this.cb.onNodeClick?.(Number(String(id).slice(1)));
    });
    this.graph.on('edge:click', (e: any) => {
      const id = e.target?.id;
      if (id != null) this.cb.onEdgeClick?.(Number(String(id).slice(1)));
    });
    this.graph.on(ComboEvent.DBLCLICK, (e: any) => {
      const id = String(e.target?.id ?? '');
      if (!id.startsWith('G')) return;
      const g = id.slice(1);
      const data = this.graph.getComboData(id as any) as any;
      const collapsed = !!data?.style?.collapsed;
      // collapse-expand 行为随后 toggle；这里记录目标态（保留区域框人工位置，不清 null）
      const cur = this.gpos.get(g) || { collapsed: false, x: null, y: null };
      this.gpos.set(g, { ...cur, collapsed: !collapsed });
      this.dirtyGroups.add(g);
      this.cb.onGroupToggle?.(g as GroupKey, !collapsed);
      this.cb.onDirty?.();
    });
    // 拖动结束 → 位置转 manual（锁定的不可拖，enable 已挡），区域框拖动记区域位置
    this.graph.on(NodeEvent.DRAG_END, () => {
      if (!this.editable) return;
      window.setTimeout(() => this.syncDraggedNodes(), 0);
    });
    this.graph.on(ComboEvent.DRAG_END, () => {
      if (!this.editable) return;
      for (const [g] of this.gpos) {
        const id = 'G' + g;
        try {
          const p = this.graph.getElementPosition(id as any);
          if (p && Number.isFinite(p[0])) { this.gpos.set(g, { ...(this.gpos.get(g) || { collapsed: false }), x: p[0], y: p[1] }); this.dirtyGroups.add(g); }
        } catch { /* 折叠动画中可能暂取不到，忽略 */ }
      }
      this.syncDraggedNodes();
      this.cb.onDirty?.();
    });
  }

  private syncDraggedNodes() {
    for (const n of this.nodes) {
      const id = 'N' + n.node_id;
      let p: any;
      try { p = this.graph.getElementPosition(id as any); } catch { continue; }
      if (!p || !Number.isFinite(p[0])) continue;
      const cur = this.pos.get(n.node_id);
      if (!cur) continue;
      if (Math.abs(cur.x - p[0]) > 0.5 || Math.abs(cur.y - p[1]) > 0.5) {
        this.pos.set(n.node_id, {
          ...cur, x: p[0], y: p[1],
          source: cur.locked ? cur.source : 'manual', // 拖动→manual（红线）；locked 节点禁拖故不会到这里
        });
        this.dirtyNodes.add(n.node_id);
        this.cb.onDirty?.();
      }
    }
  }

  setEditable(v: boolean) { this.editable = v; } // enable 闭包实时读取该标志，无需重建行为

  get dirtyCount() { return { nodes: this.dirtyNodes.size, groups: this.dirtyGroups.size }; }

  /** 全量喂数据（节点/区域/边）。pos 为最终位置（页面完成 auto/manual 合并后传入）。 */
  setData(nodes: any[], links: TopoLinkV2[], pos: Map<number, LivePos>, gpos: Map<string, LiveGroupPos>) {
    this.nodes = nodes;
    this.links = links;
    this.pos = new Map(pos);
    this.gpos = new Map(gpos);
    this.dirtyNodes.clear();
    this.dirtyGroups.clear();
    this.renderAll();
  }

  private renderAll() {
    // 区域集合 = 有节点的组 ∪ 有状态记录的组（节点 combo 引用必须存在对应 combo，否则 G6 抛 Node not found）
    const combos = new Map<string, any>();
    const groups = new Set<string>([...this.pos.values()].map(p => p.group));
    for (const g of this.gpos.keys()) groups.add(g);
    for (const g of groups) {
      const gp = this.gpos.get(g) || { collapsed: false, x: null as number | null, y: null as number | null };
      combos.set('G' + g, {
        id: 'G' + g,
        style: {
          collapsed: gp.collapsed,
          ...(gp.x != null && gp.y != null && gp.collapsed ? { x: gp.x, y: gp.y } : {}),
          labelText: `${GROUP_LABEL[g as GroupKey] || g} · ${[...this.pos.values()].filter(p => p.group === g).length} 台`,
        },
      });
    }
    const nodesData = this.nodes.filter(n => this.pos.has(n.node_id)).map(n => {
      const p = this.pos.get(n.node_id)!;
      return {
        id: 'N' + n.node_id,
        combo: ('G' + p.group) as any,
        style: {
          x: p.x, y: p.y,
          dname: n.display_name || ('#' + n.node_id),
          sub: `${n.mgmt_ip || '—'} · ${p.locked ? '锁定' : p.source === 'manual' ? '人工' : '自动'} · ${n.iface_count ?? 0}口`,
          position_locked: p.locked,
          layout_source: p.source,
          titleFill: n.status === 'degraded' ? '#F2C94C' : '#E4E4E7',
        },
      };
    });
    const edgesData = this.links
      .filter(l => l.a != null && l.b != null && this.pos.has(l.a) && this.pos.has(l.b))
      .map(l => ({
        id: 'L' + l.link_id,
        source: 'N' + l.a, target: 'N' + l.b,
        style: { ...edgeVisual(l.status, l.source) },
      }));
    this.graph.setData({ nodes: nodesData as any, edges: edgesData as any, combos: [...combos.values()] as any });
    void this.graph.render();
  }

  /** 更新位置（自动布局应用后调用；只动传入的节点，保留其余） */
  applyPositions(rows: { node_id: number; x: number; y: number; group: GroupKey; source: 'auto' | 'manual'; locked: boolean }[]) {
    for (const r of rows) this.pos.set(r.node_id, { x: r.x, y: r.y, source: r.source, locked: r.locked, group: r.group });
    this.renderAll();
  }

  setGroupsCollapsed(map: Map<string, boolean>) {
    // 注意：setData 改 style.collapsed 不会触发子节点隐藏动画——程序化折叠必须走 collapseElement/expandElement；
    // 且 G6 对并发折叠/展开有内部锁（isCollapsingExpanding），必须逐个串行执行。
    void (async () => {
      for (const [g, c] of map) {
        const id = ('G' + g) as any;
        let cur: boolean;
        try { cur = !!(this.graph.getComboData(id) as any)?.style?.collapsed; } catch { continue; }
        if (cur === c) continue;
        this.gpos.set(g, { ...(this.gpos.get(g) || { collapsed: false, x: null, y: null }), collapsed: c });
        this.dirtyGroups.add(g);
        try {
          const opts = { animation: false, align: false } as any;
          await (c ? this.graph.collapseElement(id, opts) : this.graph.expandElement(id, opts));
        } catch { /* 动画锁竞争等，忽略单次 */ }
      }
      this.cb.onDirty?.();
    })();
  }

  fitAll() { void this.graph.fitView({ when: 'always', direction: 'both' } as any); }
  focusNode(nodeId: number) {
    void this.graph.focusElement('N' + nodeId as any, { duration: 350 } as any);
    void this.graph.setElementState('N' + nodeId as any, ['selected']);
  }
  selectEdge(linkId: number) {
    void this.graph.setElementState('L' + linkId as any, ['selected']);
  }
  enterFullscreen() {
    const pl: any = this.graph.getPluginInstance('fullscreen');
    pl?.request?.();
  }

  /** 保存：返回待写库行（页面负责调 layoutStore 后 markSaved） */
  collectSavePayload() {
    const nodes = [...this.dirtyNodes].map(id => {
      const p = this.pos.get(id)!;
      return { node_id: id, x: p.x, y: p.y, group_key: p.group, layout_source: p.source, position_locked: p.locked };
    });
    const groups = [...this.dirtyGroups].map(g => {
      const gp = this.gpos.get(g)!;
      // 折叠态但还没记录过位置 → 现场读取（折叠后 combo 停在原中心）
      let gx = gp.x, gy = gp.y;
      if (gp.collapsed && gx == null) {
        try { const p = this.graph.getElementPosition('G' + g as any); if (p && Number.isFinite(p[0])) { gx = p[0]; gy = p[1]; } } catch { /* noop */ }
      }
      return { group_key: g, label: GROUP_LABEL[g as GroupKey] || g, collapsed: gp.collapsed, x: gx, y: gy, w: null, h: null };
    });
    return { nodes, groups };
  }
  markSaved() { this.dirtyNodes.clear(); this.dirtyGroups.clear(); this.cb.onDirty?.(); }

  /** 锁定/解锁切换（编辑态由页面弹窗确认前不直接改，这里提供落地口） */
  setLocked(nodeId: number, locked: boolean) {
    const p = this.pos.get(nodeId);
    if (!p) return;
    this.pos.set(nodeId, { ...p, locked });
    this.dirtyNodes.add(nodeId);
    this.renderAll();
    this.cb.onDirty?.();
  }

  destroy() { try { this.graph.destroy(); } catch { /* noop */ } }
}

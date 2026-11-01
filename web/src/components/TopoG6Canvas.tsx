/* G6 全局拓扑画布（AntV G6 5.1.1，API 逐个查 node_modules 源码核实）
 * V2 Phase 2：区域=管理员资产（zone）。空画布不出现任何自动区域——只有管理员建的 zone 渲染为 combo。
 * - 设备卡片节点：自定义 DeviceCardNode（继承 Rect，render 内自绘两行 + 🔒/✎ 角标）
 * - 区域容器：自定义 ZoneCombo（继承 RectCombo，覆写 getExpandedKeySize/getEmptyKeySize/getComboPosition
 *   支持人工 w/h 与人工摆位；G6 默认 rect combo 尺寸/位置全由成员包络，人工尺寸必须覆写才生效——源码核实）
 * - 区域 resize：自绘右下角手柄 + pointer 事件手动换算（drag-element 不 resize combo，源码核实）
 * - 拖入/拖出：NodeEvent.DRAG_END 按落点中心命中区域包围盒改 combo（updateNodeData combo:null 解绑再挂新——源码核实）
 * - 画布只是渲染器：位置状态以外部 layout Map 为准，保存走 DB（PUT /layout/batch + PATCH zone geometry） */
import {
  Graph, Rect, RectCombo, ExtensionCategory, register,
  NodeEvent, ComboEvent,
} from '@antv/g6';
import { Rect as GRect, Text as GText } from '@antv/g';
import { NODE_H, NODE_W } from '../topology/autoLayout';
import { edgeVisual, PARALLEL_EDGE_TRANSFORM } from '../topology/edgeRouter';
import { ZoneInfo } from '../topology/layoutStore';

export interface TopoLinkV2 {
  link_id: number; a: number | null; b: number | null;
  a_if?: string | null; b_if?: string | null; a_oper?: number | null; b_oper?: number | null;
  b_snapshot?: any; status: string; source?: string; confidence?: string | number;
  seen_a_at?: number; seen_b_at?: number;
}

export const comboIdOf = (zoneId: number) => 'Z' + zoneId;
export function zoneIdOfCombo(comboId: string): number | null {
  return comboId.startsWith('Z') && /^\d+$/.test(comboId.slice(1)) ? +comboId.slice(1) : null;
}

/* ---------- 自定义设备卡片节点 ---------- */
class DeviceCardNode extends Rect {
  render(attributes: any = this.parsedAttributes, container = this) {
    super.render(attributes, container); // key 形状（rect）；内置 label 关掉，自绘两行
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

/* ---------- 自定义区域 combo（人工 w/h + 人工摆位生效的关键覆写；protected 可覆写已源码核实） ---------- */
class ZoneCombo extends RectCombo {
  render(attributes: any = this.parsedAttributes, container = this) {
    super.render(attributes, container);
    const w = attributes.size?.[0] ?? 0;
    const h = attributes.size?.[1] ?? 0;
    // 备注常驻一行（区域是文档化资产）
    this.upsert('zone-note', GText as any,
      (attributes.znote && !attributes.collapsed)
        ? { x: -w / 2 + 14, y: -h / 2 + 30, text: String(attributes.znote).slice(0, 60),
            fontSize: 10, fill: '#8B8B93', textBaseline: 'middle', wordWrap: true, wordWrapWidth: Math.max(40, w - 28), maxLines: 1 }
        : false as any,
      container);
    // 右下角缩放手柄（仅编辑态显示；zhandle 由视图层按 editable 开）
    this.upsert('zone-resize', GRect as any,
      (attributes.zhandle && !attributes.collapsed)
        ? { x: w / 2 - 14, y: h / 2 - 14, width: 14, height: 14, fill: attributes.stroke || '#3F3F46',
            fillOpacity: 0.85, radius: 2, cursor: 'nwse-resize', zIndex: 5 }
        : false as any,
      container);
  }
  protected getExpandedKeySize(attributes: any): any {
    if (attributes.zw != null && attributes.zh != null) return [attributes.zw, attributes.zh, 0];
    return super.getExpandedKeySize(attributes); // 无人工尺寸 → 成员自动包络（G6 原生行为）
  }
  protected getEmptyKeySize(attributes: any): any {
    // 空区域（刚建、还没放设备）：有人工尺寸用工整尺寸，否则给可点的默认框
    if (attributes.zw != null && attributes.zh != null) return [attributes.zw, attributes.zh, 0];
    return [300, 160, 0];
  }
  getComboPosition(attributes: any): any {
    // 人工尺寸区域：位置以 datum x/y 为准（translateComboBy 维护 datum，拖动无回弹闪烁——源码核实）
    if (attributes.zw != null && attributes.zh != null) return [+(attributes.x ?? 0), +(attributes.y ?? 0), 0];
    return super.getComboPosition(attributes);
  }
}

let registered = false;
function ensureRegister() {
  if (registered) return;
  registered = true;
  register(ExtensionCategory.NODE, 'device-card', DeviceCardNode as any);
  register(ExtensionCategory.COMBO, 'zone', ZoneCombo as any);
}

/** zone 语义字段 → combo 样式（颜色/边框/note/人工几何透传给 ZoneCombo 覆写） */
function zoneComboStyle(z: ZoneInfo, memberCount: number, editable: boolean): any {
  const manualGeo = z.w != null && z.h != null;
  return {
    labelText: `${z.name} · ${memberCount} 台`,
    fill: z.bg_color || 'rgba(96,165,250,0.06)',
    fillOpacity: 0.12, // 深色画布上的彩色区域=参考图效果：色相填充压低透明度
    stroke: z.border_style === 'none' ? 'rgba(0,0,0,0)' : (z.border_color || '#3F3F46'),
    lineWidth: z.border_style === 'none' ? 0 : z.border_width,
    lineDash: z.border_style === 'dashed' ? [7, 5] : undefined,
    // 人工几何：zw/zh 触发 ZoneCombo 覆写；x/y 由 datum 承载（无 x/y 时 G6 按内容自动定位）
    ...(manualGeo ? { zw: z.w, zh: z.h, ...(z.x != null && z.y != null ? { x: z.x, y: z.y } : {}) } : {}),
    znote: z.note || '',
    zhandle: editable && manualGeo,
    collapsed: z.collapsed,
    collapsedSize: [Math.max(180, Math.min(320, (z.w ?? 240))), 56],
  };
}

// ---------- PART 2: 视图封装 ----------

export interface LivePos {
  x: number; y: number;
  source: 'auto' | 'manual'; locked: boolean;
  group: string;            // 自动布局八类分组（仅摆放语义，不作为可见区域）
  zone: number | null;      // V2 区域隶属（null=未分区，画布上无容器）
}
export interface LiveZoneGeo { collapsed: boolean; x: number | null; y: number | null; w: number | null; h: number | null }

export interface G6Callbacks {
  onNodeClick?: (nodeId: number) => void;
  onEdgeClick?: (linkId: number) => void;
  onZoneToggle?: (zoneId: number, collapsed: boolean) => void;
  onDirty?: () => void; // 有未保存变更时通知页面（保存按钮高亮）
}

const MIN_ZONE_SIDE = 40; // 与后端 PATCH geometry 的 w/h≥40 对齐

export class TopoG6View {
  graph: Graph;
  private container: HTMLElement;
  private nodes: any[] = [];
  private links: TopoLinkV2[] = [];
  private pos = new Map<number, LivePos>();
  private zoneInfo = new Map<number, ZoneInfo>();     // 语义字段（页面权威，setData 灌入）
  private zoneGeo = new Map<number, LiveZoneGeo>();   // 编辑中的几何（拖动/缩放/折叠的即时态）
  private dirtyNodes = new Set<number>();
  private dirtyZones = new Set<number>();
  private editable = false;
  private cb: G6Callbacks;
  // resize 会话（右下角手柄按下后激活；drag-element 期间互斥跳过）
  private resize: { comboId: string; zw: number; zh: number; zx: number; zy: number } | null = null;

  constructor(container: HTMLElement, cb: G6Callbacks) {
    ensureRegister();
    this.container = container;
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
        type: 'zone',
        style: {
          radius: 10,
          zIndex: -1,
          labelText: '',
          labelFontSize: 12,
          labelFontWeight: 700,
          labelFill: '#C9C9D1',
          labelPlacement: 'top-left',
          labelOffsetY: -14,
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
            if (!this.editable || this.resize) return false;
            if (e.targetType === 'node') {
              const p = this.pos.get(Number(String(e.target?.id ?? '').slice(1)));
              if (p?.locked) return false; // 锁定节点不可拖动（红线：locked=固定约束）
            }
            return true;
          },
          shadowStyle: { fill: 'rgba(34,211,238,0.15)' },
        },
        { type: 'click-select' },
        {
          type: 'collapse-expand',
          trigger: 'dblclick',
          enable: (e: any) => e.targetType === 'combo' && !this.resize,
          // animation:false —— 实测 G6 折叠动画偶发不 resolve，会永久占住 isCollapsingExpanding 锁
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
    // 双击区域折叠/展开：collapse-expand 行为负责渲染，这里同步本地几何脏位
    this.graph.on(ComboEvent.DBLCLICK, (e: any) => {
      const zid = zoneIdOfCombo(String(e.target?.id ?? ''));
      if (zid == null) return;
      const data = this.graph.getComboData('Z' + zid as any) as any;
      const collapsed = !data?.style?.collapsed; // 行为随后 toggle，记录目标态
      const cur = this.zoneGeo.get(zid) || { collapsed: false, x: null, y: null, w: null, h: null };
      this.zoneGeo.set(zid, { ...cur, collapsed });
      this.dirtyZones.add(zid);
      this.cb.onZoneToggle?.(zid, collapsed);
      this.cb.onDirty?.();
    });
    // 节点拖动结束 → 位置转 manual + 落点命中检测（拖入/拖出区域）
    this.graph.on(NodeEvent.DRAG_END, () => {
      if (!this.editable) return;
      window.setTimeout(() => this.syncDraggedNodes(), 0);
    });
    // 区域拖动结束 → 钉为人工几何（当前位置+当前包络尺寸），成员随区域整体平移（G6 translateComboBy 原生行为）
    this.graph.on(ComboEvent.DRAG_END, () => {
      if (!this.editable || this.resize) return;
      window.setTimeout(() => this.syncDraggedZones(), 0);
    });
    this.bindZoneResize();
  }

  /* ---------- 区域 resize（自绘手柄 + drag 序列 dx/dy，drag-element 互斥） ---------- */
  private bindZoneResize() {
    const graph = this.graph;
    graph.on(ComboEvent.POINTER_DOWN, (e: any) => {
      if (!this.editable) return;
      const comboId = String(e.target?.id ?? '');
      const zid = zoneIdOfCombo(comboId);
      if (zid == null) return;
      const info = this.zoneInfo.get(zid);
      const geo = this.zoneGeo.get(zid);
      if (!info || !geo || geo.collapsed) return;
      // 手柄命中：右下角色块区域（canvas 坐标 vs 指针 viewport→canvas 换算）
      try {
        const b = graph.getElementRenderBounds(comboId as any);
        const pt = this.eventCanvasPoint(e);
        if (!pt) return;
        const [x1, y1] = b.max;
        if (pt[0] >= x1 - 16 && pt[1] >= y1 - 16) {
          const p = graph.getElementPosition(comboId as any);
          this.resize = { comboId, zw: b.max[0] - b.min[0], zh: b.max[1] - b.min[1], zx: p[0], zy: p[1] };
        }
      } catch { /* bounds 暂不可取则不启动 resize */ }
    });
    graph.on(ComboEvent.DRAG, (e: any) => {
      if (!this.resize) return; // 非手柄拖动交回 drag-element
      const { dx = 0, dy = 0 } = e as any;
      const r = this.resize;
      r.zw = Math.max(MIN_ZONE_SIDE, r.zw + dx);
      r.zh = Math.max(MIN_ZONE_SIDE, r.zh + dy);
      r.zx += dx / 2; r.zy += dy / 2; // 右下角锚点：左上角不动，中心半量平移
      try {
        graph.updateComboData([{ id: r.comboId as any, style: { x: r.zx, y: r.zy, zw: r.zw, zh: r.zh, zhandle: true } }]);
      } catch { /* noop */ }
    });
    const finish = () => {
      if (!this.resize) return;
      const zid = zoneIdOfCombo(this.resize.comboId)!;
      const r = this.resize;
      const cur = this.zoneGeo.get(zid) || { collapsed: false, x: null, y: null, w: null, h: null };
      this.zoneGeo.set(zid, { ...cur, x: r.zx, y: r.zy, w: r.zw, h: r.zh });
      this.dirtyZones.add(zid);
      this.resize = null;
      this.cb.onDirty?.();
    };
    graph.on(ComboEvent.DRAG_END, () => finish());
    graph.on(ComboEvent.POINTER_UP, () => { window.setTimeout(finish, 0); });
  }

  private eventCanvasPoint(e: any): [number, number] | null {
    // 官方行为源码（create-edge）同款换算：event.client{x,y} → graph.getCanvasByClient（源码核实）
    const cx = e.client?.x ?? (Array.isArray(e.client) ? e.client[0] : undefined);
    const cy = e.client?.y ?? (Array.isArray(e.client) ? e.client[1] : undefined);
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) return null;
    try {
      const p = this.graph.getCanvasByClient([cx, cy] as any);
      return [p[0], p[1]];
    } catch { return null; }
  }

  private syncDraggedNodes() {
    const touched = new Set<number>();
    for (const n of this.nodes) {
      const id = 'N' + n.node_id;
      let p: any;
      try { p = this.graph.getElementPosition(id as any); } catch { continue; }
      if (!p || !Number.isFinite(p[0])) continue;
      const cur = this.pos.get(n.node_id);
      if (!cur) continue;
      const moved = Math.abs(cur.x - p[0]) > 0.5 || Math.abs(cur.y - p[1]) > 0.5;
      if (!moved) continue;
      const next: LivePos = { ...cur, x: p[0], y: p[1], source: cur.locked ? cur.source : 'manual' }; // 拖动→manual（红线）
      // 落点命中检测：中心点落在哪个展开区域包络内（折叠区不参与；取面积最小者=最深命中）
      let target: number | null = null; let bestArea = Infinity;
      for (const [zid] of this.zoneInfo) {
        const geo = this.zoneGeo.get(zid);
        if (geo?.collapsed) continue;
        try {
          const b = this.graph.getElementRenderBounds('Z' + zid as any);
          if (p[0] >= b.min[0] && p[0] <= b.max[0] && p[1] >= b.min[1] && p[1] <= b.max[1]) {
            const area = (b.max[0] - b.min[0]) * (b.max[1] - b.min[1]);
            if (area < bestArea) { bestArea = area; target = zid; }
          }
        } catch { /* noop */ }
      }
      if (target !== cur.zone) {
        next.zone = target;
        if (cur.zone != null) touched.add(cur.zone);
        if (target != null) touched.add(target);
        // 挂/摘 combo（源码核实：updateNodeData combo:null → refreshComboData 解除旧 combo；再挂新 combo）
        try {
          if (target == null) this.graph.updateNodeData([{ id: id as any, combo: null as any }]);
          else this.graph.updateNodeData([{ id: id as any, combo: ('Z' + target) as any }]);
        } catch { /* 结构更新异常则下个 renderAll 兜底 */ }
      }
      this.pos.set(n.node_id, next);
      this.dirtyNodes.add(n.node_id);
      this.cb.onDirty?.();
    }
    // 受影响区域标签的成员数即时刷新（不改语义字段，仅 labelText）
    if (touched.size) {
      const mc = new Map<number, number>();
      for (const p of this.pos.values()) if (p.zone != null) mc.set(p.zone, (mc.get(p.zone) || 0) + 1);
      for (const zid of touched) {
        const z = this.zoneInfo.get(zid);
        if (!z) continue;
        try { this.graph.updateComboData([{ id: ('Z' + zid) as any, style: { labelText: `${z.name} · ${mc.get(zid) || 0} 台` } }]); } catch { /* noop */ }
      }
    }
  }

  private syncDraggedZones() {
    for (const [zid] of this.zoneInfo) {
      const comboId = ('Z' + zid) as any;
      try {
        const data = this.graph.getComboData(comboId) as any;
        if (data?.style?.collapsed) continue;
        const p = this.graph.getElementPosition(comboId);
        if (!p || !Number.isFinite(p[0])) continue;
        const cur = this.zoneGeo.get(zid) || { collapsed: false, x: null, y: null, w: null, h: null };
        // 已是人工几何：仅更新 x/y；自动包络几何：拖动即固化为人工（当前位置+当前包络）
        const b = this.graph.getElementRenderBounds(comboId);
        const w = cur.w ?? (b.max[0] - b.min[0]), h = cur.h ?? (b.max[1] - b.min[1]);
        if (Math.abs((cur.x ?? p[0]) - p[0]) > 0.5 || Math.abs((cur.y ?? p[1]) - p[1]) > 0.5 || cur.w == null) {
          this.zoneGeo.set(zid, { ...cur, x: p[0], y: p[1], w, h });
          this.dirtyZones.add(zid);
          // 立即把 zw/zh 写回 combo 数据，让 ZoneCombo 用人工尺寸
          this.graph.updateComboData([{ id: comboId, style: { x: p[0], y: p[1], zw: w, zh: h, zhandle: this.editable } }]);
          this.cb.onDirty?.();
        }
      } catch { /* 折叠动画中可能暂取不到，忽略 */ }
    }
  }

  setEditable(v: boolean) {
    this.editable = v; // enable 闭包实时读取该标志，无需重建行为
    // 手柄显隐随编辑态
    for (const [zid] of this.zoneInfo) {
      try {
        this.graph.updateComboData([{ id: ('Z' + zid) as any, style: { zhandle: v && (this.zoneGeo.get(zid)?.w ?? this.zoneInfo.get(zid)?.w) != null } }]);
      } catch { /* noop */ }
    }
  }

  get dirtyCount() { return { nodes: this.dirtyNodes.size, zones: this.dirtyZones.size }; }

  /** 全量喂数据。zones=管理员区域（唯一容器来源；空 zones=画布上无任何区域框）。 */
  setData(nodes: any[], links: TopoLinkV2[], zones: Map<number, ZoneInfo>, pos: Map<number, LivePos>) {
    this.nodes = nodes;
    this.links = links;
    this.zoneInfo = new Map(zones);
    this.zoneGeo = new Map([...zones].map(([zid, z]) => [zid, { collapsed: z.collapsed, x: z.x, y: z.y, w: z.w, h: z.h }]));
    this.pos = new Map(pos);
    this.dirtyNodes.clear();
    this.dirtyZones.clear();
    this.renderAll();
  }

  /** 区域语义/几何外部刷新（CRUD 后页面重新拉取调用；不清脏位） */
  setZones(zones: Map<number, ZoneInfo>) {
    this.zoneInfo = new Map(zones);
    for (const [zid, z] of zones) {
      const cur = this.zoneGeo.get(zid);
      this.zoneGeo.set(zid, {
        collapsed: z.collapsed, x: z.x, y: z.y, w: z.w, h: z.h,
        // 本地未保存的编辑优先于服务端回读（避免保存后重拉覆盖即时态）
        ...(cur && this.dirtyZones.has(zid) ? { x: cur.x ?? z.x, y: cur.y ?? z.y, w: cur.w ?? z.w, h: cur.h ?? z.h } : {}),
      });
    }
    this.renderAll();
  }

  private renderAll() {
    // 区域集合只来自管理员 zone —— 绝不自动生成
    const memberCount = new Map<number, number>();
    for (const p of this.pos.values()) if (p.zone != null) memberCount.set(p.zone, (memberCount.get(p.zone) || 0) + 1);
    const combos: any[] = [];
    for (const [zid, z] of this.zoneInfo) {
      const geo = this.zoneGeo.get(zid) || { collapsed: z.collapsed, x: z.x, y: z.y, w: z.w, h: z.h };
      const manualGeo = geo.w != null && geo.h != null;
      combos.push({
        id: 'Z' + zid,
        style: {
          ...zoneComboStyle(z, memberCount.get(zid) || 0, this.editable),
          collapsed: geo.collapsed,
          ...(manualGeo
            ? { zw: geo.w, zh: geo.h, ...(geo.x != null && geo.y != null ? { x: geo.x, y: geo.y } : {}) }
            : {}), // 无成员且无人工尺寸 → ZoneCombo.getEmptyKeySize 默认框（位置按 datum x/y 或由首次成员驱动包络）
        },
      });
    }
    const nodesData = this.nodes.filter(n => this.pos.has(n.node_id)).map(n => {
      const p = this.pos.get(n.node_id)!;
      return {
        id: 'N' + n.node_id,
        ...(p.zone != null && this.zoneInfo.has(p.zone) ? { combo: ('Z' + p.zone) as any } : {}),
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
    this.graph.setData({ nodes: nodesData as any, edges: edgesData as any, combos: combos as any });
    void this.graph.render();
  }

  /** 应用自动布局结果（只动传入节点；zone 隶属保持不变——自动布局不改变区域归属，区域是管理员资产） */
  applyPositions(rows: { node_id: number; x: number; y: number; source: 'auto' | 'manual'; locked: boolean }[]) {
    for (const r of rows) {
      const cur = this.pos.get(r.node_id);
      if (!cur) continue;
      this.pos.set(r.node_id, { ...cur, x: r.x, y: r.y, source: r.source, locked: r.locked });
    }
    this.renderAll();
  }

  /** 外部成员变更（侧栏加入区域等，服务端已写 zone_id）后同步本地隶属并重渲染；不标脏 */
  setNodeZones(entries: { node_id: number; zone: number | null }[]) {
    for (const e of entries) {
      const p = this.pos.get(e.node_id);
      if (p) this.pos.set(e.node_id, { ...p, zone: e.zone });
    }
    this.renderAll();
  }

  setZonesCollapsed(map: Map<number, boolean>) {

    // 程序化折叠必须走 collapseElement/expandElement（setData style.collapsed 不触发动画）；
    // G6 内部锁 isCollapsingExpanding → 必须逐个串行。
    void (async () => {
      for (const [zid, c] of map) {
        const id = ('Z' + zid) as any;
        let cur: boolean;
        try { cur = !!(this.graph.getComboData(id) as any)?.style?.collapsed; } catch { continue; }
        if (cur === c) continue;
        const geo = this.zoneGeo.get(zid) || { collapsed: false, x: null, y: null, w: null, h: null };
        let gx = geo.x, gy = geo.y;
        if (c && gx == null) { try { const p = this.graph.getElementPosition(id); if (p && Number.isFinite(p[0])) { gx = p[0]; gy = p[1]; } } catch { /* noop */ } }
        this.zoneGeo.set(zid, { ...geo, collapsed: c, x: gx, y: gy });
        this.dirtyZones.add(zid);
        try {
          const opts = { animation: false, align: false } as any;
          await (c ? this.graph.collapseElement(id, opts) : this.graph.expandElement(id, opts));
        } catch { /* 动画锁竞争等，忽略单次 */ }
      }
      this.cb.onDirty?.();
    })();
  }

  fitAll() { void this.graph.fitView({ when: 'always', direction: 'both' } as any); }

  /** 当前视口中心的 canvas 坐标（建区时给默认摆位，避免 NaN 定位） */
  viewportCenter(): [number, number] {
    try {
      const w = this.container.clientWidth || 800, h = this.container.clientHeight || 500;
      const p = this.graph.getCanvasByViewport([w / 2, h / 2] as any);
      return [Math.round(p[0]), Math.round(p[1])];
    } catch { return [0, 0]; }
  }
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

  /** 保存：返回待写库行。节点走 PUT /layout/batch（坐标+zone 隶属）；区域几何走 PATCH /zones/:id/geometry */
  collectSavePayload() {
    const nodes = [...this.dirtyNodes].map(id => {
      const p = this.pos.get(id)!;
      return { node_id: id, x: p.x, y: p.y, zone_id: p.zone, layout_source: p.source, position_locked: p.locked };
    });
    const zones = [...this.dirtyZones].map(zid => {
      const geo = this.zoneGeo.get(zid)!;
      return { zone_id: zid, x: geo.x, y: geo.y, w: geo.w, h: geo.h, collapsed: (geo.collapsed ? 1 : 0) as 0 | 1 };
    });
    return { nodes, zones };
  }
  markSaved() { this.dirtyNodes.clear(); this.dirtyZones.clear(); this.cb.onDirty?.(); }

  /** 区域几何外部回写（PATCH 失败回滚等场景） */
  setZoneGeometry(zid: number, geo: Partial<LiveZoneGeo>) {
    const cur = this.zoneGeo.get(zid) || { collapsed: false, x: null, y: null, w: null, h: null };
    this.zoneGeo.set(zid, { ...cur, ...geo });
  }
  getZoneGeo(zid: number) { return this.zoneGeo.get(zid) || null; }
  /** 区域删除后清本地态（页面确认删除成功后调用） */
  dropZoneLocal(zid: number) {
    this.zoneInfo.delete(zid);
    this.zoneGeo.delete(zid);
    this.dirtyZones.delete(zid);
    for (const [id, p] of this.pos) if (p.zone === zid) this.pos.set(id, { ...p, zone: null });
  }

  /** 锁定/解锁切换（编辑态由页面确认后调用） */
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



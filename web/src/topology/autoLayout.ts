/* AutoLayoutEngine + LayoutMerger —— 确定性自动布局与人工位置合并（纯函数，独立于 G6）
 *
 * 布局模型（区域为主、层级为辅，任务书规则的 combo 友好落地）：
 * - 区域（group_key）是视觉主单元（G6 combo 容器，支持折叠/展开），
 *   区域块自上而下按语义层级排序：internet → firewall → core → dc/office/prod/wireless/other，
 *   满足"互联网接入区必须最上层、防火墙其次、核心居中往下"的红线；
 * - 区域块内部按层级带（BAND_ORDER）从上往下排，块内再体现 core→agg→access 垂直次序；
 * - 簇内 barycenter（邻居重心）排序减少连线交叉；互联对端自然邻近并排（双核心并排）；
 * - 确定性：全部排序带 node_id tie-break，无随机——同一输入永远同一输出；
 * - 人工位置永久保留：layout_source=manual 或 position_locked 的节点原样占位，
 *   auto 节点与其重叠时向右顺延避让，绝不覆盖（LayoutMerger 规则）；
 * - 新设备（DB 无记录）默认 auto 参与摆放，不覆盖任何已有位置。 */

import {
  Band, BAND_ORDER, GroupKey, GROUP_ORDER,
  classifyBands, classifyGroup, ClsNode, ClsLink,
} from './classifier';

export const NODE_W = 190;
export const NODE_H = 52;

export interface SavedNodeLayout {
  x: number; y: number;
  layout_source: 'auto' | 'manual';
  position_locked: boolean;
  group_key?: string | null;
}

export interface PlacedNode {
  node_id: number;
  x: number; y: number; // 中心坐标（与 G6 style.x/y 同一约定）
  band: Band;
  group: GroupKey;
  source: 'auto' | 'manual'; // 最终位置来源
  locked: boolean;
}

export interface AutoLayoutOptions {
  nodeW?: number; nodeH?: number;
  colGap?: number;     // 节点列间距
  rowGap?: number;     // 行间距
  groupPad?: number;   // 区域块内边距（combo 包络留白）
  groupGapX?: number;  // 行内区域块水平间距
  groupGapY?: number;  // 区域块行间距
  maxRowWidth?: number; // 区域块排行的最大宽度（超出换行）
  margin?: number;
}

export interface GroupRect { group: GroupKey; x0: number; y0: number; x1: number; y1: number; count: number }

export interface AutoLayoutResult {
  placed: PlacedNode[];
  groupRects: GroupRect[];
  stats: { total: number; manualKept: number; autoPlaced: number };
}

/* ---------- 内部工具 ---------- */

interface Rect { x: number; y: number; w: number; h: number } // 中心制
const intersects = (a: Rect, b: Rect) =>
  Math.abs(a.x - b.x) < (a.w + b.w) / 2 && Math.abs(a.y - b.y) < (a.h + b.h) / 2;

/** 确定性邻居重心：有已摆放邻居的排前、按重心升序；无邻居按 node_id 兜底 */
function barycenterOrder(ids: number[], adj: Map<number, number[]>, posX: Map<number, number>): number[] {
  const key = (id: number) => {
    const xs = (adj.get(id) || []).map(nb => posX.get(nb)).filter(v => v !== undefined) as number[];
    if (!xs.length) return { has: 1, bc: 0 };
    return { has: 0, bc: xs.reduce((s, v) => s + v, 0) / xs.length };
  };
  return [...ids].sort((a, b) => {
    const ka = key(a), kb = key(b);
    if (ka.has !== kb.has) return ka.has - kb.has;
    if (ka.bc !== kb.bc) return ka.bc - kb.bc;
    return a - b;
  });
}

/* ---------- 主入口 ---------- */

export function autoLayout(
  nodes: ClsNode[],
  links: ClsLink[],
  saved: Map<number, SavedNodeLayout>,
  opts: AutoLayoutOptions = {},
): AutoLayoutResult {
  const nodeW = opts.nodeW ?? NODE_W, nodeH = opts.nodeH ?? NODE_H;
  const colGap = opts.colGap ?? 24, rowGap = opts.rowGap ?? 16;
  const groupPad = opts.groupPad ?? 40;
  const groupGapX = opts.groupGapX ?? 72, groupGapY = opts.groupGapY ?? 88;
  const maxRowWidth = opts.maxRowWidth ?? 2000;
  const margin = opts.margin ?? 80;

  const bands = classifyBands(nodes, links);
  const groupOf = new Map<number, GroupKey>(
    nodes.map(n => [n.node_id, classifyGroup(n, saved.get(n.node_id)?.group_key ?? null)]),
  );

  const adj = new Map<number, number[]>();
  for (const l of links) {
    if (l.a == null || l.b == null) continue;
    if (!adj.has(l.a)) adj.set(l.a, []);
    if (!adj.has(l.b)) adj.set(l.b, []);
    adj.get(l.a)!.push(l.b);
    adj.get(l.b)!.push(l.a);
  }

  const placed = new Map<number, PlacedNode>();
  const occupied: Rect[] = [];
  const posX = new Map<number, number>();

  // 1) 固定约束先落位：manual / locked 的已存节点原样保留
  let manualKept = 0;
  for (const n of nodes) {
    const s = saved.get(n.node_id);
    if (s && Number.isFinite(s.x) && Number.isFinite(s.y) && (s.layout_source === 'manual' || s.position_locked)) {
      placed.set(n.node_id, {
        node_id: n.node_id, x: s.x, y: s.y,
        band: bands.get(n.node_id) ?? 'unlinked',
        group: groupOf.get(n.node_id) ?? 'other',
        source: 'manual', locked: !!s.position_locked,
      });
      occupied.push({ x: s.x, y: s.y, w: nodeW, h: nodeH });
      posX.set(n.node_id, s.x);
      manualKept++;
    }
  }

  // 2) 构建区域块：块内按带顺序（BAND_ORDER）从上往下；带内 barycenter 排序
  const groupRects: GroupRect[] = [];
  let autoPlaced = 0;

  const blocks: { group: GroupKey; rows: number[][]; bandOfRow: Band[]; w: number; h: number }[] = [];
  for (const g of GROUP_ORDER) {
    const ids = nodes.filter(n => !placed.has(n.node_id) && groupOf.get(n.node_id) === g).map(n => n.node_id);
    if (!ids.length) continue;
    // 分带行块
    const rows: number[][] = [];
    const bandOfRow: Band[] = [];
    for (const band of BAND_ORDER) {
      let bandIds = ids.filter(id => bands.get(id) === band);
      if (!bandIds.length) continue;
      bandIds.sort((a, b) => a - b);
      bandIds = barycenterOrder(bandIds, adj, posX);
      const perRow = Math.max(1, Math.min(8, Math.round(Math.sqrt(bandIds.length * 2.4))));
      for (let r = 0; r * perRow < bandIds.length; r++) {
        rows.push(bandIds.slice(r * perRow, (r + 1) * perRow));
        bandOfRow.push(band);
      }
    }
    if (!rows.length) continue;
    const widest = Math.max(...rows.map(r => r.length));
    const w = widest * (nodeW + colGap) - colGap + groupPad * 2;
    const h = rows.length * (nodeH + rowGap) - rowGap + groupPad * 2 + 24; // +24 combo 标题区
    blocks.push({ group: g, rows, bandOfRow, w, h });
  }

  // 3) 区域块排行：主干层级（internet/firewall/core）各占一行严格自上而下（钉层红线），
  //    其余区域按 GROUP_ORDER 在下方贪心打包（宽度超限换行）——全部确定性。
  const SPINE: GroupKey[] = ['internet', 'firewall', 'core'];
  let rowX = margin, rowY = margin, rowMaxH = 0, rowW = 0;
  for (const b of blocks) {
    const spine = SPINE.includes(b.group);
    if (!spine && rowW > 0 && rowX + b.w > maxRowWidth) {
      rowX = margin; rowY += rowMaxH + groupGapY; rowMaxH = 0; rowW = 0;
    }
    if (spine && rowW > 0) { // 主干块前强制换行，保证各层级垂直次序
      rowX = margin; rowY += rowMaxH + groupGapY; rowMaxH = 0; rowW = 0;
    }
    const bx0 = rowX, by0 = rowY;
    // 块内摆放（带次序：第 0 行在最上）
    let ny = by0 + groupPad + 24;
    for (let ri = 0; ri < b.rows.length; ri++) {
      let nx = bx0 + groupPad;
      for (const id of b.rows[ri]) {
        // 与固定占位冲突 → 向右顺延（确定性避让）
        let guard = 0;
        while (guard++ < 80) {
          const hit = occupied.find(o => intersects(o, { x: nx + nodeW / 2, y: ny + nodeH / 2, w: nodeW, h: nodeH }));
          if (!hit) break;
          nx = hit.x + hit.w / 2 + colGap;
        }
        const cx = nx + nodeW / 2, cy = ny + nodeH / 2;
        placed.set(id, { node_id: id, x: cx, y: cy, band: b.bandOfRow[ri], group: b.group, source: 'auto', locked: false });
        occupied.push({ x: cx, y: cy, w: nodeW, h: nodeH });
        posX.set(id, cx);
        autoPlaced++;
        nx += nodeW + colGap;
      }
      ny += nodeH + rowGap;
    }
    // 块矩形（含块内固定节点归属统计）
    const inG = [...placed.values()].filter(p => p.group === b.group);
    if (inG.length) {
      const xs = inG.map(p => p.x), ys = inG.map(p => p.y);
      groupRects.push({
        group: b.group,
        x0: Math.min(...xs) - nodeW / 2 - 16, y0: Math.min(...ys) - nodeH / 2 - 28,
        x1: Math.max(...xs) + nodeW / 2 + 16, y1: Math.max(...ys) + nodeH / 2 + 16,
        count: inG.length,
      });
    }
    rowX += b.w + groupGapX;
    rowW += b.w + groupGapX;
    rowMaxH = Math.max(rowMaxH, b.h);
  }

  return {
    placed: [...placed.values()],
    groupRects: groupRects.sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group)),
    stats: { total: nodes.length, manualKept, autoPlaced },
  };
}

/** 自动布局预览（任务书：不得直接覆盖已保存人工位置，先预览再应用）。
 * 纯计算比对：UI 展示"将移动 N 个 auto 节点、保留 M 个人工/锁定位置、新增 K 个"。 */
export function previewMerge(result: AutoLayoutResult, current: Map<number, SavedNodeLayout>) {
  let willMove = 0, unchanged = 0, fresh = 0;
  for (const p of result.placed) {
    if (p.source === 'manual') { unchanged++; continue; }
    const cur = current.get(p.node_id);
    if (!cur) fresh++;
    else if (cur.layout_source === 'auto' && Math.abs(cur.x - p.x) < 0.5 && Math.abs(cur.y - p.y) < 0.5) unchanged++;
    else willMove++;
  }
  return { willMove, unchanged, fresh, manualKept: result.stats.manualKept };
}

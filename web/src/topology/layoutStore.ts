/* LayoutPersistence —— 布局读写（DB 是布局唯一存储；G6 只是渲染器，绝不作为唯一来源） */

import { topoApi } from '../api';
import { SavedNodeLayout } from './autoLayout';
import { GroupKey, GROUP_ORDER } from './classifier';

export interface SavedGroupLayout {
  group_key: string;
  label: string;
  collapsed: boolean;
  x: number | null; y: number | null; w: number | null; h: number | null; // null=按成员自动包络
}

export interface LayoutSnapshot {
  nodes: Map<number, SavedNodeLayout>;
  groups: Map<string, SavedGroupLayout>;
  meta: { node_layout_count: number; group_count: number };
}

export async function loadLayout(): Promise<LayoutSnapshot> {
  const j = await topoApi.layoutGet();
  const nodes = new Map<number, SavedNodeLayout>();
  for (const r of (j.data?.nodes || [])) {
    if (!Number.isFinite(r.x) || !Number.isFinite(r.y)) continue;
    nodes.set(+r.node_id, {
      x: +r.x, y: +r.y,
      layout_source: r.layout_source === 'manual' ? 'manual' : 'auto',
      position_locked: !!r.position_locked,
      group_key: r.group_key || null,
    });
  }
  const groups = new Map<string, SavedGroupLayout>();
  for (const g of (j.data?.groups || [])) {
    groups.set(String(g.group_key), {
      group_key: String(g.group_key),
      label: String(g.label || g.group_key),
      collapsed: !!g.collapsed,
      x: g.x == null ? null : +g.x, y: g.y == null ? null : +g.y,
      w: g.w == null ? null : +g.w, h: g.h == null ? null : +g.h,
    });
  }
  return { nodes, groups, meta: j.meta || { node_layout_count: 0, group_count: 0 } };
}

/** 只回写有变化的节点（增量保存，≤2000/批） */
export async function saveNodes(rows: {
  node_id: number; x: number; y: number; group_key?: string | null;
  layout_source: 'auto' | 'manual'; position_locked: boolean;
}[], operator: string) {
  if (!rows.length) return { ok: true, upserted: 0 };
  return topoApi.layoutSave(rows, operator);
}

export async function saveGroups(rows: SavedGroupLayout[], operator: string) {
  if (!rows.length) return { ok: true, upserted: 0 };
  return topoApi.layoutGroups(rows.map(g => ({
    group_key: g.group_key, label: g.label, collapsed: g.collapsed ? 1 : 0,
    x: g.x, y: g.y, w: g.w, h: g.h,
  })), operator);
}

/** 显式重置（唯一清除人工布局的入口，UI 必须二次确认后才调用） */
export async function resetLayout(operator: string) {
  return topoApi.layoutReset(operator);
}

export function knownGroupKeys(): GroupKey[] { return GROUP_ORDER; }

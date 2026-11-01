/* LayoutPersistence —— 布局读写（DB 是布局唯一存储；G6 只是渲染器，绝不作为唯一来源）
 * V2 Phase 2：区域（zone）是管理员资产——读写走 /zones* 端点；
 * 节点坐标+区域隶属走 PUT /layout/batch；旧 groups 仅作未迁移生产环境的过渡 shim。 */

import { topoApi } from '../api';
import { SavedNodeLayout } from './autoLayout';
import { GroupKey, GROUP_ORDER } from './classifier';

export interface SavedGroupLayout {
  group_key: string;
  label: string;
  collapsed: boolean;
  x: number | null; y: number | null; w: number | null; h: number | null; // null=按成员自动包络
}

/** V2 区域（topology_zone 行；语义字段 + 几何字段） */
export interface ZoneInfo {
  zone_id: number;
  name: string;
  bg_color: string | null;
  border_color: string | null;
  border_style: 'solid' | 'dashed' | 'none';
  border_width: number;
  parent_zone_id: number | null;
  note: string | null;
  collapsed: boolean;
  x: number | null; y: number | null; w: number | null; h: number | null; // null=按成员自动包络
  sort_hint: number;
  member_count?: number;
}

export interface LayoutSnapshot {
  nodes: Map<number, SavedNodeLayout & { zone_id?: number | null }>;
  nodeZoneOf: Map<number, number>; // 无坐标行（members 接口补建）也保留 zone 隶属：id→zone_id
  groups: Map<string, SavedGroupLayout>; // 兼容 shim（zone 存在时为其投影 z<id>）
  zones: Map<number, ZoneInfo>;
  meta: { node_layout_count: number; group_count: number; zone_count?: number };
}

export async function loadLayout(): Promise<LayoutSnapshot> {
  const j = await topoApi.layoutGet();
  const nodes = new Map<number, SavedNodeLayout & { zone_id?: number | null }>();
  const nodeZoneOf = new Map<number, number>();
  for (const r of (j.data?.nodes || [])) {
    if (r.zone_id != null && Number.isFinite(+r.zone_id)) nodeZoneOf.set(+r.node_id, +r.zone_id);
    if (!Number.isFinite(r.x) || !Number.isFinite(r.y)) continue;
    nodes.set(+r.node_id, {
      x: +r.x, y: +r.y,
      layout_source: r.layout_source === 'manual' ? 'manual' : 'auto',
      position_locked: !!r.position_locked,
      group_key: r.group_key || null,
      zone_id: r.zone_id == null ? null : +r.zone_id,
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
  const zones = new Map<number, ZoneInfo>();
  for (const z of (j.data?.zones || [])) {
    zones.set(+z.zone_id, {
      zone_id: +z.zone_id,
      name: String(z.name || ''),
      bg_color: z.bg_color ?? null,
      border_color: z.border_color ?? null,
      border_style: ['solid', 'dashed', 'none'].includes(z.border_style) ? z.border_style : 'solid',
      border_width: Number.isFinite(+z.border_width) ? +z.border_width : 1,
      parent_zone_id: z.parent_zone_id == null ? null : +z.parent_zone_id,
      note: z.note ?? null,
      collapsed: !!z.collapsed,
      x: z.x == null ? null : +z.x, y: z.y == null ? null : +z.y,
      w: z.w == null ? null : +z.w, h: z.h == null ? null : +z.h,
      sort_hint: Number.isFinite(+z.sort_hint) ? +z.sort_hint : 0,
      member_count: z.member_count == null ? undefined : +z.member_count,
    });
  }
  return { nodes, nodeZoneOf, groups, zones, meta: j.meta || { node_layout_count: 0, group_count: 0 } };
}

/** 只回写有变化的节点（增量保存，≤2000/批）。V2：操作者由服务端会话决定，前端不再自报 operator */
export async function saveNodes(rows: {
  node_id: number; x: number; y: number; group_key?: string | null;
  layout_source: 'auto' | 'manual'; position_locked: boolean;
}[]) {
  if (!rows.length) return { ok: true, upserted: 0 };
  return topoApi.layoutSave(rows);
}

/** V2 Phase 2 主保存通道：坐标 + 区域隶属批量写（行可带 zone_id；x/y 可为 null=新入区未定位） */
export async function saveLayoutBatch(rows: {
  node_id: number; x: number | null; y: number | null;
  zone_id?: number | null;
  layout_source?: 'auto' | 'manual'; position_locked?: boolean;
}[]) {
  if (!rows.length) return { ok: true, upserted: 0 };
  return topoApi.layoutBatch(rows);
}

/** 旧 group 通道（仅未迁移生产环境回退路径会用；zone 模式下不再写） */
export async function saveGroups(rows: SavedGroupLayout[]) {
  if (!rows.length) return { ok: true, upserted: 0 };
  return topoApi.layoutGroups(rows.map(g => ({
    group_key: g.group_key, label: g.label, collapsed: g.collapsed ? 1 : 0,
    x: g.x, y: g.y, w: g.w, h: g.h,
  })));
}

/* ---------- V2 区域端点封装（语义走 POST/PUT，几何走 PATCH，成员走 members/batch） ---------- */

export async function fetchZones(withMembers = false) {
  const j = await topoApi.zonesGet(withMembers);
  const zones = new Map<number, ZoneInfo>();
  for (const z of (j.data?.zones || [])) {
    zones.set(+z.zone_id, {
      zone_id: +z.zone_id,
      name: String(z.name || ''),
      bg_color: z.bg_color ?? null,
      border_color: z.border_color ?? null,
      border_style: ['solid', 'dashed', 'none'].includes(z.border_style) ? z.border_style : 'solid',
      border_width: Number.isFinite(+z.border_width) ? +z.border_width : 1,
      parent_zone_id: z.parent_zone_id == null ? null : +z.parent_zone_id,
      note: z.note ?? null,
      collapsed: !!z.collapsed,
      x: z.x == null ? null : +z.x, y: z.y == null ? null : +z.y,
      w: z.w == null ? null : +z.w, h: z.h == null ? null : +z.h,
      sort_hint: Number.isFinite(+z.sort_hint) ? +z.sort_hint : 0,
      member_count: z.member_count == null ? undefined : +z.member_count,
    });
  }
  return zones;
}

export interface ZoneSuggestion { node_ids: number[]; suggested_name: string; size: number }

export async function fetchZoneSuggestions(): Promise<{ list: ZoneSuggestion[]; note: string }> {
  const j = await topoApi.zonesSuggestions();
  return {
    list: (j.data || []).map((d: any) => ({ node_ids: d.node_ids.map(Number), suggested_name: String(d.suggested_name), size: +d.size })),
    note: String(j.meta?.note || ''),
  };
}

export const createZone = (body: any) => topoApi.createZone(body) as Promise<{ ok: boolean; zone: any }>;
export const updateZone = (id: number, body: any) => topoApi.updateZone(id, body) as Promise<{ ok: boolean; zone: any }>;
export const patchZoneGeometry = (id: number, body: { x?: number | null; y?: number | null; w?: number | null; h?: number | null; collapsed?: 0 | 1 }) =>
  topoApi.patchZoneGeometry(id, body);
export const deleteZone = (id: number) => topoApi.deleteZone(id);
export const addZoneMembers = (id: number, node_ids: number[]) => topoApi.addMembers(id, node_ids);

/** 显式重置（唯一清除人工布局的入口，UI 必须二次确认后才调用；重置前服务端自动打快照护栏） */
export async function resetLayout() {
  return topoApi.layoutReset();
}

export function knownGroupKeys(): GroupKey[] { return GROUP_ORDER; }

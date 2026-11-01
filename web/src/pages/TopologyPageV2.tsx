/* 网络拓扑 V2 —— 全局共享布局（G6 渲染 + DB 布局唯一存储）
 * V2 Phase 2：区域（zone）= 管理员资产。空画布不出现任何自动区域；
 * 区域由管理员手工创建（建区/改名/颜色/边框/note/拖动/缩放/折叠/成员入区），全部持久 DB。
 * 红线：连线只来自真实 LLDP/人工证据；区域绝不自动创建（suggestions 只读，人工采纳才建行）；
 * 布局不伪造；人工位置永久保留；自动布局先预览再应用。 */
import React from 'react';
import { topoApi, usePoll } from '../api';
import { ago } from '../components/common';
import { TopoG6View, LivePos, TopoLinkV2 } from '../components/TopoG6Canvas';
import { PanelBody } from '../components/TopologyPanelBody';
import { TrafficDrawer } from './TopologyPage';
import '../components/topo-g6.css';
import { classifyGroup } from '../topology/classifier';
import { autoLayout, previewMerge, SavedNodeLayout } from '../topology/autoLayout';
import {
  loadLayout, saveLayoutBatch, resetLayout,
  fetchZones, fetchZoneSuggestions, createZone, updateZone, patchZoneGeometry, deleteZone, addZoneMembers,
  ZoneInfo, ZoneSuggestion,
} from '../topology/layoutStore';
import { useTopoAuth } from '../topology/useTopoAuth';
import { TopoAuthBar } from '../components/TopoAuthBar';

type SelV2 = { kind: 'node' | 'edge'; id: number } | null;

/** 建区配色预设（参考图式彩色区域） */
const ZONE_PRESETS = [
  { name: '蓝', bg: '#3B82F6' }, { name: '绿', bg: '#10B981' }, { name: '橙', bg: '#F59E0B' }, { name: '红', bg: '#EF4444' },
  { name: '紫', bg: '#8B5CF6' }, { name: '青', bg: '#22D3EE' }, { name: '粉', bg: '#EC4899' }, { name: '灰', bg: '#71717A' },
];

interface ZoneFormState {
  mode: 'create' | 'edit';
  zone_id?: number;
  name: string; bg_color: string; border_color: string;
  border_style: 'solid' | 'dashed' | 'none'; border_width: number;
  note: string; parent_zone_id: number | null;
}

export default function TopologyPageV2(_: any) {
  const [busy, setBusy] = React.useState('');
  const [msg, setMsg] = React.useState('');
  // V2 §10：operator 自报退役——操作者=登录会话，写操作要求 admin（后端 401/403 是真正闸门）
  const auth = useTopoAuth();
  const canWrite = auth.authed && auth.role === 'admin';

  const { data: graph, reload: reloadGraph, err: graphErr } = usePoll(() => topoApi.graph('conflict'), 90000);
  const { data: summary } = usePoll(() => topoApi.discoverySummary(), 90000);
  const nodes = graph?.data?.nodes || [];
  const links: TopoLinkV2[] = graph?.data?.links || [];

  /* ---------- 画布与布局状态（页面是布局状态的唯一持有者，DB 是唯一存储） ---------- */
  const hostRef = React.useRef<HTMLDivElement | null>(null);
  const viewRef = React.useRef<TopoG6View | null>(null);
  const posRef = React.useRef<Map<number, LivePos>>(new Map());
  const initedRef = React.useRef(false);
  const [zonesMap, setZonesMap] = React.useState<Map<number, ZoneInfo>>(new Map());
  const [editable, setEditable] = React.useState(false);
  const [dirty, setDirty] = React.useState({ nodes: 0, zones: 0 });
  const [focus, setFocus] = React.useState(0);
  const [sel, setSel] = React.useState<SelV2>(null);
  const [tab, setTab] = React.useState<'detail' | 'zones' | 'neighbors' | 'unlinked'>('detail');
  const [trafficLink, setTrafficLink] = React.useState<TopoLinkV2 | null>(null);
  const [searchQ, setSearchQ] = React.useState('');
  const [preview, setPreview] = React.useState<null | { stats: any; rows: any[] }>(null);
  const [confirmReset, setConfirmReset] = React.useState(false);
  const [loadErr, setLoadErr] = React.useState('');
  // 区域管理 UI 状态
  const [zoneForm, setZoneForm] = React.useState<ZoneFormState | null>(null);
  const [confirmDelZone, setConfirmDelZone] = React.useState<ZoneInfo | null>(null);
  const [suggestions, setSuggestions] = React.useState<{ list: ZoneSuggestion[]; note: string } | null>(null);
  const [zoneFilterQ, setZoneFilterQ] = React.useState('');
  const [picked, setPicked] = React.useState<Set<number>>(new Set()); // 未分区设备勾选
  const [targetZone, setTargetZone] = React.useState<number | null>(null);

  const say = (s: string) => { setMsg(s); setTimeout(() => setMsg(''), 6000); };

  /* 初始化画布 */
  React.useEffect(() => {
    if (!hostRef.current || viewRef.current) return;
    hostRef.current.id = 'tg6-host'; // E2E 定位用（稳定 id）
    viewRef.current = new TopoG6View(hostRef.current, {
      onNodeClick: (nid) => { setSel({ kind: 'node', id: nid }); setFocus(nid); setTab('detail'); },
      onEdgeClick: (lid) => { setSel({ kind: 'edge', id: lid }); setTab('detail'); },
      onZoneToggle: () => setDirty(viewRef.current!.dirtyCount),
      onDirty: () => setDirty(viewRef.current!.dirtyCount),
    });
    return () => { viewRef.current?.destroy(); viewRef.current = null; };
  }, []);

  /* graph 同步进 pos（保留已有位置；新设备自动布局且不覆盖已有位置）；zones 从 DB 灌入 */
  React.useEffect(() => {
    const view = viewRef.current;
    if (!view || !nodes.length || initedRef.current) return;
    (async () => {
      try {
        const snap = await loadLayout();
        const clsLinks = links.map(l => ({ a: l.a, b: l.b }));
        if (snap.nodes.size === 0) {
          // 首次：全量自动布局（zone 隶属一律 null——空画布没有任何自动区域，红线）
          const res = autoLayout(nodes, clsLinks, new Map());
          posRef.current = new Map(res.placed.map(p => [p.node_id, { x: p.x, y: p.y, source: 'auto', locked: false, group: p.group, zone: null }]));
        } else {
          // 已有 DB 布局：全部已存行视为固定占位，仅新设备参与摆放（新设备不覆盖已有位置）
          const fakeSaved = new Map<number, SavedNodeLayout>();
          for (const [id, s] of snap.nodes) fakeSaved.set(id, { ...s, layout_source: 'manual' });
          const res = autoLayout(nodes, clsLinks, fakeSaved);
          posRef.current = new Map();
          for (const p of res.placed) {
            const zone = snap.nodeZoneOf.get(p.node_id) ?? null;
            const s = snap.nodes.get(p.node_id);
            if (s) posRef.current.set(p.node_id, { x: s.x, y: s.y, source: s.layout_source, locked: s.position_locked, group: classifyGroup({ node_id: p.node_id, display_name: (nodes.find((n: any) => n.node_id === p.node_id) || {}).display_name }, s.group_key), zone });
            else posRef.current.set(p.node_id, { x: p.x, y: p.y, source: 'auto', locked: false, group: p.group, zone });
          }
        }
        setZonesMap(new Map(snap.zones));
        initedRef.current = true;
        view.setData(nodes, links, snap.zones, posRef.current);
        requestAnimationFrame(() => view.fitAll());
      } catch (e: any) {
        setLoadErr(`布局加载失败：${e.message}（画布空白≠数据丢失，请检查 topology-svc 是否运行）`);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph]);

  React.useEffect(() => { viewRef.current?.setEditable(editable); }, [editable]);

  /* ---------- 区域刷新（CRUD 后统一走这里；画布 setZones 保留本地未保存几何） ---------- */
  const refreshZones = async () => {
    const zs = await fetchZones();
    setZonesMap(zs);
    viewRef.current?.setZones(zs);
    return zs;
  };

  /* ---------- 区域 CRUD ---------- */
  const openCreateZone = () => {
    setZoneForm({ mode: 'create', name: '', bg_color: ZONE_PRESETS[0].bg, border_color: ZONE_PRESETS[0].bg, border_style: 'solid', border_width: 2, note: '', parent_zone_id: null });
  };
  const openEditZone = (z: ZoneInfo) => {
    setZoneForm({ mode: 'edit', zone_id: z.zone_id, name: z.name, bg_color: z.bg_color || '#3B82F6', border_color: z.border_color || z.bg_color || '#3B82F6', border_style: z.border_style, border_width: z.border_width, note: z.note || '', parent_zone_id: z.parent_zone_id });
  };
  const submitZoneForm = async () => {
    if (!zoneForm) return;
    const f = zoneForm;
    if (!f.name.trim()) { say('区域名称必填'); return; }
    setBusy('区域');
    try {
      if (f.mode === 'create') {
        // 新区域默认摆在当前视口中心、给一个规整的初始框（之后可拖动/缩放手柄调整）
        const [cx, cy] = viewRef.current?.viewportCenter() || [0, 0];
        const r = await createZone({ name: f.name.trim(), bg_color: f.bg_color, border_color: f.border_color, border_style: f.border_style, border_width: f.border_width, note: f.note || null, parent_zone_id: f.parent_zone_id, x: cx, y: cy, w: 420, h: 280 });
        say(`区域「${r.zone.name}」已创建并持久化（拖动卡片入框 / 右侧勾选设备入区）`);
      } else {
        await updateZone(f.zone_id!, { name: f.name.trim(), bg_color: f.bg_color, border_color: f.border_color, border_style: f.border_style, border_width: f.border_width, note: f.note || null, parent_zone_id: f.parent_zone_id });
        say(`区域已更新（立即持久）`);
      }
      await refreshZones();
      setZoneForm(null);
    } catch (e: any) { say(`区域操作失败：${e.message}`); }
    finally { setBusy(''); }
  };
  const doDeleteZone = async (z: ZoneInfo) => {
    setBusy('区域');
    try {
      await deleteZone(z.zone_id);
      viewRef.current?.dropZoneLocal(z.zone_id);
      for (const [id, p] of posRef.current) if (p.zone === z.zone_id) posRef.current.set(id, { ...p, zone: null });
      await refreshZones();
      say(`区域「${z.name}」已删除，成员设备转为未分区（坐标保留）`);
    } catch (e: any) { say(`删除失败：${e.message}`); }
    finally { setBusy(''); setConfirmDelZone(null); }
  };
  const loadSuggestions = async () => {
    setBusy('建议');
    try {
      const s = await fetchZoneSuggestions();
      setSuggestions(s);
      if (!s.list.length) say('没有可聚合的未分区连通簇（未分区设备间没有已确认链路）');
    } catch (e: any) { say(`获取建议失败：${e.message}`); }
    finally { setBusy(''); }
  };
  const adoptSuggestion = async (s: ZoneSuggestion) => {
    setBusy('采纳');
    try {
      const [cx, cy] = viewRef.current?.viewportCenter() || [0, 0];
      const r = await createZone({ name: s.suggested_name, bg_color: '#3B82F6', border_color: '#3B82F6', border_style: 'solid', border_width: 2, note: `由连通簇建议采纳（${s.size} 台）`, x: cx, y: cy, w: 420, h: 280 });
      const zid = r.zone.zone_id;
      const m = await addZoneMembers(zid, s.node_ids);
      await refreshZones();
      viewRef.current?.setNodeZones(s.node_ids.map(id => ({ node_id: id, zone: zid })));
      for (const id of s.node_ids) { const p = posRef.current.get(id); if (p) posRef.current.set(id, { ...p, zone: zid }); }
      setSuggestions(prev => prev ? { ...prev, list: prev.list.filter(x => x !== s) } : prev);
      say(`已采纳：建区「${r.zone.name}」并入 ${m.moved} 台（missing ${m.missing.length}）——刷新/换浏览器一致`);
    } catch (e: any) { say(`采纳失败：${e.message}`); }
    finally { setBusy(''); }
  };
  const addPickedToTarget = async () => {
    if (targetZone == null || !picked.size) { say('先勾选设备并选择目标区域'); return; }
    setBusy('入区');
    try {
      const ids = [...picked];
      const r = await addZoneMembers(targetZone, ids);
      await refreshZones();
      viewRef.current?.setNodeZones(ids.map(id => ({ node_id: id, zone: targetZone })));
      for (const id of ids) { const p = posRef.current.get(id); if (p) posRef.current.set(id, { ...p, zone: targetZone }); }
      setPicked(new Set());
      say(`${r.moved} 台设备已加入区域（坐标保留；missing ${r.missing.length}）`);
    } catch (e: any) { say(`入区失败：${e.message}`); }
    finally { setBusy(''); }
  };

  /* ---------- 工具栏动作 ---------- */
  const runAutoLayout = () => {
    const saved = new Map<number, SavedNodeLayout>();
    for (const [id, p] of posRef.current) saved.set(id, { x: p.x, y: p.y, layout_source: p.source, position_locked: p.locked, group_key: p.group });
    const res = autoLayout(nodes, links.map(l => ({ a: l.a, b: l.b })), saved);
    const rows = res.placed.filter(p => p.source === 'auto').map(p => ({ node_id: p.node_id, x: p.x, y: p.y, group: p.group, source: 'auto' as const, locked: false }));
    const stats = previewMerge(res, saved);
    setPreview({ stats, rows });
  };
  const applyPreview = () => {
    if (!preview) return;
    viewRef.current?.applyPositions(preview.rows);
    preview.rows.forEach(r => {
      const cur = posRef.current.get(r.node_id);
      posRef.current.set(r.node_id, { x: r.x, y: r.y, source: 'auto', locked: false, group: r.group, zone: cur?.zone ?? null });
    });
    setDirty(viewRef.current!.dirtyCount);
    say(`已应用自动布局（${preview.rows.length} 个自动节点重排；人工/锁定位置与区域归属未动）——点「保存布局」写入数据库`);
    setPreview(null);
  };
  const doSave = async () => {
    const payload = viewRef.current!.collectSavePayload();
    if (!payload.nodes.length && !payload.zones.length) { say('没有待保存的变更'); return; }
    setBusy('保存');
    try {
      if (payload.nodes.length) await saveLayoutBatch(payload.nodes);
      for (const z of payload.zones) await patchZoneGeometry(z.zone_id, { x: z.x, y: z.y, w: z.w, h: z.h, collapsed: z.collapsed });
      viewRef.current!.markSaved();
      say(`布局已保存（节点 ${payload.nodes.length}、区域几何 ${payload.zones.length}）——刷新/换浏览器一致`);
    } catch (e: any) { say(`保存失败：${e.message}`); }
    finally { setBusy(''); }
  };
  const doReset = async () => {
    setConfirmReset(false); setBusy('重置');
    try {
      await resetLayout(); // 服务端：布局+区域全部清除（pre-reset 快照护栏已内置）
      initedRef.current = false;
      posRef.current = new Map();
      setZonesMap(new Map()); setSuggestions(null); setPicked(new Set());
      viewRef.current?.setData([], [], new Map(), new Map());
      say('已重置：人工布局与全部区域已清除（快照可找回），即将重新自动布局');
      reloadGraph();
    } catch (e: any) { say(`重置失败：${e.message}`); }
    finally { setBusy(''); }
  };
  const toggleLock = () => {
    if (!sel || sel.kind !== 'node') { say('先在图上选中设备卡片'); return; }
    const p = posRef.current.get(sel.id);
    if (!p) return;
    viewRef.current!.setLocked(sel.id, !p.locked);
    posRef.current.set(sel.id, { ...p, locked: !p.locked });
    say(p.locked ? '已解锁位置' : '已锁定位置（自动布局不再移动它）');
  };
  const collapseAllZones = (collapsed: boolean) => {
    if (!zonesMap.size) { say('还没有区域（区域由管理员创建，系统不自动生成）'); return; }
    viewRef.current?.setZonesCollapsed(new Map([...zonesMap.keys()].map(zid => [zid, collapsed])));
    setDirty(viewRef.current!.dirtyCount);
  };
  const locate = (nid: number) => { viewRef.current?.focusNode(nid); setSel({ kind: 'node', id: nid }); setFocus(nid); setSearchQ(''); };
  const focusZone = (zid: number) => { try { void viewRef.current?.graph.focusElement(('Z' + zid) as any, { duration: 350 } as any); } catch { /* noop */ } };

  const hits = searchQ
    ? nodes.filter((n: any) => (n.display_name || '').toLowerCase().includes(searchQ.toLowerCase()) || (n.mgmt_ip || '').includes(searchQ)).slice(0, 15)
    : [];
  const byId = new Map<number, any>(nodes.map((n: any) => [n.node_id, n]));
  const linkById = new Map<number, TopoLinkV2>(links.map(l => [l.link_id, l]));
  const manualCount = [...posRef.current.values()].filter(p => p.source === 'manual' || p.locked).length;
  const unassigned = nodes
    .filter((n: any) => posRef.current.get(n.node_id)?.zone == null)
    .filter((n: any) => !zoneFilterQ || (n.display_name || '').toLowerCase().includes(zoneFilterQ.toLowerCase()) || (n.mgmt_ip || '').includes(zoneFilterQ))
    .sort((a: any, b: any) => (a.display_name || '').localeCompare(b.display_name || ''));
  const zoneList = [...zonesMap.values()].sort((a, b) => a.sort_hint - b.sort_hint || a.zone_id - b.zone_id);
  const zoneMemberCount = (zid: number) => {
    const c = [...posRef.current.values()].filter(p => p.zone === zid).length;
    return Math.max(c, zonesMap.get(zid)?.member_count ?? 0);
  };

  /* PanelBody 依赖 canvas 查询接口——给一个基于图数据的 shim */
  const shimRef = React.useRef<any>(null);
  shimRef.current = {
    unlinkedNodes: () => nodes.filter((n: any) => !links.some(l => l.a === n.node_id || l.b === n.node_id)),
    linksOf: (nid: number) => links.filter(l => l.a === nid || l.b === nid),
    extSnapshot: () => null,
  };

  return (
    <div>
      <div className="stat-row">
        <div className="card"><div className="stat-num">{nodes.length || '—'}</div><div className="stat-label">纳管节点（降级 {summary?.data?.nodes_degraded ?? '—'}）</div></div>
        <div className="card"><div className="stat-num" style={{ color: 'var(--dom-network)' }}>{links.length || 0}</div><div className="stat-label">真实证据链路</div></div>
        <div className="card"><div className="stat-num">{zoneList.length}</div><div className="stat-label">区域（管理员资产）</div></div>
        <div className="card"><div className="stat-num">{manualCount || 0}</div><div className="stat-label">人工/锁定位置（DB 持久）</div></div>
        <div className="card"><div className="stat-num" style={{ color: dirty.nodes + dirty.zones ? 'var(--sev-warning)' : undefined }}>{dirty.nodes + dirty.zones || 0}</div><div className="stat-label">未保存布局变更</div></div>
      </div>

      {!nodes.length && (
        <div className="card" style={{ marginBottom: 14, color: 'var(--text-2)' }}>
          拓扑库为空或 topology-svc（:8790）未运行。
          {graphErr && <div style={{ color: 'var(--sev-critical)', marginTop: 6 }}>{graphErr}</div>}
        </div>
      )}
      {loadErr && <div className="card" style={{ marginBottom: 14, color: 'var(--sev-critical)' }}>{loadErr}</div>}

      <div className="grid-3" style={{ gridTemplateColumns: 'minmax(0,1fr) 372px' }}>
        <div className="card" style={{ padding: '12px 14px' }}>
          <div className="toolbar" style={{ position: 'relative', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
            <span className="card-title" style={{ margin: 0 }}>全局拓扑图 V2
              <span style={{ color: 'var(--text-3)', fontSize: 11, marginLeft: 8 }}>G6 · 彩色区域=管理员手工资产 · 布局存数据库（跨浏览器共享）</span>
            </span>
            <span className="spacer" style={{ flex: 1 }} />
            <TopoAuthBar compact />
            <div style={{ position: 'relative' }}>
              <input placeholder="搜索设备（名称/IP）定位" value={searchQ} onChange={e => setSearchQ(e.target.value)} style={{ width: 190, fontSize: 12 }} />
              {searchQ && (
                <div className="tc-searchlist">
                  {hits.length ? hits.map((n: any) => (
                    <div key={n.node_id} className="it" onClick={() => locate(n.node_id)}>
                      <div>{n.display_name}</div><div className="s mono">{n.mgmt_ip || '—'} · 节点 #{n.node_id}</div>
                    </div>
                  )) : <div className="it"><div className="s">无匹配</div></div>}
                </div>
              )}
            </div>
            <button className={`btn ${editable ? 'primary' : ''}`} disabled={!canWrite} onClick={() => setEditable(v => !v)} title={canWrite ? '编辑态：可拖动设备卡片/区域框、拖拽区域右下角缩放（改动即人工布局，保存后永久保留）' : '写操作需管理员登录'}>
              {editable ? '✎ 编辑中' : '编辑布局'}
            </button>
            <button className="btn" disabled={!canWrite} onClick={openCreateZone} title={canWrite ? '新建彩色区域（空画布不自动生成区域——只有手工建的才出现）' : '需管理员登录'}>＋ 新建区域</button>
            <button className="btn" disabled={!canWrite || !!busy} onClick={loadSuggestions} title="按未分区设备间已确认链路聚类给参考建议；只读不落库，人工点采纳才建区（红线：不自动创建区域）">连通建议…</button>
            <button className="btn" onClick={runAutoLayout} disabled={!nodes.length}>自动布局…</button>
            <button className="btn" onClick={doSave} disabled={!canWrite || !!busy || (!dirty.nodes && !dirty.zones)} title={canWrite ? '保存节点坐标/区域隶属 + 区域几何（PATCH geometry）' : '需管理员登录'}>保存布局{dirty.nodes + dirty.zones ? ` (${dirty.nodes + dirty.zones})` : ''}</button>
            <button className="btn" onClick={toggleLock} disabled={!canWrite || !sel || sel.kind !== 'node'} title="锁定后自动布局不再移动该设备">
              {sel && sel.kind === 'node' && posRef.current.get(sel.id)?.locked ? '解锁位置' : '锁定位置'}
            </button>
            <button className="btn" onClick={() => collapseAllZones(true)} disabled={!zoneList.length}>全部折叠</button>
            <button className="btn" onClick={() => collapseAllZones(false)} disabled={!zoneList.length}>全部展开</button>
            <button className="btn" onClick={() => viewRef.current?.fitAll()}>适应画布</button>
            <button className="btn" onClick={() => viewRef.current?.enterFullscreen()}>全屏</button>
            <button className="btn" style={{ color: 'var(--sev-critical)' }} disabled={!canWrite} onClick={() => setConfirmReset(true)} title={canWrite ? '清除全部人工布局与全部区域（pre-reset 快照护栏，可找回）' : '需管理员登录'}>重置布局</button>
            <a className="btn" href="#/topology-legacy" style={{ textDecoration: 'none' }} title="回滚通道：旧 ELK 版拓扑页">旧版</a>
            {msg && <span style={{ fontSize: 12, color: 'var(--sev-info)' }}>{msg}</span>}
          </div>
          <div className="tg6-wrap"><div ref={hostRef} className="tg6-host" />
            <div className="tg6-legend">
              <div className="row"><span className="tc-swatch" />已确认链路（双端证据）</div>
              <div className="row"><span className="tc-swatch half" />单端发现（half）</div>
              <div className="row">彩色框=管理员手工区域（双击折叠 · 编辑态拖框移动、右下角手柄缩放）</div>
              <div className="row">🔒=位置锁定 ✎=人工位置（自动布局不会移动）</div>
            </div>
            <div className="tg6-hint">滚轮缩放 · 空白处拖拽平移 · 双击区域框折叠/展开 · 编辑态拖卡片入/出区域框=改隶属 · 点卡片看详情 · 点链路看 LLDP 证据</div>
          </div>
        </div>

        <div className="card" style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div className="tc-tabs">
            <button className={tab === 'detail' ? 'on' : ''} onClick={() => setTab('detail')}>详情</button>
            <button className={tab === 'zones' ? 'on' : ''} onClick={() => setTab('zones')}>区域管理</button>
            <button className={tab === 'neighbors' ? 'on' : ''} onClick={() => setTab('neighbors')}>邻居展开</button>
            <button className={tab === 'unlinked' ? 'on' : ''} onClick={() => setTab('unlinked')}>未关联设备</button>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', maxHeight: 640 }}>
            {tab === 'zones' ? (
              <div className="tc-zones">
                {/* 区域列表：编辑/删除/定位 */}
                <div className="tc-sec-title">区域（{zoneList.length}）<span className="s">手工资产 · 立即持久</span></div>
                {!zoneList.length && <div className="tc-empty">还没有区域。点工具栏「＋ 新建区域」或「连通建议…」采纳一个。空画布不会出现任何自动区域（红线）。</div>}
                {zoneList.map(z => (
                  <div key={z.zone_id} className="tc-zone">
                    <span className="tc-zswatch" style={{ background: z.bg_color || '#3B82F6', borderStyle: z.border_style === 'none' ? 'hidden' : z.border_style }} />
                    <div className="tc-zinfo" onClick={() => focusZone(z.zone_id)} title="点击定位到该区域">
                      <div>{z.name} <span className="s">· {zoneMemberCount(z.zone_id)} 台{z.parent_zone_id ? ` · 子区#${z.parent_zone_id}` : ''}{z.collapsed ? ' · 已折叠' : ''}</span></div>
                      {z.note && <div className="s">{z.note}</div>}
                    </div>
                    <button className="btn mini" disabled={!canWrite} onClick={() => openEditZone(z)}>编辑</button>
                    <button className="btn mini" style={{ color: 'var(--sev-critical)' }} disabled={!canWrite} onClick={() => setConfirmDelZone(z)}>删除</button>
                  </div>
                ))}

                {/* 未分区设备 → 勾选加入目标区域（服务端 POST members，立即持久） */}
                <div className="tc-sec-title" style={{ marginTop: 14 }}>未分区设备（{unassigned.length}）<span className="s">勾选后加入目标区域</span></div>
                <div style={{ display: 'flex', gap: 6, margin: '6px 0' }}>
                  <input placeholder="过滤名称/IP" value={zoneFilterQ} onChange={e => setZoneFilterQ(e.target.value)} style={{ flex: 1, fontSize: 12 }} />
                  <select value={targetZone ?? ''} onChange={e => setTargetZone(e.target.value ? +e.target.value : null)} style={{ fontSize: 12, maxWidth: 150 }}>
                    <option value="">目标区域…</option>
                    {zoneList.map(z => <option key={z.zone_id} value={z.zone_id}>{z.name}</option>)}
                  </select>
                  <button className="btn primary mini" disabled={!canWrite || !picked.size || targetZone == null || !!busy} onClick={addPickedToTarget}>加入（{picked.size}）</button>
                </div>
                <div className="tc-picklist">
                  {unassigned.slice(0, 200).map((n: any) => (
                    <label key={n.node_id} className="tc-pick">
                      <input type="checkbox" checked={picked.has(n.node_id)}
                        onChange={e => { const s = new Set(picked); if (e.target.checked) s.add(n.node_id); else s.delete(n.node_id); setPicked(s); }} />
                      <span onClick={() => locate(n.node_id)}>{n.display_name}</span>
                      <span className="s mono">{n.mgmt_ip || '—'}</span>
                    </label>
                  ))}
                  {unassigned.length > 200 && <div className="s" style={{ padding: 6, fontSize: 11 }}>仅显示前 200 条，用上方过滤缩小范围</div>}
                </div>
              </div>
            ) : (
              <PanelBody tab={tab as any} sel={sel as any} focus={focus} canvasRef={shimRef} byId={byId} linkById={linkById as any}
                onTraffic={(l) => setTrafficLink(l as any)}
                onFocus={(nid) => { locate(nid); setTab('detail'); }}
                onSelEdge={(lid) => { setSel({ kind: 'edge', id: lid }); viewRef.current?.selectEdge(lid); setTab('detail'); }} />
            )}
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <div className="card-title">链路审核工作流
          <span className="spacer" />
          <a className="btn" style={{ padding: '4px 8px', fontSize: 11, textDecoration: 'none' }} href="#/link-review">前往链路审核页 →</a>
          <span style={{ fontSize: 11, color: 'var(--text-3)' }}>发现 {summary?.data?.last_run ? ago(summary.data.last_run.at) : '—'}</span>
        </div>
      </div>

      {/* 自动布局预览弹窗（任务书红线：不得直接覆盖已保存人工位置，先预览） */}
      {preview && (
        <div className="tg6-modalmask" onClick={() => setPreview(null)}>
          <div className="tg6-modal" onClick={e => e.stopPropagation()}>
            <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 10 }}>自动布局预览（尚未应用）</div>
            <div className="tc-kv">
              <span className="k">将重排</span><span className="v">{preview.stats.willMove} 个自动位置节点</span>
              <span className="k">新增</span><span className="v">{preview.stats.fresh} 个（新设备默认 auto）</span>
              <span className="k">保留不动</span><span className="v">{preview.stats.manualKept} 个人工/锁定位置 + {preview.stats.unchanged} 个已就位</span>
            </div>
            <div className="tg6-note">自动布局只移动"自动"节点；人工拖动过的位置与被锁定位置原样保留，区域归属不变（红线）。应用后仍需点「保存布局」写入数据库。</div>
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button className="btn primary" onClick={applyPreview}>应用（仅画布，待保存）</button>
              <button className="btn" onClick={() => setPreview(null)}>取消</button>
            </div>
          </div>
        </div>
      )}
      {confirmReset && (
        <div className="tg6-modalmask" onClick={() => setConfirmReset(false)}>
          <div className="tg6-modal" onClick={e => e.stopPropagation()}>
            <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 10, color: 'var(--sev-critical)' }}>⚠ 重置全部布局与区域？</div>
            <div className="tg6-note">这将<b>清除数据库中全部人工/自动布局位置以及全部 {zoneList.length} 个区域</b>（唯一允许清除的入口，操作人 {auth.user}）。清除前服务端自动保存布局+区域快照（pre-reset），可从快照表找回。清除后页面将重新自动布局且不出现任何区域。</div>
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button className="btn" style={{ color: 'var(--sev-critical)' }} disabled={!!busy} onClick={doReset}>确认重置</button>
              <button className="btn" onClick={() => setConfirmReset(false)}>取消</button>
            </div>
          </div>
        </div>
      )}

      {/* 建区 / 编辑区（语义字段立即持久；几何走画布拖动+保存） */}
      {zoneForm && (
        <div className="tg6-modalmask" onClick={() => setZoneForm(null)}>
          <div className="tg6-modal" onClick={e => e.stopPropagation()}>
            <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 10 }}>{zoneForm.mode === 'create' ? '新建区域' : `编辑区域 #${zoneForm.zone_id}`}</div>
            <div className="tc-form">
              <label>名称<input value={zoneForm.name} maxLength={64} onChange={e => setZoneForm({ ...zoneForm, name: e.target.value })} placeholder="如：核心区 / 互联网接入区 / 办公A栋" /></label>
              <div className="row2">
                <label>填充色
                  <span className="tc-presets">
                    {ZONE_PRESETS.map(p => (
                      <button key={p.bg} className={`tc-pre ${zoneForm.bg_color === p.bg ? 'on' : ''}`} style={{ background: p.bg }} title={p.name}
                        onClick={() => setZoneForm({ ...zoneForm, bg_color: p.bg, border_color: zoneForm.border_color === zoneForm.bg_color ? p.bg : zoneForm.border_color })} />
                    ))}
                    <input type="color" value={zoneForm.bg_color} onChange={e => setZoneForm({ ...zoneForm, bg_color: e.target.value })} title="自定义" />
                  </span>
                </label>
                <label>边框色
                  <span className="tc-presets">
                    <input type="color" value={zoneForm.border_color} onChange={e => setZoneForm({ ...zoneForm, border_color: e.target.value })} title="边框颜色" />
                  </span>
                </label>
              </div>
              <div className="row2">
                <label>边框样式
                  <select value={zoneForm.border_style} onChange={e => setZoneForm({ ...zoneForm, border_style: e.target.value as any })}>
                    <option value="solid">实线</option><option value="dashed">虚线</option><option value="none">无边框</option>
                  </select>
                </label>
                <label>边框宽度（0-8）
                  <input type="number" min={0} max={8} value={zoneForm.border_width} onChange={e => setZoneForm({ ...zoneForm, border_width: Math.max(0, Math.min(8, +e.target.value || 0)) })} />
                </label>
              </div>
              <label>备注（≤200 字，显示在区域框内一行）<input value={zoneForm.note} maxLength={200} onChange={e => setZoneForm({ ...zoneForm, note: e.target.value })} /></label>
              <label>父区域（可选，限两级嵌套）
                <select value={zoneForm.parent_zone_id ?? ''} onChange={e => setZoneForm({ ...zoneForm, parent_zone_id: e.target.value ? +e.target.value : null })}>
                  <option value="">（顶级区域）</option>
                  {zoneList.filter(z => z.zone_id !== zoneForm.zone_id && !z.parent_zone_id).map(z => <option key={z.zone_id} value={z.zone_id}>{z.name}</option>)}
                </select>
              </label>
            </div>
            <div className="tg6-note">{zoneForm.mode === 'create' ? '新区域默认摆在当前视口中心（420×280），建好后可拖动位置、拖右下角手柄缩放。' : '语义改动立即写库；位置/大小改动在画布上调整后点「保存布局」。'}</div>
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button className="btn primary" disabled={!!busy || !zoneForm.name.trim()} onClick={submitZoneForm}>{zoneForm.mode === 'create' ? '创建区域' : '保存修改'}</button>
              <button className="btn" onClick={() => setZoneForm(null)}>取消</button>
            </div>
          </div>
        </div>
      )}

      {confirmDelZone && (
        <div className="tg6-modalmask" onClick={() => setConfirmDelZone(null)}>
          <div className="tg6-modal" onClick={e => e.stopPropagation()}>
            <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 10, color: 'var(--sev-critical)' }}>⚠ 删除区域「{confirmDelZone.name}」？</div>
            <div className="tg6-note">区域内 {zoneMemberCount(confirmDelZone.zone_id)} 台设备将转为<b>未分区</b>（坐标保留不动，可随时再加入其它区域）。有子区域时需先处理子区域。区域资产删除立即生效。</div>
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button className="btn" style={{ color: 'var(--sev-critical)' }} disabled={!!busy} onClick={() => doDeleteZone(confirmDelZone)}>确认删除</button>
              <button className="btn" onClick={() => setConfirmDelZone(null)}>取消</button>
            </div>
          </div>
        </div>
      )}

      {/* 连通建议（只读聚类 → 人工采纳才建区；红线：系统绝不自动建区） */}
      {suggestions && (
        <div className="tg6-modalmask" onClick={() => setSuggestions(null)}>
          <div className="tg6-modal wide" onClick={e => e.stopPropagation()}>
            <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 6 }}>连通簇建议（{suggestions.list.length}）</div>
            <div className="tg6-note" style={{ marginBottom: 10 }}>{suggestions.note || '按未分区设备间已确认/人工链路做连通分量聚类，名称取公共前缀。建议仅供参考——点「采纳」才会建区（系统绝不自动创建区域）。'}</div>
            <div className="tc-suglist">
              {!suggestions.list.length && <div className="tc-empty">没有可聚合的未分区连通簇。</div>}
              {suggestions.list.map((s, i) => (
                <div key={i} className="tc-sug">
                  <div>
                    <div><b>{s.suggested_name}</b> <span className="s">· {s.size} 台</span></div>
                    <div className="s mono">{s.node_ids.slice(0, 12).join(', ')}{s.node_ids.length > 12 ? ` …+${s.node_ids.length - 12}` : ''}</div>
                  </div>
                  <button className="btn primary mini" disabled={!canWrite || !!busy} onClick={() => adoptSuggestion(s)}>采纳建区并入 {s.size} 台</button>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button className="btn" onClick={() => setSuggestions(null)}>关闭</button>
            </div>
          </div>
        </div>
      )}
      {trafficLink && <TrafficDrawer link={trafficLink as any} onClose={() => setTrafficLink(null)} />}
    </div>
  );
}

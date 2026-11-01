/* 网络拓扑 V2 —— 全局共享布局（G6 渲染 + DB 布局唯一存储）
 * 取代旧 ELK 页（旧页保留为回滚通道：#/topology-legacy）。
 * 红线：连线只来自真实 LLDP/人工证据；布局不伪造；人工位置永久保留；自动布局先预览再应用。 */
import React from 'react';
import { topoApi, usePoll } from '../api';
import { ago } from '../components/common';
import { TopoG6View, LivePos, LiveGroupPos, TopoLinkV2 } from '../components/TopoG6Canvas';
import { PanelBody } from '../components/TopologyPanelBody';
import { TrafficDrawer } from './TopologyPage';
import '../components/topo-g6.css';
import { GROUP_ORDER, GROUP_LABEL, classifyGroup } from '../topology/classifier';
import { autoLayout, previewMerge, SavedNodeLayout } from '../topology/autoLayout';
import { loadLayout, saveNodes, saveGroups, resetLayout } from '../topology/layoutStore';
import { useTopoAuth } from '../topology/useTopoAuth';
import { TopoAuthBar } from '../components/TopoAuthBar';

type SelV2 = { kind: 'node' | 'edge'; id: number } | null;

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
  const gposRef = React.useRef<Map<string, LiveGroupPos>>(new Map());
  const initedRef = React.useRef(false);
  const [editable, setEditable] = React.useState(false);
  const [dirty, setDirty] = React.useState({ nodes: 0, groups: 0 });
  const [focus, setFocus] = React.useState(0);
  const [sel, setSel] = React.useState<SelV2>(null);
  const [tab, setTab] = React.useState<'detail' | 'neighbors' | 'unlinked'>('detail');
  const [trafficLink, setTrafficLink] = React.useState<TopoLinkV2 | null>(null);
  const [searchQ, setSearchQ] = React.useState('');
  const [preview, setPreview] = React.useState<null | { stats: any; rows: any[] }>(null);
  const [confirmReset, setConfirmReset] = React.useState(false);
  const [loadErr, setLoadErr] = React.useState('');

  const say = (s: string) => { setMsg(s); setTimeout(() => setMsg(''), 6000); };

  /* 初始化画布 */
  React.useEffect(() => {
    if (!hostRef.current || viewRef.current) return;
    hostRef.current.id = 'tg6-host'; // E2E 定位用（稳定 id）
    viewRef.current = new TopoG6View(hostRef.current, {
      onNodeClick: (nid) => { setSel({ kind: 'node', id: nid }); setFocus(nid); setTab('detail'); },
      onEdgeClick: (lid) => { setSel({ kind: 'edge', id: lid }); setTab('detail'); },
      onGroupToggle: () => setDirty(viewRef.current!.dirtyCount),
      onDirty: () => setDirty(viewRef.current!.dirtyCount),
    });
    return () => { viewRef.current?.destroy(); viewRef.current = null; };
  }, []);

  /* graph 同步进 pos（保留已有位置；新设备自动布局且不覆盖已有位置） */
  React.useEffect(() => {
    const view = viewRef.current;
    if (!view || !nodes.length || initedRef.current) return;
    (async () => {
      try {
        const snap = await loadLayout();
        const clsLinks = links.map(l => ({ a: l.a, b: l.b }));
        if (snap.nodes.size === 0) {
          // 首次：全量自动布局
          const res = autoLayout(nodes, clsLinks, new Map());
          posRef.current = new Map(res.placed.map(p => [p.node_id, { x: p.x, y: p.y, source: 'auto', locked: false, group: p.group }]));
        } else {
          // 已有 DB 布局：全部已存行视为固定占位，仅新设备参与摆放（新设备不覆盖已有位置）
          const fakeSaved = new Map<number, SavedNodeLayout>();
          for (const [id, s] of snap.nodes) fakeSaved.set(id, { ...s, layout_source: 'manual' });
          const res = autoLayout(nodes, clsLinks, fakeSaved);
          posRef.current = new Map();
          for (const p of res.placed) {
            const s = snap.nodes.get(p.node_id);
            if (s) posRef.current.set(p.node_id, { x: s.x, y: s.y, source: s.layout_source, locked: s.position_locked, group: classifyGroup({ node_id: p.node_id, display_name: (nodes.find((n: any) => n.node_id === p.node_id) || {}).display_name }, s.group_key) });
            else posRef.current.set(p.node_id, { x: p.x, y: p.y, source: 'auto', locked: false, group: p.group });
          }
        }
        gposRef.current = new Map([...snap.groups].map(([g, v]) => [g, { collapsed: v.collapsed, x: v.x, y: v.y }]));
        initedRef.current = true;
        view.setData(nodes, links, posRef.current, gposRef.current);
        requestAnimationFrame(() => view.fitAll());
      } catch (e: any) {
        setLoadErr(`布局加载失败：${e.message}（画布空白≠数据丢失，请检查 topology-svc 是否运行）`);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph]);

  React.useEffect(() => { viewRef.current?.setEditable(editable); }, [editable]);

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
    preview.rows.forEach(r => { posRef.current.set(r.node_id, { x: r.x, y: r.y, source: 'auto', locked: false, group: r.group as any }); });
    setDirty(viewRef.current!.dirtyCount);
    say(`已应用自动布局（${preview.rows.length} 个自动节点重排；人工/锁定位置未动）——点「保存布局」写入数据库`);
    setPreview(null);
  };
  const doSave = async () => {
    const payload = viewRef.current!.collectSavePayload();
    if (!payload.nodes.length && !payload.groups.length) { say('没有待保存的变更'); return; }
    setBusy('保存');
    try {
      await saveNodes(payload.nodes);
      await saveGroups(payload.groups as any);
      viewRef.current!.markSaved();
      say(`布局已保存（节点 ${payload.nodes.length}、区域 ${payload.groups.length}）`);
    } catch (e: any) { say(`保存失败：${e.message}`); }
    finally { setBusy(''); }
  };
  const doReset = async () => {
    setConfirmReset(false); setBusy('重置');
    try {
      await resetLayout();
      initedRef.current = false;
      posRef.current = new Map(); gposRef.current = new Map();
      viewRef.current?.setData([], [], new Map(), new Map());
      say('已重置：人工布局已清除，即将重新自动布局');
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
  const collapseAll = (collapsed: boolean) => {
    for (const g of GROUP_ORDER) gposRef.current.set(g, { ...(gposRef.current.get(g) || { collapsed: false, x: null, y: null }), collapsed });
    viewRef.current?.setGroupsCollapsed(new Map(GROUP_ORDER.map(g => [g, collapsed])));
    setDirty(viewRef.current!.dirtyCount);
  };
  const locate = (nid: number) => { viewRef.current?.focusNode(nid); setSel({ kind: 'node', id: nid }); setFocus(nid); setSearchQ(''); };

  const hits = searchQ
    ? nodes.filter((n: any) => (n.display_name || '').toLowerCase().includes(searchQ.toLowerCase()) || (n.mgmt_ip || '').includes(searchQ)).slice(0, 15)
    : [];
  const byId = new Map<number, any>(nodes.map((n: any) => [n.node_id, n]));
  const linkById = new Map<number, TopoLinkV2>(links.map(l => [l.link_id, l]));
  const manualCount = [...posRef.current.values()].filter(p => p.source === 'manual' || p.locked).length;

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
        <div className="card"><div className="stat-num">{manualCount || 0}</div><div className="stat-label">人工/锁定位置（DB 持久）</div></div>
        <div className="card"><div className="stat-num" style={{ color: dirty.nodes + dirty.groups ? 'var(--sev-warning)' : undefined }}>{dirty.nodes + dirty.groups || 0}</div><div className="stat-label">未保存布局变更</div></div>
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
              <span style={{ color: 'var(--text-3)', fontSize: 11, marginLeft: 8 }}>G6 · 区域可折叠 · 布局存数据库（跨浏览器共享）</span>
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
            <button className={`btn ${editable ? 'primary' : ''}`} disabled={!canWrite} onClick={() => setEditable(v => !v)} title={canWrite ? '编辑态：可拖动设备卡片/区域框（拖动即人工布局，永久保留）' : '写操作需管理员登录'}>
              {editable ? '✎ 编辑中' : '编辑布局'}
            </button>
            <button className="btn" onClick={runAutoLayout} disabled={!nodes.length}>自动布局…</button>
            <button className="btn" onClick={doSave} disabled={!canWrite || !!busy || (!dirty.nodes && !dirty.groups)} title={canWrite ? undefined : '需管理员登录'}>保存布局{dirty.nodes + dirty.groups ? ` (${dirty.nodes + dirty.groups})` : ''}</button>
            <button className="btn" onClick={toggleLock} disabled={!canWrite || !sel || sel.kind !== 'node'} title="锁定后自动布局不再移动该设备">
              {sel && sel.kind === 'node' && posRef.current.get(sel.id)?.locked ? '解锁位置' : '锁定位置'}
            </button>
            <button className="btn" onClick={() => collapseAll(true)}>全部折叠</button>
            <button className="btn" onClick={() => collapseAll(false)}>全部展开</button>
            <button className="btn" onClick={() => viewRef.current?.fitAll()}>适应画布</button>
            <button className="btn" onClick={() => viewRef.current?.enterFullscreen()}>全屏</button>
            <button className="btn" style={{ color: 'var(--sev-critical)' }} disabled={!canWrite} onClick={() => setConfirmReset(true)} title={canWrite ? undefined : '需管理员登录'}>重置布局</button>
            <a className="btn" href="#/topology-legacy" style={{ textDecoration: 'none' }} title="回滚通道：旧 ELK 版拓扑页">旧版</a>
            {msg && <span style={{ fontSize: 12, color: 'var(--sev-info)' }}>{msg}</span>}
          </div>
          <div className="tg6-wrap"><div ref={hostRef} className="tg6-host" />
            <div className="tg6-legend">
              <div className="row"><span className="tc-swatch" />已确认链路（双端证据）</div>
              <div className="row"><span className="tc-swatch half" />单端发现（half）</div>
              <div className="row">🔒=位置锁定 ✎=人工位置（自动布局不会移动）</div>
            </div>
            <div className="tg6-hint">滚轮缩放 · 空白处拖拽平移 · 双击区域框折叠/展开 · 编辑态下拖动卡片=人工布局（保存后永久保留）· 点卡片看详情 · 点链路看 LLDP 证据</div>
          </div>
        </div>

        <div className="card" style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div className="tc-tabs">
            <button className={tab === 'detail' ? 'on' : ''} onClick={() => setTab('detail')}>详情</button>
            <button className={tab === 'neighbors' ? 'on' : ''} onClick={() => setTab('neighbors')}>邻居展开</button>
            <button className={tab === 'unlinked' ? 'on' : ''} onClick={() => setTab('unlinked')}>未关联设备</button>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', maxHeight: 640 }}>
            <PanelBody tab={tab} sel={sel as any} focus={focus} canvasRef={shimRef} byId={byId} linkById={linkById as any}
              onTraffic={(l) => setTrafficLink(l as any)}
              onFocus={(nid) => { locate(nid); setTab('detail'); }}
              onSelEdge={(lid) => { setSel({ kind: 'edge', id: lid }); viewRef.current?.selectEdge(lid); setTab('detail'); }} />
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
            <div className="tg6-note">自动布局只移动"自动"节点；人工拖动过的位置与被锁定位置原样保留（红线）。应用后仍需点「保存布局」写入数据库。</div>
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
            <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 10, color: 'var(--sev-critical)' }}>⚠ 重置全部布局？</div>
            <div className="tg6-note">这将<b>清除数据库中全部人工与自动布局位置</b>（唯一允许清除人工布局的入口，操作人 {auth.user}）。清除前服务端自动保存布局快照（pre-reset），可从快照表找回。清除后页面将重新自动布局。</div>
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button className="btn" style={{ color: 'var(--sev-critical)' }} disabled={!!busy} onClick={doReset}>确认重置</button>
              <button className="btn" onClick={() => setConfirmReset(false)}>取消</button>
            </div>
          </div>
        </div>
      )}

      {trafficLink && <TrafficDrawer link={trafficLink as any} onClose={() => setTrafficLink(null)} />}
    </div>
  );
}

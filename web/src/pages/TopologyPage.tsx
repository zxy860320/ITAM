/* 网络拓扑页 —— 企业网络架构图（ELK layered + 设备卡片 + 正交连线）
 * 取代旧 ECharts 力导向散点图；连线只来自真实 LLDP 证据或人工确认，绝不伪造。 */
import React from 'react';
import { topoApi, usePoll } from '../api';
import { ago } from '../components/common';
import { Chart, darkBase } from '../components/Chart';
import { TopoCanvas, TopoLink, TopoSel } from '../components/TopoCanvas';
import { PanelBody } from '../components/TopologyPanelBody';
import '../components/topo-canvas.css';

export default function TopologyPage(_: any) {
  const [includeStale, setIncludeStale] = React.useState(false);
  const [busy, setBusy] = React.useState('');
  const [msg, setMsg] = React.useState('');
  const [operator, setOperator] = React.useState(() => localStorage.getItem('topo.operator') || '');
  React.useEffect(() => { localStorage.setItem('topo.operator', operator); }, [operator]);

  const { data: graph, reload: reloadGraph, err: graphErr } =
    usePoll(() => topoApi.graph(includeStale ? 'stale,conflict' : 'conflict'), 60000, String(includeStale));
  const { data: summary, reload: reloadSummary } = usePoll(() => topoApi.discoverySummary(), 60000);
  const { data: pending, reload: reloadPending } = usePoll(() => topoApi.pending({ size: 8 }), 30000);

  const nodes = graph?.data?.nodes || [];
  const links: TopoLink[] = graph?.data?.links || [];
  const linkCountByStatus = (summary?.data?.links || []).reduce((m: any, r: any) => (m[r.status] = r.c, m), {});

  /* ---------- 画布状态 ---------- */
  const svgRef = React.useRef<SVGSVGElement | null>(null);
  const wrapRef = React.useRef<HTMLDivElement | null>(null);
  const canvasRef = React.useRef<TopoCanvas | null>(null);
  const [focus, setFocus] = React.useState<number>(0);
  const [hop, setHop] = React.useState<number>(1);
  const [sel, setSel] = React.useState<TopoSel>(null);
  const [tab, setTab] = React.useState<'detail' | 'neighbors' | 'unlinked'>('detail');
  const [layoutErr, setLayoutErr] = React.useState('');
  const [trafficLink, setTrafficLink] = React.useState<TopoLink | null>(null);
  const [searchQ, setSearchQ] = React.useState('');
  const [showExt, setShowExt] = React.useState(false);
  const firstDrawRef = React.useRef(false);

  React.useEffect(() => {
    if (!svgRef.current) return;
    const cv = new TopoCanvas(svgRef.current, {
      onNodeClick: (nid, isFocus) => {
        setSel({ kind: 'node', id: nid }); setTab('detail');
        if (!isFocus) setFocus(nid);
      },
      onLinkClick: (lid) => { setSel({ kind: 'edge', id: lid }); setTab('detail'); },
      onExtClick: (k) => { setSel({ kind: 'ext', id: k }); setTab('detail'); },
    });
    canvasRef.current = cv;
    return () => { cv.destroy(); canvasRef.current = null; };
  }, []);

  /* 数据到达：喂给画布。默认全网总览（focus=0，全部设备+全部真实证据链路）；
   * 点击设备卡片进入以该设备为中心的一跳/两跳聚焦。 */
  React.useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !nodes.length) return;
    cv.setData(nodes, links);
    cv.setShowExt(showExt); // 首绘前同步开关（否则画布默认 true 会把未纳管对端全画出来）
    if (!firstDrawRef.current) {
      firstDrawRef.current = true;
      cv.setView(focus, hop);
      cv.draw(true).then(err => { setLayoutErr(err || ''); requestAnimationFrame(() => cv.fitView(0)); });
      return;
    }
    if (focus === 0 || cv.hasNode(focus)) {
      cv.setView(focus, hop);
      cv.draw(true).then(err => { setLayoutErr(err || ''); requestAnimationFrame(() => cv.fitView(focus === 0 ? 0 : 0.45)); });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph]);

  /* focus/hop 变化 → 重布局（有保存位置则用保存位置，刷新不随机） */
  React.useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !firstDrawRef.current || !(focus === 0 || cv.hasNode(focus))) return;
    cv.setView(focus, hop);
    cv.draw(true).then(err => { setLayoutErr(err || ''); requestAnimationFrame(() => cv.fitView(focus === 0 ? 0 : 0.45)); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus, hop]);

  React.useEffect(() => { canvasRef.current?.setSelection(sel); }, [sel]);

  /* 全网总览下是否叠加未纳管对端（EXT 卡） */
  React.useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !firstDrawRef.current) return;
    cv.setShowExt(showExt);
    if (focus === 0) cv.draw(true).then(err => { setLayoutErr(err || ''); requestAnimationFrame(() => cv.fitView(0)); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showExt]);

  const run = async (fn: () => Promise<any>, label: string, done?: () => void) => {
    setBusy(label); setMsg('');
    try { const r = await fn(); setMsg(typeof r === 'string' ? r : (r.note || r.ok !== undefined ? `${label}完成` : '')); done?.(); }
    catch (e: any) { setMsg(`${label}失败：${e.message}`); }
    finally { setBusy(''); setTimeout(() => setMsg(''), 6000); }
  };
  const relayout = () => {
    const cv = canvasRef.current; if (!cv) return;
    cv.clearSaved(); cv.draw(false).then(err => { setLayoutErr(err || ''); cv.fitView(); });
  };
  const byId = new Map<number, any>(nodes.map((n: any) => [n.node_id, n]));
  const linkById = new Map<number, TopoLink>(links.map(l => [l.link_id, l]));
  const focusName = focus === 0 ? '全网总览' : (byId.get(focus)?.display_name || (focus ? '#' + focus : '（等待数据）'));
  const hits = searchQ ? nodes.filter((n: any) => (n.display_name || '').toLowerCase().includes(searchQ.toLowerCase()) || (n.mgmt_ip || '').includes(searchQ)).slice(0, 15) : [];

  return (
    <div>
      {/* KPI */}
      <div className="stat-row">
        <div className="card">
          <div className="stat-num">{nodes.length || '—'}</div>
          <div className="stat-label">纳管节点（降级 {summary?.data?.nodes_degraded ?? '—'}）</div>
        </div>
        <div className="card">
          <div className="stat-num" style={{ color: 'var(--sev-healthy)' }}>{linkCountByStatus.confirmed ?? 0}</div>
          <div className="stat-label">已确认链路（双端校验）</div>
        </div>
        <div className="card">
          <div className="stat-num" style={{ color: 'var(--sev-warning)' }}>{(linkCountByStatus.half ?? 0) + (linkCountByStatus.conflict ?? 0)}</div>
          <div className="stat-label">待确认 / 单端链路</div>
        </div>
        <div className="card">
          <div className="stat-num" style={{ color: 'var(--dom-network)' }}>{links.length || 0}</div>
          <div className="stat-label">真实链路总数{summary?.data?.last_run ? ` · 发现 ${ago(summary.data.last_run.at)}` : ''}</div>
        </div>
      </div>

      {!nodes.length && (
        <div className="card" style={{ marginBottom: 14, color: 'var(--text-2)' }}>
          拓扑库为空——先点「同步节点」拉取 Zabbix 网络设备清单。topology-svc（:8790）需处于运行状态。
          {graphErr && <div style={{ color: 'var(--sev-critical)', marginTop: 6 }}>{graphErr}</div>}
        </div>
      )}

      <div className="grid-3" style={{ gridTemplateColumns: 'minmax(0,1fr) 372px' }}>
        {/* 架构图画布 */}
        <div className="card" style={{ padding: '12px 14px' }}>
          <div className="toolbar" style={{ position: 'relative', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
            <span className="card-title" style={{ margin: 0 }}>网络架构拓扑图
              <span style={{ color: 'var(--text-3)', fontSize: 11, marginLeft: 8 }}>
                聚焦：<b style={{ color: 'var(--text-2)' }}>{focusName}</b>{focus ? ' #' + focus : ''} · ELK 分层布局 · 仅真实 LLDP/人工证据连线              </span>
            </span>
            <span className="spacer" style={{ flex: 1 }} />
            <div style={{ position: 'relative' }}>
              <input placeholder="搜索设备（名称/IP）" value={searchQ} onChange={e => setSearchQ(e.target.value)} style={{ width: 200, fontSize: 12 }} />
              {searchQ && (
                <div className="tc-searchlist">
                  {hits.length ? hits.map((n: any) => (
                    <div key={n.node_id} className="it" onClick={() => { setFocus(n.node_id); setSel({ kind: 'node', id: n.node_id }); setSearchQ(''); }}>
                      <div>{n.display_name}</div>
                      <div className="s mono">{n.mgmt_ip || '—'} · 节点 #{n.node_id}</div>
                    </div>
                  )) : <div className="it"><div className="s">无匹配</div></div>}
                </div>
              )}
            </div>
            <span className="seg">
              <button className={focus === 0 ? 'on' : ''} onClick={() => { setFocus(0); setSel(null); }}>全网总览</button>
              {[1, 2].map(h => <button key={h} className={focus !== 0 && hop === h ? 'on' : ''} disabled={focus === 0} onClick={() => setHop(h)}>{h}跳</button>)}
            </span>
            <a className="btn" href="#/topology-full" style={{ textDecoration: 'none' }} title="新页面：初始只列核心层，点卡片逐层向下展开（核心→汇聚→接入）">架构全览（逐层钻取）</a>
            <button className="btn" onClick={() => canvasRef.current?.fitView()}>适应画布</button>
            <button className="btn" onClick={relayout}>重新自动布局</button>
            <button className="btn" onClick={() => { canvasRef.current?.saveLayout(); setMsg('布局已保存（本浏览器，刷新不随机）'); setTimeout(() => setMsg(''), 2500); }}>保存布局</button>
            <label style={{ fontSize: 12, color: 'var(--text-2)', display: 'flex', gap: 4, alignItems: 'center' }}>
              <input type="checkbox" checked={includeStale} onChange={e => setIncludeStale(e.target.checked)} style={{ width: 'auto' }} />含失效链路
            </label>
            <label title="全网总览时叠加未纳管对端快照卡（数量多、图很大；聚焦模式始终显示）" style={{ fontSize: 12, color: 'var(--text-2)', display: 'flex', gap: 4, alignItems: 'center' }}>
              <input type="checkbox" checked={showExt} onChange={e => setShowExt(e.target.checked)} style={{ width: 'auto' }} />总览含未纳管对端
            </label>
            <button className="btn" disabled={!!busy} onClick={() => run(() => topoApi.sync(), '同步', () => { reloadGraph(); reloadSummary(); })}>
              {busy === '同步' ? '同步中…' : '同步节点'}
            </button>
            <button className="btn" disabled={!!busy || summary?.data?.discovery_running} onClick={() => run(() => topoApi.discoveryRun(), 'LLDP 发现', () => setTimeout(() => { reloadSummary(); reloadGraph(); reloadPending(); }, 5000))}>
              {summary?.data?.discovery_running ? '发现进行中…' : busy === 'LLDP 发现' ? '已排队' : 'LLDP 发现'}
            </button>
            {msg && <span style={{ fontSize: 12, color: 'var(--sev-info)' }}>{msg}</span>}
          </div>
          <div className="tc-wrap" ref={wrapRef}>
            <svg ref={svgRef} className="tc-svg" />
            <div className="tc-legend">
              <div className="row"><span className="tc-swatch" />已确认链路（双端证据）</div>
              <div className="row"><span className="tc-swatch half" />单端发现（half，待网络组核实）</div>
              <div className="row"><span className="tc-swatch box" />纳管设备卡片</div>
              <div className="row"><span className="tc-swatch extb" />未纳管对端（仅 LLDP 快照）</div>
            </div>
            {layoutErr && <div className="tc-note" style={{ position: 'absolute', left: 12, top: 10, maxWidth: 420 }}>{layoutErr}</div>}
            <div className="tc-hint">全网总览：全部设备 + 全部真实证据连线 · 滚轮缩放 · 拖拽平移 · 点设备卡片进入一跳/两跳上下游聚焦 · 点链路看 LLDP 证据 · 无连线设备=尚未发现真实链路（绝不伪造）</div>
          </div>
        </div>

        {/* 右侧面板 */}
        <div className="card" style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div className="tc-tabs">
            <button className={tab === 'detail' ? 'on' : ''} onClick={() => setTab('detail')}>详情</button>
            <button className={tab === 'neighbors' ? 'on' : ''} onClick={() => setTab('neighbors')}>邻居展开</button>
            <button className={tab === 'unlinked' ? 'on' : ''} onClick={() => setTab('unlinked')}>未关联设备</button>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', maxHeight: 640 }}>
            <PanelBody tab={tab} sel={sel} focus={focus} canvasRef={canvasRef as any} byId={byId} linkById={linkById}
              onTraffic={(l) => setTrafficLink(l)}
              onFocus={(nid) => { setFocus(nid); setSel({ kind: 'node', id: nid }); setTab('detail'); }}
              onSelEdge={(lid) => { setSel({ kind: 'edge', id: lid }); setTab('detail'); }} />
          </div>
        </div>
      </div>

      {/* 待确认队列（预览最新 8 条；完整审核工作流在「链路审核」专用页：分页/过滤/批量） */}
      <div className="card" style={{ marginTop: 14 }}>
        <div className="card-title">待确认链路（预览）
          <span className="spacer" />
          <a className="btn" style={{ padding: '4px 8px', fontSize: 11, textDecoration: 'none' }} href="#/link-review">前往链路审核页（分页/过滤/批量）→</a>
          <button className="btn" style={{ padding: '4px 8px', fontSize: 11 }} onClick={reloadPending}>刷新</button>
        </div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          <input placeholder="操作人（确认/忽略必填）" value={operator} onChange={e => setOperator(e.target.value)} style={{ width: 320 }} />
        </div>
        {(pending?.data || []).map((l: any) => (
          <div key={l.link_id} className="ev-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 4 }}>
            <div style={{ fontSize: 12 }}>
              <b>{l.a.name}</b> <span className="mono" style={{ color: 'var(--text-3)' }}>{l.a.iface || '?'}</span>
              {' ⇄ '}
              <b>{l.b.name || '未知邻居'}</b> <span className="mono" style={{ color: 'var(--text-3)' }}>{l.b.iface || l.b_snapshot?.port_id || '?'}</span>
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-3)' }}>
              {l.status === 'conflict' ? '⚠ 双端信息矛盾' : '单端观察到'} · 置信 {l.confidence} · 来源 {l.source} · {ago(l.last_seen)}
              {l.b_snapshot?.sys_name && !l.b.iface && <span> · 邻居原始名 {l.b_snapshot.sys_name}</span>}
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="btn primary" style={{ padding: '3px 10px', fontSize: 11 }} disabled={!operator || !!busy}
                onClick={() => run(() => topoApi.confirmLink(l.link_id, operator), '确认', () => { reloadPending(); reloadGraph(); reloadSummary(); })}>确认</button>
              <button className="btn" style={{ padding: '3px 10px', fontSize: 11 }} disabled={!operator || !!busy}
                onClick={() => run(() => topoApi.rejectLink(l.link_id, operator, '人工判定无效'), '忽略', () => { reloadPending(); reloadGraph(); reloadSummary(); })}>忽略</button>
              <button className="btn" style={{ padding: '3px 10px', fontSize: 11 }}
                onClick={() => { setFocus(l.a); setSel({ kind: 'edge', id: l.link_id }); setTab('detail'); }}>图上定位</button>
            </div>
          </div>
        ))}
        {!pending?.data?.length && (
          <div className="empty-tip" style={{ color: 'var(--text-3)', fontSize: 12, padding: '10px 0' }}>
            暂无待确认链路。现网多数设备对端未启用 LLDP——待网络组两端开启后自动出现；也可在图上人工补录。
          </div>
        )}
      </div>

      {trafficLink && <TrafficDrawer link={trafficLink} onClose={() => setTrafficLink(null)} />}
    </div>
  );
}

/* ---------- 链路流量抽屉（数据源 Zabbix 接口计数器，与旧版一致） ---------- */
function TrafficDrawer({ link, onClose }: { link: TopoLink; onClose: () => void }) {
  const [range, setRange] = React.useState('6h');
  const { data } = usePoll(() => topoApi.traffic(link.link_id, range), 60000, `${link.link_id}|${range}`);
  const d = data?.data;
  const series: any[] = [];
  const push = (name: string, arr: any[], color: string, dash = false) => {
    if (!arr?.length) return;
    series.push({
      name, type: 'line', showSymbol: false, smooth: true,
      data: arr.map((p: any) => [p.t, +(p.v / 1e6).toFixed(3)]),
      lineStyle: { color, width: 1.4, type: dash ? 'dashed' : 'solid' }, itemStyle: { color },
    });
  };
  push('A→B in', d?.a?.in?.avg, '#22D3EE');
  push('A→B out', d?.a?.out?.avg, '#B388FF');
  push('B→A in', d?.b?.in?.avg, '#22D3EE', true);
  push('B→A out', d?.b?.out?.avg, '#B388FF', true);
  const opt = series.length ? {
    ...darkBase,
    tooltip: { ...darkBase.tooltip, trigger: 'axis' },
    legend: { textStyle: { color: '#A1A1AA', fontSize: 11 }, top: 0 },
    xAxis: { type: 'time', axisLabel: { color: '#71717A', fontSize: 10 }, axisLine: { lineStyle: { color: '#27272A' } } },
    yAxis: { type: 'value', name: 'Mb/s', nameTextStyle: { color: '#71717A' }, axisLabel: { color: '#71717A', fontSize: 10 }, splitLine: { lineStyle: { color: '#1F1F23' } } },
    grid: { left: 48, right: 16, top: 34, bottom: 26 },
    series,
  } : null;
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)', zIndex: 50, display: 'flex', justifyContent: 'flex-end' }}>
      <div className="drawer-panel" onClick={e => e.stopPropagation()} style={{ width: 'min(820px, 96vw)', background: 'var(--bg-card)', borderLeft: '1px solid var(--hairline)', padding: 20, overflowY: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700 }}>链路 #{link.link_id} 两端流量</div>
            <div className="mono" style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>
              {link.a_if || '?'} ⇄ {link.b_if || link.b_snapshot?.port_id || '?'} · {link.status} · 来源 {link.source} · 置信 {link.confidence}
            </div>
          </div>
          <span style={{ flex: 1 }} />
          <div className="seg">
            {[['1h', '1h'], ['6h', '6h'], ['24h', '24h'], ['7d', '7d']].map(([v, l]) => (
              <button key={v} className={range === v ? 'on' : ''} onClick={() => setRange(v)}>{l}</button>
            ))}
          </div>
          <button className="btn" style={{ marginLeft: 10, padding: '4px 10px' }} onClick={onClose}>✕</button>
        </div>
        {opt ? <Chart option={opt} height={300} />
          : <div className="empty-tip" style={{ fontSize: 12, color: 'var(--text-3)', padding: 20 }}>
            该链路两端暂无可用流量映射（b 端未解析或接口映射缺失）。双端 LLDP 确认后可见两端曲线。
          </div>}
        <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 6 }}>数据来自 Zabbix 接口计数器（bps→Mb/s），与 Zabbix 前端同接口图表同源。</div>
      </div>
    </div>
  );
}

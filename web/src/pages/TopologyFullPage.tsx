/* 网络架构全览（钻取视图）—— 从拓扑工作台「架构全览」进入。
 * 初始只显示核心层设备；点核心 → 向下展开它的真实 LLDP 邻居（汇聚），点汇聚 → 再展开接入层。
 * 层级=沿真实链路跳数（显示层推断，来源标注在卡片上）；绝不伪造连线、不改任何库数据。 */
import React from 'react';
import { topoApi, usePoll } from '../api';
import { TopoLink } from '../components/TopoCanvas';
import { TopoTree } from '../components/TopoTree';
import '../components/topo-canvas.css';

export default function TopologyFullPage(_: any) {
  const { data: graph, err, reload: reloadGraph } = usePoll(() => topoApi.graph('conflict'), 60000);
  const nodes = graph?.data?.nodes || [];
  const links: TopoLink[] = graph?.data?.links || [];

  const svgRef = React.useRef<SVGSVGElement | null>(null);
  const treeRef = React.useRef<TopoTree | null>(null);
  const [msg, setMsg] = React.useState('');
  const fedRef = React.useRef(false);
  // 用户核定核心根（管理IP，逗号分隔）——仅前端显示配置存 localStorage，不落库
  const ROOT_KEY = 'uocp.topo.rootCores';
  const [rootCores, setRootCores] = React.useState(() => localStorage.getItem(ROOT_KEY) ?? '10.25.1.1,10.25.1.2');
  // 用户核定同层聚合对（M-LAG/堆叠双核心，"IP|IP" 逗号分隔）——仅显示层配置，不落库
  const PEER_KEY = 'uocp.topo.peerPairs';
  const [peerPairs, setPeerPairs] = React.useState(() => localStorage.getItem(PEER_KEY) ??
    '10.25.1.1|10.25.1.2,10.25.0.253|10.25.0.252,10.25.2.42|10.25.2.43,10.25.2.15|10.25.2.16,10.25.2.13|10.25.2.14,10.25.2.11|10.25.2.12,10.25.2.25|10.25.2.26,10.25.2.19|10.25.2.20');
  const parsePeers = (s: string): [string, string][] =>
    s.split(/[,，]+/).map(t => t.trim()).filter(Boolean)
      .map(t => t.split(/[|\-－—]+/).map(x => x.trim()))
      .filter(p => p.length === 2 && p[0] && p[1]) as [string, string][];

  // 数据维护：同步 Zabbix 节点入库 / 触发 LLDP 发现（与拓扑工作台同一后端接口，异步排队）
  const [busy, setBusy] = React.useState('');
  const run = async (fn: () => Promise<any>, label: string, done?: () => void) => {
    setBusy(label); setMsg('');
    try {
      const r = await fn();
      setMsg(typeof r === 'string' ? r : (r?.note || (r?.queued ? `已排队 ${r.queued} 台，发现约需 1-2 分钟` : `${label}完成`)));
      done?.();
    } catch (e: any) { setMsg(`${label}失败：${e.message}`); }
    finally { setBusy(''); setTimeout(() => setMsg(''), 8000); }
  };
  const waitDiscoveryReload = () => {
    const t = setInterval(async () => {
      try {
        const s = await topoApi.discoverySummary();
        if (!s?.data?.discovery_running) { clearInterval(t); reloadGraph(); setMsg('LLDP 发现已完成，视图已刷新'); setTimeout(() => setMsg(''), 5000); }
      } catch { /* 服务瞬断继续等 */ }
    }, 8000);
    setTimeout(() => clearInterval(t), 10 * 60 * 1000);
  };

  React.useEffect(() => {
    if (!svgRef.current) return;
    const tv = new TopoTree(svgRef.current, {});
    treeRef.current = tv;
    return () => { tv.destroy(); treeRef.current = null; };
  }, []);

  React.useEffect(() => {
    const tv = treeRef.current;
    if (!tv || !nodes.length) return;
    tv.setData(nodes, links);
    tv.setRootOverride(rootCores.split(/[,，\s]+/));
    tv.setPeerPairs(parsePeers(peerPairs));
    if (!fedRef.current) {
      fedRef.current = true;
      tv.draw();
      requestAnimationFrame(() => { tv.fitView(); setMsg('核心根 ' + tv.getRoots().length + ' 台（用户核定 ' + rootCores + '）· 点卡片 ▼ 向下展开'); });
    } else {
      tv.draw();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, rootCores, peerPairs]);

  return (
    <div>
      <div className="card" style={{ padding: '12px 14px' }}>
        <div className="toolbar" style={{ flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
          <a className="btn" href="#/topology" style={{ textDecoration: 'none' }}>← 返回拓扑工作台</a>
          <span className="card-title" style={{ margin: 0 }}>网络架构全览
            <span style={{ color: 'var(--text-3)', fontSize: 11, marginLeft: 8 }}>
              初始只列核心层 · 点卡片 ▼ 逐层向下展开（核心 → 汇聚 → 接入）· 连线仅真实 LLDP 证据
            </span>
          </span>
          <span className="spacer" style={{ flex: 1 }} />
          <label style={{ fontSize: 12, color: 'var(--text-3)' }}>核定核心（管理IP）
            <input
              value={rootCores}
              onChange={e => setRootCores(e.target.value)}
              onBlur={() => localStorage.setItem(ROOT_KEY, rootCores)}
              style={{ marginLeft: 6, width: 160, padding: '4px 8px', background: 'var(--bg-inset)', border: '1px solid var(--hairline)', borderRadius: 'var(--radius-sm)', color: 'var(--text-1)', fontSize: 12 }}
            />
          </label>
          <label style={{ fontSize: 12, color: 'var(--text-3)' }} title="M-LAG/堆叠等聚合双机强制同一层，互联线按水平样式。格式 IP|IP，多组用逗号">同层聚合对
            <input
              value={peerPairs}
              onChange={e => setPeerPairs(e.target.value)}
              onBlur={() => localStorage.setItem(PEER_KEY, peerPairs)}
              style={{ marginLeft: 6, width: 210, padding: '4px 8px', background: 'var(--bg-inset)', border: '1px solid var(--hairline)', borderRadius: 'var(--radius-sm)', color: 'var(--text-1)', fontSize: 12 }}
            />
          </label>
          <button className="btn" onClick={() => { treeRef.current?.expandAll(); treeRef.current?.fitView(); setMsg('已按真实链路展开全部层级'); setTimeout(() => setMsg(''), 2500); }}>展开全部层级</button>
          <button className="btn" onClick={() => { treeRef.current?.collapseAll(); treeRef.current?.fitView(); setMsg('已收起，仅显示核心层'); setTimeout(() => setMsg(''), 2500); }}>仅看核心层</button>
          <button className="btn" onClick={() => treeRef.current?.fitView()}>适应画布</button>
          <button className="btn" disabled={!!busy} title="从 Zabbix 拉取网络设备清单入库（新加设备先同步才会出现在拓扑库）"
            onClick={() => run(() => topoApi.sync(), '同步', () => { reloadGraph(); setMsg('同步完成，视图已刷新'); setTimeout(() => setMsg(''), 4000); })}>
            {busy === '同步' ? '同步中…' : '同步节点'}
          </button>
          <button className="btn" disabled={!!busy} title="触发全网 LLDP 发现（异步，约 1-2 分钟；完成后自动刷新视图）"
            onClick={() => run(() => topoApi.discoveryRun(), 'LLDP 发现', waitDiscoveryReload)}>
            {busy === 'LLDP 发现' ? '发现排队中…' : 'LLDP 发现'}
          </button>
          {msg && <span style={{ fontSize: 12, color: 'var(--sev-info)' }}>{msg}</span>}
        </div>
        <div className="tc-wrap" style={{ position: 'relative' }}>
          <svg ref={svgRef} className="tc-svg" style={{ height: 'calc(100vh - 210px)', minHeight: 560 }} />
          <div className="tc-legend">
            <div className="row"><span className="tc-swatch" />已确认链路（双端证据）</div>
            <div className="row"><span className="tc-swatch half" />单端发现（half，待网络组核实）</div>
            <div className="row"><span className="tc-swatch rootb" />核心层（用户核定 / 命名证据）</div>
            <div className="row"><span className="tc-swatch peer" />聚合互联（核定同层对，如 M-LAG）</div>
            <div className="row"><span className="tc-swatch extb" />未纳管对端（LLDP 快照证据，按 chassis 去重）</div>
            <div className="row"><span className="tc-swatch box" />▼ 数字=可向下展开的邻居数</div>
          </div>
          <div className="tc-hint">连线全部来自真实 LLDP 证据：双端确认=绿实线 · 单端发现=黄虚线（含 chassis_id 升格与未纳管对端 EXT）· 点击连线高亮两端设备与端口、其余变暗，点空白取消 · network_role 台账核定前不落库</div>
          {err && <div className="tc-note" style={{ position: 'absolute', left: 12, top: 10, maxWidth: 420 }}>{err}</div>}
        </div>
      </div>
    </div>
  );
}

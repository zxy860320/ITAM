/* 待确认链路审核页 —— half/conflict/stale 链的人工审核工作流
 * 背景：现网 LLDP 单向覆盖严重（对端设备不开 LLDP 回报），发现引擎只见到单端观察，
 * 链路一律先落 half。本页按置信度分层审核：conf=1.0 的双端接口全解析链是高置信批量候选；
 * conf=0.3 的对端未解析链需要人工核对 b_snapshot 原始证据。所有操作记录 operator。 */
import React from 'react';
import { topoApi, usePoll } from '../api';
import { ago, Pager } from '../components/common';

const CONF_BANDS = [
  { v: '', label: '全部置信度' },
  { v: 'min:1', label: '= 1.0（双端接口已解析）' },
  { v: 'range:0.5:0.89', label: '0.5 ~ 0.89（名称/ID 匹配）' },
  { v: 'max:0.49', label: '< 0.5（对端未解析，仅原始证据）' },
];
const STATUS_OPTS = [
  { v: 'half,conflict', label: 'half + conflict' },
  { v: 'half', label: '仅 half（单端观察）' },
  { v: 'conflict', label: '仅 conflict（端点冲突）' },
  { v: 'half,conflict,stale', label: '含 stale（长期未见）' },
];

function fmtSpeed(bps: number | null): string {
  if (!bps || bps <= 0 || bps > 1e13) return '—';
  if (bps >= 1e9) return (bps / 1e9).toFixed(0) + 'G';
  if (bps >= 1e6) return (bps / 1e6).toFixed(0) + 'M';
  return '—';
}
function operTag(oper: number | null) {
  if (oper === 1) return <span style={{ color: 'var(--sev-healthy)' }}>up</span>;
  if (oper === 2) return <span style={{ color: 'var(--sev-critical)' }}>down</span>;
  return <span style={{ color: 'var(--text-3)' }}>?</span>;
}
function confColor(c: number) {
  return c >= 0.9 ? 'var(--sev-healthy)' : c >= 0.5 ? 'var(--dom-network)' : 'var(--sev-warning)';
}

export default function LinkReviewPage(_: any) {
  const [operator, setOperator] = React.useState(() => localStorage.getItem('topo.operator') || '');
  React.useEffect(() => { localStorage.setItem('topo.operator', operator); }, [operator]);

  const [status, setStatus] = React.useState('half,conflict');
  const [band, setBand] = React.useState('');
  const [nodeId, setNodeId] = React.useState('');
  const [q, setQ] = React.useState(''); // 对端/设备/接口/快照证据搜索
  const [page, setPage] = React.useState(1);
  const size = 100;
  const [selected, setSelected] = React.useState<Set<number>>(new Set());
  const [busy, setBusy] = React.useState('');
  const [msg, setMsg] = React.useState('');

  const fkey = JSON.stringify({ status, band, nodeId, q, page });
  const { data, err, reload } = usePoll(() => {
    const qs: Record<string, any> = { status, page, size };
    if (band.startsWith('min:')) qs.min_confidence = band.slice(4);
    if (band.startsWith('max:')) qs.max_confidence = band.slice(4);
    if (band.startsWith('range:')) { const [, lo, hi] = band.split(':'); qs.min_confidence = lo; qs.max_confidence = hi; }
    if (nodeId) qs.node_id = nodeId;
    if (q.trim()) qs.q = q.trim();
    return topoApi.pending(qs);
  }, 30000, fkey);

  const rows: any[] = data?.data || [];
  const meta = data?.meta || { page: 1, size, total: 0, by_status: [], by_conf: [], by_node: [] };
  const flash = (s: string) => { setMsg(s); setTimeout(() => setMsg(''), 5000); };
  const needOperator = () => {
    if (!operator.trim()) { flash('请先填写操作人（必填，操作会记入 confirmed_by）'); return false; }
    return true;
  };

  const changeFilter = (fn: () => void) => { fn(); setPage(1); setSelected(new Set()); };

  const toggleSel = (id: number) => setSelected(prev => {
    const s = new Set(prev as Set<number>); s.has(id) ? s.delete(id) : s.add(id); return s;
  });
  const toggleAllPage = () => setSelected(prev => {
    const s = new Set(prev as Set<number>);
    const all = rows.every(r => s.has(r.link_id));
    rows.forEach(r => all ? s.delete(r.link_id) : s.add(r.link_id));
    return s;
  });

  const actOne = async (l: any, kind: 'confirm' | 'reject') => {
    if (!needOperator()) return;
    setBusy(String(l.link_id));
    try {
      if (kind === 'confirm') await topoApi.confirmLink(l.link_id, operator.trim());
      else await topoApi.rejectLink(l.link_id, operator.trim(), '审核页忽略');
      setSelected(prev => { const s = new Set(prev as Set<number>); s.delete(l.link_id); return s; });
      reload();
    } catch (e: any) { flash('操作失败：' + (e.message || e)); }
    finally { setBusy(''); }
  };

  const bulkIds = async (kind: 'confirm' | 'reject') => {
    if (!needOperator() || !selected.size) return;
    if (!window.confirm(`确认${kind === 'confirm' ? '确认' : '忽略'}选中的 ${selected.size} 条链路？`)) return;
    setBusy('bulk');
    try {
      const body: any = { link_ids: [...(selected as Set<number>)], operator: operator.trim() };
      const r = kind === 'confirm' ? await topoApi.bulkConfirm(body) : await topoApi.bulkReject(body);
      flash(`已${kind === 'confirm' ? '确认' : '忽略'} ${r.affected} 条（请求 ${r.requested}）`);
      setSelected(new Set()); reload();
    } catch (e: any) { flash('批量失败：' + (e.message || e)); }
    finally { setBusy(''); }
  };

  // 按当前过滤条件（设备+置信带，不含搜索词与分页）圈定全部匹配链批量操作
  const bulkMatch = (kind: 'confirm' | 'reject') => {
    if (!needOperator()) return;
    const match: any = {};
    if (nodeId) match.node_id = +nodeId;
    if (band.startsWith('min:')) match.min_confidence = Number(band.slice(4));
    if (band.startsWith('max:')) match.max_confidence = Number(band.slice(4));
    if (band.startsWith('range:')) { const [, lo, hi] = band.split(':'); match.min_confidence = Number(lo); match.max_confidence = Number(hi); }
    if (!window.confirm(`将${kind === 'confirm' ? '确认' : '忽略'}当前过滤条件下全部 ${meta.total} 条链路（服务端圈定，含未翻页部分），继续？`)) return;
    setBusy('bulk');
    (async () => {
      try {
        const body: any = { match, operator: operator.trim() };
        if (kind === 'confirm') body.note = `审核页按条件批量确认（${band || '全部置信'}${nodeId ? ' / 指定设备' : ''}）`;
        else body.reason = '审核页按条件批量忽略';
        const r = kind === 'confirm' ? await topoApi.bulkConfirm(body) : await topoApi.bulkReject(body);
        flash(`已${kind === 'confirm' ? '确认' : '忽略'} ${r.affected} 条（匹配 ${r.requested}）`);
        setSelected(new Set()); reload();
      } catch (e: any) { flash('批量失败：' + (e.message || e)); }
      finally { setBusy(''); }
    })();
  };

  const allPageSelected = rows.length > 0 && rows.every(r => selected.has(r.link_id));

  return (
    <div>
      {/* 汇总条 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
        <div className="card">
          <div className="stat-num" style={{ color: 'var(--sev-warning)' }}>{meta.total ?? 0}</div>
          <div className="stat-label">当前过滤条件下待审核</div>
        </div>
        <div className="card">
          <div className="stat-num" style={{ color: 'var(--sev-healthy)' }}>
            {(meta.by_conf || []).filter((b: any) => b.band === '>=0.9').reduce((s: number, b: any) => s + b.c, 0)}
          </div>
          <div className="stat-label">高置信（双端接口已解析）——批量确认候选</div>
        </div>
        <div className="card">
          <div className="stat-num" style={{ color: 'var(--sev-warning)' }}>
            {(meta.by_conf || []).filter((b: any) => b.band === '<0.5').reduce((s: number, b: any) => s + b.c, 0)}
          </div>
          <div className="stat-label">对端未解析——需核对 LLDP 原始证据</div>
        </div>
        <div className="card">
          <div className="stat-num" style={{ color: 'var(--dom-network)' }}>{(meta.by_node || []).length}</div>
          <div className="stat-label">涉及本端设备数（单向 LLDP 覆盖来源）</div>
        </div>
      </div>

      {/* 过滤器 */}
      <div className="card" style={{ marginTop: 14 }}>
        <div className="card-title">过滤器</div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <select value={status} onChange={e => changeFilter(() => setStatus(e.target.value))} style={{ width: 190 }}>
            {STATUS_OPTS.map(o => <option key={o.v} value={o.v}>{o.label}</option>)}
          </select>
          <select value={band} onChange={e => changeFilter(() => setBand(e.target.value))} style={{ width: 230 }}>
            {CONF_BANDS.map(o => <option key={o.v} value={o.v}>{o.label}</option>)}
          </select>
          <select value={nodeId} onChange={e => changeFilter(() => setNodeId(e.target.value))} style={{ width: 260 }}>
            <option value="">全部本端设备</option>
            {(meta.by_node || []).map((n: any) => <option key={n.node_id} value={n.node_id}>{n.name}（{n.c} 条）</option>)}
          </select>
          <input placeholder="搜索对端设备名 / 快照证据(sys_name、chassis_id…) / 接口" value={q}
            onChange={e => changeFilter(() => setQ(e.target.value))} style={{ width: 340 }} />
          <span className="spacer" style={{ flex: 1 }} />
          <input placeholder="操作人（必填，记忆）" value={operator} onChange={e => setOperator(e.target.value)} style={{ width: 200 }} />
          <button className="btn" onClick={reload}>刷新</button>
        </div>
        {msg && <div style={{ marginTop: 8, fontSize: 12, color: 'var(--dom-network)' }}>{msg}</div>}
        {err && <div style={{ marginTop: 8, fontSize: 12, color: 'var(--sev-critical)' }}>{err}</div>}
      </div>

      {/* 批量操作条 */}
      <div className="card" style={{ marginTop: 14, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, color: 'var(--text-3)' }}>已选 <b style={{ color: 'var(--text-1)' }}>{selected.size}</b> 条（本页 {rows.length} 条）</span>
        <button className="btn" disabled={!selected.size || busy === 'bulk'} onClick={() => bulkIds('confirm')}>批量确认所选</button>
        <button className="btn" disabled={!selected.size || busy === 'bulk'} onClick={() => bulkIds('reject')}>批量忽略所选</button>
        <span style={{ width: 1, height: 20, background: 'var(--hairline)' }} />
        <span style={{ fontSize: 12, color: 'var(--text-3)' }}>按过滤条件（{meta.total} 条，含未翻页）：</span>
        <button className="btn" disabled={!meta.total || busy === 'bulk'} onClick={() => bulkMatch('confirm')}>全部确认</button>
        <button className="btn" disabled={!meta.total || busy === 'bulk'} onClick={() => bulkMatch('reject')}>全部忽略</button>
        <span className="spacer" style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: 'var(--text-3)' }}>建议：先按「= 1.0」置信带逐设备批量确认；&lt;0.5 的逐条核对证据后再操作</span>
      </div>

      {/* 审核列表 */}
      <div className="card" style={{ marginTop: 14 }}>
        <table className="data nowrap">
          <thead>
            <tr>
              <th style={{ width: 34 }}><input type="checkbox" checked={allPageSelected} onChange={toggleAllPage} /></th>
              <th style={{ width: 34 }}>ID</th>
              <th>本端（A，已解析）</th>
              <th>对端（B）</th>
              <th style={{ width: 70 }}>置信</th>
              <th style={{ width: 90 }}>状态</th>
              <th style={{ width: 110 }}>最近发现</th>
              <th style={{ width: 130 }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((l: any) => (
              <tr key={l.link_id}>
                <td><input type="checkbox" checked={selected.has(l.link_id)} onChange={() => toggleSel(l.link_id)} /></td>
                <td className="mono">{l.link_id}</td>
                <td>
                  <b>{l.a?.name}</b>{' '}
                  <span className="mono" style={{ color: 'var(--text-2)' }}>{l.a?.iface || '?'}</span>{' '}
                  <span style={{ fontSize: 11 }}>{operTag(l.a?.oper)}{l.a?.oper != null && ' · '}{fmtSpeed(l.a?.speed)}</span>
                </td>
                <td>
                  {l.b?.iface_id ? (
                    <>
                      <b>{l.b?.name || '已解析'}</b>{' '}
                      <span className="mono" style={{ color: 'var(--text-2)' }}>{l.b?.iface || '?'}</span>{' '}
                      <span style={{ fontSize: 11 }}>{operTag(l.b?.oper)}{l.b?.oper != null && ' · '}{fmtSpeed(l.b?.speed)}</span>
                    </>
                  ) : (
                    <span title="对端未纳管或无法解析——以下为 LLDP 原始回报证据（未伪造）">
                      <span style={{ color: 'var(--text-3)' }}>未解析：</span>
                      <span className="mono" style={{ color: 'var(--text-2)' }}>
                        {l.b_snapshot?.sys_name || l.b?.name || '?'}
                        {l.b_snapshot?.port_id ? ' · ' + l.b_snapshot.port_id : ''}
                      </span>
                      {l.b_snapshot?.port_desc && (
                        <div style={{ fontSize: 11, color: 'var(--text-3)' }}>desc: {l.b_snapshot.port_desc}</div>
                      )}
                      {l.b_snapshot?.chassis_id && (
                        <div style={{ fontSize: 11, color: 'var(--text-3)' }}>chassis: {l.b_snapshot.chassis_id}</div>
                      )}
                    </span>
                  )}
                </td>
                <td className="mono" style={{ color: confColor(l.confidence) }}>{l.confidence}</td>
                <td>{l.status}{l.missing_rounds ? <span style={{ color: 'var(--text-3)', fontSize: 11 }}> ×{l.missing_rounds}</span> : null}</td>
                <td style={{ fontSize: 11 }}>{l.last_seen ? ago(l.last_seen) : '—'}</td>
                <td>
                  <button className="btn" style={{ padding: '3px 8px', fontSize: 11 }} disabled={busy !== ''} onClick={() => actOne(l, 'confirm')}>确认</button>{' '}
                  <button className="btn" style={{ padding: '3px 8px', fontSize: 11 }} disabled={busy !== ''} onClick={() => actOne(l, 'reject')}>忽略</button>
                </td>
              </tr>
            ))}
            {!rows.length && (
              <tr><td colSpan={8} className="empty-tip">
                {meta.total ? '当前页无数据，请翻页或调整过滤。' : '没有符合过滤条件的待审核链路。若为 0：要么全部已审核，要么对端设备未启用 LLDP——请网络组在链路两端开启 LLDP 后重新发现。'}
              </td></tr>
            )}
          </tbody>
        </table>
        <Pager page={meta.page} size={meta.size} total={meta.total} onPage={p => { setPage(p); setSelected(new Set()); }} />
      </div>

      <div className="card" style={{ marginTop: 14, fontSize: 12, color: 'var(--text-3)', lineHeight: 1.8 }}>
        <b style={{ color: 'var(--text-2)' }}>为什么要人工确认？</b> 发现引擎每轮从 LLDP 回报建链：只有链路<b>两端都回报</b>了对方才自动升为 confirmed；
        仅单端回报的落 half（对端设备未开 LLDP 或 SNMP 采不到）。置信度含义：
        <span className="mono"> 1.0</span>=两端接口均已在本系统解析（只缺一端 LLDP 回报，通常真实直连，适合按设备批量确认）；
        <span className="mono"> 0.7/0.4</span>=按 chassis ID / 系统名部分匹配；
        <span className="mono"> 0.3</span>=对端身份无法解析（未纳管设备/终端），请核对右侧原始证据（sys_name / port_desc / chassis_id）后再决定。
        所有确认与忽略均记录操作人，可追溯。
      </div>
    </div>
  );
}

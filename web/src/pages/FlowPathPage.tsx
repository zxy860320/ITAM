/* 流量路径走势（P2 pathtrace）：输入源/目的 IP → 依据 SNMP 路由快照逐跳推出经过的设备链
 * → 沿途每条链路（LLDP 证据）/接口（无链路证据时）的 bps 流量走势。
 * 红线：hop 连线只认 topology_link 已有证据；路由下一跳仅证明"路由指向"，
 * 无链路证据标 route-only，绝不伪造连接。数据全部只读。 */
import React from 'react';
import { topoApi, usePoll } from '../api';
import { Chart, darkBase, axisStyle } from '../components/Chart';

const RANGES = ['6h', '24h', '7d', '30d'];
const fmtBps = (v: number) => {
  if (!isFinite(v)) return '-';
  if (v >= 1e9) return (v / 1e9).toFixed(2) + ' Gbps';
  if (v >= 1e6) return (v / 1e6).toFixed(2) + ' Mbps';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + ' Kbps';
  return v.toFixed(0) + ' bps';
};
const fmtT = (t: number) => {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const EV_LABEL: Record<string, [string, string]> = {
  'lldp-confirmed': ['LLDP 双端确认', 'var(--sev-ok)'],
  confirmed: ['LLDP 双端确认', 'var(--sev-ok)'],
  manual: ['人工核定', 'var(--sev-ok)'],
  half: ['单端发现(half)', 'var(--sev-warn)'],
  conflict: ['矛盾(conflict)', 'var(--sev-crit)'],
  'route-only': ['仅路由指向·无物理链路证据', 'var(--sev-warn)'],
  'lldp-half': ['LLDP 单端证据', 'var(--sev-warn)'],
};

function TrafficChart({ series, title, range }: { series: { name: string; data: { t: number; v: number }[]; color: string }[]; title: string; range: string }) {
  const option = React.useMemo(() => ({
    ...darkBase,
    title: { text: title, left: 4, top: 2, textStyle: { color: '#A1A1AA', fontSize: 12, fontWeight: 400 } },
    legend: { top: 2, right: 8, textStyle: { color: '#71717A', fontSize: 10 }, itemWidth: 14, itemHeight: 8 },
    grid: { left: 62, right: 18, top: 34, bottom: 26 },
    xAxis: { type: 'time', ...axisStyle, axisLabel: { ...axisStyle.axisLabel, formatter: (v: number) => fmtT(v) } },
    yAxis: { type: 'value', ...axisStyle, axisLabel: { ...axisStyle.axisLabel, formatter: (v: number) => fmtBps(v) } },
    tooltip: { ...darkBase.tooltip, trigger: 'axis', valueFormatter: (v: any) => fmtBps(+v) },
    series: series.map(s => ({
      name: s.name, type: 'line', showSymbol: false, smooth: true,
      lineStyle: { width: 1.4, color: s.color }, itemStyle: { color: s.color },
      areaStyle: { color: s.color, opacity: 0.06 },
      data: s.data.map(pt => [pt.t, pt.v]),
    })),
  }), [series, title, range]);
  return <Chart option={option} height={190} />;
}

interface HopTraffic { kind: 'link' | 'iface'; data?: any; error?: string; loading: boolean }

export default function FlowPathPage(_: any) {
  const [src, setSrc] = React.useState(() => localStorage.getItem('uocp.flow.src') || '');
  const [dst, setDst] = React.useState(() => localStorage.getItem('uocp.flow.dst') || '');
  const [range, setRange] = React.useState(() => localStorage.getItem('uocp.flow.range') || '24h');
  const [result, setResult] = React.useState<any | null>(null);
  const [qErr, setQErr] = React.useState('');
  const [querying, setQuerying] = React.useState(false);
  const [msg, setMsg] = React.useState('');
  const [tr, setTr] = React.useState<Record<string, HopTraffic>>({});
  const reqSeq = React.useRef(0);

  const { data: rt, reload: reloadRt } = usePoll(topoApi.rtStatus, 60000);
  const snaps: any[] = rt?.data || [];
  const okSnaps = snaps.filter((s: any) => s.status === 'ok');
  const refreshing = rt?.meta?.refreshing;

  const doRefresh = async () => {
    try { const r = await topoApi.rtRefresh(); setMsg(r.note || '已排队'); setTimeout(() => setMsg(''), 6000); reloadRt(); }
    catch (e: any) { setMsg('刷新失败：' + e.message); }
  };

  const query = async (rangeArg?: string) => {
    const useRange = rangeArg || range; // 显式参数避免 setState 后闭包读到旧 range
    if (!src || !dst) { setQErr('请输入源和目的 IP'); return; }
    localStorage.setItem('uocp.flow.src', src); localStorage.setItem('uocp.flow.dst', dst);
    setQuerying(true); setQErr(''); setResult(null); setTr({});
    const seq = ++reqSeq.current;
    try {
      const r = await topoApi.pathtrace(src, dst);
      if (seq !== reqSeq.current) return;
      setResult(r.data);
      // 拉取每跳流量：统一走本端"出接口"视角（接口级 mapping，与 hop 链一一对应）
      const chains: any[] = r.data.chains || [];
      for (let ci = 0; ci < chains.length; ci++) {
        for (let hi = 0; hi < chains[ci].hops.length; hi++) {
          const h = chains[ci].hops[hi];
          const key = `${ci}-${hi}`;
          if (!h.out_iface_id) continue;
          setTr(t => ({ ...t, [key]: { kind: 'iface', loading: true } }));
          try {
            const d = await topoApi.ifaceTraffic(h.out_iface_id, useRange);
            if (seq !== reqSeq.current) return;
            setTr(t => ({ ...t, [key]: { kind: 'iface', data: d.data, loading: false } }));
          } catch (e: any) {
            if (seq !== reqSeq.current) return;
            setTr(t => ({ ...t, [key]: { kind: 'iface', error: e.message, loading: false } }));
          }
        }
      }
    } catch (e: any) {
      if (seq === reqSeq.current) setQErr(String(e.message || e));
    } finally { if (seq === reqSeq.current) setQuerying(false); }
  };

  const changeRange = (r: string) => {
    setRange(r); localStorage.setItem('uocp.flow.range', r);
    if (result) query(r); // 重新按新窗口拉流量（路径本身不随时间变，但实现上整链重查最简单可靠）
  };

  const chains: any[] = result?.chains || [];
  const meta = result?.meta;
  const anyChainComplete = chains.some(c => c.complete);

  return (
    <div>
      <div className="card" style={{ padding: '12px 14px', marginBottom: 12 }}>
        <div className="toolbar" style={{ flexWrap: 'wrap', gap: 8 }}>
          <span className="card-title" style={{ margin: 0 }}>流量路径走势</span>
          <span style={{ color: 'var(--text-3)', fontSize: 11 }}>源 → 目的，依据 SNMP 路由表快照逐跳推出经过的设备；
            连线只认 LLDP/人工核定证据，仅路由指向的跳如实标注</span>
        </div>
        <div className="toolbar" style={{ flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
          <input placeholder="源 IP（如 10.14.2.100）" value={src} onChange={e => setSrc(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && query()} className="input" style={{ width: 200 }} />
          <span style={{ color: 'var(--text-3)' }}>→</span>
          <input placeholder="目的 IP（如 10.25.30.5）" value={dst} onChange={e => setDst(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && query()} className="input" style={{ width: 200 }} />
          <button className="btn primary" onClick={() => query()} disabled={querying}>{querying ? '追踪中…' : '查询路径'}</button>
          <span className="spacer" style={{ flex: 1 }} />
          {RANGES.map(r => (
            <button key={r} className={`btn ${r === range ? 'primary' : ''}`} onClick={() => changeRange(r)}>{r}</button>
          ))}
        </div>
        <div className="toolbar" style={{ flexWrap: 'wrap', gap: 8, marginTop: 8, fontSize: 12, color: 'var(--text-3)' }}>
          <span>路由快照：{okSnaps.length} 台正常{snaps.length ? ` / 共 ${snaps.length} 台` : ''}
            {rt?.meta?.last_refresh ? ` · 最近刷新 ${new Date(rt.meta.last_refresh.at * 1000).toLocaleString('zh-CN')}` : ' · 尚未刷新'}
          </span>
          <button className="btn" onClick={doRefresh} disabled={refreshing}>{refreshing ? '快照刷新中…' : '刷新路由快照'}</button>
          {msg && <span style={{ color: 'var(--sev-info)' }}>{msg}</span>}
          {qErr && <span style={{ color: 'var(--sev-crit)' }}>{qErr}</span>}
        </div>
      </div>

      {!result && !querying && snaps.length === 0 && (
        <div className="card" style={{ padding: 16, color: 'var(--text-3)', fontSize: 13 }}>
          尚无路由快照。点击「刷新路由快照」为 L3 设备（核心/汇聚/防火墙）读取 SNMP 路由表与接口地址表（只读、用后即删），完成后再查询路径。
        </div>
      )}
      {result && meta && (
        <>
          <div className="card" style={{ padding: '10px 14px', marginBottom: 12, fontSize: 12 }}>
            <span style={{ color: 'var(--text-2)' }}>
              {meta.src} → {meta.dst} · 快照设备 {meta.snapshot_nodes} 台 · 入口候选 {meta.entry_candidates.length} 台
              {meta.dst_direct_on.length ? <> · 目的直连于 <b style={{ color: 'var(--sev-ok)' }}>{meta.dst_direct_on.join('、')}</b></> : ' · 目的不在任何快照设备直连网段（将追踪到设备边界）'}
              {anyChainComplete ? '' : '（未能追到"目的直连"一跳——沿途流量仍可参考）'}
            </span>
            {meta.warnings?.length ? <div style={{ marginTop: 6, color: 'var(--sev-warn)' }}>{meta.warnings.map((w: string, i: number) => <div key={i}>⚠ {w}</div>)}</div> : null}
          </div>
          {chains.map((c: any, ci: number) => (
            <div key={ci} className="card" style={{ padding: '12px 14px', marginBottom: 12 }}>
              <div style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 8 }}>
                路径 {ci + 1}：{c.hops.map((h: any) => h.name).join(' → ')}
                {c.complete ? <span style={{ color: 'var(--sev-ok)', marginLeft: 8 }}>✓ 已追到目的直连</span>
                  : <span style={{ color: 'var(--sev-warn)', marginLeft: 8 }}>△ 未达目的直连（见告警）</span>}
              </div>
              {/* 设备链横条 */}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'stretch', marginBottom: 12 }}>
                {c.hops.map((h: any, hi: number) => (
                  <React.Fragment key={hi}>
                    {hi > 0 && <span style={{ alignSelf: 'center', color: h.link ? 'var(--sev-ok)' : 'var(--sev-warn)', fontSize: 15 }}>→</span>}
                    <div style={{ border: '1px solid var(--hairline)', borderRadius: 'var(--radius-sm)', padding: '6px 9px', background: 'var(--bg-inset)', minWidth: 150 }}>
                      <div style={{ fontSize: 12, color: 'var(--text-1)' }}>{h.name}</div>
                      <div style={{ fontSize: 10, color: 'var(--text-3)' }}>入 {h.in_iface || '-'} · 出 {h.out_iface || '-'}</div>
                      {h.route && <div style={{ fontSize: 10, color: 'var(--text-3)' }}>路由 {h.route.dest}/{h.route.mask}
                        {h.route.next_hop && h.route.next_hop !== '0.0.0.0' ? ` → ${h.route.next_hop}` : '（直连）'}</div>}
                      {h.link ? <div style={{ fontSize: 10, color: (EV_LABEL[h.evidence]?.[1]) }}>链路#{h.link.link_id} · {EV_LABEL[h.evidence]?.[0] || h.evidence}{h.via === 'lldp-peer' ? ' · IP未知·按物理邻居续跳' : ''}</div>
                        : h.next_hop_unmanaged ? <div style={{ fontSize: 10, color: 'var(--sev-warn)' }}>下一跳 {h.next_hop_unmanaged} 未纳管</div>
                        : h.action === 'direct' ? <div style={{ fontSize: 10, color: 'var(--sev-ok)' }}>目的直连本机</div>
                        : h.action === 'no-snapshot' ? <div style={{ fontSize: 10, color: 'var(--sev-warn)' }}>沿 LLDP 到达 · 暂无路由快照（链末）</div>
                        : h.action === 'no-route' ? <div style={{ fontSize: 10, color: 'var(--sev-warn)' }}>路由表无匹配目的（L2 转发或快照无路由条目）</div>
                        : null}
                    </div>
                  </React.Fragment>
                ))}
              </div>
              {/* 每跳流量面板 */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 10 }}>
                {c.hops.map((h: any, hi: number) => {
                  const key = `${ci}-${hi}`;
                  const t = tr[key];
                  if (!t && !h.out_iface_id) return null;
                  const title = `${h.name} · 出接口 ${h.out_iface || ''}${h.out_iface_id ? '' : '（未定位接口）'}`;
                  return (
                    <div key={key} style={{ border: '1px solid var(--hairline)', borderRadius: 'var(--radius-sm)', padding: 6 }}>
                      {t?.loading ? <div style={{ height: 190, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-3)', fontSize: 12 }}>流量取数中…</div>
                        : t?.error ? <div style={{ padding: 12, color: 'var(--sev-crit)', fontSize: 12 }}>{title}：{t.error}</div>
                        : t?.data ? (
                          <TrafficChart range={range} title={title}
                            series={[
                              { name: 'in', data: t.data.if_in?.avg || [], color: '#38BDF8' },
                              { name: 'out', data: t.data.if_out?.avg || [], color: '#FB923C' },
                            ]} />
                        ) : <div style={{ height: 190, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-3)', fontSize: 12 }}>等待取数…</div>}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
          {!chains.length && meta && (
            <div className="card" style={{ padding: 16, color: 'var(--text-3)', fontSize: 13 }}>
              未找到入口：源地址不在任何已快照设备的直连网段内。可尝试：① 刷新路由快照 ② 用该 VLAN 的网关设备 IP 所在的 L3 设备补充快照（POST /api/topology/pathtrace/refresh 传 node_ids）。
            </div>
          )}
        </>
      )}
    </div>
  );
}

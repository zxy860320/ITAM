/* 拓扑页右侧面板：详情 / 邻居展开 / 未关联设备 + 链路证据卡（可追溯 LLDP） */
import React from 'react';
import { TopoLink } from './TopoCanvas';

const trunc = (s: string | null | undefined, n: number) => (s && s.length > n ? s.slice(0, n - 1) + '…' : (s || ''));
const fmtTs = (ts: any): string => (!ts ? '—' : new Date(ts * 1000).toLocaleString('zh-CN', { hour12: false }));
const operTxt = (o: any) => o === 1 ? <span className="tc-st-ok">up</span> : o === 2 ? <span className="tc-st-crit">down</span> : <span className="tc-st-dim">未知</span>;
export const stTxt = (s: string) =>
  s === 'confirmed' ? <span className="tc-st-ok">已确认（双端各自观察到对端）</span>
    : s === 'manual' ? <span className="tc-st-ok">人工确认</span>
    : s === 'half' ? <span className="tc-st-warn">单端发现（half）· 待网络组核实</span>
    : s === 'conflict' ? <span className="tc-st-crit">双端信息矛盾</span> : s;

export function LinkEvidence({ l, byId, compact, onTraffic }: { l: TopoLink; byId: Map<number, any>; compact?: boolean; onTraffic: () => void }) {
  const a = byId.get(l.a);
  const bM = l.b != null ? byId.get(l.b) : null;
  const snap = l.b_snapshot;
  const bTitle = bM ? trunc(bM.display_name, 20)
    : <>{(snap && snap.sys_name ? trunc(snap.sys_name, 20) : '未纳管对端')}<span className="tc-st-ext">（未纳管）</span></>;
  return (
    <div className="tc-linkcard">
      <div className="t">{trunc(a ? a.display_name : '#' + l.a, 20)} ⇄ {bTitle}</div>
      <div className="tc-kv">
        <span className="k">链路 ID</span><span className="v mono">#{l.link_id}</span>
        <span className="k">状态</span><span className="v">{stTxt(l.status)}</span>
        <span className="k">发现来源</span><span className="v">{l.source === 'lldp_zbx' ? 'LLDP（Zabbix SNMP 只读采集）' : l.source === 'manual' ? '人工确认' : (l.source || '?')}</span>
        <span className="k">置信度</span><span className="v">{l.confidence}</span>
        <span className="k">A 端</span><span className="v">{a ? <>{trunc(a.display_name, 22)} <span className="mono tc-st-dim">{a.mgmt_ip || ''}</span><br /></> : ''}<span className="mono">{l.a_if || '?'}</span> · {operTxt(l.a_oper)}</span>
        <span className="k">B 端</span><span className="v">{bM
          ? <>{trunc(bM.display_name, 22)} <span className="mono tc-st-dim">{bM.mgmt_ip || ''}</span><br /><span className="mono">{l.b_if || '?'}</span> · {operTxt(l.b_oper)}</>
          : snap ? <><span className="tc-st-ext">未纳管</span> 快照邻居名 <span className="mono">{snap.sys_name || '?'}</span><br />快照端口 <span className="mono">{snap.port_id || '?'}</span><br />chassis-id <span className="mono">{snap.chassis_id || '?'}</span></> : '—'}</span>
        {!compact && <>
          <span className="k">A 侧观察于</span><span className="v mono">{fmtTs(l.seen_a_at)}</span>
          <span className="k">B 侧观察于</span><span className="v mono">{fmtTs(l.seen_b_at)}{l.seen_b_at ? '' : '（B 端未观察到）'}</span>
          <span className="k">证据键</span><span className="v mono tc-st-dim">{l.norm_key}</span>
        </>}
      </div>
      <button className="btn" style={{ padding: '3px 10px', fontSize: 11 }} onClick={onTraffic}>查看两端流量曲线</button>
    </div>
  );
}

export function PanelBody(props: {
  tab: 'detail' | 'neighbors' | 'unlinked';
  sel: any; focus: number;
  canvasRef: React.MutableRefObject<any>;
  byId: Map<number, any>; linkById: Map<number, TopoLink>;
  onTraffic: (l: TopoLink) => void;
  onFocus: (nid: number) => void;
  onSelEdge: (lid: number) => void;
}) {
  const { tab, sel, focus, canvasRef, byId, linkById, onTraffic, onFocus, onSelEdge } = props;

  if (tab === 'unlinked') {
    const list = canvasRef.current ? canvasRef.current.unlinkedNodes() : [];
    return (
      <div>
        <div className="tc-note">以下 <b>{list.length}</b> 台纳管设备当前<b>没有任何已发现的真实链路</b>（LLDP 未开启 / 对端不支持 / 尚未被发现轮覆盖）。按设计要求，它们不进入任何连线图，绝不伪造连接。点击可聚焦查看其设备卡片。</div>
        <div className="tc-devlist" style={{ marginTop: 8 }}>
          {list.map((n: any) => (
            <div key={n.node_id} className="tc-devrow" onClick={() => onFocus(n.node_id)}>
              <div className="nm2">{n.display_name}</div>
              <div className="sub mono">{n.mgmt_ip || '—'} · {n.vendor} · {n.iface_count} 接口{n.status === 'degraded' ? ' · 降级' : ''}</div>
            </div>
          ))}
        </div>
      </div>
    );
  }
  if (tab === 'neighbors') {
    const ls: TopoLink[] = canvasRef.current ? canvasRef.current.linksOf(focus) : [];
    return (
      <div>
        <div className="tc-note">聚焦设备（{byId.get(focus)?.display_name}）的全部真实链路（{ls.length} 条）。点链路行查看证据；切换"1跳/2跳"扩大画布范围。</div>
        <div className="tc-devlist" style={{ marginTop: 8 }}>
          {ls.map((l) => {
            const peerN = l.a === focus ? l.b : l.a;
            const pn = peerN != null ? byId.get(peerN) : null;
            const ownIf = l.a === focus ? l.a_if : l.b_if;
            const peerIf = peerN != null ? (l.a === focus ? l.b_if : l.a_if) : (l.b_snapshot && l.b_snapshot.port_id);
            return (
              <div key={l.link_id} className="tc-devrow" onClick={() => onSelEdge(l.link_id)}>
                <div className="nm2">{pn ? pn.display_name : ((l.b_snapshot && l.b_snapshot.sys_name) || '未纳管对端') + '（未纳管）'}</div>
                <div className="sub mono">{ownIf || '?'} ⇄ {peerIf || '?'} · {l.status}</div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }
  /* detail */
  if (!focus) {
    return (
      <div>
        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>全网总览</div>
        <div className="tc-note">当前显示全部纳管设备与全部真实证据链路（绿色=双端确认，黄色=单端 half，紫色虚线=未纳管对端快照）。<br /><br />
          点击画布中任一设备卡片 → 进入以该设备为中心的一跳/两跳上下游视图；点击链路 → 查看 LLDP 证据。无连线的卡片表示尚未发现真实链路，按红线不伪造。</div>
      </div>
    );
  }
  if (sel && sel.kind === 'edge') {
    const l = linkById.get(sel.id as number);
    if (l) return <div><div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>链路详情与 LLDP 证据（可追溯）</div><LinkEvidence l={l} byId={byId} onTraffic={() => onTraffic(l)} /></div>;
  }
  if (sel && sel.kind === 'ext') {
    const s = canvasRef.current?.extSnapshot(sel.id as string);
    return (
      <div>
        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>未纳管对端（仅 LLDP 快照证据）</div>
        <div className="tc-kv">
          <span className="k">邻居名</span><span className="v mono">{s?.sys_name || '?'}</span>
          <span className="k">端口</span><span className="v mono">{s?.port_id || '?'}</span>
          <span className="k">端口描述</span><span className="v mono">{s?.port_desc || '?'}</span>
          <span className="k">chassis-id</span><span className="v mono">{s?.chassis_id || '?'}</span>
        </div>
        <div className="tc-note">该对端不在 Zabbix 纳管范围，无法读取其接口/状态。链路保留为 half（单端证据），等待网络组核查纳管后自动升级。不猜测其 IP / 型号 / 层级。</div>
      </div>
    );
  }
  const n = byId.get(focus);
  if (!n) return <div className="empty-tip" style={{ fontSize: 12, color: 'var(--text-3)' }}>点击画布中的设备卡片查看详情</div>;
  const ls: TopoLink[] = (canvasRef.current?.linksOf(focus) || []).slice().sort((x: TopoLink, y: TopoLink) => (x.status === y.status ? 0 : x.status === 'confirmed' ? -1 : 1));
  const nm = ls.filter((l: TopoLink) => l.b == null).length;
  return (
    <div>
      <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>{n.display_name}</div>
      <div className="tc-kv">
        <span className="k">管理 IP</span><span className="v mono">{n.mgmt_ip || '—'}</span>
        <span className="k">设备类型</span><span className="v">{n.node_type === 'switch' ? '交换机' : (n.node_type || '?')}（node_type）</span>
        <span className="k">网络角色</span><span className="v tc-st-warn">未分类（network_role 尚未人工核定，不强行归层）</span>
        <span className="k">厂商</span><span className="v">{n.vendor || '?'}</span>
        <span className="k">监控状态</span><span className="v">{n.status === 'degraded' ? <span className="tc-st-warn">降级（无接口监控项）</span> : <span className="tc-st-ok">正常（active）</span>}</span>
        <span className="k">接口数</span><span className="v">{n.iface_count}</span>
        <span className="k">真实链路</span><span className="v">{ls.length} 条（其中 {nm} 条对端未纳管）</span>
      </div>
      <div style={{ fontSize: 12, fontWeight: 700, margin: '8px 0 6px' }}>全部链路</div>
      {ls.map((l) => <LinkEvidence key={l.link_id} l={l} byId={byId} compact onTraffic={() => onTraffic(l)} />)}
    </div>
  );
}

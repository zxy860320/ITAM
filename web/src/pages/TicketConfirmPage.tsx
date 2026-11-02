import React from 'react';
import { api } from '../api';

// ============================================================
// 工单确认页（免登录）——确认人从邮件链接进入：
//   #/ticket-confirm?token=xxx
// token 由后端一次性校验：无效/已用/已取消 → 404 提示。
// ============================================================

const PRI_LABEL: Record<string, string> = { low: '低', normal: '普通', high: '高' };
const fmt = (ts: number) => new Date(ts).toLocaleString('zh-CN');

export default function TicketConfirmPage({ hash }: { hash: string }) {
  const token = React.useMemo(() => {
    const qi = hash.indexOf('?');
    return qi >= 0 ? (new URLSearchParams(hash.slice(qi + 1)).get('token') || '') : '';
  }, [hash]);

  const [info, setInfo] = React.useState<any | null>(null);
  const [loadErr, setLoadErr] = React.useState('');
  const [state, setState] = React.useState<'loading' | 'form' | 'confirming' | 'done' | 'error'>('loading');
  const [err, setErr] = React.useState('');

  React.useEffect(() => {
    if (!token) { setState('error'); setLoadErr('链接缺少确认参数（token）。请使用邮件里的完整链接。'); return; }
    api.ticketConfirmInfo(token)
      .then(d => { setInfo(d); setState(d.status === 'pending' ? 'form' : d.status === 'confirmed' ? 'done' : 'error'); if (d.status !== 'pending') setLoadErr(`该工单已是「${d.statusLabel}」状态，无需处理。`); })
      .catch(e => { setState('error'); setLoadErr(e.message === '/ticket-confirm/info -> 404' ? '确认链接无效或已使用。如需重新确认，请联系工单创建人重发邮件。' : e.message); });
  }, [token]);

  const doConfirm = async () => {
    setState('confirming');
    try {
      await api.ticketConfirm(token);
      setState('done');
      setInfo((x: any) => x ? { ...x, status: 'confirmed', statusLabel: '已结束' } : x);
    } catch (e: any) { setErr(e.message); setState('error'); }
  };

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="login-brand">
          <div className="brand-name">IT运维监控平台 · 工单确认</div>
          <div className="brand-sub">TICKET CONFIRMATION</div>
        </div>

        {state === 'loading' && <div style={{ textAlign: 'center', color: 'var(--text-3)', padding: '26px 0' }}>正在读取工单…</div>}

        {(state === 'error') && (
          <div className="login-err" style={{ whiteSpace: 'pre-wrap' }}>{err || loadErr}</div>
        )}

        {info && state !== 'error' && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '6px 0 12px' }}>
              <span className="mono" style={{ fontSize: 12, color: 'var(--text-3)' }}>{info.no}</span>
              <span className={`badge ${info.status === 'confirmed' ? 'healthy' : 'warning'}`}><i className="bdot" />{info.statusLabel}</span>
              <span className="tag-chip">优先级 {PRI_LABEL[info.priority]}</span>
            </div>
            <div style={{ fontSize: 16, fontWeight: 600, margin: '2px 0 10px' }}>{info.title}</div>
            <div style={{ fontSize: 12, color: 'var(--text-3)', display: 'grid', gap: 4, marginBottom: 12 }}>
              <span>创建人：{info.createBy || '—'}　·　创建时间：{fmt(info.createdAt)}</span>
              <span>确认人：{info.confirmer}{info.phone ? `　·　电话：${info.phone}` : ''}</span>
            </div>
            <div style={{ background: 'var(--bg-inset)', border: '1px solid var(--hairline)', borderLeft: '3px solid var(--dom-network)', borderRadius: 6, padding: '10px 12px', whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.6, maxHeight: '32vh', overflow: 'auto', marginBottom: 18 }}>
              {info.content}
            </div>
            {state === 'form' && (
              <button className="btn primary" onClick={doConfirm} style={{ width: '100%', padding: '11px 0' }}>确认工单（确认后工单结束）</button>
            )}
            {state === 'confirming' && (
              <button className="btn primary" disabled style={{ width: '100%', padding: '11px 0' }}>确认中…</button>
            )}
            {state === 'done' && (
              <div style={{ background: 'rgba(76,175,80,.10)', border: '1px solid rgba(76,175,80,.35)', color: 'var(--sev-healthy)', borderRadius: 6, padding: '11px 14px', fontSize: 13, textAlign: 'center' }}>
                ✓ 已确认，工单 {info.no} 已结束。感谢您的确认，本页可关闭。
              </div>
            )}
          </>
        )}

        <div className="login-foot">
          <a href="#/dashboard" className="mono" style={{ fontSize: 11, color: 'var(--text-3)' }}>← 返回监控大屏</a>
        </div>
      </div>
    </div>
  );
}

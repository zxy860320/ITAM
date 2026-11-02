import React from 'react';
import { api } from '../api';

// ============================================================
// 个人工作台 · 工单
// 录入（确认人姓名/邮箱必填、电话选填）→ 保存即发邮件给确认人
// → 确认人点邮件链接确认 → 工单结束（免登录，token 一次性）
// 邮件失败醒目提示 + 重发（换新 token，旧链接作废）
// ============================================================

const PRI_LABEL: Record<string, string> = { low: '低', normal: '普通', high: '高' };
const ST_LABEL: Record<string, string> = { pending: '待确认', confirmed: '已结束', cancelled: '已取消' };
const fmt = (ts: number | null) => ts ? new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';

const EMPTY_FORM = { title: '', content: '', priority: 'normal', cname: '', cemail: '', cphone: '' };

export default function TicketPage() {
  const [tab, setTab] = React.useState<'all' | 'pending' | 'confirmed' | 'cancelled'>('all');
  const [q, setQ] = React.useState('');
  const [page, setPage] = React.useState(1);
  const [data, setData] = React.useState<any>(null);
  const [form, setForm] = React.useState({ ...EMPTY_FORM });
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<{ kind: 'ok' | 'err' | 'warn'; text: string } | null>(null);
  const [detail, setDetail] = React.useState<any>(null);

  const load = React.useCallback(() => {
    api.tickets({ status: tab === 'all' ? '' : tab, q, page, size: 15 }).then(setData).catch(e => setMsg({ kind: 'err', text: `加载失败：${e.message}` }));
  }, [tab, q, page]);
  React.useEffect(() => { load(); }, [load]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setMsg(null);
    try {
      const r = await api.ticketCreate({
        title: form.title, content: form.content, priority: form.priority,
        confirmer: { name: form.cname, email: form.cemail, phone: form.cphone },
      });
      if (r.mail?.ok) setMsg({ kind: 'ok', text: `工单 ${r.ticket.no} 已创建，确认邮件已发送至 ${r.ticket.confirmer.email}` });
      else setMsg({ kind: 'warn', text: `工单 ${r.ticket.no} 已创建，但邮件发送失败：${r.mail?.error || '未知原因'}。可在列表「重发邮件」重试（通常是 SMTP 通道未配置）。` });
      setForm({ ...EMPTY_FORM });
      setPage(1); load();
    } catch (e: any) { setMsg({ kind: 'err', text: e.message }); }
    finally { setBusy(false); }
  };

  const resend = async (t: any) => {
    if (!window.confirm(`重发确认邮件给 ${t.confirmer.name} <${t.confirmer.email}>？\n（旧确认链接将作废，改发新链接）`)) return;
    try {
      const r = await api.ticketResend(t.id);
      setMsg(r.mail?.ok
        ? { kind: 'ok', text: `已重发 ${r.ticket.no} 确认邮件` }
        : { kind: 'warn', text: `重发失败：${r.mail?.error || '未知原因'}` });
      load();
    } catch (e: any) { setMsg({ kind: 'err', text: e.message }); }
  };

  const cancel = async (t: any) => {
    if (!window.confirm(`取消工单 ${t.no}？取消后确认链接作废。`)) return;
    try { await api.ticketCancel(t.id); setMsg({ kind: 'ok', text: `工单 ${t.no} 已取消` }); load(); }
    catch (e: any) { setMsg({ kind: 'err', text: e.message }); }
  };

  const stats = data?.stats;
  const rows = data?.data || [];
  const total = data?.total || 0;
  const pages = Math.max(1, Math.ceil(total / 15));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {msg && (
        <div className="card" style={{ borderLeft: `3px solid ${msg.kind === 'ok' ? 'var(--sev-healthy)' : msg.kind === 'warn' ? 'var(--sev-warning)' : 'var(--sev-critical)'}` }}>
          <span style={{ fontSize: 12.5 }}>{msg.text}</span>
          <span className="spacer" style={{ flex: 1 }} />
          <button className="btn" style={{ float: 'right', padding: '2px 10px' }} onClick={() => setMsg(null)}>✕</button>
        </div>
      )}

      {/* 录入表单 */}
      <div className="card">
        <div className="card-title">新建工单 <span className="tag-chip">保存即发邮件给确认人，确认后工单结束</span></div>
        <form onSubmit={submit} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 18px' }}>
          <div className="field" style={{ gridColumn: '1 / -1' }}>
            <label>工单标题 *</label>
            <input value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} placeholder="例：机房空调滤网清洗申请" required maxLength={200} />
          </div>
          <div className="field" style={{ gridColumn: '1 / -1' }}>
            <label>工单内容 *</label>
            <textarea value={form.content} onChange={e => setForm(f => ({ ...f, content: e.target.value }))}
              placeholder="详细描述需求、时间窗口、涉及设备等" required rows={5} style={{ resize: 'vertical', background: 'var(--bg-inset)', color: 'var(--text-1)', border: '1px solid var(--hairline)', borderRadius: 6, padding: '8px 10px', font: 'inherit' }} />
          </div>
          <div className="field">
            <label>优先级</label>
            <select value={form.priority} onChange={e => setForm(f => ({ ...f, priority: e.target.value }))}>
              <option value="low">低</option><option value="normal">普通</option><option value="high">高</option>
            </select>
          </div>
          <div className="field">
            <label>确认人姓名 *</label>
            <input value={form.cname} onChange={e => setForm(f => ({ ...f, cname: e.target.value }))} placeholder="张三" required />
          </div>
          <div className="field">
            <label>确认人邮箱 *（接收确认邮件）</label>
            <input type="email" value={form.cemail} onChange={e => setForm(f => ({ ...f, cemail: e.target.value }))} placeholder="zhangsan@corp.local" required />
          </div>
          <div className="field">
            <label>确认人电话（选填）</label>
            <input value={form.cphone} onChange={e => setForm(f => ({ ...f, cphone: e.target.value }))} placeholder="13800000000 / 8001" />
          </div>
          <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 10, alignItems: 'center' }}>
            <button className="btn primary" type="submit" disabled={busy}>{busy ? '提交中…' : '提交工单并发确认邮件'}</button>
            <span style={{ fontSize: 11, color: 'var(--text-3)' }}>确认人无需平台账号——邮件链接一键确认，确认后工单即结束。</span>
          </div>
        </form>
      </div>

      {/* 列表 */}
      <div className="card">
        <div className="card-title">
          工单列表
          {stats && (
            <span className="tag-chip">共 {stats.total} · 待确认 {stats.pending} · 已结束 {stats.confirmed}{stats.mailFail ? ` · ⚠ 邮件失败 ${stats.mailFail}` : ''}</span>
          )}
          <span className="spacer" />
          <input value={q} onChange={e => { setQ(e.target.value); setPage(1); }} placeholder="搜索单号/标题/确认人"
            style={{ width: 180, background: 'var(--bg-inset)', color: 'var(--text-1)', border: '1px solid var(--hairline)', borderRadius: 6, padding: '5px 8px', font: 'inherit', fontSize: 12 }} />
          {(['all', 'pending', 'confirmed', 'cancelled'] as const).map(t => (
            <button key={t} className={`btn ${tab === t ? 'primary' : ''}`} style={{ padding: '4px 10px', fontSize: 12 }}
              onClick={() => { setTab(t); setPage(1); }}>{t === 'all' ? '全部' : ST_LABEL[t]}</button>
          ))}
        </div>
        <table className="data nowrap">
          <thead>
            <tr>
              <th style={{ width: 130 }}>单号</th><th>标题</th><th style={{ width: 60 }}>优先级</th>
              <th style={{ width: 150 }}>确认人</th><th style={{ width: 90 }}>状态</th>
              <th style={{ width: 90 }}>创建</th><th style={{ width: 90 }}>确认时间</th><th style={{ width: 170 }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {!rows.length && <tr><td colSpan={8} className="empty-tip">暂无工单——在上方录入第一张</td></tr>}
            {rows.map((t: any) => {
              const lastMail = t.mailLog?.[t.mailLog.length - 1];
              const mailBad = t.status === 'pending' && lastMail && !lastMail.ok;
              return (
                <tr key={t.id} style={{ cursor: 'pointer' }} onClick={() => setDetail(t)}>
                  <td className="mono">{t.no}</td>
                  <td>{t.title}{mailBad && <span className="badge warning" style={{ marginLeft: 6 }}><i className="bdot" />邮件失败</span>}</td>
                  <td><span className={`badge ${t.priority === 'high' ? 'severe' : t.priority === 'low' ? 'info' : 'healthy'}`}><i className="bdot" />{PRI_LABEL[t.priority]}</span></td>
                  <td>{t.confirmer.name}{t.confirmer.phone ? ` · ${t.confirmer.phone}` : ''}<div style={{ fontSize: 11, color: 'var(--text-3)' }}>{t.confirmer.email}</div></td>
                  <td><span className={`badge ${t.status === 'confirmed' ? 'healthy' : t.status === 'cancelled' ? 'info' : 'warning'}`}><i className="bdot" />{ST_LABEL[t.status]}</span></td>
                  <td className="mono" style={{ fontSize: 11 }}>{fmt(t.createdAt)}</td>
                  <td className="mono" style={{ fontSize: 11 }}>{fmt(t.confirmedAt)}</td>
                  <td onClick={e => e.stopPropagation()}>
                    {t.status === 'pending' && <>
                      <button className="btn" style={{ padding: '3px 9px', fontSize: 11 }} onClick={() => resend(t)}>重发邮件</button>{' '}
                      <button className="btn" style={{ padding: '3px 9px', fontSize: 11 }} onClick={() => cancel(t)}>取消</button>
                    </>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="table-foot">
          <span>共 {total} 条</span>
          <span className="spacer" style={{ flex: 1 }} />
          <span className="pager">
            <button disabled={page <= 1} onClick={() => setPage(p => p - 1)}>‹</button>
            <button className="cur">{page}/{pages}</button>
            <button disabled={page >= pages} onClick={() => setPage(p => p + 1)}>›</button>
          </span>
        </div>
      </div>

      {/* 详情弹层 */}
      {detail && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => setDetail(null)}>
          <div className="card" style={{ width: 620, maxWidth: '92vw', maxHeight: '82vh', overflow: 'auto' }} onClick={e => e.stopPropagation()}>
            <div className="card-title">
              <span className="mono">{detail.no}</span>
              <span className={`badge ${detail.status === 'confirmed' ? 'healthy' : detail.status === 'cancelled' ? 'info' : 'warning'}`}><i className="bdot" />{ST_LABEL[detail.status]}</span>
              <span className="spacer" />
              <button className="btn" style={{ padding: '2px 10px' }} onClick={() => setDetail(null)}>✕</button>
            </div>
            <h3 style={{ margin: '4px 0 10px', fontSize: 16 }}>{detail.title}</h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, fontSize: 12, color: 'var(--text-2)', marginBottom: 10 }}>
              <div>创建人：{detail.createBy || '—'}</div>
              <div>优先级：{PRI_LABEL[detail.priority]}</div>
              <div>确认人：{detail.confirmer.name}（{detail.confirmer.email}）</div>
              <div>电话：{detail.confirmer.phone || '—'}</div>
              <div>创建时间：{new Date(detail.createdAt).toLocaleString('zh-CN')}</div>
              <div>确认时间：{new Date(detail.confirmedAt || 0).toLocaleString('zh-CN')}{detail.confirmedAt ? '' : '—'}</div>
            </div>
            <div style={{ background: 'var(--bg-inset)', borderLeft: '3px solid var(--dom-network)', padding: '10px 12px', whiteSpace: 'pre-wrap', fontSize: 13, borderRadius: 6 }}>{detail.content}</div>
            {detail.mailLog?.length > 0 && (
              <div style={{ marginTop: 12, fontSize: 11, color: 'var(--text-3)' }}>
                邮件记录：{detail.mailLog.map((m: any, i: number) => (
                  <div key={i}>{new Date(m.at).toLocaleString('zh-CN')} {m.ok ? '✓ 已发送' : `✗ 失败：${m.error}`}</div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

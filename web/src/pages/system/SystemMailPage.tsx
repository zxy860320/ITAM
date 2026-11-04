import React from 'react';
import { api } from '../../api';

/** 系统管理 · 邮件服务：SMTP 唯一配置源（告警推送与工单邮件都调用这里的配置），保存后可发测试邮件验证 */
export default function SystemMailPage() {
  const [mail, setMail] = React.useState<any>(null);
  const [form, setForm] = React.useState<any>(null);
  const [saving, setSaving] = React.useState(false);
  const [testing, setTesting] = React.useState(false);
  const [to, setTo] = React.useState('');
  const [msg, setMsg] = React.useState<any>(null);

  const load = React.useCallback(() => {
    api.mail().then(d => { setMail(d); setForm((f: any) => f ?? d); }).catch(() => {});
  }, []);
  React.useEffect(() => { load(); }, [load]);
  React.useEffect(() => { if (mail && !form) setForm(mail); }, [mail, form]);

  const set = (k: string, v: any) => setForm((f: any) => ({ ...f, [k]: v }));

  async function save() {
    setSaving(true); setMsg(null);
    try {
      const r = await api.mailSave(form);
      setMsg({ ok: true, text: '已保存（告警推送、工单邮件即刻起使用新配置）' });
      setMail(r.mail); setForm(null); load();
    } catch (e: any) { setMsg({ ok: false, text: String(e.message || e) }); }
    setSaving(false);
  }
  async function test() {
    setTesting(true); setMsg(null);
    try {
      const r = await api.mailTest(to);
      setMsg({ ok: true, text: `✔ 测试邮件已真实发出（${r.latencyMs ?? '?'}ms${r.messageId ? ` · ${r.messageId}` : ''}），请到收件箱确认` });
    } catch (e: any) { setMsg({ ok: false, text: `✘ 发送失败：${String(e.message || e).slice(0, 160)}` }); }
    setTesting(false);
    load();
  }

  if (!mail) return <div className="card"><div className="card-title">邮件服务（SMTP）</div><div style={{ color: 'var(--text-3)' }}>加载中…</div></div>;
  const f = form ?? mail;

  return (
    <div>
      <div className="card">
        <div className="card-title">邮件服务（SMTP）— 全平台收发邮件的唯一配置源</div>
        <div style={{ color: 'var(--text-3)', fontSize: 12, marginBottom: 10 }}>
          告警推送（告警出口页的邮件通道）与工单确认邮件都调用这里配置的发件通道；「告警出口」页只决定"发给谁"，SMTP 参数统一在此维护。
        </div>
        <div className="grid-2" style={{ gap: 10 }}>
          <div className="field"><label>SMTP 主机</label>
            <input value={f.host} onChange={e => set('host', e.target.value)} placeholder="smtp.partner.outlook.cn / smtp.exmail.qq.com" /></div>
          <div className="field"><label>端口 / 加密</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input style={{ width: 90 }} type="number" value={f.port} onChange={e => set('port', Number(e.target.value))} />
              <div className="seg" style={{ width: 'fit-content' }}>
                <button className={f.secure ? 'on' : ''} onClick={() => set('secure', true)}>SSL(465)</button>
                <button className={!f.secure ? 'on' : ''} onClick={() => set('secure', false)}>STARTTLS(25/587)</button>
              </div>
            </div></div>
          <div className="field"><label>发件账号</label>
            <input value={f.user} onChange={e => set('user', e.target.value)} placeholder="monitor@company.com" /></div>
          <div className="field"><label>授权码/密码（保存后显示为掩码，留空或保留掩码 = 不改动）</label>
            <input type="password" value={f.pass} onChange={e => set('pass', e.target.value)} placeholder="••••••" /></div>
          <div className="field" style={{ gridColumn: '1 / -1', maxWidth: 460 }}><label>发件人显示地址（留空 = 用发件账号）</label>
            <input value={f.from} onChange={e => set('from', e.target.value)} placeholder="IT运维监控 &lt;monitor@company.com&gt;" /></div>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 6 }}>
          <button className="btn primary" onClick={save} disabled={saving}>{saving ? '保存中…' : '保存邮件配置'}</button>
          <span style={{ color: 'var(--text-3)', fontSize: 12 }}>配置状态：{mail.ready
            ? <b style={{ color: 'var(--sev-healthy)' }}>已就绪（{mail.host}:{mail.port}）</b>
            : <b style={{ color: 'var(--sev-warning)' }}>未配置完整</b>}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 12, borderTop: '1px solid var(--hairline)', paddingTop: 12, flexWrap: 'wrap' }}>
          <div className="field" style={{ margin: 0, minWidth: 280 }}>
            <label>测试收件人（用已保存的配置真实发送一封验证邮件，结果如实展示）</label>
            <input value={to} onChange={e => setTo(e.target.value)} placeholder="you@company.com" />
          </div>
          <button className="btn" onClick={test} disabled={testing || !mail.ready || !to.trim()}
            title={!mail.ready ? '请先保存完整的 SMTP 配置' : ''}>
            {testing ? '发送中…' : '发送测试邮件'}
          </button>
        </div>
        {msg && (
          <div className="mono" style={{ fontSize: 12, marginTop: 10, color: msg.ok ? 'var(--sev-healthy)' : 'var(--sev-critical)' }}>{msg.text}</div>
        )}
      </div>

      <div className="card" style={{ marginTop: 12 }}>
        <div className="card-title">发送失败排查</div>
        <div style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 2 }}>
          <b>Connection timeout</b>：多半是服务器出站防火墙封锁 SMTP 端口（25/465/587）——网页能开不代表 SMTP 通。可在服务器上验证：{'docker compose exec server node -e "require(\'net\').connect(587,\'smtp.partner.outlook.cn\',()=>{console.log(\'OK\');process.exit(0)}).setTimeout(()=>{console.log(\'TIMEOUT\');process.exit(1)},8000)"'}<br />
          <b>Invalid login / 535</b>：授权码不对（多数邮箱需要"授权码"而非登录密码）。<br />
          失败记录可在「告警出口 → 最近发送记录」回溯，服务端日志：<span className="mono">docker compose logs server | grep notify</span>
        </div>
      </div>
    </div>
  );
}

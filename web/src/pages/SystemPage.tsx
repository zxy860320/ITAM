import React from 'react';
import { api, usePoll } from '../api';
import { fmtTime } from '../components/common';

const PERM_LABELS: Record<string, string> = {
  'asset.write': '资产台账编辑', 'ops.exec': '设备操作', 'event.ack': '确认告警',
  'link.review': '链路审核', 'platform.config': '平台配置', 'user.manage': '用户管理',
  'ticket.manage': '工单管理(预留)', 'ticket.handle': '工单处理(预留)',
};

/** 邮件服务卡：SMTP 唯一配置源（告警推送与工单邮件都调用这里的配置），保存后可发测试邮件验证 */
function MailCard() {
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
  );
}

/** 系统管理页：真实角色矩阵（来自用户管理）+ AD 状态 + 操作审计日志 */
export default function SystemPage() {
  const { data } = usePoll(api.system, 30000);

  return (
    <div>
      <div className="stat-row">
        <div className="card"><div className="stat-num">{data?.roles?.length ?? '—'}</div><div className="stat-label">角色（RBAC，可在用户管理页自定义）</div></div>
        <div className="card"><div className="stat-num">{data?.users?.total ?? '—'}</div><div className="stat-label">平台用户（本地 {data?.users?.local ?? 0} · AD {data?.users?.ad ?? 0}）</div></div>
        <div className="card">
          <div className="stat-num" style={{ color: data?.ad?.enabled ? 'var(--sev-healthy)' : 'var(--text-3)' }}>
            {data?.ad?.enabled ? '已启用' : '未启用'}
          </div>
          <div className="stat-label">AD 域登录（{data?.ad?.url || '未配置'}）</div>
        </div>
        <div className="card"><div className="stat-num" style={{ color: 'var(--sev-healthy)' }}>正常</div><div className="stat-label">平台运行状态</div></div>
      </div>

      <div style={{ marginBottom: 14 }}>
        <MailCard />
      </div>

      <div className="grid-2" style={{ marginBottom: 14 }}>
        <div className="card">
          <div className="card-title">角色与能力矩阵（RBAC）</div>
          <table className="data">
            <thead><tr><th>角色</th><th>能力</th></tr></thead>
            <tbody>
              {(data?.roles || []).map((r: any) => (
                <tr key={r.role}>
                  <td>{r.label}<span className="mono" style={{ color: 'var(--text-3)', marginLeft: 8, fontSize: 11 }}>{r.role}</span></td>
                  <td style={{ color: 'var(--text-2)' }}>
                    查看{r.perms.map((k: string) => ' · ' + (PERM_LABELS[k] || k)).join('')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ marginTop: 10, fontSize: 12, color: 'var(--text-3)' }}>
            数据实时来自「用户管理」页（内置 admin/operator/viewer + 自定义角色）；权限变更即时生效（旧会话自动失效）。
          </div>
        </div>

        <div className="card">
          <div className="card-title">登录与账号体系</div>
          <table className="data">
            <tbody>
              <tr><td>登录方式</td><td style={{ color: 'var(--text-2)' }}>本地账号（scrypt 哈希）+ AD 域（LDAP UPN bind）</td></tr>
              <tr><td>会话</td><td style={{ color: 'var(--text-2)' }}>httpOnly cookie · 7 天 · 连续 5 次失败锁定 15 分钟</td></tr>
              <tr><td>AD 首登</td><td style={{ color: 'var(--text-2)' }}>自动入册并赋予默认角色，可改角色/禁用</td></tr>
              <tr><td>门禁</td><td style={{ color: 'var(--text-2)' }}>除监控大屏免登录外，全部页面与 API 需登录</td></tr>
            </tbody>
          </table>
          <div style={{ marginTop: 10, fontSize: 12, color: 'var(--text-3)' }}>
            AD 地址、Base DN、域名后缀、默认角色在「用户管理 → AD 域对接」配置，支持连通性测试；拿到 DC 地址后填入即生效，无需改代码。
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-title">操作审计日志（最近 {data?.auditLog?.length ?? 0} 条：登录/授权变更/资产操作）</div>
        <table className="data">
          <thead><tr><th>时间</th><th>操作者</th><th>动作</th></tr></thead>
          <tbody>
            {(data?.auditLog || []).map((l: any, i: number) => (
              <tr key={i}>
                <td className="mono" style={{ color: 'var(--text-2)' }}>{fmtTime(l.at)}</td>
                <td>{l.user}</td>
                <td style={{ color: 'var(--text-2)' }}>{l.action}{l.detail ? `（${l.detail}）` : ''}</td>
              </tr>
            ))}
            {!(data?.auditLog || []).length && <tr><td colSpan={3} style={{ color: 'var(--text-3)' }}>暂无审计记录</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

import React from 'react';
import { api } from '../api';
import { fmtTime } from '../components/common';

/** 告警出口配置页：钉钉 / 飞书 / 企业微信 / 邮件 四类通道的增删改、路由规则、测试与发送记录 */

const TYPES = [
  { key: 'dingtalk', label: '钉钉', hint: '群设置 → 智能群助手 → 添加自定义机器人，复制 Webhook；启用加签则再填 Secret（SEC 开头）' },
  { key: 'feishu', label: '飞书', hint: '群设置 → 群机器人 → 自定义机器人，复制 Webhook；启用签名校验则填 Secret' },
  { key: 'wecom', label: '企业微信', hint: '群设置 → 群机器人 → 添加，复制 Webhook（含 key 即为凭证）' },
  { key: 'email', label: '邮件', hint: 'SMTP 服务器（如企业邮箱/exmail），发件账号 + 授权码，收件人多个用逗号分隔' },
];
const SEVS = ['info', 'warning', 'severe', 'critical'];
const SEV_LABEL: Record<string, string> = { info: '信息及以上', warning: '警告及以上', severe: '严重及以上', critical: '仅灾难' };
const DOMS = [['server', '服务器'], ['network', '网络'], ['database', '数据库'], ['service', '服务']] as const;

let seq = 0;
const nid = () => `ch_${Date.now().toString(36)}_${++seq}`;

function blank(type = 'dingtalk') {
  return {
    id: nid(), type, label: '', enabled: true, webhook: '', secret: '', keyword: '',
    minSeverity: 'warning', domains: [] as string[], pattern: '', includeRecovery: true,
    smtp: { host: '', port: 465, secure: true, user: '', pass: '', from: '' },
    to: [] as string[],
  } as any;
}

export default function NotifyPage() {
  const [cfg, setCfg] = React.useState<any>(null);
  const [draft, setDraft] = React.useState<any>(null);   // 本地编辑副本（保存前不覆盖服务端）
  const [ui, setUi] = React.useState({ enabled: false, consoleUrl: '' });
  const [saving, setSaving] = React.useState(false);
  const [msg, setMsg] = React.useState<any>(null);
  const [testing, setTesting] = React.useState<Record<string, string>>({});

  const load = React.useCallback(() => {
    api.notify().then(d => {
      setCfg(d);
      setUi({ enabled: d.enabled, consoleUrl: d.consoleUrl || '' });
      setDraft((prev: any) => prev ?? d.channels);
    }).catch(() => {});
  }, []);
  React.useEffect(() => { load(); }, [load]);

  // 服务端数据到达后若无本地草稿则采用（不覆盖正在编辑的内容）
  React.useEffect(() => {
    if (cfg && !draft) setDraft(cfg.channels);
  }, [cfg, draft]);

  const setCh = (id: string, k: string, v: any) =>
    setDraft((ds: any[]) => ds.map(c => c.id === id ? { ...c, [k]: v } : c));
  const setSmtp = (id: string, k: string, v: any) =>
    setDraft((ds: any[]) => ds.map(c => c.id === id ? { ...c, smtp: { ...c.smtp, [k]: v } } : c));

  async function save() {
    setSaving(true); setMsg(null);
    try {
      const r = await api.notifySave({ enabled: ui.enabled, consoleUrl: ui.consoleUrl, channels: draft });
      setMsg({ ok: true, text: `已保存（${r.channels} 个通道，出口${r.enabled ? '开启' : '关闭'}）` });
      setDraft(null); load();
    } catch (e: any) { setMsg({ ok: false, text: String(e.message || e) }); }
    setSaving(false);
  }
  async function test(id: string) {
    setTesting(t => ({ ...t, [id]: '发送中…' }));
    try {
      await api.notifyTest(id);
      setTesting(t => ({ ...t, [id]: '✔ 已送达，请到目标群/邮箱确认' }));
    } catch (e: any) { setTesting(t => ({ ...t, [id]: `✘ ${String(e.message || e).slice(0, 80)}` })); }
    load();
  }

  if (!cfg) return <div style={{ color: 'var(--text-3)' }}>加载中…</div>;
  const channels = draft ?? cfg.channels;

  return (
    <div>
      {/* 总开关 */}
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-title">告警出口总控</div>
        <div style={{ display: 'flex', gap: 18, alignItems: 'center', flexWrap: 'wrap' }}>
          <div className="seg" style={{ width: 'fit-content' }}>
            <button className={!ui.enabled ? 'on' : ''} onClick={() => setUi(u => ({ ...u, enabled: false }))}>关闭</button>
            <button className={ui.enabled ? 'on' : ''} onClick={() => setUi(u => ({ ...u, enabled: true }))}>开启推送</button>
          </div>
          <div className="field" style={{ flex: 1, minWidth: 280, margin: 0 }}>
            <input value={ui.consoleUrl} onChange={e => setUi(u => ({ ...u, consoleUrl: e.target.value }))}
              placeholder="控制台地址（附在告警消息尾部，如 http://10.x.x.x:5273/#/dashboard）" />
          </div>
        </div>
        <div style={{ color: 'var(--text-2)', fontSize: 12, marginTop: 10, lineHeight: 1.8 }}>
          机制：每轮采集后对活动告警<b>差分</b>——新告警按各通道路由规则推送（同轮多条自动聚合为 1 条摘要），告警恢复发恢复通知；
          <b>服务重启首轮只建基线不补发</b>，已通知过的告警不重发。消息内容全部来自 Zabbix 真实事件，不伪造。
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 12, alignItems: 'center' }}>
          <button className="btn primary" onClick={save} disabled={saving}>{saving ? '保存中…' : '保存配置'}</button>
          {msg && <span className="mono" style={{ fontSize: 12, color: msg.ok ? 'var(--sev-healthy)' : 'var(--sev-critical)' }}>{msg.text}</span>}
          <span className="mono" style={{ fontSize: 12, color: 'var(--text-3)', marginLeft: 'auto' }}>
            累计发送 {cfg.stats?.sent ?? 0} · 失败 {cfg.stats?.fail ?? 0}
            {cfg.stats?.lastOk ? ` · 最近成功 ${fmtTime(cfg.stats.lastOk)}` : ''}
          </span>
        </div>
      </div>

      {/* 通道列表 */}
      {channels.map((ch: any) => {
        const t = TYPES.find(x => x.key === ch.type)!;
        const live = cfg.channels.find((x: any) => x.id === ch.id);
        return (
          <div className="card" key={ch.id} style={{ marginBottom: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
              <span className="badge info"><i className="bdot" />{t.label}</span>
              <input style={{ width: 200 }} value={ch.label} placeholder={`通道名称（如 ${t.label}-值班群）`}
                onChange={e => setCh(ch.id, 'label', e.target.value)} />
              <div className="seg" style={{ width: 'fit-content' }}>
                <button className={!ch.enabled ? 'on' : ''} onClick={() => setCh(ch.id, 'enabled', false)}>停用</button>
                <button className={ch.enabled ? 'on' : ''} onClick={() => setCh(ch.id, 'enabled', true)}>启用</button>
              </div>
              <span className="spacer" style={{ flex: 1 }} />
              {live?.stats && (
                <span className="mono" style={{ fontSize: 12, color: live.stats.fail && !live.stats.sent ? 'var(--sev-critical)' : 'var(--text-3)' }}>
                  已发 {live.stats.sent} · 失败 {live.stats.fail}{live.stats.lastError ? ` · 最近错误：${live.stats.lastError.slice(0, 40)}` : ''}
                </span>
              )}
              <button className="btn" disabled={!live} title={live ? '用服务端已保存的配置发送' : '新通道/改动需先点「保存配置」后再测试'}
                onClick={() => test(ch.id)}>{testing[ch.id] || (live ? '发送测试消息' : '未保存·先保存再测')}</button>
              <button className="btn" style={{ color: 'var(--sev-critical)' }}
                onClick={() => setDraft((ds: any[]) => ds.filter(x => x.id !== ch.id))}>删除</button>
            </div>
            {testing[ch.id] && (
              <div className="mono" style={{ fontSize: 12, marginBottom: 8, color: testing[ch.id].startsWith('✔') ? 'var(--sev-healthy)' : 'var(--sev-critical)' }}>{testing[ch.id]}</div>
            )}
            <div style={{ color: 'var(--text-3)', fontSize: 12, marginBottom: 8 }}>{t.hint}</div>

            {ch.type === 'email' ? (
              <div className="grid-2" style={{ gap: 10 }}>
                <div className="field"><label>SMTP 主机</label>
                  <input value={ch.smtp.host} onChange={e => setSmtp(ch.id, 'host', e.target.value)} placeholder="smtp.exmail.qq.com" /></div>
                <div className="field"><label>端口 / 加密</label>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input style={{ width: 90 }} type="number" value={ch.smtp.port} onChange={e => setSmtp(ch.id, 'port', Number(e.target.value))} />
                    <div className="seg" style={{ width: 'fit-content' }}>
                      <button className={ch.smtp.secure ? 'on' : ''} onClick={() => setSmtp(ch.id, 'secure', true)}>SSL(465)</button>
                      <button className={!ch.smtp.secure ? 'on' : ''} onClick={() => setSmtp(ch.id, 'secure', false)}>STARTTLS(25/587)</button>
                    </div>
                  </div></div>
                <div className="field"><label>发件账号</label>
                  <input value={ch.smtp.user} onChange={e => setSmtp(ch.id, 'user', e.target.value)} placeholder="monitor@company.com" /></div>
                <div className="field"><label>授权码/密码（保存后显示为掩码）</label>
                  <input type="password" value={ch.smtp.pass} onChange={e => setSmtp(ch.id, 'pass', e.target.value)} placeholder="••••••" /></div>
                <div className="field"><label>收件人（逗号分隔）</label>
                  <input value={ch.to.join(', ')} onChange={e => setCh(ch.id, 'to', String(e.target.value).split(/[,，]/).map(s => s.trim()).filter(Boolean))}
                    placeholder="ops@company.com, netteam@company.com" /></div>
              </div>
            ) : (
              <div className="grid-2" style={{ gap: 10 }}>
                <div className="field"><label>Webhook 地址（保存后 key 显示为掩码）</label>
                  <input value={ch.webhook} onChange={e => setCh(ch.id, 'webhook', e.target.value)}
                    placeholder="https://oapi.dingtalk.com/robot/send?access_token=…" /></div>
                <div className="field">
                  <label>{ch.type === 'wecom' ? '（企业微信无需 Secret）' : ch.type === 'feishu' ? '签名校验 Secret（可选）' : '加签 Secret（可选，SEC 开头）'}</label>
                  {ch.type !== 'wecom' && <input type="password" value={ch.secret} onChange={e => setCh(ch.id, 'secret', e.target.value)} placeholder="••••••" />}
                </div>
              </div>
            )}
            {ch.type === 'dingtalk' && (
              <div className="field" style={{ maxWidth: 420 }}><label>自定义关键词（机器人安全设置选"自定义关键词"时必填，将拼入消息头）</label>
                <input value={ch.keyword} onChange={e => setCh(ch.id, 'keyword', e.target.value)} placeholder="告警" /></div>
            )}

            {/* 路由规则 */}
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center', marginTop: 4 }}>
              <div className="field" style={{ margin: 0 }}>
                <label>最低级别</label>
                <div className="seg" style={{ width: 'fit-content' }}>
                  {SEVS.map(s => <button key={s} className={ch.minSeverity === s ? 'on' : ''} onClick={() => setCh(ch.id, 'minSeverity', s)}>{SEV_LABEL[s]}</button>)}
                </div>
              </div>
              <div className="field" style={{ margin: 0 }}>
                <label>域过滤（不选 = 全部）</label>
                <div className="seg" style={{ width: 'fit-content' }}>
                  {DOMS.map(([k, lb]) => (
                    <button key={k} className={ch.domains.includes(k) ? 'on' : ''}
                      onClick={() => setCh(ch.id, 'domains', ch.domains.includes(k) ? ch.domains.filter((x: string) => x !== k) : [...ch.domains, k])}>{lb}</button>
                  ))}
                </div>
              </div>
              <div className="field" style={{ margin: 0 }}>
                <label>恢复通知</label>
                <div className="seg" style={{ width: 'fit-content' }}>
                  <button className={ch.includeRecovery ? 'on' : ''} onClick={() => setCh(ch.id, 'includeRecovery', true)}>开</button>
                  <button className={!ch.includeRecovery ? 'on' : ''} onClick={() => setCh(ch.id, 'includeRecovery', false)}>关</button>
                </div>
              </div>
              <div className="field" style={{ margin: 0, flex: 1, minWidth: 240 }}>
                <label>关键词/正则过滤（可选，仅推送消息匹配的事件）</label>
                <input value={ch.pattern} onChange={e => setCh(ch.id, 'pattern', e.target.value)} placeholder="如 Link down|CPU" />
              </div>
            </div>
          </div>
        );
      })}

      <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
        {TYPES.map(t => (
          <button key={t.key} className="btn" onClick={() => setDraft((ds: any[]) => [...ds, blank(t.key)])}>+ 添加{t.label}通道</button>
        ))}
      </div>

      {/* 发送记录 */}
      <div className="card">
        <div className="card-title">最近发送记录</div>
        {!cfg.log?.length ? <div style={{ color: 'var(--text-3)' }}>暂无记录</div> : (
          <table className="tbl">
            <thead><tr><th>时间</th><th>通道</th><th>类型</th><th>事件数</th><th>结果</th></tr></thead>
            <tbody>
              {cfg.log.slice(0, 20).map((r: any, i: number) => (
                <tr key={i}>
                  <td className="mono">{fmtTime(r.at)}</td>
                  <td>{r.channel}（{r.type}）</td>
                  <td>{r.kind === 'trigger' ? '告警' : r.kind === 'recovery' ? '恢复' : '测试'}</td>
                  <td className="mono">{r.events}</td>
                  <td style={{ color: r.ok ? 'var(--sev-healthy)' : 'var(--sev-critical)' }}>{r.ok ? '✔ 成功' : `✘ ${r.error || '失败'}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ============================================================
// 工单路由（个人工作台）
// 登录态：GET /api/tickets 列表/详情；POST create（建单即发邮件）/resend/cancel
// 免登录（确认人未必有平台账号）：
//   GET  /api/ticket-confirm/info?token= → 工单摘要（标题/内容/创建人/状态）
//   POST /api/ticket-confirm             → 凭 token 确认，工单结束
// 确认链接域名：优先 notify.json 的 consoleUrl（对接页可配），否则取请求 Host。
// 邮件失败绝不静默：结果落账 mailLog，前端醒目提示 + 一键重发。
// ============================================================
import { TK_STATUS } from './ticketStore.js';

function baseUrlOf(req, consoleUrl) {
  try { if (consoleUrl) return new URL(consoleUrl).origin; } catch { /* 配置异常回落 Host */ }
  const proto = req.headers['x-forwarded-proto'] || 'http';
  return `${proto}://${req.headers.host}`;
}

function ticketMail({ base, t, consoleLabel }) {
  const link = `${base}/#/ticket-confirm?token=${t.confirmToken}`;
  const line = '─'.repeat(46);
  const text = [
    `工单确认请求：${t.no}`,
    line,
    `标题：${t.title}`,
    `优先级：${({ low: '低', normal: '普通', high: '高' })[t.priority]}`,
    `创建人：${t.createBy || '—'}`,
    `创建时间：${new Date(t.createdAt).toLocaleString('zh-CN')}`,
    t.confirmer.phone ? `联系电话：${t.confirmer.phone}` : null,
    line,
    '工单内容：',
    t.content,
    line,
    `请点击下方链接确认，确认后本工单即结束：`,
    link,
    `（此链接仅限您本人使用；如无法打开，请复制完整地址到浏览器）`,
    line,
    `—— ${consoleLabel} 工单系统自动发送，请勿直接回复`,
  ].filter(x => x !== null).join('\n');
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const html = `
<div style="font-family:'Segoe UI',system-ui,sans-serif;max-width:640px;margin:0 auto;color:#1a202c">
  <h2 style="border-bottom:2px solid #22d3ee;padding-bottom:8px">工单确认请求 <span style="color:#0891b2;font-size:13px">${esc(t.no)}</span></h2>
  <table style="width:100%;border-collapse:collapse;font-size:13px;margin:14px 0">
    <tr><td style="color:#64748b;padding:4px 0;width:90px">标题</td><td><b>${esc(t.title)}</b></td></tr>
    <tr><td style="color:#64748b;padding:4px 0">创建人</td><td>${esc(t.createBy || '—')}</td></tr>
    <tr><td style="color:#64748b;padding:4px 0">创建时间</td><td>${new Date(t.createdAt).toLocaleString('zh-CN')}</td></tr>
    ${t.confirmer.phone ? `<tr><td style="color:#64748b;padding:4px 0">联系电话</td><td>${esc(t.confirmer.phone)}</td></tr>` : ''}
  </table>
  <div style="background:#f1f5f9;border-left:3px solid #22d3ee;padding:12px 14px;font-size:13px;white-space:pre-wrap">${esc(t.content)}</div>
  <p style="margin:22px 0"><a href="${link}" style="display:inline-block;background:#0891b2;color:#fff;text-decoration:none;padding:10px 26px;border-radius:6px;font-size:14px">确认工单</a></p>
  <p style="font-size:12px;color:#64748b">点击后本工单即结束。若按钮无法打开，请复制此地址到浏览器：<br><span style="word-break:break-all">${esc(link)}</span></p>
  <p style="font-size:11px;color:#94a3b8;border-top:1px solid #e2e8f0;padding-top:8px">—— ${esc(consoleLabel)} 工单系统自动发送，请勿直接回复</p>
</div>`;
  return { subject: `[工单确认] ${t.no} ${t.title}`, text, html };
}

export function mountTickets(app, { store, notifier, userStore, consoleUrlOf }) {
  const audit = (by, action, detail = '') => {
    console.log(`[ticket-audit] ${new Date().toISOString()} ${by || '-'} ${action}${detail ? ': ' + detail : ''}`);
  };

  const sendMail = async (t, base) => {
    const m = ticketMail({ base, t, consoleLabel: 'IT运维监控平台' });
    try {
      const r = await notifier.sendBusinessMail(t.confirmer.email, m.subject, m.text, m.html);
      store.recordMail(t.id, true);
      audit(t.createBy, 'mail-ok', `${t.no} → ${t.confirmer.email} via ${r.channel}`);
      return { ok: true };
    } catch (e) {
      store.recordMail(t.id, false, String(e.message || e).slice(0, 300));
      audit(t.createBy, 'mail-fail', `${t.no} → ${t.confirmer.email}: ${e.message || e}`);
      return { ok: false, error: String(e.message || e).slice(0, 300) };
    }
  };

  // ---------- 登录态（全站门禁已保证；工作台对个人开放） ----------
  app.get('/api/tickets', (req, res) => {
    const r = store.list(req.query);
    res.json({ ...r, statusLabels: TK_STATUS });
  });

  app.post('/api/tickets/create', async (req, res) => {
    const by = req.auth?.user?.displayName || req.auth?.user?.username || '';
    const r = store.create({ ...req.body, createBy: by });
    if (!r.ok) return res.status(400).json(r);
    audit(by, 'create', `${r.ticket.no} → ${r.ticket.confirmer.email}`);
    const mail = await sendMail(r.ticket, baseUrlOf(req, consoleUrlOf?.()));
    res.json({ ok: true, ticket: store.get(r.ticket.id), mail });
  });

  app.post('/api/tickets/resend', async (req, res) => {
    const r0 = store.rotateToken(String(req.body?.id || ''));
    if (!r0.ok) return res.status(400).json(r0);
    audit(req.auth?.user?.username, 'resend', r0.ticket.no);
    const mail = await sendMail(r0.ticket, baseUrlOf(req, consoleUrlOf?.()));
    res.json({ ok: true, ticket: store.get(r0.ticket.id), mail });
  });

  app.post('/api/tickets/cancel', (req, res) => {
    const by = req.auth?.user?.username || '';
    const r = store.cancel(String(req.body?.id || ''), by);
    if (!r.ok) return res.status(400).json(r);
    audit(by, 'cancel', r.ticket.no);
    res.json(r);
  });

  // ---------- 免登录确认端点（authRoutes 白名单已放行 /api/ticket-confirm*） ----------
  app.get('/api/ticket-confirm/info', (req, res) => {
    const t = store.getByToken(String(req.query.token || ''));
    if (!t) return res.status(404).json({ error: '确认链接无效或已使用' });
    res.json({
      no: t.no, title: t.title, content: t.content, priority: t.priority,
      createBy: t.createBy, createdAt: t.createdAt, status: t.status,
      statusLabel: TK_STATUS[t.status], phone: t.confirmer.phone || '',
      confirmer: t.confirmer.name,
    });
  });

  app.post('/api/ticket-confirm', (req, res) => {
    const r = store.confirm(String(req.body?.token || ''));
    if (!r.ok) return res.status(400).json(r);
    audit(r.ticket.confirmer.email, 'confirm', r.ticket.no);
    res.json({ ok: true, no: r.ticket.no, confirmedAt: r.ticket.confirmedAt });
  });
}

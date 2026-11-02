import fs from 'fs';
import path from 'path';
import { ALL_PERMS } from './userStore.js';
import { adAuthenticate, adTestConnection } from './ldapAd.js';

// ============================================================================
// 认证与会话：cookie 解析 → 登录/登出/me/改密 → 全站 authGuard → requirePerm
// 门禁原则（用户裁定）：除大屏 GET /api/summary、/api/dashboard 外，所有 /api 必须登录。
// /mcp 豁免：AI 客户端（Open WebUI）在 docker 内网直连，无浏览器 cookie；
// 其写能力（backup_device_now）在 ops 层已有模板白名单+审计，暂维持内网信任边界。
// ============================================================================

export const COOKIE = 'uocp_sess';
const cookieOpts = maxAge => ({
  httpOnly: true, sameSite: 'lax', path: '/', maxAge,
  secure: process.env.ITYW_COOKIE_SECURE === '1', // 反代 https 时置 1
});
function parseCookies(req) {
  const out = {};
  for (const kv of String(req.headers.cookie || '').split(';')) {
    const i = kv.indexOf('=');
    if (i > 0) out[kv.slice(0, i).trim()] = decodeURIComponent(kv.slice(i + 1).trim());
  }
  return out;
}

export function mountAuth(app, store) {
  // 认证审计落盘（系统页审计日志消费）：登录/登出/用户角色变更等均记录
  const auditFile = path.join(store.dataDir, 'auth_audit.jsonl');
  const auditAuth = (user, action, detail = '') => {
    console.log(`[auth-audit] ${new Date().toISOString()} ${user || '-'} ${action}${detail ? ': ' + detail : ''}`);
    try {
      const by = (user && store.findUser(user)) || null;
      fs.appendFileSync(auditFile, JSON.stringify({ at: Date.now(), by: user, role: by?.role || '', action, detail }) + '\n');
    } catch { /* 审计失败不阻断业务 */ }
  };
  // ---- 请求级身份注入（不拒未登录，鉴权由 authGuard/requirePerm 决定） ----
  app.use((req, res, next) => {
    const token = parseCookies(req)[COOKIE];
    const v = store.validateSession(token);
    req.auth = v ? { user: store.publicUser(v.user), role: store.roleOf(v.user), token } : null;
    next();
  });

  // ---- 登录 ----
  app.post('/api/auth/login', async (req, res) => {
    const { username = '', password = '' } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: '请输入用户名与密码' });
    const ad = store.adConfig;
    const u0 = store.findUser(username);
    let user = null;
    // 判定顺序：AD 用户（已入册 source=ad，或 AD 已启用且账号不存在/无密码）走 AD bind；
    // 其余走本地 scrypt。AD 启用时本地同名账号仍可登录（source=local 优先本地）。
    const useAd = ad.enabled && (!u0 || u0.source === 'ad');
    if (useAd) {
      const r = await adAuthenticate(ad, String(username).replace(/@.*$/, '') || username, password).catch(e => ({ ok: false, error: `AD 异常: ${e.message || e}` }));
      if (!r.ok) { auditAuth(username, 'login-ad-fail', r.error); return res.status(401).json({ error: r.error }); }
      user = store.upsertAdUser(String(username).replace(/@.*$/, '') || username, r.profile || {});
      if (!user) return res.status(403).json({ error: '账号已在平台侧禁用' });
      auditAuth(user.username, 'login-ad-ok');
    } else {
      if (ad.enabled && !ad.allowCreateLocal && u0 == null) return res.status(403).json({ error: '平台仅允许 AD 账号登录' });
      const r = store.authenticateLocal(username, password);
      if (!r.ok) { auditAuth(username, 'login-local-fail', r.error); return res.status(401).json({ error: r.error }); }
      user = r.user;
      auditAuth(user.username, 'login-local-ok');
    }
    const token = store.createSession(user);
    res.setHeader('Set-Cookie', `${COOKIE}=${token}; ${Object.entries(cookieOpts(7 * 24 * 3600))
      .map(([k, v]) => (v === true ? k : v === false ? undefined : `${k}=${v}`)).filter(Boolean).join('; ')}`);
    const role = store.roleOf(user);
    res.json({ user: store.publicUser(user), role, perms: role?.perms || [] });
  });

  app.post('/api/auth/logout', (req, res) => {
    if (req.auth) { store.destroySession(req.auth.token); auditAuth(req.auth.user.username, 'logout'); }
    res.setHeader('Set-Cookie', `${COOKIE}=; ${Object.entries(cookieOpts(0)).map(([k, v]) => (v === true ? k : v === false ? undefined : `${k}=${v}`)).filter(Boolean).join('; ')}`);
    res.json({ ok: true });
  });

  app.get('/api/auth/me', (req, res) => {
    if (!req.auth) return res.status(401).json({ error: 'not_logged_in' });
    res.json({ user: req.auth.user, role: req.auth.role, perms: req.auth.role?.perms || [] });
  });

  app.post('/api/auth/change-password', (req, res) => {
    if (!req.auth) return res.status(401).json({ error: 'not_logged_in' });
    const u = store.userById(req.auth.user.id);
    const r = store.changePassword(u, req.body?.newPassword);
    if (!r.ok) return res.status(400).json(r);
    auditAuth(u.username, 'change-password');
    res.json({ ok: true });
  });

  // ---- 用户管理（要求 user.manage，admin 才有） ----
  const manage = requirePerm(store, 'user.manage');
  app.get('/api/users', manage, (req, res) => {
    res.json({
      users: store.users.map(u => {
        const { passwordHash, ...rest } = u;
        return rest;
      }),
      roles: store.roles,
      perms: ALL_PERMS,
    });
  });
  app.post('/api/users/create', manage, (req, res) => {
    const r = store.createUser(req.body || {});
    if (!r.ok) return res.status(400).json(r);
    auditAuth(req.auth.user.username, 'user-create', r.user.username);
    res.json(r);
  });
  app.post('/api/users/update', manage, (req, res) => {
    const r = store.updateUser(String(req.body?.id || ''), req.body || {});
    if (!r.ok) return res.status(400).json(r);
    auditAuth(req.auth.user.username, 'user-update', `${r.user.username} role=${r.user.role} enabled=${r.user.enabled}`);
    res.json(r);
  });
  app.post('/api/users/delete', manage, (req, res) => {
    const r = store.deleteUser(String(req.body?.id || ''));
    if (!r.ok) return res.status(400).json(r);
    auditAuth(req.auth.user.username, 'user-delete', String(req.body?.id));
    res.json(r);
  });
  app.post('/api/users/reset-password', manage, (req, res) => {
    const u = store.userById(String(req.body?.id || ''));
    if (!u) return res.status(400).json({ error: '用户不存在' });
    const r = store.resetPassword(u, req.body?.newPassword);
    if (!r.ok) return res.status(400).json(r);
    auditAuth(req.auth.user.username, 'user-reset-pass', u.username);
    res.json(r);
  });

  // ---- 角色管理 ----
  app.post('/api/roles/create', manage, (req, res) => {
    const r = store.createRole(req.body || {});
    if (!r.ok) return res.status(400).json(r);
    auditAuth(req.auth.user.username, 'role-create', r.role.id);
    res.json(r);
  });
  app.post('/api/roles/update', manage, (req, res) => {
    const r = store.updateRole(String(req.body?.id || ''), req.body || {});
    if (!r.ok) return res.status(400).json(r);
    auditAuth(req.auth.user.username, 'role-update', r.role.id);
    res.json(r);
  });
  app.post('/api/roles/delete', manage, (req, res) => {
    const r = store.deleteRole(String(req.body?.id || ''));
    if (!r.ok) return res.status(400).json(r);
    auditAuth(req.auth.user.username, 'role-delete', String(req.body?.id));
    res.json(r);
  });

  // ---- AD 配置（user.manage） ----
  app.get('/api/auth/ad-config', manage, (req, res) => res.json(store.adPublic()));
  app.post('/api/auth/ad-config/save', manage, (req, res) => {
    const r = store.saveAdConfig(req.body || {});
    if (!r.ok) return res.status(400).json(r);
    auditAuth(req.auth.user.username, 'ad-config-save', `enabled=${r.config.enabled} url=${r.config.url}`);
    res.json(r);
  });
  app.post('/api/auth/ad-config/test', manage, async (req, res) => {
    // 支持「测试未保存的表单」：body 里带 url 等字段则用表单值，否则用已存配置
    const cfg = { ...store.adConfig, ...(req.body && req.body.url ? req.body : {}) };
    const r = await adTestConnection(cfg);
    auditAuth(req.auth.user.username, 'ad-test', r.ok ? `ok ${r.latencyMs}ms` : r.error);
    res.status(r.ok ? 200 : 502).json(r);
  });

  // ---- 全站门禁：authGuard 后挂到所有后续注册的路由上（大屏豁免） ----
  const ANON_GET = new Set(['/api/summary', '/api/dashboard']);
  app.use((req, res, next) => {
    if (!req.path.startsWith('/api')) return next();               // 非 API（探活等）放行
    if (req.path.startsWith('/api/auth/')) return next();          // 登录/登出/me 自身已处理
    // 工单确认端点免登录：确认人是外部邮件收件人，未必有平台账号；
    // 能力由 48 字节一次性 token 承载（确认/取消后即作废），端点内自校验。
    if (req.path.startsWith('/api/ticket-confirm')) return next();
    if (req.method === 'GET' && ANON_GET.has(req.path)) return next(); // 大屏免登录（只读聚合）
    if (!req.auth) return res.status(401).json({ error: 'not_logged_in' });
    next();
  });
}

/** 权限点守卫：挂在具体写路由上。perm 如 'asset.write' / 'ops.exec' / 'event.ack' / 'platform.config' */
export function requirePerm(store, perm) {
  return (req, res, next) => {
    if (!req.auth) return res.status(401).json({ error: 'not_logged_in' });
    if (!store.hasPerm(store.userById(req.auth.user.id), perm)) {
      return res.status(403).json({ error: `permission_denied:${perm}` });
    }
    next();
  };
}

// topology-svc 认证守卫：校验 P0 服务下发的会话（共享 sessions.json，只读）。
// 设计：
//  - 会话文件路径 env UOCP_SESSIONS_FILE（默认 ../server/data/sessions.json；docker 里挂同一卷）；
//  - 角色文件 env UOCP_ROLES_FILE（默认 ../server/data/roles.json），用于 perms 细控；
//  - 两个文件都按 mtime 缓存，改动即时生效、不轮询；
//  - /health 开放（docker healthcheck 用）；/api/* 一律先登录，写端点再按 perm：
//      link.review  → 链路确认/拒绝/手工建链
//      platform.config → 同步、发现、路由快照刷新等重操作
//  - 审核类接口的 operator 字段一律覆盖为会话用户，杜绝冒名审核。
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SESS_FILE = process.env.UOCP_SESSIONS_FILE || path.resolve(HERE, '..', '..', 'server', 'data', 'sessions.json');
const ROLES_FILE = process.env.UOCP_ROLES_FILE || path.resolve(HERE, '..', '..', 'server', 'data', 'roles.json');
const COOKIE = 'uocp_sess';

function cachedLoad(file) {
  let cache = { mtime: 0, data: null };
  return () => {
    try {
      const st = fs.statSync(file);
      if (st.mtimeMs !== cache.mtime || !cache.data) {
        cache = { mtime: st.mtimeMs, data: JSON.parse(fs.readFileSync(file, 'utf-8')) };
      }
      return cache.data;
    } catch { return null; }
  };
}
const loadSessions = cachedLoad(SESS_FILE);
const loadRoles = cachedLoad(ROLES_FILE);

function parseCookie(req) {
  for (const kv of String(req.headers.cookie || '').split(';')) {
    const i = kv.indexOf('=');
    if (i > 0 && kv.slice(0, i).trim() === COOKIE) return decodeURIComponent(kv.slice(i + 1).trim());
  }
  return '';
}

export function installAuth(app) {
  // 身份注入
  app.use((req, res, next) => {
    const token = parseCookie(req);
    const sessions = loadSessions();
    const s = token && sessions?.sessions?.[token];
    if (s && s.expiresAt > Date.now()) {
      const roles = loadRoles();
      const role = (roles?.roles || []).find(r => r.id === s.role) || null;
      req.auth = { username: s.username, role: s.role, perms: role?.perms || [] };
    }
    next();
  });
  // /api/* 全站登录门禁（/health 开放）
  app.use('/api', (req, res, next) => {
    if (!req.auth) return res.status(401).json({ error: 'not_logged_in' });
    next();
  });
}

/** 权限守卫（挂在具体写路由上）；perm 如 'link.review' / 'platform.config' */
export function needPerm(perm) {
  return (req, res, next) => {
    if (!req.auth) return res.status(401).json({ error: 'not_logged_in' });
    if (!req.auth.perms.includes(perm)) return res.status(403).json({ error: `permission_denied:${perm}` });
    next();
  };
}

/** 链路审核守卫：perm + operator 冒名覆盖（审计追责到真实会话用户） */
export function needLinkReview(req, res, next) {
  if (!req.auth) return res.status(401).json({ error: 'not_logged_in' });
  if (!req.auth.perms.includes('link.review')) return res.status(403).json({ error: 'permission_denied:link.review' });
  if (req.body && typeof req.body === 'object') req.body.operator = req.auth.username;
  next();
}

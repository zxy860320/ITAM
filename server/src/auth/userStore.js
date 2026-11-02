import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

// ============================================================================
// 用户 / 角色 / 会话存储（data/users.json、roles.json、sessions.json、ad_config.json）
// 红线：
//  - 密码只存 scrypt 哈希（salt:hash），任何接口永不返回哈希字段；
//  - 会话 = 随机 32B token（hex），httpOnly cookie 下发，持久化 sessions.json，7 天过期；
//  - AD 配置（LDAP URL/baseDN/UPN 后缀/默认角色）可运行时修改，密码字段不外泄（保存后不回显）。
// 角色模型：内置 admin/operator/viewer（builtin，不可删）+ 自定义角色（为将来工单系统预留 perms 扩展点）。
// ============================================================================

// 权限点全集（前端/后端 requirePerm 均以此为准；ticket.* 为工单系统预置）
export const ALL_PERMS = [
  { key: 'asset.write',      label: '资产台账编辑' },
  { key: 'ops.exec',         label: '设备操作（跳板机）' },
  { key: 'event.ack',        label: '确认告警' },
  { key: 'link.review',      label: '拓扑链路审核' },
  { key: 'platform.config',  label: '平台配置（数据源/告警出口）' },
  { key: 'user.manage',      label: '用户与角色管理' },
  { key: 'ticket.manage',    label: '工单管理（预留）' },
  { key: 'ticket.handle',    label: '工单处理（预留）' },
];
export const PERM_KEYS = new Set(ALL_PERMS.map(p => p.key));

const BUILTIN_ROLES = [
  { id: 'admin',    label: '管理员',   builtin: true, perms: ALL_PERMS.map(p => p.key) },
  { id: 'operator', label: '运维员',   builtin: true, perms: ['asset.write', 'ops.exec', 'event.ack', 'link.review'] },
  { id: 'viewer',   label: '只读用户', builtin: true, perms: [] },
];

const SESSION_TTL_MS = 7 * 24 * 3600e3;   // 会话 7 天
const MAX_FAILED = 5;                     // 连续失败 5 次锁定
const LOCK_MS = 15 * 60e3;                // 锁定 15 分钟

// ---------- 密码哈希（scrypt） ----------
export function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(plain), salt, 32);
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
}
export function verifyPassword(plain, stored) {
  try {
    const [algo, saltH, hashH] = String(stored).split(':');
    if (algo !== 'scrypt' || !saltH || !hashH) return false;
    const hash = crypto.scryptSync(String(plain), Buffer.from(saltH, 'hex'), 32);
    return crypto.timingSafeEqual(hash, Buffer.from(hashH, 'hex'));
  } catch { return false; }
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return fallback; }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 原子写：先写临时文件再 rename，避免写一半进程被杀导致损坏
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
  fs.renameSync(tmp, file);
}

export class UserStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.fUsers = path.join(dataDir, 'users.json');
    this.fRoles = path.join(dataDir, 'roles.json');
    this.fSessions = path.join(dataDir, 'sessions.json');
    this.fAd = path.join(dataDir, 'ad_config.json');
    this.users = readJson(this.fUsers, { users: [] }).users || [];
    this.roles = readJson(this.fRoles, { roles: [] }).roles || [];
    this.sessions = readJson(this.fSessions, { sessions: {} }).sessions || {};
    // 内置角色永远存在且权限跟随代码定义（升级新增权限点自动补齐 admin）
    for (const br of BUILTIN_ROLES) {
      const cur = this.roles.find(r => r.id === br.id);
      if (!cur) this.roles.push({ ...br, perms: [...br.perms] });
      else Object.assign(cur, { label: br.label, builtin: true, perms: br.id === 'admin' ? ALL_PERMS.map(p => p.key) : cur.perms.filter(k => PERM_KEYS.has(k)) });
    }
    this.#persistRoles();
    this.adConfig = readJson(this.fAd, {
      enabled: false,
      url: '',            // 例 ldap://dc01.corp.local:389 或 ldaps://dc01.corp.local:636
      baseDN: '',         // 例 DC=corp,DC=local（用于 search 用户属性，可留空走纯 UPN bind）
      upnSuffix: '',      // 例 corp.local —— 登录名 username@后缀
      defaultRole: 'viewer', // AD 用户首次登录自动入册时赋予的角色
      allowCreateLocal: true,
      tlsVerify: true,       // ldaps 自签证书场景可关（仅影响证书校验，不影响认证本身）
    });
    // 种子管理员：users.json 为空时生成 admin + 随机密码打印控制台（首登后应立即改密）
    if (!this.users.length) {
      const pw = process.env.ITYW_ADMIN_PASS || crypto.randomBytes(9).toString('base64url');
      const u = this.#mkUser({ username: 'admin', displayName: '系统管理员', source: 'local', role: 'admin' });
      u.passwordHash = hashPassword(pw);
      this.users.push(u);
      this.#persistUsers();
      console.log(`[auth] 已创建默认管理员 admin，初始密码: ${pw}${process.env.ITYW_ADMIN_PASS ? '（来自 ITYW_ADMIN_PASS）' : '（随机生成，请首次登录后立即修改）'}`);
    }
    this.#gcSessions();
  }

  #mkUser({ username, displayName = '', email = '', source = 'local', role = 'viewer' }) {
    return {
      id: 'u_' + crypto.randomBytes(6).toString('hex'),
      username: String(username).toLowerCase(),
      displayName, email, source, role,
      enabled: true,
      passwordHash: null,
      failedAttempts: 0, lockedUntil: 0,
      createdAt: Date.now(), updatedAt: Date.now(), lastLogin: 0,
    };
  }
  #persistUsers() { writeJson(this.fUsers, { users: this.users }); }
  #persistRoles() { writeJson(this.fRoles, { roles: this.roles }); }
  #persistSessions() { writeJson(this.fSessions, { sessions: this.sessions }); }
  #persistAd() { writeJson(this.fAd, this.adConfig); }

  findUser(username) {
    const u = String(username || '').trim().toLowerCase();
    return this.users.find(x => x.username === u) || null;
  }
  userById(id) { return this.users.find(x => x.id === id) || null; }

  /** 对外脱敏视图（永不带 passwordHash） */
  publicUser(u) {
    if (!u) return null;
    const { passwordHash, ...rest } = u;
    return rest;
  }

  roleOf(u) { return this.roles.find(r => r.id === u?.role) || null; }
  roleIds() { return this.roles.map(r => r.id); }

  // ---------- 本地密码认证（AD 用户不走这里） ----------
  authenticateLocal(username, password) {
    const u = this.findUser(username);
    if (!u || u.source !== 'local' || !u.passwordHash) return { ok: false, error: '用户名或密码错误' };
    if (!u.enabled) return { ok: false, error: '账号已禁用' };
    if (u.lockedUntil > Date.now()) {
      const mins = Math.ceil((u.lockedUntil - Date.now()) / 60e3);
      return { ok: false, error: `账号已锁定，请 ${mins} 分钟后再试` };
    }
    if (!verifyPassword(password, u.passwordHash)) {
      u.failedAttempts = (u.failedAttempts || 0) + 1;
      if (u.failedAttempts >= MAX_FAILED) { u.lockedUntil = Date.now() + LOCK_MS; u.failedAttempts = 0; }
      u.updatedAt = Date.now();
      this.#persistUsers();
      return { ok: false, error: '用户名或密码错误' };
    }
    u.failedAttempts = 0; u.lockedUntil = 0; u.lastLogin = Date.now();
    this.#persistUsers();
    return { ok: true, user: u };
  }

  /** AD 认证成功/首登入册（source=ad，无密码哈希） */
  upsertAdUser(username, { displayName = '', email = '' } = {}) {
    let u = this.findUser(username);
    if (!u) {
      u = this.#mkUser({
        username, displayName, email, source: 'ad',
        role: PERM_KEYS.size && this.roleIds().includes(this.adConfig.defaultRole) ? this.adConfig.defaultRole : 'viewer',
      });
      this.users.push(u);
    } else {
      if (displayName) u.displayName = displayName;
      if (email) u.email = email;
    }
    if (!u.enabled) return null; // AD 验证通过但平台侧已禁用 → 拒绝
    u.lastLogin = Date.now(); u.failedAttempts = 0; u.lockedUntil = 0;
    u.updatedAt = Date.now();
    this.#persistUsers();
    return u;
  }

  // ---------- 会话 ----------
  createSession(u) {
    this.#gcSessions();
    const token = crypto.randomBytes(32).toString('hex');
    this.sessions[token] = { userId: u.id, username: u.username, role: u.role, createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL_MS };
    this.#persistSessions();
    return token;
  }
  validateSession(token) {
    if (!token) return null;
    const s = this.sessions[token];
    if (!s) return null;
    if (s.expiresAt < Date.now()) { delete this.sessions[token]; this.#persistSessions(); return null; }
    const u = this.userById(s.userId);
    if (!u || !u.enabled) { delete this.sessions[token]; this.#persistSessions(); return null; }
    return { token, session: s, user: u };
  }
  destroySession(token) {
    if (token && this.sessions[token]) { delete this.sessions[token]; this.#persistSessions(); }
  }
  destroyUserSessions(userId) {
    let n = 0;
    for (const [t, s] of Object.entries(this.sessions)) if (s.userId === userId) { delete this.sessions[t]; n++; }
    if (n) this.#persistSessions();
    return n;
  }
  #gcSessions() {
    const now = Date.now();
    let n = 0;
    for (const [t, s] of Object.entries(this.sessions)) if (s.expiresAt < now) { delete this.sessions[t]; n++; }
    if (n) this.#persistSessions();
  }

  // ---------- 改密（仅 local 用户） ----------
  changePassword(u, newPass) {
    if (u.source !== 'local') return { ok: false, error: 'AD 账号请在域控修改密码' };
    if (String(newPass || '').length < 6) return { ok: false, error: '新密码至少 6 位' };
    u.passwordHash = hashPassword(newPass);
    u.updatedAt = Date.now();
    this.#persistUsers();
    return { ok: true };
  }
  resetPassword(u, newPass) {
    if (u.source !== 'local') return { ok: false, error: 'AD 账号不支持本地重置密码' };
    if (String(newPass || '').length < 6) return { ok: false, error: '新密码至少 6 位' };
    u.passwordHash = hashPassword(newPass);
    u.failedAttempts = 0; u.lockedUntil = 0; u.updatedAt = Date.now();
    this.destroyUserSessions(u.id);
    this.#persistUsers();
    return { ok: true };
  }

  // ---------- 用户 CRUD（管理接口用） ----------
  createUser({ username, password, displayName = '', role = 'viewer', email = '' }) {
    username = String(username || '').trim().toLowerCase();
    if (!/^[a-z0-9._@-]{2,64}$/.test(username)) return { ok: false, error: '用户名仅允许小写字母数字 . _ @ -（2-64 位）' };
    if (this.findUser(username)) return { ok: false, error: '用户名已存在' };
    if (!this.roleIds().includes(role)) return { ok: false, error: '角色不存在' };
    if (String(password || '').length < 6) return { ok: false, error: '密码至少 6 位' };
    const u = this.#mkUser({ username, displayName, email, source: 'local', role });
    u.passwordHash = hashPassword(password);
    this.users.push(u);
    this.#persistUsers();
    return { ok: true, user: this.publicUser(u) };
  }
  updateUser(id, patch) {
    const u = this.userById(id);
    if (!u) return { ok: false, error: '用户不存在' };
    const { displayName, email, role, enabled } = patch || {};
    if (displayName !== undefined) u.displayName = String(displayName);
    if (email !== undefined) u.email = String(email);
    if (role !== undefined) {
      if (!this.roleIds().includes(role)) return { ok: false, error: '角色不存在' };
      if (u.username === 'admin' && role !== 'admin') return { ok: false, error: '默认 admin 不可变更角色' };
      u.role = role;
      this.destroyUserSessions(u.id); // 角色变更即时生效
    }
    if (enabled !== undefined) {
      if (u.username === 'admin' && !enabled) return { ok: false, error: '默认 admin 不可禁用' };
      u.enabled = !!enabled;
      if (!u.enabled) this.destroyUserSessions(u.id);
    }
    u.updatedAt = Date.now();
    this.#persistUsers();
    return { ok: true, user: this.publicUser(u) };
  }
  deleteUser(id) {
    const u = this.userById(id);
    if (!u) return { ok: false, error: '用户不存在' };
    if (u.username === 'admin') return { ok: false, error: '默认 admin 不可删除' };
    this.users = this.users.filter(x => x.id !== id);
    this.destroyUserSessions(id);
    this.#persistUsers();
    return { ok: true };
  }

  // ---------- 角色 CRUD ----------
  createRole({ id, label, perms = [] }) {
    id = String(id || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
    if (!id) return { ok: false, error: '角色 ID 仅允许小写字母数字 _ -' };
    if (this.roles.find(r => r.id === id)) return { ok: false, error: '角色已存在' };
    const bad = perms.filter(p => !PERM_KEYS.has(p));
    if (bad.length) return { ok: false, error: `未知权限点: ${bad.join(', ')}` };
    const r = { id, label: String(label || id), builtin: false, perms };
    this.roles.push(r);
    this.#persistRoles();
    return { ok: true, role: r };
  }
  updateRole(id, patch) {
    const r = this.roles.find(x => x.id === id);
    if (!r) return { ok: false, error: '角色不存在' };
    if (r.builtin && patch.perms !== undefined) return { ok: false, error: '内置角色权限不可修改' };
    if (patch.label !== undefined) r.label = String(patch.label);
    if (patch.perms !== undefined) {
      const bad = patch.perms.filter(p => !PERM_KEYS.has(p));
      if (bad.length) return { ok: false, error: `未知权限点: ${bad.join(', ')}` };
      r.perms = patch.perms;
      // 该角色用户会话失效，权限即时生效
      for (const u of this.users) if (u.role === id) this.destroyUserSessions(u.id);
    }
    this.#persistRoles();
    return { ok: true, role: r };
  }
  deleteRole(id) {
    const r = this.roles.find(x => x.id === id);
    if (!r) return { ok: false, error: '角色不存在' };
    if (r.builtin) return { ok: false, error: '内置角色不可删除' };
    if (this.users.some(u => u.role === id)) return { ok: false, error: '仍有用户使用该角色，请先调整其角色' };
    if (this.adConfig.defaultRole === id) return { ok: false, error: '该角色是 AD 默认角色，请先更换' };
    this.roles = this.roles.filter(x => x.id !== id);
    this.#persistRoles();
    return { ok: true };
  }

  // ---------- AD 配置 ----------
  adPublic() {
    const { url, baseDN, upnSuffix, defaultRole, enabled, allowCreateLocal, tlsVerify } = this.adConfig;
    return { enabled, url, baseDN, upnSuffix, defaultRole, allowCreateLocal, tlsVerify };
  }
  saveAdConfig(cfg) {
    const c = cfg || {};
    const url = String(c.url || '').trim();
    if (url && !/^ldaps?:\/\//i.test(url)) return { ok: false, error: 'LDAP URL 必须以 ldap:// 或 ldaps:// 开头' };
    const defaultRole = String(c.defaultRole || 'viewer');
    if (!this.roleIds().includes(defaultRole)) return { ok: false, error: '默认角色不存在' };
    Object.assign(this.adConfig, {
      enabled: !!c.enabled,
      url,
      baseDN: String(c.baseDN || '').trim(),
      upnSuffix: String(c.upnSuffix || '').trim(),
      defaultRole,
      allowCreateLocal: c.allowCreateLocal !== false,
      tlsVerify: c.tlsVerify !== false,
    });
    this.#persistAd();
    return { ok: true, config: this.adPublic() };
  }

  /** 权限检查核心：角色 → perms */
  hasPerm(u, perm) {
    const r = this.roleOf(u);
    return !!r && r.perms.includes(perm);
  }
}

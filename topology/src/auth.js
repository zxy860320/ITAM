// V2 最小认证（docs/TOPOLOGY-V2-DESIGN.md §10 路径 A）
// 现实起点：平台无认证体系。本模块给 topology-svc 自带 users + sessions + requireRole，
// 全部写端点后端校验——不是前端隐藏按钮。会话=不透明随机 token（httpOnly cookie），
// 服务端存储（auth_sessions 表）可随时吊销；接口面 authed(req) 抽象，日后换 JWT/LDAP 不动业务端点。
// 凭据纪律：密码 scrypt 哈希（node:crypto 内置，零依赖）；任何接口不回哈希；
// 初始管理员来自环境变量 TOPO_ADMIN_BOOTSTRAP_USER/PASS（.env 卷挂载，不入镜像）。
import crypto from 'node:crypto';

const COOKIE = 'topo_session';
const SESSION_TTL = 7 * 24 * 3600;      // 7 天滑动
const LOGIN_WINDOW = 60, LOGIN_MAX = 5; // 登录限速：每 IP 每分钟 5 次

const scryptHash = (pw) => {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(String(pw), salt, 64);
  return `scrypt$${salt.toString('hex')}$${h.toString('hex')}`;
};
const scryptVerify = (pw, stored) => {
  try {
    const [alg, saltHex, hashHex] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const h = crypto.scryptSync(String(pw), Buffer.from(saltHex, 'hex'), 64);
    return crypto.timingSafeEqual(h, Buffer.from(hashHex, 'hex'));
  } catch { return false; }
};

export async function initAuth(db) {
  if (db.kind === 'mysql') {
    await db.prepare(`CREATE TABLE IF NOT EXISTS topo_user (
      username VARCHAR(64) PRIMARY KEY, pass_hash VARCHAR(255) NOT NULL,
      role VARCHAR(16) NOT NULL DEFAULT 'viewer', created_at BIGINT, updated_at BIGINT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`).run();
    await db.prepare(`CREATE TABLE IF NOT EXISTS auth_session (
      token VARCHAR(64) PRIMARY KEY, username VARCHAR(64) NOT NULL,
      expires_at BIGINT NOT NULL, created_at BIGINT, last_seen_at BIGINT,
      INDEX idx_sess_user (username)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`).run();
  } else {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS topo_user (
        username TEXT PRIMARY KEY, pass_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'viewer', created_at INTEGER, updated_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS auth_session (
        token TEXT PRIMARY KEY, username TEXT NOT NULL,
        expires_at INTEGER NOT NULL, created_at INTEGER, last_seen_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_sess_user ON auth_session(username);`);
  }
  // 首启引导管理员（无环境变量则跳过——本地开发可暂时匿名只读，写操作 401）
  const bu = process.env.TOPO_ADMIN_BOOTSTRAP_USER, bp = process.env.TOPO_ADMIN_BOOTSTRAP_PASS;
  const userCount = (await db.prepare('SELECT COUNT(*) AS n FROM topo_user').get()).n;
  if (bu && bp && userCount === 0) {
    await db.prepare('INSERT INTO topo_user(username,pass_hash,role,created_at,updated_at) VALUES(?,?,?,?,?)')
      .run(bu, scryptHash(bp), 'admin', Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000));
    console.log(`[auth] bootstrap admin created: ${bu}`);
  }
}

// —— 会话解析：每个请求挂 req.auth = {user, role} | null（滑动续期节流：>1h 才写库）——
export function authMiddleware(db) {
  return async (req, res, next) => {
    req.auth = null;
    try {
      const cookie = req.headers.cookie || '';
      const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(cookie);
      if (m) {
        const tok = decodeURIComponent(m[1]);
        if (/^[a-f0-9]{64}$/.test(tok)) {
          const now = Math.floor(Date.now() / 1000);
          const s = await db.prepare('SELECT token, username, expires_at, last_seen_at FROM auth_session WHERE token=?').get(tok);
          if (s && s.expires_at > now) {
            const u = await db.prepare('SELECT username, role FROM topo_user WHERE username=?').get(s.username);
            if (u) {
              req.auth = { user: u.username, role: u.role };
              if (!s.last_seen_at || now - s.last_seen_at > 3600) {
                await db.prepare('UPDATE auth_session SET expires_at=?, last_seen_at=? WHERE token=?').run(now + SESSION_TTL, now, tok);
              }
            } else {
              await db.prepare('DELETE FROM auth_session WHERE token=?').run(tok);
            }
          } else if (s) {
            await db.prepare('DELETE FROM auth_session WHERE token=?').run(tok);
          }
        }
      }
    } catch { /* 会话解析失败按匿名处理，不 500 */ }
    next();
  };
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.auth) return res.status(401).json({ error: '未登录', code: 'AUTH_REQUIRED' });
    if (!roles.includes(req.auth.role)) return res.status(403).json({ error: '权限不足', code: 'FORBIDDEN', need: roles });
    next();
  };
}

// 登录限速（进程内计数即可——单实例服务）
const loginHits = new Map();
export function loginRateLimited(ip) {
  const now = Date.now();
  const arr = (loginHits.get(ip) || []).filter(t => now - t < LOGIN_WINDOW * 1000);
  if (arr.length >= LOGIN_MAX) { loginHits.set(ip, arr); return true; }
  arr.push(now); loginHits.set(ip, arr);
  if (loginHits.size > 500) loginHits.clear();
  return false;
}

export function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL}`);
}
export function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}
export function newToken() { return crypto.randomBytes(32).toString('hex'); }
export { scryptHash, scryptVerify, COOKIE, SESSION_TTL };

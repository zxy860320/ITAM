import { Client } from 'ldapts';
import tls from 'tls';

// ============================================================================
// AD 域对接（ldapts）
// 认证方式：UPN bind —— 用 username@upnSuffix 作为 bind DN 直接登录（不需要
// 服务账号）。若配置了 baseDN，则 bind 成功后再 search 一次取 displayName/mail。
// 不伪造：连不上/超时/证书错误一律如实报错，绝不降级放行。
// ============================================================================

const TIMEOUT_MS = 8000;

function mkClient(cfg) {
  return new Client({
    url: cfg.url,
    timeout: TIMEOUT_MS,
    // ldaps + 企业内网自签证书常见：拒绝未校验证书，但允许管理员显式勾选 skipVerify
    ...(cfg.url.startsWith('ldaps://') ? { tlsOptions: { rejectUnauthorized: cfg.tlsVerify !== false } } : {}),
  });
}

/**
 * AD 用户名密码验证。
 * @returns { ok, profile?: {displayName, email}, error? }
 */
export async function adAuthenticate(cfg, username, password) {
  const upn = cfg.upnSuffix ? `${username}@${cfg.upnSuffix}` : String(username);
  const client = mkClient(cfg);
  try {
    await client.bind(upn, password);
    let profile = { displayName: '', email: '' };
    if (cfg.baseDN) {
      // bind 成功即认证通过；search 仅补全展示属性，失败不影响登录结果
      try {
        const san = String(upn).replace(/[\\*()"\0]/g, '');
        const { searchEntries } = await client.search(cfg.baseDN, {
          scope: 'sub',
          filter: `(|(userPrincipalName=${san})(sAMAccountName=${san.replace(/@.*$/, '')}))`,
          attributes: ['displayName', 'mail', 'userPrincipalName'],
          sizeLimit: 1,
        });
        if (searchEntries[0]) {
          profile.displayName = String(searchEntries[0].displayName || '');
          profile.email = String(searchEntries[0].mail || '');
        }
      } catch { /* 属性补全失败：保持空展示字段 */ }
    }
    return { ok: true, profile };
  } catch (e) {
    const msg = String(e?.message || e);
    // 531/invalidCredentials → 统一模糊文案，不泄露账号是否存在
    if (/invalid credentials|531|credentials/i.test(msg)) return { ok: false, error: '用户名或密码错误（AD）' };
    return { ok: false, error: `AD 连接失败: ${msg}` };
  } finally {
    await client.unbind().catch(() => {});
  }
}

/**
 * 连通性测试（用户管理页「测试连接」）：TCP/TLS 可达 + 匿名根 DSE 读取。
 * 不要求凭据；失败原因如实回传（DNS/拒绝/超时/证书）。
 */
export async function adTestConnection(cfg) {
  const t0 = Date.now();
  if (!cfg?.url) return { ok: false, error: '未配置 LDAP URL' };
  try {
    new URL(cfg.url); // URL 合法性
  } catch { return { ok: false, error: 'LDAP URL 格式非法' }; }
  try {
    // 先做底层可达性探测，拿到精确的错误分类（DNS/拒绝/超时/证书）
    if (cfg.url.startsWith('ldaps://')) {
      await new Promise((resolve, reject) => {
        const u = new URL(cfg.url);
        const sock = tls.connect({
          host: u.hostname, port: Number(u.port || 636),
          rejectUnauthorized: cfg.tlsVerify !== false,
          timeout: TIMEOUT_MS,
        }, () => { sock.end(); resolve(); });
        sock.on('error', reject);
        sock.on('timeout', () => { sock.destroy(); reject(new Error('TLS 连接超时')); });
      });
    } else {
      const net = await import('net');
      await new Promise((resolve, reject) => {
        const u = new URL(cfg.url);
        const sock = net.connect(Number(u.port || 389), u.hostname, () => { sock.end(); resolve(); });
        sock.setTimeout(TIMEOUT_MS);
        sock.on('error', reject);
        sock.on('timeout', () => { sock.destroy(); reject(new Error('TCP 连接超时')); });
      });
    }
    // 可达 → 读根 DSE（空 bind DN，AD 允许匿名查询 rootDSE）验证是 LDAP 服务
    const client = mkClient(cfg);
    try {
      const { searchEntries } = await client.search('', { scope: 'base', filter: '(objectClass=*)', attributes: ['defaultNamingContext', 'dnsHostName', 'serverName'] });
      const root = searchEntries[0] || {};
      return {
        ok: true, latencyMs: Date.now() - t0,
        server: String(root.dnsHostName || root.serverName || ''),
        namingContext: String(root.defaultNamingContext || ''),
        baseDNHint: cfg.baseDN || root.defaultNamingContext || '',
      };
    } finally {
      await client.unbind().catch(() => {});
    }
  } catch (e) {
    const msg = String(e?.message || e);
    let hint = '';
    if (/ENOTFOUND|EAI_AGAIN/i.test(msg)) hint = '；域名无法解析（检查 DNS 或 hosts）';
    else if (/ECONNREFUSED/i.test(msg)) hint = '；端口拒绝连接（检查 389/636 与防火墙）';
    else if (/certificate|self.signed|self-signed/i.test(msg)) hint = '；证书校验失败（内网自签证书可勾选跳过校验）';
    return { ok: false, error: `${msg}${hint}`, latencyMs: Date.now() - t0 };
  }
}

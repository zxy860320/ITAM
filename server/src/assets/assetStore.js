import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

// 资产台账存储：data/assets.json（运行时数据，含加密凭据——.gitignore 排除，不入库）。
// 凭据红线：密码 AES-256-GCM 加密后存 enc 字段；任何列表/详情接口永不返回 enc 与明文；
// 明文只能通过 /api/assets/cred/reveal 显式获取，且每次查看都写审计（asset_audit.jsonl）。
// 密钥：env ITYW_CRED_KEY（32字节hex）优先；缺省时首启自动生成 data/cred.key（同样不入库）。
// 换密钥不破坏旧数据：解密失败单条报错提示，不影响其他记录。

export const ASSET_TYPES = [
  { key: 'server',   label: '服务器' },
  { key: 'network',  label: '网络设备' },
  { key: 'vm',       label: '虚拟机' },
  { key: 'database', label: '数据库' },
  { key: 'pc',       label: '电脑终端' },
  { key: 'office',   label: '办公软件' },
  { key: 'web',      label: 'Web 服务' },
  { key: 'other',    label: '其他' },
];
export const TYPE_LABEL = Object.fromEntries(ASSET_TYPES.map(t => [t.key, t.label]));

const rid = (n = 8) => crypto.randomBytes(n).toString('hex').slice(0, n);

function loadKey(dataDir) {
  const fromEnv = (process.env.ITYW_CRED_KEY || '').trim();
  if (fromEnv) {
    const k = Buffer.from(fromEnv, 'hex');
    if (k.length !== 32) throw new Error('ITYW_CRED_KEY 必须是 64 位 hex（32 字节），当前长度不符');
    return k;
  }
  const kf = path.join(dataDir, 'cred.key');
  try {
    const k = Buffer.from(fs.readFileSync(kf, 'utf-8').trim(), 'hex');
    if (k.length === 32) return k;
  } catch { /* 首启无密钥文件 */ }
  const k = crypto.randomBytes(32);
  fs.writeFileSync(kf, k.toString('hex'));
  console.log('[assets] 已生成凭据加密密钥 cred.key（勿入库、勿丢失；建议生产改用 ITYW_CRED_KEY 环境变量）');
  return k;
}

export class AssetStore {
  constructor(dataDir, { auditFile } = {}) {
    this.file = path.join(dataDir, 'assets.json');
    this.auditFile = auditFile || path.join(dataDir, 'asset_audit.jsonl');
    this.key = loadKey(dataDir);
    this.assets = this.#load();
  }

  #load() {
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf-8'));
      return Array.isArray(d.assets) ? d.assets : [];
    } catch { return []; }
  }
  #persist() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({ assets: this.assets }, null, 1));
  }
  audit(rec) {
    try {
      fs.appendFileSync(this.auditFile, JSON.stringify({ at: Date.now(), ...rec }) + '\n');
    } catch (e) { console.warn('[assets] 审计写入失败:', e.message); }
  }

  encrypt(plain) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([c.update(String(plain), 'utf-8'), c.final()]);
    return `${iv.toString('hex')}.${c.getAuthTag().toString('hex')}.${ct.toString('hex')}`;
  }
  decrypt(enc) {
    const [ivH, tagH, ctH] = String(enc).split('.');
    const d = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivH, 'hex'));
    d.setAuthTag(Buffer.from(tagH, 'hex'));
    return Buffer.concat([d.update(Buffer.from(ctH, 'hex')), d.final()]).toString('utf-8');
  }

  /** 凭据元数据（永不带密码，无论 enc 还是明文） */
  #credMeta(c) {
    return { id: c.id, label: c.label, username: c.username, note: c.note || '', hasPassword: !!c.enc, updatedAt: c.updatedAt };
  }
  /** 资产摘要/详情（脱敏视图） */
  #view(a, full) {
    const v = {
      id: a.id, type: a.type, typeLabel: TYPE_LABEL[a.type] || a.type,
      name: a.name, ip: a.ip || '', model: a.model || '', os: a.os || '',
      sn: a.sn || '', location: a.location || '', owner: a.owner || '',
      env: a.env || '', status: a.status || 'inuse', remark: a.remark || '',
      monitorHostid: a.monitorHostid || '',
      credCount: (a.creds || []).length,
      createdAt: a.createdAt, updatedAt: a.updatedAt,
    };
    if (full) v.creds = (a.creds || []).map(c => this.#credMeta(c));
    return v;
  }

  stats() {
    const byType = {};
    let creds = 0;
    for (const a of this.assets) {
      byType[a.type] = (byType[a.type] || 0) + 1;
      creds += (a.creds || []).length;
    }
    return { total: this.assets.length, creds, byType, types: ASSET_TYPES };
  }

  list({ type, q, page = 1, size = 20 } = {}) {
    let out = this.assets;
    if (type) out = out.filter(a => a.type === type);
    if (q) {
      const s = String(q).toLowerCase();
      out = out.filter(a =>
        (a.name || '').toLowerCase().includes(s) || (a.ip || '').includes(s) ||
        (a.model || '').toLowerCase().includes(s) || (a.owner || '').toLowerCase().includes(s) ||
        (a.sn || '').toLowerCase().includes(s) || (a.location || '').includes(s));
    }
    out = [...out].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const total = out.length;
    const p = Math.max(1, Number(page) || 1), sz = Math.min(200, Math.max(1, Number(size) || 20));
    return { rows: out.slice((p - 1) * sz, p * sz).map(a => this.#view(a, false)), total, page: p, size: sz };
  }

  get(id) {
    const a = this.assets.find(x => x.id === id);
    return a ? this.#view(a, true) : null;
  }
  findByIp(ip) {
    ip = String(ip || '').trim();
    if (!ip) return null;
    return this.assets.find(a => a.ip === ip) || null;
  }

  /** 新增/更新资产 + 凭据。凭据带 id=更新（密码留空=保留旧密码），不带 id=新增；
   *  凭据删除只走 deleteCred（防误覆盖）。 */
  save(payload) {
    const name = String(payload.name || '').trim();
    if (!name) return { error: '资产名称必填' };
    const type = ASSET_TYPES.some(t => t.key === payload.type) ? payload.type : 'other';
    const now = Date.now();
    let a = payload.id ? this.assets.find(x => x.id === payload.id) : null;
    if (payload.id && !a) return { error: '资产不存在' };
    if (!a) {
      a = { id: `as-${rid(8)}`, creds: [], createdAt: now };
      this.assets.push(a);
    }
    for (const f of ['name', 'ip', 'model', 'os', 'sn', 'location', 'owner', 'env', 'status', 'remark', 'monitorHostid']) {
      if (payload[f] !== undefined) a[f] = String(payload[f]).trim();
    }
    a.type = type;
    // 凭据：更新或新增
    for (const c of (Array.isArray(payload.creds) ? payload.creds : [])) {
      const label = String(c.label || '').trim() || '默认';
      const username = String(c.username || '').trim();
      if (c.id) {
        const old = (a.creds || []).find(x => x.id === c.id);
        if (!old) continue;
        old.label = label; old.username = username; old.note = String(c.note || '').trim();
        const pw = String(c.password || '');
        if (pw) old.enc = this.encrypt(pw);   // 空密码=不改
        old.updatedAt = now;
      } else {
        if (!username) return { error: `凭据「${label}」缺少账号` };
        if (!c.password) return { error: `新凭据「${label}」必须设置密码` };
        (a.creds = a.creds || []).push({ id: `cr-${rid(6)}`, label, username, note: String(c.note || '').trim(), enc: this.encrypt(c.password), createdAt: now, updatedAt: now });
      }
    }
    a.updatedAt = now;
    this.#persist();
    return { ok: true, id: a.id };
  }

  remove(id) {
    const i = this.assets.findIndex(x => x.id === id);
    if (i < 0) return { error: '资产不存在' };
    const [gone] = this.assets.splice(i, 1);
    this.#persist();
    this.audit({ via: 'web', action: 'delete', asset: `${gone.name}(${gone.id})`, by: 'ui' });
    return { ok: true };
  }

  deleteCred(assetId, credId) {
    const a = this.assets.find(x => x.id === assetId);
    if (!a) return { error: '资产不存在' };
    const i = (a.creds || []).findIndex(c => c.id === credId);
    if (i < 0) return { error: '凭据不存在' };
    const [gone] = a.creds.splice(i, 1);
    a.updatedAt = Date.now();
    this.#persist();
    this.audit({ via: 'web', action: 'cred-delete', asset: `${a.name}(${a.id})`, cred: `${gone.label}/${gone.username}` });
    return { ok: true };
  }

  /** 查看明文——仅显式调用，必审计。 */
  revealCred(assetId, credId) {
    const a = this.assets.find(x => x.id === assetId);
    if (!a) return { error: '资产不存在' };
    const c = (a.creds || []).find(x => x.id === credId);
    if (!c) return { error: '凭据不存在' };
    if (!c.enc) return { error: '该凭据未设置密码' };
    let password;
    try { password = this.decrypt(c.enc); }
    catch { return { error: '凭据解密失败：加密密钥可能已更换（旧凭据需用新密钥重存）' }; }
    this.audit({ via: 'web', action: 'cred-reveal', asset: `${a.name}(${a.id})`, cred: `${c.label}/${c.username}`, by: 'ui' });
    return { ok: true, username: c.username, password, label: c.label };
  }

  /** 从监控面（Zabbix/dbmp 实体）一键导入：按 IP 去重，已存在的只补 monitorHostid，不动凭据。 */
  importFromMonitor(entities) {
    let added = 0, updated = 0, skipped = 0;
    const now = Date.now();
    for (const e of entities) {
      const ip = String(e.ip || '').trim();
      if (!ip) { skipped++; continue; }
      const guessType = e.domain === 'network' ? 'network' : e.domain === 'database' ? 'database' : e.domain === 'service' ? 'web' : 'server';
      const exist = this.findByIp(ip);
      if (exist) {
        if (!exist.monitorHostid && e.hostid) { exist.monitorHostid = e.hostid; exist.updatedAt = now; updated++; }
        else skipped++;
        continue;
      }
      this.assets.push({
        id: `as-${rid(8)}`, type: guessType, name: e.name || ip, ip,
        model: e.model || '', os: e.os || '', sn: '', location: e.location || '', owner: '', env: '',
        status: 'inuse', remark: e.label ? `导入自监控：${e.label}` : '导入自监控',
        monitorHostid: e.hostid || '', creds: [], createdAt: now, updatedAt: now,
      });
      added++;
    }
    if (added || updated) this.#persist();
    this.audit({ via: 'web', action: 'import-monitor', added, updated, skipped });
    return { ok: true, added, updated, skipped };
  }

  /** MCP 只读视图（永不返回任何凭据内容，连元数据也只给数量） */
  mcpList({ type, q } = {}) {
    let out = this.assets;
    if (type) out = out.filter(a => a.type === type);
    if (q) {
      const s = String(q).toLowerCase();
      out = out.filter(a => (a.name || '').toLowerCase().includes(s) || (a.ip || '').includes(s) || (a.owner || '').toLowerCase().includes(s));
    }
    return out.slice(0, 50).map(a => ({
      id: a.id, type: a.type, typeLabel: TYPE_LABEL[a.type] || a.type,
      name: a.name, ip: a.ip || '', model: a.model || '', os: a.os || '',
      location: a.location || '', owner: a.owner || '', env: a.env || '', status: a.status || 'inuse',
      credCount: (a.creds || []).length,
    }));
  }
}

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

// 配置/审计持久化：data/ops.json（跳板机连接配置，含 token——与 source.json 同级、同样不入库）
// 备份内容独立存目录 data/backups/<assetKey>/<ts>.txt（含设备密文，单独存放便于管控），
// data/backups/index.json 只存元数据 + sha1 指纹 + 脱敏预览，供列表与变更检测。

// 跳板机命令模板白名单（命令只能从模板选，前端不接受自由输入）。
// 实测（2026-10-30）：`|`/重定向等元字符被 MCP 直接拒绝；save/reboot 等是危险词黑名单——
// 所以这里只放"单条、纯词表内、只读"的命令；输出过滤在 ITYW 侧做。
export const TEMPLATES = [
  { id: 'cfg-huawei', label: '配置备份（华为/H3C VRP）', platform: 'net', command: 'display current-configuration', backup: true },
  { id: 'ver-huawei', label: '版本信息（华为/H3C VRP）', platform: 'net', command: 'display version' },
  { id: 'cfg-h3c-comware', label: '配置备份（H3C Comware）', platform: 'net', command: 'display current-configuration', backup: true },
  { id: 'ver-h3c-comware', label: '版本信息（H3C Comware）', platform: 'net', command: 'display version' },
  { id: 'cfg-cisco', label: '配置备份（Cisco IOS）', platform: 'net', command: 'show running-config', backup: true },
  { id: 'ver-cisco', label: '版本信息（Cisco IOS）', platform: 'net', command: 'show version' },
];
// 第一期只启用实测过的华为/H3C 备份与版本命令；Cisco 未在该环境实测，保留模板但 disabled
for (const t of TEMPLATES) if (t.id.startsWith('cfg-cisco') || t.id.startsWith('ver-cisco')) t.disabled = true;
export const TEMPLATE_BY_ID = Object.fromEntries(TEMPLATES.map(t => [t.id, t]));

// 输出脱敏：设备配置含 local-user 密文 / SNMP community / 密码类行——预览与列表一律脱敏后才回前端
const SECRET_PATTERNS = [
  /^(\s*(local-user\s+\S+\s+password|password|set authentication password|authentication-key|simple|cipher|irreversible-cipher)\b).*$/im,
  /(community|authentication\s+md5|authentication\s+simple|authentication\s+cipher|authentication\s+key)\b.*$/i,
  /(%\^%[^%]*%\^%)/g,
  /(\$1c\$[^\s]+)/g,
  /(\$1a\$[^\s]+)/g,
];
export function redact(text) {
  if (!text) return '';
  let out = String(text);
  // 任何位置含 password 关键词的行整行脱敏（local-user ... password / set authentication password / password recover 等）
  out = out.replace(/(^|\n)([^\n]*\bpassword\b[^\n]*)/gi, (_m, p1) => `${p1}  *** 已脱敏`);
  out = out.replace(/(^|\n)(\s*[^\n]*\b(?:community|authentication-key)\b[^\n]*)/gi, (_m, p1) => `${p1}  *** 已脱敏`);
  out = out.replace(/%\^%[^%]*%\^%/g, '***');
  out = out.replace(/\$1c\$[^\s]+/g, '***');
  out = out.replace(/\$1a\$[^\s]+/g, '***');
  return out;
}

// KoKo 分页残渣清洗：VRP/Comware 长输出里 "---- More ----" 及其右侧回显空白要抹掉；
// 末尾提示符行（<...> 或 [...]# / $）保留判断但裁掉——只留配置正文。
export function cleanPaging(text) {
  let out = String(text).replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');       // ANSI 序列
  out = out.replace(/-{2,}\s*More\s*-{2,}[^\n]*/g, '');                  // "---- More ----" + 同行右侧残渣
  out = out.replace(/[ \t]{20,}\n/g, '\n');                              // 分页后填充空白
  out = out.replace(/\n{3,}/g, '\n\n');
  // 裁掉结尾提示符行（华为 <HOST>、Linux [root@h ~]#）与 shell 退出码残留
  out = out.replace(/\n\s*[<[][^\n\]]*(?:>|~\]#|\$)\s*;?\d*\s*$/g, '');
  return out.trim();
}

export class OpsStore {
  constructor({ cfgFile, backupDir }) {
    this.cfgFile = cfgFile;
    this.backupDir = backupDir;
    this.indexFile = path.join(backupDir, 'index.json');
    this.cfg = { enabled: false, mcpUrl: '', token: '', knownHostsHint: '' };
    this.index = { items: [] }; // 元数据：{id, assetKey, assetName, address, tpl, command, at, bytes, sha1, changed, redactedPreview, error}
    this._load();
  }
  _load() {
    try { Object.assign(this.cfg, JSON.parse(fs.readFileSync(this.cfgFile, 'utf-8'))); } catch { /* 首启无配置 */ }
    try { this.index = JSON.parse(fs.readFileSync(this.indexFile, 'utf-8')); } catch { /* 首启无备份 */ }
  }
  saveCfg(partial) {
    Object.assign(this.cfg, partial);
    fs.mkdirSync(path.dirname(this.cfgFile), { recursive: true });
    fs.writeFileSync(this.cfgFile, JSON.stringify(this.cfg, null, 2));
  }
  publicCfg() {
    return {
      enabled: !!this.cfg.enabled,
      mcpUrl: this.cfg.mcpUrl || '',
      hasToken: !!this.cfg.token,
    };
  }
  _saveIndex() {
    fs.mkdirSync(this.backupDir, { recursive: true });
    fs.writeFileSync(this.indexFile, JSON.stringify(this.index, null, 1));
  }
  list({ assetKey = '', limit = 50 } = {}) {
    const items = this.index.items
      .filter(x => (!assetKey || x.assetKey === assetKey))
      .slice(0, limit);
    return items;
  }
  latest(assetKey) {
    return this.index.items.find(x => x.assetKey === assetKey) || null;
  }
  // 追加一条备份元数据（全文另存文件）；changed = 与上一条同设备指纹是否不同
  addBackup({ assetKey, assetName, address, tpl, command, raw }) {
    const cfgText = cleanPaging(raw);
    const sha1 = crypto.createHash('sha1').update(cfgText).digest('hex');
    const prev = this.latest(assetKey);
    const changed = prev ? prev.sha1 !== sha1 : true;
    const id = `${Date.now()}-${sha1.slice(0, 8)}`;
    const dir = path.join(this.backupDir, assetKey.replace(/[^\w.-]/g, '_'));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${id}.txt`);
    fs.writeFileSync(file, cfgText); // 全文含密文：仅存磁盘，接口永不整发
    const rec = {
      id, assetKey, assetName, address, tpl, command,
      at: Date.now(), bytes: Buffer.byteLength(cfgText), sha1, changed,
      prevSha1: prev?.sha1 || null, file,
      redactedPreview: redact(cfgText).split('\n').slice(0, 40).join('\n'),
    };
    this.index.items.unshift(rec);
    if (this.index.items.length > 2000) this.index.items.length = 2000;
    this._saveIndex();
    return rec;
  }
  get(recId) { return this.index.items.find(x => x.id === recId) || null; }
}

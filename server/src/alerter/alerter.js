// ============================================================
// 告警出口（Notifier）
// 通道：钉钉 / 飞书 / 企业微信（群机器人 webhook）、邮箱（SMTP）
// 机制：每轮采集后对 problem 事件差分——
//   新增活动告警 → 按通道路由规则(最低级别/域/正则)发送；
//   告警恢复(不再出现在 problem 列表) → 发恢复通知(可关)；
//   服务重启首轮只登记基线不补发，避免重启风暴；
//   每通道每轮最多 2 条(新增聚合1条+恢复聚合1条)，防刷屏。
// 内容全部来自 Zabbix 真实事件字段，不伪造任何指标。
// ============================================================
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import nodemailer from 'nodemailer';

export const SEV_LABEL = { info: '信息', warning: '警告', severe: '严重', critical: '灾难' };
const SEV_NUM = { info: 1, warning: 2, severe: 3, critical: 4 };
const DOMAIN_LABEL = { server: '服务器', network: '网络', database: '数据库', service: '服务' };
export const CH_TYPES = {
  dingtalk: '钉钉机器人',
  feishu: '飞书机器人',
  wecom: '企业微信机器人',
  email: '邮件(SMTP)',
};
const MAX_LINES = 10;       // 聚合消息最多列出的事件条数
const STATE_TTL = 7 * 864e5; // 已恢复事件快照保留 7 天后剪枝
const http = (url, body) => fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(10000),
}).then(async r => {
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch { /* 非 JSON 响应按文本判错 */ }
  if (!r.ok) throw new Error(`HTTP ${r.status} ${String(text).slice(0, 200)}`);
  // 三家机器人协议都是 errcode/code 非 0 即失败
  if (j && ((j.errcode != null && j.errcode !== 0) || (j.code != null && j.code !== 0 && j.code !== '0'))) {
    throw new Error(`errcode=${j.errcode ?? j.code} ${j.errmsg || j.msg || ''}`.trim());
  }
  return j || {};
});

const mask = s => !s ? '' : (s.length <= 8 ? '•'.repeat(Math.max(3, s.length)) : s.slice(0, 4) + '••••••' + s.slice(-4));
const isMasked = s => typeof s === 'string' && s.includes('•');
function maskUrl(u) {
  try {
    const x = new URL(u);
    for (const [k, v] of x.searchParams.entries()) x.searchParams.set(k, mask(v));
    return x.toString();
  } catch { return mask(u); }
}

export class Notifier {
  constructor(cfgFile, stateFile) {
    this.cfgFile = cfgFile;
    this.stateFile = stateFile;
    this.cfg = { enabled: false, consoleUrl: '', channels: [] };
    this.state = { baseline: false, open: {}, closed: {} };
    this.log = [];            // 内存发送日志（最近 100 条）
    this.stats = { sent: 0, fail: 0, lastOk: null, lastErr: null };
    this._busy = false;
    this._transports = new Map(); // email transport 按 通道id+host+user 缓存
    this._load();
  }

  _load() {
    try { Object.assign(this.cfg, JSON.parse(fs.readFileSync(this.cfgFile, 'utf-8'))); } catch { /* 首次运行用默认 */ }
    try { this.state = Object.assign(this.state, JSON.parse(fs.readFileSync(this.stateFile, 'utf-8'))); } catch { /* 无状态文件 */ }
    this._prune();
  }
  saveCfg() {
    fs.mkdirSync(path.dirname(this.cfgFile), { recursive: true });
    fs.writeFileSync(this.cfgFile, JSON.stringify(this.cfg, null, 2));
  }
  _saveState() {
    this._prune();
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      fs.writeFileSync(this.stateFile, JSON.stringify(this.state));
    } catch (e) { console.warn('[notify] 状态持久化失败:', e.message); }
  }
  _prune() {
    const now = Date.now();
    for (const [id, c] of Object.entries(this.state.closed || {})) {
      if (!c || now - (c.rt || 0) > STATE_TTL) delete this.state.closed[id];
    }
  }

  // ---------- 配置保存（掩码回填：前端带 • 的字段保留原值） ----------
  saveConfig(body) {
    const old = new Map(this.cfg.channels.map(c => [c.id, c]));
    const channels = (Array.isArray(body.channels) ? body.channels : []).map(c => {
      const id = c.id || ('ch_' + crypto.randomBytes(4).toString('hex'));
      const o = old.get(id) || {};
      const keep = (v, prev) => (v == null || v === '' || isMasked(v)) ? (prev ?? '') : v;
      const ch = {
        id,
        type: CH_TYPES[c.type] ? c.type : 'dingtalk',
        label: String(c.label || CH_TYPES[c.type] || '通道'),
        enabled: c.enabled !== false,
        webhook: keep(c.webhook, o.webhook),
        secret: keep(c.secret, o.secret),
        keyword: c.keyword ?? o.keyword ?? '',
        minSeverity: SEV_NUM[c.minSeverity] ? c.minSeverity : 'warning',
        domains: Array.isArray(c.domains) ? c.domains : [],
        pattern: c.pattern ?? '',
        includeRecovery: c.includeRecovery !== false,
        smtp: {
          host: (c.smtp?.host ?? o.smtp?.host ?? ''),
          port: Number(c.smtp?.port ?? o.smtp?.port ?? 465),
          secure: c.smtp?.secure ?? o.smtp?.secure ?? true,
          user: keep(c.smtp?.user, o.smtp?.user),
          pass: keep(c.smtp?.pass, o.smtp?.pass),
          from: (c.smtp?.from ?? o.smtp?.from ?? ''),
        },
        to: Array.isArray(c.to) ? c.to : (c.to ? String(c.to).split(/[,，;\s]+/).filter(Boolean) : []),
      };
      return ch;
    });
    this.cfg = {
      enabled: body.enabled !== false,
      consoleUrl: body.consoleUrl ?? this.cfg.consoleUrl ?? '',
      channels,
    };
    this.saveCfg();
  }

  // ---------- 对前端/接口的视图（敏感字段掩码） ----------
  publicView() {
    return {
      enabled: this.cfg.enabled,
      consoleUrl: this.cfg.consoleUrl || '',
      channels: this.cfg.channels.map(c => ({
        ...c,
        webhook: c.webhook ? maskUrl(c.webhook) : '',
        secret: c.secret ? mask(c.secret) : '',
        smtp: { ...c.smtp, pass: c.smtp.pass ? mask(c.smtp.pass) : '' },
        stats: c.stats || null,
      })),
      state: { open: Object.keys(this.state.open).length, baseline: this.state.baseline },
      stats: this.stats,
      log: this.log.slice(0, 50),
    };
  }

  // ---------- 路由判定 ----------
  _match(ch, ev) {
    if (SEV_NUM[ev.severity] < (SEV_NUM[ch.minSeverity] || 0)) return false;
    if (ch.domains?.length && !ch.domains.includes(ev.domain)) return false;
    if (ch.pattern) {
      try { if (!new RegExp(ch.pattern).test(ev.message || '')) return false; }
      catch { /* 非法正则放行，宁多发不漏发 */ }
    }
    return true;
  }

  // ---------- 消息构建（纯文本行，各通道渲染器各自加格式） ----------
  _buildMsg(kind, evs, nameOf) {
    const head = kind === 'trigger'
      ? `【告警】新增 ${evs.length} 条${evs.length > MAX_LINES ? `（仅列 ${MAX_LINES} 条）` : ''}`
      : `【恢复】恢复 ${evs.length} 条`;
    const ts = new Date().toLocaleString('zh-CN', { hour12: false });
    const lines = evs.slice(0, MAX_LINES).map(e => {
      const tag = `[${SEV_LABEL[e.severity] || e.severity}${e.domain ? '·' + (DOMAIN_LABEL[e.domain] || e.domain) : ''}]`;
      const who = nameOf(e);
      const t = new Date(e.clock).toLocaleString('zh-CN', { hour12: false });
      return `${tag} ${who ? who + ' — ' : ''}${e.message}\n  ${t}`;
    });
    const tail = this.cfg.consoleUrl ? `详情: ${this.cfg.consoleUrl}` : '';
    return { title: head, text: [head, `时间: ${ts}`, ...lines, tail].filter(Boolean).join('\n') };
  }

  // ---------- 各通道渲染 ----------
  _payload(ch, msg) {
    if (ch.type === 'dingtalk') {
      return { msgtype: 'text', text: { content: `${ch.keyword ? ch.keyword + '\n' : ''}${msg.text}` } };
    }
    if (ch.type === 'feishu') {
      return { msg_type: 'text', content: { text: msg.text } };
    }
    if (ch.type === 'wecom') {
      return { msgtype: 'text', text: { content: msg.text, mentioned_list: [] } };
    }
    return null; // email 走单独分支
  }

  _signUrl(ch) {
    let url = ch.webhook;
    if (ch.type === 'dingtalk' && ch.secret) {
      // 钉钉加签：timestamp + '\n' + secret 做 HmacSHA256 → base64 → urlEncode
      const ts = Date.now();
      const sign = crypto.createHmac('sha256', ch.secret).update(`${ts}\n${ch.secret}`).digest('base64');
      const u = new URL(url);
      u.searchParams.set('timestamp', String(ts));
      u.searchParams.set('sign', sign);
      url = u.toString();
    }
    if (ch.type === 'feishu' && ch.secret) {
      // 飞书加签：key = HmacSHA256(`${ts}\n${secret}`, '') 作密钥对空串签名
      const ts = Math.floor(Date.now() / 1000);
      const key = crypto.createHmac('sha256', `${ts}\n${ch.secret}`).update('').digest();
      const sign = crypto.createHmac('sha256', key).update('').digest('base64');
      const u = new URL(url);
      u.searchParams.set('timestamp', String(ts));
      u.searchParams.set('sign', sign);
      url = u.toString();
    }
    return url;
  }

  async _sendChannel(ch, msg) {
    if (ch.type === 'email') return this._sendEmail(ch, msg);
    if (!ch.webhook) throw new Error('未配置 webhook');
    return http(this._signUrl(ch), this._payload(ch, msg));
  }

  _transport(ch) {
    const key = `${ch.id}|${ch.smtp.host}|${ch.smtp.port}|${ch.smtp.user}`;
    let t = this._transports.get(key);
    if (!t) {
      t = nodemailer.createTransport({
        host: ch.smtp.host, port: ch.smtp.port, secure: !!ch.smtp.secure,
        auth: { user: ch.smtp.user, pass: ch.smtp.pass },
        connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
      });
      this._transports.set(key, t);
    }
    return t;
  }

  async _sendEmail(ch, msg) {
    if (!ch.smtp?.host || !ch.to?.length) throw new Error('未配置 SMTP 或收件人');
    await this._transport(ch).sendMail({
      from: ch.smtp.from || ch.smtp.user,
      to: ch.to.join(','),
      subject: msg.title,
      text: msg.text,
    });
    return { ok: true };
  }

  _logIt(ch, kind, n, ok, err) {
    const rec = { at: Date.now(), channel: ch.label, type: CH_TYPES[ch.type], kind, events: n, ok, error: err || null };
    this.log.unshift(rec);
    if (this.log.length > 100) this.log.length = 100;
    ch.stats = { sent: (ch.stats?.sent || 0) + (ok ? 1 : 0), fail: (ch.stats?.fail || 0) + (ok ? 0 : 1), lastAt: rec.at, lastError: err || null };
    if (ok) { this.stats.sent++; this.stats.lastOk = rec.at; }
    else { this.stats.fail++; this.stats.lastErr = rec.at; console.warn(`[notify] ${ch.label} 发送失败:`, err); }
  }

  // ---------- 主入口：每轮 sync 后调用 ----------
  // events: 当前活动 problem（collector 结构）；nameOf: event→主机名
  async diffAndSend(events, nameOf = () => '') {
    if (this._busy) return { skipped: 'busy' };
    this._busy = true;
    try {
      if (!this.cfg.enabled || !this.cfg.channels.some(c => c.enabled)) return { skipped: 'disabled' };
      const now = Date.now();
      const openNew = {};           // 本轮活动全集（重写）
      const trig = [], rec = [];
      for (const e of events) {
        const id = String(e.eventid);
        openNew[id] = { severity: e.severity, message: e.message, clock: e.clock, domain: e.domain };
        // 上轮不在活动集且从未通知过恢复 → 视为新告警；
        // 已恢复过又原样重开的同一 eventid 不重复打扰（Zabbix 重开通常生成新 eventid）
        if (!this.state.open[id] && !this.state.closed[id]) trig.push(e);
      }
      // 恢复差分：上轮活动、本轮不在 → 恢复
      for (const [id, snap] of Object.entries(this.state.open)) {
        if (!openNew[id]) {
          this.state.closed[id] = { ...snap, rt: now, noticeSent: true };
          rec.push({ eventid: id, ...snap });
        }
      }
      const firstRun = !this.state.baseline;
      this.state.open = openNew;
      this.state.baseline = true;
      this._saveState();
      if (firstRun) return { baseline: true, open: Object.keys(openNew).length };

      const results = [];
      for (const ch of this.cfg.channels) {
        if (!ch.enabled) continue;
        const t = trig.filter(e => this._match(ch, e));
        const r = ch.includeRecovery ? rec.filter(e => this._match(ch, e)) : [];
        if (!t.length && !r.length) continue;
        try {
          if (t.length) { const m = this._buildMsg('trigger', t.filter(e => this._match(ch, e)), nameOf); await this._sendChannel(ch, m); this._logIt(ch, 'trigger', t.length, true); results.push({ ch: ch.label, kind: 'trigger', n: t.length, ok: true }); }
          if (r.length) { const m = this._buildMsg('recovery', r, () => ''); await this._sendChannel(ch, m); this._logIt(ch, 'recovery', r.length, true); results.push({ ch: ch.label, kind: 'recovery', n: r.length, ok: true }); }
        } catch (e) {
          this._logIt(ch, 'trigger', t.length || r.length, false, String(e.message || e));
          results.push({ ch: ch.label, kind: 'mixed', ok: false, error: String(e.message || e) });
        }
      }
      return { results, trig: trig.length, rec: rec.length };
    } finally { this._busy = false; }
  }

  // ---------- 测试发送（配置页"测试"按钮） ----------
  async testChannel(id) {
    const ch = this.cfg.channels.find(c => c.id === id);
    if (!ch) throw new Error('通道不存在');
    const msg = {
      title: '【测试】IT运维监控平台告警出口',
      text: `【测试】IT运维监控平台告警出口连通性验证\n通道: ${ch.label}（${CH_TYPES[ch.type]}）\n时间: ${new Date().toLocaleString('zh-CN', { hour12: false })}\n收到本条即表示该出口配置正确。`,
    };
    try {
      await this._sendChannel(ch, msg);
      this._logIt(ch, 'test', 1, true);
      return { ok: true };
    } catch (e) {
      this._logIt(ch, 'test', 1, false, String(e.message || e));
      throw e;
    }
  }
}
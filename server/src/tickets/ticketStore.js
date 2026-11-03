// ============================================================
// 工单存储（个人工作台）
// 流程：录入（确认人姓名/邮箱必填，电话选填）→ pending 待确认
//       → 邮件给确认人（含 token 确认链接，走全局「邮件服务」SMTP 配置，系统管理维护）
//       → 确认人点开链接确认 → confirmed 工单结束
// 数据：data/tickets.json（含确认人个人信息，.gitignore 不入库）
// 红线：邮件发送结果如实记录（失败置 mailLog.error，绝不假称已送达）
// ============================================================
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const readJson = (f, dft) => { try { return JSON.parse(fs.readFileSync(f, 'utf-8')); } catch { return dft; } };
function writeJson(f, obj) {
  const t = f + '.tmp';
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(t, JSON.stringify(obj, null, 2));
  fs.renameSync(t, f);
}

export const TK_STATUS = { pending: '待确认', confirmed: '已结束', cancelled: '已取消' };

export class TicketStore {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'tickets.json');
    this.data = readJson(this.file, { seq: {}, tickets: [] });
  }
  _save() { writeJson(this.file, this.data); }

  /** 流水号 TK-YYYYMMDD-NNN（按天递增） */
  _no() {
    const d = new Date();
    const key = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    this.data.seq[key] = (this.data.seq[key] || 0) + 1;
    return `TK-${key}-${String(this.data.seq[key]).padStart(3, '0')}`;
  }

  create({ title, content, confirmer, priority = 'normal', createBy = '' }) {
    const t0 = String(title || '').trim();
    const c0 = String(content || '').trim();
    const name = String(confirmer?.name || '').trim();
    const email = String(confirmer?.email || '').trim().toLowerCase();
    const phone = String(confirmer?.phone || '').trim();
    if (!t0) return { ok: false, error: '工单标题必填' };
    if (!c0) return { ok: false, error: '工单内容必填' };
    if (!name) return { ok: false, error: '确认人姓名必填' };
    if (!EMAIL_RE.test(email)) return { ok: false, error: '确认人邮箱格式不正确' };
    if (phone && !/^[0-9+\-() 　]{5,20}$/.test(phone)) return { ok: false, error: '电话号码格式不正确（可留空）' };
    const now = Date.now();
    const t = {
      id: 'tk_' + crypto.randomBytes(6).toString('hex'),
      no: this._no(),
      title: t0.slice(0, 200),
      content: c0.slice(0, 5000),
      priority: ['low', 'normal', 'high'].includes(priority) ? priority : 'normal',
      confirmer: { name, email, phone },
      status: 'pending',
      createBy,
      createdAt: now,
      updatedAt: now,
      confirmToken: crypto.randomBytes(24).toString('hex'), // 一次性：确认/取消后作废
      confirmedAt: null,
      confirmedBy: null,
      mailLog: [],   // { at, ok, error } —— 每次发送如实记录
      events: [{ at: now, by: createBy, action: 'created' }],
    };
    this.data.tickets.push(t);
    this._save();
    return { ok: true, ticket: t };
  }

  get(id) { return this.data.tickets.find(t => t.id === id) || null; }
  getByToken(token) { return token ? this.data.tickets.find(t => t.confirmToken === token) || null : null; }

  /** 列表：status 过滤 + q 模糊（单号/标题/确认人），按创建时间倒序分页 */
  list({ status, q, page = 1, size = 20 } = {}) {
    let arr = [...this.data.tickets].sort((a, b) => b.createdAt - a.createdAt);
    const stats = { total: arr.length, pending: 0, confirmed: 0, cancelled: 0, mailFail: 0 };
    for (const t of arr) {
      stats[t.status] = (stats[t.status] || 0) + 1;
      if (t.status === 'pending' && t.mailLog.length && !t.mailLog[t.mailLog.length - 1].ok) stats.mailFail++;
    }
    if (status && TK_STATUS[status]) arr = arr.filter(t => t.status === status);
    if (q) {
      const s = String(q).toLowerCase();
      arr = arr.filter(t => t.no.toLowerCase().includes(s) || t.title.toLowerCase().includes(s)
        || t.confirmer.name.toLowerCase().includes(s) || t.confirmer.email.toLowerCase().includes(s));
    }
    const total = arr.length;
    const p = Math.max(1, Number(page) || 1);
    const sz = Math.min(100, Math.max(1, Number(size) || 20));
    return { data: arr.slice((p - 1) * sz, p * sz), total, stats };
  }

  /** 确认人凭 token 确认 → 工单结束（一次性，已确认/已取消/查不到均拒） */
  confirm(token) {
    const t = this.getByToken(token);
    if (!t) return { ok: false, error: '确认链接无效或已使用' };
    if (t.status !== 'pending') return { ok: false, error: `工单已是「${TK_STATUS[t.status]}」状态，无需确认`, ticket: { no: t.no, status: t.status } };
    const now = Date.now();
    t.status = 'confirmed';
    t.confirmedAt = now;
    t.confirmedBy = t.confirmer.email;
    t.confirmToken = null;
    t.updatedAt = now;
    t.events.push({ at: now, by: t.confirmer.email, action: 'confirmed-by-confirmer' });
    this._save();
    return { ok: true, ticket: t };
  }

  /** 创建人取消（仅 pending 可取消） */
  cancel(id, by = '') {
    const t = this.get(id);
    if (!t) return { ok: false, error: '工单不存在' };
    if (t.status !== 'pending') return { ok: false, error: `仅「待确认」工单可取消（当前：${TK_STATUS[t.status]}）` };
    const now = Date.now();
    t.status = 'cancelled';
    t.confirmToken = null;
    t.updatedAt = now;
    t.events.push({ at: now, by, action: 'cancelled' });
    this._save();
    return { ok: true, ticket: t };
  }

  /** 重发确认邮件：换发新 token（旧链接作废）；调用方负责实际发信并 recordMail */
  rotateToken(id) {
    const t = this.get(id);
    if (!t) return { ok: false, error: '工单不存在' };
    if (t.status !== 'pending') return { ok: false, error: `工单已是「${TK_STATUS[t.status]}」状态` };
    t.confirmToken = crypto.randomBytes(24).toString('hex');
    t.updatedAt = Date.now();
    t.events.push({ at: t.updatedAt, action: 'token-rotated' });
    this._save();
    return { ok: true, ticket: t };
  }

  /** 邮件发送结果落账（成功/失败都记录，失败不翻转工单状态——可在界面重发） */
  recordMail(id, ok, error = null) {
    const t = this.get(id);
    if (!t) return null;
    t.mailLog.push({ at: Date.now(), ok, error });
    if (t.mailLog.length > 20) t.mailLog.shift();
    t.updatedAt = Date.now();
    t.events.push({ at: t.updatedAt, action: ok ? 'mail-sent' : 'mail-failed', detail: error || undefined });
    this._save();
    return t;
  }
}

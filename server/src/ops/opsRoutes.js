// /api/ops/* —— 经跳板机 MCP 的设备操作（第一期：交换机配置备份）
// 安全设计：
//  1) 命令不接受自由输入，只能选 TEMPLATES 里的模板 id（白名单再前置到 ITYW 侧）；
//  2) MCP token 只存 server/data/ops.json（不入库、接口只回 hasToken 不回明文）；
//  3) 备份全文含设备密文→只落磁盘文件；列表/预览一律 redact；全文下载需带 &raw=1 且再次脱敏由前端确认（此处 raw 输出仍脱敏，密文永不出接口——需要密文请直取服务器磁盘文件）；
//  4) 每次 exec 记录本地审计（含跳板机会话可关联的时间戳），跳板机侧另有 KoKo 录像。
import fs from 'fs';
import { fileURLToPath } from 'url';
import { JmsClient } from './jmsClient.js';
import { TEMPLATES, TEMPLATE_BY_ID, redact, cleanPaging, diffLines, OpsStore } from './config.js';

// 跨平台 fileURLToPath（Windows 下 .pathname 会带盘符前导斜杠）
const p = sub => fileURLToPath(new URL(sub, import.meta.url));

export function mountOps(app, { notifier }) {
  const store = new OpsStore({
    cfgFile: p('../../data/ops.json'),
    backupDir: p('../../data/backups/'),
  });
  // 配置热加载：保存后重建 client
  let jms = new JmsClient(store.cfg);
  const assetCache = { at: 0, data: null }; // 资产列表缓存 5 分钟，避免前端频繁打跳板机

  const reload = () => { jms = new JmsClient(store.cfg); };

  // ---------- 连接配置 ----------
  app.get('/api/ops/config', (req, res) => {
    res.json({ ...store.publicCfg(), templates: TEMPLATES.filter(t => !t.disabled), backupCount: store.index.items.length });
  });

  app.post('/api/ops/config/save', (req, res) => {
    const b = req.body || {};
    const patch = {};
    if (typeof b.enabled === 'boolean') patch.enabled = b.enabled;
    if (typeof b.mcpUrl === 'string') patch.mcpUrl = b.mcpUrl.trim();
    // token 掩码回填：带 • 或空表示不修改
    if (typeof b.token === 'string' && b.token && !/•/.test(b.token)) patch.token = b.token.trim();
    store.saveCfg(patch);
    reload();
    res.json({ ok: true, ...store.publicCfg() });
  });

  app.post('/api/ops/config/test', async (req, res) => {
    try {
      const h = await jms.health();
      res.json({ ok: true, health: h });
    } catch (e) {
      res.status(502).json({ ok: false, error: String(e.message || e) });
    }
  });

  // ---------- 资产清单（跳板机纳管的设备，前端选目标用；/mcp 工具层同源复用） ----------
  async function fetchJmsAssets(search) {
    if (!jms.configured) throw Object.assign(new Error('跳板机 MCP 未配置'), { status: 400 });
    if (!search && assetCache.data && Date.now() - assetCache.at < 300000) return { cached: true, ...assetCache.data };
    const pages = [];
    let total = 0;
    for (let offset = 0; ; offset += 100) {
      const r = await jms.listAssets({ search, limit: 100, offset });
      total = r.count ?? total;
      pages.push(...(r.results || []));
      if (!r.results?.length || pages.length >= (r.count ?? 0)) break;
      if (offset > 1000) break; // 防御
    }
    const slim = pages.map(a => ({
      id: a.id, name: a.name, address: a.address,
      platform: a.platform?.name || '', category: a.category?.label || '',
      nodes: (a.nodes_display || [])[0] || '', accounts: a.accounts_amount ?? 0,
      protocols: (a.protocols || []).map(p => `${p.name}:${p.port}`).join(','),
    }));
    const data = { count: total, assets: slim };
    if (!search) { assetCache.at = Date.now(); assetCache.data = data; }
    return data;
  }

  app.get('/api/ops/assets', async (req, res) => {
    try {
      res.json(await fetchJmsAssets(String(req.query.search || '')));
    } catch (e) {
      res.status(e.status || 502).json({ error: String(e.message || e) });
    }
  });

  // ---------- 执行命令模板（备份=备份类模板，其余=巡检） ----------
  const inFlight = new Set(); // 同一目标并发防抖：backup 按钮连点不重复入库
  async function runTpl({ asset, tpl, account = '' }) {
    const t = TEMPLATE_BY_ID[tpl];
    if (!t || t.disabled) throw Object.assign(new Error(`命令模板不存在或已禁用: ${tpl}`), { status: 400 });
    if (!asset) throw Object.assign(new Error('缺少目标资产（name 或 address）'), { status: 400 });
    const started = Date.now();
    const r = await jms.exec({ asset, command: t.command, account: String(account) });
    if (r.ok === false) throw Object.assign(new Error(r.error || '跳板机执行失败'), { status: 502 });
    const out = r.output || '';
    let rec = null;
    if (t.backup) {
      rec = store.addBackup({
        // assetKey 用调用方传入的检索值（设备列表一键备份时=IP），保证监控侧可按 IP 匹配
        assetKey: String(asset), assetName: String(r.asset || asset), address: String(r.asset || asset),
        tpl: t.id, command: t.command, raw: out,
      });
      // 配置变更→推告警出口（复用现有通道，全文不外发只发摘要）
      if (rec.changed && rec.prevSha1) {
        notifier.sendAdhoc(
          `【配置变更】${rec.assetName}`,
          `设备 ${rec.assetName} 配置指纹变化（经跳板机备份发现）\n时间: ${new Date(rec.at).toLocaleString('zh-CN', { hour12: false })}\n命令: ${rec.command}\n新指纹: ${rec.sha1.slice(0, 12)}（上一条 ${String(rec.prevSha1).slice(0, 12)}）`
        ).catch(() => {});
      }
    }
    return {
      ok: true, asset: r.asset, account: r.account, command: t.command,
      elapsedMs: Date.now() - started,
      truncated: !!r.truncated, note: r.note || '',
      bytes: Buffer.byteLength(out),
      outputRedacted: redact(cleanPaging(out)),   // 展示层：清洗分页残渣 + 脱敏
      backup: rec ? { id: rec.id, changed: rec.changed, sha1: rec.sha1, prevSha1: rec.prevSha1, bytes: rec.bytes } : null,
    };
  }

  app.post('/api/ops/exec', async (req, res) => {
    if (!jms.configured) return res.status(400).json({ error: '跳板机 MCP 未配置' });
    try {
      res.json(await runTpl(req.body || {}));
    } catch (e) {
      res.status(e.status || 502).json({ ok: false, error: String(e.message || e) });
    }
  });

  // ---------- 一键配置备份（设备列表备份按钮）：目标=IP/名称，模板固定为配置备份 ----------
  app.post('/api/ops/backup', async (req, res) => {
    if (!jms.configured) return res.status(400).json({ error: '跳板机 MCP 未配置' });
    const { asset = '', tpl = 'cfg-huawei' } = req.body || {};
    if (!asset) return res.status(400).json({ error: '缺少目标设备（IP 或名称）' });
    const bt = TEMPLATE_BY_ID[tpl];
    if (!bt || bt.disabled || !bt.backup) return res.status(400).json({ error: '模板不是可用的备份模板' });
    if (inFlight.has(String(asset))) return res.status(409).json({ error: '该设备备份正在进行中' });
    inFlight.add(String(asset));
    try {
      res.json(await runTpl({ asset, tpl }));
    } catch (e) {
      res.status(e.status || 502).json({ ok: false, error: String(e.message || e) });
    } finally {
      inFlight.delete(String(asset));
    }
  });

  // ---------- 备份历史 ----------
  app.get('/api/ops/backups', (req, res) => {
    const assetKey = String(req.query.assetKey || '');
    const limit = Math.min(200, Number(req.query.limit || 50));
    res.json({ items: store.list({ assetKey, limit }) });
  });

  // 每台设备最新备份摘要（设备列表备份按钮旁展示"最近备份 x 前"；须先于 /:id 注册）
  app.get('/api/ops/backups/meta', (req, res) => {
    const byAsset = {};
    for (const x of store.index.items) {
      if (!byAsset[x.assetKey]) byAsset[x.assetKey] = { at: x.at, id: x.id, sha1: x.sha1, bytes: x.bytes, changed: x.changed };
    }
    res.json({ byAsset });
  });

  // 单条备份脱敏全文（配置密文永不通过接口出磁盘）
  app.get('/api/ops/backups/:id', (req, res) => {
    const rec = store.get(req.params.id);
    if (!rec) return res.status(404).json({ error: 'not found' });
    try {
      const text = fs.readFileSync(rec.file, 'utf-8');
      res.json({ meta: rec, textRedacted: redact(text) });
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  // 两份备份差异比对（行级 LCS diff，逐行脱敏后出接口；na/nb=各自行号）
  app.get('/api/ops/diff', (req, res) => {
    const ra = store.get(String(req.query.a || ''));
    const rb = store.get(String(req.query.b || ''));
    if (!ra || !rb) return res.status(404).json({ error: '备份记录不存在' });
    let ta, tb;
    try {
      ta = fs.readFileSync(ra.file, 'utf-8');
      tb = fs.readFileSync(rb.file, 'utf-8');
    } catch (e) { return res.status(500).json({ error: String(e.message || e) }); }
    const d = diffLines(ta, tb);
    res.json({
      a: { id: ra.id, at: ra.at, assetName: ra.assetName, bytes: ra.bytes, sha1: ra.sha1 },
      b: { id: rb.id, at: rb.at, assetName: rb.assetName, bytes: rb.bytes, sha1: rb.sha1 },
      same: ra.sha1 === rb.sha1,
      added: d.added, removed: d.removed, truncated: d.truncated,
      lines: d.lines.map(x => ({ ...x, l: redact(x.l) })),
    });
  });

  // 相邻两次备份的指纹对比（哪些设备配置在变）
  app.get('/api/ops/changes', (req, res) => {
    const changed = store.index.items.filter(x => x.changed).slice(0, Number(req.query.limit || 50));
    res.json({ items: changed });
  });

  // 跳板机会话审计（透传，供合规查看录像入口在跳板机 UI）
  app.get('/api/ops/sessions', async (req, res) => {
    if (!jms.configured) return res.status(400).json({ error: '跳板机 MCP 未配置' });
    try {
      const r = await jms.listSessions({ asset: String(req.query.asset || ''), limit: Math.min(100, Number(req.query.limit || 20)) });
      res.json(r);
    } catch (e) { res.status(502).json({ error: String(e.message || e) }); }
  });

  // 内部句柄：供 /mcp 工具层直接复用（同一进程内调用，不绕 HTTP；安全口径与路由一致）
  return {
    jmsConfigured: () => jms.configured,
    jmsAssets: (search = '') => fetchJmsAssets(String(search || '')),
    list: ({ assetKey, limit }) => store.list({ assetKey, limit }),
    meta: () => {
      const byAsset = {};
      for (const x of store.index.items) {
        if (!byAsset[x.assetKey]) byAsset[x.assetKey] = { at: x.at, id: x.id, sha1: x.sha1, bytes: x.bytes, changed: x.changed };
      }
      return { byAsset };
    },
    diff: (aId, bId) => {
      const ra = store.get(aId), rb = store.get(bId);
      if (!ra || !rb) return { ok: false, error: '备份记录不存在' };
      try {
        const d = diffLines(fs.readFileSync(ra.file, 'utf-8'), fs.readFileSync(rb.file, 'utf-8'));
        return { ok: true, a: ra, b: rb, same: ra.sha1 === rb.sha1, added: d.added, removed: d.removed, truncated: d.truncated, lines: d.lines };
      } catch (e) { return { ok: false, error: String(e.message || e) }; }
    },
    async backup(asset) {
      if (!jms.configured) throw new Error('跳板机 MCP 未配置');
      if (!asset) throw new Error('缺少目标设备（IP 或名称）');
      if (inFlight.has(String(asset))) throw new Error('该设备备份正在进行中');
      inFlight.add(String(asset));
      try {
        return await runTpl({ asset, tpl: 'cfg-huawei' });
      } finally {
        inFlight.delete(String(asset));
      }
    },
  };
}

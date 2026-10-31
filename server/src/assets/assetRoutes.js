// 资产管理 API：台账 CRUD + 凭据（加密存储）。
// 红线：所有响应永不含密码（enc 或明文）；明文仅 /cred/reveal 且必审计。
export function mountAssets(app, { store, mergedData }) {
  app.get('/api/assets/stats', (req, res) => res.json(store.stats()));

  app.get('/api/assets', (req, res) => {
    res.json(store.list({ type: req.query.type, q: req.query.q, page: req.query.page, size: req.query.size }));
  });

  app.get('/api/assets/:id', (req, res) => {
    const v = store.get(req.params.id);
    if (!v) return res.status(404).json({ error: '资产不存在' });
    res.json(v);
  });

  app.post('/api/assets/save', (req, res) => {
    const r = store.save(req.body || {});
    if (r.error) return res.status(400).json(r);
    res.json(r);
  });

  app.post('/api/assets/delete', (req, res) => {
    const r = store.remove(req.body?.id);
    if (r.error) return res.status(400).json(r);
    res.json(r);
  });

  app.post('/api/assets/cred/delete', (req, res) => {
    const r = store.deleteCred(req.body?.assetId, req.body?.credId);
    if (r.error) return res.status(400).json(r);
    res.json(r);
  });

  // 查看凭据明文：显式操作 + 服务端审计（asset_audit.jsonl）
  app.post('/api/assets/cred/reveal', (req, res) => {
    const r = store.revealCred(req.body?.assetId, req.body?.credId);
    if (r.error) return res.status(400).json(r);
    res.json(r);
  });

  // 一键导入监控面资产（Zabbix + dbmp 实体），按 IP 去重
  app.post('/api/assets/import-monitor', (req, res) => {
    const ds = mergedData();
    if (!ds) return res.status(503).json({ error: 'collector syncing, retry' });
    const entities = ds.hosts.map(h => ({
      hostid: h.hostid, name: h.name, ip: h.ip, domain: h.domain, label: h.label, model: h.model, os: h.os,
    }));
    res.json(store.importFromMonitor(entities));
  });
}

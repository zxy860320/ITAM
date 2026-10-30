import React from 'react';
import { api } from '../api';
import { fmtTime } from '../components/common';
import { DiffView } from '../components/BackupPanel';

/** 设备操作页：经跳板机（JumpServer MCP）对纳管设备执行白名单命令模板。
 *  第一期：交换机配置备份（只读抓取配置全文→入库→指纹变更检测→告警出口推送）。
 *  红线：命令只能从服务端模板白名单选择；输出接口侧已脱敏（密文不出跳板机审计之外）。 */

export default function OpsPage() {
  const [cfg, setCfg] = React.useState<any>(null);
  const [form, setForm] = React.useState({ enabled: false, mcpUrl: '', token: '' });
  const [msg, setMsg] = React.useState<any>(null);
  const [testing, setTesting] = React.useState<string>('');

  const [assets, setAssets] = React.useState<any[] | null>(null);
  const [assetErr, setAssetErr] = React.useState('');
  const [q, setQ] = React.useState('');
  const [picked, setPicked] = React.useState<any>(null);
  const [tpl, setTpl] = React.useState('cfg-huawei');
  const [running, setRunning] = React.useState(false);
  const [result, setResult] = React.useState<any>(null);

  const [backups, setBackups] = React.useState<any[]>([]);
  const [detail, setDetail] = React.useState<any>(null);
  const [bkPicked, setBkPicked] = React.useState<string[]>([]);
  const [diff, setDiff] = React.useState<any>(null);

  const load = React.useCallback(() => {
    api.opsConfig().then(d => {
      setCfg(d);
      setForm(f => ({ ...f, enabled: d.enabled, mcpUrl: d.mcpUrl || '', token: '' }));
    }).catch(() => {});
    api.opsBackups({ limit: 50 }).then(d => setBackups(d.items || [])).catch(() => {});
  }, []);
  React.useEffect(() => { load(); }, [load]);

  const loadAssets = React.useCallback((search: string) => {
    setAssets(null); setAssetErr('');
    api.opsAssets({ search }).then(d => setAssets(d.assets || [])).catch(e => setAssetErr(String(e.message || e)));
  }, []);
  React.useEffect(() => {
    if (cfg?.enabled && assets === null && !assetErr && !q) loadAssets('');
  }, [cfg]);

  async function save() {
    setMsg(null);
    try {
      const r = await api.opsConfigSave(form);
      setMsg({ ok: true, text: '已保存' });
      load();
      if (r.hasToken) loadAssets(q);
    } catch (e: any) { setMsg({ ok: false, text: String(e.message || e) }); }
  }
  async function testConn() {
    setTesting('连接中…');
    try {
      const r = await api.opsConfigTest();
      setTesting(`✔ 跳板机在线（用户 ${r.health?.user?.username || '?'}${r.health?.user?.is_superuser ? ' · 超管' : ''}）`);
    } catch (e: any) { setTesting(`✘ ${String(e.message || e).slice(0, 120)}`); }
  }
  async function run() {
    if (!picked) return;
    setRunning(true); setResult(null);
    try {
      const r = await api.opsExec({ asset: picked.address || picked.name, tpl });
      setResult(r);
      api.opsBackups({ limit: 50 }).then(d => setBackups(d.items || [])).catch(() => {});
    } catch (e: any) {
      setResult({ ok: false, error: String(e.message || e) });
    }
    setRunning(false);
  }
  async function openBackup(id: string) {
    setDetail({ loading: true } as any);
    try { setDetail(await api.opsBackup(id)); }
    catch (e: any) { setDetail({ error: String(e.message || e) }); }
  }
  function toggleBk(id: string) {
    setBkPicked(p => p.includes(id) ? p.filter(x => x !== id) : [...p, id].slice(-2));
  }
  async function comparePicked() {
    if (bkPicked.length !== 2) return;
    setDiff({ loading: true });
    try { setDiff(await api.opsDiff(bkPicked[0], bkPicked[1])); }
    catch (e: any) { setDiff({ error: String(e.message || e) }); }
  }

  if (!cfg) return <div style={{ color: 'var(--text-3)' }}>加载中…</div>;

  const netAssets = (assets || []).filter(a => a.category === '网络设备' || /Huawei|H3C|Cisco/i.test(a.platform));
  const filtered = q ? netAssets.filter(a => (a.name + a.address + a.platform).toLowerCase().includes(q.toLowerCase())) : netAssets;

  return (
    <div>
      {/* 跳板机连接 */}
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-title">跳板机连接（JumpServer MCP）
          <span className="spacer" />
          <span className={`badge ${cfg.enabled ? 'healthy' : 'info'}`}><span className="bdot" />{cfg.enabled ? '已启用' : '未启用'}</span>
          <span className="badge info"><span className="bdot" />备份 {cfg.backupCount} 份</span>
        </div>
        <div className="grid-2">
          <div className="field">
            <label>MCP 地址（streamable-http，如 http://10.25.6.5:8000/mcp）</label>
            <input value={form.mcpUrl} onChange={e => setForm({ ...form, mcpUrl: e.target.value })} placeholder="http://<jumpserver>:8000/mcp" />
          </div>
          <div className="field">
            <label>Bearer Token{cfg.hasToken ? '（已配置，留空不改）' : ''}</label>
            <input type="password" value={form.token} onChange={e => setForm({ ...form, token: e.target.value })} placeholder={cfg.hasToken ? '••••••••（保持不变）' : '跳板机 API token'} />
          </div>
        </div>
        <div className="toolbar" style={{ marginTop: 6, marginBottom: 0 }}>
          <label style={{ fontSize: 12, color: 'var(--text-2)', display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={form.enabled} onChange={e => setForm({ ...form, enabled: e.target.checked })} /> 启用设备操作
          </label>
          <button className="btn primary" onClick={save}>保存</button>
          <button className="btn" onClick={testConn} disabled={!cfg.enabled}>测试连接</button>
          {testing && <span style={{ fontSize: 12, color: 'var(--text-2)' }}>{testing}</span>}
          {msg && <span style={{ fontSize: 12, color: msg.ok ? 'var(--sev-healthy)' : 'var(--sev-critical)' }}>{msg.text}</span>}
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 8 }}>
          所有命令经跳板机 KoKo 代理执行（设备账号由跳板机托管，平台不经手设备凭据），全程留有 4A 会话审计与录像。
          命令只能从服务端白名单模板中选择；配置输出中的密码/密文在接口层脱敏，全文仅存平台服务器磁盘。
        </div>
      </div>

      {/* 命令执行 */}
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-title">命令执行 / 配置备份</div>
        <div className="toolbar">
          <input placeholder="搜索资产（IP/名称）" value={q} onChange={e => setQ(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') loadAssets(q); }} />
          <select style={{ width: 340 }} value={picked ? (picked.id || '') : ''} onChange={e => {
            setPicked(netAssets.find(a => a.id === e.target.value) || null);
          }}>
            <option value="">— 选择目标设备（{assets === null ? '加载中…' : `${filtered.length} 台网络设备`}）—</option>
            {filtered.map(a => <option key={a.id} value={a.id}>{a.address} · {a.name}{a.platform ? ` · ${a.platform}` : ''}</option>)}
          </select>
          <select value={tpl} onChange={e => setTpl(e.target.value)}>
            {(cfg.templates || []).map((t: any) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
          <button className="btn primary" onClick={run} disabled={!picked || running}>{running ? '执行中（经跳板机，约 10-60s）…' : '执行'}</button>
          {assetErr && <span style={{ fontSize: 12, color: 'var(--sev-critical)' }}>资产加载失败: {assetErr}</span>}
        </div>
        {result && (
          <div style={{ marginTop: 8 }}>
            {result.ok ? (
              <>
                <div style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 6 }}>
                  {result.asset} · 账号 {result.account || '(默认)'} · {result.elapsedMs} ms · {result.bytes} B
                  {result.backup && (
                    <> · 备份已入库 <span className="mono">{result.backup.sha1.slice(0, 12)}</span>
                      <span className={`badge ${result.backup.changed ? 'warning' : 'healthy'}`} style={{ marginLeft: 6 }}>
                        <span className="bdot" />{result.backup.changed ? (result.backup.prevSha1 == null && result.bytes ? '首次备份' : '配置有变更') : '与上份一致'}
                      </span>
                    </>
                  )}
                  {result.truncated && <span style={{ color: 'var(--sev-warning)', marginLeft: 8 }}>输出被截断</span>}
                </div>
                <pre className="mono" style={{ background: 'var(--bg-inset)', border: '1px solid var(--hairline)', borderRadius: 6, padding: 10, fontSize: 11.5, lineHeight: 1.5, maxHeight: 420, overflow: 'auto', whiteSpace: 'pre-wrap' }}>{result.outputRedacted}</pre>
              </>
            ) : (
              <div style={{ fontSize: 12, color: 'var(--sev-critical)' }}>✘ {result.error}</div>
            )}
          </div>
        )}
      </div>

      {/* 备份历史 */}
      <div className="card">
        <div className="card-title">配置备份历史<span className="spacer" />
          <span style={{ fontSize: 11, color: 'var(--text-3)' }}>变更 = 与同设备上一份指纹(sha1)不同；变更已推送告警出口</span>
        </div>
        <div className="toolbar" style={{ margin: '0 0 8px' }}>
          <button className="btn primary" style={{ padding: '4px 12px', fontSize: 11 }} onClick={comparePicked} disabled={bkPicked.length !== 2}>
            比对所选（{bkPicked.length}/2）
          </button>
          <span style={{ fontSize: 11, color: 'var(--text-3)' }}>勾选任意两份备份做行级差异比对（脱敏后展示）</span>
        </div>
        {diff && (
          <div style={{ marginBottom: 10 }}>
            {diff.loading && <div style={{ color: 'var(--text-3)', fontSize: 12 }}>比对中…</div>}
            {diff.error && <div style={{ color: 'var(--sev-critical)', fontSize: 12 }}>{diff.error}</div>}
            {diff.lines && <DiffView diff={diff} onClose={() => setDiff(null)} />}
          </div>
        )}
        <table className="data nowrap">
          <thead><tr>
            <th style={{ width: 30 }} />
            <th>时间</th><th>设备</th><th>命令</th><th className="num">字节</th><th>指纹</th><th>变更</th><th>操作</th>
          </tr></thead>
          <tbody>
            {backups.length === 0 && <tr><td colSpan={8} className="empty-tip">暂无备份记录——选择设备与"配置备份"模板执行一次</td></tr>}
            {backups.map(b => (
              <tr key={b.id}>
                <td><input type="checkbox" style={{ width: 'auto' }} checked={bkPicked.includes(b.id)} onChange={() => toggleBk(b.id)} /></td>
                <td className="mono">{fmtTime(b.at)}</td>
                <td>{b.assetName}</td>
                <td className="mono" style={{ fontSize: 11 }}>{b.command}</td>
                <td className="num mono">{b.bytes}</td>
                <td className="mono" style={{ fontSize: 11 }}>{b.sha1.slice(0, 12)}</td>
                <td>{b.changed ? <span className="badge warning"><span className="bdot" />变更</span> : <span className="badge healthy"><span className="bdot" />一致</span>}</td>
                <td><button className="btn" style={{ padding: '4px 10px', fontSize: 11 }} onClick={() => openBackup(b.id)}>查看</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 备份全文（脱敏）弹层 */}
      {detail && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 90 }}
          onClick={() => setDetail(null)}>
          <div className="card" style={{ width: 'min(920px, 92vw)', maxHeight: '86vh', display: 'flex', flexDirection: 'column' }} onClick={e => e.stopPropagation()}>
            <div className="card-title">
              {detail.meta ? `${detail.meta.assetName} · ${fmtTime(detail.meta.at)} · ${detail.meta.bytes} B` : '备份详情'}
              <span className="spacer" />
              <span style={{ fontSize: 11, color: 'var(--text-3)' }}>密码/密文已脱敏</span>
              <button className="btn" style={{ padding: '4px 10px', fontSize: 11 }} onClick={() => setDetail(null)}>关闭</button>
            </div>
            {detail.loading && <div style={{ color: 'var(--text-3)' }}>加载中…</div>}
            {detail.error && <div style={{ color: 'var(--sev-critical)' }}>{detail.error}</div>}
            {detail.textRedacted != null && (
              <pre className="mono" style={{ background: 'var(--bg-inset)', border: '1px solid var(--hairline)', borderRadius: 6, padding: 10, fontSize: 11.5, lineHeight: 1.5, overflow: 'auto', whiteSpace: 'pre-wrap', flex: 1 }}>{detail.textRedacted}</pre>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

import React from 'react';
import { api } from '../api';
import { fmtTime, Pager } from '../components/common';

/** 资产管理页：资产台账（服务器/网络设备/虚拟机/数据库/电脑/办公/Web 服务）+ 资产凭据管理。
 *  安全红线：密码在服务端 AES-256-GCM 加密存储；页面任何列表/编辑态都不回显密码，
 *  明文只能通过「查看」按钮显式获取（服务端每次审计），15 秒后自动隐去。 */

const TYPES = [
  { key: '',        label: '全部' },
  { key: 'server',  label: '服务器' },
  { key: 'network', label: '网络设备' },
  { key: 'vm',      label: '虚拟机' },
  { key: 'database', label: '数据库' },
  { key: 'pc',      label: '电脑终端' },
  { key: 'office',  label: '办公软件' },
  { key: 'web',     label: 'Web 服务' },
  { key: 'other',   label: '其他' },
];
const TYPE_COLOR: Record<string, string> = {
  server: 'var(--dom-server)', network: 'var(--dom-network)', vm: '#8b5cf6', database: 'var(--dom-database)',
  pc: '#22D3EE', office: '#f472b6', web: 'var(--dom-service)', other: 'var(--text-3)',
};
const STATUS_LABEL: Record<string, string> = { inuse: '使用中', spare: '闲置', repair: '维修中', retired: '已下线' };

export default function AssetPage() {
  const [stats, setStats] = React.useState<any>(null);
  const [rows, setRows] = React.useState<any[]>([]);
  const [total, setTotal] = React.useState(0);
  const [page, setPage] = React.useState(1);
  const [type, setType] = React.useState('');
  const [q, setQ] = React.useState('');
  const [qDeb, setQDeb] = React.useState('');
  const [err, setErr] = React.useState('');
  const [editing, setEditing] = React.useState<any>(null);   // 编辑弹窗（asset 对象或新建默认）
  const [credOf, setCredOf] = React.useState<any>(null);     // 凭据抽屉的资产（详情对象）
  const [importing, setImporting] = React.useState(false);
  const size = 20;

  React.useEffect(() => {
    const t = setTimeout(() => setQDeb(q), 300);
    return () => clearTimeout(t);
  }, [q]);
  React.useEffect(() => { setPage(1); }, [type, qDeb]);

  const reload = React.useCallback(() => {
    api.assets({ type, q: qDeb, page, size }).then(d => { setRows(d.rows || []); setTotal(d.total || 0); setErr(''); })
      .catch(e => setErr(String(e.message || e)));
    api.assetsStats().then(setStats).catch(() => {});
  }, [type, qDeb, page]);
  React.useEffect(() => { reload(); }, [reload]);

  async function del(id: string, name: string) {
    if (!window.confirm(`确认删除资产「${name}」？其下所有凭据一并删除。`)) return;
    try { await api.assetDelete(id); reload(); } catch (e: any) { alert(String(e.message || e)); }
  }
  async function doImport() {
    if (!window.confirm('从监控面（Zabbix/zCloud 实时实体）导入资产？按 IP 去重，不会覆盖已有台账与凭据。')) return;
    setImporting(true);
    try {
      const r = await api.assetsImportMonitor();
      alert(`导入完成：新增 ${r.added} · 补监控关联 ${r.updated} · 跳过（已存在/无IP） ${r.skipped}`);
      reload();
    } catch (e: any) { alert(String(e.message || e)); }
    setImporting(false);
  }

  return (
    <div>
      <div className="stat-row" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
        <div className="card"><div className="stat-num">{stats?.total ?? '—'}</div><div className="stat-label">资产总数</div></div>
        <div className="card"><div className="stat-num">{stats?.creds ?? '—'}</div><div className="stat-label">托管凭据（加密存储）</div></div>
        <div className="card" style={{ gridColumn: 'span 2' }}>
          <div className="card-title">类别分布</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px', fontSize: 12, color: 'var(--text-2)' }}>
            {(stats?.types || []).map((t: any) => (
              <span key={t.key}><i className="dom-dot" style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: TYPE_COLOR[t.key], marginRight: 5 }} />{t.label} {stats?.byType?.[t.key] || 0}</span>
            ))}
          </div>
        </div>
      </div>

      <div className="toolbar">
        <div className="seg">
          {TYPES.map(t => (
            <button key={t.key} className={type === t.key ? 'on' : ''} onClick={() => setType(t.key)}>{t.label}</button>
          ))}
        </div>
        <input placeholder="搜索 名称 / IP / 型号 / 负责人 / SN / 位置" value={q} onChange={e => setQ(e.target.value)} />
        <span className="spacer" style={{ flex: 1 }} />
        <button className="btn" onClick={doImport} disabled={importing}>{importing ? '导入中…' : '导入监控资产'}</button>
        <button className="btn" style={{ borderColor: 'var(--dom-network)', color: 'var(--dom-network)' }}
          onClick={() => setEditing({ name: '', type: type || 'server', ip: '', model: '', os: '', sn: '', location: '', owner: '', env: '', status: 'inuse', remark: '', creds: [] })}>
          + 新增资产
        </button>
      </div>

      <div className="card" style={{ padding: '6px 14px 12px' }}>
        {err && <div className="badge critical" style={{ margin: '8px 0' }}>{err}</div>}
        <table className="data nowrap">
          <thead>
            <tr>
              <th>名称</th><th>类别</th><th>IP</th><th>型号 / 系统</th><th>位置</th><th>负责人</th><th>环境</th><th>状态</th>
              <th className="num">凭据</th><th>更新时间</th><th style={{ width: 150 }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && <tr><td className="empty-tip" colSpan={11}>暂无资产——点「+ 新增资产」手工登记，或「导入监控资产」从 Zabbix/zCloud 一键带入</td></tr>}
            {rows.map(a => (
              <tr key={a.id}>
                <td style={{ fontWeight: 500 }}>{a.name}{a.monitorHostid && <span className="badge info" style={{ marginLeft: 6 }}>已纳管</span>}</td>
                <td><span style={{ color: TYPE_COLOR[a.type] }}>{a.typeLabel}</span></td>
                <td className="mono">{a.ip || '—'}</td>
                <td style={{ color: 'var(--text-2)' }}>{[a.model, a.os].filter(Boolean).join(' · ') || '—'}</td>
                <td>{a.location || '—'}</td>
                <td>{a.owner || '—'}</td>
                <td>{a.env || '—'}</td>
                <td>{STATUS_LABEL[a.status] || a.status}</td>
                <td className="num">
                  {a.credCount > 0
                    ? <a style={{ color: 'var(--dom-network)', cursor: 'pointer' }} onClick={() => openCred(a.id)}>{a.credCount} 条</a>
                    : <span style={{ color: 'var(--text-3)' }}>0</span>}
                </td>
                <td className="mono" style={{ color: 'var(--text-3)' }}>{a.updatedAt ? fmtTime(a.updatedAt) : '—'}</td>
                <td>
                  <button className="btn" onClick={() => openCred(a.id)}>凭据</button>{' '}
                  <button className="btn" onClick={() => editAsset(a.id)}>编辑</button>{' '}
                  <button className="btn" style={{ color: 'var(--sev-critical)' }} onClick={() => del(a.id, a.name)}>删除</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="table-foot">
          共 {total} 条
          <span style={{ flex: 1 }} />
          <Pager page={page} size={size} total={total} onPage={setPage} />
        </div>
      </div>

      <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 10 }}>
        凭据（账号/密码）在服务端 AES-256-GCM 加密存储，接口永不返回密文与明文；「查看」明文每次操作均记录审计（server/data/asset_audit.jsonl）。
        生产建议设 ITYW_CRED_KEY 环境变量固定密钥。
      </div>

      {editing && <AssetEditor asset={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />}
      {credOf && <CredDrawer asset={credOf} onClose={() => setCredOf(null)} onChanged={reload}
        onEditAsset={() => { const a = credOf; setCredOf(null); setEditing(a); }} />}
    </div>
  );

  async function openCred(id: string) {
    try { setCredOf(await api.asset(id)); } catch (e: any) { alert(String(e.message || e)); }
  }
  async function editAsset(id: string) {
    try { setEditing(await api.asset(id)); } catch (e: any) { alert(String(e.message || e)); }
  }
}

/* ---------------- 资产编辑弹窗（含凭据行编辑：密码只在新增/重置时输入，永不回显） ---------------- */
function AssetEditor({ asset, onClose, onSaved }: { asset: any; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = React.useState({
    id: asset.id, name: asset.name || '', type: asset.type || 'server', ip: asset.ip || '', model: asset.model || '',
    os: asset.os || '', sn: asset.sn || '', location: asset.location || '', owner: asset.owner || '',
    env: asset.env || '', status: asset.status || 'inuse', remark: asset.remark || '', monitorHostid: asset.monitorHostid || '',
  });
  // 凭据编辑行：已有凭据带 id（密码留空=不修改）；新行无 id
  const [creds, setCreds] = React.useState<any[]>((asset.creds || []).map((c: any) => ({ id: c.id, label: c.label, username: c.username, note: c.note, password: '', keep: true })));
  const [saving, setSaving] = React.useState(false);
  const [msg, setMsg] = React.useState('');
  const set = (k: string, v: string) => setF(x => ({ ...x, [k]: v }));

  async function save() {
    if (!f.name.trim()) { setMsg('资产名称必填'); return; }
    setSaving(true); setMsg('');
    try {
      await api.assetSave({ ...f, creds: creds.map(c => ({ id: c.id, label: c.label, username: c.username, note: c.note, password: c.password })) });
      onSaved();
    } catch (e: any) { setMsg(String(e.message || e)); }
    setSaving(false);
  }

  const inp = (k: string, label: string, ph = '') => (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--text-2)' }}>
      {label}
      <input className="ainp" value={(f as any)[k] || ''} placeholder={ph} onChange={e => set(k, e.target.value)} />
    </label>
  );

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)', zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div onClick={e => e.stopPropagation()} className="card" style={{ width: 'min(760px, 94vw)', maxHeight: '88vh', overflowY: 'auto' }}>
        <div className="card-title">{asset.id ? `编辑资产 · ${asset.name}` : '新增资产'}<span className="spacer" />
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn" style={{ borderColor: 'var(--dom-network)', color: 'var(--dom-network)', marginLeft: 6 }} onClick={save} disabled={saving}>{saving ? '保存中…' : '保存'}</button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 12 }}>
          {inp('name', '名称 *', '如 web-prod-01')}
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--text-2)' }}>类别
            <select className="ainp" value={f.type} onChange={e => set('type', e.target.value)}>
              {TYPES.filter(t => t.key).map(t => <option key={t.key} value={t.key}>{t.label}</option>)}
            </select>
          </label>
          {inp('ip', 'IP 地址', '10.x.x.x')}
          {inp('model', '型号', '如 RH2288 V5')}
          {inp('os', '系统 / 版本', '如 CentOS 7.9')}
          {inp('sn', '序列号 SN')}
          {inp('location', '位置', '如 IDC-A机柜3')}
          {inp('owner', '负责人')}
          {inp('env', '环境', '生产/测试')}
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--text-2)' }}>状态
            <select className="ainp" value={f.status} onChange={e => set('status', e.target.value)}>
              {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--text-2)', gridColumn: 'span 2' }}>备注
            <input className="ainp" value={f.remark} onChange={e => set('remark', e.target.value)} />
          </label>
        </div>

        <div className="card-title" style={{ marginTop: 6 }}>资产凭据<span className="spacer" />
          <button className="btn" onClick={() => setCreds(x => [...x, { label: '', username: '', note: '', password: '' }])}>+ 添加凭据</button>
        </div>
        {creds.length === 0 && <div style={{ fontSize: 12, color: 'var(--text-3)', padding: '4px 0 8px' }}>无凭据。可添加 SSH/控制台/数据库账号等；密码加密存储。</div>}
        {creds.map((c, i) => (
          <div key={c.id || `new-${i}`} style={{ display: 'grid', gridTemplateColumns: '1.2fr 1.2fr 1.6fr 1.4fr auto', gap: 8, marginBottom: 8, alignItems: 'center' }}>
            <input className="ainp" placeholder="用途标签（如 SSH root）" value={c.label} onChange={e => setCreds(x => x.map((y, j) => j === i ? { ...y, label: e.target.value } : y))} />
            <input className="ainp" placeholder="账号" value={c.username} onChange={e => setCreds(x => x.map((y, j) => j === i ? { ...y, username: e.target.value } : y))} />
            <input className="ainp" type="password" placeholder={c.id ? '••••（留空保持原密码）' : '密码（明文只存这一次）'} value={c.password} autoComplete="new-password"
              onChange={e => setCreds(x => x.map((y, j) => j === i ? { ...y, password: e.target.value } : y))} />
            <input className="ainp" placeholder="备注" value={c.note || ''} onChange={e => setCreds(x => x.map((y, j) => j === i ? { ...y, note: e.target.value } : y))} />
            <button className="btn" style={{ color: 'var(--sev-critical)' }} onClick={() => setCreds(x => x.filter((_, j) => j !== i))}>移除</button>
          </div>
        ))}
        <div style={{ fontSize: 11, color: 'var(--text-3)' }}>凭据「移除」只是从本次编辑中撤下；已存凭据要真正删除请在资产行「凭据」抽屉里删（有审计）。</div>
        {msg && <div className="badge critical" style={{ marginTop: 10 }}>{msg}</div>}
      </div>
    </div>
  );
}

/* ---------------- 凭据抽屉：列表 + 显式查看明文（审计+自动隐去） + 删除 ---------------- */
function CredDrawer({ asset, onClose, onChanged, onEditAsset }: { asset: any; onClose: () => void; onChanged: () => void; onEditAsset: () => void }) {
  const [revealed, setRevealed] = React.useState<Record<string, { username: string; password: string }>>({});
  const [busy, setBusy] = React.useState('');

  async function reveal(c: any) {
    setBusy(c.id);
    try {
      const r = await api.assetCredReveal(asset.id, c.id);
      setRevealed(x => ({ ...x, [c.id]: { username: r.username, password: r.password } }));
      setTimeout(() => setRevealed(x => { const n = { ...x }; delete n[c.id]; return n; }), 15000);
    } catch (e: any) { alert(String(e.message || e)); }
    setBusy('');
  }
  function copyText(t: string) { navigator.clipboard?.writeText(t).then(() => {}).catch(() => {}); }
  async function delCred(c: any) {
    if (!window.confirm(`删除凭据「${c.label}/${c.username}」？`)) return;
    try {
      await api.assetCredDelete(asset.id, c.id);
      onChanged(); onClose();
    } catch (e: any) { alert(String(e.message || e)); }
  }

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)', zIndex: 55, display: 'flex', justifyContent: 'flex-end' }}>
      <div onClick={e => e.stopPropagation()} style={{ width: 'min(560px, 96vw)', background: 'var(--bg-card)', borderLeft: '1px solid var(--hairline)', padding: 20, overflowY: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 14 }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700 }}>{asset.name} · 凭据</div>
            <div className="mono" style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>{asset.ip || '—'} · {asset.typeLabel}</div>
          </div>
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={onEditAsset}>编辑资产</button>
          <button className="btn" style={{ marginLeft: 6 }} onClick={onClose}>关闭</button>
        </div>
        {(asset.creds || []).length === 0 && <div style={{ color: 'var(--text-3)', fontSize: 12 }}>该资产暂无凭据，点「编辑资产」添加。</div>}
        {(asset.creds || []).map((c: any) => {
          const rv = revealed[c.id];
          return (
            <div key={c.id} className="card" style={{ marginBottom: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <b>{c.label}</b>
                <span className="mono" style={{ color: 'var(--text-2)' }}>{c.username}</span>
                <span style={{ flex: 1 }} />
                {c.hasPassword && (rv
                  ? <button className="btn" onClick={() => copyText(rv.password)}>复制密码</button>
                  : <button className="btn" onClick={() => reveal(c)} disabled={busy === c.id}>{busy === c.id ? '…' : '查看明文'}</button>)}
                <button className="btn" style={{ color: 'var(--sev-critical)' }} onClick={() => delCred(c)}>删除</button>
              </div>
              <div style={{ marginTop: 6 }} className="mono">
                {c.hasPassword ? (rv ? <span style={{ color: 'var(--sev-warning)' }}>{rv.password}</span> : <span style={{ color: 'var(--text-3)' }}>密码 ••••••••（加密存储）</span>) : <span style={{ color: 'var(--text-3)' }}>未设置密码</span>}
              </div>
              {c.note && <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 4 }}>{c.note}</div>}
              <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4 }}>更新于 {c.updatedAt ? fmtTime(c.updatedAt) : '—'}</div>
            </div>
          );
        })}
        <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 8 }}>明文显示 15 秒后自动隐去；每次查看都会写入服务端审计。</div>
      </div>
    </div>
  );
}

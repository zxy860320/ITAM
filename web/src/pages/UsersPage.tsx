import React from 'react';
import { api } from '../api';
import { fmtTime } from '../components/common';

/**
 * 用户管理：用户 CRUD（禁用/删除/重置密码/改角色）+ 角色管理（自定义角色，
 * 权限点勾选，为工单系统预留 ticket.* 扩展）+ AD 域对接配置（可测试连接）。
 * 仅 admin（perm=user.manage）可见入口；后端接口同样强制。
 */
export default function UsersPage() {
  const [data, setData] = React.useState<any>(null);       // { users, roles, perms }
  const [err, setErr] = React.useState('');
  const [msg, setMsg] = React.useState('');
  const flash = (s: string) => { setMsg(s); setTimeout(() => setMsg(''), 4000); };

  const reload = React.useCallback(() => {
    api.users().then(d => { setData(d); setErr(''); }).catch(e => setErr(String(e.message || e)));
  }, []);
  React.useEffect(() => { reload(); }, [reload]);

  // ---------- 新建用户 ----------
  const [nu, setNu] = React.useState({ username: '', displayName: '', password: '', role: 'viewer' });
  const createUser = async () => {
    try { await api.userCreate(nu); flash(`已创建用户 ${nu.username}`); setNu({ username: '', displayName: '', password: '', role: 'viewer' }); reload(); }
    catch (e: any) { flash(`创建失败：${e.message}`); }
  };

  // ---------- 用户操作 ----------
  const act = async (fn: () => Promise<any>, ok: string) => {
    try { await fn(); flash(ok); reload(); } catch (e: any) { flash(`操作失败：${e.message}`); }
  };
  const resetPass = async (u: any) => {
    const pw = window.prompt(`为用户 ${u.username} 设置新密码（至少 6 位）：`);
    if (pw == null) return;
    act(() => api.userResetPass(u.id, pw), `已重置 ${u.username} 密码`);
  };

  // ---------- 角色管理 ----------
  const [nr, setNr] = React.useState({ id: '', label: '', perms: [] as string[] });
  const togglePerm = (list: string[], p: string) => list.includes(p) ? list.filter(x => x !== p) : [...list, p];
  const createRole = async () => {
    try { await api.roleCreate(nr); flash(`已创建角色 ${nr.id}`); setNr({ id: '', label: '', perms: [] }); reload(); }
    catch (e: any) { flash(`创建失败：${e.message}`); }
  };
  const updatePerms = (r: any, perms: string[]) =>
    act(() => api.roleUpdate({ id: r.id, perms }), `角色 ${r.id} 权限已更新（成员会话即时生效）`);
  const delRole = (r: any) => {
    if (!window.confirm(`删除自定义角色 ${r.id}（${r.label}）？`)) return;
    act(() => api.roleDelete(r.id), `已删除角色 ${r.id}`);
  };

  // ---------- AD 配置 ----------
  const [ad, setAd] = React.useState<any>(null);
  const [adTest, setAdTest] = React.useState('');
  React.useEffect(() => { api.adConfig().then(setAd).catch(() => {}); }, []);
  const setAdField = (k: string, v: any) => setAd((x: any) => ({ ...x, [k]: v }));
  const saveAd = async () => {
    try { await api.adConfigSave(ad); flash('AD 配置已保存'); } catch (e: any) { flash(`保存失败：${e.message}`); }
  };
  const testAd = async () => {
    setAdTest('测试中…');
    try {
      const r = await api.adConfigTest(ad);
      setAdTest(`✓ 连通（${r.latencyMs}ms）${r.server ? ' · 服务器 ' + r.server : ''}${r.namingContext ? ' · ' + r.namingContext : ''}`);
    } catch (e: any) { setAdTest(`✗ ${e.message}`); }
  };

  if (err) return <div className="card"><div className="card-title">加载失败</div><div style={{ color: 'var(--sev-critical)' }}>{err}</div></div>;
  if (!data) return <div className="card">加载中…</div>;

  const permLabels: Record<string, string> = Object.fromEntries((data.perms || []).map((p: any) => [p.key, p.label]));
  const roleLabel = (id: string) => data.roles.find((r: any) => r.id === id)?.label || id;
  const srcBadge = (u: any) => u.source === 'ad'
    ? <span className="badge info"><i className="bdot" />AD</span>
    : <span className="badge"><i className="bdot" />本地</span>;

  return (
    <div>
      {msg && <div className="card" style={{ marginBottom: 12, borderColor: 'var(--dom-service)', color: 'var(--text-1)' }}>{msg}</div>}

      {/* ============ 用户 ============ */}
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-title">用户（{data.users.length}：本地 {data.users.filter((u: any) => u.source === 'local').length} · AD {data.users.filter((u: any) => u.source === 'ad').length}）</div>
        <table className="data">
          <thead><tr><th>用户名</th><th>显示名</th><th>来源</th><th>角色</th><th>状态</th><th>最近登录</th><th>操作</th></tr></thead>
          <tbody>
            {data.users.map((u: any) => (
              <tr key={u.id} style={u.enabled ? undefined : { opacity: 0.5 }}>
                <td className="mono">{u.username}</td>
                <td>{u.displayName || <span style={{ color: 'var(--text-3)' }}>—</span>}</td>
                <td>{srcBadge(u)}</td>
                <td>
                  <select value={u.role} style={{ fontSize: 12 }}
                    onChange={e => act(() => api.userUpdate({ id: u.id, role: e.target.value }), `${u.username} 角色 → ${roleLabel(e.target.value)}`)}>
                    {data.roles.map((r: any) => <option key={r.id} value={r.id}>{r.label}</option>)}
                  </select>
                </td>
                <td>{u.enabled
                  ? <span className="badge ok"><i className="bdot" />启用</span>
                  : <span className="badge"><i className="bdot" />禁用</span>}</td>
                <td className="mono" style={{ color: 'var(--text-3)' }}>{u.lastLogin ? fmtTime(u.lastLogin) : '从未'}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <button className="btn" style={{ padding: '3px 9px', fontSize: 11.5 }}
                    onClick={() => act(() => api.userUpdate({ id: u.id, enabled: !u.enabled }), `${u.username} 已${u.enabled ? '禁用' : '启用'}`)}>
                    {u.enabled ? '禁用' : '启用'}
                  </button>
                  {u.source === 'local' && (
                    <button className="btn" style={{ padding: '3px 9px', fontSize: 11.5, marginLeft: 6 }} onClick={() => resetPass(u)}>重置密码</button>
                  )}
                  {u.username !== 'admin' && (
                    <button className="btn" style={{ padding: '3px 9px', fontSize: 11.5, marginLeft: 6 }}
                      onClick={() => { if (window.confirm(`删除用户 ${u.username}？（AD 账号删除后下次登录会自动重新入册）`)) act(() => api.userDelete(u.id), `已删除 ${u.username}`); }}>
                      删除
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="sub-form">
          <div className="field" style={{ flex: 1, minWidth: 130 }}>
            <label>用户名（小写字母数字 . _ @ -）</label>
            <input value={nu.username} onChange={e => setNu({ ...nu, username: e.target.value })} placeholder="zhangsan" />
          </div>
          <div className="field" style={{ flex: 1, minWidth: 110 }}>
            <label>显示名</label>
            <input value={nu.displayName} onChange={e => setNu({ ...nu, displayName: e.target.value })} placeholder="张三" />
          </div>
          <div className="field" style={{ flex: 1, minWidth: 110 }}>
            <label>初始密码（≥6 位）</label>
            <input type="password" value={nu.password} onChange={e => setNu({ ...nu, password: e.target.value })} />
          </div>
          <div className="field" style={{ minWidth: 110 }}>
            <label>角色</label>
            <select value={nu.role} onChange={e => setNu({ ...nu, role: e.target.value })}>
              {data.roles.map((r: any) => <option key={r.id} value={r.id}>{r.label}</option>)}
            </select>
          </div>
          <button className="btn primary" style={{ alignSelf: 'flex-end' }} onClick={createUser}
            disabled={!nu.username || nu.password.length < 6}>新建本地用户</button>
          <span className="hint">AD 账号无需建档——启用 AD 后域账号直接登录，自动按默认角色入册。</span>
        </div>
      </div>

      {/* ============ 角色 ============ */}
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-title">角色（内置 admin / operator / viewer 不可改删；自定义角色可配权限点）</div>
        {data.roles.map((r: any) => (
          <div key={r.id} className="role-row">
            <div className="role-head">
              <b>{r.label}</b>
              <span className="mono" style={{ color: 'var(--text-3)', fontSize: 11 }}>{r.id}</span>
              {r.builtin
                ? <span className="badge"><i className="bdot" />内置</span>
                : <button className="btn" style={{ padding: '3px 9px', fontSize: 11.5 }} onClick={() => delRole(r)}>删除</button>}
              <span style={{ color: 'var(--text-3)', fontSize: 11, marginLeft: 'auto' }}>
                {data.users.filter((u: any) => u.role === r.id).length} 用户
              </span>
            </div>
            <div className="perm-grid">
              {(data.perms || []).map((p: any) => (
                <label key={p.key} className="perm-item">
                  <input type="checkbox" checked={r.id === 'admin' ? true : r.perms.includes(p.key)}
                    disabled={r.builtin}
                    onChange={() => updatePerms(r, togglePerm(r.perms, p.key))} />
                  {p.label}<span className="mono" style={{ color: 'var(--text-3)', marginLeft: 5, fontSize: 10.5 }}>{p.key}</span>
                </label>
              ))}
            </div>
          </div>
        ))}
        <div className="sub-form">
          <div className="field" style={{ minWidth: 130 }}>
            <label>角色 ID（小写字母数字 _ -）</label>
            <input value={nr.id} onChange={e => setNr({ ...nr, id: e.target.value })} placeholder="ticket-agent" />
          </div>
          <div className="field" style={{ minWidth: 130 }}>
            <label>显示名</label>
            <input value={nr.label} onChange={e => setNr({ ...nr, label: e.target.value })} placeholder="工单处理员" />
          </div>
          <div className="field" style={{ flex: 1, minWidth: 200 }}>
            <label>权限点</label>
            <div className="perm-grid" style={{ padding: '4px 0' }}>
              {(data.perms || []).map((p: any) => (
                <label key={p.key} className="perm-item">
                  <input type="checkbox" checked={nr.perms.includes(p.key)}
                    onChange={() => setNr({ ...nr, perms: togglePerm(nr.perms, p.key) })} />
                  {p.label}
                </label>
              ))}
            </div>
          </div>
          <button className="btn primary" style={{ alignSelf: 'flex-end' }} onClick={createRole} disabled={!nr.id}>新建角色</button>
        </div>
      </div>

      {/* ============ AD 域对接 ============ */}
      <div className="card">
        <div className="card-title">AD 域对接（LDAP）</div>
        {!ad ? <div style={{ color: 'var(--text-3)' }}>加载 AD 配置…</div> : (
          <>
            <div className="sub-form">
              <div className="field" style={{ minWidth: 110 }}>
                <label>启用 AD 登录</label>
                <select value={ad.enabled ? '1' : '0'} onChange={e => setAdField('enabled', e.target.value === '1')}>
                  <option value="0">关闭（仅本地账号）</option>
                  <option value="1">启用</option>
                </select>
              </div>
              <div className="field" style={{ flex: 2, minWidth: 240 }}>
                <label>LDAP URL（ldap:// 或 ldaps://）</label>
                <input value={ad.url} onChange={e => setAdField('url', e.target.value)} placeholder="ldap://dc01.corp.local:389" />
              </div>
              <div className="field" style={{ flex: 2, minWidth: 220 }}>
                <label>Base DN（可留空，纯 UPN bind）</label>
                <input value={ad.baseDN} onChange={e => setAdField('baseDN', e.target.value)} placeholder="DC=corp,DC=local" />
              </div>
              <div className="field" style={{ minWidth: 150 }}>
                <label>UPN 后缀（域名）</label>
                <input value={ad.upnSuffix} onChange={e => setAdField('upnSuffix', e.target.value)} placeholder="corp.local" />
              </div>
            </div>
            <div className="sub-form">
              <div className="field" style={{ minWidth: 150 }}>
                <label>AD 用户默认角色</label>
                <select value={ad.defaultRole} onChange={e => setAdField('defaultRole', e.target.value)}>
                  {data.roles.map((r: any) => <option key={r.id} value={r.id}>{r.label}</option>)}
                </select>
              </div>
              <div className="field" style={{ minWidth: 170 }}>
                <label>允许新建本地账号</label>
                <select value={ad.allowCreateLocal ? '1' : '0'} onChange={e => setAdField('allowCreateLocal', e.target.value === '1')}>
                  <option value="1">允许</option>
                  <option value="0">仅 AD 登录</option>
                </select>
              </div>
              <div className="field" style={{ minWidth: 170 }}>
                <label>ldaps 证书校验</label>
                <select value={ad.tlsVerify ? '1' : '0'} onChange={e => setAdField('tlsVerify', e.target.value === '1')}>
                  <option value="1">严格校验</option>
                  <option value="0">跳过（内网自签）</option>
                </select>
              </div>
              <div style={{ display: 'flex', gap: 8, alignSelf: 'flex-end' }}>
                <button className="btn primary" onClick={saveAd}>保存 AD 配置</button>
                <button className="btn" onClick={testAd} disabled={!ad.url}>测试连接</button>
              </div>
            </div>
            {adTest && (
              <div style={{ fontSize: 12, padding: '8px 10px', background: 'var(--bg-inset)', borderRadius: 6, color: adTest.startsWith('✓') ? 'var(--sev-healthy)' : 'var(--sev-critical)' }}>
                {adTest}
              </div>
            )}
            <div style={{ marginTop: 10, fontSize: 12, color: 'var(--text-3)' }}>
              认证方式：UPN bind（username@{ad.upnSuffix || '域后缀'}），无需服务账号；配置 Base DN 后会补全 AD 显示名/邮箱。
              AD 用户首次登录自动入册为「{roleLabel(ad.defaultRole)}」，可在上表调整角色或禁用（禁用后 AD 验证通过也不放行）。
            </div>
          </>
        )}
      </div>
    </div>
  );
}

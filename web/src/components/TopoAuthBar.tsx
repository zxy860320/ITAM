/* topology-svc 登录/会话条（V2 §10）——嵌在各拓扑页工具栏。
 * 后端是真正的权限闸门（写端点 401/403）；本组件只负责体验：
 * 未登录时提示"写操作需登录"，非 admin 提示只读，admin 显示用户名+退出。 */
import React from 'react';
import { useTopoAuth, topoLogin, topoLogout, refreshTopoAuth } from '../topology/useTopoAuth';

export function TopoAuthBar({ compact = false }: { compact?: boolean }) {
  const st = useTopoAuth();
  const [open, setOpen] = React.useState(false);
  const [u, setU] = React.useState('');
  const [p, setP] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState('');

  React.useEffect(() => { void refreshTopoAuth(); }, []);

  const doLogin = async () => {
    if (!u.trim() || !p || busy) return;
    setBusy(true); setErr('');
    try {
      const j = await topoLogin(u.trim(), p);
      if (j?.ok) { setOpen(false); setP(''); }
      else throw new Error(j?.error || '登录失败');
    } catch (e: any) { setErr(String(e.message || e)); }
    finally { setBusy(false); }
  };

  if (st.authed) {
    return (
      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
        <span style={{ color: st.role === 'admin' ? 'var(--sev-healthy)' : 'var(--dom-network)' }}>
          ● {st.user}{st.role ? `（${st.role === 'admin' ? '管理员' : '只读'}）` : ''}
        </span>
        {!compact && st.role !== 'admin' && <span style={{ color: 'var(--sev-warning)' }}>当前身份只读，写操作需管理员</span>}
        <button className="btn" style={{ padding: '2px 8px', fontSize: 11 }} onClick={() => void topoLogout()}>退出</button>
      </span>
    );
  }
  if (!open) {
    return (
      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
        {!compact && <span style={{ color: 'var(--text-3)' }}>只读浏览中（写操作需管理员登录）</span>}
        <button className="btn" style={{ padding: '2px 8px', fontSize: 11 }} onClick={() => { setOpen(true); void refreshTopoAuth(); }}>拓扑登录</button>
        {st.users_exist === false && <span style={{ color: 'var(--sev-warning)' }}>尚无用户：服务端需配置 TOPO_ADMIN_BOOTSTRAP_USER/PASS 首启引导</span>}
      </span>
    );
  }
  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
      <input placeholder="用户名" value={u} onChange={e => setU(e.target.value)} autoFocus style={{ width: 120, fontSize: 12 }} />
      <input placeholder="密码" type="password" value={p} onChange={e => setP(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') void doLogin(); }} style={{ width: 140, fontSize: 12 }} />
      <button className="btn primary" style={{ padding: '2px 10px', fontSize: 11 }} disabled={busy || !u.trim() || !p} onClick={() => void doLogin()}>
        {busy ? '登录中…' : '登录'}
      </button>
      <button className="btn" style={{ padding: '2px 8px', fontSize: 11 }} onClick={() => { setOpen(false); setErr(''); }}>收起</button>
      {err && <span style={{ color: 'var(--sev-critical)', fontSize: 12 }}>{err}</span>}
    </span>
  );
}

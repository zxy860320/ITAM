import React from 'react';
import { api } from '../api';

/** 登录页：本地账号 + AD 域账号（AD 启用后填 user@域 或纯 sAMAccountName 均可） */
export default function LoginPage({ onLoggedIn }: { onLoggedIn: (who: any) => void }) {
  const [username, setUsername] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setErr('');
    try {
      const who = await api.login(username, password);
      onLoggedIn(who);
    } catch (e: any) {
      setErr(String(e.message || e).replace('/auth/login -> 401', '') || '登录失败');
    } finally { setBusy(false); }
  };

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <div className="login-brand">
          <div className="brand-name">IT运维监控平台</div>
          <div className="brand-sub">ZABBIX · TOPOLOGY · OPS CONSOLE</div>
        </div>
        <div className="field">
          <label>用户名</label>
          <input autoFocus value={username} onChange={e => setUsername(e.target.value)}
            placeholder="本地账号 或 AD 账号（zhangsan / zhangsan@corp.local）" autoComplete="username" />
        </div>
        <div className="field">
          <label>密码</label>
          <input type="password" value={password} onChange={e => setPassword(e.target.value)}
            placeholder="••••••••" autoComplete="current-password" />
        </div>
        {err && <div className="login-err">{err}</div>}
        <button className="btn primary" type="submit" disabled={busy || !username || !password}>
          {busy ? '登录中…' : '登 录'}
        </button>
        <div className="login-foot">
          <a href="#/dashboard" className="mono" style={{ fontSize: 11, color: 'var(--text-3)' }}>免登录进入监控大屏 →</a>
        </div>
      </form>
    </div>
  );
}

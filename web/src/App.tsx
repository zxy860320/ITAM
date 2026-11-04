import React from 'react';
import { api, usePoll } from './api';
import { useNow } from './components/common';
import Dashboard from './pages/Dashboard';
import ServerPage from './pages/ServerPage';
import NetworkPage from './pages/NetworkPage';
import WirelessPage from './pages/WirelessPage';
import DatabasePage from './pages/DatabasePage';
import ServicePage from './pages/ServicePage';
import TopologyPage from './pages/TopologyPage';
import TopologyFullPage from './pages/TopologyFullPage';
import LinkReviewPage from './pages/LinkReviewPage';
import FlowPathPage from './pages/FlowPathPage';
import SourcePage from './pages/SourcePage';
import NotifyPage from './pages/NotifyPage';
import OpsPage from './pages/OpsPage';
import AssetPage from './pages/AssetPage';
import AssistantPage from './pages/AssistantPage';
import SystemOverviewPage from './pages/system/SystemOverviewPage';
import SystemMailPage from './pages/system/SystemMailPage';
import SystemPermsPage from './pages/system/SystemPermsPage';
import SystemAuditPage from './pages/system/SystemAuditPage';
import UsersPage from './pages/UsersPage';
import TicketPage from './pages/TicketPage';
import TicketConfirmPage from './pages/TicketConfirmPage';
import LoginPage from './pages/LoginPage';

const NAV = [
  { group: '监控视图', items: [
    { key: 'dashboard', label: '监控大屏', hash: '#/dashboard' },
    { key: 'server',    label: '服务器监控', hash: '#/server',    color: 'var(--dom-server)' },
    { key: 'database',  label: '数据库监控', hash: '#/database',  color: 'var(--dom-database)' },
    { key: 'network',   label: '网络设备监控', hash: '#/network', color: 'var(--dom-network)' },
    { key: 'wlan',      label: '无线网络监控', hash: '#/wlan',    color: 'var(--dom-wlan)' },
    { key: 'topology',  label: '网络拓扑', hash: '#/topology',  color: 'var(--dom-network)' },
    { key: 'link-review', label: '链路审核', hash: '#/link-review', color: 'var(--dom-network)' },
    { key: 'flow-path', label: '流量路径走势', hash: '#/flow-path', color: 'var(--dom-network)' },
    { key: 'service',   label: '服务监控', hash: '#/service',   color: 'var(--dom-service)' },
  ]},
  { group: '工作台', items: [
    { key: 'tickets', label: '工单工作台', hash: '#/tickets', color: 'var(--sev-warning)' },
  ]},
  { group: '平台管理', items: [
    { key: 'assets', label: '资产管理', hash: '#/assets', color: '#8b5cf6' },
    { key: 'source', label: '监控源对接', hash: '#/source' },
    { key: 'notify', label: '告警出口', hash: '#/notify' },
    { key: 'ops', label: '设备操作', hash: '#/ops', color: 'var(--dom-service)' },
    { key: 'assistant', label: 'AI 助手', hash: '#/assistant', color: 'var(--dom-wlan)' },
    { key: 'system', label: '系统管理', hash: '#/system', children: [
      { key: 'system', label: '运行概览', hash: '#/system' },
      { key: 'system-mail', label: '邮件服务', hash: '#/system-mail' },
      { key: 'system-perms', label: '权限与账号', hash: '#/system-perms' },
      { key: 'system-audit', label: '审计日志', hash: '#/system-audit' },
    ]},
    { key: 'users', label: '用户管理', hash: '#/users', perm: 'user.manage' },
  ]},
];

const PAGES: Record<string, [React.FC<any>, string]> = {
  dashboard: [Dashboard, '监控大屏'],
  server: [ServerPage, '服务器监控'],
  database: [DatabasePage, '数据库监控'],
  network: [NetworkPage, '网络设备监控'],
  wlan: [WirelessPage, '无线网络监控'],
  topology: [TopologyPage, '网络拓扑'],
  'topology-full': [TopologyFullPage, '网络架构全览'],
  'link-review': [LinkReviewPage, '链路审核'],
  'flow-path': [FlowPathPage, '流量路径走势'],
  service: [ServicePage, '服务监控'],
  source: [SourcePage, '监控源对接'],
  notify: [NotifyPage, '告警出口'],
  ops: [OpsPage, '设备操作'],
  assets: [AssetPage, '资产管理'],
  assistant: [AssistantPage, 'AI 助手'],
  system: [SystemOverviewPage, '系统管理 / 运行概览'],
  'system-mail': [SystemMailPage, '系统管理 / 邮件服务'],
  'system-perms': [SystemPermsPage, '系统管理 / 权限与账号'],
  'system-audit': [SystemAuditPage, '系统管理 / 审计日志'],
  users: [UsersPage, '用户管理'],
  tickets: [TicketPage, '工单工作台'],
};

function useHashRoute() {
  const [hash, setHash] = React.useState(location.hash || '#/dashboard');
  React.useEffect(() => {
    const f = () => setHash(location.hash || '#/dashboard');
    location.hash = hash;
    window.addEventListener('hashchange', f);
    return () => window.removeEventListener('hashchange', f);
  }, []);
  return hash;
}

export default function App() {
  const hash = useHashRoute();
  const route = hash.replace(/^#\//, '').split('?')[0] || 'dashboard';

  // 规则：所有 Hook 必须在条件分支之前无条件调用
  const { data: sum } = usePoll(api.summary, 20000);
  const now = useNow();
  const p = (n: number) => String(n).padStart(2, '0');
  /* 侧栏可折叠（偏好存 localStorage）：拓扑等宽画布页面可临时收起菜单 */
  const [navCollapsed, setNavCollapsed] = React.useState(() => localStorage.getItem('uocp.nav.collapsed') === '1');
  const toggleNav = () => setNavCollapsed(v => { localStorage.setItem('uocp.nav.collapsed', v ? '0' : '1'); return !v; });

  // ---------- 登录门禁（除大屏外全站需登录）：UI 门禁 + 顶栏用户区 ----------
  const [auth, setAuth] = React.useState<any | null | undefined>(undefined); // undefined=检查中，null=未登录
  const [userMenu, setUserMenu] = React.useState(false);
  React.useEffect(() => { api.me().then(setAuth).catch(() => setAuth(null)); }, []);
  const doLogout = async () => {
    try { await api.logout(); } catch { /* 会话可能已失效 */ }
    setAuth(null); setUserMenu(false);
  };
  const changePassword = async () => {
    const pw = window.prompt('输入新密码（至少 6 位）：');
    if (pw == null) return;
    try { await api.changePassword(pw); alert('密码已修改'); }
    catch (e: any) { alert(`修改失败：${e.message}`); }
    setUserMenu(false);
  };

  // 大屏模式：无侧栏，流式铺满视口、自适应任意屏幕尺寸（免登录）
  if (route === 'dashboard') return <Dashboard />;

  // 工单确认页：邮件收件人免登录（token 承载一次性确认能力）
  if (route === 'ticket-confirm') return <TicketConfirmPage hash={hash} />;

  // 其余页面：未登录先过登录页
  if (auth === undefined) return <div className="login-wrap"><div className="login-card" style={{ textAlign: 'center', color: 'var(--text-3)' }}>正在检查登录状态…</div></div>;
  if (auth === null) return <LoginPage onLoggedIn={who => setAuth(who)} />;

  const [Page, title] = PAGES[route] || PAGES.dashboard;
  const perms: string[] = auth.perms || [];
  const visibleNav = NAV.map(g => ({
    ...g,
    items: g.items.filter(it => !('perm' in (it as any)) || perms.includes((it as any).perm)),
  })).filter(g => g.items.length);

  return (
    <div className="app-shell">
      {!navCollapsed && (
        <aside className="sidebar">
          <div className="brand">
            <div className="brand-name">IT运维监控平台</div>
            <div className="brand-sub">ZABBIX 7.2 · OPS CONSOLE</div>
          </div>
          {visibleNav.map(g => (
            <div key={g.group}>
              <div className="nav-group-label">{g.group}</div>
              {g.items.map((it: any) => it.children ? (
                <div key={it.key} className="nav-parent">
                  <a className={`nav-item ${it.children.some((c: any) => c.key === route) ? 'active' : ''}`} href={it.hash}>
                    {it.label}
                    <span className="nav-caret">›</span>
                  </a>
                  {it.children.map((c: any) => (
                    <a key={c.key} className={`nav-item nav-sub ${route === c.key ? 'active' : ''}`} href={c.hash}>{c.label}</a>
                  ))}
                </div>
              ) : (
                <a key={it.key} className={`nav-item ${route === it.key ? 'active' : ''}`} href={it.hash}>
                  {it.color && <i className="dom-dot" style={{ background: it.color }} />}
                  {it.label}
                  {sum && it.key !== 'source' && it.key !== 'system' && it.key !== 'notify' && it.key !== 'dashboard' && it.key !== 'users' && (() => {
                    const d = sum.domains.find((x: any) => x.domain === it.key);
                    const n = d ? d.critical + d.warning : 0;
                    return n > 0 ? <span className="nav-badge">{n}</span> : null;
                  })()}
                </a>
              ))}
            </div>
          ))}
          <div className="sidebar-foot">
            <span className="dot-live" />采集器运行中 · {sum?.collector?.freq ?? 60}s
          </div>
        </aside>
      )}
      <div className="main-area">
        <header className="topbar">
          <button className="nav-toggle" title={navCollapsed ? '展开菜单' : '收起菜单'}
            onClick={toggleNav}>{navCollapsed ? '☰ 菜单' : '☰'}</button>
          <span className="crumb">控制台 / {title}</span>
          <div className="spacer" />
          {sum && (
            <span className="sync-meta">
              SYNC #{sum.collector.syncCount} · {new Date(sum.collector.lastSync).toLocaleTimeString('zh-CN')}
              {' '}· {sum.totals.problemsActive} 活动告警
            </span>
          )}
          <span className="clock">{now.getFullYear()}-{p(now.getMonth() + 1)}-{p(now.getDate())} {p(now.getHours())}:{p(now.getMinutes())}:{p(now.getSeconds())}</span>
          <div className="user-chip">
            <span>{auth.user?.displayName || auth.user?.username}</span>
            <span className="urole">{auth.role?.label || auth.user?.role}{auth.user?.source === 'ad' ? ' · AD' : ''}</span>
            <button className="btn" style={{ padding: '4px 8px' }} onClick={() => setUserMenu(v => !v)}>▾</button>
            {userMenu && (
              <div className="user-menu">
                {auth.user?.source === 'local' && <button onClick={changePassword}>修改密码</button>}
                <button onClick={doLogout}>退出登录</button>
              </div>
            )}
          </div>
        </header>
        <div className="page-scroll">
          <Page summary={sum} auth={auth} />
        </div>
      </div>
    </div>
  );
}

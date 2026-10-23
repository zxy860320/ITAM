import React from 'react';
import { api, usePoll } from './api';
import { useNow } from './components/common';
import Dashboard from './pages/Dashboard';
import ServerPage from './pages/ServerPage';
import NetworkPage from './pages/NetworkPage';
import DatabasePage from './pages/DatabasePage';
import ServicePage from './pages/ServicePage';
import SourcePage from './pages/SourcePage';
import SystemPage from './pages/SystemPage';

const NAV = [
  { group: '监控视图', items: [
    { key: 'dashboard', label: '监控大屏', hash: '#/dashboard' },
    { key: 'server',    label: '服务器监控', hash: '#/server',    color: 'var(--dom-server)' },
    { key: 'database',  label: '数据库监控', hash: '#/database',  color: 'var(--dom-database)' },
    { key: 'network',   label: '网络设备监控', hash: '#/network', color: 'var(--dom-network)' },
    { key: 'service',   label: '服务监控', hash: '#/service',   color: 'var(--dom-service)' },
  ]},
  { group: '平台管理', items: [
    { key: 'source', label: '监控源对接', hash: '#/source' },
    { key: 'system', label: '系统管理', hash: '#/system' },
  ]},
];

const PAGES: Record<string, [React.FC<any>, string]> = {
  dashboard: [Dashboard, '监控大屏'],
  server: [ServerPage, '服务器监控'],
  database: [DatabasePage, '数据库监控'],
  network: [NetworkPage, '网络设备监控'],
  service: [ServicePage, '服务监控'],
  source: [SourcePage, '监控源对接'],
  system: [SystemPage, '系统管理'],
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

  // 大屏模式：无侧栏，1920×1080 比例画布
  if (route === 'dashboard') return <Dashboard />;

  const [Page, title] = PAGES[route] || PAGES.dashboard;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-name">IT运维监控平台</div>
          <div className="brand-sub">ZABBIX 7.2 · OPS CONSOLE</div>
        </div>
        {NAV.map(g => (
          <div key={g.group}>
            <div className="nav-group-label">{g.group}</div>
            {g.items.map(it => (
              <a key={it.key} className={`nav-item ${route === it.key ? 'active' : ''}`} href={it.hash}>
                {it.color && <i className="dom-dot" style={{ background: it.color }} />}
                {it.label}
                {sum && it.key !== 'source' && it.key !== 'system' && it.key !== 'dashboard' && (() => {
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
      <div className="main-area">
        <header className="topbar">
          <span className="crumb">控制台 / {title}</span>
          <div className="spacer" />
          {sum && (
            <span className="sync-meta">
              SYNC #{sum.collector.syncCount} · {new Date(sum.collector.lastSync).toLocaleTimeString('zh-CN')}
              {' '}· {sum.totals.problemsActive} 活动告警
            </span>
          )}
          <span className="clock">{now.getFullYear()}-{p(now.getMonth() + 1)}-{p(now.getDate())} {p(now.getHours())}:{p(now.getMinutes())}:{p(now.getSeconds())}</span>
        </header>
        <div className="page-scroll">
          <Page summary={sum} />
        </div>
      </div>
    </div>
  );
}

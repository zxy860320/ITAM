import React from 'react';
import { api, usePoll } from '../api';
import { Badge, Spark, Meter, Pager, ago, DOM_COLOR } from '../components/common';
import EntityDetailDrawer from './EntityDetailDrawer';
import DbDetailDrawer from './DbDetailDrawer';

/** 域监控页通用骨架：KPI 行 + 工具条 + 列表 + 详情抽屉 */
export default function EntityPage({ domain, summary }: { domain: string; summary: any }) {
  const [q, setQ] = React.useState('');
  const [avail, setAvail] = React.useState('');
  const [page, setPage] = React.useState(1);
  const [detail, setDetail] = React.useState<any>(null);

  const qs = { domain, q, availability: avail, page, size: 20 };
  const { data, reload } = usePoll(() => api.entities(qs), 20000, JSON.stringify(qs));
  const { data: evs } = usePoll(() => api.events({ domain, size: 8 }), 20000, domain);

  const stats = summary?.domains?.find((d: any) => d.domain === domain);

  return (
    <div>
      {/* KPI */}
      <div className="stat-row">
        <div className="card">
          <div className="stat-num">{stats?.total ?? '—'}</div>
          <div className="stat-label">监控对象总数</div>
        </div>
        <div className="card">
          <div className="stat-num" style={{ color: 'var(--sev-healthy)' }}>{stats?.healthy ?? '—'}</div>
          <div className="stat-label">健康</div>
        </div>
        <div className="card">
          <div className="stat-num" style={{ color: 'var(--sev-warning)' }}>{stats?.warning ?? '—'}</div>
          <div className="stat-label">存在警告</div>
        </div>
        <div className="card">
          <div className="stat-num" style={{ color: 'var(--sev-critical)' }}>{stats?.critical ?? '—'}</div>
          <div className="stat-label">异常 / 离线</div>
        </div>
      </div>

      <div className="grid-3" style={{ marginBottom: 14 }}>
        {/* 列表 */}
        <div className="card" style={{ padding: '12px 14px' }}>
          <div className="toolbar" style={{ marginBottom: 10 }}>
            <input placeholder="搜索名称 / IP…" value={q} onChange={e => { setQ(e.target.value); setPage(1); }} />
            <div className="seg">
              {[['', '全部'], ['critical', '异常'], ['warning', '警告'], ['healthy', '健康']].map(([v, l]) => (
                <button key={v} className={avail === v ? 'on' : ''} onClick={() => { setAvail(v); setPage(1); }}>{l}</button>
              ))}
            </div>
            <span className="spacer" style={{ flex: 1 }} />
            <button className="btn" onClick={reload}>刷新</button>
          </div>
          <table className="data fixed nowrap">
            <Colgroup cols={buildCols(domain, data?.rows || [])} />
            <thead>
              <tr>{buildCols(domain, data?.rows || []).map(c => <th key={c.key} className={c.cls}>{c.th}</th>)}</tr>
            </thead>
            <tbody>
              {(data?.rows || []).map((r: any) => (
                <tr key={r.hostid || r.serviceid} style={{ cursor: 'pointer' }} onClick={() => setDetail(r)}>
                  {buildCols(domain, data?.rows || []).map(c => <td key={c.key} className={c.cls}>{cell(c.key, r, domain)}</td>)}
                </tr>
              ))}
              {(!data?.rows?.length) && (
                <tr><td colSpan={buildCols(domain, []).length} className="empty-tip">
                  {domain === 'database'
                    ? '该域暂无监控对象 — zCloud(dbmp) 北向API 未返回实例（检查 对接页 数据库数据源状态）'
                    : '该域暂无监控对象 — 在 Zabbix 中为相关主机挂载对应模板后会自动归入本域'}
                </td></tr>
              )}
            </tbody>
          </table>
          {data && <Pager page={data.page} size={data.size} total={data.total} onPage={setPage} />}
        </div>

        {/* 域内告警流 */}
        <div className="card">
          <div className="card-title">域内告警<span className="spacer" /><a href="#/dashboard" style={{ color: 'var(--text-3)', fontSize: 11, textDecoration: 'none' }}>全部告警 →</a></div>
          {(evs?.rows || []).map((e: any) => (
            <div key={e.eventid} className="ev-row">
              <Badge sev={e.severity} />
              <span className="ev-msg" title={e.message}>{e.message}</span>
              <span className="ev-time">{ago(e.clock)}</span>
            </div>
          ))}
        </div>
      </div>

      {/* 详情抽屉：dbmp（zCloud）数据库实体走 DB 专属抽屉，其余走通用设备抽屉 */}
      {detail && (String(detail.hostid || '').startsWith('dbmp-')
        ? <DbDetailDrawer entity={detail} onClose={() => setDetail(null)} />
        : <EntityDetailDrawer entity={detail} onClose={() => setDetail(null)} />)}
    </div>
  );
}

/* ---------- 列定义：按当页实际数据裁剪空列，百分比列宽自适应卡片宽度 ---------- */
type Col = { key: string; th: string; w?: string; cls?: string };

function buildCols(domain: string, rows: any[]): Col[] {
  const any = (f: (r: any) => any) => rows.some(f);
  const empty = rows.length === 0;
  const cols: Col[] = [{ key: 'name', th: '名称', w: '22%' }];
  if (!empty && any(r => r.ip)) cols.push({ key: 'ip', th: 'IP', w: '12%', cls: 'mono' });
  cols.push({ key: 'group', th: domain === 'service' ? '分组' : domain === 'database' ? '集群' : '群组', w: '12%' });
  if (domain === 'service') {
    cols.push({ key: 'rt', th: 'RT P95', w: '12%', cls: 'mono num' });
    cols.push({ key: 'qps', th: 'QPS', w: '12%', cls: 'mono num' });
    cols.push({ key: 'successRate', th: '成功率', w: '10%', cls: 'mono num' });
    cols.push({ key: 'instances', th: '实例', w: '8%', cls: 'mono num' });
  } else if (domain === 'database') {
    cols.push({ key: 'dbRole', th: '角色', w: '8%' });
    cols.push({ key: 'version', th: '版本', w: '10%', cls: 'mono' });
    cols.push({ key: 'conn', th: '连接数', w: '12%', cls: 'mono num' });
    cols.push({ key: 'threads', th: '活跃线程', w: '8%', cls: 'mono num' });
    cols.push({ key: 'qps', th: 'QPS', w: '10%', cls: 'mono num' });
  } else if (domain === 'network' && any(r => r.wlan)) {
    // 无线控制器（AC）：AP 状态汇总 + 接入用户数（区别于交换机的 CPU/内存列）
    cols.push({ key: 'ap', th: 'AP（正常/异常/总数）', w: '16%', cls: 'mono' });
    cols.push({ key: 'wlanUsers', th: '接入用户(2.4G/5G)', w: '16%', cls: 'mono num' });
    if (!empty && any(r => !r.wlan && (r.cpu != null || r.mem != null))) {
      cols.push({ key: 'cpu', th: 'CPU', w: '12%' });
      cols.push({ key: 'mem', th: '内存', w: '12%' });
    }
  } else {
    cols.push({ key: 'cpu', th: 'CPU', w: '18%' });
    cols.push({ key: 'mem', th: '内存', w: '18%' });
    if (!empty && any(r => r.disk != null)) cols.push({ key: 'disk', th: '磁盘', w: '8%', cls: 'mono num' });
  }
  const sparkKey = domain === 'service' ? 'rtSpark' : domain === 'database' ? 'qpsSpark' : 'cpuSpark';
  if (!empty && any(r => !r.wlan && r[sparkKey]?.length)) cols.push({ key: 'spark', th: '趋势', w: '10%' });
  cols.push({ key: 'problems', th: '告警', w: '6%', cls: 'num' });
  cols.push({ key: 'availability', th: '状态', w: '9%' });
  return cols;
}

function Colgroup({ cols }: { cols: Col[] }) {
  return (
    <colgroup>
      {cols.map(c => c.w
        ? <col key={c.key} style={{ width: c.w }} />
        : <col key={c.key} />)}
    </colgroup>
  );
}

function cell(key: string, r: any, domain: string) {
  const dbm = r.dbMetrics || {};
  switch (key) {
    case 'name':
      return <span title={r.name}>{r.name}</span>;
    case 'ip':
      return <span style={{ color: 'var(--text-2)' }}>{r.ip || '—'}</span>;
    case 'group':
      return <span style={{ color: 'var(--text-3)' }} title={r.group}>{r.group || '—'}</span>;
    case 'rt': return r.rt ? `${r.rt}ms` : '—';
    case 'qps': {
      const v = domain === 'database' ? dbm.qps : r.qps;
      return v != null ? v.toLocaleString?.() ?? v : '—';
    }
    case 'successRate':
      return <span style={{ color: r.successRate < 98.5 && r.successRate > 0 ? 'var(--sev-warning)' : undefined }}>{r.successRate ? `${r.successRate}%` : '—'}</span>;
    case 'instances': return r.instances ?? '—';
    case 'dbRole':
      return <span style={{ color: r.dbRole === 'master' ? '#38BDF8' : 'var(--text-2)' }}>{r.dbRole || '—'}</span>;
    case 'version': return <span style={{ fontSize: 11 }}>{r.version || '—'}</span>;
    case 'conn': {
      if (dbm.threads_connected == null) return <span style={{ color: 'var(--text-3)' }}>—</span>;
      const pct = dbm.conn_pct;
      return <span title={dbm.max_connections ? `max_connections=${dbm.max_connections}（占用 ${pct}%）` : undefined}
        style={{ color: pct != null && pct >= 80 ? 'var(--sev-warning)' : undefined }}>{dbm.threads_connected}{dbm.max_connections ? ` / ${dbm.max_connections}` : ''}</span>;
    }
    case 'threads': return dbm.threads_running != null
      ? <span style={{ color: dbm.threads_running >= 30 ? 'var(--sev-warning)' : undefined }}>{dbm.threads_running}</span>
      : <span style={{ color: 'var(--text-3)' }}>—</span>;
    case 'cpu': return r.cpu == null ? <span style={{ color: 'var(--text-3)' }}>—</span> : <Meter value={r.cpu} />;
    case 'mem': return r.mem == null ? <span style={{ color: 'var(--text-3)' }}>—</span> : <Meter value={r.mem} />;
    case 'ap': {
      if (!r.wlan) return <span style={{ color: 'var(--text-3)' }}>—</span>;
      const st = r.apStates || {};
      const normal = (st.Normal || 0), idle = (st.Idle || 0);
      const fault = (r.apTotal ?? 0) - normal - idle;
      return <span title={`Normal=${normal}${idle ? ` Idle=${idle}(备机待机)` : ''} 异常=${fault}`}>
        <span style={{ color: 'var(--sev-healthy)' }}>{normal}</span>/<span style={{ color: fault ? 'var(--sev-critical)' : 'var(--text-3)' }}>{fault}</span>/{r.apTotal ?? '—'}
      </span>;
    }
    case 'wlanUsers': {
      if (!r.wlan) return <span style={{ color: 'var(--text-3)' }}>—</span>;
      return r.wlanUsers != null
        ? <span title={`2.4G: ${r.wlanUsers24 ?? '—'} · 5G: ${r.wlanUsers5 ?? '—'}`}>{r.wlanUsers} <span style={{ color: 'var(--text-3)', fontSize: 11 }}>({r.wlanUsers24 ?? '—'}/{r.wlanUsers5 ?? '—'})</span></span>
        : '—';
    }
    case 'disk': return r.disk == null ? '—' : `${r.disk}%`;
    case 'spark': return <Spark data={domain === 'service' ? r.rtSpark : domain === 'database' ? r.qpsSpark : r.cpuSpark} w={86} color={DOM_COLOR[domain]} />;
    case 'problems':
      return <span className="mono" style={{ color: r.problems ? 'var(--sev-critical)' : 'var(--text-3)' }}
        title={r.noiseProblems ? `另有 ${r.noiseProblems} 条哨兵值噪声告警（传感器不可读等），未计入` : undefined}>
        {r.problems || '—'}{r.noiseProblems ? <span style={{ color: 'var(--text-3)', fontSize: 10 }}> ~{r.noiseProblems}</span> : null}
      </span>;
    case 'availability': return <Badge sev={r.availability} />;
    default: return null;
  }
}

import React from 'react';
import { api, usePoll } from '../api';
import { Badge, Spark, Meter, Pager, ago, DOM_COLOR } from '../components/common';
import EntityDetailDrawer from './EntityDetailDrawer';

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
                <tr><td colSpan={buildCols(domain, []).length} className="empty-tip">该域暂无监控对象 — 在 Zabbix 中为相关主机挂载对应模板后会自动归入本域</td></tr>
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

      {/* 详情抽屉 */}
      {detail && <EntityDetailDrawer entity={detail} onClose={() => setDetail(null)} />}
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
  cols.push({ key: 'group', th: domain === 'service' ? '分组' : '群组', w: '12%' });
  if (domain === 'service') {
    cols.push({ key: 'rt', th: 'RT P95', w: '12%', cls: 'mono num' });
    cols.push({ key: 'qps', th: 'QPS', w: '12%', cls: 'mono num' });
    cols.push({ key: 'successRate', th: '成功率', w: '10%', cls: 'mono num' });
    cols.push({ key: 'instances', th: '实例', w: '8%', cls: 'mono num' });
  } else {
    cols.push({ key: 'cpu', th: 'CPU', w: '18%' });
    cols.push({ key: 'mem', th: '内存', w: '18%' });
    if (!empty && any(r => r.disk != null)) cols.push({ key: 'disk', th: '磁盘', w: '8%', cls: 'mono num' });
  }
  const sparkKey = domain === 'service' ? 'rtSpark' : 'cpuSpark';
  if (!empty && any(r => r[sparkKey]?.length)) cols.push({ key: 'spark', th: '趋势', w: '10%' });
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
  switch (key) {
    case 'name':
      return <span title={r.name}>{r.name}</span>;
    case 'ip':
      return <span style={{ color: 'var(--text-2)' }}>{r.ip || '—'}</span>;
    case 'group':
      return <span style={{ color: 'var(--text-3)' }} title={r.group}>{r.group || '—'}</span>;
    case 'rt': return r.rt ? `${r.rt}ms` : '—';
    case 'qps': return r.qps?.toLocaleString?.() ?? '—';
    case 'successRate':
      return <span style={{ color: r.successRate < 98.5 && r.successRate > 0 ? 'var(--sev-warning)' : undefined }}>{r.successRate ? `${r.successRate}%` : '—'}</span>;
    case 'instances': return r.instances ?? '—';
    case 'cpu': return r.cpu == null ? <span style={{ color: 'var(--text-3)' }}>—</span> : <Meter value={r.cpu} />;
    case 'mem': return r.mem == null ? <span style={{ color: 'var(--text-3)' }}>—</span> : <Meter value={r.mem} />;
    case 'disk': return r.disk == null ? '—' : `${r.disk}%`;
    case 'spark': return <Spark data={domain === 'service' ? r.rtSpark : r.cpuSpark} w={86} color={DOM_COLOR[domain]} />;
    case 'problems':
      return <span className="mono" style={{ color: r.problems ? 'var(--sev-critical)' : 'var(--text-3)' }}>{r.problems || '—'}</span>;
    case 'availability': return <Badge sev={r.availability} />;
    default: return null;
  }
}

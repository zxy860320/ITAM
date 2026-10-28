import React from 'react';
import { api, usePoll } from '../api';
import { Badge, Pager, fmtTime, ago } from '../components/common';
import { Chart, darkBase, axisStyle } from '../components/Chart';

/* ---------- 格式化 ---------- */
function fmtNum(n: any, d = 2): string {
  const v = Number(n);
  return Number.isFinite(v) ? +v.toFixed(d) + '' : '—';
}
function fmtUptime(s: any): string {
  const v = Number(s);
  if (!Number.isFinite(v) || v <= 0) return '—';
  const d = Math.floor(v / 86400), h = Math.floor((v % 86400) / 3600), m = Math.floor((v % 3600) / 60);
  return d ? `${d}天${h}小时` : h ? `${h}小时${m}分` : `${m}分`;
}
function toLocalInput(ts: number): string {
  const d = new Date(ts), p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 数据库实例深度详情（数据源：zCloud(dbmp) 北向API :8023，免鉴权实时快照）。
 * 趋势 = 本平台按采集周期对真实累计计数器（Questions/Com_commit…）采样差值；
 * 采样起点之前的区间如实为空，不做任何补造。
 */
export default function DbDetailDrawer({ entity, onClose }: { entity: any; onClose: () => void }) {
  const id = entity.hostid;
  const { data: d, reload } = usePoll(() => api.entityDetail(id).then(r => r.detail), 60000, id);

  const [range, setRange] = React.useState<'6h' | '24h' | '7d' | '30d'>('6h');
  const [tillStr, setTillStr] = React.useState('');
  const tillEpoch = tillStr ? Math.floor(new Date(tillStr).getTime() / 1000) : 0;
  const [metric, setMetric] = React.useState<'qps' | 'conn' | 'slow' | 'rows' | 'bufhit'>('qps');
  const { data: sd } = usePoll(
    () => api.entitySeries(id, { range, till: tillEpoch }).then(r => r.series),
    60000, `${id}|${range}|${tillEpoch}`,
  );

  React.useEffect(() => {
    const f = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    addEventListener('keydown', f); return () => removeEventListener('keydown', f);
  }, [onClose]);

  const [tab, setTab] = React.useState<'status' | 'config' | 'obj'>('status');
  const [stPage, setStPage] = React.useState(1);
  const [cfgPage, setCfgPage] = React.useState(1);
  const [varQ, setVarQ] = React.useState('');

  const prof = d?.profile || {};
  const m = entity.dbMetrics || {};
  const rates = d?.rates || {};
  const S: any = sd?.series || {};

  const xfmt = React.useCallback((t: number) => {
    const dt = new Date(t), p = (n: number) => String(n).padStart(2, '0');
    if (range === '6h' || range === '24h') return `${p(dt.getHours())}:${p(dt.getMinutes())}`;
    if (range === '7d') return `${p(dt.getMonth() + 1)}-${p(dt.getDate())} ${p(dt.getHours())}h`;
    return `${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
  }, [range]);

  const lineOpt = React.useCallback((pairs: { name: string; s: any; color: string }[], opt: { yMax?: number; yName?: string } = {}) => {
    const anyXs = pairs.map(p => (p.s?.avg || [])).sort((a, b) => b.length - a.length)[0] || [];
    const xs = anyXs.map((pt: any) => xfmt(pt.t));
    const series = pairs.map(p => ({
      name: p.name, type: 'line', data: (p.s?.avg || []).map((pt: any) => +pt.v),
      smooth: true, symbol: 'none', lineStyle: { width: 1.6, color: p.color },
      areaStyle: { opacity: 0.08, color: p.color },
    }));
    return {
      ...darkBase,
      legend: pairs.length > 1 ? { data: pairs.map(p => p.name), textStyle: { color: '#A1A1AA', fontSize: 11 }, top: 2, right: 4 } : undefined,
      grid: { left: 48, right: 14, top: pairs.length > 1 ? 26 : 18, bottom: 22 },
      tooltip: { ...darkBase.tooltip, valueFormatter: (v: any) => `${v}${opt.yName ? ` ${opt.yName}` : ''}` },
      xAxis: { type: 'category', data: xs, ...axisStyle, boundaryGap: false },
      yAxis: { type: 'value', ...(opt.yMax ? { max: opt.yMax } : {}), name: opt.yName || '', ...axisStyle },
      series,
    };
  }, [xfmt]);

  const DB_METRICS: { key: typeof metric; label: string; pairs: { name: string; s: any; color: string }[]; opt: { yMax?: number; yName?: string } }[] = [
    { key: 'qps', label: 'QPS / TPS', pairs: [{ name: 'QPS', s: S.qps, color: '#38BDF8' }, { name: 'TPS', s: S.tps, color: '#F59E0B' }], opt: { yName: '/s' } },
    { key: 'conn', label: '连接 / 线程', pairs: [{ name: 'Threads_connected', s: S.conn, color: '#34D399' }, { name: 'Threads_running', s: S.running, color: '#F97316' }], opt: {} },
    { key: 'slow', label: '慢查询', pairs: [{ name: 'Slow_queries/s', s: S.slow, color: '#F87171' }], opt: { yName: '/s' } },
    { key: 'rows', label: 'InnoDB 行读写', pairs: [{ name: '行读/s', s: S.rows, color: '#38BDF8' }, { name: '行写/s', s: S.rowsWritten, color: '#A78BFA' }], opt: { yName: '/s' } },
    { key: 'bufhit', label: 'BP 命中率', pairs: [{ name: 'Buffer Pool 命中率', s: S.bufhit, color: '#22D3EE' }], opt: { yName: '%' } },
  ];
  const cur = DB_METRICS.find(x => x.key === metric) || DB_METRICS[0];
  const win = sd?.window || { from: Date.now() - 6 * 3600e3, to: Date.now(), range };

  // 状态变量 / 配置参数 过滤 + 分页
  const stVars = (d?.allStatusVars || []).filter((x: any) => !varQ || x.name.toLowerCase().includes(varQ.toLowerCase()));
  const cfgVars = (d?.allConfigVars || []).filter((x: any) => !varQ || x.name.toLowerCase().includes(varQ.toLowerCase()));
  const PAGE = 14;
  const stRows = tab === 'status' ? stVars.slice((stPage - 1) * PAGE, stPage * PAGE) : cfgVars.slice((cfgPage - 1) * PAGE, cfgPage * PAGE);

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)', zIndex: 50, display: 'flex', justifyContent: 'flex-end' }}>
      <div className="drawer-panel" onClick={e => e.stopPropagation()} style={{ width: 'min(920px, 96vw)', background: 'var(--bg-card)', borderLeft: '1px solid var(--hairline)', padding: 20, overflowY: 'auto' }}>
        {/* 头部 */}
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 14 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 16, fontWeight: 700 }}>{entity.name}</div>
            <div className="mono" style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>
              {prof.dbType || entity.dbType} · 集群 {prof.clusterName || entity.group} · 数据源 zCloud 北向API
              {d?.profile?.updatetime ? ` · 快照 ${prof.updatetime}` : ''}
            </div>
          </div>
          <span style={{ flex: 1 }} />
          <Badge sev={entity.availability} />
          <button className="btn" style={{ marginLeft: 10 }} onClick={reload}>重拉</button>
          <button className="btn" style={{ marginLeft: 6 }} onClick={onClose}>关闭</button>
        </div>

        {/* 核心指标卡 */}
        <div className="grid-3" style={{ gap: 10, marginBottom: 14 }}>
          <Metric label="状态" value={prof.dbState || entity.dbState || '—'} small
            color={entity.availability === 'healthy' ? 'var(--sev-healthy)' : entity.availability === 'critical' ? 'var(--sev-critical)' : 'var(--sev-warning)'} />
          <Metric label="角色" value={prof.dbRole || entity.dbRole || '—'} small
            color={prof.dbRole === 'master' ? '#38BDF8' : undefined} />
          <Metric label="版本" value={prof.version || entity.version || '—'} small />
          <Metric label="QPS" value={m.qps != null ? fmtNum(m.qps) : '（采样中）'} />
          <Metric label="TPS" value={m.tps != null ? fmtNum(m.tps) : '（采样中）'} />
          <Metric label="连接数" value={m.threads_connected != null ? `${m.threads_connected}${m.max_connections ? ` / ${m.max_connections}` : ''}` : '—'}
            color={m.conn_pct != null && m.conn_pct >= 80 ? 'var(--sev-warning)' : undefined} />
          <Metric label="活跃线程" value={m.threads_running ?? '—'} small />
          <Metric label="BP 命中率" value={d?.bpHitPct != null ? `${d.bpHitPct}%` : '—'} small />
          <Metric label="运行时长" value={fmtUptime(m.uptime_seconds)} small />
          <Metric label="慢查询(累计)" value={m.slow_queries_total ?? '—'} small
            color={m.slow_queries_total > 0 ? 'var(--sev-warning)' : undefined} />
          <Metric label="中断连接(累计)" value={m.aborted_connects ?? '—'} small />
          <Metric label="数据库数" value={(d?.databases || []).length || '—'} small />
        </div>

        {/* 实例档案 */}
        <div className="card" style={{ marginBottom: 12 }}>
          <div className="card-title">实例档案<span className="spacer" /><span style={{ fontSize: 10, color: 'var(--text-3)' }}>来自 zCloud getDbInfo / getCustomInfo 实时快照</span></div>
          <div className="kv-grid">
            <KV k="实例名" v={prof.instanceName} />
            <KV k="集群" v={prof.clusterName} />
            <KV k="主机" v={prof.hostname} />
            <KV k="地址" v={prof.hostIp ? `${prof.hostIp}:${prof.dbPort}` : ''} />
            <KV k="类型 / 版本" v={[prof.dbType, prof.version].filter(Boolean).join(' ')} />
            <KV k="角色" v={prof.dbRole} />
            <KV k="运行状态" v={prof.dbState} />
            <KV k="存储引擎" v={prof.defaultstorageengine} />
            <KV k="操作系统" v={prof.system} />
            <KV k="当前登录" v={prof.currentlogged} />
            <KV k="max_connections" v={d?.config?.max_connections} />
            <KV k="wait_timeout" v={d?.config?.wait_timeout} />
            <KV k="Buffer Pool" v={d?.config?.innodb_buffer_pool_size && fmtBytesGB(d.config.innodb_buffer_pool_size)} />
            <KV k="数据目录" v={d?.config?.datadir} wide />
            {entity.description && <KV k="备注" v={entity.description} wide />}
          </div>
          {(d?.databases || []).length > 0 && (
            <div style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {d.databases.map((x: string) => <span key={x} className="tag-chip">{x}</span>)}
            </div>
          )}
          {(d?.users || []).length > 0 && (
            <div className="mono" style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 8 }}>
              账号：{d.users.join('、')}
            </div>
          )}
        </div>

        {/* 趋势（本地真实采样差值） */}
        <div className="card" style={{ marginBottom: 12 }}>
          <div className="card-title" style={{ flexWrap: 'wrap', gap: 8 }}>
            运行趋势
            <span className="spacer" />
            <span className="seg">
              {DB_METRICS.map(x => (
                <button key={x.key} className={cur?.key === x.key ? 'on' : ''} onClick={() => setMetric(x.key)}>{x.label}</button>
              ))}
            </span>
            <span className="seg">
              {(['6h', '24h', '7d', '30d'] as const).map(r => (
                <button key={r} className={range === r ? 'on' : ''} onClick={() => setRange(r)}>
                  {r === '6h' ? '6小时' : r === '24h' ? '24小时' : r === '7d' ? '7天' : '30天'}
                </button>
              ))}
            </span>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-3)' }}>
              结束于
              <input type="datetime-local" value={tillStr} max={toLocalInput(Date.now())}
                style={{ background: 'var(--bg-inset)', border: '1px solid var(--hairline)', color: 'var(--text-1)', borderRadius: 'var(--radius-sm)', padding: '4px 6px', fontSize: 11, fontFamily: 'var(--ff-mono)', colorScheme: 'dark' }}
                onChange={e => setTillStr(e.target.value)} />
              {tillStr && <button className="btn" style={{ padding: '3px 8px', fontSize: 11 }} onClick={() => setTillStr('')}>回到现在</button>}
            </label>
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 10, color: 'var(--text-3)', margin: '2px 0 8px', alignItems: 'center' }}>
            <span>{fmtTime(win.from)} → {fmtTime(win.to)}</span>
            <span>· 粒度：北向API 采样（每 {sd?.sampleSec ?? 60}s 读一次真实计数器差值）</span>
            {sd?.samplesFrom && <span>· 本平台自 {fmtTime(sd.samplesFrom)} 起累计采样 {sd.sampleCount ?? (d?.sampleCount ?? '')} 点；更早历史需 zCloud :8093 Prometheus 账密</span>}
          </div>
          {cur && ((cur.pairs.some(p => (p.s?.avg?.length || 0) > 0))
            ? <Chart option={lineOpt(cur.pairs, cur.opt)} height={220} />
            : <div style={{ color: 'var(--text-3)', fontSize: 12 }}>该时间窗内尚无采样点（本平台按周期读取 zCloud 状态计数器后生成，最长等待一个采集周期；若该集群无快照数据则无曲线）</div>)}
        </div>

        {/* 状态变量 / 配置参数 / 快照概览 */}
        <div className="card" style={{ marginBottom: 12 }}>
          <div className="card-title">
            <span className={`tab-btn ${tab === 'status' ? 'on' : ''}`} onClick={() => { setTab('status'); setStPage(1); }}>状态变量（{stVars.length}）</span>
            <span className={`tab-btn ${tab === 'config' ? 'on' : ''}`} onClick={() => { setTab('config'); setCfgPage(1); }}>配置参数（{cfgVars.length}）</span>
            <span className="spacer" />
            <input placeholder="过滤变量名…" value={varQ}
              style={{ width: 160, background: 'var(--bg-inset)', border: '1px solid var(--hairline)', color: 'var(--text-1)', borderRadius: 'var(--radius-sm)', padding: '4px 8px', fontSize: 11, fontFamily: 'var(--ff-mono)' }}
              onChange={e => { setVarQ(e.target.value); setStPage(1); setCfgPage(1); }} />
          </div>
          <table className="data fixed nowrap">
            <colgroup><col style={{ width: '42%' }} /><col style={{ width: '58%' }} /></colgroup>
            <thead><tr><th>变量</th><th>值</th></tr></thead>
            <tbody>
              {stRows.map((x: any, i: number) => (
                <tr key={i}>
                  <td className="mono" style={{ fontSize: 11 }} title={x.name}>{x.name}</td>
                  <td className="mono" style={{ fontSize: 11, wordBreak: 'break-all' }} title={String(x.value)}>{String(x.value ?? '—')}</td>
                </tr>
              ))}
              {!stRows.length && <tr><td colSpan={2} className="empty-tip">{d ? '无匹配变量' : '加载中…（点「重拉」或等待下一个采集周期）'}</td></tr>}
            </tbody>
          </table>
          <Pager page={tab === 'status' ? stPage : cfgPage} size={PAGE} total={tab === 'status' ? stVars.length : cfgVars.length}
            onPage={tab === 'status' ? setStPage : setCfgPage} />
        </div>

        {/* 关联事件 */}
        <div className="card">
          <div className="card-title">关联事件</div>
          <div style={{ color: 'var(--text-3)', fontSize: 12 }}>
            zCloud 告警尚未接入本平台汇聚链路（可在 zCloud 告警通道配置推送 Zabbix 后自动归入）；实例状态变化：快照更新 {prof.updatetime || '—'}
          </div>
        </div>
      </div>
    </div>
  );
}

function fmtBytesGB(n: any): string {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (v >= 1024 ** (i + 1) && i < u.length - 1) i++;
  return `${(v / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}

function Metric({ label, value, small, color }: { label: string; value: any; small?: boolean; color?: string }) {
  return (
    <div className="card" style={{ padding: '10px 12px' }}>
      <div className="stat-label">{label}</div>
      <div className="mono" style={{ fontSize: small ? 14 : 18, fontWeight: 600, marginTop: 2, wordBreak: 'break-all', color }}>{value}</div>
    </div>
  );
}

function KV({ k, v, wide }: { k: string; v?: any; wide?: boolean }) {
  const s = v == null ? '' : String(v);
  return (
    <div className={wide ? 'kv wide' : 'kv'}>
      <span className="kv-k">{k}</span>
      <span className="kv-v mono" title={s}>{s || '—'}</span>
    </div>
  );
}

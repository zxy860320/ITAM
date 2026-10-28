import React from 'react';
import { api, usePoll } from '../api';
import { Chart, darkBase, axisStyle } from '../components/Chart';
import { Badge, Spark, fmtTime, ago, SEV_LABEL, DOM_COLOR } from '../components/common';

/** 监控大屏 —— 流式铺满视口，自适应任意屏幕尺寸（不再固定 1920×1080 缩放留黑边） */
export default function Dashboard() {
  const { data, err } = usePoll(api.dashboard, 10000);

  const [now, setNow] = React.useState(new Date());
  React.useEffect(() => { const t = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(t); }, []);
  const p = (n: number) => String(n).padStart(2, '0');

  const option = React.useMemo(() => {
    if (!data) return {};
    const hours = data.eventTrend.length;
    const xs = data.eventTrend.map((_: any, i: number) => `${p((now.getHours() - (hours - 1 - i) + 24) % 24)}:00`);
    return {
      ...darkBase,
      legend: { data: ['紧急', '严重', '警告', '信息'], textStyle: { color: '#A1A1AA', fontSize: 11 }, top: 0, right: 0, itemWidth: 10, itemHeight: 10 },
      xAxis: { type: 'category', data: xs, ...axisStyle, splitLine: { show: false } },
      yAxis: { type: 'value', ...axisStyle },
      series: [
        { name: '紧急', type: 'bar', stack: 's', data: data.eventTrend.map((b: any) => b.critical), itemStyle: { color: '#FF5252' } },
        { name: '严重', type: 'bar', stack: 's', data: data.eventTrend.map((b: any) => b.severe), itemStyle: { color: '#FF7F0E' } },
        { name: '警告', type: 'bar', stack: 's', data: data.eventTrend.map((b: any) => b.warning), itemStyle: { color: '#F2C94C' } },
        { name: '信息', type: 'bar', stack: 's', data: data.eventTrend.map((b: any) => b.info), itemStyle: { color: '#29B6F6' } },
      ],
    };
  }, [data, now.getMinutes()]);

  const donut = React.useMemo(() => {
    if (!data) return {};
    return {
      ...darkBase, grid: { top: 0, bottom: 0, left: 0, right: 0 },
      series: [{
        type: 'pie', radius: ['58%', '78%'], center: ['50%', '50%'],
        label: { show: false },
        data: [
          { name: '健康', value: data.domains.reduce((s: number, d: any) => s + d.healthy, 0), itemStyle: { color: '#4CAF50' } },
          { name: '警告', value: data.domains.reduce((s: number, d: any) => s + d.warning, 0), itemStyle: { color: '#F2C94C' } },
          { name: '异常', value: data.domains.reduce((s: number, d: any) => s + d.critical, 0), itemStyle: { color: '#FF5252' } },
        ],
      }],
    };
  }, [data]);

  return (
    <div style={{ width: '100vw', height: '100vh', background: 'var(--bg-page)', overflow: 'hidden', display: 'flex', flexDirection: 'column', padding: '14px clamp(16px, 2vw, 40px)', gap: 14 }}>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 14, minHeight: 0, minWidth: 0 }}>
        {/* 大屏标题栏 */}
        <div style={{ display: 'flex', alignItems: 'center', height: 56, borderBottom: '1px solid var(--hairline)' }}>
          <a href="#/server" style={{ color: 'var(--text-3)', textDecoration: 'none', fontSize: 13 }}>← 控制台</a>
          <div style={{ flex: 1, textAlign: 'center' }}>
            <div style={{ fontSize: 26, fontWeight: 700, letterSpacing: 6 }}>IT 运维监控大屏</div>
          </div>
          <div style={{ fontFamily: 'var(--ff-mono)', color: 'var(--text-2)', fontSize: 15, width: 300, textAlign: 'right' }}>
            {now.getFullYear()}-{p(now.getMonth() + 1)}-{p(now.getDate())} {p(now.getHours())}:{p(now.getMinutes())}:{p(now.getSeconds())}
          </div>
        </div>

        {err && !data && <div style={{ color: 'var(--sev-critical)', padding: 20 }}>数据源连接中…（请确认后端 :8787 已启动）</div>}
        {data && (<>
          {/* KPI 行 */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14 }}>
            <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
              <Chart option={donut} height={92} />
              <div>
                <div className="stat-num">{data.totals.hosts}</div>
                <div className="stat-label">监控对象（主机 318 + 服务 36）</div>
              </div>
              <div style={{ marginLeft: 'auto', display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12 }}>
                {data.domains.map((d: any) => (
                  <span key={d.domain} style={{ color: 'var(--text-2)' }}>
                    <i style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: DOM_COLOR[d.domain], marginRight: 6 }} />
                    {d.label} <b className="mono" style={{ color: 'var(--text-1)' }}>{d.total}</b>
                  </span>
                ))}
              </div>
            </div>
            <div className="card">
              <div className="stat-num" style={{ color: 'var(--sev-critical)' }}>{data.severity.critical + data.severity.severe}</div>
              <div className="stat-label">活动告警（紧急+严重）</div>
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                {(['critical', 'severe', 'warning', 'info'] as const).map(s => (
                  <span key={s} className={`badge ${s}`}><i className="bdot" />{data.severity[s]}</span>
                ))}
              </div>
            </div>
            <div className="card">
              <div className="stat-num">{data.totals.items.toLocaleString()}</div>
              <div className="stat-label">监控项 · 采集频率 60s · Zabbix 7.2.5</div>
              <div className="sync-meta" style={{ marginTop: 10 }}>
                最近同步 {data.collector ? fmtTime(data.collector.lastSync) : '—'}{data.collector ? ` · 第 ${data.collector.syncCount} 轮` : ''}
              </div>
            </div>
            <div className="card">
              <div className="stat-num" style={{ color: 'var(--sev-healthy)' }}>{data.totals.avgAvail}%</div>
              <div className="stat-label">整体可用性（近 24h）</div>
              <div style={{ marginTop: 10 }}>
                <Spark data={[99.9, 99.8, 99.95, 99.7, 99.9, 99.95, 99.6, 99.85, 99.95, 99.9]} w={200} h={28} color="#4CAF50" />
              </div>
            </div>
          </div>

          {/* 中部三栏 */}
          <div style={{ display: 'grid', gridTemplateColumns: 'clamp(260px, 26%, 500px) minmax(0, 1fr) clamp(260px, 26%, 500px)', gap: 14, flex: 1, minHeight: 0 }}>
            {/* 左：四域健康 */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {data.domains.map((d: any) => (
                <div className="card" key={d.domain} style={{ flex: 1 }}>
                  <div className="card-title">
                    <i style={{ width: 8, height: 8, borderRadius: 2, background: DOM_COLOR[d.domain] }} />
                    {d.label}监控
                    <span className="spacer" />
                    <a href={`#/${d.domain}`} style={{ color: 'var(--text-3)', fontSize: 11, textDecoration: 'none' }}>详情 →</a>
                  </div>
                  <div style={{ display: 'flex', gap: 6, height: 12, borderRadius: 3, overflow: 'hidden' }}>
                    <i style={{ flex: d.healthy, background: 'var(--sev-healthy)' }} />
                    <i style={{ flex: d.warning, background: 'var(--sev-warning)' }} />
                    <i style={{ flex: d.critical, background: 'var(--sev-critical)' }} />
                  </div>
                  <div className="mono" style={{ display: 'flex', gap: 16, marginTop: 8, fontSize: 12, color: 'var(--text-2)' }}>
                    <span>总数 <b style={{ color: 'var(--text-1)' }}>{d.total}</b></span>
                    <span style={{ color: 'var(--sev-healthy)' }}>{d.healthy}</span>
                    <span style={{ color: 'var(--sev-warning)' }}>{d.warning}</span>
                    <span style={{ color: 'var(--sev-critical)' }}>{d.critical}</span>
                  </div>
                </div>
              ))}
            </div>

            {/* 中：24h 告警趋势 + TOP */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0 }}>
              <div className="card" style={{ flex: 1.2, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                <div className="card-title">近 24 小时告警趋势</div>
                <div style={{ flex: 1, minHeight: 80 }}>
                  <Chart option={option} height="100%" />
                </div>
              </div>
              <div className="grid-2" style={{ flex: 1 }}>
                <div className="card">
                  <div className="card-title">CPU 使用率 TOP（服务器）</div>
                  {data.topCpu.map((h: any) => (
                    <div key={h.name} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4.5px 0', fontSize: 12 }}>
                      <span className="mono" style={{ width: 118, color: 'var(--text-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.name}</span>
                      <span className="meter" style={{ flex: 1 }}><i style={{ width: `${h.cpu}%`, background: h.cpu >= 90 ? 'var(--sev-critical)' : h.cpu >= 80 ? 'var(--sev-warning)' : 'var(--dom-server)' }} /></span>
                      <span className="mono" style={{ width: 44, textAlign: 'right', color: h.cpu >= 90 ? 'var(--sev-critical)' : 'var(--text-1)' }}>{h.cpu}%</span>
                    </div>
                  ))}
                </div>
                <div className="card">
                  <div className="card-title">响应时间 TOP（服务）</div>
                  {data.topRt.map((s: any) => (
                    <div key={s.name} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4.5px 0', fontSize: 12 }}>
                      <span style={{ width: 92, color: 'var(--text-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
                      <span className="meter" style={{ flex: 1 }}><i style={{ width: `${Math.min(s.rt / 6, 100)}%`, background: s.rt > 400 ? 'var(--sev-warning)' : 'var(--dom-service)' }} /></span>
                      <span className="mono" style={{ width: 56, textAlign: 'right' }}>{s.rt}ms</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* 右：TOP告警 + 实时事件流 */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0 }}>
              <div className="card" style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
                <div className="card-title">当前最高优先级告警</div>
                {data.topProblems.slice(0, 6).map((e: any) => (
                  <div key={e.eventid} className="ev-row">
                    <Badge sev={e.severity} />
                    <span className="ev-msg" title={e.message}><b>{e.object}</b> · {e.message}</span>
                    <span className="ev-time">{ago(e.clock)}</span>
                  </div>
                ))}
              </div>
              <div className="card" style={{ flex: 1.2, minHeight: 0, overflow: 'hidden' }}>
                <div className="card-title">实时事件流<span className="spacer" /><span className="badge healthy"><i className="bdot" />LIVE</span></div>
                <div style={{ overflow: 'hidden' }}>
                  {data.recent.slice(0, 13).map((e: any) => (
                    <div key={e.eventid} className="ev-row">
                      <span className="ev-time">{fmtTime(e.clock)}</span>
                      <span className="ev-msg" title={e.message}>{e.message}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </>)}
      </div>
    </div>
  );
}

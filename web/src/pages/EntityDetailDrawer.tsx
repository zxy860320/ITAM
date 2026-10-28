import React from 'react';
import { api, usePoll } from '../api';
import { Badge, Pager, fmtTime, ago, DOM_COLOR } from '../components/common';
import { Chart, darkBase, axisStyle } from '../components/Chart';

/* ---------- 格式化 ---------- */
function fmtBytes(n: any): string {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (v >= 1024 ** (i + 1) && i < u.length - 1) { i++; }
  return `${(v / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}
function fmtBps(n: any): string {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '—';
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)} Gb/s`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)} Mb/s`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)} Kb/s`;
  return `${v.toFixed(0)} b/s`;
}
function fmtNum(n: any, d = 2): string {
  const v = Number(n);
  return Number.isFinite(v) ? +v.toFixed(d) + '' : '—';
}
/** Date → datetime-local 输入框格式（本地时区） */
function toLocalInput(ts: number): string {
  const d = new Date(ts), p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 设备深度详情抽屉：点开设备时按需从 Zabbix 实时拉取——
 * 设备档案（型号/序列号/固件/软件版本/位置）、ICMP 可达性、
 * 近 6h CPU/内存/时延趋势、网络接口表、全部监控项、带标签的关联事件。
 */
export default function EntityDetailDrawer({ entity, onClose }: { entity: any; onClose: () => void }) {
  const id = entity.hostid || entity.serviceid;
  const { data } = usePoll(() => api.entity(id), 60000, id);
  const { data: d, reload } = usePoll(() => api.entityDetail(id).then(r => r.detail), 120000, id);
  const [tab, setTab] = React.useState<'ifs' | 'items'>('ifs');
  const [ifPage, setIfPage] = React.useState(1);
  const [itemPage, setItemPage] = React.useState(1);

  // —— 时间窗：6h/24h 走 history 原始；7d/30d 走 trend 小时聚合；tillStr 可回看过去某段 ——
  const [range, setRange] = React.useState<'6h' | '24h' | '7d' | '30d'>('6h');
  const [tillStr, setTillStr] = React.useState(''); // datetime-local，'' = 现在
  const tillEpoch = tillStr ? Math.floor(new Date(tillStr).getTime() / 1000) : 0;
  const [metric, setMetric] = React.useState<'res' | 'temp' | 'load' | 'proc' | 'fs' | 'dio' | 'traffic' | 'ping'>('res');
  const [iface, setIface] = React.useState(''); // 流量接口（'' = 后端自动选活跃口）
  const [dev, setDev] = React.useState('');     // 磁盘设备（'' = 后端自动选最活跃盘）
  const [mnt, setMnt] = React.useState('');     // 磁盘分区挂载点（'' = 后端自动选根分区）
  const { data: sd } = usePoll(
    () => api.entitySeries(id, { range, till: tillEpoch, iface, dev, mnt }).then(r => r.series),
    120000, `${id}|${range}|${tillEpoch}|${iface}|${dev}|${mnt}`,
  );

  React.useEffect(() => {
    const f = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    addEventListener('keydown', f); return () => removeEventListener('keydown', f);
  }, [onClose]);

  const prof = d?.profile || {};
  const netIfs = d?.netIfs || [];
  const items = d?.items || [];
  const events = data?.events || [];
  const color = DOM_COLOR[entity.domain];

  // —— 趋势数据（来自 series 接口，一次返回全部指标）——
  const S: any = sd?.series || {};
  const grain = sd?.grain === 'hour';
  const win = sd?.window || { from: Date.now() - 6 * 3600e3, to: Date.now(), range };
  const ifaces: { iface: string; label: string }[] = sd?.ifaces || [];
  const has = (k: string) => (S[k]?.avg?.length || 0) > 0;
  const trafficOn = (S.traffic?.in?.avg?.length || 0) > 0 || (S.traffic?.out?.avg?.length || 0) > 0;
  const dioOn = (S.dio?.read?.avg?.length || 0) > 0 || (S.dio?.write?.avg?.length || 0) > 0;
  const devs: { dev: string }[] = sd?.devs || [];
  const mnts: { mnt: string; label: string; cur: number }[] = sd?.mnts || [];
  const fsLabel = mnt ? (mnts.find(x => x.mnt === mnt)?.label || `磁盘使用 [${mnt}]`) : (sd?.meta?.fs?.label || '磁盘使用');

  // x 轴标签按窗口自适应
  const xfmt = React.useCallback((t: number) => {
    const dt = new Date(t), p = (n: number) => String(n).padStart(2, '0');
    if (range === '6h' || range === '24h') return `${p(dt.getHours())}:${p(dt.getMinutes())}`;
    if (range === '7d') return `${p(dt.getMonth() + 1)}-${p(dt.getDate())} ${p(dt.getHours())}h`;
    return `${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
  }, [range]);

  /**
   * 通用趋势 option：pairs = [{ name, s, color }]，s 为该指标序列（avg / 可选 max,min 包络）。
   * yMax 用于百分比类固定 0~100；div/suf 对数值做换算（如秒→ms、bps→Mb/s）。
   */
  const lineOpt = React.useCallback((pairs: { name: string; s: any; color: string }[], opt: { yMax?: number; yName?: string; div?: number; scaleAuto?: boolean } = {}) => {
    const div = opt.div || 1;
    // 自适应量级（流量 bps → 自动 Mb/s）：取全部点最大值定一档
    let unit = '', uDiv = 1;
    if (opt.scaleAuto) {
      let mx = 0;
      for (const p of pairs) for (const pt of (p.s.avg || [])) mx = Math.max(mx, Math.abs(pt.v));
      if (mx >= 1e9) { unit = ' Gb/s'; uDiv = 1e9; } else if (mx >= 1e6) { unit = ' Mb/s'; uDiv = 1e6; }
      else if (mx >= 1e3) { unit = ' Kb/s'; uDiv = 1e3; } else { unit = ' b/s'; uDiv = 1; }
    }
    const cv = (v: number) => +(v / div / uDiv).toFixed(2);
    const anyXs = pairs.map(p => (p.s.avg || [])).sort((a, b) => b.length - a.length)[0] || [];
    const xs = anyXs.map((pt: any) => xfmt(pt.t));
    const series: any[] = [];
    for (const p of pairs) {
      if (p.s.max && p.s.min) {
        series.push({ name: p.name + '·min', type: 'line', stack: p.name, data: p.s.min.map(cv), lineStyle: { opacity: 0 }, areaStyle: { opacity: 0.07, color: p.color }, symbol: 'none', silent: true, tooltip: { show: false } });
        series.push({ name: p.name + '·band', type: 'line', stack: p.name, data: p.s.max.map((v: number, i: number) => cv(v - p.s.min[i])), lineStyle: { opacity: 0 }, areaStyle: { opacity: 0.07, color: p.color }, symbol: 'none', silent: true, tooltip: { show: false } });
      }
      series.push({ name: p.name, type: 'line', data: (p.s.avg || []).map((pt: any) => cv(pt.v)), smooth: true, symbol: 'none', lineStyle: { width: 1.6, color: p.color }, ...(p.s.max ? {} : { areaStyle: { opacity: 0.08, color: p.color } }) });
    }
    return {
      ...darkBase,
      legend: pairs.length > 1 ? { data: pairs.map(p => p.name), textStyle: { color: '#A1A1AA', fontSize: 11 }, top: 2, right: 4 } : undefined,
      grid: { left: 48, right: 14, top: pairs.length > 1 ? 26 : 18, bottom: 22 },
      tooltip: { ...darkBase.tooltip, valueFormatter: (v: any) => `${v}${unit || (opt.yName ? ` ${opt.yName}` : '')}` },
      xAxis: { type: 'category', data: xs, ...axisStyle, boundaryGap: false },
      yAxis: { type: 'value', ...(opt.yMax ? { max: opt.yMax } : {}), name: unit.trim() || opt.yName || '', ...(opt.yMax ? {} : {}), ...axisStyle },
      series,
    };
  }, [xfmt]);

  const METRICS: { key: typeof metric; label: string; show: boolean; pairs: { name: string; s: any; color: string }[]; opt: Parameters<typeof lineOpt>[1]; empty: string }[] = [
    { key: 'res', label: 'CPU / 内存', show: true, pairs: [{ name: 'CPU', s: S.cpu || {}, color }, { name: '内存', s: S.mem || {}, color: '#F59E0B' }], opt: { yMax: 100, yName: '%' }, empty: '该设备无 CPU/内存监控项' },
    { key: 'temp', label: '温度', show: has('temp'), pairs: [{ name: '温度', s: S.temp || {}, color: '#F97316' }], opt: { yName: '°C' }, empty: '无温度传感器' },
    { key: 'load', label: '负载', show: has('load'), pairs: [{ name: 'Load (5m)', s: S.load || {}, color: '#A78BFA' }], opt: {}, empty: '无负载监控项' },
    { key: 'proc', label: '进程数', show: has('proc'), pairs: [{ name: '进程数', s: S.proc || {}, color: '#38BDF8' }], opt: {}, empty: '无进程数监控项' },
    { key: 'fs', label: '磁盘使用', show: has('fs'), pairs: [{ name: fsLabel, s: S.fs || {}, color: '#34D399' }], opt: { yMax: 100, yName: '%' }, empty: '无磁盘使用率监控项' },
    { key: 'dio', label: '磁盘 I/O', show: dioOn, pairs: [{ name: '读', s: S.dio?.read || {}, color: '#38BDF8' }, { name: '写', s: S.dio?.write || {}, color: '#F59E0B' }], opt: { yName: 'ops/s' }, empty: '无磁盘 I/O 监控项（vfs.dev.read/write.rate）' },
    { key: 'traffic', label: '接口流量', show: trafficOn, pairs: [{ name: '接收', s: S.traffic?.in || {}, color }, { name: '发送', s: S.traffic?.out || {}, color: '#F59E0B' }], opt: { scaleAuto: true }, empty: '无接口流量监控项' },
    { key: 'ping', label: 'ICMP 时延', show: has('ping'), pairs: [{ name: 'ICMP 时延', s: S.ping || {}, color: '#22D3EE' }], opt: { div: 1e-3, yName: 'ms' }, empty: '无 ICMP 监控项' },
  ];
  const shown = METRICS.filter(m => m.show);
  const cur = shown.find(m => m.key === metric) || shown[0];

  const ifRows = netIfs.slice((ifPage - 1) * 10, ifPage * 10);
  const itemRows = items.slice((itemPage - 1) * 12, itemPage * 12);

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)', zIndex: 50, display: 'flex', justifyContent: 'flex-end' }}>
      <div className="drawer-panel" onClick={e => e.stopPropagation()} style={{ width: 'min(920px, 96vw)', background: 'var(--bg-card)', borderLeft: '1px solid var(--hairline)', padding: 20, overflowY: 'auto' }}>
        {/* 头部 */}
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 14 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 16, fontWeight: 700 }}>{entity.name}</div>
            <div className="mono" style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>
              {entity.ip || '—'} · {entity.group || ''} {prof.model ? ` · ${prof.model}` : ''}
            </div>
          </div>
          <span style={{ flex: 1 }} />
          {entity.ping === false && <Badge sev="critical" />}
          <Badge sev={entity.availability} />
          <button className="btn" style={{ marginLeft: 10 }} onClick={reload}>重拉</button>
          <button className="btn" style={{ marginLeft: 6 }} onClick={onClose}>关闭</button>
        </div>

        {/* 核心指标 */}
        <div className="grid-3" style={{ gap: 10, marginBottom: 14 }}>
          <Metric label="CPU" value={entity.cpu == null ? '—' : `${entity.cpu}%`} />
          <Metric label="内存" value={entity.mem == null ? '—' : `${entity.mem}%`} />
          <Metric label="磁盘使用" value={entity.disk == null ? '—' : `${entity.disk}%`} />
          <Metric label="ICMP 可达" value={entity.ping == null ? '—' : entity.ping ? '在线' : '不可达'} small
            color={entity.ping == null ? undefined : entity.ping ? 'var(--sev-healthy)' : 'var(--sev-critical)'} />
          <Metric label="ICMP 时延" value={entity.pingMs == null ? '—' : `${entity.pingMs} ms`} small />
          <Metric label="丢包率" value={entity.pingLoss == null ? '—' : `${entity.pingLoss}%`} small
            color={entity.pingLoss ? 'var(--sev-warning)' : undefined} />
          <Metric label="设备温度" value={entity.temp == null ? '—' : `${entity.temp} °C`} small />
          <Metric label="在线时长" value={entity.uptimeDays != null ? `${entity.uptimeDays} 天` : entity.status === 'off' ? '离线' : '—'} small />
          <Metric label="监控项" value={d ? `${d.itemCount} 个` : '…'} small />
        </div>

        {/* 设备档案 */}
        <div className="card" style={{ marginBottom: 12 }}>
          <div className="card-title">设备档案<span className="spacer" /><span style={{ fontSize: 10, color: 'var(--text-3)' }}>来自 Zabbix system.* 监控项与主机接口</span></div>
          <div className="kv-grid">
            <KV k="设备型号" v={prof.model} />
            <KV k="软件版本" v={prof.swOs} />
            <KV k="硬件版本" v={prof.hwVersion} />
            <KV k="固件版本" v={prof.firmware} />
            <KV k="序列号" v={prof.serial} />
            <KV k="位置" v={prof.location} />
            <KV k="维护联系人" v={prof.contact} />
            <KV k="内核 / 架构" v={[prof.uname, prof.arch].filter(Boolean).join(' · ')} />
            <KV k="CPU 核数" v={prof.cpuNum} />
            <KV k="内存总量" v={prof.memTotal && fmtBytes(prof.memTotal)} />
            <KV k="可用内存" v={prof.memAvail && fmtBytes(prof.memAvail)} />
            <KV k="进程数" v={prof.processes} />
            {entity.description && <KV k="主机备注" v={entity.description} />}
            {prof.descr && <KV k="系统描述" v={prof.descr} wide />}
          </div>
          {(d?.interfaces || []).length > 0 && (
            <div style={{ marginTop: 10 }}>
              {d.interfaces.map((i: any, idx: number) => (
                <div key={idx} className="mono" style={{ fontSize: 11, color: 'var(--text-2)', padding: '3px 0' }}>
                  <span style={{ color: i.available === 1 ? 'var(--sev-healthy)' : 'var(--sev-critical)' }}>●</span>
                  {' '}{i.type === 2 ? 'SNMP' : i.type === 1 ? 'Agent' : 'IPMI'} {i.useip === 1 ? i.ip : i.dns}:{i.port}
                  {i.available === 1 ? ' 采集正常' : ` 采集异常 ${i.error || ''}`}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 趋势：指标切换 + 时间窗 + 历史回看 */}
        <div className="card" style={{ marginBottom: 12 }}>
          <div className="card-title" style={{ flexWrap: 'wrap', gap: 8 }}>
            运行趋势
            <span className="spacer" />
            {shown.length > 2 ? (
              <select value={cur?.key} onChange={e => setMetric(e.target.value as any)}
                className="mono" style={{ background: 'var(--bg-inset)', border: '1px solid var(--hairline)', color: 'var(--text-1)', borderRadius: 'var(--radius-sm)', padding: '4px 8px', fontSize: 11, colorScheme: 'dark' }}>
                {shown.map(m => <option key={m.key} value={m.key}>{m.label}</option>)}
              </select>
            ) : (
              <span className="seg">
                {shown.map(m => (
                  <button key={m.key} className={cur?.key === m.key ? 'on' : ''} onClick={() => setMetric(m.key)}>{m.label}</button>
                ))}
              </span>
            )}
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
            <span>· 粒度：{grain ? '小时聚合（平均线 + min~max 包络）' : '原始采集（分钟级）'}</span>
            {sd?.retention?.history && <span>· 原始保留 {sd.retention.history} / 聚合保留 {sd.retention.trends}</span>}
            {cur?.key === 'traffic' && ifaces.length > 0 && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
                接口
                <select value={iface} onChange={e => setIface(e.target.value)}
                  className="mono" style={{ background: 'var(--bg-inset)', border: '1px solid var(--hairline)', color: 'var(--text-1)', borderRadius: 'var(--radius-sm)', padding: '3px 6px', fontSize: 10, colorScheme: 'dark', maxWidth: 260 }}>
                  <option value="">自动（活跃口）{S.traffic?.label ? ` · 当前 ${S.traffic.label}` : ''}</option>
                  {ifaces.map(x => <option key={x.iface} value={x.iface}>{x.label}</option>)}
                </select>
              </label>
            )}
            {cur?.key === 'dio' && devs.length > 0 && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
                磁盘
                <select value={dev} onChange={e => setDev(e.target.value)}
                  className="mono" style={{ background: 'var(--bg-inset)', border: '1px solid var(--hairline)', color: 'var(--text-1)', borderRadius: 'var(--radius-sm)', padding: '3px 6px', fontSize: 10, colorScheme: 'dark', maxWidth: 260 }}>
                  <option value="">自动（活跃盘）{S.dio?.dev ? ` · 当前 ${S.dio.dev}` : ''}</option>
                  {devs.map(x => <option key={x.dev} value={x.dev}>{x.dev}</option>)}
                </select>
              </label>
            )}
            {cur?.key === 'fs' && mnts.length > 0 && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
                分区
                <select value={mnt} onChange={e => setMnt(e.target.value)}
                  className="mono" style={{ background: 'var(--bg-inset)', border: '1px solid var(--hairline)', color: 'var(--text-1)', borderRadius: 'var(--radius-sm)', padding: '3px 6px', fontSize: 10, colorScheme: 'dark', maxWidth: 300 }}>
                  <option value="">自动（根分区）{sd?.meta?.fs?.mnt ? ` · 当前 ${sd.meta.fs.mnt}` : ''}</option>
                  {mnts.map(x => <option key={x.mnt} value={x.mnt}>{x.mnt}（现值 {x.cur}%）</option>)}
                </select>
              </label>
            )}
          </div>
          {cur && (cur.pairs.some(p => (p.s.avg?.length || 0) > 0)
            ? <Chart option={lineOpt(cur.pairs, cur.opt)} height={220} />
            : <div style={{ color: 'var(--text-3)', fontSize: 12 }}>该时间窗内无数据（可能超出 Zabbix 历史保留期，或{cur.empty}）</div>)}
        </div>

        {/* 接口 / 监控项 切换表 */}
        <div className="card" style={{ marginBottom: 12 }}>
          <div className="card-title">
            <span className={`tab-btn ${tab === 'ifs' ? 'on' : ''}`} onClick={() => { setTab('ifs'); setIfPage(1); }}>网络接口（{netIfs.length}）</span>
            <span className={`tab-btn ${tab === 'items' ? 'on' : ''}`} onClick={() => { setTab('items'); setItemPage(1); }}>全部监控项（{items.length}）</span>
          </div>
          {tab === 'ifs' ? (
            netIfs.length ? (
              <table className="data fixed nowrap">
                <colgroup>
                  <col style={{ width: '30%' }} /><col style={{ width: '10%' }} /><col style={{ width: '14%' }} />
                  <col style={{ width: '14%' }} /><col style={{ width: '12%' }} /><col style={{ width: '10%' }} /><col style={{ width: '10%' }} />
                </colgroup>
                <thead><tr><th>接口</th><th>状态</th><th>协商速率</th><th className="num">接收</th><th className="num">发送</th><th className="num">错包</th><th className="num">丢弃</th></tr></thead>
                <tbody>
                  {ifRows.map((x: any, i: number) => (
                    <tr key={i}>
                      <td title={x.name}>{x.name}</td>
                      <td><span style={{ color: x.status === 1 ? 'var(--sev-healthy)' : x.status === 2 ? 'var(--sev-critical)' : 'var(--text-3)' }}>{x.status === 1 ? 'up' : x.status === 2 ? 'down' : '—'}</span></td>
                      <td className="mono" style={{ fontSize: 11 }}>{fmtBps(x.speed)}</td>
                      <td className="mono num" style={{ fontSize: 11 }}>{fmtBps(x.in)}</td>
                      <td className="mono num" style={{ fontSize: 11 }}>{fmtBps(x.out)}</td>
                      <td className="mono num" style={{ fontSize: 11, color: (x.inErr || x.outErr) ? 'var(--sev-warning)' : 'var(--text-3)' }}>{(x.inErr || 0) + (x.outErr || 0)}</td>
                      <td className="mono num" style={{ fontSize: 11, color: (x.inDsc || x.outDsc) ? 'var(--sev-warning)' : 'var(--text-3)' }}>{(x.inDsc || 0) + (x.outDsc || 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <div style={{ color: 'var(--text-3)', fontSize: 12 }}>该设备未配置网络接口监控项</div>
          ) : (
            <table className="data fixed nowrap">
              <colgroup><col style={{ width: '40%' }} /><col style={{ width: '26%' }} /><col style={{ width: '18%' }} /><col style={{ width: '16%' }} /></colgroup>
              <thead><tr><th>监控项</th><th>现值</th><th className="num">单位</th><th className="num">最近更新</th></tr></thead>
              <tbody>
                {itemRows.map((it: any, i: number) => (
                  <tr key={i}>
                    <td title={`${it.name}\n${it.key}`}>{it.name}</td>
                    <td className="mono" style={{ fontSize: 11 }} title={it.value}>{(+it.valueType === 0 && Number.isFinite(+it.value)) ? fmtNum(it.value) : (it.value || '—')}</td>
                    <td className="mono num" style={{ fontSize: 11, color: 'var(--text-3)' }}>{it.units || '—'}</td>
                    <td className="num" style={{ fontSize: 11, color: 'var(--text-3)' }}>{ago(it.lastclock)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {tab === 'ifs'
            ? <Pager page={ifPage} size={10} total={netIfs.length} onPage={setIfPage} />
            : <Pager page={itemPage} size={12} total={items.length} onPage={setItemPage} />}
        </div>

        {/* 关联事件 */}
        <div className="card">
          <div className="card-title">关联事件（最近 {events.length} 条）</div>
          {events.map((e: any) => (
            <div key={e.eventid} className="ev-row">
              <span className="ev-time">{fmtTime(e.clock)}</span>
              <Badge sev={e.severity} />
              <span className="ev-msg" title={e.message}>{e.message}</span>
              {(e.tags || []).map((t: string) => <span key={t} className="tag-chip">{t}</span>)}
            </div>
          ))}
          {!events.length && <div style={{ color: 'var(--text-3)', fontSize: 12 }}>该对象近期无事件</div>}
        </div>
      </div>
    </div>
  );
}

function Metric({ label, value, small, color }: { label: string; value: any; small?: boolean; color?: string }) {
  return (
    <div className="card" style={{ padding: '10px 12px' }}>
      <div className="stat-label">{label}</div>
      <div className="mono" style={{ fontSize: small ? 14 : 18, fontWeight: 600, marginTop: 2, wordBreak: 'break-all', color }}>{value}</div>
    </div>
  );
}

function KV({ k, v, wide }: { k: string; v?: string; wide?: boolean }) {
  return (
    <div className={wide ? 'kv wide' : 'kv'}>
      <span className="kv-k">{k}</span>
      <span className="kv-v mono" title={v || ''}>{v || '—'}</span>
    </div>
  );
}

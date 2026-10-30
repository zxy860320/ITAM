import React from 'react';

export const SEV_LABEL: Record<string, string> = { critical: '紧急', severe: '严重', warning: '警告', info: '信息', healthy: '健康' };
export const DOM_COLOR: Record<string, string> = { server: 'var(--dom-server)', database: 'var(--dom-database)', network: 'var(--dom-network)', wlan: 'var(--dom-wlan)', service: 'var(--dom-service)' };
export const DOM_LABEL: Record<string, string> = { server: '服务器', database: '数据库', network: '网络设备', service: '服务' };

export function Badge({ sev }: { sev: string }) {
  return <span className={`badge ${sev}`}><i className="bdot" />{SEV_LABEL[sev] || sev}</span>;
}

/** 等宽火花线（纯 SVG，无依赖） */
export function Spark({ data, w = 90, h = 22, color = 'var(--dom-server)' }: { data: number[]; w?: number; h?: number; color?: string }) {
  if (!data?.length) return <span style={{ color: 'var(--text-3)' }}>—</span>;
  const max = Math.max(...data, 1), min = Math.min(...data);
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * w},${h - 2 - ((v - min) / (max - min || 1)) * (h - 4)}`).join(' ');
  return (
    <svg width={w} height={h} style={{ display: 'inline-block', verticalAlign: 'middle' }}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.4" />
    </svg>
  );
}

export function Meter({ value, color }: { value: number; color?: string }) {
  const c = color || (value >= 90 ? 'var(--sev-critical)' : value >= 80 ? 'var(--sev-warning)' : 'var(--sev-healthy)');
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span className="meter" style={{ flex: 1, minWidth: 28, width: 'auto' }}><i style={{ width: `${Math.min(value, 100)}%`, background: c }} /></span>
      <span className="mono" style={{ fontSize: 12, color: 'var(--text-2)', minWidth: 34, textAlign: 'right' }}>{value}%</span>
    </span>
  );
}

export function fmtTime(ts: number) {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
export function ago(ts: number) {
  const m = Math.max(0, Math.floor((Date.now() - ts) / 60000));
  if (m < 60) return `${m}分钟前`;
  if (m < 1440) return `${Math.floor(m / 60)}小时前`;
  return `${Math.floor(m / 1440)}天前`;
}

/** 分页页码序列：首尾恒显，当前页 ±1，缺口用 … 占位 */
function pageSeq(page: number, pages: number): (number | '…')[] {
  const keep = new Set<number>([1, pages, page - 1, page, page + 1]);
  const out: (number | '…')[] = [];
  let prev = 0;
  for (let i = 1; i <= pages; i++) {
    if (!keep.has(i)) continue;
    if (i - prev > 1) out.push('…');
    out.push(i);
    prev = i;
  }
  return out;
}

/** 通用分页表格容器 */
export function Pager({ page, size, total, onPage }: { page: number; size: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / size));
  return (
    <div className="table-foot">
      <span>共 {total} 条 · 第 {page}/{pages} 页</span>
      <span className="spacer" style={{ flex: 1 }} />
      <span className="pager">
        <button disabled={page <= 1} onClick={() => onPage(page - 1)}>‹</button>
        {pageSeq(page, pages).map((p, i) => p === '…'
          ? <span key={'gap' + i} className="pgap">…</span>
          : <button key={p} className={p === page ? 'cur' : ''} onClick={() => onPage(p)}>{p}</button>)}
        <button disabled={page >= pages} onClick={() => onPage(page + 1)}>›</button>
      </span>
    </div>
  );
}

export function useNow(ms = 1000) {
  const [now, setNow] = React.useState(() => new Date());
  React.useEffect(() => { const t = setInterval(() => setNow(new Date()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}

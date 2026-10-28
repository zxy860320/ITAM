import React from 'react';

const BASE = '/api';

async function get<T = any>(path: string): Promise<T> {
  const r = await fetch(BASE + path);
  if (!r.ok) throw new Error(`${path} -> ${r.status}`);
  return r.json();
}
async function post<T = any>(path: string, body?: any): Promise<T> {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    // 带上服务端 JSON 错误体（如"通道不存在"），否则界面只能看到裸状态码
    const j = await r.json().catch(() => ({} as any));
    throw new Error(j?.error || `${path} -> ${r.status}`);
  }
  return r.json();
}

export const api = {
  summary: () => get('/summary'),  dashboard: () => get('/dashboard'),
  entities: (qs: Record<string, any>) =>
    get('/entities?' + new URLSearchParams(Object.entries(qs).filter(([, v]) => v !== '' && v != null).map(([k, v]) => [k, String(v)]))),
  entity: (id: string) => get(`/entities/${id}`),
  entityDetail: (id: string) => get(`/entities/${id}/detail`),
  entitySeries: (id: string, qs: Record<string, any>) =>
    get(`/entities/${id}/series?` + new URLSearchParams(Object.entries(qs).filter(([, v]) => v !== '' && v != null).map(([k, v]) => [k, String(v)]))),
  events: (qs: Record<string, any>) =>
    get('/events?' + new URLSearchParams(Object.entries(qs).filter(([, v]) => v !== '' && v != null).map(([k, v]) => [k, String(v)]))),
  ack: (id: string, user: string) => post(`/events/${id}/ack`, { user }),
  source: () => get('/source'),
  sourceTest: () => post('/source/test'),
  sourceSave: (body: any) => post('/source/save', body),
  notify: () => get('/notify'),
  notifySave: (body: any) => post('/notify/save', body),
  notifyTest: (id: string) => post('/notify/test', { id }),
  system: () => get('/system'),
};

/* ---------- topology-svc（:8790，经 vite 代理 /topo-api → /api） ---------- */
const TBASE = '/topo-api';
// 注意：不能用上面的 get()——它会再加 '/api' 前缀变成 /api/topo-api/...（404）
async function tget<T = any>(path: string): Promise<T> {
  const r = await fetch(TBASE + path);
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(j?.error || `${path} -> ${r.status}`);
  }
  return r.json();
}
async function tpost<T = any>(path: string, body?: any): Promise<T> {
  const r = await fetch(TBASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error || `${path} -> ${r.status}`);
  return j;
}
export const topoApi = {
  graph: (include = '') => tget(`/topology/graph${include ? '?include=' + include : ''}`),
  nodes: (qs: Record<string, any>) =>
    tget('/topology/nodes?' + new URLSearchParams(Object.entries(qs).filter(([, v]) => v !== '' && v != null).map(([k, v]) => [k, String(v)]))),
  node: (id: number) => tget(`/topology/nodes/${id}`),
  links: (qs: Record<string, any>) =>
    tget('/topology/links?' + new URLSearchParams(Object.entries(qs).filter(([, v]) => v !== '' && v != null).map(([k, v]) => [k, String(v)]))),
  pending: (qs: Record<string, any> = {}) =>
    tget('/topology/links/pending?' + new URLSearchParams(Object.entries(qs).filter(([, v]) => v !== '' && v != null).map(([k, v]) => [k, String(v)]))),
  confirmLink: (id: number, operator: string) => tpost(`/topology/links/${id}/confirm`, { operator }),
  rejectLink: (id: number, operator: string, reason?: string) => tpost(`/topology/links/${id}/reject`, { operator, reason }),
  bulkConfirm: (body: { link_ids?: number[]; match?: any; operator: string; note?: string }) => tpost('/topology/links/bulk-confirm', body),
  bulkReject: (body: { link_ids?: number[]; match?: any; operator: string; reason?: string }) => tpost('/topology/links/bulk-reject', body),
  traffic: (id: number, range: string) => tget(`/topology/links/${id}/traffic?range=${range}`),
  ifaceTraffic: (id: number, range: string) => tget(`/topology/interfaces/${id}/traffic?range=${range}`),
  sync: () => tpost('/topology/sync'),
  discoveryRun: (node_ids?: string[]) => tpost('/topology/discovery/run', node_ids ? { node_ids } : {}),
  discoverySummary: () => tget('/topology/discovery/summary'),
  pathtrace: (src: string, dst: string) => tget(`/topology/pathtrace?src=${encodeURIComponent(src)}&dst=${encodeURIComponent(dst)}`),
  rtStatus: () => tget('/topology/pathtrace/status'),
  rtRefresh: (node_ids?: string[]) => tpost('/topology/pathtrace/refresh', node_ids ? { node_ids } : {}),
};

/** 通用轮询 hook；key 变化（筛选/翻页/搜索）立即重新拉取，不必等轮询周期 */
export function usePoll<T>(fn: () => Promise<T>, ms = 15000, key = ''): { data: T | null; err: string | null; reload: () => void } {
  const [data, setData] = React.useState<T | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [tick, setTick] = React.useState(0);
  const fnRef = React.useRef(fn);
  fnRef.current = fn;
  React.useEffect(() => {
    let alive = true;
    const run = () => fnRef.current().then(d => { if (alive) { setData(d); setErr(null); } }).catch(e => { if (alive) setErr(String(e.message || e)); });
    run();
    const t = setInterval(run, ms);
    return () => { alive = false; clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tick]);
  return { data, err, reload: () => setTick(x => x + 1) };
}

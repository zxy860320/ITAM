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
  if (!r.ok) throw new Error(`${path} -> ${r.status}`);
  return r.json();
}

export const api = {
  summary: () => get('/summary'),
  dashboard: () => get('/dashboard'),
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
  system: () => get('/system'),
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

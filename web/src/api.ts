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
  // 设备操作（经跳板机 JumpServer MCP）
  opsConfig: () => get('/ops/config'),
  opsConfigSave: (body: any) => post('/ops/config/save', body),
  opsConfigTest: () => post('/ops/config/test'),
  opsAssets: (qs: Record<string, any>) =>
    get('/ops/assets?' + new URLSearchParams(Object.entries(qs).filter(([, v]) => v !== '' && v != null).map(([k, v]) => [k, String(v)]))),
  opsExec: (body: any) => post('/ops/exec', body),
  opsBackupNow: (body: { asset: string; tpl?: string }) => post('/ops/backup', body),
  opsBackupsMeta: () => get('/ops/backups/meta'),
  opsDiff: (a: string, b: string) => get(`/ops/diff?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`),
  opsBackups: (qs: Record<string, any>) =>
    get('/ops/backups?' + new URLSearchParams(Object.entries(qs).filter(([, v]) => v !== '' && v != null).map(([k, v]) => [k, String(v)]))),
  opsBackup: (id: string) => get(`/ops/backups/${id}`),
  opsChanges: (qs: Record<string, any> = {}) =>
    get('/ops/changes?' + new URLSearchParams(Object.entries(qs).map(([k, v]) => [k, String(v)]))),
  opsSessions: (qs: Record<string, any> = {}) =>
    get('/ops/sessions?' + new URLSearchParams(Object.entries(qs).filter(([, v]) => v !== '' && v != null).map(([k, v]) => [k, String(v)]))),
  aiConfig: () => get('/ai/config'),
  // 资产管理（台账+加密凭据；接口永不返回密码，reveal 显式获取并服务端审计）
  assetsStats: () => get('/assets/stats'),
  assets: (qs: Record<string, any>) =>
    get('/assets?' + new URLSearchParams(Object.entries(qs).filter(([, v]) => v !== '' && v != null).map(([k, v]) => [k, String(v)]))),
  asset: (id: string) => get(`/assets/${id}`),
  assetSave: (body: any) => post('/assets/save', body),
  assetDelete: (id: string) => post('/assets/delete', { id }),
  assetCredDelete: (assetId: string, credId: string) => post('/assets/cred/delete', { assetId, credId }),
  assetCredReveal: (assetId: string, credId: string) => post('/assets/cred/reveal', { assetId, credId }),
  assetsImportMonitor: () => post('/assets/import-monitor'),
  // AI agent（LangGraph 服务，经 server 代理 /api/agent/*）
  agentHealth: () => get('/agent/health'),
  agentReset: (thread_id: string) => post('/agent/reset', { thread_id }),
};

/** 与 agent 服务通信的 SSE（POST /api/agent/chat，逐事件回调）。返回 abort 函数。 */
export function agentChat(
  threadId: string,
  message: string,
  onEvent: (ev: any) => void,
): () => void {
  const ac = new AbortController();
  (async () => {
    try {
      const r = await fetch('/api/agent/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ thread_id: threadId, message }),
        signal: ac.signal,
      });
      if (!r.ok || !r.body) {
        const j = await r.json().catch(() => ({}) as any);
        onEvent({ type: 'error', message: j?.error || `agent -> ${r.status}` });
        onEvent({ type: 'done' });
        return;
      }
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const raw = buf.slice(0, idx); buf = buf.slice(idx + 2);
          const line = raw.split('\n').find(l => l.startsWith('data: '));
          if (line) { try { onEvent(JSON.parse(line.slice(6))); } catch { /* 半截包忽略 */ } }
        }
      }
    } catch (e: any) {
      if (e?.name !== 'AbortError') onEvent({ type: 'error', message: String(e?.message || e) });
    }
  })();
  return () => ac.abort();
}

/* ---------- topology-svc（:8790，经 vite 代理 /topo-api → /api；生产经 nginx /topo-api/ 同源代理） ---------- */
const TBASE = '/topo-api';
// V2 认证：写端点需要 httpOnly 会话 cookie，所有 topo 请求必须带凭据（同源/白名单 CORS 均已配好）
// 注意：不能用上面的 get()——它会再加 '/api' 前缀变成 /api/topo-api/...（404）
async function tget<T = any>(path: string): Promise<T> {
  const r = await fetch(TBASE + path, { credentials: 'include' });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(j?.error || `${path} -> ${r.status}`);
  }
  return r.json();
}
async function tpost<T = any>(path: string, body?: any): Promise<T> {
  const r = await fetch(TBASE + path, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error || `${path} -> ${r.status}`);
  return j;
}
async function tput<T = any>(path: string, body?: any): Promise<T> {
  const r = await fetch(TBASE + path, {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error || `${path} -> ${r.status}`);
  return j;
}
async function tpatch<T = any>(path: string, body?: any): Promise<T> {
  const r = await fetch(TBASE + path, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error || `${path} -> ${r.status}`);
  return j;
}
async function tdel<T = any>(path: string): Promise<T> {
  const r = await fetch(TBASE + path, { method: 'DELETE', credentials: 'include' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error || `${path} -> ${r.status}`);
  return j;
}
export const topoAuth = {
  me: () => tget('/topology/auth/me'),
  login: (username: string, password: string) => tpost('/topology/auth/login', { username, password }),
  logout: () => tpost('/topology/auth/logout'),
};
export const topoApi = {
  graph: (include = '') => tget(`/topology/graph${include ? '?include=' + include : ''}`),
  nodes: (qs: Record<string, any>) =>
    tget('/topology/nodes?' + new URLSearchParams(Object.entries(qs).filter(([, v]) => v !== '' && v != null).map(([k, v]) => [k, String(v)]))),
  node: (id: number) => tget(`/topology/nodes/${id}`),
  links: (qs: Record<string, any>) =>
    tget('/topology/links?' + new URLSearchParams(Object.entries(qs).filter(([, v]) => v !== '' && v != null).map(([k, v]) => [k, String(v)]))),
  pending: (qs: Record<string, any> = {}) =>
    tget('/topology/links/pending?' + new URLSearchParams(Object.entries(qs).filter(([, v]) => v !== '' && v != null).map(([k, v]) => [k, String(v)]))),
  confirmLink: (id: number) => tpost(`/topology/links/${id}/confirm`, {}),
  rejectLink: (id: number, reason?: string) => tpost(`/topology/links/${id}/reject`, { reason }),
  bulkConfirm: (body: { link_ids?: number[]; match?: any; note?: string }) => tpost('/topology/links/bulk-confirm', body),
  bulkReject: (body: { link_ids?: number[]; match?: any; reason?: string }) => tpost('/topology/links/bulk-reject', body),
  traffic: (id: number, range: string) => tget(`/topology/links/${id}/traffic?range=${range}`),
  ifaceTraffic: (id: number, range: string) => tget(`/topology/interfaces/${id}/traffic?range=${range}`),
  sync: () => tpost('/topology/sync'),
  discoveryRun: (node_ids?: string[]) => tpost('/topology/discovery/run', node_ids ? { node_ids } : {}),
  discoverySummary: () => tget('/topology/discovery/summary'),
  pathtrace: (src: string, dst: string) => tget(`/topology/pathtrace?src=${encodeURIComponent(src)}&dst=${encodeURIComponent(dst)}`),
  rtStatus: () => tget('/topology/pathtrace/status'),
  rtRefresh: (node_ids?: string[]) => tpost('/topology/pathtrace/refresh', node_ids ? { node_ids } : {}),
  // P3 全局共享布局（DB 唯一存储；auto/manual + position_locked）
  layoutGet: () => tget('/topology/layout'),
  layoutSave: (nodes: any[]) => tput('/topology/layout', { nodes }),
  layoutGroups: (groups: any[]) => tput('/topology/layout/groups', { groups }),
  // V2 Phase 2：坐标+区域隶属事务性批量写（行可带 zone_id，x/y 可为 null）
  layoutBatch: (nodes: any[]) => tput('/topology/layout/batch', { nodes }),
  layoutReset: () => tpost('/topology/layout/reset', {}),
  // V2 Phase 2 区域（管理员资产：系统绝不自动创建，suggestions 仅供参考）
  zonesGet: (members = false) => tget(`/topology/zones${members ? '?members=1' : ''}`),
  zonesSuggestions: () => tget('/topology/zones/suggestions'),
  createZone: (body: any) => tpost('/topology/zones', body),
  updateZone: (id: number, body: any) => tput(`/topology/zones/${id}`, body),
  patchZoneGeometry: (id: number, body: { x?: number | null; y?: number | null; w?: number | null; h?: number | null; collapsed?: 0 | 1 }) =>
    tpatch(`/topology/zones/${id}/geometry`, body),
  deleteZone: (id: number) => tdel(`/topology/zones/${id}`),
  addMembers: (id: number, node_ids: number[]) => tpost(`/topology/zones/${id}/members`, { node_ids }),
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

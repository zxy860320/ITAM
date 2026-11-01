/* topology-svc 会话态（V2 §10）：模块级单例，跨页面共享。
 * 现实：只读匿名可用，全部写端点要求 admin 会话。页面据 authed/role 决定写操作是否可用——
 * 但真正的闸门在后端（401/403），前端只是体验层。 */
import React from 'react';
import { topoAuth } from '../api';

export type TopoAuthState = {
  checked: boolean;
  authed: boolean;
  user?: string;
  role?: string;
  users_exist?: boolean;
};

let state: TopoAuthState = { checked: false, authed: false };
const subs = new Set<(s: TopoAuthState) => void>();

export function topoAuthState(): TopoAuthState { return state; }
function emit(s: TopoAuthState) { state = s; subs.forEach(f => f(s)); }

export async function refreshTopoAuth(): Promise<TopoAuthState> {
  try {
    const j = await topoAuth.me();
    emit({ checked: true, authed: !!j.data?.authed, user: j.data?.user, role: j.data?.role, users_exist: j.data?.users_exist });
  } catch {
    emit({ ...state, checked: true }); // topology-svc 不可达：保持未登录显示
  }
  return state;
}

export async function topoLogin(username: string, password: string) {
  const j = await topoAuth.login(username, password);
  await refreshTopoAuth();
  return j;
}
export async function topoLogout() {
  try { await topoAuth.logout(); } finally { await refreshTopoAuth(); }
}

export function useTopoAuth(): TopoAuthState {
  const [s, setS] = React.useState<TopoAuthState>(state);
  React.useEffect(() => {
    subs.add(setS);
    if (!state.checked) void refreshTopoAuth();
    return () => { subs.delete(setS); };
  }, []);
  return s;
}

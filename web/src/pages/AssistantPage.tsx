// AI 助手页：自研 LangGraph 聊天（主）+ Open WebUI iframe（备用入口）。
// 自研链路：本页面 → server 代理 /api/agent/chat(SSE) → agent :8791(LangGraph) → 平台 /mcp 工具层。
// 工具能力来自平台实时数据；agent 服务带会话记忆（thread_id + checkpoint）。
import React from 'react';
import { api, agentChat } from '../api';

type ToolStep = { name: string; args: any; preview?: string; isError?: boolean; done?: boolean };
type Msg = { role: 'user' | 'ai'; text: string; steps?: ToolStep[] };

export default function AssistantPage() {
  const [tab, setTab] = React.useState<'chat' | 'owui'>('chat');
  const { data: cfg } = useAiCfg();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, height: 'calc(100vh - 108px)' }}>
      <div className="toolbar">
        <span className="badge info">MCP 工具层已就绪</span>
        <span style={{ opacity: 0.75, fontSize: 13 }}>
          助手基于 LangGraph，可查询实时告警 / 设备 / 资产台账 / 配置备份并支持多步推理；回答只用工具返回的真实数据。
        </span>
        <span className="spacer" />
        <div className="seg">
          <button className={tab === 'chat' ? 'on' : ''} onClick={() => setTab('chat')}>平台助手</button>
          <button className={tab === 'owui' ? 'on' : ''} onClick={() => setTab('owui')}>Open WebUI</button>
        </div>
      </div>
      {tab === 'chat' ? <AgentChat /> : <OwuiFrame cfg={cfg} />}
    </div>
  );
}

/* ---------------- 自研聊天（LangGraph） ---------------- */

/* 会话状态提升到模块级：切菜单会卸载组件，但 SSE 流不中止、消息不丢——
 * 回到本页时从断点继续渲染；只有「停止」「新会话」才主动断开。 */
type Session = { threadId: string; msgs: Msg[]; busy: boolean; input: string; abort: null | (() => void); v: number };
const session: Session = { threadId: `th-${Date.now().toString(36)}`, msgs: [], busy: false, input: '', abort: null, v: 0 };
const sessionListeners = new Set<() => void>();
function patchSession(fn: (s: Session) => void) {
  fn(session); session.v++;
  sessionListeners.forEach(f => f());
}
function useSession() {
  const [, force] = React.useReducer((x: number) => x + 1, 0);
  React.useEffect(() => {
    sessionListeners.add(force);
    return () => { sessionListeners.delete(force); };
  }, []);
  return session;
}

function AgentChat() {
  const s = useSession();
  const [health, setHealth] = React.useState<any>(null);
  const [hErr, setHErr] = React.useState('');
  const scrollRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    api.agentHealth().then(setHealth).catch(e => setHErr(String(e?.message || e)));
    // 卸载时不 abort——回答中途切到别的菜单，流继续在后台跑完
  }, []);

  React.useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [s.v]);

  const send = (text?: string) => {
    const message = (text ?? s.input).trim();
    if (!message || s.busy) return;
    patchSession(st => {
      st.input = '';
      st.busy = true;
      st.msgs = [...st.msgs, { role: 'user', text: message }, { role: 'ai', text: '', steps: [] }];
    });
    // 只更新最后一条 ai 消息
    const patch = (fn: (m: Msg) => Msg) =>
      patchSession(st => { const c = [...st.msgs]; c[c.length - 1] = fn(c[c.length - 1]); st.msgs = c; });
    session.abort = agentChat(session.threadId, message, ev => {
      if (ev.type === 'token') patch(m => ({ ...m, text: m.text + ev.text }));
      else if (ev.type === 'tool_start')
        patch(m => ({ ...m, steps: [...(m.steps || []), { name: ev.name, args: ev.args }] }));
      else if (ev.type === 'tool_done')
        patch(m => {
          const steps = [...(m.steps || [])];
          const i = steps.findIndex(x => x.name === ev.name && !x.done);
          if (i >= 0) steps[i] = { ...steps[i], preview: ev.preview, isError: ev.isError, done: true };
          return { ...m, steps };
        });
      else if (ev.type === 'error') patch(m => ({ ...m, text: m.text + (m.text ? '\n\n' : '') + `⚠ ${ev.message}` }));
      else if (ev.type === 'done') patchSession(st => { st.busy = false; st.abort = null; });
    });
  };

  const newSession = async () => {
    session.abort?.();
    const old = session.threadId;
    patchSession(st => { st.abort = null; st.busy = false; });
    try { await api.agentReset(old); } catch { /* agent 未起时忽略 */ }
    patchSession(st => { st.threadId = `th-${Date.now().toString(36)}`; st.msgs = []; });
  };

  const owuiHint = health && !health?.llm?.configured;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, flex: 1, minHeight: 0 }}>
      {(hErr || (health && !health.ok)) && (
        <div className="card" style={{ padding: '10px 14px' }}>
          <b>Agent 服务未就绪。</b>{' '}
          {hErr && <span>{hErr}（agent 服务可能未启动：本地 <code className="mono">agent/.venv/Scripts/python.exe agent/app.py</code>，容器 <code className="mono">docker compose up -d agent</code>）</span>}
          {health && health.mcp && !health.mcp.connected && <span>MCP 连接失败：{health.mcp.error}</span>}
          {owuiHint && <span>工具层已加载 {health.mcp?.tools} 个工具；还差模型——在下方「模型配置」填写模型名并保存即可（免重启）。</span>}
        </div>
      )}
      <LlmSettingsCard health={health} onChanged={() => api.agentHealth().then(setHealth).catch(() => {})} />
      <div ref={scrollRef} className="chatbox">
        {s.msgs.length === 0 && (
          <div className="empty-tip" style={{ marginTop: 40 }}>
            试试问：「现在有什么严重告警」「最近 24 小时哪些设备配置变过」「资产台账里有多少台数据库」<br />
            助手只会基于平台工具实时查询的结果作答，不编造数据。
          </div>
        )}
        {s.msgs.map((m, i) => (
          <div key={i} className={`chatmsg ${m.role}`}>
            {m.steps && m.steps.length > 0 && (
              <div className="chattools">
                {m.steps.map((s, j) => (
                  <details key={j} className={`chattool ${s.isError ? 'err' : ''}`}>
                    <summary>{s.done ? (s.isError ? '✗' : '✓') : '…'} 调用工具 {s.name}</summary>
                    <pre className="mono">{JSON.stringify(s.args, null, 1)}{s.preview ? `\n→ ${s.preview}` : ''}</pre>
                  </details>
                ))}
              </div>
            )}
            {m.text && (m.role === 'ai'
              ? <div className="chatmd" dangerouslySetInnerHTML={{ __html: renderMd(m.text) }} />
              : <div className="chatuser">{m.text}</div>)}
            {m.role === 'ai' && s.busy && i === s.msgs.length - 1 && <span className="chattyping" aria-label="正在回答" />}
          </div>
        ))}
      </div>
      <div className="chatinput">
        <textarea
          className="ainp" rows={2} placeholder="向运维助手提问，Enter 发送，Shift+Enter 换行"
          value={s.input} onChange={e => patchSession(st => { st.input = e.target.value; })}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
        />
        {s.busy
          ? <button className="btn" onClick={() => { session.abort?.(); patchSession(st => { st.abort = null; st.busy = false; }); }}>停止</button>
          : <button className="btn primary" onClick={() => send()}>发送</button>}
        <button className="btn" onClick={newSession}>新会话</button>
      </div>
    </div>
  );
}

/* ---------------- 模型配置卡片（保存即生效，免重启） ---------------- */

function LlmSettingsCard({ health, onChanged }: { health: any; onChanged: () => void }) {
  const [open, setOpen] = React.useState(false);
  const [cfg, setCfg] = React.useState<any>(null);
  const [form, setForm] = React.useState({ base_url: '', api_key: '', model: '' });
  const [busy, setBusy] = React.useState<'test' | 'save' | ''>('');
  const [msg, setMsg] = React.useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const load = () => api.agentLlmSettings()
    .then(d => { setCfg(d); setForm(f => ({ ...f, base_url: f.base_url || d.base_url || '', model: f.model || d.model || '' })); })
    .catch(e => setMsg({ kind: 'err', text: `读取模型配置失败：${e?.message || e}` }));
  React.useEffect(() => { if (open && !cfg) load(); }, [open]);

  // 未就绪且模型缺失时自动展开，管理员一进页面就能看到
  React.useEffect(() => { if (health && !health.llm?.configured) setOpen(true); }, [health]);

  const test = async () => {
    setBusy('test'); setMsg(null);
    try {
      const d = await api.agentLlmTest({ base_url: form.base_url, api_key: form.api_key, model: form.model });
      setMsg(d.ok
        ? { kind: 'ok', text: `连接成功：模型「${d.model}」可用（端点 ${d.base_url || '默认'}）` }
        : { kind: 'err', text: d.error || '测试失败' });
    } catch (e: any) { setMsg({ kind: 'err', text: `测试失败：${e?.message || e}（保存/测试需要 platform.config 权限）` }); }
    setBusy('');
  };
  const save = async () => {
    if (!form.model.trim()) { setMsg({ kind: 'err', text: '模型名不能为空' }); return; }
    setBusy('save'); setMsg(null);
    try {
      const d = await api.agentLlmSave({ base_url: form.base_url.trim(), api_key: form.api_key.trim(), model: form.model.trim() });
      if (d.ok) { setMsg({ kind: 'ok', text: '已保存，下一条消息即使用新模型（无需重启）' }); setForm(f => ({ ...f, api_key: '' })); load(); onChanged(); }
      else setMsg({ kind: 'err', text: d.error || '保存失败' });
    } catch (e: any) { setMsg({ kind: 'err', text: `保存失败：${e?.message || e}（需要 platform.config 权限，找管理员）` }); }
    setBusy('');
  };

  const cur = health?.llm;
  return (
    <div className="card" style={{ padding: '8px 14px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <b style={{ fontSize: 13 }}>模型配置</b>
        <span style={{ fontSize: 12.5, color: 'var(--text-3)' }}>
          {cur
            ? <>当前：<span className="mono">{cur.model || '（未设置）'}</span>{cur.base_url ? <> @ <span className="mono">{cur.base_url}</span></> : null}
              {cur.source === 'settings' ? '（界面配置）' : cur.source === 'env' ? '（.env）' : ''}</>
            : '正在读取…'}
        </span>
        <span className="spacer" style={{ flex: 1 }} />
        <button className="btn" onClick={() => setOpen(v => !v)}>{open ? '收起' : '修改'}</button>
      </div>
      {open && (
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '110px 1fr', gap: '6px 10px', alignItems: 'center', maxWidth: 760 }}>
            <label>模型名 *</label>
            <input className="ainp mono" value={form.model} placeholder="LiteLLM /v1/models 里注册的名（如 general）；Ollama 如 qwen2.5:32b"
              onChange={e => setForm(f => ({ ...f, model: e.target.value }))} />
            <label>API 端点</label>
            <input className="ainp mono" value={form.base_url} placeholder="http://<litellm>:4000/v1 或 http://<ollama>:11434/v1（留空=沿用 .env）"
              onChange={e => setForm(f => ({ ...f, base_url: e.target.value }))} />
            <label>API Key</label>
            <input className="ainp mono" type="password" value={form.api_key}
              placeholder={cfg?.api_key_masked ? `已保存 ${cfg.api_key_masked}，留空则不变` : '网关无鉴权可留空'}
              onChange={e => setForm(f => ({ ...f, api_key: e.target.value }))} />
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button className="btn" disabled={!!busy} onClick={test}>{busy === 'test' ? '测试中…' : '测试连接'}</button>
            <button className="btn primary" disabled={!!busy} onClick={save}>{busy === 'save' ? '保存中…' : '保存（即生效）'}</button>
            <span style={{ fontSize: 12.5, color: msg?.kind === 'err' ? 'var(--sev-critical)' : 'var(--sev-healthy)' }}>{msg?.text || ''}</span>
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
            配置保存在 agent 数据卷（llm_settings.json），优先于 .env，重启不丢；换 LiteLLM 模型名后这里改一下即可，不用动服务器。
          </div>
        </div>
      )}
    </div>
  );
}

/* 极简 Markdown 渲染：先转义 HTML 再转换（防注入），支持表格/代码/加粗/列表/标题 */
function esc(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function renderMd(src: string): string {
  const lines = esc(src).split('\n');
  const out: string[] = [];
  let inCode = false, inList = false, inTable = false;
  const closeAll = () => {
    if (inList) { out.push('</ul>'); inList = false; }
    if (inTable) { out.push('</table>'); inTable = false; }
  };
  const inline = (s: string) =>
    s.replace(/`([^`]+)`/g, '<code>$1</code>')
     .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^```/.test(l)) {
      closeAll();
      out.push(inCode ? '</pre>' : '<pre className="mono">'); inCode = !inCode; continue;
    }
    if (inCode) { out.push(l); continue; }
    if (/^\|.*\|\s*$/.test(l)) {
      if (/^\|[\s:|-]+\|\s*$/.test(l)) continue; // 分隔行
      if (!inTable) { out.push('<table>'); inTable = true; }
      const cells = l.replace(/^\||\|\s*$/g, '').split('|');
      out.push('<tr>' + cells.map((c, j) => `<t${i + 1 < lines.length && /^\|[\s:|-]+\|\s*$/.test(lines[i + 1]) ? 'h' : 'd'}>${inline(c.trim())}</t${i + 1 < lines.length && /^\|[\s:|-]+\|\s*$/.test(lines[i + 1]) ? 'h' : 'd'}>`).join('') + '</tr>');
      continue;
    }
    if (inTable) { out.push('</table>'); inTable = false; }
    if (/^[-*] /.test(l)) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li>${inline(l.slice(2))}</li>`); continue;
    }
    if (inList) { out.push('</ul>'); inList = false; }
    const h = l.match(/^(#{1,4}) (.*)$/);
    if (h) { out.push(`<div class="mdh">${inline(h[2])}</div>`); continue; }
    if (l.trim() === '') continue;
    out.push(`<p>${inline(l)}</p>`);
  }
  closeAll();
  if (inCode) out.push('</pre>');
  return out.join('');
}

/* ---------------- Open WebUI 备用入口（iframe，逻辑同旧版） ---------------- */

function OwuiFrame({ cfg }: { cfg: any }) {
  const [probe, setProbe] = React.useState<'unknown' | 'up' | 'down'>('unknown');
  const [frameKey, setFrameKey] = React.useState(0);
  const url = React.useMemo(() => {
    if (!cfg) return '';
    if (cfg.url) return cfg.url;
    return `${location.protocol}//${location.hostname}:${cfg.port}`;
  }, [cfg]);

  React.useEffect(() => {
    if (!url) return;
    let alive = true;
    setProbe('unknown');
    fetch(url + '/', { mode: 'no-cors' })
      .then(() => { if (alive) setProbe('up'); })
      .catch(() => { if (alive) setProbe('down'); });
    return () => { alive = false; };
  }, [url]);

  if (!cfg) return <div className="empty-tip">正在读取 AI 助手配置…</div>;
  if (!cfg.enabled) return <Guide url={url} why="后端 AI_ENABLED=0，Open WebUI 入口已被管理员禁用。" />;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, flex: 1, minHeight: 0 }}>
      <div className="toolbar">
        <span style={{ opacity: 0.75, fontSize: 13 }}>Open WebUI 作为备用聊天前端，模型与工具在其后台配置（MCP 指向本平台 /mcp）。</span>
        <span className="spacer" />
        {probe === 'down' && <span className="badge warning">助手服务未连通</span>}
        <button className="btn" onClick={() => setFrameKey(k => k + 1)}>重载</button>
        <a className="btn" href={url} target="_blank" rel="noreferrer">新窗口打开</a>
      </div>
      {probe === 'down' ? (
        <Guide url={url} why={`无法连接 ${url}（助手服务未启动或端口未放行）。`} />
      ) : (
        <iframe
          key={frameKey}
          src={url}
          title="Open WebUI"
          style={{ flex: 1, width: '100%', border: '1px solid var(--hairline)', borderRadius: 'var(--radius-md)', background: 'var(--bg-card)' }}
          allow="clipboard-read; clipboard-write; microphone"
        />
      )}
    </div>
  );
}

function useAiCfg() {
  return usePollLocal(api.aiConfig);
}
function usePollLocal(fn: () => Promise<any>) {
  const [data, setData] = React.useState<any>(null);
  React.useEffect(() => {
    let alive = true; let n = 0;
    const run = () => fn().then(d => { if (alive) setData(d); }).catch(() => { if (alive && ++n < 5) setTimeout(run, 2000); });
    run();
    return () => { alive = false; };
  }, []);
  return { data };
}

function Guide({ url, why }: { url: string; why: string }) {
  return (
    <div className="card" style={{ maxWidth: 860 }}>
      <div className="card-title">Open WebUI 入口（一次性配置）</div>
      <p style={{ marginTop: 0 }}>{why}</p>
      <ol style={{ lineHeight: 1.9, paddingLeft: 22, margin: 0 }}>
        <li>服务器上 <code className="mono">docker compose up -d open-webui web</code>（数据在 named volume <code className="mono">open_webui_data</code>）。</li>
        <li>后台 <b>Settings → Admin → Integrations → External Tool Servers</b>：Type 选 <b>MCP (Streamable HTTP)</b>，URL 填 <code className="mono">http://&lt;平台主机&gt;/mcp</code>（必须从 Open WebUI 所在主机可达）。</li>
        <li><b>Settings → Admin → Connections</b> 配置模型端点（任意 OpenAI 兼容接口）。</li>
        <li>日常问答推荐切回「平台助手」标签（LangGraph，带工具步骤与会话记忆）。</li>
      </ol>
    </div>
  );
}

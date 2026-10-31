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

function AgentChat() {
  const [threadId, setThreadId] = React.useState(() => `th-${Date.now().toString(36)}`);
  const [msgs, setMsgs] = React.useState<Msg[]>([]);
  const [input, setInput] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [health, setHealth] = React.useState<any>(null);
  const [hErr, setHErr] = React.useState('');
  const abortRef = React.useRef<null | (() => void)>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    api.agentHealth().then(setHealth).catch(e => setHErr(String(e?.message || e)));
    return () => abortRef.current?.();
  }, []);

  React.useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [msgs]);

  const send = (text?: string) => {
    const message = (text ?? input).trim();
    if (!message || busy) return;
    setInput('');
    setBusy(true);
    setMsgs(m => [...m, { role: 'user', text: message }, { role: 'ai', text: '', steps: [] }]);
    // 只更新最后一条 ai 消息
    const patch = (fn: (m: Msg) => Msg) =>
      setMsgs(m => { const c = [...m]; c[c.length - 1] = fn(c[c.length - 1]); return c; });
    abortRef.current = agentChat(threadId, message, ev => {
      if (ev.type === 'token') patch(m => ({ ...m, text: m.text + ev.text }));
      else if (ev.type === 'tool_start')
        patch(m => ({ ...m, steps: [...(m.steps || []), { name: ev.name, args: ev.args }] }));
      else if (ev.type === 'tool_done')
        patch(m => {
          const steps = [...(m.steps || [])];
          const i = steps.findIndex(s => s.name === ev.name && !s.done);
          if (i >= 0) steps[i] = { ...steps[i], preview: ev.preview, isError: ev.isError, done: true };
          return { ...m, steps };
        });
      else if (ev.type === 'error') patch(m => ({ ...m, text: m.text + (m.text ? '\n\n' : '') + `⚠ ${ev.message}` }));
      else if (ev.type === 'done') setBusy(false);
    });
  };

  const newSession = async () => {
    abortRef.current?.(); setBusy(false);
    try { await api.agentReset(threadId); } catch { /* agent 未起时忽略 */ }
    setThreadId(`th-${Date.now().toString(36)}`);
    setMsgs([]);
  };

  const owuiHint = health && !health?.llm?.configured;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, flex: 1, minHeight: 0 }}>
      {(hErr || (health && !health.ok)) && (
        <div className="card" style={{ padding: '10px 14px' }}>
          <b>Agent 服务未就绪。</b>{' '}
          {hErr && <span>{hErr}（agent 服务可能未启动：本地 <code className="mono">agent/.venv/Scripts/python.exe agent/app.py</code>，容器 <code className="mono">docker compose up -d agent</code>）</span>}
          {health && health.mcp && !health.mcp.connected && <span>MCP 连接失败：{health.mcp.error}</span>}
          {owuiHint && <span>工具层已加载 {health.mcp?.tools} 个工具；还差模型——在 .env 配 <code className="mono">LLM_BASE_URL</code> / <code className="mono">LLM_MODEL</code>（Ollama 则 base_url 填 <code className="mono">http://&lt;host&gt;:11434/v1</code>）后重启 agent。</span>}
        </div>
      )}
      <div ref={scrollRef} className="chatbox">
        {msgs.length === 0 && (
          <div className="empty-tip" style={{ marginTop: 40 }}>
            试试问：「现在有什么严重告警」「最近 24 小时哪些设备配置变过」「资产台账里有多少台数据库」<br />
            助手只会基于平台工具实时查询的结果作答，不编造数据。
          </div>
        )}
        {msgs.map((m, i) => (
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
            {m.role === 'ai' && busy && i === msgs.length - 1 && <span className="chattyping" aria-label="正在回答" />}
          </div>
        ))}
      </div>
      <div className="chatinput">
        <textarea
          className="ainp" rows={2} placeholder="向运维助手提问，Enter 发送，Shift+Enter 换行"
          value={input} onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
        />
        {busy
          ? <button className="btn" onClick={() => { abortRef.current?.(); setBusy(false); }}>停止</button>
          : <button className="btn primary" onClick={() => send()}>发送</button>}
        <button className="btn" onClick={newSession}>新会话</button>
      </div>
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

// AI 助手页：内嵌 Open WebUI（iframe）。
// 工具能力来自平台自己的 MCP 端点（server :8787/mcp）——Open WebUI 只是聊天前端，
// 模型在 OWUI 后台配（OpenAI 兼容端点），工具在 OWUI Integrations 里指向 /mcp。
import React from 'react';
import { api } from '../api';

export default function AssistantPage() {
  const { data: cfg } = useAiCfg();
  const [probe, setProbe] = React.useState<'unknown' | 'up' | 'down'>('unknown');
  const [frameKey, setFrameKey] = React.useState(0);

  // 后端配置优先；未配 AI_ASSISTANT_URL 时按当前主机 + AI_ASSISTANT_PORT 拼装
  const url = React.useMemo(() => {
    if (!cfg) return '';
    if (cfg.url) return cfg.url;
    return `${location.protocol}//${location.hostname}:${cfg.port}`;
  }, [cfg]);

  React.useEffect(() => {
    if (!url) return;
    let alive = true;
    setProbe('unknown');
    // no-cors 探测：拿到响应（不透明）即认为服务在；抛错=连不上（DNS/拒连）
    fetch(url + '/', { mode: 'no-cors' })
      .then(() => { if (alive) setProbe('up'); })
      .catch(() => { if (alive) setProbe('down'); });
    return () => { alive = false; };
  }, [url]);

  if (!cfg) return <div className="empty-tip">正在读取 AI 助手配置…</div>;
  if (!cfg.enabled) return <Guide url={url} why="后端 AI_ENABLED=0，AI 助手已被管理员禁用。" />;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, height: 'calc(100vh - 108px)' }}>
      <div className="toolbar">
        <span className="badge info">MCP 工具层已就绪</span>
        <span style={{ opacity: 0.75, fontSize: 13 }}>
          助手可查询实时告警 / 设备 / 拓扑数据与配置备份（只读 + 一键备份，不提供设备改配）。模型与工具在助手后台配置一次即可。
        </span>
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
          title="AI 运维助手"
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
// aiConfig 基本不变：拉一次 + 失败重试即可，不必沿用页面级 20s 轮询
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
      <div className="card-title">部署 AI 助手（一次性配置）</div>
      <p style={{ marginTop: 0 }}>{why}</p>
      <ol style={{ lineHeight: 1.9, paddingLeft: 22, margin: 0 }}>
        <li>服务器上 <code className="mono">docker compose up -d open-webui web</code>（compose 已内置 open-webui 服务，数据在 named volume <code className="mono">open_webui_data</code>）。</li>
        <li>浏览器打开 <a href={url} target="_blank" rel="noreferrer">{url}</a>，首次访问创建的账号即为管理员。</li>
        <li>助手后台 <b>Settings → Admin → Integrations → External Tool Servers → Add Connection</b>：
          Type 选 <b>MCP (Streamable HTTP)</b>，URL 填 <code className="mono">http://server:8787/mcp</code>（compose 内网地址），Auth 选 <b>None</b>（或在 .env 配 ITYW_MCP_TOKEN 后选 Bearer）。</li>
        <li><b>Settings → Admin → Connections</b> 配置模型端点（任意 OpenAI 兼容接口：内网 vLLM/Ollama/商用 API）。</li>
        <li>回到本页重载即可对话；提问「现在有什么严重告警」「XX 交换机配置最近变过吗」会自动调用平台工具。</li>
      </ol>
    </div>
  );
}

"""ITYW AI 助手 agent 服务（LangGraph）。

定位：平台自研助手的后端大脑。工具能力全部来自 ITYW 平台自己的 MCP 端点
（server :8787/mcp，Streamable HTTP，零改动复用），本服务只负责：
  - 把 MCP 工具转成 LangChain tools（langchain-mcp-adapters）
  - LangGraph agent 循环 + SQLite checkpoint 会话记忆（thread_id）
  - 对平台后端暴露 SSE 流式接口：POST /chat {thread_id, message}
红线（与平台一致）：
  - 不伪造数据：一切事实来自工具结果；工具没返回就如实说没有
  - 凭据（资产账号密码）不查询、不外泄——MCP 工具层设计上也不提供
环境变量：
  AGENT_PORT=8791  AGENT_HOST=127.0.0.1
  ITYW_MCP_URL=http://127.0.0.1:8787/mcp   ITYW_MCP_TOKEN=（可选 Bearer）
  LLM_BASE_URL=https://...  LLM_API_KEY=...  LLM_MODEL=qwen2.5:32b
  AGENT_DB=data/checkpoints.db
"""
import json
import os
import time
from datetime import datetime
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

HERE = Path(__file__).resolve().parent
MCP_URL = os.environ.get("ITYW_MCP_URL", "http://127.0.0.1:8787/mcp")
MCP_TOKEN = os.environ.get("ITYW_MCP_TOKEN", "")
LLM_BASE_URL = os.environ.get("LLM_BASE_URL", "")
LLM_API_KEY = os.environ.get("LLM_API_KEY", "unused")
LLM_MODEL = os.environ.get("LLM_MODEL", "")
DB_PATH = Path(os.environ.get("AGENT_DB", str(HERE / "data" / "checkpoints.db")))

TOOLS_TTL = 300  # 秒；MCP 工具列表缓存，平台重启后最迟 5 分钟自动接上

SYS_PROMPT = """你是 ITYW IT 运维管理平台的内置运维助手。
你能使用的工具来自平台实时数据（Zabbix 监控、zCloud 数据库台账、资产台账、配置备份）。

规则（必须遵守）：
1. 一切事实必须来自工具返回的结果。工具没有返回数据时，如实说明"查询无结果"，绝不编造数字、设备、告警或时间。
2. 资产账号密码属于加密凭据，工具层不会提供，你也绝不向用户索要或展示密码。
3. 回答使用简体中文，简洁直接；多台设备/多条告警优先用 Markdown 表格列出。
4. 时间戳（毫秒）转换为"YYYY-MM-DD HH:mm"本地时间展示。
5. 用户说"最近"通常指近 24 小时；"严重告警"用 monitor_summary / query_events 查当前活动告警。
6. 需要执行备份（backup_device_now）这类写操作前，先向用户复述目标设备名并等待用户明确同意。
7. 工具返回 isError 时，把错误如实转告并给出下一步建议（如"该设备未纳管/无备份记录"）。"""

app = FastAPI(title="ITYW Agent", docs_url=None, redoc_url=None)

# ---------- MCP 工具加载（带缓存） ----------
_tools: list = []
_tools_at: float = 0
_graph = None
_graph_tools_id: int = 0


def llm_ready() -> bool:
    return bool(LLM_MODEL)


def llm():
    from langchain_openai import ChatOpenAI
    return ChatOpenAI(
        model=LLM_MODEL,
        api_key=LLM_API_KEY or "unused",
        base_url=LLM_BASE_URL or None,
        temperature=0.2,
        streaming=True,
        timeout=120,
    )


async def get_tools():
    global _tools, _tools_at
    if _tools and time.time() - _tools_at < TOOLS_TTL:
        return _tools
    from langchain_mcp_adapters.client import MultiServerMCPClient
    conn = {"ityw": {"transport": "streamable_http", "url": MCP_URL}}
    if MCP_TOKEN:
        conn["ityw"]["headers"] = {"Authorization": f"Bearer {MCP_TOKEN}"}
    client = MultiServerMCPClient(conn)
    tools = await client.get_tools()
    if not tools:
        raise RuntimeError(f"MCP 端点未返回任何工具（{MCP_URL}）")
    _tools, _tools_at = tools, time.time()
    return _tools


def build_graph(model, tools, checkpointer):
    """langchain 1.x 的 create_agent 优先；旧版回退 create_react_agent。"""
    try:
        from langchain.agents import create_agent
        return create_agent(model=model, tools=tools, system_prompt=SYS_PROMPT, checkpointer=checkpointer)
    except ImportError:
        from langgraph.prebuilt import create_react_agent
        return create_react_agent(model, tools, prompt=SYS_PROMPT, checkpointer=checkpointer)


_saver = None
_saver_cm = None  # 必须保持模块级引用：局部变量会被 GC，导致下一请求 checkpointer 连接失效


@app.post("/chat")
async def chat(req: Request):
    body = await req.json()
    message = str(body.get("message") or "").strip()
    thread_id = str(body.get("thread_id") or "default")

    def sse(ev: dict) -> str:
        return "data: " + json.dumps(ev, ensure_ascii=False) + "\n\n"

    async def gen():
        global _graph, _graph_tools_id, _saver
        if not message:
            yield sse({"type": "error", "message": "消息为空"})
            return
        if not llm_ready():
            yield sse({"type": "error", "message": "模型未配置：请在 .env 设置 LLM_BASE_URL / LLM_MODEL 后重启 agent 服务"})
            return
        try:
            tools = await get_tools()
        except Exception as e:
            yield sse({"type": "error", "message": f"工具层连接失败：{e}（检查平台后端与 /mcp 是否在线）"})
            return
        if _graph is None or _graph_tools_id != id(_tools):
            from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
            DB_PATH.parent.mkdir(parents=True, exist_ok=True)
            if _saver is None:
                global _saver_cm
                _saver_cm = AsyncSqliteSaver.from_conn_string(str(DB_PATH))
                _saver = await _saver_cm.__aenter__()
            _graph = build_graph(llm(), tools, _saver)
            _graph_tools_id = id(_tools)
        now = datetime.now().strftime("%Y-%m-%d %H:%M")
        # 注入当前时间，让"最近/今天"类问题有时间基准（不改动用户原文展示）
        user_msg = f"[当前时间 {now}]\n{message}"
        cfg = {"configurable": {"thread_id": thread_id}, "recursion_limit": 30}
        try:
            async for mode, chunk in _graph.astream(
                {"messages": [{"role": "user", "content": user_msg}]},
                config=cfg, stream_mode=["messages", "updates"],
            ):
                if mode == "messages":
                    msg, _meta = chunk
                    # 流式回复是 AIMessageChunk（type="AIMessageChunk"），不是 "ai"——别只判 "ai"
                    mtype = getattr(msg, "type", "")
                    if mtype in ("ai", "AIMessageChunk") and getattr(msg, "content", ""):
                        text = msg.content if isinstance(msg.content, str) else \
                            "".join(b.get("text", "") for b in msg.content if isinstance(b, dict))
                        if text:
                            yield sse({"type": "token", "text": text})
                elif mode == "updates":
                    for _node, update in (chunk or {}).items():
                        for msg in (update or {}).get("messages", []):
                            t = getattr(msg, "type", "")
                            if t == "ai" and getattr(msg, "tool_calls", None):
                                for tc in msg.tool_calls:
                                    yield sse({"type": "tool_start", "name": tc.get("name"),
                                               "args": tc.get("args") or {}})
                            elif t == "tool":
                                preview = str(getattr(msg, "content", ""))[:600]
                                yield sse({"type": "tool_done", "name": getattr(msg, "name", ""),
                                           "preview": preview,
                                           "isError": "error" in str(getattr(msg, "status", "")).lower()})
        except Exception as e:
            import traceback
            traceback.print_exc()
            yield sse({"type": "error", "message": f"agent 运行异常：{e}"})
        yield sse({"type": "done"})

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.post("/reset")
async def reset(req: Request):
    """清空某个会话的历史（前端"新会话"按钮调用）。"""
    body = await req.json()
    thread_id = str(body.get("thread_id") or "default")
    if _graph is not None:
        try:
            await _graph.adelete_thread(thread_id)
        except Exception:
            return JSONResponse({"ok": False})
    return JSONResponse({"ok": True})


@app.get("/health")
async def health():
    tools_n = 0
    mcp_ok = False
    err = ""
    try:
        tools = await get_tools()
        tools_n, mcp_ok = len(tools), True
    except Exception as e:
        err = str(e)
    return {
        "ok": mcp_ok and llm_ready(),
        "mcp": {"url": MCP_URL, "connected": mcp_ok, "tools": tools_n, "error": err},
        "llm": {"configured": llm_ready(), "model": LLM_MODEL or None, "base_url": LLM_BASE_URL or None},
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host=os.environ.get("AGENT_HOST", "127.0.0.1"),
                port=int(os.environ.get("AGENT_PORT", "8791")))

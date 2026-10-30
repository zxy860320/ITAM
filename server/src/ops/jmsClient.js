// JumpServer MCP（streamable-http）极简 JSON-RPC 客户端
// 实测协议（2026-10-30）：POST /mcp，Accept: application/json, text/event-stream；
// 服务器无状态（不要求 Mcp-Session-Id），响应为 SSE（event: message / data: {jsonrpc...}），
// 也可能直接 application/json——两种都解析。工具结果在 result.content[0].text（JSON 字符串）。
// 红线：本客户端只调用跳板机 MCP 暴露的工具，绝不经手设备凭据、绝不直连设备。

export class JmsClient {
  constructor({ url, mcpUrl, token, timeoutMs = 90000 } = {}) {
    this.url = mcpUrl || url || '';
    this.token = token || '';
    this.timeoutMs = timeoutMs;
    this._id = 0;
  }

  get configured() { return !!(this.url && this.token); }

  async _rpc(method, params) {
    if (!this.configured) throw new Error('跳板机 MCP 未配置（缺少 url/token）');
    const id = ++this._id;
    const r = await fetch(this.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Authorization': `Bearer ${this.token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const body = await r.text();
    if (!r.ok) throw new Error(`MCP HTTP ${r.status}: ${body.slice(0, 200)}`);
    // SSE：收集所有 data: 行，取带 id 的响应；纯 JSON 直接 parse
    let payload = null;
    if (body.includes('data:')) {
      for (const line of body.split('\n')) {
        if (!line.startsWith('data:')) continue;
        try {
          const j = JSON.parse(line.slice(5).trim());
          if (j && (j.id === id || j.result || j.error)) payload = j;
        } catch { /* 忽略非 JSON 行 */ }
      }
    } else {
      try { payload = JSON.parse(body); } catch { /* fallthrough */ }
    }
    if (!payload) throw new Error(`MCP 响应无法解析: ${body.slice(0, 200)}`);
    if (payload.error) throw new Error(`MCP error ${payload.error.code}: ${payload.error.message}`);
    return payload.result;
  }

  async callTool(name, args = {}) {
    const res = await this._rpc('tools/call', { name, arguments: args });
    const err = res?.isError === true;
    const text = (res?.content || []).map(c => c.text || '').join('\n');
    let data = null;
    try { data = JSON.parse(text); } catch { /* 有的工具返回纯文本 */ }
    if (err) throw new Error(data?.error || text || `${name} 调用失败`);
    return data ?? text;
  }

  // ---- 便捷封装（与 MCP 工具一一对应） ----
  health() { return this.callTool('js_health'); }
  listAssets({ search = '', limit = 100, offset = 0 } = {}) { return this.callTool('js_list_assets', { search, limit, offset }); }
  exec({ asset, command, account = '' }) { return this.callTool('js_exec_command', { asset, command, account }); }
  listSessions({ asset = '', is_finished = true, limit = 20, offset = 0 } = {}) { return this.callTool('js_list_sessions', { asset, is_finished, limit, offset }); }
  listCommands({ asset = '', cmd = '', limit = 20, offset = 0 } = {}) { return this.callTool('js_list_commands', { asset, cmd, limit, offset }); }
}

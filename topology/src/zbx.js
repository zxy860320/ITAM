// 精简 Zabbix JSON-RPC 客户端（自带一份，不触碰 P0 文件）
// 继承 P0 已验证约定：apiinfo.version 不带 auth；item.get 指定不存在字段会静默缺失
export class Zbx {
  constructor({ endpoint, token }) {
    this.endpoint = endpoint;
    this.token = token;
    this._id = 0;
  }
  ok() { return !!(this.endpoint && this.token); }
  async call(method, params = {}, opts = {}) {
    const body = { jsonrpc: '2.0', method, params, id: ++this._id };
    if (!opts.noAuth) body.auth = this.token;
    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs || 60000),
    });
    const j = await res.json();
    if (j.error) throw new Error(`${method}: ${j.error.message} ${j.error.data || ''}`);
    return j.result;
  }
  version() { return this.call('apiinfo.version', {}, { noAuth: true }); }

  /** 网络主机（模板名匹配 netTemplateRe），含组与模板 */
  async netHosts(re, limit = 500) {
    const hosts = await this.call('host.get', {
      output: ['hostid', 'host', 'name', 'status', 'flags'],
      selectParentTemplates: ['templateid', 'name'],
      selectGroups: ['groupid', 'name'],
      limit,
    });
    return hosts.filter(h => (h.parentTemplates || []).some(t => re.test(t.name || '')));
  }
  hostSnmpInterfaces(hostids) {
    return this.call('hostinterface.get', { output: 'extend', hostids, filters: { type: 2 } });
  }
  /** 接口类监控项：net.if.in/out/status/speed/errors + discovery 宏 */
  netIfItems(hostids) {
    return this.call('item.get', {
      output: ['itemid', 'hostid', 'name', 'key_', 'units', 'value_type', 'lastvalue', 'lastclock', 'state'],
      hostids,
      search: { key_: 'net.if.' },
      searchByAnd: false,
      limit: 100000,
    });
  }
  historyText(itemids, limit = 1) {
    return this.call('history.get', {
      output: ['itemid', 'clock', 'value'], itemids, history: 4,
      sortfield: 'clock', sortorder: 'DESC', limit,
    });
  }
  createTempItem(spec) {
    return this.call('item.create', [spec]).then(r => (r.itemids || [])[0] || null);
  }
  deleteItems(itemids) { return this.call('item.delete', itemids); }
  findItemsByKeys(keys) {
    return this.call('item.get', {
      output: ['itemid', 'hostid', 'key_', 'name', 'state', 'error', 'lastclock'],
      search: { key_: keys }, searchByAnd: false,
    });
  }
}

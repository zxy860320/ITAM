import React from 'react';
import { api, usePoll } from '../api';
import { fmtTime, DOM_LABEL } from '../components/common';

/** 监控源对接页：数据源配置 + 连通性测试 + 群组映射 */
export default function SourcePage() {
  const { data, reload } = usePoll(api.source, 20000);
  const [form, setForm] = React.useState({ mode: 'mock', endpoint: '', token: '', freq: 60 });
  const [testResult, setTestResult] = React.useState<any>(null);
  const [saving, setSaving] = React.useState(false);
  const [dbmpBase, setDbmpBase] = React.useState('');
  const [dbmpOn, setDbmpOn] = React.useState(true);

  React.useEffect(() => {
    if (data) setForm(f => ({ ...f, mode: data.mode, endpoint: data.mode === 'zabbix' ? data.endpoint : '', freq: data.freq }));
    if (data?.dbmp) { setDbmpBase(f0 => f0 || data.dbmp.base || ''); setDbmpOn(!!data.dbmp.enabled); }
  }, [data?.mode, data?.freq, data?.dbmp?.enabled, data?.dbmp?.base]);

  const set = (k: string, v: any) => setForm(f => ({ ...f, [k]: v }));

  async function test() {
    setTestResult({ running: true });
    const r = await api.sourceTest();
    setTestResult(r);
    reload();
  }
  async function save() {
    setSaving(true);
    await api.sourceSave(form);
    setSaving(false);
    reload();
  }

  return (
    <div>
      <div className="grid-2" style={{ marginBottom: 14 }}>
        {/* 连接配置 */}
        <div className="card">
          <div className="card-title">数据源配置（JSON-RPC 2.0）</div>
          <div className="field">
            <label>数据源模式</label>
            <div className="seg" style={{ width: 'fit-content' }}>
              <button className={form.mode === 'mock' ? 'on' : ''} onClick={() => set('mode', 'mock')}>Mock 演示数据</button>
              <button className={form.mode === 'zabbix' ? 'on' : ''} onClick={() => set('mode', 'zabbix')}>真实 Zabbix API</button>
            </div>
          </div>
          {form.mode === 'zabbix' && (
            <>
              <div className="field">
                <label>API Endpoint（形如 http://host/zabbix/api_jsonrpc.php）</label>
                <input value={form.endpoint} onChange={e => set('endpoint', e.target.value)} placeholder="http://zabbix.example.com/zabbix/api_jsonrpc.php" />
              </div>
              <div className="field">
                <label>API Token（Zabbix 7.x Bearer Token）</label>
                <input type="password" value={form.token} onChange={e => set('token', e.target.value)} placeholder="••••••••••••" />
              </div>
            </>
          )}
          <div className="field">
            <label>采集频率（秒，30 / 60 / 120 档，默认 60）</label>
            <div className="seg" style={{ width: 'fit-content' }}>
              {[30, 60, 120].map(v => (
                <button key={v} className={form.freq === v ? 'on' : ''} onClick={() => set('freq', v)}>{v}s</button>
              ))}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10, marginTop: 6 }}>
            <button className="btn primary" onClick={save} disabled={saving}>{saving ? '保存中…' : '保存配置'}</button>
            <button className="btn" onClick={test}>测试连接并立即同步</button>
          </div>
          {testResult && !testResult.running && (
            <div className="card" style={{ marginTop: 12, background: testResult.ok ? 'rgba(76,175,80,.07)' : 'rgba(255,82,82,.07)' }}>
              <div className="mono" style={{ fontSize: 12, color: testResult.ok ? 'var(--sev-healthy)' : 'var(--sev-critical)' }}>
                {testResult.ok ? '✔ 连接成功' : `✘ 同步失败：${testResult.error}`}
                {' '}· 往返 {testResult.latencyMs}ms
              </div>
              {testResult.counts && (
                <div className="mono" style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 4 }}>
                  拉取对象：主机 {testResult.counts.hosts} · 服务 {testResult.counts.services} · 事件 {testResult.counts.events}
                </div>
              )}
              {testResult.dbmp && (
                <div className="mono" style={{ fontSize: 12, marginTop: 4, color: testResult.dbmp.ok ? 'var(--text-2)' : 'var(--sev-critical)' }}>
                  {testResult.dbmp.ok ? `zCloud 数据库实例 ${testResult.dbmp.instances} 个` : `zCloud 同步失败：${testResult.dbmp.error}`}
                </div>
              )}
            </div>
          )}
        </div>

        {/* 同步状态 */}
        <div className="card">
          <div className="card-title">采集器状态</div>
          {!data ? <div style={{ color: 'var(--text-3)' }}>加载中…</div> : (
            <>
              <div className="grid-2" style={{ gap: 10, marginBottom: 12 }}>
                <Stat label="当前数据源" value={data.mode === 'zabbix' ? 'Zabbix 真实源' : 'Mock 演示'} />
                <Stat label="版本" value={data.version} small />
                <Stat label="采集频率" value={`${data.freq}s`} />
                <Stat label="同步轮次" value={`#${data.syncCount}`} />
                <Stat label="最近同步" value={data.lastSync ? fmtTime(data.lastSync) : '—'} small />
                <Stat label="最近错误" value={data.lastError || '无'} small />
              </div>
              <div style={{ color: 'var(--text-2)', fontSize: 12, lineHeight: 1.8 }}>
                数据链路：Zabbix Server → <b className="mono">host.get / item.get / problem.get</b>（拉取<b>全部主机组</b>）→
                Collector（<b>三级类型判定：模板特征 → 主机命名 → 群组名</b>·去重聚合）→ REST API → 控制台。
                切换为真实 Zabbix 只需填入 Endpoint 与 Token，接口层按 JSON-RPC 2.0 规格实现，无需改动前端。
              </div>
              {data.classifyStats && (
                <div style={{ marginTop: 10 }}>
                  <div className="stat-label" style={{ marginBottom: 4 }}>类型判定依据分布</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {Object.entries(data.classifyStats as Record<string, number>).map(([via, n]) => (
                      <span key={via} className="badge info"><i className="bdot" />{via} · {n}</span>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* 数据库数据源：zCloud(dbmp) 北向API */}
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-title">数据库数据源 · zCloud(dbmp) 北向API<span className="spacer" />
          <span className={`badge ${data?.dbmp?.enabled ? (data?.dbmp?.lastError ? 'warning' : 'healthy') : 'info'}`}><i className="bdot" />
            {data?.dbmp?.enabled ? (data?.dbmp?.lastError ? '异常' : '采集中') : '已停用'}</span>
        </div>
        <div className="grid-2" style={{ gap: 10, marginBottom: 10 }}>
          <Stat label="北向API地址" value={data?.dbmp?.base || '—'} small />
          <Stat label="数据库实例" value={data?.dbmp ? `${data.dbmp.instances} 个` : '—'} />
          <Stat label="同步轮次" value={data?.dbmp ? `#${data.dbmp.syncCount}` : '—'} />
          <Stat label="最近同步" value={data?.dbmp?.lastSync ? fmtTime(data.dbmp.lastSync) : '—'} small />
        </div>
        {data?.dbmp?.counts && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
            {Object.entries(data.dbmp.counts as Record<string, any>).map(([t, c]: any) => (
              <span key={t} title={c.error || ''} className={`badge ${c.error ? 'critical' : c.n ? 'healthy' : 'info'}`}><i className="bdot" />{t} · {c.n}{c.error ? ' ✘' : ''}</span>
            ))}
          </div>
        )}
        {(() => {
          // 整体异常（lastError）或任一库型的请求错误都显式展示，便于现场直接定位
          const cntErr = Object.values((data?.dbmp?.counts || {}) as Record<string, any>).find(c => c.error)?.error || null;
          const msg = data?.dbmp?.lastError || cntErr;
          return msg ? <div className="mono" style={{ fontSize: 12, color: 'var(--sev-critical)', marginBottom: 8 }}>最近错误：{msg}</div> : null;
        })()}
        <div className="field">
          <label>北向API Base（免鉴权 customApi；留空或关闭则数据库域回到无数据态）</label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input value={dbmpBase} onChange={e => setDbmpBase(e.target.value)} placeholder="http://10.70.0.94:8023" style={{ flex: 1, maxWidth: 360 }} />
            <div className="seg" style={{ width: 'fit-content' }}>
              <button className={dbmpOn ? 'on' : ''} onClick={() => setDbmpOn(true)}>启用</button>
              <button className={!dbmpOn ? 'on' : ''} onClick={() => setDbmpOn(false)}>停用</button>
            </div>
            <button className="btn primary" onClick={async () => { await api.sourceSave({ dbmp: { enabled: dbmpOn, base: dbmpBase } }); reload(); }}>保存</button>
          </div>
        </div>
        <div style={{ color: 'var(--text-2)', fontSize: 12, lineHeight: 1.8 }}>
          数据链路：zCloud <b className="mono">:8023 getDbInfo（资产）/ getCustomInfo（实时状态快照）</b> → 数据库域实体（角色/版本/连接/线程/库列表）→
          趋势由本平台按周期采样真实累计计数器差值生成（zCloud 自带 Prometheus :8093 需 Basic 账密，配置后可切原生历史曲线）。
        </div>
      </div>

      {/* 群组映射 */}
      <div className="card">
        <div className="card-title">Zabbix 群组 → 监控域映射（同步自监控源·全群组主机逐台判定）</div>
        <table className="data">
          <thead><tr><th>Zabbix 群组</th><th>主机数</th><th>判定域分布</th><th>主域</th><th>采集频率</th><th>映射状态</th></tr></thead>
          <tbody>
            {(data?.mapping || []).map((m: any) => (
              <tr key={m.zbxGroup}>
                <td className="mono">{m.zbxGroup}</td>
                <td className="mono">{m.total ?? m.count}</td>
                <td>
                  {m.counts
                    ? Object.entries(m.counts as Record<string, number>)
                        .sort((a: any, b: any) => b[1] - a[1])
                        .map(([d, n]: any) => `${DOM_LABEL[d] || d} ${n}`).join(' · ')
                    : m.domainLabel}
                </td>
                <td>{m.domainLabel}</td>
                <td className="mono">{m.freq}s</td>
                <td>
                  {m.mixed
                    ? <span className="badge warning"><i className="bdot" />跨域群组</span>
                    : <span className="badge healthy"><i className="bdot" />已同步</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {data?.mapping?.length ? (
          <div style={{ color: 'var(--text-3)', fontSize: 12, marginTop: 8 }}>
            群组为业务命名（如"办公网"），与主机类型无必然对应；平台按主机挂载模板/命名逐台判定类型，跨域群组以多数域标注。
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Stat({ label, value, small }: { label: string; value: any; small?: boolean }) {
  return (
    <div className="card" style={{ background: 'var(--bg-inset)', padding: '9px 12px' }}>
      <div className="stat-label">{label}</div>
      <div className="mono" style={{ fontSize: small ? 13 : 17, fontWeight: 600, marginTop: 2, wordBreak: 'break-all' }}>{value}</div>
    </div>
  );
}

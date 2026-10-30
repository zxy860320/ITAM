import React from 'react';
import { api } from '../api';
import { fmtTime } from './common';

/** 设备配置备份面板（设备详情抽屉内）：一键备份 + 历史列表 + 任选两份差异比对。
 *  目标标识用设备 IP（跳板机资产名多为裸 IP）；备份经服务端白名单模板，输出脱敏。 */
export default function BackupPanel({ entity }: { entity: any }) {
  const keyIp = entity.ip || '';
  const keyName = entity.name || '';
  const [list, setList] = React.useState<any[] | null>(null);
  const [err, setErr] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [opMsg, setOpMsg] = React.useState<any>(null);
  const [picked, setPicked] = React.useState<string[]>([]);
  const [diff, setDiff] = React.useState<any>(null);
  const [fulltext, setFulltext] = React.useState<any>(null);

  const load = React.useCallback(() => {
    const keys = [...new Set([keyIp, keyName].filter(Boolean))];
    Promise.all(keys.map(k => api.opsBackups({ assetKey: k, limit: 100 }).catch(() => ({ items: [] }))))
      .then(rs => {
        const seen = new Set<string>(); const merged: any[] = [];
        for (const r of rs) for (const it of r.items || []) if (!seen.has(it.id)) { seen.add(it.id); merged.push(it); }
        merged.sort((a, b) => b.at - a.at);
        setList(merged);
      })
      .catch(e => setErr(String(e.message || e)));
  }, [keyIp, keyName]);
  React.useEffect(() => { load(); }, [load]);

  async function backupNow() {
    setBusy(true); setOpMsg(null);
    try {
      const r = await api.opsBackupNow({ asset: keyIp || keyName });
      const b = r.backup;
      setOpMsg({ ok: true, text: b ? `备份完成 · ${r.bytes} B · ${b.changed ? (b.prevSha1 == null ? '首次备份' : '配置有变更') : '与上份一致'}` : '执行完成' });
      load();
    } catch (e: any) {
      setOpMsg({ ok: false, text: String(e.message || e).slice(0, 200) });
    }
    setBusy(false);
  }

  function togglePick(id: string) {
    setPicked(p => p.includes(id) ? p.filter(x => x !== id) : [...p, id].slice(-2));
  }
  async function compare() {
    if (picked.length !== 2) return;
    setDiff({ loading: true });
    try { setDiff(await api.opsDiff(picked[0], picked[1])); }
    catch (e: any) { setDiff({ error: String(e.message || e) }); }
  }
  // 快捷：与上一份比对（列表降序，同设备下一条即上一份）
  function quickDiff(i: number) {
    const cur = list![i];
    const prev = list!.slice(i + 1).find(x => x.assetKey === cur.assetKey);
    if (!prev) return;
    setPicked([cur.id, prev.id]);
    setDiff({ loading: true });
    api.opsDiff(cur.id, prev.id).then(setDiff).catch(e => setDiff({ error: String(e.message || e) }));
  }
  async function viewFull(id: string) {
    setFulltext({ loading: true });
    try { setFulltext(await api.opsBackup(id)); }
    catch (e: any) { setFulltext({ error: String(e.message || e) }); }
  }

  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div className="card-title">配置备份（经跳板机）
        <span className="spacer" />
        {list && list.length > 0 && <span style={{ fontSize: 11, color: 'var(--text-3)' }}>最近 {fmtTime(list[0].at)}</span>}
        <button className="btn" style={{ marginLeft: 8, padding: '4px 12px', fontSize: 11 }}
          onClick={backupNow} disabled={busy}>{busy ? '备份中（约10-60s）…' : '立即备份'}</button>
      </div>
      {opMsg && <div style={{ fontSize: 12, marginBottom: 6, color: opMsg.ok ? 'var(--sev-healthy)' : 'var(--sev-critical)' }}>{opMsg.ok ? '✔ ' : '✘ '}{opMsg.text}</div>}
      {err && <div style={{ fontSize: 12, color: 'var(--sev-critical)', marginBottom: 6 }}>{err}</div>}
      {!list && <div style={{ color: 'var(--text-3)', fontSize: 12 }}>加载备份记录…</div>}
      {list && !list.length && <div style={{ color: 'var(--text-3)', fontSize: 12 }}>该设备暂无备份记录——点「立即备份」抓取当前配置（只读，经跳板机 KoKo 审计）</div>}
      {list && list.length > 0 && (
        <>
          <table className="data fixed nowrap">
            <colgroup>
              <col style={{ width: '18%' }} /><col style={{ width: '22%' }} /><col style={{ width: '9%' }} /><col style={{ width: '15%' }} />
              <col style={{ width: '10%' }} /><col style={{ width: '26%' }} />
            </colgroup>
            <thead><tr><th>时间</th><th>命令</th><th className="num">字节</th><th>指纹</th><th>变更</th><th>操作</th></tr></thead>
            <tbody>
              {list.slice(0, 30).map((b, i) => {
                const hasPrev = list.slice(i + 1).some(x => x.assetKey === b.assetKey);
                return (
                  <tr key={b.id}>
                    <td className="mono" style={{ fontSize: 11 }}>
                      <input type="checkbox" style={{ width: 'auto', marginRight: 6 }} checked={picked.includes(b.id)} onChange={() => togglePick(b.id)} />
                      {fmtTime(b.at)}
                    </td>
                    <td className="mono" style={{ fontSize: 11, color: 'var(--text-3)' }}>{b.command}</td>
                    <td className="num mono" style={{ fontSize: 11 }}>{b.bytes}</td>
                    <td className="mono" style={{ fontSize: 11 }}>{b.sha1.slice(0, 10)}</td>
                    <td>{b.changed ? <span className="badge warning"><span className="bdot" />变更</span> : <span className="badge healthy"><span className="bdot" />一致</span>}</td>
                    <td style={{ display: 'flex', gap: 6 }}>
                      <button className="btn" style={{ padding: '3px 9px', fontSize: 11 }} onClick={() => viewFull(b.id)}>全文</button>
                      {hasPrev && <button className="btn" style={{ padding: '3px 9px', fontSize: 11 }} onClick={() => quickDiff(i)}>与上份diff</button>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="toolbar" style={{ margin: '8px 0 0' }}>
            <button className="btn primary" style={{ padding: '4px 12px', fontSize: 11 }} onClick={compare} disabled={picked.length !== 2}>
              比对所选（{picked.length}/2）
            </button>
            <span style={{ fontSize: 11, color: 'var(--text-3)' }}>勾选任意两份备份做行级差异比对（脱敏后）</span>
          </div>
        </>
      )}
      {diff && (
        <div style={{ marginTop: 10 }}>
          {diff.loading && <div style={{ color: 'var(--text-3)', fontSize: 12 }}>比对中…</div>}
          {diff.error && <div style={{ color: 'var(--sev-critical)', fontSize: 12 }}>{diff.error}</div>}
          {diff.lines && <DiffView diff={diff} onClose={() => setDiff(null)} />}
        </div>
      )}
      {fulltext && (
        <Modal onClose={() => setFulltext(null)}
          title={fulltext.meta ? `${fulltext.meta.assetName} · ${fmtTime(fulltext.meta.at)} · ${fulltext.meta.bytes} B（密码/密文已脱敏）` : '备份全文'}>
          {fulltext.loading && <div style={{ color: 'var(--text-3)' }}>加载中…</div>}
          {fulltext.error && <div style={{ color: 'var(--sev-critical)' }}>{fulltext.error}</div>}
          {fulltext.textRedacted != null && <pre className="mono" style={{ background: 'var(--bg-inset)', border: '1px solid var(--hairline)', borderRadius: 6, padding: 10, fontSize: 11.5, lineHeight: 1.5, overflow: 'auto', whiteSpace: 'pre-wrap', flex: 1 }}>{fulltext.textRedacted}</pre>}
        </Modal>
      )}
    </div>
  );
}

/** diff 视图：a=旧(红删除) b=新(绿新增)，灰=上下文；行号 na/nb */
export function DiffView({ diff, onClose }: { diff: any; onClose?: () => void }) {
  const oldR = diff.a.at <= diff.b.at ? diff.a : diff.b;
  const newR = diff.a.at <= diff.b.at ? diff.b : diff.a;
  return (
    <div style={{ border: '1px solid var(--hairline)', borderRadius: 'var(--radius-sm)', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', background: 'var(--bg-inset)', fontSize: 11, flexWrap: 'wrap' }}>
        <span className="mono" style={{ color: 'var(--sev-critical)' }}>旧 {fmtTime(oldR.at)}（{oldR.sha1.slice(0, 10)}）</span>
        <span style={{ color: 'var(--text-3)' }}>→</span>
        <span className="mono" style={{ color: 'var(--sev-healthy)' }}>新 {fmtTime(newR.at)}（{newR.sha1.slice(0, 10)}）</span>
        <span className="spacer" style={{ flex: 1 }} />
        <span className="mono" style={{ color: 'var(--sev-healthy)' }}>+{diff.added}</span>
        <span className="mono" style={{ color: 'var(--sev-critical)' }}>-{diff.removed}</span>
        {diff.truncated && <span className="tag-chip" title="差异过大仅显示前 6000 行">已截断</span>}
        {onClose && <button className="btn" style={{ padding: '3px 9px', fontSize: 11 }} onClick={onClose}>收起</button>}
      </div>
      {diff.same && <div style={{ padding: 10, fontSize: 12, color: 'var(--text-3)' }}>两份备份指纹相同，内容完全一致。</div>}
      {!diff.same && (
        <pre className="mono" style={{ margin: 0, fontSize: 11, lineHeight: 1.55, maxHeight: 420, overflow: 'auto' }}>
          {diff.lines.map((x: any, i: number) => (
            <div key={i} style={{
              background: x.t === '+' ? 'rgba(76,175,80,.13)' : x.t === '-' ? 'rgba(255,82,82,.13)' : undefined,
              color: x.t === '+' ? 'var(--sev-healthy)' : x.t === '-' ? 'var(--sev-critical)' : 'var(--text-3)',
              padding: '0 10px', whiteSpace: 'pre-wrap', wordBreak: 'break-all',
            }}>
              <span style={{ display: 'inline-block', width: 46, color: 'var(--text-3)', opacity: .7 }}>{x.na ?? ''}</span>
              <span style={{ display: 'inline-block', width: 46, color: 'var(--text-3)', opacity: .7 }}>{x.nb ?? ''}</span>
              <span style={{ display: 'inline-block', width: 14 }}>{x.t}</span>{x.l}
            </div>
          ))}
        </pre>
      )}
    </div>
  );
}

export function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 90 }}
      onClick={onClose}>
      <div className="card" style={{ width: 'min(960px, 94vw)', maxHeight: '86vh', display: 'flex', flexDirection: 'column', zIndex: 91 }}
        onClick={e => e.stopPropagation()}>
        <div className="card-title">{title}<span className="spacer" />
          <button className="btn" style={{ padding: '4px 10px', fontSize: 11 }} onClick={onClose}>关闭</button>
        </div>
        {children}
      </div>
    </div>
  );
}

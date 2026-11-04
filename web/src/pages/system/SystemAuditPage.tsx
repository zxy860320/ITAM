import React from 'react';
import { api, usePoll } from '../../api';
import { fmtTime } from '../../components/common';

/** 系统管理 · 审计日志：登录 / 授权变更 / 资产操作留痕 */
export default function SystemAuditPage() {
  const { data } = usePoll(api.system, 20000);

  return (
    <div className="card">
      <div className="card-title">操作审计日志（最近 {data?.auditLog?.length ?? 0} 条：登录 / 授权变更 / 资产操作）</div>
      <table className="data">
        <thead><tr><th>时间</th><th>操作者</th><th>动作</th></tr></thead>
        <tbody>
          {(data?.auditLog || []).map((l: any, i: number) => (
            <tr key={i}>
              <td className="mono" style={{ color: 'var(--text-2)' }}>{fmtTime(l.at)}</td>
              <td>{l.user}</td>
              <td style={{ color: 'var(--text-2)' }}>{l.action}{l.detail ? `（${l.detail}）` : ''}</td>
            </tr>
          ))}
          {!(data?.auditLog || []).length && <tr><td colSpan={3} style={{ color: 'var(--text-3)' }}>暂无审计记录</td></tr>}
        </tbody>
      </table>
      <div style={{ marginTop: 10, fontSize: 12, color: 'var(--text-3)' }}>
        原始留痕在服务端 data/auth_audit.jsonl 与 data/asset_audit.jsonl（追加式，不落库）；本页展示合并后的最近 20 条。
      </div>
    </div>
  );
}

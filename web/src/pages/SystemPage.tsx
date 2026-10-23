import React from 'react';
import { api, usePoll } from '../api';
import { fmtTime } from '../components/common';

/** 系统管理页：RBAC 四角色 + 审计日志（只读展示 + 模拟） */
export default function SystemPage() {
  const { data } = usePoll(api.system, 30000);

  return (
    <div>
      <div className="stat-row">
        <div className="card"><div className="stat-num">4</div><div className="stat-label">角色（RBAC）</div></div>
        <div className="card"><div className="stat-num">3</div><div className="stat-label">告警通知渠道（规划中）</div></div>
        <div className="card"><div className="stat-num">1</div><div className="stat-label">已对接监控源</div></div>
        <div className="card"><div className="stat-num" style={{ color: 'var(--sev-healthy)' }}>正常</div><div className="stat-label">平台运行状态</div></div>
      </div>

      <div className="grid-2" style={{ marginBottom: 14 }}>
        <div className="card">
          <div className="card-title">角色与能力矩阵（RBAC）</div>
          <table className="data">
            <thead><tr><th>角色</th><th>能力</th></tr></thead>
            <tbody>
              {(data?.roles || []).map((r: any) => (
                <tr key={r.role}>
                  <td>{r.label}<span className="mono" style={{ color: 'var(--text-3)', marginLeft: 8, fontSize: 11 }}>{r.role}</span></td>
                  <td style={{ color: 'var(--text-2)' }}>{r.perms.join(' · ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ marginTop: 10, fontSize: 12, color: 'var(--text-3)' }}>
            本期为只读展示；用户体系与权限 CRUD 在 M4 里程碑接入。
          </div>
        </div>

        <div className="card">
          <div className="card-title">通知渠道</div>
          {[
            ['邮件', 'SMTP · 运维组邮件组', '规划中'],
            ['钉钉', '群机器人 Webhook', '规划中'],
            ['短信', '网关对接（紧急告警）', '规划中'],
          ].map(([n, d, s]) => (
            <div key={n} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 0', borderBottom: '1px solid var(--hairline)' }}>
              <b style={{ width: 44 }}>{n}</b>
              <span style={{ flex: 1, color: 'var(--text-2)', fontSize: 12 }}>{d}</span>
              <span className="badge info"><i className="bdot" />{s}</span>
            </div>
          ))}
          <div className="card-title" style={{ marginTop: 14 }}>Webhook（自定义）</div>
          <div style={{ fontSize: 12, color: 'var(--text-3)' }}>支持将告警事件推送至外部工单系统（M4）。</div>
        </div>
      </div>

      <div className="card">
        <div className="card-title">操作审计日志（最近 {data?.auditLog?.length ?? 0} 条）</div>
        <table className="data">
          <thead><tr><th>时间</th><th>操作者</th><th>动作</th></tr></thead>
          <tbody>
            {(data?.auditLog || []).map((l: any, i: number) => (
              <tr key={i}>
                <td className="mono" style={{ color: 'var(--text-2)' }}>{fmtTime(l.at)}</td>
                <td>{l.user}</td>
                <td style={{ color: 'var(--text-2)' }}>{l.action}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

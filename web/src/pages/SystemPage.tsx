import React from 'react';
import { api, usePoll } from '../api';
import { fmtTime } from '../components/common';

const PERM_LABELS: Record<string, string> = {
  'asset.write': '资产台账编辑', 'ops.exec': '设备操作', 'event.ack': '确认告警',
  'link.review': '链路审核', 'platform.config': '平台配置', 'user.manage': '用户管理',
  'ticket.manage': '工单管理(预留)', 'ticket.handle': '工单处理(预留)',
};

/** 系统管理页：真实角色矩阵（来自用户管理）+ AD 状态 + 操作审计日志 */
export default function SystemPage() {
  const { data } = usePoll(api.system, 30000);

  return (
    <div>
      <div className="stat-row">
        <div className="card"><div className="stat-num">{data?.roles?.length ?? '—'}</div><div className="stat-label">角色（RBAC，可在用户管理页自定义）</div></div>
        <div className="card"><div className="stat-num">{data?.users?.total ?? '—'}</div><div className="stat-label">平台用户（本地 {data?.users?.local ?? 0} · AD {data?.users?.ad ?? 0}）</div></div>
        <div className="card">
          <div className="stat-num" style={{ color: data?.ad?.enabled ? 'var(--sev-healthy)' : 'var(--text-3)' }}>
            {data?.ad?.enabled ? '已启用' : '未启用'}
          </div>
          <div className="stat-label">AD 域登录（{data?.ad?.url || '未配置'}）</div>
        </div>
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
                  <td style={{ color: 'var(--text-2)' }}>
                    查看{r.perms.map((k: string) => ' · ' + (PERM_LABELS[k] || k)).join('')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ marginTop: 10, fontSize: 12, color: 'var(--text-3)' }}>
            数据实时来自「用户管理」页（内置 admin/operator/viewer + 自定义角色）；权限变更即时生效（旧会话自动失效）。
          </div>
        </div>

        <div className="card">
          <div className="card-title">登录与账号体系</div>
          <table className="data">
            <tbody>
              <tr><td>登录方式</td><td style={{ color: 'var(--text-2)' }}>本地账号（scrypt 哈希）+ AD 域（LDAP UPN bind）</td></tr>
              <tr><td>会话</td><td style={{ color: 'var(--text-2)' }}>httpOnly cookie · 7 天 · 连续 5 次失败锁定 15 分钟</td></tr>
              <tr><td>AD 首登</td><td style={{ color: 'var(--text-2)' }}>自动入册并赋予默认角色，可改角色/禁用</td></tr>
              <tr><td>门禁</td><td style={{ color: 'var(--text-2)' }}>除监控大屏免登录外，全部页面与 API 需登录</td></tr>
            </tbody>
          </table>
          <div style={{ marginTop: 10, fontSize: 12, color: 'var(--text-3)' }}>
            AD 地址、Base DN、域名后缀、默认角色在「用户管理 → AD 域对接」配置，支持连通性测试；拿到 DC 地址后填入即生效，无需改代码。
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-title">操作审计日志（最近 {data?.auditLog?.length ?? 0} 条：登录/授权变更/资产操作）</div>
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
      </div>
    </div>
  );
}

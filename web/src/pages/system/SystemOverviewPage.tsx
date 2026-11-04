import React from 'react';
import { api, usePoll } from '../../api';

/** 系统管理 · 运行概览：平台自身状态速览 + 各子页直达 */
export default function SystemOverviewPage() {
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

      <div className="grid-2" style={{ gap: 12 }}>
        <div className="card">
          <div className="card-title">功能入口</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13 }}>
            <a href="#/system-mail" style={{ color: 'var(--text-1)' }}>✉ 邮件服务（SMTP）— 全平台收发邮件的唯一配置源，配置后可发测试邮件验证</a>
            <a href="#/system-perms" style={{ color: 'var(--text-1)' }}>🛡 权限与账号 — 角色能力矩阵（RBAC）、登录与会话策略</a>
            <a href="#/system-audit" style={{ color: 'var(--text-1)' }}>📜 审计日志 — 登录 / 授权变更 / 资产操作留痕</a>
            <a href="#/users" style={{ color: 'var(--text-1)' }}>👥 用户管理 — 账号增删、角色分配、AD 域对接（独立菜单）</a>
          </div>
          <div style={{ marginTop: 10, fontSize: 12, color: 'var(--text-3)' }}>
            系统管理已按职责拆分：概览 / 邮件服务 / 权限与账号 / 审计日志，各自独立页面，互不干扰。
          </div>
        </div>
        <div className="card">
          <div className="card-title">平台组件状态</div>
          <table className="data">
            <tbody>
              <tr><td>采集器</td><td style={{ color: 'var(--sev-healthy)' }}>运行中（Zabbix 数据源）</td></tr>
              <tr><td>认证</td><td style={{ color: 'var(--text-2)' }}>本地账号 + AD 域，全站门禁</td></tr>
              <tr><td>邮件服务</td><td style={{ color: data?.mailReady ? 'var(--sev-healthy)' : 'var(--sev-warning)' }}>
                {data?.mailReady ? '已就绪（告警/工单邮件可发送）' : '未配置或不完整——请到「邮件服务」页配置'}
              </td></tr>
              <tr><td>告警出口</td><td style={{ color: 'var(--text-2)' }}>{data?.notifyEnabled ? '推送开启' : '推送关闭'}（在「告警出口」页维护）</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

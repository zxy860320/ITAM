# IT运维监控平台（ITYW）

基于 Zabbix 数据源的 IT 运维监控平台，复刻 7 张 Ardot 高保真设计稿（dark-monitoring-ops 设计系统）。

## 快速启动

```bash
# 1. 后端（:8787）
cd server && npm install && npm start

# 2. 前端（:5273，/api 自动代理到后端）
cd web && npm install && npm run dev
```

打开 http://localhost:5273 即可使用（`#/dashboard` 大屏 · `#/server|database|network|service` 四域 · `#/source` 对接 · `#/system` 系统管理）。

## 技术栈

| 层 | 选型 |
|---|---|
| 前端 | React 18 + Vite 5 + ECharts（无 Router，hash 路由）|
| 后端 | Node.js 22 + Express，Collector 轮询采集（默认 60s）|
| 数据源 | 双模：**Mock 确定性数据集**（默认）/ **真实 Zabbix 7.2 JSON-RPC**（配置即切换）|

## 数据链路

```
Zabbix Server ──host/item/trigger/event──▶ Collector（群组映射·去重·四态分级）
                                              │  mock 模式：确定性种子数据集
                                              ▼
                              REST API（/api/*）──▶ 控制台七页 + 大屏
```

## 关键口径（对齐产品文档基线）

- 监控对象 **354** = 主机 **318**（Linux 186 / Windows 72 / 网络 42 / MySQL 18）+ 服务 **36**
- 群组映射五条：Linux servers→服务器 · Windows servers→服务器 · Network devices→网络设备 · MySQL databases→数据库 · Application services→服务
- 告警四态：紧急 `#FF5252` / 严重 `#FF7F0E` / 警告 `#F2C94C` / 信息 `#29B6F6`
- 采集频率三档：30s / 60s / 120s（默认 60s），监控源对接页可改

## 切换真实 Zabbix

进入「监控源对接」页 → 选「真实 Zabbix API」→ 填 Endpoint（`http://<zbx>/zabbix/api_jsonrpc.php`）与 Bearer Token → 测试连接 → 保存。
接口层已按 Zabbix 7.2 `host.get / problem.get` JSON-RPC 2.0 规格实现（`server/src/collector/zabbixClient.js`），无需改动前端。

## 目录结构

```
server/src/
  server.js                 # Express 入口 + REST API
  collector/zabbixClient.js # JSON-RPC 适配层（mock|zabbix 双模）
  collector/mockData.js     # 确定性数据集（种子可复现）
  collector/aggregate.js    # 聚合层（summary/趋势/分页筛选）
web/src/
  App.tsx                   # hash 路由 + 侧栏（active 三重强调）
  styles/tokens.css         # dark-monitoring-ops 设计令牌
  pages/Dashboard.tsx       # 监控大屏 1920×1080 等比缩放
  pages/EntityPage.tsx      # 四域共用列表+详情抽屉骨架
  pages/SourcePage.tsx      # 监控源对接（映射五条/频率三档/连通测试）
  pages/SystemPage.tsx      # RBAC 四角色 + 审计日志
```

## 本期范围（In / Out）

- **In**：七页控制台、数据链路（mock+真实适配层）、告警四态分级与确认（ack）、RBAC 展示、审计日志
- **Out（M4 规划）**：真实告警渠道分发（邮件/钉钉/短信）、登录与权限 CRUD、CMDB 联动

# ITYW 运维平台 —— 功能点与实现逻辑说明

> 基于代码实况整理（2026-10-31，main @ 103f1ba）。配套文档：`TOPOLOGY-P1-DESIGN.md`（拓扑表设计）、`TOPOLOGY-P2-DESIGN.md`（路径追踪）、`DEPLOY-DOCKER.md`（生产部署）。

---

## 0. 总体架构

```
                    ┌─────────────────────────────────────────────┐
 浏览器 ──▶ web (Vite dev :5273 / nginx :80)                       │
                    │  /api ──▶ server :8787   /topo-api ──▶ :8790 │
                    └─────────────────────────────────────────────┘
 server :8787 (Express, P0 监控+运维+AI工具层)
   ├─ ZabbixCollector  ◀── Zabbix 7.0.32 JSON-RPC (http://10.25.6.8:8080/api_jsonrpc.php)
   ├─ DbmpClient       ◀── zCloud(dbmp) 北向API (http://10.70.0.94:8023)
   ├─ Notifier         ──▶ 钉钉/飞书/企业微信 webhook、SMTP
   ├─ mountOps         ◀── JumpServer 跳板机 MCP（配置备份/只读巡检）
   ├─ mountAssets      (台账 + AES-256-GCM 加密凭据)
   ├─ mountMcp  /mcp   ──▶ AI 工具层（JSON-RPC 手写 MCP Streamable HTTP，9 工具）
   └─ proxyAgent /api/agent/* ──▶ agent :8791 (LangGraph + MCP 客户端 + SSE)
 topology-svc :8790 (P1 拓扑 + P2 路径追踪，独立进程)
   └─ db: sqlite(node:sqlite，本地默认) / MySQL 8（compose 生产），SQL 方言自动翻译
```

| 进程 | 端口 | 说明 |
|---|---|---|
| server（P0） | 8787 | 监控数据、告警出口、运维、资产、/mcp、agent 代理 |
| topology-svc（P1/P2） | 8790 | 节点/接口/链路、LLDP 发现、路由快照与路径追踪 |
| agent（AI） | 8791 | LangGraph 助手，仅容器网络/本机可达（compose 不映射宿主端口） |
| web | 5273(dev)/80(nginx) | React SPA，hash 路由 |

**平台红线（贯穿全部模块）**：
1. **不伪造数据**——所有展示来自真实采集；拉不到就标 unknown/error 并如实说明，mock 兜底仅在明确 mock 模式或真实源完全不可用时出现且口径可辨。
2. **凭据与配置密文不出接口**——备份全文脱敏、资产密码加密存储、token 只回 hasToken。
3. **写操作先确认**——一键备份、批量审核等均需显式触发/操作人。
4. **拓扑断言只认证据**——物理链路只认 LLDP/人工，禁止 Ping/IP 连通性推断直连。

---

## 1. P0 监控（server :8787）

### 1.1 采集层 `collector/zabbixClient.js`（757 行）

- **传输**：Zabbix JSON-RPC 2.0，Bearer token。特例：`apiinfo.version` 必须**不带** Authorization 头（带反而报 -32602）。
- **单轮采集（sync）**：7 个 RPC 并行 `Promise.all`——
  `host.get`（含 selectGroups/selectParentTemplates）、`problem.get`（活动告警+tags）、`trigger.get`（problem.objectid=triggerid → trigger→host 映射，否则告警挂不到主机）、`item.get` 关键指标（CPU/内存/文件系统/uptime，`search` 部分匹配捞多核多盘变体，output extend 直接带 lastvalue）、`item.get` 摘要项（型号/版本/位置/温度/ICMP 三件套/无线 AC 汇总）、`item.get countOutput`（监控项总数）、`hostinterface.get`（Agent/SNMP 接口 IP）。
  实测坑：7.0.32 `host.get` 的 `selectHostInterfaces` 不返回数据 → 接口必须单独查。
- **三级域分类 `classify()`**：模板特征正则 → 主机命名正则 → 群组名兜底（默认 server）；网络主机判据是链接了 `*/by SNMP/i` 模板。无线控制器（模板 `/wireless access controller/i` 或命名 `/wuxian|无线/`）仍归 network，但打 `wlan=true` 伪域标记，视图层拆出「无线网络」独立分组。
- **指标聚合细节**：多核/多盘取 max；`lastclock=0`（从未采集）跳过；CPU 分量项（`[,idle]`/`[,user]`）用 `CPU_COMPONENT_RE` 排除——**idle≠使用率**（Zabbix 手册 §7.4 坑）。
- **IP 解析**：`hostinterface.get` main 优先、Agent(1)>SNMP(2)，无效再从主机名正则提取（如 `h3c-10.14.0.127/xx`）。
- **告警挂接**：problem → trigger→host 映射 → 补 hostid/domain，事件可按域过滤（wlan 按主机集合映射）。
- **深度详情 `detail(hostid)`**（带缓存）：档案 profile + 监控接口 + 全监控项 + 近 6h 时序，点开抽屉时按需实时拉 Zabbix。
- **时序 `series(hostid, range, till, iface, dev, mnt, ap)`**：窗口规则——`range≤86400s` 走 `history.get` raw；`>86400s`（7d/30d）走 `trend.get` 小时包络（min/avg/max）。支持切换流量接口、磁盘设备、分区挂载点、无线 AP 维度。SNMP 文本项读数一律 `history.get history=4`（log 型）。
- **失败兜底**：真实源出错时保留旧 dataset；从未成功过则回落 mock（mockData.js，确定性 seed）保证 UI 不白屏。

### 1.2 聚合层 `collector/aggregate.js`

`summary()`（各域健康分布+严重度计数+总体可用率）、`topProblems()`（按严重度+时间排 Top N）、`eventTrend()`（24h 小时桶）、`listFilter()`（domain/q/status/availability，network 与 wlan 拆分口径与列表一致）、`paginate()`。

### 1.3 API 一览（server.js，全部经 `guard`：首采未完成回 503）

| 路由 | 逻辑 |
|---|---|
| GET /api/summary、/api/dashboard | 总览/大屏：summary+采集器状态；大屏另加 topProblems/eventTrend/recent/topCpu/topRt |
| GET /api/entities | 通用实体列表（hosts+services 合并），critical→warning→healthy 排序 |
| GET /api/entities/:id | 实体+关联事件 |
| GET /api/entities/:id/detail | Zabbix 实时深度详情；`dbmp-` 前缀实体走 zCloud 快照（**不走 mock 兜底**）；mock 模式给轻量 detail |
| GET /api/entities/:id/series | 时间窗时序（range/till 回看锚点/iface/dev/mnt/ap）；dbmp 实体走本地真实采样差值序列 |
| GET /api/events、POST /api/events/:id/ack | 告警列表（severity/status/domain 过滤）与确认（内存态） |
| GET/POST /api/source* | 监控源对接页：读取配置、测试连通（真 sync 一轮回计数与延迟）、保存（freq 夹 30~120s），持久化 `data/source.json` |
| GET/POST /api/notify* | 告警出口配置/测试（见 §2） |
| GET /api/system | 角色与审计（演示级静态数据） |

### 1.4 数据库域补位 `collector/dbmpClient.js`（zCloud/dbmp）

- 通道：`GET :8023/.../getDbInfo`（实例资产清单，免鉴权）、`getCustomInfo`（每实例实时快照：`databasestatus`≈SHOW GLOBAL STATUS、`databasevariable`≈SHOW VARIABLES、库/账号清单）。
- 实体 ID 前缀 `dbmp-`，`domain:'database'`，在 `mergedData()` 与 Zabbix hosts 合并。
- **QPS/TPS 走势**：zCloud 自带 Prometheus(:8093) 需 Basic 账密未配置 → 本地按采样周期读真实累计计数器（Questions/Com_commit 等）**差值采样**存 `data/dbmp_samples.json`；每实例最多 2016 点，超限 2:1 抽稀（差值仍精确）；采样起点之前的区间如实为空，`meta.samplesFrom` 标注可回溯起点。
- 诚实原则：拉不到标 unknown；DB 实体详情无快照时返回明确 note 而非编造。

### 1.5 告警出口 `alerter/alerter.js`

- 通道：钉钉/飞书/企业微信（群机器人 webhook，含钉钉加签/飞书签名）、邮件(SMTP，nodemailer 连接复用)。
- **差分机制**：每轮采集后 `diffAndSend(events)`——新增活动告警按通道路由规则（最低级别/域/正则）发送；恢复事件发恢复通知（可关）；**服务重启首轮只建基线不补发**（防重启风暴）；每通道每轮最多聚合 2 条（新增 1 + 恢复 1），单条最多列 10 行。
- 状态持久化 `data/notify_state.json`（已恢复事件快照 7 天 TTL 剪枝）。
- 配置持久化 `data/notify.json`；secret/webhook 回前端一律 mask（`•` 掩码），保存时识别掩码值不覆盖原值。

---

## 2. P1 网络拓扑（topology-svc :8790）

### 2.1 数据层 `db.js`：sqlite/MySQL 双引擎

- 统一异步外观（`prepare().get/all/run`）；本地默认 sqlite（node:sqlite，WAL），compose 生产 `TOPO_DB=mysql` 走 MySQL 8。
- **方言翻译 `toMysqlSql()`**：调用方一律写 sqlite 风格 SQL，MySQL 侧自动改写——`ON CONFLICT(k) DO UPDATE SET x=excluded.x → ON DUPLICATE KEY UPDATE x=VALUES(x)`（常量赋值透传）、`CAST AS REAL→DOUBLE`、`AUTOINCREMENT→AUTO_INCREMENT`。已实测验证（含 pathtrace 快照 upsert）。
- 表：`topology_node` / `topology_interface` / `topology_link` / `topology_metric_mapping` / `topo_meta`（KV 元数据：快照、last_sync/last_disc 等）。凭据不落库。
- 坑：node:sqlite 读超 2^53 的 INTEGER 直接抛错 → 聚合也要 `CAST(... AS REAL)`（speed 项脏值事故后加固）。

### 2.2 节点/接口同步 `sync.js`

Zabbix → node/interface/metric_mapping。接口标识用 **fingerprint = sha1(node|if_name|if_descr)**：ifIndex 是可变属性，漂移时只改 `if_index` 属性而 `interface_id` 不变（抗漂移，用户规则）。接口名/类型从监控项 key 精确形态解析（`net.if.in[ifHCInOctets.<idx>]` 等，排除逗号变体与点式 errors 冒充），分类 loopback/vlan/agg/ethernet。

### 2.3 LLDP 链路发现 `discovery.js` + `lldpParser.js`

「托管临时项」模式（对 Zabbix 零侵入、用后即删）：
1. 对目标主机建临时 SNMP walk 项（`type=20`，**value_type=4 log 型**——7.0.32 的 character(3) 存储有 bug；`delay` 不能为 0；必填 `interfaceid`，从 `hostinterface.get {type:2}` 取）；
2. 轮询等首轮（≥80s 量级）→ `history.get history=4` 读 walk 文本 → **删除临时项**；
3. `lldpParser` 解析 LLDP-MIB walk 文本（本地 chassis/port + 远端 chassis/port/sysName，列 OID 层级经现网修正确认；TimeMark 只用于去重不当行号）；
4. `applyObservations` 链路算法：双端互相印证 → **confirmed**；仅单端看到 → **half**；两端矛盾 → **conflict**；本轮观察过但对端消失 → **stale**（decay 只作用于本轮观察集合内的端点，绝不误伤未参与节点）。
- **管理口过滤**（用户规则）：MEth/M-GigabitEthernet/Mgmt 等带外管理口学到的邻居不连数据面线。
- 现网实况：H3C 接入/核心 loc 表齐全但 lldpRemTable 空（对端不发 LLDP）→ 系统以 half/manual 流程承载；自动全量建链需网络组两端开 LLDP。

### 2.4 链路审核（LinkReviewPage + links API）

- `GET /links/pending`：分页/过滤/summary；`bulk-confirm`/`bulk-reject` 支持 `link_ids` 或 `match` 圈定（operator 必填、幂等）；人工补线 `POST /links`（status=manual）。
- 审核前操作惯例：`cp` 备份 topology.db。

### 2.5 拓扑图与钻取（graph API + TopoCanvas）

- `/graph` 出节点+链路+层级；钻取视图层级定版（用户规则）：**互联网接入区交换机（10.25.1.11/12，纳管前后都必须最上层）→ 防火墙层 → 核心层(0) → 下联**。钉层按命名语义（`isInternetMgmt`：名称含"互联网/接入区"且非 FW 名）而非 EXT 实卡类型；EXT 快照与 internetTop 组共同构成整组统一深度，互联链不得把组内节点拉开层级。
- 设备命名判读约定：`*-FW<型号>*`（FW6585F/FW6625F）都是**防火墙**，EXT/INET/DMZ/OPM/AF 是防火墙所属安全区。
- 链路/接口流量 `traffic.js`：metric_mapping → Zabbix history/trend（>86400s 走 trend 包络），同 P0 窗口规则。

---

## 3. P2 流量路径走势（pathtrace.js）

**目标**：源 IP → 目的 IP，依据 SNMP 路由表逐跳推出经过的纳管设备链（只读、可解释、不伪造）。

### 3.1 路由快照采集（refreshRouteSnapshots）

- 目标节点：显式 nodeIds，或默认 `display_name LIKE 核心/CORE/汇聚/AGG/FW/防火墙/互联网/接入区`（只是"值得读路由表的 L3 设备"启发式，不构成拓扑断言）。
- **数据源 = ipCidrRouteTable**（行根 `.4.24.4.1`，2026-10-26 用户规则"最长前缀匹配"切换）：legacy ipRouteTable 索引只有 dest，同 dest 多掩码只回报一条（实测丢 /24）；cidr 行 index 13 段 = dest(4)mask(4)tos(1)nexthop(4)，天然无冲突。dest/mask/nexthop 全在 index，**只采列 `.5`(ifIndex) 单列**（~34KB；三列合并必超 65535B 截断）。超 ~740 行设备仍会截断 → 快照如实标 `truncated`，追踪时不猜数据。
- 流程同 LLDP 托管临时项：建项 → 轮询首轮 → history 读取 → 删除；快照 JSON 存 `topo_meta`（`k='rt.<node_id>'`），不建新表。每批 8 台，全程 8~20 分钟；`rtRunning` 防重入；`rt.last_refresh` 只在整轮完成后写入。入口防呆：`zbx.ok()` 失败直接 400 明确报"检查挂载文件 /app/config/source.json"（防挂载失效静默空跑）。
- 快照仅手动刷新（POST /pathtrace/refresh）；每日自动调度为待办。

### 3.2 追踪算法（tracePath）

1. **入口**：src 落在某快照设备直连网段（ipAddrTable 本机IP+掩码）→ 该设备为入口（VRRP/双核心各出一条链，最多 6 条）；
2. **每跳**：`pickRoute` = 所有覆盖目的的路由取**最长前缀**（LPM），等长 ECMP 取 walk 行序首条（确定性）；
3. **下一跳定位**：下一跳 IP 在**全局 ipAddr 快照**反查纳管设备；
   - 命中 → 物理链路只取 `topology_link` 已有证据（有证据标 `lldp-confirmed`/半证据，无证据如实标 `link=null, evidence='route-only'`）；
   - 未命中（常见：SNMP 只采到管理口 IP，三层互连 IP 采不到）→ **按路由出接口的 LLDP 物理邻居续跳**（`findPhysNext`：active 对端、排除来路接口与已访问设备，confirmed/manual 优先，多候选优先"有快照且路由可达目的"，`via='lldp-peer'` 如实标注，用户核定方法论）；
4. **停止条件（全部如实）**：目的直连本机（`action=direct` 完成）／路由无匹配（`no-route`）／直连路由但下一跳未定（`route-guess` 不猜）／出接口无任何 LLDP 对端证据（设备边界）／对端无路由快照（提示可刷新）。环路检测：visited 集合。
5. **meta**：快照台数/最老时间戳、dst 直连在哪台、入口候选、全部 warnings 透传前端。

前端 FlowPathPage：源/目的输入、入口选择、逐跳链（含证据徽章与 warnings）、快照新鲜度面板（status API）。

---

## 4. 设备操作 / 配置备份（opsRoutes.js + jmsClient.js）

经 JumpServer 跳板机 MCP 通道操作网络设备，第一期只做**配置备份与只读巡检**。

- **命令白名单**：前端不接受自由输入，只能选 `TEMPLATES` 模板（display current-configuration / display version，华为/H3C 已实测启用；Cisco 模板保留但 disabled——该环境未实测）。实测约束：`|`/重定向被 MCP 直接拒绝，save/reboot 等危险词在跳板机黑名单。
- **jmsClient**：手写 JSON-RPC over Streamable HTTP 调 JumpServer MCP（token 只存 `data/ops.json`，接口只回 hasToken）。
- **备份存储**：全文含设备密文 → **只落磁盘** `data/backups/<assetKey>/<ts>.txt`；`index.json` 存元数据+sha1 指纹+脱敏预览。列表/预览/**全文下载接口一律 `redact()`**（password 行、community、%^%^…%^%、$1c$/$1a$ 密文模式）——密文永不出接口，需要密文直取服务器磁盘文件。
- **输出清洗**：KoKo 分页残渣（`---- More ----`）与提示符行剥离。
- **变更检测**：`diffLines`（unified diff ±3 行上下文，6000 字符截断）；`/api/ops/changes` 按 sha1 指纹比对列出配置变更历史。
- 每次 exec 本地审计（时间戳可关联跳板机 KoKo 录像）；备份防抖；前端 BackupPanel 组件。

---

## 5. 资产管理（assetStore.js + assetRoutes.js）

- 台账：8 类资产（服务器/网络设备/虚拟机/数据库/电脑终端/办公软件/Web/其他），`data/assets.json`（.gitignore，不入库）。
- **凭据红线**：密码 `AES-256-GCM` 加密存 `enc` 字段（密钥：env `ITYW_CRED_KEY`(64hex) 优先，缺省首启生成 `data/cred.key`）；任何列表/详情接口**永不返回** enc 与明文；明文只能 `POST /api/assets/cred/reveal` 显式获取，**每次查看写审计** `asset_audit.jsonl`；换密钥不破坏旧数据（单条解密失败只提示该条）。
- 与监控联动：`import-monitor` 从监控数据集一键导入台账；stats 聚合视图。

---

## 6. AI 能力

### 6.1 工具层 `/mcp`（server/src/ai/mcpServer.js，手写 MCP Streamable HTTP）

- 手写 JSON-RPC 2.0（initialize/tools/list/tools/call），零第三方 SDK；可选 `ITYW_MCP_TOKEN` Bearer。
- 9 个工具：`monitor_summary`、`query_events`、`query_devices`、`device_detail`、`backup_history`、`backup_diff`、`backup_device_now`（唯一写操作，复用 /api/ops/backup 的防抖与入库口径）、`query_jumpserver_assets`、`query_assets`。
- 数据口径与 Web 一致：监控走 collector 内存快照（不另打 Zabbix）；备份内容出接口前一律 `redact()`；**不提供任何凭据查询工具**（资产密码在工具层设计上就不可见）。
- 每次 tools/call 写审计 `data/ai_audit.jsonl`（工具名/参数摘要/耗时）。

### 6.2 agent 服务（agent/app.py，LangGraph :8791）

- 工具来源 = 平台自己的 /mcp（langchain-mcp-adapters 转 LangChain tools，TTL 缓存重建）；`create_agent`（或老版本 `create_react_agent`）+ **SQLite checkpoint 会话记忆**（thread_id）。
- `POST /chat {thread_id, message}` SSE 流式：事件类型 `token`（回答增量）、`tool_start`/`tool_end`（前端展示执行步骤）、`error`；`POST /reset` 清会话；`GET /health` 报 mcp 连接状态与 LLM 配置（注意 configured 只查 env 存在，不验证网络连通）。
- LLM 走 OpenAI 兼容端点（LiteLLM `general` @ http://10.10.8.5:4000/v1），ChatOpenAI timeout=120s；推理模型首 token 可达 1~3 分钟。
- 红线写入 system prompt：一切事实来自工具结果，工具没返回就如实说没有。

### 6.3 前端助手页（AssistantPage.tsx）

- 走 server `proxyAgent` 同源代理（SSE 不缓冲：`X-Accel-Buffering: no`；/chat 超时 300s）；agent 不可达回 503 JSON → 前端显示配置指引红条。
- **会话状态为模块级单例**（`session` + `patchSession`/`useSession` 订阅刷新）：组件卸载**不 abort** SSE——回答中途切菜单，流在后台跑完，切回接着看；只有「停止」「新会话」主动断开（新会话另调 agentReset 清 checkpoint）。
- 消息气泡渲染工具步骤、打字动画（busy 且最后一条 AI 消息）。

### 6.4 Open WebUI（可选外挂）

compose 内含 open-webui 服务；对接方式 = External Tool Servers 填 `http://server:8787/mcp`（MCP Streamable HTTP）。`/api/ai/config` 给前端 iframe 地址（AI_ASSISTANT_URL/PORT）。

---

## 7. 前端（web，React + Vite + hash 路由）

| 页面 | 实现要点 |
|---|---|
| 监控大屏 Dashboard | /api/dashboard：计数卡、域健康分布、24h 事件趋势、Top CPU/RT、最近事件流 |
| 服务器/网络/无线/数据库/服务监控 | 同一 EntityPage 骨架按 domain 过滤；列表带 CPU/内存/磁盘/ICMP/型号摘要列；无线页走 AC 形态（AP 状态汇总、接入用户数、`ap-<指标>-[AP]` 正则解析的 AP 表；**255=传感器不可读哨兵值，展示层降噪标注**） |
| 实体详情抽屉 EntityDetailDrawer | 档案/接口表/全监控项/时序图（6h/24h/7d/30d 切换 + 时间锚点回看 + 接口/磁盘分区/AP 维度切换）；dbmp 实体走 DbDetailDrawer（zCloud 快照 + 本地采样差值曲线） |
| 网络拓扑 TopologyPage/TopologyFullPage | TopoCanvas（自绘画布：分层布局、钻取、链路证据徽章）+ TopoTree + 接口流量 |
| 链路审核 LinkReviewPage | pending 列表 + 批量确认/驳回（operator 必填） |
| 流量路径走势 FlowPathPage | 见 §3 |
| 资产管理 AssetPage | 台账 CRUD + 凭据录入/查看（reveal 二次确认）+ 从监控导入 |
| 监控源对接 SourcePage | Zabbix 配置/测试 + 分类统计（via 判定依据计数）+ 群组映射 + zCloud 卡片 |
| 告警出口 NotifyPage | 通道 CRUD（掩码回显）、路由规则、发送测试 |
| 设备操作 OpsPage | 模板选择→执行→备份历史/预览/diff/变更列表 |
| AI 助手 AssistantPage | 见 §6.3 |
| 系统管理 SystemPage | 角色/审计（演示级） |

通用组件：Chart.tsx（自绘 SVG 时序图，含 min/avg/max 包络）、BackupPanel、common（徽标/分页等）。api.ts：fetch 封装 + agentChat SSE（AbortController）。

---

## 8. 数据与持久化清单

| 文件/表 | 位置 | 内容 | 安全 |
|---|---|---|---|
| source.json | server/data | Zabbix endpoint/token + dbmp 配置 | 卷挂载进容器，不入镜像不入库；**单文件挂载坑**：宿主机文件不存在会被建成空目录 → endpoint 空 → `Failed to parse URL`；修复后必须 `--force-recreate`（挂载点类型容器创建时固化） |
| notify.json / notify_state.json | server/data | 告警通道配置/差分状态 | secret 掩码回显 |
| ops.json / backups/ | server/data | 跳板机 token / 备份全文 | 全文含密文只落磁盘，接口全脱敏 |
| assets.json / cred.key / asset_audit.jsonl | server/data | 台账/加密密钥/凭据审计 | .gitignore；生产建议 ITYW_CRED_KEY |
| dbmp_samples.json | server/data | DB 计数器差值采样 | 真实采样，起点可回溯 |
| ai_audit.jsonl | server/data | MCP 工具调用审计 | 追加式 |
| topology.db（sqlite）/ MySQL ityw 库 | topology/data | 拓扑五表 + topo_meta | 凭据不落库 |
| checkpoints.db | agent/data | LangGraph 会话记忆 | — |

---

## 9. 部署（docker-compose，Linux `open-webui` 主机 /data/ITAM）

- 服务：mysql:8.0 + server + topology + web(nginx:80) + agent(python:3.12-slim) + open-webui；`deploy/` 三个 Dockerfile；nginx 反代 `/api`→server、`/topo-api`→topology（rewrite 掉前缀）。
- 关键环境变量（`.env`，不入库）：`TOPO_DB=mysql`、`AGENT_URL=http://agent:8791`（**server 容器内填 127.0.0.1 必现 /agent/health 503**——容器网络里 127.0.0.1 指向自己）、`LLM_BASE_URL/LLM_API_KEY/LLM_MODEL`、`AI_SECRET_KEY`、`ITYW_CRED_KEY`。
- 数据迁移：`topology/scripts/migrate-sqlite-to-mysql.mjs`（`compose --profile tools run migrate`）。
- 健康判读：`/api/agent/health`（503=AGENT_URL 错/agent 未起；ok:false+llm 段=LLM env 缺失）；topology `/health`（zbx_connected）；8791 故意不映射宿主端口，`ss` 查不到属正常。

---

## 10. 关键工程决策 / 现网实测坑（速查）

1. SNMP 文本项必须 `value_type=4`（log），=3 在 7.0.32 有存储 bug；读用 `history.get history=4`。
2. `item.create type=20` 必填 interfaceid；delay≠0；首轮等待 ≥80s。
3. speed 项 `units=bps` 且 lastvalue 已被模板预处理乘过——**不要**再 ×1e6（2e17 脏值超 JS 安全整数 → node:sqlite RangeError）。
4. 禁止 Ping/IP 连通性推断物理直连；接口用内部 ID（fingerprint 抗 ifIndex 漂移）。
5. 路由快照目标 LIKE 清单（pathtrace.js/server.js 两处）：核心/CORE/汇聚/AGG/FW/防火墙/互联网/接入区——新增区域命名要同步两处。
6. grep 排障坑：`grep '[rt]'` 是字符集、`grep '$$rt$$'` 锚点失配 → 用 `grep -F '[rt]'`。
7. agent `llm.configured:true` 只检查 env 存在，不验证网络连通——排"AI 无响应"要先在 agent 容器内 httpx 直测 LLM 端点。
8. 无线 AC：华为备机 `IdleIdle` 文本归一 Idle；`ap-clients/cpu/memory/temp` 的 **255=传感器不可读哨兵**；模板键拼写错误 `ap-clientes-5-` 按原键采。

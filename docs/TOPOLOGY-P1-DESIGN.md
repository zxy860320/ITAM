# UOCP P1：真实网络拓扑模块 — 技术设计与任务拆分（v1.0 待评审）

> 状态：**设计稿，待人工评审。本轮不编码、不改动 P0 任何功能。**
> 日期：2026-10-25 ｜ 作者：UOCP 接手 Agent
> 输入依据：① 产品手册 `docs/PRODUCT-HANDBOOK.md`（§4~§7）；② 后端源码审查（`server/src/server.js` 279 行、`collector/zabbixClient.js` 624 行、`aggregate.js` 66 行、`mockData.js` 169 行）；③ 现网 Zabbix 只读探测脚本 `.workbuddy/tmp/probe_lldp*.py`、`probe_hif_details.py`（全部为只读 API 调用，未改动 Zabbix 任何配置）。

---

## 0. 架构前提核实（先检查服务边界）

**代码审查结论：当前 ITYW 仓库并不是微服务，而是单体。**

| 组件 | 形态 | 边界 |
|---|---|---|
| 后端 | 单进程 Express（:8787），`server.js` 内联全部路由 | 无服务拆分，无独立存储（仅内存缓存 + `server/data/source.json` 持久化数据源配置） |
| 前端 | Vite + React（:5273），7 个页面 + 详情抽屉 | 只消费 `/api/*`，与后端无状态耦合 |
| 数据源 | `ZabbixCollector` 双模（mock / zabbix JSON-RPC） | 60s 全量 sync，按群组映射分域（server/network/database/service） |

UOCP 规划中的"微服务架构"在本仓库尚未落地（P0 是单体 MVP）。为遵守"保持微服务架构、不擅自重构 P0"两条原则，P1 的拓扑能力**不放进入口 `server.js`**，而是新建独立进程：

- **决策：新增拓扑服务 `topology-svc`（推荐方案 A）**
  - 独立目录 `topology/`（或 `server-topology/`），独立端口（建议 :8790），独立 SQLite 文件库（`topology/data/topology.db`），独立进程生命周期；
  - 与 P0 唯一交点：两者都只读同一个 Zabbix API；前端新增页面直连 `topology-svc` 的 `/api/topology/*`，不经过 P0 后端；
  - P0 代码零改动（不新增路由、不改 collector），满足"不修改 P0 已有功能"。
- 备选方案 B（不推荐）：在现有 Express 内挂 `/api/topology/*` 路由 + 模块目录。改动小但违背"先检查边界再决定放独立服务"的意图，且拓扑发现是独立节奏（低频、长任务）与 60s 采集循环混在一起会互相拖累。后文 API 前缀均按方案 A 书写，评审若选 B 仅前缀不同。

---

## 1. 现有 Zabbix 集成能力分析（实测数据）

### 1.1 平台与接入

- Zabbix **7.0.32**，JSON-RPC 2.0（`http://10.25.6.8:8080/api_jsonrpc.php`），Bearer Token 认证（`apiinfo.version` 必须不带 auth 头——已在 P0 踩坑并修复）。
- 现用 API 面：`host.get` / `item.get` / `problem.get` / `trigger.get` / `history.get` / `trend.get` / `hostinterface.get` / `discoveryrule.get` / `template.get`。
- P0 已验证的行为坑（拓扑服务复用 API 时必须继承）：逗号变体 key（`net.if.in["eth0",errors]`）会冒充真实 bps；`vfs.fs` 两三代 key 形态并存；trend 对恒定值不写行；`item.get` 不返回 `snmp_community` 字段。

### 1.2 网络主机与接口盘点（2026-10 现网实测）

| 能力 | 实测结果 | 对拓扑的意义 |
|---|---|---|
| 主机总量 | 252 台 | — |
| 网络主机 | **137 台**（`HP Comware HH3C by SNMP` 109 + `Huawei VRP by SNMP` 28） | 拓扑节点的候选全集 |
| hostinterface | 265 个，网络主机全部为 **type=2（SNMP）** | 节点管理面 IP 可信 |
| SNMP 凭据可见性 | ★ **`hostinterface.get` 的 `details` 含完整 SNMP 配置**：`{"version":"2","bulk":"1","community":"zabbix","max_repetitions":"10"}`，137/137 全部可读 | 推翻了"item 级 community 不可读→自建 SNMP 无凭据来源"的担忧：凭据可从 hostinterface 获取 |
| 接口六类指标（in/out/status/speed/errors/discards） | **125/137 台**全有，key 形态 `net.if.in[ifHCInOctets.<ifIndex>]`（units=bps），接口 label 在 item name `Interface <label>(` 中 | 链路流量关联、端口状态可直接复用 |
| 接口 LLD 规则 | **137/137 台**均有 `net.if.discovery`（SNMP 型规则，snmp_oid 走 ifName/ifDescr/ifAlias 等标准列，delay=1h） | Zabbix 侧接口清单自动化程度高 |
| 无接口指标的主机 | **12 台**（yixi1-biandiansuo、h3c-10.14.0.119 等），hostGroups 为空，疑似未挂组/停用 | 拓扑中标记"数据不全"，处置见 §2 |
| **LLDP 监控项 / 发现规则 / 模板** | **全部为 0**（key 搜 `lldp`、name 搜 `LLDP`、`template.get` 搜索均为空） | ★ 最大缺口：现网没有任何现成 LLDP 数据，必须补采集（§3） |

### 1.3 P0 collector 的可复用度

`zabbixClient.js` 已具备：RPC 封装 + 版本探测、群组→域分类、item 正则防坑匹配、`series()` 时序管道（history/trend 自动切换、iface/dev/mnt 参数族）。拓扑服务需要的是不同节奏（低频拓扑发现 + 按需 join 流量），复用方式建议是**抽包级复用**（把 RPC 客户端与 key 防坑正则提炼为共享模块）而非进程内耦合；P1.2 再决定是否物理抽包，初期允许 topology-svc 内自带一份精简 RPC 客户端，避免触碰 P0 文件。

---

## 2. 真实拓扑数据来源与缺口

### 2.1 可用数据源（按可信度排序）

| # | 数据源 | 现状 | 能提供的拓扑事实 | 可信度 |
|---|---|---|---|---|
| S1 | **Zabbix LLDP 监控项** | ★ 现网为 0，需先补建（§3） | 端口级直连关系（本端端口 ↔ 对端系统名/端口/Chassis ID） | 高（协议层事实） |
| S2 | Zabbix `net.if.*` 接口指标 + item name | 125/137 台可用 | 接口清单、ifIndex、label、速率、oper 状态、流量 | 高 |
| S3 | Zabbix `hostinterface.details` | 137/137 可用 | 节点管理 IP + SNMP version/community（供自建 SNMP 兜底用） | 高 |
| S4 | Zabbix host 基础信息（hostid/name/host/groups/templates） | 137 台网络主机 | 节点身份、厂商系列（HH3C/VRP 模板即可分厂商） | 高 |
| S5 | 人工补录（UI/API 录入） | P1 新建 | 无 LLDP 设备（老旧/禁用 LLDP）的链路 | 中（需双人复核标记） |
| S6 | ~~ICMP/Ping、SNMP brMIB 转发表、ARP~~ | **禁用** | —— 开发原则明确：不得通过 Ping/IP 连通性推断物理直连 | — |

### 2.2 缺口清单与对策

| 缺口 | 影响 | 对策（P1 内） |
|---|---|---|
| G1 全网无 LLDP 数据 | 无法自动建链路 | §3 双路线补采集：优先 Zabbix 侧加 LLDP 监控项（推荐），UOCP 侧直连 SNMP 作兜底/验证 |
| G2 12 台网络主机无接口指标、群组为空 | 这 12 台无法出接口清单，节点会"孤岛" | 拓扑同步时单独列出为 `degraded`，不猜链路；给出运维处置清单（重新挂组/启用），是否纳管交人工确认 |
| G3 ifIndex 不稳定（换板/重启可能漂移） | 用 ifIndex 做永久键会产生错链路 | 内部 `interface_id` 主键；`if_index` 只是属性；接口匹配用稳定指纹（§4.2） |
| G4 单端 LLDP 可见（对端禁用 LLDP 或 SNMP 不可达） | 只有 A 端知道连到 B | 允许 `half` 状态链路（单端待确认），可视化用虚线，绝不自动补全对端 |
| G5 双端描述不一致 / 环路矛盾 | 数据可信度 | 双端校验 + 冲突标记 `conflict`，冲突链路不进默认视图，进待处理列表 |
| G6 SNMP community 是明文字段 | 安全 | 凭据仅存 topology-svc 本地库、不落日志；API 永不回显 community；P2 评估加密存储 |
| G7 官方"LLDP by SNMP"模板在 7.0.32 的存在性 | 路线 1 落地细节 | 两次 WebSearch 未能完全定论（7.0 whatsnew 未提及；社区资料多为自研模板）。设计按"若无官方模板则自研最小 LLDP 模板（snmp walk lldpRemTable）"兜底，P1.2 首先在测试环境验证 |

---

## 3. LLDP 采集技术方案

### 3.1 数据协议基础

LLDP-MIB：
- **本端**：`lldpLocPortTable`（.1.0.8802.1.1.2.1）— 本地端口 ID/描述；
- **对端**：`lldpRemTable`（.1.0.8802.1.1.2.1.4）— `lldpRemSysName`（对端系统名）、`lldpRemPortId` / `lldpRemPortDesc`（对端端口）、`lldpRemTimeMark` + `lldpRemIndex` 三元组寻址；
- 索引 = `(lldpRemTimeMark, lldpRemLocalPortNum, lldpRemIndex)`，其中 `lldpRemLocalPortNum` 经 `lldpLocPortNum` 映射回 ifIndex（实现时先做 PortNum→ifIndex 映射表）。

前置条件：**设备已全局启用 LLDP**。HP Comware / Huawei VRP 通常默认开启或可批量命令开启——P1.2 第一步先 SNMP walk `lldpLocChassisId`（.1.0.8802.1.1.2.1.3.0）抽样验证现网开关状态，若大面积未启用，输出设备清单交网络组批量开启（这是现网配合项，不由 UOCP 自动改设备配置）。

### 3.2 路线 1（推荐）：在 Zabbix 侧建立 LLDP 采集，UOCP 只消费

做法：给 137 台网络主机挂"LLDP 采集模板"（官方模板若确认存在则直接用；否则自研最小模板）：
- LLD 规则 `lldp.discovery`：`snmp_oid = discovery[{#LOCPORT},1.0.8802.1.1.2.1.3.7.1.3]`（lldpLocPortId 列）或复用现有 `net.if.discovery` 的 `{#IFINDEX}`；
- 主监控项（text，type=20 SNMP walk）：`lldp.rem` walk `1.0.8802.1.1.2.1.4.1`（整张 lldpRemTable），或按端口 dependent 项；
- UOCP 通过 `item.get`（search key=lldp）+ `history.get` 读原始 walk 文本，解析成链路。

优点：**复用现成 SNMP 凭据与代理体系、零新增网络设备访问路径、时点数据留 Zabbix 可回溯、与"优先复用 Zabbix LLDP 数据"原则完全一致。**
代价：需要向 Zabbix 写模板/挂模板（对 Zabbix 是写操作，需 Zabbix 管理员评审授权——UOCP token 当前权限待确认，P1.2 先做 `template.create` 权限探测）。

### 3.3 路线 2（兜底/验证）：UOCP 侧直连 SNMP 采集

topology-svc 内置轻量 SNMP 客户端（推荐 Node `net-snmp`，纯 JS 无编译负担）：
- 凭据来源：Zabbix `hostinterface.get.details`（§1.2 已实测可读：version=2c、community 明文）；无 hostinterface 凭据的设备走人工配置页补录；
- 每次发现任务：walk `lldpLocChassisId` → 未启用则记 `lldp_disabled`；启用则 walk `lldpLocPortTable` + `lldpRemTable`；
- 结果写入 `topology_discovery_record`（原始 walk 文本快照），解析后进 link 表。

优点：不改 Zabbix 配置、可作路线 1 的交叉验证源、12 台异常主机也能单独探测。
代价：UOCP 直连设备 SNMP（新增网络访问面，需安全评审）；凭据管理责任转移到 UOCP。

### 3.4 链路建立算法（两条路线共用）

```
输入: 每条 LLDP 观察 (local_node, local_port, rem_chassis_id, rem_sys_name, rem_port_id/desc, source, ts)
1. 对端身份解析:
   首选 lldpRemChassisId(MAC 形式) → 匹配节点 mgmt 接口 MAC / 已登记 chassis_id;
   次选 sysName 精确匹配(大小写不敏感) → 唯一命中才接受, 多义则 conflict;
   对端不在 137 台清单(如服务器网卡也开 LLDP) → 存 external_neighbor, 只记不建正式链路.
2. 双端校验: 存在反向观察 (rem→local 同端口对) → status=confirmed;
   仅单向 → status=half(待确认);
   同一 A 端口出现两个不同 B 端口(时间序矛盾) → status=conflict.
3. uplink/downlink 归一: A-B 与 B-A 去重为一条 link, 保留两端快照.
4. 时间衰减: lldpRemAgeOut 内未见刷新 → last_seen 过期 → 连续 N 轮缺失转 stale, 人工确认后才删除.
5. 禁止性规则: 任何情况下不使用 ICMP/ARP/brMIB 转发表推断物理直连.
```

人工补录链路复用同一 link 表，`source=manual`，`status=confirmed_by_operator`（双人复核字段 P2 再做）。

---

## 4. 拓扑数据库设计（topology-svc 私有 SQLite）

设计原则：**不依赖任何资产/CMDB 表**；所有主键为内部自增 ID；Zabbix hostid、ifIndex 均为"外部引用/属性"而非永久标识；ifIndex 漂移通过接口指纹重绑定。

### 4.1 topology_node（拓扑节点）

| 列 | 类型 | 说明 |
|---|---|---|
| node_id | INTEGER PK | 内部主键 |
| zbx_hostid | TEXT UNIQUE | Zabbix 主机 ID（可空：未纳管但被 LLDP 邻居提及的 external 节点为 NULL） |
| node_type | TEXT | `switch` / `router` / `fw` / `ap` / `external`（对端非纳管设备） |
| vendor | TEXT | 由模板推断：HH3C Comware / Huawei VRP / unknown |
| display_name | TEXT | 主机名（同步自 Zabbix name，可人工覆盖） |
| mgmt_ip | TEXT | hostinterface SNMP IP |
| chassis_id | TEXT | LLDP chassis id（MAC 形式），对端解析锚点 |
| status | TEXT | `active` / `degraded`（如 12 台无接口项） / `disabled` / `stale` |
| health_flags | TEXT(JSON) | `{no_if_items:true, snmp_unreachable:false,...}` 处置提示 |
| first_seen / last_seen | INTEGER | unix 秒 |

### 4.2 topology_interface（拓扑接口）

| 列 | 类型 | 说明 |
|---|---|---|
| interface_id | INTEGER PK | 内部主键（★永久标识，ifIndex 不作主键） |
| node_id | INTEGER FK→node | |
| fingerprint | TEXT | 稳定指纹 = `sha1(node_id + if_name + if_descr)`；ifIndex 漂移时凭它把旧 interface_id 重绑到新 ifIndex |
| if_index | INTEGER | 当前 ifIndex（属性，可变） |
| if_name / if_descr / if_alias | TEXT | 来自 net.if.discovery LLD 宏与 item name |
| if_type | TEXT | `ethernet` / `vlan` / `loopback` / `agg`（据 ifDescr/ifType 归类；vlan/loopback 不建物理链路） |
| speed_bps | INTEGER | `net.if.speed[ifHighSpeed.N]` 现值缓存 |
| oper_status | INTEGER | `net.if.status` 现值（1=up 2=down） |
| zbx_itemids | TEXT(JSON) | `{in:itemid, out:itemid, status:itemid, speed:itemid}` → 指标映射的兜底缓存（正式映射在 metric_mapping） |
| metric_source | TEXT | `zabbix`（默认）/ `none` |
| first_seen / last_seen | INTEGER | |
| UNIQUE | (node_id, fingerprint) | |

### 4.3 topology_link（拓扑链路）

| 列 | 类型 | 说明 |
|---|---|---|
| link_id | INTEGER PK | |
| a_node / a_iface | INTEGER FK | A 端（node_id / interface_id） |
| b_node / b_iface | INTEGER FK 可空 | B 端；half 链路时 B 端仅存快照文本 |
| b_snapshot | TEXT(JSON) | 对端原始快照 `{sys_name, port_id, port_desc, chassis_id}`（half/conflict 时用于人工确认） |
| status | TEXT | `confirmed`（双端一致）/ `half`（单端待确认）/ `conflict` / `stale` / `manual` |
| source | TEXT | `lldp_zbx` / `lldp_snmp` / `manual` |
| confidence | REAL | 1.0 双端；0.7 单端强匹配；0.4 单端弱匹配（仅 sysName） |
| confirmed_by / confirmed_at | TEXT/INTEGER | 人工确认半链路的操作员与时间（half→confirmed 的审计） |
| discovered_at / last_seen / missing_rounds | | 存在性维护：连续 missing_rounds≥3 转 stale |
| UNIQUE | 归一化端点对 (min(node,iface), max(node,iface)) 生成 norm_key UNIQUE | 防 A-B / B-A 重复 |

### 4.4 topology_discovery_record（发现执行记录）

| 列 | 类型 | 说明 |
|---|---|---|
| record_id | INTEGER PK | |
| run_id | TEXT | 一次发现批次 uuid（手动触发/定时同一口径） |
| node_id | INTEGER FK | 逐节点记录（含失败节点） |
| source | TEXT | `zbx_item` / `direct_snmp` / `manual` |
| raw_snapshot | TEXT | 原始 walk/ item 文本快照（回溯与重解析用， gzip 可选） |
| result | TEXT | `ok` / `snmp_timeout` / `lldp_disabled` / `no_credentials` / `parse_error` |
| neighbors_found | INTEGER | 本节点解析出的邻居条数 |
| started_at / finished_at | INTEGER | |

### 4.5 topology_metric_mapping（链路/接口 → Zabbix 指标映射）

| 列 | 类型 | 说明 |
|---|---|---|
| mapping_id | INTEGER PK | |
| interface_id | INTEGER FK | |
| metric | TEXT | `if_in` / `if_out` / `if_speed` / `if_oper` / `if_errors` |
| zbx_itemid | TEXT | 对应 Zabbix itemid（发现时解析 key `net.if.in[ifHCInOctets.<ifIndex>]` 且校验 units=bps、排除逗号变体冒充项） |
| key_snapshot | TEXT | 绑定时 key 原文（漂移审计） |
| stale | INTEGER | 重绑失败置 1，链路流量降级为"—" |
| UNIQUE | (interface_id, metric) | |

> 注：链路"流量"= 两端接口 if_in/if_out 的展示组合，API 层聚合，不在 link 表冗余指标。

### 4.6 同步与漂移处理流程（接口重绑定）

```
每轮接口同步:
  for 每个 LLD 发现的接口(ifName/ifDescr/ifIndex):
    fp = fingerprint(node, ifName, ifDescr)
    命中 fingerprint → 仅更新 if_index/last_seen(若 ifIndex 变了记 drift 日志)
    未命中 → 新建 interface_id
  连续 3 轮未见的接口 → status 软删(不物删, 保护历史链路引用)
链路重算(每轮发现后):
  LLDP 观察按 (a_iface,b_iface) upsert link; 消失链路 missing_rounds++
```

---

## 5. 拓扑 API 设计（topology-svc，前缀 `/api/topology`）

统一约定：只读 GET 为主 + 少量 POST 动作；响应 `{ data, meta }`；错误沿用 P0 风格 `{ error }`；分页 `{page,size,total}`。

### 5.1 节点

```
GET  /api/topology/nodes?domain=&status=&vendor=&q=&page=&size=
     → [{node_id, display_name, node_type, vendor, mgmt_ip, status,
         health_flags, iface_count, link_count}]
GET  /api/topology/nodes/:nodeId
     → 节点详情 + interfaces[]（含 oper/speed/link 摘要）+ 最近 discovery 结果
```

### 5.2 接口

```
GET  /api/topology/interfaces?node_id=&if_type=&has_link=&page=
     → 接口清单（含 fingerprint 是否近期漂移、metric 绑定健康）
```

### 5.3 链路

```
GET  /api/topology/links?status=&source=&node_id=&page=
     → [{link_id, a:{node_id,name,iface_name}, b:{...}, status, source,
         confidence, last_seen}]
GET  /api/topology/links/pending?       ← = links?status=half|conflict
     → 待确认/冲突队列（带 b_snapshot 供人工比对）
POST /api/topology/links/:linkId/confirm   body {operator, note?}   half→confirmed
POST /api/topology/links/:linkId/reject    body {operator, reason}  → rejected(保留审计)
POST /api/topology/links                   body {a_node_id,a_interface_id,
                                                b_node_id,b_interface_id,operator,note}
     → 人工补录（校验两端接口存在、不重复、不自环；source=manual）
DELETE /api/topology/links/:linkId         仅允许删 manual 链路；LLDP 链路只允许 reject
```

### 5.4 链路流量（可视化取数）

```
GET /api/topology/links/:linkId/traffic?range=6h|24h|7d|30d&till=
    → { a:{in:{avg,max,min}, out:{...}}, b:{...}, meta:{units:'bps',
        stale_mapping:false} }
    实现: 经 metric_mapping 找 4 个 zbx_itemid → 直接 history.get/trend.get
    (复用 P0 series() 的窗口/粒度规则: >86400s 走 trend, 否则 history)
GET /api/topology/graph?level=l2&scope=all|cluster:x
    → 一次性图数据 { nodes[], links[] }（前端可视化主入口；
      默认剔除 stale/conflict，include=stale,conflict 可显式带出）
```

### 5.5 发现（discovery）

```
POST /api/topology/discovery/run   body {node_ids?:[], source?:'auto'|'zbx_item'|'direct_snmp'}
     → { run_id, queued:N }（异步；同时最多 1 个 run，重复触发返回 409）
GET  /api/topology/discovery/runs?page=        → 批次摘要列表
GET  /api/topology/discovery/runs/:runId       → 批次汇总(ok/失败分类计数、新增/消失链路数)
GET  /api/topology/discovery/records?run_id=&node_id=&result=&page=
     → 逐节点记录（result 过滤定位 snmp_timeout / lldp_disabled 设备）
GET  /api/topology/discovery/summary
     → { nodes_total, nodes_ok, lldp_disabled:[names], no_credentials:[names],
         half_links, conflict_links, last_run:{...} }  ← 运维健康面板数据
```

---

## 6. P1 分阶段实施计划

> 每阶段末有可演示产出与退出准则；任何阶段不改动 P0 代码。Zabbix 写操作（路线 1 挂模板）单独列为需授权项。

### P1.1 数据能力检查与现网验证（设计本轮已大半完成，剩余 1~2 天）
- [x] Zabbix 版本/API/网络主机/接口指标盘点（§1）
- [x] LLDP 数据缺失确认（0 项 0 模板）
- [x] SNMP 凭据可读性确认（hostinterface.details 明文可读）
- [ ] 抽样 SNMP walk `lldpLocChassisId`：确认现网设备 LLDP 开关状态分布（需一台能直连设备 SNMP 的跳板；用只读 walk）
- [ ] `template.create` / `item.create` 权限探测（决定路线 1 是否需要 Zabbix 管理员代操作）
- 退出准则：路线 1 / 路线 2 的最终选型经人工评审敲定；12 台无接口主机的处置清单交网络组。

### P1.2 拓扑服务骨架 + 节点/接口同步（约 1 周）
- 新建 `topology-svc`（:8790，SQLite；依赖仅 express + node:sqlite 或 better-sqlite3）
- 实现：Zabbix RPC 精简客户端（继承 P0 防坑约定）→ `topology_node` / `topology_interface` 同步任务（手动触发 + 30min 定时）；fingerprint 漂移重绑；degraded 标记
- 产出 API：nodes / interfaces / graph（此时只有节点无链路）
- 退出准则：137 台节点 + ~7000 接口（估）入库幂等两轮；第二轮零 diff；12 台 degraded 正确标记；mock 模式可离线演示。

### P1.3 LLDP 链路发现（约 1~2 周，关键阶段）
- 按 P1.1 选定路线实现采集（推荐路线 1：自研最小 LLDP SNMP 模板 + UOCP 消费；路线 2 直连 SNMP 作兜底）
- 实现 §3.4 链路算法：双端校验 / half / conflict / external_neighbor / stale 衰减
- `topology_discovery_record` 全程留痕；`POST discovery/run` 手动触发
- 退出准则：现网跑全量发现；confirmed 链路数 >0 且抽样 10 条与现场跳线记录一致；half/conflict 队列可解释；重复执行幂等。

### P1.4 指标关联与链路流量（约 1 周）
- `topology_metric_mapping` 绑定（防逗号变体、校验 units）；流量 API `links/:id/traffic`、graph 带流量着色
- ifIndex 漂移 → mapping 重绑/stale 降级演练（测试环境改 ifIndex 模拟）
- 退出准则：每条 confirmed 链路两端流量曲线可用；mapping 健康面板可解释；SNMP 主机 bps 与 Zabbix 前端一致（对照 10718 等样机）。

### P1.5 前端拓扑视图 + 待确认工作流（约 1~2 周）
- 前端新增"网络拓扑"页（React Flow 或 Cytoscape.js）：分层布局（核心/汇聚/接入按群组或速率推断仅作视觉分层，不作拓扑事实）、confirmed 实线 / half 虚线 / conflict 红色、点链路看两端流量
- 待确认队列 UI：half 链路人工确认/驳回；manual 补录表单（选 A 端节点→接口→B 端节点→接口）
- 退出准则：E2E 走通"发现→审核 half→补录→图上可见带流量"；P0 页面回归无影响（零改动验证）。

排期合计约 5~7 周（单人）。依赖的外部配合：网络组开 LLDP（若抽样发现大面积关闭）、Zabbix 管理员授权挂模板（路线 1）。

---

## 7. 验收测试方案

### 7.1 数据正确性（核心）
| 用例 | 方法 | 通过标准 |
|---|---|---|
| T1 节点覆盖 | 拓扑节点数 vs Zabbix 网络主机数（137） | 全量入图；12 台 degraded 有明确标记与原因 |
| T2 接口覆盖 | 抽 5 台（含 10718）接口清单 vs Zabbix hostinterface/LLD 结果 | 一致；无重复 fingerprint |
| T3 链路真实性 | 随机抽 10 条 confirmed 链路，对照现场跳线资料/配线架记录 | 10/10 两端设备+端口全对 |
| T4 双端一致率 | confirmed / (confirmed+half+conflict) | ≥85%（低于则回查 LLDP 覆盖率） |
| T5 禁止推断 | 代码审查 + 单测断言不存在 icmp/arp/brMIB→link 路径 | 静态扫描零命中 |
| T6 流量准确 | 链路流量 vs Zabbix 前端同接口图表（6h/7d 各一） | 数值一致（±1%） |

### 7.2 鲁棒性与漂移
| 用例 | 方法 | 通过标准 |
|---|---|---|
| T7 ifIndex 漂移 | 测试环境人为改 item key 中 ifIndex 再同步 | interface_id 不变、历史链路不断、drift 日志可见 |
| T8 单端可见 | 对端禁用 LLDP（测试环境） | 链路 half、不自动补全对端、出现在待确认队列 |
| T9 冲突检测 | 构造 A1→B1 与 A1→B2 矛盾观察 | conflict 标记、默认视图剔除、审计保留 |
| T10 消失链路 | 拔线（测试环境）或删 LLDP 项 | 连续 3 轮缺失转 stale，不物理删除 |
| T11 SNMP 不可达 | 对不可达设备跑发现 | result=snmp_timeout，节点不崩，summary 列出 |
| T12 幂等 | 连跑 3 轮发现 | link 集合零重复（norm_key 生效）、无抖动 |

### 7.3 API 与工作流
- 契约测试：§5 全部端点（含参数组合、分页、错误码 404/409）；
- 人工补录：创建 manual 链路 → 图上可见；删除仅限 manual；LLDP 链路 delete 返回 403；
- confirm/reject 审计字段完整（operator/at）。

### 7.4 回归与边界
- P0 回归：topology-svc 上线前后，P0 全部页面（Dashboard/Server/Network/Database/Service/Source/System + 详情抽屉四张趋势卡含新增磁盘分区下拉）冒烟通过；P0 代码 diff 为空（git diff 验证）；
- 性能：137 节点全量发现单轮 ≤5min（路线 2 按 20 并发 SNMP）；graph API ≤300ms；traffic API ≤1s（7d trend 粒度）；
- 安全：API 响应零 community 明文；Zabbix token/SNMP 凭据仅存服务端配置文件与本地库。

### 7.5 验收演示脚本（供评审）
1. `POST /discovery/run` → 轮询 summary：节点/邻居/链路计数增长；
2. 打开拓扑页：核心-接入分层图，confirmed 实线、half 虚线；
3. 点开一条 half 链路 → 用 b_snapshot 对照 → 确认 → 变实线；
4. 点一条 confirmed 链路 → 两端 6h 流量曲线；
5. 人工补录一条无 LLDP 设备链路 → 图上虚线（manual 样式）；
6. 跑 T7 漂移演练，证明历史链路存活。

---

## 8. 评审需要拍板的决策点

| # | 决策 | 推荐 |
|---|---|---|
| D1 | 服务形态：独立 topology-svc（方案 A） vs P0 内挂模块（方案 B） | **A** |
| D2 | LLDP 采集路线：Zabbix 侧模板（路线 1） vs UOCP 直连 SNMP（路线 2） | **1 为主、2 兜底**；待 P1.1 权限探测与 LLDP 开关抽样后定 |
| D3 | 存储：SQLite（P1）→ PG（多实例/微服务化时） | **SQLite** |
| D4 | 12 台无接口主机：标记 degraded vs 暂时排除出图 | **degraded 标记**，处置清单交网络组 |
| D5 | 前端图引擎：React Flow vs Cytoscape.js（137 节点规模都够） | React Flow（与 React 栈整合成本低） |
| D6 | 官方 LLDP 模板缺失时是否授权自研模板挂到生产 Zabbix | 需 Zabbix 管理员同意；先在测试主机 10718 验证 |

> 本文档到此为本轮全部产出。等待人工评审；评审通过前不进入任何编码。

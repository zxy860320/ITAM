# ITYW 网络拓扑重构设计 V2.0（设计稿，待人工审核）

> 状态：**设计阶段交付物，未修改任何代码**。审核通过前不进入重构。
> 作者：ITYW 助手 ｜ 日期：2026-10-31 ｜ 基线：`feat/topology-view` @ `e775da3`（拓扑 V1.5）
> 需求依据：《ITYW 网络拓扑重构需求 V2.0》任务书 + 参考架构图（clipboard-2026-10-31T16-08-06）
> 前序文档：`docs/TOPOLOGY-P1-DESIGN.md`（采集与链路发现）、`docs/TOPOLOGY-P2-DESIGN.md`（路径追踪）

---

## 0. 摘要与设计立场

V2 的目标是把拓扑模块从"设备关系图"升级为**企业级网络架构拓扑图**：以真实网络区域为布局单位、以真实设备+接口为连接对象、以物理连接与逻辑关系的证据为数据基础，管理员人工设计布局为主、Zabbix/SNMP/LLDP 自动更新为辅。

贯穿全文的四条不可妥协红线（继承既有工程纪律）：

1. **不伪造数据**：任何视觉元素（区域、连线、图标、速率、VLAN）背后必须有真实数据或管理员录入，无数据即空态，不编造。
2. **禁止推断物理直连**：不用 Ping、IP 连通性、命名、分类推断物理连接。每条连线必须有 `relation_type` + 证据字段；三层路由关系（route_nexthop）在视觉上永不表现为物理直连线。
3. **自动发现不覆盖人工布局**：坐标一旦 `manual` 即永久保留；新设备只分配初始位置；链路变化不触发全图重排。
4. **权限必须后端校验**：不能只前端隐藏按钮。正视平台目前**没有任何认证体系**的现实，给出最小可行的后端校验与集成方案（§10）。

本文档完成任务书第一阶段十项输出：现有代码审查（§1）、参考图差异分析（§2）、真实拓扑数据模型（§3）、物理/逻辑/冗余连接模型（§4）、区域化人工布局方案（§5）、G6 技术实现方案（§6）、数据库设计（§7）、API 设计（§8）、SNMP 采集差距分析（§9，含现网实测证据）、分阶段实施计划（§11），另加权限设计（§10）与风险开放问题（§12）。

---

## 1. 现有代码审查（V1.5 基线盘点）

### 1.1 后端 topology-svc（:8790，独立 Express 服务）

| 文件 | 行数 | 职责 | V2 处置 |
|---|---|---|---|
| `topology/src/db.js` | 312 | sqlite(node:sqlite)/MySQL8 双引擎抽象 + `toMysqlSql` 方言翻译（ON CONFLICT→ON DUPLICATE KEY、CAST REAL→DOUBLE、反引号保留字兼容） | **保留**，schema 增量扩展（§7） |
| `topology/src/config.js` | — | `lldpWalk` OID 集、`netTemplateRe=/by SNMP/i`、MySQL 环境变量族 | 扩展采集 OID 配置 |
| `topology/src/sync.js` | 140 | Zabbix `host.get`（模板名 `/by SNMP/i`，137 台候选）→ node upsert；`item.get net.if.*` 正则聚合 → interface upsert（`fingerprint=sha1(node\|if_name\|if_descr)` 抗 ifIndex 漂移） | **保留**，补聚合口识别（§9.4） |
| `topology/src/discovery.js` | 259 | `runDiscovery`：Zabbix 临时 walk 项（type=20、value_type=4、用后即删、delay 1m、首轮等待）→ `history.get` → `applyObservations`（双端 confirmed / 单端 half / decay 只作用 observedNodes）；四态分级 ok / rem_empty_indeterminate / rem_empty_aged / mib_unsupported / snmp_unreachable / walk_empty / no_iface / parse_error | **保留**（这是七类关系中"LLDP 双端确认/单端邻接"两类的现有实现） |
| `topology/src/lldpParser.js` | 80 | LLDP-MIB walk 文本解析（chassisId/portId/portDescr/sysName） | 保留 |
| `topology/src/zbx.js` | 64 | Zabbix JSON-RPC 客户端：netHosts / hostSnmpInterfaces / netIfItems / historyText / createTempItem / deleteItems | 扩展新 MIB 族的 walk 方法 |
| `topology/src/pathtrace.js` | ~300 | ipCidrRouteTable（行根 `.1.3.6.1.2.1.4.24.4.1`，13 段 index，只采列 .5 防截断）+ ipAddrTable；LPM 最长前缀匹配；快照存 `topo_meta rt.<node_id>`；`link=null, evidence='route-only'` 红线 | 保留（P2 功能保留项）；route 数据源反哺 route_nexthop 逻辑关系（§4.6） |
| `topology/src/traffic.js` | — | 接口流量 history 查询 | 保留 |
| `topology/src/server.js` | 479 | 全部 REST 端点（§8.1 现状清单） | 扩展（§8） |

**现有表**（sqlite/MySQL 双份 DDL）：`topology_node`（160 台，全部 `node_type='switch'`，vendor h3c 109 / huawei 51）→ `topology_interface`（6925 条非 stale：ethernet 6576、vlan 344、loopback 5、**agg 0**；speed 10G+ 2071 / 1G 3661 / 100M 914 / null 267）→ `topology_link`（confirmed 156 / half 858 / stale 13；`norm_key` 前缀 `L:` 全链路、`H:` 半链路；四态证据 `seen_a_at`/`seen_b_at`；confidence cid=0.7 / sys=0.4 / 全链路=1.0）+ `topology_discovery_record`（raw_snapshot 留证）+ `topology_metric_mapping`（if_in/if_out/if_speed/if_oper/if_errors → zbx_itemid）+ `topo_meta` k/v + V1.5 的 `topology_layout`（node 坐标、layout_source auto/manual、position_locked）与 `topology_group`（固定 key 区域、collapsed、x/y/w/h，无外键）。

### 1.2 前端 `web/src/topology/`（V1.5）

| 模块 | 现状 | 与 V2 的冲突点 |
|---|---|---|
| `classifier.ts` | **固定八类** `GROUP_ORDER=['internet','firewall','core','dc','office','prod','wireless','other']`；`classifyGroup` 按命名正则归类；`classifyBands` BFS 跳数落带（BAND_ORDER 钉层带：互联网接入区→防火墙→核心→下联） | ★硬冲突：V2 要求**管理员自定义区域**（名称/颜色/边框自由建），固定枚举 key 无法承载；命名正则自动归类与"无真实数据不得自动创建虚假区域"冲突。BAND 层级钉带逻辑可降级为"初始建议" |
| `autoLayout.ts` | 区域块布局 + SPINE 强制换行 + 重心排序 | 保留为"初始布局辅助"工具，不再是布局权威 |
| `TopoG6Canvas.tsx` | G6 自定义 device-card 节点、rect combo、`collapseElement/expandElement`（必须 `animation:false`，否则不 resolve 锁死）、搜索定位 | 节点形态换成专业图标（§6.2）；combo 换成可自定义配色/边框/尺寸的区域容器（§6.3） |
| `edgeRouter.ts` | `edgeVisual(status, source)`：confirmed 绿实 / manual 绿虚 / half 黄虚 / conflict 红 / stale 灰点 | ★硬冲突：只按**证据状态**区分线型，未按**七类关系语义**区分；无端口/带宽标注文字；无聚合父子展开（§6.4） |
| `layoutStore.ts` | 前端布局状态 + `layoutSave(nodes, operator)` | operator 为前端自报字符串（localStorage `topo.operator`）——§10 处理 |

### 1.3 认证与权限现状（实测确认）

- `web/src` 全库 grep `login|auth|Authorization|401` **零命中**：平台无任何登录/会话/角色体系。
- 所有写操作的 `operator` 是前端自报字符串，后端仅做**非空校验**（`server.js` 各写端点）。
- topology-svc 与 P0 server 均无鉴权中间件；生产部署（docker-compose）目前靠网络隔离（内网）暴露。

结论：V2 权限设计必须把"先建立最小认证"作为前置依赖，而不是假设已有体系可对接（§10）。

### 1.4 现网数据实况画像（2026-10 实测）

- 网络主机 137 台候选（链接模板名 `/by SNMP/i`：HH3C 109 + Huawei VRP 28），入库节点 160（含历史）。
- **degraded 12 台**（无 `net.if.*` 项，均在"办公网"组）：10727/10728/10729/10730/10741/10751/10767/10805/10810/10811/10813/10814。
- **LLDP 实况**：H3C 接入/核心 `lldpLocPortId` 等 loc 表齐全但 **lldpRemTable 为空**（对端不发 LLDP）；IDC 交换机 walk 全空（LLDP 未启用）。→ 这是 half 链路高达 858 条（858/1027≈84%）的根因；自动建全链依赖网络组两端开启 LLDP，系统以 half/manual 流程承载。
- 无线 AC：华为 10919(main)/10917(standby)（AirEngine9700）、H3C 10762（SNMP 停采）；`ap-state-name` 备机 IdleIdle 文本、传感器 255=不可读哨兵值。
- dbmp/zCloud 数据库实体（`dbmp-` 前缀，domain:'database'）已在 P0 侧存在，**不属于网络拓扑域**，V2 画布默认不混入（见 §12 开放问题 Q6）。

### 1.5 V1.5 已知的坑（重构必须绕开）

1. G6 combo 折叠/展开动画不 resolve → 所有 collapse/expand 必须 `animation:false` + 串行 await。
2. `setData` 改 `style.collapsed` 不会隐藏子节点 → 必须走官方 `collapseElement/expandElement`。
3. `position_locked` 是 MySQL 保留字 → 反引号 + `toMysqlSql` 方言兼容已处理，新表命名避开保留字。
4. Zabbix SNMP 文本项必须 `value_type=4`（=3 有存储 bug）；type=20 临时项必填 interfaceid、delay≠0、首轮等待 ≥80s。
5. speed 项已被模板预处理乘过，**不得再乘 1e6**（曾产 2e17 脏值超 JS 安全整数，node:sqlite 读 INTEGER 直接抛错；聚合也要 `CAST(... AS REAL/DOUBLE)`）。

---

## 2. 参考图差异分析

### 2.1 参考图视觉语法提炼（来自参考架构图）

参考图是典型的多面板企业网络架构图（Visio/PPT 风），其可迁移的视觉语法：

| 视觉元素 | 参考图表现 | V2 对应实现 |
|---|---|---|
| **彩色区域** | 大块纯色底（橙"华为IDC"、绿、蓝"H3C 32005"、黄/青/粉办公核心区等），区域内有标题文字 | `topology_zone` 自定义背景色/边框色（§5） |
| **子区域/虚线框** | 大区域内嵌虚线小框（逻辑子系统） | 区域嵌套（parent_zone_id）或区域弱化态 |
| **机柜/机房编号** | 红色 `T46-xxx` 文字标注 | 区域/节点的 `label_extra` 富标注（机房位 U 位、机柜号） |
| **专业设备图标** | 方框交换机图标成排、服务器机柜图标、云图标 | device_class 图标库 ≥12 类（§6.2），同类图标成排布置=人工布局天然结果 |
| **多线型图例** | 左下图例框：粗细/实虚区分链路与介质 | 画布图例组件按七类关系渲染（§6.4） |
| **链路文字标注** | 链路上直接标注端口号/带宽 | edge label：本端/对端端口 + 速率（§6.4） |
| **层间网状交叉连线** | 核心↔接入多条交叉、双链路冗余并存 | 保留双链路（norm_key 含接口端点，天然不合并）；不做强交叉规避，人工布局决定 |
| **独立小面板** | 右侧"管理网（深圳分支）"、"分支办公"独立画布 | V2 一期用**区域折叠为胶囊**承载；多画布/分面板列为二期选项（§12 Q3） |

### 2.2 逐项差距矩阵（现状 → V2 要求 → 差距结论）

| # | 维度 | V1.5 现状 | V2.0 要求 | 差距与结论 |
|---|---|---|---|---|
| 1 | 组织单位 | 固定八类 group_key 自动归类 | 管理员自定义区域 CRUD | ★重建：`topology_group`→`topology_zone`（§5/§7） |
| 2 | 区域外观 | rect combo 统一样式 | 自定义名称/背景色/边框/尺寸/自由拖动 | combo 自定义样式 + zone 属性（§6.3） |
| 3 | 区域折叠 | 已支持（animation:false） | 保留 | 满足 |
| 4 | 设备入区 | 自动归类+手工挪动 | 拖入区域（人工隶属） | layout.zone_id 人工覆盖（§5.2） |
| 5 | 区域/设备坐标 | topology_layout/group 已持久化 | 永久保留、manual 不被覆盖 | 基本满足；补快照/回滚（§5.5） |
| 6 | 设备图形 | 统一 device-card 小卡片 | 专业图标 ≥12 类 | ★新：图标库 + device_class 字段（§6.2） |
| 7 | 节点信息 | 名称+IP+状态角标 | 名称/管理IP/型号/在线/告警 | 型号已有数据源（sysDescr 实测含型号，§9.2）；告警需接 Zabbix problem |
| 8 | 链路端点 | 接口级端点已存在（a_iface/b_iface） | 端口级+速率/状态/VLAN/聚合/实时流量 | 数据基础在，缺展示与聚合/VLAN 数据源（§9） |
| 9 | 关系语义 | 只有证据状态（confirmed/half/…） | 七类关系分别表达 | ★重建：relation_type 七枚举（§4） |
| 10 | 逻辑≠物理 | 半链路用虚线已区分 | 路由/VLAN/可达不得画成物理直连 | 现状 half 已虚线；route_nexthop/vrrp/stack 新类别各给专属视觉（§6.4） |
| 11 | 聚合展示 | 无（agg 接口=0） | Eth-Trunk 逻辑链+成员展开 | 依赖采集扩展（§9.4）+ 父子链模型（§4.4） |
| 12 | 双链路冗余 | norm_key 端点级天然并存 | 保留 | 满足 |
| 13 | 链路详情 | pending 审核列表 | 点击链路看详情 | 前端 Drawer 增强（§6.5） |
| 14 | 布局引擎 | 前端 autoLayout 全图排布 | 人工为主、系统辅助、不覆盖 | autoLayout 降级为工具按钮（§5.4） |
| 15 | 布局快照 | 无 | 保存/恢复/备份/回滚 | 新表 `topology_layout_snapshot`（§7.4） |
| 16 | 权限 | operator 自报 | 两档权限+后端校验 | ★新：最小认证+后端 RBAC（§10） |
| 17 | 保留项 | Zabbix 采集/LLDP 发现/链路审核/接口流量/路径追踪/双库 | 全部保留 | 全部保留并兼容（§4.8 迁移映射） |

---

## 3. 真实网络拓扑数据模型（设备与接口域）

实体关系总览（ER 语言描述，DDL 见 §7）：

```
Site(机房/站点，轻量属性，一期不做独立表)
 └─ Zone(网络区域，管理员维护) ──* Placement(节点∈区域，人工隶属)
Node(设备) ──1:* Interface(接口)
Node: device_class(12+类) / vendor / model / mgmt_ip / chassis_id / status / health_flags
Interface: if_type{ethernet|vlan|loopback|agg|other} / speed / oper / vlan_id(新) / parent_iface_id(新，聚合成员)
Link(连接) ──* LinkEvidence(证据) —— §4
```

### 3.1 设备（topology_node 扩展）

保持现有"Zabbix 资产 ↔ 拓扑节点"同步机制不变（zbx_hostid 唯一），新增三个语义字段：

- **`device_class`**：设备图形分类，V2 图标枚举：`core_switch / dist_switch / access_switch / router / firewall / load_balancer / vpn_gateway / wireless_ac / wireless_ap / server / storage / security / unknown`（+`unknown` 兜底，绝不硬猜）。
- **`class_evidence`**：分类证据来源，`model_regex`（sysDescr 型号正则）| `sysobjid`（enterprise/设备族 OID）| `template_name`（Zabbix 模板名）| `manual`（管理员标注）| `none`（unknown）。
- **`model`**：从 sysDescr 提取的型号（实测可读：`S7506X-G`、`S5135S-24FP4T4S-EI`、`USG6625F`——见 §9.2 实测）。

**分类证据规则（不编造）**：
1. sysDescr 型号正则：H3C `Sxxxx`（核心/接入按型号族：S7xxx/S9xxx→core 候选；S5xxx/S3xxx→access 候选）、Huawei `CE68xx/CE88xx`→core、`S57xx/S6720`→access、USG→firewall、AirEngine AC 型号→wireless_ac。正则命中只写 `class_evidence='model_regex'`（中置信）。
2. sysObjectID 白名单映射（25506=H3C、2011=Huawei 已实测；对防火墙/路由器/AC 等具体产品子 OID 做增量表）。
3. Zabbix 模板名（如 wireless AC 模板 `/wireless access controller/i` 已有先例）。
4. 冲突或无法判 → `unknown`，前端用通用交换机图标 + "待标注"角标，**管理员人工标注后 `class_evidence='manual'` 且永不被自动覆盖**。
5. 现网 160 台预估：绝大部分可自动判为三类交换机（命名+型号规律强），防火墙/路由器/AC 少量；服务器/存储一期不入库（Zabbix 网络主机口径不含服务器 SNMP）。

### 3.2 接口（topology_interface 扩展）

保持 `fingerprint` 抗漂移机制（V2 一切连线引用 fingerprint 而非 ifIndex——ifIndex 是可变属性这条既有纪律不变）。新增：

- `vlan_id`：当 `if_type='vlan'` 时的 VLAN 号（Vlan-interface 接口名自带数字，sync 解析即可，零 SNMP 成本；现网 344 条 vlan 接口全部可得）。
- `parent_iface_id`：聚合成员指向聚合口（Eth-Trunk/Bagg）逻辑接口，配合 §9.4 采集扩展启用；一期先加列、值为 NULL。
- `admin_status`：ifAdminStatus（与 oper 区分，排障用；Zabbix 模板已有 net.if 项族可扩展 mapping）。

### 3.3 区域（新实体 Zone，替代 topology_group）

见 §5/§7。要点：区域是**管理员资产**，不是算法产物；自动系统只可产生"建议"（suggestion），不可直接建行。

---

## 4. 连接数据模型：七类关系（物理 / 逻辑 / 冗余）

### 4.1 总模型

`topology_link` 升级为"关系实例表"，核心新增列 `relation_type`（七枚举）与父子/聚合关联列。**证据状态（status）与关系语义（relation_type）正交**：一条链既有语义类别，又有各自的证据生命周期。

| # | relation_type | 语义 | 数据源（现有/新增） | 证据要求 | 可否视为物理直连 |
|---|---|---|---|---|---|
| 1 | `lldp_confirmed` | LLDP 双端互认物理链路 | discovery.js 现有（双端 seen_a_at+seen_b_at） | 两端各自 walk 报告互为邻居 | ✅ 物理 |
| 2 | `lldp_half` | LLDP 单端邻接（对端未回/未开 LLDP） | discovery.js 现有（仅一端 seen_*_at + b_snapshot） | 一端 LLDP 报文快照（raw_snapshot 留证） | ⚠️ 物理**疑似**，视觉必须虚线待确认 |
| 3 | `manual_physical` | 人工确认物理连接 | 链路审核页人工建链/确认（现有 links POST 扩展） | 管理员录入 + 两端接口必填 + note 必填 | ✅ 物理（人工证据） |
| 4 | `agg_lacp` | Eth-Trunk/LACP 聚合（逻辑口） | **新采集**（§9.4）+ 人工录入兜底 | 聚合口成员关系（8023-LAG 或 vendor MIB） | ➖ 逻辑聚合口，**展开成员后才表现为物理** |
| 5 | `route_nexthop` | 三层路由下一跳 | pathtrace.js 现有 ipCidrRouteTable 快照 | LPM 命中条目 + 出接口 + 下一跳 IP；**无物理链路证据时 link 端点可为设备级** | ❌ 逻辑，永不当物理 |
| 6 | `vrrp` | VRRP 冗余组 | **新采集**（§9.6，现网 walk 空）+ 人工录入 | VRRP 组号+优先级+状态 | ❌ 逻辑冗余关系 |
| 7 | `stack` | 设备堆叠/IRF/CSS | **新采集**（§9.7）+ 人工录入 | 堆叠域证据或管理员标注 | ⚠️ 物理互联但语义是"冗余/虚拟化"，独立视觉 |

### 4.2 物理类关系（1/2/3）

- **端点完整性**：物理类三型必须 `a_node+a_iface+b_node+b_iface` 四元齐（人工建链时接口必选，不允许设备级物理连线——把"接口级连接"这条需求落到 schema 硬约束：物理类 CHECK/后端校验四元非空）。
- `norm_key` 规则保持：物理类=排序端点指纹哈希（`L:`/`H:` 前缀沿用）；**新增 relation_type 进入 norm_key 命名空间**（如 `R:` 路由、`V:` vrrp、`S:` stack、`G:` agg），防止不同语义互相撞唯一键。
- 双端确认生命周期不变：half→confirmed 靠对端观测合流（`seen_a_at/seen_b_at` 现有机制），decay（missing_rounds/stale）只作用于 observed 节点——保留。
- `lldp_half` 升级为可操作对象：审核页对 half 链路人工确认→**改写 relation_type 为 `manual_physical`**（保留 b_snapshot 与 LLDP 原始证据于 evidence 表），而不是仅改 status——语义与证据分离。

### 4.3 证据表（新 `topology_link_evidence`）

现状证据散在 link 行（seen_a_at/b_snapshot/record_id）。V2 拆出 1:* 证据表，一条关系可挂多条、多类证据：

```
topology_link_evidence(evidence_id, link_id→, kind{lldp_a|lldp_b|lldp_raw|manual_note|route_snapshot|lacp_snapshot|vrrp_snapshot|stack_snapshot}, payload(JSON/LONGTEXT), source_run_id, observed_at, expires_at)
```

好处：half 升 confirmed 后旧半端证据不丢；route/vrrp 快照刷新只 append 不覆盖；审核审计链完整（谁、何时、凭什么）。

### 4.4 聚合链路父子模型（agg_lacp）

- 聚合逻辑口本身是一条 `topology_interface(if_type='agg')`（Zabbix 接口发现补上 Eth-Trunk/Bagg 后自动入库；sync.classify() 已识别 `bridge-template|bagg|aggregator`→'agg'，现网 agg=0 的原因是 Zabbix SNMP 接口发现未含聚合口，见 §9.4）。
- `agg_lacp` 链路 = **设备级聚合对**：A 的 Eth-Trunk1 ↔ B 的 Eth-Trunk1（端点 iface 是 agg 接口）。
- 物理成员关系：`topology_interface.parent_iface_id` 指向 agg 接口 + 一条证据行（kind='lacp_snapshot'）。
- 前端表达：画布上聚合对渲染为**加粗单线**（带宽=成员速率和），点击展开成员接口清单（Drawer）；"展开成员到画布"开关把成员物理链临时渲染为普通物理线。
- **降级保护**：采集不到 LACP MIB 时，管理员可人工建 `agg_lacp`（两端 agg 接口 + note），evidence kind='manual_note'。

### 4.5 VRRP / 堆叠（冗余类）

- `vrrp`：端点为**设备级**（vrrp 挂在三层接口/VLANIF 上，一期到设备+VLAN 粒度：新增 `vlan_id` 冗余列于 link）。视觉：两端点同色的红色虚线弧/双人字标记（§6.4）。
- `stack`：端点为设备级；证据=vendor 堆叠 MIB 或人工。视觉：双线捆绑样式，堆叠对在布局上建议贴近但不强制。
- **红线重申**：vrrp/stack 的连线不得作为其他物理连接的证据；审核页对这三类只提供"人工录入/删除"，不提供"批量确认"（防止误当半链路批量升格）。

### 4.6 route_nexthop 与 P2 路径追踪的关系

- 数据源已就绪：`topo_meta rt.<node_id>` 路由快照 + LPM。V2 新增后台任务 `linker`：从路由快照生成 `route_nexthop` 关系（A 设备 --dest 覆盖/B 设备 mgmt_ip--> B，出接口+下一跳 IP 存 evidence payload='route_snapshot'）。
- **视觉硬约束**：`route_nexthop` 默认**不显示**在画布（可开关"逻辑视图"叠加）；开启时渲染为灰蓝色点划线并在 label 标"路由非物理"；P2 路径追踪视图沿用现状 `link=null, evidence='route-only'` 标注。
- 续跳方法论沿用用户核定规则：下一跳 IP 不在快照地址表时按路由出接口的 LLDP 物理邻居续跳（`via='lldp-peer'`），绝不伪造连接——`route_nexthop` 生成器同样遵守：只有 LPM 命中真实条目才建关系。

### 4.7 链路状态机（统一）

```
discovered/half ──(对端观测合流)──▶ confirmed
                ──(人工确认)────▶ confirmed(manual_physical)
任何态 ──(N 轮未再观测)──▶ stale（灰点保留，可复活）
人工 ──▶ rejected（软删，留审核痕迹）
```
`status` 枚举沿用现状（confirmed/half/conflict/stale/rejected/manual 并入 manual_physical 的 relation_type），迁移映射见 §7.5。

### 4.8 现有 1027 条链路的迁移映射

| 现状 | V2 映射 |
|---|---|
| status=confirmed, source=lldp_zbx | relation_type=`lldp_confirmed`，status=confirmed；seen_a/b_at 转两条 evidence 行 |
| status=half, source=lldp_zbx | relation_type=`lldp_half`；b_snapshot 转 evidence kind='lldp_raw' |
| source=manual | relation_type=`manual_physical` |
| stale/conflict/rejected | relation_type 按 source 同上，status 保留 |
| norm_key 重算 | 迁移脚本重算加 `L:/H:` 前缀不变（物理类不变；route/vrrp/stack 为新增，无历史） |

---

## 5. 区域化人工布局方案

### 5.1 区域（Zone）模型九项能力对照

任务书九项 → 实现：

| 能力 | 实现 |
|---|---|
| 自定义名称 | `topology_zone.name`（人工，唯一性不强制但 UI 提示） |
| 自定义背景颜色 | `bg_color`（存色值；参考图橙/绿/蓝/黄/青/粉皆可；提供预置色板+自由取色） |
| 自定义边框 | `border_color`、`border_style`(solid/dashed)、`border_width` |
| 自由拖动 | 区域 rect 可拖，坐标写回 `zone.x/y`（manual 语义） |
| 大小调整 | G6 combo/rect resize handle → `zone.w/h`（人工尺寸优先于自动包络） |
| 折叠/展开 | `collapsed`（沿用 V1.5 collapseElement 机制）；折叠态渲染为带名称+设备数的胶囊，背景色保持 |
| 设备拖入/拖出区域 | 拖节点跨区 → `placement{node_id, zone_id, source:'manual'}` 改写；**设备隶属是人工决定**，算法建议不覆盖 |
| 区域位置保存 | 即时持久化（PUT zones/:id），全局共享 |
| 区域内设备布局保存 | `topology_layout.x/y`（V1.5 已有）+ zone_id；manual 坐标永不被自动布局覆盖 |

**不自动创建虚假区域**：系统侧只读扫描（如"有 N 台设备未分区、疑似同一区域"）仅输出 suggestion 列表（存 meta 或接口现算），管理员一键"采纳为区域"才建行；初始空画布不预置任何区域。

### 5.2 布局数据归属

- `placement`（node→zone）与坐标分离：`topology_layout` 行 = node_id, zone_id, x, y, layout_source(auto|manual), position_locked。
- 新设备入图：Zabbix 同步新增 node → 若已有未分区默认区（管理员可设一个"未分区"保留区）则给初始网格位（layout_source='auto'），否则不入画布、进"未分区清单"侧栏等人工拖入——**自动发现只补充素材，不动既有布局**。
- 链路增删**绝不**触发重排：前端 autoLayout 只作为工具栏按钮"整理未锁定节点"存在，作用域限定 layout_source='auto' 且 position_locked=0 的节点。

### 5.3 层级与连线走向

- 参考图的"自上而下"层级（互联网接入→防火墙→核心→下联）由**人工摆放**表达；V1.5 classifier 的 BAND 钉层逻辑降级为一次性"建议初始层级"功能（生成建议 y 带，人工采纳后转 manual）。
- 既有层级定版纪律保留（互联网接入区交换机 10.25.1.11/12 最上层，FW 命名判读等）——这些写进"初始建议"算法的先验，而非渲染时强制。

### 5.4 自动布局辅助工具边界

保留 autoLayout（区域块+重心排序）但改语义：
- 入口：工具栏"自动排布（仅未锁定）"确认框；
- 作用：只移动 `layout_source='auto'` 节点；执行后这些节点转 `layout_source='suggested'`（新增值，区别于 manual 与 auto，可被下次自动整理再移动，但人工拖动一次即转 manual）；
- 链路变化、同步新增设备、Zabbix 告警变化：全部不触发任何自动布局。

### 5.5 布局快照 / 回滚（任务书"保存/恢复/备份/回滚"）

新表 `topology_layout_snapshot(snapshot_id, name, kind{manual|auto_pre|discovery_pre}, zones_json, layout_json, created_by, created_at)`：
- 管理员手动"保存布局版本"（命名快照）；
- 系统自动护栏：每次批量操作（bulk-confirm、discovery run 后若产生新节点入区、autoLayout 执行前）自动打 `auto_pre` 快照（保留最近 20 份）；
- 回滚 = 快照内容覆盖写回 zone/layout 表（写前再打一份当前快照，回滚本身可回滚）。

---

## 6. G6 技术实现方案（渲染与交互层）

> 原则确认：G6 只承担渲染/交互，不引入 dagre/force 等自动布局作为权威（现有 G6 v5 用法延续）。

### 6.1 图元素映射

| V2 实体 | G6 元素 | 说明 |
|---|---|---|
| Zone | combo（沿用）+ 自定义 combo style | bg/边框/标题/折叠胶囊全走 combo style 映射 zone 字段；`animation:false` 纪律保留 |
| 子区域 | combo 嵌套（combo.parent） | G6 v5 combo 支持嵌套；参考图虚线子框→border_style='dashed' |
| 设备 | 自定义节点 `device-node`（替换 device-card） | 图标 + 名称/IP/型号两行文字 + 状态角标 |
| 关系（物理/逻辑） | edge，按 relation_type×status 查样式表 | 见 6.4 |
| 区域外未分区设备 | 独立"未分区"侧栏（HTML，不入画布） | 拖入画布=建 placement |

### 6.2 设备图标库（≥12 类）

- 形态：**SVG symbol 图标集**（线条风格统一、单色可染色，参考图方框交换机图标风），G6 `icon`/自定义 keyShape 渲染；不用 emoji、不用第三方图库依赖（避免授权问题），自绘 12+ 简笔 SVG。
- 类：核心/汇聚/接入交换机、路由器、防火墙、负载均衡、VPN 网关、无线 AC、无线 AP、服务器、存储、安全设备（通用）、unknown（通用交换机轮廓+问号角标）。
- 尺寸分级：图标 ~28–40px（比 V1.5 小卡片信息密度低、成排摆放更接近参考图），选中/告警加外圈。
- 节点信息带：名称（必显）、mgmt_ip（必显）、model（有则显）、在线状态（右上点）、告警状态（右下徽章——数据源见 6.6）。
- 钻取：双击节点 → 既有钻取视图（internetTop→FW→core 层级纪律保留）/详情 Drawer。

### 6.3 区域渲染细节

- 标题带：区域内左上角标题文字（zone.name）+ 设备计数；`label_extra` 支持第二行红字（对应参考图 T46-xxx 机柜/机房编号，V2 提供 `zone.note` 字段承载）。
- 折叠胶囊：折叠后 combo 收成固定高胶囊，保持 bg_color，标题+计数；成员边自动汇聚到胶囊（G6 折叠边语义沿用）。
- 人工尺寸：`zone.w/h` 非空时不自动包络；为空时按成员自动包络（padding 可配）。

### 6.4 七类关系视觉编码（核心差异点）

| relation_type | 线型 | 颜色 | 端点标记 | label |
|---|---|---|---|---|
| lldp_confirmed | 实线（1.5–3px，粗细可按速率分档 100M/1G/10G+） | 绿 | 无 | 端口:端口 + 速率（可开关） |
| manual_physical | 实线同宽 | 深青（区别于 LLDP 绿） | 小方块端点 | 端口:端口 + "人工" |
| lldp_half | **虚线** | 黄 | 对端空心圈（b_snapshot 名标于圈旁） | 本端端口 + "待确认" |
| agg_lacp | **加粗双线**（宽度=成员数映射） | 绿 | 菱形端点 | Trunk 名 + 成员数 + 总带宽 |
| route_nexthop | 点划线 | 灰蓝 | 箭头（下一跳方向） | "路由非物理"（默认隐藏此类） |
| vrrp | 弧形虚线 | 红 | 双人字/V 标记 | VRID + master/backup（采到时） |
| stack | 三线捆绑 | 紫 | 堆叠括号标记 | 堆叠域（采到时） |

- 冲突（status=conflict）覆盖为红色实线+感叹号；stale 一律灰点线（覆盖关系色）。
- **图例组件**（参考图左下）：按上表自动渲染，含当前图中各类计数；物理类与逻辑类分组展示并标注"逻辑关系不代表直连"。
- 链路 label 默认只显示物理类（confirmed/manual/agg）的端口+速率，缩放到 zoom>0.6 才显示（防 1000+ 边文字爆炸）；half/route 类 label 常显关键状态词。

### 6.5 链路点击详情 Drawer

点击任意边 → Drawer：关系类型与含义解释、两端设备+接口（可跳接口流量 mini 图，复用现有 traffic 接口）、证据列表（evidence 表逐条：来源/时间/raw 摘要）、状态历史、可执行操作（按角色：确认/驳回/改类型/删除）。半链路 Drawer 内直接展示 b_snapshot 原文（对端自报名）——审核从"列表批量"升级为"逐条带证据审阅"。

### 6.6 告警状态接入（节点角标）

- 数据源：Zabbix `problem.get`（P0 server 已有同款调用可移植到 topology-svc 只读代理），按 hostid→node 映射，节点角标三态：无告警/一般/严重（按 problem severity 映射）。
- 只读展示，不落 topology 库（避免与 P0 告警视图双源）；接口 `GET /alerts/summary` 现查缓存 60s。

### 6.7 性能预算

- 现量级：160 节点/1027 边——G6 canvas 无压力；V2 图标节点+label 增量可控。
- 措施：边 label 按 zoom 分级显隐；route_nexthop 默认关；区域折叠时子图不渲染；数据接口 graph 一次全量（现状不变），增量刷新仅节点状态字段（轻量轮询 60s）。

---

## 7. 数据库设计（V2 目标 schema，双方言）

> 延续 `db.js` 双引擎+`toMysqlSql` 翻译机制；新表一律 sqlite/MySQL 成对 DDL；命名避开 MySQL 保留字（不用 `order/group/key` 裸词）。所有新表走 `CREATE TABLE IF NOT EXISTS`，旧库自动增量，无需停服迁移工具（数据回填另有 §7.5 迁移脚本）。

### 7.1 新表：`topology_zone`（替代 topology_group）

```sql
CREATE TABLE topology_zone (
  zone_id      INTEGER PRIMARY KEY AUTOINCREMENT, -- MySQL: INT AUTO_INCREMENT
  name         TEXT NOT NULL,
  bg_color     TEXT DEFAULT '#f0f5ff',
  border_color TEXT,
  border_style TEXT DEFAULT 'solid',      -- solid | dashed | none
  border_width REAL DEFAULT 1,
  parent_zone_id INTEGER,                  -- 嵌套子区域（自引用，可空）
  note         TEXT,                       -- 红字富标注（机房/机柜编号等）
  collapsed    INTEGER DEFAULT 0,
  x REAL, y REAL, w REAL, h REAL,         -- 人工位置/尺寸（NULL=自动包络）
  sort_hint    INTEGER DEFAULT 0,          -- 初始建议层级（0=顶层往下）
  created_by   TEXT, created_at INTEGER,
  updated_by   TEXT, updated_at INTEGER
);
```
- `topology_group` 不删不写（旧表冻结），迁移脚本把八类 group 行转 zone 行（label→name，key 存 `meta` 旧映射），前端不再读旧表。

### 7.2 `topology_layout` 增列（ALTER）

- `zone_id INTEGER`（NULL=未分区）；`layout_source` 值域扩为 `auto|suggested|manual`。
- 旧列 `group_key` 保留只读一个版本期，迁移后写 NULL（MySQL 不支持 `ADD COLUMN IF NOT EXISTS`——迁移脚本查 information_schema / sqlite PRAGMA table_info 判存在）。

### 7.3 `topology_link` 增列（ALTER）

```
relation_type TEXT NOT NULL DEFAULT 'lldp_confirmed'  -- 七枚举，迁移脚本按 4.8 回填
parent_link_id INTEGER          -- 聚合成员→agg 逻辑链（可空）
vlan_id INTEGER                 -- vrrp/聚合的 VLAN 上下文（可空）
bandwidth_bps BIGINT            -- 聚合总带宽=成员和（应用层算，冗余列便于渲染）
```
`norm_key` 前缀命名空间扩：`L:`/`H:`（物理沿用）、`G:` agg、`R:` route、`V:` vrrp、`S:` stack。

### 7.4 新表：`topology_link_evidence` 与 `topology_layout_snapshot`

见 §4.3、§5.5 DDL 同风格（evidence 表 payload 用 LONGTEXT/TEXT；snapshot 表 zones_json/layout_json 存 JSON 文本，单份 ~百 KB 内）。索引：`idx_evidence_link(link_id)`、`idx_snapshot_created(created_at)`。

### 7.5 迁移与回滚脚本（新增 `topology/scripts/migrate-v1-to-v2.mjs`，仅设计描述）

1. 备份：sqlite `VACUUM INTO` / MySQL mysqldump（对齐既有 migrate-sqlite-to-mysql.mjs 惯例，compose --profile tools 跑）。
2. ALTER 增列（幂等：先查列存在性）。
3. 回填：按 §4.8 映射 UPDATE `relation_type`；`topology_group` 八行→`topology_zone`（默认 collapsed=0，位置沿用旧 x/y/w/h；group_key 记入 topo_meta `v1.group_map` 备回滚）；layout.group_key→zone_id（按旧 key 找新 zone_id）。
4. 证据回填：每条 confirmed/half 链生成 1–2 条 evidence 行（kind=lldp_a/lldp_b，observed_at=seen_*_at；half 的 b_snapshot→kind=lldp_raw）。
5. 校验断言：行数守恒、relation_type 覆盖率 100%、norm_key 无冲突；输出对账报告。
6. 回滚：旧表未删，`v1.group_map` + 列默认值可逆；快照表机制兜底布局回滚。

### 7.6 ER 汇总（V2）

```
topology_zone 1──* topology_layout(node 隶属+坐标)
topology_node 1──* topology_interface(*──1 parent 自引用聚合成员)
topology_link(relation_type, parent_link_id, vlan_id) *──1 topology_node/interface 两端
topology_link 1──* topology_link_evidence
topology_layout_snapshot(全局快照 JSON)
topo_meta(k/v: rt.<node> 路由快照、v2.settings、v1.group_map)
topology_discovery_record / topology_metric_mapping：不变
```

---

## 8. API 设计（REST，topology-svc :8790）

### 8.1 现有端点保留清单（全部不破坏）

`/health`、`POST /sync`、`GET /nodes`、`GET /nodes/:id`、`GET /interfaces`、`GET /links`、`GET /links/pending`、`POST /links/bulk-confirm`、`POST /links/bulk-reject`、`POST /links`、`DELETE /links/:id`、`GET /links/:id/traffic`、`GET /graph`、`GET/PUT /layout`、`GET /layout/groups`（V2 兼容期保留，转 shim 读 zone）、`POST /layout/reset`、`POST /discovery/run`、`GET /discovery/runs|records|summary|cleanup`、`GET /interfaces/:id/traffic`、`POST /pathtrace/*`×4。

### 8.2 新增端点

**区域（Zone）**
| 方法 | 路径 | 说明 | 权限 |
|---|---|---|---|
| GET | `/zones` | 全量区域（含嵌套） | 读 |
| POST | `/zones` | 建区域（name 必填；bg/border 可选） | 管理员 |
| PUT | `/zones/:id` | 改名/颜色/边框/note/sort_hint | 管理员 |
| PATCH | `/zones/:id/geometry` | 拖动/缩放/折叠高频写（x,y,w,h,collapsed） | 管理员 |
| DELETE | `/zones/:id` | 删除区域（成员设备转未分区；有子区域需先处理） | 管理员 |
| POST | `/zones/:id/members` | 设备入区（node_ids[]，placement.source='manual'） | 管理员 |
| GET | `/zones/suggestions` | 只读算法建议（未分区聚类），不落库 | 读 |

**布局**
| 方法 | 路径 | 说明 | 权限 |
|---|---|---|---|
| PUT | `/layout/batch` | 批量坐标+zone 隶属（拖动落点事务性写） | 管理员 |
| POST | `/layout/snapshots` | 命名快照 | 管理员 |
| GET | `/layout/snapshots` | 列表 | 读 |
| POST | `/layout/snapshots/:id/restore` | 回滚（自动先打当前快照） | 管理员 |

**关系**
| 方法 | 路径 | 说明 | 权限 |
|---|---|---|---|
| POST | `/links` 扩展 | body 增 relation_type（manual_physical/agg_lacp/vrrp/stack 走此入口人工建）；物理类四元硬校验 | 管理员 |
| PATCH | `/links/:id/relation` | 半链→人工物理确认等语义改写（保留证据链） | 管理员 |
| GET | `/links/:id/evidence` | 证据列表 | 读 |
| GET | `/graph` 扩展 | 增 `include_logic=0|1` 参数（route/vrrp/stack 叠加）；响应带 relation_type、bandwidth、evidence 计数 | 读 |
| POST | `/linker/route-scan` | 从路由快照生成 route_nexthop 关系（幂等、只 append） | 管理员 |

**设备标注 / 告警**
| 方法 | 路径 | 说明 | 权限 |
|---|---|---|---|
| PATCH | `/nodes/:id` | 管理员标注 device_class/model（class_evidence='manual'，自动分类不得覆盖） | 管理员 |
| GET | `/alerts/summary` | Zabbix problem 现查（60s 缓存） | 读 |

**认证（新增，§10）**
`POST /auth/login`、`POST /auth/logout`、`GET /auth/me`。

### 8.3 写操作统一约定

- 所有写端点移除"operator 自报字符串"信任：`operator`/`role` 一律来自会话（§10），body 里的 operator 字段兼容期忽略并告警日志。
- 高频 PATCH（geometry/layout/batch）走 debounce 500ms 前端合并 + 后端幂等 upsert（layout_source=manual 语义即时写）。
- 审核类批量操作保持"link_ids 或 match 圈定 + 幂等 + 操作前自动快照护栏"（沿用 V1.5 纪律）。

---

## 9. SNMP / Zabbix 采集能力差距分析（十项，含现网实测证据）

> 实测方式：Zabbix 临时 walk 项（type=20、value_type=4、用后即删）探测 4 台代表设备（H3C S7506X-G 核心、S5135S-24FP4T4S-EI 接入、Huawei USG6625F 防火墙、华为核心 IDC-R01-36U-SW1）× 6 MIB 族；脚本 `.workbuddy/tmp/probe_v2_mibs.mjs`（可复用）。日期 2026-10-31。

| # | 能力项 | 现状 | 实测/证据 | V2 方案 |
|---|---|---|---|---|
| 1 | 设备基础信息 | ✅ 已有（host.get + sysDescr/sysObjectID 实测可读） | sysDescr 含型号：`S7506X-G`/`S5135S-24FP4T4S-EI`/`USG6625F`；sysObjectID enterprise 25506=H3C、2011=Huawei | 新增 Zabbix 内置项 `system.descr`/`system.objectid`（多数模板已内置 SNMP agent 项，直接 history.get）→ 回填 node.model/vendor/class |
| 2 | 接口清单 | ✅ 已有（net.if.* 聚合，6925 条，fingerprint 抗漂移） | 现网正常 | 保留 |
| 3 | LLDP 邻居 | ✅ 已有（临时 walk lldpRemTable） | 现网限制：H3C remTable 空（对端不发）、IDC 未开 LLDP → 84% half | 保留；推进网络组开 LLDP（既有专项文档路径）；half 承载不变 |
| 4 | 接口速率 | ✅ 已有（if_speed mapping；注意已预处理乘值，不再乘 1e6） | 10G+ 2071 / 1G 3661 / 100M 914 / null 267 | 保留；速率分档进边宽渲染 |
| 5 | IP/子网 | ✅ 已有（ipAddrTable，pathtrace 在用） | 正常 | 复用；接口级 IP 挂到 interface 展示（Drawer） |
| 6 | VLAN（TAG/名称） | ❌ **标准 MIB 采不到** | `dot1qVlanStaticName`(1.3.6.1.2.1.17.7.1.4.1.3) 4 台 walk 全部 **0 行 empty(no error)** —— MIB 视图未放开（与当年华为 LLDP iso 视图不输出同模式） | 方案 A（推荐）：网络组放开 MIB 视图（H3C `snmp-agent mib-view` 放 BRIDGE-MIB/Q-BRIDGE-MIB；华为放相同）；方案 B：VLANIF 接口名自带 VLAN 号（**零 SNMP 成本，344 条 vlan 接口立即可用**，一期先做这个）；方案 C：vendor 私有（H3C hh3cVlan / Huawei huaweiSwitchExtMIB）作为 A 受阻备选。TAG(PVID) 需 Q-BRIDGE-MIB dot1qPvid——视图放开后可行性高 |
| 7 | Eth-Trunk/LACP | ❌ 采不到 + **接口发现未含聚合口**（agg=0） | 8023-LAG（baseAggregate 34.1.1.4 / aggregator 34.2.1.1）4 台全部 0 行 empty；同时 Zabbix SNMP 接口发现（IF-MIB ifTable）本就不列华为 Eth-Trunk/H3C Bridge-Aggregation 逻辑口（逻辑口在 entPhysical 而非 ifTable 的部分实现中） | 分两步：(a) 聚合逻辑口入库——候选源：`entPhysicalClass=aggregator(5)`（**entPhysicalClass 实测可读**：209/67/40 行 OK，含聚合器实体）经 entPhysicalName 提取 Eth-Trunk/BAGG 名；(b) 成员关系——8023-LAG 需放开视图（方案 A）或 vendor MIB（H3C hh3cLACP / Huawei huaweiIfExt）；均不可达时人工录入 agg_lacp。兼容性：H3C Comware 与华为 VRP 私有 OID 分开实现，不假设同 MIB |
| 8 | VRRP | ❌ | VRRP-MIB(1.3.6.1.2.1.28) 4 台全部 0 行 empty | 放开视图后 vrrpVRRPEntryTable 标准可行；华为 VRP 亦支持标准 VRRP-MIB；一期人工录入 vrrp 关系（核心对已知冗余对可由管理员标注）。采集实现：临时 walk `walk[1.3.6.1.2.1.28.1.2]`（组表）+ `.28.1.3`（实例状态），复用 discovery 临时项框架 |
| 9 | 堆叠/IRF/CSS | ❌（无数据源） | 无标准 MIB；LLDP 不将堆叠口报为标准邻居；现网无相关 Zabbix 项 | 只能 vendor 私有：H3C IRF——`hh3cDeviceManagementMIB`（hh3cIRFPriority/hh3cIRFMember 等）；华为 CSS/iStack——`huaweiDeviceInfoMIB`（hwDeviceManage 域）。**先提交 OID 清单与兼容性矩阵，待 SNMP 视图策略确认后实现**；一期堆叠关系全部人工录入（现网已知堆叠对由管理员标注）。注意：堆叠成员在 SNMP 视角常表现为同一逻辑设备，建图前先与网络组确认现网是否真有堆叠形态，没有就不建此类数据 |
| 10 | 光模块 DDM | ❌ | `entSensorValue`(1.3.6.1.2.1.99.1.1.1.4) 4 台全部 0 行；Zabbix 现成 sensor 项仅 fan/temp/psu（147/56/4 个），**无任何光模块项** | 候选：H3C `hh3c-Entity.mib`（hh3cTransceiverTable：温度/电压/电流/功率/灵敏度）；华为 `huaweiTransceiverMIB`（hwTransceiverTable 1.3.6.1.4.1.2011.5.2.13 系）。两者均需实体已启用 DDM + SNMP 视图放开。一期不做自动采集，链路详情预置"光功率"空态槽位（人工可填 note） |

### 9.1 实测证据汇总（2026-10-31，4 台 × 6 族，全部只读 walk）

| 探测族 | OID | 结果 |
|---|---|---|
| P1_system | `walk[1.3.6.1.2.1.1]` | ✅ 9–11 行 OK（sysDescr 含型号、sysObjectID enterprise 可辨厂商） |
| P2_vlan | `walk[1.3.6.1.2.1.17.7.1.4.1.3]` | ❌ 全部 0 行 empty(no error) |
| P3_lacp | `walk[...34.1.1.4,...34.2.1.1]` | ❌ 全部 0 行 empty |
| P4_vrrp | `walk[1.3.6.1.2.1.28]` | ❌ 全部 0 行 empty |
| P5_entity | `walk[1.3.6.1.2.1.47.1.1.1.1.5]` | ✅ 209 / 67 / 40 行 OK（entPhysicalClass 可读，含 aggregator 类实体） |
| P6_sensor | `walk[1.3.6.1.2.1.99.1.1.1.4]` | ❌ 0 行 |

关键判读：`empty(no error)` 而非 `noSuchObject`/超时——SNMP 可达且无权限报错但返回空，**典型 MIB 视图未放开特征**（与华为 CE6881H LLDP iso 视图事件完全同模式，见 `docs/UOCP-华为CE6881H-LLDP-SNMP专项排查-2026-10-25.md` 先例：放开视图后同 OID 即出数据）。因此 §9 各项的"方案 A=放开视图"有现成协作路径，不是技术不可行。

### 9.2 零成本立即可做（不依赖网络组配合）

1. **model/vendor/class 回填**：sysDescr/sysObjectID 走 Zabbix 内置 SNMP agent 项（agent 设备大多已有 `system.descr`），history.get 即取——160 台型号列当期可填。
2. **VLANIF→vlan_id**：344 条 vlan 接口名解析，接口模型即刻带 VLAN 上下文。
3. **entPhysicalClass=aggregator 探测聚合口存在性**：209 行样本里可统计各设备聚合器实体——先产出"哪些设备疑似有 Eth-Trunk/BAGG"清单（只作建议清单，不建数据），指导人工录入优先级。

### 9.3 采集实现纪律（沿用）

所有新 MIB 族走 `discovery.js` 临时 walk 框架（type=20、value_type=4、interfaceid 必填、delay≠0、首轮等待 ≥80s、用后即删、raw_snapshot 留证、四态失败分级——**采集失败绝不写成"无该数据"**）。vendor 私有 OID 按 h3c/huawei 两套配置表，未知厂商不猜。

---

## 10. 权限与认证设计

### 10.1 现实起点

平台无认证（§1.3）。任何"管理员/普通用户"分档都必须先解决"你是谁"。可选集成路径评估：

| 路径 | 描述 | 评估 |
|---|---|---|
| A. 最小自建认证（推荐起步） | topology-svc 内置用户表+登录接口，签发 httpOnly cookie 会话（随机 token 存 `topo_meta` 或新表），HMAC 签名防篡改；P0/P1 前端共用 | 工作量小（~1 天）、立即满足"后端校验"红线；密码 bcrypt 哈希；不与任何外部系统耦合。缺点：多系统各自登录 |
| B. P0 server 统一签发 | 在 P0(:8787) 建认证，topology-svc 校验 P0 共享密钥签发的 JWT | 平台化方向正确；P0 目前也无认证，等于 A 换个位置做。二期合并 |
| C. 对接现网统一认证（LDAP/OA/企业微信） | 真实企业场景终态 | 需要 IT 部门提供 LDAP/SSO 参数——列为开放问题 Q5，不阻塞 V2 |

**一期采用 A**（topology-svc 自治最小认证），接口面按"会话可替换"设计（`auth/me` 抽象，日后换 JWT/LDAP 不动业务端点）。

### 10.2 角色与权限矩阵（两档）

| 能力 | 管理员(admin) | 普通用户(viewer) |
|---|---|---|
| 查看拓扑/区域/链路/详情/流量/告警 | ✅ | ✅ |
| 区域 CRUD、拖动缩放、折叠 | ✅ | ❌（前端隐藏+后端 403） |
| 设备拖动、入区/出区、坐标保存 | ✅ | ❌ |
| 设备 class/model 标注 | ✅ | ❌ |
| 链路审核（确认/驳回/批量） | ✅ | ❌ |
| 人工建链/改关系类型/删链 | ✅ | ❌ |
| discovery/sync/linker 触发 | ✅ | ❌ |
| 布局快照/回滚 | ✅ | ❌ |
| 用户管理（建用户/改密） | ✅ | ❌ |

### 10.3 后端校验实现要点

- 中间件 `requireRole('admin')` 挂在**全部写端点**（§8 表格权限列即清单）；viewer/匿名写一律 403，与前端按钮隐藏无关。
- 写操作的 `updated_by/confirmed_by/operator` 从会话取，忽略 body 自报（兼容期记 WARN 日志）。
- 登录限速（5 次/分钟/IP）、会话 7 天滑动过期、密码不出接口（登录外任何端点不回哈希）。
- 初始管理员由部署时环境变量 `TOPO_ADMIN_BOOTSTRAP_USER/PASS` 首启创建（凭据走卷挂载/.env，不入镜像——沿用部署纪律）。
- CORS：topology-svc 仅允许 P0 web 来源 + 携带凭据（当前 `*` 配置必须收紧）。

---

## 11. 分阶段实施计划

> 每阶段结束都有可验收产物与回退点；任何阶段不做"顺手重构"。预估按单人全职。

### Phase 0（0.5 周）：设计冻结 + 数据地基
- 审核通过本方案；`migrate-v1-to-v2.mjs` 幂等迁移脚本（§7.5）+ 对账断言；zone/link 增列、evidence/snapshot 新表上线（旧前端零感知——列都带默认值）。
- 验收：生产库迁移演练（sqlite 副本+MySQL compose 各跑一遍）行数守恒、旧接口全绿。

### Phase 1（1.5 周）：最小认证 + 权限后端化
- §10 路径 A 落地；全部写端点挂 requireRole；前端登录页 + 会话态；operator 自报字段退役。
- 验收：viewer 会话直连 curl 写端点全部 403（curl 测试集入 `.workbuddy/tmp/`）。

### Phase 2（2 周）：区域模型 + 区域编辑器
- zone CRUD API + 前端区域工具栏：建区、改名/颜色/边框/note、拖动缩放、折叠、拖入拖出设备、`/zones/suggestions`。
- `topology_group` 读路径全部切 zone（/graph 兼容 shim 一个版本）。
- 验收：空画布不出现任何自动区域；参考图式彩色区域可由管理员 30 分钟内手工搭出；刷新/换浏览器布局一致。

### Phase 3（2 周）：七类关系数据层 + 审核升级
- relation_type 回填、evidence 表写入路径、半链→manual_physical 语义改写 API、route_nexthop linker（默认不显示）、人工建链扩展（agg/vrrp/stack 人工录入 UI）。
- 验收：1027 条存量链路 100% 带 relation_type；审核页逐条证据可查；route 关系生成幂等。

### Phase 4（2.5 周）：画布视觉重构
- device-node 图标库（12+ SVG symbol）+ model/告警角标；七类关系边样式 + 图例组件 + 端口/带宽 label 分级显隐；链路详情 Drawer（证据/流量 mini）；聚合加粗双线+成员展开；逻辑视图开关。
- 验收：与参考图逐元素比对清单（区域/图标/线型/图例/标注五项达标）；route 关系在物理视图 0 条泄漏。

### Phase 5（1.5 周）：布局工具化 + 快照
- autoLayout 降级改造（仅未锁定）、快照/回滚 UI、批量操作自动护栏快照；钻取视图层级纪律迁移验证。
- 验收：manual 坐标在 sync/discovery/批量审核后 0 位移（前后坐标 diff 断言）。

### Phase 6（1–2 周，外部依赖）：采集扩展
- 零成本三项先行（model/class、VLANIF vlan_id、聚合器建议清单）；MIB 视图放开申请提交网络组（附 §9.1 实测证据与华为 LLDP 先例文档）；放开后按 discovery 框架实装 VLAN/LACP/VRRP collector + vendor 私有堆叠/光模块调研纪要。
- 验收：每项新采集以"实测 walk 行数>0 的样本设备"为完成标准；未放开项保持人工录入通道。

合计：不含 Phase 6 外部等待约 **10 周**；Phase 2–5 可按 2/3→4 部分并行压缩到 ~8 周。

---

## 12. 风险与开放问题（需人工裁决）

| # | 问题 | 建议默认 |
|---|---|---|
| Q1 | 半链 84% 的存量视觉：全部黄虚线会不会满屏黄线？ | 按证据可信度分深浅两档（cid 命中 vs 仅 sysName）；同时推进网络组开 LLDP（既有专项） |
| Q2 | 区域是否允许重叠/大面积交叠？ | 允许（参考图有嵌套与相邻）；碰撞仅 UI 提示不禁止 |
| Q3 | 参考图右侧独立小面板（管理网/分支）要不要"多画布"？ | 一期用折叠胶囊+搜索定位承载；二期评估多画布（涉及跨画布链路显示难题） |
| Q4 | 汇聚层（dist_switch）现网命名规律弱，自动判类误判风险 | class_evidence 三档置信+人工标注兜底已设计；建议上线后管理员抽检 20 台 |
| Q5 | 统一认证对接（LDAP/OA） | 待 IT 部门输入；auth 抽象层已留 |
| Q6 | dbmp/zCloud 数据库实体要不要进 V2 画布？ | 不进（网络拓扑域）；保留 P0 侧 zCloud 卡片；如需关联仅在设备 Drawer 里列"该设备承载的 DB"只读引用 |
| Q7 | 聚合口采集依赖视图放开，若长期不放开？ | 人工录入通道常开；`entPhysicalClass` 建议清单辅助 |
| Q8 | 现网是否真有堆叠（IRF/CSS/iStack）？ | 需网络组确认；没有则 stack 类保持空态（不建假数据） |
| Q9 | 旧 `topology_group` 表退役时间表 | 两个版本兼容期后删除（迁移脚本备份先行） |

---

## 附：本设计未改动任何代码

本文件是唯一产物。所有引用的现状代码行为均来自对 `topology/src/*`、`web/src/topology/*`、`web/src/api.ts` 的全文/关键段阅读与现网只读实测（SNMP walk、Zabbix API、DB 只读查询）。等待人工审核；审核意见将形成 V2.1 修订后再排期实施。

# UOCP 网络拓扑 · M1 出口报告（采集修复 → 抽样 → 全量）

> 日期：2026-10-25 ｜ 范围：M1（修采集）经用户逐批批准推进至 M2 数据基础（153 台全量只读发现）
> 红线全程遵守：**未迁移任何 DB 结构、未对任何交换机/防火墙配置做写操作**（全程经 Zabbix SNMP GET/walk 只读，临时托管项 `lldp.discovery.<runId>` 用后即删、对账无残留）。

---

## 1. M1 做了什么（对照 TOPOLOGY-P2-DESIGN.md v1.2 §9-M1）

| 事项 | 结果 |
|---|---|
| walk OID 修正（`config.js`） | v1 五个错误 OID（rem 用了 `.4.1.5`）全部修正为标准 LLDP-MIB（`lldpRvRemTable .4.1.1` 等）；修复后单台 S5590 即得 rem 306 行（v1 为 0 行） |
| 解析器修正（`lldpParser.js`） | rem 列索引正则 `.4.1.1.<col>.<tm>.<port>.<remidx>`、chassis 标量 `.3.2.0`、loc 多字符列号 |
| vendor 路由（`discovery.js`） | huawei → §2.4 获批方案 C，直接记 `mib_unsupported`（**绝不记"无邻居"**）；h3c → 标准 walk |
| 四态证据分级落库 | discovery_record.result 四态：`ok` / `mib_unsupported` / `walk_empty` / `snmp_unreachable`，各态语义隔离 |
| 自环守卫 | LLDP 邻居解析回本机（IRF 堆叠成员口回指）不建链路 |
| `discovery/run` node_ids 语义 | 确认为 zbx_hostid 字符串数组；不带 node_ids = 全量（`status<>'stale'`） |

## 2. 发现轮时间线（`topology_discovery_record.run_id` 实况）

| run_id | 记录数 | 性质 | 结果 |
|---|---|---|---|
| `b45f639c` | 1 | 早期单台（修前） | — |
| `ebfdac1f` / `c85ee992` | 137×2 | 修前全量（错误 OID 基线） | 几乎全 walk_empty（印证 OID 根因） |
| `ea426abb` / `dfe501f8` | 1×2 | **M1 单台受控验证**（S5590） | 34 邻居/30 链路；第二轮 new=0/updated=30 → **V4 幂等 ✓** |
| `6d290441` / `75b1e3fd` | 15×2 | **抽样验证**（含 IDC 华为与不可达历史名单） | ok=14 / mib_unsupported=1 → **V2 ✓**（华为单列不误判） |
| `bd223d4c` | **153** | **M2 数据基础：全量只读发现（用户放行）** | ok=107 / mib_unsupported=44 / walk_empty=2 |

## 3. 全量（run bd223d4c）核心数据

- 纳管节点 **153**（含 2 台 degraded）→ `ok=107`、`mib_unsupported=44`（**全部 huawei**：IDC 接入交换机 + IDC-R10-5U-CORE-SW1、IDC-R20-5U-CORE-SW2 两台核心 + 14 台 FW6625/6585 防火墙）、`walk_empty=2`（即 degraded 两台：yixi1#biandiansuo 10.14.0.80、xiaoliutaobiandiansuo 10.14.0.207）。
- 链路 **507** 条（全部 source=lldp_zbx，零猜测来源）：`confirmed 82`（双端各自观察到对端）、`half 425`（单端证据，多为华为侧读不到导致的 IDC↔H3C 边界）。
- 有链路设备 **107** / 无链路设备 **46** / 未纳管对端去重 **369**（含大量终端 PC/打印机 MAC；疑似核心：**JK_Industrial_Core**、**SFPC-9021LAN001-HXSW**）。
- 并行链路独立成行不合并、自环不建线——"不伪造连接"红线在数据层持续成立。

## 4. 验收项勾验（本轮新增）

| # | 验收 | 结果 |
|---|---|---|
| V1 | 修复 OID 后 S5590 单台发现 | ✓（前轮已验：rem≥30 行、邻居≥29、快照含 `.4.1.1.*`） |
| V2 | 华为设备记 `mib_unsupported`，绝不记"无邻居" | ✓（44 台全部 huawei 单列；抽样与全量两轮一致） |
| V3 | 不可达设备不产生邻居语义 | ✓ 并更新：历史不可达 10.14.0.134 / 10.14.0.130 最新轮均已恢复 `ok`（134 得 3 邻居）——§10-5 核查事项可关闭 |
| V4 | 同 run 重跑行数不变（去重幂等） | ✓（单台两轮 new=0；全量轮后 graph 无重复链路堆积） |
| V18 | 无按网段/名称相似度生成 link 的代码路径 | ✓（link.source 全部 lldp_zbx，507/507） |

V5~V9、V12~V15（三维状态机/审计/租约）属 M2 结构迁移范畴——**未获准、未启动**。

## 5. 未纳管对端核查清单（并入人工处理清单 E 表）

完整 369 个去重对端见 `docs/UOCP-人工处理清单-2026-10-25.md` §E（按 chassis 聚合，含挂载点与端口）。处理优先级：

1. **JK_Industrial_Core**（办公网核心交换机）、**SFPC-9021LAN001-HXSW**（S5590C 上联 25GE 槽位形态=疑似 IRF 堆叠核心）→ 建议加入 Zabbix SNMP 监控；纳入后下一轮发现自动把相关 half 升级 confirmed。
2. 其余对端多为终端（PC/打印机 MAC）或机柜小交换机，按需纳管。

## 6. M1 出口结论与下一步

- **M1 出口判据达成**：V1~V4 通过；采集链路（OID→解析→四态→落库→graph API→前端全网总览）端到端真实数据贯通。
- 前端已交付"全网总览 + 一跳/两跳聚焦 + 未纳管对端开关 + 无链路设备网格陈列（不连线）"（详见 `docs/TOPOLOGY-P2-DESIGN.md` §12）。
- **待用户评审**：M2 正式范围（DB 结构迁移 up/down、三维状态机 A/B/C、alias/external 表、audit/租约）——当前 507 链路仍运行在旧两态模型（half/confirmed）之上，属过渡态。
- network_role 全部仍为"未分类"（人工核定未开始，§10-6 待台账）。

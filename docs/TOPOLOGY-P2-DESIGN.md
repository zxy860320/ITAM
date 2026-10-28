# UOCP 网络拓扑模块重构方案（P2）

> 版本：**v1.2（v1.1 有条件通过后四项修订 · 待确认）** ｜ 日期：2026-10-25 ｜ v1.1 评审有条件通过；本版落实四项：①计数器 0 不得定性"从未收到"（§2.3）②监控对象与真实设备身份分离（§3.1）③自动 pair 不等同人工审核、B 轴移除 auto_confirmed（§4.1/4.2）④华为 CE6881H 私有 MIB 只读实测→无邻居明细，定案方案 C（§2.4）。
> 状态：四项修订完成；M1 仅获批**单台 H3C 受控验证**（结果见 `.workbuddy/tmp/M1-REPORT.md` / §11）。禁止 137 台全量发现、禁止 DB 结构迁移、禁止修改交换机配置。
> 前置：P1 已上线（topology-svc :8790 + web #/topology）；P0（:8787）与 web（:5273）零改动。
> 硬约束：**不得改动任何交换机配置**；不建 CMDB；保持 UOCP 微服务架构；**不得为了让拓扑图看起来完整而伪造任何网络连接关系**。

---

## 0. v1.1 核心结论（证据先行）

**v1 关于"数据源没有邻居（对端没有发送 LLDP PDU）"的定性，本轮撤回。** 直接只读 SNMP v2c 探测（net-snmp，community 经 Zabbix `hostinterface.get` 只读取得）得到如下证据：

1. **v1 生产采集的 7 个 walk OID 中 5 个无效**（`topology/src/config.js: lldpWalk`）：
   - `1.0.8802.1.1.2.1.3.0` —— 无效（标量实例应为 `.3.1.0`/`.3.2.0`）；
   - `…1.4.1.5 / .4.1.7 / .4.1.8 / .4.1.9` —— **缺 Entry 层**，正确为 `…1.4.1.1.5 / .4.1.1.7 / .4.1.1.8 / .4.1.1.9`。
   对 H3C SFPC-9021LAN001-HJ-S5590 同机对照实测：**错误 OID `.4.1.5` walk=0 行；正确 OID `.4.1.1` walk=34 行（29 个不同邻居，含 SysName、ChassisId MAC、PortId 完整字段）**。→ "0 邻居"的头号根因是**我方 OID 错误**，不是交换机未发 LLDP。
2. **H3C Comware V7 完整实现标准 LLDP-MIB**：抽 12 台（每 9 取 1），10 台 SNMP 可达且**全部返回邻居数据**（1~11 行/台，样机 S5590 达 34 行）；`lldpPortConfigAdminStatus` 全部 = `txAndRx(3)`；`lldpStatsRemTablesInserts=297 / Deletes=263 / Ageouts=72 / Drops=0`。按 109 台 H3C 估算，**仅修正 OID 即可产生数百条真实 LLDP 证据**。
3. **华为 CloudEngine（CE6881H，YunShan OS V200R024，28 台 IDC）不实现标准 LLDP-MIB**：全部 `1.0.8802.1.1.2.*` GET 返回 `noSuchObject`（config/stats/loc/rem 皆无），3 台抽查一致——这是"MIB 未实现"而非权限拦截（同 community 能读私有 MIB）。私有 HUAWEI-LLDP-MIB（`.1.3.6.1.4.1.2011.5.25.134`）可读：全局标量 `.134.1.1.1.0 = 1`（**LLDP 全局已使能**）、端口配置表 55 行、远端 NetworkId 表 20~21 行——**提示华为侧邻居真实存在，但明细需私有 MIB 专项方案**（§2.4）。
4. **v1 §3.3-5"大概率接口级 LLDP 未启用"的推测一并撤回**：两家厂商证据均显示 LLDP 已启用。

"0 邻居"各假说解释力排序：**①我方 OID 错误（已证实、可自纠）＞ ②华为不实现标准 MIB（已证实、需专项）＞ ③个别设备 SNMP 不可达（抽样 12 台中 2 台超时，对应 DB 的 h3c walk_empty）＞ ④交换机未发 LLDP（无任何证据支持）**。

---

## 1. P2 原方案问题修订对照表（输出①）

| # | v1 原文/设计 | 问题 | v1.1 修订 | 依据 |
|---|---|---|---|---|
| 1 | §1.2 结论"数据源没有邻居、对端不发 PDU" | 定性过早、根因误判 | **撤回**。根因①我方 walk OID 无效；②华为不实现标准 MIB；③个别设备不可达 | §2 直接探测：错误 OID=0 行 / 正确 OID=34 行 |
| 2 | §3.3-1 增加 `lldpRemLastStatusChange`、`lldpRemTTL` | **两对象不存在于 LLDP-MIB**（引用错误） | 改用真实对象：`lldpStatsRemTablesLastChangeTime/Inserts/Deletes/Drops/Ageouts`（`.2.1.0~.2.5.0`）+ `lldpStatsTxPortTable(.2.6)`、`lldpStatsRxPortTable(.2.7)` | 标准 MIB 对象表 + S5590 实测 |
| 3 | §3.3-5 "大概率 LLDP 未启用邻居收报，需网络组核查" | 无证据推测 | 撤回定性；改为采集实况 `lldpPortConfigAdminStatus(.1.6.1.2)`：实测 H3C 全=3(txAndRx)、华为全局使能=1 | round2/round5 |
| 4 | §1.3 "chassis_id 全库 0 条（`.3.0` 现网不返回）" | 把 OID 错误归因设备 | 更正：`.3.0` 本身无效；正确实例 `.3.2.0` 实测可读（本机 chassis MAC） | round2 |
| 5 | §5.1 直接定案"ELK.js + 自绘 SVG" | 未经对比即定案 | 改三方案 PoC 比较后再定（§6） | 评审意见·四 |
| 6 | §4 链路状态两轴（discovery/confirmation） | 未分离实际运行状态；manual 与 LLDP 证据生命周期纠缠 | 三维状态轴（§5.1）；manual 链路不随证据过期失效 | 评审意见·二 |
| 7 | §3.2 role 与 node_type 混用 | device_type ≠ network_role | 两列分离：`device_type`（种类）与 `network_role`（角色，默认 unknown，仅人工/别名表赋值）（§4） | 评审意见·三 |
| 8 | §4 未覆盖边界场景 | 8 类场景缺失 | 补 ifIndex 漂移/堆叠/聚合口/并行链路/逻辑接口/多管理 IP/未纳管对端/多主机组（§4.3） | 评审意见·三 |
| 9 | §2/§7 可靠性仅"托管项对账"一条 | 缺租约、并发、限流、迁移回滚、审计 | 新增可靠性专章（§7） | 评审意见·六 |
| 10 | §7 顺序：S2 先改采集 | OID 正确性未验证即改码 | 调整为：**LLDP 原始数据验证（本轮已完成）→ 修数据模型与发现机制 → 前端 PoC → 完整界面**（§9） | 评审意见·七 |
| 11 | 旧页面按速率猜核心/汇聚（`tierOf`） | 违背"角色未知不得认定" | 废除；`network_role=unknown` 使用明确的独立样式 | 核心原则 |
| 12 | 复核更正：v1 曾报"275 条快照中 161 条含 `.4.1` 子串" | 假阳性——`.3.7.1.4.10` 等行含子串 `.4.1` | 逐行精确匹配 `.4.1.1.` 复核：**真实 rem 行数=0**，与 OID 错误完全吻合 | 本轮 DB 只读复核 |

---

## 2. 修订后 LLDP 采集设计（输出②）

### 2.1 标准 LLDP-MIB 权威对照表（IEEE 802.1AB；根 `1.0.8802.1.1.2`）

**不存在对象（v1 引用错误，永久禁用）**：`lldpRemTTL`、`lldpRemLastStatusChange`、`lldpRemTablesLastTimeMark`、`lldpRemTablesRefreshTime`、`lldpLocInitialization`、`lldpTimer`。

| 对象 | OID | 类型 | 用途 | 现网可得性（实测） |
|---|---|---|---|---|
| lldpMessageTxInterval | `.1.1.1.0` | Integer32 | 发包周期（证据解读用） | H3C=30 ✓ / 华为 noSuchObject |
| lldpMessageTxHoldMultiplier | `.1.2.0` | Integer32 | 老化倍数（H3C 实测=4） | H3C ✓ |
| lldpReinitDelay | `.1.3.0` | Integer32 | 重初始化延迟（=2） | H3C ✓ |
| **lldpPortConfigAdminStatus** | `.1.6.1.2.<port>` | INTEGER 枚举 1=txOnly 2=rxOnly 3=txAndRx 4=disabled | 端口收发使能实况；disabled 时已有远端条目会自然老化 | H3C 全=3 ✓ |
| lldpStatsRemTablesLastChangeTime | `.2.1.0` | TimeStamp | 远端表最近变化时刻（老化证据） | H3C ✓（=2322438967） |
| lldpStatsRemTablesInserts / Deletes / Drops / Ageouts | `.2.2.0~.2.5.0` | ZeroBasedCounter32 | 插入/删除/丢弃/老化累计（区分"从未有邻居"与"曾有后老化清零"） | H3C ✓（297/263/0/72） |
| lldpStatsTxPortTable | `.2.6.1.2.<port>` | Counter32 | 本端各口发出 LLDU 总数 | H3C ✓ |
| lldpStatsRxPortTable | `.2.7.1.2~.7.<port>` | Counter32×5 + ZeroBasedCounter32 | 本端各口**收到** LLDU 帧/错误/TLV/老化计数——邻居是否在发的直接证据 | H3C ✓（60+ 行） |
| lldpLocChassisIdSubtype / lldpLocChassisId | `.3.1.0` / `.3.2.0` | INTEGER / OctetString | 本机 chassis（匹配主键；v1 错写 `.3.0`） | H3C ✓ / 华为私有 MIB 待专项 |
| lldpLocSysName / lldpLocSysDesc | `.3.3.0` / `.3.4.0` | OctetString | 本机 LLDP 名（与 sysName 可不同） | H3C ✓ |
| lldpLocPortId | `.3.7.1.3.<port>` | OctetString | 本端端口 ID（v1 唯二有效 OID） | H3C ✓ |
| lldpLocPortDesc | `.3.7.1.4.<port>` | OctetString | 本端端口描述 | H3C ✓ |
| **lldpRemTable（远端邻居）** | `.4.1.1.<col>.<TimeMark>.<LocalPortNum>.<RemIndex>` | 见下 | 邻居证据主表 | H3C ✓（S5590 34 行） |
| ├ ChassisIdSubtype / ChassisId | `.4.1.1.4/.5` | INTEGER / OctetString(6B MAC 常见) | 对端设备唯一标识（MAC 归一化后匹配 chassis_id） | H3C ✓ |
| ├ PortIdSubtype / PortId | `.4.1.1.6/.7` | INTEGER / OctetString | 对端端口标识 | H3C ✓ |
| ├ PortDesc | `.4.1.1.8` | OctetString | 对端端口描述 | H3C ✓ |
| ├ SysName / SysDesc | `.4.1.1.9/.10` | OctetString | 对端设备名（匹配 system.name 主路径） | H3C ✓ |
| └ SysCapSupported / SysCapEnabled | `.4.1.1.11/.12` | OctetString(hex) | 对端能力（辅助 device_type 候选，不作认定） | H3C ✓ |
| LLDP-EXT-DOT1-MIB | `.5.32962` | — | 聚合口（dot3baAggPort）等扩展 | H3C rem 邻域未见实现（round1 portConfig walk 含 .5 子树时观察）；华为 `.5` 也 noSuchObject |

**rem 表复合索引解析（v1 解析器同错一层，必须同步修）**：`lldpParser.js` 正则 `BASE\.4\.1\.(\d+)\.(\d+)\.(\d+)\.(\d+)$` 把 `<col>` 误当 `<TimeMark>`。正确：`BASE\.4\.1\.1\.(col)\.(TimeMark)\.(LocalPortNum)\.(RemIndex)$`。实测索引示例 `.4.1.1.9.673080569.51.1` = col9, TimeMark=673080569（TimeTicks，非 0 表示条目重启后重载，**不得当行号用**）, LocalPortNum=51, RemIndex=1。TimeMark 仅用于去重（取同 (port,remidx) 最新 TimeMark），不参与语义。

### 2.2 修订后的 walk 计划（vendor 路由）

```
H3C / 通用标准实现：
  walk 1.0.8802.1.1.2.1.4.1.1        # rem 全表一次拉齐（列齐全，免多次 walk；实测 34 行 ~10KB）
  walk 1.0.8802.1.1.2.1.3.7.1        # loc 端口表（PortId+PortDesc）
  get  .3.1.0 .3.2.0 .3.3.0          # 本机 chassis/sysName
  get  .2.1.0 .2.2.0 .2.3.0 .2.4.0 .2.5.0   # 老化证据标量
  walk .1.6.1.2                      # 端口使能实况
华为 CloudEngine：标准 MIB 全部 noSuchObject → 走私有（下节）
```

### 2.3 证据分级与"无法采集"的区分

walk 结果四态（对应验收"不得把采集失败说成没有邻居"）：
- `rem_present`：rem 表有行 → 正常解析；
- `rem_empty_indeterminate`：rem 空 + stats Inserts=0 + RxPort 全 0 → **"本轮无法证明曾收到过 PDU"**。⚠️ 不得直接解读为"历史上从未收到邻居报文"，理由：
  1. `lldpStatsRemTablesInserts/Ageouts` 等为 ZeroBasedCounter32/Counter32，**设备重启或 agent 重启即清零**，清零后与"从未有过"不可区分；
  2. Zabbix 侧执行过 `hwLldpCounterReset`/清统计操作同样会使计数器归零（私有 MIB 明确提供该功能）；
  3. TimeMark（如实测 673080569）非 0 即表明 agent 曾重启、rem 表曾被重载——历史计数已不可信。
  判定"确无邻居"必须结合 `sysUpTime`（重启基准）、多轮连续观察（≥3 轮均为空）与 `lldpStatsRemTablesLastChangeTime`，否则一律标 `indeterminate`（中性结论）。任何情况下都**不断言物理链路不存在**；
- `rem_empty_aged`：rem 空 + stats Inserts>0 或 Ageouts>0 → "曾有邻居已老化消失"；
- `snmp_unreachable / mib_unsupported`：超时或 noSuchObject → **采集失败，绝不写"无邻居"**（v1 把这类混入 walk_empty 是错误，v1.1 单列状态）。

### 2.4 华为专项（本轮已按评审做只读实测，结论：私有 MIB 无邻居明细 → 选方案 C）

**实测对象**：IDC-R01-36U-SW1（10.25.0.1，CE6881H，community 经 hostinterface.get 只读取得）。证据：`.workbuddy/tmp/lldp_hw_private_verify_result.json`。全程 GET/subtree 只读。

实测结果（对 HUAWEI-LLDP-MIB `.2011.5.25.134` 全区 walk，136 行）：

| 区域 | 内容 | 邻居价值 |
|---|---|---|
| `.134.1.1.0=1` | hwLldpEnable（全局使能） | 状态 |
| `.134.1.2.0=10.25.0.1` | 本机管理 IP | 身份 |
| `.134.1.5.1.11`（110 行） | hwLldpPortConfigIfIndex：portNum→ifIndex **映射表** | ★可解决 LLDP portNum↔ifIndex（§4.3-1） |
| `.134.1.13.0` | 16 字节全零（MDN 相关） | 无 |
| `.134.1.2.3.1.1`（21 行） | hwLldpRemNetworkId：**全部为空串**（CloudEngine 未填 NetworkId） | 无 |

关键结论：

1. **私有 HUAWEI-LLDP-MIB（2006 版）根本不定义邻居明细列**——全文档（华为 S 系列 MIB 参考 + ipnetwork-monitor 完整对象表）只有 RemProtoType 与 RemNetworkId 两张表，**没有 hwLldpRemChassisId/PortId/SysName**。实测与之吻合：`.134.1.2` 仅 21 行空 NetworkId。
2. 华为 CE（CloudEngine）标准 LLDP-MIB `1.0.8802.1.1.2.*` 全部 noSuchObject（上轮已证 3 台抽查）；华为官方 CloudEngine MIB 参考"查询 LLDP 远端设备信息"章节也**只列 stats 计数器、不含 rem 明细**——与实测一致：CE 平台 SNMP 侧只暴露统计，不暴露邻居表。
3. 因此 v1.1 方案 A（私有 MIB 补明细）**不成立**；方案 B（SSH `display lldp neighbor`）超出"仅 SNMP 只读"边界未获批。
4. **裁决：按方案 C 执行**——华为设备呈现"LLDP 数据源不支持（SNMP 无邻居表）"徽标，不画线、不猜线；其邻居若为 H3C，仍可经 H3C 侧单边证据得 half。附带收益：`.134.1.5.1.11` 映射表可在未来 IDC 互联需求升级时复用。
5. 若后续需要华为↔华为 IDC 互联真相，可选路径（均需另行批准）：B（SSH 只读命令）、或对 CE 升级支持标准 LLDP-MIB 的 VRP/YunShan 版本、或经 NCE/iMaster 北向 API。本节不做任何预设实施。

### 2.5 保留的采集工程细节

临时 walk 项（`type=20`、`delay=0`、value_type=4）、`history.get history=4`、用后即删、key 前缀 `lldp.discovery.<runId>`——机制不变；新增 §7 租约与对账。

---

## 3. 修订后数据库模型（输出③）

SQLite 增量 `ALTER TABLE`/新表，无破坏性变更；三道 UNIQUE（`zbx_hostid`、`node_id+fingerprint`、`norm_key`）保留（重复同步幂等已实测）。

```sql
-- topology_node 增列
sys_name TEXT, model TEXT, sys_descr TEXT, sys_objectid TEXT,   -- 身份（Zabbix system.* 只读采集）
device_type TEXT DEFAULT 'unknown',      -- switch/router/firewall/ap/… 由 sysObjectID+sysDescr 判定；判不了=unknown
network_role TEXT DEFAULT 'unknown',     -- core/distribution/access/… 仅人工标注/别名表；绝不自动认定
network_role_source TEXT,                -- manual | model_hint(仅提示) —— model_hint 不改变渲染认定
zone TEXT,                               -- 主机组映射：数据中心网络设备/办公网；多主机组见 §4.3-8
mgmt_ips TEXT,                           -- JSON 数组，支持同设备多管理 IP（§4.3-6）；zbx_hostid 是监控对象唯一键（非设备身份，见 §3.2）
monitoring_status TEXT,                  -- active|degraded|disabled|stale（监控维度，与运行/审核维度分离）
chassis_id TEXT,                         -- 真实设备硬件身份（LLDP lldpLocChassisId 本机 walk；v1 已有列，v1.1 升级为一等公民）
identity_state TEXT DEFAULT 'monitor_only'
                                         -- confirmed(本机 walk 取得 chassis_id) | candidate(仅对端邻居报文反推) | monitor_only(仅 Zabbix 行)

-- topology_interface 增列
port_type TEXT DEFAULT 'physical',       -- physical | logical(vlanif/loopback/bag|eth-trunk) | stack-port
agg_member_of INTEGER,                   -- 聚合口接口 id（成员→聚合口外键；§4.3-3）
lldp_port_num INTEGER,                   -- lldpLocPortNum/lldpRemLocalPortNum 与 ifIndex 的映射缓存（可能不同！§4.3-1）

-- topology_link：状态三维分离（详见 §5.1），增列
evidence_status TEXT,                    -- half | pair | stale | expired（A 轴）
review_status TEXT,                      -- unreviewed | manual_confirmed | rejected | manual_created（B 轴；自动 pair 不写 B）
operational_status TEXT,                 -- up | down | unknown（两端接口 oper 派生；无接口数据=unknown）
evidence_record_id INTEGER,              -- → topology_discovery_record（可追溯原始快照）
is_aggregate INTEGER DEFAULT 0,          -- 聚合链路（成员证据聚合；§4.3-3）
parallel_seq INTEGER                     -- 同设备对多条并行物理链路各自独立成行（§4.3-4）

-- 新表
topology_alias(alias_key TEXT PRIMARY KEY, node_id INTEGER, created_by TEXT, created_at INTEGER)
  -- 邻居名/chassis → 节点 的人工别名（未纳管对端 → alias 指向 external 占位或人工挂接）
topology_node_layout(node_id INTEGER PRIMARY KEY, zone TEXT, x REAL, y REAL, layer INTEGER, saved_at INTEGER)
topology_zone_collapse(zone TEXT PRIMARY KEY, collapsed INTEGER)
topology_audit(id INTEGER PRIMARY KEY, actor TEXT, action TEXT, entity TEXT, entity_id TEXT, detail TEXT, at INTEGER)
  -- 人工确认/驳回/补录/角色标注/别名增删全部入审计（§7.9）
topology_run(                                    -- 任务与租约（§7.1-2）
  run_id TEXT PRIMARY KEY, kind TEXT, state TEXT,  -- running|completed|failed|aborted
  owner TEXT, heartbeat_at INTEGER, created_at INTEGER, finished_at INTEGER)
```

**明确不建**：CMDB 属性面（序列号、保修、资产…）；推断类虚拟列。

### 3.1 设备身份模型：监控对象与真实设备分离（评审·二）

**Zabbix hostid ≠ 设备**。`zbx_hostid` 只是"Zabbix 监控对象"的 ID——它可能因主机组迁移、模板变更、重新发现而变化，也可能一台设备对应多个主机行（多管理 IP 重复录入）或一个主机行代表一台堆叠逻辑机。真实设备身份以 **chassis_id（LLDP Chassis ID，通常为桥 MAC）** 为锚。三层身份：

| 层 | 键 | 性质 | 稳定性 |
|---|---|---|---|
| 监控对象 | `zbx_hostid` | Zabbix 数据库行 | 最弱（可增删重建） |
| 名称身份 | `display_name`/sysName | 人读名称，可改名 | 中 |
| 硬件身份 | `chassis_id`（+ sysObjectID 前缀厂商域） | 设备 LLDP 报文自报 | 强 |

**identity_state 规则（证据制，不猜）**：
- `confirmed`：对**本机** walk `lldpLocChassisId(.3.2.0)` 成功取得 → 该监控对象与 chassis_id 的绑定是设备自报，可信；
- `candidate`：chassis_id 仅来自**对端邻居报文**中出现的值（未见本机 walk 印证）——可参与匹配，UI 标注"待本机印证"；
- `monitor_only`：无 chassis_id（如华为 SNMP 无 loc 表），仅监控对象。

**冲突处理（不自动合并）**：若两个 node 的 chassis_id 相同（疑似同设备多主机行 / 堆叠拆分），**不自动合并**——写入 `topology_audit`（action=`identity_conflict`）+ 待确认队列，由人工裁决合并（合并仅置 `merged_into` 软标记，历史 link 通过 alias 保留可追溯）。同理 chassis_id 不同但 sysName 相同（改名/重名）也只报冲突。链路端点一律引用 `node_id`（内部代理键），身份演进不影响链路行。

### 3.2 现网事实对照（v1 审查已证，全部只读）
主机组「数据中心网络设备」28 /「办公网」109 = zone 直接来源；`system.name`（=匹配键）、`system.hw.model`、`system.location`、`system.descr`、`system.objectid`（.2011=Huawei/.25506=H3C）均已在 Zabbix。

---

## 4. 链路发现与状态机设计（输出④）

### 4.1 三维状态轴（评审·二）

| 轴 | 语义 | 取值 | 更新者 |
|---|---|---|---|
| **A 发现证据状态** | LLDP 自动发现的观测事实 | `half`(单端见) / `pair`(双端见) / `stale`(超 3 轮未见) / `expired`(证据过期清理) | 发现任务 |
| **B 人工审核状态** | 人对"这条连接是否成立"的判断。**自动双向发现（A=pair）不写入 B 轴**——双端证据只是机器观测，不等同于人工审核 | `unreviewed`(默认，无人审过) / `manual_confirmed` / `rejected` / `manual_created`(无 LLDP 的人工补录) | 人工（入审计） |
| **C 实际运行状态** | 链路当前通不通（运行维度） | `up` / `down` / `unknown` | 接口 oper 派生 + （S5）Zabbix problem |

**关键规则（按评审原文落实）**：
- **人工确认（B=manual_confirmed）的链路在 LLDP 证据过期后仍然保留**：A 轴变 `expired` 不清除该行，B 轴保持 manual_confirmed，图上以"人工确认（证据已过期）"线型呈现；
- **LLDP 邻居消失 ≠ 物理链路故障**：A 轴 stale/expired 绝不映射为 C 轴 down；C 轴只由接口 oper/告警驱动；
- **A=pair 不产生任何 B 轴状态**：双端一致的 LLDP 证据默认渲染为"自动证据线（未审核）"样式（与人工确认线型明确区分），需要人审时才进入 B 轴流转；A=`half` 且 B=`unreviewed` 的行默认不渲染（开关可开），**任何组合都不产生"推断"连线**。

### 4.2 状态机

```
（发现）──新证据──▶ half ──对端也见──▶ pair          （A 轴内部，B 轴始终 unreviewed）
   │                 │ 3 轮未见            │ 3 轮未见
   ▼                 ▼                     ▼
 （无连接）        stale ──再现──▶ half/pair   stale ──> expired
                                     │ B=manual_confirmed/rejected 时：行永不删除、不再自动流转
（人工审核入口）
  A=half/pair 的机器证据 ──人审──▶ B=manual_confirmed（"我确认这条连接存在"）
                        └─人审──▶ B=rejected（"证据有误/已拆除"，保留行与审计）
（人工补录）──▶ B=manual_created：A 轴=None，等待 LLDP 交叉验证；若后续 LLDP 出现
              half/pair → 仅提示"证据吻合"，不改变 B（人已确认）；若 LLDP 矛盾
              → 标记 conflict + 入待审队列（人工裁决，不自动改线）
```

匹配顺序（证据匹配，非推断）：chassis_id MAC 归一化精确 → sysName 精确（经 alias 表映射）→ 失败进待确认队列（保留 v1 已实现行为）。对端不在 Zabbix → 建 `external` 占位节点（明确灰显"未纳管"），**不猜测其 IP/型号**。

### 4.3 八类边界场景处理（评审·三）

| # | 场景 | 处理 |
|---|---|---|
| 1 | **ifIndex 变化** | 接口唯一键 = fingerprint(sha1(node\|label\|descr))（已实现）；LLDP 的 LocalPortNum ≠ ifIndex，新增 `lldp_port_num` 映射缓存，映射断裂时该轮证据按 PortId/PortDesc 文本再匹配一次，仍失败 → 记 `port_mapping_gap` 审计，不硬连 |
| 2 | **交换机堆叠** | 堆叠后一台 Zabbix 主机 = 逻辑一机；成员槽位接口（`GigabitEthernet1/0/0/x` 格式）照常挂本节点；`device_type=switch` 不变，`health_flags` 记 `stack`（sysDescr 含 IRF 时标注）；不为成员槽建独立节点（无独立监控对象） |
| 3 | **Eth-Trunk / Bridge-Aggregation** | 聚合口为逻辑接口（`port_type=logical`），成员物理口 `agg_member_of` 指向它；LLDP 证据出现在成员口 → 物理链路各自成行 + `is_aggregate=1` 关联聚合口；图上聚合口折叠为一条粗线（可展开成员），**展开前不合并**（评审禁止按名称相似合并） |
| 4 | **多条并行物理链路** | norm_key 含端口对：同设备对多条链路各自独立行（`parallel_seq` 区分），图上平行线（PoC 渲染要求，§6） |
| 5 | **逻辑接口 vs 物理接口** | `port_type` 显式区分；LLDP 一般只在物理口出现；Vlanif/Loopback 不参与链路发现；vlan 接口统计仅用于详情 |
| 6 | **同一设备多个管理 IP** | 设备唯一键=zbx_hostid；`mgmt_ips` JSON 数组；hostinterface 多行合并去重，绝不因 IP 不同建两个节点（本轮实测部分主机多接口行） |
| 7 | **未纳入 Zabbix 的对端设备** | `external` 占位节点（sysName/chassis_id 已知部分如实展示）+ 待确认队列提示"可转正式节点"；不猜管理 IP、不猜型号 |
| 8 | **Zabbix 多主机组 → 区域映射** | 主机属于多组时 zone 取网络区域语义组优先（规则表可配）；冲突记录进 `health_flags`；实测当前两组互斥，规则仅为防御 |

**禁止项（代码级验收）**：不得按 IP 网段相近、名称相似、同机柜位推断连接；`system.location` 只作展示，不参与连线。

---

## 5. 零链路/低证据场景设计（评审·五）

当前库 links=0 是**真实状态**（OID 修复后预期显著改善，但设计必须对 0 链路成立）：

1. **已确认拓扑视图**：只画 A/B 组合达标的线（当前=无连线，诚实呈现）；
2. **未关联设备列表**：侧栏完整 137 台列表，可按 zone/搜索过滤；
3. **按区域分类**：zone 分组（主机组）视图，无连线时设备按 zone 分列排布（ELK 无 compound 也可分列）；
4. **设备搜索定位**：名称/IP/model 搜索 → 高亮居中；
5. **链路发现状态说明**：页面显式横幅："本轮发现：H3C 采集失败（OID 无效）已定位，待修复上线"、"华为设备 LLDP-MIB 未实现（专项待评审）"、"N 台 SNMP 不可达"——把"为什么没有线"说清楚，而不是用假线填满图；
6. **人工确认链路入口**：两端设备/接口选择器 + 备注 + 审计（v1 API 已有，补 UI）。

---

## 6. 前端渲染选型 PoC 比较（输出⑤，评审·四）

**不预先定案。** S4 前先做 PoC：同一份 137 节点/模拟 300 边（仅 PoC 演示用合成数据，不进生产库）数据集，三方案各实现同一验收屏（分层布局、区域折叠、并行链路、缩放平移、标签、搜索定位）：

| 维度 | A. ELK.js + ECharts（预计算坐标，layout:'none'） | B. ELK.js + 成熟图形库（antv X6，备选 JointJS） | C. ELK.js + 自绘 SVG |
|---|---|---|---|
| 开发复杂度 | 低（ECharts 现成） | 低-中（X6 现成交互/端口/分组） | 高（zoom/pan/命中/折叠全手写） |
| 维护成本 | 中（ECharts graph API 与自算坐标的胶水） | 低-中（库升级跟随） | 高（全部自维护） |
| 缩放/平移交互 | 内置 roam，但边标签随缩放策略受限 | 内置（X6 强项） | 手写，可完全可控 |
| 边标签（端口名） | graph 边标签能力弱，需 rich text hack | 原生 edge label | 原生可控 |
| 并行链路 | 需手工错开曲线（ECharts 无原生多平行边） | X6 原生 parallel edges | 手写（可行） |
| 区域折叠 | compound 需 ECharts tree 混用或手工聚合节点 | X6 原生 group/collapse | 手写 |
| 性能（~150 节点/300 边） | Canvas，好 | Canvas，好 | SVG 够用（<1k 元素） |
| 包体 | +elkjs（已有 ECharts） | +X6(~200KB) | +elkjs |
| 与现有代码距离 | 最近（复用 ECharts 页骨架） | 新页重写 | 新页重写+最多手写 |

**决策规则（写死，防返工）**：PoC 屏通过后——若 A 的边标签/并行链路两屏均可接受 → 选 A（成本最低）；任一屏明显劣 → 选 B；仅当 B 与需求冲突（如需深度定制渲染语义）才选 C。**PoC 报告随 S4 交付，选型由数据说话。**

---

## 7. 可靠性设计（评审·六）

| # | 项 | 设计 |
|---|---|---|
| 1 | run_id | 每次发现/同步建 `topology_run` 行，UUID；全部 discovery_record/托管项 key/日志携带 run_id |
| 2 | 任务租约与并发 | `owner+heartbeat_at`，心跳 30s；租约超时(120s)可被接管；同一时刻 sync/discovery 各只允许一个活跃 run（`state=running` 查询即拒） |
| 3 | 启动对账 | 服务启动时扫 `item.get search key_=lldp.discovery.` → 无活跃 run 对应的托管项一律回收（已实测发生过 20 个泄漏，cleanup 端点已有，改为自动） |
| 4 | 采集超时 | Zabbix 临时项等待窗口上限 80s + 单节点 history 读取超时；超时节点记 `snmp_unreachable` 不阻塞全轮 |
| 5 | 孤儿项回收 | 每轮结束删本 run 全部临时项；删除前校验 key 前缀+runId 双条件（删除范围校验，绝不误删非本服务项） |
| 6 | API 限流 | 对 Zabbix item.get/history.get 并发≤5、QPS≤20（现 batchSize=20 基础上加令牌）；轮内节点串行小批 |
| 7 | 失败重试 | 节点级重试 1 次（不同轮自然重试）；run 级失败保留 run 行，`failed` 状态可查询 |
| 8 | 数据库迁移与回滚 | 全部 `ADD COLUMN`/新表；迁移脚本带 `up()`/`down()`；迁移前自动备份 `topology.db.bak-<ts>`；上线顺序：迁移 → 兼容读（旧列保留一个版本周期）→ 切换 |
| 9 | 人工操作审计 | confirm/reject/manual-link/role/alias 全部写 `topology_audit`（actor 必填，API 层强制）；UI 链路详情展示审计链 |

---

## 8. 可执行验收测试清单（输出⑦）

每行 = 可执行动作 + 期望结果（S6 逐条勾验）：

| # | 测试 | 期望 |
|---|---|---|
| V1 | 对 SFPC-9021LAN001-HJ-S5590 用修复后 OID 跑单节点发现 | rem≥30 行解析入库，neighbors_found≥29，raw_snapshot 含 `.4.1.1.*` |
| V2 | 对 IDC-R01-36U-SW1 跑发现 | 状态=`mib_unsupported`（华为路由私有 MIB 或过渡态），**绝不记"无邻居"** |
| V3 | 对不可达设备（10.14.0.134） | 状态=`snmp_unreachable`，不产生任何邻居语义 |
| V4 | 同一 run 重复执行两次 | links/nodes/interfaces 行数不变（norm_key/fingerprint/zbx_hostid 三道 UNIQUE） |
| V5 | 双端都见同一邻居 → 查询该链路 | A=pair；**B 仍=unreviewed**（自动发现≠人工审核）；默认以"自动证据线（未审核）"样式渲染，与人工确认线型可区分 |
| V6 | 仅单端见（如 IDC 华为↔H3C 边界，H3C 侧单边证据） | A=half, B=unreviewed；默认视图不渲染，开"显示单端证据"开关后以虚线+half 徽标呈现 |
| V7 | 人工确认一条链路后，连续 3+ 轮 LLDP 未见该邻居（证据 expired） | 链路行**不删除**；B=manual_confirmed 保持；图上呈现"人工确认（证据已过期）"专属线型 |
| V8 | LLDP 邻居消失（A→stale/expired） | C 轴 operational_status **不变**（绝不映射为 down）；UI 文案"邻居证据消失，不等于链路故障" |
| V9 | 人工补录(manual_created)与后续 LLDP 证据矛盾 | 标记 conflict、进待审队列、写审计；**不自动改线、不自动删线**，人工裁决 |
| V10 | 实测并行链路对端（`fenxiaofangkongzhishi` 出现于 S5590 端口 182 与 22） | 两条独立 link 行（parallel_seq 1/2），图上平行双线，各带各自端口标签 |
| V11 | 邻居 sysName 不在 Zabbix 纳管范围 | 生成 external 占位节点（仅展示 LLDP 报文中真实出现的 sysName/chassis），待确认队列提示；**无猜测 IP/型号字段** |
| V12 | 依次执行 confirm / reject / manual-link / role 标注 / alias 增删 | 每操作 `topology_audit` 恰好 +1 行，actor 非空；UI 链路详情能看到审计链 |
| V13 | 发现 run 中途 kill 进程 → 重启 topology-svc | 启动对账回收全部 `lldp.discovery.*` 孤儿托管项；Zabbix `item.get` 过滤该前缀 = 0 残留 |
| V14 | run 进行中再次触发发现/同步 | 第二请求被拒（409 + 提示活跃 run_id）；租约超时(120s)后可接管 |
| V15 | 执行迁移脚本 up() → down() → up() | 三次均成功；执行前自动生成 `topology.db.bak-<ts>`；down() 后数据行数与迁移前一致 |
| V16 | 在 links=0 状态下打开拓扑页 | 137 节点按 zone 分列可读；未关联列表完整；搜索定位可用；发现状态横幅说明"为什么没有线"；无任何假线 |
| V17 | S4 PoC：同一数据集三方案各实现 6 项验收屏（分层布局/区域折叠/并行链路/缩放平移/边标签/搜索定位） | 三屏截图+七维评分表写入 PoC 报告，随 S4 交付；按 §6 决策规则定案 |
| V18 | 代码级检查：全仓 grep 连线相关逻辑 | 不存在按 IP 网段/名称相似度/location 生成 link 的代码路径；单测断言"输入两个同网段无 LLDP 证据的设备 → 产出 0 条 link" |

---

## 9. 调整后实施计划（输出⑥，评审·七）

顺序按评审要求重排：**LLDP 原始数据验证 → 修数据模型与发现机制 → 前端 PoC → 完整界面**。

| 里程碑 | 内容 | 出口判据 | 预估 |
|---|---|---|---|
| **M0 LLDP 原始数据验证** | ✅ **本轮已完成**：5 轮只读直接探测 + 权威 MIB 对照 + DB 复核；确证 OID 根因、华为 MIB 未实现、H3C 全部使能 | 证据 JSON×5 + 本文档 §2 | — |
| **M1 修采集（先于一切界面）** | `config.js` walk OID 修正；`lldpParser.js` rem 正则修正（`.4.1.1.<col>.<tm>.<pn>.<ri>`）；vendor 路由（huawei→§2.4 获批方案）；四态证据分级落库；单节点验证回路：先 S5590 一台 → 12 台抽样 → 109 台 H3C 全量 | V1~V4 | 2–3 天 |
| **M2 数据模型 + 三维状态机** | §3 迁移脚本（up/down+备份）；三维状态列与状态机（§4.1/4.2）；八场景（§4.3）；alias/audit/run 表；租约/对账/限流（§7） | V5~V9、V12~V15 | 3–4 天 |
| **M3 前端 PoC（可与 M2 并行）** | 三方案各 6 屏 + PoC 报告 + 按 §6 规则定案 | V17 + 选型评审通过 | 2–3 天 |
| **M4 完整界面** | 按 PoC 定案实现：已确认视图、zone 布局、未关联列表、搜索、人工确认入口、发现状态横幅、华为过渡态/`half` 呈现、审计链展示 | V6、V10、V11、V16 | 5–7 天 |
| **M5 全量验证与上线** | 137 台全量发现轮；全部 V 项勾验；性能与回滚演练；文档定稿 v2 | 全部 V 项通过 + 评审 | 2–3 天 |

依赖关系：M2 与 M3 可并行；M4 依赖 M2+M3 完成；M5 依赖全部。**每个里程碑出口需用户确认后再进入下一里程碑**（评审制开发）。

---

## 10. 仍需人工确认的问题（输出⑧）

以下各项**本轮不做任何预设实施**，待评审裁决：

1. **华为专项深度（§2.4）**：方案 A（HUAWEI-LLDP-MIB 私有列结构实测——需批准"对 1 台 CE6881H 做只读 SNMP 私有 MIB walk 专项"）还是先按方案 C（过渡态呈现，不画线）？方案 B（SSH 只读命令）超出"仅 SNMP 只读"边界，默认不做。
2. **half（单端证据）链路的默认显示策略**：建议默认隐藏 + 开关（V6）；但网络管理视角单端证据通常意味着本端物理连接真实存在（对端可能只是 MIB 不支持）——IDC↔H3C 边界将存在大量 half，是否默认虚线展示请裁决。
3. **zone 是否需要细分**：默认沿用 Zabbix 两主机组（数据中心/办公网）；`system.location` 有数据但需人工映射表才能作三级区域，是否要做？
4. **IDC 内部互联（华为↔华为）过渡期呈现**：完全留空 vs 节点徽标"LLDP 数据源不支持（MIB 未实现）"——建议后者（§2.4-C），请确认。
5. **两台 SNMP 不可达 H3C（10.14.0.134、10.14.0.130）**：是否列入给网络组的核查清单（与此前 12 台核查清单一并）？（本轮仅只读探测确认超时，未做任何设备侧操作。）
6. **network_role 初始赋值来源**：默认仅 UI 人工标注 + alias 表，不自动认定；如网络组有台账可提供初始角色清单，可一次性导入（入审计）。
7. **operational_status（C 轴）数据源**：当前拓扑库无接口 oper 数据。先全 `unknown`，还是 M4 期即接 Zabbix `ifOperStatus` 只读查询（增加查询量）？默认：先 unknown，S5 期再接。

---

## 11. M1 单台受控验证结果（2026-10-25，获批范围：仅 1 台 H3C）

完整报告：`.workbuddy/tmp/M1-REPORT.md`。对象：node 54 = SFPC-9021LAN001-HJ-S5590（zbx_hostid=10785，10.14.0.203）。两 run：`ea426abb`（new=30）与 `dfe501f8`（new=0/updated=30，去重幂等确认）。

**核心数据**：修复 OID 后单台 walk 返回 471 行 / 31,716 B（rem `.4.1.1` 306 行 vs v1 错误 OID 0 行）；解析 **34 邻居** → 自环守卫吸收 4 行（IRF 回指）→ **30 条链路**：

- **11 条 `L:` 全链路**——双端接口均在纳管节点接口清单精确解析（conf=1.0，含 Gi1/0/49、Gi1/0/26、Gi1/0/9 等非标准口形态）；
- **19 条 `H:` snapshot-only**——逐条核验 17 个对端身份全部 name-miss + chassis-miss，即**对端未纳管 Zabbix**（非匹配算法缺陷），保留完整 b_snapshot 供 M2 external/alias 挂接；
- **并行链路独立成行**：`fenxiaofangkongzhishi`（Gi1/0/22+Gi2/0/22）与 `SFPC-9021LAN001-HXSW`（Te1/0/50+Te2/0/50）各自两行未合并；
- **chassis_id 回填 12 节点**（本机 54=`bc:5a:34:1b:b2:00` 属自报 confirmed；其余 11 节点经对端报文反推属 candidate，待本机 walk 印证）——印证 §3.1 身份模型。

**异常**：①45 台 walk_empty 仍混淆 mib_unsupported（28 台 IDC 华为）/snmp_unreachable，四态落库属 M1 剩余；②19 条未匹配全因对端未纳管（含疑似核心堆叠机 SFPC-9021LAN001-HXSW 未纳管，建议核查）；③link.status 仍为旧 half/confirmed——pair 升级需对端同跑发现，三维状态迁移属 M2（禁做范围）；④community 命名不统一（办公网 `zabbix` / IDC `HertzBeat`）；⑤`discovery/run` 的 `node_ids` 实为 zbx_hostid 字符串数组（API 语义需修正）。

V1 验收：✓（rem≥30 行、neighbors≥29、raw_snapshot 含 `.4.1.1.*`）；V4 验收：✓（第二轮 new=0，行数不变）。V2/V3（华为/不可达状态单列）待四态落库后验证。**等待评审确认后进入 M1 剩余（12 台抽样）→ 再申请 109 台全量。**

---

## 12. M2 数据基础：153 台全量只读发现 + 前端全网总览（2026-10-25，用户放行）

M1 出口详见 `docs/UOCP-M1-EXIT-REPORT-2026-10-25.md`。本节记录用户放行全量后的数据与界面实况。

**发现轮 `bd223d4c`（153 节点全量，全程 SNMP 只读）**：

- 节点四态：`ok=107` / `mib_unsupported=44`（**全部 huawei**：IDC 接入 + IDC-R10-5U-CORE-SW1、IDC-R20-5U-CORE-SW2 + 14 台 FW6625/6585 防火墙，按 §2.4 方案 C 不画线）/ `walk_empty=2`（=2 台 degraded：10.14.0.80、10.14.0.207，现场核查项）。V2 全量复验 ✓。
- 链路 **507**（旧基线 79 → 507；全部 source=lldp_zbx）：`confirmed 82`（双端观察一致）/ `half 425`（单端，多为华为侧 MIB 不可读所致 IDC↔H3C 边界）。link.source 无任何按网段/相似度生成路径（V18 ✓）。
- 有链路 107 / 无链路 46 / 未纳管对端去重 **369**（含终端 PC/打印机；疑似核心 JK_Industrial_Core、SFPC-9021LAN001-HXSW 置顶建议纳管——纳管后下轮自动 half→confirmed）。
- 人工处理清单交付：`docs/UOCP-人工处理清单-2026-10-25.md`（A mib_unsupported 44 / B walk_empty 2 / C 其它异常 0 / D degraded 2 / E 未纳管对端 369 / F 无链路 46 + 处理优先级建议；开 LLDP 属交换机配置变更，只能网络组操作）。

**前端"全网总览"（focus=0 默认，整合页 `web/src/pages/TopologyPage.tsx` + `TopoCanvas.tsx`）**：

- full 模式 computeSubgraph：全部纳管节点入图；ELK layered 追加 `wrapping.strategy=MULTILAYER + additionalLayerSpacing=80 + surroundConnections`（无连线节点自动换行）。
- **EXT 开关**：369 个未纳管对端进总览会撑到 49141×2162px 不可用 → 总览默认只画纳管↔纳管（153 节点/114 边/9088×1416px），工具栏"总览含未纳管对端"复选可叠加；聚焦模式始终显示 EXT。
- **无链路 46 台不进 ELK**：图下方网格陈列，标题明示"尚无已发现的真实链路 · 不连线、不伪造"。
- **LOD 三级降级**：k<0.55 隐藏小字标签；k<0.3 只留提亮卡片（#232329/#52525B/2.5px）+ 加粗连线，远看呈"卡片星座"结构；放大恢复文字。点卡片进一跳/两跳聚焦。
- Node 预演（`.workbuddy/tmp/fullview_elk_test.mjs`）：含 EXT 522 节点 1565ms、不含 153 节点 526ms，badEdges=0。

**仍未做（待 M2 单独评审）**：DB 结构迁移（三维状态 A/B/C、alias/external、audit/租约）、network_role 人工核定（全部"未分类"）。当前 confirmed/half 仍为旧两态模型（过渡态）。

---

## 附：变更范围声明（v1.2 + M1 轮 + M2 数据基础轮）

- **文档**：本文档 v1 → v1.1 → v1.2（四项评审修订）→ §11（M1 结果）。
- **已修改生产代码（M1 获批范围内，仅采集正确性修复）**：`topology/src/config.js`（lldpWalk 五个错误 OID 修正）、`topology/src/lldpParser.js`（rem 索引正则/标量实例/loc 列号修正）、`topology/src/discovery.js`（自环守卫）。离线单测 `.workbuddy/tmp/test_parser_m1.mjs` 11 项断言全过。
- **数据**：仅 discovery_run/discovery_record/link 运行时数据经服务正常写入（单台 30 条链路，属获批验证产物）；**未做任何 DB 结构迁移**。
- **未修改**：Zabbix 监控配置（临时托管项用后即删，已对账无残留）、任何网络设备配置（全程 SNMP GET/walk 只读）。
- **只读探测证据**：`lldp_direct_result.json`、`lldp_probe_supplement_result.json`、`lldp_hw_cols_result.json`、`lldp_probe_round3~5_result.json`、`lldp_hw_private_verify_result.json`（华为私有 MIB 专项）；脚本同目录，全部 GET/subtree 只读，未使用 SET。
- **M2 数据基础轮（§12，用户放行）**：仅运行时数据经服务正常写入（全量发现 153 台/507 链路）；**仍未做任何 DB 结构迁移、未改任何设备配置**。前端整合（TopologyPage/TopoCanvas 重写）属获批的前端重设计范围。
- **下一步**：M1 出口报告已提交（`docs/UOCP-M1-EXIT-REPORT-2026-10-25.md`）；M2 正式范围（结构迁移/三维状态机/审计租约）**等待单独评审**；人工处理事项见 `docs/UOCP-人工处理清单-2026-10-25.md`。
# UOCP 专项排查报告：华为 CE6881H 的 LLDP SNMP 采集问题

- 日期：2026-10-25（任务 #20）
- 排查方式：**全程只读**（SNMP GET / GETNEXT / WALK + 华为官方文档检索），未修改任何交换机配置、未修改任何 UOCP 代码
- 探测目标（经 Zabbix hostinterface 取 IP 与 community）：
  - `IDC-R01-36U-SW1` / 10.25.0.1（community=HertzBeat）— **CE6881H-48S6CQ**，sysDescr = `YunShan OS, Version 1.24.0.1 (CE6881H V300R024C00SPC500)`，sysObjectID = `1.3.6.1.4.1.2011.2.239.95`
  - `IDC-R10-5U-CORE-SW1` / 10.25.0.253（community=HertzBeat）— **CE16804**，sysDescr = `YunShan OS, Version 1.24.0.1 (CE16800 V300R024C00SPC500)`，sysObjectID = `1.3.6.1.4.1.2011.2.239.58`
- 探测脚本与原始结果（可复跑）：
  - `.workbuddy/tmp/lldp_hw_ce_probe2.mjs` → `lldp_hw_ce_probe2_result.json`
  - `.workbuddy/tmp/lldp_hw_ce_probe3.mjs` → `lldp_hw_ce_probe3_result.json`
  - 早期复核：`.workbuddy/tmp/lldp_hw_private_verify.mjs` → `lldp_hw_private_verify_result.json`
- 原则声明：本报告所有私有 OID 的对象名称均**以华为官方 MIB 参考文档对名**，不根据 OID 编号或索引猜测字段含义；无法确证身份的子树如实标注。

---

## 一、五问逐答

### Q1：标准 LLDP-MIB 是否因 SNMP View 权限而不可访问？——是（根因判定：视图屏蔽，而非功能未实现）

**实测证据（两台一致）：**

| 验证命令（只读） | OID | MIB 对象 | 实测结果 |
|---|---|---|---|
| `snmpget -v2c -c HertzBeat 10.25.0.1 1.0.8802.1.1.2.1.3.1.0` | `.1.0.8802.1.1.2.1.3.1.0` | `lldpLocSysCapEnabled`（LLDP-MIB） | `noSuchObject` |
| `snmpget -v2c -c HertzBeat 10.25.0.1 1.0.8802.1.1.2.1.3.2.0` | `.1.0.8802.1.1.2.1.3.2.0` | `lldpLocSysDesc` | `noSuchObject` |
| `snmpget -v2c -c HertzBeat 10.25.0.1 1.0.8802.1.1.2.1.4.1.1.2` | `.1.0.8802.1.1.2.1.4.1.1.2` | `lldpRemChassisIdSubtype` 列 | `noSuchObject` |
| `snmpwalk -v2c -c HertzBeat 10.25.0.1 1.0.8802.1` | `.1.0.8802.1` | IEEE 802.1 全家（含 LLDP-MIB / lldpXdot1） | **0 行** |
| `snmpgetnext -v2c -c HertzBeat 10.25.0.1 1.0.8802.1` | 从 `.1`（std 分支）起步 | — | 回卷到 `.1.3.6.1.2.1.1.1.0`（sysDescr）→ **本视图内 std(1.0) 分支完全为空** |

三重印证：GET 返回 `noSuchObject`、GETNEXT 从 `1.0.8802.1` 直接跳入 `1.3.6.1` 树、整棵 `.1.0.8802.1` walk 0 行。同时同一 community 可读 bridge MIB（`dot1dStpPriority .1.3.6.1.2.1.17.2.1.0` = 1）、ifName（`.1.3.6.1.2.1.31.1.1.1.1` 可读）、私有 `.2011.5.25.134`（136/172 行）——说明 SNMP 服务与 ACL 均正常，唯独 `1.0.*`（标准 IEEE 分支）不可见。

**官方依据（华为 KB，EDOC1100408151《Why the LLDP Neighbor Information Cannot Be Obtained Through SNMP》）：** LLDP-MIB 根 `iso(1).std(0).iso8802(8802).ieee802dot1(1).ieee802dot1mibs(1).lldpMIB(2)` = **`1.0.8802.1.1.2` 不在缺省 MIB 视图（internet `1.3.6.1`）之下**；CloudEngine 多版本 MIB 参考对 LLDP-MIB / lldpXdot1MIB 均重复同一说明。华为对视图外 OID 返回 `noSuchObject`，错误类型本身无法区分"未实现 vs 视图屏蔽"，故以官方文档补证为**视图屏蔽**。

> 注：CLI 能看到 LLDP 邻居（用户已确认）与 SNMP 读不到并不矛盾——LLDP 功能本身开启（私有 MIB `hwLldpEnable .1.3.6.1.4.1.2011.5.25.134.1.1.1.0` = 1），只是 MIB 挂在了 SNMP 缺省视图之外。

### Q2：当前 community 实际绑定哪个读视图？——SNMP 侧无法自读，需网络组 CLI 只读确认

**实测证据：**

| 验证命令 | OID 子树 | MIB 模块 | 实测结果 |
|---|---|---|---|
| `snmpwalk -v2c -c HertzBeat 10.25.0.1 1.3.6.1.6.3.15` | `.1.3.6.1.6.3.15` | SNMP-COMMUNITY-MIB（community 与上下文绑定表） | **0 行（未实现）** |
| `snmpwalk -v2c -c HertzBeat 10.25.0.1 1.3.6.1.6.3.12` | `.1.3.6.1.6.3.12` | SNMP-VACM-MIB（视图表） | 仅 3 个标量（`vacmSecurityToModelMaxSubtrees` 等），**无 vacmAccessTable 实例** |

结论：无法通过 SNMP 自身读出 "community=HertzBeat → 读视图" 的绑定关系。旁证（bridge/ifName 可读、Q-BRIDGE `dot1qTpFdbPort` 0 行、`.1.0` 分支空）与该设备使用**只含 internet(1.3.6.1) 子树的缺省视图**一致（用户已确认 ViewDefault 含 internet）。

**请网络组在交换机 CLI 执行（均为只读 display 命令，不改配置）：**

```
display snmp-agent community
display snmp-agent mib-view
display snmp-agent sys-info version
```

即可确认 HertzBeat 绑定的 mib-view 名称及其包含的子树。

### Q3：CE6881H 对应软件版本是否支持标准 LLDP-MIB？——支持（是视图屏蔽，不是未实现）

- 实测版本：CE6881H **V300R024C00SPC500**（YunShan OS 1.24.0.1）；CORE 为 CE16800 同版本线。
- 华为 CloudEngine 数据中心交换机（含 CE6800 系列）MIB 参考文档中，LLDP-MIB（`lldpXdot1`/`lldpMIB`）标注为"**实现与 MIB 文件定义一致**"，即该版本实现并支持标准 LLDP-MIB，仅因 `1.0.8802.1.1.2` 不在缺省视图而不可达（与 KB EDOC1100408151 一致，KB 给出的解法就是加 iso 视图，而不是升级版本）。

### Q4：华为私有 LLDP-MIB（.134）中是否有能返回邻居 SysName / Chassis ID / LocalPort / RemotePort 的对象？——没有任何可读的邻居明细对象

私有根：`hwLldp .1.3.6.1.4.1.2011.5.25.134`。全区 walk 实测（R01=136 行 / CORE=172 行），列分布：

| 列 | 行数 | 对象名（官方对名） | 访问属性（官方） | 实测值 |
|---|---|---|---|---|
| `.134.1.1.1.0` | 1 | `hwLldpEnable` | read-only | 1（LLDP 已启用） |
| `.134.1.1.2.0` | 1 | `hwLldpLocManIPAddr` | read-only | 10.25.0.1 / 10.25.255.3 |
| `.134.1.1.3.0` | 1 | `hwLldpCounterReset` | read-only | 2 |
| `.134.1.1.4.0` | 1 | `hwLldpNotificationEnable` | read-only | 1 |
| `.134.1.1.13.0` | 1 | `hwLldpLocManIPv6Addr` | read-only | （存在） |
| `.134.1.1.5.1.11` | 110 / 146 | `hwLldpPortConfigIfIndex` | read-only | 本地端口 ifIndex（仅端口配置，无邻居内容） |
| `.134.1.1.5.1.12` | 55 / 73 | `hwLldpPortConfigCounterReset` | read-write | 全部 = 2 |
| `.134.1.2.3.1.1` | 21 | `hwLldpRemNetworkId`（`hwLldpRemNetworkIdTable`） | read-only | **21 个实例全部为空串** |

邻居明细相关表的官方读取约束（CloudEngine MIB 参考原文）：

- `hwLldpMdnRemTable .134.1.2.2`（含 `hwLldpMdnRemLocalPortId .1.2.2.1.3`、`hwLldpMdnRemMacAddr .1.2.2.1.8` 等）：本环境 walk **无任何实例**（GETNEXT 边界证据见下）。
- `hwLldpInterfaceRemTable .134.1.3`：官方明确"**该表不支持读取**"；实测 GETNEXT `.134.1.3.1.1.1` 越过该区。
- `hwLldpInterfaceNeighborChangeTable .134.1.5`——**真正的邻居明细就在这里，但全部是 accessible-for-notify，只能作为 trap 绑定变量，不能 GET/WALK**：
  - `hwLldpInterfaceNeiChassisType .134.1.5.1.1.4`
  - `hwLldpInterfaceNeiChassisId .134.1.5.1.1.5`（Chassis ID）
  - `hwLldpInterfaceNeiPortIdType .134.1.5.1.1.6` / `hwLldpInterfaceNeiPortId .134.1.5.1.1.7`（远端端口）
  - `hwLldpInterfaceNeiSysName .134.1.5.1.1.8`（**SysName**）
  - `hwLldpInterfaceNeiSysDescription .134.1.5.1.1.9`
  - `hwLldpInterfaceNeiMgtAddr .134.1.5.1.1.13`（远端管理地址）
  - 对应 notification：`hwLldpInterfaceNeighborChange = .1.3.6.1.4.1.2011.5.25.134.2.12`

GETNEXT 边界证据（probe2 `hw134_remBoundary`）：从 `.134.1.2.3.1.1` 末行、`.134.1.2.4`、`.134.1.3.1.1.1`、`.134.1.4.1.1.1` 各点起步，返回值全部跳到 `.1.3.6.1.4.1.2011.5.25.142.1.6.0`（license 文件名区）→ **本设备 `.134.1.2` 之后（.1.2.4+/1.3/1.4/1.5）没有任何可 GET 的实例**。

**结论：`.134` 私有 MIB 中不存在任何可通过 SNMP GET/WALK 返回邻居 SysName / Chassis ID / 本地端口 / 远端端口的对象。** 唯一的只读"远端"列 `hwLldpRemNetworkId` 21 实例全空串（该字段官方定义为远端网络标识，本环境未配置）。邻居明细对象虽存在但被限定为 trap-only。

### Q5：是否需要其它华为私有 MIB 子树？——不需要（也没有）：候选子树逐一排除，FDB 备选源也不可用

| 候选子树 | 验证命令 | 官方对名 | 判定 |
|---|---|---|---|
| `.1.3.6.1.4.1.2011.5.25.32` | `snmpwalk -v2c -c HertzBeat 10.25.0.1 1.3.6.1.4.1.2011.5.25.32`（400 行） | **HUAWEI-XQoS-MIB（hwQoS/CBQoS，QoS 配置）** | 与 LLDP 无关（早期"hwLldpOld"猜测已按官方文档纠正） |
| `.1.3.6.1.4.1.2011.5.25.41` | 同上（400 行） | **HUAWEI-IF-EXT-MIB（hwIFExtMib：接口扩展 hwIFExtTable、接口 IP 表 hwIfIpTable、Trunk 成员表 hwTrunkMemTable）** | 接口/IP/Trunk 信息，无邻居表 |
| `.1.3.6.1.4.1.2011.10.32` | walk | — | 0 行，不存在 |
| `.1.3.6.1.2.1.17.7.1.2.2`（Q-BRIDGE-MIB `dot1qTpFdbPort`，FDB 备选拓扑源） | walk | `dot1qTpFdbPort` | **0 行**（同样在视图外或未开放），MAC-FDB 反推链路的备选路也不通 |
| `.1.3.6.1.2.1.31.1.1.1.1`（ifName） | walk | `ifName` | 可读（NULL0/MEth0/0/0 等）——仅本地接口名，无邻居 |

结论：**不存在能补齐邻居信息的其它私有子树**；华为在该平台把邻居明细限定为 trap notification + 视图外的标准 LLDP-MIB 两条路，SNMP 轮询路线在现配置下无解。

---

## 二、可选补强路径的边界（供网络组决策参考，均属交换机配置/架构变更，本轮不实施）

1. **官方 KB 解法（配置变更，需网络组）**：`snmp-agent mib-view included iso-view iso` + `snmp-agent community read HertzBeat mib-view iso-view`（+ 必要时 `snmp-agent sys-info version all`）。生效后 UOCP **现有标准 walk OID 原样可用**（`topology/src/config.js` 的 `lldpWalk` 已含 `1.0.8802.1.1.2.1.2/.1.3.1/.1.3.2/.1.3.7.1/.1.4.1.1`），UOCP 侧届时仅需把 vendor 路由从"huawei→直接记 mib_unsupported"改为同样走标准 walk（一处小改，本轮禁改代码，仅作未来选项）。
2. **SNMP Trap 接收（架构新增）**：设备已 `hwLldpNotificationEnable=1`，理论上可搭 trap collector 收 `.134.2.12 hwLldpInterfaceNeighborChange` 的绑定变量（含 SysName/ChassisId/PortId/MgtAddr）。但只在**邻居变化时**上报、无存量全量、且需要新 collector 组件与 TRAP 目标配置——不满足"不修改交换机配置"约束，且事件流无法给出可核对的存量快照，不作推荐。

## 三、推荐实现方案（不修改交换机配置，唯一推荐）

**维持并固化现状语义（方案 C）：**

1. **vendor 路由保持 huawei → `mib_unsupported`**：44 台华为设备（含 2 台 CORE）在拓扑中以四态徽标明确标注"LLDP 经 SNMP 不可读（视图限制，非设备不支持）"，绝不猜测连线。
2. **华为↔H3C 边界依赖对端单边证据**：H3C 侧标准 LLDP walk 已产出 507 条链路（confirmed 82 / half 425）；凡华为端口出现在 H3C 邻居表中，即以 `half`（half-edge，source=lldp_zbx）呈现该边界——这是**真实对端证据**，不是伪造。全网 107 台有链路节点中华为的互联缺口由此部分覆盖。
3. **华为↔华为互联按红线留空**：两端都是华为且均不可读时，图中不连线，节点保持 `mib_unsupported` 态；核心间互联缺口已在人工处理清单 A 表向网络组列明。
4. **若网络组未来按 KB 配好 iso-view**：UOCP 只需一处 vendor 路由小改即可自动纳入华为标准 LLDP（属未来代码变更，届时单独走变更评审）。

### 能否完整支持华为设备自动拓扑发现？——**不能**

在"不修改交换机配置"的前提下，基于本次全部实测证据：标准 LLDP-MIB 视图屏蔽、私有 MIB 无邻居明细可读对象、FDB 备选 0 行、其它私有子树均无关——**SNMP 轮询路径无法读取华为设备的 LLDP 邻居，因此无法完整支持华为↔华为边界的自动拓扑发现**。可自动化的只有：华为节点存在性（Zabbix 纳管 + 标准 system/if MIB）、以及华为↔H3C 边界经 H3C 侧的 half 单边证据。华为↔华为的完整互联只能在网络组放开 iso-view 视图（或改用 trap/NETCONF 等其它通道）之后实现。

---

## 四、证据与引用索引

- 实测原始数据：`lldp_hw_ce_probe2_result.json`（stdGet/stdNext/lldpWalk/vacm/hw134 列分布/remBoundary/hwOther）、`lldp_hw_ce_probe3_result.json`（sysServices=78、25.32/25.41 各 400 行、dot1qTpFdbPort=0、ifName、`.134.1.1.5.1.12` 全=2）
- 华为官方文档（WebSearch 检索摘要核对）：
  - KB EDOC1100408151：《Why the LLDP Neighbor Information Cannot Be Obtained Through SNMP》——1.0.8802.1.1.2 不在缺省视图、三条解法命令
  - CloudEngine CE6800/CE16800 系列 MIB 参考：HUAWEI-LLDP-MIB（`.134` 各表读取约束、`.1.5` accessible-for-notify、notification `.134.2.12` 绑定变量清单、`hwLldpInterfaceRemTable` "不支持读取"）
  - EDOC1100276957 / EDOC1100561473（HUAWEI-IF-EXT-MIB）：`.2011.5.25.41 = hwIFExtMib`
  - XQoS/CBQoS MIB 文档：`.2011.5.25.32 = hwQoS`
- 复跑方式：`cd C:/Users/zxy/.workbuddy/binaries/node/workspace && NODE_PATH=./node_modules "…/node.exe" <脚本>`（脚本经 Zabbix API 取凭据后直连 SNMP，全程只读）

---

## 五、整改验证记录（同日追加，17:49）

网络组已按本报告 §二·1 在 **IDC-R01-34U-SW2（10.25.0.2，CE6881H）** 放开 iso MIB 视图，验证结果：

1. **标准 LLDP-MIB 完全可读**（Zabbix 服务器侧 `snmpwalk -v2c -c HertzBeat 10.25.0.2 1.0.8802.1.1.2.1.3 / .1.4.1.1`）：`lldpLocSysName="IDC-R01-34U-SW2"`、local ChassisID `90:f9:70:df:45:41`、rem 表含邻居 SysName/ChassisID/PortID/描述/管理地址——**证实 Q1 判定：视图屏蔽而非未实现**。
2. **UOCP 侧配套变更（已实施）**：`topology/src/discovery.js` 去掉 huawei→直接记 mib_unsupported 的 vendor 短路，华为与 H3C 一样走标准 walk；未放开视图的设备由既有兜底分支如实记 `mib_unsupported`（不伪造、不猜线语义不变）。
3. **单台受控发现通过**（run `538b487d`，仅 node8）：result=ok、**21 邻居全部入库**——
   - 上联 3 条 → IDC-R01-36U-SW1（100GE1/0/1、100GE1/0/2、10GE1/0/48，half）
   - 1 条 → IDC-R20-5U-CORE-SW2（CE16804，half）
   - 1 条 → IDC-R10-19U-MGMT-HJ-SW（经 MEth0/0/0 管理口，half）
   - 16 条 → Mellanox ConnectX-4 Lx 服务器网卡（未纳管 EXT，以 chassis-MAC 挂 half，进人工清单 F/E 类核对）
   - 与交换机 CLI `display lldp neighbor` 逐条一致；全网四态最新分布 ok 108 / mib_unsupported 43 / walk_empty 2（node8 从 mib_unsupported 转 ok）。
4. **待网络组批量放开后**：对其余 43 台华为（A 表）执行同样两条命令，然后重跑全量发现——华为↔华为互联将随双端证据自动从 half 升级 confirmed。

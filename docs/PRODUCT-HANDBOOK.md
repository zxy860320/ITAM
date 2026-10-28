# ITYW 运维监控平台 · 产品与工程手册（AI 交接文档）

> 本文档面向后续接手本项目的 AI / 工程师。目标：读完即可安全地继续开发，不踩已知坑。
> 最后更新：2026-10-23（首版全链路 + 多指标趋势完成）

---

## 1. 产品定位

一款面向 IT 运维团队的**统一监控看板**，数据源为 **Zabbix**（真实环境 `http://10.25.6.8:8080`，Zabbix 7.0.32）。核心卖点：

- 按资产域分类浏览：**服务器 / 数据库 / 网络设备 / 服务** 四域（当前真实环境命中 server:2、network:137）
- 设备深度详情：档案、接口、全监控项、**多指标历史趋势**（时间窗 6h/24h/7d/30d + 过去任意锚点回看）
- 告警流：Zabbix problem 实时挂到设备
- 监控源对接页：测试连接、切换 mock/zabbix、配置持久化

视觉体系：dark-monitoring-ops 设计系统（复刻 7 张 Ardot 高保真稿），token 集中在 `web/src/styles/tokens.css`。

## 2. 快速启动

```bash
# 后端 :8787
cd server && npm install && npm start
# 前端 :5273（vite 将 /api 代理到 8787）
cd web && npm install && npm run dev
```

首次运行：复制 `server/data/source.example.json` → `server/data/source.json`，填入真实 endpoint 与 API token。
**`source.json` 含凭据，已 gitignore，切勿提交。**

页面路由（hash，无 Router 库）：`#/dashboard` 大屏 · `#/server|database|network|service` 四域列表 · `#/source` 对接 · `#/system` 系统。

## 3. 架构总览

```
Zabbix Server (JSON-RPC)
   │ host.get / item.get / trigger.get / problem.get / history.get / trend.get
   ▼
Collector（server/src/collector/）
   ├─ zabbixClient.js  真实源：全量拉取→三级判定→指标/告警挂接→时序
   ├─ mockData.js      确定性种子数据集（无凭据开发/演示用）
   └─ aggregate.js     汇总统计（summary/dashboard）
   ▼ 内存态数据集，默认 60s 轮询刷新
Express API（server/src/server.js，:8787）
   ▼ /api/*（vite proxy）
React SPA（web/src/，:5273）
```

## 4. API 一览（server/src/server.js）

| 路由 | 说明 |
|---|---|
| `GET /api/summary` | 四域计数/健康分布（顶栏与卡片） |
| `GET /api/dashboard` | 大屏聚合 |
| `GET /api/entities?domain=&q=&page=&size=` | 分页实体列表（rows/total/page/size），字段含 hostid/name/ip/cpu/mem/disk/ping/pingMs/temp/problems/availability/model |
| `GET /api/entities/:id` | 单实体 |
| `GET /api/entities/:id/detail` | 深度详情：device profile（system.* 监控项）、网络接口表、全部监控项 |
| `GET /api/entities/:id/series?range=&till=&iface=` | **多指标时序**（见 §6） |
| `GET /api/events?domain=&size=` | 告警流 |
| `POST /api/events/:id/ack` | 告警确认（mock 生效；真实源未接 Zabbix acknowledged，遗留） |
| `GET /api/source` / `POST /api/source/test` / `POST /api/source/save` | 监控源配置（save 写 source.json） |
| `GET /api/system` | 运行时状态 |

## 5. 数据模型关键决策

- **三级类型判定**（zabbixClient.classify）：`TEMPLATE_RULES`（模板名正则，如 Comware/VRP→network）→ `NAME_RULES`（主机名正则）→ `GROUP_HINTS`（群组名兜底）→ 默认 server。真实环境 139 台 → 模板:网络设备 137 / 模板:操作系统 2。**不是**按 host group 白名单过滤。
- **告警挂接**：真实 problem.objectid 是 **triggerid**（不是 hostid）→ 用 trigger.get(selectHosts) 建 triggerid→hostid 映射后再挂事件。
- **实体现值指标**：来自 item.get 的 `lastvalue/lastclock`；`lastclock=0` = 从未采集 → UI 显示 `—`。
- **IP 三级兜底**：host interfaces → host name 内嵌 IP → proxy 地址。
- **四态健康**：healthy / warning / critical / unknown（availability 字段），由告警与 ping 推导。

## 6. 时序 / series 设计（本项目最复杂模块，改动前必读）

### 6.1 两层存储自适应
- Zabbix 原始值在 **history**（保留 31d），小时聚合在 **trends**（保留 365d，字段名 `trends` 不是 `trend`）。
- `series()`：窗口 span > 86400s → `trend.get`（grain='hour'，返回 avg + min/max 包络数组）；否则 `history.get`（grain='raw'，分钟级原始点）。

### 6.2 多指标拉取（一次 item.get 全拿）
search key_ 模式（searchByAny）：`system.cpu.util / hwCPUUsage / hrProcessorLoad / hwEntityCPUUtilization / vm.memory.util / hrMemoryLoad / vm.memory.size / icmppingsec / sensor.temp.value / system.cpu.load / proc.num / vfs.fs / net.if.in / net.if.out / vfs.dev.read.rate / vfs.dev.write.rate`。
然后 `pick(候选key序列, pref)` 按优先级选首个 `lastclock>0` 的 item，产出 7 类指标 + traffic + **dio（磁盘 I/O）**。
- **dio**：`vfs.dev.read.rate[dev]` / `vfs.dev.write.rate[dev]`（IOPS，ops/s），读写同参天然配对（区别于网络流量的不对称坑）；设备下拉 `devs`（'' = 自动选现值读写和最大的活跃盘），series 请求带 `dev=` 参数。Linux agent 主机有（vda/vdb），网络设备没有 → 前端 `dioOn` 自动隐藏。**注意**：Zabbix 对长期恒定值（空闲盘 0）不写 trend 行，7d/30d 窗可能空属正常。
- **fs 分区选择**：series 返回 `mnts`（全部挂载点清单，正则 `FS_PUSED_RE` 兼容 `vfs.fs[.dependent].size[mnt,pused]` 两代 key，units='%'，含现值 cur，根分区排最前）；series 请求带 `mnt=` 参数 → `chosen.fs` 精确取该挂载点，`meta.fs.mnt` 回显当前挂载点。前端"磁盘使用"卡有分区下拉（'' = 自动选根分区，无根分区退 pused 首个）。同样受 trend 恒定值行为影响：使用率长期不变的分区 7d/30d 可能只有零星 trend 点，属正常。

各设备类型实测 key 形态（真实环境）：
- **H3C 交换机**：`system.cpu.util[hh3cEntityExtCpuUsage.212]`、`vm.memory.util[hh3cEntityExtMemUsage.212]`、`sensor.temp.value[hh3cEntityExtTemperature.212]`（°C）、`icmppingsec`、`net.if.in[ifHCInOctets.<ifIndex>]`（value_type=3 unsigned, bps）
- **Linux 服务器**：`system.cpu.util`（多变体）、`vm.memory.util`、`system.cpu.load[all,avg5]`、`proc.num`、**磁盘是 `vfs.fs.dependent.size[/,pused]`（不是 vfs.fs.size！模板用了 dependent 变体）**、`net.if.in["enp4s1"]`（参数带引号）

### 6.3 接口流量配对（关键坑）
SNMP 设备 in/out 的 key 参数**不对称**：`net.if.in[ifHCInOctets.10]` vs `net.if.out[ifHCOutOctets.10]` → 直接按参数配对永远配不上。
解法：正则 `^(ifHCInOctets|ifHCOutOctets|ifInOctets|ifOutOctets)\.(.+)$` 归一化为 pairKey `ifidx:<ifIndex>`；agent 设备两侧同参（去引号后接口名）。
- 展示 label 从 item name `/Interface\s+([^(（:：]+)/` 提取（如 `GigabitEthernet1/0/48`）
- 下拉 value=pairKey、显示 label；`iface=''` 时自动选"现值收发和最大"的活跃口
- 排除带逗号变体（errors/discards）；**detail 的接口表相反——逗号变体必须识别归位**：agent 设备 `net.if.in["eth0",errors]` / `[...,dropped]` 若不识别会被当主项，0 覆盖真实 bps（IFRE 已兼容点式与逗号式，dropped 归入丢弃）

### 6.4 limit 全局截断坑
`history.get / trend.get` 的 `limit` 是**整个请求所有 item 的总点数**。多指标 24h ≈ 6700 点 → history limit **16000**、trend limit **9000**。改小会静默截断（丢最近数据）。

### 6.5 缓存
`_seriesCache` key = `hostid|range|t2|iface`；长窗 TTL 300s、短窗 60s。

### 6.6 前端渲染（EntityDetailDrawer.tsx）
- METRICS 数组按 `has(key)` 动态显隐（网络：CPU内存/温度/流量/ICMP；服务器：CPU内存/负载/进程数/磁盘/流量）
- 通用 `lineOpt(pairs, {yMax, yName, div, scaleAuto})`：包络带 = 两条 stack 透明线（min 打底 + max−min 差值）areaStyle 0.07；scaleAuto 按最大值自动 b/s→Kb/s→Mb/s→Gb/s；ping 用 div=1e-3 秒→ms
- usePoll key=`${id}|${range}|${tillEpoch}|${iface}` —— 任何维度切换立即拉取（此前不带 key 导致切换慢）

## 7. Zabbix API 使用守则（踩过的坑）

1. 所有调用带 `Authorization: Bearer <token>`；**唯一例外 `apiinfo.version` 必须不带 auth 头**（否则 -32602）。
2. `item.get` 用 `state:0, status:0` 过滤启用项；**`monitored:true` 与 search 组合会返回 0**（行为异常，勿用）。
3. `item.get` 没有 `value_` 字段；现值取 `lastvalue/lastclock`。
4. 多核/多实例指标是变体 key（`system.cpu.util[xxx.0]`），要 `search + searchByAny`，不要精确 filter。
4b. **`system.cpu.util[,idle]` 等逗号分量变体不是使用率**（idle=空闲 99.5% 会冒充 CPU 99.5%）。列表汇总与 series/detail 的 pick 均须跳过 `system.cpu.util[,` 前缀（zabbixClient.CPU_COMPONENT_RE）。
4c. **概览"磁盘使用"两代 key 都要认**：旧模板 `vfs.fs.size[/,pused]`，Zabbix 7.x 新 agent 模板改成依赖项 `vfs.fs.dependent.size[/,pused]`。列表汇总用正则 `DISK_RE`（兼容 dependent.）匹配，根分区（`/`、`c:\`）优先、否则取所有挂载点最大值；同步 search 里要带 `vfs.fs.size` 与 `vfs.fs.dependent.size` 两个前缀，只写精确旧 key 会导致新模板主机 disk=null（概览显示"—"，但趋势卡有数据）。
5. trend 字段是 `trends`；trend.get 需 `output:['itemid','clock','value_min','value_avg','value_max']`。
6. 排查"返回空"：先用 `countOutput` 确认对象存在，再逐步缩小过滤条件；并核对 curl 是否忘带 Bearer 头。

## 8. 文件地图

```
server/src/server.js            Express 路由 + guard + source 配置读写
server/src/collector/
  zabbixClient.js               ★核心：rpc()/sync()/classify()/detail()/series()
  mockData.js                   mock 数据集（结构与真实 collector 对齐，改 series 要同步改 mockSeries）
  aggregate.js                  summary/dashboard 聚合
server/data/source.json         运行时凭据（gitignore）；source.example.json 是模板
web/src/App.tsx                 hash 路由 + 布局
web/src/api.ts                  fetch 封装（entitySeries 带 range/till/iface）
web/src/pages/EntityPage.tsx    列表页：buildCols() 按当页数据裁剪空列、页码分页、搜索、.seg 域切换
web/src/pages/EntityDetailDrawer.tsx  ★深度抽屉：档案/核心指标/趋势卡/接口表/监控项表
web/src/pages/SourcePage.tsx    监控源对接（版本实测、判定依据徽章）
web/src/components/Chart.tsx    ECharts 封装（setOption(option, true) notMerge）
web/src/styles/tokens.css       设计 token（.grid-3>*{min-width:0} 是修布局爆列的关键）
```

## 9. 开发/验证约定

- **语法校验**：后端 `node --check`；前端用 web 本地 `node_modules/typescript/bin/tsc --noEmit`（别猜全局路径）。
- **curl 走本机代理问题**：沙箱内 curl 需 `--noproxy '*'` 才能访问 localhost:8787。
- **复杂请求脚本**：bash 嵌套引号/`&` 转义不可靠 → 写 python(mjs) 脚本文件跑（`.workbuddy/tmp/` 有现成的 `probe_keys.py`、`verify_series.py`、`walkthrough2.mjs` 可复用）。
- **浏览器走查**：playwright（msedge channel，`--no-proxy-server`），断言 + console clean + 元素级截图。走查脚本样例见 `.workbuddy/tmp/walkthrough2.mjs`。
- 修改 collector 数据形状时，**必须同步 mockData/mockSeries**，保证 mock 模式页面不崩。

## 10. 已知限制与待办

| 项 | 状态 |
|---|---|
| 真实源告警确认（ack）未接 Zabbix `problem.acknowledge` | 遗留（M2） |
| 告警流无分页 | 遗留 |
| 趋势卡顶部偶现残留 "°C" 小字（y 轴 name 渲染） | 视觉小瑕疵，未处理 |
| 错包/丢弃、电源/风扇等计数型指标 | Zabbix 有数据，未接（更适合做当前值表格） |
| database/service 两域当前为空 | Zabbix 侧挂对应模板后自动归入（三级判定已就绪） |
| `source.json` token 属敏感凭据 | 已 gitignore；若仓库外发需先在 Zabbix 侧吊销旧 token |

## 11. 变更记录锚点

- git 首个提交 `8317b08`：全链路首版（三级判定、trigger→host 挂接、详情面板、时间窗趋势、多指标 + 接口配对修复、配置持久化）。
- 过程性细节（每个功能的勘察结论与坑）在 `.workbuddy/memory/2026-10-23.md`（会话工作日志，格式 yyyy-MM-dd.md，append-only）。

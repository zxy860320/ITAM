// P1.3 LLDP 链路发现（路线1落地形态：临时 walk 项 → 读取 → 删除 → 解析 → 链路算法）
// 现网验证（2026-10-24 探测）：SNMP walk LLDP-MIB 可行；value_type 必须=4（日志型），
// 3（character）在 7.0.32 存储校验有 bug；delay 不能为 0。
// 链路算法：双端校验 confirmed / 单端 half / 矛盾 conflict / 消失 stale；禁止 Ping 推断。
import crypto from 'node:crypto';
import { parseWalk, neighborKey, normId } from './lldpParser.js';

const sha1 = s => crypto.createHash('sha1').update(s).digest('hex');

// 管理口判定（2026-10-26 用户规则）：经管理口（华为 MEth0/0/0、H3C M-GigabitEthernet 等）
// 学到的 LLDP 邻居属于带外管理网连接，不作为数据面拓扑连线。
// 注意 GigabitEthernet0/0/x 不在此列（部分设备三层口，非管理口专用名）。
const MGMT_IFACE_RE = /^(MEth|M-Eth|MEth0|M-GigabitEthernet|M-Gi\d|Mgmt|Management)/i;
export function isMgmtIface(name) { return MGMT_IFACE_RE.test(String(name || '').trim()); }

/**
 * 应用一轮 LLDP 观察 → link upsert。
 * observations: [{ hostid, ts, parsed:parseWalk结果, record_id }]
 * observedNodes: 本轮成功读到 LLDP MIB 的 node_id 集合（含 ok/aged/indeterminate）。
 *   decay 只作用于端点落在该集合内的链路——部分节点发现轮绝不误伤未参与节点的链路（P2-M1 修正）。
 * 返回 {new, updated, half, confirmed, conflict, observed_ifaces}
 */
export function applyObservations(db, source, observations, runTs, observedNodes = null) {
  const stat = { new: 0, updated: 0, half: 0, confirmed: 0, conflict: 0, observed_ifaces: new Set() };
  const getNode = db.prepare('SELECT node_id, display_name FROM topology_node WHERE zbx_hostid=?');
  const findNodeBySys = db.prepare(`SELECT node_id FROM topology_node
    WHERE lower(display_name)=? OR lower(zbx_hostid)=? OR (mgmt_ip=? AND mgmt_ip<>'')`);
  const findNodeByCid = db.prepare('SELECT node_id FROM topology_node WHERE chassis_id=? AND chassis_id IS NOT NULL');
  const setChassis = db.prepare('UPDATE topology_node SET chassis_id=? WHERE node_id=? AND (chassis_id IS NULL OR chassis_id=?)');
  const findIface = db.prepare(`SELECT interface_id, if_name FROM topology_interface
    WHERE node_id=? AND stale=0 AND (if_name=? OR if_descr=?) LIMIT 1`);
  const findIfaceByName = db.prepare(`SELECT interface_id FROM topology_interface
    WHERE node_id=? AND stale=0 AND if_name=? LIMIT 1`);
  const getLink = db.prepare('SELECT * FROM topology_link WHERE norm_key=?');
  const insLink = db.prepare(`INSERT INTO topology_link(norm_key,a_node,a_iface,b_node,b_iface,b_snapshot,status,source,confidence,
    seen_a_at,seen_b_at,discovered_at,last_seen) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const updLink = db.prepare(`UPDATE topology_link SET status=?, confidence=?, seen_a_at=?, seen_b_at=?,
    last_seen=?, missing_rounds=0, b_snapshot=COALESCE(?,b_snapshot) WHERE link_id=?`);

  for (const ob of observations) {
    const node = getNode.get(ob.hostid);
    if (!node) continue;
    const { parsed, ts } = ob;
    // chassis_id 补全（本端 walk 常缺 .3.0，用邻居处看到的 chassis 反填）
    if (parsed.chassis_id) setChassis.run(parsed.chassis_id, node.node_id, parsed.chassis_id);

    // 本端端口定位：lldpLocPortNum → locPorts[pn].port_id / port_desc → topology_interface
    for (const rem of parsed.rem) {
      const lp = parsed.locPorts[rem.port_num] || parsed.locPorts[String(rem.port_num)] || {};
      const aIface = findIface.get(node.node_id, lp.port_id || '', lp.port_desc || '');
      if (!aIface) continue; // 本端端口不在接口清单（聚合口/未纳管口），只留记录
      // 管理口守卫（用户规则 2026-10-26）：本端经 MEth 等管理口学到的邻居是带外管理网连接，不建链
      if (isMgmtIface(aIface.if_name)) continue;
      // 对端回报口是管理口 → 同为管理网连接，不建链（含半链路）
      if (isMgmtIface(rem.port_id) || isMgmtIface(rem.port_desc)) continue;
      const nkey = neighborKey(rem);
      let bNodeId = null, bMatch = null;
      if (rem.chassis_id) { const r = findNodeByCid.get(normId(rem.chassis_id)); if (r) { bNodeId = r.node_id; bMatch = 'cid'; } }
      if (!bNodeId && rem.sys_name) {
        const r = findNodeBySys.get(rem.sys_name.toLowerCase(), rem.sys_name.toLowerCase(), rem.sys_name);
        if (r && r.node_id !== node.node_id) { bNodeId = r.node_id; bMatch = 'sys'; }
      }
      // 自环守卫：邻居身份解析回本节点（堆叠 IRF/自身回指，实测 S5590 有 4 行）→ 不建链路，只留发现记录
      if (bNodeId === node.node_id) continue;
      // 用邻居观察反填对端 chassis_id，提高下轮 cid 匹配率
      if (bNodeId && rem.chassis_id) setChassis.run(normId(rem.chassis_id), bNodeId, normId(rem.chassis_id));

      // 对端端口解析（能解析则建全链路，不能则 half + snapshot）
      let bIface = null;
      if (bNodeId) {
        const r = findIface.get(bNodeId, normId(rem.port_id), rem.port_desc || '');
        if (r) bIface = r.interface_id;
        else { const r2 = findIfaceByName.get(bNodeId, normId(rem.port_id)); if (r2) bIface = r2.interface_id; }
      }
      const snapshot = { sys_name: rem.sys_name, port_id: rem.port_id, port_desc: rem.port_desc, chassis_id: rem.chassis_id };

      let normKey, aIsA, pair = null;
      if (bIface) {
        pair = [[node.node_id, aIface.interface_id], [bNodeId, bIface]].sort((x, y) => x[0] - y[0] || x[1] - y[1]);
        aIsA = pair[0][0] === node.node_id && pair[0][1] === aIface.interface_id;
        normKey = `L:${pair[0][0]}:${pair[0][1]}|${pair[1][0]}:${pair[1][1]}`;
      } else {
        aIsA = true;
        // 半链路 key 用稳定邻居身份（chassisId/sysName + 对端端口），避免 port_desc 抖动导致重复
        normKey = `H:${node.node_id}:${aIface.interface_id}|${nkey || sha1(JSON.stringify(snapshot))}|${normId(rem.port_id)}`;
      }
      stat.observed_ifaces.add(normKey);
      const conf = bIface ? 1.0 : bMatch === 'cid' ? 0.7 : bMatch === 'sys' ? 0.4 : 0.3;
      const existing = getLink.get(normKey);
      const tsA = aIsA ? ts : null, tsB = aIsA ? null : ts;
      if (existing) {
        let status = existing.status;
        const sA = Math.max(existing.seen_a_at || 0, tsA || 0), sB = Math.max(existing.seen_b_at || 0, tsB || 0);
        if (bIface && sA && sB) status = 'confirmed';
        else if (status !== 'manual' && status !== 'confirmed' && status !== 'rejected') status = 'half';
        if (status === 'confirmed' && existing.status !== 'confirmed') stat.confirmed++;
        if (status === 'half' && existing.status !== 'half') stat.half++;
        updLink.run(status, Math.max(conf, existing.confidence || 0), sA, sB, ts,
          bIface ? null : JSON.stringify(snapshot), existing.link_id);
        stat.updated++;
      } else {
        const status = 'half'; // 单轮只见单方向；双端确认走上面的 existing 分支
        if (bIface) insLink.run(normKey, pair[0][0], pair[0][1], pair[1][0], pair[1][1], JSON.stringify(snapshot), status, source, conf, tsA, tsB, ts, ts);
        else insLink.run(normKey, node.node_id, aIface.interface_id, bNodeId, null, JSON.stringify(snapshot), status, source, conf, tsA, tsB, ts, ts);
        stat.new++;
        if (status === 'half') stat.half++;
      }
    }
  }

  // 消失衰减：非 manual、本轮未观察到的 → missing_rounds++，≥3 转 stale
  // 注意1：>=3 判断必须在 CASE 内而非 WHERE——放 WHERE 会导致前两轮不计数，永远到不了 3
  // 注意2：observedNodes 限定端点——只有本轮真正读取过 LLDP MIB 的节点才有权对其链路计缺（部分轮不误伤）
  const seenList = [...stat.observed_ifaces];
  let decaySql = `UPDATE topology_link SET missing_rounds=missing_rounds+1,
    status=CASE WHEN missing_rounds+1>=3 THEN 'stale' ELSE status END
    WHERE source<>'manual' AND status NOT IN ('stale','rejected','manual')
    AND norm_key NOT IN (${seenList.map(() => '?').join(',') || "''"})`;
  const decayArgs = [...seenList];
  if (observedNodes && observedNodes.size) {
    const olist = [...observedNodes];
    decaySql += ` AND (a_node IN (${olist.map(() => '?').join(',')}) OR b_node IN (${olist.map(() => '?').join(',')}))`;
    decayArgs.push(...olist, ...olist);
  }
  // 注意3：seenList 是数组（用 .length）——曾误写 .size（Set 属性）恒为 undefined，
  // 导致不传 observedNodes 的调用 decay 永不执行（自测暴露，2026-10-26 修复）
  if (seenList.length || (observedNodes && observedNodes.size)) db.prepare(decaySql).run(...decayArgs);
  stat.observed_ifaces = stat.observed_ifaces.size;
  return stat;
}

/**
 * 一轮发现：对指定节点创建临时 walk 项 → 等待首轮采集 → 读 history → 删除 → 解析入库。
 * 分批控制并发（默认 20/批），每节点写 discovery_record（含原始快照）。
 * P2-M1（2026-10-25）：
 *  - nodeIds 参数同时接受 node_id（数字/数字串）与 zbx_hostid（串）——修复 v1 只按 zbx_hostid 过滤的语义陷阱；
 *  - vendor 路由（2026-10-25 变更）：网络组放开 iso MIB 视图后 huawei 同样走标准 walk（首台实测可读）；未放开者由兜底分支记 mib_unsupported；
 *  - result 四态分级（§2.3）：ok / rem_empty_indeterminate / rem_empty_aged / mib_unsupported / snmp_unreachable /
 *    walk_empty(无数据无错误，待查) / no_iface / parse_error。**绝不把采集失败写成"无邻居"。**
 */
export async function runDiscovery(db, zbx, cfg, { nodeIds = null, batchSize = 20, waitMs = 80000, log = () => {} } = {}) {
  const runId = crypto.randomUUID();
  const runTs = Math.floor(Date.now() / 1000);
  // node_ids 语义修复：数字形态按 node_id 匹配，其余按 zbx_hostid 匹配（两者都试）
  const strs = [], ints = [];
  for (const v of (nodeIds || [])) {
    strs.push(String(v));
    if (/^\d+$/.test(String(v))) ints.push(Number(v));
  }
  let targetNodes;
  if (strs.length) {
    const conds = [], args = [];
    if (strs.length) { conds.push(`zbx_hostid IN (${strs.map(() => '?').join(',')})`); args.push(...strs); }
    if (ints.length) { conds.push(`node_id IN (${ints.map(() => '?').join(',')})`); args.push(...ints); }
    targetNodes = db.prepare(`SELECT zbx_hostid, node_id, vendor FROM topology_node WHERE status<>'stale' AND (${conds.join(' OR ')})`).all(...args);
  } else {
    targetNodes = db.prepare("SELECT zbx_hostid, node_id, vendor FROM topology_node WHERE status<>'stale'").all();
  }
  const hostids = targetNodes.map(r => r.zbx_hostid).filter(Boolean);
  const vendorOf = new Map(targetNodes.map(r => [r.zbx_hostid, (r.vendor || '').toLowerCase()]));
  log(`run ${runId}: 目标节点 ${hostids.length}`);

  const insRec = db.prepare(`INSERT INTO topology_discovery_record(run_id,node_id,source,raw_snapshot,result,neighbors_found,error,started_at,finished_at)
    VALUES(?,?,?,?,?,?,?,?,?)`);
  const ifaceOf = db.prepare('SELECT node_id FROM topology_node WHERE zbx_hostid=?');
  const allObs = [];
  const observedNodes = new Set(); // 本轮"成功读到 LLDP MIB"的 node_id（四态 ok/aged/indeterminate），decay 只对它们生效
  const batchSummary = {};
  const tally = r => { batchSummary[r] = (batchSummary[r] || 0) + 1; };

  for (let i = 0; i < hostids.length; i += batchSize) {
    const batch = hostids.slice(i, i + batchSize);
    // vendor 路由（2026-10-25 变更）：网络组按华为官方 KB(EDOC1100408151) 放开交换机 iso MIB 视图后，
    // 华为 CloudEngine 标准 LLDP-MIB 已实测可读（首台验证 IDC-R01-34U-SW2 / 10.25.0.2）→ huawei 与 h3c 同样走标准 walk。
    // 尚未放开视图的设备 walk 无数据，由下方"mib 全区无数据"兜底分支如实记 mib_unsupported（不伪造、不猜线）。
    const walkBatch = [...batch];
    if (!walkBatch.length) continue;
    // 每主机 SNMP 接口
    const ifaces = await zbx.hostSnmpInterfaces(walkBatch);
    const byHost = {};
    for (const f of ifaces) (byHost[f.hostid] ||= []).push(f);
    const created = [];
    for (const hid of walkBatch) {
      const ifList = byHost[hid] || [];
      const startedAt = Math.floor(Date.now() / 1000);
      if (!ifList.length) {
        insRec.run(runId, ifaceOf.get(hid)?.node_id ?? null, 'zbx_walk_probe', null, 'no_iface', 0, 'no SNMP interface', startedAt, Math.floor(Date.now() / 1000));
        tally('no_iface');
        continue;
      }
      try {
        const itemid = await zbx.createTempItem({
          name: 'UOCP LLDP discovery (managed)', hostid: hid, key_: `lldp.discovery.${runId.slice(0, 8)}`,
          type: 20, snmp_oid: cfg.lldpWalk, value_type: 4, interfaceid: ifList[0].interfaceid,
          delay: '1m', status: 0, timeout: '20s',
        });
        if (itemid) created.push({ hostid: hid, itemid, startedAt });
        else throw new Error('item.create no id');
      } catch (e) {
        insRec.run(runId, ifaceOf.get(hid)?.node_id ?? null, 'zbx_walk_probe', null, 'snmp_timeout', 0, String(e.message).slice(0, 400), startedAt, Math.floor(Date.now() / 1000));
        tally('snmp_timeout');
      }
    }
    log(`run ${runId}: 批次 ${i / batchSize + 1} 创建 ${created.length} 项，等待 ${Math.round(waitMs / 1000)}s`);
    if (created.length) await new Promise(r => setTimeout(r, waitMs));
    for (const c of created) {
      const nodeId = ifaceOf.get(c.hostid)?.node_id ?? null;
      let result = 'walk_empty', snap = null, n = 0, err = null;
      // itemerror 判定（history 无数据时区分"设备不可达"与"表空"）
      let itemErr = '';
      try {
        const info = await zbx.call('item.get', { output: ['itemid', 'error'], itemids: [c.itemid] });
        itemErr = (info[0] && info[0].error) || '';
      } catch { /* 查询失败不改变主流程 */ }
      try {
        const rows = await zbx.historyText([c.itemid], 1);
        if (rows.length && rows[0].value) {
          snap = rows[0].value;
          const parsed = parseWalk(snap);
          n = parsed.rem.length;
          // 四态分级（§2.3）：计数器 0 不得定性"从未收到"——无历史佐证时一律 indeterminate
          const hasMib = n > 0 || parsed.chassis_id || Object.keys(parsed.locPorts).length || Object.keys(parsed.stats).length;
          if (n > 0) {
            result = 'ok';
            allObs.push({ hostid: c.hostid, ts: +rows[0].clock || runTs, parsed });
            if (nodeId) observedNodes.add(nodeId);
          } else if (hasMib) {
            const s = parsed.stats;
            result = (s.inserts > 0 || s.ageouts > 0 || s.deletes > 0) ? 'rem_empty_aged' : 'rem_empty_indeterminate';
            if (nodeId) observedNodes.add(nodeId); // MIB 可读但表空=有效观察，参与 decay 计数
          } else {
            result = 'mib_unsupported'; // 能连通但标准 MIB 全区无数据（非华为 vendor 路由命中的例外情况）
          }
        } else {
          result = itemErr ? 'snmp_unreachable' : 'walk_empty';
          if (itemErr) err = itemErr.slice(0, 400);
        }
      } catch (e) { err = String(e.message).slice(0, 400); result = 'parse_error'; }
      insRec.run(runId, nodeId, 'zbx_walk_probe', snap, result, n, err, c.startedAt, Math.floor(Date.now() / 1000));
      tally(result);
    }
    // 用后即删（幂等清理）
    const ids = created.map(c => c.itemid);
    if (ids.length) { try { await zbx.deleteItems(ids); } catch (e) { log(`cleanup warn: ${e.message}`); } }
  }

  const linkStat = applyObservations(db, 'lldp_zbx', allObs, runTs, observedNodes);
  return { runId, nodes: hostids.length, ...batchSummary, links: linkStat };
}

/** 清理历史遗留的托管发现项（异常中断时用） */
export async function cleanupManagedItems(zbx) {
  const items = await zbx.call('item.get', {
    output: ['itemid', 'hostid', 'key_'], search: { key_: 'lldp.discovery.' }, limit: 1000,
  });
  const ids = items.map(i => i.itemid);
  if (ids.length) await zbx.deleteItems(ids);
  return ids.length;
}

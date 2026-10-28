// P1.2 节点/接口同步：Zabbix → topology_node / topology_interface / topology_metric_mapping
// fingerprint = sha1(node|if_name|if_descr)：ifIndex 漂移时 interface_id 不变，仅改 if_index 属性
import crypto from 'node:crypto';

const sha1 = s => crypto.createHash('sha1').update(s).digest('hex');

// 精确形态（继承 P0 防坑：排除逗号变体与点式 errors/discards 冒充）
const IF_PARAM = /^net\.if\.(in|out|status|speed|type)\[(?:ifHCInOctets|ifHCOutOctets|ifInOctets|ifOutOctets|ifOperStatus|ifHighSpeed|ifType)\.([0-9]+)\]$/;
const IF_ERR = /^net\.if\.(?:in|out)\.errors\[(?:ifInErrors|ifOutErrors)\.([0-9]+)\]$/;
const LABEL_RE = /Interface\s+([^(（:：]+)/;
const DESCR_RE = /Interface\s+[^()（）]*[（(]([^）)]*)[）)]/;

function classify(name, descr, ifTypeVal) {
  const n = (name || '').toLowerCase();
  if (n.startsWith('loopback')) return 'loopback';
  if (n.startsWith('vlan')) return 'vlan';
  if (n.startsWith('bridge-template') || n.startsWith('bagg') || n.includes('aggregator')) return 'agg';
  if (ifTypeVal === '53') return 'vlan';
  if (ifTypeVal === '6') return 'ethernet';
  if (/(vl-?interface|vlan-if)/.test(n)) return 'vlan';
  return 'ethernet';
}

export async function syncTopology(db, zbx, cfg, log = () => {}) {
  if (!zbx.ok()) throw new Error('Zabbix 凭据缺失（server/data/source.json）');
  const now = Math.floor(Date.now() / 1000);
  const hosts = await zbx.netHosts(cfg.netTemplateRe);
  log(`网络主机 ${hosts.length} 台`);
  const hostids = hosts.map(h => h.hostid);

  const [ifacesRaw, items] = await Promise.all([
    zbx.hostSnmpInterfaces(hostids),
    zbx.netIfItems(hostids),
  ]);
  const snmpIfaceByHost = {};
  for (const it of ifacesRaw) (snmpIfaceByHost[it.hostid] ||= []).push(it);

  const itemsByHost = {};
  for (const it of items) (itemsByHost[it.hostid] ||= []).push(it);

  const stat = { nodes: 0, nodes_degraded: 0, interfaces: 0, ifindex_drift: 0, mappings: 0, external_kept: 0 };
  const upNode = db.prepare(`INSERT INTO topology_node(zbx_hostid,node_type,vendor,display_name,mgmt_ip,status,health_flags,first_seen,last_seen)
    VALUES(?,?,?,?,?,?,?,?,?)
    ON CONFLICT(zbx_hostid) DO UPDATE SET vendor=excluded.vendor, display_name=excluded.display_name,
      mgmt_ip=excluded.mgmt_ip, status=excluded.status, health_flags=excluded.health_flags, last_seen=excluded.last_seen`);
  const getNodeId = db.prepare('SELECT node_id FROM topology_node WHERE zbx_hostid=?');
  const upIface = db.prepare(`INSERT INTO topology_interface(node_id,fingerprint,if_index,if_name,if_descr,if_alias,if_type,speed_bps,oper_status,missing_rounds,stale,first_seen,last_seen)
    VALUES(?,?,?,?,?,?,?,?,?,0,0,?,?)
    ON CONFLICT(node_id,fingerprint) DO UPDATE SET if_index=excluded.if_index, if_descr=excluded.if_descr,
      if_alias=excluded.if_alias, if_type=excluded.if_type, speed_bps=excluded.speed_bps,
      oper_status=excluded.oper_status, missing_rounds=0, stale=0, last_seen=excluded.last_seen`);
  const findIfaceByIndex = db.prepare('SELECT interface_id, if_index, if_name FROM topology_interface WHERE node_id=? AND if_index=?');
  const upMap = db.prepare(`INSERT INTO topology_metric_mapping(interface_id,metric,zbx_itemid,key_snapshot)
    VALUES(?,?,?,?)
    ON CONFLICT(interface_id,metric) DO UPDATE SET zbx_itemid=excluded.zbx_itemid, key_snapshot=excluded.key_snapshot, stale=0`);

  for (const h of hosts) {
    const tplNames = (h.parentTemplates || []).map(t => t.name || '');
    const vendor = tplNames.some(n => /HH3C|H3C/i.test(n)) ? 'h3c' : tplNames.some(n => /VRP|Huawei/i.test(n)) ? 'huawei' : 'unknown';
    const ifList = snmpIfaceByHost[h.hostid] || [];
    const mgmtIp = ifList.find(i => i.useip === '1' || i.ip)?.ip || null;
    const hItems = itemsByHost[h.hostid] || [];
    const groups = h.groups || [];
    const flags = {};
    if (!hItems.some(it => IF_PARAM.test(it.key_ || '') || IF_ERR.test(it.key_ || ''))) flags.no_if_items = true;
    if (!groups.length) flags.groups_empty = true;
    const degraded = Object.keys(flags).length > 0;
    if (degraded) stat.nodes_degraded++;
    await upNode.run(h.hostid, 'switch', vendor, h.name || h.host, mgmtIp,
      degraded ? 'degraded' : 'active', JSON.stringify(flags), now, now);
    stat.nodes++;
    const { node_id: nodeId } = await getNodeId.get(h.hostid);

    // 按 ifIndex 聚合本主机接口项
    const byIdx = {};
    for (const it of hItems) {
      let m = IF_PARAM.exec(it.key_ || '');
      if (m) {
        const idx = +m[2];
        const rec = byIdx[idx] ||= { label: null, descr: null, items: {} };
        rec.items[m[1]] = it;
        if (!rec.label) {
          const lm = LABEL_RE.exec(it.name || '');
          if (lm) rec.label = lm[1];
          const dm = DESCR_RE.exec(it.name || '');
          if (dm) rec.descr = dm[1];
        }
        continue;
      }
      m = IF_ERR.exec(it.key_ || '');
      if (m) {
        const idx = +m[1];
        const rec = byIdx[idx] ||= { label: null, descr: null, items: {} };
        (rec.items.errors ||= []).push(it);
      }
    }
    for (const [idxStr, rec] of Object.entries(byIdx)) {
      const idx = +idxStr;
      const label = rec.label || `if${idx}`;
      const descr = rec.descr || '';
      const fp = sha1(`${nodeId}|${label}|${descr}`);
      const speedIt = rec.items.speed;
      const operIt = rec.items.status;
      // 实测（2026-10-24）：模板 speed 项 units=bps 且 lastvalue 已乘过（自定义预处理），勿再 *1e6；
      // 仅当 units 非 bps（原始 ifHighSpeed Mbps 形态）时才换算，超 1e13 视为脏数据置 null
      let speed = null;
      if (speedIt?.lastvalue != null && speedIt.lastvalue !== '') {
        const raw = +speedIt.lastvalue;
        const v = (speedIt.units || '').toLowerCase() === 'bps' ? raw : raw * 1e6;
        if (Number.isFinite(v) && v >= 0 && v <= 1e13) speed = Math.round(v);
      }
      const oper = operIt?.lastvalue != null && operIt.lastvalue !== '' ? +operIt.lastvalue : null;
      const itype = classify(label, descr, rec.items.type?.lastvalue);
      // ifIndex 漂移检测：同 fingerprint 旧记录 if_index 变了 → 记漂移（interface_id 保持不变）
      const old = await findIfaceByIndex.get(nodeId, idx);
      if (old && old.if_name && old.if_name !== label) { stat.ifindex_drift++; log(`ifIndex 漂移 node=${h.host} idx=${idx}: ${old.if_name} → ${label}`); }
      await upIface.run(nodeId, fp, idx, label, descr, '', itype, speed, oper, now, now);
      const { interface_id: ifaceId } = await db.prepare('SELECT interface_id FROM topology_interface WHERE node_id=? AND fingerprint=?').get(nodeId, fp);
      stat.interfaces++;
      const mapOne = async (metric, it) => { if (it) { await upMap.run(ifaceId, metric, String(it.itemid), it.key_); stat.mappings++; } };
      await mapOne('if_in', rec.items.in); await mapOne('if_out', rec.items.out);
      await mapOne('if_speed', rec.items.speed); await mapOne('if_oper', rec.items.status);
      if (rec.items.errors?.length) { await upMap.run(ifaceId, 'if_errors', String(rec.items.errors[0].itemid), rec.items.errors[0].key_); stat.mappings++; }
    }
    // 接口消失检测：本轮未见的置 missing_rounds（软删，保历史链路）
    const seenFps = Object.keys(byIdx).map(idxStr => {
      const rec = byIdx[+idxStr];
      return sha1(`${nodeId}|${rec.label || `if${idxStr}`}|${rec.descr || ''}`);
    });
    if (seenFps.length) {
      const all = (await db.prepare('SELECT fingerprint FROM topology_interface WHERE node_id=? AND stale=0').all(nodeId)).map(r => r.fingerprint);
      const gone = all.filter(fp => !seenFps.includes(fp));
      if (gone.length) {
        const stmt = db.prepare('UPDATE topology_interface SET missing_rounds=missing_rounds+1, stale=CASE WHEN missing_rounds+1>=3 THEN 1 ELSE 0 END WHERE node_id=? AND fingerprint=?');
        for (const fp of gone) await stmt.run(nodeId, fp);
      }
    }
  }
  return stat;
}

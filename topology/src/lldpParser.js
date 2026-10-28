// LLDP-MIB walk 文本解析（Zabbix snmpwalk -Oe -Ot -On 输出形态）
// 行例: .1.0.8802.1.1.2.1.3.7.1.3.97 = STRING: "Ten-GigabitEthernet1/1/0/1"
//       .1.0.8802.1.1.2.1.3.7.1.3.10 = Hex-STRING: 00 0F E2 07 F2 E0
// 列 OID（相对 1.0.8802.1.1.2.1）——P2-M1 修正 2026-10-25（v1 注释与代码同错一层）:
//  .3.1.0            lldpLocChassisIdSubtype（标量实例；v1 误写 .3.0——不存在）
//  .3.2.0            lldpLocChassisId      （标量实例）
//  .3.7.1.3.<p>      lldpLocPortId        (p = lldpLocPortNum)
//  .3.7.1.4.<p>      lldpLocPortDesc
//  .4.1.1.<col>.<TimeMark>.<LocalPortNum>.<RemIndex>   ← v1 误把 <col> 当 Entry 号（缺 1 层）
//   col4=ChassisIdSubtype col5=ChassisId col6=PortIdSubtype col7=PortId col8=PortDesc
//   col9=SysName col10=SysDesc col11/12=SysCap
//  TimeMark 是 agent 启动后 TimeTicks（非 0 表示条目重启后重载），仅用于去重，不得当行号。
const BASE = '.1.0.8802.1.1.2.1';
// 类型标签实测形态含 Gauge32/Counter32/Timeticks（大小写混排），故用 i 标志
const VAL_RE = /^(\.1\.0\.8802\.1\.1\.2\.1\.[0-9.]+)\s*=\s*(?:STRING|Hex-STRING|INTEGER|GAUGE|COUNTER|IpAddress|TIMETICKS)[^:]*:\s*(.*)$/i;

function cleanVal(s) {
  s = (s || '').trim();
  if (s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1);
  return s.trim();
}

/**
 * 解析 walk 文本 →
 * { chassis_id, locPorts: {portNum: {port_id, port_desc}},
 *   stats: {lastchange, inserts, deletes, drops, ageouts},   // P2-M1 四态证据分级用（§2.3）
 *   rem: [{time_mark, port_num, rem_index, chassis_id, port_id, port_desc, sys_name}] }
 */
export function parseWalk(text) {
  const out = { chassis_id: null, locPorts: {}, stats: {}, rem: {} };
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = VAL_RE.exec(line);
    if (!m) continue;
    const oid = m[1], val = cleanVal(m[2]);
    if (oid === BASE + '.3.2.0') { out.chassis_id = normId(val); continue; }
    let mm;
    // stats 标量（§2.3 四态分级证据；计数器重启即清零，不得据 0 断言"从未收到"）
    if ((mm = oid.match(/^\.1\.0\.8802\.1\.1\.2\.1\.2\.([1-5])\.0$/))) {
      const k = ['', 'lastchange', 'inserts', 'deletes', 'drops', 'ageouts'][+mm[1]];
      const n = parseInt(val, 10);
      if (k && Number.isFinite(n)) out.stats[k] = n;
      continue;
    }
    if ((mm = oid.match(new RegExp('^' + BASE.replace(/\./g, '\\.') + '\\.3\\.7\\.1\\.(\\d+)\\.(\\d+)$')))) {
      const col = mm[1], pn = mm[2];
      const p = out.locPorts[pn] || (out.locPorts[pn] = { port_id: '', port_desc: '' });
      if (col === '3') p.port_id = normId(val);
      else if (col === '4') p.port_desc = val;
      continue;
    }
    if ((mm = oid.match(new RegExp('^' + BASE.replace(/\./g, '\\.') + '\\.4\\.1\\.1\\.(\\d+)\\.(\\d+)\\.(\\d+)\\.(\\d+)$')))) {
      const col = mm[1], t = mm[2], pn = mm[3], ri = mm[4];
      const key = `${t}|${pn}|${ri}`;
      const r = out.rem[key] || (out.rem[key] = { time_mark: +t, port_num: +pn, rem_index: +ri, chassis_id: '', port_id: '', port_desc: '', sys_name: '' });
      if (col === '4') r.chassis_id_sub = val;         // ChassisIdSubtype（仅留存，不参与匹配）
      else if (col === '5') r.chassis_id = normId(val);
      else if (col === '7') r.port_id = normId(val);
      else if (col === '8') r.port_desc = val;
      else if (col === '9') r.sys_name = val;
    }
  }
  out.rem = Object.values(out.rem);
  return out;
}

/** Hex-STRING MAC 归一化为小写冒号形式；其余原样小写 */
export function normId(v) {
  const hex = /^([0-9A-Fa-f]{2}[\s:])+[0-9A-Fa-f]{2}$/.exec((v || '').trim());
  if (hex) return v.trim().replace(/[\s]+/g, ':').replace(/:+/g, ':').toLowerCase();
  return (v || '').trim();
}

/** 邻居身份键：chassis_id 优先（MAC），否则 sysName 小写 */
export function neighborKey(rem) {
  if (rem.chassis_id) return 'cid:' + rem.chassis_id.toLowerCase();
  if (rem.sys_name) return 'sys:' + rem.sys_name.toLowerCase();
  return null;
}

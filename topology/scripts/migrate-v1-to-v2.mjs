// V1 → V2 数据迁移（docs/TOPOLOGY-V2-DESIGN.md §7.5）
// 用法：
//   sqlite（本地）：node topology/scripts/migrate-v1-to-v2.mjs                 # 用 CFG 默认库（会先 VACUUM INTO 备份）
//   sqlite 副本演练：TOPO_DB=/path/copy.db node topology/scripts/migrate-v1-to-v2.mjs
//   MySQL（compose）：docker compose --profile tools run --rm migrate 或本地 TOPO_DB=mysql + MYSQL_* 环境变量
// 幂等：重复执行为 no-op（增列由 openDb→ensureV2 幂等保证；数据回填以 topo_meta 标记 + 存在性检查）。
// 结构变更全部可空/带默认值——旧代码零感知；旧表 topology_group 冻结保留作回滚源。
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { openDb, metaGet, metaSet } from '../src/db.js';
import { CFG } from '../src/config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const log = (...a) => console.log('[migrate-v2]', ...a);
const now = () => Math.floor(Date.now() / 1000);

async function counts(db) {
  const out = {};
  for (const t of ['topology_node', 'topology_interface', 'topology_link', 'topology_zone', 'topology_link_evidence', 'topology_layout_snapshot'])
    out[t] = (await db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get()).n;
  return out;
}

async function main() {
  log(`engine=${CFG.dbKind} target=${CFG.dbKind === 'mysql' ? `mysql://${CFG.mysql.host}:${CFG.mysql.port}/${CFG.mysql.database}` : CFG.dbFile}`);

  // 0) 备份（sqlite：VACUUM INTO 带时间戳；MySQL：脚本前先跑 mysqldump——compose 环境见部署文档）
  if (CFG.dbKind === 'sqlite') {
    const bak = `${CFG.dbFile}.bak-v2-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`;
    // 注意：VACUUM INTO 需独占连接，本脚本尚未打开库，先备份再 openDb
    const { DatabaseSync } = await import('node:sqlite');
    const raw = new DatabaseSync(CFG.dbFile);
    raw.exec(`VACUUM INTO '${bak.replace(/'/g, "''")}'`);
    raw.close();
    log('backup →', bak);
  } else {
    log('WARN: MySQL 侧请先手动备份：mysqldump -h ... ityw_topology > backup.sql');
  }

  const db = await openDb(CFG); // openDb 内含 ensureV2：三新表 + 四增列（幂等）
  const before = await counts(db);
  log('counts(before):', JSON.stringify(before));

  // 1) relation_type 回填（§4.8 映射）。以 v1.relation_backfill 标记幂等（避免 MySQL 同表子查询限制）。
  if (!(await metaGet(db, 'v1.relation_backfill'))) {
    const updates = [
      ["manual_physical", "source='manual'"],
      ["lldp_confirmed", "source<>'manual' AND status='confirmed'"],
      ["lldp_half", "source<>'manual' AND status='half'"],
    ];
    let touched = 0;
    for (const [rt, where] of updates) {
      const r = await db.prepare(`UPDATE topology_link SET relation_type=? WHERE ${where}`).run(rt);
      touched += r.changes;
    }
    // stale/conflict/rejected：按双端证据判定语义（两端都见过=曾双端确认）
    const staleRows = await db.prepare(
      "SELECT link_id, seen_a_at, seen_b_at FROM topology_link WHERE status IN ('stale','conflict','rejected') AND relation_type='lldp_confirmed' AND source<>'manual'").all();
    for (const r of staleRows) {
      if (r.seen_a_at == null || r.seen_b_at == null) {
        await db.prepare("UPDATE topology_link SET relation_type='lldp_half' WHERE link_id=?").run(r.link_id);
        touched++;
      }
    }
    await metaSet(db, 'v1.relation_backfill', String(now()));
    log(`relation_type backfill: ${touched} rows classified`);
  } else {
    log('relation_type backfill: already done, skip');
  }

  // 2) topology_group（旧固定八类）→ topology_zone。已迁移过（v1.group_map 存在）则跳过。
  const grpMapRaw = await metaGet(db, 'v1.group_map');
  if (!grpMapRaw) {
    const groups = await db.prepare('SELECT group_key, label, collapsed, x, y, w, h FROM topology_group').all();
    const map = {};
    for (const g of groups) {
      const r = await db.prepare(
        'INSERT INTO topology_zone(name,bg_color,border_style,collapsed,x,y,w,h,sort_hint,created_by,created_at,updated_by,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(g.label || g.group_key, '#f0f5ff', 'solid', g.collapsed ?? 0, g.x, g.y, g.w, g.h, 0, 'migrate-v2', now(), 'migrate-v2', now());
      map[g.group_key] = Number(r.lastInsertRowid);
    }
    await metaSet(db, 'v1.group_map', JSON.stringify(map));
    log(`group→zone: ${groups.length} zones created, map=${JSON.stringify(map)}`);
    // 3) layout.group_key → zone_id
    let moved = 0;
    for (const [gk, zid] of Object.entries(map)) {
      const r = await db.prepare('UPDATE topology_layout SET zone_id=? WHERE group_key=? AND zone_id IS NULL').run(zid, gk);
      moved += r.changes;
    }
    log(`layout.group_key→zone_id: ${moved} rows`);
  } else {
    log('group→zone: already migrated (v1.group_map exists), skip');
  }

  // 4) evidence 回填：每条存量 confirmed/half 链生成 1–2 条证据行。以 v1.evidence_backfill 标记幂等。
  if (!(await metaGet(db, 'v1.evidence_backfill'))) {
    const links = await db.prepare(
      "SELECT link_id, status, source, seen_a_at, seen_b_at, b_snapshot, discovered_at FROM topology_link WHERE relation_type IN ('lldp_confirmed','lldp_half','manual_physical')").all();
    let ev = 0;
    for (const l of links) {
      const ins = async (kind, payload, at) => {
        await db.prepare('INSERT INTO topology_link_evidence(link_id,kind,payload,observed_at) VALUES(?,?,?,?)').run(l.link_id, kind, payload ?? null, at ?? l.discovered_at ?? now());
        ev++;
      };
      if (l.relation_type === 'manual_physical') { if (l.discovered_at) await ins('manual_note', null, l.discovered_at); continue; }
      if (l.seen_a_at != null) await ins('lldp_a', null, l.seen_a_at);
      if (l.seen_b_at != null) await ins('lldp_b', null, l.seen_b_at);
      if (l.relation_type === 'lldp_half' && l.b_snapshot) await ins('lldp_raw', l.b_snapshot, l.discovered_at);
    }
    await metaSet(db, 'v1.evidence_backfill', String(now()));
    log(`evidence backfill: ${ev} rows for ${links.length} links`);
  } else {
    log('evidence backfill: already done, skip');
  }

  // 5) 对账断言
  const after = await counts(db);
  const problems = [];
  if (after.topology_node !== before.topology_node) problems.push('node count changed');
  if (after.topology_interface !== before.topology_interface) problems.push('interface count changed');
  if (after.topology_link !== before.topology_link) problems.push('link count changed');
  const nullRt = (await db.prepare("SELECT COUNT(*) AS n FROM topology_link WHERE relation_type IS NULL OR relation_type=''").get()).n;
  if (nullRt) problems.push(`${nullRt} links missing relation_type`);
  const badRt = (await db.prepare('SELECT COUNT(*) AS n FROM topology_link WHERE relation_type NOT IN (?, ?, ?, ?, ?, ?, ?)')
    .all('lldp_confirmed', 'lldp_half', 'manual_physical', 'agg_lacp', 'route_nexthop', 'vrrp', 'stack')).n;
  if (badRt) problems.push(`${badRt} links with unknown relation_type`);
  const dupNorm = (await db.prepare('SELECT COUNT(*) AS n FROM (SELECT norm_key, COUNT(*) c FROM topology_link GROUP BY norm_key HAVING c>1)').get()).n;
  if (dupNorm) problems.push(`${dupNorm} duplicated norm_key groups`);
  const rtDist = (await db.prepare('SELECT relation_type, COUNT(*) n FROM topology_link GROUP BY relation_type').all());

  log('counts(after):', JSON.stringify(after));
  log('relation_type distribution:', JSON.stringify(rtDist));
  if (problems.length) { log('FAIL:', problems.join('; ')); process.exit(1); }
  log('OK: migration verified (counts conserved, relation_type 100%, norm_key unique)');
  await db.close();
}

main().catch(e => { console.error('[migrate-v2] ERROR:', e); process.exit(1); });

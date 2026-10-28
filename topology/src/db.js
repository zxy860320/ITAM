// topology-svc 本地 SQLite（node:sqlite，Node 22.5+ 内置）
// 五表设计见 docs/TOPOLOGY-P1-DESIGN.md §4；凭据不落库（路线2兜底时从 Zabbix 现读）。
import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import path from 'path';

export function openDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL;');
  db.exec('PRAGMA foreign_keys=ON;');
  db.exec(`
  CREATE TABLE IF NOT EXISTS topology_node (
    node_id      INTEGER PRIMARY KEY AUTOINCREMENT,
    zbx_hostid   TEXT UNIQUE,
    node_type    TEXT DEFAULT 'switch',
    vendor       TEXT,
    display_name TEXT,
    mgmt_ip      TEXT,
    chassis_id   TEXT,
    status       TEXT DEFAULT 'active',        -- active | degraded | disabled | stale
    health_flags TEXT DEFAULT '{}',            -- JSON: {no_if_items,groups_empty,...}
    first_seen   INTEGER,
    last_seen    INTEGER
  );
  CREATE TABLE IF NOT EXISTS topology_interface (
    interface_id  INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id       INTEGER NOT NULL REFERENCES topology_node(node_id) ON DELETE CASCADE,
    fingerprint   TEXT NOT NULL,               -- sha1(node|if_name|if_descr) 抗 ifIndex 漂移
    if_index      INTEGER,                     -- 当前 ifIndex（属性，可变）
    if_name       TEXT,
    if_descr      TEXT,
    if_alias      TEXT,
    if_type       TEXT DEFAULT 'ethernet',     -- ethernet | vlan | loopback | agg | other
    speed_bps     INTEGER,
    oper_status   INTEGER,                     -- 1=up 2=down
    metric_source TEXT DEFAULT 'zabbix',
    missing_rounds INTEGER DEFAULT 0,
    stale         INTEGER DEFAULT 0,
    first_seen    INTEGER,
    last_seen     INTEGER,
    UNIQUE (node_id, fingerprint)
  );
  CREATE TABLE IF NOT EXISTS topology_link (
    link_id        INTEGER PRIMARY KEY AUTOINCREMENT,
    norm_key       TEXT UNIQUE,                -- 归一化端点对（或半链路快照哈希），防重复
    a_node         INTEGER REFERENCES topology_node(node_id),
    a_iface        INTEGER REFERENCES topology_interface(interface_id),
    b_node         INTEGER REFERENCES topology_node(node_id),
    b_iface        INTEGER REFERENCES topology_interface(interface_id),
    b_snapshot     TEXT,                       -- JSON: {sys_name,port_id,port_desc,chassis_id} half 时
    status         TEXT DEFAULT 'half',        -- confirmed | half | conflict | stale | rejected | manual
    source         TEXT DEFAULT 'lldp_zbx',    -- lldp_zbx | lldp_snmp | manual
    confidence     REAL DEFAULT 0,
    confirmed_by   TEXT,
    confirmed_at   INTEGER,
    seen_a_at      INTEGER,                    -- A→B 方向最近观察时间（双端校验）
    seen_b_at      INTEGER,                    -- B→A 方向最近观察时间
    discovered_at  INTEGER,
    last_seen      INTEGER,
    missing_rounds INTEGER DEFAULT 0,
    note           TEXT
  );
  CREATE TABLE IF NOT EXISTS topology_discovery_record (
    record_id       INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id          TEXT NOT NULL,
    node_id         INTEGER,
    source          TEXT,                      -- zbx_walk_probe | zbx_resident | direct_snmp | manual
    raw_snapshot    TEXT,                      -- 原始 walk 文本（回溯/重解析）
    result          TEXT,                      -- ok | walk_empty | snmp_timeout | no_credentials | parse_error | no_iface
    neighbors_found INTEGER DEFAULT 0,
    error           TEXT,
    started_at      INTEGER,
    finished_at     INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_record_run ON topology_discovery_record(run_id);
  CREATE TABLE IF NOT EXISTS topology_metric_mapping (
    mapping_id   INTEGER PRIMARY KEY AUTOINCREMENT,
    interface_id INTEGER NOT NULL REFERENCES topology_interface(interface_id) ON DELETE CASCADE,
    metric       TEXT NOT NULL,                -- if_in | if_out | if_speed | if_oper | if_errors
    zbx_itemid   TEXT NOT NULL,
    key_snapshot TEXT,
    stale        INTEGER DEFAULT 0,
    UNIQUE (interface_id, metric)
  );
  CREATE TABLE IF NOT EXISTS topo_meta (k TEXT PRIMARY KEY, v TEXT);
  `);
  return db;
}

export function metaGet(db, k) {
  const r = db.prepare('SELECT v FROM topo_meta WHERE k=?').get(k);
  return r ? r.v : null;
}
export function metaSet(db, k, v) {
  db.prepare('INSERT INTO topo_meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, String(v));
}

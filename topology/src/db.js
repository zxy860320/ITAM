// topology-svc 数据层：sqlite / MySQL 双引擎，统一异步接口
// 表设计见 docs/TOPOLOGY-P1-DESIGN.md §4；凭据不落库（路线2兜底时从 Zabbix 现读）。
// 统一接口（所有调用方 await）：
//   db.prepare(sql).get(...p) → row|undefined
//   db.prepare(sql).all(...p) → rows[]
//   db.prepare(sql).run(...p) → {changes, lastInsertRowid}
//   db.exec(sql)（仅 sqlite 方言 DDL 用，MySQL 走 initMysqlSchema）
// 方言差异（调用方写 sqlite 风格，MySQL 侧自动翻译）：
//   ON CONFLICT(cols) DO UPDATE SET x=excluded.x → ON DUPLICATE KEY UPDATE x=VALUES(x)
//   CAST(x AS REAL) → CAST(x AS DOUBLE)；AUTOINCREMENT → AUTO_INCREMENT
import fs from 'fs';
import path from 'path';

// ---------- SQL 方言翻译（sqlite → mysql） ----------
export function toMysqlSql(sql) {
  return sql
    .replace(/CAST\((.*?) AS REAL\)/gi, 'CAST($1 AS DOUBLE)')
    .replace(/INSERT (INTO|OR IGNORE INTO)\s+(\S+)\s*\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)\s*ON CONFLICT\s*\(([^)]*)\) DO UPDATE SET ([\s\S]*?)(?=;?$)/gi,
      (m, into, table, cols, vals, _conf, sets) => {
        const setList = sets.split(',').map(s => {
          const mm = /^\s*([\w.]+)\s*=\s*excluded\.(\w+)\s*$/.exec(s.trim());
          if (mm) return `${mm[1]}=VALUES(${mm[2]})`;
          // 常量赋值（如 stale=0）
          return s.trim();
        }).join(', ');
        return `INSERT INTO ${table} (${cols}) VALUES (${vals}) ON DUPLICATE KEY UPDATE ${setList}`;
      });
}

// ---------- sqlite 引擎（node:sqlite 包一层异步外观） ----------
async function openSqlite(dbFile) {
  const { DatabaseSync } = await import('node:sqlite');
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const raw = new DatabaseSync(dbFile);
  raw.exec('PRAGMA journal_mode=WAL;');
  raw.exec('PRAGMA foreign_keys=ON;');
  raw.exec(SQLITE_SCHEMA);
  return {
    kind: 'sqlite',
    location: dbFile,
    prepare(sql) {
      const st = raw.prepare(sql);
      return {
        async get(...p) { return st.get(...p); },
        async all(...p) { return st.all(...p); },
        async run(...p) { const r = st.run(...p); return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) }; },
      };
    },
    async exec(sql) { raw.exec(sql); },
    async close() { raw.close(); },
  };
}

// ---------- MySQL 引擎（mysql2 连接池） ----------
async function openMysql(my) {
  const mysql = await import('mysql2/promise');
  const pool = mysql.createPool({
    host: my.host, port: my.port, user: my.user, password: my.password,
    database: my.database, waitForConnections: true, connectionLimit: 10,
    charset: 'utf8mb4', decimalNumbers: true, multipleStatements: false,
    connectTimeout: 10000,
  });
  // 等 MySQL 就绪（compose 里 depends_on healthy 一般已足够；重试兜底）
  for (let i = 1; i <= 30; i++) {
    try { await pool.query('SELECT 1'); break; }
    catch (e) {
      if (i === 30) throw e;
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  for (const ddl of MYSQL_SCHEMA) await pool.query(ddl);
  return {
    kind: 'mysql',
    location: `mysql://${my.host}:${my.port}/${my.database}`,
    prepare(sql) {
      const msql = toMysqlSql(sql);
      return {
        async get(...p) { const [rows] = await pool.query(msql, p); return rows[0] ?? undefined; },
        async all(...p) { const [rows] = await pool.query(msql, p); return rows; },
        async run(...p) { const [r] = await pool.query(msql, p); return { changes: r.affectedRows ?? 0, lastInsertRowid: Number(r.insertId ?? 0) }; },
      };
    },
    async exec() { throw new Error('exec not supported on mysql engine'); },
    async close() { await pool.end(); },
  };
}

// ---------- 打开入口（CFG.db 决定引擎） ----------
export async function openDb(cfg) {
  if (cfg.dbKind === 'mysql') return openMysql(cfg.mysql);
  return openSqlite(cfg.dbFile);
}

// ---------- meta（k/v 表；双方言各写一条） ----------
export async function metaGet(db, k) {
  const r = await db.prepare('SELECT v FROM topo_meta WHERE k=?').get(k);
  return r ? r.v : null;
}
export async function metaSet(db, k, v) {
  if (db.kind === 'mysql') {
    await db.prepare('INSERT INTO topo_meta(k,v) VALUES(?,?) ON DUPLICATE KEY UPDATE v=VALUES(v)').run(k, String(v));
  } else {
    await db.prepare('INSERT INTO topo_meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, String(v));
  }
}

// ---------- schema：sqlite ----------
const SQLITE_SCHEMA = `
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
`;

// ---------- schema：MySQL（utf8mb4；speed_bps BIGINT——实测有 4e16 脏值；
// 路径快照存 topo_meta.v，LONGTEXT——64KB walk 文本超 TEXT 64KB 上限风险） ----------
const MYSQL_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS topology_node (
    node_id      INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    zbx_hostid   VARCHAR(64) UNIQUE,
    node_type    VARCHAR(32) DEFAULT 'switch',
    vendor       VARCHAR(32),
    display_name VARCHAR(255),
    mgmt_ip      VARCHAR(64),
    chassis_id   VARCHAR(128),
    status       VARCHAR(16) DEFAULT 'active',
    health_flags TEXT,
    first_seen   BIGINT,
    last_seen    BIGINT,
    INDEX idx_node_status (status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS topology_interface (
    interface_id   INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    node_id        INT NOT NULL,
    fingerprint    VARCHAR(64) NOT NULL,
    if_index       INT,
    if_name        VARCHAR(255),
    if_descr       TEXT,
    if_alias       VARCHAR(255),
    if_type        VARCHAR(32) DEFAULT 'ethernet',
    speed_bps      BIGINT,
    oper_status    INT,
    metric_source  VARCHAR(32) DEFAULT 'zabbix',
    missing_rounds INT DEFAULT 0,
    stale          INT DEFAULT 0,
    first_seen     BIGINT,
    last_seen      BIGINT,
    UNIQUE KEY uniq_node_fp (node_id, fingerprint),
    CONSTRAINT fk_if_node FOREIGN KEY (node_id) REFERENCES topology_node(node_id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS topology_link (
    link_id        INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    norm_key       VARCHAR(255) UNIQUE,
    a_node         INT,
    a_iface        INT,
    b_node         INT,
    b_iface        INT,
    b_snapshot     TEXT,
    status         VARCHAR(16) DEFAULT 'half',
    source         VARCHAR(32) DEFAULT 'lldp_zbx',
    confidence     DOUBLE DEFAULT 0,
    confirmed_by   VARCHAR(128),
    confirmed_at   BIGINT,
    seen_a_at      BIGINT,
    seen_b_at      BIGINT,
    discovered_at  BIGINT,
    last_seen      BIGINT,
    missing_rounds INT DEFAULT 0,
    note           TEXT,
    CONSTRAINT fk_link_a_node FOREIGN KEY (a_node) REFERENCES topology_node(node_id),
    CONSTRAINT fk_link_b_node FOREIGN KEY (b_node) REFERENCES topology_node(node_id),
    CONSTRAINT fk_link_a_iface FOREIGN KEY (a_iface) REFERENCES topology_interface(interface_id),
    CONSTRAINT fk_link_b_iface FOREIGN KEY (b_iface) REFERENCES topology_interface(interface_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS topology_discovery_record (
    record_id       INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    run_id          VARCHAR(64) NOT NULL,
    node_id         INT,
    source          VARCHAR(32),
    raw_snapshot    LONGTEXT,
    result          VARCHAR(32),
    neighbors_found INT DEFAULT 0,
    error           TEXT,
    started_at      BIGINT,
    finished_at     BIGINT,
    INDEX idx_record_run (run_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS topology_metric_mapping (
    mapping_id   INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    interface_id INT NOT NULL,
    metric       VARCHAR(32) NOT NULL,
    zbx_itemid   VARCHAR(64) NOT NULL,
    key_snapshot TEXT,
    stale        INT DEFAULT 0,
    UNIQUE KEY uniq_if_metric (interface_id, metric),
    CONSTRAINT fk_map_iface FOREIGN KEY (interface_id) REFERENCES topology_interface(interface_id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS topo_meta (
    k VARCHAR(191) PRIMARY KEY,
    v LONGTEXT
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
];

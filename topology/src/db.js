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
          // 允许列名带反引号（sqlite 侧为兼容 MySQL 保留字可能加反引号）
          const mm = /^\s*`?([\w.]+)`?\s*=\s*excluded\.`?(\w+)`?\s*$/.exec(s.trim());
          if (mm) return `\`${mm[1]}\`=VALUES(\`${mm[2]}\`)`;
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

// ---------- V2 增量（docs/TOPOLOGY-V2-DESIGN.md §7） ----------
// relation_type 七枚举（§4.1）；norm_key 前缀命名空间：L:/H: 物理沿用，G: agg、R: route、V: vrrp、S: stack
export const RELATION_TYPES = ['lldp_confirmed', 'lldp_half', 'manual_physical', 'agg_lacp', 'route_nexthop', 'vrrp', 'stack'];

// 列存在性检查（幂等增列用）：MySQL 查 information_schema，sqlite 查 PRAGMA
async function hasColumn(db, table, col) {
  if (db.kind === 'mysql') {
    const r = await db.prepare('SELECT 1 AS ok FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name=? AND column_name=?').get(table, col);
    return !!r;
  }
  const rows = await db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some(r => r.name === col);
}

// 旧库（V1.5 及更早）打开后自动补齐 V2 列——全部可空/带默认值，旧代码零感知。
// 数据回填（relation_type 映射、group→zone、evidence）不在这里做，见 scripts/migrate-v1-to-v2.mjs。
export async function ensureV2(db) {
  const alter = async (table, col, ddl) => {
    if (await hasColumn(db, table, col)) return false;
    await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${ddl}`).run();
    return true;
  };
  // topology_link：关系语义 + 聚合父子 + VLAN 上下文 + 聚合带宽冗余
  await alter('topology_link', 'relation_type', "relation_type VARCHAR(32) NOT NULL DEFAULT 'lldp_confirmed'");
  await alter('topology_link', 'parent_link_id', 'parent_link_id INT');
  await alter('topology_link', 'vlan_id', 'vlan_id INT');
  await alter('topology_link', 'bandwidth_bps', 'bandwidth_bps BIGINT');
  // topology_layout：人工区域隶属（zone_id）；坐标语义不变
  await alter('topology_layout', 'zone_id', 'zone_id INT');
  // zone_id 索引（新列上建，双方言各自写法；已存在则跳过）
  if (db.kind === 'mysql') {
    const idx = await db.prepare('SELECT 1 AS ok FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name=? AND index_name=?').get('topology_layout', 'idx_layout_zone');
    if (!idx) await db.prepare('CREATE INDEX idx_layout_zone ON topology_layout (zone_id)').run();
  } else {
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_layout_zone ON topology_layout(zone_id)').run();
  }
}

// ---------- 打开入口（CFG.db 决定引擎） ----------
export async function openDb(cfg) {
  const db = cfg.dbKind === 'mysql' ? await openMysql(cfg.mysql) : await openSqlite(cfg.dbFile);
  await ensureV2(db);
  return db;
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
  -- P3 全局共享布局：与设备真实属性分离；node_id 不设外键——
  -- 设备删除后布局历史保留（物理删除仅由管理员显式 reset 触发）
  CREATE TABLE IF NOT EXISTS topology_layout (
    node_id         INTEGER PRIMARY KEY,
    group_key       TEXT,                          -- 稳定区域 key（NULL=按默认规则推断）
    x               REAL,
    y               REAL,
    layout_source   TEXT DEFAULT 'auto',           -- auto | manual（拖动后=manual）
    position_locked INTEGER DEFAULT 0,             -- 1=固定位置，自动布局不得移动
    updated_by      TEXT,
    updated_at      INTEGER
  );
  CREATE TABLE IF NOT EXISTS topology_group (
    group_key  TEXT PRIMARY KEY,                   -- V2 起冻结只读（迁移备份源，退役见设计 §12 Q9）
    label      TEXT,
    collapsed  INTEGER DEFAULT 0,
    x          REAL, y REAL, w REAL, h REAL,       -- 区域容器人工位置/尺寸（NULL=按成员自动包络）
    updated_at INTEGER
  );
  -- ===== V2（设计 §7）=====
  -- 区域：管理员资产，非算法产物；系统只出建议不落库
  CREATE TABLE IF NOT EXISTS topology_zone (
    zone_id      INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL,
    bg_color     TEXT DEFAULT '#f0f5ff',
    border_color TEXT,
    border_style TEXT DEFAULT 'solid',             -- solid | dashed | none
    border_width REAL DEFAULT 1,
    parent_zone_id INTEGER,                        -- 嵌套子区域（自引用可空）
    note         TEXT,                             -- 富标注（机房/机柜编号，参考图红字）
    collapsed    INTEGER DEFAULT 0,
    x REAL, y REAL, w REAL, h REAL,                -- 人工位置/尺寸（NULL=按成员自动包络）
    sort_hint    INTEGER DEFAULT 0,                -- 初始建议层级（0=顶层往下）
    created_by   TEXT, created_at INTEGER,
    updated_by   TEXT, updated_at INTEGER
  );
  -- 链路证据 1:*（§4.3）：一条关系挂多条多类证据，半链升格不丢历史
  CREATE TABLE IF NOT EXISTS topology_link_evidence (
    evidence_id   INTEGER PRIMARY KEY AUTOINCREMENT,
    link_id       INTEGER NOT NULL REFERENCES topology_link(link_id) ON DELETE CASCADE,
    kind          TEXT NOT NULL,                   -- lldp_a | lldp_b | lldp_raw | manual_note | route_snapshot | lacp_snapshot | vrrp_snapshot | stack_snapshot
    payload       TEXT,                            -- JSON/原文（raw walk 片段等）
    source_run_id TEXT,
    observed_at   INTEGER,
    expires_at    INTEGER                          -- 预留：证据有效期（如 route 快照）
  );
  CREATE INDEX IF NOT EXISTS idx_evidence_link ON topology_link_evidence(link_id);
  -- 布局快照/回滚（§5.5）：zones+layout 全量 JSON；批量操作前自动护栏快照
  CREATE TABLE IF NOT EXISTS topology_layout_snapshot (
    snapshot_id  INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL,
    kind         TEXT DEFAULT 'manual',            -- manual | auto_pre | discovery_pre
    zones_json   TEXT NOT NULL,
    layout_json  TEXT NOT NULL,
    created_by   TEXT,
    created_at   INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_snapshot_created ON topology_layout_snapshot(created_at);
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
  // P3 全局共享布局（无外键：设备删除后保留布局历史，见 sqlite 侧注释）。
  // position_locked 在 MySQL 8.0.1+ 是保留字，sqlite 侧同款反引号写法保证 DML 双方言共用。
  `CREATE TABLE IF NOT EXISTS topology_layout (
    node_id         INT PRIMARY KEY,
    group_key       VARCHAR(64),
    x               DOUBLE,
    y               DOUBLE,
    layout_source   VARCHAR(16) DEFAULT 'auto',
    \`position_locked\` INT DEFAULT 0,
    updated_by      VARCHAR(128),
    updated_at      BIGINT,
    INDEX idx_layout_group (group_key)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS topology_group (
    group_key  VARCHAR(64) PRIMARY KEY,
    label      VARCHAR(128),
    collapsed  INT DEFAULT 0,
    x          DOUBLE, y DOUBLE, w DOUBLE, h DOUBLE,
    updated_at BIGINT
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  // ===== V2（设计 §7，与 sqlite 侧成对）=====
  `CREATE TABLE IF NOT EXISTS topology_zone (
    zone_id       INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    name          VARCHAR(128) NOT NULL,
    bg_color      VARCHAR(32) DEFAULT '#f0f5ff',
    border_color  VARCHAR(32),
    border_style  VARCHAR(16) DEFAULT 'solid',
    border_width  DOUBLE DEFAULT 1,
    parent_zone_id INT,
    note          TEXT,
    collapsed     INT DEFAULT 0,
    x             DOUBLE, y DOUBLE, w DOUBLE, h DOUBLE,
    sort_hint     INT DEFAULT 0,
    created_by    VARCHAR(128), created_at BIGINT,
    updated_by    VARCHAR(128), updated_at BIGINT
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS topology_link_evidence (
    evidence_id   INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    link_id       INT NOT NULL,
    kind          VARCHAR(32) NOT NULL,
    payload       LONGTEXT,
    source_run_id VARCHAR(64),
    observed_at   BIGINT,
    expires_at    BIGINT,
    INDEX idx_evidence_link (link_id),
    CONSTRAINT fk_ev_link FOREIGN KEY (link_id) REFERENCES topology_link(link_id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS topology_layout_snapshot (
    snapshot_id  INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    name         VARCHAR(128) NOT NULL,
    kind         VARCHAR(16) DEFAULT 'manual',
    zones_json   LONGTEXT NOT NULL,
    layout_json  LONGTEXT NOT NULL,
    created_by   VARCHAR(128),
    created_at   BIGINT,
    INDEX idx_snapshot_created (created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
];

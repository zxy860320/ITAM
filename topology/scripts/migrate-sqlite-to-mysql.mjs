// sqlite → MySQL 数据迁移（一次性）。
// 用法（本地）：在仓库根执行
//   node topology/scripts/migrate-sqlite-to-mysql.mjs
// 用法（服务器 compose）：
//   docker compose --profile tools run --rm migrate
// 环境变量：
//   TOPO_SQLITE   源 sqlite 文件（默认 topology/data/topology.db）
//   MYSQL_HOST / MYSQL_PORT / MYSQL_USER / MYSQL_PASSWORD / MYSQL_DATABASE
// 说明：
// - 按 FK 顺序导入六表，保留显式自增 ID（node_id/interface_id/...）；
// - 幂等：ON DUPLICATE KEY UPDATE 覆盖非主键列，可重复执行；
// - speed_bps 实测存在 >2^53 脏值，读取用 setReadBigInts 防 RangeError，
//   mysql2 直接接受 BigInt 参数写入 BIGINT 列。
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

const SQL_FILE = process.env.TOPO_SQLITE || path.join(ROOT, 'topology', 'data', 'topology.db');
const MY = {
  host: process.env.MYSQL_HOST || '127.0.0.1',
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER || 'topology',
  password: process.env.MYSQL_PASSWORD || '',
  database: process.env.MYSQL_DATABASE || 'ityw_topology',
};

// 表顺序 = FK 依赖顺序；主键列用于 ON DUPLICATE KEY UPDATE 时跳过
const TABLES = [
  { name: 'topology_node', pk: ['node_id'] },
  { name: 'topology_interface', pk: ['interface_id'] },
  { name: 'topology_link', pk: ['link_id'] },
  { name: 'topology_discovery_record', pk: ['record_id'] },
  { name: 'topology_metric_mapping', pk: ['mapping_id'] },
  { name: 'topo_meta', pk: ['k'] },
];

if (!fs.existsSync(SQL_FILE)) {
  console.error(`[migrate] sqlite 文件不存在: ${SQL_FILE}`);
  process.exit(1);
}
console.log(`[migrate] src=${SQL_FILE}`);
console.log(`[migrate] dst=mysql://${MY.host}:${MY.port}/${MY.database}`);

const { DatabaseSync } = await import('node:sqlite');
const mysql = await import('mysql2/promise');

const src = new DatabaseSync(SQL_FILE, { readOnly: true });
const pool = await mysql.createPool({
  ...MY, waitForConnections: true, connectionLimit: 5,
  charset: 'utf8mb4', decimalNumbers: true, multipleStatements: false, connectTimeout: 10000,
});

// 等目标库六表就绪（DDL 由 topology-svc 启动时创建，compose 里可能有几秒竞态）
const want = TABLES.map(t => t.name);
for (let i = 1; i <= 30; i++) {
  const [rows] = await pool.query(
    'SELECT COUNT(*) cnt FROM information_schema.tables WHERE table_schema=? AND table_name IN (?)',
    [MY.database, want]);
  if (rows[0].cnt >= want.length) break;
  if (i === 30) throw new Error(`目标库 ${MY.database} 缺表（找到 ${rows[0].cnt}/${want.length}），请先启动 topology 服务建表`);
  console.log(`[migrate] 等待 topology 建表... ${rows[0].cnt}/${want.length}`);
  await new Promise(r => setTimeout(r, 2000));
}

await pool.query('SET FOREIGN_KEY_CHECKS=0');
let grand = 0;
try {
  for (const { name, pk } of TABLES) {
    const cols = src.prepare(`PRAGMA table_info(${name})`).all().map(c => c.name);
    const stmt = src.prepare(`SELECT * FROM ${name}`);
    if (typeof stmt.setReadBigInts === 'function') stmt.setReadBigInts(true);
    const rows = stmt.all();

    const nonPk = cols.filter(c => !pk.includes(c));
    const upsert = nonPk.length
      ? ` ON DUPLICATE KEY UPDATE ${nonPk.map(c => `${c}=VALUES(${c})`).join(',')}`
      : ` ON DUPLICATE KEY UPDATE ${pk[0]}=${pk[0]}`;

    let n = 0;
    const CHUNK = 500;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      // 多行 VALUES：一份 SQL 带 n×cols 个占位符
      const multi = `INSERT INTO ${name} (${cols.join(',')}) VALUES `
        + chunk.map(() => `(${cols.map(() => '?').join(',')})`).join(',')
        + upsert;
      const args = chunk.flatMap(r => cols.map(c => r[c] ?? null));
      await pool.query(multi, args);
      n += chunk.length;
    }

    const [[{ cnt }]] = await pool.query(`SELECT COUNT(*) cnt FROM ${name}`);
    console.log(`[migrate] ${name}: moved=${n} srcTotal=${rows.length} mysqlNow=${cnt}`);
    if (cnt < rows.length) throw new Error(`${name}: mysql 行数(${cnt}) < sqlite 行数(${rows.length})，迁移不完整`);
    grand += rows.length;
  }
} finally {
  await pool.query('SET FOREIGN_KEY_CHECKS=1');
  await pool.end();
  src.close();
}
console.log(`[migrate] DONE total=${grand} rows`);

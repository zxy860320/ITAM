// topology-svc 配置：Zabbix 凭据复用 P0 的 server/data/source.json（只读，不写入）
// 存储引擎：TOPO_DB=mysql → MySQL（MYSQL_HOST/PORT/USER/PASSWORD/DATABASE）；
// 否则 TOPO_DB 视为 sqlite 文件路径（缺省 topology/data/topology.db，本地开发默认）。
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

const SRC_CFG = process.env.ZBX_SOURCE_CFG || path.join(ROOT, 'server', 'data', 'source.json');
let zbx = { endpoint: '', token: '' };
try {
  const c = JSON.parse(fs.readFileSync(SRC_CFG, 'utf-8'));
  zbx = { endpoint: c.endpoint, token: c.token };
} catch { /* 无 P0 配置文件时置空，/health 会报告 */ }

export const CFG = {
  port: Number(process.env.TOPO_PORT || 8790),
  dbKind: String(process.env.TOPO_DB || '').toLowerCase() === 'mysql' ? 'mysql' : 'sqlite',
  dbFile: process.env.TOPO_DB || path.join(ROOT, 'topology', 'data', 'topology.db'),
  mysql: {
    host: process.env.MYSQL_HOST || '127.0.0.1',
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER || 'topology',
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DATABASE || 'ityw_topology',
  },
  zbx,
  // LLDP 临时采样 walk 的 OID 集（P2-M1 修正 2026-10-25：v1 中 5/7 OID 无效——
  // 标量实例应是 .3.1.0/.3.2.0（v1 的 .3.0 不存在）；rem 列缺 Entry 层，正确为 .4.1.1.<col>。
  // 实测对照（S5590）：错误 .4.1.5 walk=0 行；正确 .4.1.1 walk=34 行/29 邻居。
  // walk 子树：stats(.2 含 RemTables 标量与 Tx/Rx 计数——四态分级证据 §2.3)、
  // loc chassisIdSubtype+chassisId(.3.1/.3.2 标量实例)、locPortTable(.3.7.1 全列)、remTable(.4.1.1 全列)
  lldpWalk: 'walk[1.0.8802.1.1.2.1.2,1.0.8802.1.1.2.1.3.1,1.0.8802.1.1.2.1.3.2,'
    + '1.0.8802.1.1.2.1.3.7.1,1.0.8802.1.1.2.1.4.1.1]',
  // 网络主机判定：链接模板名包含以下字样
  netTemplateRe: /by SNMP/i,
};

# ITYW Docker Compose 部署指南（Linux 服务器）

架构：`web(nginx :80)` 静态托管前端并反代 `/api → server:8787`、`/topo-api/ → topology:8790/api/`；
`topology-svc` 存储用 **MySQL 8.0**（本地开发仍可留在 sqlite，引擎由 `TOPO_DB` 切换）；
`server(P0)` 的 JSON 配置（source/notify/采样）全部走卷挂载，镜像内不含任何凭据。

```
浏览器 → web(nginx:80)
           ├─ /api/*       → server:8787      (P0 监控)
           ├─ /topo-api/*  → topology:8790    (P1 拓扑，nginx 去前缀)
           └─ 静态文件      → /usr/share/nginx/html
topology:8790 → mysql:3306 (ityw_topology 库，六表)
server / topology → Zabbix http://10.25.6.8:8080（source.json 提供 token）
server → dbmp zCloud http://10.70.0.94:8023（source.json 的 dbmp 节）
```

## 0. 服务器前置

- Linux + Docker ≥ 24（compose v2 内置）；服务器可达 Zabbix `10.25.6.8:8080` 与 zCloud `10.70.0.94:8023`。
- 拉取代码：`git clone https://github.com/zxy860320/ITAM.git ityw && cd ityw`。

## 1. 凭据与配置（三个文件，均不入库）

```bash
cp .env.example .env                    # 改 MYSQL_ROOT_PASSWORD / MYSQL_PASSWORD
mkdir -p server/data
# Zabbix 数据源（P0 对接页也可在部署后在线改，改后写回该文件）：
cat > server/data/source.json <<'EOF'
{
  "mode": "zabbix",
  "endpoint": "http://10.25.6.8:8080/api_jsonrpc.php",
  "token": "<Zabbix API token>",
  "freq": 60,
  "dbmp": { "enabled": true, "base": "http://10.70.0.94:8023" }
}
EOF
# 告警出口（钉钉/飞书/企微/邮件）可部署后经前端“告警出口”页配置，写 server/data/notify.json
chmod 600 .env server/data/source.json
```

`topology-svc` 只读挂载同一份 `source.json` 拿 Zabbix token（`ZBX_SOURCE_CFG=/app/config/source.json`），从不写它。

## 2. 构建与启动

```bash
docker compose build            # server / topology / web 三个镜像
docker compose up -d            # mysql 健康后依次拉起 server、topology、web
docker compose ps               # 全部 Up；mysql (healthy)
```

访问 `http://<服务器IP>/`。健康检查端点：

- `curl http://127.0.0.1/api/source`（经 nginx，P0）
- `docker compose exec topology node -e "fetch('http://127.0.0.1:8790/health').then(r=>r.json()).then(j=>console.log(j.db_kind, j.db, j.zbx_connected))"`
  —— 应输出 `mysql mysql://mysql:3306/ityw_topology true`
  （注意：topology 的 `/health` 挂在根路径；前端经 nginx 的调用全是 `/topo-api/topology/*` → `/api/topology/*`）

## 3. 数据迁移（可选，把本机 sqlite 里的拓扑现状带上服务器）

前提：把本地 `topology/data/topology.db` scp 到服务器同路径。表 DDL 由 topology-svc 启动时自动创建，
所以先 `up -d` 确认 topology 起来，再跑迁移（脚本按 FK 顺序导入六表、保留显式 ID、幂等可重跑，
每表校验 MySQL 行数 ≥ sqlite 行数）：

```bash
docker compose --profile tools run --rm migrate
```

迁移后前端“拓扑”“链路审核”页应立即看到与本地一致的设备/链路；之后本地 sqlite 即弃用。
不迁移也可以：服务器上手动“同步设备 → 发现 LLDP → 审核”从零积累。

## 4. 升级 / 回滚 / 备份

```bash
git pull && docker compose build && docker compose up -d   # 升级
docker compose down                                        # 停止（数据在 mysql_data 卷与 ./server/data）
docker compose exec mysql mysqldump -uroot -p ityw_topology | gzip > topo-$(date +%F).sql.gz  # 备份
```

## 5. 常见问题

- **topology 启动即退出**：看 `docker compose logs topology`。`SELECT 1` 连接失败会重试 30 次×2s；
  若最终失败，多为 .env 密码与 mysql 卷已初始化的旧密码不一致——改 .env 或 `docker compose down -v` 清卷重来。
- **`/topo-api/*` 全部 404**：nginx 的 `location /topo-api/` 与 `proxy_pass .../api/` 尾部斜杠必须成对，勿改。
- **邮件通道**：服务器出网 25 端口常被云厂商封，SMTP 用 465(SSL) 或 587；配置在告警出口页保存后需打开总开关。
- **迁移报 RangeError**：不会——脚本对 node:sqlite 开了 `setReadBigInts`（speed_bps 实测有 4×10^16 脏值，超 JS 安全整数）。
- **端口冲突**：改 .env 的 `WEB_PORT`；server/topology/mysql 默认不映射宿主机端口，仅 nginx 80 对外。

## 6. 镜像构成

| 服务 | 基础镜像 | 说明 |
|---|---|---|
| server | node:22-alpine | `npm ci --omit=dev`，仅 express+nodemailer；配置全靠卷 |
| topology | node:22-alpine | express+mysql2；`TOPO_DB=mysql`；scripts/ 打入镜像供 migrate 复用 |
| web | node:22-alpine → nginx:1.27-alpine | `vite build` 产物拷入 nginx；nginx.conf 复刻 vite 代理规则 |
| mysql | mysql:8.0 | utf8mb4；命名卷 `mysql_data`；healthcheck 供 topology depends_on |

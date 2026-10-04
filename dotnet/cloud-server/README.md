# cyrene-cloud-server —— 云端昔涟 Phase 1 服务端（IKJK2J）

事件库 + `/v1/sync` push / fetch / clone；契约 = 同步协议 v0
（`docs/specs/2026-10-04-sync-protocol-v0.md` + `fixtures/sync-protocol/`）。

## 裸跑（推荐主路线）

```bash
# ① 发布（仓库根；VPS 已装 ASP.NET Core Runtime 10 + libicu）
dotnet publish dotnet/cloud-server -c Release -o ./artifacts/cyrene-cloud
#    不想装运行时 → 自包含：-r linux-x64 --self-contained true（体积换零依赖）

# ② VPS 部署（system 用户 + 0700 数据目录 + 产物）
sudo useradd --system --home-dir /opt/cyrene-cloud --shell /usr/sbin/nologin cyrene || true
sudo install -d -o cyrene -g cyrene -m 700 /var/lib/cyrene-cloud
sudo rsync -a --delete ./artifacts/cyrene-cloud/ /opt/cyrene-cloud/

# ③ systemd（单元在仓库 dotnet/cloud-server/deploy/，拷到 VPS 执行）
sudo cp dotnet/cloud-server/deploy/cyrene-cloud-server.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now cyrene-cloud-server
journalctl -u cyrene-cloud-server -f

# ④ 验证 + 反代（TLS）
curl http://127.0.0.1:7789/healthz
caddy run --config dotnet/cloud-server/deploy/Caddyfile.example   # 同机反代；IKJK2K 接管暴露面
```

systemd 单元内置（`deploy/cyrene-cloud-server.service`）：`ASPNETCORE_URLS=http://127.0.0.1:7789`、
`CYRENE_CLOUD_DATA=/var/lib/cyrene-cloud`、`Restart=always`、`LimitNOFILE=65536`、`MemoryHigh=384M`、
`MemoryMax=512M`、`UMask=0077`、`ProtectSystem=strict`（仅数据目录可写）、日志走 journald。

## 本地运行（开发）

```bash
dotnet build dotnet/cloud-server -c Release
CYRENE_CLOUD_DATA=./data dotnet dotnet/cloud-server/bin/Release/net10.0/cyrene-cloud-server.dll
# 默认 http://127.0.0.1:7789（--urls / ASPNETCORE_URLS 可覆盖）
```

### 环境变量

| 变量 | 说明 |
| --- | --- |
| `CYRENE_CLOUD_DATA` | 数据目录（`events.db`；默认 `AppContext.BaseDirectory/data`） |
| `CLOUD_TOKEN` | 非空时 `/v1/*` 与**远程** `/healthz` 需 `Authorization: Bearer <token>`（scheme 大小写不敏感；回环探针豁免）。IKJK2K 配对制将取代它 |
| `ASPNETCORE_URLS` | 监听地址（默认 `http://127.0.0.1:7789`） |

## 容器（备选）

```bash
cd dotnet/cloud-server
docker compose up -d --build
curl http://127.0.0.1:7789/healthz
```

`mem_limit 512m` + healthcheck + `restart: unless-stopped` + 日志上限（json-file 10m×3）；
同样仅绑 `127.0.0.1`，反代见 `deploy/Caddyfile.example`。
镜像内以非 root（`cyrene`，uid 10001）运行；命名卷 `cloud-data` 首次初始化会继承 `/data` 属主，
若改 bind mount 需自行 `chown 10001`。

## API（camelCase JSON）

- `GET /healthz` → `{status, rssMB, cursor}`（cursor 为 O(1) 插入序游标；`CLOUD_TOKEN` 非空时远程访问需令牌、回环探针豁免）
- `POST /v1/sync/push` — body 为 JSONL 事件批（协议 v0 读取语义）；整批原子：
  - `400 E_SYNC_BATCH_INVALID`：JSON 坏行 / 半截尾行 / 字段级校验失败（`errors:[{index,code}]`，`index` = 输入 JSONL 0 基物理行号）
  - `400 E_SYNC_BATCH_REJECTED`：链/序号校验失败（`E_SYNC_CHAIN` / `E_SYNC_SEQ`；`index` 同上，与 BATCH_INVALID 统一为物理行号）
  - `413 E_SYNC_BATCH_TOO_LARGE`：请求体超上限（10MB；客户端应切小批重推）
  - `200 {accepted, duplicates, cursor}`：重复 eventId 幂等跳过（批内重复由读取器丢弃；跨批重复计入 `duplicates`）
- `GET /v1/sync/fetch?since=<cursor>&limit=<1..1000>&sessionId=<可选>` →
  `{events, cursor, hasMore}`（插入序；`cursor` 不透明，客户端原样回传）
- `GET /v1/sync/clone?sessionId=<可选>` — 全量 JSONL 流（每行一个事件）；游标在
  `X-Sync-Cursor` 响应头，同时作为**流内容快照上界**（并发写入的事件由后续 fetch 接力），
  clone 后从该游标走 fetch 增量。
  注意：游标是**全局插入序**——带了 `sessionId` 的 clone，后续 fetch 必须带同一 `sessionId`，
  否则会跳过其他会话中 id 更小的事件

客户端收敛：拉取后按 `(lamport, deviceId, seq)` 重排（协议 v0 读取语义），
离线分叉两端最终收敛到同一全序。

## 链校验（v0 过渡策略）

- per-(sessionId, deviceId) 链接；`hash` 为「已上链」标记（客户端计算，服务端不重算内容哈希——Q3 待定稿）；
- 已上链事件：有链尾 ⇒ `prevHash` 必须等于链尾 `hash`；无链尾 ⇒ `prevHash` 必须缺省；
- 未上链事件：`prevHash` 必须缺省；过渡期允许与已上链事件混用；
- 同 (sessionId, deviceId) 的 `seq` 严格递增；重复 `eventId` 幂等跳过。

## 持久性

SQLite WAL + `synchronous=FULL`：push 返回 200 的事件（已提交）断电后不丢；备份/恢复演练属 IKJK2N。

## 内存预算口径

| 数字 | 含义 |
| --- | --- |
| `MemoryMax=512M` / `mem_limit 512m` | cloud-server **单进程硬上限**（OOM kill 阈值） |
| `2G 预算` | **VPS 整机**内存预算（含反代、运行时、其他 sidecar） |
| 冒烟参考阈值 `300MB` | 仅作告警输出，**不作为 CI pass/fail 门禁**（专用性能任务判定） |

## 测试

```bash
dotnet build dotnet/cloud-server -c Release     # 或按「裸跑」先 publish
python scripts/dotnet-cloud-sync-test.py        # 起真实服务：并发收敛/幂等/分页/clone/链校验
python scripts/dotnet-cloud-sync-test.py <发布目录>/cyrene-cloud-server.dll   # 裸产物直测
```

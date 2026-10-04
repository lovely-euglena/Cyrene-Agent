# cyrene-cloud-server —— 云端昔涟 Phase 1 服务端（IKJK2J）

事件库 + `/v1/sync` push / fetch / clone；契约 = 同步协议 v0
（`docs/specs/2026-10-04-sync-protocol-v0.md` + `fixtures/sync-protocol/`）。

## 本地运行

```bash
dotnet build dotnet/cloud-server -c Release
CYRENE_CLOUD_DATA=./data dotnet dotnet/cloud-server/bin/Release/net10.0/cyrene-cloud-server.dll
# 默认 http://127.0.0.1:7789（可用 --urls / ASPNETCORE_URLS 覆盖）
```

| 环境变量 | 说明 |
| --- | --- |
| `CYRENE_CLOUD_DATA` | 数据目录（`events.db`，默认 `AppContext.BaseDirectory/data`） |
| `CLOUD_TOKEN` | 非空时 `/v1/*` 需 `Authorization: Bearer <token>`（IKJK2K 前的最小门闩） |
| `ASPNETCORE_URLS` | 监听地址（默认 `http://127.0.0.1:7789`） |

## API（camelCase JSON）

- `GET /healthz` → `{status, rssMB, events}`
- `POST /v1/sync/push` — body 为 JSONL 事件批（协议 v0 读取语义）；整批原子：
  - `400 E_SYNC_BATCH_INVALID`：JSON 坏行 / 半截尾行 / 字段级校验失败（`errors:[{index,code}]`）
  - `400 E_SYNC_BATCH_REJECTED`：链/序号校验失败（`E_SYNC_CHAIN` / `E_SYNC_SEQ`）
  - `200 {accepted, duplicates, cursor}`：重复 eventId 幂等跳过
- `GET /v1/sync/fetch?since=<cursor>&limit=<1..1000>&sessionId=<可选>` →
  `{events, cursor, hasMore}`（插入序；`cursor` 不透明，客户端原样回传）
- `GET /v1/sync/clone?sessionId=<可选>` — 全量 JSONL 流（每行一个事件），游标在
  `X-Sync-Cursor` 响应头；新设备 clone 后从该游标走 fetch 增量

客户端收敛：拉取后按 `(lamport, deviceId, seq)` 重排（协议 v0 读取语义），
离线分叉两端最终收敛到同一全序。

## 链校验（v0 过渡策略）

- per-(sessionId, deviceId) 链接；`hash` 为「已上链」标记（客户端计算，服务端不重算内容哈希——Q3 待定稿）；
- 已上链事件：有链尾 ⇒ `prevHash` 必须等于链尾 `hash`；无链尾 ⇒ `prevHash` 必须缺省；
- 未上链事件：`prevHash` 必须缺省；过渡期允许与已上链事件混用；
- 同 (sessionId, deviceId) 的 `seq` 严格递增；重复 `eventId` 幂等跳过。

## 容器（compose）

```bash
cd dotnet/cloud-server
docker compose up -d --build
curl http://127.0.0.1:7789/healthz
```

`mem_limit 512m` + healthcheck + `restart: unless-stopped` + 日志上限（json-file 10m×3）；
仅绑 `127.0.0.1` 对外端口，TLS 终结见 `Caddyfile.example`（IKJK2K 接管暴露面）。

## 测试

```bash
python scripts/dotnet-cloud-sync-test.py   # 起真实服务：并发收敛/幂等/分页/clone/链校验
```

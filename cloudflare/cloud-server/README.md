# cyrene-cloud-cf — 云端昔涟 CF 版（IKJN79）

Cloudflare Workers + Durable Objects(SQLite) 的服务端实现，与 .NET 完整版共享同一协议
（`docs/specs/2026-10-04-sync-protocol-v0.md`）与一致性套件（`scripts/dotnet-cloud-sync-test.py` 核心档）。

- 端点：`/healthz`、`/v1/capabilities`（impl=cf-workers）、`/v1/pair/code`、`/v1/pair`、
  `/v1/devices[...]`、`/v1/sync/push|fetch|clone`；
- 鉴权：device token（配对签发 / 撤销 / 轮换）+ 主控令牌；DO 内固定窗口限流（pair 10/min、sync 300/min）；
- 存储：单租户单 DO（`global`）SQLite——事件表（插入序游标）/ 设备 / 配对码 / 限流 / 生成队列；
- 生成：push 触发 → DO alarm 处理与退避重试；`CLOUD_LLM_MODE=echo` 为内置回声 mock（测试部署），
  设置 `CLOUD_LLM_API_KEY` 后走 OpenAI 兼容接口；
- PWA：Workers 静态资产（`assets/`，构建产出），缓存头 / CSP 由 Worker 统一控制（与 .NET 静态托管一致）。

## 本地开发与验证

前置：Node 24+；`src/pwa` 已安装依赖（`npm --prefix src/pwa ci`）。

```bash
cd cloudflare/cloud-server
npm ci
npm run check          # tsc 类型检查
npm test               # 单测（重放 / 配对码 / 设备名 / 哈希）

npm run assets:build   # 构建 PWA 到 ./assets（复用 src/pwa 的 Vite 构建）

# 本地密钥（.dev.vars，gitignored）：
#   CLOUD_TOKEN=smoke-master
#   CLOUD_LLM_MODE=echo
npx wrangler dev --port 8787 --ip 127.0.0.1
```

另开终端跑验收（与 .NET 版同一套件）：

```bash
python scripts/dotnet-cloud-sync-test.py --base-url http://127.0.0.1:8787 --master-token smoke-master
node scripts/pwa-e2e-test.mjs --base-url http://127.0.0.1:8787 --master-token smoke-master --expect-echo
```

## 部署

```bash
cd cloudflare/cloud-server
npx wrangler login                       # 或配置 CLOUDFLARE_API_TOKEN
npx wrangler secret put CLOUD_TOKEN      # 主控令牌（签发/管理设备与配对码）
# 真实生成：npx wrangler secret put CLOUD_LLM_API_KEY（+ 可选 CLOUD_LLM_MODEL / CLOUD_LLM_BASE_URL）
npm run deploy                           # 构建资产 + wrangler deploy
# 测试部署（回声 mock，不调外部模型）：
#   npm run assets:build && npx wrangler deploy --var CLOUD_LLM_MODE:echo
```

- 自定义域在 `wrangler.toml` 的 `routes` 配置（默认 `cyrene-cloud.ygwill.asia`），部署自动创建 DNS 与证书。
  **证书覆盖**：3 级子域（`*.ygwill.asia`）走通用证书；4 级子域不在覆盖内，TLS 握手 alert 40
  （IKJN3W 实测）——需独立子 zone / ACM / 已覆盖域名。
- **Bot Fight Mode**：开启时会拦脚本 UA（403/1010）。脚本客户端需用 `--user-agent` 传浏览器 UA
  （核心档套件 / e2e 均支持），或关闭 BFM（Free 计划无法按路径豁免）；生产使用建议关闭 BFM 或独立 zone
  ——桌面端同步客户端同为非浏览器 UA。
- 部署实例验收：

```bash
python scripts/dotnet-cloud-sync-test.py --base-url https://<域> --master-token <TOKEN>
node scripts/pwa-e2e-test.mjs --base-url https://<域> --master-token <TOKEN> --expect-echo
```

## 运维

- 日志：`npx wrangler tail`；错误只记会话 id / 状态码，不记消息正文与密钥；
- 数据：DO SQLite（单实例）；导出 = 调 `/v1/sync/clone`（JSONL 全量，游标在 `X-Sync-Cursor`）；
- 环境变量：见 `src/env.ts` 与 `wrangler.toml` 注释（`CLOUD_PAIR_TTL_SECONDS` / `CLOUD_RATE_*` /
  `CLOUD_LLM_*` / `CLOUD_ALLOWED_HOSTS` / `CLOUD_DIALOG_*`）；
- 与 .NET 版差异：`healthz.rssMB` 恒 0（Workers 无进程 RSS 概念）；生成重试由 DO alarm 承担；
  限流为 DO 固定窗口（CF 平台另有边缘限流）。

## 结构

```
src/worker.ts   入口：路由 / 能力声明 / 静态托管 / 转发 DO
src/store.ts    CloudStore DO：事件库 / 鉴权 / 配对 / 限流 / 生成闭环
src/replay.ts   事件重放（与 .NET DialogLoop.Replay 对齐）
src/util.ts     随机 / 哈希 / 配对码 / 设备名
test/           单测（vitest）
scripts/build-assets.mjs   PWA → assets
```

# cyrene-cloud-php — 云端昔涟 PHP 空间版（IKJN7C）

面向国内虚拟主机场景的服务端实现（L1 同步核心 + L2 鉴权/配对；生成降级为 inline）。
与 .NET / CF 版共享同一协议（`docs/specs/2026-10-04-sync-protocol-v0.md`）与一致性套件
（`scripts/dotnet-cloud-sync-test.py` 核心档）；协议读取器与 TS / C# 跑同一组
fixtures（`fixtures/sync-protocol/cases`，tests/run.php 执行）。

- 端点：`/healthz`、`/v1/capabilities`（impl=php-shared）、`/v1/pair/code`、`/v1/pair`、
  `/v1/devices[...]`、`/v1/sync/push|fetch|clone`；SQLite 自增 id = 服务端游标；
- 鉴权：device token（配对签发 / 撤销 / 轮换）+ 主控令牌；SQLite 固定窗口限流（pair 10/min、sync 300/min）；
- 生成（inline 降级）：push 内联尽力（受 `max_execution_time` 预算约束），超时/失败挂起
  `dialog_pending`，由 `bin/drain.php`（cron）重试；`CLOUD_LLM_MODE=echo` 为回声 mock，
  `CLOUD_LLM_API_KEY` 走 OpenAI 兼容接口；桌面端在线兜底生成；
- PWA：同空间静态托管（`public/` 下产物，缓存头 / CSP 与 .NET / CF 口径一致）。

## 结构

```
public/          站点根：index.php（入口/路由/静态托管）+ .htaccess + PWA 构建产物（gitignore）
lib/             实现（util / config / protocol / store / auth / dialog / server）
bin/drain.php    挂起生成排空（cron）
tests/run.php    零依赖测试（fixtures + 工具 + 集成）
scripts/build-assets.mjs   PWA → public/（复用 src/pwa 构建）
data/            SQLite 数据目录（gitignore；须可写且 deny 直读）
```

## 本地运行（便携 PHP）

前置：PHP 8.1+（`pdo_sqlite` / `mbstring` / `curl`）；PWA 资产：

```bash
npm --prefix src/pwa ci
node php/cloud-server/scripts/build-assets.mjs

php php/cloud-server/tests/run.php          # 单测（fixtures + 工具 + 集成）

# 启动（生成关闭）
CLOUD_TOKEN=smoke-master php -S 127.0.0.1:8088 -t php/cloud-server/public php/cloud-server/public/index.php
# Windows PowerShell：
#   $env:CLOUD_TOKEN='smoke-master'
#   php -S 127.0.0.1:8088 -t php/cloud-server/public php/cloud-server/public/index.php

# 验收（与 .NET / CF 同一套件）
python scripts/dotnet-cloud-sync-test.py --base-url http://127.0.0.1:8088 --master-token smoke-master

# 生成档（inline echo）+ PWA e2e
#   $env:CLOUD_LLM_MODE='echo' 后重启服务
node scripts/pwa-e2e-test.mjs --base-url http://127.0.0.1:8088 --master-token smoke-master --expect-echo
```

> 注：`pair` 分组限流默认 10 次/分钟（与 .NET / CF 同口径）。同一实例 1 分钟内重复跑
> 「套件 + e2e」可能触发 429（e2e 会给出明确诊断）；等待下一分钟或临时调大
> `CLOUD_RATE_PAIR_PER_MIN` 即可。

## 配置（环境变量；或 `php/cloud-server/config.local.php` 返回覆盖数组）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `CYRENE_CLOUD_DATA` | `php/cloud-server/data` | SQLite 数据目录（须可写） |
| `CLOUD_TOKEN` | 空 | 主控令牌（签发/管理设备与配对码） |
| `CLOUD_ALLOWED_HOSTS` | 空 | 域名白名单（逗号分隔；空 = 不限制；回环豁免） |
| `CLOUD_PAIR_TTL_SECONDS` | `300` | 配对码有效期 |
| `CLOUD_RATE_SYNC_PER_MIN` / `CLOUD_RATE_PAIR_PER_MIN` | `300` / `10` | 固定窗口限流 |
| `CLOUD_LLM_MODE` | 空 | `echo` = 回声 mock（测试部署） |
| `CLOUD_LLM_API_KEY` / `CLOUD_LLM_MODEL` / `CLOUD_LLM_BASE_URL` | 空 / `gpt-4o-mini` / OpenAI | 真实生成（OpenAI 兼容） |
| `CLOUD_LLM_SYSTEM_PROMPT` / `CLOUD_LLM_CONTEXT_CHARS` / `CLOUD_LLM_MAX_TOKENS` / `CLOUD_LLM_TIMEOUT_SECONDS` | 空 / `24000` / `1024` / `60` | 生成参数 |

## 真实虚拟主机部署

1. 上传 `php/cloud-server/` 到空间，**把域名站点根指向 `public/`**（`lib/`、`bin/`、`data/`
   在 webroot 之外）；`public/.htaccess` 已含 API 重写与静态缓存/CSP 头；
2. `data/` 须可写（SQLite WAL；入口 / cron 会 `umask(0077)` 并 best-effort 设目录 0700、库文件 0600）；
   若空间只允许单一 webroot，请把 `data/` 放到 webroot 之外，
   并用 `CYRENE_CLOUD_DATA` 或 `config.local.php` 指定绝对路径（`data/.htaccess` 已含 deny 兜底）；
3. 设 `CLOUD_TOKEN`（可在 `config.local.php` 返回 `['master_token' => '...']`）；
4. 可选 cron：`* * * * * php /path/to/php/cloud-server/bin/drain.php >> /path/drain.log 2>&1`；
5. 备份 = 复制 `data/events.db`（或调 `/v1/sync/clone` 导出 JSONL）。

## 与 .NET / CF 版差异

- 游标同为插入序（SQLite AUTOINCREMENT）；生成档 = `inline`（非 realtime）；PWA 同空间静态；
- 限流为 SQLite 固定窗口（绝对分钟对齐；匿名分区 = 客户端 IP，回环信任 `X-Forwarded-For` **最右**一跳
  ——与 .NET `ForwardedHeaders` ForwardLimit=1 口径一致；已认证分区 = 主控 / deviceId）；
  无 CF 边缘限流；`healthz.rssMB` = PHP 内存峰值（非进程 RSS）；
- healthz：回环直连免鉴权；同机反代下按 XFF 最右跳判定真实客户端（外部客户端仍 401，与 .NET 对齐）；
- 内联生成受 `max_execution_time` 约束：放不下即挂起（cron/桌面兜底），不阻塞同步；
- 存储加固：入口 / cron `umask(0077)` + 目录 0700 + `events.db`/`-wal`/`-shm` 0600
  （best-effort；Linux / CI 有权限断言）；
- 并发写：`BEGIN IMMEDIATE` + `busy_timeout=5000`（`php -S` 串行；PHP-FPM 多 worker 下亦安全）；
- 静态托管不回显 `.php` / `.htaccess` / 点文件（404）；
- 单请求单进程（`php -S` 串行）；生产建议 PHP-FPM + 反向代理（`.htaccess` 模板为 Apache 2.4+ 语法）。

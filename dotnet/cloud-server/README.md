# cyrene-cloud-server —— 云端昔涟 Phase 1 服务端（IKJK2J / IKJK2K / IKJK2M / IKJK2L）

事件库 + `/v1/sync` push / fetch / clone + 手机 PWA 静态托管；契约 = 同步协议 v0
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
| `CYRENE_CLOUD_DATA` | 数据目录（`events.db`：事件 + 设备/配对码；默认 `AppContext.BaseDirectory/data`） |
| `CLOUD_TOKEN` | 主控令牌（可选；引导/运维）：非空时可用它鉴权与出码 |
| `CLOUD_PAIR_TTL_SECONDS` | 配对码有效期（默认 300 秒） |
| `CLOUD_ALLOWED_HOSTS` | Host 白名单（逗号分隔；回环始终放行；不设 = 不校验，生产建议设置） |
| `CLOUD_RATE_PAIR_PER_MIN` / `CLOUD_RATE_SYNC_PER_MIN` | 限流阈值/分钟（默认 10 / 300） |
| `CLOUD_LLM_API_KEY` | 服务端模型密钥（非空即启用生成；只在服务端、不落日志） |
| `CLOUD_LLM_MODEL` / `CLOUD_LLM_BASE_URL` | 模型名（默认 `gpt-4o-mini`）/ OpenAI 兼容端点（默认官方） |
| `CLOUD_LLM_TIMEOUT_SECONDS` / `CLOUD_LLM_MAX_TOKENS` / `CLOUD_LLM_CONTEXT_CHARS` | 生成参数（默认 60 / 1024 / 24000） |
| `CLOUD_LLM_SYSTEM_PROMPT` | 可选系统提示词（默认无） |
| `ASPNETCORE_URLS` | 监听地址（默认 `http://127.0.0.1:7789`） |

## 配对与设备令牌（IKJK2K）

```text
VPS（引导）:  dotnet /opt/cyrene-cloud/cyrene-cloud-server.dll pair-code   # 或已配对设备 POST /v1/pair/code
新设备:       POST /v1/pair { code, deviceName } → { deviceId, token }      # token 仅此一次回显
```

- 库内只存 token/配对码的 SHA-256 哈希；日志全程脱敏；撤销即时生效；轮换后旧 token 立即 401；
- 命令行：`pair-code` / `devices` / `revoke <deviceId>`；容器内：
  `docker compose exec cloud-server dotnet cyrene-cloud-server.dll pair-code`；
- 安全基线：数据目录 0700 / `events.db` 0600（Linux，best-effort；systemd `UMask=0077` 兜底）、
  Host 白名单、接口限流、远程 healthz 需令牌；TLS 由 Caddy 终结（`deploy/Caddyfile.example`）。

## 服务端文本生成（IKJK2M）

`CLOUD_LLM_API_KEY` 非空即启用：push 出现新用户消息（或 `turn_rewind` 编辑/重生成）后，服务端重放该会话事件 →
活动分支消息流 → 调用模型 → 以 `deviceId=server` 写回 assistant 事件（各端 fetch 即可见）。

- **幂等**：assistant eventId = `gen-<sha256(sessionId:锚点事件id)[..32]>`；断网重试/重复触发不产生重复消息，
  预检已存在即跳过模型调用；
- **重放**：`turn_rewind(keep_user)` 裁掉锚点后的旧 assistant 尾并重生成；`replace_user` 以 replacementUser
  重建该轮；`tombstone` 移除目标轮；
- **失败重试**：模型调用 2 次退避；仍失败只记日志（无副作用残留），下一次事件会再次触发；
- **用量/脱敏**：成功日志记录模型名与 `prompt_tokens / completion_tokens`（不含消息正文）；密钥只在服务端、不进日志；
- Q2 拍板：Phase 1 用最小聊天环（不引 LoopHost/Agents），工具链留后续批次。

## 渠道托管（Phase 2 渠道批：IKJK3P / IKJK2P / IKJK2R / IKJK2S / IKJK2T）

服务端 24/7 托管渠道适配器（微信 iLink / 飞书 webhook / QQ 官方 bot 被动回复），
渠道消息进事件流（v0 `message.append` + `presentation.channelSource`），桌面/手机/服务端共享同一历史。
设计冻结：`docs/design/2026-10-05-server-channel.md`；契约 fixtures：`fixtures/channels/`。

- `CLOUD_CHANNELS` 为空 = 渠道层整体关闭（不注册存储/托管服务，零内存占用）；
  渠道托管要求服务端生成已启用（`CLOUD_LLM_API_KEY` 非空），否则状态 `config_missing` 且不拉取消息（设计 §2.4 R6）；
- 默认归属：**服务端持有**；桌面显式 claim 后租约持有（TTL 默认 180s，心跳续约，release 宽限 5s 恢复）；
  桌面在 owner=server 时绝不启动本机适配器（`channels.remote`，见下）；
- 渠道凭据服务端自持：`CLOUD_TOKEN` 非空时 `channels.db` 内 AES-GCM 加密（状态标注 `credentialProtection:"aes-gcm"`）；
  未设时降级 0600 明文（标注 `plain`，生产强烈建议设置 `CLOUD_TOKEN`）；凭据与消息正文永不进日志；
- 媒体落 `CYRENE_CLOUD_DATA/media/<渠道>/`，总量按 `CLOUD_CHANNEL_MEDIA_DIR_MB` LRU + TTL 7 天；
  媒体本体不进事件流（文本占位 `[图片]` / `[文件: name]` / `[附件: path]`）。

### 渠道环境变量（服务端）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `CLOUD_CHANNELS` | 空 | 逗号列表 `wechat,feishu,qqbot`；空 = 渠道层关闭 |
| `CLOUD_CHANNEL_OWNERSHIP_TTL_SECONDS` | 180 | 桌面认领租约 TTL（30–86400 钳制） |
| `CLOUD_CHANNEL_FAILOVER_GRACE_SECONDS` | 300 | 桌面兜底不可达宽限（服务端已解析；桌面兜底判定由桌面侧配置，本批未经 API 暴露） |
| `CLOUD_CHANNEL_WECHAT_BASE_URL` | `https://ilinkai.weixin.qq.com` | iLink 端点（扫码登录 + 协议客户端基址） |
| `CLOUD_CHANNEL_WECHAT_MEDIA_MAX_MB` | 20 | 微信入站媒体上限（图片 10 / 文件 20 分档） |
| `CLOUD_CHANNEL_FEISHU_APP_ID` / `_APP_SECRET` | 空 | 飞书应用凭据（自持；齐备才托管） |
| `CLOUD_CHANNEL_FEISHU_VERIFICATION_TOKEN` | 空 | webhook 校验（托管门槛之一） |
| `CLOUD_CHANNEL_FEISHU_ENCRYPT_KEY` | 空 | 事件解密 + 签名强制（配置后 `X-Lark-Signature` 必校验） |
| `CLOUD_CHANNEL_FEISHU_AUDIO` | 开 | `0` = 出站语音降级文本（无 ffmpeg 或体积敏感时关闭） |
| `CLOUD_CHANNEL_FEISHU_FFMPEG` / `FFMPEG_PATH` | PATH 查找 | ffmpeg 可执行文件路径（转 Ogg Opus 用） |
| `CLOUD_CHANNEL_QQBOT_APP_ID` / `_APP_SECRET` | 空 | QQ 开放平台凭据（齐备才托管；仅被动回复） |
| `CLOUD_CHANNEL_QQBOT_ALLOW_ANY_PRIVATE` / `_ALLOWED_OPENIDS` | `0` / 空 | 私聊白名单（镜像桌面语义；被拒 openid 进状态 detail） |
| `CLOUD_CHANNEL_QQBOT_STRIP_URLS` | `0` | 含链接消息发送失败时替换为 `[链接]` 的兜底开关 |
| `CLOUD_CHANNEL_VISION` | 空 | 预留（未接线、无消费点）：图片/文件当前仅事件占位文本；视觉输入（caption / 直读）为后续批次 |
| `CLOUD_CHANNEL_MEDIA_DIR_MB` | 256 | 媒体缓存总量上限 |
| `CLOUD_CHANNEL_ASR_*` / `CLOUD_CHANNEL_TTS_*` | 空 | 语音分期配置（当前 SILK 占位，未接线，见下「已知缺口」） |

> 测试注入点（生产不需要，缺省官方端点）：`CLOUD_CHANNEL_FEISHU_BASE_URL`、`CLOUD_CHANNEL_WECHAT_CDN_BASE_URL`、
> `CLOUD_CHANNEL_QQBOT_API_BASE` / `_TOKEN_URL` —— `scripts/channel-smoke-test.py` 指向本机 mock 上游。

### 渠道控制面 API（复用 `/v1/*` Bearer；`GET /v1/capabilities` 公开）

- `GET /v1/channels/ownership` → `{serverId, leaseTtlSeconds, channels:{<id>:{owner,holder?,leaseExpiresAt?}}}`（桌面 30s 轮询）；
- `POST /v1/channels/ownership/claim|heartbeat|release`（holder = 当前鉴权 deviceId/`master`；多设备先到先得）；
- `GET /v1/channels/status` → 各渠道 `{id, phase, enabled, owner, detail}`（`detail` 含 `botId`/`wsReady`/`lastErrorCode` 等）；
- `POST /v1/channels/{id}/proactive` — `{sessionId?, intentId, text}`，intentId 幂等；无收件人 400 `E_CHANNEL_RECIPIENT_MISSING`，
  owner=desktop 409 `E_CHANNEL_OWNED_BY_OTHER`；capability 不支持主动的渠道（qqbot）前置 400 `E_CHANNEL_UNSUPPORTED`，
  不在 `capabilities.channels.proactive`（不支持主动通知）；
- `POST /v1/channels/wechat/login/start` → `{loginId, pngBase64, expiresAt}`；`GET .../login/status?loginId=` → `pending|scanned|confirmed|expired|error`；
  `POST .../wechat/logout`（幂等）；
- `POST /v1/channels/feishu/webhook`（**公开路由**，兼容别名 `/events`）：Verification Token + 签名 + ±5min 时间戳 + AES-256-CBC 解密。

### 桌面侧 `channels.remote`（服务端托管接线）

桌面设置 `channels.remote = {enabled, baseUrl?, preferServer, failover}`（`src/main/channels/settings-store.ts`）：

- `enabled`：启用「云端托管」；`baseUrl` 缺省复用同步服务端地址（IKJK2I 接线前可显式填写）；
- token 复用同步 device token（不新增凭据面）；控制面请求 12s 超时（停止时中止在途并尽力交回租约）；
  remote 配置 5s TTL 缓存（保存后立即失效）；
- `preferServer=true`（默认）：**自动兜底（failover）期间**服务端恢复后自动 release 并停本机；
  `false` 则重新 claim 维持本机；手动「本机运行」不参与自动交回（继续续租）；
- `failover=local`（默认关）：服务端连续不可达 ≥ 宽限期才本机兜底启动，重连后必须 claim/release 二选一（残余双主窗口由幂等吸收，文档明示）。

### 部署要点

- 裸跑（systemd）建议 `apt install ffmpeg` 以启用飞书语音；不装或体积敏感时设 `CLOUD_CHANNEL_FEISHU_AUDIO=0`（语音降级文本）；
- 容器镜像已内置 ffmpeg（`Dockerfile`，+~80MB 体积，Q1 拍板接受）；`docker compose` 的 `mem_limit 512m` 即渠道层内存兜底；
- 飞书事件订阅 URL 填 `https://<域名>/v1/channels/feishu/webhook`（Caddy 反代即可，无需额外放行；该路由自带校验）；
- 渠道层目标峰值 ≤420MB（整机 2G 预算内）；`CLOUD_CHANNELS` 可随时整体关闭，同步/PWA 不受影响；
- 故障隔离：单渠道启动/发送失败只记状态与日志，不影响其它渠道与 `/v1/sync`。

### 真机冒烟清单（§1.3 豁免项的替代证据入口）

CI 用 mock e2e（`scripts/channel-smoke-test.py`，57 项；Linux CI 追加 4 项落盘权限断言 = 61 项）+ C# 自测（`channel-selftest all`，266 项）覆盖协议与编排；
以下**真机项**需人工执行一次，并在部署/PR 记录日期、commit、结果（截图或日志片段）：

| 渠道 | 步骤 | 通过标准 |
| --- | --- | --- |
| 微信 | 设置页「云端微信登录」扫码 → 收文本 → 回文本 → 收/发图片 → 断网 30s 再恢复 → 触发 `ret=-14`（换 token） | 状态 running；文本/图片往返；断线自动重连；`ret=-14` 后状态 error + 「会话已过期」提示且不重试 |
| 飞书 | 真 App 凭据 + 事件订阅 URL；私聊文本/图片；桌面触发一条主动消息 | webhook challenge 通过；文本/图片往返；主动消息实测可达（服务端 REST 发送成功） |
| QQ | 真 AppID/Secret；私聊被动回复；连发 5 条触发上限 | 60 分钟内最多 4 条回复；超限/超窗返回明确错误；白名单拒绝在状态 detail 可见 |
| 大文件 | 任选渠道发 1 个视频/超大文件 | 大小上限文案拒绝（不落盘、不崩溃） |
| 日志脱敏 | `journalctl -u cyrene-cloud-server` 抽查渠道相关行 | 无 bot token / app secret / 消息正文 |

### 已知缺口（设计 §1.3 分期）

- **SILK 语音**：`ISilkCodec` 为占位实现（`SilkUnavailableCodec`），入站语音回「未配置语音识别」文案、出站语音降级文本 + 状态 `voice:false`（§4.2 阶段 7 未落地）；
- **图片视觉输入**：`CLOUD_CHANNEL_VISION` 预留未接线（无消费点）；图片/文件仅事件占位文本，caption / 模型直读为后续批次（§3.3）；
- **服务端自主主动消息调度**：未做（依赖 IKJK2O）；当前仅 `POST /v1/channels/{id}/proactive` + 桌面转发唯一化（§5.4 Q3）；
- **真机冒烟**：上表待人工执行；微信出站图片、飞书语音转码的 CI 覆盖在 C# `channel-selftest wechat|feishu`。

## 容器（备选）

```bash
cd dotnet/cloud-server
docker compose up -d --build
curl http://127.0.0.1:7789/healthz
```

`mem_limit 512m` + healthcheck + `restart: unless-stopped` + 日志上限（json-file 10m×3）；
同样仅绑 `127.0.0.1`，反代见 `deploy/Caddyfile.example`。
镜像内以非 root（`cyrene`，uid 10001）运行；命名卷 `cloud-data` 首次初始化会继承 `/data` 属主，
若改 bind mount 需自行 `chown 10001`。容器内可直接出码：
`docker compose exec cloud-server dotnet cyrene-cloud-server.dll pair-code`（或 `devices` / `revoke <id>`）。

## 手机 PWA（IKJK2L）

构建（仓库根；产物进 `wwwroot`，随 `dotnet publish` / Docker 构建进镜像）：

```bash
npm --prefix src/pwa ci        # 首次
npm --prefix src/pwa run build # → dotnet/cloud-server/wwwroot/
```

- 手机访问 `https://<域名>/`：配对码登录（CLI `pair-code` 或已配对设备生成）→ 会话列表 → 查看 / 续聊；
- 同源 Bearer 鉴权；token 存 localStorage；HTML 附 CSP；`assets/`（带哈希）长缓存，
  `index.html` / `sw.js` / manifest 不缓存；
- 离线：Service Worker 应用壳 + localStorage 事件快照 → 只读浏览（不支持离线发送）；
  前台 3s 轮询接收服务端生成回复；
- 本地开发：`npm --prefix src/pwa run dev`（vite 代理 `/v1`、`/healthz` → 127.0.0.1:7789）；
- 设计文档：`docs/design/2026-10-04-pwa-mobile-client-design.md`。

## API（camelCase JSON）

鉴权（IKJK2K）：除 `POST /v1/pair`（兑换）与 `GET /v1/capabilities`（公开只读）外，`/v1/*` 需
`Authorization: Bearer <device token>`（或 `CLOUD_TOKEN` 主控）；Bearer scheme 大小写不敏感。错误码：
`401 E_UNAUTHORIZED`、`400 E_PAIR_CODE`、`404 E_DEVICE_NOT_FOUND`、`429 E_RATE_LIMITED`、`421 E_HOST_NOT_ALLOWED`。

- `GET /v1/capabilities`（**公开**）→ `{impl, protocol, sync, clone, cursor, generation, pairing, pwa, maxBatchBytes}`
  （形态能力声明；PWA/桌面客户端据此降级 UI；IKJN78，四形态设计见 `docs/design/2026-10-04-cloud-server-forms.md`）

- `GET /healthz` → `{status, rssMB, cursor, devices}`（cursor 为 O(1) 插入序游标；回环探针豁免、远程需令牌）
- `POST /v1/pair/code`（需鉴权）→ `{code, expiresAt}`（一次性配对码，TTL 见 env）
- `POST /v1/pair`（**公开**）— `{code, deviceName}` → `{deviceId, name, token}`（device token 仅此一次回显）
- `GET /v1/devices` → `{devices:[{deviceId, name, createdAt, lastSeenAt, revoked}]}`
- `POST /v1/devices/{id}/revoke`（撤销即时生效）/ `POST /v1/devices/{id}/rotate`（返回新 token，仅此一次）
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
python scripts/dotnet-cloud-sync-test.py        # 本地 full：同步收敛 + 配对/令牌 + 生成闭环 + PWA 静态托管 + 能力声明（Windows 54 / Linux 55 项；wwwroot 未构建时跳过静态 3 项）
python scripts/dotnet-cloud-sync-test.py --profile core   # 本地核心档（同步核心 + 配对 + 能力声明）
python scripts/dotnet-cloud-sync-test.py --base-url URL --master-token TOKEN   # 远端形态核心档（CF / PHP / …）
python scripts/dotnet-cloud-sync-test.py <发布目录>/cyrene-cloud-server.dll   # 裸产物直测
dotnet <发布目录>/cyrene-cloud-server.dll channel-selftest all   # 渠道五套 C# 自测（framework/wechat/feishu/qqbot/ownership；266 项，mock HTTP/WS 无网络）
#   `--selftest <suite>` 为同义通用别名（如 --selftest wechat）；未知子集退出码 2，不会误落回真服务启动
python scripts/channel-smoke-test.py <发布目录>/cyrene-cloud-server.dll   # 渠道 mock e2e（iLink 扫码/文本/图片/重连、飞书 webhook 加密/去重/别名/413、QQ 网关被动回复、归属（含 401/越权反向断言）、主动消息；57 项，Linux +4 落盘权限）
dotnet dotnet/smoke-host/bin/Release/net10.0/cyrene-smoke.dll --selftest channel-contract fixtures/channels   # 渠道契约 fixtures（C# 侧 runner，61 项；TS 侧 npx vitest run src/main/channels）
npx --yes ajv-cli@5 validate -s fixtures/channels/schema/channel-contract-v1.schema.json -d "fixtures/channels/cases/*.json"   # schema 规范校验（draft-07，61 例全过；命令同 fixtures/channels/README.md）
node scripts/pwa-e2e-test.mjs <发布目录>/cyrene-cloud-server.dll   # 手机 PWA e2e（Microsoft Edge 通道：配对/查看/续聊/离线缓存）
node scripts/pwa-e2e-test.mjs --base-url URL --master-token TOKEN   # 远端 e2e（不 spawn；--expect-echo 开启生成断言）
```

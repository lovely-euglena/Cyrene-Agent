# Cyrene .NET 后端总览（dotnet-backend）

> 状态：功能级完成 + Linux 侧五套实测（96+ 项，见下「测试矩阵」）；2026-10-04 跨平台协议类抽入 `dotnet/cyrene-core`（IKJK2G），本地（Windows）全量复跑全绿，Linux 复跑由 CI 工作流承接（脚本已去硬编码路径）；Windows 实机冒烟已跑通（`scripts/dotnet-smoke.ps1` 6/6，含 tray-scheduler 自测 + 管道 E2E；CyreneVoice 已发布时 7/7）。
> 决策记录：docs/dotnet-migration-decisions.md（A1-A19）

## 测试矩阵（Linux 冒烟壳 dotnet/smoke-host，引用 dotnet/cyrene-core 跨平台核心）

| 套件 | 覆盖 | 结果 |
|---|---|---|
| `scripts/dotnet-smoke-linux.py` | 八 host 全链帧序（fs/计算器/RAG 迁移+混合检索/Agent 闭环/loop/记忆六表/越权自测 + **secrets-host vault 契约 + vault/.bak 权限 0600 断言** + **llm-host 自测（作业库 24 项 + mock SSE 全链 45 项）** + **selftest scheduler（调度核心）**） | 40/40 |
| `scripts/dotnet-edge-test.py` | 畸形帧/路径穿越/SQL 注入/1e308 权重/5MB payload/幽灵会话 | 13/13 |
| `scripts/dotnet-tools-matrix.py` | 工具逐个真实调用（calculator/now/sysinfo/fs 三件/expense/search_text/str_replace 两段式/apply_patch 事务/下载黑名单/穿越拒绝/**git 八件（真实仓库 + 本地 bare 远程）/ web_search/weather/plan_trip（config 帧确定性路径）/ fetch_url（本地 HTTP fixture + GitHub API mock + 截断/缓存）/ 文档四件（zip 结构 + PdfPig 文本提取）/ 邮件四件（本地 fake SMTP + fake IMAP；含连接拒绝 E_EMAIL_PRECONDITION）/ ast_grep 两件（随包 CLI）**；含 write 三态 changes 证据、账本与字符串数字校验、git 校验拒绝路径、旧 args `__` 键拒绝（IKJLP4）） | 150/150（本地全量；CI 136/0，见注） |
| `scripts/dotnet-agent-loop-test.py` | 多轮工具环闭环/MaxTurns 硬闸/并发会话隔离/destroy 语义/畸形回注/白名单环内拦截 | 13/13 |
| `scripts/ipc-stress-test.ts` | 并发 20 call 路由/2MB payload/超时恢复/shutdown 清 pending | ALL PASS |
| `scripts/dual-track-diff.ts` | calculator + fs 三件（输出/字节）+ exchange_rate + expense（输出/账本）+ search_text（6）+ str_replace（8，含诊断/空文件播种）+ apply_patch（9，事务/迁移/EOL）+ download_file（10，本地 HTTP/字节/黑名单/连续点/穿越拒绝/偶数级前导穿越拒绝）+ git（29，镜像仓库/本地 bare 远程/commit-log-revert hash 归一/截断与 staged）+ web_search（4，确定性校验）+ weather（4）+ plan_trip（3）+ fetch_url（5，raw 逐字/markdown 归一投影/表格已知差异）+ 文档四件（6，读回投影：单元格/数字格式/列宽容差/docx run 属性/PDF 文本提取）+ 邮件四件（12，校验路径逐字）+ ast_grep 两件（10，TS napi ↔ CLI 逐字/落盘字节） | 计算器 12 + fs 7 + life 10 + search 6 + srepl 8 + apply_patch 9 + download 10 + git 29 + web_search 4 + weather 4 + plan_trip 3 + fetch_url 5 + 文档 6 + 邮件 12 + ast_grep 10 |
| `scripts/plugin-security-test.ts` | .NET 插件 risk 闸门（未声明拒注册/透传/invoke 闭环/优雅关停） | ALL PASS |

> CI 口径注记：`dotnet-tools-matrix.py` 在工作流中先于 `npm ci` 运行，ast-grep 段因
> CLI 未安装 SKIP（**135/0**）；ast-grep 由后续 TS 步骤的 dual-track（npm ci 之后）
> 覆盖。本地安装依赖后全量为 150/150。

实测修复的代表性缺陷：RagHost 建表 SQL 丢括号、Jieba 词典 Resources 不拷贝
（rag-host 从未真正跑通）、Cosine 漏除 entry 范数、ToolHost 帧竞态丢帧、
Agent 白名单只在自测验函数未接线（P0）、tool_result 生命周期断链、
git commit 漏子命令、IPC argv 双传。

## 九 host 进程地图（B3：独立启停，崩溃宿主监督重启；另含原生窗口/分离托盘两形态）

| Host | 入口 | 阶段 | 状态 |
|---|---|---|---|
| 原生窗口 | `cyrene-native serve`（默认） | 前置 | 生产 |
| 分离托盘 | `cyrene-native --tray` | 前置 | 生产（托盘 UI + spawn Electron + 常驻调度：SchedulerStore/Engine、sched.* 管道协议、离线 headless 拉起；见 `docs/design/2026-10-05-scheduler-to-dotnet.md`） |
| MCP 连接 | `cyrene-native --mcp-host` | M4 前置 | 生产骨架（stdio/SSE + 重连/超时/进程树清理） |
| 内置工具 | `cyrene-native --tool-host` | D | calculator/now/clipboard/sysinfo + fs 三件 + exchange_rate/expense/search_text + git 八件/apply_patch/download + web_search/weather/plan_trip + **fetch_url/文档四件/邮件四件/ast_grep 两件（T2 按库替代批）** 接线（evidence 帧协议 v1 + config 帧 + call 帧 meta 内部参数字段（IKJLP4）+ weather_card 事件帧 + 邮件 config 帧 + ast-grep CLI 注入，150 项矩阵实测） |
| Agent 会话 | `cyrene-native --agent-host` | H/J | LLM 回调闭环 + 多轮工具环 + orchestrate/mailbox/白名单**主路径拦截**（13 项实测） |
| RAG | `cyrene-native --rag-host` | E | SQLite/WAL + jieba BM25（CutForSearch+标点过滤）+ 混合检索（余弦修正）+ JSON 迁移 |
| 记忆 | `cyrene-native --memory-host` | I | L0/L1/冲突/反思表 + get/append op（L2/DMAE 建表暂缓驱动 A7） |
| 对话循环 | `cyrene-native --loop-host` | K | 状态机骨架（🔴 实机逐 token 一致性未过前禁开） |
| 语音 | `CyreneVoice.exe --voice-host` | F/G | TTS 四引擎 + minimax 骨架 + Silero VAD 三模式 + 自动校准 |
| 密钥库 | `cyrene-native --secrets-host` | Phase 1（IKJM7D A1） | DPAPI vault（原子写/.bak/迁移标记）+ secret.get/put/delete/list/import/status/mark-migrated（帧契约测试锁定） |
| LLM 作业 | `cyrene-native --llm-host` | Phase 2（IKJM7D H0–H4 MVP） | 作业式厂商服务：鉴权注入/bearer+raw、OpenAI SSE 解析、重试集中（429/5xx/网络/超时）、未确认量反压、TTL 回收、lanes 4/2/1、指标出口（stderr + status） |

## 双轨开关（唯一解析入口 `src/main/dotnet-backend/config.ts`）

环境变量 > `./config/cyrene.conf` > 默认（表见 decisions 文档）。
所有 TS 客户端（native-tool-host/host-clients/agent-process-manager）在
开关=0/无 exe/超时/崩溃 时自动回退 TS 原路——无灰度直切（P10）。

## 铁律落实位（P 检查）

- B1 密钥不落 .NET：`agent-process-manager.ts` llm_request→streamChatWithSdk 代理
  - ⚠️ 2026-10-03 起拟迁移：密钥保存下沉 .NET DPAPI 密钥库（分阶段，见 [design/2026-10-03-secrets-migration-to-dotnet.md](./design/2026-10-03-secrets-migration-to-dotnet.md)）；切换前按 B1 执行
- B2 审批在 Electron：tool_request→setToolExecutor→executeToolCall（含 checkPermission）
- B8 语音边界：只动 `synthesizeByEngine` 引擎层入口（tts-dispatcher.ts），IPC/播放/转码/状态机零改动
- B9 VAD 隐私：local/hybrid 仅语音段上云（VadEngine 门控在发送方）
- B10 便携：HostConfig.cs（C#）+ config.ts（TS）同规则解析，./data 单根

## 安全加固（实测驱动）

- **MCP HTTP**（M5）：127.0.0.1 绑定 + 回环校验双保险 + **Host 头白名单**
  （DNS rebinding 防护——恶意页面把 evil.com 解析到 127.0.0.1 时 403）
- **.NET 插件 risk 闸门**（closed world）：SDK `CyreneToolAttribute.Risk`
  （缺省 unknown）→ adapter 白名单校验——未声明/unknown **拒注册**；
  `MAX_TOOLS_PER_PLUGIN=64` 防注册表撑爆；policyFor 非 full 档对 unknown 全 deny
- **IPC**（host-clients）：spawn `error` 事件立即反馈（ENOENT 不等超时）；
  超时 kill 先置 exited 防竞态；shutdown 清 pending；数组 mode argv 防双传
- **Agent 循环**：工具白名单在 MakeContinuation 主路径拦截（J6 落地）；
  tool_result 缺字段给明确 errorCode（不裸抛 KeyNotFound）
- **截图 helper**：prewarm 懒启动（路径预检不 spawn）+ 600s 空闲自杀
  （`SCREENSHOT_HELPER_IDLE_MS` 覆盖，0=永不），与 embedding sidecar 语义对齐

## 契约文档

- 帧协议（B5）：各 host C# 源文件头注释即规范（errorCode 字段统一）；工具宿主
  call 帧的内部参数走独立 `meta` 字段（模型不可见，宿主只读 meta、不读 args `__`
  旧键，IKJLP4，见 ToolHost.cs 头注释）；
  ToolHost `config` 帧（timezone/dateLocale/dataDir + webSearch/weather/travel/email 运行时注入）见
  `ToolHostConfig`（C#）与 `NativeToolHost.setRuntimeSettings`（TS）；邮件授权码仅宿主内存驻留（B1）
- 写类工具 evidence 帧协议 v1：`docs/design/2026-10-03-tool-evidence-frame-protocol.md`
  （`changes: ToolFileChange[]` 随 result `data` 返回；策略层留 TS，见下）
- ast_grep 两件走随包 CLI（`@ast-grep/cli` 平台包二进制路径由 TS `resolveAstGrepCommand` 解析后经
  call 帧 meta.astGrepCommand 注入（IKJLP4 起内部参数统一走 meta）；pnpm/npm 两种 node_modules 布局均兼容）
- 多 Agent：docs/multi-agent-architecture.md
- 语音/VAD：dotnet/voice/CyreneVoice/ 源头注释
- 构建/发版：docs/build-guide.md

## Windows 冒烟（C3，必跑清单）

`scripts/dotnet-smoke.ps1`：tool-host 五工具双轨 diff、agent-host 闭环、
rag-host 迁移+逐 query、voice-host TTS mock、VAD 三模式、便携开关、
`--selftest tray-scheduler`（托盘调度宿主：协议/arm/离线失败/队列/中断/宽限兜底，
IKJK51 复审 P1-6）、`scripts/tray-scheduler-e2e.mjs`（真实起 `--tray --scheduler`
驱动 sched.* 协议：CRUD/在线 sched.fire/断线离线 failed 历史/disarm，IKJK51 复审 P2-1）。

## 云端昔涟 cloud-server（IKJK2J / IKJK2K）

- `dotnet/cloud-server/`：ASP.NET Core Minimal API + Microsoft.Data.Sqlite WAL——
  append-only 事件库（event_id 幂等索引；插入序游标）+ `/v1/sync` push（JSONL 整批原子）/
  fetch（since+limit+sessionId）/ clone（NDJSON 流 + `X-Sync-Cursor`）；协议校验复用
  cyrene-core `SyncProtocolV0`（`docs/specs/2026-10-04-sync-protocol-v0.md`）。
- 链校验（v0 过渡策略）：per-(sessionId, deviceId) 链接 + seq 严格递增；
  内容哈希重算待 Q3 定稿；默认绑 127.0.0.1。
- 鉴权/配对（IKJK2K）：device token（`POST /v1/pair` 兑换，库内哈希存储、撤销/轮换即时）或
  `CLOUD_TOKEN` 主控；`/v1/*` 始终鉴权、`/v1/pair` 公开、`/healthz` 回环豁免；
  Host 白名单 + 限流 + 日志脱敏 + Linux 0700/0600；CLI：`pair-code` / `devices` / `revoke`。
- 服务端生成（IKJK2M）：`CLOUD_LLM_API_KEY` 启用；push 触发生成、事件重放取活动分支（编辑/重生成/删除语义）、
  `gen-*` 幂等写回 `deviceId=server`；mock LLM 冒烟覆盖（断网重试不重复 / 编辑重生成）。
- 渠道托管（Phase 2 渠道批 IKJK3P/IKJK2P/IKJK2R/IKJK2S/IKJK2T）：`CLOUD_CHANNELS=wechat,feishu,qqbot` 服务端 24/7；
  微信 iLink 扫码登录/长轮询/媒体、飞书 webhook（签名/解密/去重）+ 最小 REST、QQ 官方 bot 被动回复（WS+REST）、
  归属租约 claim/heartbeat/release + `/v1/channels/{id}/proactive` 幂等投递；设计 `docs/design/2026-10-05-server-channel.md`。
  渠道套件实测：`channel-selftest all` **286 项**（framework/wechat/feishu/qqbot/ownership；无 ffmpeg，含 ffmpeg 287）+ `scripts/channel-smoke-test.py`
  **57 项**（真实起服务 + mock iLink/飞书/QQ 上游；Linux 追加 4 项落盘权限 = 61）+ `--selftest channel-contract fixtures/channels`
  **62 项**（双端契约 C# 侧）。
- 测试：`python scripts/dotnet-cloud-sync-test.py`（真实起服务：幂等/分页/并发收敛/链拒绝回滚/
  clone 游标 + 配对令牌/限流/Host/脱敏 + 生成闭环 + PWA 静态托管 + 能力声明，Windows 54 / Linux 55 项；
  wwwroot 未构建时跳过静态 3 项）。`--base-url/--profile core` 为远端/核心档（对任意 HTTP 形态）。
- 能力声明（IKJN78）：`GET /v1/capabilities`（公开只读）——四形态（完整 / CF / PHP / Git）能力边界，
  客户端按声明降级（设计见 `docs/design/2026-10-04-cloud-server-forms.md`）。
- 手机 PWA（IKJK2L）：`src/pwa/`（原生 TS，零运行时依赖）→ 构建产物进 `wwwroot` 静态托管；
  配对登录 + fetch/push + 离线只读缓存（SW 应用壳 + localStorage 事件快照）；物化视图与
  `DialogLoop.Replay` 逐条对齐；e2e `node scripts/pwa-e2e-test.mjs <dll>`（Microsoft Edge 通道）。
- 部署：**裸跑为主**（`dotnet publish` + `deploy/cyrene-cloud-server.service` systemd 单元 +
  `deploy/Caddyfile.example` 反代，`CLOUD_ALLOWED_HOSTS` 建议随域名设置）；容器为备选
  （`docker-compose.yml`：mem_limit 512m + healthcheck + 日志上限）；正式部署/备份/告警属 IKJK2N。

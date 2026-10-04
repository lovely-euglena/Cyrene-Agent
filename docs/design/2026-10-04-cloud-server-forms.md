# 服务端四形态与能力声明 · 设计（IKJN70 / IKJN78）

> **日期**：2026-10-04
> **状态**：能力声明与一致性套件已实现（IKJN78）；CF 版已实现并通过部署实例验收（IKJN79，已合并）；Git 版适配器已实现（IKJN7B，已合并）；PHP 版已实现并通过本地验收（IKJN7C，PR 待合并）
> **关联**：RFC `docs/design/2026-10-03-cloud-cyrene-rfc.md`（不变式 / Q8）· 总决策 IKJN70 ·
> CF spike IKJN3W · 桌面端同步客户端 IKJK2I · PWA IKJK2L · 完整版运维 IKJK2N

## 0. 目标

把「服务端」从唯一实现变成**可替换的 remote 形态**（RFC 不变式：remote 随时可解绑），覆盖不同用户场景；
用「一套协议 + 能力声明 + 一致性套件」避免多实现契约漂移。

## 1. 四形态取舍矩阵

| 维度 | 完整版（.NET VPS） | CF 版 | PHP 空间版 | Git 仓库版 |
| --- | --- | --- | --- | --- |
| 设计目的 | 全功能参照；Phase 2 24/7 渠道/调度 | 免运维 / 免费 / 海外可达 | 国内虚拟主机场景 / 免运维 | 零服务器 / 数据版本化 |
| push / fetch / clone | 实时 | 实时 | 实时 | 批量（pull 周期，分钟级） |
| 游标 | 服务端插入序 | DO 插入序 | MySQL 自增序 | 每设备 append-only 分片 + 字节偏移（无全局游标） |
| 鉴权 | device token + master | 同左（TS 重写） | token 表 | 仓库权限（私库 + PAT/SSH） |
| 服务端生成 | 后台队列 + 重试 | 模型 API + DO alarm 重试 | push 内联尽力（可选 cron 排空） | 不做（桌面在线代生成） |
| PWA 托管 | 同源 | Workers 静态资产 | 同空间静态 | 不承诺（桌面优先） |
| 运维 / 备份 | systemd + 备份/监控（IKJK2N） | CF 面板 + 定期导出 | 空间商 + 导出脚本 | git 历史即备份 |
| 数据主权 | 自己机器 | 平台 | 空间商 | 自己仓库 |

取舍原则：**L1 同步核心全形态一致**；L2 鉴权/配对按平台能力落地；L3 生成按形态降级；L4 运维面各随平台。

## 2. 能力声明（`GET /v1/capabilities`）

公开只读（客户端在配对前就要用它降级 UI；不含敏感信息）。字段：

| 字段 | 取值 | 说明 |
| --- | --- | --- |
| `impl` | `dotnet-vps` / `cf-workers` / `php-shared` / `git-repo` | 形态标识 |
| `protocol` | `v0` | 协议版本 |
| `sync` / `clone` | bool | 同步核心能力 |
| `cursor` | `server` / `file-offset` | 增量游标语义 |
| `generation` | `realtime` / `inline` / `none` | 服务端生成档位 |
| `pairing` | `device-token` / `shared-secret` / `repo-credential` | 鉴权形态 |
| `pwa` | bool | 是否托管 PWA |
| `maxBatchBytes` | int | push 批上限 |

客户端降级：PWA 在 `generation: none` 不显示「等待回复」；`pwa: false` 不提示手机访问；
解析失败 / 老服务端（无端点）回退兼容默认（`realtime` / `pwa=true`，行为不变）。

## 3. 一致性套件与 profile（IKJN78）

- **本地 full**（默认）：全量检查（含生成闭环 / 限流阈值 / Host 白名单 / 日志脱敏 / Linux 权限 /
  裸 socket 上限探测）；
- **核心档**（`--profile core` 或 `--base-url URL --master-token TOKEN`）：对任意 HTTP 形态跑
  同步核心 + 配对令牌 + 能力声明 +（`pwa=true` 时）静态托管；事件/会话 id 带运行前缀，
  可对持久实例重复跑；
- **PWA e2e**：`--base-url / --master-token` 远端模式（不 spawn；`--expect-echo` 显式开启生成断言）；
- Git 版不走 HTTP 套件，走桌面端适配器测试（IKJN7B）。

## 4. 各形态要点

### 4.1 完整版（已实现）

能力声明 `impl=dotnet-vps`；`generation` 随 `CLOUD_LLM_API_KEY` 动态；PWA 同源托管；运维见 IKJK2N。

### 4.2 CF 版（IKJN79，已实现）

- `cloudflare/cloud-server/`：Workers + DO SQLite（单租户单 DO `global`），TS 复用
  `src/main/sync/sync-protocol.ts` 校验器；
- 端点与 .NET 版逐项对齐：healthz / capabilities(impl=cf-workers) / pair(code) / devices(revoke/rotate) /
  sync(push/fetch/clone)；鉴权（device token + 主控）、链/序号校验、整批原子性由核心档套件锁定；
  限流（DO 固定窗口）不在核心档内，由 `test/rate-limit.test.ts` 单测 + cf-worker 工作流低阈值实例的
  429 断言覆盖；
- 生成：push 触发 → DO alarm 处理与退避重试；`CLOUD_LLM_MODE=echo` 为内置回声 mock（测试部署），
  设置 `CLOUD_LLM_API_KEY` 后走 OpenAI 兼容接口；静态资产用 Workers 静态资产（Worker 统一缓存头 / CSP）；
- 部署要点：自定义域用 3 级子域（通用证书即时覆盖；4 级子域 alert 40，见 IKJN3W）；Bot Fight Mode 会拦
  脚本 UA（403/1010，套件 / e2e 用 `--user-agent` 传浏览器 UA，或关闭 BFM）；步骤见
  `cloudflare/cloud-server/README.md`。

### 4.3 Git 版（IKJN7B，桌面端；适配器已实现）

- `src/main/sync/git-remote.ts`（`GitRepoRemote`）：每设备 `events-<deviceId>.jsonl` append-only 分片 +
  字节偏移增量；`.gitattributes` 固定 `*.jsonl -text`（禁用行尾转换，保字节偏移语义）；
- push = 追加分片 + commit + push；fetch = pull `--rebase` + 读新行；合并 = eventId 幂等 +
  规范序并集（`mergeSyncEvents`）；无生成 / 无 PWA；
- 保守合并：pull 失败/冲突一律中止（不 force、不重写远端历史）；强制推送（历史重写）后
  前缀哈希失配 / 文件收缩 → 该分片回退全量重读；半截尾行只读到最后一个换行（本设备追加前自愈修剪）；
- 鉴权 = 仓库权限（私库 + PAT/SSH，经 `remoteUrl` 传入，不外泄日志；init 错误同样脱敏并覆盖
  URL 变形）；状态由调用方持有（`FetchState` 每分片 `{offset, prefixHash}`，模块不落盘额外状态）；
- 失败路径：git 调用带无输出超时（`timeoutMs`）与取消（`signal`）；提交失败回滚追加（文件 + 暂存区）；
  无新事件 / 同批重试自愈（补提交 / 补推送）；默认隔离用户全局 git 配置与终端凭证提示；
  错误码可重试分级（git / timeout / push_rejected 可重试，conflict / aborted / invalid_config 需处理）；
- 适配器测试（独立 bare 远端 + 双工作副本）：收敛 / 离线分叉 / 强推恢复 / 半截行 / 幂等 /
  纯本地 / 行尾规则 / 收缩重读 / 追加自愈 / 坏行物理行号 / init 脱敏 / 提交回滚 / 未推送自愈 /
  参数校验 / 同设备冲突 / 宿主受限 env / 取消，**19/19**；桌面端接线（事件导出器 / 物化视图）属 IKJK2I，后续接入。

### 4.4 PHP 版（IKJN7C，已实现）

- `php/cloud-server/`：单套件实现 L1+L2（零依赖：PDO SQLite + 手写路由/静态托管）；
  协议读取器与 TS / C# 跑同一组 fixtures（tests/run.php **11/11**）；
- 鉴权 = device token（配对/撤销/轮换）+ 主控令牌；SQLite 固定窗口限流；域名白名单；
- 生成降级（inline）：push 内联尽力（`max_execution_time` 预算内），超时/失败挂起 `dialog_pending`，
  可选 cron 排空（`bin/drain.php`）+ 桌面兜底；`CLOUD_LLM_MODE=echo` 回声 mock；
- 静态资产：`public/` 同空间托管（缓存头 / CSP 与 .NET / CF 口径一致）；Apache `.htaccess` 模板；
- 虚拟主机约束：数据目录可写且不进 webroot；clone 生成器分页流式（内存有界）；配置走 env / config.local.php；
- 存储加固（评审 P0）：入口 / cron `umask(0077)` + 目录 0700 + 库/`-wal`/`-shm` 0600
  （best-effort；Linux / CI 断言）；
- 并发与语义：`BEGIN IMMEDIATE` 写事务；限流分区只信已验证主体（匿名按 IP，回环信任 XFF **最右**一跳）；
  healthz 回环直连免鉴权（同机反代按 XFF 真实客户端判定）；id 长度 / 规范序按 UTF-16 码元
  （与 TS / C# 一致，astral / emoji 亦对齐）。

## 5. 验证（IKJN78 批次，Windows 本地）

- 本地 full 云冒烟：**54/54**（含 3 项能力声明检查）；
- 核心档（本地实例）：**35/35**；远端核心档与本地核心档同一函数（CF 批次将直接对部署实例跑）；
- PWA 单测：**39/39**（含能力解析/降级 6 项）；e2e（Edge 通道）：**11/11**（含能力声明检查）。

### IKJN79 批次（CF 版）

- 单测（重放 / 配对码 / 设备名 / 哈希 / 限流固定窗口）：**22/22**；
- 本地 `wrangler dev`（回声 mock）：核心档 **35/35**、PWA e2e **11/11**（评审修复后复跑，持久实例可重复跑）；
- 限流低阈值实例（`CLOUD_RATE_PAIR_PER_MIN=2`）：`/v1/pair/code` 连续三次 **200 200 429**；
- 部署实例 `cyrene-cloud.ygwill.asia`（HTTPS，回声 mock）：核心档 **35/35**、PWA e2e **11/11**
  （配对 / 查看 / 续聊 / 离线 / 生成闭环）；
- .NET full 回归：**54/54**（套件鲁棒化后）。
- 评审修复（2026-10-04）：限流口径修正 + 单测/工作流 429 断言；clone 流式分页（内存有界）；
  限流分区只信已验证主体；chunked 请求体流式限长；畸形设备 id 回 4xx；工作流工程化；README 差异清单补齐。
- 核心档鲁棒化（IKJN79 顺带）：对启用服务端生成的实例，计数 / 集合断言收敛到 run 前缀事件
  （生成事件 id 前缀 `gen-`）；clone 改为快照单调夹逼 + run 集合 + 游标边界。

### IKJN7B 批次（Git 版适配器）

- 适配器测试 **19/19**（独立 bare 远端 + 双工作副本：收敛 / 离线分叉 / 强推恢复 / 半截行 / 幂等 /
  纯本地 / 行尾规则 / 收缩重读 / 追加自愈 / 坏行物理行号 / init 脱敏 / 提交回滚 / 未推送自愈 /
  参数校验 / 同设备冲突 / 宿主受限 env / 取消）；
- 组合回归：`vitest run src/main/sync src/pwa` **70/70**；`tsc main` / `tsc preload` /
  `tsc renderer` 三端 0 错误。
- 复审修复（2026-10-05）：默认隔离 env 与 simple-git 安全拦截对齐——按 argv-parser 全集补齐
  `unsafe` 开关（`PAGER` / `GIT_EXTERNAL_DIFF` / `GIT_PROXY_COMMAND` / `GIT_TEMPLATE_DIR` /
  `GIT_CONFIG_COUNT` 等），宿主含受限键仍可用（含用例）；自愈先修剪半截尾行；`ext::` 等 `::` 协议形式拒绝；
  补取消（aborted）用例。

### IKJN7C 批次（PHP 空间版）

- PHP 单测 **47/47**（含 11 个共享 fixtures：协议读取器与 TS / C# 逐字段一致；Linux / CI 另含 3 项权限加固断言）；
- 核心档（生成关闭）**35/35**；鲁棒核心档（inline echo）**35/35**；PWA e2e（inline echo）**11/11**（持久实例可重复跑）；
- .NET 本地 e2e 回归 **11/11**；e2e 脚本顺带修复：seed 事件 id 唯一化 + `data-session-id` 精确定位 +
  生成断言接受 `inline`（PHP 形态）。
- 评审修复（2026-10-05）：存储加固（P0）；CI 阶段 2 传参修复（`env`）+ pnpm 锁定 + permissions + 就绪断言；
  clone 生成器分页流式；id / 排序 UTF-16 码元语义对齐（含 astral 单测）；`BEGIN IMMEDIATE`；
  限流分区 / 回环 XFF；请求体限长；生成触发 / 排空异常兜底；静态拦截 `.php` / 点文件；README 差异补齐。
- 复审修复（2026-10-05）：XFF 改取**最右受信跳**（防客户端伪造最左值绕限流，与 .NET ForwardLimit=1 对齐）；
  healthz 回环判定含 XFF（同机反代下外部客户端仍 401）；CI 阶段 1/2 数据目录隔离（防 pair 限流跨阶段叠加）；
  新增 XFF / healthz 单测 5 项；P3（umask 进程级副作用、断言强度、id 尾随控制符 fixture 统一）明确接受为跟进项。

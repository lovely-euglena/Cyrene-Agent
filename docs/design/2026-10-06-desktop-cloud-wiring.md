# 桌面端云接线（IKJK2I）——CTA 导出器 · 存量迁移 · 重放物化视图 · 同步客户端

> 状态：**已实施**（2026-10-06，IKJK2I；五簇并行交付 + 集成终验）· 里程碑「云端昔涟：不落」Phase 1 收尾 · 关联 issue IKJK2I
> 关联：RFC `2026-10-03-cloud-cyrene-rfc.md`（§1 客户端 / §4 时序 / **Q4 本稿拍板**）·
> 协议 `docs/specs/2026-10-04-sync-protocol-v0.md`（v0/v0.1）· PWA `2026-10-04-pwa-mobile-client-design.md` ·
> 服务端契约 `dotnet/cloud-server/README.md` · 渠道 `2026-10-05-server-channel.md`（remote 复用约定）·
> CTA `2026-09-21-cta-conversation-transcript-architecture-design.md`
> 前置：IKJK2G–IKJK2H / IKJK2J–IKJK2M 已交付；IKJK2O（v0.1 事件）PR #25 已合并（本批不依赖）

## 0. 结论与范围

**目标（issue 验收）**：用真实 userData 迁移后 UI 无感；重复迁移幂等；崩溃后可重入；只读导出（不改现有写入路径）。

**进本批**

1. **事件导出器**：CTA journal（audit 全量）→ 同步事件（4 类映射 + presentation 随行 + 过滤），幂等、崩溃可重入；含 `session.create` 与标题修订；
2. **存量迁移驱动**：对全部会话确保 v1→v2 journal 迁移（复用既有 `ConversationSessionMigration`）并导出初始事件链；
3. **旁路事件库与同步状态**（`<userData>/sync/`）：outbox / inbox JSONL + 原子 state；
4. **HTTP 同步客户端**（pair / pair-code / capabilities / push / fetch / clone）+ **同步服务**（单飞、调度、状态、失败保留游标 / 水位并记 `lastError`，下轮 60s 重试）；
5. **重放物化视图**（桌面 replay，与 PWA 语义对齐）+ **合并读模型**（本地投影 + 远端 overlay）→ `CHATS_GET` 合并（仅同步启用时）；fetch 到新事件后广播刷新；
6. **云端设置面**：设置页「云端」section + IPC + preload；token 按 channels 先例加密存储；
7. **渠道 remote 复用**：`channels.remote` 未显式配置时回退 sync 配置（渠道设计既定约定）；
8. **文档**：本设计稿、决策记录、handover / README 更新。

**不做（边界）**

- 记忆 / 心情事件发射接线（v0.1 协议已就绪，另批）；
- 远端会话新建 / 编辑 / 重生成入口（PWA Phase 2）；会话删除同步（v0 未定义）；
- `CHATS_GET_PAGE` 合并（历史分页仍为本地）；多 remote；哈希链；服务端部署（IKJK2N）；
- 对远端消息的桌面编辑 / 重生成（UI 不区分远端消息，Phase 1 限制，见 §5.2）。

**Q4 拍板：远端事件落盘 = 旁路事件库（`<userData>/sync/`），不回填 CTA。**

理由：

- CTA 是富领域模型（工具条目 / presentation / 压缩 / 归档），远端事件是协议层最小文本事件；回填需伪造 CTA 条目并处理「导入条目再导出」环路标记，触碰校验 / 审计 / 压缩语义（issue 明言「只读导出，不改变现有写入路径」）；
- 旁路库可直接复用协议读取器（`readSyncBatch`）读写，语义纯粹、可测；
- Git 类比仍成立：本地 journal = worktree/对象库，`sync/` = remote-tracking（远端事件不进本地对象库）。

**已否决备选**：回填 CTA（写入路径与语义风险大；其唯一收益「UI 免合并」已由本批合并读模型覆盖）。

## 1. 架构总览

```text
桌面主进程
  CTA journal（本地权威源，只读）──► 导出器（幂等 / 时钟）──► sync/events-local.jsonl（outbox）
                                                              │ push（分块、幂等）
  UI ◄── 合并读模型 ◄── 本地投影 + sync/events-remote.jsonl（inbox replay）
                          ▲ fetch / clone（游标）              │
                          └──────── HTTP 同步客户端 ◄──────────┘ ⇄ cloud-server（/v1/*）
  sync/state.json（deviceId / lamport / seq / 游标 / 推送水位 / 会话导出水位 / 标题修订）
  sync/settings.json（enabled / baseUrl / token(enc:) / deviceName）
```

数据流：本地新增 → 导出（分配时钟、追加 outbox）→ push；fetch/clone → 追加 inbox（去重）→ 合并读模型（`CHATS_GET`）→ UI。所有环节可中断重入；无半写状态（append+fsync 先于 state 原子写）。

## 2. 事件导出器

### 2.1 映射（对齐协议 spec §4）

| CTA 条目 | 同步事件 | 说明 |
| --- | --- | --- |
| `user` | `message.append`（role=user） | `turnId` 必填（rewind 锚点） |
| `assistant` | `message.append`（role=assistant；presentation 随行） | 内部消息（`visibility=internal`）与空文本跳过 |
| `turn_rewind` | `turn_rewind` | revision 从 CTA 信封移入载荷（replace_user 时） |
| `turn_tombstone` | `tombstone` | 1:1 |
| `compaction_checkpoint` | **不同步**（Q1-a） | 重放原始历史 |
| `tool_result` / `tool_started` / `task_state` / `effect_resolution` / `interruption` / `backfill_boundary` / `presentation_patch` / `delivery_receipt` | **不同步** | presentation 随 assistant 事件携带；其余留桌面 |

### 2.2 字段转换

- `eventId = entry.id`；`sessionId = conversationId`；`ts = ISO(new Date(entry.at))`（毫秒 + `Z`）；
- **user**：`text = payload.text`；`turnId = entry.turnId`；
- **assistant**：`text = contentToText(payload.content)`（复用投影层工具函数，改为导出；image 块 → `[image]`）；`turnId = entry.turnId?`；`presentation = {patchRevision, patch}`：目标 `entry.turnId ?? entry.id` 的最新合并补丁（复用 `mergePresentationPatch`），按协议白名单过滤键，过滤后为空则整体省略；
- **turn_rewind**：`{anchorUserTurnId, disposition, reason}`；`replace_user` 追加 `{replacementUser:{text}, revision}`；`keep_user` 二者必须缺省；
- **tombstone**：`{targetUserTurnId, reason}` 原样；
- 附件 / 贴纸 / 工具过程不导出（v0 文本范围；spec §2.2 Phase 1 口径）。

### 2.3 时钟与设备身份

- `deviceId`：首次启用生成 `desk-<12hex>` 并持久化；**与服务器 deviceId（`dev_*`）解耦**——重配对 / 轮换 token 不改变协议身份（事件不可变、seq 连续性）；
- `lamport`：全局水位；导出每事件 `++`；fetch / clone 后取 `max(本地, 远端最大)`；
- `seq`：全局单调计数器，导出每事件 `++`（服务端按 `(session, device)` 严格递增校验，全局计数满足）；
- **持久化顺序**：事件先 append+fsync → 后原子写 state；崩溃窗口由 eventId 去重兜底。

### 2.4 `session.create` 与标题修订

- 事件 id：`screate:<conversationId>:r<n>`；`n` = 标题修订号（state 记录 `titleRevision` / `lastTitle`）；标题变化才发新事件（PWA 物化取最后一条，重命名可传播）；
- payload：`{title, createdAt}`；title 截断至 ≤200（协议上限）。

### 2.5 幂等与崩溃可重入

- 快路径：state `conversations[cid].exportedThroughSeq`（从上次水位续扫）；
- 正确性兜底：outbox 内存 eventId 集合——重复导出的事件不再 append（时钟不重分配）；
- 迁移 + 导出任意时点中断：重启后从水位续扫 + 去重，最终收敛到同一事件集；
- 状态恢复（R2 补登记）：state 缺失 / 损坏 → 按事件库恢复（deviceId / lamport / seq / 标题水位；fetchCursor / pushedCount / serverDeviceId 等不可推导字段取默认，靠服务端 eventId 幂等重推）；load / save 入口按 mtime 1h 阈值清理崩溃遗留的 `state.json.*.tmp`。

### 2.6 存量迁移驱动

- 导出前对 `chatsStore.listSessions()` 全量会话执行 `ensureConversationMigrated`（既有 v1→v2 迁移：json messages → journal 初始事件链，已具 CAS / 并发锁 / 崩溃注入测试）；
- **本批不重写迁移器**：issue 的「迁移器」由既有实现承担，本批负责「全量驱动 + 初始事件链导出 + 重入」。

## 3. 旁路事件库与同步状态

```text
<userData>/sync/
├─ settings.json        # {enabled, baseUrl, token(enc:), deviceName}（公开快照剥离 token，暴露 hasToken）
├─ state.json           # 见下
├─ events-local.jsonl   # 本机导出事件（append-only；push 源）
└─ events-remote.jsonl  # fetch/clone 拉取事件（append-only；含他端与 server 事件）
```

- 格式：一行一事件（协议 JSONL）；读取经 `readSyncBatch`（去重 / 规范排序 / 末行截断容错免费获得）；append 沿用 transcript store 的 fsync 模式；state 原子写（tmp+rename）；
- `state.json`：`{schemaVersion:1, deviceId, lamport, seq, fetchCursor|null, pushedCount, serverDeviceId|null, conversations{cid:{exportedThroughSeq,titleRevision,lastTitle}}, updatedAt}`；
- 容量：文本事件小，v1 不设上限（后续按需裁剪）。

## 4. 同步客户端与服务

### 4.1 HTTP 客户端（`src/main/sync/http-client.ts`）

- 方法：`pair(code, deviceName)` / `createPairCode()` / `capabilities()` / `push(events)` / `fetch(cursor, {sessionId?, limit?})` / `clone({sessionId?})`；
- 配置 `{baseUrl, token, timeoutMs?, signal?, fetchImpl?}`（fetchImpl 注入便于测试）；全局 fetch + `AbortSignal.timeout`（沿用 runtime-policy `external-http` 30s）；
- 错误模型（token 安全，错误文本剥离 token / URL 变体）：`{code: invalid_config|unauthorized|forbidden|rate_limited|batch_invalid|batch_rejected|oversize_event|cursor|not_found|http|timeout|aborted|network}` + status + 服务器 code；
- push 分块：按序列化字节 ≤5 MiB（低于服务端 10 MiB）；单事件序列化 >10 MiB 预检拦截（抛 `oversize_event`，含 eventId、不发送）；重试安全（eventId 幂等）；401 → 标记未授权（UI 提示重新配对）。

### 4.2 同步流程（`sync-service.ts`，单飞互斥）

- **初次**（`fetchCursor=null`）：导出 → push → `clone`（NDJSON；`X-Sync-Cursor` 快照上限）→ 入库 / 记游标；
- **增量**：导出 → push（`pushedCount` 起，200 后推进）→ `fetch` 循环（`hasMore` 至 false）→ 入库 / 推进游标；
- 入库去重：eventId 已在 local 或 remote 则跳过（自己的事件 fetch 回来不会重复）；lamport 水位取 max；
- 失败：游标 / 水位不前移，错误入状态，下轮重试；不产生半写；
- **调度**：启用时启动（app ready 后）；60s 定时（unref）+ 手动「立即同步」+ 配置保存后一次；
- fetch 到新事件 → `broadcastChatsChanged()`（打开的聊天页刷新）。

### 4.3 配对与 token

- **首次**：设置页填 服务器地址 + 配对码（服务器 CLI `pair-code` 生成）+ 设备名 → `POST /v1/pair` → 存 token / serverDeviceId；
- **高级**：直接填 token（运维 / 主令牌）；已配对桌面可为手机生成配对码（`POST /v1/pair/code`，显示 `XXXX-XXXX` + 到期，一次性）；
- `expiresAt` 为 .NET "O" 格式（7 位小数 + `+00:00`）——解析前裁剪为毫秒精度；
- **解除配对**：清 token / serverDeviceId / fetchCursor；保留 outbox 与 state（重新配对后幂等重推、重拉）；
- token 存储：`sync/settings.json` 的 `enc:`（safeStorage → `obf:` 回退），公开快照仅 `hasToken`；日志 / 错误全程脱敏。

### 4.4 换址语义（#IKJSNA；复审 P2-5 收敛）

- **判定键**：`normalizeBaseUrlKey` 只取 protocol + host（大小写不敏感）；路径 / 尾斜杠差异**不算**换址——有意保留：同 origin 子路径调整（反代挂载点变化等）不触发清 token 重配对。代价：同 origin 多实例 / 同址更换服务端实例不会触发重置，旧游标可能越界——Phase 1 接受该风险（识别需实例身份握手；后续可用 clone 响应携带 serverDeviceId 加强）；
- **换址动作**（saveConfig / pair）：重置 `fetchCursor` / `pushedCount` / `serverDeviceId` 与内存 `lastSyncAt` / `lastError`；递增 generation 并中止在途轮次，旧轮在结算点校验代际，不一致即丢弃（不得覆盖重置）；补跑经 `requestSync` 排队，旧轮结算后立即以新配置执行（不等 60s 定时）；
- **unpair**：同代际 + stop 中止语义；保留 outbox / state（重配对后幂等重推、重拉）；
- **inbox 旧服务器事件**：保留并继续参与合并读模型（历史不丢；按 deviceId 过滤保证幂等），不做自动清理。

## 5. 重放物化视图与合并读模型

### 5.1 桌面 replay（`src/main/sync/materializer.ts`）

- 语义与 PWA `replaySession` 对齐：`message.append`（user 开新轮 / assistant 挂 turnId 或当前轮）、`turn_rewind`（keep_user 截断 / replace_user 替换）、`tombstone`（移除目标轮）、`session.create`（会话元数据）；未知锚点 no-op；输入假定已去重 + 规范序；
- **共享核心**：抽取为 `src/main/sync/materializer.ts`，PWA `src/pwa/core/materializer.ts` 改为复用（PWA 既有单测锁定语义，不回归）；`groupTurns` / `summarizeSessions` 保留在 PWA。

### 5.2 合并读模型（`src/main/sync/read-model.ts`）

- 输入：本地组合会话（`loadComposedSession` 结果）+ inbox 中本会话、`deviceId ≠ 本机` 的事件；
- 远端集合 replay → 远端 turns（text-only）；本地消息保持原序，远端 turns 按其 `ts` 插入（`at`/`ts` 同轴）；eventId 天然不重叠（已按 deviceId 过滤）；
- **gating**：同步未启用 / 无远端事件 → 原样返回（UI 无感）；
- 边界：远端集合内 rewind / tombstone 锚点为本地回合时 no-op（PWA 无编辑入口，Phase 1 不出现）；远端消息不支持桌面编辑 / 重生成；`CHATS_GET_PAGE` 不合并。

### 5.3 UI 接入

- `CHATS_GET` 处理器：`loadComposedSession` 后调用合并 provider（未启用 → 原样）；渲染器零改动（远端消息为最小 `ChatMessage`：id=eventId / role / content / at）；
- fetch 后有新事件 → `broadcastChatsChanged()` 触发 UI 刷新（复用既有导出）。

## 6. 设置面

- IPC（settings 命名空间，对齐 channels 先例；常量见接口冻结）：`SYNC_GET_CONFIG` / `SYNC_SAVE_CONFIG` / `SYNC_GET_STATUS` / `SYNC_NOW` / `SYNC_PAIR` / `SYNC_PAIR_CODE` / `SYNC_UNPAIR` / `SYNC_CHANGED`（广播）；
- preload：`window.settings.syncGetConfig / syncSaveConfig / syncGetStatus / syncNow / syncPair / syncPairCode / syncUnpair`（动作类返回 `SyncOpResult<T>`，读取类直接返回）；
- 渲染器：设置页新增「云端」section（nav + 分支 + `SECTION_MAP` 别名）；面板 `CloudSyncSettingsPanel.tsx`：启用开关 / 服务器地址 / 配对码兑换 / 高级 token / 设备名 / 生成配对码（码 + 到期）/ 立即同步 / 解除配对 / 状态行（连接、上次同步、待推送、游标、错误）；异步模式对齐 `ChannelsSettingsPanel` / `DataStorageSettings`。

## 7. 渠道 remote 复用

- `channels.remote` 的 `baseUrl` / `token` 未显式配置时回退 sync 配置（单一来源）；显式配置优先（兼容现状）；改动点在 channels 配置解析（构造 ownership client 前）。

## 8. 安全与兼容

- token 加密落盘 / 公开快照剥离 / 错误脱敏（服务端契约：token 仅在配对 / 轮换响应出现一次）；
- 只读导出：CTA 零写入（除既有迁移路径）；旁路库独立可删；
- 未启用同步时行为与现状完全一致（默认关闭）；
- 服务器兼容：push 不带哈希链（Q3 过渡策略允许）；失败保留游标 / 水位并记 `lastError`，下一轮 60s 重试（含 429）；
- 协议版本：本批只产生 v0 四类事件（v0.1 的 memory/mood 另批）。

## 9. 决策记录

| # | 决策 | 理由 |
| --- | --- | --- |
| D1 | **Q4 = 旁路事件库**（不回填 CTA） | 见 §0；只读导出自然成立；协议语义纯粹 |
| D2 | 协议 deviceId 本地生成（`desk-*`），与服务器 deviceId 解耦 | 重配对稳定；事件不可变 |
| D3 | 时钟 = 持久化全局 lamport / seq（state） | 幂等稳定、跨端可比；崩溃由 eventId 去重兜底 |
| D4 | `session.create` 以标题修订号重发（`screate:<cid>:r<n>`） | PWA 取最后一条；重命名可传播；同题幂等 |
| D5 | presentation 为导出时快照（随 assistant 事件，白名单过滤） | spec §4 / Q1；后续 patch 修订不同步（v0 限制） |
| D6 | 合并读模型在 IPC 层（`CHATS_GET`），同步关闭零变化 | UI 无感；渲染器零改动 |
| D7 | 全量迁移驱动复用既有 v1→v2 迁移器 | 已具幂等 / 崩溃测试；不重写 |
| D8 | 渠道 remote 回退 sync 配置 | 渠道设计既定约定 |
| D9 | 记忆 / 心情发射接线另批 | 控制面收敛；v0.1 协议已就绪 |
| D10 | 空文本 assistant / internal 消息不导出 | 手机端不出现空气泡 / 内部消息 |

## 10. 验证与验收对照

**单测（vitest）**

- 导出器：4 类映射 / rewind keep+replace / 墓碑 / presentation 合并与白名单过滤 / internal 与空文本跳过 / 标题修订 / 幂等（重复执行零新事件）/ 崩溃重入（模拟中断后重扫）；
- 库与状态：append+去重 / 规范排序 / 末行截断容错 / state 原子写 / 水位单调；
- HTTP 客户端：fetchImpl 注入（URL / 头 / 错误码 / token 不泄漏）/ push 分块 / clone 流解析；
- 同步服务：假客户端全流程（初次 clone / 增量 / 重复幂等 / 401 失败保留游标、水位并记 `lastError` 且下轮重试成功 / 单飞）；
- 读模型：合并排序 / 去重 / 远端 rewind+墓碑 / gating（关闭时零变化）；
- 设置存储：enc/obf / 归一化 / hasToken；
- IPC：新通道注册 / `CHATS_GET` 合并开关。

**契约 / 回归**

- `npx vitest run src/main/sync src/pwa`（PWA replay 共享核心不回归）；`npx vitest run src/main/chats src/main/orchestrator`（CTA / chats 不回归）；
- `npx tsc -p tsconfig.main.json --noEmit` + `build:main` / `build:preload` / `check:renderer`；
- cloud-server：`dotnet build` + `python scripts/dotnet-cloud-sync-test.py`（不回归，服务端零改动）。

**手动冒烟（真实 userData，只读）**

- dry-run（默认 skip；输出会话 / 事件计数与样例，不写盘）：
  - POSIX：`CYRENE_SYNC_DRY_RUN=1 CYRENE_SYNC_DRY_RUN_USERDATA=<真实 userData> npx vitest run src/main/sync/export-dry-run.manual.test.ts`；
  - Windows PowerShell：`$env:CYRENE_SYNC_DRY_RUN='1'; $env:CYRENE_SYNC_DRY_RUN_USERDATA='<真实 userData>'; npx vitest run src/main/sync/export-dry-run.manual.test.ts`。
- 真机（人工）：启用同步 → 手机打开桌面历史（收敛）→ 手机发送 → 桌面聊天页出现（合并读模型）→ 桌面回复 → 手机可见。
- **未实测面**：真机冒烟待人工执行；本机真实 userData 为旧布局（无 `cyrene-chats/index.json`），dry-run 优雅跳过——已与实测口径一并登记于决策记录。

**验收映射**

| issue 验收 | 证据 |
| --- | --- |
| 真实 userData 迁移后 UI 无感 | dry-run 冒烟（合成数据）+ 迁移驱动复用既有迁移（零 UI 变更路径）+ 单测 |
| 重复迁移幂等 | 迁移器既有测试 + 导出器幂等单测（重复执行零新事件） |
| 崩溃后可重入 | 导出 / 状态写入顺序（append→state）+ 崩溃重入单测 + 库末行容错 |

## 11. 实现分工（并行簇）

| 簇 | 范围 |
| --- | --- |
| A | 导出器 / 旁路库 / 同步状态 / 迁移驱动（`sync-state.ts` `event-store.ts` `exporter.ts` + 测试 + dry-run 冒烟） |
| B | HTTP 客户端 / 同步服务 / 设置存储 / sync-ipc / default-dependencies 接线（+ 测试） |
| C | 物化器（桌面 + PWA 复用）/ 读模型 / `chats-ipc` 合并 / 渠道 remote 回退（+ 测试） |
| D | preload / 设置页「云端」面板 / nav / SECTION_MAP（+ 测试） |
| E | 决策记录 / handover / docs 索引 / README 注记 |

接口冻结见附录 A（契约提交先行；各簇只动各自文件，禁止改冻结文件签名）。

## 附录 A：接口冻结（契约提交）

**`src/shared/ipc-channels.ts`（新增常量）**：`SYNC_GET_CONFIG` / `SYNC_SAVE_CONFIG` / `SYNC_GET_STATUS` / `SYNC_NOW` / `SYNC_PAIR` / `SYNC_PAIR_CODE` / `SYNC_UNPAIR` / `SYNC_CHANGED`（`sync:*` 命名）。

**`src/shared/sync-types.ts`（新增）**：`SyncConfigPublic` / `SyncSaveConfigInput` / `SyncStatus` / `SyncPairInput` / `SyncPairCodeResult` / `SyncOpResult<T>`（动作类统一返回 `{ok:true,data} | {ok:false,error:{code,message}}`）。

**`src/main/sync/read-model.ts`（契约占位，C 簇实现体）**：

```ts
export interface RemoteMergeSource {
  isEnabled(): boolean;
  getRemoteSessionEvents(sessionId: string): Promise<SyncEventV0[]>;
}
export type RemoteMergeProvider = (session: ChatSession) => Promise<ChatSession>;
export function createRemoteMergeProvider(source: RemoteMergeSource | null): RemoteMergeProvider | null;
```

**`src/main/sync/sync-state.ts`（A）**：`SyncState`（`{schemaVersion:1, deviceId, lamport, seq, fetchCursor:string|null, pushedCount, serverDeviceId:string|null, conversations:Record<string,{exportedThroughSeq,titleRevision,lastTitle}>, updatedAt}`）+ `createSyncState()` / `loadSyncState(syncDir)` / `saveSyncState(syncDir, state)`。

**`src/main/sync/event-store.ts`（A）**：`SyncEventStore`（`open({syncDir})`、`getLocalEvents()`、`getRemoteEvents()`、`getAllEvents()`、`getLocalEventIds()`、`getRemoteEventsForSession(cid)`、`appendLocal(events)`、`appendRemote(events)`、`getLocalCount()`、`getRemoteCount()`）。

**`src/main/sync/exporter.ts`（A）**：`createSyncExporter(deps) → SyncExporter`（`exportPending(): Promise<{exported:number; sessions:number}>`；deps：`{userDataPath, state, store, listSessions, ensureMigrated, readAuditEntries}`）。

**`src/main/sync/http-client.ts`（B）**：`createSyncHttpClient(config) → SyncHttpClient`（`pair/createPairCode/capabilities/push/fetch/clone` + `SyncHttpError`）。

**`src/main/sync/sync-service.ts`（B）**：`createSyncService(deps) → SyncService`（`start/stop/syncNow/getStatus/getConfig/saveConfig/pair/createPairCode/unpair`；`isEnabled()` 与 `getRemoteSessionEvents(cid)` 供读模型）。

**`src/main/chats/chats-ipc.ts`（C）**：`registerChatsIpc` options 增加 `remoteMerge?: RemoteMergeProvider`（`CHATS_GET` 在 `loadComposedSession` 后调用）。

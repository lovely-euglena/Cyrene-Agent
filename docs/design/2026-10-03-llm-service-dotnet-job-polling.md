# LLM 服务化：.NET 厂商服务（job + 轮询取 token）

> **日期**：2026-10-03
> **状态**：设计草案（讨论中，未实施）
> **关联 Issue**：[Ygwill/cyrene-agent#IKJLB2](https://gitee.com/ygwill/cyrene-agent/issues/IKJLB2)
> **结论先行**：新增 `cyrene-native --llm-host` **作业式厂商服务**——TS `llm.submit` 提交请求，
> .NET 负责「鉴权注入 → 发送 → 流式解析 → 事件缓冲」，TS 按 cursor **轮询**取归一化 token 事件。
> 动机：适配 DeepSeek 级 **400+ TPS** 输出、把流式解析从 Electron 主线程移走防阻塞、重试/限流
> 集中到后端、并为**服务器版本**预留服务边界。分批落地：先 OpenAI 协议 + interactive 通道 MVP
> （2–3 周），全量 3 协议 + 后台低优先级通道 5–9 周。
> 关联：`docs/design/2026-10-03-secrets-migration-to-dotnet.md`（A20 密钥库，本设计的前置）、
> `docs/design/2026-10-03-cloud-cyrene-rfc.md`（云端昔涟：服务器版总纲；本设计是其传输层的桌面侧先行）、
> `docs/design/2026-09-26-agent-orchestration-plan-b.md`（循环留在 TS 的边界）、
> `src/main/llm-queue.ts`（现有后台限流队列，本设计接管其职责）。
> 服务器版关联：决策 issue [IKJK2F](https://gitee.com/ygwill/cyrene-agent/issues/IKJK2F) ·
> 里程碑 [#229292「云端昔涟：不落」](https://gitee.com/ygwill/cyrene-agent/milestones/229292)。

---

## 1. 动机

### 1.1 400+ TPS 的吞吐压力

DeepSeek 等厂商的生成速度可达 400+ TPS。现状链路（`sdk-stream/runtime.ts` → `onDelta` 回调 →
AGUI 节流 → 渲染进程）里，**每个 token 都经过 Electron 主进程**的 JSON 解析与转发。
400 TPS = 每秒 400 次 delta 处理，主进程与 IPC 都会明显升温；若未来出现千级 TPS 模型，
按 token 直通会成为瓶颈。

服务化后：.NET 侧**按时间/字节合并事件**（16–50ms 或 ≥256 字符一批），400 TPS 折算为
**~8–13 个轮询事件/秒**；TS 主线程只做「游标轮询 + 批量上抛」，负载与厂商 TPS 解耦。

### 1.2 Electron 主线程防阻塞

主进程是单线程：SSE 字节流解析、增量归一化、重试计时、日志都挤在同一条线程上，
与 UI/IPC/窗口管理互抢。解析与缓冲迁到独立 .NET 进程后，**最坏情况是 llm-host 忙，
不是主线程卡**；TS 侧只剩低频轮询。

### 1.3 重试机制集中化

现状重试语义散在 `harness-llm.ts` / `model-retry-runner.ts` / `llm-queue.ts`：
- 主聊天：idle 超时 + Retry-After + 「有可见增量后不重放」（防重复输出）；
- 后台：FIFO 串行 + 限流关键词猜测（`RATE_LIMIT_KEYWORDS`）退避 5s 重试一次。

服务化后 .NET 能直接看到 `429`/`Retry-After`/`5xx`/网络错误，**按 provider + key 做并发/退避**，
比关键词猜测准确；重试状态以事件推给 TS（现有 `ModelRetryStatus` UI 通路不变）。

### 1.4 服务器版本的基础（最重要）

服务器版需要把「厂商调用」变成**无 Electron 依赖的服务**：多租户、配额、审计、弹性伸缩。
作业式 API（submit/poll/cancel）天然是进程/机器边界清晰的契约：

| 桌面版 | 服务器版（同契约演进） |
|---|---|
| stdio 帧 | HTTP / gRPC / WebSocket |
| DPAPI 密钥库（A20） | KMS / Secrets Manager |
| 进程内单队列 | 按租户/Key 的分布式队列 + 配额 |
| TS 客户端（Electron 主进程） | Web/薄客户端 + 会话服务 |

**现在按服务边界设计，未来换实现不换契约。**

服务器版总纲见 [云端昔涟 RFC](./2026-10-03-cloud-cyrene-rfc.md)（D1：.NET 10 + SQLite；
D2：`dotnet/cyrene-core` 跨平台核心库；D5：512MB 容器预算）。本设计的**响应解析 / 重试 / 限流核心
目标放进 `cyrene-core`**（无 Windows/Electron 依赖）：桌面 `--llm-host` 用 stdio 帧承载，
云端 `DialogLoop`（服务端生成，密钥仅服务端）直接以库调用复用同一实现——这正是「同契约、换实现」。

## 2. 现状与约束

| 事实 | 数据 | 影响 |
|---|---|---|
| vendors 传输层规模 | 3,628 行实现 / 4,337 行测试（26+26 文件） | 响应侧解析（normalizer/accumulator ≈1,000 行量级）是主要移植对象 |
| .NET 流式能力 | `Agents/AgentLoop.cs` 仅 `stream:false`；全仓库 event-stream 引用 **0 处** | SSE 解析需新写（HttpClient + 半行拼接，无框架障碍） |
| .NET 依赖 | csproj 只有 SQLite/Jieba/SSH/FTP/S3，无 OpenAI/Anthropic 包 | 手写 HTTP 为主；Anthropic 无官方 .NET SDK 是最大外部不确定性 |
| 后台队列 | `llm-queue.ts`：FIFO 串行、限流退避；**主聊天不入队** | 服务化后所有调用过服务，必须保留「主聊天不被后台堵塞」语义 |
| 密钥 | A20（IKJLB2）：Phase 1 迁入 .NET DPAPI 密钥库 | llm-host 从库取 key，TS 传 profileId，不传明文 |

## 3. 架构与职责边界

```
TS（Electron 主进程）                        cyrene-native --llm-host
┌────────────────────────────┐   submit   ┌──────────────────────────────┐
│ 循环 / 工具 / 权限 / 上下文   │ ─────────▶ │ 作业队列（interactive/normal/low）│
│ vendors facade（留接口）     │            │ │ 限流：per provider+key 串行   │
│ 轮询 poll(cursor) ◀─────────┼────────────┤ │ 发送 + 流式解析 + 事件缓冲    │
│ 事件→AGUI→渲染               │   events   │ │ 重试：429/Retry-After/idle   │
└────────────────────────────┘            │ └ 密钥：DPAPI 库（A20）        │
                                           └──────────────────────────────┘
```

**职责划分（与 Plan B 一致的「推理边界」）**：

- 留 TS：对话循环、上下文组装/压缩、工具执行与权限审批、AGUI、结构化输出的业务校验；
- 迁 .NET：鉴权注入、HTTP 发送、SSE 解析、增量归一化、事件缓冲、重试/退避、按 key 限流；
- 密钥：.NET 独占；TS 提交 `profileId`（或 `{providerId, model, baseUrl}`），永不见 key。

### 3.1 请求塑形归属（起步建议）

| 方案 | .NET 职责 | 跨协议移植 | 建议 |
|---|---|---|---|
| A 全量 | 请求构建 + 发送 + 解析 | 前后两侧 + registry | 终态 |
| **B 响应侧（起步）** | TS 传已塑形 wire 请求，.NET 注入鉴权 + 发送 + 解析 + 缓冲 | 只搬响应侧（≈1,000 行量级） | **先做** |
| C 原始转发 | 只发送 + 回传原始块，TS 解析 | ≈0 | 不作为目标 |

方案 B 中 TS 需要把 wire 请求（`protocol/url/body`，headers 不含真 key）传给 llm-host；
`protocol` 决定 .NET 用哪套解析器。registry/reasoning/tool-choice 等请求侧事实源**不上移**。

## 4. 协议（job + cursor）

### 4.1 ops

| op | 载荷 | 返回 |
|---|---|---|
| `llm.submit` | `jobId, lane(interactive/normal/low), profileId, wire{protocol,url,headers?,body}, options{stream,timeoutMs,idleTimeoutMs,maxRetries}` | `{accepted, queuePosition}` |
| `llm.poll` | `jobId, cursor, maxEvents, waitMs`（长轮询，`waitMs` 内无新事件即空返回） | `{events[], nextCursor, status, usage?, final?}` |
| `llm.cancel` | `jobId` | `{cancelled}` |
| `job.list` | — | 诊断用（不含事件体） |
| `shutdown` | — | 退出 |

### 4.2 事件

| type | 字段 | 说明 |
|---|---|---|
| `text_delta` | `text` | 批量合并后的可见文本 |
| `thinking_delta` | `text` | 思考增量（reasoning_content / thinking block） |
| `tool_call` | `id, name, arguments` | 工具调用（增量聚合完成后一次性给，与现 TS accumulator 语义对齐） |
| `retry` | `attempt, delayMs, reason` | 重试状态（对接现有 `ModelRetryStatus`） |
| `usage` | `input, output, cachedInput?, cacheCreation?` | 用量（TS 落 `token-usage-store`） |
| `finish` | `reason` | 终止原因 |
| `error` | `code, message, category` | 复用现有模型错误分类口径 |
| `truncated` | `gap` | 缓冲溢出丢批标记（见 4.4） |

- **cursor**：单调递增 `seq`。poll 带 cursor 幂等取，TS 可安全重试、乱序恢复；
- **批合并**：窗口 16–50ms 或累计 ≥256 字符，先到先发；400 TPS ≈ 8–13 事件/秒；
- **长轮询**：`waitMs` 默认 500，空闲挂起，新事件立即返回——延迟接近推送，实现是轮询。

### 4.3 job 生命周期

`queued → running → (done | failed | cancelled | timeout)`。

- 终态后缓冲保留 `JOB_TTL`（默认 5 分钟）供补读，随后回收；
- 上限：在途 job 数（默认 64）、单 job 缓冲高水位（默认 1MB / 4k 事件）；
- TS 未轮询期间事件照常入 ring，不阻塞厂商流（受反压约束，见下）。

### 4.4 反压（关键设计点）

- .NET 控制着厂商连接：**缓冲高水位时暂停读取上游 response stream**，
  流量控制直接作用到 TCP，厂商端自然减速——不做无界内存缓冲；
- 若应用层无法暂停（某些 SDK/流实现），ring 满按 drop-oldest 丢批并发 `truncated` 事件；
  文本渲染可容忍缺口，工具调用/usage/finish 事件**永不丢弃**（单独优先级通道）。

## 5. 优先级与限流（接管 llm-queue）

### 5.1 通道

| lane | 消费者 | 语义 |
|---|---|---|
| `interactive` | 主聊天、渠道回复（QQ/飞书） | **永不被后台堵塞**；独立并发额度，可直接发起 |
| `normal` | 主动聊天、朋友圈、社交上下文 | 与 interactive 并发不互斥，受全局上限约束 |
| `low` | MemoryJudge/压缩/反思/Summary/Wiki、心情观察、插件 LLM | 与现有 `llm-queue` 同语义：**单并发 FIFO 串行** |

主聊天不入队的现状语义（`llm-queue.ts` 头注释）在服务侧以 lane 保留——这是最容易引入的回归点，
列为一等验收项。

### 5.2 限流与重试

- 按 `provider + key` 的并发/速率闸（默认串行，可配）；
- `429`/`Retry-After`/`5xx`/网络错误：指数退避 + 上限；重试预算沿用 `modelRequestMaxRetries`；
- **重放规则与现 Harness 对齐**：
  - 首个可见增量前失败 → 可整请求重试；
  - 已有可见增量 → **不重放**（防重复输出），以 `error` 收口；
  - idle 超时 → 可判重试或失败（沿用 `model-retry-runner` 语义）。
- 过渡期 TS 的 `enqueueLLMTask` 保留为薄壳（打 lane 标记 / 兼容旧调用），稳定后移除。

## 6. 服务器版本预留

- **协议字段预留**：`tenantId / userId / sessionId / traceId / idempotencyKey`（桌面版可空）；
- **传输核心落 `cyrene-core`**：响应解析 / 重试 / 限流不依赖 Windows（RFC D2 的 CI 断言：
  不出现 net10.0-windows / WPF / WinForms 依赖），云端 `DialogLoop` 直接以库调用复用；
- **依赖倒置**：密钥库（DPAPI → 服务端密钥，0600 / 静态加密方式见 RFC §2.1）、
  job 存储（内存 ring → Redis/SQLite）、队列（进程内 → 分布式）、传输（stdio → HTTP/gRPC）
  都做成实现可替换的口子；
- **无 Electron 假设**：llm-host 不读 `app.getPath`、不依赖 data-dir 语义（路径由调用方给或配置给）；
- **内存预算**：事件缓冲高水位 / ring 大小按 RFC D5 核算（cloud-server 空载 ≤150MB、
  基准负载 ≤300MB、容器上限 512MB）；
- **可观测**：每 job 的 queue wait / TTFT / TPS / retry 计数 / token 用量出结构化指标，
  桌面版写日志，服务器版直接接 metrics；
- **审计**：who(submit) → what(profile/model) → usage，为配额与审计留字段。

## 7. 分批落地

| 批次 | 内容 | 估计 |
|---|---|---|
| 2.0 MVP | `--llm-host` 骨架 + job/cursor 协议 + OpenAI 协议流式解析 + interactive 通道；主聊天双轨（llm-host 优先，TS 回退需 A20 密钥库就绪） | 2–3 周 |
| 2.1 队列 | normal/low 通道接管 `llm-queue` 消费点（memory/moments/社交/插件）；重试/限流集中化 | 1–2 周 |
| 2.2 协议全量 | Anthropic + Responses 解析（thinking/rawAssistant/encrypted reasoning）；structured output 归属定案 | 2–3 周 |
| 2.3 服务器化 | 传输核心进 `cyrene-core`（无 Windows 依赖）+ 契约字段预留 + 指标/审计；云端 DialogLoop 复用（RFC Phase 1 / IKJK2M 定环的复用形态） | 对齐云端昔涟 RFC 里程碑 |

## 8. 验收与测试

| # | 用例 | 期望 |
|---|---|---|
| 1 | mock 400 TPS 流 | 主线程 CPU/事件循环延迟无可见劣化；轮询事件 ≤15/s |
| 2 | cursor 幂等/补读 | 重复 poll、断点续读、乱序恢复不丢不重 |
| 3 | 反压 | 停止轮询 ≥30s：ring 不溢出（上游被暂停）；无法暂停时出 `truncated` |
| 4 | 取消延迟 | `llm.cancel` → 上游连接 100ms 级中断 |
| 5 | 重试语义 | 首增量前失败重试；有增量后不重放；`retry` 事件正确推送 |
| 6 | lane 隔离 | low 通道满载时 interactive 的 TTFT 不劣化（对照现状） |
| 7 | 双轨 diff | 同一请求 llm-host 与 TS 直连的文本/工具调用/usage 一致 |
| 8 | 崩溃恢复 | llm-host 中途退出：TS 明确收口（`E_LLM_HOST_LOST`），不重放副作用 |
| 9 | 契约 | C#/TS 协议字段一致性测试（复用 agent-orchestration 扫描 C# 源码锁契约的先例）|

## 9. 开放问题

1. 请求塑形：按 §3.1 方案 B 起步，A 作为终态的时间点；
2. structured output 三模式的归属（请求侧留 TS 可零改动，走 A 则 .NET 也要实现）；
3. usage 记账：.NET 上报、TS 落账（建议），还是服务侧维护对账；
4. `--llm-host` 与规划中的 `--backend` 合并宿主的关系（合并触发条件）；
5. B1 铁律正式废止时点（llm-host 稳定 + A20 落地后）；
6. 服务器版的鉴权/租户模型是否复用桌面配置 schema（现在预留字段，不定协议）。

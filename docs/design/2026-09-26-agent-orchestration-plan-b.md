# Agent 编排 Plan B：编排下沉、循环复用（v1 已落地）

> 日期：2026-09-26 · 状态：**机制 v1 已落地**（协议 + .NET 编排器 + TS worker/客户端 + 契约/单测/冒烟）
> 关联：`docs/multi-agent-architecture.md`（原 P1/P2 路线）、`src/main/orchestrator/harness/cyrene-harness.ts`

## 1. 决策：为什么不是把 CyreneHarness 搬进 .NET

对"把 Agent 循环搬到 .NET"做过完整评估（依赖面 4,736 行纯逻辑 + ~3,500 行测试，
外加 vendors 3,453 行 / tools registry 8,480 行）：

- **纯控制逻辑移植本身不难**（1–2 周），但 Harness 的价值恰恰在与
  dispatcher / vendors / 权限审批 / AGUI 事件的紧耦合；
- **边界成本占七成**：流式协议、逐调用工具桥、uncertainEffects/ledger 的
  单边权威、checkpoint 持久化、行为一致性回归（6–10 周且长尾风险高）；
- Harness 是 **I/O 密集**（LLM/工具都是 await），搬过去买不到性能，
  买到的是架构对齐；而"主进程单点"用子进程/编排层就能解决。

因此 Plan B = **.NET 只做编排机制，单会话循环 100% 复用 TS CyreneHarness**：

```
聊天/调用方（Electron 主进程）
   │  agentOrchestratorClient.runTurn(groupId, message)
   ▼
cyrene-native --agent-orchestrator（.NET，本设计）
   │  机制：会话生命周期 / 邮箱 / pipeline 推进 / 取消 / 上限
   │  策略：由调用方以 group 配置声明（pipeline 顺序、角色、提示词）
   │
   │  step 帧（stdio JSON 行）              step_result 帧
   ▼                                        ▲
HarnessSessionWorker（TS，Electron 主进程）
   │  composeStepUserContent（邮箱 + 原请求）
   ▼
runCyreneHarness（完整循环：压缩/调度/重试/熔断/副作用账本/缓存）
   │
   ▼
vendors（API key）/ toolRegistry / 权限审批 / ToolOutputStore —— 永不离开 Electron
```

设计边界（与 `multi-agent-architecture.md` 一致）：

1. **密钥永不落 .NET 进程**：LLM 请求在 TS 侧发起；
2. **权限审批闸门留在 Electron**：工具执行与审批都在 TS 侧；
3. **.NET 只提供机制不做策略**：pipeline 顺序、角色提示词、工具白名单
   全部由调用方在 `group.create` 时声明；
4. **单会话同一时刻至多一个在途 step**：host 不会并发下发，worker 侧也会拒绝。

## 2. 协议（stdio JSON 行）

请求（`id` 应答式）；响应 `{id, ok, data?|error?}`：

| op | 载荷 | 说明 |
|---|---|---|
| `group.create` | `groupId, members[{sessionId, role?, systemPrompt?, toolWhitelist?, conversationId?}], pipeline[], stepTimeoutMs?` | 建组；pipeline ⊆ members |
| `group.destroy` | `groupId` | 取消在途/排队 turn 并删组 |
| `group.list` | — | 组/成员/邮箱深度/排队数 |
| `turn.start` | `callId, groupId, message` | 启动流水线；终态异步回 `turn.result` |
| `turn.cancel` | `callId` | 排队中直接出队；在途转 `step.cancel` |
| `mailbox.list` | `sessionId` | 诊断用 |
| `shutdown` | — | 退出 |

host → Electron 通知帧：

| 帧 | 说明 |
|---|---|
| `ready` | 进程握手（15s 超时由客户端兜底） |
| `step` | `callId, stepId, sessionId, groupId, index, role, message, mailbox[], config{}` |
| `step.cancel` | 取消指定 step（worker AbortController） |
| `turn.result` | `callId, groupId, ok, status(success/failed/cancelled/timeout), finalAnswer, error, steps[]` |
| `event` | `group.running` / `group.idle` |
| `log` | level + message |

Electron → host 通知帧：`step_result`（`stepId, callId, sessionId, ok, status, finalAnswer, error, rounds?, terminateReason?`）。

跨语言契约（`protocol.ts` ↔ `OrchestratorOps`/`OrchestratorLimits`）由
`agent-orchestration-contract.test.ts` 扫描 C# 源码锁定，任何一侧改名即红。

## 3. 机制语义（不变量）

- **流水线推进**：每一步成功后，`finalAnswer` 只经**邮箱**投递给下一步
  （`{fromSessionId, text}`）；worker 组装为
  `[来自上游的消息] + [原始用户请求]`，不把结果拼进 prompt 模板。
- **turn 串行**：同组排队 FIFO；前一条终态后才启动下一条（上限 8 条）。
- **step 超时**：host 计时（默认 600s，组级可配）→ 下发 `step.cancel` +
  立即以 `timeout` 收口；迟到 `step_result` 因 pending 已摘除而忽略（at-most-once）。
- **取消**：`turn.cancel` → 排队中直接出队；在途发 `step.cancel`，worker
  abort 后回 `cancelled`，由 `RunTurnAsync` 统一收口（不会双重 `turn.result`）。
- **销毁**：`group.destroy` 取消在途与排队 turn，且不再启动排队项。
- **上限**：组 16 / 组内会话 8 / 邮箱 128 / 消息 256KiB / 排队 turn 8；
  与 TS `ORCHESTRATOR_LIMITS` 同名同值。

## 4. 文件清单

| 文件 | 职责 |
|---|---|
| `dotnet/native-windows/Agents/AgentOrchestrator.cs` | 编排机制 + 协议循环（`--agent-orchestrator`） |
| `dotnet/native-windows/Program.cs` | 模式注册 |
| `src/main/orchestrator/agent-orchestration/protocol.ts` | TS 侧协议契约（唯一事实源的镜像） |
| `src/main/orchestrator/agent-orchestration/harness-session-worker.ts` | 会话 transcript、邮箱组装、取消/失败归一 |
| `src/main/orchestrator/agent-orchestration/step-runner.ts` | step → HarnessInput 生产装配（环境注入） |
| `src/main/orchestrator/agent-orchestration/agent-orchestrator-client.ts` | 子进程生命周期 + 帧路由 + turn API |
| `src/main/config.ts` | `agentOrchestrator` 开关（env/conf，统一解析入口） |
| `scripts/verify/agent-orchestrator-smoke.mjs` | 跨进程协议冒烟（stub worker） |

## 5. v1 范围与有意未做

已做：协议、编排机制、worker/客户端、契约测试、单测、跨进程冒烟、
配置开关、设计文档。

未做（按优先级）：

1. **生产环境解析器接线**：`createHarnessStepRunner(resolveEnvironment)`
   需要从"当前设置 + registry + 权限 + FileToolOutputStore + prompt-builder"
   组装每个会话的 `HarnessStepEnvironment`——复用 `harness-adapter` 的
   `prepareToolRuntime` 思路，但走轻量路径（不带 AGUI/run-store/review）。
2. **聊天入口**：把用户消息从聊天 UI 路由到 `runTurn`（以及流式事件回渲染）。
3. **worker 子进程化**：当前循环在 Electron 主进程内（I/O 密集，可接受）；
   `HarnessSessionWorker` 已是传输无关抽象，后续可把 runStep 换成
   `utilityProcess` RPC，协议不变。
4. **会话持久化**：transcript/state 只在内存；可接 `HarnessRunStore` 做崩溃恢复。
5. **邮箱主动唤醒与多轮协作**：现在 mailbox 只服务 pipeline 的单向投递；
   planner↔executor 往返需要 `mailbox.send` + 唤醒策略（P2 后半）。
6. **三 host 合并 `--backend`**（P3）：与 MCP/SSH/tool host 共用监督器。

## 6. 验证

```bash
# TS：worker/客户端/契约/step-runner/config（26 用例）
npx vitest run src/main/orchestrator/agent-orchestration src/main/config.test.ts

# C# 构建
dotnet build dotnet/native-windows/CyreneNative.csproj

# 跨进程冒烟（真实 cyrene-native + stub worker）
npm run verify:agent-orchestrator
```

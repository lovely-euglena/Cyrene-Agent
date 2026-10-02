# 子 Agent 编排接入接口（Plan B · 生产未接线）

> 日期：2026-10-03 · 范围：`src/main/orchestrator/agent-orchestration/task-orchestrator-runner.ts`（新增）、
> `harness-session-worker`、`agent-orchestrator-client`、`step-runner`、`task-runtime` 注入点、`src/main/config.ts`
> 关联：`docs/design/2026-09-26-agent-orchestration-plan-b.md`、提交 `f212f801` / `03bd16b5` / `08432859`

## 1. 目标与边界

- 目标：为「子 Agent（Task）经 agent-orchestrator 执行」把接口留好——.NET 管
  会话/流水线/超时/取消机制，循环 100% 复用 TS CyreneHarness（Plan B 决策）。
- **边界：生产不接线**。`tool-runtime` 未注入 runner、`taskOrchestrator` 默认关，
  线上行为与改动前完全一致；后续启用见 plan-b §5.1。

## 2. 交付物

| 模块 | 内容 |
|---|---|
| `harness-session-worker.ts` | `seedSession()`（resume 预置历史，在途拒绝）、`abortAll()` |
| `agent-orchestrator-client.ts` | host 退出时 `worker.abortAll()`，防本地 Harness 泄漏 |
| `step-runner.ts` | 环境解析器带本 step `signal`；`HarnessStepEnvironment.onCheckpoint` 旁路 |
| `task-orchestrator-runner.ts`（新增） | 单会话 group 执行、会话注册表、终态映射、回退规则、`shutdown()` |
| `task-runtime.ts` | `runOrchestrated` 注入点（type-only 依赖，不注入 = 原路径） |
| `config.ts` | `taskOrchestrator` 开关（`CYRENE_TASK_ORCHESTRATOR` / conf，默认关） |
| 集成测试（新增） | `task-orchestrator-loop.integration.test.ts` + `verify:task-orchestrator-loop` |

## 3. 关键语义

### 3.1 回退规则（防副作用重复）

| 场景 | 结果 |
|---|---|
| 开关关 / exe 缺失 / 启动失败 / `group.create` 失败 | `used:false` → 直跑 TS Harness |
| 首个 step 前 turn 失败/抛错 | `used:false` → 回退直跑 |
| 已执行过 step 后失败 | `used:true failed`，不回退 |
| 用户取消 / host step 超时 | `used:true cancelled / timeout`，不回退 |

### 3.2 超时换算

- profile 有限：host `stepTimeoutMs = profile + 15s` 宽限（Harness 自身超时先生效，host 兜底）；
- profile 不限（0）：近 `int.Max`（避免 host 默认 600s 改变任务原本语义）。

### 3.3 resume

- 旧 messages（不含本轮 prompt）与 `{ todoItems, uncertainEffects: [] }` 经 seed 注入；
- 编排终态 `finalState` 回传任务结算，写 todoItems。

## 4. 验证（本机实测）

| 项 | 结果 |
|---|---|
| 相关单测（worker / client / step-runner / runner / task-runtime / config） | 全绿 |
| `npm run verify:task-orchestrator-loop`（真实 exe + 真循环） | 5/5 通过 |
| `npm run verify:agent-orchestrator`（协议冒烟） | PASS |
| `node scripts/agent-loop-smoke.mjs`（纯 .NET 循环） | 19/19 |
| `tsc -p tsconfig.main.json --noEmit` | 0 错 |

## 5. 遗留

- 生产注入（tool-runtime）+ 开关打开：待验证期后由维护者决定；
- 多角色 pipeline（planner→executor→reviewer）与聊天入口：未做；
- worker 子进程化、mailbox 主动唤醒：未做（plan-b §5 原清单）。

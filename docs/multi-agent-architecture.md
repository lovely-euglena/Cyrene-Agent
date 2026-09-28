# 多 Agent 运行底层架构（v1 设计 + 骨架落地）

> 状态：会话宿主骨架已落地（`--agent-host`）；**多 Agent 编排已按 Plan B 落地
> 机制 v1**（`--agent-orchestrator`：.NET 只做会话/邮箱/pipeline 机制，
> 单会话循环复用 TS CyreneHarness，不再往 .NET 搬循环）——
> 详见 `docs/design/2026-09-26-agent-orchestration-plan-b.md`。
> 关联：MCP 桥（`--mcp-host`）、内置工具宿主（`--tool-host`）——三 host 构成
> .NET 后端演进路线。

## 1. 动机与边界

单 Agent（CyreneAgent，每会话一实例）跑在 Electron 主进程内，问题是：

1. **主进程即单点**——Agent 循环的 CPU 密集段（上下文组装/压缩/工具编排）
   与 UI、IPC、窗口管理抢主线程
2. **无法水平编排**——多 Agent 协作（规划者/执行者/审查者）需要进程级
   隔离，一个 Agent 的失控循环不能拖死其他
3. **密钥与权限天然在主进程**——API keys、权限审批 UI、供应商适配
   （流式 SSE 解析）不适合也不应该搬进后端

因此架构采取**编排下沉、推理留前**的切分：

```
Electron 主进程（前端宿主）                cyrene-native --agent-host
┌──────────────────────────┐              ┌──────────────────────────┐
│ API keys / 供应商适配     │   stdio      │ AgentSessionHost          │
│ 流式渲染 / 权限审批 UI    │  JSON 行协议 │  ├ session s1（规划者）   │
│ LLM 请求代理 ←────────────┼──────────────┼→ llm_request 帧           │
│ 应答注入   ──────────────┼──────────────┼→ llm_response 帧          │
└──────────────────────────┘              │  ├ session s2（执行者）   │
                                          │  ├ session s3（审查者）   │
                                          │  └ 状态机/上下文/白名单    │
                                          └──────────────────────────┘
```

**核心设计决策**：LLM 推理不在 agent-host——step 产生 `llm_request` 帧
回传 Electron，应答经 `llm_response` 回注。密钥永不落 .NET 进程，权限
审批闸门保持在 Electron 侧（用户看到的是同一套审批 UI）。

### 总开关与配置解析（2026-09-26）

agent-host 的启停走统一解析入口 `resolveDotnetConfig()`（`src/main/config.ts`），
优先级：环境变量 `CYRENE_AGENT_HOST` > `./config/cyrene.conf` 的 `agentHost` >
默认启用。布尔值容忍 `1/true/on/yes`（启用）与 `0/false/off/no`（关闭），
非法值回落默认。**禁止在业务模块散读 `process.env.CYRENE_AGENT_HOST`**
（历史 bug：`!== "0"` 把 `false`/`abc` 都当成启用）。关闭或 native exe
缺失时全部 API 返回 `{ ok: false, error: "agent-host 未启用" }`，上层照旧走
TS 循环（`agent-process-manager.ts`）。

## 2. 会话模型

| 概念 | 说明 |
|---|---|
| `session` | 编排原子单位：独立上下文、工具白名单、状态机（idle/stepping/blocked） |
| `step` | 一次推进：消息入 inbox → 状态机走一步（组装上下文/决定工具调用/产出 LLM 请求） |
| `role` | 会话角色提示（planner/executor/reviewer/自定义），create 时注入 |
| `mailbox` | 会话间消息传递（s1 → s2 的任务移交），多 Agent 协作的基本通信原语 |
| `whitelist` | 每会话独立工具白名单——执行者拿不到 fs-write，审查者只读 |

会话数量上限（默认 16）+ 单会话 inbox 深度上限（128）防失控。

## 3. 协议（已实现于 AgentSessionHost.cs）

```
→ {"op":"create","sessionId":"s1","config":{"role":"planner",...}}
← {"op":"result","ok":true}
→ {"op":"destroy","sessionId":"s1"}
→ {"op":"step","callId":"c1","sessionId":"s1","message":"..."}
← {"op":"llm_request","callId":"c1","session":{"id":"s1","role":"planner",
      "context":"<组装后的上下文>","history":[...]}}     ← 主进程代理推理
→ {"op":"llm_response","callId":"c1","content":"模型输出"}
← {"op":"result","callId":"c1","ok":true,"data":{"state":"idle"}}
→ {"op":"list"}        ← 会话清单+状态
→ {"op":"shutdown"}
```

## 4. 三 host 合一路线（.NET 后端整合）

```
现状：--mcp-host（MCP 连接）  --tool-host（内置工具）  --agent-host（会话）
                    ↓ 后续合并
       cyrene-native --backend（单进程，子系统注册制）
```

合并动机：三 host 共享同一套 spawn/监督/回退基建（TS 侧三个客户端
高度同构），合并后一份监督器、一次握手、单一故障域。合并触发条件：
agent-host 的 LLM 回调闭环上线时（避免两次协议大改）。

## 5. TS 侧接入点（下一阶段）

- `AgentProcessManager`（新）：管理 agent-host 生命周期 + 会话 CRUD +
  LLM 请求代理（把 llm_request 转发给现有 vendor 适配层）
- 多 Agent 编排策略（谁先 step、结果如何聚合）放 TS 侧策略层，
  .NET 只提供机制不做策略——保持 host 简单可测

## 6. 阶段计划

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0 | 会话宿主骨架（create/destroy/step/llm 回调帧） | ✅ |
| P1 | LLM 回调闭环（TS 代理 + 流式）+ 单会话端到端 | 被 Plan B 取代（`--agent-host` 路径保留） |
| P2 | mailbox + 多会话编排（规划→执行→审查） | 🟡 机制 v1 ✅（`--agent-orchestrator`，pipeline/邮箱/取消/上限 + 冒烟）；生产接线（环境解析器/聊天入口）待做 |
| P3 | 三 host 合并为 --backend + 会话持久化 | 待做 |

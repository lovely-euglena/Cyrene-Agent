/**
 * agent-orchestrator 跨语言协议契约（Plan B：编排下沉、循环复用）。
 *
 * 架构：
 *   Electron 主进程（TS Harness 循环 + 供应商/工具/审批）
 *        ↕ stdio JSON 行协议
 *   cyrene-native --agent-orchestrator（.NET：会话/邮箱/流水线机制，不碰密钥）
 *
 * 唯一事实源：dotnet/native-windows/Agents/AgentOrchestrator.cs 的
 * OrchestratorOps / OrchestratorLimits 常量。任何一侧改 op、帧名或上限，
 * agent-orchestration-contract.test.ts 立即变红（同 native-settings-protocol 的模式）。
 *
 * 设计边界（详见 docs/design/2026-09-26-agent-orchestration-plan-b.md）：
 * - .NET 只提供机制：会话生命周期、邮箱、流水线推进、取消、上限；
 *   不做策略（谁先 step、结果如何聚合由调用方以 pipeline 声明）。
 * - LLM 推理与工具执行全在 Electron 侧，由 HarnessSessionWorker 复用
 *   CyreneHarness 跑完整循环；.NET 进程永远看不到 API key 与工具正文。
 */

/** cyrene-native 启动参数。 */
export const AGENT_ORCHESTRATOR_ARG = "--agent-orchestrator";

/** 机制上限（与 C# OrchestratorLimits 同名同值）。 */
export const ORCHESTRATOR_LIMITS = {
  /** 同时存在的 group 数上限。 */
  maxGroups: 16,
  /** 单 group 成员（会话）数上限。 */
  maxSessionsPerGroup: 8,
  /** 单会话邮箱深度上限。 */
  mailboxDepth: 128,
  /** 单条 turn 消息字符数上限。 */
  maxMessageChars: 256 * 1024,
  /** 单 step 默认超时（毫秒）；group.create 可覆盖。 */
  defaultStepTimeoutMs: 600_000,
  /** 单 group 排队 turn 数上限。 */
  maxQueuedTurnsPerGroup: 8,
} as const;

/** Electron → host 请求 op（id 请求/应答式）。 */
export const ORCHESTRATOR_REQUEST_OPS = {
  GroupCreate: "group.create",
  GroupDestroy: "group.destroy",
  GroupList: "group.list",
  TurnStart: "turn.start",
  TurnCancel: "turn.cancel",
  MailboxList: "mailbox.list",
  Shutdown: "shutdown",
} as const;

/** host → Electron 通知帧 op。 */
export const ORCHESTRATOR_HOST_FRAME_OPS = {
  Ready: "ready",
  Step: "step",
  StepCancel: "step.cancel",
  TurnResult: "turn.result",
  Event: "event",
  Log: "log",
} as const;

/** Electron → host 通知帧 op（step 执行完成回注）。 */
export const ORCHESTRATOR_CLIENT_FRAME_OPS = {
  StepResult: "step_result",
} as const;

/** host 生命周期事件名（op="event" 的 name 字段）。 */
export const ORCHESTRATOR_EVENT_NAMES = {
  GroupRunning: "group.running",
  GroupIdle: "group.idle",
} as const;

/** step 执行终态：与 Harness terminateReason 的映射见 harness-session-worker.ts。 */
export type OrchestratorStepStatus = "success" | "failed" | "cancelled" | "timeout";

export interface OrchestratorMailboxItem {
  fromSessionId?: string;
  text: string;
}

export interface OrchestratorStepConfig {
  systemPrompt?: string;
  toolWhitelist?: string[] | null;
  conversationId?: string;
  stepTimeoutMs?: number;
}

/** host → Electron：请对指定会话执行一步（完整 Harness 循环）。 */
export interface OrchestratorStepFrame {
  op: "step";
  callId: string;
  stepId: string;
  groupId: string;
  sessionId: string;
  /** 流水线内序号（0 起）。 */
  index: number;
  role?: string;
  /** 本轮 turn 的原始用户消息（每个 step 都携带，供下游会话看到原请求）。 */
  message: string;
  /** 上游投递到本会话邮箱的消息（已由 host 清空）。 */
  mailbox: OrchestratorMailboxItem[];
  config: OrchestratorStepConfig;
}

export interface OrchestratorStepCancelFrame {
  op: "step.cancel";
  callId: string;
  stepId: string;
  sessionId: string;
}

/** Electron → host：一步执行完成（成功/失败/取消）。 */
export interface OrchestratorStepResultFrame {
  op: "step_result";
  callId: string;
  stepId: string;
  sessionId: string;
  ok: boolean;
  status: OrchestratorStepStatus;
  finalAnswer?: string;
  error?: string;
  /** 仅诊断用：轮数/终态等稳定元数据，不参与调度。 */
  rounds?: number;
  terminateReason?: string;
}

export interface OrchestratorTurnStepRecord {
  sessionId: string;
  ok: boolean;
  status: OrchestratorStepStatus;
  finalAnswer?: string;
}

/** host → Electron：整条流水线 turn 的终态。 */
export interface OrchestratorTurnResultFrame {
  op: "turn.result";
  callId: string;
  groupId: string;
  ok: boolean;
  status: OrchestratorStepStatus;
  finalAnswer?: string;
  error?: string;
  steps: OrchestratorTurnStepRecord[];
}

export interface OrchestratorGroupMemberConfig {
  sessionId: string;
  role?: string;
  systemPrompt?: string;
  /** null = 不限制；缺省 = 不限制。机制只透传，白名单过滤由 worker 侧执行。 */
  toolWhitelist?: string[] | null;
  conversationId?: string;
}

export interface OrchestratorGroupCreateRequest {
  groupId: string;
  members: OrchestratorGroupMemberConfig[];
  /** 流水线顺序（sessionId 序列），必须全部属于 members。 */
  pipeline: string[];
  stepTimeoutMs?: number;
}

export interface OrchestratorGroupSummary {
  groupId: string;
  state: "idle" | "running";
  activeTurnCallId?: string;
  queuedTurns: number;
  pipeline: string[];
  members: Array<{
    sessionId: string;
    role?: string;
    state: "idle" | "stepping" | "failed";
    stepCount: number;
    mailboxDepth: number;
  }>;
}

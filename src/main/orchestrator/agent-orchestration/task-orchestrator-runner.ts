/**
 * TaskOrchestratorRunner —— 子 Agent（Task）经 agent-orchestrator 执行的接口层。
 *
 * 状态：**接口已就绪，生产未接线**。生产路径仍是 task-runtime 直跑 CyreneHarness
 *（tool-runtime 不注入本 runner）。后续启用只需两步：
 *   1. tool-runtime 把 getTaskOrchestratorRunner() 传给
 *      createTaskExecutor({ runOrchestrated: ... })；
 *   2. 开关 taskOrchestrator=1（CYRENE_TASK_ORCHESTRATOR / cyrene.conf）。
 *
 * 语义（Plan B：编排下沉、循环复用）：
 * - .NET 只管会话/邮箱/流水线/超时/取消机制；每个 step 的循环仍由
 *   createHarnessStepRunner → runCyreneHarness 在本进程完成；
 * - 密钥、工具执行、权限审批永不进入 .NET 进程；
 * - 回退规则：仅「尚未执行任何 step」的基础设施失败才回退直跑（used:false）；
 *   已执行过 step / 用户取消 / host 超时一律不回退，避免工具副作用重复。
 */
import { resolveDotnetConfig } from "../../config";
import { AgentOrchestratorClient, type AgentOrchestratorTurnResult } from "./agent-orchestrator-client";
import { HarnessSessionWorker, type WorkerSessionSeed } from "./harness-session-worker";
import { createHarnessStepRunner, type HarnessStepEnvironment } from "./step-runner";
import type {
  OrchestratorGroupCreateRequest,
  OrchestratorStepFrame,
  OrchestratorStepStatus,
} from "./protocol";
import type { AgentState, HarnessEvent } from "../harness";

/** 端口：便于单测注入 fake；AgentOrchestratorClient 结构满足。 */
export interface TaskOrchestratorClientPort {
  enabled(): boolean;
  ensureStarted(): Promise<boolean>;
  createGroup(config: OrchestratorGroupCreateRequest): Promise<{ ok: boolean; error?: string }>;
  runTurn(
    groupId: string,
    message: string,
    options?: { signal?: AbortSignal },
  ): Promise<AgentOrchestratorTurnResult>;
  destroyGroup(groupId: string): Promise<{ ok: boolean; error?: string }>;
}

/** 端口：便于单测注入 fake；HarnessSessionWorker 结构满足。 */
export interface TaskOrchestratorWorkerPort {
  seedSession(sessionId: string, seed: WorkerSessionSeed): void;
  destroySession(sessionId: string): boolean;
  abortAll(): number;
  /** 只读 transcript（终态 AgentState 透传给任务结算写 todoItems）。 */
  getTranscript(sessionId: string): { state?: AgentState } | undefined;
}

export interface TaskOrchestrationInput {
  /** 任务 id（日志/诊断用）。 */
  taskId: string;
  /** 会话唯一 id（建议 `taskId:childRunId`，避免与历史组/会话冲突）。 */
  sessionId: string;
  /** 编排组 id（同一 turn 内唯一）。 */
  groupId: string;
  /** 角色标签（诊断用；提示词/工具白名单由 environment 决定）。 */
  role?: string;
  /** 本轮 turn 的用户消息（子任务 prompt）。 */
  message: string;
  /** 会话历史与状态（resume/恢复时注入）。 */
  seed: WorkerSessionSeed;
  /** host 侧 step 超时（由调用方经 resolveHostStepTimeoutMs 计算）。 */
  stepTimeoutMs: number;
  /** 每个 step 的环境装配（模型/工具/提示词/权限/存储由任务侧注入）。 */
  resolveEnvironment: (context: { signal: AbortSignal }) => HarnessStepEnvironment;
  /** Harness 事件出口（任务 trace 投影用）。 */
  onEvent?: (event: HarnessEvent) => void;
  /** 父运行取消信号。 */
  signal?: AbortSignal;
}

export type TaskOrchestrationOutcome =
  | {
      used: true;
      status: OrchestratorStepStatus;
      finalAnswer?: string;
      error?: string;
      /** turn.result 内的 step 记录数（诊断）。 */
      steps: number;
      /** 会话终态 AgentState（任务结算写 todoItems 用）。 */
      finalState?: AgentState;
    }
  | { used: false; reason: string };

/** host step 超时宽限：Harness 自身超时先生效，host 只做兜底。 */
export {
  ORCHESTRATOR_STEP_TIMEOUT_GRACE_MS,
  ORCHESTRATOR_UNBOUNDED_STEP_TIMEOUT_MS,
  resolveHostStepTimeoutMs,
} from "./protocol";

interface RegisteredTaskSession {
  resolveEnvironment: (context: { signal: AbortSignal }) => HarnessStepEnvironment;
  onEvent?: (event: HarnessEvent) => void;
  stepStarted: boolean;
}

/**
 * 按 sessionId 分发的信封：把 host step / Harness 事件路由到对应任务的
 * 环境装配与事件出口。生产由 worker 的 runStep/onEvent 调用；
 * 单测可注入本注册表并手工 markStepStarted 验证回退规则。
 */
export class TaskStepEnvironmentRegistry {
  private readonly sessions = new Map<string, RegisteredTaskSession>();

  register(
    sessionId: string,
    entry: { resolveEnvironment: RegisteredTaskSession["resolveEnvironment"]; onEvent?: (event: HarnessEvent) => void },
  ): void {
    if (this.sessions.has(sessionId)) throw new Error(`编排会话已注册: ${sessionId}`);
    this.sessions.set(sessionId, {
      resolveEnvironment: entry.resolveEnvironment,
      ...(entry.onEvent ? { onEvent: entry.onEvent } : {}),
      stepStarted: false,
    });
  }

  unregister(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  hasStepStarted(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.stepStarted ?? false;
  }

  /** 标记会话已进入 step 执行（生产由 resolve 触发；测试/诊断可直接调用）。 */
  markStepStarted(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (entry) entry.stepStarted = true;
  }

  /** worker 的 step 解析入口：命中即标记 started 并返回环境。 */
  resolve(step: OrchestratorStepFrame, context: { signal: AbortSignal }): HarnessStepEnvironment {
    const entry = this.sessions.get(step.sessionId);
    if (!entry) throw new Error(`未注册的编排会话: ${step.sessionId}`);
    entry.stepStarted = true;
    return entry.resolveEnvironment(context);
  }

  /** worker 的事件出口：仅路由给对应会话。 */
  emit(event: HarnessEvent, step: Pick<OrchestratorStepFrame, "sessionId">): void {
    this.sessions.get(step.sessionId)?.onEvent?.(event);
  }

  get size(): number {
    return this.sessions.size;
  }
}

export interface TaskOrchestratorRunnerOptions {
  /** 测试注入：替换默认 AgentOrchestratorClient。 */
  client?: TaskOrchestratorClientPort;
  /** 测试注入：替换默认 HarnessSessionWorker。 */
  worker?: TaskOrchestratorWorkerPort;
  /** 测试注入：共享环境注册表（默认内部新建）。 */
  registry?: TaskStepEnvironmentRegistry;
  /** 测试注入：替代 resolveDotnetConfig().taskOrchestrator。 */
  isEnabled?: () => boolean;
}

export interface TaskOrchestratorRunner {
  run(input: TaskOrchestrationInput): Promise<TaskOrchestrationOutcome>;
  readonly registry: TaskStepEnvironmentRegistry;
  enabled(): boolean;
}

export function createTaskOrchestratorRunner(
  options: TaskOrchestratorRunnerOptions = {},
): TaskOrchestratorRunner {
  const registry = options.registry ?? new TaskStepEnvironmentRegistry();
  const worker: TaskOrchestratorWorkerPort = options.worker ?? new HarnessSessionWorker({
    runStep: createHarnessStepRunner((step, context) => registry.resolve(step, context)),
    onEvent: (event, step) => registry.emit(event, step),
  });
  // 默认 client 只与默认 worker 组合；测试注入 client 时应同时注入 worker。
  const client: TaskOrchestratorClientPort = options.client
    ?? new AgentOrchestratorClient({ worker: worker as HarnessSessionWorker });
  const isEnabled = options.isEnabled ?? (() => resolveDotnetConfig().taskOrchestrator);

  async function run(input: TaskOrchestrationInput): Promise<TaskOrchestrationOutcome> {
    if (!isEnabled()) return { used: false, reason: "taskOrchestrator 开关未启用" };
    if (!client.enabled()) {
      return { used: false, reason: "agent-orchestrator 未启用（开关或 native exe 缺失）" };
    }
    if (input.signal?.aborted) return { used: true, status: "cancelled", error: "已取消", steps: 0 };

    registry.register(input.sessionId, {
      resolveEnvironment: input.resolveEnvironment,
      ...(input.onEvent ? { onEvent: input.onEvent } : {}),
    });
    let groupCreated = false;
    try {
      if (!(await client.ensureStarted())) return { used: false, reason: "agent-orchestrator 启动失败" };
      worker.seedSession(input.sessionId, input.seed);

      const created = await client.createGroup({
        groupId: input.groupId,
        members: [{ sessionId: input.sessionId, ...(input.role ? { role: input.role } : {}) }],
        pipeline: [input.sessionId],
        stepTimeoutMs: input.stepTimeoutMs,
      });
      if (!created.ok) return { used: false, reason: created.error ?? "group.create 失败" };
      groupCreated = true;

      const result = await client.runTurn(
        input.groupId,
        input.message,
        input.signal ? { signal: input.signal } : {},
      );
      // 首个 step 之前失败 → 基础设施故障，允许上层回退直跑；
      // 一旦有 step 执行过，副作用不可假设幂等，绝不回退。
      if (!result.ok && result.status === "failed" && !registry.hasStepStarted(input.sessionId)) {
        return { used: false, reason: result.error ?? "turn 在首个 step 前失败" };
      }
      const finalState = worker.getTranscript(input.sessionId)?.state;
      return {
        used: true,
        status: result.status,
        ...(result.finalAnswer !== undefined ? { finalAnswer: result.finalAnswer } : {}),
        ...(result.error !== undefined ? { error: result.error } : {}),
        steps: result.steps?.length ?? 0,
        ...(finalState ? { finalState } : {}),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!registry.hasStepStarted(input.sessionId)) return { used: false, reason: message };
      return { used: true, status: "failed", error: message, steps: 0 };
    } finally {
      if (groupCreated) {
        try {
          await client.destroyGroup(input.groupId);
        } catch {
          // host 可能已退出，组随进程消失
        }
      }
      // 中止可能泄漏的在途 step，并清 transcript（下次运行重新 seed）
      worker.destroySession(input.sessionId);
      registry.unregister(input.sessionId);
    }
  }

  return { run, registry, enabled: isEnabled };
}

let singleton: TaskOrchestratorRunner | null = null;

/** 生产单例（懒建）：同一条 native 宿主进程服务所有任务。 */
export function getTaskOrchestratorRunner(): TaskOrchestratorRunner {
  if (!singleton) singleton = createTaskOrchestratorRunner();
  return singleton;
}

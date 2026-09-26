/**
 * HarnessSessionWorker —— agent-orchestrator 的会话执行器（Plan B 核心）。
 *
 * 职责边界：
 * - 持有每个会话的 transcript（messages + AgentState），跨 step 续跑；
 * - 把 host 下发的 step（含上游邮箱消息）组装成本轮 user 消息；
 * - 执行一步完整 CyreneHarness 循环（具体装配由注入的 runStep 决定），
 *   把 Harness 事件透传给上层、把 checkpoint 状态回写进会话；
 * - 取消（host step.cancel / 上层 abort）与失败语义归一为
 *   success / failed / cancelled 三态回注 host。
 *
 * 本模块只依赖 Harness 类型，不 import electron / vendors / tool registry，
 * 便于单测注入 fake runStep；生产装配见 step-runner.ts。
 */

import type { ChatMessage } from "../vendors/types";
import type { AgentState, HarnessEvent, HarnessResult } from "../harness";
import type {
  OrchestratorStepFrame,
  OrchestratorStepResultFrame,
  OrchestratorStepStatus,
} from "./protocol";

/** 会话级累积状态：同一 session 的多个 step 共享，destroy 时清空。 */
export interface WorkerSessionTranscript {
  sessionId: string;
  messages: ChatMessage[];
  state?: AgentState;
  stepCount: number;
}

export interface SessionStepExecutionRequest {
  step: OrchestratorStepFrame;
  signal: AbortSignal;
  /** 会话历史 + 本轮 user 消息（worker 已组装）。 */
  messages: ChatMessage[];
  /** 会话上一步结束时的 AgentState（todo/uncertainEffects 续跑）。 */
  state?: AgentState;
  /** Harness 事件出口（透传给上层帧桥）。 */
  emit: (event: HarnessEvent) => void;
}

export interface SessionStepExecutionResult {
  result: HarnessResult;
  /** 终态检查点消息（未提供时回退 request.messages）。 */
  messages?: ChatMessage[];
  /** 终态 AgentState（未提供时回退 result.finalState）。 */
  state?: AgentState;
}

export interface HarnessSessionWorkerOptions {
  /** 执行一步；生产注入 step-runner，测试注入 fake。 */
  runStep: (request: SessionStepExecutionRequest) => Promise<SessionStepExecutionResult>;
  /** 每步 Harness 事件的只读出口（client 转 step.event 帧）。 */
  onEvent?: (event: HarnessEvent, step: OrchestratorStepFrame) => void;
}

/**
 * 把 host 下发的 step 组装成本轮 user 消息：
 * - 无邮箱消息（流水线首步）→ 原始用户消息；
 * - 有邮箱消息 → 上游消息块 + 原始用户请求（下游会话没有首步历史，
 *   必须看到原请求才能正确执行）。
 */
export function composeStepUserContent(step: Pick<OrchestratorStepFrame, "message" | "mailbox">): string {
  const mailbox = step.mailbox ?? [];
  if (mailbox.length === 0) return step.message;
  const blocks = mailbox.map(
    (item) => `[来自 ${item.fromSessionId ?? "上游会话"} 的消息]\n${item.text}`,
  );
  return [...blocks, `[原始用户请求]\n${step.message}`].join("\n\n---\n\n");
}

/** Harness 终态 → step 三态（timeout 由 host 侧产生，worker 不上报）。 */
function mapStepStatus(result: HarnessResult): OrchestratorStepStatus {
  if (result.terminateReason === "cancelled") return "cancelled";
  if (result.terminateReason === undefined) return "success";
  return "failed";
}

export class HarnessSessionWorker {
  private readonly sessions = new Map<string, WorkerSessionTranscript>();
  private readonly activeSteps = new Map<string, { controller: AbortController; sessionId: string }>();
  private readonly activeBySession = new Map<string, string>();

  constructor(private readonly options: HarnessSessionWorkerOptions) {}

  /** 执行一步。永不抛出：异常/取消都归一为 step_result 帧数据。 */
  async executeStep(step: OrchestratorStepFrame): Promise<OrchestratorStepResultFrame> {
    if (this.activeBySession.has(step.sessionId)) {
      return this.failureFrame(step, `会话 ${step.sessionId} 已有在途 step，拒绝并发执行`);
    }
    const existing = this.sessions.get(step.sessionId);
    const transcript = this.ensureSession(step.sessionId);
    const controller = new AbortController();
    this.activeSteps.set(step.stepId, { controller, sessionId: step.sessionId });
    this.activeBySession.set(step.sessionId, step.stepId);

    const messages: ChatMessage[] = [
      ...transcript.messages,
      { role: "user", content: composeStepUserContent(step) },
    ];
    try {
      const execution = await this.options.runStep({
        step,
        signal: controller.signal,
        messages,
        ...(transcript.state ? { state: transcript.state } : {}),
        emit: (event) => this.options.onEvent?.(event, step),
      });
      // 取消是 host 的显式意图：即使取消竞态下模型刚好收尾，也按 cancelled 上报。
      if (controller.signal.aborted) {
        // 首次 step 即被取消：不留下空会话壳
        if (!existing && transcript.stepCount === 0) this.sessions.delete(step.sessionId);
        return this.frame(step, {
          ok: false,
          status: "cancelled",
          finalAnswer: execution.result.finalAnswer,
          rounds: execution.result.rounds,
          terminateReason: "cancelled",
        });
      }
      transcript.messages = execution.messages ?? messages;
      transcript.state = execution.state ?? execution.result.finalState;
      transcript.stepCount++;
      const status = mapStepStatus(execution.result);
      return this.frame(step, {
        ok: status === "success",
        status,
        finalAnswer: execution.result.finalAnswer,
        ...(status === "success" ? {} : { error: `harness 终止：${execution.result.terminateReason}` }),
        rounds: execution.result.rounds,
        ...(execution.result.terminateReason ? { terminateReason: execution.result.terminateReason } : {}),
      });
    } catch (error) {
      if (controller.signal.aborted) {
        if (!existing && transcript.stepCount === 0) this.sessions.delete(step.sessionId);
        return this.frame(step, { ok: false, status: "cancelled", terminateReason: "cancelled" });
      }
      return this.failureFrame(step, error instanceof Error ? error.message : String(error));
    } finally {
      this.activeSteps.delete(step.stepId);
      if (this.activeBySession.get(step.sessionId) === step.stepId) {
        this.activeBySession.delete(step.sessionId);
      }
    }
  }

  /** host step.cancel：中止在途 step。返回是否命中。 */
  cancelStep(stepId: string): boolean {
    const active = this.activeSteps.get(stepId);
    if (!active) return false;
    active.controller.abort();
    return true;
  }

  /** 销毁会话：中止在途 step 并清空 transcript。 */
  destroySession(sessionId: string): boolean {
    const stepId = this.activeBySession.get(sessionId);
    if (stepId) this.cancelStep(stepId);
    return this.sessions.delete(sessionId);
  }

  hasActiveStep(sessionId: string): boolean {
    return this.activeBySession.has(sessionId);
  }

  /** 只读诊断视图（测试/宿主排查用）。 */
  getTranscript(sessionId: string): WorkerSessionTranscript | undefined {
    return this.sessions.get(sessionId);
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  private ensureSession(sessionId: string): WorkerSessionTranscript {
    let transcript = this.sessions.get(sessionId);
    if (!transcript) {
      transcript = { sessionId, messages: [], stepCount: 0 };
      this.sessions.set(sessionId, transcript);
    }
    return transcript;
  }

  private frame(
    step: OrchestratorStepFrame,
    payload: {
      ok: boolean;
      status: OrchestratorStepStatus;
      finalAnswer?: string;
      error?: string;
      rounds?: number;
      terminateReason?: string;
    },
  ): OrchestratorStepResultFrame {
    return {
      op: "step_result",
      callId: step.callId,
      stepId: step.stepId,
      sessionId: step.sessionId,
      ok: payload.ok,
      status: payload.status,
      ...(payload.finalAnswer !== undefined ? { finalAnswer: payload.finalAnswer } : {}),
      ...(payload.error !== undefined ? { error: payload.error } : {}),
      ...(payload.rounds !== undefined ? { rounds: payload.rounds } : {}),
      ...(payload.terminateReason !== undefined ? { terminateReason: payload.terminateReason } : {}),
    };
  }

  private failureFrame(step: OrchestratorStepFrame, message: string): OrchestratorStepResultFrame {
    return this.frame(step, { ok: false, status: "failed", error: message });
  }
}

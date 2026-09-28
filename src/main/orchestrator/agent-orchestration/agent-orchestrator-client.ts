/**
 * AgentOrchestratorClient —— cyrene-native --agent-orchestrator 的 TS 客户端。
 *
 * 数据流（Plan B）：
 *   runTurn(groupId, message)
 *     → host：按 pipeline 下发 step 帧
 *     → 本客户端把 step 交给 HarnessSessionWorker（复用 CyreneHarness 全循环）
 *     → step_result 回注 host
 *     → host 把上游 finalAnswer 投进下游会话邮箱并下发下一步
 *     → turn.result 解析 runTurn Promise
 *
 * 职责边界：
 * - 进程生命周期与帧路由（spawn/监督/优雅关停）在本类；
 * - 会话 transcript 与循环执行在 HarnessSessionWorker / step-runner；
 * - LLM 密钥、工具执行、权限审批永远不进入 .NET 进程。
 *
 * 总开关走统一解析入口（resolveDotnetConfig().agentOrchestrator，环境变量
 * CYRENE_AGENT_ORCHESTRATOR / config/cyrene.conf）；关闭或 native exe 缺失时
 * 全部 API 返回未启用，不影响 TS 侧原有循环。
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as readline from "node:readline";
import { resolveDotnetConfig } from "../../config";
import { resolveNativeWindowsExe } from "../../windows/native-windows-host";
import { trackChildProcess } from "../../child-processes";
import { HarnessSessionWorker } from "./harness-session-worker";
import type { HarnessEvent } from "../harness";
import {
  AGENT_ORCHESTRATOR_ARG,
  ORCHESTRATOR_REQUEST_OPS,
  type OrchestratorGroupCreateRequest,
  type OrchestratorGroupSummary,
  type OrchestratorStepCancelFrame,
  type OrchestratorStepFrame,
  type OrchestratorStepStatus,
  type OrchestratorTurnResultFrame,
} from "./protocol";

const LOG_PREFIX = "[AgentOrchestrator]";
const READY_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 15_000;

export interface AgentOrchestratorClientOptions {
  /** 会话执行器；缺省时任何 step 都会失败（生产接线必须注入）。 */
  worker?: HarnessSessionWorker;
  /** 测试注入：替代 node:child_process.spawn。 */
  spawnImpl?: typeof spawn;
  /** 测试注入：替代 native exe 探测。 */
  resolveExe?: () => string | null;
  /** 测试注入：替代统一配置开关。 */
  isEnabled?: () => boolean;
  /** 流式 Harness 事件（本进程回调，供 UI 订阅；不回流 .NET 进程）。 */
  onStepEvent?: (event: HarnessEvent, step: OrchestratorStepFrame) => void;
  /** host 生命周期事件帧（group.running / group.idle）。 */
  onHostEvent?: (frame: Record<string, unknown>) => void;
  logger?: (level: "info" | "warn" | "error", message: string) => void;
}

export interface AgentOrchestratorTurnResult {
  ok: boolean;
  status: OrchestratorStepStatus;
  finalAnswer?: string;
  error?: string;
  steps?: OrchestratorTurnResultFrame["steps"];
}

interface PendingRequest {
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface PendingTurn {
  resolve: (result: AgentOrchestratorTurnResult) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export class AgentOrchestratorClient {
  private proc: ChildProcess | null = null;
  private exited = false;
  private starting: Promise<boolean> | null = null;
  private ready: Promise<boolean> | null = null;
  private onReady: (() => void) | null = null;
  private nextRequestId = 1;
  private readonly pendingRequests = new Map<number, PendingRequest>();
  private readonly pendingTurns = new Map<string, PendingTurn>();
  private readonly worker: HarnessSessionWorker;

  constructor(private readonly options: AgentOrchestratorClientOptions = {}) {
    this.worker = options.worker ?? new HarnessSessionWorker({
      runStep: async () => {
        throw new Error("agent-orchestrator 未注入 runStep 执行器（缺少 step-runner 接线）");
      },
      ...(options.onStepEvent ? { onEvent: options.onStepEvent } : {}),
    });
  }

  /** 总开关：统一配置解析 + native exe 存在。 */
  enabled(): boolean {
    if (this.options.isEnabled) return this.options.isEnabled();
    return resolveDotnetConfig().agentOrchestrator && this.resolveExe() !== null;
  }

  // ── 进程生命周期 ─────────────────────────────────────────

  private resolveExe(): string | null {
    return this.options.resolveExe ? this.options.resolveExe() : resolveNativeWindowsExe();
  }

  async ensureStarted(): Promise<boolean> {
    if (!this.enabled()) return false;
    if (this.exited) return false;
    if (this.proc?.stdin?.writable) {
      return this.ready ? this.ready : true;
    }
    if (this.starting) return this.starting;
    const pendingStart = this.startProcess();
    this.starting = pendingStart;
    try {
      return await pendingStart;
    } finally {
      this.starting = null;
    }
  }

  private async startProcess(): Promise<boolean> {
    const exe = this.resolveExe();
    if (!exe) return false;
    const spawnImpl = this.options.spawnImpl ?? spawn;
    const child = spawnImpl(exe, [AGENT_ORCHESTRATOR_ARG], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    if (!child || !child.stdout || !child.stdin) return false;
    this.proc = child;
    this.exited = false;
    trackChildProcess(child, `cyrene-native ${AGENT_ORCHESTRATOR_ARG}`);
    this.wireFrameRouter(child);
    this.ready = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), READY_TIMEOUT_MS);
      this.onReady = () => {
        clearTimeout(timer);
        resolve(true);
      };
    });
    const ok = await this.ready;
    if (!ok) {
      // ready 超时：进程可能没起来，回收后允许下一次重试
      // （先摘 proc 再 kill：exit 回调据此识别"旧进程"、不锁死 exited）
      this.proc = null;
      this.ready = null;
      try { child.kill(); } catch { /* ignore */ }
    }
    return ok;
  }

  private wireFrameRouter(child: ChildProcess): void {
    child.stdout?.setEncoding("utf-8");
    const rl = readline.createInterface({ input: child.stdout! });
    rl.on("line", (line) => {
      // 已被替换/回收的旧进程残留帧：丢弃，避免污染当前进程的状态机
      if (this.proc !== child) return;
      if (!line.trim()) return;
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      this.routeFrame(frame).catch((error) => {
        this.log("error", `帧处理失败: ${error instanceof Error ? error.message : String(error)}`);
      });
    });
    child.stderr?.setEncoding("utf-8");
    child.stderr?.on("data", (data: string) => this.log("warn", `[stderr] ${data.slice(0, 300)}`));
    child.on("exit", (code) => {
      // 旧进程（ready 超时被回收、或已被新进程替换）的退出不回收当前状态：
      // 正常退出/崩溃才锁 exited，避免误伤重试后的新进程。
      if (this.proc !== child) {
        this.log("warn", `host 退出 code=${code}（已不是当前进程，忽略）`);
        return;
      }
      this.exited = true;
      this.proc = null;
      this.starting = null;
      this.ready = null;
      for (const [, pending] of this.pendingRequests) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`agent-orchestrator 退出（code=${code}）`));
      }
      this.pendingRequests.clear();
      for (const [callId] of this.pendingTurns) {
        this.settleTurn(callId, { ok: false, status: "failed", error: `agent-orchestrator 退出（code=${code}）` });
      }
      this.log("warn", `host 退出 code=${code}`);
    });
  }

  private async routeFrame(frame: Record<string, unknown>): Promise<void> {
    // 请求应答帧：{id:n, ok:bool, data?|error?}
    if (typeof frame.id === "number" && frame.op === undefined) {
      const pending = this.pendingRequests.get(frame.id);
      if (!pending) return;
      this.pendingRequests.delete(frame.id);
      clearTimeout(pending.timer);
      if (frame.ok === true) pending.resolve(frame.data);
      else pending.reject(new Error(typeof frame.error === "string" ? frame.error : "agent-orchestrator 请求失败"));
      return;
    }

    switch (frame.op) {
      case "ready":
        this.onReady?.();
        return;
      case "step": {
        const step = frame as unknown as OrchestratorStepFrame;
        const result = await this.worker.executeStep(step);
        this.send(result);
        return;
      }
      case "step.cancel": {
        const cancel = frame as unknown as OrchestratorStepCancelFrame;
        this.worker.cancelStep(cancel.stepId);
        return;
      }
      case "turn.result": {
        const result = frame as unknown as OrchestratorTurnResultFrame;
        this.settleTurn(result.callId, {
          ok: result.ok,
          status: result.status,
          ...(result.finalAnswer !== undefined ? { finalAnswer: result.finalAnswer } : {}),
          ...(result.error !== undefined ? { error: result.error } : {}),
          ...(result.steps ? { steps: result.steps } : {}),
        });
        return;
      }
      case "event":
        this.options.onHostEvent?.(frame);
        return;
      case "log": {
        const level = frame.level === "error" ? "error" : frame.level === "warn" ? "warn" : "info";
        this.log(level, String(frame.message ?? ""));
        return;
      }
      default:
        return;
    }
  }

  // ── 编排 API ─────────────────────────────────────────────

  async createGroup(config: OrchestratorGroupCreateRequest): Promise<{ ok: boolean; error?: string }> {
    if (!(await this.ensureStarted())) return { ok: false, error: "agent-orchestrator 未启用" };
    try {
      await this.request(ORCHESTRATOR_REQUEST_OPS.GroupCreate, { ...config });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async destroyGroup(groupId: string): Promise<{ ok: boolean; error?: string }> {
    if (!(await this.ensureStarted())) return { ok: false, error: "agent-orchestrator 未启用" };
    try {
      await this.request(ORCHESTRATOR_REQUEST_OPS.GroupDestroy, { groupId });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async listGroups(): Promise<OrchestratorGroupSummary[]> {
    if (!(await this.ensureStarted())) return [];
    const data = await this.request<{ groups?: OrchestratorGroupSummary[] }>(ORCHESTRATOR_REQUEST_OPS.GroupList, {});
    return data.groups ?? [];
  }

  async listMailbox(sessionId: string): Promise<Array<{ fromSessionId?: string; text: string }>> {
    if (!(await this.ensureStarted())) return [];
    const data = await this.request<{ items?: Array<{ fromSessionId?: string; text: string }> }>(
      ORCHESTRATOR_REQUEST_OPS.MailboxList,
      { sessionId },
    );
    return data.items ?? [];
  }

  /**
   * 启动一条流水线 turn 并等待终态（turn.result）。
   * callId 由客户端预生成并先注册，避免应答/结果帧竞态丢结果；host 校验唯一性。
   */
  async runTurn(
    groupId: string,
    message: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<AgentOrchestratorTurnResult> {
    if (options.signal?.aborted) return { ok: false, status: "cancelled", error: "已取消" };
    if (!(await this.ensureStarted())) return { ok: false, status: "failed", error: "agent-orchestrator 未启用" };
    const callId = `t${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const resultPromise = new Promise<AgentOrchestratorTurnResult>((resolve) => {
      const pending: PendingTurn = { resolve };
      if (options.signal) {
        const onAbort = () => {
          void this.cancelTurn(callId);
        };
        pending.signal = options.signal;
        pending.onAbort = onAbort;
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
      this.pendingTurns.set(callId, pending);
    });
    try {
      await this.request(ORCHESTRATOR_REQUEST_OPS.TurnStart, { callId, groupId, message });
    } catch (error) {
      this.settleTurn(callId, {
        ok: false,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return resultPromise;
  }

  /** 取消 turn（活动中的 step 由 host 转 step.cancel；排队的直接出队）。 */
  async cancelTurn(callId: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.proc?.stdin?.writable) return { ok: false, error: "agent-orchestrator 未启动" };
    try {
      await this.request(ORCHESTRATOR_REQUEST_OPS.TurnCancel, { callId });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async shutdown(): Promise<void> {
    const child = this.proc;
    if (!child || this.exited) return;
    try {
      await this.request(ORCHESTRATOR_REQUEST_OPS.Shutdown, {}, 3_000);
    } catch {
      // host 可能在应答前就退出：按退出流程兜底
    }
    await new Promise<void>((resolve) => {
      if (this.exited || !this.proc) return resolve();
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* ignore */ }
        resolve();
      }, 5_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  // ── 帧收发 ───────────────────────────────────────────────

  private request<T>(op: string, payload: Record<string, unknown>, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    const child = this.proc;
    if (!child || this.exited || !child.stdin?.writable) {
      return Promise.reject(new Error("agent-orchestrator 未启动"));
    }
    const id = this.nextRequestId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingRequests.delete(id)) reject(new Error(`agent-orchestrator 请求超时: ${op}`));
      }, timeoutMs);
      this.pendingRequests.set(id, {
        resolve: (data) => resolve(data as T),
        reject,
        timer,
      });
      this.send({ id, op, ...payload });
    });
  }

  private send(frame: object): void {
    const child = this.proc;
    if (!child || this.exited || !child.stdin?.writable) return;
    try {
      child.stdin.write(`${JSON.stringify(frame)}\n`);
    } catch {
      // stdout/stdin 断裂由 exit 流程统一处理
    }
  }

  private settleTurn(callId: string, result: AgentOrchestratorTurnResult): void {
    const pending = this.pendingTurns.get(callId);
    if (!pending) return;
    this.pendingTurns.delete(callId);
    if (pending.signal && pending.onAbort) {
      pending.signal.removeEventListener("abort", pending.onAbort);
    }
    pending.resolve(result);
  }

  private log(level: "info" | "warn" | "error", message: string): void {
    if (this.options.logger) {
      this.options.logger(level, message);
      return;
    }
    const line = `${LOG_PREFIX} ${message}`;
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  }
}

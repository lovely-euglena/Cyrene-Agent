/**
 * AgentProcessManager——多 Agent 会话宿主客户端（agent-host 轨，P1 闭环）。
 *
 * 职责：
 *   - cyrene-native --agent-host 进程生命周期（spawn/监督/优雅关停）
 *   - 会话 CRUD 转发（create/destroy/list）
 *   - step 的 LLM 回调代理：host 发 llm_request → 本管理器调用现有
 *     vendors 层（getAdapterForConfig + streamChatWithSdk——密钥/供应商
 *     适配/超时全部留在主进程，.NET 永远只见明文上下文不见 key）
 *     → llm_response 回注 host；host 发 tool_request → 调用 toolRegistry
 *     （含权限审批，复用 executeToolCall 路径）→ tool_result 回注
 *
 * 协议见 dotnet/native-windows/Agents/AgentSessionHost.cs 头注释。
 * 默认启用（CYRENE_AGENT_HOST=0 关闭）：0 或 native exe 缺失时全部 API
 * 返回 { ok: false, error: "agent-host 未启用" }——上层照旧走 TS 循环。
 */
import { spawn, type ChildProcess } from "child_process";
import * as readline from "readline";
import { resolveNativeWindowsExe } from "../windows/native-windows-host";
import { trackChildProcess } from "../child-processes";
import { getAdapterForConfig, type ChatMessage, type VendorConfig } from "./vendors";
import { streamChatWithSdk } from "./vendors/sdk-stream/runtime";

const LOG_PREFIX = "[AgentHost]";

export interface AgentSessionConfig {
  /** 会话角色（planner/executor/reviewer...），落 config 帧给 host 侧策略参考 */
  role?: string;
  /** 工具白名单（null=全部；host 侧 J3 将做强制校验，当前先透传） */
  toolWhitelist?: string[] | null;
  /** 会话级系统提示词（拼进 llm_request 的 messages 首位） */
  systemPrompt?: string;
}

interface StepContext {
  resolve: (value: { ok: boolean; state?: string; error?: string }) => void;
  /** 供应商配置（llm_request 代理时用；每会话绑定当前模型设置） */
  vendor: VendorConfig;
}

export class AgentProcessManager {
  private proc: ChildProcess | null = null;
  private exited = false;
  private starting: Promise<boolean> | null = null;
  private steps = new Map<string, StepContext>();
  private toolsHandlers: Array<(callId: string, sessionId: string, toolCalls: unknown) => void> = [];

  /** 宿主回注：llm_request 的会话配置 → VendorConfig（默认当前模型）。 */
  vendorResolver: ((sessionConfig: unknown) => VendorConfig) | null = null;
  /** 宿主回注：messages 预处理（拼系统提示词/裁剪），默认原样。 */
  messagePreprocessor: ((messages: ChatMessage[]) => ChatMessage[]) | null = null;

  enabled(): boolean {
    return process.env.CYRENE_AGENT_HOST !== "0" && resolveNativeWindowsExe() !== null;
  }

  private async ensureStarted(): Promise<boolean> {
    if (this.exited) return false;
    if (this.proc?.stdin?.writable) return true;
    if (this.starting) return this.starting;
    const pendingStart = (async () => {
      const exe = resolveNativeWindowsExe();
      if (!exe) return false;
      const child = spawn(exe, ["--agent-host"], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      if (!child || !child.stdout || !child.stdin) return false;
      this.proc = child;
      trackChildProcess(child, "cyrene-native --agent-host");
      this.exited = false;
      this.wireFrameRouter(child);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 10_000);
        child.once("spawn", () => { clearTimeout(timer); resolve(); });
      });
      return true;
    })();
    this.starting = pendingStart;
    const ok = await pendingStart;
    this.starting = null;
    return ok;
  }

  private wireFrameRouter(child: ChildProcess): void {
    child.stdout?.setEncoding("utf-8");
    const rl = readline.createInterface({ input: child.stdout! });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      let frame: Record<string, unknown>;
      try { frame = JSON.parse(line); } catch { return; }
      this.routeFrame(frame).catch((error) => {
        console.error(LOG_PREFIX, "帧处理失败:", error instanceof Error ? error.message : error);
      });
    });
    child.stderr?.setEncoding("utf-8");
    child.stderr?.on("data", (d: string) => console.warn(LOG_PREFIX, "[stderr]", d.slice(0, 300)));
    child.on("exit", (code) => {
      this.exited = true;
      this.proc = null;
      this.starting = null;
      for (const [, ctx] of this.steps) ctx.resolve({ ok: false, error: `agent-host 退出（code=${code}）` });
      this.steps.clear();
      console.warn(LOG_PREFIX, `host 退出 code=${code}`);
    });
  }

  /** host → Electron 的帧分发。 */
  private async routeFrame(frame: Record<string, unknown>): Promise<void> {
    switch (frame.op) {
      case "llm_request": {
        const callId = String(frame.callId ?? "");
        const session = frame.session as { messages?: ChatMessage[]; config?: unknown } | undefined;
        const ctx = this.steps.get(callId);
        if (!ctx || !session?.messages) return;
        try {
          const messages = this.messagePreprocessor
            ? this.messagePreprocessor(session.messages)
            : session.messages;
          const vendor = this.vendorResolver
            ? this.vendorResolver(session.config)
            : ctx.vendor;
          const adapter = getAdapterForConfig(vendor);
          const response = await streamChatWithSdk({
            adapter,
            request: {
              model: vendor.model,
              messages,
              stream: false,
            } as never,
            config: vendor,
            timeoutMs: 120_000,
          });
          this.send({
            op: "llm_response", callId, ok: true,
            content: {
              text: response.text ?? "",
              toolCalls: response.toolCalls ?? [],
            },
          });
        } catch (error) {
          this.send({
            op: "llm_response", callId, ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }
      case "tool_request": {
        const callId = String(frame.callId ?? "");
        const sessionId = String(frame.sessionId ?? "");
        // 工具执行回调（含权限审批）——由上层注入实现，见 setToolExecutor
        for (const handler of this.toolsHandlers) handler(callId, sessionId, frame.assistantMessage);
        return;
      }
      case "result": {
        const callId = String(frame.callId ?? "");
        const ctx = this.steps.get(callId);
        if (!ctx) return;
        this.steps.delete(callId);
        ctx.resolve({
          ok: frame.ok === true,
          state: typeof frame.data === "object" && frame.data ? String((frame.data as { state?: string }).state ?? "") : undefined,
          error: typeof frame.error === "string" ? frame.error : undefined,
        });
        return;
      }
      case "event":
        console.log(LOG_PREFIX, "[event]", JSON.stringify(frame).slice(0, 200));
        return;
      case "log": {
        const level = String(frame.level ?? "info");
        const line = `${LOG_PREFIX} ${String(frame.message ?? "")}`;
        if (level === "error") console.error(line);
        else if (level === "warn") console.warn(line);
        else console.log(line);
        return;
      }
      default:
        return;
    }
  }

  /** 工具执行器注入（含审批的完整 executeToolDefinition 路径）。 */
  setToolExecutor(handler: (callId: string, sessionId: string, assistantMessage: unknown) => void): void {
    this.toolsHandlers.push(handler);
  }

  /** host 工具执行结果回注（由工具执行器在完成时调用）。 */
  resolveToolCall(callId: string, sessionId: string, result: unknown): void {
    this.send({ op: "tool_result", callId, sessionId, result });
  }

  async createSession(sessionId: string, config: AgentSessionConfig, vendor: VendorConfig): Promise<{ ok: boolean; error?: string }> {
    if (!this.enabled() || !await this.ensureStarted()) return { ok: false, error: "agent-host 未启用" };
    this.send({ op: "create", sessionId, config });
    return { ok: true };
  }

  async destroySession(sessionId: string): Promise<void> {
    this.send({ op: "destroy", sessionId });
  }

  /** 单步推进：resolves 于会话到达终态（done/failed）。 */
  async step(sessionId: string, message: string, vendor: VendorConfig): Promise<{ ok: boolean; state?: string; error?: string }> {
    if (!this.enabled() || !await this.ensureStarted()) return { ok: false, error: "agent-host 未启用" };
    const callId = `a${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    return new Promise((resolve) => {
      this.steps.set(callId, { resolve, vendor });
      this.send({ op: "step", callId, sessionId, message });
    });
  }

  async shutdown(): Promise<void> {
    const child = this.proc;
    if (!child || this.exited) return;
    try { child.stdin?.write(`${JSON.stringify({ op: "shutdown" })}\n`); } catch { /* ignore */ }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } resolve(); }, 5_000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }

  private send(frame: Record<string, unknown>): void {
    const child = this.proc;
    if (!child || this.exited || !child.stdin?.writable) return;
    try { child.stdin.write(`${JSON.stringify(frame)}\n`); } catch { /* ignore */ }
  }
}

export const agentProcessManager = new AgentProcessManager();

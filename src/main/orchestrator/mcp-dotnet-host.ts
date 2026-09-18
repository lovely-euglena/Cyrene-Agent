/**
 * .NET MCP 桥宿主客户端（mcp-dotnet-host）。
 *
 * 把 MCP server 连接管理整体下沉到 cyrene-native --mcp-host 子进程
 * （重连/超时/进程树清理都在 .NET 侧），Electron 主进程只面对稳定的
 * stdio JSON 行协议。桥协议见 dotnet/native-windows/Mcp/McpHost.cs 头注释。
 *
 * 本模块是单例客户端：spawn/复用 host 进程、connect/disconnect/call
 * 转发、tools/state 事件回调。注册 ToolRegistry 的逻辑仍在 mcp-adapter
 * （保持 effectKind 解析等业务规则单点维护）。
 */
import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as readline from "readline";
import { resolveNativeWindowsExe } from "../windows/native-windows-host";

const LOG_PREFIX = "[MCP DotnetHost]";

interface HostServerConfig {
  transport: "stdio" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  callTimeoutMs?: number;
}

interface ToolsChangedListener {
  (serverId: string, tools: Array<{
    name: string;
    description?: string;
    inputSchema?: { type: "object"; properties: Record<string, unknown>; required?: string[] };
    annotations?: Record<string, unknown>;
  }>): void;
}

interface StateChangedListener {
  (serverId: string, state: "connected" | "reconnecting" | "disconnected", error?: string): void;
}

class McpDotnetHost {
  private proc: ChildProcess | null = null;
  private exited = false;
  private started = false;
  private starting: Promise<boolean> | null = null;
  private seq = 0;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private toolsListeners = new Set<ToolsChangedListener>();
  private stateListeners = new Set<StateChangedListener>();

  onToolsChanged(listener: ToolsChangedListener): void {
    this.toolsListeners.add(listener);
  }

  onStateChanged(listener: StateChangedListener): void {
    this.stateListeners.add(listener);
  }

  /** host 进程是否已就绪（供 adapter 决定走 .NET 轨还是 TS 直连回退）。 */
  async ensureStarted(): Promise<boolean> {
    if (this.started && this.proc && !this.exited) return true;
    if (this.starting) return this.starting;
    this.starting = this.doStart();
    const ok = await this.starting;
    this.starting = null;
    return ok;
  }

  private async doStart(): Promise<boolean> {
    const exe = resolveNativeWindowsExe();
    if (!exe || !fs.existsSync(exe)) {
      console.warn(LOG_PREFIX, "cyrene-native 不可用，MCP 走 TS 直连回退");
      return false;
    }
    try {
      const child = spawn(exe, ["--mcp-host"], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      this.proc = child;
      this.exited = false;
      this.started = true;

      child.on("exit", (code, signal) => {
        this.exited = true;
        this.started = false;
        this.proc = null;
        const message = `host 进程退出 (code=${code} signal=${signal ?? "-"})，全部 MCP server 断连`;
        console.warn(LOG_PREFIX, message);
        for (const [, call] of this.pending) call.reject(new Error(message));
        this.pending.clear();
        // 各 server 状态由 adapter 侧工具卸载兜底；此处不做自动重启——
        // 下一次 ensureStarted（新连接请求）会重新拉起 host 并重连全部
      });
      child.stderr?.on("data", (buf: Buffer) => {
        const text = String(buf).trim();
        if (text) console.warn(LOG_PREFIX, "[stderr]", text.slice(0, 400));
      });

      const rl = readline.createInterface({ input: child.stdout! });
      rl.on("line", (line) => this.handleLine(line));

      // ready 握手（10s）
      await this.waitReady();
      console.log(LOG_PREFIX, "就绪（cyrene-native --mcp-host）");
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(LOG_PREFIX, "启动失败，走 TS 直连回退:", message);
      this.started = false;
      return false;
    }
  }

  private readyResolve: (() => void) | null = null;

  private waitReady(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.readyResolve = null;
        reject(new Error("host ready 握手超时（10s）"));
      }, 10_000);
      this.readyResolve = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return; // 非 JSON 行容错
    }
    const op = typeof frame.op === "string" ? frame.op : "";
    if (op === "ready") {
      this.readyResolve?.();
      this.readyResolve = null;
      return;
    }
    if (op === "tools") {
      const serverId = String(frame.serverId ?? "");
      const tools = Array.isArray(frame.tools) ? frame.tools as never[] : [];
      for (const l of this.toolsListeners) l(serverId, tools);
      return;
    }
    if (op === "state") {
      const serverId = String(frame.serverId ?? "");
      const state = frame.state as "connected" | "reconnecting" | "disconnected";
      const error = typeof frame.error === "string" ? frame.error : undefined;
      for (const l of this.stateListeners) l(serverId, state, error);
      return;
    }
    if (op === "result") {
      const callId = String(frame.callId ?? "");
      const call = this.pending.get(callId);
      if (!call) return;
      this.pending.delete(callId);
      if (frame.ok === true) call.resolve(frame.data);
      else call.reject(new Error(typeof frame.error === "string" ? frame.error : "MCP 调用失败"));
      return;
    }
    if (op === "log") {
      const level = String(frame.level ?? "info");
      const message = String(frame.message ?? "");
      const line2 = `${LOG_PREFIX} ${message}`;
      if (level === "error") console.error(line2);
      else if (level === "warn") console.warn(line2);
      else console.log(line2);
    }
  }

  /** 连接一个 server；resolve 为 tools 列表（host 侧已完成 MCP 握手）。 */
  async connectServer(serverId: string, config: HostServerConfig): Promise<Array<{
    name: string;
    description?: string;
    inputSchema?: { type: "object"; properties: Record<string, unknown>; required?: string[] };
    annotations?: Record<string, unknown>;
  }>> {
    const data = await this.request({ op: "connect", serverId, config });
    return Array.isArray(data) ? data as never[] : [];
  }

  async disconnectServer(serverId: string): Promise<void> {
    try {
      await this.request({ op: "disconnect", serverId });
    } catch {
      // host 已退出时 disconnect 允许静默失败（状态回调已兜底）
    }
  }

  async callTool(serverId: string, tool: string, args: Record<string, unknown>, timeoutMs = 60_000): Promise<unknown> {
    return this.request({ op: "call", callId: this.nextCallId(), serverId, tool, args }, timeoutMs);
  }

  private nextCallId(): string {
    this.seq += 1;
    return `mc${Date.now().toString(36)}-${this.seq}`;
  }

  private request(frame: Record<string, unknown>, timeoutMs = 15_000): Promise<unknown> {
    const callId = typeof frame.callId === "string" ? frame.callId : this.nextCallId();
    const payload = { ...frame, callId };
    return new Promise((resolve, reject) => {
      if (!this.proc || this.exited) {
        reject(new Error("MCP host 未运行"));
        return;
      }
      const timer = setTimeout(() => {
        if (this.pending.delete(callId)) reject(new Error("MCP host 请求超时"));
      }, timeoutMs);
      this.pending.set(callId, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      try {
        this.proc.stdin!.write(`${JSON.stringify(payload)}\n`);
      } catch (error) {
        this.pending.delete(callId);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** 应用退出时优雅关停（host 会级联清理全部 MCP server 进程树）。 */
  async shutdown(): Promise<void> {
    const child = this.proc;
    if (!child || this.exited) return;
    try {
      child.stdin?.write(`${JSON.stringify({ op: "shutdown" })}\n`);
    } catch { /* ignore */ }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* ignore */ }
        resolve();
      }, 5_000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }
}

export const mcpDotnetHost = new McpDotnetHost();

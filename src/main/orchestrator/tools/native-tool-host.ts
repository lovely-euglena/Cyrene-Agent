/**
 * .NET 内置工具宿主客户端（native-tool-host）。
 *
 * 计算密集/系统交互型内置工具优先在 cyrene-native --tool-host 子进程
 * 执行（.NET 性能 + 进程隔离），不可用/超时/崩溃自动回退 TS 本地实现
 * （utility-tools.ts 保持同语义，双轨测试对齐）。
 *
 * 容错策略：
 *   - ensureStarted 失败 → 本轮全部走 TS 实现（静默降级，不重试
 *     到下次调用，避免每工具调用付一次探测成本）
 *   - 单次调用超时（默认 5s）→ 杀掉 host 重启（工具无状态，重启
 *     零成本），当次调用回退 TS
 *   - host 崩溃 → exited 标记，在途调用立即回退，下次 ensureStarted
 *     重新拉起（进程监督）
 */
import { spawn, type ChildProcess } from "child_process";
import * as readline from "readline";
import { resolveNativeWindowsExe } from "../../windows/native-windows-host";
import { trackChildProcess } from "../../child-processes";

const LOG_PREFIX = "[ToolHost]";

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class NativeToolHost {
  private proc: ChildProcess | null = null;
  private exited = false;
  private starting: Promise<boolean> | null = null;
  private pending = new Map<string, PendingCall>();
  private callSeq = 0;
  private timezone: string | null = null;

  /** 宿主侧注入用户时区（now 工具用；host 启动时随 init 帧下发）。 */
  setTimezone(tz: string | null): void {
    this.timezone = tz;
    if (this.proc && !this.exited) {
      this.send({ op: "config", timezone: tz ?? "Asia/Shanghai" });
    }
  }

  async ensureStarted(): Promise<boolean> {
    if (this.exited) {
      this.exited = false; // 监督重启
      this.proc = null;
    }
    if (this.proc) return true;
    if (this.starting) return this.starting;
    this.starting = this.start().finally(() => { this.starting = null; });
    return this.starting;
  }

  private async start(): Promise<boolean> {
    const exe = resolveNativeWindowsExe();
    if (!exe) return false;
    try {
      const child = spawn(exe, ["--tool-host"], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      this.proc = child;
      trackChildProcess(child, "cyrene-native --tool-host");
      this.exited = false;
      child.on("exit", () => {
        this.exited = true;
        this.proc = null;
        for (const [, call] of this.pending) {
          clearTimeout(call.timer);
          call.reject(new Error("tool-host 进程退出"));
        }
        this.pending.clear();
      });
      child.stderr?.on("data", (d: Buffer) => {
        const line = d.toString().trim();
        if (line) console.warn(LOG_PREFIX, "[stderr]", line.slice(0, 200));
      });
      readline.createInterface({ input: child.stdout! }).on("line", (line) => {
        if (!line.trim()) return;
        try {
          const frame = JSON.parse(line) as Record<string, unknown>;
          this.handleFrame(frame);
        } catch {
          // 协议外输出：忽略
        }
      });
      // 就绪等待：ready 帧或 3s 超时
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("tool-host 启动超时")), 3000);
        const onReady = () => { clearTimeout(timer); cleanup(); resolve(); };
        const onExit = () => { clearTimeout(timer); cleanup(); reject(new Error("tool-host 启动即退出")); };
        const cleanup = () => {
          child.removeListener("ready" as never, onReady as never);
        };
        this.readyWaiters.push(onReady);
        child.once("exit", onExit);
      });
      this.send({ op: "config", timezone: this.timezone ?? "Asia/Shanghai" });
      return true;
    } catch (error) {
      console.warn(LOG_PREFIX, "启动失败，工具走 TS 实现:", error instanceof Error ? error.message : error);
      this.proc = null;
      return false;
    }
  }

  private readyWaiters: Array<() => void> = [];

  private handleFrame(frame: Record<string, unknown>): void {
    const op = typeof frame.op === "string" ? frame.op : "";
    if (op === "ready") {
      for (const w of this.readyWaiters.splice(0)) w();
      return;
    }
    if (op === "result") {
      const callId = typeof frame.callId === "string" ? frame.callId : "";
      const call = this.pending.get(callId);
      if (!call) return;
      this.pending.delete(callId);
      clearTimeout(call.timer);
      if (frame.ok === true) call.resolve(frame.data);
      else call.reject(new Error(typeof frame.error === "string" ? frame.error : "工具执行失败"));
    }
  }

  /**
   * 调用一个 native 工具。返回 null = native 轨不可用（调用方回退 TS）。
   * 拒绝（超时/进程故障）同样由调用方捕获后回退 TS。
   */
  async call(tool: string, args: Record<string, unknown>, timeoutMs = 5000): Promise<unknown | null> {
    if (!(await this.ensureStarted())) return null;
    const child = this.proc;
    if (!child || this.exited) return null;
    return new Promise<unknown>((resolve, reject) => {
      const callId = `t${++this.callSeq}`;
      const timer = setTimeout(() => {
        this.pending.delete(callId);
        // 超时：host 可能卡死——杀掉等监督重启，当次回退
        console.warn(LOG_PREFIX, `工具 ${tool} 超时（${timeoutMs}ms），重启 host`);
        try { child.kill(); } catch { /* ignore */ }
        reject(new Error(`native 工具 ${tool} 超时`));
      }, timeoutMs);
      this.pending.set(callId, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
        timer,
      });
      try {
        child.stdin!.write(`${JSON.stringify({ op: "call", callId, tool, args })}\n`);
      } catch (error) {
        this.pending.delete(callId);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private send(frame: Record<string, unknown>): void {
    const child = this.proc;
    if (!child || this.exited || !child.stdin?.writable) return;
    try {
      child.stdin.write(`${JSON.stringify(frame)}\n`);
    } catch { /* ignore */ }
  }
}

export const nativeToolHost = new NativeToolHost();

/**
 * 通用包装：native 优先执行，任何失败（不可用/超时/进程故障）回退 TS 实现。
 * fallback 参数即原 TS execute 函数——双轨语义对齐由测试保证。
 */
export async function nativeFirst(
  tool: string,
  args: Record<string, unknown>,
  fallback: (args: Record<string, unknown>) => Promise<string> | string,
): Promise<string> {
  try {
    const result = await nativeToolHost.call(tool, args);
    if (result !== null) {
      return typeof result === "string" ? result : JSON.stringify(result);
    }
  } catch (error) {
    console.warn(LOG_PREFIX, `native 轨失败回退 TS（${tool}）:`, error instanceof Error ? error.message : error);
  }
  return fallback(args);
}

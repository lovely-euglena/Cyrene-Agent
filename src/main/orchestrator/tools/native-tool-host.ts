/**
 * .NET 内置工具宿主客户端（native-tool-host）。
 *
 * 计算密集/系统交互型内置工具优先在 cyrene-native --tool-host 子进程
 * 执行（.NET 性能 + 进程隔离），不可用/超时/崩溃/取消自动回退 TS 本地实现
 * （utility-tools.ts 保持同语义，双轨测试对齐）。
 *
 * 容错策略：
 *   - ensureStarted 失败 → 本轮全部走 TS 实现（静默降级，不重试
 *     到下次调用，避免每工具调用付一次探测成本）
 *   - 单次调用超时（默认 5s；长任务可经 NativeFirstOptions.timeoutMs 按件
 *     覆盖）→ 杀掉 host 重启（工具无状态，重启零成本），当次调用回退 TS
 *   - 用户取消（AbortSignal）：排队中直接摘除；在途立即杀 host 中止
 *     （下载等先缓冲后一次性落盘，杀进程保证取消后不再落盘），并以
 *     AbortError 拒绝——调用方必须原样上抛，禁止回退 TS 重跑副作用
 *   - host 崩溃 → exited 标记，在途/排队调用立即回退，下次 ensureStarted
 *     重新拉起（进程监督）
 *
 * 串行闸门：C# ToolHost 在唯一读循环上同步执行工具，天然串行；本客户端
 * 显式排队（同一时刻只写一个 call 帧），看门狗从「实际派发」而非「入队」
 * 起算——避免长任务在途时，排队短调用的 watchdog 先到点误杀 host、
 * 连带整批调用回退重跑（PR #1 复审阻断项 2）。
 *
 * 注意：默认 5s 只适合毫秒级工具；任何会走网络/大文件的工具接线时
 * 必须传入与 C# 侧内部超时匹配的 timeoutMs，且需要取消语义时经
 * options.signal 透传父运行信号。
 */
import { spawn, type ChildProcess } from "child_process";
import * as readline from "readline";
import { resolveNativeWindowsExe } from "../../windows/native-windows-host";
import { trackChildProcess } from "../../child-processes";
import { createAbortError, isAbortError } from "../../abort-utils";
import { resolveDotnetConfig } from "../../dotnet-backend/config";

const LOG_PREFIX = "[ToolHost]";

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  /** 工具名：超时/退出日志用于定位被连带拒绝的调用。 */
  tool: string;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface QueuedCall {
  callId: string;
  tool: string;
  args: Record<string, unknown>;
  timeoutMs: number;
  signal?: AbortSignal;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  /** 排队期间的取消监听（派发时移除）。 */
  onAbort?: () => void;
}

/** 宿主运行时配置（config 帧载荷）。 */
export interface HostRuntimeSettings {
  timezone: string;
  dateLocale: string;
  /** 本地数据根（expenses.json 等宿主侧落盘位置）；null = 宿主侧不可用。 */
  dataDir: string | null;
}

/** nativeFirst 按件选项：长耗时工具（大文件下载/外网请求）覆盖默认 5s 看门狗。 */
export interface NativeFirstOptions {
  /** 单次调用超时（ms）。缺省 5000；应 ≥ C# 侧内部超时，避免 native 轨被误杀。 */
  timeoutMs?: number;
  /** 父运行取消信号：排队中直接取消，在途杀 host 中止；AbortError 原样上抛不回退。 */
  signal?: AbortSignal;
}

export class NativeToolHost {
  private proc: ChildProcess | null = null;
  private exited = false;
  private starting: Promise<boolean> | null = null;
  private pending = new Map<string, PendingCall>();
  /** 串行闸门：等待派发的调用（busy 时暂存 TS 侧，不写入 stdin）。 */
  private queue: QueuedCall[] = [];
  private busy = false;
  /** 已发 kill 等待 exit：期间不向将死进程派发新帧。 */
  private killing = false;
  private callSeq = 0;
  private settings: HostRuntimeSettings = {
    timezone: "Asia/Shanghai",
    dateLocale: "zh-CN",
    dataDir: null,
  };

  /** 兼容旧入口：仅更新时区（now 工具每次调用实时下发）。 */
  setTimezone(tz: string | null): void {
    this.setRuntimeSettings({ timezone: tz ?? "Asia/Shanghai" });
  }

  /**
   * 注入/更新宿主运行时配置：host 已启动立即下发 config 帧；
   * 未启动则存为启动配置（start 时下发），不需要重启 host。
   */
  setRuntimeSettings(patch: Partial<HostRuntimeSettings>): void {
    if (patch.timezone !== undefined && patch.timezone.trim()) this.settings.timezone = patch.timezone.trim();
    if (patch.dateLocale !== undefined && patch.dateLocale.trim()) this.settings.dateLocale = patch.dateLocale.trim();
    if (patch.dataDir !== undefined) this.settings.dataDir = patch.dataDir;
    if (this.proc && !this.exited) this.send({ op: "config", ...this.settings });
  }

  /** 当前配置快照（测试/诊断用）。 */
  getRuntimeSettings(): Readonly<HostRuntimeSettings> {
    return { ...this.settings };
  }

  async ensureStarted(): Promise<boolean> {
    if (this.exited) {
      this.exited = false; // 监督重启
      this.proc = null;
    }
    // 启动中：所有调用等同一个 barrier（保证串行闸门 FIFO 顺序——
    // 若先查 this.proc 快路径，第二个调用会比第一个更早恢复，后进先出）
    if (this.starting) return this.starting;
    if (this.proc) return true;
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
      this.killing = false;
      this.busy = false;
      child.on("exit", () => {
        this.exited = true;
        this.proc = null;
        this.killing = false;
        this.busy = false;
        const outstanding = this.describeOutstanding();
        if (outstanding) console.warn(LOG_PREFIX, `host 退出：连带拒绝 ${outstanding}`);
        for (const call of [...this.pending.values()]) {
          clearTimeout(call.timer);
          if (call.onAbort && call.signal) call.signal.removeEventListener("abort", call.onAbort);
          call.reject(call.signal?.aborted ? createAbortError() : new Error("tool-host 进程退出"));
        }
        this.pending.clear();
        const queued = this.queue.splice(0);
        for (const entry of queued) {
          if (entry.onAbort && entry.signal) entry.signal.removeEventListener("abort", entry.onAbort);
          entry.reject(entry.signal?.aborted ? createAbortError() : new Error("tool-host 进程退出"));
        }
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
      this.send({ op: "config", ...this.settings });
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
      if (frame.ok === true) call.resolve(frame.data);
      else call.reject(new Error(typeof frame.error === "string" ? frame.error : "工具执行失败"));
    }
  }

  /** 在途 + 排队调用清单（超时/退出日志用）；exclude 排除已处理的当次调用。 */
  private describeOutstanding(exclude?: string): string {
    const names: string[] = [];
    for (const [id, call] of this.pending) {
      if (id !== exclude) names.push(`${id}(${call.tool})`);
    }
    for (const entry of this.queue) names.push(`${entry.callId}(${entry.tool})`);
    return names.length > 0 ? `${names.length} 个在途/排队调用：${names.join(", ")}` : "";
  }

  /**
   * 串行闸门派发：同一时刻至多一个 call 帧在途（看门狗随派发起算）。
   * 上一个调用 settle / host 退出后自动派发下一个。
   */
  private dispatchNext(): void {
    if (this.busy || this.exited || this.killing) return;
    const child = this.proc;
    if (!child) return;
    const entry = this.queue.shift();
    if (!entry) return;

    this.busy = true;
    const { callId, tool, args, timeoutMs, signal } = entry;
    if (entry.onAbort && signal) signal.removeEventListener("abort", entry.onAbort);

    let done = false;
    const finish = (settle: () => void): void => {
      if (done) return;
      done = true;
      const current = this.pending.get(callId);
      if (current) {
        this.pending.delete(callId);
        clearTimeout(current.timer);
        if (current.onAbort && current.signal) current.signal.removeEventListener("abort", current.onAbort);
      }
      this.busy = false;
      settle();
      this.dispatchNext();
    };

    const timer = setTimeout(() => {
      const collateral = this.describeOutstanding(callId);
      console.warn(
        LOG_PREFIX,
        `工具 ${tool} 超时（${timeoutMs}ms），重启 host` + (collateral ? `；将连带拒绝 ${collateral}` : ""),
      );
      this.killing = true;
      try { child.kill(); } catch { /* ignore */ }
      finish(() => entry.reject(new Error(`native 工具 ${tool} 超时`)));
    }, timeoutMs);

    const onAbort = (): void => {
      console.warn(LOG_PREFIX, `工具 ${tool} 已取消（AbortSignal），杀 host 中止`);
      this.killing = true;
      try { child.kill(); } catch { /* ignore */ }
      finish(() => entry.reject(createAbortError()));
    };

    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    this.pending.set(callId, {
      resolve: (value) => finish(() => entry.resolve(value)),
      reject: (error) => finish(() => entry.reject(error)),
      timer,
      tool,
      signal,
      onAbort,
    });

    try {
      child.stdin!.write(`${JSON.stringify({ op: "call", callId, tool, args })}\n`);
    } catch (error) {
      finish(() => entry.reject(error instanceof Error ? error : new Error(String(error))));
    }
  }

  /**
   * 调用一个 native 工具。返回 null = native 轨不可用（调用方回退 TS）。
   * 拒绝（超时/进程故障）同样由调用方捕获后回退 TS；signal 中止时以
   * AbortError 拒绝——调用方必须原样上抛，不得回退重跑。
   */
  async call(
    tool: string,
    args: Record<string, unknown>,
    timeoutMs = 5000,
    signal?: AbortSignal,
  ): Promise<unknown | null> {
    if (signal?.aborted) throw createAbortError();
    if (!(await this.ensureStarted())) return null;
    if (this.exited || !this.proc) return null;
    return new Promise<unknown>((resolve, reject) => {
      const callId = `t${++this.callSeq}`;
      const entry: QueuedCall = { callId, tool, args, timeoutMs, signal, resolve, reject };
      // 排队期间取消：直接摘除，不触达 host
      if (signal) {
        entry.onAbort = () => {
          const idx = this.queue.indexOf(entry);
          if (idx >= 0) this.queue.splice(idx, 1);
          reject(createAbortError());
        };
        signal.addEventListener("abort", entry.onAbort, { once: true });
      }
      this.queue.push(entry);
      this.dispatchNext();
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
 * options.timeoutMs：按件看门狗（缺省 5s），长任务必须覆盖。
 * options.signal：父运行取消信号（AbortError 原样上抛，不回退重跑）。
 */
export async function nativeFirst(
  tool: string,
  args: Record<string, unknown>,
  fallback: (args: Record<string, unknown>) => Promise<string> | string,
  options: NativeFirstOptions = {},
): Promise<string> {
  // CYRENE_TOOL_HOST=0：所有接线方式（含裸 nativeFirst 工具）统一零触达
  if (!resolveDotnetConfig().toolHost) return fallback(args);
  if (options.signal?.aborted) throw createAbortError();
  try {
    const result = await nativeToolHost.call(tool, args, options.timeoutMs, options.signal);
    if (result !== null) {
      return typeof result === "string" ? result : JSON.stringify(result);
    }
  } catch (error) {
    if (isAbortError(error)) throw error; // 取消必须中止：回退 TS 会重复执行副作用
    console.warn(LOG_PREFIX, `native 轨失败回退 TS（${tool}）:`, error instanceof Error ? error.message : error);
  }
  return fallback(args);
}

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
 *     覆盖）→ 默认杀掉 host 重启（工具无状态，重启零成本），当次调用回退 TS；
 *     只读调用可经 NativeFirstOptions.abandonOnTimeout 走轻量隔离（#IKJLP2）：
 *     超时只拒绝当次、host 保留，等迟到结果帧排空后再派发后续调用；兜底窗口
 *     max(timeoutMs, 5s) 到期仍无结果才杀 host 收敛
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
import type { ToolDefinition } from "./registry/tool-registry";
import type { ToolContext } from "./registry/tool-context";
import { ToolExecutionError } from "./registry/tool-execution-error";

const LOG_PREFIX = "[ToolHost]";

/** 轻量隔离排空兜底的窗口下限（#IKJLP2）：max(当次 timeoutMs, 本值)。 */
const ABANDON_DRAIN_MIN_MS = 5_000;

/** 宿主事件帧（op:"event"）：天气卡片等调用内副作用，随 callId 路由给对应调用。 */
export interface HostToolEvent {
  kind: string;
  payload: unknown;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  /** 工具名：超时/退出日志用于定位被连带拒绝的调用。 */
  tool: string;
  signal?: AbortSignal;
  onAbort?: () => void;
  /** 调用内事件回调（event 帧按 callId 路由）。 */
  onEvent?: (event: HostToolEvent) => void;
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
  /** 调用内事件回调（event 帧按 callId 路由）。 */
  onEvent?: (event: HostToolEvent) => void;
  /** 超时轻量隔离（只读调用，#IKJLP2）：超时不杀 host，排空完成前不派发新帧。 */
  abandonOnTimeout?: boolean;
}

/** 宿主运行时配置（config 帧载荷）。 */
export interface HostRuntimeSettings {
  timezone: string;
  dateLocale: string;
  /** 本地数据根（expenses.json 等宿主侧落盘位置）；null = 宿主侧不可用。 */
  dataDir: string | null;
  /** web_search 引擎与各源 key（B1：仅宿主内存驻留，不落盘；调用前刷新）。 */
  webSearch: WebSearchHostSettings | null;
  /** 天气查询配置（B1：key 仅宿主内存驻留，不落盘；调用前刷新）。 */
  weather: WeatherHostSettings | null;
  /** 出行工具配置（B1：key 仅宿主内存驻留，不落盘；调用前刷新）。 */
  travel: TravelHostSettings | null;
  /** 邮件配置（B1：授权码仅宿主内存驻留，不落盘；调用前刷新）。 */
  email: EmailHostSettings | null;
}

/** web_search 宿主侧配置。 */
export interface WebSearchHostSettings {
  engine: string;
  bochaKey: string;
  tavilyKey: string;
  anySearchKey: string;
}

/** weather 宿主侧配置。 */
export interface WeatherHostSettings {
  city: string;
  /** "open-meteo" | "amap" */
  source: string;
  amapKey: string;
  enabled: boolean;
  /** geocoding language（weatherLanguage，如 zh/en/ja）。 */
  language: string;
}

/** plan_trip 宿主侧配置。 */
export interface TravelHostSettings {
  amapKey: string;
  enabled: boolean;
}

/** 邮件宿主侧配置（SMTP/IMAP 共用账号；pass 为授权码，B1 仅内存驻留）。 */
export interface EmailHostSettings {
  enabled: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  user: string;
  pass: string;
  fromName: string;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
}

/** nativeFirst 按件选项：长耗时工具（大文件下载/外网请求）覆盖默认 5s 看门狗。 */
export interface NativeFirstOptions {
  /** 单次调用超时（ms）。缺省 5000；应 ≥ C# 侧内部超时，避免 native 轨被误杀。 */
  timeoutMs?: number;
  /**
   * 超时轻量隔离（#IKJLP2，仅限只读调用）：超时只拒绝当次、不杀 host——标记
   * 「已放弃在途」等迟到结果帧排空后再派发后续调用，排队调用不因当次超时被
   * 连带拒绝；兜底窗口 max(timeoutMs, 5s) 到期仍无结果才杀 host 收敛（排队
   * 调用按 E_TOOL_NOT_DISPATCHED sentinel 安全回退，与默认语义一致）。
   * 副作用类调用必须维持默认杀进程语义：native 完成与 TS 回退并发会重复副作用。
   */
  abandonOnTimeout?: boolean;
  /** 父运行取消信号：排队中直接取消，在途杀 host 中止；AbortError 原样上抛不回退。 */
  signal?: AbortSignal;
  /** 调用内事件回调（如 weather_card）：event 帧按 callId 路由；只有 native 轨会触发。 */
  onEvent?: (event: HostToolEvent) => void;
  /**
   * 可信内部参数（`__` 前缀，docs/pr-review-rules.md §2.3）：nativeFirst 先剥离
   * 模型 args 中的 `__` 键，再合并本字段下发宿主。模型/渲染层注入的内部参数
   * 一律丢弃——内部参数只能经此通道由主进程可信装配注入。
   */
  internalArgs?: Record<string, unknown>;
  /**
   * native 轨失败（超时/进程故障/错误帧）时是否回退 TS，默认 true。
   * 副作用类工具（send_email）置 false：失败可能发生在「已执行但未收到确认」之后，
   * 自动回退会重复副作用——此时结构化上抛 effectState:"unknown"（不重跑），
   * 交由 Harness 登记 uncertainEffects。
   */
  fallbackOnError?: boolean;
  /**
   * fallbackOnError=false 时仍允许安全回退的错误码清单（确定「未执行副作用」的
   * 前置失败，如 E_EMAIL_PRECONDITION=SMTP 连接/认证失败、未进入发送阶段）。
   * 排队未派发 sentinel（NativeCallNotDispatchedError）始终安全回退，无需列入。
   */
  safeFallbackCodes?: readonly string[];
  /** fallbackOnError=false 且 native 不确定失败时的提示文案（缺省为通用不确定态文案）。 */
  uncertainFailureMessage?: (error: Error) => string;
}

/**
 * 剥离模型 args 中的内部参数（`__` 前缀）。
 * 信任边界（docs/pr-review-rules.md §2.3）：`__` 键只能由主进程可信装配注入，
 * 来自模型 / 渲染层的一律视为攻击并丢弃，不得进入宿主帧。
 */
export function stripInternalArgs(args: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (!key.startsWith("__")) clean[key] = value;
  }
  return clean;
}

/**
 * 「确定未派发」错误（P2-2）：host 退出时被连带拒绝的**排队**调用——call 帧
 * 从未写入 stdin，副作用确定未执行；nativeFirst 据此在 fallbackOnError:false
 * 下仍安全回退 TS。在途调用（call 帧已下发）失败仍是普通 Error：状态可能未知。
 */
export class NativeCallNotDispatchedError extends Error {
  readonly name = "NativeCallNotDispatchedError";
  readonly code = "E_TOOL_NOT_DISPATCHED";
  constructor(message = "tool-host 进程退出（调用尚未派发，确定未执行）") {
    super(message);
  }
}

/** 判定失败是否「确定未执行副作用」：排队未派发 sentinel，或错误码命中安全清单。 */
function isDefinitelyNotApplied(error: Error, safeCodes?: readonly string[]): boolean {
  if (error instanceof NativeCallNotDispatchedError) return true;
  const code = (error as Error & { code?: unknown }).code;
  return typeof code === "string" && (safeCodes?.includes(code) ?? false);
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
  /**
   * 「已放弃在途」调用（轻量隔离，#IKJLP2）：超时后等待迟到结果帧排空，
   * 排空完成前不派发新帧；兜底计时器到期仍无结果则杀 host 收敛。
   */
  private abandoned: { callId: string; tool: string; timer: NodeJS.Timeout } | null = null;
  private callSeq = 0;
  private settings: HostRuntimeSettings = {
    timezone: "Asia/Shanghai",
    dateLocale: "zh-CN",
    dataDir: null,
    webSearch: null,
    weather: null,
    travel: null,
    email: null,
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
    if (patch.webSearch !== undefined) this.settings.webSearch = patch.webSearch;
    if (patch.weather !== undefined) this.settings.weather = patch.weather;
    if (patch.travel !== undefined) this.settings.travel = patch.travel;
    if (patch.email !== undefined) this.settings.email = patch.email;
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
        this.clearAbandoned();
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
          // 排队调用从未写入 stdin：独立 sentinel 标记「确定未派发」，
          // 与在途失败（状态可能未知）分流（P2-2）
          entry.reject(entry.signal?.aborted ? createAbortError() : new NativeCallNotDispatchedError());
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
    if (op === "event") {
      // 调用内事件（如 weather_card）：按 callId 路由给对应调用的回调；无回调则忽略
      const callId = typeof frame.callId === "string" ? frame.callId : "";
      const call = this.pending.get(callId);
      if (!call?.onEvent) return;
      try {
        call.onEvent({ kind: typeof frame.kind === "string" ? frame.kind : "", payload: frame.payload });
      } catch (error) {
        console.warn(LOG_PREFIX, "事件回调异常:", error instanceof Error ? error.message : error);
      }
      return;
    }
    if (op === "result") {
      const callId = typeof frame.callId === "string" ? frame.callId : "";
      const call = this.pending.get(callId);
      if (!call) {
        // 轻量隔离（#IKJLP2）：已放弃在途调用的迟到结果帧——丢弃并恢复派发（排空完成）
        if (this.abandoned?.callId === callId) {
          const abandonedTool = this.abandoned.tool;
          this.clearAbandoned();
          console.warn(LOG_PREFIX, `已放弃调用 ${callId}(${abandonedTool}) 结果帧到达（丢弃），排空完成、继续派发`);
          this.dispatchNext();
        }
        return;
      }
      if (frame.ok === true) call.resolve(frame.data);
      else {
        const failure = new Error(typeof frame.error === "string" ? frame.error : "工具执行失败");
        // B5 错误码契约透传：错误帧 errorCode（如 E_EMAIL_PRECONDITION=确定未进入
        // 发送阶段）挂到 Error.code，nativeFirst 据此判定是否可安全回退（P2-3）
        if (typeof frame.errorCode === "string" && frame.errorCode) {
          (failure as Error & { code?: string }).code = frame.errorCode;
        }
        call.reject(failure);
      }
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

  /** 清除「已放弃在途」标记（结果帧排空 / host 退出 / 兜底杀进程时调用）。 */
  private clearAbandoned(): void {
    if (this.abandoned) {
      clearTimeout(this.abandoned.timer);
      this.abandoned = null;
    }
  }

  /**
   * 串行闸门派发：同一时刻至多一个 call 帧在途（看门狗随派发起算）。
   * 上一个调用 settle / host 退出后自动派发下一个。
   */
  private dispatchNext(): void {
    if (this.busy || this.exited || this.killing || this.abandoned) return;
    const child = this.proc;
    if (!child) return;
    const entry = this.queue.shift();
    if (!entry) return;

    this.busy = true;
    const { callId, tool, args, timeoutMs, signal, onEvent } = entry;
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
      if (entry.abandonOnTimeout) {
        // 轻量隔离（#IKJLP2，只读调用）：超时只拒绝当次、host 保留；标记
        // 「已放弃在途」等迟到结果帧排空后再派发——排队调用不因当次超时被
        // 连带拒绝。兜底窗口到期仍无结果 → 视为真卡死，杀 host 收敛
        // （排队调用按 E_TOOL_NOT_DISPATCHED sentinel 安全回退，与默认语义一致）。
        const drainMs = Math.max(timeoutMs, ABANDON_DRAIN_MIN_MS);
        console.warn(
          LOG_PREFIX,
          `工具 ${tool} 超时（${timeoutMs}ms），轻量隔离：放弃当次调用（host 保留，排空兜底 ${drainMs}ms）`,
        );
        this.abandoned = {
          callId,
          tool,
          timer: setTimeout(() => {
            if (this.abandoned?.callId !== callId) return; // 已排空 / 已随 host 退出清除
            this.clearAbandoned();
            console.warn(LOG_PREFIX, `已放弃调用 ${callId}(${tool}) 排空超时（${drainMs}ms），杀 host 收敛`);
            this.killing = true;
            try { child.kill(); } catch { /* ignore */ }
          }, drainMs),
        };
        finish(() => entry.reject(new Error(`native 工具 ${tool} 超时`)));
        return;
      }
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
      onEvent,
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
   *
   * 信任边界：args 必须是「模型参数已剥离 `__` 键 + 可信内部参数」的最终装配结果
   * （用 nativeFirst / withNativeFirst，或调用方自行 stripInternalArgs）；
   * 模型/渲染层原始 args 不得直接传入。
   */
  async call(
    tool: string,
    args: Record<string, unknown>,
    timeoutMs = 5000,
    signal?: AbortSignal,
    onEvent?: (event: HostToolEvent) => void,
    abandonOnTimeout = false,
  ): Promise<unknown | null> {
    if (signal?.aborted) throw createAbortError();
    if (!(await this.ensureStarted())) return null;
    if (this.exited || !this.proc) return null;
    return new Promise<unknown>((resolve, reject) => {
      const callId = `t${++this.callSeq}`;
      const entry: QueuedCall = { callId, tool, args, timeoutMs, signal, resolve, reject, onEvent, abandonOnTimeout };
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
 * options.internalArgs：可信 `__` 内部参数（唯一注入通道）；模型 args 里的 `__` 键先被剥离，
 *   TS 回退同样只拿剥离后的参数。
 */
export async function nativeFirst(
  tool: string,
  args: Record<string, unknown>,
  fallback: (args: Record<string, unknown>) => Promise<string> | string,
  options: NativeFirstOptions = {},
): Promise<string> {
  // 信任边界：模型 args 的 `__` 键一律剥离；可信内部参数只经 internalArgs 注入。
  // TS 回退（零触达/失败/确定未执行）也统一只拿剥离后的参数（P2-6④ 口径一致）。
  const cleanArgs = stripInternalArgs(args);
  // CYRENE_TOOL_HOST=0：所有接线方式（含裸 nativeFirst 工具）统一零触达
  if (!resolveDotnetConfig().toolHost) return fallback(cleanArgs);
  if (options.signal?.aborted) throw createAbortError();
  const nativeArgs = options.internalArgs
    ? { ...cleanArgs, ...options.internalArgs }
    : cleanArgs;
  try {
    const result = await nativeToolHost.call(
      tool, nativeArgs, options.timeoutMs, options.signal, options.onEvent, options.abandonOnTimeout,
    );
    if (result !== null) {
      return typeof result === "string" ? result : JSON.stringify(result);
    }
  } catch (error) {
    if (isAbortError(error)) throw error; // 取消必须中止：回退 TS 会重复执行副作用
    const failure = error instanceof Error ? error : new Error(String(error));
    if (options.fallbackOnError === false && !isDefinitelyNotApplied(failure, options.safeFallbackCodes)) {
      // 副作用安全：失败可能是「已执行、确认未回」，自动回退会重复副作用。
      // 结构化上抛 effectState:"unknown"（P2-1）→ executeToolDefinition 保留事实
      // → Harness 登记 uncertainEffects 并拦截同 fingerprint 重放。
      console.warn(LOG_PREFIX, `native 轨失败且禁止自动回退（${tool}）:`, failure.message);
      throw new ToolExecutionError(
        "E_TOOL_EFFECT_UNKNOWN",
        options.uncertainFailureMessage?.(failure)
          ?? `[错误] ${tool} 执行状态未知（native 轨失败：${failure.message}）；为避免重复执行副作用不会自动回退。`,
        "semantic_failure",
        false,
        "unknown",
      );
    }
    // fallbackOnError 缺省 true：任何失败都回退（双轨语义对齐）；false 时到这里
    // 仅限确定未执行（排队未派发 / safeFallbackCodes 命中的前置失败）
    console.warn(LOG_PREFIX, `native 轨失败回退 TS（${tool}）:`, failure.message);
  }
  return fallback(nativeArgs);
}

/** 判定宿主输出是否为"成功载荷里的业务失败"（C# Err(...) JSON）——是则调用方回退 TS 拿原错误语义。 */
export function isNativeFailurePayload(text: string): boolean {
  try {
    const parsed = JSON.parse(text) as { success?: unknown } | null;
    return parsed !== null && typeof parsed === "object" && parsed.success === false;
  } catch {
    return false; // 非 JSON（纯文本输出）按成功处理
  }
}

/**
 * 通用"native 优先"工具包装（写类/生成类工具）：保留工具元数据，把 execute 换成
 * prepare → native 调用 → 失败回退 TS 原实现。
 *
 * prepare 返回 native 调用参数；返回 null 表示"不触达 native"（校验不通过或 host 不可用），
 * 直接走 TS 原实现产出语义一致的错误/结果。prepare 内抛出的语义拒绝（如覆盖防骤降）
 * 原样上抛，不回退重跑副作用。模型 args 中的 `__` 键在进入 prepare 前统一剥离
 * （信任边界 §2.3），可信内部参数只能由 prepare 自行装配；TS 回退同样只拿
 * 剥离后的 args（不再向 TS 实现透传模型伪造的 `__` 键）。
 */
export function withNativeFirst(
  tool: ToolDefinition,
  nativeTool: string,
  prepare: (args: Record<string, unknown>, ctx?: ToolContext) => Record<string, unknown> | null,
  timeoutMs?: number,
  abandonOnTimeout = false,
): ToolDefinition {
  const tsExecute = tool.execute.bind(tool);
  return {
    ...tool,
    execute: async (args, ctx) => {
      // 信任边界：先剥离模型 args 的 `__` 键；TS 回退（零触达/prepare 拒绝/
      // native 失败）统一只拿剥离后的参数，口径与 nativeFirst 一致（P2-6④）
      const cleanArgs = stripInternalArgs(args);
      if (!resolveDotnetConfig().toolHost) return tsExecute(cleanArgs, ctx);
      const nativeArgs = prepare(cleanArgs, ctx);
      if (nativeArgs === null) return tsExecute(cleanArgs, ctx);
      try {
        const result = await nativeToolHost.call(nativeTool, nativeArgs, timeoutMs, ctx?.signal, undefined, abandonOnTimeout);
        if (result !== null) {
          const text = typeof result === "string" ? result : JSON.stringify(result);
          if (!isNativeFailurePayload(text)) return text;
          console.warn(LOG_PREFIX, nativeTool, "native 返回错误载荷，回退 TS:", text.slice(0, 200));
        }
      } catch (error) {
        if (isAbortError(error)) throw error; // 取消必须中止：回退 TS 会重复执行副作用
        console.warn(LOG_PREFIX, nativeTool, "native 轨失败回退 TS:", error instanceof Error ? error.message : error);
      }
      return tsExecute(cleanArgs, ctx);
    },
  };
}

/**
 * .NET host 统一客户端（rag/memory/loop + voice 分发）。
 *
 * 共用同一套 JSON 行协议骨架（与 native-tool-host 同构）；voice 有
 * 二进制段（4B 长度头）——本客户端只发文本帧，音频回传走
 * onBinary 回调由调用方拼。各 host 开关来自 resolveDotnetConfig()
 * （B4：全部 0/1 直切）。
 *
 * 进程生命周期（IKJSNF）：启动不可用分支杀已 spawn 的子进程；exit/error
 * 处理器按「当前实例」守卫（旧 child 的迟到事件不得清掉新 spawn 的引用）；
 * 超时 kill 带 SIGKILL 强杀兜底（与 shutdown 的 5s 对齐，exit 到达即取消）；
 * 事件订阅成对（addEventListener / removeEventListener，避免长驻单例上
 * 订阅者累积泄漏）。
 */
import { spawn, type ChildProcess } from "child_process";
import * as readline from "readline";
import { resolveNativeWindowsExe } from "../windows/native-windows-host";
import { resolveDotnetConfig } from "./config";

const VOICE_EXE_NAME = "CyreneVoice.exe";

/** 超时 kill 的 SIGKILL 强杀兜底窗口（与 shutdown 的 5s 对齐，IKJSNF）。 */
const KILL_ESCALATE_MS = 5_000;

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class LineHostClient {
  private proc: ChildProcess | null = null;
  private exited = false;
  private starting: Promise<boolean> | null = null;
  private pending = new Map<string, Pending>();
  private seq = 0;
  /** killAndReset 的 SIGKILL 兜底计时器（exit 到达即取消，避免垂死进程拖住重启）。 */
  private killEscalation: { child: ChildProcess; timer: NodeJS.Timeout } | null = null;
  private readonly mode: string | string[];
  private readonly timeoutMs: number;

  constructor(mode: string | string[], timeoutMs = 10_000) {
    this.mode = mode;
    this.timeoutMs = timeoutMs;
  }

  /** 子类追加启动参数（如 --data-dir）。 */
  protected extraArgs(): string[] {
    return [];
  }

  async ensureStarted(): Promise<boolean> {
    if (this.proc && !this.exited) return true;
    if (this.starting) return this.starting;
    const starting = (async () => {
      const exe = this.resolveExe();
      if (!exe) return false;
      // mode 支持数组（["dotnet", dll, "--tool-host"] 形态——argv[0] 是
      // 可执行本身，其余是参数；单字符串时 exe+mode 两段式不变）
      const argv = [...(Array.isArray(this.mode) ? this.mode.slice(1) : [this.mode]), ...this.extraArgs()];
      const child = spawn(exe, argv, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      // 启动不可用分支：子进程已 spawn，必须杀掉再返回——否则孤儿进程
      // 存活到应用退出（本模块子进程未登记 trackChildProcess，退出兜底不覆盖，IKJSNF）
      if (!child?.stdout?.readable || !child?.stdin) {
        try { child?.kill(); } catch { /* ignore */ }
        return false;
      }
      this.proc = child;
      this.exited = false;
      // 实例代际守卫（IKJSNF）：killAndReset 先摘引用再 kill，旧 child 的
      // exit/error 若在窗口内到达，不得清掉新 spawn 的引用或状态
      //
      // spawn 失败（ENOENT 等）立即反馈：清 pending + 标记退出，
      // 调用方收到明确错误而非干等超时
      child.on("error", (err) => {
        if (this.proc !== child) return;
        this.exited = true;
        this.proc = null;
        this.starting = null;
        for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error(`host 启动失败: ${err.message}`)); }
        this.pending.clear();
      });
      child.stdout.setEncoding("utf-8");
      const rl = readline.createInterface({ input: child.stdout });
      rl.on("line", (line) => {
        if (this.proc !== child) return; // 旧实例迟到帧忽略（幽灵结果不路由）
        this.onLine(line);
      });
      child.on("exit", () => {
        // 强杀兜底计时器：exit 到达即取消（此 child 可能已被 killAndReset 摘引用）
        if (this.killEscalation?.child === child) this.cancelKillEscalation();
        if (this.proc !== child) return;
        this.exited = true;
        this.proc = null;
        this.starting = null;
        for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error("host 退出")); }
        this.pending.clear();
      });
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 10_000);
        child.once("spawn", () => { clearTimeout(timer); resolve(); });
      });
      return true;
    })();
    this.starting = starting;
    // 复审 P2-2⑥：同步/异步 reject 也必须清 starting——否则失败 promise 被永久缓存，
    // 后续 ensureStarted 永远拿到同一次失败（宿主再也拉不起来）。
    try {
      return await starting;
    } finally {
      this.starting = null;
    }
  }

  /** 保存路径门控用（IKJNX1 #1）：同步判定宿主进程当前是否存活（不触发拉起）。 */
  isAlive(): boolean {
    return !!this.proc && !this.exited;
  }

  protected resolveExe(): string | null {
    // 数组 mode：argv[0] 即可执行（测试后门/自定义 sidecar 启动）
    if (Array.isArray(this.mode)) return String(this.mode[0]);
    if (this.mode === "--voice-host") {
      // A15：voice 是独立 exe（资源目录 voice/ 下）
      try {
        const electron = require("electron");
        const path = require("node:path");
        const fs = require("node:fs") as typeof import("node:fs");
        if (electron.app?.isPackaged) {
          const p = path.join(process.resourcesPath, "voice", VOICE_EXE_NAME);
          if (fs.existsSync(p)) return p;
        }
        const dev = path.join(electron.app.getAppPath(), "dotnet", "voice", "CyreneVoice", "bin", "Release", "net10.0", VOICE_EXE_NAME);
        return fs.existsSync(dev) ? dev : null;
      } catch {
        return null;
      }
    }
    return resolveNativeWindowsExe();
  }

  /** onBinary：voice 客户端覆盖以收音频段。 */
  protected onBinary(_payload: Buffer): void { /* 默认无二进制 */ }

  private onLine(line: string): void {
    // voice 轨二进制段与文本帧混流：按 4B 头探测
    // （简化实现：文本协议仍按行；二进制段仅 voice 且经 onBinary 上抛）
    let frame: Record<string, unknown>;
    try { frame = JSON.parse(line); } catch { return; }
    const op = frame.op as string | undefined;
    if (op === "result" || op === "finished") {
      const callId = frame.callId as string;
      const p = this.pending.get(callId);
      if (!p) return;
      this.pending.delete(callId);
      clearTimeout(p.timer);
      if (frame.ok === false) {
        // 复审 P0-5：对齐仓库错误帧约定 {error: "msg", errorCode: "E_..."}——
        // 业务错误码挂到 Error 上，调用方可分类（lane 满 / auth 缺失 / secret 不可用）
        const err = new Error(String(frame.error ?? "host 调用失败")) as Error & { errorCode?: string; retryable?: boolean };
        if (typeof frame.errorCode === "string") err.errorCode = frame.errorCode;
        if (typeof frame.retryable === "boolean") err.retryable = frame.retryable;
        p.reject(err);
      } else {
        p.resolve(frame.data ?? frame);
      }
    } else if (op === "ready" || op === "log" || op === "vad_result" || op === "asr_partial" || op === "asr_final" || op === "tts_meta") {
      this.onEvent(frame);
    }
  }

  private eventListeners: Array<(frame: Record<string, unknown>) => void> = [];

  protected onEvent(frame: Record<string, unknown>): void {
    // 快照派发：订阅者可在回调内 removeEventListener，不因数组位移漏发本轮其余订阅者
    for (const l of [...this.eventListeners]) l(frame);
  }

  // 事件订阅：host 主动帧（vad_result/asr/tts_meta/log）观察者。
  // 客户端是长驻单例：订阅方 dispose 时必须 removeEventListener，否则订阅者累积泄漏（IKJSNF）。
  addEventListener(listener: (frame: Record<string, unknown>) => void): void {
    this.eventListeners.push(listener);
  }

  /** 移除事件订阅（按引用；未订阅过则 no-op，可重复调用）。 */
  removeEventListener(listener: (frame: Record<string, unknown>) => void): void {
    const idx = this.eventListeners.indexOf(listener);
    if (idx >= 0) this.eventListeners.splice(idx, 1);
  }

  call(op: string, args: Record<string, unknown>): Promise<unknown> {
    const callId = `h${++this.seq}-${Math.random().toString(36).slice(2, 7)}`;
    return new Promise((resolve, reject) => {
      if (!this.proc || this.exited) { reject(new Error("host 未运行")); return; }
      const timer = setTimeout(() => {
        this.pending.delete(callId);
        this.exited = true;          // 先标记，防新 call 拿到垂死 proc
        this.killAndReset();
        reject(new Error(`${op} 超时（${this.timeoutMs}ms，host 已重置）`));
      }, this.timeoutMs);
      this.pending.set(callId, { resolve, reject, timer });
      try {
        this.proc.stdin!.write(`${JSON.stringify({ op, callId, ...args })}\n`);
      } catch (error) {
        this.pending.delete(callId);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /**
   * 杀掉当前子进程并复位（调用超时路径）。
   * 先摘引用再 kill：旧 child 的 exit/error 处理器带 `this.proc !== child`
   * 守卫，不会清掉窗口期内新 spawn 的引用（IKJSNF）。
   * 强杀兜底：SIGTERM 后 KILL_ESCALATE_MS 仍无 exit → SIGKILL（与 shutdown
   * 的 5s 兜底对齐；exit 到达则取消计时器）。
   */
  private killAndReset(): void {
    const child = this.proc;
    this.exited = true;
    this.proc = null;
    // 复审 P2-2：旧 child 的 exit 会被代际守卫短路（this.proc !== child），不能指望
    // 它清理在途调用——这里直接结算剩余 pending（调用方超时路径自己的 pending 已摘除），
    // 否则其余调用各自干等超时（最长 30s）。
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error("host 已重置")); }
    this.pending.clear();
    if (!child) return;
    // 上一轮兜底若还在（旧 child 尚未 exit），先取消再为本次重新计时
    this.cancelKillEscalation();
    const timer = setTimeout(() => {
      this.killEscalation = null;
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    }, KILL_ESCALATE_MS);
    this.killEscalation = { child, timer };
    try { child.kill(); } catch { /* ignore */ }
  }

  private cancelKillEscalation(): void {
    if (this.killEscalation) {
      clearTimeout(this.killEscalation.timer);
      this.killEscalation = null;
    }
  }

  async shutdown(): Promise<void> {
    const child = this.proc;
    if (!child || this.exited) return;
    // 在途调用立即失败（不等 exit 事件）
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error("host 关停中")); }
    this.pending.clear();
    try { child.stdin?.write(`${JSON.stringify({ op: "shutdown" })}\n`); } catch { /* ignore */ }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } resolve(); }, 5_000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }
}

/** RAG host 客户端（E7 开关：resolveDotnetConfig().ragHost）。 */
export class RagHostClient extends LineHostClient {
  enabled(): boolean { return resolveDotnetConfig().ragHost; }
  open(dbPath: string, jsonImportPath?: string) { return this.call("open", { dbPath, jsonImportPath }); }
  query(embedding: number[], text: string, topK = 8) { return this.call("query", { embedding, text, topK }); }
  upsert(entries: unknown[]) { return this.call("upsert", { entries }); }
  markRecalled(ids: string[]) { return this.call("mark_recalled", { ids }); }
  stats() { return this.call("stats", {}); }
}

/** 记忆 host 行（id/key + 内容 JSON + 时间戳）。content 发送为任意 JSON；读回为原始 JSON 文本。 */
export interface MemoryHostRow {
  id: string;
  content: unknown;
  salience?: number;
  createdAt?: number;
  updatedAt?: number;
}

/** 记忆 host 客户端（I7 开关：resolveDotnetConfig().memoryHost）。 */
export class MemoryHostClient extends LineHostClient {
  enabled(): boolean { return resolveDotnetConfig().memoryHost; }
  open(dbPath: string, jsonImportPath?: string) { return this.call("open", { dbPath, jsonImportPath }); }
  put(level: string, id: string, content: unknown, opts?: { salience?: number; createdAt?: number; updatedAt?: number }) {
    return this.call("put", { level, id, content, ...opts });
  }
  /** 整层替换：clear + 批量写入（一次事务）。 */
  replace(level: string, rows: MemoryHostRow[]) { return this.call("replace", { level, rows }); }
  clear(level: string) { return this.call("clear", { level }); }
  delete(level: string, id: string) { return this.call("delete", { level, id }); }
  get(level: string, id?: string) { return this.call("get", { level, ...(id ? { id } : {}) }); }
  query(level: string, limit = 50) { return this.call("query", { level, limit }); }
  append(level: string, content: unknown, key?: string) { return this.call("append", { level, content, ...(key ? { key } : {}) }); }
  recordConflict(oldContent: string | null, newContent: string) { return this.call("record_conflict", { old: oldContent, new: newContent }); }
  recordReflection(content: string, sourceIds?: string) { return this.call("record_reflection", { content, sourceIds }); }
  stats() { return this.call("stats", {}); }
}

/** LoopHost 客户端（K5 开关；骨架态，默认 0）。 */
export class LoopHostClient extends LineHostClient {
  enabled(): boolean { return resolveDotnetConfig().loopHost; }
  start(messages: unknown[], tools?: string[]) { return this.call("start", { messages, tools }); }
  abort() { return this.call("abort", {}); }
}

/** 语音 host 客户端（F3.3；事件流走 onEvent 覆盖）。 */
export class VoiceHostClient extends LineHostClient {
  enabled(): boolean { return resolveDotnetConfig().voiceHost; }
  constructor() { super("--voice-host", 20_000); }
  tts(engine: string, payload: Record<string, unknown>): Promise<{ audioBase64: string; format: string } | null> {
    return this.call("tts", { engine, payload }) as Promise<{ audioBase64: string; format: string } | null>;
  }
  vadConfig(mode: string, opts: Record<string, unknown>) { return this.call("vad_config", { mode, ...opts }); }
}

export const ragHostClient = new RagHostClient("--rag-host");
export const memoryHostClient = new MemoryHostClient("--memory-host");
export const loopHostClient = new LoopHostClient("--loop-host");
export const voiceHostClient = new VoiceHostClient();

/**
 * .NET host 统一客户端（rag/memory/loop + voice 分发）。
 *
 * 共用同一套 JSON 行协议骨架（与 native-tool-host 同构）；voice 有
 * 二进制段（4B 长度头）——本客户端只发文本帧，音频回传走
 * onBinary 回调由调用方拼。各 host 开关来自 resolveDotnetConfig()
 * （B4：全部 0/1 直切）。
 */
import { spawn, type ChildProcess } from "child_process";
import * as readline from "readline";
import { resolveNativeWindowsExe } from "../windows/native-windows-host";
import { resolveDotnetConfig } from "./config";

const VOICE_EXE_NAME = "CyreneVoice.exe";

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
  private readonly mode: string | string[];
  private readonly timeoutMs: number;

  constructor(mode: string | string[], timeoutMs = 10_000) {
    this.mode = mode;
    this.timeoutMs = timeoutMs;
  }

  async ensureStarted(): Promise<boolean> {
    if (this.proc && !this.exited) return true;
    if (this.starting) return this.starting;
    const starting = (async () => {
      const exe = this.resolveExe();
      if (!exe) return false;
      // mode 支持数组（["dotnet", dll, "--tool-host"] 形态——argv[0] 是
      // 可执行本身，其余是参数；单字符串时 exe+mode 两段式不变）
      const argv = Array.isArray(this.mode) ? this.mode.slice(1) : [this.mode];
      const child = spawn(exe, argv, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      if (!child?.stdout?.readable || !child?.stdin) return false;
      this.proc = child;
      this.exited = false;
      // spawn 失败（ENOENT 等）立即反馈：清 pending + 标记退出，
      // 调用方收到明确错误而非干等超时
      child.on("error", (err) => {
        this.exited = true;
        this.proc = null;
        this.starting = null;
        for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error(`host 启动失败: ${err.message}`)); }
        this.pending.clear();
      });
      child.stdout.setEncoding("utf-8");
      const rl = readline.createInterface({ input: child.stdout });
      rl.on("line", (line) => this.onLine(line));
      child.on("exit", () => {
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
    const ok = await starting;
    this.starting = null;
    return ok;
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
      if (frame.ok === false) p.reject(new Error(String(frame.error ?? "host 调用失败")));
      else p.resolve(frame.data ?? frame);
    } else if (op === "ready" || op === "log" || op === "vad_result" || op === "asr_partial" || op === "asr_final" || op === "tts_meta") {
      this.onEvent(frame);
    }
  }

  private eventListeners: Array<(frame: Record<string, unknown>) => void> = [];

  protected onEvent(frame: Record<string, unknown>): void {
    for (const l of this.eventListeners) l(frame);
  }

  // 事件订阅：host 主动帧（vad_result/asr/tts_meta/log）观察者。
  addEventListener(listener: (frame: Record<string, unknown>) => void): void {
    this.eventListeners.push(listener);
  }

  call(op: string, args: Record<string, unknown>): Promise<unknown> {
    const callId = `h${++this.seq}-${Math.random().toString(36).slice(2, 7)}`;
    return new Promise((resolve, reject) => {
      if (!this.proc || this.exited) { reject(new Error("host 未运行")); return; }
      const timer = setTimeout(() => {
        this.pending.delete(callId);
        this.exited = true;          // 先标记，防新 call 拿到垂死 proc
        this.killAndReset();
        reject(new Error(`${op} 超时（${this.timeoutMs}ms，host 已重启）`));
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

  private killAndReset(): void {
    try { this.proc?.kill(); } catch { /* ignore */ }
    this.exited = true;
    this.proc = null;
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

/** 记忆 host 客户端（I7 开关）。 */
export class MemoryHostClient extends LineHostClient {
  enabled(): boolean { return resolveDotnetConfig().memoryHost; }
  open(dbPath: string, jsonImportPath?: string) { return this.call("open", { dbPath, jsonImportPath }); }
  put(level: string, id: string, content: unknown) { return this.call("put", { level, id, content }); }
  query(level: string, filter?: unknown) { return this.call("query", { level, filter }); }
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

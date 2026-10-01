// .NET 云存储托管宿主的宿主侧薄代理：cyrene-native --storage-host（stdio JSON 行协议）。
//
// 与 native-tool-host 的差异：storage 宿主是有状态的（连接/会话常驻），客户端超时只
// 放弃本次等待、绝不杀进程——否则一次慢传输会把整组会话打断。进程退出时统一拒绝在途
// 调用，下次调用自动重启（连接按需懒重连）。

import { spawn, type ChildProcess } from "node:child_process";
import * as readline from "node:readline";
import { app } from "electron";
import { isNativeWindowsEnabled, resolveNativeWindowsExe } from "../windows/native-windows-host";
import { trackChildProcess } from "../child-processes";

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const READY_TIMEOUT_MS = 10_000;

/** 宿主 result 帧失败：携带结构化 errorCode（STORAGE_*），供工具层透传。 */
export class StorageHostError extends Error {
  readonly errorCode: string;
  readonly retryable: boolean;

  constructor(errorCode: string, message: string, retryable = false) {
    super(message);
    this.name = "StorageHostError";
    this.errorCode = errorCode;
    this.retryable = retryable;
  }
}

export class NativeStorageHostClient {
  private proc: ChildProcess | null = null;
  private exited = false;
  private starting: Promise<void> | null = null;
  private pending = new Map<string, PendingCall>();
  private seq = 0;
  private readyWaiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
  private readonly spawnImpl: typeof spawn;

  constructor(spawnImpl?: typeof spawn) {
    this.spawnImpl = spawnImpl ?? spawn;
  }

  async ensureStarted(): Promise<void> {
    if (this.proc && !this.exited) return;
    if (this.starting) return this.starting;
    this.starting = this.launch().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async launch(): Promise<void> {
    if (!isNativeWindowsEnabled()) {
      throw new Error("NATIVE_UNAVAILABLE: 原生组件已禁用（CYRENE_NATIVE_WINDOWS=0）");
    }
    const exe = resolveNativeWindowsExe();
    if (!exe) {
      throw new Error("NATIVE_UNAVAILABLE: cyrene-native 不可用（需要 .NET 10 运行时与原生组件）");
    }

    let child: ChildProcess;
    try {
      child = this.spawnImpl(exe, ["--storage-host", "--data-dir", app.getPath("userData")], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      throw new Error(`NATIVE_UNAVAILABLE: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.proc = child;
    this.exited = false;
    trackChildProcess(child, "cyrene-native --storage-host");

    child.on("exit", () => {
      this.exited = true;
      this.proc = null;
      this.failAllPending(new Error("storage-host 进程退出"));
    });
    child.stdin?.on("error", () => {
      this.failAllPending(new Error("storage-host stdin 断开"));
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const line = chunk.toString().trim();
      if (line) console.warn("[StorageHost]", line.slice(0, 300));
    });
    if (!child.stdout) throw new Error("NATIVE_UNAVAILABLE: storage-host stdout 不可用");
    readline.createInterface({ input: child.stdout }).on("line", (line) => {
      if (!line.trim()) return;
      try {
        this.handleFrame(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // 协议外输出：忽略
      }
    });

    await new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve: () => { clearTimeout(timer); resolve(); },
        reject: (error: Error) => { clearTimeout(timer); reject(error); },
      };
      const timer = setTimeout(() => {
        this.readyWaiters = this.readyWaiters.filter((w) => w !== waiter);
        reject(new Error("storage-host 启动超时"));
      }, READY_TIMEOUT_MS);
      this.readyWaiters.push(waiter);
      child.once("exit", () => waiter.reject(new Error("storage-host 启动即退出")));
    });
  }

  private handleFrame(frame: Record<string, unknown>): void {
    const op = typeof frame.op === "string" ? frame.op : "";
    if (op === "ready") {
      for (const waiter of this.readyWaiters.splice(0)) waiter.resolve();
      return;
    }
    if (op !== "result") return;
    const callId = typeof frame.callId === "string" ? frame.callId : "";
    const call = this.pending.get(callId);
    if (!call) return;
    this.pending.delete(callId);
    clearTimeout(call.timer);
    if (frame.ok === true) {
      call.resolve(frame.data);
    } else {
      const errorCode = typeof frame.errorCode === "string" ? frame.errorCode : "STORAGE_IO_ERROR";
      const message = typeof frame.error === "string" ? frame.error : "storage-host 调用失败";
      call.reject(new StorageHostError(errorCode, message, frame.retryable === true));
    }
  }

  /** 调用宿主 op；超时只放弃等待（进程与会话保留）。 */
  async call(op: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<unknown> {
    await this.ensureStarted();
    const child = this.proc;
    if (!child || this.exited || !child.stdin) throw new Error("storage-host 进程不可用");
    return new Promise<unknown>((resolve, reject) => {
      const callId = `s${++this.seq}`;
      const timer = setTimeout(() => {
        this.pending.delete(callId);
        reject(new StorageHostError("STORAGE_TIMEOUT", `${op} 超过 ${timeoutMs}ms 未返回`, true));
      }, timeoutMs);
      this.pending.set(callId, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
        timer,
      });
      try {
        child.stdin!.write(`${JSON.stringify({ op, callId, ...params })}\n`);
      } catch (error) {
        this.pending.delete(callId);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private failAllPending(error: Error): void {
    for (const [, call] of this.pending) {
      clearTimeout(call.timer);
      call.reject(error);
    }
    this.pending.clear();
  }

  /** 应用退出时调用（正常情况下由 trackChildProcess 收尸）。 */
  dispose(): void {
    const child = this.proc;
    if (child && child.exitCode === null) {
      this.failAllPending(new Error("storage-host 已释放"));
      child.stdin?.end();
      child.kill();
    }
    this.proc = null;
    this.exited = false;
  }
}

export const nativeStorageHost = new NativeStorageHostClient();

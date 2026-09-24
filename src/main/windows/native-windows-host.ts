// cyrene-native 窗口进程宿主客户端（Electron 主进程侧）。
//
// 取代 splash / sidebar / tasks 三个 BrowserWindow（-3 Chromium 渲染进程，
// 约 -200~400MB 常驻）。窗口本体在 dotnet/native-windows/（WPF×2 + WinForms×1）。
//
// 启用条件（默认关闭，灰度开关）：
//   CYRENE_NATIVE_WINDOWS=1 且 exe 存在。未启用时 createAuxWindows /
//   createSplashWindow 走原 BrowserWindow 路径——每步可回退。
//
// 数据推送复用主进程现成的 IPC 数据源（runtimeState / modelConfig /
// scheduler / tokenUsage），窗口动作（openSettings 等）转发到既有
// 主进程窗口管理函数。

import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { app } from "electron";

// ── 帧协议（与 cyrene-embed sidecar 同构） ──
interface Frame {
  id: number;
  op?: string;
  name?: string;
  kind?: string;
  action?: string;
  section?: string;
  ok?: boolean;
  error?: string;
  [key: string]: unknown;
}

type CommandHandler = (frame: Frame) => void;

const READY_TIMEOUT_MS = 15_000;

let cachedExePath: string | null | undefined;

/**
 * 原生窗口默认启用（v2.0.0 起从灰度转正）。
 *
 * 语义：
 *   - 默认启用（exe 就位即走 .NET 窗口路径）
 *   - 显式回退：CYRENE_NATIVE_WINDOWS=0 强制走 Electron BrowserWindow
 *     （排障开关；exe 缺失/运行时未装时自动回退，无需手动设置）
 */
export function isNativeWindowsEnabled(): boolean {
  if (process.env.CYRENE_NATIVE_WINDOWS === "0") return false;
  return true;
}

export function resolveNativeWindowsExe(): string | null {
  if (cachedExePath !== undefined) return cachedExePath;
  try {
    if (app.isPackaged) {
      const packaged = path.join(process.resourcesPath, "native-windows", "cyrene-native.exe");
      if (fs.existsSync(packaged)) {
        cachedExePath = packaged;
        return packaged;
      }
    } else {
      for (const cfg of ["Debug", "Release"]) {
        const dev = path.join(
          app.getAppPath(), "dotnet", "native-windows", "bin", cfg, "net10.0-windows", "cyrene-native.exe",
        );
        if (fs.existsSync(dev)) {
          cachedExePath = dev;
          return dev;
        }
      }
    }
  } catch {
    /* 非 Electron 环境（单测）：文件系统探测失败按未启用处理 */
  }
  cachedExePath = null;
  return null;
}

/**
 * 窗口动作回调（宿主注入）：openSettings / openChat / openCall /
 * togglePin / modelSwitch / splashShown。返回 false 表示动作未处理
 * （native 侧仍保持窗口自身状态）。
 */
export interface NativeWindowsHost {
  onCommand(frame: Frame): void;
}

export class NativeWindowsClient {
  private child: ChildProcess | null = null;
  private startup: Promise<void> | null = null;
  private chunks: Buffer[] = [];
  private bufferedBytes = 0;
  /**
   * 已解析、但帧体尚未到齐的帧长。管道分块到达时前缀会先被消费掉，
   * 必须保留长度状态等帧体补齐——否则下一块数据会被当作新前缀读出
   * 错误的长度（bad frame length）。
   */
  private pendingFrameLength: number | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: () => void; reject: (e: Error) => void }>();
  private onCommand: CommandHandler;
  private readonly exePath: string;

  constructor(exePath: string, host: NativeWindowsHost) {
    this.exePath = exePath;
    this.onCommand = (frame) => host.onCommand(frame);
  }

  get running(): boolean {
    return this.child !== null && this.child.exitCode === null;
  }

  /** 确保 native 进程已启动并完成 ready 握手（幂等）。 */
  async ensureStarted(): Promise<void> {
    if (this.running) return;
    if (this.startup) return this.startup;
    this.startup = this.launch().finally(() => {
      this.startup = null;
    });
    return this.startup;
  }

  private async launch(): Promise<void> {
    const child = spawn(this.exePath, ["serve"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        // WPF/Forms 进程无需 Electron 变量；保留 PATH 以便美术字体等
        ELECTRON_RUN_AS_NODE: undefined as unknown as string,
      },
    });
    this.child = child;
    this.chunks = [];
    this.bufferedBytes = 0;
    this.pendingFrameLength = null;

    const isCurrent = () => this.child === child;

    child.on("error", (error) => {
      if (!isCurrent()) return;
      console.error("[NativeWindows] spawn failed:", error.message);
      this.resetForRespawn();
    });
    child.on("exit", (code) => {
      if (!isCurrent()) return;
      // native 进程异常退出：窗口全部消失。宿主侧标记未运行，
      // 下次 ensureStarted 重启（窗口状态由调用方按需重 spawn）
      console.warn(`[NativeWindows] exited with code ${code}`);
      this.failAllPending(new Error(`native windows process exited: ${code}`));
      this.resetForRespawn();
    });
    child.stdin?.on("error", () => {
      if (!isCurrent()) return;
      this.failAllPending(new Error("native windows stdin broken"));
      this.resetForRespawn();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      // native 侧诊断日志直通（stderr 不参与帧协议）
      process.stderr.write(`[cyrene-native] ${chunk}`);
    });

    const stdout = child.stdout;
    if (!stdout) throw new Error("native windows stdout unavailable");
    stdout.on("data", (chunk: Buffer) => {
      if (!isCurrent()) return;
      this.chunks.push(chunk);
      this.bufferedBytes += chunk.length;
      this.drainFrames();
    });

    // ready 握手
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("native windows ready timeout"));
        void this.dispose("ready-timeout");
      }, READY_TIMEOUT_MS);
      const original = this.readyCallback;
      this.readyCallback = () => {
        clearTimeout(timeout);
        this.readyCallback = original;
        resolve();
      };
    });
  }

  private readyCallback: (() => void) | null = null;

  private take(n: number): Buffer | null {
    if (n === 0) return Buffer.alloc(0);
    if (this.bufferedBytes < n) return null;
    const first = this.chunks[0];
    if (first && first.length >= n) {
      const out = first.subarray(0, n);
      if (first.length === n) this.chunks.shift();
      else this.chunks[0] = first.subarray(n);
      this.bufferedBytes -= n;
      return out;
    }
    const out = Buffer.concat(this.chunks, n);
    let consumed = 0;
    while (consumed < n && this.chunks.length > 0) {
      const chunk = this.chunks[0];
      if (chunk.length <= n - consumed) {
        consumed += chunk.length;
        this.chunks.shift();
      } else {
        this.chunks[0] = chunk.subarray(n - consumed);
        consumed = n;
      }
    }
    this.bufferedBytes -= n;
    return out;
  }

  private drainFrames(): void {
    for (;;) {
      // 前缀与帧体可能分块到达（.NET 侧 prefix/body 是两次 Write）：
      // 长度解析后先存 pendingFrameLength，等帧体到齐再消费，避免
      // 消费掉前缀却丢弃长度状态导致流错位。
      if (this.pendingFrameLength === null) {
        const prefix = this.take(4);
        if (!prefix) return;
        const len = prefix.readInt32LE(0);
        if (len < 0 || len > 16 * 1024 * 1024) {
          console.error(`[NativeWindows] bad frame length ${len}; recycling`);
          this.failAllPending(new Error("native windows protocol failure"));
          this.disposeSync("protocol-failure");
          return;
        }
        this.pendingFrameLength = len;
      }
      const headerBuf = this.take(this.pendingFrameLength);
      if (!headerBuf) return;
      this.pendingFrameLength = null;
      let frame: Frame;
      try {
        frame = JSON.parse(headerBuf.toString("utf8"));
      } catch {
        console.error("[NativeWindows] bad frame JSON; recycling");
        this.failAllPending(new Error("native windows protocol failure"));
        this.disposeSync("protocol-failure");
        return;
      }
      this.handleFrame(frame);
    }
  }

  private handleFrame(frame: Frame): void {
    // ready 帧（id=0）
    if (frame.id === 0 && frame.op === "ready") {
      this.readyCallback?.();
      return;
    }
    // 事件通知（无 id 语义）
    if (frame.op === "event") {
      if (frame.name === "cmd") {
        this.onCommand(frame);
      } else if (frame.name === "win.shown") {
        this.onCommand(frame); // splash shown → 启动编排最短时长计时
      }
      return;
    }
    // 请求响应
    const pending = this.pending.get(frame.id);
    if (!pending) return;
    this.pending.delete(frame.id);
    if (frame.ok) pending.resolve();
    else pending.reject(new Error(frame.error ?? "native windows request failed"));
  }

  private async request(payload: Record<string, unknown>): Promise<void> {
    const child = this.child;
    if (!child || !child.stdin || child.exitCode !== null) {
      throw new Error("native windows process is not running");
    }
    const id = this.nextId++;
    return new Promise<void>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const json = Buffer.from(JSON.stringify({ id, ...payload }), "utf8");
      const prefix = Buffer.alloc(4);
      prefix.writeInt32LE(json.length);
      child.stdin!.write(prefix);
      child.stdin!.write(json);
    });
  }

  // ── 公开 API：窗口生命周期 + 状态推送 ──

  async spawnWindow(kind: "splash" | "sidebar" | "tasks" | "settings" | "plugins", layout?: unknown): Promise<void> {
    await this.ensureStarted();
    await this.request({ op: "win.spawn", kind, layout: layout ?? {} });
  }

  async showWindow(kind: string): Promise<void> {
    await this.request({ op: "win.show", kind });
  }

  async closeWindow(kind: string): Promise<void> {
    await this.request({ op: "win.close", kind });
  }

  async pushLayout(layout: unknown): Promise<void> {
    await this.request({ op: "win.layout", layout });
  }

  async pushRuntimeState(state: unknown): Promise<void> {
    await this.request({ op: "state.runtime", state });
  }

  async pushModelConfig(config: unknown): Promise<void> {
    await this.request({ op: "state.model", config });
  }

  async pushPlugins(payload: unknown): Promise<void> {
    await this.ensureStarted();
    await this.request({ op: "state.plugins", plugins: payload ?? {} });
  }

  async pushSettings(settings: unknown): Promise<void> {
    await this.ensureStarted();
    await this.request({ op: "state.settings", settings: settings ?? {} });
  }

  async pushTasks(tasks: unknown, usage: unknown): Promise<void> {
    await this.request({ op: "state.tasks", tasks, usage });
  }

  failAllPending(error: Error): void {
    for (const p of this.pending.values()) p.reject(error);
    this.pending.clear();
  }

  private resetForRespawn(): void {
    this.child = null;
    this.chunks = [];
    this.bufferedBytes = 0;
    this.pendingFrameLength = null;
  }

  disposeSync(reason: string): void {
    const child = this.child;
    if (child && child.exitCode === null) {
      this.failAllPending(new Error(`native windows disposed: ${reason}`));
      child.stdin?.end();
      child.kill();
    }
    this.resetForRespawn();
  }

  async dispose(reason: string): Promise<void> {
    this.disposeSync(reason);
    // 等待退出
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
  }
}

// ── 模块级单例 ──
let sharedClient: NativeWindowsClient | null = null;

export function getNativeWindowsClient(host: NativeWindowsHost): NativeWindowsClient | null {
  if (!isNativeWindowsEnabled()) return null;
  const exe = resolveNativeWindowsExe();
  if (!exe) return null;
  if (!sharedClient) {
    sharedClient = new NativeWindowsClient(exe, host);
  }
  return sharedClient;
}

export function disposeNativeWindows(reason = "manual"): void {
  if (sharedClient) {
    sharedClient.disposeSync(reason);
  }
}

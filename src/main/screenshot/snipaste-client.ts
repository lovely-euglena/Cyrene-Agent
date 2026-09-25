// Snipaste 截图后端——把「Snipaste 命令行」包装成与内置 helper 相同的
// ScreenshotHelperClient 接口，供截图服务无感替换。
//
// 交互流程（命令行为 `Snipaste.exe snip --block -o clipboard`）：
//   1. 确保 Snipaste 常驻进程在运行（不在则拉起并等待就绪）；
//   2. 记录调用前剪贴板图片（取消判定基准）；
//   3. --block 等待用户完成截图/标注并退出截图界面；
//   4. 读剪贴板新图片：无变化 = 用户取消（SCREENSHOT_CANCELLED），
//      有变化 = 成功；chat-button 模式写入截图目录并回传文件路径与尺寸；
//   5. hotkey 模式（clipboard-only）不落盘。
//
// 为什么走剪贴板而不是 -o <文件>：-o clipboard 是官方文档里的免费版示例，
// 标注后的结果就是用户点击「复制」时写入的内容，语义最稳；文件输出在不同
// 版本/授权下的行为差异更大。
//
// 已知限制：Snipaste 截图界面由常驻进程持有，外部无法关闭，因此 cancel() 为
// 无操作；交互硬上限（默认 10 分钟）仅用于防止 Promise 永久挂起。

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFile, spawn } from "node:child_process";
import type {
  CaptureState,
  HelperProcessState,
  PendingRequest,
  ScreenshotHelperClient,
  ScreenshotMode,
  ScreenshotResult,
} from "./helper-client";
import { SNIPASTE_EXE_NAME } from "./snipaste-detect";

export interface SnipasteChildProcess {
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "exit", listener: (code: number | null) => void): unknown;
  kill(): unknown;
}

export interface SnipasteClientOptions {
  /** 解析 Snipaste.exe 绝对路径；null = 未安装/未检测到。 */
  resolveExecutable: () => Promise<string | null>;
  screenshotDirectory: string;
  /** 读当前剪贴板图片（PNG buffer）；空剪贴板返回 null。 */
  readClipboardPng: () => Buffer | null;
  spawnImpl?: (command: string, args: string[]) => SnipasteChildProcess;
  isProcessRunningImpl?: (executable: string) => Promise<boolean>;
  startProcessImpl?: (executable: string) => void;
  writeFileImpl?: (filePath: string, data: Buffer) => Promise<void>;
  sleepImpl?: (ms: number) => Promise<void>;
  platform?: NodeJS.Platform;
  now?: () => number;
  createRequestId?: () => string;
  logger?: Pick<Console, "debug" | "warn" | "error">;
  /** 拉起常驻进程后的就绪等待上限（毫秒），默认 8s。 */
  residentReadyTimeoutMs?: number;
  /** 就绪轮询间隔（毫秒），默认 250ms。 */
  residentReadyPollMs?: number;
  /** 单次截图交互硬上限（毫秒），默认 10 分钟。 */
  maxInteractionMs?: number;
}

/** 解析 PNG 尺寸（IHDR：签名 8 字节 + 长度/类型 8 字节后是宽高）。 */
export function readPngSize(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 24) return null;
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < signature.length; i += 1) {
    if (buffer[i] !== signature[i]) return null;
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

function defaultSpawn(command: string, args: string[]): SnipasteChildProcess {
  return spawn(command, args, { stdio: "ignore", windowsHide: true });
}

function defaultStartProcess(executable: string): void {
  try {
    const child = spawn(executable, [], { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
  } catch {
    // 拉起失败由后续 isProcessRunning 轮询兜底报 SNIPASTE_START_FAILED
  }
}

function defaultIsProcessRunning(executable: string): Promise<boolean> {
  if (process.platform !== "win32") return Promise.resolve(true);
  return new Promise((resolve) => {
    execFile(
      "tasklist.exe",
      ["/FI", `IMAGENAME eq ${path.basename(executable) || SNIPASTE_EXE_NAME}`, "/NH"],
      { windowsHide: true, timeout: 4000 },
      (error, stdout) => {
        const name = (path.basename(executable) || SNIPASTE_EXE_NAME).toLowerCase();
        resolve(!error && String(stdout ?? "").toLowerCase().includes(name));
      },
    );
  });
}

async function defaultWriteFile(filePath: string, data: Buffer): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, data);
}

export class SnipasteScreenshotClient implements ScreenshotHelperClient {
  private state: HelperProcessState = "stopped";
  private currentCaptureState: CaptureState = "idle";
  private executable: string | null = null;
  private pendingDetect: Promise<void> | null = null;
  private readonly emptyRequests = new Map<string, PendingRequest>();

  constructor(private readonly options: SnipasteClientOptions) {}

  get processState(): HelperProcessState {
    return this.state;
  }

  get captureState(): CaptureState {
    return this.currentCaptureState;
  }

  get pendingRequests(): ReadonlyMap<string, PendingRequest> {
    return this.emptyRequests;
  }

  ensureStarted(): Promise<void> {
    if (this.state === "ready" && this.executable) return Promise.resolve();
    if (this.pendingDetect) return this.pendingDetect;
    this.state = "starting";
    this.pendingDetect = (async () => {
      const executable = await this.options.resolveExecutable();
      if (!executable) {
        this.state = "unavailable";
        throw new Error("SNIPASTE_NOT_FOUND");
      }
      this.executable = executable;
      this.state = "ready";
      this.options.logger?.debug("[Snipaste] 使用可执行文件:", executable);
    })();
    return this.pendingDetect.finally(() => {
      this.pendingDetect = null;
    });
  }

  async start(
    mode: ScreenshotMode,
    _source: PendingRequest["source"],
  ): Promise<ScreenshotResult> {
    await this.ensureStarted();
    const executable = this.executable;
    if (!executable) throw new Error("SNIPASTE_NOT_FOUND");

    await this.ensureResidentRunning(executable);

    const requestId = (this.options.createRequestId ?? randomUUID)();
    const before = this.options.readClipboardPng();
    this.currentCaptureState = "selecting";
    try {
      const child = (this.options.spawnImpl ?? defaultSpawn)(
        executable,
        ["snip", "--block", "-o", "clipboard"],
      );
      await this.waitChild(child);

      this.currentCaptureState = "committing";
      const after = this.options.readClipboardPng();
      if (!after || (before !== null && before.equals(after))) {
        throw new Error("SCREENSHOT_CANCELLED:user");
      }
      const size = readPngSize(after);

      let filePath: string | null = null;
      if (mode === "clipboard-and-file") {
        if (!size) throw new Error("INVALID_SNIPASTE_IMAGE");
        filePath = path.join(this.options.screenshotDirectory, `${requestId}.png`);
        await (this.options.writeFileImpl ?? defaultWriteFile)(filePath, after);
      }

      return {
        requestId,
        filePath,
        width: size?.width ?? 0,
        height: size?.height ?? 0,
        mime: "image/png",
        clipboardWritten: true,
        hasAnnotations: false,
      };
    } finally {
      this.currentCaptureState = "idle";
    }
  }

  /** Snipaste 截图界面归常驻进程所有，外部无法关闭；调用取消为无操作。 */
  cancel(_requestId: string): void {
    // 有意留空（见文件头「已知限制」）。
  }

  async shutdown(): Promise<void> {
    this.state = "stopped";
  }

  private async ensureResidentRunning(executable: string): Promise<void> {
    const isRunning = this.options.isProcessRunningImpl ?? defaultIsProcessRunning;
    if (await isRunning(executable)) return;

    this.options.logger?.debug("[Snipaste] 常驻进程未运行，正在拉起…");
    (this.options.startProcessImpl ?? defaultStartProcess)(executable);

    const now = this.options.now ?? Date.now;
    const sleep = this.options.sleepImpl ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const timeoutMs = this.options.residentReadyTimeoutMs ?? 8000;
    const pollMs = this.options.residentReadyPollMs ?? 250;
    const deadline = now() + timeoutMs;
    while (now() < deadline) {
      await sleep(pollMs);
      if (await isRunning(executable)) return;
    }
    throw new Error("SNIPASTE_START_FAILED");
  }

  private waitChild(child: SnipasteChildProcess): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // 已退出
        }
        finish(() => reject(new Error("SNIPASTE_TIMEOUT")));
      }, this.options.maxInteractionMs ?? 10 * 60_000);
      child.on("error", (error) => finish(() => reject(new Error(`SNIPASTE_FAILED:${error.message}`))));
      child.on("exit", () => finish(() => resolve()));
    });
  }
}

/**
 * 可切换后端的截图客户端门面：生命周期层持有一个实例并把它交给截图服务，
 * 切换后端（设置变更）只替换内部委托对象，服务与 IPC 无需感知。
 */
export class SwitchableScreenshotClient implements ScreenshotHelperClient {
  constructor(private active: ScreenshotHelperClient) {}

  setActive(client: ScreenshotHelperClient): void {
    this.active = client;
  }

  get processState(): HelperProcessState {
    return this.active.processState;
  }

  get captureState(): CaptureState {
    return this.active.captureState;
  }

  get pendingRequests(): ReadonlyMap<string, PendingRequest> {
    return this.active.pendingRequests;
  }

  ensureStarted(): Promise<void> {
    return this.active.ensureStarted();
  }

  start(mode: ScreenshotMode, source: PendingRequest["source"]): Promise<ScreenshotResult> {
    return this.active.start(mode, source);
  }

  cancel(requestId: string): void {
    this.active.cancel(requestId);
  }

  shutdown(): Promise<void> {
    return this.active.shutdown();
  }
}

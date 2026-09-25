// .NET Snipaste 截图的宿主侧薄代理：调 cyrene-native --snipaste-capture。
//
// 双轨策略：cyrene-native 可用时走本客户端（.NET 负责探测/拉起/CLI/剪贴板/落盘），
// 不可用时回退 TS 存档实现（snipaste-client.ts）。native 失败不静默切换，避免
// 二次拉起截图界面——如实把错误码返回给调用方。

import { spawn } from "node:child_process";
import type {
  CaptureState,
  HelperProcessState,
  PendingRequest,
  ScreenshotHelperClient,
  ScreenshotMode,
  ScreenshotResult,
} from "./helper-client";

export interface NativeSnipasteCaptureChild {
  stdout?: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown } | null;
  stderr?: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown } | null;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "exit", listener: (code: number | null) => void): unknown;
  kill(): unknown;
}

export interface NativeSnipasteCaptureOptions {
  /** cyrene-native.exe；null = 原生轨不可用（调用方应改用 TS 存档实现）。 */
  resolveNativeExe: () => string | null;
  /** 设置里手填的 Snipaste 路径（可为空 = 原生侧自动探测）。 */
  getSnipastePath: () => string;
  screenshotDirectory: string;
  spawnImpl?: (command: string, args: string[]) => NativeSnipasteCaptureChild;
  logger?: Pick<Console, "debug" | "warn" | "error">;
  /** 客户端兜底超时（native 内建 10 分钟交互上限），默认 12 分钟。 */
  timeoutMs?: number;
}

interface NativeCaptureResult {
  ok?: unknown;
  error?: unknown;
  message?: unknown;
  filePath?: unknown;
  width?: unknown;
  height?: unknown;
}

/** 从 stdout 里取最后一行可解析的 JSON 结果（协议行之外的杂音容忍丢弃）。 */
export function parseNativeCaptureResult(stdout: string): NativeCaptureResult | null {
  const lines = stdout.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed && typeof parsed === "object") return parsed as NativeCaptureResult;
    } catch {
      // 继续找上一行
    }
  }
  return null;
}

export class NativeSnipasteCaptureClient implements ScreenshotHelperClient {
  private state: HelperProcessState = "stopped";
  private readonly emptyRequests = new Map<string, PendingRequest>();

  constructor(private readonly options: NativeSnipasteCaptureOptions) {}

  get processState(): HelperProcessState {
    return this.state;
  }

  get captureState(): CaptureState {
    return "idle";
  }

  get pendingRequests(): ReadonlyMap<string, PendingRequest> {
    return this.emptyRequests;
  }

  ensureStarted(): Promise<void> {
    if (!this.options.resolveNativeExe()) {
      this.state = "unavailable";
      return Promise.reject(new Error("NATIVE_UNAVAILABLE"));
    }
    this.state = "ready";
    return Promise.resolve();
  }

  async start(mode: ScreenshotMode, _source: PendingRequest["source"]): Promise<ScreenshotResult> {
    await this.ensureStarted();
    const exe = this.options.resolveNativeExe();
    if (!exe) throw new Error("NATIVE_UNAVAILABLE");

    const args = ["--snipaste-capture", "--mode", mode];
    if (mode === "clipboard-and-file") {
      args.push("--output-dir", this.options.screenshotDirectory);
    }
    const snipastePath = this.options.getSnipastePath()?.trim();
    if (snipastePath) args.push("--snipaste-path", snipastePath);

    const spawnImpl = this.options.spawnImpl ?? ((command, argv) => spawn(command, argv, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }));
    this.options.logger?.debug("[NativeSnipaste] spawn", exe, args.join(" "));
    const child = spawnImpl(exe, args);
    const outcome = await collectChild(child, this.options.timeoutMs ?? 12 * 60_000);

    if (outcome.spawnError) {
      // 超时保持与原协议一致的错误串（渲染端按 SNIPASTE_TIMEOUT 映射文案）
      if (outcome.spawnError === "SNIPASTE_TIMEOUT") throw new Error("SNIPASTE_TIMEOUT");
      throw new Error(`NATIVE_SNIPASTE_FAILED: ${outcome.spawnError}`);
    }
    const parsed = parseNativeCaptureResult(outcome.stdout);
    if (!parsed) {
      const detail = outcome.stderr.trim().slice(0, 200);
      throw new Error(
        `NATIVE_SNIPASTE_FAILED: 无结果输出${detail ? ` (${detail})` : ""}${outcome.exitCode !== 0 ? ` exit=${outcome.exitCode}` : ""}`,
      );
    }
    if (parsed.ok !== true) {
      const code = typeof parsed.error === "string" && parsed.error ? parsed.error : "SNIPASTE_FAILED";
      if (code === "SCREENSHOT_CANCELLED") throw new Error("SCREENSHOT_CANCELLED:user");
      throw new Error(code);
    }

    const filePath = typeof parsed.filePath === "string" ? parsed.filePath : null;
    if (mode === "clipboard-and-file" && !filePath) {
      throw new Error("SCREENSHOT_FILE_PATH_REQUIRED");
    }
    return {
      requestId: "native-snipaste",
      filePath,
      width: Number(parsed.width) || 0,
      height: Number(parsed.height) || 0,
      mime: "image/png",
      clipboardWritten: true,
      hasAnnotations: false,
    };
  }

  cancel(_requestId: string): void {
    // 截图界面归 Snipaste 常驻进程所有，外部无法关闭（同 TS 存档实现的限制）。
  }

  async shutdown(): Promise<void> {
    this.state = "stopped";
  }
}

interface ChildOutcome {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  spawnError?: string;
}

function collectChild(child: NativeSnipasteCaptureChild, timeoutMs: number): Promise<ChildOutcome> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (outcome: ChildOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 已退出 */ }
      finish({ stdout, stderr, exitCode: null, spawnError: "SNIPASTE_TIMEOUT" });
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => finish({ stdout, stderr, exitCode: null, spawnError: error.message }));
    child.on("exit", (code) => finish({ stdout, stderr, exitCode: code }));
  });
}

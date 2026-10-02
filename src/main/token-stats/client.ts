// 精确 token 统计：cyrene-token（.NET）宿主客户端。
//
// 职责边界（用户口径）：下载管理/URL/镜像回退/校验/缓存/加载/计数全部在 .NET
// 宿主内（dotnet/token-stats），本文件只做进程生命周期 + 帧协议 + 把文本/模型名
// 传过去。设置默认关闭；关闭、词表缺失或下载失败时调用方回退启发式估算。
//
// 帧协议（与 dotnet/token-stats/Program.cs 对齐）：
//   请求 [4B LE 长度][JSON {id, op, ...}]
//   响应 [4B LE 长度][JSON {id, ok, ...}]；启动握手 {id:0, op:"ready"}

import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { app } from "electron";
import { trackChildProcess } from "../child-processes";
import { loadGeneralSettings } from "../settings/settings-facade";
import { buildContextUsageSnapshot } from "../orchestrator/context-usage";
import { buildContextUsageSnapshotWithCounter } from "./exact-counter";
import {
  normalizeTokenizerModelId,
  type TokenizerSourceId,
} from "./models";
import type { ContextUsageSnapshotInput } from "../orchestrator/context-usage";
import type { ContextUsageSnapshot } from "../../shared/context-usage";

interface PendingRequest {
  resolve: (header: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface TokenizerStatusEntry {
  model: string;
  installed: boolean;
  known: boolean;
  path?: string | null;
}

/** 首次下载可能跨多个源（每个最长 120s），单请求上限取宽。 */
const REQUEST_TIMEOUT_MS = 300_000;
const READY_TIMEOUT_MS = 60_000;
const MAX_FRAME_BYTES = 64 * 1024 * 1024;

let cachedExePath: string | null | undefined;

/** cyrene-token 可执行文件路径（打包态 resources/token-stats；开发态 dotnet/.../bin）。 */
export function resolveTokenHostPath(): string | null {
  if (cachedExePath !== undefined) return cachedExePath;
  const override = process.env.CYRENE_TOKEN_HOST_EXE;
  if (override && fs.existsSync(override)) {
    cachedExePath = override;
    return cachedExePath;
  }
  const exeName = process.platform === "win32" ? "cyrene-token.exe" : "cyrene-token";
  const candidates: string[] = [];
  try {
    candidates.push(path.join(process.resourcesPath, "token-stats", exeName));
  } catch {
    /* 非打包环境无 resourcesPath */
  }
  // 单测/非 Electron 环境 app 可能为 undefined：安全跳过开发态探测
  if (!app?.isPackaged) {
    let repoRoot: string | null = null;
    try {
      repoRoot = app?.getAppPath() ?? null;
    } catch {
      repoRoot = null;
    }
    if (repoRoot) {
      candidates.push(
        path.join(repoRoot, "dotnet", "token-stats", "bin", "Release", "net10.0", "win-x64", "publish", exeName),
        path.join(repoRoot, "dotnet", "token-stats", "bin", "Release", "net10.0", exeName),
        path.join(repoRoot, "dotnet", "token-stats", "bin", "Debug", "net10.0", exeName),
      );
    }
  }
  cachedExePath = candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
  return cachedExePath;
}

/** 精确统计开关：设置开启且宿主存在（环境变量 CYRENE_TOKEN_STATS=0 可强制关闭）。 */
export function isTokenStatsEnabled(): boolean {
  if (process.env.CYRENE_TOKEN_STATS === "0") return false;
  try {
    if (resolveTokenHostPath() === null) return false;
    return loadGeneralSettings().tokenStatsEnabled === true;
  } catch {
    return false;
  }
}

function resolveSource(): TokenizerSourceId {
  try {
    const source = loadGeneralSettings().tokenStatsSource;
    if (source === "hf-mirror" || source === "huggingface" || source === "modelscope") return source;
  } catch {
    /* 设置未就绪：用默认 */
  }
  return "modelscope";
}

class TokenStatsClient {
  private child: ChildProcess | null = null;
  private buffer = Buffer.alloc(0);
  private pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private startup: Promise<boolean> | null = null;
  private ready = false;
  private stderrTail = "";

  /** 懒启动；返回 false 表示宿主不可用（调用方回退估算）。 */
  ensureStarted(source: TokenizerSourceId): Promise<boolean> {
    if (this.child && this.child.exitCode === null && this.ready) return Promise.resolve(true);
    if (this.startup) return this.startup;
    const exePath = resolveTokenHostPath();
    if (!exePath) return Promise.resolve(false);
    this.startup = new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (value: boolean): void => {
        if (settled) return;
        settled = true;
        this.startup = null;
        resolve(value);
      };
      try {
        let userDataDir: string | null = null;
        try {
          userDataDir = app?.getPath("userData") ?? null;
        } catch {
          userDataDir = null;
        }
        if (!userDataDir) {
          finish(false);
          return;
        }
        const dataDir = path.join(userDataDir, "token-stats");
        const child = spawn(exePath, ["serve", "--data-dir", dataDir, "--source", source], {
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
        this.child = child;
        this.ready = false;
        this.buffer = Buffer.alloc(0);
        this.stderrTail = "";
        trackChildProcess(child, "token-stats");

        const readyTimer = setTimeout(() => finish(false), READY_TIMEOUT_MS);
        child.stdout?.on("data", (chunk: Buffer) => {
          this.buffer = Buffer.concat([this.buffer, chunk]);
          for (const frame of this.takeFrames()) {
            if (frame.id === 0 && frame.op === "ready") {
              this.ready = true;
              clearTimeout(readyTimer);
              finish(true);
              continue;
            }
            const requestId = typeof frame.id === "number" ? frame.id : null;
            if (requestId === null) continue;
            const pending = this.pending.get(requestId);
            if (!pending) continue;
            this.pending.delete(requestId);
            clearTimeout(pending.timer);
            pending.resolve(frame);
          }
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          this.stderrTail = `${this.stderrTail}${chunk.toString("utf8")}`.slice(-2000);
        });
        // sidecar 崩溃后写入会触发 EPIPE：必须兜住，否则主进程 uncaught
        child.stdin?.on("error", () => { /* 退出路径统一在 exit 处理 */ });
        child.once("error", () => {
          clearTimeout(readyTimer);
          this.rejectAll(new Error("token host spawn 失败"));
          finish(false);
        });
        child.once("exit", () => {
          clearTimeout(readyTimer);
          this.ready = false;
          this.rejectAll(new Error("token host 已退出"));
          finish(false);
        });
      } catch {
        finish(false);
      }
    });
    return this.startup;
  }

  async request(
    source: TokenizerSourceId,
    payload: Record<string, unknown>,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<Record<string, unknown> | null> {
    const started = await this.ensureStarted(source);
    if (!started || !this.child || this.child.exitCode !== null) return null;
    const id = this.nextId++;
    return new Promise<Record<string, unknown> | null>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(null);
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (header) => resolve(header),
        reject: () => resolve(null),
        timer,
      });
      try {
        this.writeFrame({ id, ...payload });
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve(null);
      }
    });
  }

  private writeFrame(payload: Record<string, unknown>): void {
    const json = Buffer.from(JSON.stringify(payload), "utf8");
    const prefix = Buffer.alloc(4);
    prefix.writeInt32LE(json.length, 0);
    this.child?.stdin?.write(Buffer.concat([prefix, json]));
  }

  /** 从缓冲中取出完整帧（长度前缀可能跨 chunk）。 */
  private takeFrames(): Array<Record<string, unknown> & { id?: number; op?: string }> {
    const frames: Array<Record<string, unknown> & { id?: number; op?: string }> = [];
    while (this.buffer.length >= 4) {
      const length = this.buffer.readInt32LE(0);
      if (length < 0 || length > MAX_FRAME_BYTES) {
        this.buffer = Buffer.alloc(0);
        break;
      }
      if (this.buffer.length < 4 + length) break;
      const body = this.buffer.subarray(4, 4 + length).toString("utf8");
      this.buffer = this.buffer.subarray(4 + length);
      try {
        frames.push(JSON.parse(body));
      } catch {
        /* 单帧损坏：跳过，不破坏后续帧 */
      }
    }
    return frames;
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  isRunning(): boolean {
    return this.child !== null && this.child.exitCode === null && this.ready;
  }

  shutdown(): void {
    this.rejectAll(new Error("token host 已关闭"));
    try {
      this.child?.stdin?.end();
      this.child?.kill();
    } catch {
      /* 已退出 */
    }
    this.child = null;
    this.ready = false;
  }
}

const host = new TokenStatsClient();

/** 批量精确计数；不可用/失败返回 null（调用方回退估算）。 */
export async function countTokensExact(
  model: string,
  texts: string[],
  source: TokenizerSourceId = resolveSource(),
): Promise<number[] | null> {
  const normalized = normalizeTokenizerModelId(model);
  if (!normalized || texts.length === 0) return null;
  const header = await host.request(source, { op: "count", model: normalized, texts });
  if (!header || header.ok !== true || !Array.isArray(header.counts)) return null;
  const counts = header.counts.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return counts.length === texts.length ? counts : null;
}

/**
 * 上下文快照（精确版）：设置关闭/模型不支持/宿主失败时与 buildContextUsageSnapshot 完全一致。
 * 调用方无需自行判断开关（但仍建议关闭时走同步路径，避免事件延迟）。
 */
export async function buildContextUsageSnapshotExact(
  input: ContextUsageSnapshotInput,
  model: string | undefined,
): Promise<ContextUsageSnapshot> {
  if (!isTokenStatsEnabled()) return buildContextUsageSnapshot(input);
  if (normalizeTokenizerModelId(model) === null) return buildContextUsageSnapshot(input);
  return buildContextUsageSnapshotWithCounter(input, (texts) => countTokensExact(model ?? "", texts));
}

/** 词表安装状态（设置页/诊断用；宿主不可用返回 null）。 */
export async function getTokenizerStatus(model?: string): Promise<TokenizerStatusEntry[] | null> {
  const header = await host.request(resolveSource(), { op: "status", ...(model ? { model } : {}) });
  if (!header || header.ok !== true || !Array.isArray(header.models)) return null;
  return header.models as TokenizerStatusEntry[];
}

/** 删除已缓存词表（设置页/诊断用）。 */
export async function deleteTokenizer(model: string): Promise<boolean> {
  const header = await host.request(resolveSource(), { op: "delete", model });
  return header?.ok === true;
}

/** 应用退出时调用（幂等）。 */
export function shutdownTokenStatsHost(): void {
  host.shutdown();
}

/** 诊断：宿主是否正在运行（含词表缓存）。 */
export function isTokenStatsHostRunning(): boolean {
  return host.isRunning();
}

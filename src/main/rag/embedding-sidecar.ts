// .NET embedding sidecar 客户端（spawn cyrene-embed serve）。
//
// 激活条件（全部满足才启用，否则调用方回退 embedding-worker）：
//   1. 默认启用（CYRENE_EMBED_SIDECAR=0 关闭；exe 缺失自动回退 worker）
//   2. sidecar exe 存在（见 resolveSidecarPath）
//
// 帧协议见 dotnet/embedding-sidecar/Program.cs：
//   请求 [4B LE 头长][JSON {id,op:"embed",texts}]
//   响应 [4B LE 头长][JSON {id,ok,count,dim}][float32 LE count×dim×4]
//   就绪 {id:0,op:ready,modelKey,dim}
//
// 数值与 transformers.js WASM 逐位一致（verify cosine=1.0，
// max|diff|≈5e-7），因此 cacheIdentity 沿用 "local"——LanceDB
// 索引零迁移。同机性能：WASM 749ms/条 → ORT native 173ms/条。
//
// ⚠️ 实现要点（都是复查时踩过的坑）：
//   - 帧解析是跨 chunk 的状态机：二进制段不完整时保存 mid-frame
//     状态（header + binaryLength），否则下一个 chunk 的头 4 字节
//     会被误读为长度前缀 → 协议永久失步。
//   - Float32Array 构造要求 byteOffset 4 字节对齐；buffer 内偏移
//     由 header JSON 长度决定（任意值）→ 必须 ArrayBuffer.slice 拷贝
//     出对齐副本，不能直接视图。
//   - 每个请求带超时（READY_TIMEOUT 之外的请求级超时），sidecar
//     卡死时 reject → embedLocal 走 worker 兜底，并回收 sidecar。
//   - stdin EPIPE 必须监听，否则 sidecar 崩溃后写入触发主进程
//     uncaught exception。
//   - exit/error 处理器带身份校验：旧进程的退出事件晚到时不能
//     误杀新进程的 pending / 引用。

import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { app } from "electron";

interface PendingRequest {
  resolve: (vectors: Float32Array[]) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/** 模型加载 ready 超时（模型 570MB，慢盘 30s+ 也可能）。 */
const READY_TIMEOUT_MS = 60_000;
/** 单请求超时：基数 + 每条文本加时（native ~200ms/条，留 10x 余量）。 */
const REQUEST_TIMEOUT_BASE_MS = 30_000;
const REQUEST_TIMEOUT_PER_TEXT_MS = 2_000;
/** 响应头 JSON 上限（防御异常头字段）。 */
const MAX_HEADER_BYTES = 1 << 20;
/** 二进制段上限（0.5M 条 × 1024 dim × 4B = 2GB 的安全边界）。 */
const MAX_BINARY_BYTES = 512 << 20;

let cachedExePath: string | null | undefined;

/**
 * sidecar exe 路径（只找一次，结果缓存）。
 * 打包态：resources/embed-sidecar/cyrene-embed(.exe)（electron-builder extraResources）
 * 开发态：dotnet/embedding-sidecar/bin/Release|Debug/net10.0/（需 dotnet build/publish）
 */
export function resolveSidecarPath(): string | null {
  if (cachedExePath !== undefined) return cachedExePath;

  // Windows 产物带 .exe 后缀（此前只找无后缀名，Windows 打包态永远探测不到）
  const exeName = process.platform === "win32" ? "cyrene-embed.exe" : "cyrene-embed";
  const candidates: string[] = [];
  try {
    // 打包态（app.isPackaged 时 process.resourcesPath 指向 resources/）
    candidates.push(path.join(process.resourcesPath, "embed-sidecar", exeName));
  } catch {
    /* 非打包环境无 resourcesPath —— 忽略 */
  }
  // 开发态：app.getAppPath() 即仓库根（package.json 所在目录）
  if (!app.isPackaged) {
    const repoRoot = app.getAppPath();
    candidates.push(
      path.join(repoRoot, "dotnet", "embedding-sidecar", "bin", "Release", "net10.0", "win-x64", "publish", exeName),
      path.join(repoRoot, "dotnet", "embedding-sidecar", "bin", "Release", "net10.0", exeName),
      path.join(repoRoot, "dotnet", "embedding-sidecar", "bin", "Debug", "net10.0", exeName),
    );
  }

  cachedExePath = candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
  return cachedExePath;
}

export function isSidecarEnabled(): boolean {
  // 默认启用（转正）；CYRENE_EMBED_SIDECAR=0 显式关闭，exe 缺失自动回退 worker
  if (process.env.CYRENE_EMBED_SIDECAR === "0") return false;
  return resolveSidecarPath() !== null;
}

export class EmbeddingSidecarClient {
  private child: ChildProcess | null = null;
  private pending = new Map<number, PendingRequest>();
  private nextId = 1;
  // 接收缓冲：chunk 队列 + 计数。
  // 不用「单 buffer + Buffer.concat」累积：每 data 事件全量重拷贝是 O(n²)，
  // 大响应（256KB+ 多 chunk）时 CPU/GC 浪费显著；且消费用 subarray 视图
  // 会持有整个历史底层 buffer（跨帧滞留内存）。队列模型下每个视图最多
  // 持有队头单个 chunk（64KB 级），消费即弃。
  private chunks: Buffer[] = [];
  private bufferedBytes = 0;

  /**
   * 从队列头取精确 n 字节。数据不足返回 null（调用方等下个 data）。
   * 快路径（队头 chunk 足够）零拷贝返回视图；跨 chunk 时仅拼 n 字节。
   */
  private take(n: number): Buffer | null {
    if (n === 0) return Buffer.alloc(0);
    if (this.bufferedBytes < n) return null;
    const first = this.chunks[0];
    if (first.length >= n) {
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
  /** mid-frame 状态：header 已解析、二进制段未收齐（跨 chunk 状态机） */
  private frameState: { header: any; binaryLength: number } | null = null;
  private startup: Promise<void> | null = null;
  private modelKey: string | null = null;
  private onReadyFrame: ((header: any) => void) | null = null;

  constructor(private readonly exePath: string) {}

  getRunningState(): { running: boolean; modelKey: string | null; pendingRequests: number } {
    return {
      running: this.child !== null && this.child.exitCode === null,
      modelKey: this.modelKey,
      pendingRequests: this.pending.size,
    };
  }

  async embedTexts(modelKey: string, texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    if (this.modelKey && this.modelKey !== modelKey) {
      // 当前 sidecar 加载的模型不同：重启换模型（现阶段只有 bgem3，防御式处理）
      await this.dispose("model-switch");
    }
    await this.ensureStarted(modelKey);

    const id = this.nextId++;
    const timeoutMs =
      REQUEST_TIMEOUT_BASE_MS + REQUEST_TIMEOUT_PER_TEXT_MS * Math.min(texts.length, 256);
    return new Promise<Float32Array[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        // sidecar 疑似卡死：回收进程（下次调用自动重启），本次走调用方兜底
        void this.dispose("request-timeout");
        reject(new Error(`Embedding sidecar request timeout (${timeoutMs}ms, texts=${texts.length})`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.writeFrame({ id, op: "embed", texts });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        throw error;
      }
    });
  }

  private async ensureStarted(modelKey: string): Promise<void> {
    if (this.child && this.child.exitCode === null && this.modelKey === modelKey) return;
    if (!this.startup) {
      this.startup = this.launch(modelKey).finally(() => {
        this.startup = null;
      });
    }
    await this.startup;
  }

  private launch(modelKey: string): Promise<void> {
    this.disposeSync("relaunch");

    return new Promise<void>((resolve, reject) => {
      const child = spawn(this.exePath, ["serve", this.modelDirArg(modelKey)], {
        stdio: ["pipe", "pipe", "inherit"],
        env: this.buildEnv(),
      });
      this.child = child;
      this.chunks = [];
      this.bufferedBytes = 0;
      this.frameState = null;

      // 身份校验：本 child 的退出事件晚到时（已被 dispose/替换），
      // 不能误杀新 child 的 pending 和引用
      const isCurrent = () => this.child === child;

      child.on("error", (error) => {
        if (!isCurrent()) return;
        this.failAllPending(new Error(`Embedding sidecar spawn failed: ${error.message}`));
        this.resetForRespawn();
        reject(error);
      });

      child.on("exit", (code) => {
        if (!isCurrent()) return;
        this.failAllPending(new Error(`Embedding sidecar exited with code ${code}`));
        this.resetForRespawn();
        // 启动期（ready 未到）进程就死了：立刻 reject 启动 Promise，
        // 让 embedTexts 马上走 worker 兜底，而不是干等 60s ready 超时。
        // 已 settle 的 Promise 上调用 reject 是 no-op，安全。
        reject(new Error(`Embedding sidecar exited during startup (code ${code})`));
      });

      // EPIPE 防护：sidecar 崩溃后 writeFrame 的 stdin 错误若无人监听，
      // 会成为主进程 uncaught exception
      child.stdin?.on("error", () => {
        if (!isCurrent()) return;
        this.failAllPending(new Error("Embedding sidecar stdin broken (EPIPE)"));
        this.resetForRespawn();
      });

      const stdout = child.stdout;
      if (!stdout) {
        reject(new Error("Embedding sidecar stdout unavailable"));
        return;
      }
      stdout.on("data", (chunk: Buffer) => {
        if (!isCurrent()) return;
        this.chunks.push(chunk);
        this.bufferedBytes += chunk.length;
        this.drainFrames();
      });

      // 等待 ready 帧（模型加载 2~3s，慢盘更久）
      const readyTimeout = setTimeout(() => {
        if (!isCurrent()) return;
        reject(new Error(`Embedding sidecar ready timeout (model=${modelKey})`));
        this.onReadyFrame = null;
        void this.dispose("ready-timeout");
      }, READY_TIMEOUT_MS);

      this.onReadyFrame = (header) => {
        if (header.id === 0 && header.op === "ready") {
          clearTimeout(readyTimeout);
          this.modelKey = header.modelKey;
          this.onReadyFrame = null;
          resolve();
        }
        // 非 ready 帧在启动期收到：忽略，继续等（不消耗 onReadyFrame）
      };
    });
  }

  private buildEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    // framework-dependent 构建：apphost 依赖 DOTNET_ROOT 找共享 runtime
    if (!env.DOTNET_ROOT) {
      const fallback = path.join(os.homedir(), ".dotnet");
      if (fs.existsSync(path.join(fallback, "dotnet"))) env.DOTNET_ROOT = fallback;
    }
    return env;
  }

  private modelDirArg(modelKey: string): string {
    // 模型目录解析与 embedding-pipeline 的 getProjectModelBaseDir 一致：
    // models/Xenova/bge-m3（bgem3 唯一模型）
    const key = modelKey || "bgem3";
    const candidates: string[] = [];
    try {
      candidates.push(path.join(process.resourcesPath, "embed-models", "Xenova", key === "bgem3" ? "bge-m3" : key));
    } catch {
      /* 非打包环境 */
    }
    if (!app.isPackaged) {
      // 开发态：仓库根（app.getAppPath()）
      const repoRoot = app.getAppPath();
      candidates.push(path.join(repoRoot, "models", "Xenova", "bge-m3"));
    }
    const found = candidates.find((candidate) => fs.existsSync(candidate));
    if (!found) throw new Error(`Embedding sidecar model dir not found for ${modelKey}`);
    return found;
  }

  private writeFrame(header: Record<string, unknown>): void {
    const child = this.child;
    if (!child || !child.stdin || child.exitCode !== null) {
      throw new Error("Embedding sidecar is not running");
    }
    const json = Buffer.from(JSON.stringify(header), "utf8");
    const prefix = Buffer.alloc(4);
    prefix.writeInt32LE(json.length);
    child.stdin.write(prefix);
    child.stdin.write(json);
  }

  /**
   * 帧解析状态机。跨 chunk 安全：header 已解析但二进制段未收齐时，
   * mid-frame 状态保存在 this.frameState，下个 data 事件先补齐再继续。
   */
  private drainFrames(): void {
    while (true) {
      // 1) 二进制段收集中（mid-frame）
      if (this.frameState) {
        const { header, binaryLength } = this.frameState;
        const binary = this.take(binaryLength);
        if (!binary) return; // 继续等数据
        this.frameState = null;
        this.completeResponse(header, binary);
        continue;
      }

      // 2) 新帧：长度前缀
      const prefix = this.take(4);
      if (!prefix) return;
      const headerLen = prefix.readInt32LE(0);
      if (headerLen < 0 || headerLen > MAX_HEADER_BYTES) {
        this.protocolFailure(`bad frame length ${headerLen}`);
        return;
      }
      const headerBuf = this.take(headerLen);
      if (!headerBuf) return; // 帧头不完整

      let header: any;
      try {
        header = JSON.parse(headerBuf.toString("utf8"));
      } catch {
        this.protocolFailure("frame header is not valid JSON");
        return;
      }

      // 启动期等 ready 帧
      if (this.onReadyFrame) {
        this.onReadyFrame(header);
        continue;
      }

      // 3) 二进制段长度推导 + 校验
      const binaryLength =
        header && header.ok && typeof header.count === "number" && typeof header.dim === "number"
          ? header.count * header.dim * 4
          : 0;
      if (!Number.isFinite(binaryLength) || binaryLength < 0 || binaryLength > MAX_BINARY_BYTES) {
        this.protocolFailure(`bad binary length ${binaryLength}`);
        return;
      }
      if (binaryLength > 0) {
        this.frameState = { header, binaryLength };
        continue;
      }
      this.completeResponse(header, null);
    }
  }

  private completeResponse(header: any, binary: Buffer | null): void {
    const pending = this.pending.get(header.id);
    if (!pending) return;
    this.pending.delete(header.id);
    clearTimeout(pending.timer);
    if (header.ok) {
      const dim = header.dim as number;
      const count = header.count as number;
      const vectors: Float32Array[] = [];
      for (let i = 0; i < count; i++) {
        // ⚠️ Float32Array 要求 byteOffset 4 对齐；buffer 内偏移取决于
        // header 长度（任意）。ArrayBuffer.slice 返回对齐的独立副本。
        const start = binary!.byteOffset + i * dim * 4;
        const copy = binary!.buffer.slice(start, start + dim * 4);
        vectors.push(new Float32Array(copy));
      }
      pending.resolve(vectors);
    } else {
      pending.reject(new Error(header.error ?? "Embedding sidecar embed failed"));
    }
  }

  /** 协议失序不可恢复：杀进程、清 pending（下次调用自动重启）。 */
  private protocolFailure(reason: string): void {
    console.error(`[EmbeddingSidecar] protocol failure: ${reason}; recycling sidecar`);
    this.failAllPending(new Error(`Embedding sidecar protocol failure: ${reason}`));
    this.disposeSync("protocol-failure");
  }

  private failAllPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private resetForRespawn(): void {
    this.child = null;
    this.modelKey = null;
    this.onReadyFrame = null;
    this.frameState = null;
    this.chunks = [];
    this.bufferedBytes = 0;
  }

  private disposeSync(reason: string): void {
    const child = this.child;
    if (child && child.exitCode === null) {
      this.failAllPending(new Error(`Embedding sidecar disposed: ${reason}`));
      child.stdin?.end();
      child.kill();
    }
    this.resetForRespawn();
  }

  async dispose(reason: string): Promise<void> {
    const child = this.child;
    if (child && child.exitCode === null) {
      this.failAllPending(new Error(`Embedding sidecar disposed: ${reason}`));
      child.stdin?.end();
      child.kill();
      await new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        setTimeout(resolve, 3000);
      });
    }
    this.resetForRespawn();
  }
}

// ── 模块级单例 ──
let sharedClient: EmbeddingSidecarClient | null = null;

export function getEmbeddingSidecarClient(): EmbeddingSidecarClient | null {
  if (!isSidecarEnabled()) return null;
  if (!sharedClient) {
    const exe = resolveSidecarPath();
    if (!exe) return null;
    sharedClient = new EmbeddingSidecarClient(exe);
  }
  return sharedClient;
}

export async function disposeEmbeddingSidecar(reason = "manual"): Promise<void> {
  if (sharedClient) {
    await sharedClient.dispose(reason);
  }
}

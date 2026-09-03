// .NET embedding sidecar 客户端（spawn cyrene-embed serve）。
//
// 激活条件（全部满足才启用，否则调用方回退 embedding-worker）：
//   1. 环境变量 CYRENE_EMBED_SIDECAR=1（实验开关，后续接 settings UI）
//   2. sidecar exe 存在（见 resolveSidecarPath）
//
// 帧协议见 dotnet/embedding-sidecar/Program.cs：
//   请求 [4B LE 头长][JSON {id,op:"embed",texts}]
//   响应 [4B LE 头长][JSON {id,ok,count,dim}][float32 LE count×dim×4]
//   就绪 {id:0,op:"ready",modelKey,dim}
//
// 数值与 transformers.js WASM 逐位一致（verify cosine=1.0，
// max|diff|≈5e-7），因此 cacheIdentity 沿用 "local"——LanceDB
// 索引零迁移。同机性能：WASM 749ms/条 → ORT native 173ms/条。

import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { app } from "electron";

interface PendingRequest {
  resolve: (vectors: Float32Array[]) => void;
  reject: (error: Error) => void;
}

let cachedExePath: string | null | undefined;

/**
 * sidecar exe 路径（只找一次，结果缓存）。
 * 打包态：resources/embed-sidecar/cyrene-embed（electron-builder extraResources）
 * 开发态：dotnet/embedding-sidecar/bin/Release/net10.0/（需手动 dotnet publish）
 * Linux 开发验证：bin/Debug 也可（弱机验证路径，正式走 Release）
 */
export function resolveSidecarPath(): string | null {
  if (cachedExePath !== undefined) return cachedExePath;

  const candidates: string[] = [];
  try {
    // 打包态（app.isPackaged 时 process.resourcesPath 指向 resources/）
    candidates.push(path.join(process.resourcesPath, "embed-sidecar", "cyrene-embed"));
  } catch {
    /* 非打包环境无 resourcesPath —— 忽略 */
  }
  const repoRoot = app.isPackaged
    ? null
    : path.join(app.getAppPath(), "..", "..", "..");
  if (repoRoot) {
    candidates.push(
      path.join(repoRoot, "dotnet", "embedding-sidecar", "bin", "Release", "net10.0", "cyrene-embed"),
      path.join(repoRoot, "dotnet", "embedding-sidecar", "bin", "Debug", "net10.0", "cyrene-embed"),
    );
  }

  cachedExePath = candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
  return cachedExePath;
}

export function isSidecarEnabled(): boolean {
  if (process.env.CYRENE_EMBED_SIDECAR !== "1") return false;
  return resolveSidecarPath() !== null;
}

export class EmbeddingSidecarClient {
  private child: ChildProcess | null = null;
  private pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private buffered = Buffer.alloc(0);
  private startup: Promise<void> | null = null;
  private modelKey: string | null = null;

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
      this.dispose("model-switch");
    }
    await this.ensureStarted(modelKey);

    const id = this.nextId++;
    return new Promise<Float32Array[]>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.writeFrame({ id, op: "embed", texts });
      // sidecar 崩溃由 exit 处理器统一 reject
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
        env: { ...process.env },
      });
      this.child = child;
      this.buffered = Buffer.alloc(0);

      child.on("error", (error) => {
        this.failAllPending(new Error(`Embedding sidecar spawn failed: ${error.message}`));
        this.resetForRespawn();
        reject(error);
      });

      child.on("exit", (code) => {
        this.failAllPending(new Error(`Embedding sidecar exited with code ${code}`));
        this.resetForRespawn();
      });

      const stdout = child.stdout;
      if (!stdout) {
        reject(new Error("Embedding sidecar stdout unavailable"));
        return;
      }
      stdout.on("data", (chunk: Buffer) => {
        this.buffered = Buffer.concat([this.buffered, chunk]);
        this.drainFrames();
      });

      // 等待 ready 帧（模型加载 2~3s）
      const readyTimeout = setTimeout(() => {
        reject(new Error(`Embedding sidecar ready timeout (model=${modelKey})`));
        void this.dispose("ready-timeout");
      }, 60_000);
      this.readyWaiters.push(() => clearTimeout(readyTimeout));

      const onFrame = (header: any) => {
        if (header.id === 0 && header.op === "ready") {
          this.modelKey = header.modelKey;
          const waiters = this.readyWaiters;
          this.readyWaiters = [];
          waiters.forEach((waker) => waker());
          stdout.off("data", this.boundData);
          resolve();
        }
      };
      // ready 帧只处理一次；drainFrames 在 resolve 后接管
      // —— 简化：onReady 标记
      this.onReadyFrame = onFrame;
    });
  }

  private readyWaiters: Array<() => void> = [];
  private onReadyFrame: ((header: any) => void) | null = null;
  private boundData = (chunk: Buffer) => this.buffered = Buffer.concat([this.buffered, chunk]);

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
    const repoRoot = app.isPackaged
      ? null
      : path.join(app.getAppPath(), "..", "..", "..");
    if (repoRoot) {
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

  private drainFrames(): void {
    while (this.buffered.length >= 4) {
      const headerLen = this.buffered.readInt32LE(0);
      if (this.buffered.length < 4 + headerLen) return; // 帧头不完整
      const headerJson = this.buffered.subarray(4, 4 + headerLen).toString("utf8");
      this.buffered = this.buffered.subarray(4 + headerLen);
      let header: any;
      try {
        header = JSON.parse(headerJson);
      } catch {
        continue; // 协议破坏：跳过该帧（不应发生）
      }

      // ready 帧（若仍在启动期）
      if (this.onReadyFrame) {
        this.onReadyFrame(header);
        this.onReadyFrame = null;
        continue;
      }

      const binaryLength = header.ok && header.count > 0 ? header.count * header.dim * 4 : 0;
      if (this.buffered.length < binaryLength) return; // 二进制段不完整，等下个 data 事件
      const binary = this.buffered.subarray(0, binaryLength);
      this.buffered = this.buffered.subarray(binaryLength);

      const pending = this.pending.get(header.id);
      if (!pending) continue;
      this.pending.delete(header.id);
      if (header.ok) {
        const vectors: Float32Array[] = [];
        const dims = header.dim;
        for (let i = 0; i < header.count; i++) {
          vectors.push(new Float32Array(binary.buffer, binary.byteOffset + i * dims * 4, dims));
        }
        pending.resolve(vectors);
      } else {
        pending.reject(new Error(header.error ?? "Embedding sidecar embed failed"));
      }
    }
  }

  private failAllPending(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  private resetForRespawn(): void {
    this.child = null;
    this.modelKey = null;
    this.onReadyFrame = null;
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

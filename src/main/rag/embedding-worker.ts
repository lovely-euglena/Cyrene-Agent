// Off-main-thread embedding execution.
//
// Electron 主进程此前的 local embedding（RAG 记忆检索、贴纸/场景索引）直接
// 在主进程加载 transformers.js WASM pipeline：bge-m3 单条推理数百毫秒到秒级，
// 期间推理计算占满线程，所有窗口 IPC 一起卡顿。
//
// 本模块把推理挪进专用 worker_threads：
//   - 主进程侧（EmbeddingWorkerClient）：懒启动 worker、请求/响应按
//     requestId 关联（init 握手复用同一套 pending 表）、worker 崩溃后下次
//     调用自动重启、unref 不阻塞应用退出。
//   - worker 侧：本文件自身作为 worker 入口（new Worker(__filename)，与
//     document-index-worker.ts 相同模式），串行执行推理作业。
//
// document-index-worker 已经跑在自己的 worker 线程里，那里的 provider 直接
// 用本线程 pipeline（isMainThread=false 分支），不会嵌套再起 worker。

import { Worker, isMainThread, parentPort } from "worker_threads";

// ── 协议 ──
export type EmbeddingWorkerInbound =
  | { type: "init"; requestId: number; modelKey: string }
  | { type: "embed"; requestId: number; texts: string[] };

export type EmbeddingWorkerOutbound =
  | { type: "ready"; requestId: number }
  | { type: "result"; requestId: number; dim: number; buffers: ArrayBuffer[] }
  | { type: "error"; requestId: number; reason: string };

/** 与 document-index-worker 的 DocumentIndexWorkerPort 同构的可注入端口 */
export interface EmbeddingWorkerPort {
  postMessage(message: EmbeddingWorkerInbound, transfer?: ArrayBuffer[]): void;
  on(event: "message" | "error" | "exit", listener: (...args: any[]) => void): unknown;
  terminate(): Promise<number>;
  unref(): void;
}

// ── worker 侧入口 ──
if (!isMainThread) {
  void runEmbeddingWorkerThread();
}

async function runEmbeddingWorkerThread(): Promise<void> {
  const port = parentPort;
  if (!port) return;

  const { getLocalPipeline, runBatchedInference } = await import("./embedding-pipeline");

  let activePipeline: any = null;

  const postError = (requestId: number, reason: string) => {
    try {
      port.postMessage({ type: "error", requestId, reason } satisfies EmbeddingWorkerOutbound);
    } catch {
      // port 已关闭（主进程退出）时忽略
    }
  };

  // transformers.js pipeline 不保证并发调用安全，串行执行所有作业
  let queue: Promise<void> = Promise.resolve();
  port.on("message", (message: EmbeddingWorkerInbound) => {
    queue = queue
      .then(async () => {
        if (message.type === "init") {
          activePipeline = await getLocalPipeline(message.modelKey);
          port.postMessage({ type: "ready", requestId: message.requestId } satisfies EmbeddingWorkerOutbound);
          return;
        }
        if (message.texts.length === 0) {
          port.postMessage({
            type: "result",
            requestId: message.requestId,
            dim: 0,
            buffers: [],
          } satisfies EmbeddingWorkerOutbound);
          return;
        }
        if (!activePipeline) {
          throw new Error("Embedding worker received embed before init");
        }
        const vectors = await runBatchedInference(activePipeline, message.texts);
        const dim = vectors[0].length;
        const buffers = vectors.map((vector) => vector.buffer as ArrayBuffer);
        // transfer list：向量零拷贝传回主线程
        port.postMessage(
          { type: "result", requestId: message.requestId, dim, buffers } satisfies EmbeddingWorkerOutbound,
          buffers,
        );
      })
      .catch((error: unknown) => {
        postError(message.requestId, error instanceof Error ? error.message : String(error));
      });
  });
}

// ── 主进程侧客户端 ──
interface PendingRequest {
  resolve: (vectors: Float32Array[]) => void;
  reject: (error: Error) => void;
}

function readIdleDisposeMs(): number {
  const raw = process.env.EMBEDDING_WORKER_IDLE_MS;
  if (raw && /^\d+$/.test(raw)) return Number(raw);
  return 600_000; // 10 分钟，与 sidecar CYRENE_EMBED_IDLE_EXIT_SEC 默认对齐
}

export class EmbeddingWorkerClient {
  private worker: EmbeddingWorkerPort | null = null;
  private workerBoot: Promise<EmbeddingWorkerPort> | null = null;
  private modelKey: string | null = null;
  private pending = new Map<number, PendingRequest>();
  private nextRequestId = 1;
  private readonly createWorkerPort: () => EmbeddingWorkerPort;

  /**
   * 空闲自动回收（ms）。worker 加载 bge-m3 WASM 后常驻 ~700MB，
   * 桌宠 24/7 场景下 embedding 调用是间歇性的（记忆写入/场景识别/
   * 贴纸索引），空闲即回收把常驻变峰值——与 .NET sidecar 的
   * CYRENE_EMBED_IDLE_EXIT_SEC（默认 600s）语义对齐。
   * terminate 后下次调用懒重启（模型加载 2-3s）。
   * EMBEDDING_WORKER_IDLE_MS 覆盖；0 = 永不回收。
   */
  private readonly idleDisposeMs: number;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(createWorkerPort?: () => EmbeddingWorkerPort, idleDisposeMs = readIdleDisposeMs()) {
    this.createWorkerPort = createWorkerPort ?? (() => new Worker(__filename) as unknown as EmbeddingWorkerPort);
    this.idleDisposeMs = idleDisposeMs;
  }

  /**
   * 在 worker 里执行批量 embedding。首次调用懒启动 worker 并加载模型。
   * worker 崩溃时本次调用失败，下次调用自动重启 worker。
   */
  async embedTexts(modelKey: string, texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    this.cancelIdleTimer();
    const worker = await this.ensureActiveWorker(modelKey);

    const requestId = this.nextRequestId++;
    try {
      return await new Promise<Float32Array[]>((resolve, reject) => {
        this.pending.set(requestId, { resolve, reject });
        worker.postMessage({ type: "embed", requestId, texts });
      });
    } finally {
      // 请求结束（含 reject）：无后续排队时排定空闲回收
      if (this.pending.size === 0) this.scheduleIdleDispose();
    }
  }

  /** 排定空闲回收计时。 */
  private scheduleIdleDispose(): void {
    if (this.idleDisposeMs <= 0) return;
    this.cancelIdleTimer();
    this.idleTimer = setTimeout(() => {
      if (this.pending.size > 0) return; // 又有请求进来，保活
      if (this.idleDisposeMs <= 0) return;
      this.idleTimer = null;
      console.log(`[EmbeddingWorker] idle ${this.idleDisposeMs / 1000}s, terminating (model memory reclaimed; lazy respawn on next call)`);
      this.dispose("idle-timeout");
    }, this.idleDisposeMs);
    this.idleTimer.unref?.();
  }

  private cancelIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  /**
   * ensureWorker 之后、postMessage 之前存在竞态窗口：worker 可能恰好崩溃
   * （exit 已把 this.worker 清空）。校验拿到的是当前活跃 worker，否则重试。
   */
  private async ensureActiveWorker(modelKey: string): Promise<EmbeddingWorkerPort> {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const worker = await this.ensureWorker(modelKey);
      if (this.worker === worker && this.modelKey === modelKey) {
        return worker;
      }
      lastError = new Error("Embedding worker exited during startup");
    }
    throw lastError ?? new Error("Embedding worker unavailable");
  }

  /** 停掉 worker（换模型 / reset provider / 空闲回收 / 应用退出时调用） */
  dispose(reason: string): void {
    this.cancelIdleTimer();
    const worker = this.worker;
    this.worker = null;
    this.workerBoot = null;
    this.modelKey = null;
    if (worker) {
      this.failAllPending(new Error(`Embedding worker disposed: ${reason}`));
      void worker.terminate().catch(() => undefined);
    }
  }

  getWorkerDiagnostics(): { workerRunning: boolean; modelKey: string | null; pendingRequests: number } {
    return {
      workerRunning: this.worker !== null,
      modelKey: this.modelKey,
      pendingRequests: this.pending.size,
    };
  }

  private ensureWorker(modelKey: string): Promise<EmbeddingWorkerPort> {
    if (this.workerBoot && this.modelKey === modelKey) {
      return this.workerBoot;
    }
    if (this.worker && this.modelKey === modelKey) {
      return Promise.resolve(this.worker);
    }
    // 模型切换：换 worker（目前只有 bgem3，此路径实际不会走到）
    if (this.worker || this.workerBoot) {
      this.dispose(`switching model to ${modelKey}`);
    }
    this.modelKey = modelKey;
    this.workerBoot = this.spawnWorker(modelKey);
    return this.workerBoot;
  }

  private spawnWorker(modelKey: string): Promise<EmbeddingWorkerPort> {
    const worker = this.createWorkerPort();
    worker.unref(); // 不阻塞应用退出
    this.worker = worker;

    // 身份校验：旧 worker 的 exit/error 事件晚到时（terminate 异步），
    // 不能误杀新 worker 的 pending / 引用
    const isCurrent = () => this.worker === worker;

    worker.on("message", (message: EmbeddingWorkerOutbound) => {
      if (!isCurrent()) return;
      const pending = this.pending.get(message.requestId);
      if (!pending) return;
      this.pending.delete(message.requestId);
      if (message.type === "ready") {
        // init 握手：pending.resolve 以空数组占位，boot promise 里换回 worker
        pending.resolve([]);
      } else if (message.type === "result") {
        const vectors = message.buffers.map((buffer) => new Float32Array(buffer));
        if (vectors.length > 0 && vectors.some((vector) => vector.length !== message.dim)) {
          pending.reject(new Error(`Embedding worker returned inconsistent dims (expected ${message.dim})`));
          return;
        }
        pending.resolve(vectors);
      } else {
        pending.reject(new Error(message.reason));
      }
    });

    worker.on("error", (error: Error) => {
      if (!isCurrent()) return;
      this.failAllPending(error);
      this.resetForRespawn();
    });

    worker.on("exit", (code: number) => {
      if (!isCurrent()) return;
      this.failAllPending(new Error(`Embedding worker exited with code ${code}`));
      this.resetForRespawn();
    });

    const initRequestId = this.nextRequestId++;
    const boot = new Promise<EmbeddingWorkerPort>((resolve, reject) => {
      this.pending.set(initRequestId, {
        resolve: () => resolve(worker),
        reject,
      });
    });
    worker.postMessage({ type: "init", requestId: initRequestId, modelKey });

    return boot.then(
      (resolved) => {
        this.workerBoot = null;
        return resolved;
      },
      (error: Error) => {
        this.resetForRespawn();
        void worker.terminate().catch(() => undefined);
        throw error;
      },
    );
  }

  private failAllPending(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  private resetForRespawn(): void {
    this.worker = null;
    this.workerBoot = null;
    this.modelKey = null;
  }
}

// ── 模块级单例 ──
let sharedClient: EmbeddingWorkerClient | null = null;

export function getEmbeddingWorkerClient(): EmbeddingWorkerClient {
  if (!sharedClient) {
    sharedClient = new EmbeddingWorkerClient();
  }
  return sharedClient;
}

export function disposeEmbeddingWorker(reason = "manual"): void {
  if (sharedClient) {
    sharedClient.dispose(reason);
  }
}

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

export class EmbeddingWorkerClient {
  private worker: EmbeddingWorkerPort | null = null;
  private workerBoot: Promise<EmbeddingWorkerPort> | null = null;
  private modelKey: string | null = null;
  private pending = new Map<number, PendingRequest>();
  private nextRequestId = 1;
  private readonly createWorkerPort: () => EmbeddingWorkerPort;

  constructor(createWorkerPort?: () => EmbeddingWorkerPort) {
    this.createWorkerPort = createWorkerPort ?? (() => new Worker(__filename) as unknown as EmbeddingWorkerPort);
  }

  /**
   * 在 worker 里执行批量 embedding。首次调用懒启动 worker 并加载模型。
   * worker 崩溃时本次调用失败，下次调用自动重启 worker。
   */
  async embedTexts(modelKey: string, texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const worker = await this.ensureActiveWorker(modelKey);

    const requestId = this.nextRequestId++;
    return new Promise<Float32Array[]>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      worker.postMessage({ type: "embed", requestId, texts });
    });
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

  /** 停掉 worker（换模型 / reset provider / 应用退出时调用） */
  dispose(reason: string): void {
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

    worker.on("message", (message: EmbeddingWorkerOutbound) => {
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
      this.failAllPending(error);
      this.resetForRespawn();
    });

    worker.on("exit", (code: number) => {
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

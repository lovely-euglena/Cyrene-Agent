// .NET embedding sidecar 客户端（spawn cyrene-embed serve）。
//
// 激活条件（全部满足才启用，否则调用方回退 embedding-worker）：
//   1. 默认启用（CYRENE_EMBED_SIDECAR=0 关闭；exe 缺失自动回退 worker）
//   2. sidecar exe 存在（见 resolveSidecarPath）
//
// 帧协议见 dotnet/embedding-sidecar/Program.cs：
//   请求 [4B LE 头长][JSON {id,op:"embed",texts,modelDir,modelKey}]
//   响应 [4B LE 头长][JSON {id,ok,count,dim}][float32 LE count×dim×4]
//   就绪 {id:0,op:ready,modelKey,dim}
//
// 第二引擎（IKIH28）：embed/search/doc-import 请求携带可选 modelDir + modelKey
// （缺省 = 启动默认），C# 侧池按 modelDir 路由；rerank 已有 rerankerDir。
// 客户端不再因 modelKey 变化无条件 dispose 重启；对旧 sidecar（无池）用
// 「ready modelKey/dim 不符 + 请求失败/响应维度不符」检测并回退重启一次。
// doc-import 响应无二进制向量、旧 exe 忽略请求 modelDir：发送前必须先确认
// 路由（ready 维度/启动参数），无法确认则重启；仍无法确认 → 失败，不落错向量。
//
// ⚠️ 实现要点（都是复查时踩过的坑）：
//   - 帧解析统一走 SidecarFrameDecoder（sidecar-frame-decoder.ts）：
//     长度前缀在 JSON 头收齐前不得消费；二进制段不完整时保存
//     mid-frame 状态。历史 P0：头被分片时前缀丢失 → 下一轮把
//     `{"id` 误读为长度（bad frame length 1684611707）→ 协议永久失步。
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
import { trackChildProcess } from "../child-processes";
import { DecodedFrame, SidecarFrameDecoder } from "./sidecar-frame-decoder";
import { getProjectModelDir } from "./model-status";
import { getCurrentModelKey, LOCAL_MODELS } from "./embedding-pipeline";

interface SidecarResponse {
  header: Record<string, unknown>;
  vectors: Float32Array[];
}

export interface SidecarSearchRequest {
  ragDataDir: string;
  storeMode?: "sqlite" | "json";
  query: string;
  source?: string;
  topK: number;
  importIds?: string[];
  allowedEntryIds?: string[];
  customWords?: string[];
  vectorWeight?: number;
  bm25Weight?: number;
  updateRecall?: boolean;
}

export interface SidecarSearchEntry {
  id: string;
  text: string;
  source: string;
  weight: number;
  createdAt: number;
  lastRecalledAt: number;
  metadata?: Record<string, unknown> | null;
  score: number;
}

export interface SidecarSearchResponse {
  entries: SidecarSearchEntry[];
  embeddings: Float32Array[];
}

export interface DocImportProgress {
  status: string;
  completedChunks?: number;
  totalChunks?: number;
}

export interface DocImportResponse {
  kind: string;
  name?: string;
  chunks?: number;
  importId?: string | null;
  cached?: boolean;
  text?: string | null;
  reason?: string | null;
  [key: string]: unknown;
}

interface PendingRequest {
  resolve: (response: SidecarResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * 响应维度/模型回显与请求模型不符（旧 sidecar 无池时用错模型计算）。
 * 独立类型用于触发回退重启：旧 exe ready 帧恒报 "bgem3"，不能只靠
 * ready 键判断 possiblyUnrouted（P2-5）。
 */
export class SidecarModelRoutingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SidecarModelRoutingError";
  }
}

/** 模型加载 ready 超时（模型 570MB，慢盘 30s+ 也可能）。 */
const READY_TIMEOUT_MS = 60_000;
/** 单请求超时：基数 + 每条文本加时（native ~200ms/条，留 10x 余量）。 */
const REQUEST_TIMEOUT_BASE_MS = 30_000;
const REQUEST_TIMEOUT_PER_TEXT_MS = 2_000;
/** 文档导入超时（分钟级：读取 + 分块 + 全量 embedding + 落盘）。 */
const DOC_IMPORT_TIMEOUT_MS = 15 * 60_000;

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
  // 帧解析状态机（缓冲队列 + 跨 chunk 状态，见 sidecar-frame-decoder.ts）。
  private decoder = new SidecarFrameDecoder();
  private startup: Promise<void> | null = null;
  private modelKey: string | null = null;
  /** 当前进程 spawn 时传入的模型键（旧 exe 无池：启动参数即实际加载模型）。 */
  private launchedModelKey: string | null = null;
  /** ready 帧回报的实际维度（旧 exe modelKey 失真，但 dim 如实）。 */
  private readyDims: number | null = null;
  private onReadyFrame: ((header: any) => void) | null = null;
  /** doc-import 进度通知路由（op=progress 帧，按 forId）。 */
  private progressHandlers = new Map<number, (progress: DocImportProgress) => void>();
  /** 回退重启互斥（单飞）：同一时刻只有一个「重启 + 重试」在途，并发回退串行，避免后到者 dispose 掉前者刚拉起的新进程（P2-5）。 */
  private restartLock: Promise<void> = Promise.resolve();

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
    const timeoutMs =
      REQUEST_TIMEOUT_BASE_MS + REQUEST_TIMEOUT_PER_TEXT_MS * Math.min(texts.length, 256);
    const expectedDims = LOCAL_MODELS[modelKey]?.dims;
    const response = await this.requestRouted(
      modelKey,
      { op: "embed", texts },
      timeoutMs,
      `texts=${texts.length}`,
      { expectedDims },
    );
    return response.vectors;
  }

  /**
   * rerank（.NET RerankerEngine）：返回与 documents 对齐的原始 logits（越大越相关）。
   * rerankerDir = 完整模型目录（models/bge-reranker-base 或 models/bge-reranker-v2-m3，
   * 由调用方按 mode 解析后显式传入）；sidecar 按 dir 惰性加载/热切换，无需重启进程。
   */
  async rerankScores(
    query: string,
    documents: string[],
    rerankerDir: string,
  ): Promise<number[]> {
    if (documents.length === 0) return [];
    await this.ensureStarted(getCurrentModelKey());
    const timeoutMs =
      REQUEST_TIMEOUT_BASE_MS + REQUEST_TIMEOUT_PER_TEXT_MS * Math.min(documents.length, 256);
    const { vectors } = await this.request(
      { op: "rerank", query, documents, rerankerDir },
      timeoutMs,
      `docs=${documents.length}`,
    );
    // 协议约定 rerank 响应 = count×dim(1)，即每条文档一个标量分数
    return vectors.map((v) => v[0] ?? 0);
  }

  /**
   * 混合检索（.NET）：向量 + BM25 + 融合 + 召回回写全部在 sidecar 执行。
   * 返回条目与对齐的 embedding；失败由调用方回退本地实现。
   */
  async searchHybrid(modelKey: string, payload: SidecarSearchRequest): Promise<SidecarSearchResponse> {
    // 耗时与候选量相关（全库分词 + 扫描）；后续可做 token 缓存优化
    const expectedDims = LOCAL_MODELS[modelKey]?.dims;
    const { header, vectors } = await this.requestRouted(
      modelKey,
      { op: "search", ...payload },
      REQUEST_TIMEOUT_BASE_MS,
      `search="${payload.query.slice(0, 24)}"`,
      { expectedDims },
    );
    const entries = Array.isArray(header.results) ? (header.results as SidecarSearchEntry[]) : [];
    return { entries, embeddings: vectors };
  }

  /**
   * 文档导入（读取/分块/embedding/落盘/缓存全部在 sidecar，分钟级超时）。
   * onProgress 通过 op=progress 通知帧转发；onStarted 供取消桥接使用。
   */
  async docImport(
    modelKey: string,
    payload: { filePath: string; ragDataDir: string; storeMode?: "sqlite" | "json"; pandocPath?: string },
    callbacks: {
      onProgress?: (progress: DocImportProgress) => void;
      onStarted?: (requestId: number) => void;
    } = {},
  ): Promise<DocImportResponse> {
    const startedIds: number[] = [];
    try {
      const expectedDims = LOCAL_MODELS[modelKey]?.dims;
      const { header } = await this.requestRouted(
        modelKey,
        { op: "doc-import", ...payload },
        DOC_IMPORT_TIMEOUT_MS,
        `doc="${payload.filePath.slice(-32)}"`,
        {
          expectedDims,
          // 旧 exe 忽略请求 modelDir 且 doc-import 响应无 dim/modelKey：无法从
          // 响应发现错模型，而错误维度向量一旦落盘无法撤销 → 发送前必须能确认
          // 路由（新 exe 回显 dim/modelKey；旧 exe 用 ready 维度/启动参数确认）。
          requireModelEcho: true,
          onStarted: (id) => {
            startedIds.push(id);
            if (callbacks.onProgress) this.progressHandlers.set(id, callbacks.onProgress);
            callbacks.onStarted?.(id);
          },
        },
      );
      return header as DocImportResponse;
    } finally {
      // 含旧 sidecar 回退重试产生的多个 requestId，全部清理
      for (const id of startedIds) this.progressHandlers.delete(id);
    }
  }

  /** 取消进行中的 doc-import（best-effort 通知帧；sidecar 按批检查取消位）。 */
  cancelDocImport(targetId: number): void {
    try {
      this.writeFrame({ id: this.nextId++, op: "doc-import-cancel", targetId });
    } catch {
      // sidecar 已退出：导入随进程中止
    }
  }

  /**
   * 模型路由请求（embed/search/doc-import 公共路径）：
   *   - 请求携带 modelDir + modelKey，C# 侧池按 modelDir 路由，不再因 modelKey
   *     变化无条件 dispose 重启；
   *   - 旧 sidecar（无池）兼容：当前进程 ready 的 modelKey 与请求不符时，先按
   *     新协议试发；请求失败或返回维度不符（旧进程用错模型静默计算）则回退
   *     重启一次（以请求的 modelDir 重新 spawn）。
   *   - P2-5：维度不符错误同样触发回退（旧 exe ready 键恒报 "bgem3"，实际按
   *     e5-small 启动时 possiblyUnrouted=false，不能只看 ready 键）；回退重启
   *     串行单飞，并发不互杀。
   *   - P1-2：doc-import 等响应无二进制的 op（requireModelEcho）在发送前先
   *     确认路由；无法确认（旧 exe 忽略请求 modelDir）则先重启再发，避免错误
   *     维度向量静默落盘。
   */
  private async requestRouted(
    modelKey: string,
    header: Record<string, unknown>,
    timeoutMs: number,
    label: string,
    opts: {
      expectedDims?: number;
      /** 响应必须能确认路由（doc-import；见 isRoutingConfirmed）。 */
      requireModelEcho?: boolean;
      onStarted?: (id: number) => void;
    } = {},
  ): Promise<SidecarResponse> {
    const modelDir = this.modelDirArg(modelKey);
    const payload = { ...header, modelDir, modelKey };

    await this.ensureStarted(modelKey);
    // 运行中的进程可能是按其他模型启动的（旧 sidecar 无池，无法路由）
    const possiblyUnrouted = this.modelKey !== null && this.modelKey !== modelKey;

    const attempt = async (): Promise<SidecarResponse> => {
      const response = await this.request(payload, timeoutMs, label, opts.onStarted);
      this.assertResponseModel(
        response,
        modelKey,
        opts.expectedDims,
        opts.requireModelEcho === true && this.isRoutingConfirmed(modelKey, opts.expectedDims),
      );
      return response;
    };

    if (opts.requireModelEcho === true && !this.isRoutingConfirmed(modelKey, opts.expectedDims)) {
      console.warn(
        `[EmbeddingSidecar] doc-import for "${modelKey}" is unverifiable on current sidecar ` +
        `(launched "${this.launchedModelKey}", ready "${this.modelKey}", ready dim ${this.readyDims}); restarting first`,
      );
      return this.restartAndRetry(modelKey, async () => {
        // 重启后仍无法确认路由 → 直接失败，不发请求（旧进程会按启动模型写入错误向量）
        if (!this.isRoutingConfirmed(modelKey, opts.expectedDims)) {
          throw new SidecarModelRoutingError(
            `doc-import for "${modelKey}" cannot confirm routing after restart ` +
            `(launched "${this.launchedModelKey}", ready "${this.modelKey}", ready dim ${this.readyDims})`,
          );
        }
        return attempt();
      });
    }

    try {
      return await attempt();
    } catch (error) {
      if (!possiblyUnrouted && !(error instanceof SidecarModelRoutingError)) throw error;
      console.warn(
        `[EmbeddingSidecar] request for "${modelKey}" failed on sidecar ready with "${this.modelKey}" ` +
        `(${error instanceof Error ? error.message : String(error)}); restarting with the requested model`,
      );
      return this.restartAndRetry(modelKey, attempt);
    }
  }

  /**
   * 路由确认（仅 doc-import 等 requireModelEcho 的 op 需要）：
   *   - 本地注册模型维度唯一（bgem3=1024、e5-small=384），ready 帧的 dim 与请求
   *     一致即可确认实际加载的是请求模型（旧 exe modelKey 失真但 dim 如实）；
   *   - 无 ready dim 时退化为「本进程是按请求模型 spawn 的」（旧 exe 启动参数
   *     即实际模型；新 exe 池按请求 modelDir 路由且响应会回显 dim）。
   */
  private isRoutingConfirmed(modelKey: string, expectedDims?: number): boolean {
    if (expectedDims !== undefined && this.readyDims !== null) {
      return this.readyDims === expectedDims;
    }
    return this.launchedModelKey === modelKey;
  }

  /**
   * 回退重启 + 重试（单飞）：并发回退在这里串行化（持锁到重试结束），后到者
   * 不会在重试途中 dispose 掉前者刚拉起的新进程。doc-import 重试可能分钟级，
   * 持锁期间其它回退排队等待——过渡态下正确性优先（初始请求不受影响）。
   */
  private async restartAndRetry<T>(modelKey: string, retry: () => Promise<T>): Promise<T> {
    const previous = this.restartLock;
    let release!: () => void;
    this.restartLock = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      await this.dispose("model-routing-fallback");
      await this.ensureStarted(modelKey);
      return await retry();
    } finally {
      release();
    }
  }

  /**
   * 响应模型校验：header.dim / 向量长度与请求模型的注册维度不一致 = 旧进程算错模型。
   * requireModelEcho 场景（doc-import）在响应无 dim 回显且路由未确认时必须失败，
   * 不能让旧进程按启动模型静默导入错误向量（P1-2）。
   */
  private assertResponseModel(
    response: SidecarResponse,
    modelKey: string,
    expectedDims?: number,
    routingConfirmed = false,
  ): void {
    if (expectedDims === undefined) return;
    const headerDim = response.header.dim;
    if (typeof headerDim === "number" && headerDim > 0 && headerDim !== expectedDims) {
      throw new SidecarModelRoutingError(
        `Embedding sidecar returned ${headerDim}-dim output for "${modelKey}" (expected ${expectedDims})`,
      );
    }
    if (headerDim === undefined && !routingConfirmed) {
      throw new SidecarModelRoutingError(
        `Embedding sidecar response for "${modelKey}" has no dim echo and routing is unconfirmed ` +
        `(old sidecar ignores per-request modelDir)`,
      );
    }
    const headerModelKey = response.header.modelKey;
    if (typeof headerModelKey === "string" && headerModelKey.length > 0 && headerModelKey !== modelKey) {
      throw new SidecarModelRoutingError(
        `Embedding sidecar routed "${modelKey}" to model "${headerModelKey}"`,
      );
    }
    for (const vector of response.vectors) {
      if (vector.length !== expectedDims) {
        throw new SidecarModelRoutingError(
          `Embedding sidecar returned ${vector.length}-dim vectors for "${modelKey}" (expected ${expectedDims})`,
        );
      }
    }
  }

  /** 请求公共路径：超时 + pending 路由（进程生命周期由 ensureStarted 管理）。 */
  private async request(
    header: Record<string, unknown>,
    timeoutMs: number,
    label: string,
    onStarted?: (id: number) => void,
  ): Promise<SidecarResponse> {
    const id = this.nextId++;
    onStarted?.(id);
    return new Promise<SidecarResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        // sidecar 疑似卡死：回收进程（下次调用自动重启），本次走调用方兜底
        void this.dispose("request-timeout");
        reject(new Error(`Embedding sidecar request timeout (${timeoutMs}ms, ${label})`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.writeFrame({ ...header, id });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        throw error;
      }
    });
  }

  /**
   * 懒启动。运行中的进程直接复用（模型路由交给 C# 池；旧协议兼容重启
   * 只发生在 requestRouted 检测到行为不符时）；启动握手进行中则等待完成，
   * 避免在 ready 之前写入请求帧。
   */
  private async ensureStarted(modelKey: string): Promise<void> {
    if (this.startup) {
      await this.startup;
      return;
    }
    if (this.child && this.child.exitCode === null) return;
    this.startup = this.launch(modelKey).finally(() => {
      this.startup = null;
    });
    await this.startup;
  }

  private launch(modelKey: string): Promise<void> {
    this.disposeSync("relaunch");
    // 记录 spawn 参数：旧 exe 无池，启动 modelDir 即实际加载模型
    // （doc-import 发送前路由确认用；新 exe 池另有响应 dim/modelKey 回显）
    this.launchedModelKey = modelKey;

    return new Promise<void>((resolve, reject) => {
      // 第 3 参数 = modelKey（显式启动键，ready 帧回显；旧 exe 忽略多余参数）。
      // 第 4 参数（rerankerDir 默认目录）暂不传：rerank 每次都显式带 dir。
      const child = spawn(this.exePath, ["serve", this.modelDirArg(modelKey), modelKey], {
        stdio: ["pipe", "pipe", "inherit"],
        env: this.buildEnv(),
      });
      this.child = child;
      trackChildProcess(child, "embedding-sidecar");
      this.decoder.reset();

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
        let frames: DecodedFrame[];
        try {
          frames = this.decoder.push(chunk);
        } catch (error) {
          // 协议失序不可恢复：回收进程（下次调用自动重启）
          this.protocolFailure(error instanceof Error ? error.message : String(error));
          return;
        }
        for (const frame of frames) {
          if (this.onReadyFrame) {
            this.onReadyFrame(frame.header);
            continue;
          }
          const header = frame.header as { op?: string; forId?: number };
          if (header.op === "progress" && typeof header.forId === "number") {
            this.progressHandlers.get(header.forId)?.(frame.header as unknown as DocImportProgress);
            continue;
          }
          this.completeResponse(frame.header as any, frame.binary);
        }
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
          // 旧 exe ready 的 modelKey 恒报 "bgem3"，但 dim 如实 → 缓存供路由确认
          this.readyDims = typeof header.dim === "number" && header.dim > 0 ? header.dim : null;
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
    // 模型目录解析统一走 model-status.ts（设置页状态探测 / reranker / 本地兜底同一套）：
    // CYRENE_MODELS_DIR → cwd/models → exe 同级 models → resources/embed-models → …
    // 命中第一个「三个必装文件齐全」的目录；打包态用户把模型放到 exe 同级
    // models/ 也能被侧车识别，不再只认 resources/embed-models。
    const resolved = getProjectModelDir("embedding", modelKey || "bgem3");
    if (!resolved) {
      throw new Error(`Embedding sidecar model dir not found for ${modelKey}`);
    }
    return resolved;
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
      pending.resolve({ header, vectors });
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
    this.launchedModelKey = null;
    this.readyDims = null;
    this.onReadyFrame = null;
    this.decoder.reset();
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

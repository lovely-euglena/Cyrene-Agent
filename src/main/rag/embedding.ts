import { checkEmbeddingModelInstalled } from "./model-status";
import { isMainThread } from "worker_threads";
import {
  DEFAULT_MODEL_KEY,
  LOCAL_MODELS,
  dropLocalPipeline,
  getLocalPipeline,
  getLocalPipelineDiagnostics,
  getCurrentModelKey,
  resetLocalPipelines,
  runBatchedInference,
  setCurrentModelKey,
} from "./embedding-pipeline";
import { disposeEmbeddingWorker, getEmbeddingWorkerClient } from "./embedding-worker";
import { disposeEmbeddingSidecar, getEmbeddingSidecarClient } from "./embedding-sidecar";

// ── 错误类型 ──
export class EmbeddingDimensionMismatchError extends Error {
  constructor(
    public readonly declared: number,
    public readonly actual: number,
    public readonly context: string,
  ) {
    super(`Embedding dimension mismatch: ${context} — declared ${declared}, got ${actual}`);
    this.name = "EmbeddingDimensionMismatchError";
  }
}

export class EmbeddingBatchDimensionInconsistencyError extends Error {
  constructor(
    public readonly expected: number,
    public readonly actual: number,
    public readonly index: number,
  ) {
    super(`Embedding batch inconsistency at index ${index}: expected ${expected} dimensions, got ${actual}`);
    this.name = "EmbeddingBatchDimensionInconsistencyError";
  }
}

// ── 类型 ──
export type EmbeddingProviderIdentity = {
  provider: string;
  model: string;
  dimensions: number;
  endpoint?: string;
};

/**
 * 索引元数据 — 写入向量索引时记录，用于后续一致性校验。
 */
export interface EmbeddingIndexMetadata {
  provider: string;
  model: string;
  dimensions: number;
  cacheIdentity: string;
}

export type EmbeddingWorkerConfig =
  | { provider: "local"; modelKey: string }
  | { provider: "openai-compat"; baseUrl: string; apiKey: string; model: string };

export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  readonly dims: number;
  readonly name: string;
  readonly cacheIdentity?: EmbeddingProviderIdentity;
  readonly workerConfig?: EmbeddingWorkerConfig;
  /** 用户声明的维度（可能为 undefined，表示未配置） */
  readonly declaredDimensions?: number;
  /** 实际探测到的维度（首次 embed 后才有值） */
  readonly resolvedDimensions?: number;
}

// ── 模型注册表 / 本地 pipeline 状态 ──
// LOCAL_MODELS、pipeline 缓存与批量推理辅助已抽到 embedding-pipeline.ts，
// 供本模块与 embedding-worker.ts（专用推理线程）共用。

// ── 本地推理入口 ──
/**
 * 执行 local embedding 推理。
 * - 主进程 + sidecar 启用（CYRENE_EMBED_SIDECAR=1 且 exe 存在）：
 *   走 .NET sidecar（ORT native，~4.3x 提速，数值与 WASM 逐位一致）；
 * - 主进程（sidecar 关闭/不可用）：走专用 embedding worker，
 *   推理不再阻塞主进程事件循环；
 * - 已在 worker 线程（document-index-worker）：直接用本线程 pipeline。
 *
 * sidecar 数值与 transformers.js 逐位一致（verify cosine=1.0），
 * cacheIdentity 保持 "local" 不变，LanceDB 索引零迁移。
 */
async function embedLocal(modelKey: string, texts: string[]): Promise<Float32Array[]> {
  if (isMainThread) {
    const sidecar = getEmbeddingSidecarClient();
    if (sidecar) {
      try {
        return await sidecar.embedTexts(modelKey, texts);
      } catch (error) {
        console.warn(
          "[Embedding] sidecar failed, falling back to worker:",
          error instanceof Error ? error.message : String(error),
        );
        // 兜底走 worker（其自身带 10min 空闲回收，不会双模型常驻）
        const vectors = await getEmbeddingWorkerClient().embedTexts(modelKey, texts);
        // sidecar 恢复期已用 worker 完成本次请求；若 sidecar 下次调用重启
        // 成功，worker 会因空闲超时自动卸载（两套模型不同时常驻 >10min）
        return vectors;
      }
    }
    return getEmbeddingWorkerClient().embedTexts(modelKey, texts);
  }
  const pipe = await getLocalPipeline(modelKey);
  return runBatchedInference(pipe, texts);
}

export function createLocalEmbeddingProvider(modelKey?: string): EmbeddingProvider | null {
  const key = modelKey || DEFAULT_MODEL_KEY;
  const config = LOCAL_MODELS[key];
  if (!config) throw new Error("Unknown embedding model: " + key);

  // 模型缺失返回 null，调用方决定如何处理
  if (!checkEmbeddingModelInstalled(key)) {
    return null;
  }

  return {
    name: "local-" + config.hfName.split("/").pop(),
    dims: config.dims,
    declaredDimensions: config.dims,
    resolvedDimensions: config.dims,
    cacheIdentity: {
      provider: "local",
      model: config.hfName,
      dimensions: config.dims,
    },
    workerConfig: { provider: "local", modelKey: key },

    async embed(text: string): Promise<number[]> {
      const [vector] = await embedLocal(key, [text]);
      return Array.from(vector);
    },

    async embedBatch(texts: string[]): Promise<number[][]> {
      // 真批量推理：一次前向处理整批文本（内部按 token 量切子批次），
      // 不再逐条调 pipeline。
      const vectors = await embedLocal(key, texts);
      return vectors.map((vector) => Array.from(vector));
    },
  };
}

// ── OpenAI 兼容 Provider ──
/**
 * 创建 OpenAI 兼容的 embedding provider。
 *
 * @param baseUrl - API 基础 URL
 * @param apiKey - API 密钥
 * @param model - 模型名称
 * @param declaredDimensions - 用户声明的维度（可选）。
 *   留空时首次 embed 自动探测；填写时与实际响应严格校验。
 */
export function createOpenAIEmbeddingProvider(
  baseUrl: string,
  apiKey: string,
  model = "text-embedding-ada-002",
  declaredDimensions?: number,
): EmbeddingProvider {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");
  const endpoint = normalizedBaseUrl + "/embeddings";

  // 维度状态：可能由用户声明，也可能在首次调用后自动探测
  let resolvedDims: number | undefined = declaredDimensions;
  let resolved = false;

  function getDims(): number {
    if (resolvedDims !== undefined) return resolvedDims;
    throw new Error("Embedding dimensions not yet resolved — call embed() first");
  }

  function validateAndResolveDimensions(embedding: number[], context: string): void {
    const actual = embedding.length;
    if (declaredDimensions !== undefined && declaredDimensions !== actual) {
      throw new EmbeddingDimensionMismatchError(declaredDimensions, actual, context);
    }
    if (!resolved) {
      resolvedDims = actual;
      resolved = true;
    } else if (resolvedDims !== actual) {
      throw new EmbeddingDimensionMismatchError(resolvedDims!, actual, context);
    }
  }

  function validateBatchConsistency(embeddings: number[][]): void {
    if (embeddings.length === 0) return;
    const firstDim = embeddings[0].length;
    for (let i = 1; i < embeddings.length; i++) {
      if (embeddings[i].length !== firstDim) {
        throw new EmbeddingBatchDimensionInconsistencyError(firstDim, embeddings[i].length, i);
      }
    }
  }

  return {
    name: "openai-compat-" + model,

    get dims() {
      return getDims();
    },

    get declaredDimensions() {
      return declaredDimensions;
    },

    get resolvedDimensions() {
      return resolvedDims;
    },

    get cacheIdentity(): EmbeddingProviderIdentity | undefined {
      // 维度未探测前返回 base identity（不含 dimensions）
      // 维度已探测后返回完整 identity
      if (resolvedDims === undefined) return undefined;
      return {
        provider: "openai-compat",
        model,
        dimensions: resolvedDims,
        endpoint: normalizedBaseUrl,
      };
    },

    get workerConfig(): EmbeddingWorkerConfig {
      return {
        provider: "openai-compat",
        baseUrl: normalizedBaseUrl,
        apiKey,
        model,
      };
    },

    async embed(text: string): Promise<number[]> {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + apiKey,
        },
        body: JSON.stringify({ model, input: text }),
      });
      if (!res.ok) {
        throw new Error("Embedding API error: " + res.status + " " + await res.text());
      }
      const data = await res.json() as { data: Array<{ embedding: number[] }> };
      const embedding = data.data[0].embedding;
      validateAndResolveDimensions(embedding, `embed() for model "${model}"`);
      return embedding;
    },

    async embedBatch(texts: string[]): Promise<number[][]> {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + apiKey,
        },
        body: JSON.stringify({ model, input: texts }),
      });
      if (!res.ok) {
        throw new Error("Embedding API error: " + res.status + " " + await res.text());
      }
      const data = await res.json() as { data: Array<{ embedding: number[] }> };
      const embeddings = data.data.map((d) => d.embedding);
      validateBatchConsistency(embeddings);
      for (const emb of embeddings) {
        validateAndResolveDimensions(emb, `embedBatch() for model "${model}"`);
      }
      return embeddings;
    },
  };
}

// ── 自动选择 Provider ──
let cachedProvider: EmbeddingProvider | null = null;

export function getEmbeddingProvider(
  mode: "auto" | "local" | "cloud" = "auto",
  cloudBaseUrl?: string,
  cloudApiKey?: string,
  modelKey?: string,
  cloudDimensions?: number,
): EmbeddingProvider | null {
  if (cachedProvider) return cachedProvider;

  if (mode === "local") {
    cachedProvider = createLocalEmbeddingProvider(modelKey);
  } else if (mode === "cloud" && cloudBaseUrl && cloudApiKey) {
    cachedProvider = createOpenAIEmbeddingProvider(cloudBaseUrl, cloudApiKey, modelKey, cloudDimensions);
  } else {
    // auto 模式：优先 local，local 不存在且 cloud 配置完整时用 cloud，否则 null
    const local = createLocalEmbeddingProvider(modelKey);
    if (local) {
      cachedProvider = local;
    } else if (cloudBaseUrl && cloudApiKey) {
      cachedProvider = createOpenAIEmbeddingProvider(cloudBaseUrl, cloudApiKey, modelKey, cloudDimensions);
    } else {
      cachedProvider = null;
    }
  }

  return cachedProvider;
}

/**
 * 获取当前 embedding provider 的 identity。
 * 注意：对于 cloud provider 且未声明维度的情况，需要先调用 embed() 解析维度。
 * 此函数要求 provider 的维度已解析（resolvedDimensions !== undefined）。
 */
export async function getEmbeddingProviderIdentity(): Promise<EmbeddingProviderIdentity> {
  const provider = getEmbeddingProvider();
  if (!provider) throw new Error("Embedding provider is not available");

  if (provider.cacheIdentity) return provider.cacheIdentity;

  // 对于 local provider，dims 始终已知
  const localModel = Object.values(LOCAL_MODELS).find(
    (model) => provider.name === "local-" + model.hfName.split("/").pop(),
  );
  if (localModel) {
    return {
      provider: "local",
      model: localModel.hfName,
      dimensions: provider.dims,
    };
  }

  // cloud provider：如果维度已解析，返回 identity
  const cloudModelPrefix = "openai-compat-";
  if (provider.name.startsWith(cloudModelPrefix)) {
    const dims = provider.resolvedDimensions ?? provider.declaredDimensions;
    if (dims === undefined) {
      throw new Error(
        "Embedding dimensions not yet resolved for cloud provider. " +
        "Call embed() first, or declare dimensions in settings."
      );
    }
    return {
      provider: "openai-compat",
      model: provider.name.slice(cloudModelPrefix.length),
      dimensions: dims,
    };
  }

  const dims = provider.resolvedDimensions ?? provider.declaredDimensions;
  if (dims === undefined) {
    throw new Error("Embedding dimensions not yet resolved for provider: " + provider.name);
  }
  return {
    provider: provider.name,
    model: provider.name,
    dimensions: dims,
  };
}

export function getEmbeddingWorkerConfig(): EmbeddingWorkerConfig {
  const provider = getEmbeddingProvider();
  if (!provider) throw new Error("Embedding provider is not available");
  if (provider.workerConfig) return provider.workerConfig;
  return { provider: "local", modelKey: getCurrentModelKey() };
}

export { getCurrentModelKey };

export function getCurrentModelDims(): number {
  const config = LOCAL_MODELS[getCurrentModelKey()];
  return config ? config.dims : 1024;
}

export function switchEmbeddingModel(modelKey: string): void {
  if (modelKey !== "bgem3") {
    console.warn(`[Embedding] ignoring model switch to "${modelKey}" — bge-m3 is the only supported model`);
    return;
  }
  cachedProvider = null;
  dropLocalPipeline(getCurrentModelKey());
  setCurrentModelKey(modelKey);
}

export function resetEmbeddingProvider(): void {
  cachedProvider = null;
  resetLocalPipelines();
  setCurrentModelKey(DEFAULT_MODEL_KEY);
  // 连同 embedding worker / sidecar 一起回收（下次 embed 时懒重启）
  disposeEmbeddingWorker("resetEmbeddingProvider");
  void disposeEmbeddingSidecar("resetEmbeddingProvider");
}

export function getEmbeddingDiagnostics(): {
  currentModelKey: string;
  cachedPipelineKeys: string[];
  loadingPipelineKeys: string[];
  localPipelineInitCount: number;
  embeddingWorker: { workerRunning: boolean; modelKey: string | null; pendingRequests: number };
} {
  const pipeline = getLocalPipelineDiagnostics();
  return {
    currentModelKey: getCurrentModelKey(),
    cachedPipelineKeys: pipeline.cachedPipelineKeys,
    loadingPipelineKeys: pipeline.loadingPipelineKeys,
    localPipelineInitCount: pipeline.localPipelineInitCount,
    embeddingWorker: getEmbeddingWorkerClient().getWorkerDiagnostics(),
  };
}

// ── 场景识别专用 provider（固定 bge-m3，不受 RAG 模型切换影响）──
let sceneProvider: EmbeddingProvider | null = null;

/**
 * 获取场景识别专用的 embedding provider（固定 bge-m3）。
 * 和文档/记忆的 provider 独立——RAG 切换模型不影响场景识别。
 * 模型不存在时返回 null。
 */
export function getSceneEmbeddingProvider(): EmbeddingProvider | null {
  if (!sceneProvider) {
    sceneProvider = createLocalEmbeddingProvider("bgem3");
  }
  return sceneProvider;
}

export { checkEmbeddingModelInstalled };

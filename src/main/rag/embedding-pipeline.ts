// Local embedding pipeline registry — shared by in-thread users (document
// index worker already runs inside its own worker thread) and the dedicated
// embedding worker (embedding-worker.ts).
//
// Extracted from embedding.ts so the worker entry can load pipelines without
// importing provider management (avoids circular imports).

import * as path from "path";
import * as os from "os";
import { getProjectModelBaseDir } from "./model-status";

// ── 模型注册表 ──
export interface ModelConfig {
  key: string;
  hfName: string;
  dims: number;
}

export const LOCAL_MODELS: Record<string, ModelConfig> = {
  bgem3: { key: "bgem3", hfName: "Xenova/bge-m3", dims: 1024 },
};

export const DEFAULT_MODEL_KEY = "bgem3";

// ── 本地 Pipeline ──
// bge-m3 是唯一的 embedding 模型，同时服务于 RAG 记忆/文档检索和场景识别
const localPipelines: Map<string, any> = new Map();
const localPipelineLoads: Map<string, Promise<any>> = new Map();
let currentModelKey: string = DEFAULT_MODEL_KEY;
let localPipelineInitCount = 0;

// @xenova/transformers is ESM-only, use dynamic import in CJS context
const importEsm = new Function("moduleName", "return import(moduleName)") as (moduleName: string) => Promise<any>;

export function getCurrentModelKey(): string {
  return currentModelKey;
}

export function setCurrentModelKey(modelKey: string): void {
  currentModelKey = modelKey;
}

export function dropLocalPipeline(modelKey: string): void {
  localPipelines.delete(modelKey);
  localPipelineLoads.delete(modelKey);
}

export function resetLocalPipelines(): void {
  localPipelines.clear();
  localPipelineLoads.clear();
  localPipelineInitCount = 0;
}

export async function getLocalPipeline(modelKey?: string): Promise<any> {
  const key = modelKey || currentModelKey;
  const config = LOCAL_MODELS[key];
  if (!config) throw new Error("Unknown embedding model: " + key);

  const cached = localPipelines.get(key);
  if (cached) return cached;
  const loading = localPipelineLoads.get(key);
  if (loading) return loading;

  const load = (async () => {
    localPipelineInitCount += 1;
    const { pipeline, env } = await importEsm("@xenova/transformers");
    env.allowLocalModels = true;
    env.allowRemoteModels = false;
    env.useBrowserCache = false;
    // 主路径：项目根 models/（用户实际放模型的地方）。
    // 兜底：HF cache，通过 cache_dir 选项传给 pipeline。
    // transformers 内部会按 (localModelPath, cache_dir) 顺序查找文件。
    const modelBaseDir = getProjectModelBaseDir("embedding", key);
    if (!modelBaseDir) throw new Error(`Local embedding model "${key}" is not installed`);
    env.localModelPath = modelBaseDir;
    const pipe = await pipeline("feature-extraction", config.hfName, {
      cache_dir: path.join(os.homedir(), ".cache", "huggingface"),
    });
    localPipelines.set(key, pipe);
    return pipe;
  })();
  localPipelineLoads.set(key, load);
  try {
    return await load;
  } finally {
    localPipelineLoads.delete(key);
  }
}

export function getLocalPipelineDiagnostics(): {
  cachedPipelineKeys: string[];
  loadingPipelineKeys: string[];
  localPipelineInitCount: number;
} {
  return {
    cachedPipelineKeys: Array.from(localPipelines.keys()),
    loadingPipelineKeys: Array.from(localPipelineLoads.keys()),
    localPipelineInitCount,
  };
}

// ── 批量推理 ──
/**
 * 单次前向允许的最大文本数 / 最大总字符数。
 * batch 越大吞吐越高，但 WASM 堆内存随 batch × token 数膨胀，
 * 这两个上限用于防止长文档批量推理时 OOM。
 */
export const MAX_INFERENCE_BATCH_TEXTS = 8;
export const MAX_INFERENCE_BATCH_CHARS = 6000;

/**
 * 对 transformers.js pipeline 做真正的批量推理。
 *
 * feature-extraction pipeline 接受 string[] 输入，一次前向处理整批文本
 * （tokenizer 内部做 batch padding，mean pooling 基于 attention mask
 * 屏蔽 padding 位），比逐条推理少 (N-1) 次前向开销，快数倍。
 *
 * 返回值与输入等长的 Float32Array 列表（每项为归一化后的向量）。
 * 超过 MAX_INFERENCE_BATCH_TEXTS / MAX_INFERENCE_BATCH_CHARS 时自动切子批次。
 */
export async function runBatchedInference(pipe: any, texts: string[]): Promise<Float32Array[]> {
  if (texts.length === 0) return [];

  const out: Float32Array[] = [];
  let batch: string[] = [];
  let batchChars = 0;

  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    const result: any = await pipe(batch, { pooling: "mean", normalize: true });
    // 归一化后的输出 Tensor：dims = [batch.length, embeddingDim]
    const dims: number[] = result.dims as number[];
    const dim = dims[dims.length - 1];
    const count = batch.length;
    const data = result.data as Float32Array;
    if (typeof dim !== "number" || data.length !== count * dim) {
      throw new Error(
        `Embedding batch tensor shape mismatch: expected ${count}x${dim}, got data length ${data.length}`,
      );
    }
    for (let i = 0; i < count; i++) {
      // subarray 是视图，new Float32Array(view) 拷贝出独立 buffer，
      // 后续才可安全跨 postMessage 传输
      out.push(new Float32Array(data.subarray(i * dim, (i + 1) * dim)));
    }
    batch = [];
    batchChars = 0;
  };

  for (const text of texts) {
    if (
      batch.length > 0 &&
      (batch.length >= MAX_INFERENCE_BATCH_TEXTS || batchChars + text.length > MAX_INFERENCE_BATCH_CHARS)
    ) {
      await flush();
    }
    batch.push(text);
    batchChars += text.length;
  }
  await flush();

  return out;
}

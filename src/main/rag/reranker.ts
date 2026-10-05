// Reranker module — cross-encoder reranking for RAG
// 支持两个模型（IKIH28 第二引擎）：
//   standard = bge-reranker-base（models/bge-reranker-base）
//   v2-m3    = bge-reranker-v2-m3（models/bge-reranker-v2-m3；源仓库
//              onnx-community/bge-reranker-v2-m3-ONNX）
//
// 引擎优先级（RAG 后端迁移 .NET 的第一步）：
//   1. .NET sidecar rerank op（ORT native，原始 logits，逐条前向；按 rerankerDir 热切换）
//   2. transformers.js 本地兜底（sidecar 不可用时）
//
// v2-m3 未安装 → initReranker 自动降级 none（沿用现有降级语义）。
//
// ⚠️ 历史 bug（已修）：原实现把 [[query, doc], ...] 直接喂 text-classification
// pipeline —— v2 tokenizer 不支持元组输入（`text.split is not a function`），
// 被 retriever 捕获后静默降级；且 num_labels=1 时 pipeline 的 softmax 让
// 分数恒为 1。正确姿势是 tokenizer(docs, { text_pair }) + model() 读原始 logits。
import * as path from "path";
import * as os from "os";
import { getProjectModelBaseDir, getProjectModelDir } from "./model-status";
import { getEmbeddingSidecarClient, isSidecarEnabled } from "./embedding-sidecar";

// ── Types ──
export type RerankerMode = "standard" | "v2-m3" | "none";
export type RerankerModelKey = Exclude<RerankerMode, "none">;

export interface RerankerProvider {
  rerank(query: string, documents: string[]): Promise<Array<{ text: string; score: number }>>;
  readonly name: string;
}

/** 展示/日志名。 */
const RERANKER_MODEL_NAMES: Record<RerankerModelKey, string> = {
  standard: "bge-reranker-base",
  "v2-m3": "bge-reranker-v2-m3",
};

/**
 * transformers.js pipeline 的 model id（相对 localModelPath 的解析路径）：
 *   - standard 落点是 models/bge-reranker-base（bare，历史布局）
 *   - v2-m3 落点是 models/bge-reranker-v2-m3（bare 布局；源仓库
 *     onnx-community/bge-reranker-v2-m3-ONNX，与 model-status 探测 /
 *     C# 下载器 SubDir 一致）
 */
const RERANKER_PIPELINE_IDS: Record<RerankerModelKey, string> = {
  standard: "bge-reranker-base",
  "v2-m3": "bge-reranker-v2-m3",
};

// ── ESM import helper (same pattern as embedding.ts) ──
const importEsm = new Function("moduleName", "return import(moduleName)") as (moduleName: string) => Promise<any>;

// ── transformers.js 兜底 pipeline（惰性加载；sidecar 可用时不加载；按模型分别缓存） ──
const jsPipelines = new Map<RerankerModelKey, any>();

async function getJsPipeline(modeKey: RerankerModelKey): Promise<any> {
  const cached = jsPipelines.get(modeKey);
  if (cached) return cached;

  const { pipeline, env } = await importEsm("@xenova/transformers");
  const originalPath = env.localModelPath;
  const modelsDir = getProjectModelBaseDir("reranker", modeKey);
  if (!modelsDir) throw new Error("Local reranker model is not installed");
  env.localModelPath = modelsDir;
  env.allowLocalModels = true;
  env.allowRemoteModels = false;
  env.useBrowserCache = false;

  try {
    const pipe = await pipeline("text-classification", RERANKER_PIPELINE_IDS[modeKey], {
      quantized: true,
      cache_dir: path.join(os.homedir(), ".cache", "huggingface"),
    });
    jsPipelines.set(modeKey, pipe);
    console.log(`[Reranker] transformers.js pipeline loaded (${modeKey}, fallback path)`);
    return pipe;
  } finally {
    env.localModelPath = originalPath;
  }
}

/** JS 兜底打分：tokenizer 句对编码 + 原始 logits（不做 softmax）。 */
async function jsRerank(
  modeKey: RerankerModelKey,
  query: string,
  documents: string[],
): Promise<Array<{ text: string; score: number }>> {
  const pipe = await getJsPipeline(modeKey);
  const inputs = pipe.tokenizer(
    documents.map(() => query),
    { text_pair: documents, padding: true, truncation: true },
  );
  const { logits } = await pipe.model(inputs);
  const scores = Array.from(logits.data as Float32Array);
  return documents.map((text, i) => ({ text, score: scores[i] ?? 0 }));
}

// ── Reranker provider（按 mode 选目录） ──
export async function createReranker(modeKey: RerankerModelKey): Promise<RerankerProvider> {
  const sidecar = isSidecarEnabled() ? getEmbeddingSidecarClient() : null;
  const rerankerDir = getProjectModelDir("reranker", modeKey);
  const name = RERANKER_MODEL_NAMES[modeKey];
  if (sidecar && rerankerDir) {
    console.log(`[Reranker] ${modeKey} backend: .NET sidecar (${rerankerDir})`);
  } else {
    console.log(`[Reranker] ${modeKey} backend: transformers.js (sidecar unavailable)`);
  }

  return {
    name,

    async rerank(query: string, documents: string[]): Promise<Array<{ text: string; score: number }>> {
      if (documents.length === 0) return [];

      const start = Date.now();
      let engine = "transformers.js";
      let results: Array<{ text: string; score: number }>;

      if (sidecar && rerankerDir) {
        try {
          const scores = await sidecar.rerankScores(query, documents, rerankerDir);
          results = documents.map((text, i) => ({ text, score: scores[i] ?? 0 }));
          engine = "dotnet";
        } catch (error) {
          console.warn(`[Reranker] sidecar rerank (${modeKey}) failed, falling back to transformers.js:`, error);
          results = await jsRerank(modeKey, query, documents);
        }
      } else {
        results = await jsRerank(modeKey, query, documents);
      }

      results.sort((a, b) => b.score - a.score);
      console.log(`[Reranker] ${name}: ${documents.length} docs reranked in ${Date.now() - start}ms (${engine})`);
      return results;
    },
  };
}

/** 兼容旧调用名（等价于 createReranker("standard")）。 */
export async function createStandardReranker(): Promise<RerankerProvider> {
  return createReranker("standard");
}

// ── Reranker manager ──
let currentReranker: RerankerProvider | null = null;
let currentRerankerMode: RerankerMode = "none";

function checkRerankerModelInstalled(modeKey: RerankerModelKey): boolean {
  return getProjectModelBaseDir("reranker", modeKey) !== null;
}

export function getRerankerInstallStatus(): { standard: boolean; "v2-m3": boolean } {
  return {
    standard: checkRerankerModelInstalled("standard"),
    "v2-m3": checkRerankerModelInstalled("v2-m3"),
  };
}

export async function initReranker(mode: RerankerMode): Promise<void> {
  currentRerankerMode = mode;

  if (mode === "none") {
    currentReranker = null;
    console.log("[Reranker] disabled");
    return;
  }

  if (!checkRerankerModelInstalled(mode)) {
    console.warn(`[Reranker] ${RERANKER_MODEL_NAMES[mode]} 未找到，自动降级为 none。`);
    currentRerankerMode = "none";
    currentReranker = null;
    return;
  }

  console.log(`[Reranker] initializing ${mode} mode (${RERANKER_MODEL_NAMES[mode]})...`);
  currentReranker = await createReranker(mode);
  console.log(`[Reranker] ${mode} mode ready: ${currentReranker.name}`);
}

export function getReranker(): RerankerProvider | null {
  return currentReranker;
}

export function getRerankerMode(): RerankerMode {
  return currentRerankerMode;
}

export function resetReranker(): void {
  currentReranker = null;
  currentRerankerMode = "none";
  jsPipelines.clear();
}

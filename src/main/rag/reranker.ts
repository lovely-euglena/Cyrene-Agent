// Reranker module — cross-encoder reranking for RAG
// 只支持 bge-reranker-base，不再提供 light 版本
//
// 引擎优先级（RAG 后端迁移 .NET 的第一步）：
//   1. .NET sidecar rerank op（ORT native，原始 logits，逐条前向）
//   2. transformers.js 本地兜底（sidecar 不可用时）
//
// ⚠️ 历史 bug（已修）：原实现把 [[query, doc], ...] 直接喂 text-classification
// pipeline —— v2 tokenizer 不支持元组输入（`text.split is not a function`），
// 被 retriever 捕获后静默降级；且 num_labels=1 时 pipeline 的 softmax 让
// 分数恒为 1。正确姿势是 tokenizer(docs, { text_pair }) + model() 读原始 logits。
import * as path from "path";
import * as os from "os";
import { getProjectModelBaseDir, getProjectModelDir } from "./model-status";
import { getEmbeddingSidecarClient, isSidecarEnabled } from "./embedding-sidecar";
import { DEFAULT_MODEL_KEY } from "./embedding-pipeline";

// ── Types ──
export interface RerankerProvider {
  rerank(query: string, documents: string[]): Promise<Array<{ text: string; score: number }>>;
  readonly name: string;
}

// ── ESM import helper (same pattern as embedding.ts) ──
const importEsm = new Function("moduleName", "return import(moduleName)") as (moduleName: string) => Promise<any>;

// ── transformers.js 兜底 pipeline（惰性加载；sidecar 可用时不加载） ──
let jsPipeline: any = null;

async function getJsPipeline(): Promise<any> {
  if (jsPipeline) return jsPipeline;

  const { pipeline, env } = await importEsm("@xenova/transformers");
  const originalPath = env.localModelPath;
  const modelsDir = getProjectModelBaseDir("reranker", "standard");
  if (!modelsDir) throw new Error("Local reranker model is not installed");
  env.localModelPath = modelsDir;
  env.allowLocalModels = true;
  env.allowRemoteModels = false;
  env.useBrowserCache = false;

  try {
    jsPipeline = await pipeline("text-classification", "bge-reranker-base", {
      quantized: true,
      cache_dir: path.join(os.homedir(), ".cache", "huggingface"),
    });
    console.log(`[Reranker] transformers.js pipeline loaded (fallback path)`);
    return jsPipeline;
  } finally {
    env.localModelPath = originalPath;
  }
}

/** JS 兜底打分：tokenizer 句对编码 + 原始 logits（不做 softmax）。 */
async function jsRerank(
  query: string,
  documents: string[],
): Promise<Array<{ text: string; score: number }>> {
  const pipe = await getJsPipeline();
  const inputs = pipe.tokenizer(
    documents.map(() => query),
    { text_pair: documents, padding: true, truncation: true },
  );
  const { logits } = await pipe.model(inputs);
  const scores = Array.from(logits.data as Float32Array);
  return documents.map((text, i) => ({ text, score: scores[i] ?? 0 }));
}

// ── Standard reranker (bge-reranker-base) ──
export async function createStandardReranker(): Promise<RerankerProvider> {
  const sidecar = isSidecarEnabled() ? getEmbeddingSidecarClient() : null;
  const rerankerDir = getProjectModelDir("reranker", "standard");
  if (sidecar && rerankerDir) {
    console.log(`[Reranker] standard backend: .NET sidecar (${rerankerDir})`);
  } else {
    console.log("[Reranker] standard backend: transformers.js (sidecar unavailable)");
  }

  return {
    name: "bge-reranker-base",

    async rerank(query: string, documents: string[]): Promise<Array<{ text: string; score: number }>> {
      if (documents.length === 0) return [];

      const start = Date.now();
      let engine = "transformers.js";
      let results: Array<{ text: string; score: number }>;

      if (sidecar && rerankerDir) {
        try {
          const scores = await sidecar.rerankScores(DEFAULT_MODEL_KEY, query, documents, rerankerDir);
          results = documents.map((text, i) => ({ text, score: scores[i] ?? 0 }));
          engine = "dotnet";
        } catch (error) {
          console.warn("[Reranker] sidecar rerank failed, falling back to transformers.js:", error);
          results = await jsRerank(query, documents);
        }
      } else {
        results = await jsRerank(query, documents);
      }

      results.sort((a, b) => b.score - a.score);
      console.log(`[Reranker] standard: ${documents.length} docs reranked in ${Date.now() - start}ms (${engine})`);
      return results;
    },
  };
}

// ── Reranker manager ──
let currentReranker: RerankerProvider | null = null;
let currentRerankerMode: "standard" | "none" = "none";

function checkRerankerModelInstalled(): boolean {
  return getProjectModelBaseDir("reranker", "standard") !== null;
}

export function getRerankerInstallStatus(): { standard: boolean } {
  return { standard: checkRerankerModelInstalled() };
}

export async function initReranker(mode: "standard" | "none"): Promise<void> {
  currentRerankerMode = mode;

  if (mode === "none") {
    currentReranker = null;
    console.log("[Reranker] disabled");
    return;
  }

  if (!checkRerankerModelInstalled()) {
    console.warn(`[Reranker] bge-reranker-base 未找到 (models/bge-reranker-base/onnx/model_quantized.onnx)，自动降级为 none。`);
    currentRerankerMode = "none";
    currentReranker = null;
    return;
  }

  console.log("[Reranker] initializing standard mode (bge-reranker-base)...");
  currentReranker = await createStandardReranker();
  console.log(`[Reranker] standard mode ready: ${currentReranker.name}`);
}

export function getReranker(): RerankerProvider | null {
  return currentReranker;
}

export function getRerankerMode(): "standard" | "none" {
  return currentRerankerMode;
}

export function resetReranker(): void {
  currentReranker = null;
  currentRerankerMode = "none";
  jsPipeline = null;
}

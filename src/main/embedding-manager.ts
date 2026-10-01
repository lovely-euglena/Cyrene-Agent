import * as path from "path";
import { hfModelCacheDir } from "./cache-dir";
import { getProjectModelsDirCandidates } from "./rag/model-status";
import * as fs from "fs";

// --- Model definitions ---

interface ModelInfo {
  key: string;
  name: string;
  dir: string;
  onnx: string;
}

const MODELS: ModelInfo[] = [
  { key: "bgem3", name: "Xenova/bge-m3", dir: "Xenova/bge-m3", onnx: "onnx/model_quantized.onnx" },
];

function getCacheDir(): string {
  return hfModelCacheDir();
}

// --- Status check ---

export function getEmbeddingStatus(): Record<string, { installed: boolean; sizeBytes: number }> {
  const cacheDir = getCacheDir();
  const result: Record<string, { installed: boolean; sizeBytes: number }> = {};
  for (const m of MODELS) {
    const onnxPath = path.join(cacheDir, m.dir, m.onnx);
    const installed = fs.existsSync(onnxPath);
    let sizeBytes = 0;
    if (installed) {
      try { sizeBytes = fs.statSync(onnxPath).size; } catch {}
    }
    result[m.key] = { installed, sizeBytes };
  }
  return result;
}

// --- Download ---

export async function downloadEmbeddingModel(
  modelKey: string,
  mirror: string,
  onProgress: (info: { model: string; file: string; progress: number; status: string }) => void
): Promise<void> {
  const model = MODELS.find((m) => m.key === modelKey);
  if (!model) throw new Error("Unknown model: " + modelKey);

  // Dynamic import ESM module
  const importEsm = new Function("moduleName", "return import(moduleName)") as (moduleName: string) => Promise<any>;
  const { pipeline, env } = await importEsm("@xenova/transformers");

  if (mirror === "hf-mirror") {
    env.remoteHost = "https://hf-mirror.com";
  }
  env.cacheDir = getCacheDir();
  env.allowLocalModels = false;

  await pipeline("feature-extraction", model.name, {
    progress_callback: (p: any) => {
      onProgress({
        model: modelKey,
        file: p.file || "",
        progress: p.progress || 0,
        status: p.status || "downloading",
      });
    },
  });
}

// --- Delete ---

/**
 * 删除已安装的 embedding 模型。
 *
 * 模型有两个落点（探测顺序见 rag/model-status.ts）：
 *   1. 项目侧手动安装：<候选根目录>/Xenova/bge-m3（状态页「已安装」的常规来源）
 *   2. HF 缓存兜底：hfModelCacheDir()/Xenova/bge-m3（旧下载器 / transformers.js 落点）
 *
 * 两处都清，并把实际删除的路径返回给调用方（日志/提示用）。
 */
export function deleteEmbeddingModel(modelKey: string): string[] {
  const model = MODELS.find((m) => m.key === modelKey);
  if (!model) throw new Error("Unknown model: " + modelKey);

  const removed: string[] = [];
  const removeDir = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    fs.rmSync(dir, { recursive: true, force: true });
    removed.push(dir);
  };

  // 1) 项目侧：每个候选根目录都可能有安装
  //    （CYRENE_MODELS_DIR / cwd / exe 同级 / resources/embed-models …）
  for (const baseDir of getProjectModelsDirCandidates()) {
    removeDir(path.join(baseDir, model.dir));
  }
  // 2) HF 缓存兜底
  removeDir(path.join(getCacheDir(), model.dir));

  return removed;
}
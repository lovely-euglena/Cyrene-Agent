// Model installation status detection
// Provides unified model availability checks for embedding and reranker models.

import * as path from "path";
import { hfModelCacheDir } from "../cache-dir";
import * as fs from "fs";
import * as os from "os";
import { app } from "electron";

const HF_CACHE_DIR = path.join(hfModelCacheDir(), "Xenova");

export interface ModelInstallStatus {
  embedding: { bgem3: boolean; "e5-small": boolean };
  reranker: { standard: boolean; "v2-m3": boolean };
}

// All models require these files to be considered "installed".
// 仅检查存在性（不校验大小）：大小达标由下载窗/安装脚本的 MinBytes 口径保证，
// 见 docs/local-models.md 第 2 节与 ModelDownloadSpecs。
const REQUIRED_FILES = ["tokenizer.json", "config.json", "onnx/model_quantized.onnx"];

// Possible sub-paths for each model.
//
// IMPORTANT: sub-paths are baseDir-specific.
//   - Project baseDirs (`<root>/models`) expect the **canonical Xenova layout**
//     that transformers.js itself appends at load time:
//     `pipeline("feature-extraction", "Xenova/bge-m3")` resolves to
//     `<localModelPath>/Xenova/bge-m3/tokenizer.json`. So on the project side
//     the canonical layout is `models/Xenova/bge-m3/`, NOT `models/bge-m3/`.
//   - HF cache baseDir (`~/.cache/huggingface/Xenova`) already ends with the
//     `Xenova/` segment that huggingface-cli writes. The canonical model
//     sub-dir there is therefore just `bge-m3/` (not `Xenova/bge-m3/`).
//
// PROJECT_SUB_PATHS layout:
//   models/Xenova/bge-m3/                     ← bgem3
//   models/Xenova/multilingual-e5-small/      ← e5-small
//   models/bge-reranker-base/                 ← reranker-standard
//   models/bge-reranker-v2-m3/                ← reranker-v2-m3
//
// HF_CACHE_SUB_PATHS layout (~/.cache/huggingface/Xenova/):
//   bge-m3/                                   ← bgem3
//   multilingual-e5-small/                    ← e5-small
//   （reranker-v2-m3 源为 onnx-community/*，HF 缓存不在 Xenova/ 下——
//     由应用内下载器装到项目目录，无 HF 缓存兜底）
const PROJECT_SUB_PATHS: Record<string, string[]> = {
  "embedding-bgem3": ["Xenova/bge-m3"],
  "embedding-e5-small": ["Xenova/multilingual-e5-small"],
  "reranker-standard": ["bge-reranker-base"],
  "reranker-v2-m3": ["bge-reranker-v2-m3"],
};

const HF_CACHE_SUB_PATHS: Record<string, string[]> = {
  "embedding-bgem3": ["bge-m3"],
  "embedding-e5-small": ["multilingual-e5-small"],
};

/**
 * (kind, modelKey) → 探测用 modelId。modelKey 必须命中注册表，
 * 否则返回 null（未知 key 不再静默回落到 bgem3/standard）。
 */
function resolveModelId(kind: "embedding" | "reranker", modelKey: string): string | null {
  const modelId = `${kind}-${modelKey}`;
  return Object.prototype.hasOwnProperty.call(PROJECT_SUB_PATHS, modelId) ? modelId : null;
}

/** Result of probing one (baseDir, subPath) candidate. */
interface CandidateCheck {
  /** Absolute path to the candidate model directory. */
  modelDir: string;
  /** Required files that are missing in this candidate. Empty = fully installed. */
  missingFiles: string[];
}

/**
 * Probe a single baseDir + modelId for a fully-installed model.
 * Returns every candidate under baseDir (for diagnostics) plus whether at
 * least one candidate is complete.
 */
function probeCandidates(
  modelId: string,
  baseDir: string,
  subPathsLookup: Record<string, string[]>,
): {
  installed: boolean;
  candidates: CandidateCheck[];
} {
  const subPaths = subPathsLookup[modelId] ?? [];
  const candidates: CandidateCheck[] = subPaths.map((subPath) => {
    const modelDir = path.join(baseDir, subPath);
    const missingFiles = REQUIRED_FILES.filter((file) => !fs.existsSync(path.join(modelDir, file)));
    return { modelDir, missingFiles };
  });
  const installed = candidates.some((c) => c.missingFiles.length === 0);
  return { installed, candidates };
}

/**
 * Resolve all candidate base directories in priority order.
 *
 * 开发态（app.isPackaged=false）：
 *   1. CYRENE_MODELS_DIR env var (highest — explicit override)
 *   2. process.cwd() + "models"  (npm run dev / electron . 从仓库根启动)
 *   3. directory beside the executable + "models"
 *   4. app.getAppPath() + "models"
 *   5. process.resourcesPath + "models"
 *   6. process.resourcesPath + "embed-models"  (自定义打包 extraResources 映射)
 *
 * 打包态（app.isPackaged=true）：cwd 不可靠（快捷方式/命令行启动时可能是
 * 任意目录），因此把「exe 同级 models/」（用户手动放置模型的落点）提到最前，
 * embed-models（自定义内嵌模型的约定目录，与 .NET 侧车一致）次之。
 *
 * Why this matters: the previous implementation used
 * `path.join(__dirname, "..", "..", "..", "models")` — but the compiled
 * file lives at `dist/main/main/rag/model-status.js`, so `__dirname`
 * points there and ".."×3 lands at `dist/models` (always wrong).
 * In packaged builds `process.resourcesPath` is the asar dir, which
 * is read-only and not where users drop models.
 */
export function getProjectModelsDirCandidates(): string[] {
  const out: string[] = [];
  const push = (dir: string | null | undefined): void => {
    if (dir && !out.includes(dir)) out.push(dir);
  };

  const cwdModels = path.join(process.cwd(), "models");
  const executableModels = path.join(path.dirname(process.execPath), "models");
  const resourcesModels = process.resourcesPath
    ? path.join(process.resourcesPath, "models")
    : null;
  // 侧车/.NET 侧的约定目录：resources/embed-models/Xenova/bge-m3
  // （自定义构建可用 electron-builder extraResources 把模型映射到这里）
  const resourcesEmbedModels = process.resourcesPath
    ? path.join(process.resourcesPath, "embed-models")
    : null;
  let appModels: string | null = null;
  try {
    appModels = path.join(app.getAppPath(), "models");
  } catch {
    // app not ready yet — fall through
  }

  let packaged = false;
  try {
    packaged = app.isPackaged === true;
  } catch {
    // app not ready yet — default to development ordering
  }

  push(process.env.CYRENE_MODELS_DIR);
  if (packaged) {
    push(executableModels);
    push(resourcesEmbedModels);
    push(resourcesModels);
    push(appModels);
    push(cwdModels);
  } else {
    push(cwdModels);
    push(executableModels);
    push(appModels);
    push(resourcesModels);
    push(resourcesEmbedModels);
  }
  return out;
}

/** Primary project-models directory (highest-priority candidate). */
export function getProjectModelsDir(): string {
  return getProjectModelsDirCandidates()[0];
}

/**
 * Resolve the base directory containing a complete local model. This is the
 * same probe used by the settings status UI, so a displayed installed model
 * and the runtime loader can never disagree about its location.
 */
export function getProjectModelBaseDir(kind: "embedding" | "reranker", modelKey: string): string | null {
  const modelId = resolveModelId(kind, modelKey);
  if (!modelId) return null;
  for (const baseDir of getProjectModelsDirCandidates()) {
    const probe = probeCandidates(modelId, baseDir, PROJECT_SUB_PATHS);
    if (probe.installed) return baseDir;
  }
  return null;
}

/**
 * Resolve the concrete complete model directory (e.g. `<base>/Xenova/bge-m3`).
 * Used by loaders that need an explicit path argument (e.g. the .NET sidecar
 * rerank op, which is spawned with a modelDir rather than a transformers.js key).
 */
export function getProjectModelDir(kind: "embedding" | "reranker", modelKey: string): string | null {
  const modelId = resolveModelId(kind, modelKey);
  if (!modelId) return null;
  for (const baseDir of getProjectModelsDirCandidates()) {
    const probe = probeCandidates(modelId, baseDir, PROJECT_SUB_PATHS);
    const hit = probe.candidates.find((c) => c.missingFiles.length === 0);
    if (hit) return hit.modelDir;
  }
  return null;
}

/**
 * Detailed per-model diagnostic for troubleshooting "model not detected" bugs.
 *
 * Semantics:
 * - A project model directory "exists" if at least one candidate sub-path
 *   directory exists under any project base dir (even if incomplete).
 * - If a project model directory exists but is incomplete, we do NOT
 *   fall back to the HuggingFace cache — that would silently mask the
 *   real problem (user dropped a partial model into the project tree).
 * - HF cache is only used as fallback when no project model directory
 *   exists at all.
 *
 * Returned object:
 *   - modelId: the canonical model identifier we probed
 *   - installed: true if at least one probe succeeded (project or HF)
 *   - source: "project" | "hf-cache" | null  (which candidate set matched)
 *   - matchedAt: absolute path of the directory that satisfied all required
 *                files (null when installed is false)
 *   - existingProjectDir: first project-side directory that exists at all
 *                (even if incomplete). null when no project directory exists.
 *   - modelDirCandidates: every project baseDir we probed
 *   - subPathCandidates: sub-paths tried under each baseDir
 *   - requiredFiles: file names that must all be present
 *   - missingFiles: missing files in `existingProjectDir` when project exists
 *                  but is incomplete; otherwise []
 */
export interface ModelStatusDetail {
  modelId: string;
  installed: boolean;
  source: "project" | "hf-cache" | null;
  matchedAt: string | null;
  existingProjectDir: string | null;
  modelDirCandidates: string[];
  subPathCandidates: string[];
  requiredFiles: string[];
  missingFiles: string[];
}

export function getModelInstallStatusDetail(
  kind: "embedding" | "reranker",
  modelKey: string,
): ModelStatusDetail {
  const modelId = resolveModelId(kind, modelKey) ?? `${kind}-${modelKey}`;

  const subPaths = PROJECT_SUB_PATHS[modelId] ?? [];
  const projectBaseDirs = getProjectModelsDirCandidates();

  // Walk every project (baseDir, subPath) combination.
  let existingProjectDir: string | null = null;
  let existingProjectMissing: string[] = [];
  let projectMatchedAt: string | null = null;

  for (const baseDir of projectBaseDirs) {
    const probe = probeCandidates(modelId, baseDir, PROJECT_SUB_PATHS);
    for (const c of probe.candidates) {
      if (fs.existsSync(c.modelDir)) {
        if (existingProjectDir === null) {
          existingProjectDir = c.modelDir;
          existingProjectMissing = c.missingFiles;
        }
        if (c.missingFiles.length === 0 && projectMatchedAt === null) {
          projectMatchedAt = c.modelDir;
        }
      }
    }
  }

  if (projectMatchedAt) {
    return {
      modelId,
      installed: true,
      source: "project",
      matchedAt: projectMatchedAt,
      existingProjectDir: projectMatchedAt,
      modelDirCandidates: projectBaseDirs,
      subPathCandidates: subPaths,
      requiredFiles: REQUIRED_FILES,
      missingFiles: [],
    };
  }

  // Project model dir exists but is incomplete → refuse to fall back.
  if (existingProjectDir !== null) {
    return {
      modelId,
      installed: false,
      source: null,
      matchedAt: null,
      existingProjectDir,
      modelDirCandidates: projectBaseDirs,
      subPathCandidates: subPaths,
      requiredFiles: REQUIRED_FILES,
      missingFiles: existingProjectMissing,
    };
  }

  // No project model dir at all → try HF cache as last resort.
  const hfProbe = probeCandidates(modelId, HF_CACHE_DIR, HF_CACHE_SUB_PATHS);
  const hfHit = hfProbe.candidates.find((c) => c.missingFiles.length === 0);
  if (hfHit) {
    return {
      modelId,
      installed: true,
      source: "hf-cache",
      matchedAt: hfHit.modelDir,
      existingProjectDir: null,
      modelDirCandidates: projectBaseDirs,
      subPathCandidates: subPaths,
      requiredFiles: REQUIRED_FILES,
      missingFiles: [],
    };
  }

  return {
    modelId,
    installed: false,
    source: null,
    matchedAt: null,
    existingProjectDir: null,
    modelDirCandidates: projectBaseDirs,
    subPathCandidates: subPaths,
    requiredFiles: REQUIRED_FILES,
    missingFiles: [],
  };
}

export function getModelInstallStatus(): ModelInstallStatus {
  return {
    embedding: {
      bgem3: getModelInstallStatusDetail("embedding", "bgem3").installed,
      "e5-small": getModelInstallStatusDetail("embedding", "e5-small").installed,
    },
    reranker: {
      standard: getModelInstallStatusDetail("reranker", "standard").installed,
      "v2-m3": getModelInstallStatusDetail("reranker", "v2-m3").installed,
    },
  };
}

export function checkEmbeddingModelInstalled(modelKey: string): boolean {
  const detail = getModelInstallStatusDetail("embedding", modelKey);
  return detail.installed;
}

export function checkRerankerModelInstalled(modelKey = "standard"): boolean {
  const detail = getModelInstallStatusDetail("reranker", modelKey);
  return detail.installed;
}

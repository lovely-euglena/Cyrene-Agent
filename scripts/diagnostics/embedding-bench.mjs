// embedding 基准测试 — Phase 0 基线量化
//
// 对比同一批文本的三种推理方式（均为 WASM 后端，不涉及网络）：
//   1. sequential：逐条 pipeline 调用 —— embedBatch 修复前的旧行为
//   2. batched：   string[] 一次前向 —— runBatchedInference 的新行为
//   3. worker：    embedding-worker 全链路（含 postMessage 往返）
//
// 同时校验批内向量与逐条向量的一致性（padding + attention mask 平均池化）。
//
// 运行前置：models/Xenova/bge-m3/ 已就位（scripts/install-bge-*.ps1 或手动
// 下载），node_modules 已安装。
//
// 用法：node scripts/diagnostics/embedding-bench.mjs [textCount]

import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { pipeline, env } from "@xenova/transformers";

const modelBaseDir = path.join(process.cwd(), "models");
env.allowLocalModels = true;
env.allowRemoteModels = false;
env.useBrowserCache = false;
env.localModelPath = modelBaseDir;

const textCount = Number(process.argv[2] ?? 48);

// 贴纸/场景描述（短文本）与文档分块（长文本）混合，贴近真实写入路径
const shortTexts = [
  "昔涟趴在桌边看着你工作，尾巴轻轻晃了一下",
  "The user is focused on coding, typing fast",
  "雨天，窗外的雨声很大，室内很安静",
  "user praised the pet and smiled warmly",
];
const longText = `RAG 检索链路说明：文档导入时先分块（约 500-1000 字符），逐块向量化写入
LanceDB；查询时将 query 向量化后做 IVF 检索，取 top-k 候选，再经 bge-reranker
重排得到最终上下文。记忆写入路径为单条文本，场景识别每次对话执行一次，
两者的 embedding 调用频率都远高于检索刷新。这段长文本用于模拟文档分块的
真实负载，长度约 300 字。`.repeat(3);

const texts = [];
for (let i = 0; i < textCount; i++) {
  texts.push(i % 3 === 2 ? longText : shortTexts[i % shortTexts.length]);
}

function ms(start) {
  return Number((performance.now() - start).toFixed(1));
}

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-12);
}

console.log(`[bench] loading Xenova/bge-m3 (WASM) from ${modelBaseDir} ...`);
const loadStart = performance.now();
const pipe = await pipeline("feature-extraction", "Xenova/bge-m3", {
  cache_dir: path.join(os.homedir(), ".cache", "huggingface"),
});
console.log(`[bench] model loaded in ${ms(loadStart)}ms`);

// 预热（首次推理含 WASM 编译/图优化，不计入）
await pipe("warmup", { pooling: "mean", normalize: true });

// ── 1) 逐条推理（旧行为） ──
{
  const start = performance.now();
  const oldVectors = [];
  for (const text of texts) {
    const result = await pipe(text, { pooling: "mean", normalize: true });
    oldVectors.push(Float32Array.from(result.data));
  }
  const elapsed = ms(start);
  console.log(`[bench] sequential: ${texts.length} texts in ${elapsed}ms (${(elapsed / texts.length).toFixed(1)}ms/text)`);

  globalThis.__oldVectors = oldVectors;
}

// ── 2) 批量推理（新行为：dist 编译产物里的真实 runBatchedInference） ──
{
  // 用 dist 的真实实现（排序组批 + 子批次切分），而不是在 bench 里复刻逻辑，
  // 确保测到的就是发布代码路径
  const pipelineUrl = pathToFileURL(
    path.join(process.cwd(), "dist", "main", "main", "rag", "embedding-pipeline.js"),
  ).href;
  let runBatchedInference;
  try {
    const mod = await import(pipelineUrl);
    // tsc 编译产物是 CJS：具名导出通常能被 cjs-module-lexer 识别，兜底走 default
    runBatchedInference = mod.runBatchedInference ?? mod.default?.runBatchedInference;
  } catch {
    console.log("[bench] batched: dist/main/main/rag/embedding-pipeline.js 不存在，跳过（先 npm run build:main）");
    globalThis.__newVectors = globalThis.__oldVectors;
  }
  if (runBatchedInference) {
    const start = performance.now();
    const newVectors = await runBatchedInference(pipe, texts);
    const elapsed = ms(start);
    console.log(`[bench] batched:    ${texts.length} texts in ${elapsed}ms (${(elapsed / texts.length).toFixed(1)}ms/text)`);

    // 一致性：批内 padding + mask-aware mean pooling 应与逐条结果一致
    // （残差为 int8 量化噪声）
    const oldVectors = globalThis.__oldVectors;
    let worst = 1;
    let maxDiff = 0;
    for (let i = 0; i < texts.length; i++) {
      worst = Math.min(worst, cosine(oldVectors[i], newVectors[i]));
      for (let j = 0; j < oldVectors[i].length; j++) {
        maxDiff = Math.max(maxDiff, Math.abs(oldVectors[i][j] - newVectors[i][j]));
      }
    }
    console.log(`[bench] consistency: worst cosine=${worst.toFixed(8)}, max |diff|=${maxDiff.toExponential(2)}`);
    console.log(`[bench] dims: ${oldVectors[0].length}`);
    globalThis.__newVectors = newVectors;
  }
}

// ── 3) worker 全链路（新架构） ──
{
  // 编译后的 dist/main/main/rag/embedding-worker.js 才是 worker 入口
  // （tsconfig rootDir=src → outDir dist/main，src/main/rag 映射到 dist/main/main/rag；
  //   直接跑 ts 源文件需要 ts 注册器，这里从 dist 加载，需先 npm run build:main）
  const workerPath = path.join(process.cwd(), "dist", "main", "main", "rag", "embedding-worker.js");
  let workerVectors = null;
  if (fs.existsSync(workerPath)) {
    const start = performance.now();
    workerVectors = await new Promise((resolve, reject) => {
      const worker = new Worker(workerPath);
      worker.on("message", (message) => {
        if (message.type === "ready") {
          worker.postMessage({ type: "embed", requestId: 1, texts });
          return;
        }
        if (message.type === "result") {
          const out = message.buffers.map((buffer) => new Float32Array(buffer));
          worker.terminate();
          resolve(out);
          return;
        }
        if (message.type === "error") {
          worker.terminate();
          reject(new Error(message.reason));
        }
      });
      worker.on("error", reject);
      worker.postMessage({ type: "init", requestId: 0, modelKey: "bgem3" });
    });
    const elapsed = ms(start);
    const newVectors = globalThis.__newVectors;
    let worst = 1;
    for (let i = 0; i < texts.length; i++) {
      worst = Math.min(worst, cosine(workerVectors[i], newVectors[i]));
    }
    console.log(`[bench] worker round-trip: ${elapsed}ms (含冷启动加载模型), consistency vs in-proc: cosine=${worst.toFixed(8)}`);
  } else {
    console.log("[bench] worker: dist/main/main/rag/embedding-worker.js 不存在，跳过（先 npm run build:main）");
  }
}


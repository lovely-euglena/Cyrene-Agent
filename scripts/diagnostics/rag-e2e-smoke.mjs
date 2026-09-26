// RAG 后端端到端自测（走生产 TS 路径 + 真实 .NET sidecar）：
//   initRAG / initReranker → 文档导入（队列 → sidecar doc-import）
//   → 导入检索（index 门面，含 reranker）→ 记忆写入（embed op）
//   → 记忆检索（search op + 召回回写）→ allowedEntryIds 空集语义 → 缓存重放 → 统计
//
// 前置：npm run build:main && npm run build:embed-sidecar；models/ 模型就位
// 用法：node scripts/diagnostics/rag-e2e-smoke.mjs

import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Module = require("node:module");
const repo = process.cwd();
const userData = path.join(os.tmpdir(), "cyrene-rag-e2e-" + Date.now());
fs.mkdirSync(userData, { recursive: true });

const origLoad = Module._load;
Module._load = function (request) {
  if (request === "electron") {
    return {
      app: {
        isPackaged: false,
        getAppPath: () => repo,
        getPath: (k) => (k === "userData" ? userData : path.join(userData, k)),
      },
    };
  }
  return origLoad.apply(this, arguments);
};

const checks = [];
const check = (label, ok, detail = "") => {
  checks.push({ label, ok });
  console.log(`[rag-e2e] ${ok ? "ok  " : "FAIL"} ${label}${detail ? " — " + detail : ""}`);
};

const rag = require(path.join(repo, "dist", "main", "main", "rag", "index.js"));
const { configureDocumentIndexQueue, enqueueDocumentIndexJob } = require(
  path.join(repo, "dist", "main", "main", "rag", "document-index-queue.js"),
);
const { runDocumentImportJobViaSidecar } = require(
  path.join(repo, "dist", "main", "main", "rag", "document-import-sidecar.js"),
);
const { initReranker, getReranker } = require(path.join(repo, "dist", "main", "main", "rag", "reranker.js"));
const { getEmbeddingSidecarClient, disposeEmbeddingSidecar } = require(
  path.join(repo, "dist", "main", "main", "rag", "embedding-sidecar.js"),
);

try {
  await rag.initRAG("auto");
  await initReranker("standard");
  configureDocumentIndexQueue(runDocumentImportJobViaSidecar);

  check("sidecar available", getEmbeddingSidecarClient() !== null);
  check("reranker active", getReranker()?.name === "bge-reranker-base");

  // ── 1) 文档导入（>30k 字符） ──
  const docPath = path.join(userData, "检索系统笔记.md");
  const docBody = [
    "# 检索系统设计笔记",
    "## 混合检索",
    "混合检索将向量相似度与 BM25 关键词分数按 0.7/0.3 加权融合，兼顾语义与字面匹配。",
    "## 分块策略",
    "文档导入时按 512 token 滑动窗口分块，overlap 128，保证断点被两个块覆盖。",
    "## 重排",
    "cross-encoder 重排对候选片段逐条打分，分数是原始 logits，越大越相关。",
    ...Array.from(
      { length: 700 },
      (_, i) =>
        `第 ${i} 条备注：向量库采用 JSON 存储与 IVF 倒排索引；召回时只探测最近的少量簇；` +
        `记忆压缩把旧对话归纳为事实条目；桌宠在雨天会调低音量。`,
    ),
  ].join("\n");
  fs.writeFileSync(docPath, docBody);

  const progress = [];
  const imported = await enqueueDocumentIndexJob({
    filePath: docPath,
    query: "混合检索 BM25 融合",
    onProgress: (p) => progress.push(p.status),
  });
  check(
    "document import",
    imported.kind === "indexed" && imported.chunks > 0,
    `kind=${imported.kind} chunks=${imported.chunks} cached=${imported.cached}`,
  );
  check(
    "progress flow",
    ["queued", "reading", "chunking", "embedding", "done"].every((s) => progress.includes(s)),
    progress.slice(0, 6).join(","),
  );

  // ── 2) 导入检索（index 门面：retriever → sidecar search → rerank） ──
  const relevant = await rag.searchImportedDocumentChunksForImportIds(
    "混合检索如何融合向量与 BM25 分数",
    [imported.importId],
    3,
  );
  check(
    "imported-doc retrieval",
    relevant.length > 0 && relevant.every((c) => c.importId === imported.importId),
    relevant.map((c) => c.score.toFixed(3)).join(","),
  );
  const junk = await rag.searchImportedDocumentChunksForImportIds("今天天气怎么样", [imported.importId], 3);
  const topRelevant = relevant[0]?.score ?? -99;
  const topJunk = junk[0]?.score ?? -99;
  check(
    "rerank discrimination",
    topRelevant > topJunk,
    `relevant=${topRelevant.toFixed(3)} junk=${topJunk.toFixed(3)}`,
  );

  // ── 3) 记忆写入（embed op） ──
  const histId = await rag.addMemory("用户问过：混合检索的融合权重怎么调？记录一下 0.7/0.3。", "chat_history", {
    sessionId: "e2e",
    role: "user",
    ts: Date.now(),
  });
  check("addMemory(chat_history)", typeof histId === "string" && histId.startsWith("chat_history_"), histId);
  const l2RagId = await rag.addL2MemoryVector("用户喜欢在雨天听爵士乐", "l2_e2e", { source: "e2e" });
  check("addL2MemoryVector", typeof l2RagId === "string" && l2RagId.startsWith("user_memory_"), l2RagId);

  // ── 4) 记忆检索 + 召回回写 ──
  const history = await rag.searchHistoryEntries("融合权重 0.7", 3);
  check("history retrieval", history.length > 0 && history[0].score > 0, history[0] ? `score=${history[0].score.toFixed(3)}` : "no result");

  const recallable = rag.getEntriesBySource("chat_history");
  const boosted = recallable.find((e) => e.id === histId);
  // getEntriesBySource 不暴露 lastRecalledAt → 时间戳直接读库文件校验
  const boostFile = JSON.parse(fs.readFileSync(path.join(userData, "rag-data", "memory-store.json"), "utf8"));
  const boostedRaw = boostFile.find((e) => e.id === histId);
  check(
    "recall write-back + ensureFresh",
    !!boosted && boosted.weight > 1.0 && !!boostedRaw && boostedRaw.lastRecalledAt > boostedRaw.createdAt,
    boostedRaw
      ? `weight=${boostedRaw.weight} recall-lag=${boostedRaw.lastRecalledAt - boostedRaw.createdAt}ms`
      : "entry missing",
  );

  // ── 5) allowedEntryIds 空集语义（L2 未同步 → 应返回空） ──
  const gated = await rag.searchMemoryEntries("雨天 爵士乐", "user_memory", 3);
  check("user_memory L2 gate (empty allowed set excludes all)", gated.length === 0, `returned=${gated.length}`);

  // ── 6) 缓存重放 + 统计 ──
  const replay = await enqueueDocumentIndexJob({ filePath: docPath, query: "", onProgress: () => {} });
  check("cache replay", replay.kind === "indexed" && replay.cached === true, `chunks=${replay.chunks}`);
  const stats = rag.getRAGStats();
  check(
    "stats via ensureFresh",
    stats.sources.imported_doc === imported.chunks && stats.sources.chat_history === 1,
    JSON.stringify(stats.sources),
  );
  check("hasImportedDocumentChunks", rag.hasImportedDocumentChunks(imported.importId) === true);
} catch (error) {
  check("unexpected error", false, String(error));
} finally {
  try {
    await disposeEmbeddingSidecar("e2e-done");
  } catch {
    /* ignore */
  }
}

const pass = checks.every((c) => c.ok);
console.log(`[rag-e2e] ${pass ? "PASS" : "FAIL"} (${checks.filter((c) => c.ok).length}/${checks.length})`);
process.exit(pass ? 0 : 1);

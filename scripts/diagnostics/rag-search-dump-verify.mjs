// 生成 RAG 检索金样（Phase B 对账基准）：
//   - fixture 向量库（真实 bge-m3 向量 + 权重/时间衰减/多来源/metadata）
//   - TS 检索期望结果（HybridRetriever：向量 + BM25 + 融合，reranker 关闭）
//   - 分词快照（tokenize 的 word/tag/isStop/isNoun，.NET jieba 移植逐词对账）
//
// 前置：npm run build:main（经 dist 调用 TS 实现）；models/Xenova/bge-m3 就位
// 用法：node scripts/diagnostics/rag-search-dump-verify.mjs
//
// 产物（git 忽略）：
//   scripts/diagnostics/rag-search-fixture/memory-store.json           TS 检索回写后的副本
//   scripts/diagnostics/rag-search-fixture/baseline/memory-store.json  检索前基线（.NET 对账用）
//   scripts/diagnostics/rag-search-verify-data.json                    查询/期望/分词快照
//
// 注意：无 source 的查询走随机初始化的 IVF 路径（不可跨引擎精确对账），
// 金样中以 ivfSkip 标注，仅记录 TS 侧结果供参考。

import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { pipeline, env } from "@xenova/transformers";

// ── electron stub（经 dist 加载 TS 实现需要） ──
const require = createRequire(import.meta.url);
const Module = require("node:module");
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "electron") {
    return { app: { isPackaged: false, getAppPath: () => process.cwd() } };
  }
  return realLoad.apply(this, arguments);
};

const repoRoot = process.cwd();
const fixtureDir = path.join(repoRoot, "scripts", "diagnostics", "rag-search-fixture");
const baselineDir = path.join(fixtureDir, "baseline");
const outPath = path.join(repoRoot, "scripts", "diagnostics", "rag-search-verify-data.json");
const modelsRoot = path.join(repoRoot, "models");

// ── 真实 bge-m3 向量（与 .NET sidecar 逐位一致，Phase A 已证） ──
env.allowLocalModels = true;
env.allowRemoteModels = false;
env.useBrowserCache = false;
env.localModelPath = modelsRoot;
console.log("[rag-dump] loading bge-m3 ...");
const extractor = await pipeline("feature-extraction", "Xenova/bge-m3", { cache_dir: modelsRoot });
const embed = async (text) => Array.from((await extractor(text, { pooling: "mean", normalize: true })).data);

// ── fixture 文档（覆盖：来源过滤 / importIds / metadata / 中英混合 / 自定义词） ──
const NOW = Date.now();
const hours = (h) => NOW - h * 3600_000;
const docs = [
  { text: "昔涟是桌宠的虚拟角色，喜欢在用户工作时安静陪伴。", source: "user_memory", weight: 1.0, at: hours(1) },
  { text: "用户偏好深色主题，讨厌频繁弹窗打扰。", source: "user_memory", weight: 1.5, at: hours(30) },
  { text: "用户正在开发 RAG 检索链路，关注向量库与重排质量。", source: "user_memory", weight: 2.2, at: hours(200) },
  { text: "用户最近在研究本地 ONNX 推理加速。", source: "user_memory", weight: 1.0, at: hours(0.5) },
  { text: "RAG 检索链路包含文档分块、embedding 写入、近邻搜索与 cross-encoder 重排三个阶段。", source: "imported_doc", importId: "imp_001", weight: 1.0, at: hours(2) },
  { text: "向量库采用 JSON 存储与 IVF 倒排索引，搜索时只探测最近的一小部分簇。", source: "imported_doc", importId: "imp_001", weight: 1.0, at: hours(2) },
  { text: "BM25 是经典的关键词检索算法，与向量检索加权融合可以兼顾语义与字面匹配。", source: "imported_doc", importId: "imp_001", weight: 1.0, at: hours(2) },
  { text: "Memory compression summarizes older turns into compact facts to keep the context window small.", source: "imported_doc", importId: "imp_002", weight: 1.2, at: hours(5) },
  { text: "Worldbook entries are injected by keyword activation and activation decay.", source: "worldbook", weight: 1.0, at: hours(10) },
  { text: "DMAE 状态机根据关键词激活度决定世界书注入优先级。", source: "worldbook", weight: 1.0, at: hours(10) },
  { text: "Sticker embedding matches user scenes with sticker descriptions for semantic retrieval.", source: "sticker", weight: 1.0, at: hours(20) },
  { text: "场景识别用最近三轮对话的加权向量与场景标签匹配。", source: "scene", weight: 1.0, at: hours(20) },
];

console.log(`[rag-dump] embedding ${docs.length} docs ...`);
const entries = [];
for (let i = 0; i < docs.length; i++) {
  const d = docs[i];
  entries.push({
    id: `doc_${String(i).padStart(2, "0")}`,
    text: d.text,
    embedding: await embed(d.text),
    source: d.source,
    weight: d.weight,
    createdAt: d.at,
    lastRecalledAt: d.at,
    metadata: d.importId ? { importId: d.importId } : undefined,
  });
}

// ── 写 fixture 库 + 基线快照 ──
fs.mkdirSync(fixtureDir, { recursive: true });
fs.mkdirSync(baselineDir, { recursive: true });
const storePath = path.join(fixtureDir, "memory-store.json");
const baselinePath = path.join(baselineDir, "memory-store.json");
fs.writeFileSync(storePath, JSON.stringify(entries, null, 2), "utf8");
fs.copyFileSync(storePath, baselinePath);
fs.writeFileSync(
  path.join(fixtureDir, "memory-store-meta.json"),
  JSON.stringify(
    {
      provider: "local",
      model: "Xenova/bge-m3",
      dimensions: 1024,
      cacheIdentity: JSON.stringify({ provider: "local", model: "Xenova/bge-m3", dimensions: 1024 }),
    },
    null,
    2,
  ),
  "utf8",
);

// ── TS 检索（经 dist 的真实实现） ──
const distRag = path.join(repoRoot, "dist", "main", "main", "rag");
const { JsonVectorStore } = require(path.join(distRag, "vectorstore.js"));
const { HybridRetriever, tokenize, registerJiebaCustomWord } = require(path.join(distRag, "retriever.js"));

const customWords = ["昔涟"];
for (const w of customWords) registerJiebaCustomWord(w);

const provider = {
  name: "parity-bge-m3",
  declaredDimensions: 1024,
  resolvedDimensions: 1024,
  cacheIdentity: { provider: "local", model: "Xenova/bge-m3", dimensions: 1024 },
  embed: async (text) => embed(text),
  embedBatch: async (texts) => {
    const out = [];
    for (const t of texts) out.push(await embed(t));
    return out;
  },
};

const queries = [
  { query: "RAG 检索 向量库 重排", source: "imported_doc", topK: 5 },
  { query: "用户喜欢什么主题", source: "user_memory", topK: 5 },
  { query: "how does memory compression work", source: "imported_doc", topK: 5 },
  { query: "世界书 注入", source: "worldbook", topK: 3 },
  { query: "RAG", source: "imported_doc", topK: 5, options: { importIds: ["imp_002"] } },
  { query: "向量检索 BM25 融合", source: "imported_doc", topK: 5, options: { allowedEntryIds: ["doc_04", "doc_05", "doc_06"] } },
  { query: "昔涟 陪伴", source: undefined, topK: 5, ivfSkip: true },
];

const expectedQueries = [];
for (const q of queries) {
  // 逐查询重置为基线库（隔离召回回写对后续查询的级联影响，.NET 对账同法）
  fs.copyFileSync(baselinePath, storePath);
  const store = new JsonVectorStore(fixtureDir);
  const retriever = new HybridRetriever(store, provider);
  const results = await retriever.retrieve(q.query, q.source, q.topK, q.options ?? {});
  expectedQueries.push({
    ...q,
    results: results.map((r) => ({ id: r.entry.id, score: r.score })),
  });
  console.log(
    `[rag-dump] ${q.ivfSkip ? "(ivf-skip) " : ""}${q.query} → ${results.map((r) => `${r.entry.id}:${r.score.toFixed(4)}`).join(", ")}`,
  );
}

// ── 分词快照（docs 全量 + 所有查询） ──
const snapshot = (text) =>
  tokenize(text).map((t) => ({ w: t.word, tag: t.tag, s: t.isStop ? 1 : 0, n: t.isNoun ? 1 : 0 }));
const queryTexts = [...new Set(queries.map((q) => q.query))];
const tokens = {
  docs: docs.map((d) => ({ text: d.text, tokens: snapshot(d.text) })),
  queries: queryTexts.map((t) => ({ text: t, tokens: snapshot(t) })),
};

fs.writeFileSync(
  outPath,
  JSON.stringify(
    {
      model: "Xenova/bge-m3",
      customWords,
      baselineStore: path.relative(repoRoot, path.join(baselineDir, "memory-store.json")).replace(/\\/g, "/"),
      queries: expectedQueries,
      tokens,
    },
    null,
    2,
  ),
  "utf8",
);
console.log(`[rag-dump] written to ${outPath}`);
console.log(`[rag-dump] ${expectedQueries.length} queries, ${docs.length} docs, token snapshots ready`);

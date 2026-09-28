// 生成 reranker 金样数据（pairs + tokenIds + logits），
// 供 .NET RerankerEngine verify-rerank 数值对账。
//
// 用法：node scripts/diagnostics/reranker-dump-verify.mjs [out.json]
// 输出默认 scripts/diagnostics/reranker-verify-data.json（git 忽略，仅本地用）

import * as path from "node:path";
import * as fs from "node:fs";
import { AutoTokenizer, AutoModelForSequenceClassification, env } from "@xenova/transformers";

const modelsRoot = path.join(process.cwd(), "models");
env.allowLocalModels = true;
env.allowRemoteModels = false;
env.useBrowserCache = false;
env.localModelPath = modelsRoot;

// 覆盖：短文本、中文、长文本（触发 longest_first 截断到 512）
const short = (n, s) => Array.from({ length: n }, () => s).join("，");
const pairs = [
  {
    query: "how to debug RAG retrieval pipeline",
    doc: "This guide explains RAG retrieval, vector store and reranker debugging",
  },
  {
    query: "how to debug RAG retrieval pipeline",
    doc: "Weather is nice today for a walk outside",
  },
  {
    query: "用户询问如何调试 RAG 检索链路",
    doc: "这篇文档讲解 RAG 检索、向量库与重排的调试方法",
  },
  {
    query: "why is the reranker score constant",
    doc: short(60, "cross encoder 对查询与文档的拼接序列做打分，取单个 logit 作为相关性分数"),
  },
];

const out =
  process.argv[2] ?? path.join(process.cwd(), "scripts", "diagnostics", "reranker-verify-data.json");

// 顺带打印 tokenizer.json 的 pair 模板（写 .NET 侧 pair 编码时对齐用）
const tokenizerJson = JSON.parse(
  fs.readFileSync(path.join(modelsRoot, "bge-reranker-base", "tokenizer.json"), "utf8")
);
console.log("[reranker-dump] post_processor:", JSON.stringify(tokenizerJson.post_processor));

console.log(`[reranker-dump] loading bge-reranker-base from ${modelsRoot} ...`);
const t0 = performance.now();
const tokenizer = await AutoTokenizer.from_pretrained("bge-reranker-base", {
  cache_dir: modelsRoot,
});
const model = await AutoModelForSequenceClassification.from_pretrained("bge-reranker-base", {
  quantized: true,
  cache_dir: modelsRoot,
});
console.log(`[reranker-dump] model loaded in ${(performance.now() - t0).toFixed(0)}ms`);

const tokenIds = [];
const scores = [];
for (const { query, doc } of pairs) {
  // (query, doc) 配对编码，batch=1 无 padding；truncation 到 model_max_length(512)
  const enc = tokenizer(query, { text_pair: doc, truncation: true });
  tokenIds.push(Array.from(enc.input_ids.data).map(Number));
  const { logits } = await model(enc);
  scores.push(logits.tolist()[0][0]);
}

fs.writeFileSync(out, JSON.stringify({ model: "bge-reranker-base", pairs, tokenIds, scores }));
console.log(`[reranker-dump] ${pairs.length} pairs, seq lens=${tokenIds.map((t) => t.length).join(",")}`);
console.log(`[reranker-dump] scores=${scores.map((s) => s.toFixed(4)).join(", ")}`);
console.log(`[reranker-dump] written to ${out}`);

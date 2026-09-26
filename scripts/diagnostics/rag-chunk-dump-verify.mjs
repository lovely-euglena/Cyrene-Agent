// 生成 chunk 切分金样（TS chunkText 逐块快照），供 .NET TextChunker verify-chunks 对账。
//
// 前置：npm run build:main
// 用法：node scripts/diagnostics/rag-chunk-dump-verify.mjs

import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();
const outPath = path.join(repoRoot, "scripts", "diagnostics", "rag-chunk-verify-data.json");

const { chunkText } = require(path.join(repoRoot, "dist", "main", "main", "rag", "chunk.js"));

const longChinese = Array.from(
  { length: 60 },
  (_, i) =>
    `第${i + 1}段：桌宠助手需要稳定地检索历史对话与文档。向量检索依赖分块质量，块太大会稀释语义，块太小会丢上下文。` +
    `因此采用滑动窗口，保证任何断点至少被两个块覆盖。`,
).join("");

const markdown = [
  "# 系统设计",
  "本文描述检索系统的整体结构。",
  "## 数据层",
  "向量库采用 JSON 存储，附带 IVF 倒排索引。",
  "### 存储格式",
  "条目包含 id、text、embedding 与元数据。",
  "## 检索层",
  "混合检索融合向量与 BM25 分数。",
  "## 记忆层",
  "L0/L1/L2 分层管理长期记忆。",
  ...Array.from({ length: 30 }, (_, i) => `补充段落 ${i + 1}：记忆压缩会在会话结束后把旧对话归纳为事实条目。`),
].join("\n");

const noPunct = Array.from({ length: 80 }, (_, i) => `关键词${i}检索链路段落`).join("");

const mixed =
  "RAG pipeline includes embedding, retrieval and reranking. " +
  longChinese.slice(0, 900) +
  " cross-encoder rerank improves precision.";

const samples = [
  { name: "short", text: "短文本，无需切分。" },
  { name: "long-chinese", text: longChinese },
  { name: "markdown-headings", text: markdown },
  { name: "no-punctuation", text: noPunct },
  { name: "mixed", text: mixed },
  { name: "crlf", text: "第一行。\r\n第二行。\r\n" + longChinese.slice(0, 1200) },
];

const dump = samples.map((s) => ({
  name: s.name,
  text: s.text,
  chunks: chunkText(s.text, "doc_" + s.name).map((c) => ({ id: c.id, index: c.index, text: c.text })),
}));

fs.writeFileSync(outPath, JSON.stringify(dump, null, 2), "utf8");
console.log(`[chunk-dump] ${dump.length} samples`);
for (const d of dump) console.log(`[chunk-dump] ${d.name}: ${d.chunks.length} chunks, text=${d.text.length} chars`);
console.log(`[chunk-dump] written to ${outPath}`);

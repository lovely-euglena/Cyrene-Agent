// dump JS 侧 embedding 验证数据（文本 + tokenIds + 向量），
// 供 .NET sidecar 数值一致性对比（verify 模式输入）。
//
// 用法：node scripts/diagnostics/embedding-dump-verify.mjs [out.json]
// 输出默认 scripts/diagnostics/embedding-verify-data.json（git 忽略体积，仅本地用）

import * as path from "node:path";
import * as fs from "node:fs";
import { pipeline, env, AutoTokenizer } from "@xenova/transformers";

const modelBaseDir = path.join(process.cwd(), "models");
env.allowLocalModels = true;
env.allowRemoteModels = false;
env.useBrowserCache = false;
env.localModelPath = modelBaseDir;

const texts = [
  // 短文本（贴纸/场景描述类）
  "昔涟趴在桌边看着你工作，尾巴轻轻晃了一下",
  "The user is focused on coding, typing fast",
  "雨天，窗户上有水珠",
  "用户刚刚夸奖了昔涟",
  // 中等文本
  "昔涟注意到你连续工作了很久，轻轻地给你递上一杯热茶，然后把音量调小了一些，不想打扰你的思路。",
  "The assistant detected that the user has been working for over three hours without a break, and gently suggested taking a short walk.",
  // 长文本（文档分块类）
  "RAG 检索链路包含三个阶段：文档摄入时先分块并生成 embedding 写入向量库；检索时把查询文本转成向量做近邻搜索；最后可选地用 cross-encoder 对候选重排。分块策略影响召回质量，块太大稀释语义，块太小丢失上下文。",
  "Memory compression summarizes older conversation turns into compact facts so the context window stays small. The compressor runs as a batch job after each session ends, embedding the summary into the same vector store used by retrieval.",
];

const out = process.argv[2] ?? path.join(process.cwd(), "scripts", "diagnostics", "embedding-verify-data.json");

console.log(`[dump] loading Xenova/bge-m3 from ${modelBaseDir} ...`);
const t0 = performance.now();
const extractor = await pipeline("feature-extraction", "Xenova/bge-m3", {
  cache_dir: path.join(process.cwd(), "models"),
});
console.log(`[dump] model loaded in ${(performance.now() - t0).toFixed(0)}ms`);

const tokenizer = await AutoTokenizer.from_pretrained("Xenova/bge-m3");

const tokenIds = [];
for (const text of texts) {
  const enc = await tokenizer(text);
  // enc.input_ids.data: BigInt64Array
  tokenIds.push(Array.from(enc.input_ids.data).map(Number));
}

const vectors = [];
for (const text of texts) {
  const result = await extractor(text, { pooling: "mean", normalize: true });
  // float16 精度足够对比；存 float32 原值
  vectors.push(Array.from(result.data, (v) => Math.round(v * 1e6) / 1e6));
}

fs.writeFileSync(out, JSON.stringify({ model: "Xenova/bge-m3", texts, tokenIds, vectors, dims: vectors[0].length }));
console.log(`[dump] ${texts.length} texts, tokenIds lens=${tokenIds.map((t) => t.length).join(",")}`);
console.log(`[dump] written to ${out}`);

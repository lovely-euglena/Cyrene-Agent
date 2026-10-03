// 文本（jieba 分词 + BM25）表情包匹配引擎
// 与向量匹配（sticker-embedder）并行的第二条链路：不依赖 embedding 模型，
// 只要贴纸有文字描述/短语即可匹配。分词复用 rag/retriever 的 tokenize，
// 因此实体图谱注册的自定义词（如角色名）在这里同样生效。

import { tokenize, type TokenInfo } from "./rag/retriever";
import { BUILT_IN_STICKER_DESCRIPTIONS } from "./sticker-descriptions";
import { loadUserStickerManifest } from "./sticker-storage";

/** 文本索引中的一条：贴纸 id + 其描述/短语拼成的可匹配文本。 */
export interface StickerTextEntry {
  id: string;
  text: string;
}

/** 贴纸文字描述（内置与用户贴纸共用）。 */
export interface StickerTextDescription {
  description?: string;
  phrases?: string[];
}

const DEFAULT_MINIMUM_MATCH_SCORE = 0.9;
const DEFAULT_MINIMUM_LEAD = 0.55;
const MIN_CONFIDENCE_THRESHOLD = 0.3;
const MAX_CONFIDENCE_THRESHOLD = 0.9;

const K1 = 1.2;
const B = 0.75;
const STOP_WEIGHT = 0.3;
const NOUN_WEIGHT = 1.3;

/** 把内置 + 用户贴纸的文字描述合并成可匹配索引。 */
export function buildStickerTextIndex(
  builtIn: Record<string, StickerTextDescription>,
  userStickers: Record<string, StickerTextDescription>,
): StickerTextEntry[] {
  const entries: StickerTextEntry[] = [];
  for (const [id, sticker] of [...Object.entries(builtIn), ...Object.entries(userStickers)]) {
    const text = [...new Set([
      ...(typeof sticker.description === "string" ? [sticker.description] : []),
      ...(Array.isArray(sticker.phrases) ? sticker.phrases : []),
    ].map((phrase) => phrase.trim()).filter(Boolean))].join("\n");
    if (text) entries.push({ id, text });
  }
  return entries;
}

/** 从内置描述 + 用户贴纸清单构建文本索引（无模型、无 IO 之外的副作用）。 */
export function loadStickerTextIndex(): StickerTextEntry[] {
  return buildStickerTextIndex(BUILT_IN_STICKER_DESCRIPTIONS, loadUserStickerManifest());
}

function bm25Score(
  queryTokens: TokenInfo[],
  docTokens: TokenInfo[],
  docFreq: Map<string, number>,
  totalDocs: number,
  avgDocLen: number,
): number {
  const termFrequency = new Map<string, number>();
  for (const token of docTokens) {
    termFrequency.set(token.word, (termFrequency.get(token.word) ?? 0) + 1);
  }

  let score = 0;
  for (const queryToken of queryTokens) {
    const documentFrequency = docFreq.get(queryToken.word) ?? 0;
    if (documentFrequency === 0) continue;
    const frequency = termFrequency.get(queryToken.word) ?? 0;
    const idf = Math.log((totalDocs - documentFrequency + 0.5) / (documentFrequency + 0.5) + 1);
    const numerator = frequency * (K1 + 1);
    const denominator = frequency + K1 * (1 - B + B * (avgDocLen ? docTokens.length / avgDocLen : 1));
    let termScore = idf * (numerator / denominator);
    if (queryToken.isNoun) termScore *= NOUN_WEIGHT;
    if (queryToken.isStop) termScore *= STOP_WEIGHT;
    score += termScore;
  }
  return score;
}

/**
 * 文本匹配：jieba 分词 + BM25 打分。
 * 命中需同时满足「最高分够高」与「与第二名拉开差距」，避免沾边就触发。
 * @param query 聊天内容压缩后的查询文本
 * @param index 文本索引（调用方可先按开关过滤掉被禁用的贴纸）
 * @param confidenceThreshold 匹配置信度 0.3~0.9（与向量阈值同键，越高越谨慎）
 */
export function matchStickerText(
  query: string,
  index: readonly StickerTextEntry[],
  confidenceThreshold = DEFAULT_MINIMUM_LEAD,
): { id: string; score: number } | null {
  if (!query.trim() || index.length === 0) return null;

  const queryTokens = tokenize(query);
  const tokenized = index.map((entry) => ({ entry, tokens: tokenize(entry.text) }));

  const docFreq = new Map<string, number>();
  for (const { tokens } of tokenized) {
    for (const word of new Set(tokens.map((token) => token.word))) {
      docFreq.set(word, (docFreq.get(word) ?? 0) + 1);
    }
  }
  const avgDocLen = tokenized.reduce((sum, { tokens }) => sum + tokens.length, 0) / tokenized.length;
  const queryWords = new Set(queryTokens.map((token) => token.word));

  const ranked = tokenized
    .map(({ entry, tokens }) => ({
      entry,
      score: tokens.some((token) => queryWords.has(token.word))
        ? bm25Score(queryTokens, tokens, docFreq, tokenized.length, avgDocLen)
        : 0,
    }))
    .sort((a, b) => b.score - a.score);

  const [best, second] = ranked;
  const threshold = Math.max(MIN_CONFIDENCE_THRESHOLD, Math.min(MAX_CONFIDENCE_THRESHOLD, confidenceThreshold));
  const minimumScore = DEFAULT_MINIMUM_MATCH_SCORE * (threshold / DEFAULT_MINIMUM_LEAD);
  if (!best || best.score < minimumScore) return null;

  const lead = second?.score ? (best.score - second.score) / best.score : 1;
  const minimumLead = DEFAULT_MINIMUM_LEAD
    * ((threshold - MIN_CONFIDENCE_THRESHOLD) / (MAX_CONFIDENCE_THRESHOLD - MIN_CONFIDENCE_THRESHOLD));
  if (lead < minimumLead) return null;

  return { id: best.entry.id, score: lead };
}

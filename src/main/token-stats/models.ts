// 精确 token 统计：模型名归一化与支持清单。
//
// 清单需与 dotnet/token-stats/tokenizer-sources.json 保持同步（20 个官方词表）。
// 该文件不依赖 electron，可在单测/渲染侧安全导入。

export const TOKENIZER_MODEL_IDS = [
  "deepseek-v3.2",
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "deepseek-v4.1-flash",
  "glm-5",
  "glm-5.1",
  "glm-5.2",
  "glm-5.3",
  "glm-5.3-flash",
  "minimax-m2",
  "minimax-m2.1",
  "minimax-m2.5",
  "minimax-m3",
  "qwen3",
  "qwen3.5",
  "qwen3.6-27b",
  "qwen3.6-35b-a3b",
  "qwen3.8-2.4t-a95b",
  "qwen3.8-27b",
  "qwen3.8-flash-next",
] as const;

export type TokenizerModelId = (typeof TOKENIZER_MODEL_IDS)[number];
export type TokenizerSourceId = "modelscope" | "hf-mirror" | "huggingface";

const MODEL_ID_SET: ReadonlySet<string> = new Set(TOKENIZER_MODEL_IDS);
/** 前缀匹配用（长 key 优先：qwen3.8-27b 不会命中 qwen3）。 */
const MODEL_IDS_BY_LENGTH: readonly string[] = [...TOKENIZER_MODEL_IDS].sort((a, b) => b.length - a.length);

/**
 * 服务商模型名 → 词表清单 key。
 * - 大小写不敏感；容忍 `org/model` 前缀；
 * - 支持家族变体前缀（qwen3-235b-a22b → qwen3，glm-5-air → glm-5）；
 * - 不在清单内返回 null（调用方回退启发式估算）。
 */
export function normalizeTokenizerModelId(model: string | undefined | null): string | null {
  if (typeof model !== "string") return null;
  const trimmed = model.trim().toLowerCase();
  if (!trimmed) return null;
  const bare = trimmed.includes("/") ? trimmed.slice(trimmed.lastIndexOf("/") + 1) : trimmed;
  if (MODEL_ID_SET.has(bare)) return bare;
  if (MODEL_ID_SET.has(trimmed)) return trimmed;
  for (const id of MODEL_IDS_BY_LENGTH) {
    if (bare.startsWith(`${id}-`)) return id;
  }
  return null;
}

export function isTokenizerSourceId(value: unknown): value is TokenizerSourceId {
  return value === "modelscope" || value === "hf-mirror" || value === "huggingface";
}

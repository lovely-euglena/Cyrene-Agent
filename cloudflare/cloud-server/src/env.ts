/**
 * CF 版运行环境（IKJN79）：wrangler vars / secrets，命名与 .NET 版 CLOUD_* 环境变量对齐。
 */

export interface Env {
  ASSETS: Fetcher;
  CLOUD_STORE: DurableObjectNamespace;
  /** 主控令牌（secret；未设置时仅 device token 可用，与 .NET 一致）。 */
  CLOUD_TOKEN?: string;
  /** 域名白名单（逗号分隔；空 = 不限制；回环豁免）。 */
  CLOUD_ALLOWED_HOSTS?: string;
  CLOUD_PAIR_TTL_SECONDS?: string;
  CLOUD_RATE_SYNC_PER_MIN?: string;
  CLOUD_RATE_PAIR_PER_MIN?: string;
  /** 模型 API 密钥（secret；设置即启用生成，与 CLOUD_LLM_MODE=echo 二选一）。 */
  CLOUD_LLM_API_KEY?: string;
  CLOUD_LLM_MODEL?: string;
  CLOUD_LLM_BASE_URL?: string;
  /** "echo" = 内置回声 mock（测试部署用，不调外部模型）。 */
  CLOUD_LLM_MODE?: string;
  CLOUD_LLM_SYSTEM_PROMPT?: string;
  CLOUD_LLM_CONTEXT_CHARS?: string;
  CLOUD_LLM_MAX_TOKENS?: string;
  CLOUD_LLM_TIMEOUT_SECONDS?: string;
  CLOUD_DIALOG_MAX_ATTEMPTS?: string;
  CLOUD_DIALOG_RETRY_BASE_MS?: string;
}

/** push 请求体上限（10MB；与 .NET CloudApi.MaxPushBodyBytes 一致）。 */
export const MAX_PUSH_BODY_BYTES = 10 * 1024 * 1024;

/** 正整数环境变量解析（非法/缺省回退；与 .NET ReadIntEnv 一致）。 */
export function intEnv(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** 服务端生成是否启用：echo mock 或模型 API 密钥（与 .NET ModelClient.Enabled 口径一致）。 */
export function generationEnabled(env: Env): boolean {
  const mode = (env.CLOUD_LLM_MODE ?? "").trim().toLowerCase();
  const apiKey = (env.CLOUD_LLM_API_KEY ?? "").trim();
  return mode === "echo" || apiKey.length > 0;
}

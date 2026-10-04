/**
 * llm-host 线协议契约（TS 侧事实镜像，H0 契约冻结）。
 *
 * C# 事实源：dotnet/cyrene-core/Llm/LlmContracts.cs——两侧字符串必须逐字一致，
 * 一致性由 llm-contract.test.ts 扫描 C# 源码锁定（同 native-settings-protocol 先例）。
 * 任一侧改动必须同批同步，否则 CI 红。
 */

export const LLM_OPS = {
  ready: "ready",
  result: "result",
  submit: "llm.submit",
  poll: "llm.poll",
  cancel: "llm.cancel",
  status: "llm.status",
  shutdown: "shutdown",
} as const;

export const LLM_EVENTS = {
  delta: "delta",
  reasoningDelta: "reasoning_delta",
  toolCallsDelta: "tool_calls_delta",
  usage: "usage",
  finish: "finish",
  retry: "retry",
  error: "error",
  done: "done",
} as const;

export const LLM_LANES = {
  interactive: "interactive",
  normal: "normal",
  low: "low",
} as const;

/** secrets-host op 名（契约测试与 SecretsHost.cs 双向锁定，复审 P1-14）。 */
export const SECRETS_OPS = {
  ready: "ready",
  result: "result",
  get: "secret.get",
  put: "secret.put",
  delete: "secret.delete",
  list: "secret.list",
  import: "secret.import",
  status: "secret.status",
  markMigrated: "secret.mark-migrated",
  shutdown: "shutdown",
} as const;

export const LLM_ERRORS = {
  authMissing: "E_LLM_HOST_AUTH_MISSING",
  badRequest: "E_LLM_HOST_BAD_REQUEST",
  jobMissing: "E_LLM_HOST_JOB_MISSING",
  laneFull: "E_LLM_HOST_LANE_FULL",
  secretUnavailable: "E_LLM_HOST_SECRET_UNAVAILABLE",
  httpPrefix: "E_LLM_HTTP_",
  httpNetwork: "E_LLM_HTTP_0",
  idleTimeout: "E_LLM_IDLE_TIMEOUT",
  requestTimeout: "E_LLM_REQUEST_TIMEOUT",
  cancelled: "E_LLM_CANCELLED",
  truncated: "E_LLM_TRUNCATED",
} as const;

/** llm.submit 载荷（TS 塑形 wire 请求、去鉴权；.NET 注入鉴权后发送）。 */
export interface LlmSubmitPayload {
  lane: string;
  endpoint: string;
  method?: string;
  auth: { vaultKey: string; style: "bearer" | "raw"; headerName?: string };
  headers: Record<string, string>;
  body: string;
  protocol?: string;
  timeoutMs?: number;
  maxRetries?: number;
  idleTimeoutMs?: number;
}

/** llm.poll 结果段。 */
export interface LlmPollResult {
  jobId: string;
  cursor: number;
  nextCursor: number;
  events: LlmHostEvent[];
  final: boolean;
}

/** 归一化 token 事件（C# LlmEvent 的 camelCase 序列化形态）。 */
export interface LlmHostEvent {
  type: string;
  text?: string | null;
  calls?: unknown;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cachedInputTokens?: number | null;
  reason?: string | null;
  attempt?: number | null;
  delayMs?: number | null;
  category?: string | null;
  code?: string | null;
  message?: string | null;
  retryable?: boolean | null;
}

/** 密钥库宿主 result.data 形态。 */
export interface SecretsStatusData {
  count: number;
  migrated: boolean;
  migratedAt: string | null;
  protector: string;
  available: boolean;
}

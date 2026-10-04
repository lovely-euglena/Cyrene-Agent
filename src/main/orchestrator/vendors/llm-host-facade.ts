/**
 * llm-host 双轨 facade（Phase 2 / H3）。
 *
 * 拍板 #1（方案 B 起步）：TS 塑形 wire 请求（复用 adapter.buildStreamRequest，
 * 摘除鉴权头），.NET 注入鉴权 + 发送 + 流式解析；本模块按 cursor 轮询归一化
 * 事件并翻译回 onDelta / usage / 工具回调语义，返回与 streamChatWithSdk 同形的
 * ChatResponse（双轨 diff 一致性验收用例 7）。
 *
 * 路由条件：llmHost + secretsHost 双开且 keyring 已 hydrate、transport=openai、
 * 流式请求。任一不满足 → TS 直连（双轨回退）。host 中途丢失：无可见增量时
 * 抛 E_LLM_HOST_LOST 由调用方回退直连；已有增量则如实失败（不重放副作用，
 * 设计 §8 用例 8）。
 */
import { AgentRuntimeError } from "../agent-runtime-error";
import { llmHostClient as defaultLlmHostClient, type LlmHostClient } from "../../dotnet-backend/llm-host-client";
import { resolveDotnetConfig } from "../../dotnet-backend/config";
import { LLM_EVENTS, LLM_LANES, type LlmHostEvent } from "../../dotnet-backend/llm-host-protocol";
import { isKeyringHydrated, isVaultMode, resolveVaultKeyForVendor } from "../../settings/secrets-keyring";
import { resolveTransport } from "./transport-detector";
import type { ModelRetryStatus } from "../../../shared/model-retry";
import type { ChatMessage, ChatRequest, ChatResponse, ChatVendorAdapter, ToolCall, VendorConfig } from "./types";

const AUTH_HEADER_PATTERN = /^(authorization|x-api-key|api-key|cookie)$/i;

/** 客户端引用（可注入桩——双轨链路测试用；复审放行条件 2「宿主拉起与双轨链路」）。 */
let llmHostClient: LlmHostClient = defaultLlmHostClient;
export function __setLlmHostClientForTests(client: LlmHostClient | null): void {
  llmHostClient = client ?? defaultLlmHostClient;
}

export interface LlmHostCallOptions {
  adapter: ChatVendorAdapter;
  request: ChatRequest;
  config: VendorConfig;
  timeoutMs: number;
  signal?: AbortSignal;
  onDelta: (delta: { type: "text_delta" | "reasoning_delta"; delta: string }) => void;
  onRetryStatus?: (status: ModelRetryStatus) => void;
}

/** 双轨路由判定（主聊天流式 + openai 协议 + 双开关 + keyring 就绪）。 */
export function shouldRouteViaLlmHost(config: VendorConfig, request: ChatRequest): boolean {
  const cfg = resolveDotnetConfig();
  if (!cfg.llmHost || !cfg.secretsHost) return false;
  if (!isKeyringHydrated() || !isVaultMode()) return false;
  if (request.stream === false) return false;
  try {
    if (resolveTransport({
      baseUrl: config.baseUrl,
      explicitTransport: config.explicitTransport,
      provider: config.provider,
    }) !== "openai") return false;
  } catch {
    return false;
  }
  return llmHostClient.enabled();
}

/** llm-host 通道调用（翻译层；返回与 streamChatWithSdk 同形的 ChatResponse）。 */
export async function callLLMViaLlmHost(options: LlmHostCallOptions): Promise<ChatResponse> {
  const { adapter, request, config } = options;
  const signal = options.signal ?? new AbortController().signal; // 缺省 = 不可取消（后台通道）

  // 复审 P0-1：生产链路显式拉起宿主（既有 host 模式同构——ensureStarted 幂等），
  // 失败按宿主丢失回退 TS 直连
  try {
    const up = await llmHostClient.ensureStarted();
    if (!up) throw new Error("llm-host 启动失败");
  } catch (err) {
    throw hostLost(err, "ensureStarted");
  }

  const http = adapter.buildStreamRequest({ ...request, stream: true }, config);

  // 摘鉴权头（wire 去鉴权；.NET 从 vault 注入）
  const headers: Record<string, string> = {};
  let authStyle: "bearer" | "raw" = "bearer";
  let authHeaderName = "x-api-key";
  for (const [name, value] of Object.entries(http.headers)) {
    if (AUTH_HEADER_PATTERN.test(name)) {
      if (/^x-api-key$|^api-key$/i.test(name)) {
        authStyle = "raw";
        authHeaderName = name.toLowerCase();
      }
      continue;
    }
    headers[name] = value;
  }

  let jobId = "";
  try {
    jobId = await llmHostClient.submit({
      lane: LLM_LANES.interactive,
      endpoint: http.url,
      method: "POST",
      // 复审 P1-10：按内存真值反查 key 实际所在槽位（档案 key 在 model:profile:<id>
      // 槽而 provider 槽为空时，provider 槽硬编码会 AUTH_MISSING）
      auth: { vaultKey: resolveVaultKeyForVendor(config.provider, config.apiKey), style: authStyle, headerName: authHeaderName },
      headers,
      body: http.body,
      protocol: "openai",
      timeoutMs: Math.max(30_000, options.timeoutMs || 120_000),
      maxRetries: 5, // 对齐 modelRequestMaxRetries 默认（复审 P1-11）
      idleTimeoutMs: 45_000,
    });
    if (!jobId) throw new Error("submit 未返回 jobId");
  } catch (err) {
    // submit 失败 = 作业未创建（jobId 为空），无 .NET 侧资源需取消；由 hostLost
    // 统一 → 调用方回退直连（E_LLM_HOST_LOST）
    throw hostLost(err, "submit");
  }

  const onAbort = () => { void llmHostClient.cancel(jobId).catch(() => { }); };
  signal.addEventListener("abort", onAbort, { once: true });

  try {
    return await collectJob(jobId, options, signal);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function collectJob(
  jobId: string,
  options: LlmHostCallOptions,
  signal: AbortSignal,
): Promise<ChatResponse> {
  const { onDelta, onRetryStatus } = options;
  let cursor = 0;
  let text = "";
  let thinking = "";
  let finishReason = "stop";
  let usage: ChatResponse["usage"] | undefined;
  const toolAcc = new Map<number, { id: string; name: string; arguments: string }>();

  while (!signal.aborted) {
    let result;
    try {
      result = await llmHostClient.poll(jobId, cursor, 5_000);
    } catch (err) {
      // host 丢失：先尽力取消 .NET 侧作业（幂等；host 已死则 no-op，复审 P1-11 防双计费），
      // 无可见增量 → 明确收口（调用方可回退直连）；已有增量 → 如实失败
      void llmHostClient.cancel(jobId).catch(() => { });
      if (text.length === 0 && thinking.length === 0 && toolAcc.size === 0) throw hostLost(err, "poll");
      throw err;
    }
    cursor = result.nextCursor;

    for (const ev of result.events) {
      const mapped = translate(ev, onDelta, onRetryStatus, toolAcc);
      if (mapped.text !== undefined) text += mapped.text;
      if (mapped.thinking !== undefined) thinking += mapped.thinking;
      if (mapped.finishReason) finishReason = mapped.finishReason;
      if (mapped.usage) usage = mapped.usage;
      if (mapped.terminalError) throw terminalError(ev, options.config.model);
    }
    // 节流（复审提示项 · H4 验收 §8-1）：有事件时也按 ~66ms 节奏轮询，
    // 事件流量 ≤15/s——主线程事件循环保护（400 TPS 上游由 .NET 缓冲摊平）
    if (result.events.length > 0) await new Promise((r) => setTimeout(r, 66));
    if (result.final) break;
  }

  if (signal.aborted) throw new Error("E_SOUL_ONLY_CANCELLED");

  const toolCalls: ToolCall[] = [...toolAcc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => ({ id: v.id, name: v.name, arguments: v.arguments }));

  const assistantMessage: ChatMessage = {
    role: "assistant",
    content: text,
    ...(thinking ? { thinking } : {}),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  };
  return {
    assistantMessage,
    text,
    ...(thinking ? { thinking } : {}),
    toolCalls,
    finishReason,
    raw: { viaLlmHost: true, jobId },
    ...(usage ? { usage } : {}),
  };
}

type Translated = {
  text?: string;
  thinking?: string;
  finishReason?: string;
  usage?: ChatResponse["usage"];
  terminalError?: boolean;
};

function translate(
  ev: LlmHostEvent,
  onDelta: LlmHostCallOptions["onDelta"],
  onRetryStatus: LlmHostCallOptions["onRetryStatus"],
  toolAcc: Map<number, { id: string; name: string; arguments: string }>,
): Translated {
  switch (ev.type) {
    case LLM_EVENTS.delta:
      if (ev.text) onDelta({ type: "text_delta", delta: ev.text });
      return { text: ev.text ?? undefined };
    case LLM_EVENTS.reasoningDelta:
      if (ev.text) onDelta({ type: "reasoning_delta", delta: ev.text });
      return { thinking: ev.text ?? undefined };
    case LLM_EVENTS.toolCallsDelta: {
      // OpenAI tool_calls 流式聚合：index 对齐，id/name 首块赋值，arguments 逐块拼接
      if (Array.isArray(ev.calls)) {
        for (const raw of ev.calls) {
          const c = raw as { index?: number; id?: string; function?: { name?: string; arguments?: string } };
          const idx = typeof c.index === "number" ? c.index : 0;
          const slot = toolAcc.get(idx) ?? { id: c.id ?? `call_${idx}`, name: c.function?.name ?? "", arguments: "" };
          if (c.id) slot.id = c.id;
          if (c.function?.name) slot.name = c.function.name;
          if (c.function?.arguments) slot.arguments += c.function.arguments;
          toolAcc.set(idx, slot);
        }
      }
      return {};
    }
    case LLM_EVENTS.usage:
      return {
        usage: {
          input: ev.inputTokens ?? 0,
          output: ev.outputTokens ?? 0,
          ...(ev.cachedInputTokens ? { cachedInput: ev.cachedInputTokens } : {}),
        },
      };
    case LLM_EVENTS.finish:
      return { finishReason: ev.reason ?? "stop" };
    case LLM_EVENTS.retry:
      onRetryStatus?.({
        phase: "waiting",
        retryNumber: ev.attempt ?? 1,
        maxRetries: 3,
        delayMs: ev.delayMs ?? 0,
        category: (ev.category ?? "UNKNOWN") as ModelRetryStatus["category"],
      });
      return {};
    case LLM_EVENTS.error:
      return { terminalError: true };
    case LLM_EVENTS.done:
      return {};
    default:
      return {};
  }
}

function terminalError(ev: LlmHostEvent, model: string): AgentRuntimeError {
  const message = ev.message ?? "llm-host 作业失败";
  return new AgentRuntimeError("E_MODEL_REQUEST_FAILED", `[${ev.code ?? "E_LLM_HOST_ERROR"}] ${message}`, {
    modelFailure: {
      provider: "llm-host",
      model,
      category: "SERVER_ERROR", // ModelFailureInfo 合法枚举（复审提示项；原 "PROVIDER"/无 model 不合规）
    },
  });
}

function hostLost(err: unknown, phase: string): AgentRuntimeError {
  return new AgentRuntimeError("E_LLM_HOST_LOST", `llm-host ${phase} 失败: ${err instanceof Error ? err.message : String(err)}`, {
    cause: err,
  });
}

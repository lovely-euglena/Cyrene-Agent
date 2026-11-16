export type UnifiedStreamDelta =
  | { type: "reasoning_delta"; delta: string }
  | { type: "text_delta"; delta: string }
  | { type: "tool_call_start"; index: number; id?: string; nameDelta?: string }
  | { type: "tool_call_arguments_delta"; index: number; id?: string; delta: string }
  | { type: "tool_call_end"; index: number; id?: string }
  | { type: "usage"; inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; cacheCreationTokens?: number }
  | { type: "finish"; reason: string }
  | { type: "refusal"; reason?: string }
  /**
   * 服务端托管工具往返块（DeepSeek 全家桶 API；issue #253）。
   * 服务端产生 server_tool_use（如 read_link）并可能附带 signature——
   * signature 是服务端搜索上下文的续接凭证，多轮必须**原样回传**。
   * 形态按 OpenAI 兼容流推测，真网首测后校准字段名（10-25 铁律）。
   */
  | {
      type: "server_tool_call";
      callId?: string;
      tool: string;
      input?: unknown;
      signature?: string;
    };

export interface StreamAccumulatorSnapshot {
  text: string;
  thinking?: string;
  serverToolCalls: ReadonlyArray<{ callId?: string; tool: string; input?: unknown; signature?: string }>;
  toolCalls: ReadonlyArray<{
    index: number;
    id?: string;
    name: string;
    arguments: string;
    ended: boolean;
  }>;
  finishReason?: string;
  refusal?: string;
  usage?: { input: number; output: number; cachedInput?: number; cacheCreation?: number };
}

export interface StreamDiagnostic {
  code: "E_STREAM_TERMINAL_MISMATCH";
  transport: "anthropic";
  differences: string[];
  live: {
    text_length: number;
    reasoning_length: number;
    tool_call_ids: string[];
  };
  terminal: {
    text_length: number;
    reasoning_length: number;
    tool_call_ids: string[];
  };
}

export type ProviderProtocolErrorCode =
  | "E_TOOL_CALL_ID_CHANGED"
  | "E_TOOL_CALL_INCOMPLETE"
  | "E_STREAM_TERMINAL_MISMATCH"
  | "E_UNSUPPORTED_STREAM_EVENT";

export class ProviderProtocolError extends Error {
  constructor(
    readonly code: ProviderProtocolErrorCode,
    message: string,
    readonly providerDetails?: { vendorCode?: string; vendorType?: string; status?: number; requestId?: string },
  ) {
    super(message);
    this.name = "ProviderProtocolError";
  }
}

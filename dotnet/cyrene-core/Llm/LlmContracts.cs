namespace CyreneNative.Llm;

/// <summary>
/// llm-host 线协议契约（H0 契约冻结）。
///
/// TS 侧事实镜像：src/main/dotnet-backend/llm-host-protocol.ts（契约一致性由
/// llm-contract.test.ts 扫描本文件锁定——两侧任一改动都必须同批同步，否则 CI 红）。
///
/// 传输：stdio JSON 行（与 --ssh-host / --tool-host 同构）；长轮询帧由
/// Task.Run 承载，读帧线程永不阻塞（StorageHost 先例）。
///
/// 帧（宿主 → native）：
///   {"op":"ready"}
///   → {"op":"llm.submit","callId":"c1","lane":"interactive|normal|low",
///      "endpoint":"https://…/chat/completions","method":"POST",
///      "auth":{"vaultKey":"model:provider:MiniMax…","style":"bearer|raw"},
///      "headers":{"Content-Type":"application/json",…非鉴权头…},
///      "body":"{…完整 wire 请求体（TS 塑形，去鉴权）…}",
///      "protocol":"openai","timeoutMs":180000,"maxRetries":3,"idleTimeoutMs":45000}
///   → {"op":"llm.poll","callId":"c2","jobId":"j1","cursor":0,"maxEvents":200,"waitMs":5000}
///   → {"op":"llm.cancel","callId":"c3","jobId":"j1"}
///   → {"op":"llm.status"}
///   → {"op":"shutdown"}
/// 帧（native → 宿主）：
///   ← {"op":"ready"}
///   ← {"op":"result","callId","ok":true,"data":…} / {"op":"result","callId","ok":false,"error":{code,message}}
///   （MVP 纯 poll 拉取，无推送帧；retry/done/error 终态经 poll 事件下发）
///
/// 事件（event.type，LlmEvent）：
///   delta            {"type":"delta","text":…}                  文本增量
///   reasoning_delta  {"type":"reasoning_delta","text":…}        思考增量
///   tool_calls_delta {"type":"tool_calls_delta","calls":[{index,id,name,argsDelta}]}
///   usage            {"type":"usage","inputTokens":…,"outputTokens":…,"cachedInputTokens":…}
///   finish           {"type":"finish","reason":"stop|length|tool_calls|…"}
///   retry            {"type":"retry","attempt":1,"delayMs":3000,"category":"RATE_LIMIT"}
///   error            {"type":"error","code":"E_LLM_HTTP_500","message":…,"retryable":false}
///   done             {"type":"done"}                            终态（成功收口）
///
/// 错误码（result.error.code / error 事件 code）：
///   E_LLM_HOST_AUTH_MISSING   vault 中无该 vaultKey（密钥库未迁移/被清）
///   E_LLM_HOST_BAD_REQUEST    帧缺字段 / body 非法 JSON
///   E_LLM_HOST_JOB_MISSING    jobId 不存在（过期/宿主重启）
///   E_LLM_HOST_LANE_FULL      low 通道积压超上限
///   E_LLM_HOST_SECRET_UNAVAILABLE  密钥保护器不可用（DPAPI 故障）
///   E_LLM_HTTP_<status>       上游 HTTP 非法状态（透传，如 E_LLM_HTTP_401）
///   E_LLM_HTTP_0              网络层失败（连接/超时/流中断）
///   E_LLM_IDLE_TIMEOUT        上游静默超限
///   E_LLM_CANCELLED           用户取消
///   E_LLM_TRUNCATED           反压溢出（ring 满，上游不可暂停）
///
/// 重试语义（与 TS model-retry-runner 对齐）：
///   首个可见增量（delta/reasoning_delta/tool_calls_delta）到达前失败
///   → 可重试（429/5xx/网络/超时），退避 1s,2s,4s…cap 30s 或 retry-after；
///   有增量后失败 → 终态 error，不重放（副作用不可见性由 TS 保证）。
/// </summary>
public static class LlmContracts
{
    // ── op 常量（TS 契约扫描锚点，勿改字面量） ──
    public const string OpReady = "ready";
    public const string OpSubmit = "llm.submit";
    public const string OpPoll = "llm.poll";
    public const string OpCancel = "llm.cancel";
    public const string OpStatus = "llm.status";
    public const string OpShutdown = "shutdown";
    public const string OpResult = "result";

    // ── 事件类型 ──
    public const string EvDelta = "delta";
    public const string EvReasoningDelta = "reasoning_delta";
    public const string EvToolCallsDelta = "tool_calls_delta";
    public const string EvUsage = "usage";
    public const string EvFinish = "finish";
    public const string EvRetry = "retry";
    public const string EvError = "error";
    public const string EvDone = "done";

    // ── lane 名 ──
    public const string LaneInteractive = "interactive";
    public const string LaneNormal = "normal";
    public const string LaneLow = "low";

    // ── 错误码 ──
    public const string ErrAuthMissing = "E_LLM_HOST_AUTH_MISSING";
    public const string ErrBadRequest = "E_LLM_HOST_BAD_REQUEST";
    public const string ErrJobMissing = "E_LLM_HOST_JOB_MISSING";
    public const string ErrLaneFull = "E_LLM_HOST_LANE_FULL";
    public const string ErrSecretUnavailable = "E_LLM_HOST_SECRET_UNAVAILABLE";
    public const string ErrHttpPrefix = "E_LLM_HTTP_";
    public const string ErrHttpNetwork = "E_LLM_HTTP_0";
    public const string ErrIdleTimeout = "E_LLM_IDLE_TIMEOUT";
    public const string ErrCancelled = "E_LLM_CANCELLED";
    public const string ErrTruncated = "E_LLM_TRUNCATED";
}

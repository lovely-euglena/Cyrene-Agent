using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using CyreneNative.Tools;

namespace CyreneNative.Agents;

/// <summary>
/// 循环内可恢复错误（LLM 层/参数层）——映射为 final 帧的 code 与退出码。
/// 工具层错误不走这里：归一为 tool_result 帧（ok=false），不让单个工具失败打断循环。
/// </summary>
internal sealed class AgentLoopException : Exception
{
    public string Code { get; }
    public AgentLoopException(string code, string message) : base(message) => Code = code;
}

/// <summary>
/// 纯后端 Agent 循环测试版（cyrene-native --agent-loop）。
///
/// 无 Electron / 窗口 / AGUI 依赖：LLM function-calling while 循环整体跑在
/// 本进程里，把循环语义（工具分发、错误归一、轮次/超时/重试、退出码）
/// 当作可独立验证的测试对象。
/// **它是测试版，不是生产路径**——生产单会话循环仍是 TS CyreneHarness
/// （见 docs/design/2026-09-26-agent-orchestration-plan-b.md）。
///
/// 用法：
///   cyrene-native --agent-loop --base-url http://127.0.0.1:PORT/v1 --model mock \
///     --prompt "6*7 等于几" [--api-key k] [--system s] [--max-rounds 8] \
///     [--timeout-ms 60000] [--retries 0] [--tools none]
///   环境变量回退：CYRENE_LOOP_BASE_URL / CYRENE_LOOP_MODEL / CYRENE_LOOP_API_KEY
///
/// 输出（stdout，stdio JSON 行，与 --tool-host 同风格；诊断走 log 帧/stderr）：
///   ← {"op":"ready","model","url","maxRounds","tools":[...]}
///   ← {"op":"round","round","messageCount"}
///   ← {"op":"llm_request","round","attempt","url","bytes"}
///   ← {"op":"assistant","round","content","toolCalls":[...],"finishReason"}
///   ← {"op":"tool_start"/"tool_result","round","callId","name",...}
///   ← {"op":"final","status":"success|llm_error|max_rounds|cancelled",
///       "finalAnswer?","code?","error?","rounds","toolCalls","usage?"}
///   ← {"op":"error","code":"E_USAGE",...}   ← 参数错误
///   ← {"op":"log","level":"info|warn|error","message"}
///
/// 退出码：0 成功 / 1 错误（含超时与用户中断）/ 2 参数用法错误 / 3 轮次耗尽。
///
/// 工具集（只读安全子集，进程内直调 --tool-host 的同一实现）：
///   calculator / now / sysinfo / clipboard(仅读) / fs_read_file / fs_list_dir
///   ——git、fs_write_file、clipboard 写被有意排除（测试版不做副作用）。
/// </summary>
internal static class AgentLoop
{
    // ── 退出码契约（smoke 按此断言）────────────────────────────
    private const int ExitSuccess = 0;
    private const int ExitError = 1;
    private const int ExitUsage = 2;
    private const int ExitMaxRounds = 3;

    private const int DefaultMaxRounds = 8;
    private const int DefaultTimeoutMs = 60_000;
    /// <summary>单个工具结果回注模型的字符上限（超出加截断标记）。</summary>
    private const int ToolResultMaxChars = 16_384;
    private const int RetryBackoffBaseMs = 150;

    /// <summary>请求体序列化选项：Web 命名（与协议帧一致）+ NaN/Infinity → null。</summary>
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        Converters = { new SafeDoubleJsonConverter() },
    };

    private sealed class LoopOptions
    {
        public string BaseUrl = "";
        public string ApiKey = "";
        public string Model = "";
        public string Prompt = "";
        public string SystemPrompt = "";
        public int MaxRounds = DefaultMaxRounds;
        public int TimeoutMs = DefaultTimeoutMs;
        public int Retries;
        public bool ToolsEnabled = true;
    }

    private sealed record LoopTool(string Name, string Description, JsonElement Parameters);

    private sealed record ParsedToolCall(string Id, string Name, string Arguments, bool IdSynthesized);

    private sealed record LlmResponse(string? Content, string? FinishReason, List<ParsedToolCall> ToolCalls, JsonElement? Usage);

    private sealed record ToolOutcome(bool Ok, string Content, string? ErrorCode, bool Truncated);

    public static async Task<int> Run(string[] args)
    {
        var stdout = Console.OpenStandardOutput();
        var ioLock = new SemaphoreSlim(1, 1);
        void Emit(object frame) => ToolHost.WriteFrame(stdout, ioLock, frame);

        LoopOptions options;
        try { options = ParseArgs(args); }
        catch (AgentLoopException ex)
        {
            Emit(new { op = "error", code = ex.Code, message = ex.Message });
            return ExitUsage;
        }
        if (!Uri.TryCreate(BuildChatUrl(options.BaseUrl), UriKind.Absolute, out var chatUri)
            || (chatUri.Scheme != Uri.UriSchemeHttp && chatUri.Scheme != Uri.UriSchemeHttps))
        {
            Emit(new { op = "error", code = "E_USAGE", message = $"--base-url 不是合法的 http(s) 地址: {options.BaseUrl}" });
            return ExitUsage;
        }
        return await RunAsync(options, Emit);
    }

    // ── 参数解析 ─────────────────────────────────────────────

    private static LoopOptions ParseArgs(string[] args)
    {
        var options = new LoopOptions
        {
            BaseUrl = Environment.GetEnvironmentVariable("CYRENE_LOOP_BASE_URL") ?? "",
            ApiKey = Environment.GetEnvironmentVariable("CYRENE_LOOP_API_KEY") ?? "",
            Model = Environment.GetEnvironmentVariable("CYRENE_LOOP_MODEL") ?? "",
        };
        for (var i = 0; i < args.Length; i++)
        {
            var key = args[i];
            string NextValue()
            {
                if (i + 1 >= args.Length) throw new AgentLoopException("E_USAGE", $"参数 {key} 缺少取值");
                return args[++i];
            }
            switch (key)
            {
                case "-h":
                case "--help":
                    throw new AgentLoopException("E_USAGE", UsageText());
                case "--base-url": options.BaseUrl = NextValue(); break;
                case "--api-key": options.ApiKey = NextValue(); break;
                case "--model": options.Model = NextValue(); break;
                case "--prompt": options.Prompt = NextValue(); break;
                case "--system": options.SystemPrompt = NextValue(); break;
                case "--max-rounds": options.MaxRounds = ParseBoundedInt(key, NextValue(), 1, 64); break;
                case "--timeout-ms": options.TimeoutMs = ParseBoundedInt(key, NextValue(), 100, 600_000); break;
                case "--retries": options.Retries = ParseBoundedInt(key, NextValue(), 0, 5); break;
                case "--tools": options.ToolsEnabled = !string.Equals(NextValue(), "none", StringComparison.OrdinalIgnoreCase); break;
                default:
                    throw new AgentLoopException("E_USAGE", $"未知参数: {key}\n{UsageText()}");
            }
        }
        if (options.BaseUrl.Length == 0)
            throw new AgentLoopException("E_USAGE", "--base-url 必填（或环境变量 CYRENE_LOOP_BASE_URL）");
        if (options.Model.Length == 0)
            throw new AgentLoopException("E_USAGE", "--model 必填（或环境变量 CYRENE_LOOP_MODEL）");
        if (options.Prompt.Length == 0)
            throw new AgentLoopException("E_USAGE", "--prompt 必填");
        return options;
    }

    private static int ParseBoundedInt(string key, string raw, int min, int max)
    {
        if (!int.TryParse(raw, out var value) || value < min || value > max)
            throw new AgentLoopException("E_USAGE", $"{key} 取值必须是 {min}-{max} 的整数（收到: {raw}）");
        return value;
    }

    private static string UsageText() =>
        "用法: cyrene-native --agent-loop --base-url <url> --model <id> --prompt <text> " +
        "[--api-key k] [--system s] [--max-rounds 1-64] [--timeout-ms 100-600000] [--retries 0-5] [--tools none]";

    // ── 主循环 ───────────────────────────────────────────────

    private static async Task<int> RunAsync(LoopOptions options, Action<object> emit)
    {
        using var http = new HttpClient { Timeout = System.Threading.Timeout.InfiniteTimeSpan };
        using var lifetime = new CancellationTokenSource();
        Console.CancelKeyPress += (_, e) => { e.Cancel = true; lifetime.Cancel(); };

        var url = BuildChatUrl(options.BaseUrl);
        var tools = options.ToolsEnabled ? LoopToolCatalog.All : LoopToolCatalog.None;
        emit(new
        {
            op = "ready",
            model = options.Model,
            url,
            maxRounds = options.MaxRounds,
            retries = options.Retries,
            tools = tools.Select(tool => tool.Name).ToArray(),
        });

        var messages = new List<Dictionary<string, object>>();
        if (options.SystemPrompt.Length > 0) messages.Add(Msg("system", options.SystemPrompt));
        messages.Add(Msg("user", options.Prompt));

        var rounds = 0;
        var totalToolCalls = 0;
        var sawUsage = false;
        long usagePrompt = 0, usageCompletion = 0, usageTotal = 0;

        try
        {
            for (var round = 1; round <= options.MaxRounds; round++)
            {
                rounds = round;
                emit(new { op = "round", round, messageCount = messages.Count });

                var response = await CallLLMAsync(http, url, options, messages, tools, emit, round, lifetime.Token);
                if (response.Usage is { } usageElement)
                {
                    sawUsage = true;
                    usagePrompt += ReadUsageLong(usageElement, "prompt_tokens");
                    usageCompletion += ReadUsageLong(usageElement, "completion_tokens");
                    usageTotal += ReadUsageLong(usageElement, "total_tokens");
                }

                var calls = response.ToolCalls;
                emit(new
                {
                    op = "assistant",
                    round,
                    content = response.Content,
                    toolCalls = calls.Select(call => new
                    {
                        id = call.Id,
                        name = call.Name,
                        arguments = call.Arguments,
                        synthesizedId = call.IdSynthesized,
                    }).ToArray(),
                    finishReason = response.FinishReason,
                });
                foreach (var synthesized in calls.Where(call => call.IdSynthesized))
                {
                    emit(new { op = "log", level = "warn", message = $"tool_call 缺 id，已合成 {synthesized.Id}（name={synthesized.Name}）" });
                }

                if (calls.Count == 0)
                {
                    if (response.Content is null)
                        emit(new { op = "log", level = "warn", message = "assistant.content 为空且无 tool_calls，按空回答收口" });
                    emit(new
                    {
                        op = "final",
                        status = "success",
                        finalAnswer = response.Content ?? "",
                        rounds,
                        toolCalls = totalToolCalls,
                        usage = BuildUsage(sawUsage, usagePrompt, usageCompletion, usageTotal),
                    });
                    return ExitSuccess;
                }

                // assistant 轮次必须带 tool_calls 进历史，随后逐个回 tool 结果
                messages.Add(AssistantMessage(response.Content, calls));
                foreach (var call in calls)
                {
                    totalToolCalls++;
                    emit(new { op = "tool_start", round, callId = call.Id, name = call.Name });
                    var stopwatch = Stopwatch.StartNew();
                    var outcome = ExecuteTool(call);
                    stopwatch.Stop();
                    emit(new
                    {
                        op = "tool_result",
                        round,
                        callId = call.Id,
                        name = call.Name,
                        ok = outcome.Ok,
                        ms = stopwatch.ElapsedMilliseconds,
                        errorCode = outcome.ErrorCode,
                        contentLength = outcome.Content.Length,
                        truncated = outcome.Truncated,
                        preview = Truncate(outcome.Content, 400),
                    });
                    messages.Add(new Dictionary<string, object>
                    {
                        ["role"] = "tool",
                        ["tool_call_id"] = call.Id,
                        ["content"] = outcome.Content,
                    });
                }
            }

            emit(new
            {
                op = "final",
                status = "max_rounds",
                rounds,
                toolCalls = totalToolCalls,
                usage = BuildUsage(sawUsage, usagePrompt, usageCompletion, usageTotal),
            });
            return ExitMaxRounds;
        }
        catch (AgentLoopException ex)
        {
            emit(new
            {
                op = "final",
                status = "llm_error",
                code = ex.Code,
                error = ex.Message,
                rounds,
                toolCalls = totalToolCalls,
                usage = BuildUsage(sawUsage, usagePrompt, usageCompletion, usageTotal),
            });
            return ExitError;
        }
        catch (OperationCanceledException)
        {
            emit(new { op = "final", status = "cancelled", code = "E_CANCELLED", error = "用户中断", rounds, toolCalls = totalToolCalls });
            return ExitError;
        }
        catch (Exception ex)
        {
            emit(new { op = "final", status = "llm_error", code = "E_UNEXPECTED", error = ex.Message, rounds, toolCalls = totalToolCalls });
            return ExitError;
        }
    }

    // ── LLM 调用 ─────────────────────────────────────────────

    /// <summary>拼 /chat/completions：baseUrl 已带后缀则原样使用（与 TS api-endpoint 同语义）。</summary>
    private static string BuildChatUrl(string baseUrl)
    {
        var trimmed = baseUrl.TrimEnd('/');
        if (trimmed.EndsWith("/chat/completions", StringComparison.OrdinalIgnoreCase)) return trimmed;
        return trimmed + "/chat/completions";
    }

    private static async Task<LlmResponse> CallLLMAsync(
        HttpClient http,
        string url,
        LoopOptions options,
        List<Dictionary<string, object>> messages,
        LoopTool[] tools,
        Action<object> emit,
        int round,
        CancellationToken lifetime)
    {
        var bodyJson = JsonSerializer.Serialize(BuildPayload(options, messages, tools), JsonOptions);
        var attempt = 0;
        while (true)
        {
            attempt++;
            emit(new { op = "llm_request", round, attempt, url, bytes = bodyJson.Length });

            using var requestCts = CancellationTokenSource.CreateLinkedTokenSource(lifetime);
            requestCts.CancelAfter(options.TimeoutMs);
            try
            {
                using var request = new HttpRequestMessage(HttpMethod.Post, url)
                {
                    Content = new StringContent(bodyJson, Encoding.UTF8, "application/json"),
                };
                if (options.ApiKey.Length > 0)
                    request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", options.ApiKey);

                using var response = await http.SendAsync(request, HttpCompletionOption.ResponseContentRead, requestCts.Token);
                var text = await response.Content.ReadAsStringAsync(requestCts.Token);

                if (!response.IsSuccessStatusCode)
                {
                    var code = (int)response.StatusCode;
                    if (IsRetryable(response.StatusCode) && attempt <= options.Retries)
                    {
                        var backoff = RetryBackoffBaseMs * attempt;
                        emit(new { op = "log", level = "warn", message = $"LLM HTTP {code}，{backoff}ms 后重试（第 {attempt} 次失败，允许 {options.Retries} 次）" });
                        await Task.Delay(backoff, lifetime);
                        continue;
                    }
                    throw new AgentLoopException("E_LLM_HTTP", $"LLM HTTP {code}: {Truncate(text, 300)}");
                }

                return ParseResponse(text, round);
            }
            catch (OperationCanceledException) when (!lifetime.IsCancellationRequested)
            {
                throw new AgentLoopException("E_LLM_TIMEOUT", $"LLM 请求超时（{options.TimeoutMs}ms）");
            }
        }
    }

    private static bool IsRetryable(HttpStatusCode status)
        => status is HttpStatusCode.TooManyRequests
            or HttpStatusCode.InternalServerError
            or HttpStatusCode.BadGateway
            or HttpStatusCode.ServiceUnavailable
            or HttpStatusCode.GatewayTimeout;

    private static Dictionary<string, object> BuildPayload(LoopOptions options, List<Dictionary<string, object>> messages, LoopTool[] tools)
    {
        var payload = new Dictionary<string, object>
        {
            ["model"] = options.Model,
            ["messages"] = messages,
            ["stream"] = false,
        };
        if (tools.Length > 0)
        {
            payload["tools"] = tools.Select(tool => new Dictionary<string, object>
            {
                ["type"] = "function",
                ["function"] = new Dictionary<string, object>
                {
                    ["name"] = tool.Name,
                    ["description"] = tool.Description,
                    ["parameters"] = tool.Parameters,
                },
            }).ToArray();
        }
        return payload;
    }

    private static LlmResponse ParseResponse(string text, int round)
    {
        JsonDocument doc;
        try { doc = JsonDocument.Parse(text); }
        catch (JsonException ex)
        {
            throw new AgentLoopException("E_LLM_PARSE", $"LLM 响应不是合法 JSON: {ex.Message}｜正文片段: {Truncate(text, 200)}");
        }

        using (doc)
        {
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object
                || !root.TryGetProperty("choices", out var choices)
                || choices.ValueKind != JsonValueKind.Array)
            {
                throw new AgentLoopException("E_LLM_EMPTY", $"LLM 响应缺少 choices 数组｜正文片段: {Truncate(text, 200)}");
            }

            JsonElement firstChoice = default;
            var hasChoice = false;
            foreach (var choice in choices.EnumerateArray()) { firstChoice = choice; hasChoice = true; break; }
            if (!hasChoice)
                throw new AgentLoopException("E_LLM_EMPTY", "LLM 响应 choices 为空数组");

            if (firstChoice.ValueKind != JsonValueKind.Object
                || !firstChoice.TryGetProperty("message", out var message)
                || message.ValueKind != JsonValueKind.Object)
            {
                throw new AgentLoopException("E_LLM_EMPTY", $"LLM 响应缺少 choices[0].message｜正文片段: {Truncate(text, 200)}");
            }

            // content：string / null 都合法；其它类型兜底取原文（容错非标准端点）
            string? content = null;
            if (message.TryGetProperty("content", out var contentEl))
            {
                content = contentEl.ValueKind switch
                {
                    JsonValueKind.String => contentEl.GetString(),
                    JsonValueKind.Null or JsonValueKind.Undefined => null,
                    _ => contentEl.GetRawText(),
                };
            }

            var finishReason = firstChoice.TryGetProperty("finish_reason", out var fr) && fr.ValueKind == JsonValueKind.String
                ? fr.GetString()
                : null;

            var calls = new List<ParsedToolCall>();
            if (message.TryGetProperty("tool_calls", out var toolCalls) && toolCalls.ValueKind == JsonValueKind.Array)
            {
                var index = 0;
                foreach (var item in toolCalls.EnumerateArray())
                {
                    index++;
                    if (item.ValueKind != JsonValueKind.Object) continue;
                    var id = item.TryGetProperty("id", out var idEl) && idEl.ValueKind == JsonValueKind.String
                        ? idEl.GetString()
                        : null;
                    var fn = item.TryGetProperty("function", out var fnEl) ? fnEl : default;
                    var name = fn.ValueKind == JsonValueKind.Object && fn.TryGetProperty("name", out var nameEl)
                        ? nameEl.GetString() ?? ""
                        : "";
                    var arguments = "";
                    if (fn.ValueKind == JsonValueKind.Object && fn.TryGetProperty("arguments", out var argsEl))
                    {
                        // 标准是 JSON 字符串；容错 object/array 直接取原文
                        arguments = argsEl.ValueKind switch
                        {
                            JsonValueKind.String => argsEl.GetString() ?? "",
                            JsonValueKind.Null or JsonValueKind.Undefined => "",
                            _ => argsEl.GetRawText(),
                        };
                    }
                    var synthesized = string.IsNullOrEmpty(id);
                    calls.Add(new ParsedToolCall(synthesized ? $"call_r{round}_{index}" : id!, name, arguments, synthesized));
                }
            }

            var usage = root.TryGetProperty("usage", out var usageEl) && usageEl.ValueKind == JsonValueKind.Object
                ? usageEl.Clone()
                : (JsonElement?)null;

            return new LlmResponse(content, finishReason, calls, usage);
        }
    }

    // ── 工具执行 ─────────────────────────────────────────────

    private static ToolOutcome ExecuteTool(ParsedToolCall call)
    {
        JsonElement? args;
        try { args = ParseToolArgs(call.Arguments); }
        catch (AgentLoopException ex) { return new ToolOutcome(false, $"[{ex.Code}] {ex.Message}", ex.Code, false); }

        try
        {
            var result = call.Name switch
            {
                "calculator" => Calculator.Evaluate(args),
                "now" => NowTool.Execute(args),
                "sysinfo" => SysInfo.Execute(),
                "clipboard" => ClipboardReadOnly(args),
                "fs_read_file" => FsTools.ReadFile(args ?? LoopToolCatalog.EmptyArgs),
                "fs_list_dir" => FsTools.ListDir(args ?? LoopToolCatalog.EmptyArgs),
                _ => throw new ToolHostException("E_UNKNOWN_TOOL", $"未知工具: {call.Name}"),
            };
            var content = result switch
            {
                null => "null",
                string text => text,
                _ => JsonSerializer.Serialize(result, result.GetType(), JsonOptions),
            };
            var truncated = content.Length > ToolResultMaxChars;
            return new ToolOutcome(
                true,
                truncated ? Truncate(content, ToolResultMaxChars) : content,
                null,
                truncated);
        }
        catch (ToolHostException ex)
        {
            return new ToolOutcome(false, $"[{ex.Code}] {ex.Message}", ex.Code, false);
        }
        catch (Exception ex)
        {
            return new ToolOutcome(false, $"[E_TOOL_FAILED] {ex.Message}", "E_TOOL_FAILED", false);
        }
    }

    private static JsonElement? ParseToolArgs(string arguments)
    {
        if (string.IsNullOrWhiteSpace(arguments)) return null;
        JsonDocument doc;
        try { doc = JsonDocument.Parse(arguments); }
        catch (JsonException ex) { throw new AgentLoopException("E_BAD_ARGS", $"arguments 不是合法 JSON: {ex.Message}"); }
        using (doc)
        {
            if (doc.RootElement.ValueKind != JsonValueKind.Object)
                throw new AgentLoopException("E_BAD_ARGS", $"arguments 必须是 JSON 对象（收到 {doc.RootElement.ValueKind}）");
            return doc.RootElement.Clone();
        }
    }

    /// <summary>clipboard 只读守卫：测试版禁写，避免冒烟污染用户剪贴板。</summary>
    private static object ClipboardReadOnly(JsonElement? args)
    {
        var action = args?.TryGetProperty("action", out var actionEl) == true && actionEl.ValueKind == JsonValueKind.String
            ? actionEl.GetString()
            : "read";
        if (string.Equals(action, "write", StringComparison.OrdinalIgnoreCase))
            throw new ToolHostException("E_READONLY_TOOL", "测试版循环禁用剪贴板写入");
        return ClipboardTool.Execute(args);
    }

    // ── 工具目录（只读安全子集）────────────────────────────────

    private static class LoopToolCatalog
    {
        public static readonly LoopTool[] None = Array.Empty<LoopTool>();

        public static readonly LoopTool[] All =
        {
            new("calculator", "数学表达式求值（优先级/幂/白名单函数/常量，无 eval）",
                Schema("""{"type":"object","properties":{"expression":{"type":"string","description":"表达式，如 sqrt(6*7)、2^10+abs(-3)"}},"required":["expression"],"additionalProperties":false}""")),
            new("now", "当前时间（时区感知）",
                Schema("""{"type":"object","properties":{"format":{"type":"string","enum":["default","iso","epoch"]}},"additionalProperties":false}""")),
            new("sysinfo", "系统信息快照（OS/CPU/内存/进程运行时长）",
                Schema("""{"type":"object","properties":{},"additionalProperties":false}""")),
            new("clipboard", "读取系统剪贴板文本（测试版仅支持读）",
                Schema("""{"type":"object","properties":{"action":{"type":"string","enum":["read"]}},"additionalProperties":false}""")),
            new("fs_read_file", "读取文本文件（绝对路径，可指定行窗口）",
                Schema("""{"type":"object","properties":{"path":{"type":"string","description":"绝对路径"},"startLine":{"type":"integer"},"maxLines":{"type":"integer"}},"required":["path"],"additionalProperties":false}""")),
            new("fs_list_dir", "列出目录（绝对路径）",
                Schema("""{"type":"object","properties":{"path":{"type":"string","description":"绝对路径"},"filter":{"type":"string"},"showHidden":{"type":"boolean"}},"required":["path"],"additionalProperties":false}""")),
        };

        /// <summary>args 缺失时给 fs 工具的空对象（避免 Undefined JsonElement 上探属性崩溃）。</summary>
        public static readonly JsonElement EmptyArgs = JsonDocument.Parse("{}").RootElement.Clone();

        private static JsonElement Schema(string json) => JsonDocument.Parse(json).RootElement.Clone();
    }

    // ── 小工具函数 ───────────────────────────────────────────

    private static Dictionary<string, object> Msg(string role, string content)
        => new() { ["role"] = role, ["content"] = content };

    private static Dictionary<string, object> AssistantMessage(string? content, List<ParsedToolCall> calls)
    {
        var message = new Dictionary<string, object>
        {
            ["role"] = "assistant",
            // content 给空串而非 null：部分 OpenAI 兼容端点对 null 严格校验
            ["content"] = content ?? "",
            ["tool_calls"] = calls.Select(call => new Dictionary<string, object>
            {
                ["id"] = call.Id,
                ["type"] = "function",
                ["function"] = new Dictionary<string, object>
                {
                    ["name"] = call.Name,
                    ["arguments"] = call.Arguments,
                },
            }).ToArray(),
        };
        return message;
    }

    private static object? BuildUsage(bool sawUsage, long prompt, long completion, long total)
        => sawUsage ? new { promptTokens = prompt, completionTokens = completion, totalTokens = total } : null;

    private static long ReadUsageLong(JsonElement usage, string name)
        => usage.TryGetProperty(name, out var el) && el.ValueKind == JsonValueKind.Number ? el.GetInt64() : 0;

    private static string Truncate(string text, int max)
        => text.Length <= max ? text : text[..max] + $"…（已截断，共 {text.Length} 字符）";
}

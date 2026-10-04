using System;
using System.Collections.Generic;
using System.IO;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace CyreneNative.Llm;

/// <summary>OpenAI 兼容 SSE 解析结果事件（解析层纯输出，不含重试语义）。</summary>
public sealed class OpenAiWireEvent
{
    public string? TextDelta;          // choices[0].delta.content
    public string? ReasoningDelta;     // choices[0].delta.reasoning_content / reasoning
    public JsonElement? ToolCallsDelta;// choices[0].delta.tool_calls（原样数组）
    public string? FinishReason;       // choices[0].finish_reason
    public JsonElement? Usage;         // usage 对象（include_usage 尾块）
    public JsonElement? WireError;     // body 内 {"error":{…}}——HTTP 200 但业务失败（P1-7：终态）
}

/// <summary>上游 HTTP 失败（带重试判定所需的 status / retry-after；status=0 表示网络层失败）。</summary>
public sealed class OpenAiHttpException : Exception
{
    public int Status { get; }
    public string? RetryAfterMs { get; }
    public string BodyHead { get; }
    /// <summary>流静默超时（idle）——设计 §5.2：可判重试（无可见增量时）或失败。</summary>
    public bool IsIdleTimeout { get; }

    public OpenAiHttpException(int status, string? retryAfterMs, string bodyHead, bool isIdleTimeout = false)
        : base($"HTTP {status}: {(bodyHead.Length > 200 ? bodyHead[..200] : bodyHead)}")
    {
        Status = status; RetryAfterMs = retryAfterMs; BodyHead = bodyHead; IsIdleTimeout = isIdleTimeout;
    }

    /// <summary>
    /// 可重试判定（IKJM7D 复审 P0-9 修复）：408/429/5xx 与网络层失败（status=0）可重试——
    /// 连接失败/流中断/idle 静默均映射为 status=0。
    /// </summary>
    public static bool IsRetryableStatus(int status)
        => status == 0 || status is 408 or 429 or >= 500;
}

/// <summary>
/// OpenAI 兼容 SSE 客户端（手写 HttpClient 流式，无 SDK 依赖；cyrene-core 洁净）。
///
/// 协议事实：data: 行 / [DONE] 收口；EOF 无 [DONE] 亦按成功收口（部分网关不发送，
/// 以 finish_reason/usage 判定完整性）；多行 data: 拼接未实现（OpenAI 兼容族无此场景，注释留痕）。
/// </summary>
public static class OpenAiSseClient
{
    /// <summary>
    /// 一次流式请求：鉴权/头注入后的完整请求（headers 由 service 组装）。
    /// onWire 返回 false → 立即停止读（取消/终态）；网络失败统一转 OpenAiHttpException(0)。
    /// </summary>
    public static async Task StreamOnceAsync(
        HttpClient http, string method, string endpoint, IReadOnlyDictionary<string, string> headers,
        string body, int idleTimeoutMs, Func<OpenAiWireEvent, bool> onWire, CancellationToken ct)
    {
        using var idleCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var ctIdle = idleCts.Token;
        // 下限对齐契约（ParseJob clamp ≥1000；复审 P1-2：连接/响应头阶段 idle 也要可达/可测）
        var idleFloorMs = Math.Max(1_000, idleTimeoutMs);
        idleCts.CancelAfter(TimeSpan.FromMilliseconds(idleFloorMs));

        try
        {
            using var req = new HttpRequestMessage(new HttpMethod(method), endpoint);
            foreach (var (k, v) in headers) req.Headers.TryAddWithoutValidation(k, v);
            req.Content = new StringContent(body, Encoding.UTF8, "application/json");

            using var resp = await http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ctIdle).ConfigureAwait(false);
            if (!resp.IsSuccessStatusCode)
            {
                var errBody = await resp.Content.ReadAsStringAsync(CancellationToken.None).ConfigureAwait(false);
                string? ra = resp.Headers.RetryAfter?.Delta is { } d
                    ? ((long)d.TotalMilliseconds).ToString(System.Globalization.CultureInfo.InvariantCulture) : null;
                throw new OpenAiHttpException((int)resp.StatusCode, ra, errBody);
            }

            await using var stream = await resp.Content.ReadAsStreamAsync(ctIdle).ConfigureAwait(false);
            var reader = new StreamReader(stream, Encoding.UTF8);
            var idleMs = TimeSpan.FromMilliseconds(idleFloorMs);

            while (true)
            {
                string? line;
                try
                {
                    line = await reader.ReadLineAsync(ctIdle).ConfigureAwait(false);
                    idleCts.CancelAfter(idleMs); // 每读到一行重置 idle 计时（「静默超限」而非总时长）
                }
                catch (OperationCanceledException) when (!ct.IsCancellationRequested)
                {
                    throw new OpenAiHttpException(0, null, "流读取超时（idle）", isIdleTimeout: true);
                }
                if (line == null) break; // EOF：OpenAI 流以 [DONE] 或连接关闭收口（按成功）
                if (line.Length == 0) continue; // 事件分隔

                if (!line.StartsWith("data:", StringComparison.Ordinal))
                    continue; // event:/comment/心跳行——OpenAI 协议只认 data:
                var payload = line["data:".Length..].TrimStart();
                if (payload == "[DONE]") break;

                JsonDocument doc;
                try { doc = JsonDocument.Parse(payload); }
                catch (JsonException) { continue; } // 非法 chunk 容错跳过
                using (doc)
                {
                    var wire = MapChunk(doc.RootElement);
                    if (wire != null && !onWire(wire)) return; // 调用方要求停止（取消/终态）
                }
            }
        }
        catch (OpenAiHttpException) { throw; }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            // 复审 P1-2：连接/响应头阶段 idleCts 触发（ct 未取消）→ 归 idle 超时，
            // 由 service 按网络/idle 可重试分类，而不是裸 OCE 落 REQUEST_TIMEOUT
            throw new OpenAiHttpException(0, null, "连接/响应头超时（idle）", isIdleTimeout: true);
        }
        catch (OperationCanceledException) { throw; } // 用户取消/总超时：交由 service 语义处理
        catch (HttpRequestException ex) { throw new OpenAiHttpException(0, null, ex.Message); }       // 网络 → 可重试（P0-9）
        catch (IOException ex) { throw new OpenAiHttpException(0, null, ex.Message); }                // 流中断 → 可重试（P0-9）
    }

    /// <summary>OpenAI chat.completion.chunk → 归一 wire 事件（纯函数）。空串 content 不产 delta（P1-6）。</summary>
    public static OpenAiWireEvent? MapChunk(JsonElement root)
    {
        var ev = new OpenAiWireEvent();
        if (root.ValueKind == JsonValueKind.Object && root.TryGetProperty("error", out var err))
        {
            ev.WireError = err.Clone(); // HTTP 200 内嵌业务错误 → 调用方按终态 error 收口（P1-7）
            return ev;
        }
        if (root.TryGetProperty("usage", out var usage) && usage.ValueKind == JsonValueKind.Object)
            ev.Usage = usage.Clone();
        if (!root.TryGetProperty("choices", out var choices) || choices.ValueKind != JsonValueKind.Array || choices.GetArrayLength() == 0)
            return ev.Usage != null ? ev : null;

        var c0 = choices[0];
        if (c0.ValueKind != JsonValueKind.Object) return ev.Usage != null ? ev : null;
        if (c0.TryGetProperty("finish_reason", out var fr) && fr.ValueKind == JsonValueKind.String)
            ev.FinishReason = fr.GetString();
        if (c0.TryGetProperty("delta", out var delta) && delta.ValueKind == JsonValueKind.Object)
        {
            if (delta.TryGetProperty("content", out var content) && content.ValueKind == JsonValueKind.String
                && content.GetString() is { Length: > 0 } text)
                ev.TextDelta = text;
            // 厂商思考字段两形态：DeepSeek reasoning_content / OpenAI o 系 reasoning
            if (delta.TryGetProperty("reasoning_content", out var rc) && rc.ValueKind == JsonValueKind.String
                && rc.GetString() is { Length: > 0 } t1)
                ev.ReasoningDelta = t1;
            else if (delta.TryGetProperty("reasoning", out var r2) && r2.ValueKind == JsonValueKind.String
                && r2.GetString() is { Length: > 0 } t2)
                ev.ReasoningDelta = t2;
            if (delta.TryGetProperty("tool_calls", out var tc) && tc.ValueKind == JsonValueKind.Array && tc.GetArrayLength() > 0)
                ev.ToolCallsDelta = tc.Clone();
        }
        var interesting = ev.TextDelta != null || ev.ReasoningDelta != null || ev.ToolCallsDelta != null
            || ev.FinishReason != null || ev.Usage != null;
        return interesting ? ev : null;
    }
}

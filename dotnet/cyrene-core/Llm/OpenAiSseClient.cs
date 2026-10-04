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
    public JsonElement? WireError;     // body 内 {"error":{...}}
}

/// <summary>上游 HTTP 失败（带重试判定所需的 status / retry-after）。</summary>
public sealed class OpenAiHttpException : Exception
{
    public int Status { get; }
    public string? RetryAfterMs { get; }
    public string BodyHead { get; }
    public OpenAiHttpException(int status, string? retryAfterMs, string bodyHead)
        : base($"HTTP {status}: {Trunc(bodyHead, 400)}")
    { Status = status; RetryAfterMs = retryAfterMs; BodyHead = bodyHead; }

    internal static string Trunc(string s, int n) => s.Length <= n ? s : s[..n];

    /// <summary>可重试判定：408/429/5xx（与 TS model-error-classifier 对齐；401/403/400 不重试）。</summary>
    public static bool IsRetryableStatus(int status) =>
        status is 408 or 429 || (status >= 500 && status <= 599);
}

/// <summary>
/// OpenAI 兼容协议流式客户端（手写 SSE，无 SDK 依赖——设计 §2：.NET 无 OpenAI 包）。
///
/// 只负责「一次 HTTP 往返的流式解析」：连接、data:/[DONE]、delta 字段抽取、idle 超时。
/// 重试/退避/取消/事件缓冲/鉴权注入是 LlmJobService 的职责（职责分离，服务器版
/// DialogLoop 以纯参数复用本类，无 LlmJob 依赖——依赖倒置口子）。
/// </summary>
public static class OpenAiSseClient
{
    /// <summary>
    /// 流式执行一次请求。onWire 返回 false = 调用方要求中止（反压溢出/取消），
    /// 此时读循环立即退出并返回（HttpClient 流式读挂起即 TCP 反压——ring 高水位暂停的实现基础）。
    /// </summary>
    public static async Task StreamOnceAsync(
        HttpClient http,
        string method,
        string endpoint,
        IReadOnlyDictionary<string, string> headers,
        string body,
        int idleTimeoutMs,
        Func<OpenAiWireEvent, bool> onWire,
        CancellationToken ct)
    {
        using var req = new HttpRequestMessage(new HttpMethod(method), endpoint);
        foreach (var (k, v) in headers)
        {
            // 内容头（Content-Type/Length）不能放 request headers：body 统一 JSON，
            // Content-Type 由 StringContent 固定给出，TS 侧无需传
            if (k.Equals("Content-Type", StringComparison.OrdinalIgnoreCase)) continue;
            if (k.Equals("Content-Length", StringComparison.OrdinalIgnoreCase)) continue;
            req.Headers.TryAddWithoutValidation(k, v);
        }
        req.Content = new StringContent(body, Encoding.UTF8, "application/json");

        using var ctIdle = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var idleMs = TimeSpan.FromMilliseconds(Math.Max(5_000, idleTimeoutMs));
        ctIdle.CancelAfter(idleMs); // 连接/响应头阶段同用 idle 预算

        HttpResponseMessage resp;
        try
        {
            resp = await http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ctIdle.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            throw new OpenAiHttpException(0, null, "连接/响应头超时（idle）");
        }
        using (resp)
        {
            if (!resp.IsSuccessStatusCode)
            {
                var errBody = await resp.Content.ReadAsStringAsync(CancellationToken.None).ConfigureAwait(false);
                string? ra = resp.Headers.RetryAfter?.Delta is { } d
                    ? ((long)d.TotalMilliseconds).ToString(System.Globalization.CultureInfo.InvariantCulture) : null;
                throw new OpenAiHttpException((int)resp.StatusCode, ra, errBody);
            }

            await using var stream = await resp.Content.ReadAsStreamAsync(ctIdle.Token).ConfigureAwait(false);
            var reader = new StreamReader(stream, Encoding.UTF8);

            while (true)
            {
                string? line;
                try
                {
                    line = await reader.ReadLineAsync(ctIdle.Token).ConfigureAwait(false);
                    ctIdle.CancelAfter(idleMs); // 每读到一行重置 idle（「静默超限」而非总时长）
                }
                catch (OperationCanceledException) when (!ct.IsCancellationRequested)
                {
                    throw new OpenAiHttpException(0, null, "流读取超时（idle）");
                }
                if (line == null) break; // EOF：OpenAI 流以 [DONE] 或连接关闭收口
                if (line.Length == 0) continue; // 事件分隔

                if (!line.StartsWith("data:", StringComparison.Ordinal))
                    continue; // event:/comment/心跳行——OpenAI 协议只认 data:
                var payload = line["data:".Length..].TrimStart();
                if (payload == "[DONE]") break;

                JsonDocument doc;
                try { doc = JsonDocument.Parse(payload); }
                catch (JsonException)
                {
                    continue; // 非 JSON 心跳/杂行：与 TS reader 行为一致（跳过）
                }
                using (doc)
                {
                    var ev = MapChunk(doc.RootElement);
                    if (ev != null && !onWire(ev))
                        return; // 调用方中止（反压/取消）
                }
            }
        }
    }

    /// <summary>OpenAI chat.completion.chunk → 归一 wire 事件（纯函数）。</summary>
    public static OpenAiWireEvent? MapChunk(JsonElement root)
    {
        var ev = new OpenAiWireEvent();
        if (root.ValueKind == JsonValueKind.Object && root.TryGetProperty("error", out var err))
        {
            ev.WireError = err.Clone();
            return ev;
        }
        if (root.TryGetProperty("usage", out var usage) && usage.ValueKind == JsonValueKind.Object)
            ev.Usage = usage.Clone();
        if (!root.TryGetProperty("choices", out var choices) || choices.ValueKind != JsonValueKind.Array || choices.GetArrayLength() == 0)
            return (ev.Usage != null || ev.WireError != null) ? ev : null;

        var c0 = choices[0];
        if (c0.ValueKind != JsonValueKind.Object) return ev.Usage != null ? ev : null;
        if (c0.TryGetProperty("finish_reason", out var fr) && fr.ValueKind == JsonValueKind.String)
            ev.FinishReason = fr.GetString();
        if (c0.TryGetProperty("delta", out var delta) && delta.ValueKind == JsonValueKind.Object)
        {
            if (delta.TryGetProperty("content", out var content) && content.ValueKind == JsonValueKind.String)
                ev.TextDelta = content.GetString();
            // 厂商思考字段两形态：DeepSeek reasoning_content / OpenAI o 系 reasoning
            if (delta.TryGetProperty("reasoning_content", out var rc) && rc.ValueKind == JsonValueKind.String)
                ev.ReasoningDelta = rc.GetString();
            else if (delta.TryGetProperty("reasoning", out var r2) && r2.ValueKind == JsonValueKind.String)
                ev.ReasoningDelta = r2.GetString();
            if (delta.TryGetProperty("tool_calls", out var tc) && tc.ValueKind == JsonValueKind.Array && tc.GetArrayLength() > 0)
                ev.ToolCallsDelta = tc.Clone();
        }
        var interesting = ev.TextDelta != null || ev.ReasoningDelta != null || ev.ToolCallsDelta != null
            || ev.FinishReason != null || ev.Usage != null || ev.WireError != null;
        return interesting ? ev : null;
    }
}

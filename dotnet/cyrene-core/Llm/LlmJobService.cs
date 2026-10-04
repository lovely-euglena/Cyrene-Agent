using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Net;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using CyreneNative.Secrets;

namespace CyreneNative.Llm;

/// <summary>llm 作业执行服务（H1 调度 + H2 执行）：鉴权注入 + 重试集中 + 事件缓冲/反压。</summary>
public sealed class LlmJobService : IDisposable
{
    private readonly LlmJobStore _store;
    private readonly ISecretProvider _secrets;
    private readonly HttpClient _http;

    public LlmJobStore Store => _store;
    public bool SecretsAvailable => _secrets.IsAvailable;

    public LlmJobService(ISecretProvider secrets)
    {
        _secrets = secrets;
        _store = new LlmJobStore(job => _ = RunAsync(job));
        _http = new HttpClient(new SocketsHttpHandler
        {
            PooledConnectionLifetime = TimeSpan.FromMinutes(10),
            AutomaticDecompression = DecompressionMethods.All,
        })
        { Timeout = Timeout.InfiniteTimeSpan }; // 超时全部自管（idle/取消语义见 OpenAiSseClient）
    }

    /// <summary>提交作业（帧即 llm.submit 载荷）；low 满载返回 null。</summary>
    public LlmJob? Submit(JsonElement frame)
    {
        var job = ParseJob(frame);
        return job == null ? null : _store.Submit(job);
    }

    private static LlmJob? ParseJob(JsonElement frame)
    {
        string Get(string prop) => frame.TryGetProperty(prop, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : "";
        var lane = Get("lane");
        var endpoint = Get("endpoint");
        var body = Get("body");
        if (endpoint.Length == 0 || body.Length == 0) return null;
        var method = Get("method") is { Length: > 0 } m ? m : "POST";
        var protocol = Get("protocol") is { Length: > 0 } p ? p : "openai";

        string? vaultKey = null;
        var authStyle = "bearer";
        if (frame.TryGetProperty("auth", out var auth) && auth.ValueKind == JsonValueKind.Object)
        {
            if (auth.TryGetProperty("vaultKey", out var vk) && vk.ValueKind == JsonValueKind.String) vaultKey = vk.GetString();
            if (auth.TryGetProperty("style", out var st) && st.ValueKind == JsonValueKind.String) authStyle = st.GetString() ?? "bearer";
        }

        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        if (frame.TryGetProperty("headers", out var hs) && hs.ValueKind == JsonValueKind.Object)
            foreach (var h in hs.EnumerateObject())
                if (h.Value.ValueKind == JsonValueKind.String) headers[h.Name] = h.Value.GetString() ?? "";

        return new LlmJob(
            lane, endpoint, method, body, vaultKey, authStyle, headers, protocol,
            timeoutMs: frame.TryGetProperty("timeoutMs", out var t) && t.TryGetInt32(out var ti) ? ti : 180_000,
            maxRetries: frame.TryGetProperty("maxRetries", out var r) && r.TryGetInt32(out var ri) ? Math.Clamp(ri, 0, 10) : 3,
            idleTimeoutMs: frame.TryGetProperty("idleTimeoutMs", out var i) && i.TryGetInt32(out var ii) ? ii : 45_000);
    }

    /// <summary>执行（store pump 出队回调）。终态（done/error/cancelled）在此收口。</summary>
    private async Task RunAsync(LlmJob job)
    {
        var began = DateTimeOffset.UtcNow;
        job.Metrics.QueueWaitMs = (long)(began - job.EnqueuedAt).TotalMilliseconds;
        try
        {
            await ExecuteWithRetryAsync(job).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            MarkTerminal(job, LlmJobState.Error, new LlmEvent
            {
                Type = LlmContracts.EvError, Code = LlmContracts.ErrHttpNetwork,
                Message = $"job execution crashed: {ex.Message}", Retryable = false,
            });
        }
        finally
        {
            job.Metrics.ClosedAt = DateTimeOffset.UtcNow;
        }
    }

    private async Task ExecuteWithRetryAsync(LlmJob job)
    {
        string? authValue = null;
        var attempt = 0;
        while (true)
        {
            attempt++;
            var ct = job.Cts.Token;
            if (ct.IsCancellationRequested)
            {
                MarkTerminal(job, LlmJobState.Cancelled, new LlmEvent { Type = LlmContracts.EvError, Code = LlmContracts.ErrCancelled });
                return;
            }

            // 鉴权注入：.NET 从 vault 取，TS 全程不接触明文（设计 §3；首 attempt 一次，重试复用）
            if (authValue == null && job.AuthVaultKey != null)
            {
                if (!_secrets.IsAvailable)
                {
                    MarkTerminal(job, LlmJobState.Error, new LlmEvent
                    {
                        Type = LlmContracts.EvError, Code = LlmContracts.ErrSecretUnavailable,
                        Message = "secret provider unavailable", Retryable = false,
                    });
                    return;
                }
                authValue = _secrets.Get(job.AuthVaultKey);
                if (authValue == null)
                {
                    MarkTerminal(job, LlmJobState.Error, new LlmEvent
                    {
                        Type = LlmContracts.EvError, Code = LlmContracts.ErrAuthMissing,
                        Message = $"vault key missing: {job.AuthVaultKey}", Retryable = false,
                    });
                    return;
                }
            }

            try
            {
                await StreamAttemptAsync(job, authValue, attempt, ct).ConfigureAwait(false);
                return; // StreamAttemptAsync 自然结束即已补发 finish/usage/done 并置 Done
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                MarkTerminal(job, LlmJobState.Cancelled, new LlmEvent { Type = LlmContracts.EvError, Code = LlmContracts.ErrCancelled });
                return;
            }
            catch (OpenAiHttpException hex)
            {
                var hadVisible = job.SawVisibleDelta;
                var retryable = !hadVisible && OpenAiHttpException.IsRetryableStatus(hex.Status);
                if (!retryable || attempt > job.MaxRetries)
                {
                    job.Metrics.Retries = attempt - 1;
                    MarkTerminal(job, LlmJobState.Error, new LlmEvent
                    {
                        Type = LlmContracts.EvError,
                        Code = hex.Status == 0 ? LlmContracts.ErrHttpNetwork : LlmContracts.ErrHttpPrefix + hex.Status,
                        Message = retryable ? $"retries exhausted ({job.MaxRetries}): {hex.Message}" : hex.Message,
                        Retryable = hadVisible,
                    });
                    return;
                }
                var delay = ComputeDelayMs(hex.RetryAfterMs, attempt);
                job.Metrics.Retries = attempt;
                AppendBlocked(job, new LlmEvent
                {
                    Type = LlmContracts.EvRetry, Attempt = attempt, DelayMs = delay,
                    Category = hex.Status == 429 ? "RATE_LIMIT" : hex.Status == 0 ? "NETWORK" : "SERVER",
                });
                job.State = LlmJobState.WaitingRetry;
                try { await Task.Delay(delay, ct).ConfigureAwait(false); }
                catch (OperationCanceledException)
                {
                    MarkTerminal(job, LlmJobState.Cancelled, new LlmEvent { Type = LlmContracts.EvError, Code = LlmContracts.ErrCancelled });
                    return;
                }
                job.State = LlmJobState.Running;
            }
        }
    }

    /// <summary>一次流式尝试；wire → 归一事件落 ring（含高水位反压）。流自然结束后补发 finish → usage → done 并置 Done。</summary>
    private async Task StreamAttemptAsync(LlmJob job, string? authValue, int attempt, CancellationToken ct)
    {
        var finish = default(string);
        JsonElement? usage = null;
        var ttft = Stopwatch.StartNew();

        // 每次尝试重置可见增量旗标（重试语义：新 attempt 内的首个可见增量前才可重试）
        job.SawVisibleDelta = false;
        var headers = BuildHeaders(job, authValue);

        await OpenAiSseClient.StreamOnceAsync(
            _http, job.Method, job.Endpoint, headers, job.Body, job.IdleTimeoutMs,
            ev =>
            {
                if (job.IsTerminal) return false; // 取消/终态：中止读（上游连接随之释放）
                var mapped = MapWire(ev, ref finish, ref usage);
                if (mapped == null) return true;
                AwaitRoom(job, ct); // 反压：ring 高水位 → 挂起（poll 抽走至低水位恢复）
                job.Append(mapped);
                var t = mapped.Type;
                if (t is LlmContracts.EvDelta or LlmContracts.EvReasoningDelta or LlmContracts.EvToolCallsDelta)
                {
                    job.SawVisibleDelta = true;
                    job.Metrics.TtftMs ??= ttft.ElapsedMilliseconds;
                }
                return true;
            }, ct).ConfigureAwait(false);

        EmitTerminalEvents(job, finish, usage);
    }

    private IReadOnlyDictionary<string, string> BuildHeaders(LlmJob job, string? authValue)
    {
        if (job.AuthVaultKey == null || authValue == null) return job.Headers;
        var headers = new Dictionary<string, string>(job.Headers, StringComparer.OrdinalIgnoreCase);
        if (job.AuthStyle == "raw")
            headers[job.AuthHeaderName] = authValue; // x-api-key 等 raw 头
        else
            headers["Authorization"] = $"Bearer {authValue}";
        return headers;
    }

    /// <summary>反压等待：ring ≥ 高水位 → 轮询等 poll 抽到低水位以下（20ms tick，取消即抛）。</summary>
    private static void AwaitRoom(LlmJob job, CancellationToken ct)
    {
        while (job.EventCount >= LlmJob.HighWater && !job.IsTerminal)
        {
            ct.WaitHandle.WaitOne(20);
            ct.ThrowIfCancellationRequested();
        }
    }

    /// <summary>缓冲已满时的兜底追加（丢弃计数；终态补事件必达）。</summary>
    private static void AppendBlocked(LlmJob job, LlmEvent e)
    {
        if (!job.Append(e))
        {
            job.Metrics.DroppedEvents++;
            // ring 满且上游不可暂停（当前实现上游可暂停，此路径仅防御）：截断收口
            job.State = LlmJobState.Error;
            job.FinishedAt = DateTimeOffset.UtcNow;
            job.Append(new LlmEvent { Type = LlmContracts.EvError, Code = LlmContracts.ErrTruncated, Message = "event buffer overflow", Retryable = false });
        }
    }

    /// <summary>wire → 归一 LlmEvent（finish/usage 缓存到流自然结束后统一发，保证顺序：…delta → finish → usage → done）。</summary>
    private static LlmEvent? MapWire(OpenAiWireEvent ev, ref string? finish, ref JsonElement? usage)
    {
        if (ev.WireError != null)
        {
            var msg = ev.WireError.Value.ValueKind == JsonValueKind.Object
                && ev.WireError.Value.TryGetProperty("message", out var m) && m.ValueKind == JsonValueKind.String
                    ? m.GetString() : "upstream wire error";
            return new LlmEvent { Type = LlmContracts.EvError, Code = LlmContracts.ErrHttpPrefix + 200, Message = msg, Retryable = false };
        }
        if (ev.TextDelta != null) return new LlmEvent { Type = LlmContracts.EvDelta, Text = ev.TextDelta };
        if (ev.ReasoningDelta != null) return new LlmEvent { Type = LlmContracts.EvReasoningDelta, Text = ev.ReasoningDelta };
        if (ev.ToolCallsDelta != null) return new LlmEvent { Type = LlmContracts.EvToolCallsDelta, Calls = ev.ToolCallsDelta.Value.Clone() };
        if (ev.FinishReason != null) finish = ev.FinishReason;
        if (ev.Usage != null) usage = ev.Usage; // 尾块常 finish+usage 同体，两者都要捕获
        return null;
    }

    /// <summary>流自然结束（[DONE]/EOF）：补发 finish → usage → done 终事件并置 Done 终态。</summary>
    private void EmitTerminalEvents(LlmJob job, string? finish, JsonElement? usage)
    {
        if (job.IsTerminal) return; // 流结束前已被取消/出错：终态不覆盖（error/done 只发一个）
        AppendBlocked(job, new LlmEvent { Type = LlmContracts.EvFinish, Reason = finish ?? "stop" });
        if (usage != null)
        {
            long In(string prop) => usage.Value.TryGetProperty(prop, out var v) && v.TryGetInt64(out var i) ? i : 0;
            AppendBlocked(job, new LlmEvent
            {
                Type = LlmContracts.EvUsage,
                InputTokens = In("prompt_tokens"),
                OutputTokens = In("completion_tokens"),
                CachedInputTokens = usage.Value.TryGetProperty("prompt_tokens_details", out var det)
                    && det.ValueKind == JsonValueKind.Object && det.TryGetProperty("cached_tokens", out var c) && c.TryGetInt64(out var ci) ? ci : null,
            });
        }
        AppendBlocked(job, new LlmEvent { Type = LlmContracts.EvDone });
        job.State = LlmJobState.Done;
        job.FinishedAt = DateTimeOffset.UtcNow;
        var begunAt = job.StartedAt ?? job.EnqueuedAt;
        job.Metrics.TotalMs = (long)(job.FinishedAt.Value - begunAt).TotalMilliseconds;
    }

    private static void MarkTerminal(LlmJob job, LlmJobState state, LlmEvent? terminalEvent = null)
    {
        if (job.IsTerminal) return; // 终态只发一次（cancel 竞速：先到先得）
        if (terminalEvent != null) job.Append(terminalEvent);
        job.State = state;
        job.FinishedAt = DateTimeOffset.UtcNow;
    }

    private static int ComputeDelayMs(string? retryAfterMs, int attempt)
    {
        if (retryAfterMs != null && long.TryParse(retryAfterMs, NumberStyles.Integer, CultureInfo.InvariantCulture, out var ra) && ra is > 0 and <= 120_000)
            return (int)ra;
        return (int)Math.Min(30_000, 1_000L << Math.Min(attempt, 5)); // 1s,2s,4s,8s,16s,30s 封顶
    }

    public void Dispose()
    {
        _store.Dispose();
        try { _http.Dispose(); } catch { }
    }
}

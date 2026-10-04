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

/// <summary>
/// llm 作业执行服务（H1 调度 + H2 执行）：鉴权注入 + 重试集中 + 事件缓冲/反压。
///
/// 重试语义（对齐 TS model-retry-runner / 设计 §5.2；IKJM7D 复审 P0-9 修复）：
///   - 可重试失败 = 408/429/5xx + 网络层失败（连接失败/流中断，status=0）+ idle 静默超时，
///     且首个可见增量之前 → 退避后重发，`retry` 事件推送进度；
///   - 已有可见增量：任何失败 → 直接 error 收口（绝不重放副作用）；
///   - retry-after 头优先，否则指数退避 1s→2s→4s…封顶 30s；
///   - 总时长兜底：timeoutMs 经 linked CTS 生效（P1-5，超时 = 不可重试终态）。
/// 反压（复审 P0-2 修复）：高水位按「未确认量」暂停上游读（poll 消费推进恢复），
/// 消费者死亡由 stall 兜底（60s）→ truncated 终态；ring 满防御性 drop-oldest。
/// </summary>
public sealed class LlmJobService : IDisposable
{
    private readonly LlmJobStore _store;
    private readonly ISecretProvider _secrets;
    private readonly HttpClient _http;
    private readonly object _metricsGate = new();
    private readonly List<LlmJobMetrics> _recentMetrics = new();

    public LlmJobStore Store => _store;
    public bool SecretsAvailable => _secrets.IsAvailable;

    public LlmJobService(ISecretProvider secrets)
    {
        _secrets = secrets;
        _store = new LlmJobStore(job => { try { job.RunTask = ExecuteJobAsync(job); } catch { /* 防御 */ } });
        _http = new HttpClient(new SocketsHttpHandler
        {
            PooledConnectionLifetime = TimeSpan.FromMinutes(10),
            AutomaticDecompression = DecompressionMethods.All,
        })
        { Timeout = Timeout.InfiniteTimeSpan }; // 超时全部自管（idle/总时长/取消语义见下）
    }

    /// <summary>提交作业；返回 (job, error)。error 非空 = 非法帧（bad request，复审 P1-7）。</summary>
    public LlmJob? TrySubmit(JsonElement frame, out string? error)
    {
        error = null;
        try
        {
            var job = ParseJob(frame);
            if (job == null) { error = "submit 帧缺少 endpoint/body 必填字段"; return null; }
            var stored = _store.Submit(job);
            if (stored == null) error = LlmContracts.ErrLaneFull;
            return stored;
        }
        catch (Exception ex)
        {
            error = $"submit 帧解析失败: {Trunc(ex.Message)}";
            return null;
        }
    }

    private static string Trunc(string s) => s.Length <= 300 ? s : s[..300];

    private static LlmJob? ParseJob(JsonElement frame)
    {
        string Get(string prop) => frame.TryGetProperty(prop, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : "";
        var endpoint = Get("endpoint");
        var body = Get("body");
        if (endpoint.Length == 0 || body.Length == 0) return null;

        string? authVaultKey = null;
        if (frame.TryGetProperty("auth", out var auth) && auth.ValueKind == JsonValueKind.Object)
        {
            if (auth.TryGetProperty("vaultKey", out var vk) && vk.ValueKind == JsonValueKind.String)
                authVaultKey = vk.GetString();
        }
        var authStyle = Get("authStyle") is { Length: > 0 } legacy ? legacy : "bearer";
        string? authHeaderName = null;
        if (frame.TryGetProperty("auth", out var auth2) && auth2.ValueKind == JsonValueKind.Object
            && auth2.TryGetProperty("style", out var st) && st.ValueKind == JsonValueKind.String)
            authStyle = st.GetString() ?? "bearer";
        if (frame.TryGetProperty("auth", out var auth3) && auth3.ValueKind == JsonValueKind.Object
            && auth3.TryGetProperty("headerName", out var hn) && hn.ValueKind == JsonValueKind.String)
            authHeaderName = hn.GetString();

        var headers = new Dictionary<string, string>();
        if (frame.TryGetProperty("headers", out var hs) && hs.ValueKind == JsonValueKind.Object)
            foreach (var p in hs.EnumerateObject())
                if (p.Value.ValueKind == JsonValueKind.String) headers[p.Name] = p.Value.GetString() ?? "";

        var lane = Get("lane") is { Length: > 0 } l ? l : LlmContracts.LaneInteractive;
        return new LlmJob(
            lane, endpoint,
            Get("method") is { Length: > 0 } m ? m : "POST",
            body, authVaultKey, authStyle, headers,
            Get("protocol") is { Length: > 0 } proto ? proto : "openai",
            frame.TryGetProperty("timeoutMs", out var to) && to.TryGetInt32(out var t) ? Math.Clamp(t, 1_000, 600_000) : 120_000,
            frame.TryGetProperty("maxRetries", out var mr) && mr.TryGetInt32(out var r) ? Math.Clamp(r, 0, 10) : 5,
            frame.TryGetProperty("idleTimeoutMs", out var it) && it.TryGetInt32(out var i2) ? Math.Clamp(i2, 1_000, 300_000) : 45_000,
            authHeaderName);
    }

    /// <summary>作业执行入口（pump 注入 job.RunTask；全异常兜底为终态——绝不悬空）。</summary>
    private async Task ExecuteJobAsync(LlmJob job)
    {
        try
        {
            await ExecuteWithRetryAsync(job).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (job.Cts.IsCancellationRequested)
        {
            MarkTerminal(job, LlmJobState.Cancelled, new LlmEvent { Type = LlmContracts.EvError, Code = LlmContracts.ErrCancelled });
        }
        catch (Exception ex)
        {
            MarkTerminal(job, LlmJobState.Error, new LlmEvent
            {
                Type = LlmContracts.EvError, Code = LlmContracts.ErrBadRequest,
                Message = Trunc(ex.Message), Retryable = false,
            });
        }
        finally
        {
            PublishMetrics(job);
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
                        Message = $"vault 缺少 key: {job.AuthVaultKey}", Retryable = false,
                    });
                    return;
                }
            }

            // 组装请求头（鉴权注入；raw 风格用提交方 headerName——P1-4，Azure api-key 等）
            var headers = new Dictionary<string, string>(job.Headers, StringComparer.OrdinalIgnoreCase);
            if (authValue != null)
            {
                if (job.AuthStyle == "bearer") headers["Authorization"] = $"Bearer {authValue}";
                else headers[job.AuthHeaderName] = authValue;
            }

            // 总时长兜底（P1-5）：timeoutMs 经 linked CTS 生效；超时 = 不可重试终态
            using var attemptCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            attemptCts.CancelAfter(job.TimeoutMs);

            job.State = LlmJobState.Running;
            job.StartedAt ??= DateTimeOffset.UtcNow;
            if (job.Metrics.QueueWaitMs == null)
                job.Metrics.QueueWaitMs = (long)(job.StartedAt.Value - job.EnqueuedAt).TotalMilliseconds;

            var hadVisibleBefore = job.SawVisibleDelta;
            OpenAiHttpException? failure = null;
            OperationCanceledException? cancelled = null;
            try
            {
                await StreamAttemptAsync(job, attemptCts.Token, headers).ConfigureAwait(false);
                return; // 正常终态（EmitTerminalEvents 已置 Done；wire error 已置 Error）
            }
            catch (OpenAiHttpException ex) { failure = ex; }
            catch (OperationCanceledException ex)
            {
                if (ct.IsCancellationRequested)
                {
                    cancelled = ex; // 用户取消 → 终态
                }
                else
                {
                    // attemptCts 超时（总时长）→ 不可重试终态（P1-5）
                    MarkTerminal(job, LlmJobState.Error, new LlmEvent
                    {
                        Type = LlmContracts.EvError, Code = LlmContracts.ErrRequestTimeout,
                        Message = $"总时长超限（{job.TimeoutMs}ms）", Retryable = false,
                    });
                    return;
                }
            }

            if (cancelled != null)
            {
                MarkTerminal(job, LlmJobState.Cancelled, new LlmEvent { Type = LlmContracts.EvError, Code = LlmContracts.ErrCancelled });
                return;
            }

            // 失败分类（P0-9）：status=0（网络/中断/idle）与 408/429/5xx 可重试；有可见增量后绝不重放
            var retryable = OpenAiHttpException.IsRetryableStatus(failure!.Status) && !job.SawVisibleDelta && attempt <= job.MaxRetries;
            if (!retryable)
            {
                var code = failure.Status == 0
                    ? (failure.IsIdleTimeout ? LlmContracts.ErrIdleTimeout : LlmContracts.ErrHttpNetwork)
                    : LlmContracts.ErrHttpPrefix + failure.Status;
                var category = failure.Status == 0 ? "NETWORK"
                    : failure.Status == 429 ? "RATE_LIMIT"
                    : failure.Status >= 500 ? "SERVER_ERROR"
                    : "UNKNOWN";
                MarkTerminal(job, LlmJobState.Error, new LlmEvent
                {
                    Type = LlmContracts.EvError, Code = code,
                    Message = Trunc(failure.BodyHead.Length > 0 ? failure.BodyHead : failure.Message),
                    Retryable = false, Category = category,
                });
                return;
            }

            // 退避重试：retry-after 头优先，否则指数 1s,2s,4s…封顶 30s（修 off-by-one）
            job.RetryCount = attempt;
            job.Metrics.Retries = attempt;
            job.State = LlmJobState.WaitingRetry;
            var delayMs = ComputeDelayMs(failure.RetryAfterMs, attempt - 1);
            job.Append(new LlmEvent
            {
                Type = LlmContracts.EvRetry, Attempt = attempt, DelayMs = delayMs,
                Category = failure.Status >= 500 ? "SERVER_ERROR" : failure.Status == 429 ? "RATE_LIMIT" : "NETWORK",
            });
            try { await Task.Delay(delayMs, ct).ConfigureAwait(false); }
            catch (OperationCanceledException)
            {
                MarkTerminal(job, LlmJobState.Cancelled, new LlmEvent { Type = LlmContracts.EvError, Code = LlmContracts.ErrCancelled });
                return;
            }
        }
    }

    /// <summary>一次流式尝试；wire → 归一事件落 ring（含高水位反压）。流自然结束后补发 finish → usage → done 并置 Done。</summary>
    private async Task StreamAttemptAsync(LlmJob job, CancellationToken ct, IReadOnlyDictionary<string, string> headers)
    {
        var finish = default(string);
        JsonElement? usage = null;
        var ttft = Stopwatch.StartNew();
        await OpenAiSseClient.StreamOnceAsync(_http, job.Method, job.Endpoint, headers, job.Body, job.IdleTimeoutMs, ev =>
        {
            if (job.IsTerminal) return false; // 取消/终态：中止读（上游连接随之释放）

            // HTTP 200 内嵌业务错误 → 终态 error，不补 done（P1-7）
            if (ev.WireError != null)
            {
                var msg = ev.WireError.Value.ValueKind == JsonValueKind.Object
                    && ev.WireError.Value.TryGetProperty("message", out var m) && m.ValueKind == JsonValueKind.String
                        ? m.GetString() ?? "upstream wire error" : "upstream wire error";
                MarkTerminal(job, LlmJobState.Error, new LlmEvent
                {
                    Type = LlmContracts.EvError, Code = LlmContracts.ErrHttpPrefix + "200",
                    Message = Trunc(msg), Retryable = false, Category = "UNKNOWN",
                });
                return false;
            }

            var mapped = MapWire(ev, ref finish, ref usage);
            if (mapped == null) return true;

            // 反压：未确认量 ≥ 高水位 → 暂停上游读（TCP 反压），poll 消费推进至低水位恢复；
            // 消费者死亡 60s → truncated 终态（P0-2 修复）
            var pausedAt = Stopwatch.StartNew();
            while (job.Unconfirmed() >= LlmJob.HighWater && !job.IsTerminal)
            {
                if (pausedAt.ElapsedMilliseconds > LlmJob.StallTimeoutMs)
                {
                    MarkTerminal(job, LlmJobState.Error, new LlmEvent
                    {
                        Type = LlmContracts.EvError, Code = LlmContracts.ErrTruncated,
                        Message = "消费者停止拉取，超水位暂停超过 60s（stall 兜底）", Retryable = false,
                    });
                    return false;
                }
                ct.WaitHandle.WaitOne(20);
                if (ct.IsCancellationRequested) return false;
            }
            job.Append(mapped);
            var t = mapped.Type;
            if (t is LlmContracts.EvDelta or LlmContracts.EvReasoningDelta or LlmContracts.EvToolCallsDelta)
            {
                job.SawVisibleDelta = true;
                job.FirstDeltaAt ??= DateTimeOffset.UtcNow;
                if (job.Metrics.TtftMs == null) job.Metrics.TtftMs = ttft.ElapsedMilliseconds;
            }
            return true;
        }, ct).ConfigureAwait(false);

        if (!job.IsTerminal) EmitTerminalEvents(job, finish, usage);
    }

    /// <summary>流自然结束（[DONE]/EOF）：补发 finish → usage → done 终事件并置 Done 终态。</summary>
    private void EmitTerminalEvents(LlmJob job, string? finish, JsonElement? usage)
    {
        if (job.IsTerminal) return; // 流结束前已被取消/出错：终态不覆盖（error/done 只发一个）
        job.Append(new LlmEvent { Type = LlmContracts.EvFinish, Reason = finish ?? "stop" }, isTerminal: true);
        if (usage != null)
        {
            long In(string prop) => usage.Value.TryGetProperty(prop, out var v) && v.TryGetInt64(out var i) ? i : 0;
            job.Metrics.TokensOut = In("completion_tokens");
            job.Append(new LlmEvent
            {
                Type = LlmContracts.EvUsage,
                InputTokens = In("prompt_tokens"),
                OutputTokens = In("completion_tokens"),
                CachedInputTokens = usage.Value.TryGetProperty("prompt_tokens_details", out var det)
                    && det.ValueKind == JsonValueKind.Object && det.TryGetProperty("cached_tokens", out var c) && c.TryGetInt64(out var ci) ? ci : null,
            }, isTerminal: true);
        }
        job.Append(new LlmEvent { Type = LlmContracts.EvDone }, isTerminal: true);
        job.State = LlmJobState.Done;
        job.FinishedAt = DateTimeOffset.UtcNow;
    }

    /// <summary>wire → 归一 LlmEvent（finish/usage 缓存到流自然结束后统一发，保证顺序：…delta → finish → usage → done）。</summary>
    private static LlmEvent? MapWire(OpenAiWireEvent ev, ref string? finish, ref JsonElement? usage)
    {
        if (ev.TextDelta != null) return new LlmEvent { Type = LlmContracts.EvDelta, Text = ev.TextDelta };
        if (ev.ReasoningDelta != null) return new LlmEvent { Type = LlmContracts.EvReasoningDelta, Text = ev.ReasoningDelta };
        if (ev.ToolCallsDelta != null) return new LlmEvent { Type = LlmContracts.EvToolCallsDelta, Calls = ev.ToolCallsDelta.Value.Clone() };
        if (ev.FinishReason != null) finish = ev.FinishReason;
        if (ev.Usage != null) usage = ev.Usage; // 尾块常 finish+usage 同体，两者都要捕获
        return null;
    }

    private static void MarkTerminal(LlmJob job, LlmJobState state, LlmEvent? terminalEvent = null)
    {
        if (job.IsTerminal) return; // 终态只发一次（cancel 竞速：先到先得）
        if (terminalEvent != null)
        {
            job.Append(terminalEvent, isTerminal: true);
            if (terminalEvent.Code != null) job.Metrics.ErrorCode = terminalEvent.Code;
        }
        job.State = state;
        job.FinishedAt = DateTimeOffset.UtcNow;
    }

    /// <summary>终态指标出口（P1-8）：stderr 结构化日志 + 最近 10 条供 llm.status 拉取。</summary>
    private void PublishMetrics(LlmJob job)
    {
        var m = job.Metrics;
        m.State = job.State;
        var begunAt = job.StartedAt ?? job.EnqueuedAt;
        m.TotalMs = (long)((job.FinishedAt ?? DateTimeOffset.UtcNow) - begunAt).TotalMilliseconds;
        m.ClosedAt = DateTimeOffset.UtcNow;
        m.DroppedEvents = job.DroppedEvents;
        string json;
        lock (_metricsGate)
        {
            _recentMetrics.Add(m);
            if (_recentMetrics.Count > 10) _recentMetrics.RemoveAt(0);
            json = JsonSerializer.Serialize(m, new JsonSerializerOptions
            {
                PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
                DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
            });
        }
        Console.Error.WriteLine($"[llm-metrics] {json}");
    }

    /// <summary>最近终态指标（llm.status 出口，P1-8）。</summary>
    public IReadOnlyList<LlmJobMetrics> RecentMetrics()
    {
        lock (_metricsGate) return _recentMetrics.ToArray();
    }

    private static int ComputeDelayMs(string? retryAfterMs, int attempt)
    {
        if (retryAfterMs != null && long.TryParse(retryAfterMs, NumberStyles.Integer, CultureInfo.InvariantCulture, out var ra) && ra is > 0 and <= 120_000)
            return (int)ra;
        return (int)Math.Min(30_000, 1_000L << Math.Min(attempt, 5)); // 1s,2s,4s,8s,16s,30s 封顶（首档 1s）
    }

    public void Dispose()
    {
        _store.Dispose();
        try { _http.Dispose(); } catch { }
    }
}

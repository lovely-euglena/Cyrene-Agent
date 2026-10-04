using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading;

namespace CyreneNative.Llm;

/// <summary>作业事件（JSON 序列化后即 poll 帧里的 event 元素；字段名 camelCase 由序列化策略控制）。</summary>
public sealed class LlmEvent
{
    public string Type { get; set; } = "";
    public string? Text { get; set; }
    public object? Calls { get; set; }
    public long? InputTokens { get; set; }
    public long? OutputTokens { get; set; }
    public long? CachedInputTokens { get; set; }
    public string? Reason { get; set; }
    public int? Attempt { get; set; }
    public int? DelayMs { get; set; }
    public string? Category { get; set; }
    public string? Code { get; set; }
    public string? Message { get; set; }
    public bool? Retryable { get; set; }
}

/// <summary>作业状态：queued → running →（waiting_retry）→ done | error | cancelled。</summary>
public enum LlmJobState { Queued, Running, WaitingRetry, Done, Error, Cancelled }

/// <summary>结构化指标（设计 §6 可观测：queue wait / TTFT / retry 计数；桌面版落日志，服务器版接 metrics）。</summary>
public sealed class LlmJobMetrics
{
    public long? QueueWaitMs { get; set; }
    public long? TtftMs { get; set; }
    public long? TotalMs { get; set; }
    public int Retries { get; set; }
    public long DroppedEvents { get; set; }
    public long? TokensOut { get; set; }
    public DateTimeOffset? ClosedAt { get; set; }
}

/// <summary>单条作业：事件 ring + 长轮询等待 + 重试/取消/指标。</summary>
public sealed class LlmJob
{
    public const int RingCapacity = 8192;      // 事件 ring 上限（高水位 80% 暂停上游，见 LlmJobService）
    public const int HighWater = 6553;         // ~80%
    public const int LowWater = 2048;          // 恢复阈值
    public static readonly TimeSpan Ttl = TimeSpan.FromMinutes(10);

    public string Id { get; } = "j" + Guid.NewGuid().ToString("N")[..12];
    public string Lane { get; }
    public string Endpoint { get; }
    public string Method { get; }
    public string Body { get; }
    public string? AuthVaultKey { get; }
    public string AuthStyle { get; }
    /// <summary>authStyle=raw 时的鉴权头名（如 x-api-key；bearer 走 Authorization 固定头）。</summary>
    public string AuthHeaderName { get; }
    public IReadOnlyDictionary<string, string> Headers { get; }
    public string Protocol { get; }
    public int TimeoutMs { get; }
    public int MaxRetries { get; }
    public int IdleTimeoutMs { get; }
    public LlmJobMetrics Metrics { get; } = new();

    public LlmJobState State { get; set; } = LlmJobState.Queued;
    public int RetryCount { get; set; }
    public bool SawVisibleDelta { get; set; }
    public DateTimeOffset EnqueuedAt { get; } = DateTimeOffset.UtcNow;
    public DateTimeOffset? StartedAt { get; set; }
    public DateTimeOffset? FirstDeltaAt { get; set; }
    public DateTimeOffset? FinishedAt { get; set; }
    public CancellationTokenSource Cts { get; } = new();

    private readonly object _gate = new();
    private readonly List<LlmEvent> _events = new();          // 终态后保留至 TTL
    private long _dropped;
    private long _waiters;

    public LlmJob(string lane, string endpoint, string method, string body,
        string? authVaultKey, string authStyle, IReadOnlyDictionary<string, string> headers,
        string protocol, int timeoutMs, int maxRetries, int idleTimeoutMs, string? authHeaderName = null)
    {
        Lane = lane; Endpoint = endpoint; Method = method; Body = body;
        AuthVaultKey = authVaultKey; AuthStyle = authStyle; AuthHeaderName = authHeaderName ?? "x-api-key"; Headers = headers;
        Protocol = protocol; TimeoutMs = timeoutMs; MaxRetries = maxRetries; IdleTimeoutMs = idleTimeoutMs;
    }

    public int EventCount { get { lock (_gate) return _events.Count; } }
    public long DroppedEvents { get { lock (_gate) return _dropped; } }
    public bool IsTerminal => State is LlmJobState.Done or LlmJobState.Error or LlmJobState.Cancelled;

    /// <summary>追加事件；ring 满且不可丢弃时返回 false（反压溢出）。</summary>
    public bool Append(LlmEvent e)
    {
        lock (_gate)
        {
            if (_events.Count >= RingCapacity) { _dropped++; Monitor.PulseAll(_gate); return false; }
            _events.Add(e);
            Monitor.PulseAll(_gate); // 唤醒长轮询等待者
            return true;
        }
    }

    /// <summary>
    /// 取 [cursor, cursor+max) 事件段；为空且 waitMs>0 时长轮询（Monitor.Wait，不占读帧线程）。
    /// 返回实际 nextCursor（幂等：cursor 不变即无新事件）。
    /// </summary>
    public IReadOnlyList<LlmEvent> Poll(int cursor, int maxEvents, int waitMs)
    {
        lock (_gate)
        {
            WaitLocked(cursor, waitMs);
            var end = Math.Min(cursor + Math.Max(1, maxEvents), _events.Count);
            if (cursor >= end) return Array.Empty<LlmEvent>();
            var slice = _events.GetRange(cursor, end - cursor);
            return slice;
        }
    }

    private void WaitLocked(int cursor, int waitMs)
    {
        var deadline = DateTime.UtcNow + TimeSpan.FromMilliseconds(Math.Clamp(waitMs, 0, 10_000));
        while (cursor >= _events.Count && DateTime.UtcNow < deadline && !IsTerminal)
        {
            // 终态时 ring 里可能仍有未读事件（error/done 已在 ring），Poll 会立即返回它们。
            var remaining = deadline - DateTime.UtcNow;
            Monitor.Wait(_gate, remaining <= TimeSpan.Zero ? TimeSpan.FromMilliseconds(1) : remaining);
        }
    }

    /// <summary>缓冲房间数（>0 = 上游可继续推）。</summary>
    public int Room { get { lock (_gate) return RingCapacity - _events.Count; } }
}

/// <summary>
/// 作业注册表 + lane 调度。
///   interactive：并行上限 4（主聊天，TTFT 优先）；
///   normal：并行上限 2（结构化/摘要类）；
///   low：并行上限 1、队列上限 32（标题/心情/记忆三件等后台任务，满载拒绝 E_LLM_HOST_LANE_FULL）。
/// 调度器每 lane 一条 pump 线程；queue wait / TTFT / TPS 计数在 LlmJob 上。
/// </summary>
public sealed class LlmJobStore : IDisposable
{
    private const int InteractiveParallel = 4;
    private const int NormalParallel = 2;
    private const int LowParallel = 1;
    public const int LowQueueCap = 32;

    private readonly object _gate = new();
    private readonly Dictionary<string, LlmJob> _jobs = new();
    private readonly Queue<string>[] _queues =
    {
        new(), new(), new(), // 0=interactive 1=normal 2=low
    };
    private readonly SemaphoreSlim[] _slots =
    {
        new(InteractiveParallel, InteractiveParallel),
        new(NormalParallel, NormalParallel),
        new(LowParallel, LowParallel),
    };
    private readonly CancellationTokenSource _shutdown = new();
    private readonly List<Thread> _pumps = new();
    private readonly Action<LlmJob>? _onDequeued;

    public LlmJobStore(Action<LlmJob>? onDequeued = null)
    {
        _onDequeued = onDequeued;
        for (var lane = 0; lane < 3; lane++)
        {
            var idx = lane;
            var t = new Thread(() => PumpLoop(idx)) { IsBackground = true, Name = $"llm-lane-{idx}" };
            t.Start();
            _pumps.Add(t);
        }
    }

    private static int LaneIndex(string lane) => lane switch
    {
        LlmContracts.LaneNormal => 1,
        LlmContracts.LaneLow => 2,
        _ => 0,
    };

    /// <summary>lane → 并发槽位数（自测/诊断用）。</summary>
    public static int LaneSlotOf(string lane) => LaneIndex(lane) switch
    {
        1 => NormalParallel,
        2 => LowParallel,
        _ => InteractiveParallel,
    };

    /// <summary>入队；low 满载返回 null（调用方回 E_LLM_HOST_LANE_FULL）。</summary>
    public LlmJob? Submit(LlmJob job)
    {
        var idx = LaneIndex(job.Lane);
        lock (_gate)
        {
            if (idx == 2 && _queues[2].Count >= LowQueueCap) return null;
            _queues[idx].Enqueue(job.Id);
            _jobs[job.Id] = job;
            Monitor.PulseAll(_gate);
        }
        return job;
    }

    public LlmJob? Find(string? jobId)
    {
        if (string.IsNullOrEmpty(jobId)) return null;
        lock (_gate) return _jobs.TryGetValue(jobId, out var j) ? j : null;
    }

    public bool Cancel(string jobId)
    {
        var job = Find(jobId);
        if (job == null) return false;
        lock (_gate)
        {
            if (job.IsTerminal) return true;
            // 尚未出队：从队列摘除并落取消终态；运行中：保留状态，由 Cts 让执行流收口
            var wasQueued = false;
            for (var i = 0; i < _queues.Length; i++)
            {
                if (_queues[i].Count == 0) continue;
                var remaining = _queues[i].Where(id => id != jobId).ToList();
                wasQueued |= remaining.Count != _queues[i].Count;
                _queues[i] = new Queue<string>(remaining);
            }
            if (wasQueued) job.State = LlmJobState.Cancelled;
            Monitor.PulseAll(_gate);
        }
        try { job.Cts.Cancel(); } catch { /* 已释放 */ }
        if (job.State == LlmJobState.Cancelled) job.FinishedAt = DateTimeOffset.UtcNow;
        return true;
    }

    private void PumpLoop(int laneIdx)
    {
        while (!_shutdown.IsCancellationRequested)
        {
            LlmJob? job = null;
            lock (_gate)
            {
                while (_queues[laneIdx].Count == 0 && !_shutdown.IsCancellationRequested)
                    Monitor.Wait(_gate, 500);
                if (_shutdown.IsCancellationRequested) return;
                job = _jobs[_queues[laneIdx].Dequeue()];
            }
            if (job.IsTerminal) continue;
            _slots[laneIdx].Wait(_shutdown.Token);
            if (_shutdown.IsCancellationRequested) { _slots[laneIdx].Release(); return; }
            lock (_gate)
            {
                if (job.State == LlmJobState.Cancelled) { _slots[laneIdx].Release(); continue; }
                job.State = LlmJobState.Running;
                job.StartedAt = DateTimeOffset.UtcNow;
            }
            try { _onDequeued?.Invoke(job); }
            catch (Exception ex)
            {
                job.Append(new LlmEvent { Type = LlmContracts.EvError, Code = LlmContracts.ErrBadRequest, Message = $"调度异常: {ex.Message}", Retryable = false });
                job.State = LlmJobState.Error;
                job.FinishedAt = DateTimeOffset.UtcNow;
            }
            finally
            {
                // 完成时机由执行方置终态；这里只归还并发槽。终态后仍可能有长轮询在读尾事件，
                // 归还即允许下一作业并行——正确性由 job 隔离保证。
                _slots[laneIdx].Release();
            }
        }
    }

    /// <summary>清 TTL 过期作业（宿主循环定时调用）。</summary>
    public void SweepExpired()
    {
        List<string>? dead = null;
        lock (_gate)
        {
            foreach (var (id, job) in _jobs)
            {
                if (job.IsTerminal && job.FinishedAt.HasValue && DateTimeOffset.UtcNow - job.FinishedAt.Value > LlmJob.Ttl)
                    (dead ??= new List<string>()).Add(id);
            }
            if (dead != null) foreach (var id in dead) _jobs.Remove(id);
        }
        if (dead != null)
            foreach (var id in dead) try { Find(id)?.Cts.Dispose(); } catch { }
    }

    public (int jobs, int running, int queued) Snapshot()
    {
        lock (_gate)
        {
            var running = _jobs.Values.Count(j => j.State is LlmJobState.Running or LlmJobState.WaitingRetry);
            var queued = _queues.Sum(q => q.Count);
            return (_jobs.Count, running, queued);
        }
    }

    public void Dispose()
    {
        _shutdown.Cancel();
        lock (_gate) Monitor.PulseAll(_gate);
        foreach (var s in _slots) try { s.Dispose(); } catch { }
    }
}

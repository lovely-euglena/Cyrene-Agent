using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;

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

/// <summary>
/// poll 结果：事件段 + clamp 后的有效 nextCursor（P2-1①）+ 真实缺口标记 Gap（P2-2：
/// 请求 cursor 落在已丢弃段——该段事件不可恢复，消费侧应告警；仅 ring 回收已消费事件时 Gap=false）。
/// </summary>
public readonly record struct LlmPollSlice(IReadOnlyList<LlmEvent> Events, int NextCursor, bool Gap);

/// <summary>结构化指标（设计 §6 可观测；终态时经 stderr 结构化日志 + llm.status 出口）。</summary>
public sealed class LlmJobMetrics
{
    public string JobId { get; set; } = "";
    public string Lane { get; set; } = "";
    public LlmJobState State { get; set; }
    public long? QueueWaitMs { get; set; }
    public long? TtftMs { get; set; }
    public long? TotalMs { get; set; }
    public int Retries { get; set; }
    public long DroppedEvents { get; set; }
    public long? TokensOut { get; set; }
    public string? ErrorCode { get; set; }
    public DateTimeOffset? ClosedAt { get; set; }
}

/// <summary>
/// 单条作业：事件 ring + 长轮询等待 + 重试/取消/指标。
///
/// 反压语义（IKJM7D 复审 P0-2 修复；P2-1① 按实现订正口径）：
///   - ring 上限 RingCapacity；**满时 drop-oldest**（_base 前移 + _dropped 计数；单次腾位
///     即保证终态 done/error 可追加），SSE 回调永不阻塞、永不死锁；
///   - 反压按「未确认量 = EventCount - PolledCursor」判定：poll 消费推进 PolledCursor，
///     上游读在 > LowWater 时暂停、降至 ≤LowWater 恢复（**单一阈值，无独立高水位/迟滞**）；
///   - _dropped 是 ring 回收累计（含「已 poll 消费、仅因 ring 满被回收」的事件），
///     不等于增量缺口；真实缺口由 Poll 的 Gap（请求 cursor < _base）判定；
///   - 消费者死亡导致的永久暂停由 stall 兜底（service 侧 60s 超水位 → truncated 终态）。
/// </summary>
public sealed class LlmJob
{
    public const int RingCapacity = 4096;      // 对齐设计 §4（复审提示项：8192→4096）
    public const int LowWater = 1024;          // 暂停阈值（单一阈值，无迟滞——P2-1①）
    public const int StallTimeoutMs = 60_000;  // 超水位暂停兜底（消费者死亡）
    public static readonly TimeSpan Ttl = TimeSpan.FromMinutes(5); // 对齐设计（10min→5min）

    public string Id { get; } = "j" + Guid.NewGuid().ToString("N")[..12];
    public string Lane { get; }
    public string Endpoint { get; }
    public string Method { get; }
    public string Body { get; }
    public string? AuthVaultKey { get; }
    public string AuthStyle { get; }
    /// <summary>authStyle=raw 时的鉴权头名（如 x-api-key / api-key；bearer 走 Authorization 固定头）。</summary>
    public string AuthHeaderName { get; }
    public IReadOnlyDictionary<string, string> Headers { get; }
    public string Protocol { get; }
    public int TimeoutMs { get; }
    public int MaxRetries { get; }
    public int IdleTimeoutMs { get; }
    public LlmJobMetrics Metrics { get; } = new();

    public LlmJobState State { get; set; } = LlmJobState.Queued;
    public bool SawVisibleDelta { get; set; }
    public DateTimeOffset EnqueuedAt { get; } = DateTimeOffset.UtcNow;
    public DateTimeOffset? StartedAt { get; set; }
    public DateTimeOffset? FinishedAt { get; set; }
    public CancellationTokenSource Cts { get; } = new();

    /// <summary>执行 Task（service 注入；pump 据此持有槽位至终态——P0-3）。</summary>
    public Task? RunTask { get; set; }

    private readonly object _gate = new();
    private readonly List<LlmEvent> _events = new();          // [base, base+count) 绝对序号连续
    private int _base;                                        // 已被 drop-oldest 丢弃的事件数
    private long _dropped;                                    // ring 回收累计（含已消费事件；非缺口，P2-2）
    private long _polledCursor;                               // 消费位点（TS 已拉取到的最大 nextCursor）

    public LlmJob(string lane, string endpoint, string method, string body,
        string? authVaultKey, string authStyle, IReadOnlyDictionary<string, string> headers,
        string protocol, int timeoutMs, int maxRetries, int idleTimeoutMs, string? authHeaderName = null)
    {
        Lane = lane; Endpoint = endpoint; Method = method; Body = body;
        AuthVaultKey = authVaultKey; AuthStyle = authStyle; AuthHeaderName = authHeaderName ?? "x-api-key"; Headers = headers;
        Protocol = protocol; TimeoutMs = timeoutMs; MaxRetries = maxRetries; IdleTimeoutMs = idleTimeoutMs;
        Metrics.JobId = Id; Metrics.Lane = lane;
    }

    public int EventCount { get { lock (_gate) return _base + _events.Count; } }
    public long DroppedEvents { get { lock (_gate) return _dropped; } }
    public bool IsTerminal => State is LlmJobState.Done or LlmJobState.Error or LlmJobState.Cancelled;

    /// <summary>未确认事件量（生产-消费差）：高水位反压按此判定，poll 消费推进后回落。</summary>
    public int PendingCount { get { lock (_gate) return _base + _events.Count - (int)Math.Min((long)_base + _events.Count, Interlocked.Read(ref _polledCursor)); } }

    /// <summary>
    /// 追加事件；ring 满时 drop-oldest（_base 前移，_dropped 回收累计）。
    /// 满时先丢弃一条最旧腾位再追加（单次 drop 已保证终态 done/error 必达，无二次分支）。
    /// 实现偏差（P2-3，已在设计稿注记）：不做工具/usage/finish 保护位，全事件同权 drop-oldest——
    /// 反压下未确认量 ≤~1025 << RingCapacity，被驱逐事件必已消费，保护位收益与游标改造成本不成比例。
    /// </summary>
    public bool Append(LlmEvent e)
    {
        lock (_gate)
        {
            if (_events.Count >= RingCapacity)
            {
                _events.RemoveAt(0);
                _base++;
                _dropped++;
            }
            _events.Add(e);
            Monitor.PulseAll(_gate); // 唤醒长轮询等待者
            return true;
        }
    }

    /// <summary>
    /// 取 [cursor, cursor+max) 事件段；cursor 低于 _base（已被丢弃）时从 _base 起补读
    /// （丢弃段不可恢复；真实缺口经 slice.Gap 上报，DroppedEvents 只是回收累计，P2-2）。
    /// 为空且 waitMs>0 时长轮询（Monitor.Wait，不占读帧线程）。
    /// 复审 P2-1①：返回 clamp 后的有效 nextCursor——宿主不得按 cursor+events.Count 自算
    /// （cursor 在丢弃段时会重复投递同一批事件）。
    /// </summary>
    public LlmPollSlice Poll(int cursor, int maxEvents, int waitMs)
    {
        lock (_gate)
        {
            var effective = Math.Clamp(cursor, _base, _base + _events.Count);
            var deadline = waitMs <= 0 ? DateTime.MinValue : DateTime.UtcNow.AddMilliseconds(waitMs);
            while (effective >= _base + _events.Count && !IsTerminal)
            {
                var remaining = (long)(deadline - DateTime.UtcNow).TotalMilliseconds;
                if (waitMs <= 0 || remaining <= 0 || !Monitor.Wait(_gate, (int)Math.Min(remaining, int.MaxValue)))
                    break;
                effective = Math.Clamp(effective, _base, _base + _events.Count);
            }
            // P2-2：缺口按「请求 cursor 落后于当前 _base」判定（等待期间发生的回收同样计入）——
            // 已消费事件被回收不构成缺口。
            var gap = cursor < _base;
            var take = Math.Min(maxEvents, _base + _events.Count - effective);
            var slice = _events.GetRange(effective - _base, Math.Max(0, take));
            var next = effective + slice.Count;
            if (next > Interlocked.Read(ref _polledCursor))
                Interlocked.Exchange(ref _polledCursor, next);
            return new LlmPollSlice(slice, next, gap);
        }
    }

    /// <summary>当前未确认量快照（service 反压判定用）。</summary>
    public int Unconfirmed() => PendingCount;
}

/// <summary>
/// 作业注册表 + 三 lane 队列调度。
///
/// 并发语义（IKJM7D 复审 P0-3 修复）：pump 出队后调用 onDequeued（service 注入
/// job.RunTask），**同步等待 RunTask 完成后才 Release 槽位**——并发上限在作业整个
/// 运行期生效，low lane 严格单并发 FIFO。
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
        // 每 lane 按并发槽位数起 pump（P0-3：4/2/1 真实生效——槽位持到作业终态）
        for (var lane = 0; lane < 3; lane++)
        {
            var count = lane switch { 1 => NormalParallel, 2 => LowParallel, _ => InteractiveParallel };
            for (var i = 0; i < count; i++)
            {
                var laneIdx = lane;
                var t = new Thread(() => PumpLoop(laneIdx)) { IsBackground = true, Name = $"llm-pump-{lane}-{i}" };
                _pumps.Add(t);
                t.Start();
            }
        }
    }

    private void PumpLoop(int laneIdx)
    {
        try
        {
            while (!_shutdown.IsCancellationRequested)
            {
                LlmJob? job;
                try
                {
                    _slots[laneIdx].Wait(_shutdown.Token);
                }
                catch (OperationCanceledException) { break; }
                catch (ObjectDisposedException) { break; }

                job = Take(laneIdx);
                if (job == null)
                {
                    _slots[laneIdx].Release();
                    if (_shutdown.IsCancellationRequested) break;
                    lock (_gate)
                    {
                        if (_queues[laneIdx].Count == 0)
                            Monitor.Wait(_gate, 200); // 空转退避，防取不到时自旋烧 CPU
                    }
                    continue;
                }
                try
                {
                    _onDequeued?.Invoke(job);              // 注入 RunTask（同步启动）
                    job.RunTask?.Wait();                   // 槽位持有至作业终态（P0-3）
                }
                catch { /* RunTask 聚合异常已由 service 记录为终态 */ }
                finally
                {
                    try { _slots[laneIdx].Release(); }
                    catch (ObjectDisposedException) { /* dispose 竞速（P1-12） */ }
                    catch (SemaphoreFullException) { /* 重复释放防御 */ }
                }
            }
        }
        catch (OperationCanceledException) { /* shutdown：正常退出路径（P1-12） */ }
        catch (ObjectDisposedException) { /* dispose 竞速：静默退出 */ }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[llm-host] pump-{laneIdx} 异常退出: {ex.Message}");
        }
    }

    private static readonly object UnknownLaneGate = new();
    private static readonly HashSet<string> UnknownLanes = new(StringComparer.Ordinal);

    /// <summary>复审 P2-1③：未知 lane 不再静默归 interactive——warn 一次（每值）。</summary>
    private static int LaneIndex(string lane) => lane switch
    {
        LlmContracts.LaneNormal => 1,
        LlmContracts.LaneLow => 2,
        LlmContracts.LaneInteractive => 0,
        _ => UnknownLane(lane),
    };

    private static int UnknownLane(string lane)
    {
        lock (UnknownLaneGate)
        {
            if (UnknownLanes.Add(lane))
                Console.Error.WriteLine($"[llm-host] 未知 lane \"{lane}\" → 归 interactive（契约外值）");
        }
        return 0;
    }

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
        lock (_gate)
        {
            if (job.Lane == LlmContracts.LaneLow && _queues[2].Count >= LowQueueCap)
                return null; // 满载拒绝
            _jobs[job.Id] = job;
            _queues[LaneIndex(job.Lane)].Enqueue(job.Id);
            Monitor.PulseAll(_gate);
        }
        return job;
    }

    private LlmJob? Take(int laneIdx)
    {
        lock (_gate)
        {
            if (_queues[laneIdx].Count == 0) return null;
            var id = _queues[laneIdx].Dequeue();
            return _jobs.TryGetValue(id, out var j) ? j : null;
        }
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
        var wasQueued = false;
        lock (_gate)
        {
            if (job.IsTerminal) return true;
            // 尚未出队：从队列摘除并落取消终态；运行中：保留状态，由 Cts 让执行流收口
            for (var i = 0; i < _queues.Length; i++)
            {
                if (_queues[i].Count == 0) continue;
                var remaining = _queues[i].Where(id => id != jobId).ToList();
                wasQueued |= remaining.Count != _queues[i].Count;
                _queues[i] = new Queue<string>(remaining);
            }
            Monitor.PulseAll(_gate);
        }
        if (wasQueued)
        {
            // 复审 P2-2③：排队中取消也要落终态事件并唤醒 poll 等待方（原先只改 State，
            // 最迟 waitMs≤10s 才可见）。Append 在 job gate 上 PulseAll，终态立即可达。
            job.State = LlmJobState.Cancelled;
            job.Append(new LlmEvent
            {
                Type = LlmContracts.EvError, Code = LlmContracts.ErrCancelled, Retryable = false,
            });
            job.FinishedAt = DateTimeOffset.UtcNow;
        }
        try { job.Cts.Cancel(); } catch { /* 已释放 */ }
        return true;
    }

    /// <summary>终态作业过 TTL 后回收（_jobs 与事件 ring 释放）。宿主 Timer 定期调用（P0-4）。</summary>
    public void SweepExpired(TimeSpan? maxAge = null)
    {
        var ttl = maxAge ?? LlmJob.Ttl;
        List<LlmJob>? dead = null;
        lock (_gate)
        {
            foreach (var (id, job) in _jobs)
            {
                if (job.IsTerminal && job.FinishedAt.HasValue && DateTimeOffset.UtcNow - job.FinishedAt.Value > ttl)
                    (dead ??= new List<LlmJob>()).Add(job);
            }
            if (dead != null)
                foreach (var job in dead) _jobs.Remove(job.Id); // 引用已持有，Remove 后仍可清理 Cts（修死代码）
        }
        if (dead != null)
            foreach (var job in dead)
                try { job.Cts.Dispose(); } catch { /* 并发取消竞速 */ }
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
        foreach (var t in _pumps)
            try { t.Join(2000); } catch { /* 已退出 */ }
        foreach (var s in _slots) try { s.Dispose(); } catch { }
    }
}

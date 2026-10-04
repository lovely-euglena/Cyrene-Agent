namespace CyreneNative.Scheduler;

/// <summary>
/// 调度引擎：逐行对照 src/main/scheduler/scheduler-engine.ts。
///
/// - 单 timer（延迟 1h 封顶）；store 变更 → 重排；
/// - 启动 / 插件启停后做逾期归一：once 逾期写 skipped/"missed while app was
///   closed" 历史并停用；周期任务滚动到未来（不补跑）；
/// - 到点触发：先推进排期（updateTask{nextFireAt,lastFiredAt}）再并发执行，
///   崩溃窗口内不重复触发；running 去重（重复触发写 skipped/"previous run
///   still active"）；canRun 为假（插件未运行）时跳过本次但照常推进；
/// - FireNow：不推进排期的手动触发；
/// - 插件启用口径 = PluginUserEnabled && approvalFingerprint 非空（授权指纹
///   由 TS 侧维护，C# 不算指纹）；
/// - 不依赖 WPF / DispatcherTimer：默认 System.Threading.Timer，测试可注入
///   延迟执行 seam（Func&lt;TimeSpan, Func&lt;Task&gt;, IDisposable&gt;）手动触发。
/// </summary>
public sealed class SchedulerEngine
{
    /// <summary>定时器延迟上限：1 小时（对齐 TS MAX_TIMER_DELAY_MS）。</summary>
    public static readonly TimeSpan MaxTimerDelay = TimeSpan.FromHours(1);

    private readonly ISchedulerTaskStore _store;
    private readonly Func<ScheduledTask, DateTimeOffset, bool, Task<SchedulerRunResult>> _runTask;
    private readonly Func<ScheduledTask, bool>? _canRunTask;
    private readonly Func<DateTimeOffset> _now;
    private readonly Func<string> _id;
    private readonly Func<TimeSpan, Func<Task>, IDisposable> _scheduleTimer;
    private readonly object _runningGate = new();
    private readonly HashSet<string> _runningTaskIds = new(StringComparer.Ordinal);
    private IDisposable? _timer;
    private bool _subscribed;

    public SchedulerEngine(
        ISchedulerTaskStore store,
        Func<ScheduledTask, DateTimeOffset, bool, Task<SchedulerRunResult>> runTask,
        Func<ScheduledTask, bool>? canRunTask = null,
        Func<DateTimeOffset>? now = null,
        Func<string>? id = null,
        Func<TimeSpan, Func<Task>, IDisposable>? scheduleTimer = null)
    {
        _store = store;
        _runTask = runTask;
        _canRunTask = canRunTask;
        _now = now ?? (() => DateTimeOffset.Now);
        _id = id ?? (() => $"hist-{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}-{SchedulerStoreHelpers.RandomBase36(6)}");
        _scheduleTimer = scheduleTimer ?? DefaultScheduleTimer;
    }

    /// <summary>
    /// 统一启用判断：用户任务看磁盘 enabled；插件任务看有效授权
    /// （pluginUserEnabled + 非空授权指纹）。指纹内容由 TS 侧校验。
    /// </summary>
    public static bool IsTaskEnabled(ScheduledTask task)
        => task.OwnerPluginId is not null
            ? task.PluginUserEnabled == true && !string.IsNullOrEmpty(task.ApprovalFingerprint)
            : task.Enabled;

    public void Start()
    {
        NormalizeOverdueTasks();
        if (!_subscribed)
        {
            _store.Changed += OnStoreChanged;
            _subscribed = true;
        }
        ScheduleNextTimer();
    }

    public void Stop()
    {
        DisposeTimer();
        if (_subscribed)
        {
            _store.Changed -= OnStoreChanged;
            _subscribed = false;
        }
    }

    /// <summary>
    /// 插件启停后调用：重新归一化逾期任务并重排计时器。
    /// 只推进下一次触发时间，不补跑停用期间错过的任务。
    /// </summary>
    public void RefreshPluginTasks()
    {
        NormalizeOverdueTasks();
        ScheduleNextTimer();
    }

    public async Task<FireNowResult> FireNowAsync(string taskId)
    {
        var task = _store.GetTasks().FirstOrDefault(item => item.Id == taskId);
        if (task is null) return new FireNowResult(false, "task not found");
        if (!IsTaskEnabled(task)) return new FireNowResult(false, "task is disabled");
        if (!CanRun(task)) return new FireNowResult(false, "plugin not running");
        if (IsRunning(task.Id)) return new FireNowResult(false, "task already running");
        await RunOneAsync(task, _now(), manual: true).ConfigureAwait(false);
        return new FireNowResult(true);
    }

    private bool CanRun(ScheduledTask task) => _canRunTask is null || _canRunTask(task);

    /// <summary>关停任务时写入的 patch：用户任务清 enabled，插件任务清用户授权。</summary>
    private static ScheduledTaskPatch DisablePatch(ScheduledTask task)
        => task.OwnerPluginId is not null
            ? new ScheduledTaskPatch { PluginUserEnabled = false, NextFireAt = null }
            : new ScheduledTaskPatch { Enabled = false, NextFireAt = null };

    private void NormalizeOverdueTasks()
    {
        var now = _now();
        foreach (var task in _store.GetTasks())
        {
            if (!IsTaskEnabled(task) || task.NextFireAt is null) continue;
            if ((task.MaxRuns is int maxRuns && (task.RunCount ?? 0) >= maxRuns)
                || (task.EndAt is not null && SchedulerJson.TryParseIso(task.EndAt, out var endAt) && endAt <= now))
            {
                _store.UpdateTask(task.Id, DisablePatch(task));
                continue;
            }
            if (!SchedulerJson.TryParseIso(task.NextFireAt, out var next))
            {
                _store.UpdateTask(task.Id, DisablePatch(task));
                continue;
            }
            if (next > now) continue;
            if (task.Schedule.Kind == ScheduleKind.Once)
            {
                _store.RecordHistory(new ScheduledTaskHistoryEntry
                {
                    Id = _id(),
                    TaskId = task.Id,
                    TaskTitle = task.Title,
                    FiredAt = SchedulerJson.ToIsoString(now),
                    Status = ScheduledTaskHistoryStatus.Skipped,
                    Reason = "missed while app was closed",
                    EffectiveToolIds = new List<string>(),
                });
                _store.UpdateTask(task.Id, DisablePatch(task));
                continue;
            }
            var normalized = ScheduleCalculator.NormalizeOverdueNextFireAt(task.Schedule, next, now);
            if ((task.MaxRuns is int maxRunsLimit && (task.RunCount ?? 0) >= maxRunsLimit)
                || EndConditionExceeded(task, normalized))
            {
                _store.UpdateTask(task.Id, DisablePatch(task));
                continue;
            }
            _store.UpdateTask(task.Id, new ScheduledTaskPatch { NextFireAt = SchedulerJson.ToIsoStringOrNull(normalized) });
        }
    }

    private void ScheduleNextTimer()
    {
        DisposeTimer();
        var now = _now();
        ScheduledTask? nextTask = null;
        foreach (var task in _store.GetTasks())
        {
            if (!IsTaskEnabled(task) || task.NextFireAt is null) continue;
            if (!SchedulerJson.TryParseIso(task.NextFireAt, out _)) continue;
            if (nextTask is null || string.CompareOrdinal(task.NextFireAt, nextTask.NextFireAt) < 0) nextTask = task;
        }
        if (nextTask?.NextFireAt is null) return;
        if (!SchedulerJson.TryParseIso(nextTask.NextFireAt, out var next)) return;
        var delay = next - now;
        if (delay < TimeSpan.Zero) delay = TimeSpan.Zero;
        if (delay > MaxTimerDelay) delay = MaxTimerDelay;
        _timer = _scheduleTimer(delay, FireDueTasksAsync);
    }

    private async Task FireDueTasksAsync()
    {
        var now = _now();
        var due = _store.GetTasks()
            .Where(task => IsTaskEnabled(task)
                && task.NextFireAt is not null
                && SchedulerJson.TryParseIso(task.NextFireAt, out var at)
                && at <= now)
            .ToList();
        foreach (var task in due)
        {
            var scheduledFireAt = task.NextFireAt is not null && SchedulerJson.TryParseIso(task.NextFireAt, out var parsed)
                ? parsed
                : now;
            if (task.MaxRuns is int maxRuns && (task.RunCount ?? 0) >= maxRuns)
            {
                _store.UpdateTask(task.Id, DisablePatch(task));
                continue;
            }
            if (task.EndAt is not null && SchedulerJson.TryParseIso(task.EndAt, out var endAt) && scheduledFireAt > endAt)
            {
                _store.UpdateTask(task.Id, DisablePatch(task));
                continue;
            }
            var nextRunCount = (task.RunCount ?? 0) + 1;
            if (!CanRun(task))
            {
                // 插件停用：跳过本次执行，但照常推进下一次时间，既不补跑，
                // 也避免逾期任务让计时器进入零延迟循环。
                _store.RecordHistory(new ScheduledTaskHistoryEntry
                {
                    Id = _id(),
                    TaskId = task.Id,
                    TaskTitle = task.Title,
                    FiredAt = SchedulerJson.ToIsoString(scheduledFireAt),
                    Status = ScheduledTaskHistoryStatus.Skipped,
                    Reason = "plugin not running",
                    EffectiveToolIds = new List<string>(),
                });
                var skippedNext = NextFireAtFor(task, scheduledFireAt, now);
                var skippedFinished = task.Schedule.Kind == ScheduleKind.Once
                    || (task.MaxRuns is int skippedMaxRuns && nextRunCount >= skippedMaxRuns)
                    || EndConditionExceeded(task, skippedNext);
                var skippedPatch = skippedFinished
                    ? DisablePatch(task)
                    : new ScheduledTaskPatch { NextFireAt = SchedulerJson.ToIsoStringOrNull(skippedNext) };
                skippedPatch.LastFiredAt = SchedulerJson.ToIsoString(scheduledFireAt);
                _store.UpdateTask(task.Id, skippedPatch);
                continue;
            }

            // 先发起执行、后推进排期：runOne 同步登记 running 并启动 runner，
            // 排期推进独立于执行完成，崩溃窗口内不会重复触发。
            _ = RunOneDetachedAsync(task, scheduledFireAt);
            var next = NextFireAtFor(task, scheduledFireAt, now);
            var finished = task.Schedule.Kind == ScheduleKind.Once
                || (task.MaxRuns is int limit && nextRunCount >= limit)
                || EndConditionExceeded(task, next);
            var patch = finished
                ? DisablePatch(task)
                : new ScheduledTaskPatch { NextFireAt = SchedulerJson.ToIsoStringOrNull(next) };
            patch.LastFiredAt = SchedulerJson.ToIsoString(scheduledFireAt);
            _store.UpdateTask(task.Id, patch);
        }
        ScheduleNextTimer();
    }

    private static DateTimeOffset? NextFireAtFor(ScheduledTask task, DateTimeOffset scheduledFireAt, DateTimeOffset now)
    {
        var rawNext = ScheduleCalculator.ComputeNextFireAtAfter(task.Schedule, scheduledFireAt);
        return rawNext is not null && rawNext <= now
            ? ScheduleCalculator.NormalizeOverdueNextFireAt(task.Schedule, rawNext.Value, now)
            : rawNext;
    }

    /// <summary>对齐 TS：`task.endAt && (!next || next &gt; Date.parse(task.endAt))`（坏 endAt 不误伤）。</summary>
    private static bool EndConditionExceeded(ScheduledTask task, DateTimeOffset? next)
    {
        if (string.IsNullOrEmpty(task.EndAt)) return false;
        if (next is null) return true;
        return SchedulerJson.TryParseIso(task.EndAt, out var endAt) && next > endAt;
    }

    private async Task RunOneAsync(ScheduledTask task, DateTimeOffset scheduledFireAt, bool manual)
    {
        if (!TryEnterRunning(task.Id))
        {
            if (!manual)
            {
                _store.RecordHistory(new ScheduledTaskHistoryEntry
                {
                    Id = _id(),
                    TaskId = task.Id,
                    TaskTitle = task.Title,
                    FiredAt = SchedulerJson.ToIsoString(scheduledFireAt),
                    Status = ScheduledTaskHistoryStatus.Skipped,
                    Reason = "previous run still active",
                    EffectiveToolIds = new List<string>(),
                });
            }
            return;
        }
        try
        {
            await _runTask(task, scheduledFireAt, manual).ConfigureAwait(false);
        }
        finally
        {
            ExitRunning(task.Id);
        }
    }

    /// <summary>定时触发路径的 fire-and-forget：执行结果由 runner 自报，这里兜底异常。</summary>
    private async Task RunOneDetachedAsync(ScheduledTask task, DateTimeOffset scheduledFireAt)
    {
        try
        {
            await RunOneAsync(task, scheduledFireAt, manual: false).ConfigureAwait(false);
        }
        catch
        {
            // 对齐 TS void runOne：失败由 runner 落历史，引擎不因单任务异常停摆。
        }
    }

    private bool TryEnterRunning(string taskId)
    {
        lock (_runningGate) return _runningTaskIds.Add(taskId);
    }

    private void ExitRunning(string taskId)
    {
        lock (_runningGate) _runningTaskIds.Remove(taskId);
    }

    private bool IsRunning(string taskId)
    {
        lock (_runningGate) return _runningTaskIds.Contains(taskId);
    }

    private void OnStoreChanged(IReadOnlyList<ScheduledTask> tasks) => ScheduleNextTimer();

    private void DisposeTimer()
    {
        _timer?.Dispose();
        _timer = null;
    }

    /// <summary>默认定时器：System.Threading.Timer（跨平台，无 WPF 依赖）。</summary>
    private static IDisposable DefaultScheduleTimer(TimeSpan delay, Func<Task> callback)
    {
        if (delay < TimeSpan.Zero) delay = TimeSpan.Zero;
        var timer = new Timer(
            _ => _ = InvokeTimerCallbackAsync(callback),
            null,
            Timeout.InfiniteTimeSpan,
            Timeout.InfiniteTimeSpan);
        timer.Change(delay, Timeout.InfiniteTimeSpan);
        return timer;
    }

    private static async Task InvokeTimerCallbackAsync(Func<Task> callback)
    {
        try
        {
            await callback().ConfigureAwait(false);
        }
        catch
        {
            // 后台 timer 回调异常不得终结进程。
        }
    }
}

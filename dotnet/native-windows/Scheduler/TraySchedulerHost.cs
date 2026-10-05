using System.IO;
using System.Text.Json;
using CyreneNative.Scheduler;

namespace CyreneNative;

/// <summary>
/// 常驻托盘内的调度宿主（IKJK51，设计 §2/§4/§6）：持有 SchedulerStore +
/// SchedulerEngine 单实例——host 模式下托盘是任务/历史文件的唯一写者。
///
/// - 所有 store/engine 访问经 <see cref="_gate"/> 串行化（named pipe 读线程
///   vs 引擎 timer 线程；引擎回调不重入本锁）；
/// - 引擎到点：Electron 在线 → 发 {op:"event",name:"sched.fire"} 后立即返回
///   （历史由 Electron 经 sched.report 回写）；离线 → 预建 running 历史 +
///   Process.Start headless Electron（--scheduled-task/--scheduled-history/
///   --scheduled-fire-at，UseShellExecute=false）；启动失败写 failed 历史 +
///   气泡；headless 终态（success/failed）report 到达时气泡提醒并出队；
/// - 复审 P1-1：headless 拉起串行排队（同一时刻至多一个执行实例；前一个终态
///   或进程退出后再拉下一个）。进程无 report 退出（单实例锁失败/崩溃）→ 宽限
///   后写 failed 历史 + 气泡，不再永久 running；
/// - 复审 P1-1：Start() 把遗留 running 历史标为中断（上一托盘进程崩溃未回报）；
/// - 复审 P1-5：跟踪 headless 进程句柄，Stop()（完全退出）时按句柄杀进程树
///   （不会误杀主 Electron）并把 running 历史写中断；
/// - 任务写操作（store.Changed，含引擎排期推进）统一广播 sched.changed
///   全量快照；历史/插件状态不广播；
/// - sched.mode：Electron 双轨协商（enabled=false 停引擎防双调度——TS
///   scheduler 回退接管；enabled=true 恢复）。
/// </summary>
internal sealed class TraySchedulerHost
{
    private readonly object _gate = new();
    private readonly SchedulerStore _store;
    private readonly SchedulerEngine _engine;
    private readonly Dictionary<string, bool> _pluginRunning = new(StringComparer.Ordinal);
    /// <summary>本进程 headless 拉起/排队且尚未收到终态 report 的 histId → 任务信息。</summary>
    private readonly Dictionary<string, HeadlessJobInfo> _headlessPending = new(StringComparer.Ordinal);
    /// <summary>等待前一个 headless 终态的执行队列（复审 P1-1 串行化）。</summary>
    private readonly Queue<HeadlessJob> _headlessQueue = new();
    /// <summary>当前在跑的 headless 历史 id（null = 无在跑实例）。</summary>
    private string? _headlessActiveHistId;
    /// <summary>当前在跑的 headless 进程句柄（完全退出时按句柄杀，不误杀主 Electron）。</summary>
    private System.Diagnostics.Process? _headlessProcess;
    /// <summary>是否已收到 Electron 的插件运行状态同步（复审 P2-7 首连窗口）。</summary>
    private bool _pluginStateKnown;
    private readonly string _electronExe;
    private readonly Func<string, object, bool> _sendEvent;
    private readonly Action<string, string> _showBalloon;
    private readonly Func<bool> _isElectronConnected;
    /// <summary>--scheduler 启动即启用；false 时等待 Electron 经 sched.mode arm。</summary>
    private readonly bool _schedulerEnabled;
    private bool _engineRunning;

    /// <summary>headless 进程退出后等待迟到 report 的宽限（测试可缩短）。</summary>
    internal TimeSpan HeadlessExitGrace { get; set; } = TimeSpan.FromSeconds(3);

    /// <summary>进程启动 seam（自测注入；缺省 Process.Start）。返回 null 视为已启动但不可跟踪。</summary>
    internal Func<System.Diagnostics.ProcessStartInfo, System.Diagnostics.Process?> ProcessStarter { get; set; }
        = psi => System.Diagnostics.Process.Start(psi);

    /// <summary>自测可读状态。</summary>
    internal bool EngineRunning => _engineRunning;
    internal int QueuedHeadlessCount { get { lock (_gate) return _headlessQueue.Count; } }
    internal string? ActiveHeadlessHistId { get { lock (_gate) return _headlessActiveHistId; } }

    public TraySchedulerHost(
        string dataDir,
        string electronExe,
        bool schedulerEnabled,
        Func<string, object, bool> sendEvent,
        Action<string, string> showBalloon,
        Func<bool>? isElectronConnected = null,
        Func<TimeSpan, Func<Task>, IDisposable>? scheduleTimer = null)
    {
        _electronExe = electronExe;
        _schedulerEnabled = schedulerEnabled;
        _sendEvent = sendEvent;
        _showBalloon = showBalloon;
        _isElectronConnected = isElectronConnected ?? (() => true);
        _store = new SchedulerStore(dataDir);
        _engine = new SchedulerEngine(_store, RunTaskAsync, CanRunTask, scheduleTimer: scheduleTimer);
    }

    /// <summary>
    /// 启动：加载归一（store.Load）→ 遗留 running 历史标为中断（复审 P1-1）；
    /// --scheduler 时 engine.Start（逾期归一 + timer），否则仅托盘 UI，
    /// 等 sched.mode enabled:true 由 Electron 接管启用。
    /// </summary>
    public void Start()
    {
        lock (_gate)
        {
            _store.Load();
            _store.MarkRunningHistoryInterrupted("interrupted: tray restarted while task was running");
            _store.Changed += OnTasksChanged;
            if (_schedulerEnabled)
            {
                _engine.Start();
                _engineRunning = true;
            }
        }
    }

    /// <summary>
    /// 完全退出路径：先停引擎（不再触发/拉起），中止在跑 headless 进程树并
    /// 把 running 历史写中断（复审 P1-5），再退托盘。
    /// </summary>
    public void Stop()
    {
        System.Diagnostics.Process? process;
        lock (_gate)
        {
            try { _engine.Stop(); } catch { /* 退出路径不抛 */ }
            _store.Changed -= OnTasksChanged;
            _engineRunning = false;
            _headlessQueue.Clear();
            _headlessPending.Clear();
            _headlessActiveHistId = null;
            process = _headlessProcess;
            _headlessProcess = null;
        }
        if (process is { } p)
        {
            try
            {
                if (!p.HasExited) p.Kill(entireProcessTree: true);
            }
            catch { /* 权限/已退出：忽略 */ }
            finally { p.Dispose(); }
        }
        try
        {
            // 按文件对账：所有遗留 running（在跑进程 + 排队项 + 在线运行）标中断。
            _store.MarkRunningHistoryInterrupted("interrupted: tray exited while task was running");
        }
        catch { /* 退出路径不抛 */ }
    }

    /// <summary>处理 sched.* 帧；返回回执 data（无 id 帧由调用方丢弃 data）。</summary>
    public SchedulerOpResult Handle(string op, JsonElement frame)
    {
        try
        {
            switch (op)
            {
                case "sched.snapshot":
                    lock (_gate) return SchedulerOpResult.Success(new { tasks = _store.GetTasks() });

                case "sched.add":
                {
                    var input = ReadPayload<NewScheduledTaskInput>(frame, "input");
                    lock (_gate) return SchedulerOpResult.Success(_store.AddTask(input));
                }

                case "sched.update":
                {
                    var taskId = ReadRequiredString(frame, "taskId");
                    var patch = ReadPayload<ScheduledTaskPatch>(frame, "patch");
                    lock (_gate) return SchedulerOpResult.Success(_store.UpdateTask(taskId, patch));
                }

                case "sched.toggle":
                {
                    var taskId = ReadRequiredString(frame, "taskId");
                    var enabled = ReadRequiredBool(frame, "enabled");
                    lock (_gate) return SchedulerOpResult.Success(_store.ToggleTask(taskId, enabled));
                }

                case "sched.delete":
                {
                    var taskId = ReadRequiredString(frame, "taskId");
                    lock (_gate) return SchedulerOpResult.Success(_store.DeleteTask(taskId));
                }

                case "sched.delete-owner":
                {
                    var pluginId = ReadRequiredString(frame, "pluginId");
                    lock (_gate) return SchedulerOpResult.Success(_store.DeleteTasksByOwner(pluginId));
                }

                case "sched.history":
                {
                    var taskId = ReadRequiredString(frame, "taskId");
                    var limit = ReadOptionalInt(frame, "limit") ?? 10;
                    lock (_gate) return SchedulerOpResult.Success(_store.GetHistory(taskId, limit));
                }

                case "sched.report":
                {
                    var entry = ReadPayload<ScheduledTaskHistoryEntry>(frame, "entry");
                    return HandleReport(entry);
                }

                case "sched.plugin-state":
                {
                    var running = ReadRunningMap(frame);
                    lock (_gate)
                    {
                        _pluginRunning.Clear();
                        foreach (var pair in running) _pluginRunning[pair.Key] = pair.Value;
                        _pluginStateKnown = true;
                        _engine.RefreshPluginTasks();
                    }
                    return SchedulerOpResult.Success(new { });
                }

                case "sched.mode":
                {
                    // 双轨协商：enabled=false → 停引擎（TS scheduler 回退接管，防双调度）；
                    // enabled=true → 恢复（幂等）。
                    var enabled = ReadRequiredBool(frame, "enabled");
                    lock (_gate)
                    {
                        if (enabled && !_engineRunning)
                        {
                            _engine.Start();
                            _engineRunning = true;
                        }
                        else if (!enabled && _engineRunning)
                        {
                            _engine.Stop();
                            _engineRunning = false;
                        }
                    }
                    return SchedulerOpResult.Success(new { });
                }

                default:
                    return SchedulerOpResult.Failure($"unknown op: {op}");
            }
        }
        catch (SchedulerValidationException ex) { return SchedulerOpResult.Failure(ex.Message); }
        catch (JsonException ex) { return SchedulerOpResult.Failure($"invalid payload: {ex.Message}"); }
        catch (InvalidOperationException ex) { return SchedulerOpResult.Failure(ex.Message); }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[TraySchedulerHost] {op} failed: {ex}");
            return SchedulerOpResult.Failure(ex.Message);
        }
    }

    // ── 引擎委托 ────────────────────────────────────────────────

    /// <summary>
    /// 到点执行：在线（管道可写）→ sched.fire 事件交 Electron scheduler-runner，
    /// 立即返回；离线 → headless 拉起（串行排队）。写失败按离线处理（避免任务静默丢失）。
    /// </summary>
    private Task<SchedulerRunResult> RunTaskAsync(ScheduledTask task, DateTimeOffset scheduledFireAt, bool manual)
    {
        var iso = SchedulerJson.ToIsoString(scheduledFireAt);
        if (_sendEvent("sched.fire", new { taskId = task.Id, scheduledFireAt = iso }))
        {
            return Task.FromResult(new SchedulerRunResult { Ok = true, EffectiveToolIds = new List<string>() });
        }
        return Task.FromResult(LaunchHeadless(task, iso));
    }

    /// <summary>
    /// 插件任务离线语义：插件未运行 → false（引擎自动写 skipped/"plugin not running"
    /// 并推进排期）；用户任务恒可跑。
    ///
    /// 复审 P2-7 首连窗口：Electron 在线但插件状态尚未同步时按「暂缓判定」处理
    /// （返回 true，交 Electron 执行前用 isTaskEnabled/canRunTask 复核）；离线时
    /// 仍按未运行处理（插件运行需要 Electron）。
    /// </summary>
    private bool CanRunTask(ScheduledTask task)
    {
        if (task.OwnerPluginId is null) return true;
        lock (_gate)
        {
            if (_pluginRunning.TryGetValue(task.OwnerPluginId, out var running)) return running;
            return !_pluginStateKnown && _isElectronConnected();
        }
    }

    private void OnTasksChanged(IReadOnlyList<ScheduledTask> tasks)
        => _sendEvent("sched.changed", new { tasks });

    // ── headless 拉起（串行队列，复审 P1-1） ─────────────────────

    private sealed record HeadlessJob(ScheduledTask Task, string Iso, string HistId);

    private sealed record HeadlessJobInfo(string TaskId, string Title, string Iso);

    private static string NewHistoryId()
        => $"hist-{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}-{SchedulerStoreHelpers.RandomBase36(6)}";

    private static ScheduledTaskHistoryEntry RunningEntry(ScheduledTask task, string iso, string histId)
        => new()
        {
            Id = histId,
            TaskId = task.Id,
            TaskTitle = task.Title,
            FiredAt = iso,
            Status = ScheduledTaskHistoryStatus.Running,
            Reason = "headless launch",
            EffectiveToolIds = new List<string>(),
        };

    /// <summary>
    /// 离线拉起：同一时刻至多一个执行实例；有在跑实例时入队（预建 running 历史，
    /// 终态/进程退出后出队拉起）。启动失败写 failed 历史 + 气泡并立即出队下一个。
    /// </summary>
    private SchedulerRunResult LaunchHeadless(ScheduledTask task, string iso)
    {
        HeadlessJob? queued = null;
        string histId;
        lock (_gate)
        {
            histId = NewHistoryId();
            var job = new HeadlessJob(task, iso, histId);
            _headlessPending[histId] = new HeadlessJobInfo(task.Id, task.Title, iso);
            _store.RecordHistory(RunningEntry(task, iso, histId));
            if (_headlessActiveHistId is not null)
            {
                _headlessQueue.Enqueue(job);
                queued = job;
            }
            else
            {
                _headlessActiveHistId = histId;
            }
        }
        if (queued is not null)
        {
            Console.Error.WriteLine($"[TraySchedulerHost] headless queued: {task.Id} ({histId})");
            return new SchedulerRunResult { Ok = true, HistoryId = histId, EffectiveToolIds = new List<string>() };
        }
        return StartHeadlessProcess(task, iso, histId);
    }

    /// <summary>启动 headless 进程；失败 → failed 历史 + 气泡 + 出队下一个。</summary>
    private SchedulerRunResult StartHeadlessProcess(ScheduledTask task, string iso, string histId)
    {
        try
        {
            if (string.IsNullOrEmpty(_electronExe) || !File.Exists(_electronExe))
                throw new FileNotFoundException("Electron exe not found", _electronExe);
            var startInfo = new System.Diagnostics.ProcessStartInfo
            {
                FileName = _electronExe,
                UseShellExecute = false,
                WorkingDirectory = Path.GetDirectoryName(_electronExe) ?? "",
            };
            startInfo.ArgumentList.Add("--scheduled-task");
            startInfo.ArgumentList.Add(task.Id);
            startInfo.ArgumentList.Add("--scheduled-history");
            startInfo.ArgumentList.Add(histId);
            startInfo.ArgumentList.Add("--scheduled-fire-at");
            startInfo.ArgumentList.Add(iso);
            var process = ProcessStarter(startInfo);
            if (process is not null)
            {
                lock (_gate) _headlessProcess = process;
                // 复审 P2-4：先订阅再开事件——已启动进程若立即退出，先开事件会让
                // Exited 回调先于订阅丢失，该 histId 队列停滞至迟到 report/下次对账。
                process.Exited += (_, _) => OnHeadlessProcessExited(histId, process);
                process.EnableRaisingEvents = true;
            }
            Console.Error.WriteLine($"[TraySchedulerHost] headless launch: {task.Id} ({histId})");
            return new SchedulerRunResult { Ok = true, HistoryId = histId, EffectiveToolIds = new List<string>() };
        }
        catch (Exception ex)
        {
            lock (_gate)
            {
                _store.RecordHistory(new ScheduledTaskHistoryEntry
                {
                    Id = histId,
                    TaskId = task.Id,
                    TaskTitle = task.Title,
                    FiredAt = iso,
                    FinishedAt = SchedulerJson.ToIsoString(DateTimeOffset.Now),
                    Status = ScheduledTaskHistoryStatus.Failed,
                    Reason = "headless launch",
                    ErrorMessage = ex.Message,
                    EffectiveToolIds = new List<string>(),
                });
                _headlessPending.Remove(histId);
                if (_headlessActiveHistId == histId) _headlessActiveHistId = null;
            }
            _showBalloon("定时任务启动失败", $"{task.Title} 拉起失败：{ex.Message}");
            DrainHeadlessQueue();
            return new SchedulerRunResult
            {
                Ok = false,
                HistoryId = histId,
                Error = ex.Message,
                EffectiveToolIds = new List<string>(),
            };
        }
    }

    /// <summary>
    /// headless 进程退出但未收到终态 report（单实例锁失败/崩溃）：宽限后写
    /// failed 历史 + 气泡，不再永久 running；随后出队下一个。
    /// </summary>
    private void OnHeadlessProcessExited(string histId, System.Diagnostics.Process process)
    {
        var exitCode = -1;
        try { exitCode = process.ExitCode; } catch { /* 句柄已失效 */ }
        var grace = HeadlessExitGrace;
        _ = System.Threading.Tasks.Task.Delay(grace).ContinueWith(_ =>
        {
            string? title = null;
            var alreadyReported = false;
            try
            {
                lock (_gate)
                {
                    if (_headlessActiveHistId != histId) return; // 终态 report 已到（或已由 Stop 处理）
                    if (!_headlessPending.Remove(histId, out var info)) return;
                    // 复审 P2-3：TS 回退断连时会把真实终态直写同一历史文件；宽限内
                    // 若已有终态则视为「已回报」——不覆写 failed、不弹假失败气泡。
                    var existing = _store.FindHistoryById(histId);
                    if (existing is not null
                        && existing.Status is ScheduledTaskHistoryStatus.Success or ScheduledTaskHistoryStatus.Failed)
                    {
                        _headlessActiveHistId = null;
                        alreadyReported = true;
                        Console.Error.WriteLine($"[TraySchedulerHost] headless exit ignored (terminal already recorded): {histId}");
                    }
                    else
                    {
                        _store.RecordHistory(new ScheduledTaskHistoryEntry
                        {
                            Id = histId,
                            TaskId = info.TaskId,
                            TaskTitle = info.Title,
                            FiredAt = info.Iso,
                            FinishedAt = SchedulerJson.ToIsoString(DateTimeOffset.Now),
                            Status = ScheduledTaskHistoryStatus.Failed,
                            Reason = "headless process exited without report",
                            ErrorMessage = $"headless exited without report (exit code {exitCode})",
                            EffectiveToolIds = new List<string>(),
                        });
                        _headlessActiveHistId = null;
                        title = info.Title;
                    }
                }
                if (!alreadyReported)
                    _showBalloon("定时任务失败", $"{title} 执行进程异常退出且未回报结果（exit code {exitCode}）");
                DrainHeadlessQueue();
            }
            finally
            {
                try { process.Dispose(); } catch { /* 句柄清理失败不致命 */ }
            }
        });
    }

    /// <summary>
    /// 前一个 headless 终态后拉起队列中的下一个（同一时刻至多一个实例）。
    /// 复审 P2-5：出队时复核任务仍启用/可运行——排队期最长可达 30 分钟，任务可能
    /// 已被禁用/删除或插件已停用（对齐在线路径 fire 前复核口径）；不满足写 skipped
    /// 覆写预建 running，清在跑标记后继续出队，不拉起。
    /// </summary>
    private void DrainHeadlessQueue()
    {
        while (true)
        {
            HeadlessJob next;
            lock (_gate)
            {
                if (_headlessActiveHistId is not null || _headlessQueue.Count == 0) return;
                next = _headlessQueue.Dequeue();
                _headlessActiveHistId = next.HistId;
            }

            var current = _store.GetTasks().FirstOrDefault(task => task.Id == next.Task.Id);
            var skipReason = current is null
                ? "task not found"
                : !SchedulerEngine.IsTaskEnabled(current)
                    ? "task is disabled"
                    : !CanRunTask(current)
                        ? "plugin not running"
                        : null;
            if (skipReason is null)
            {
                StartHeadlessProcess(next.Task, next.Iso, next.HistId);
                return;
            }

            lock (_gate)
            {
                _store.RecordHistory(new ScheduledTaskHistoryEntry
                {
                    Id = next.HistId,
                    TaskId = next.Task.Id,
                    TaskTitle = next.Task.Title,
                    FiredAt = next.Iso,
                    FinishedAt = SchedulerJson.ToIsoString(DateTimeOffset.Now),
                    Status = ScheduledTaskHistoryStatus.Skipped,
                    Reason = skipReason,
                    EffectiveToolIds = new List<string>(),
                });
                _headlessPending.Remove(next.HistId);
                if (_headlessActiveHistId == next.HistId) _headlessActiveHistId = null;
            }
            Console.Error.WriteLine($"[TraySchedulerHost] headless skipped at drain: {next.Task.Id} ({next.HistId}) {skipReason}");
        }
    }

    /// <summary>历史写入 + headless 终态气泡（仅本进程拉起的 histId）。</summary>
    private SchedulerOpResult HandleReport(ScheduledTaskHistoryEntry entry)
    {
        var terminal = entry.Status is ScheduledTaskHistoryStatus.Success or ScheduledTaskHistoryStatus.Failed;
        string? headlessTitle = null;
        var wasActive = false;
        lock (_gate)
        {
            _store.RecordHistory(entry);
            if (terminal && !string.IsNullOrEmpty(entry.Id))
            {
                if (_headlessPending.Remove(entry.Id, out var info) && _headlessActiveHistId == entry.Id)
                {
                    headlessTitle = info.Title;
                    _headlessActiveHistId = null;
                    _headlessProcess = null;
                    wasActive = true;
                }
            }
        }
        if (wasActive)
        {
            if (headlessTitle is not null)
            {
                var success = entry.Status == ScheduledTaskHistoryStatus.Success;
                _showBalloon(
                    success ? "定时任务完成" : "定时任务失败",
                    success
                        ? $"{headlessTitle} 已在后台执行完成"
                        : string.IsNullOrEmpty(entry.ErrorMessage)
                            ? $"{headlessTitle} 执行失败"
                            : $"{headlessTitle} 执行失败：{entry.ErrorMessage}");
            }
            DrainHeadlessQueue();
        }
        return SchedulerOpResult.Success(new { });
    }

    // ── 帧解析 ──────────────────────────────────────────────────

    private static T ReadPayload<T>(JsonElement frame, string name)
    {
        if (!frame.TryGetProperty(name, out var element)) throw new JsonException($"missing {name}");
        return element.Deserialize<T>(SchedulerJson.Options) ?? throw new JsonException($"invalid {name}");
    }

    private static string ReadRequiredString(JsonElement frame, string name)
    {
        if (frame.TryGetProperty(name, out var element) && element.ValueKind == JsonValueKind.String)
        {
            var value = element.GetString();
            if (!string.IsNullOrEmpty(value)) return value;
        }
        throw new JsonException($"missing {name}");
    }

    private static bool ReadRequiredBool(JsonElement frame, string name)
    {
        if (frame.TryGetProperty(name, out var element)
            && element.ValueKind is JsonValueKind.True or JsonValueKind.False)
        {
            return element.GetBoolean();
        }
        throw new JsonException($"missing {name}");
    }

    private static int? ReadOptionalInt(JsonElement frame, string name)
        => frame.TryGetProperty(name, out var element) && element.ValueKind == JsonValueKind.Number
            ? element.GetInt32()
            : null;

    private static Dictionary<string, bool> ReadRunningMap(JsonElement frame)
    {
        var result = new Dictionary<string, bool>(StringComparer.Ordinal);
        if (frame.TryGetProperty("running", out var element) && element.ValueKind == JsonValueKind.Object)
        {
            foreach (var property in element.EnumerateObject())
            {
                if (property.Value.ValueKind is JsonValueKind.True or JsonValueKind.False)
                    result[property.Name] = property.Value.GetBoolean();
            }
        }
        return result;
    }
}

/// <summary>sched.* 帧处理结果：Ok=false 时 Error 回执 error 字段。</summary>
internal readonly record struct SchedulerOpResult(bool Ok, object? Data, string? Error)
{
    public static SchedulerOpResult Success(object? data = null) => new(true, data, null);
    public static SchedulerOpResult Failure(string error) => new(false, null, error);
}

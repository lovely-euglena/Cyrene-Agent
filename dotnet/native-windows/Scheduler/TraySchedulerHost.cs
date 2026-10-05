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
    /// <summary>本进程 headless 拉起且尚未收到终态 report 的 histId → 任务标题。</summary>
    private readonly Dictionary<string, string> _headlessHistories = new(StringComparer.Ordinal);
    private readonly string _electronExe;
    private readonly Func<string, object, bool> _sendEvent;
    private readonly Action<string, string> _showBalloon;
    /// <summary>--scheduler 启动即启用；false 时等待 Electron 经 sched.mode arm。</summary>
    private readonly bool _schedulerEnabled;
    private bool _engineRunning;

    public TraySchedulerHost(
        string dataDir,
        string electronExe,
        bool schedulerEnabled,
        Func<string, object, bool> sendEvent,
        Action<string, string> showBalloon)
    {
        _electronExe = electronExe;
        _schedulerEnabled = schedulerEnabled;
        _sendEvent = sendEvent;
        _showBalloon = showBalloon;
        _store = new SchedulerStore(dataDir);
        _engine = new SchedulerEngine(_store, RunTaskAsync, CanRunTask);
    }

    /// <summary>
    /// 启动：加载归一（store.Load）；--scheduler 时 engine.Start（逾期归一 + timer），
    /// 否则仅托盘 UI，等 sched.mode enabled:true 由 Electron 接管启用。
    /// </summary>
    public void Start()
    {
        lock (_gate)
        {
            _store.Load();
            _store.Changed += OnTasksChanged;
            if (_schedulerEnabled)
            {
                _engine.Start();
                _engineRunning = true;
            }
        }
    }

    /// <summary>完全退出路径：先停引擎（不再触发/拉起），再退托盘。</summary>
    public void Stop()
    {
        lock (_gate)
        {
            try { _engine.Stop(); } catch { /* 退出路径不抛 */ }
            _store.Changed -= OnTasksChanged;
            _engineRunning = false;
        }
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
    /// 立即返回；离线 → headless 拉起。写失败按离线处理（避免任务静默丢失）。
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
    /// </summary>
    private bool CanRunTask(ScheduledTask task)
    {
        if (task.OwnerPluginId is null) return true;
        lock (_gate) return _pluginRunning.TryGetValue(task.OwnerPluginId, out var running) && running;
    }

    private void OnTasksChanged(IReadOnlyList<ScheduledTask> tasks)
        => _sendEvent("sched.changed", new { tasks });

    // ── headless 拉起 ───────────────────────────────────────────

    private SchedulerRunResult LaunchHeadless(ScheduledTask task, string iso)
    {
        var histId = $"hist-{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}-{SchedulerStoreHelpers.RandomBase36(6)}";
        lock (_gate)
        {
            _store.RecordHistory(new ScheduledTaskHistoryEntry
            {
                Id = histId,
                TaskId = task.Id,
                TaskTitle = task.Title,
                FiredAt = iso,
                Status = ScheduledTaskHistoryStatus.Running,
                Reason = "headless launch",
                EffectiveToolIds = new List<string>(),
            });
        }

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
            var process = System.Diagnostics.Process.Start(startInfo);
            process?.Dispose();
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
                    Status = ScheduledTaskHistoryStatus.Failed,
                    Reason = "headless launch",
                    ErrorMessage = ex.Message,
                    EffectiveToolIds = new List<string>(),
                });
            }
            _showBalloon("定时任务启动失败", $"{task.Title} 拉起失败：{ex.Message}");
            return new SchedulerRunResult
            {
                Ok = false,
                HistoryId = histId,
                Error = ex.Message,
                EffectiveToolIds = new List<string>(),
            };
        }

        lock (_gate) _headlessHistories[histId] = task.Title;
        Console.Error.WriteLine($"[TraySchedulerHost] headless launch: {task.Id} ({histId})");
        return new SchedulerRunResult { Ok = true, HistoryId = histId, EffectiveToolIds = new List<string>() };
    }

    /// <summary>历史写入 + headless 终态气泡（仅本进程拉起的 histId）。</summary>
    private SchedulerOpResult HandleReport(ScheduledTaskHistoryEntry entry)
    {
        var terminal = entry.Status is ScheduledTaskHistoryStatus.Success or ScheduledTaskHistoryStatus.Failed;
        string? headlessTitle = null;
        lock (_gate)
        {
            _store.RecordHistory(entry);
            if (terminal && !string.IsNullOrEmpty(entry.Id))
                _headlessHistories.Remove(entry.Id, out headlessTitle);
        }
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

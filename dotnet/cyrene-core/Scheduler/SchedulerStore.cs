using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace CyreneNative.Scheduler;

/// <summary>引擎依赖的任务存储最小面（便于自测注入假实现，同 TS SchedulerStoreLike）。</summary>
public interface ISchedulerTaskStore
{
    IReadOnlyList<ScheduledTask> GetTasks();
    ScheduledTask UpdateTask(string id, ScheduledTaskPatch patch);
    void RecordHistory(ScheduledTaskHistoryEntry entry);
    event Action<IReadOnlyList<ScheduledTask>>? Changed;
}

/// <summary>
/// 调度任务存储：逐行对照 src/main/scheduler/scheduler-store.ts。
///
/// - 文件：{dataDir}/scheduled-tasks.json（{"tasks":[...]}，缩进 2）与
///   {dataDir}/scheduled-tasks-history.jsonl（每行紧凑 JSON + 尾换行）；
/// - 加载归一：对齐 normalizeLoadedTask（旧插件任务停用 + allow-list、无
///   workspaceBinding 用户任务停用、runCount 归 0、maxRuns&gt;0、endAt 可解析、
///   mode 白名单等）；单任务坏数据只丢该任务；
/// - runCount 由 lastFiredAt 隐式 +1；重新启用（用户 enabled / 插件
///   pluginUserEnabled）时逾期归一；
/// - 历史：同 id 覆盖、每任务保留最近 50、全局最近 1000；
/// - 同步写盘（File.WriteAllText，UTF-8 无 BOM）；单写者语义（托盘进程独占），
///   进程内变更用替换快照 + 私有锁防交叉。
/// </summary>
public sealed class SchedulerStore : ISchedulerTaskStore
{
    private readonly string _tasksFile;
    private readonly string _historyFile;
    private readonly Func<DateTimeOffset> _now;
    private readonly Func<string> _id;
    private readonly object _gate = new();
    private List<ScheduledTask> _tasks = new();

    public event Action<IReadOnlyList<ScheduledTask>>? Changed;

    public SchedulerStore(string dataDir, Func<DateTimeOffset>? now = null, Func<string>? id = null)
    {
        _tasksFile = Path.Combine(dataDir, "scheduled-tasks.json");
        _historyFile = Path.Combine(dataDir, "scheduled-tasks-history.jsonl");
        _now = now ?? (() => DateTimeOffset.Now);
        _id = id ?? (() => $"task-{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}-{SchedulerStoreHelpers.RandomBase36(6)}");
    }

    public string TasksFile => _tasksFile;
    public string HistoryFile => _historyFile;

    // ---------------------------------------------------------------- 加载/归一

    public void Load()
    {
        var loaded = new List<ScheduledTask>();
        try
        {
            var text = File.ReadAllText(_tasksFile);
            using var document = JsonDocument.Parse(text);
            var root = document.RootElement;
            if (root.ValueKind == JsonValueKind.Object
                && root.TryGetProperty("tasks", out var tasksElement)
                && tasksElement.ValueKind == JsonValueKind.Array)
            {
                foreach (var element in tasksElement.EnumerateArray())
                {
                    var task = NormalizeLoadedTask(element);
                    if (task is not null) loaded.Add(task);
                }
            }
        }
        catch
        {
            loaded = new List<ScheduledTask>();
        }
        lock (_gate) _tasks = loaded;
    }

    private ScheduledTask? NormalizeLoadedTask(JsonElement raw)
    {
        if (raw.ValueKind != JsonValueKind.Object) return null;
        var id = ReadString(raw, "id")?.Trim();
        if (string.IsNullOrEmpty(id)) return null;
        var title = ReadString(raw, "title");
        var prompt = ReadString(raw, "prompt");
        if (title is null || prompt is null) return null;
        if (!raw.TryGetProperty("schedule", out var scheduleElement)) return null;
        ScheduleConfig? schedule;
        try
        {
            schedule = scheduleElement.Deserialize<ScheduleConfig>(SchedulerJson.Options);
        }
        catch (JsonException)
        {
            return null;
        }
        if (schedule is null) return null;
        try
        {
            SchedulerValidation.ValidateSchedule(schedule);
        }
        catch (SchedulerValidationException)
        {
            return null;
        }

        var ownerPluginId = ReadString(raw, "ownerPluginId")?.Trim();
        if (string.IsNullOrEmpty(ownerPluginId)) ownerPluginId = null;
        var workspaceBinding = raw.TryGetProperty("workspaceBinding", out var bindingElement)
            ? NormalizeWorkspaceBinding(bindingElement)
            : null;

        // 插件任务磁盘 enabled 永远 false；无 workspaceBinding 的旧用户任务停用
        //（不能被动继承当前聊天目录）。
        var enabled = ownerPluginId is null
            && workspaceBinding is not null
            && !(raw.TryGetProperty("enabled", out var enabledElement) && enabledElement.ValueKind == JsonValueKind.False);

        var task = new ScheduledTask
        {
            Id = id,
            Title = title.Trim(),
            Prompt = prompt.Trim(),
            Enabled = enabled,
            Schedule = schedule,
            NextFireAt = ownerPluginId is not null || workspaceBinding is not null ? ReadString(raw, "nextFireAt") : null,
            LastFiredAt = ReadString(raw, "lastFiredAt"),
            RunCount = (int)Math.Min(ReadNonNegativeInteger(raw, "runCount") ?? 0, int.MaxValue),
            ToolMode = ownerPluginId is not null
                ? SchedulerToolMode.AllowList
                : ReadString(raw, "toolMode") == "allow-list" ? SchedulerToolMode.AllowList : SchedulerToolMode.AllEnabled,
            AllowedToolIds = ReadAllowedToolIds(raw),
            CreatedAt = ReadString(raw, "createdAt") ?? SchedulerJson.EpochIso,
            UpdatedAt = ReadString(raw, "updatedAt") ?? SchedulerJson.EpochIso,
        };

        var maxRuns = ReadNonNegativeInteger(raw, "maxRuns");
        if (maxRuns is > 0) task.MaxRuns = (int)Math.Min(maxRuns.Value, int.MaxValue);

        var endAt = ReadString(raw, "endAt");
        if (endAt is not null && SchedulerJson.TryParseIso(endAt, out _)) task.EndAt = endAt;

        if (workspaceBinding is not null) task.WorkspaceBinding = workspaceBinding;

        if (ownerPluginId is not null)
        {
            task.OwnerPluginId = ownerPluginId;
            task.PluginUserEnabled = raw.TryGetProperty("pluginUserEnabled", out var pluginEnabled)
                && pluginEnabled.ValueKind == JsonValueKind.True;
            task.Mode = PluginPromptModes.Normalize(ReadString(raw, "mode"));
            task.ApprovalFingerprint = ReadString(raw, "approvalFingerprint") ?? "";
        }
        return task;
    }

    private WorkspaceBinding? NormalizeWorkspaceBinding(JsonElement element)
    {
        if (element.ValueKind != JsonValueKind.Object) return null;
        var workspaceRoot = ReadString(element, "workspaceRoot")?.Trim() ?? "";
        if (workspaceRoot.Length == 0) return null;
        var displayName = ReadString(element, "displayName")?.Trim();
        if (string.IsNullOrEmpty(displayName)) displayName = SchedulerStoreHelpers.BaseName(workspaceRoot);
        double boundAt;
        if (element.TryGetProperty("boundAt", out var boundAtElement)
            && boundAtElement.ValueKind == JsonValueKind.Number
            && boundAtElement.TryGetDouble(out var parsedBoundAt)
            && double.IsFinite(parsedBoundAt))
        {
            boundAt = parsedBoundAt;
        }
        else
        {
            boundAt = _now().ToUnixTimeMilliseconds();
        }
        return new WorkspaceBinding { WorkspaceRoot = workspaceRoot, DisplayName = displayName, BoundAt = boundAt };
    }

    /// <summary>类型化入参的等价归一（add/update 的 workspaceBinding）。</summary>
    private WorkspaceBinding? NormalizeWorkspaceBinding(WorkspaceBinding? binding)
    {
        if (binding is null) return null;
        var workspaceRoot = binding.WorkspaceRoot?.Trim() ?? "";
        if (workspaceRoot.Length == 0) return null;
        var displayName = binding.DisplayName?.Trim();
        if (string.IsNullOrEmpty(displayName)) displayName = SchedulerStoreHelpers.BaseName(workspaceRoot);
        var boundAt = double.IsFinite(binding.BoundAt) ? binding.BoundAt : _now().ToUnixTimeMilliseconds();
        return new WorkspaceBinding { WorkspaceRoot = workspaceRoot, DisplayName = displayName, BoundAt = boundAt };
    }

    private static string? ReadString(JsonElement element, string name)
        => element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    private static long? ReadNonNegativeInteger(JsonElement element, string name)
    {
        if (!element.TryGetProperty(name, out var value) || value.ValueKind != JsonValueKind.Number) return null;
        if (!value.TryGetInt64(out var number)) return null;
        return number >= 0 ? number : null;
    }

    private static List<string> ReadAllowedToolIds(JsonElement element)
    {
        var result = new List<string>();
        if (!element.TryGetProperty("allowedToolIds", out var array) || array.ValueKind != JsonValueKind.Array) return result;
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var item in array.EnumerateArray())
        {
            var value = JsStringValue(item)?.Trim();
            if (!string.IsNullOrEmpty(value) && seen.Add(value)) result.Add(value);
        }
        return result;
    }

    /// <summary>近似 JS String(value)（数组/对象极少出现在工具 ID 里，忽略）。</summary>
    private static string? JsStringValue(JsonElement element) => element.ValueKind switch
    {
        JsonValueKind.String => element.GetString(),
        JsonValueKind.Number => element.GetRawText(),
        JsonValueKind.True => "true",
        JsonValueKind.False => "false",
        JsonValueKind.Null => "null",
        _ => null,
    };

    // ---------------------------------------------------------------- 查询

    public IReadOnlyList<ScheduledTask> GetTasks()
    {
        var snapshot = _tasks;
        return snapshot.Select(task => task.Clone()).ToList();
    }

    // ---------------------------------------------------------------- CRUD

    public ScheduledTask AddTask(NewScheduledTaskInput input)
    {
        var title = (input.Title ?? "").Trim();
        var prompt = (input.Prompt ?? "").Trim();
        if (title.Length == 0) throw new SchedulerValidationException("标题不能为空");
        if (prompt.Length == 0) throw new SchedulerValidationException("提示词不能为空");
        if (input.Schedule is null) throw new SchedulerValidationException("缺少调度配置");
        SchedulerValidation.ValidateSchedule(input.Schedule);
        var ownerPluginId = string.IsNullOrEmpty(input.OwnerPluginId?.Trim()) ? null : input.OwnerPluginId!.Trim();
        var workspaceBinding = input.WorkspaceBinding is null ? null : NormalizeWorkspaceBinding(input.WorkspaceBinding);
        if (ownerPluginId is null && workspaceBinding is null)
            throw new SchedulerValidationException("用户定时任务必须绑定工作区");
        if (input.Mode is not null && PluginPromptModes.Normalize(input.Mode) is null)
            throw new SchedulerValidationException("会话模式无效");
        if (ownerPluginId is null && input.Mode is not null and not PluginPromptModes.Work and not PluginPromptModes.Code)
            throw new SchedulerValidationException("用户定时任务模式仅支持 work 或 code");

        var now = _now();
        var next = ScheduleCalculator.ComputeInitialNextFireAt(input.Schedule, now);
        if (input.Schedule.Kind == ScheduleKind.Once && next is null)
            throw new SchedulerValidationException("一次性任务时间必须晚于当前时间");
        if (input.MaxRuns is int maxRuns && (maxRuns < 1 || maxRuns > 10_000))
            throw new SchedulerValidationException("运行次数限制必须是 1-10000 的整数");
        DateTimeOffset? endAt = null;
        if (input.EndAt is not null)
        {
            if (!SchedulerJson.TryParseIso(input.EndAt, out var parsedEndAt)) throw new SchedulerValidationException("结束时间无效或早于下次运行时间");
            endAt = parsedEndAt;
        }
        if (endAt is not null && next is not null && next > endAt)
            throw new SchedulerValidationException("结束时间无效或早于下次运行时间");

        var task = new ScheduledTask
        {
            Title = title,
            Prompt = prompt,
            // 插件任务不接受 enabled 输入：永远 false 落盘，授权由 pluginUserEnabled 表达。
            Enabled = ownerPluginId is null && (input.Enabled ?? true),
            Schedule = input.Schedule,
            NextFireAt = SchedulerJson.ToIsoStringOrNull(next),
            RunCount = 0,
            MaxRuns = input.MaxRuns,
            EndAt = endAt is null ? null : SchedulerJson.ToIsoString(endAt.Value),
            WorkspaceBinding = workspaceBinding,
            ToolMode = ownerPluginId is null
                ? input.ToolMode ?? SchedulerToolMode.AllEnabled
                : SchedulerToolMode.AllowList,
            AllowedToolIds = SchedulerStoreHelpers.Uniq(input.AllowedToolIds ?? new List<string>()),
            CreatedAt = SchedulerJson.ToIsoString(now),
            UpdatedAt = SchedulerJson.ToIsoString(now),
        };
        if (ownerPluginId is not null)
        {
            task.OwnerPluginId = ownerPluginId;
            task.PluginUserEnabled = input.PluginUserEnabled == true;
            task.Mode = PluginPromptModes.Normalize(input.Mode);
            task.ApprovalFingerprint = input.ApprovalFingerprint ?? "";
        }
        else
        {
            task.Mode = input.Mode == PluginPromptModes.Code ? PluginPromptModes.Code : PluginPromptModes.Work;
        }

        lock (_gate)
        {
            // 复审 P2-3：id 生成与追加同一把锁，避免并发 add 产生重复 id。
            task.Id = NextTaskId();
            _tasks = new List<ScheduledTask>(_tasks) { task };
            PersistTasks(_tasks);
        }
        Notify();
        return task.Clone();
    }

    private string NextTaskId()
    {
        var existing = new HashSet<string>(_tasks.Select(task => task.Id), StringComparer.Ordinal);
        var candidate = _id();
        var counter = 1;
        while (existing.Contains(candidate))
        {
            candidate = $"{_id()}-{counter}";
            counter += 1;
        }
        return candidate;
    }

    public ScheduledTask UpdateTask(string id, ScheduledTaskPatch patch)
    {
        ScheduledTask result;
        lock (_gate)
        {
            var index = _tasks.FindIndex(task => task.Id == id);
            if (index < 0) throw new SchedulerValidationException("任务不存在");
            var current = _tasks[index];
            var isPluginTask = current.OwnerPluginId is not null;
            var workspaceBinding = patch.HasWorkspaceBinding
                ? NormalizeWorkspaceBinding(patch.WorkspaceBinding)
                : current.WorkspaceBinding;
            if (!isPluginTask && patch.Enabled == true && workspaceBinding is null)
                throw new SchedulerValidationException("启用用户定时任务前必须绑定工作区");
            if (!isPluginTask && patch.Mode is not null and not PluginPromptModes.Work and not PluginPromptModes.Code)
                throw new SchedulerValidationException("用户定时任务模式仅支持 work 或 code");

            var now = _now();
            var schedule = patch.Schedule ?? current.Schedule;
            SchedulerValidation.ValidateSchedule(schedule);
            if (patch.Mode is not null && PluginPromptModes.Normalize(patch.Mode) is null)
                throw new SchedulerValidationException("会话模式无效");

            var title = patch.Title is not null ? patch.Title.Trim() : current.Title;
            var prompt = patch.Prompt is not null ? patch.Prompt.Trim() : current.Prompt;
            if (title.Length == 0) throw new SchedulerValidationException("标题不能为空");
            if (prompt.Length == 0) throw new SchedulerValidationException("提示词不能为空");

            var scheduleChanged = patch.Schedule is not null;
            var enabling = !isPluginTask && patch.Enabled == true && !current.Enabled;
            var pluginEnabling = isPluginTask && patch.PluginUserEnabled == true && current.PluginUserEnabled != true;

            var maxRuns = !patch.HasMaxRuns ? current.MaxRuns : patch.MaxRuns;
            if (maxRuns is int maxRunsValue && (maxRunsValue < 1 || maxRunsValue > 10_000))
                throw new SchedulerValidationException("运行次数限制必须是 1-10000 的整数");

            var endAtText = patch.HasEndAt ? patch.EndAt : current.EndAt;
            DateTimeOffset? endAt = null;
            if (endAtText is not null)
            {
                if (!SchedulerJson.TryParseIso(endAtText, out var parsedEndAt))
                    throw new SchedulerValidationException("结束时间无效");
                endAt = parsedEndAt;
            }

            if (enabling && maxRuns is int maxRunsLimit && (current.RunCount ?? 0) >= maxRunsLimit)
                throw new SchedulerValidationException("任务已达到运行次数上限，请先调整结束条件");
            if (enabling && endAt is not null && endAt <= now)
                throw new SchedulerValidationException("任务结束日期已过，请先调整结束条件");
            if (enabling && schedule.Kind == ScheduleKind.Once && current.LastFiredAt is not null)
                throw new SchedulerValidationException("一次性任务已经运行完成");

            DateTimeOffset? next;
            if (patch.HasNextFireAt)
            {
                next = string.IsNullOrEmpty(patch.NextFireAt) ? null : (SchedulerJson.TryParseIso(patch.NextFireAt, out var explicitNext) ? explicitNext : null);
            }
            else if (scheduleChanged)
            {
                next = ScheduleCalculator.ComputeInitialNextFireAt(schedule, now);
            }
            else
            {
                next = current.NextFireAt is not null && SchedulerJson.TryParseIso(current.NextFireAt, out var currentNext)
                    ? currentNext
                    : null;
            }
            if (schedule.Kind == ScheduleKind.Once && scheduleChanged && next is null)
                throw new SchedulerValidationException("一次性任务时间必须晚于当前时间");

            if (enabling || pluginEnabling)
            {
                if (next is null)
                {
                    next = ScheduleCalculator.ComputeInitialNextFireAt(schedule, now);
                }
                else if (next <= now)
                {
                    next = ScheduleCalculator.NormalizeOverdueNextFireAt(schedule, next.Value, now);
                }
                if (schedule.Kind == ScheduleKind.Once && (next is null || next <= now)) next = null;
            }
            if (next is not null && endAt is not null && next > endAt)
                throw new SchedulerValidationException("结束时间早于下次运行时间");

            var lastFiredAt = patch.LastFiredAt ?? current.LastFiredAt;
            var runCount = patch.LastFiredAt is not null && patch.LastFiredAt != current.LastFiredAt
                ? (current.RunCount ?? 0) + 1
                : current.RunCount ?? 0;

            var updated = current.Clone();
            updated.Title = title;
            updated.Prompt = prompt;
            updated.Schedule = schedule;
            updated.NextFireAt = SchedulerJson.ToIsoStringOrNull(next);
            updated.RunCount = runCount;
            updated.MaxRuns = maxRuns;
            updated.EndAt = endAt is null ? null : SchedulerJson.ToIsoString(endAt.Value);
            updated.LastFiredAt = lastFiredAt;
            updated.WorkspaceBinding = workspaceBinding;
            // 插件任务的 enabled 与 toolMode 是宿主不变量：任何 patch 都改不掉。
            updated.Enabled = isPluginTask ? false : patch.Enabled ?? current.Enabled;
            updated.ToolMode = isPluginTask
                ? SchedulerToolMode.AllowList
                : patch.ToolMode ?? current.ToolMode;
            updated.AllowedToolIds = patch.AllowedToolIds is not null
                ? SchedulerStoreHelpers.Uniq(patch.AllowedToolIds)
                : new List<string>(current.AllowedToolIds);
            updated.UpdatedAt = SchedulerJson.ToIsoString(now);
            if (patch.PluginUserEnabled is bool pluginUserEnabled) updated.PluginUserEnabled = pluginUserEnabled;
            if (patch.ApprovalFingerprint is not null) updated.ApprovalFingerprint = patch.ApprovalFingerprint;
            if (patch.Mode is not null) updated.Mode = PluginPromptModes.Normalize(patch.Mode);

            _tasks = new List<ScheduledTask>(_tasks);
            _tasks[index] = updated;
            PersistTasks(_tasks);
            // 复审 P2-3：Notify 移出锁（与其余写方法口径一致；Changed 订阅者
            // 可能回调 store 读取，锁内通知易放大锁竞争）。
            result = updated.Clone();
        }
        Notify();
        return result;
    }

    public bool DeleteTask(string id)
    {
        lock (_gate)
        {
            var before = _tasks.Count;
            var remaining = _tasks.Where(task => task.Id != id).ToList();
            if (remaining.Count == before) return false;
            _tasks = remaining;
            PersistTasks(_tasks);
        }
        Notify();
        return true;
    }

    /// <summary>删除某插件拥有的全部任务（仅在用户真正卸载该插件时调用）。</summary>
    public int DeleteTasksByOwner(string pluginId)
    {
        int removed;
        lock (_gate)
        {
            var before = _tasks.Count;
            var remaining = _tasks.Where(task => task.OwnerPluginId != pluginId).ToList();
            removed = before - remaining.Count;
            if (removed == 0) return 0;
            _tasks = remaining;
            PersistTasks(_tasks);
        }
        Notify();
        return removed;
    }

    public ScheduledTask ToggleTask(string id, bool enabled)
        => UpdateTask(id, new ScheduledTaskPatch { Enabled = enabled });

    // ---------------------------------------------------------------- 历史

    public void RecordHistory(ScheduledTaskHistoryEntry entry)
    {
        lock (_gate)
        {
            var existing = ReadAllHistory().Where(item => item.Id != entry.Id).ToList();
            existing.Add(entry);
            WriteHistory(existing);
        }
    }

    /// <summary>
    /// 复审 P1-1：托盘启动时把遗留 running 历史标为中断（上一托盘进程崩溃/退出
    /// 未回报终态）。之后到达的迟到 report 仍可按同 id 覆盖为真实终态。
    /// </summary>
    public int MarkRunningHistoryInterrupted(string reason)
    {
        lock (_gate)
        {
            var all = ReadAllHistory();
            var running = all.Where(item => item.Status == ScheduledTaskHistoryStatus.Running).ToList();
            if (running.Count == 0) return 0;
            var finishedAt = SchedulerJson.ToIsoString(_now());
            foreach (var entry in running)
            {
                entry.Status = ScheduledTaskHistoryStatus.Failed;
                entry.Reason = reason;
                entry.ErrorMessage = reason;
                entry.FinishedAt ??= finishedAt;
            }
            WriteHistory(all);
            return running.Count;
        }
    }

    public IReadOnlyList<ScheduledTaskHistoryEntry> GetHistory(string taskId, int limit = 10)
    {
        // 复审 P2-3：读路径纳入锁，避免读到写入中的历史文件。
        lock (_gate)
        {
            return ReadAllHistory()
                .Where(item => item.TaskId == taskId)
                .OrderByDescending(item => item.FiredAt, StringComparer.Ordinal)
                .Take(limit)
                .ToList();
        }
    }

    /// <summary>历史文件整体重写（同 id 覆盖 + 每任务 50 / 全局 1000 压缩）。</summary>
    private void WriteHistory(List<ScheduledTaskHistoryEntry> entries)
    {
        EnsureParent(_historyFile);
        var compacted = entries
            .GroupBy(item => item.TaskId)
            .SelectMany(group => group.OrderBy(item => item.FiredAt, StringComparer.Ordinal).TakeLast(50))
            .OrderBy(item => item.FiredAt, StringComparer.Ordinal)
            .TakeLast(1000)
            .ToList();
        var text = compacted.Count == 0
            ? ""
            : string.Join("\n", compacted.Select(item => JsonSerializer.Serialize(item, SchedulerJson.Options))) + "\n";
        File.WriteAllText(_historyFile, text, SchedulerStoreHelpers.Utf8NoBom);
    }

    private List<ScheduledTaskHistoryEntry> ReadAllHistory()
    {
        try
        {
            if (!File.Exists(_historyFile)) return new List<ScheduledTaskHistoryEntry>();
            var text = File.ReadAllText(_historyFile);
            var result = new List<ScheduledTaskHistoryEntry>();
            foreach (var rawLine in text.Split('\n'))
            {
                var line = rawLine.TrimEnd('\r');
                if (line.Length == 0) continue;
                try
                {
                    var item = JsonSerializer.Deserialize<ScheduledTaskHistoryEntry>(line, SchedulerJson.Options);
                    // TS 过滤 `typeof item.taskId === "string"`；坏行跳过而非整读失败（有意偏差，见报告）。
                    if (item is not null && item.TaskId is not null) result.Add(item);
                }
                catch (JsonException)
                {
                    // 单行损坏（如崩溃时的半行）不拖垮整段历史。
                }
            }
            return result;
        }
        catch
        {
            return new List<ScheduledTaskHistoryEntry>();
        }
    }

    // ---------------------------------------------------------------- 持久化/事件

    private void PersistTasks(List<ScheduledTask> tasks)
    {
        EnsureParent(_tasksFile);
        var payload = JsonSerializer.Serialize(new TasksFilePayload { Tasks = tasks }, SchedulerStoreHelpers.TasksFileOptions);
        File.WriteAllText(_tasksFile, payload, SchedulerStoreHelpers.Utf8NoBom);
    }

    private static void EnsureParent(string file)
    {
        var directory = Path.GetDirectoryName(file);
        if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);
    }

    private void Notify()
    {
        var handler = Changed;
        if (handler is null) return;
        var snapshot = GetTasks();
        foreach (var listener in handler.GetInvocationList().Cast<Action<IReadOnlyList<ScheduledTask>>>())
        {
            try
            {
                listener(snapshot);
            }
            catch
            {
                // 对齐 TS：单个监听器失败不影响其他监听器与写盘。
            }
        }
    }

    private sealed class TasksFilePayload
    {
        public List<ScheduledTask> Tasks { get; set; } = new();
    }
}

/// <summary>存储侧公共校验与工具（对齐 scheduler-store.ts 的 validateSchedule / uniq 等）。</summary>
public static class SchedulerValidation
{
    private static readonly Regex TimeOfDayRegex = new("^[0-9]{2}:[0-9]{2}$", RegexOptions.Compiled);

    /// <summary>供插件调度服务在调用 store 前做同样的结构校验。</summary>
    public static void ValidateSchedule(ScheduleConfig? schedule)
    {
        if (schedule is null) throw new SchedulerValidationException("缺少调度配置");
        switch (schedule.Kind)
        {
            case ScheduleKind.Daily:
                ValidateTimeOfDay(schedule.TimeOfDay, "每日时间");
                break;
            case ScheduleKind.Weekdays:
                ValidateTimeOfDay(schedule.TimeOfDay, "工作日时间");
                break;
            case ScheduleKind.Weekly:
                if (schedule.DayOfWeek is not int dayOfWeek || dayOfWeek < 0 || dayOfWeek > 6)
                    throw new SchedulerValidationException("星期必须是 0-6");
                ValidateTimeOfDay(schedule.TimeOfDay, "每周时间");
                break;
            case ScheduleKind.Monthly:
            {
                if (schedule.DayOfMonth is not int dayOfMonth || dayOfMonth < 1 || dayOfMonth > 31)
                    throw new SchedulerValidationException("每月日期必须是 1-31");
                ValidateTimeOfDay(schedule.TimeOfDay, "每月时间");
                break;
            }
            case ScheduleKind.Yearly:
            {
                if (schedule.Month is not int month || month < 1 || month > 12)
                    throw new SchedulerValidationException("月份必须是 1-12");
                if (schedule.DayOfMonth is not int dayOfMonth || dayOfMonth < 1 || dayOfMonth > 31)
                    throw new SchedulerValidationException("日期必须是 1-31");
                var maxDay = DateTime.DaysInMonth(2024, month); // TS: new Date(2024, month, 0).getDate()
                if (dayOfMonth > maxDay) throw new SchedulerValidationException("该月份没有这个日期");
                ValidateTimeOfDay(schedule.TimeOfDay, "每年时间");
                break;
            }
            case ScheduleKind.Interval:
            {
                if (schedule.Every is not int every || every <= 0)
                    throw new SchedulerValidationException("间隔必须是正整数");
                if (schedule.Unit == IntervalUnit.Minutes && every > 1440)
                    throw new SchedulerValidationException("分钟间隔不能超过 1440");
                if (schedule.Unit == IntervalUnit.Hours && every > 168)
                    throw new SchedulerValidationException("小时间隔不能超过 168");
                if (schedule.Unit is not (IntervalUnit.Minutes or IntervalUnit.Hours))
                    throw new SchedulerValidationException("间隔单位无效");
                break;
            }
            case ScheduleKind.Once:
                if (!SchedulerJson.TryParseIso(schedule.RunAt, out _))
                    throw new SchedulerValidationException("一次性运行时间无效");
                break;
            default:
                throw new SchedulerValidationException("未知调度类型");
        }
    }

    private static void ValidateTimeOfDay(string? timeOfDay, string label)
    {
        if (timeOfDay is null || !TimeOfDayRegex.IsMatch(timeOfDay))
            throw new SchedulerValidationException($"{label}格式必须是 HH:mm");
        var hours = int.Parse(timeOfDay.AsSpan(0, 2), CultureInfo.InvariantCulture);
        var minutes = int.Parse(timeOfDay.AsSpan(3, 2), CultureInfo.InvariantCulture);
        if (hours is < 0 or > 23 || minutes is < 0 or > 59)
            throw new SchedulerValidationException($"{label}必须是有效时间");
    }
}

internal static class SchedulerStoreHelpers
{
    internal static readonly Encoding Utf8NoBom = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false);

    internal static readonly JsonSerializerOptions TasksFileOptions = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true,
        // 复审 P2-2：中文任务标题与 TS JSON.stringify 落盘同形（不转 \uXXXX）。
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    internal static string RandomBase36(int length)
    {
        const string alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
        var chars = new char[length];
        for (var i = 0; i < length; i += 1) chars[i] = alphabet[Random.Shared.Next(alphabet.Length)];
        return new string(chars);
    }

    /// <summary>对齐 TS uniq：逐项 trim、去空、去重且保留首次出现顺序。</summary>
    internal static List<string> Uniq(IEnumerable<string> values)
    {
        var result = new List<string>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var value in values)
        {
            var trimmed = (value ?? "").Trim();
            if (trimmed.Length == 0) continue;
            if (seen.Add(trimmed)) result.Add(trimmed);
        }
        return result;
    }

    /// <summary>近似 path.basename（同时识别 / 与 \\，忽略尾分隔符）。</summary>
    internal static string BaseName(string path)
    {
        var trimmed = path.TrimEnd('/', '\\');
        var index = Math.Max(trimmed.LastIndexOf('/'), trimmed.LastIndexOf('\\'));
        return index >= 0 ? trimmed[(index + 1)..] : trimmed;
    }
}

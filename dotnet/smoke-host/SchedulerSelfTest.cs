using CyreneNative.Scheduler;
using System.Text.Json;

namespace CyreneSmoke;

/// <summary>
/// 定时任务调度核心自测（cyrene-smoke --selftest scheduler，Linux 可跑）：
/// 把 TS 侧 schedule-calculator / scheduler-store / scheduler-engine 三个测试文件
/// 的向量逐条移植为断言（唯一事实源：src/main/scheduler/*.test.ts）。
/// 输出约定：[PASS]/[FAIL] + 末行 SELFTEST scheduler: PASS / N FAILURES；退出码 0/1。
/// </summary>
internal static class SchedulerSelfTest
{
    public static int Run()
    {
        var failures = new FailureCounter();
        SerializationChecks(failures);
        CalculatorChecks(failures);
        StoreChecks(failures);
        EngineChecks(failures);
        Console.WriteLine(failures.Count == 0
            ? "SELFTEST scheduler: PASS"
            : $"SELFTEST scheduler: {failures.Count} FAILURES");
        return failures.Count == 0 ? 0 : 1;
    }

    // ================================================================ 序列化口径

    private static void SerializationChecks(FailureCounter f)
    {
        var daily = JsonSerializer.Serialize(ScheduleConfig.Daily("09:00"), SchedulerJson.Options);
        var weekdays = JsonSerializer.Serialize(ScheduleConfig.Weekdays("09:00"), SchedulerJson.Options);
        var weekly = JsonSerializer.Serialize(ScheduleConfig.Weekly(3, "09:30"), SchedulerJson.Options);
        var monthly = JsonSerializer.Serialize(ScheduleConfig.Monthly(15, "08:30"), SchedulerJson.Options);
        var yearly = JsonSerializer.Serialize(ScheduleConfig.Yearly(3, 1, "10:00"), SchedulerJson.Options);
        var once = JsonSerializer.Serialize(ScheduleConfig.Once("2026-06-22T09:00:00.000Z"), SchedulerJson.Options);
        var interval = JsonSerializer.Serialize(ScheduleConfig.Interval(1, IntervalUnit.Hours), SchedulerJson.Options);
        f.Check("json: ScheduleConfig 输出与 TS 同形",
            daily == """{"kind":"daily","timeOfDay":"09:00"}"""
            && weekdays == """{"kind":"weekdays","timeOfDay":"09:00"}"""
            && weekly == """{"kind":"weekly","dayOfWeek":3,"timeOfDay":"09:30"}"""
            && monthly == """{"kind":"monthly","dayOfMonth":15,"timeOfDay":"08:30"}"""
            && yearly == """{"kind":"yearly","month":3,"dayOfMonth":1,"timeOfDay":"10:00"}"""
            && once == """{"kind":"once","runAt":"2026-06-22T09:00:00.000Z"}"""
            && interval == """{"kind":"interval","every":1,"unit":"hours"}""");

        var taskJson = JsonSerializer.Serialize(
            DailyTask(task => { task.NextFireAt = null; task.RunCount = 0; }),
            SchedulerJson.Options);
        f.Check("json: nextFireAt 显式 null、可选字段省略",
            taskJson.Contains("\"nextFireAt\":null", StringComparison.Ordinal)
            && !taskJson.Contains("maxRuns", StringComparison.Ordinal)
            && !taskJson.Contains("ownerPluginId", StringComparison.Ordinal)
            && taskJson.Contains("\"runCount\":0", StringComparison.Ordinal));

        WithDir(dir =>
        {
            var store = NewStore(dir, "2026-06-22T08:00:00.000Z", () => "id-1");
            store.Load();
            var added = store.AddTask(new NewScheduledTaskInput
            {
                Title = "A", Prompt = "B",
                Schedule = ScheduleConfig.Daily("09:00"),
                WorkspaceBinding = Binding(),
            });
            store.UpdateTask(added.Id, new ScheduledTaskPatch { NextFireAt = null });
            using var document = JsonDocument.Parse(File.ReadAllText(store.TasksFile));
            var taskElement = document.RootElement.GetProperty("tasks")[0];
            f.Check("json: tasks 文件 {tasks:[...]}、nextFireAt 显式 null、可选字段省略",
                taskElement.TryGetProperty("nextFireAt", out var nextFireAt) && nextFireAt.ValueKind == JsonValueKind.Null
                && taskElement.GetProperty("schedule").GetProperty("kind").GetString() == "daily"
                && taskElement.GetProperty("schedule").GetProperty("timeOfDay").GetString() == "09:00"
                && !taskElement.TryGetProperty("maxRuns", out _));
        });

        WithDir(dir =>
        {
            var store = NewStore(dir, "2026-06-22T08:00:00.000Z", () => "id-1");
            store.Load();
            store.RecordHistory(new ScheduledTaskHistoryEntry
            {
                Id = "hist-1", TaskId = "task-a", TaskTitle = "A",
                FiredAt = "2026-06-22T08:00:00.000Z", Status = ScheduledTaskHistoryStatus.Success,
                EffectiveToolIds = new List<string>(),
            });
            var text = File.ReadAllText(store.HistoryFile);
            var lines = text.Split('\n');
            f.Check("json: history JSONL 紧凑单行 + 尾换行",
                lines.Length == 2 && lines[1].Length == 0
                && lines[0].StartsWith('{') && lines[0].EndsWith('}')
                && !lines[0].Contains(": ", StringComparison.Ordinal)
                && !lines[0].Contains(", ", StringComparison.Ordinal));
        });
    }

    // ================================================================ calculator

    private static void CalculatorChecks(FailureCounter f)
    {
        var onceFuture = ScheduleCalculator.ComputeInitialNextFireAt(
            ScheduleConfig.Once("2026-06-22T09:00:00.000Z"),
            ParseUtc("2026-06-22T08:00:00.000Z"));
        f.Check("calculator: once runAt 在未来 → 采用 runAt",
            Iso(onceFuture) == "2026-06-22T09:00:00.000Z");

        var oncePast = ScheduleCalculator.ComputeInitialNextFireAt(
            ScheduleConfig.Once("2026-06-22T09:00:00.000Z"),
            ParseUtc("2026-06-22T10:00:00.000Z"));
        f.Check("calculator: once runAt 已过 → null", oncePast is null);

        var dailyToday = ScheduleCalculator.ComputeInitialNextFireAt(
            ScheduleConfig.Daily("08:00"), Local(2026, 6, 22, 7, 30));
        f.Check("calculator: daily 未到点 → 今天",
            dailyToday is { } d1 && d1.LocalDateTime == new DateTime(2026, 6, 22, 8, 0, 0));

        var dailyTomorrow = ScheduleCalculator.ComputeInitialNextFireAt(
            ScheduleConfig.Daily("08:00"), Local(2026, 6, 22, 8, 30));
        f.Check("calculator: daily 已过点 → 明天",
            dailyTomorrow is { } d2 && d2.LocalDateTime.Date == new DateTime(2026, 6, 23) && d2.LocalDateTime.Hour == 8);

        var monday = Local(2026, 6, 22, 7, 0);
        var weekly = ScheduleCalculator.ComputeInitialNextFireAt(
            ScheduleConfig.Weekly(3, "09:30"), monday);
        f.Check("calculator: weekly → 下一个匹配星期",
            monday.DayOfWeek == DayOfWeek.Monday
            && weekly is { } w
            && w.LocalDateTime.Date == new DateTime(2026, 6, 24)
            && w.LocalDateTime.DayOfWeek == DayOfWeek.Wednesday
            && w.LocalDateTime.Hour == 9
            && w.LocalDateTime.Minute == 30);

        var friday = Local(2026, 6, 26, 18, 0);
        var weekdays = ScheduleCalculator.ComputeInitialNextFireAt(
            ScheduleConfig.Weekdays("09:00"), friday);
        f.Check("calculator: weekdays 不在周末触发",
            weekdays is { } wd
            && wd.LocalDateTime.DayOfWeek == DayOfWeek.Monday
            && wd.LocalDateTime.Date == new DateTime(2026, 6, 29)
            && wd.LocalDateTime.Hour == 9);

        var nowJan = Local(2026, 1, 20, 12, 0);
        var monthly = ScheduleCalculator.ComputeInitialNextFireAt(
            ScheduleConfig.Monthly(15, "08:30"), nowJan);
        var yearly = ScheduleCalculator.ComputeInitialNextFireAt(
            ScheduleConfig.Yearly(3, 1, "10:00"), nowJan);
        f.Check("calculator: monthly/yearly 日历排期",
            monthly is { } m && m.LocalDateTime.Month == 2 && m.LocalDateTime.Day == 15
            && yearly is { } y && y.LocalDateTime.Month == 3 && y.LocalDateTime.Day == 1);

        var intervalAfter = ScheduleCalculator.ComputeNextFireAtAfter(
            ScheduleConfig.Interval(1, IntervalUnit.Hours),
            ParseUtc("2026-06-22T08:00:00.000Z"));
        f.Check("calculator: interval 以 scheduledFireAt 为基线防漂移",
            Iso(intervalAfter) == "2026-06-22T09:00:00.000Z");

        var overdue = ScheduleCalculator.NormalizeOverdueNextFireAt(
            ScheduleConfig.Interval(1, IntervalUnit.Hours),
            ParseUtc("2026-06-22T08:00:00.000Z"),
            ParseUtc("2026-06-22T12:15:00.000Z"));
        f.Check("calculator: 逾期 interval 向前滚动不补跑",
            Iso(overdue) == "2026-06-22T13:00:00.000Z");

        var veryOldNow = ParseUtc("2026-06-22T12:00:00.000Z");
        var veryOld = ScheduleCalculator.NormalizeOverdueNextFireAt(
            ScheduleConfig.Interval(1, IntervalUnit.Minutes),
            ParseUtc("2025-01-01T00:00:00.000Z"),
            veryOldNow);
        f.Check("calculator: 极旧分钟 interval 归一后仍在未来",
            veryOld is { } vo && vo > veryOldNow && Iso(vo) == "2026-06-22T12:01:00.000Z");

        // ── 复审 P2-5 补充：非 interval 的 next-after / 短月 / DST ──

        var dailyAfter = ScheduleCalculator.ComputeNextFireAtAfter(
            ScheduleConfig.Daily("08:00"), Local(2026, 6, 22, 8, 0));
        f.Check("calculator: daily next-after 墙钟 +1 天",
            dailyAfter is { } da
            && da.LocalDateTime == new DateTime(2026, 6, 23, 8, 0, 0));

        var weekdaysAfter = ScheduleCalculator.ComputeNextFireAtAfter(
            ScheduleConfig.Weekdays("09:00"), Local(2026, 6, 26, 9, 0));
        f.Check("calculator: weekdays next-after 跨周末到周一",
            weekdaysAfter is { } wa
            && wa.LocalDateTime == new DateTime(2026, 6, 29, 9, 0, 0));

        var weeklyAfter = ScheduleCalculator.ComputeNextFireAtAfter(
            ScheduleConfig.Weekly(3, "09:30"), Local(2026, 6, 24, 9, 30));
        f.Check("calculator: weekly next-after +7 天同墙钟",
            weeklyAfter is { } wka
            && wka.LocalDateTime == new DateTime(2026, 7, 1, 9, 30, 0));

        var monthlyAfter = ScheduleCalculator.ComputeNextFireAtAfter(
            ScheduleConfig.Monthly(31, "08:00"), Local(2026, 1, 31, 8, 0));
        f.Check("calculator: monthly 短月跳过不夹取（1/31 → 3/31）",
            monthlyAfter is { } ma
            && ma.LocalDateTime == new DateTime(2026, 3, 31, 8, 0, 0));

        var yearlyAfter = ScheduleCalculator.ComputeNextFireAtAfter(
            ScheduleConfig.Yearly(2, 29, "08:00"), Local(2028, 2, 29, 8, 0));
        f.Check("calculator: yearly 闰日跳过非闰年（2028 → 2032）",
            yearlyAfter is { } ya
            && ya.LocalDateTime == new DateTime(2032, 2, 29, 8, 0, 0));

        // DST 无关性：next-after 以墙钟推进，不因本机时区跳变偏移小时
        //（3/8 与 11/1 是美国 DST 切换日；断言墙钟相等在任何时区都成立）。
        var dstSpring = ScheduleCalculator.ComputeNextFireAtAfter(
            ScheduleConfig.Daily("08:00"), Local(2026, 3, 8, 8, 0));
        var dstFall = ScheduleCalculator.ComputeNextFireAtAfter(
            ScheduleConfig.Daily("08:00"), Local(2026, 11, 1, 8, 0));
        f.Check("calculator: DST 切换日 next-after 保持墙钟（不 ±1h）",
            dstSpring is { } ds && ds.LocalDateTime == new DateTime(2026, 3, 9, 8, 0, 0)
            && dstFall is { } df && df.LocalDateTime == new DateTime(2026, 11, 2, 8, 0, 0));
    }

    // ================================================================ store

    private static void StoreChecks(FailureCounter f)
    {
        // 1. 用户任务未绑定工作区 → 拒绝
        WithDir(dir =>
        {
            var store = NewStore(dir, "2026-06-22T08:00:00.000Z", () => "id-1");
            store.Load();
            f.Check("store: 用户任务未绑定工作区 → 拒绝",
                ThrowsWith(() => store.AddTask(new NewScheduledTaskInput
                {
                    Title = "Workspace-bound",
                    Prompt = "Run in a selected folder",
                    Schedule = ScheduleConfig.Daily("09:00"),
                }), "必须绑定工作区"));
        });

        // 2. 用户任务模式仅支持 work / code
        WithDir(dir =>
        {
            var store = NewStore(dir, "2026-06-22T08:00:00.000Z", () => "id-1");
            store.Load();
            f.Check("store: 用户任务 chat 模式 → 拒绝",
                ThrowsWith(() => store.AddTask(new NewScheduledTaskInput
                {
                    Title = "Invalid mode",
                    Prompt = "Run",
                    Schedule = ScheduleConfig.Daily("09:00"),
                    WorkspaceBinding = Binding(),
                    Mode = PluginPromptModes.Chat,
                }), "模式仅支持"));
        });

        // 3. 添加并持久化归一后的任务
        WithDir(dir =>
        {
            var store = NewStore(dir, "2026-06-22T08:00:00.000Z", () => "id-1");
            store.Load();
            var task = store.AddTask(new NewScheduledTaskInput
            {
                Title = "  Morning  ",
                Prompt = "  Summarize my day  ",
                Schedule = ScheduleConfig.Daily("09:00"),
                WorkspaceBinding = Binding(),
                Mode = PluginPromptModes.Code,
                ToolMode = SchedulerToolMode.AllowList,
                AllowedToolIds = new List<string> { "weather", "weather", "calendar" },
            });
            var reloaded = NewStore(dir, "2026-06-22T08:00:00.000Z", () => "id-2");
            reloaded.Load();
            f.Check("store: 添加并持久化归一后的任务",
                task.Title == "Morning"
                && task.Prompt == "Summarize my day"
                && task.AllowedToolIds.SequenceEqual(new[] { "weather", "calendar" })
                && task.WorkspaceBinding is { WorkspaceRoot: "E:/project", DisplayName: "project", BoundAt: 1 }
                && task.Mode == PluginPromptModes.Code
                && !string.IsNullOrEmpty(task.NextFireAt)
                && reloaded.GetTasks().Count == 1
                && reloaded.GetTasks()[0].Title == "Morning");
        });

        // 4. runCount 由 lastFiredAt 隐式 +1；maxRuns 校验
        WithDir(dir =>
        {
            var store = NewStore(dir, "2026-06-22T08:00:00.000Z", () => "limited-task");
            store.Load();
            var task = store.AddTask(new NewScheduledTaskInput
            {
                Title = "Limited",
                Prompt = "Run",
                Schedule = ScheduleConfig.Weekdays("09:00"),
                WorkspaceBinding = Binding(),
                MaxRuns = 3,
            });
            var first = store.UpdateTask(task.Id, new ScheduledTaskPatch { LastFiredAt = "2026-06-22T09:00:00.000Z" });
            var second = store.UpdateTask(task.Id, new ScheduledTaskPatch { LastFiredAt = "2026-06-23T09:00:00.000Z" });
            f.Check("store: runCount 随 lastFiredAt 递增 / maxRuns 边界",
                task.RunCount == 0
                && first.RunCount == 1
                && second.RunCount == 2
                && ThrowsWith(() => store.UpdateTask(task.Id, new ScheduledTaskPatch { MaxRuns = 0 }), "1-10000"));
        });

        // 5. 历史每任务 50 / 全局 1000
        WithDir(dir =>
        {
            var counter = 0;
            var store = NewStore(dir, "2026-06-22T08:00:00.000Z", () => $"id-{++counter}");
            store.Load();
            for (var i = 0; i < 60; i += 1)
            {
                store.RecordHistory(new ScheduledTaskHistoryEntry
                {
                    Id = $"a-{i}",
                    TaskId = "task-a",
                    TaskTitle = "A",
                    FiredAt = SchedulerJson.ToIsoString(Local(2026, 6, 22, 8, i)),
                    Status = ScheduledTaskHistoryStatus.Success,
                    EffectiveToolIds = new List<string>(),
                });
            }
            var history = store.GetHistory("task-a", 100);
            f.Check("store: 每任务保留最近 50 条",
                history.Count == 50 && store.GetHistory("task-a", 1)[0].Id == "a-59");

            for (var taskIndex = 0; taskIndex < 25; taskIndex += 1)
            {
                for (var i = 0; i < 60; i += 1)
                {
                    store.RecordHistory(new ScheduledTaskHistoryEntry
                    {
                        Id = $"bulk-{taskIndex}-{i}",
                        TaskId = $"bulk-task-{taskIndex}",
                        TaskTitle = "Bulk",
                        FiredAt = SchedulerJson.ToIsoString(Local(2026, 6, 22, 8, 0).AddMinutes(taskIndex * 100 + i)),
                        Status = ScheduledTaskHistoryStatus.Success,
                        EffectiveToolIds = new List<string>(),
                    });
                }
            }
            var lineCount = File.ReadAllLines(store.HistoryFile).Count(line => line.Trim().Length > 0);
            f.Check("store: 全局历史封顶 1000 条", lineCount == 1000);
        });

        // 6. id 提供方冲突时生成唯一 id
        WithDir(dir =>
        {
            var store = NewStore(dir, "2026-06-22T08:00:00.000Z", () => "same-id");
            store.Load();
            var first = store.AddTask(new NewScheduledTaskInput
            {
                Title = "A", Prompt = "Run A", Schedule = ScheduleConfig.Daily("08:00"), WorkspaceBinding = Binding(),
            });
            var second = store.AddTask(new NewScheduledTaskInput
            {
                Title = "B", Prompt = "Run B", Schedule = ScheduleConfig.Daily("09:00"), WorkspaceBinding = Binding(),
            });
            f.Check("store: id 冲突时生成唯一 id",
                first.Id == "same-id"
                && second.Id != "same-id"
                && store.GetTasks().Select(task => task.Id).Distinct().Count() == 2);
        });

        // 7. 同 id 终态覆盖 running 历史
        WithDir(dir =>
        {
            var store = NewStore(dir, "2026-06-22T08:00:00.000Z", () => "id-1");
            store.Load();
            store.RecordHistory(new ScheduledTaskHistoryEntry
            {
                Id = "hist-1", TaskId = "task-a", TaskTitle = "A",
                FiredAt = "2026-06-22T08:00:00.000Z", Status = ScheduledTaskHistoryStatus.Running,
                EffectiveToolIds = new List<string>(),
            });
            store.RecordHistory(new ScheduledTaskHistoryEntry
            {
                Id = "hist-1", TaskId = "task-a", TaskTitle = "A",
                FiredAt = "2026-06-22T08:00:00.000Z", FinishedAt = "2026-06-22T08:00:05.000Z",
                Status = ScheduledTaskHistoryStatus.Success, OutputPreview = "done",
                EffectiveToolIds = new List<string>(),
            });
            var history = store.GetHistory("task-a", 10);
            f.Check("store: 同 id 终态覆盖 running 历史",
                history.Count == 1 && history[0].Status == ScheduledTaskHistoryStatus.Success);
        });

        // 8. 旧任务缺可选数组时归一而不崩溃
        WithDir(dir =>
        {
            File.WriteAllText(Path.Combine(dir, "scheduled-tasks.json"), """
            {"tasks":[{"id":"task-a","title":"A","prompt":"Run A","enabled":true,"schedule":{"kind":"daily","timeOfDay":"08:00"},"nextFireAt":"2026-06-22T08:00:00.000Z","toolMode":"allow-list","createdAt":"2026-06-22T00:00:00.000Z","updatedAt":"2026-06-22T00:00:00.000Z"}]}
            """);
            var store = NewStore(dir, "2026-06-22T08:00:00.000Z", () => "id-1");
            store.Load();
            f.Check("store: 旧任务缺 allowedToolIds → 归一为 []",
                store.GetTasks().Count == 1 && store.GetTasks()[0].AllowedToolIds.Count == 0);
        });

        // 9. 重新启用时滚动过期的 nextFireAt
        WithDir(dir =>
        {
            var now = ParseUtc("2026-06-22T08:00:00.000Z");
            var store = NewStore(dir, null, () => "task-a", () => now);
            store.Load();
            var task = store.AddTask(new NewScheduledTaskInput
            {
                Title = "Hourly", Prompt = "Run hourly",
                Schedule = ScheduleConfig.Interval(1, IntervalUnit.Hours),
                WorkspaceBinding = Binding(),
            });
            store.ToggleTask(task.Id, false);
            now = ParseUtc("2026-06-22T12:15:00.000Z");
            var enabled = store.ToggleTask(task.Id, true);
            f.Check("store: 重新启用滚动过期 nextFireAt",
                task.NextFireAt == "2026-06-22T09:00:00.000Z"
                && enabled.NextFireAt == "2026-06-22T13:00:00.000Z");
        });

        // 10. 插件任务创建不变量
        WithDir(dir =>
        {
            var store = NewStore(dir, "2026-06-22T08:00:00.000Z", () => "id-1");
            store.Load();
            var task = store.AddTask(new NewScheduledTaskInput
            {
                Title = "插件任务",
                Prompt = "Run",
                Schedule = ScheduleConfig.Daily("09:00"),
                Enabled = true,
                ToolMode = SchedulerToolMode.AllEnabled,
                AllowedToolIds = new List<string> { "a", "b" },
                OwnerPluginId = "demo-plugin",
                PluginUserEnabled = false,
                ApprovalFingerprint = "",
                Mode = PluginPromptModes.Chat,
            });
            f.Check("store: 插件任务创建无视 enabled/toolMode → 停用 + allow-list",
                !task.Enabled
                && task.ToolMode == SchedulerToolMode.AllowList
                && task.OwnerPluginId == "demo-plugin"
                && task.Mode == PluginPromptModes.Chat
                && task.PluginUserEnabled == false
                && task.ApprovalFingerprint == "");
        });

        // 11. 加载时归一旧版插件任务 / 无绑定用户任务
        WithDir(dir =>
        {
            File.WriteAllText(Path.Combine(dir, "scheduled-tasks.json"), """
            {"tasks":[
              {"id":"task-p","title":"插件任务","prompt":"Run","enabled":true,"schedule":{"kind":"daily","timeOfDay":"08:00"},"nextFireAt":"2026-06-22T08:00:00.000Z","toolMode":"all-enabled","createdAt":"2026-06-22T00:00:00.000Z","updatedAt":"2026-06-22T00:00:00.000Z","ownerPluginId":"demo-plugin","pluginUserEnabled":true,"approvalFingerprint":"abc"},
              {"id":"task-u","title":"用户任务","prompt":"Run","enabled":true,"schedule":{"kind":"daily","timeOfDay":"08:00"},"toolMode":"all-enabled","createdAt":"2026-06-22T00:00:00.000Z","updatedAt":"2026-06-22T00:00:00.000Z"}
            ]}
            """);
            var store = NewStore(dir, "2026-06-22T08:00:00.000Z", () => "id-1");
            store.Load();
            var pluginTask = store.GetTasks().FirstOrDefault(task => task.Id == "task-p");
            var userTask = store.GetTasks().FirstOrDefault(task => task.Id == "task-u");
            f.Check("store: 加载归一（插件停用 + allow-list；无绑定用户任务停用）",
                pluginTask is not null && !pluginTask.Enabled
                && pluginTask.ToolMode == SchedulerToolMode.AllowList
                && pluginTask.PluginUserEnabled == true
                && pluginTask.ApprovalFingerprint == "abc"
                && userTask is not null && !userTask.Enabled && userTask.OwnerPluginId is null);
        });

        // 12. 任何 patch 都改不掉插件任务 enabled / toolMode
        WithDir(dir =>
        {
            var store = NewStore(dir, "2026-06-22T08:00:00.000Z", () => "id-1");
            store.Load();
            var task = store.AddTask(new NewScheduledTaskInput
            {
                Title = "插件任务", Prompt = "Run",
                Schedule = ScheduleConfig.Daily("09:00"),
                OwnerPluginId = "demo-plugin",
            });
            var updated = store.UpdateTask(task.Id, new ScheduledTaskPatch
            {
                Enabled = true,
                ToolMode = SchedulerToolMode.AllEnabled,
            });
            f.Check("store: 插件任务 enabled/toolMode 为宿主不变量",
                !updated.Enabled && updated.ToolMode == SchedulerToolMode.AllowList);
        });

        // 13. pluginUserEnabled 启用时同样重排过期 nextFireAt
        WithDir(dir =>
        {
            var now = ParseUtc("2026-06-22T08:00:00.000Z");
            var store = NewStore(dir, null, () => "task-a", () => now);
            store.Load();
            var task = store.AddTask(new NewScheduledTaskInput
            {
                Title = "Hourly", Prompt = "Run hourly",
                Schedule = ScheduleConfig.Interval(1, IntervalUnit.Hours),
                OwnerPluginId = "demo-plugin",
            });
            now = ParseUtc("2026-06-22T12:15:00.000Z");
            var enabled = store.UpdateTask(task.Id, new ScheduledTaskPatch
            {
                PluginUserEnabled = true,
                ApprovalFingerprint = "fp",
            });
            f.Check("store: pluginUserEnabled 启用时重排过期 nextFireAt",
                task.NextFireAt == "2026-06-22T09:00:00.000Z"
                && enabled.PluginUserEnabled == true
                && enabled.ApprovalFingerprint == "fp"
                && enabled.NextFireAt == "2026-06-22T13:00:00.000Z");
        });

        // 14. deleteTasksByOwner 只删该插件任务并持久化
        WithDir(dir =>
        {
            var counter = 0;
            var store = NewStore(dir, "2026-06-22T08:00:00.000Z", () => $"id-{++counter}");
            store.Load();
            store.AddTask(new NewScheduledTaskInput { Title = "用户任务", Prompt = "A", Schedule = ScheduleConfig.Daily("08:00"), WorkspaceBinding = Binding() });
            store.AddTask(new NewScheduledTaskInput { Title = "插件 A 任务", Prompt = "B", Schedule = ScheduleConfig.Daily("08:00"), OwnerPluginId = "plugin-a" });
            store.AddTask(new NewScheduledTaskInput { Title = "插件 A 任务 2", Prompt = "C", Schedule = ScheduleConfig.Daily("09:00"), OwnerPluginId = "plugin-a" });
            store.AddTask(new NewScheduledTaskInput { Title = "插件 B 任务", Prompt = "D", Schedule = ScheduleConfig.Daily("10:00"), OwnerPluginId = "plugin-b" });
            var removedFirst = store.DeleteTasksByOwner("plugin-a");
            var removedAgain = store.DeleteTasksByOwner("plugin-a");
            var remaining = store.GetTasks().Select(task => task.Title).OrderBy(title => title, StringComparer.Ordinal).ToList();
            var reloaded = NewStore(dir, "2026-06-22T08:00:00.000Z", () => "id-x");
            reloaded.Load();
            var reloadedTitles = reloaded.GetTasks().Select(task => task.Title).OrderBy(title => title, StringComparer.Ordinal).ToList();
            f.Check("store: deleteTasksByOwner 只删该插件任务并持久化",
                removedFirst == 2 && removedAgain == 0
                && remaining.SequenceEqual(new[] { "插件 B 任务", "用户任务" })
                && reloadedTitles.SequenceEqual(remaining));
        });
    }

    // ================================================================ engine

    private static void EngineChecks(FailureCounter f)
    {
        // 1. 远未来任务 timer 延迟封顶 1h
        {
            var timer = new ManualTimerScheduler();
            var runs = 0;
            var store = new FakeStore(new[] { DailyTask(task => task.NextFireAt = "2026-08-22T08:00:00.000Z") });
            var engine = new SchedulerEngine(
                store,
                (task, at, manual) => { runs += 1; return Task.FromResult(OkRun()); },
                now: () => ParseUtc("2026-06-22T08:00:00.000Z"),
                scheduleTimer: timer.Schedule);
            engine.Start();
            f.Check("engine: 远未来任务 timer 延迟封顶 1h",
                timer.ScheduledCount == 1 && timer.LastDelay == TimeSpan.FromHours(1) && runs == 0);
            engine.Stop();
        }

        // 2. fireNow 运行中去重
        {
            var completion = new TaskCompletionSource<SchedulerRunResult>(TaskCreationOptions.RunContinuationsAsynchronously);
            var store = new FakeStore(new[] { DailyTask() });
            var engine = new SchedulerEngine(
                store,
                (task, at, manual) => completion.Task,
                now: () => ParseUtc("2026-06-22T08:00:00.000Z"));
            var first = engine.FireNowAsync("task-1");
            var second = engine.FireNowAsync("task-1").GetAwaiter().GetResult();
            completion.SetResult(OkRun());
            first.GetAwaiter().GetResult();
            f.Check("engine: fireNow 运行中去重",
                !second.Ok && second.Reason == "task already running");
        }

        // 3. 迟到的周期触发只补一次并滚动到未来
        {
            var now = ParseUtc("2026-06-22T07:59:00.000Z");
            var timer = new ManualTimerScheduler();
            var runs = 0;
            var store = new FakeStore(new[]
            {
                DailyTask(task =>
                {
                    task.Schedule = ScheduleConfig.Interval(1, IntervalUnit.Hours);
                    task.NextFireAt = "2026-06-22T08:00:00.000Z";
                }),
            });
            var engine = new SchedulerEngine(
                store,
                (task, at, manual) => { runs += 1; return Task.FromResult(OkRun()); },
                now: () => now,
                scheduleTimer: timer.Schedule);
            engine.Start();
            now = ParseUtc("2026-06-22T12:15:00.000Z");
            timer.Pending!().GetAwaiter().GetResult();
            f.Check("engine: 迟到周期触发只执行一次并推进到未来",
                runs == 1 && store.GetTasks()[0].NextFireAt == "2026-06-22T13:00:00.000Z");
            engine.Stop();
        }

        // 4. 非法 nextFireAt → 停用且不排零延迟循环
        {
            var timer = new ManualTimerScheduler();
            var store = new FakeStore(new[] { DailyTask(task => task.NextFireAt = "not-a-date") });
            var engine = new SchedulerEngine(
                store,
                (task, at, manual) => Task.FromResult(OkRun()),
                now: () => ParseUtc("2026-06-22T08:00:00.000Z"),
                scheduleTimer: timer.Schedule);
            engine.Start();
            var disabled = store.Updates.Any(update => update.Id == "task-1"
                && update.Patch.Enabled == false
                && update.Patch.HasNextFireAt
                && update.Patch.NextFireAt is null);
            f.Check("engine: 非法 nextFireAt → 停用且不排计时器",
                disabled && timer.ScheduledCount == 0);
            engine.Stop();
        }

        // 5. 真 store 启动归一逾期周期任务
        WithDir(dir =>
        {
            var store = NewStore(dir, "2026-06-22T08:00:00.000Z", () => "task-a");
            store.Load();
            store.AddTask(new NewScheduledTaskInput
            {
                Title = "Hourly", Prompt = "Run",
                Schedule = ScheduleConfig.Interval(1, IntervalUnit.Hours),
                WorkspaceBinding = Binding(),
            });
            var timer = new ManualTimerScheduler();
            var engine = new SchedulerEngine(
                store,
                (task, at, manual) => Task.FromResult(OkRun()),
                now: () => ParseUtc("2026-06-22T12:15:00.000Z"),
                scheduleTimer: timer.Schedule);
            engine.Start();
            f.Check("engine: 真 store 启动归一逾期周期任务",
                store.GetTasks()[0].NextFireAt == "2026-06-22T13:00:00.000Z");
            engine.Stop();
        });

        // 6. 真 store 触发后推进 nextFireAt
        WithDir(dir =>
        {
            var store = NewStore(dir, "2026-06-22T07:00:00.000Z", () => "task-a");
            store.Load();
            store.AddTask(new NewScheduledTaskInput
            {
                Title = "Hourly", Prompt = "Run",
                Schedule = ScheduleConfig.Interval(1, IntervalUnit.Hours),
                WorkspaceBinding = Binding(),
            });
            var now = ParseUtc("2026-06-22T07:59:00.000Z");
            var timer = new ManualTimerScheduler();
            var engine = new SchedulerEngine(
                store,
                (task, at, manual) => Task.FromResult(OkRun()),
                now: () => now,
                scheduleTimer: timer.Schedule);
            engine.Start();
            now = ParseUtc("2026-06-22T08:00:00.000Z");
            timer.Pending!().GetAwaiter().GetResult();
            f.Check("engine: 真 store 触发后推进 nextFireAt",
                store.GetTasks()[0].NextFireAt == "2026-06-22T09:00:00.000Z");
            engine.Stop();
        });

        // 7. maxRuns 到达后停用
        WithDir(dir =>
        {
            var store = NewStore(dir, "2026-06-22T07:00:00.000Z", () => "limited-task");
            store.Load();
            store.AddTask(new NewScheduledTaskInput
            {
                Title = "Limited", Prompt = "Run",
                Schedule = ScheduleConfig.Interval(1, IntervalUnit.Hours),
                WorkspaceBinding = Binding(),
                MaxRuns = 1,
            });
            var now = ParseUtc("2026-06-22T07:59:00.000Z");
            var timer = new ManualTimerScheduler();
            var engine = new SchedulerEngine(
                store,
                (task, at, manual) => Task.FromResult(OkRun()),
                now: () => now,
                scheduleTimer: timer.Schedule);
            engine.Start();
            now = ParseUtc("2026-06-22T08:00:00.000Z");
            timer.Pending!().GetAwaiter().GetResult();
            var task = store.GetTasks()[0];
            f.Check("engine: maxRuns 到达后停用并清 nextFireAt",
                task.RunCount == 1 && !task.Enabled && task.NextFireAt is null);
            engine.Stop();
        });

        // 8. 非法持久化 nextFireAt 不抛异常（真 store）
        WithDir(dir =>
        {
            File.WriteAllText(Path.Combine(dir, "scheduled-tasks.json"), """
            {"tasks":[{"id":"task-1","title":"Task","prompt":"Run","enabled":true,"schedule":{"kind":"daily","timeOfDay":"08:00"},"nextFireAt":"not-a-date","toolMode":"all-enabled","allowedToolIds":[],"createdAt":"2026-06-21T00:00:00.000Z","updatedAt":"2026-06-21T00:00:00.000Z"}]}
            """);
            var store = NewStore(dir, "2026-06-22T08:00:00.000Z", () => "task-a");
            store.Load();
            var engine = new SchedulerEngine(
                store,
                (task, at, manual) => Task.FromResult(OkRun()),
                now: () => ParseUtc("2026-06-22T08:00:00.000Z"));
            var threw = false;
            try { engine.Start(); }
            catch { threw = true; }
            var task = store.GetTasks()[0];
            f.Check("engine: 非法持久化 nextFireAt 启动不抛异常并停用",
                !threw && !task.Enabled && task.NextFireAt is null);
            engine.Stop();
        });

        // 9. fireNow 拒绝插件未运行
        {
            var store = new FakeStore(new[] { AuthorizedPluginTask() });
            var engine = new SchedulerEngine(
                store,
                (task, at, manual) => Task.FromResult(OkRun()),
                canRunTask: _ => false,
                now: () => ParseUtc("2026-06-22T08:00:00.000Z"));
            var result = engine.FireNowAsync("plugin-task-1").GetAwaiter().GetResult();
            f.Check("engine: fireNow 插件未运行 → 拒绝",
                !result.Ok && result.Reason == "plugin not running");
        }

        // 10. 未获授权的插件任务不排计时器
        {
            var timer = new ManualTimerScheduler();
            var store = new FakeStore(new[]
            {
                AuthorizedPluginTask(task =>
                {
                    task.PluginUserEnabled = false;
                    task.ApprovalFingerprint = "";
                }),
            });
            var engine = new SchedulerEngine(
                store,
                (task, at, manual) => Task.FromResult(OkRun()),
                now: () => ParseUtc("2026-06-22T08:00:00.000Z"),
                scheduleTimer: timer.Schedule);
            engine.Start();
            f.Check("engine: 未授权插件任务不排计时器", timer.ScheduledCount == 0);
            engine.Stop();
        }

        // 11. 插件停用时定时触发被跳过并推进（不补跑）
        {
            var now = ParseUtc("2026-06-22T07:59:00.000Z");
            var timer = new ManualTimerScheduler();
            var runs = 0;
            var store = new FakeStore(new[]
            {
                AuthorizedPluginTask(task => task.Schedule = ScheduleConfig.Interval(1, IntervalUnit.Hours)),
            });
            var engine = new SchedulerEngine(
                store,
                (task, at, manual) => { runs += 1; return Task.FromResult(OkRun()); },
                canRunTask: _ => false,
                now: () => now,
                scheduleTimer: timer.Schedule);
            engine.Start();
            now = ParseUtc("2026-06-22T08:00:00.000Z");
            timer.Pending!().GetAwaiter().GetResult();
            var skipped = store.History.FirstOrDefault(entry => entry.Status == ScheduledTaskHistoryStatus.Skipped);
            f.Check("engine: 插件停用 → skip 记历史并推进 nextFireAt",
                runs == 0
                && skipped?.Reason == "plugin not running"
                && store.GetTasks()[0].NextFireAt == "2026-06-22T09:00:00.000Z");
            engine.Stop();
        }

        // 12. refreshPluginTasks 归一逾期插件任务并重排
        {
            var now = ParseUtc("2026-06-22T12:15:00.000Z");
            var timer = new ManualTimerScheduler();
            var runs = 0;
            var store = new FakeStore(new[]
            {
                AuthorizedPluginTask(task =>
                {
                    task.Schedule = ScheduleConfig.Interval(1, IntervalUnit.Hours);
                    task.NextFireAt = "2026-06-22T07:00:00.000Z";
                }),
            });
            var engine = new SchedulerEngine(
                store,
                (task, at, manual) => { runs += 1; return Task.FromResult(OkRun()); },
                canRunTask: _ => true,
                now: () => now,
                scheduleTimer: timer.Schedule);
            engine.RefreshPluginTasks();
            var normalized = store.GetTasks()[0].NextFireAt == "2026-06-22T13:00:00.000Z";
            now = ParseUtc("2026-06-22T13:00:00.000Z");
            timer.Pending!().GetAwaiter().GetResult();
            f.Check("engine: refreshPluginTasks 归一逾期并重排后正常触发",
                normalized && runs == 1);
            engine.Stop();
        }

        // 13. 先推进排期再并发执行：runner 未完成时磁盘排期已前进
        {
            var now = ParseUtc("2026-06-22T07:59:00.000Z");
            var timer = new ManualTimerScheduler();
            var completion = new TaskCompletionSource<SchedulerRunResult>(TaskCreationOptions.RunContinuationsAsynchronously);
            var store = new FakeStore(new[]
            {
                DailyTask(task =>
                {
                    task.Schedule = ScheduleConfig.Interval(1, IntervalUnit.Hours);
                    task.NextFireAt = "2026-06-22T08:00:00.000Z";
                }),
            });
            var engine = new SchedulerEngine(
                store,
                (task, at, manual) => completion.Task,
                now: () => now,
                scheduleTimer: timer.Schedule);
            engine.Start();
            now = ParseUtc("2026-06-22T08:00:00.000Z");
            timer.Pending!().GetAwaiter().GetResult();
            var advanced = store.GetTasks()[0].NextFireAt == "2026-06-22T09:00:00.000Z";
            var stillRunning = !completion.Task.IsCompleted;
            completion.SetResult(OkRun());
            f.Check("engine: 先发起执行再推进排期（runner 未完成排期已前进）",
                advanced && stillRunning);
            engine.Stop();
        }

        // 14. FireNow 不推进排期
        {
            var store = new FakeStore(new[] { DailyTask() });
            var engine = new SchedulerEngine(
                store,
                (task, at, manual) => Task.FromResult(OkRun()),
                now: () => ParseUtc("2026-06-22T08:00:00.000Z"));
            var result = engine.FireNowAsync("task-1").GetAwaiter().GetResult();
            f.Check("engine: fireNow 手动触发不推进排期",
                result.Ok
                && !store.Updates.Any(update => update.Patch.HasNextFireAt)
                && store.GetTasks()[0].NextFireAt == "2026-06-22T08:00:00.000Z");
            engine.Stop();
        }

        // 15. once 逾期归一：skipped/"missed while app was closed" + 停用（复审 P2-5）
        {
            var timer = new ManualTimerScheduler();
            var store = new FakeStore(new[]
            {
                DailyTask(task =>
                {
                    task.Schedule = ScheduleConfig.Once("2026-06-22T07:00:00.000Z");
                    task.NextFireAt = "2026-06-22T07:00:00.000Z";
                }),
            });
            var engine = new SchedulerEngine(
                store,
                (task, at, manual) => Task.FromResult(OkRun()),
                now: () => ParseUtc("2026-06-22T08:00:00.000Z"),
                scheduleTimer: timer.Schedule);
            engine.Start();
            var skipped = store.History.Any(entry => entry.TaskId == "task-1"
                && entry.Status == ScheduledTaskHistoryStatus.Skipped
                && entry.Reason == "missed while app was closed");
            var disabled = store.Updates.Any(update => update.Id == "task-1"
                && update.Patch.Enabled == false
                && update.Patch.HasNextFireAt
                && update.Patch.NextFireAt is null);
            f.Check("engine: once 逾期 → skipped 历史 + 停用 + 不排计时器",
                skipped && disabled && timer.ScheduledCount == 0);
            engine.Stop();
        }

        // 16. endAt 超出：到点时直接停用，不执行（复审 P2-5）
        {
            var now = ParseUtc("2026-06-22T08:00:00.000Z");
            var timer = new ManualTimerScheduler();
            var runs = 0;
            var store = new FakeStore(new[]
            {
                DailyTask(task =>
                {
                    task.NextFireAt = "2026-06-22T09:00:00.000Z";
                    task.EndAt = "2026-06-22T08:30:00.000Z";
                }),
            });
            var engine = new SchedulerEngine(
                store,
                (task, at, manual) => { runs += 1; return Task.FromResult(OkRun()); },
                now: () => now,
                scheduleTimer: timer.Schedule);
            engine.Start();
            // Start 时 endAt 未过 → 正常排期；随后把 nextFireAt/endAt 都拨到过去
            // （模拟运行期到点），验证 FireDueTasks 的 endAt 复核。
            store.UpdateTask("task-1", new ScheduledTaskPatch
            {
                NextFireAt = "2026-06-22T07:59:00.000Z",
                EndAt = "2026-06-22T07:30:00.000Z",
            });
            timer.Pending!().GetAwaiter().GetResult();
            var disabled = store.Updates.Any(update => update.Id == "task-1"
                && update.Patch.Enabled == false
                && update.Patch.HasNextFireAt
                && update.Patch.NextFireAt is null);
            f.Check("engine: endAt 超出 → 到点停用不执行", runs == 0 && disabled);
            engine.Stop();
        }
    }

    // ================================================================ helpers

    private static SchedulerStore NewStore(string dir, string? fixedNow, Func<string> id, Func<DateTimeOffset>? now = null)
        => new(dir, now ?? (fixedNow is null ? null : () => ParseUtc(fixedNow)), id);

    private static WorkspaceBinding Binding() => new()
    {
        WorkspaceRoot = "E:/project",
        DisplayName = "project",
        BoundAt = 1,
    };

    private static SchedulerRunResult OkRun() => new()
    {
        Ok = true,
        HistoryId = "h",
        EffectiveToolIds = new List<string>(),
    };

    private static ScheduledTask DailyTask(Action<ScheduledTask>? mutate = null)
    {
        var task = new ScheduledTask
        {
            Id = "task-1",
            Title = "Task",
            Prompt = "Run",
            Enabled = true,
            Schedule = ScheduleConfig.Daily("08:00"),
            NextFireAt = "2026-06-22T08:00:00.000Z",
            ToolMode = SchedulerToolMode.AllEnabled,
            AllowedToolIds = new List<string>(),
            CreatedAt = "2026-06-21T00:00:00.000Z",
            UpdatedAt = "2026-06-21T00:00:00.000Z",
        };
        mutate?.Invoke(task);
        return task;
    }

    /// <summary>已获用户授权的插件任务：enabled:false 落盘 + 非空授权指纹（内容由 TS 校验）。</summary>
    private static ScheduledTask AuthorizedPluginTask(Action<ScheduledTask>? mutate = null)
        => DailyTask(task =>
        {
            task.Id = "plugin-task-1";
            task.OwnerPluginId = "demo-plugin";
            task.Enabled = false;
            task.PluginUserEnabled = true;
            task.ApprovalFingerprint = "fp";
            mutate?.Invoke(task);
        });

    private static DateTimeOffset ParseUtc(string iso)
        => SchedulerJson.TryParseIso(iso, out var value)
            ? value
            : throw new InvalidOperationException($"bad iso: {iso}");

    private static DateTimeOffset Local(int year, int month, int day, int hour, int minute)
        => ScheduleCalculator.FromLocalWall(new DateTime(year, month, day, hour, minute, 0, DateTimeKind.Unspecified));

    private static string? Iso(DateTimeOffset? value)
        => value is { } v ? SchedulerJson.ToIsoString(v) : null;

    private static bool ThrowsWith(Action action, string messagePart)
    {
        try
        {
            action();
            return false;
        }
        catch (SchedulerValidationException ex)
        {
            return ex.Message.Contains(messagePart, StringComparison.Ordinal);
        }
    }

    private static void WithDir(Action<string> body)
    {
        var dir = Path.Combine(Path.GetTempPath(), "cyrene-smoke-scheduler", Guid.NewGuid().ToString("N")[..10]);
        Directory.CreateDirectory(dir);
        try
        {
            body(dir);
        }
        finally
        {
            try { Directory.Delete(dir, true); } catch { /* 临时目录清理失败不影响结果 */ }
        }
    }

    private sealed class FailureCounter
    {
        public int Count { get; private set; }

        public void Check(string name, bool ok)
        {
            if (ok)
            {
                Console.WriteLine($"[PASS] {name}");
            }
            else
            {
                Count += 1;
                Console.WriteLine($"[FAIL] {name}");
            }
        }
    }

    /// <summary>假 store：对齐 TS engine 测试的 makeStore（浅合并 patch + 通知）。</summary>
    private sealed class FakeStore : ISchedulerTaskStore
    {
        private List<ScheduledTask> _tasks;

        public FakeStore(IEnumerable<ScheduledTask> tasks) => _tasks = tasks.Select(task => task.Clone()).ToList();

        public List<ScheduledTaskHistoryEntry> History { get; } = new();
        public List<(string Id, ScheduledTaskPatch Patch)> Updates { get; } = new();

        public event Action<IReadOnlyList<ScheduledTask>>? Changed;

        public IReadOnlyList<ScheduledTask> GetTasks() => _tasks.Select(task => task.Clone()).ToList();

        public ScheduledTask UpdateTask(string id, ScheduledTaskPatch patch)
        {
            var index = _tasks.FindIndex(task => task.Id == id);
            if (index < 0) throw new SchedulerValidationException("任务不存在");
            var updated = _tasks[index].Clone();
            if (patch.Title is not null) updated.Title = patch.Title;
            if (patch.Prompt is not null) updated.Prompt = patch.Prompt;
            if (patch.Enabled.HasValue) updated.Enabled = patch.Enabled.Value;
            if (patch.Schedule is not null) updated.Schedule = patch.Schedule;
            if (patch.HasNextFireAt) updated.NextFireAt = patch.NextFireAt;
            if (patch.LastFiredAt is not null) updated.LastFiredAt = patch.LastFiredAt;
            if (patch.ToolMode.HasValue) updated.ToolMode = patch.ToolMode.Value;
            if (patch.AllowedToolIds is not null) updated.AllowedToolIds = new List<string>(patch.AllowedToolIds);
            if (patch.PluginUserEnabled.HasValue) updated.PluginUserEnabled = patch.PluginUserEnabled.Value;
            if (patch.ApprovalFingerprint is not null) updated.ApprovalFingerprint = patch.ApprovalFingerprint;
            if (patch.Mode is not null) updated.Mode = patch.Mode;
            if (patch.HasMaxRuns) updated.MaxRuns = patch.MaxRuns;
            if (patch.HasEndAt) updated.EndAt = patch.EndAt;
            _tasks[index] = updated;
            Updates.Add((id, patch));
            Changed?.Invoke(GetTasks());
            return updated.Clone();
        }

        public void RecordHistory(ScheduledTaskHistoryEntry entry) => History.Add(entry);
    }

    /// <summary>可手动触发的延迟执行 seam：记录延迟与回调，测试里直接 await 回调。</summary>
    private sealed class ManualTimerScheduler
    {
        public int ScheduledCount { get; private set; }
        public TimeSpan? LastDelay { get; private set; }
        public Func<Task>? Pending { get; private set; }

        public IDisposable Schedule(TimeSpan delay, Func<Task> callback)
        {
            ScheduledCount += 1;
            LastDelay = delay;
            Pending = callback;
            return new NoopDisposable();
        }

        private sealed class NoopDisposable : IDisposable
        {
            public void Dispose() { }
        }
    }
}

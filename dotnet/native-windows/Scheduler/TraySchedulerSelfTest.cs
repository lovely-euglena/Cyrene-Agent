using System.IO;
using System.Text.Json;
using CyreneNative.Scheduler;

namespace CyreneNative;

/// <summary>
/// 托盘调度宿主自测（`cyrene-native --selftest tray-scheduler`，Windows 可跑）：
/// 复审 P1-6 要求的仓库内可复现入口——构造 TraySchedulerHost + 临时 data-dir +
/// 注入 stub 回调/进程启动器/手动计时器，覆盖：
///   协议 CRUD/回执/事件、arm/disarm、离线拉起失败→failed 历史+气泡、
///   终态 report→气泡、进程无 report 退出→failed 历史+气泡、遗留 running 中断、
///   headless 队列串行、插件首连窗口判定。
/// 输出约定：[PASS]/[FAIL] + 末行 SELFTEST tray-scheduler: PASS / N FAILURES；退出码 0/1。
/// </summary>
internal static class TraySchedulerSelfTest
{
    public static int Run()
    {
        var f = new FailureCounter();
        ProtocolChecks(f);
        ArmDisarmChecks(f);
        OfflineLaunchFailureChecks(f);
        TerminalReportAndQueueChecks(f);
        ProcessExitWithoutReportChecks(f);
        LeftoverRunningChecks(f);
        PluginFirstConnectChecks(f);
        Console.WriteLine(f.Count == 0
            ? "SELFTEST tray-scheduler: PASS"
            : $"SELFTEST tray-scheduler: {f.Count} FAILURES");
        return f.Count == 0 ? 0 : 1;
    }

    // ================================================================ 协议 CRUD/回执/事件

    private static void ProtocolChecks(FailureCounter f)
    {
        WithHost((host, ctx) =>
        {
            var add = host.Handle("sched.add", Frame(new
            {
                input = new
                {
                    title = "任务A",
                    prompt = "p",
                    schedule = new { kind = "daily", timeOfDay = "09:00" },
                    workspaceBinding = new { workspaceRoot = "E:/p", displayName = "p", boundAt = 1 },
                },
            }));
            var task = add.Data as ScheduledTask;
            f.Check("协议: sched.add 返回任务且事件广播", add.Ok && task is not null && ctx.Events.Any(e => e.Name == "sched.changed"));

            var snapshot = host.Handle("sched.snapshot", Frame(new { }));
            var tasks = snapshot.Data?.GetType().GetProperty("tasks")?.GetValue(snapshot.Data) as IReadOnlyList<ScheduledTask>;
            f.Check("协议: sched.snapshot 含新增任务", snapshot.Ok && tasks is { Count: 1 } && tasks[0].Title == "任务A");

            var update = host.Handle("sched.update", Frame(new { taskId = task!.Id, patch = new { title = "任务B" } }));
            f.Check("协议: sched.update 生效", update.Ok && (update.Data as ScheduledTask)?.Title == "任务B");

            var toggle = host.Handle("sched.toggle", Frame(new { taskId = task.Id, enabled = false }));
            f.Check("协议: sched.toggle 停用", toggle.Ok && (toggle.Data as ScheduledTask)?.Enabled == false);

            var history = host.Handle("sched.history", Frame(new { taskId = task.Id, limit = 10 }));
            f.Check("协议: sched.history 空列表", history.Ok && history.Data is IReadOnlyList<ScheduledTaskHistoryEntry> { Count: 0 });

            var bad = host.Handle("sched.update", Frame(new { taskId = "missing", patch = new { } }));
            f.Check("协议: 非法任务回执 ok=false + error", !bad.Ok && !string.IsNullOrEmpty(bad.Error));

            var unknown = host.Handle("sched.unknown-op", Frame(new { }));
            f.Check("协议: 未知 op 回执 ok=false", !unknown.Ok);

            var delete = host.Handle("sched.delete", Frame(new { taskId = task.Id }));
            f.Check("协议: sched.delete 生效", delete.Ok && delete.Data is true);
        });
    }

    // ================================================================ arm/disarm

    private static void ArmDisarmChecks(FailureCounter f)
    {
        WithHost((host, _) =>
        {
            f.Check("arm: 启动缺省不跑引擎", !host.EngineRunning);
            var arm = host.Handle("sched.mode", Frame(new { enabled = true }));
            f.Check("arm: sched.mode enabled=true 启动引擎", arm.Ok && host.EngineRunning);
            var disarm = host.Handle("sched.mode", Frame(new { enabled = false }));
            f.Check("disarm: sched.mode enabled=false 停引擎", disarm.Ok && !host.EngineRunning);
        });
    }

    // ================================================================ 离线拉起失败

    private static void OfflineLaunchFailureChecks(FailureCounter f)
    {
        WithHost((host, ctx) =>
        {
            host.ProcessStarter = _ => throw new FileNotFoundException("stub: exe missing");
            var taskId = AddDailyTask(host, "离线失败任务");
            host.Handle("sched.mode", Frame(new { enabled = true }));

            FireDue(host, ctx, taskId);

            var entries = History(host, taskId);
            f.Check("离线拉起失败: failed 历史 + 原因",
                entries.Any(e => e.Status == ScheduledTaskHistoryStatus.Failed && e.Reason == "headless launch"));
            f.Check("离线拉起失败: 失败气泡", ctx.Balloons.Any(b => b.Title == "定时任务启动失败"));
            f.Check("离线拉起失败: 无在跑实例（队列已清）", host.ActiveHeadlessHistId is null && host.QueuedHeadlessCount == 0);
        });
    }

    // ================================================================ 终态 report + 队列串行

    private static void TerminalReportAndQueueChecks(FailureCounter f)
    {
        WithHost((host, ctx) =>
        {
            host.ProcessStarter = _ => null; // 视为已启动（无进程句柄）
            var firstId = AddDailyTask(host, "队列任务1");
            var secondId = AddDailyTask(host, "队列任务2");
            host.Handle("sched.mode", Frame(new { enabled = true }));

            FireDue(host, ctx, firstId, secondId);

            var active = host.ActiveHeadlessHistId;
            f.Check("队列: 同一时刻至多一个执行实例（第二个入队）",
                active is not null && host.QueuedHeadlessCount == 1);
            f.Check("队列: 排队项预建 running 历史",
                History(host, secondId).Any(e => e.Status == ScheduledTaskHistoryStatus.Running));

            // 第一个终态 report → 气泡 + 出队拉起第二个
            ReportTerminal(host, firstId, active!, "success", null);
            var secondActive = host.ActiveHeadlessHistId;
            f.Check("队列: 终态后出队拉起下一个", secondActive is not null && secondActive != active && host.QueuedHeadlessCount == 0);
            f.Check("终态 report: 成功气泡", ctx.Balloons.Any(b => b.Title == "定时任务完成"));

            ReportTerminal(host, secondId, secondActive!, "failed", "stub failure");
            f.Check("终态 report: 失败气泡带原因",
                ctx.Balloons.Any(b => b.Title == "定时任务失败" && (b.Content?.Contains("stub failure") ?? false)));
            f.Check("终态 report: 历史为终态", History(host, firstId).Any(e => e.Status == ScheduledTaskHistoryStatus.Success)
                && History(host, secondId).Any(e => e.Status == ScheduledTaskHistoryStatus.Failed));
        });
    }

    // ================================================================ 进程无 report 退出（拿锁失败/崩溃）

    private static void ProcessExitWithoutReportChecks(FailureCounter f)
    {
        WithHost((host, ctx) =>
        {
            host.HeadlessExitGrace = TimeSpan.FromMilliseconds(100);
            host.ProcessStarter = _ => System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo
            {
                FileName = "cmd.exe",
                Arguments = "/c exit 7",
                UseShellExecute = false,
                CreateNoWindow = true,
            });
            var taskId = AddDailyTask(host, "异常退出任务");
            host.Handle("sched.mode", Frame(new { enabled = true }));

            FireDue(host, ctx, taskId);

            var deadline = DateTime.UtcNow.AddSeconds(10);
            while (DateTime.UtcNow < deadline
                && !History(host, taskId).Any(e => e.Status == ScheduledTaskHistoryStatus.Failed
                    && e.Reason == "headless process exited without report"))
            {
                Thread.Sleep(50);
            }
            f.Check("无 report 退出: failed 历史（原因 + 退出码）",
                History(host, taskId).Any(e => e.Status == ScheduledTaskHistoryStatus.Failed
                    && e.Reason == "headless process exited without report"
                    && (e.ErrorMessage?.Contains("exit code 7") ?? false)));
            f.Check("无 report 退出: 失败气泡 + 在跑实例清空",
                ctx.Balloons.Any(b => b.Title == "定时任务失败") && host.ActiveHeadlessHistId is null);
        });
    }

    // ================================================================ 遗留 running 中断

    private static void LeftoverRunningChecks(FailureCounter f)
    {
        WithDir(dir =>
        {
            File.WriteAllText(Path.Combine(dir, "scheduled-tasks-history.jsonl"),
                """{"id":"hist-left","taskId":"task-left","taskTitle":"遗留任务","firedAt":"2026-10-05T00:00:00.000Z","status":"running","effectiveToolIds":[]}"""
                + "\n");
            var host = NewHost(dir, () => false, out _, schedulerEnabled: false);
            host.Start();
            var entries = History(host, "task-left");
            f.Check("遗留 running: 启动标为中断 failed",
                entries.Any(e => e.Status == ScheduledTaskHistoryStatus.Failed
                    && (e.Reason?.Contains("interrupted") ?? false)));
            host.Stop();
        });
    }

    // ================================================================ 插件首连窗口（P2-7）

    private static void PluginFirstConnectChecks(FailureCounter f)
    {
        // 离线 + 状态未知：插件任务按未运行处理（skip 历史，不拉起 headless）。
        WithHost((host, ctx) =>
        {
            host.ProcessStarter = _ => throw new InvalidOperationException("should not launch");
            var taskId = AddPluginTask(host, "插件任务");
            host.Handle("sched.mode", Frame(new { enabled = true }));
            FireDue(host, ctx, taskId);
            f.Check("插件首连: 离线未同步 → skip/plugin not running",
                History(host, taskId).Any(e => e.Status == ScheduledTaskHistoryStatus.Skipped && e.Reason == "plugin not running"));
        }, electronConnected: false);

        // 在线 + 状态未知：暂缓判定（交 sched.fire，不写 skip）。
        WithHost((host, ctx) =>
        {
            var taskId = AddPluginTask(host, "插件任务");
            host.Handle("sched.mode", Frame(new { enabled = true }));
            FireDue(host, ctx, taskId);
            f.Check("插件首连: 在线未同步 → 发 sched.fire 暂缓判定",
                ctx.Events.Any(e => e.Name == "sched.fire")
                && !History(host, taskId).Any(e => e.Status == ScheduledTaskHistoryStatus.Skipped));
        }, electronConnected: true);

        // 已同步：运行中 → sched.fire。
        WithHost((host, ctx) =>
        {
            host.Handle("sched.plugin-state", Frame(new { running = new Dictionary<string, bool> { ["demo-plugin"] = true } }));
            var taskId = AddPluginTask(host, "插件任务");
            host.Handle("sched.mode", Frame(new { enabled = true }));
            FireDue(host, ctx, taskId);
            f.Check("插件首连: 已同步运行中 → 正常触发",
                ctx.Events.Any(e => e.Name == "sched.fire"));
        }, electronConnected: true);
    }

    // ================================================================ helpers

    private static string AddDailyTask(TraySchedulerHost host, string title)
    {
        var add = host.Handle("sched.add", Frame(new
        {
            input = new
            {
                title,
                prompt = "p",
                schedule = new { kind = "daily", timeOfDay = "09:00" },
                workspaceBinding = new { workspaceRoot = "E:/p", displayName = "p", boundAt = 1 },
            },
        }));
        return (add.Data as ScheduledTask)?.Id ?? throw new InvalidOperationException("add failed");
    }

    private static string AddPluginTask(TraySchedulerHost host, string title)
    {
        var add = host.Handle("sched.add", Frame(new
        {
            input = new
            {
                title,
                prompt = "p",
                schedule = new { kind = "daily", timeOfDay = "09:00" },
                ownerPluginId = "demo-plugin",
                pluginUserEnabled = true,
                approvalFingerprint = "fp",
            },
        }));
        return (add.Data as ScheduledTask)?.Id ?? throw new InvalidOperationException("add failed");
    }

    /// <summary>把任务 nextFireAt 改成过去并触发手动计时器（模拟到点）。</summary>
    private static void FireDue(TraySchedulerHost host, HostContext ctx, string taskId, string? alsoDueTaskId = null)
    {
        var past = SchedulerJson.ToIsoString(DateTimeOffset.Now.AddMinutes(-1));
        host.Handle("sched.update", Frame(new { taskId, patch = new { nextFireAt = past } }));
        if (alsoDueTaskId is not null)
            host.Handle("sched.update", Frame(new { taskId = alsoDueTaskId, patch = new { nextFireAt = past } }));
        var pending = ctx.Timer.Pending ?? throw new InvalidOperationException("timer not scheduled");
        pending.Invoke().GetAwaiter().GetResult();
    }

    private static void ReportTerminal(TraySchedulerHost host, string taskId, string histId, string status, string? error)
    {
        host.Handle("sched.report", Frame(new
        {
            entry = new
            {
                id = histId,
                taskId,
                taskTitle = "T",
                firedAt = "2026-10-05T00:00:00.000Z",
                finishedAt = "2026-10-05T00:01:00.000Z",
                status,
                effectiveToolIds = Array.Empty<string>(),
                errorMessage = error,
            },
        }));
    }

    private static IReadOnlyList<ScheduledTaskHistoryEntry> History(TraySchedulerHost host, string taskId)
    {
        var result = host.Handle("sched.history", Frame(new { taskId, limit = 50 }));
        return result.Data as IReadOnlyList<ScheduledTaskHistoryEntry> ?? new List<ScheduledTaskHistoryEntry>();
    }

    private static JsonElement Frame(object payload)
        => JsonDocument.Parse(JsonSerializer.Serialize(payload, SchedulerJson.Options)).RootElement.Clone();

    private static void WithHost(Action<TraySchedulerHost, HostContext> body, bool schedulerEnabled = false, bool electronConnected = false)
    {
        WithDir(dir =>
        {
            var host = NewHost(dir, () => electronConnected, out var ctx, schedulerEnabled);
            try
            {
                host.Start();
                body(host, ctx);
            }
            finally
            {
                host.Stop();
            }
        });
    }

    private static TraySchedulerHost NewHost(string dir, Func<bool> connected, out HostContext ctx, bool schedulerEnabled)
    {
        var context = new HostContext();
        ctx = context;
        var exePath = Path.Combine(dir, "Cyrene.exe");
        // 占位 exe：通过 File.Exists 预检；实际启动由 ProcessStarter seam 接管。
        File.WriteAllText(exePath, "");
        return new TraySchedulerHost(
            dir,
            exePath,
            schedulerEnabled,
            (name, data) =>
            {
                context.Events.Add((name, data));
                return connected();
            },
            (title, content) => context.Balloons.Add((title, content)),
            connected,
            context.Timer.Schedule);
    }

    private static void WithDir(Action<string> body)
    {
        var dir = Path.Combine(Path.GetTempPath(), "cyrene-tray-scheduler-selftest", Guid.NewGuid().ToString("N")[..10]);
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

    private sealed class HostContext
    {
        public List<(string Name, object Data)> Events { get; } = new();
        public List<(string Title, string Content)> Balloons { get; } = new();
        public ManualTimerScheduler Timer { get; } = new();
    }

    /// <summary>可手动触发的延迟执行 seam（与 smoke-host 的 ManualTimerScheduler 同形）。</summary>
    private sealed class ManualTimerScheduler
    {
        public Func<Task>? Pending { get; private set; }

        public IDisposable Schedule(TimeSpan delay, Func<Task> callback)
        {
            Pending = callback;
            return new NoopDisposable();
        }

        private sealed class NoopDisposable : IDisposable
        {
            public void Dispose() { }
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
}

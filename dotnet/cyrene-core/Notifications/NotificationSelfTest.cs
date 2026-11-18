namespace CyreneNative.Notifications;

/// <summary>
/// 通知分发自测（smoke-host --selftest notifications，issue #153）。
/// 退出码 = 失败数；全过输出 PASS 行（对齐 OrchestratorSelfTest 惯例）。
/// </summary>
public static class NotificationSelfTest
{
    public static int Run()
    {
        var failures = 0;
        void Check(string name, bool ok)
        {
            if (ok) Console.WriteLine($"[PASS] {name}");
            else { failures++; Console.WriteLine($"[FAIL] {name}"); }
        }

        // 1. 终态映射：done/failed/timeout/等待输入 通知；中间态与 cancelled 类静默
        Check("done → TaskFinished", AgentNotificationDispatcher.TryMapOutcome("done", out var k1) && k1 == NotificationKind.TaskFinished);
        Check("failed → TaskFailed", AgentNotificationDispatcher.TryMapOutcome("failed", out var k2) && k2 == NotificationKind.TaskFailed);
        Check("done_denied → TaskFailed", AgentNotificationDispatcher.TryMapOutcome("done_denied", out var k3) && k3 == NotificationKind.TaskFailed);
        Check("timeout → TaskTimeout", AgentNotificationDispatcher.TryMapOutcome("timeout", out var k4) && k4 == NotificationKind.TaskTimeout);
        Check("waiting_input → WaitingInput", AgentNotificationDispatcher.TryMapOutcome("waiting_input", out var k5) && k5 == NotificationKind.WaitingInput);
        Check("waiting_tool 静默", !AgentNotificationDispatcher.TryMapOutcome("waiting_tool", out _));
        Check("idle_denied 静默", !AgentNotificationDispatcher.TryMapOutcome("idle_denied", out _));
        Check("cancelled 静默", !AgentNotificationDispatcher.TryMapOutcome("cancelled", out _));
        Check("未知 outcome 静默", !AgentNotificationDispatcher.TryMapOutcome("whatever", out _));

        // 2. 派发：sink 收到意图+文案；null sink 不炸
        var seen = new List<(NotificationKind, string, string)>();
        INotificationSink capture = new CaptureSink(seen);
        AgentNotificationDispatcher.DispatchOutcome(capture, "done");
        Check("done 派发一条", seen.Count == 1 && seen[0].Item2 == "任务完成");
        AgentNotificationDispatcher.DispatchOutcome(capture, "waiting_tool");
        Check("中间态不派发", seen.Count == 1);
        AgentNotificationDispatcher.DispatchOutcome(null, "done");
        Check("null sink 不炸", true);

        // 3. 文案非空
        var (title, body) = AgentNotificationDispatcher.DefaultText(NotificationKind.WaitingInput);
        Check("等待输入文案", title.Length > 0 && body.Length > 0);

        return failures;
    }

    private sealed class CaptureSink(List<(NotificationKind, string, string)> sink) : INotificationSink
    {
        public void Show(NotificationKind kind, string title, string body) => sink.Add((kind, title, body));
    }
}

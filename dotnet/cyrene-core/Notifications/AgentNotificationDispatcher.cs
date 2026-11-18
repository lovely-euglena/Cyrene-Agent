namespace CyreneNative.Notifications;

/// <summary>
/// Agent 事件 → 通知意图的纯映射（.NET 版通知后端核心，issue #153）。
///
/// 与 Electron 侧 desktop-notifications.ts 的 extractNotification 语义对齐：
/// - 终态 done → 任务完成；failed/done_denied → 任务出错；timeout → 任务超时；
/// - cancelled / idle_denied 是用户可控行为或可续步态，不打扰；
/// - 等待输入（审批/ask）是最有价值的场景：挂着干等回复。
///
/// 纯函数零依赖：AgentSessionHost 协议循环在 result 终态帧处调用，
/// 映射结果经 INotificationSink 吐给宿主平台（托盘气泡等）。
/// 节制策略（总开关/前台静默）由宿主侧注入的 sink 决定——core 不读设置。
/// </summary>
public static class AgentNotificationDispatcher
{
    /// <summary>
    /// AgentSessionHost 终态 outcome → 通知意图。
    /// 返回 false 表示不通知（cancelled / 中间态 / 非终态）。
    /// </summary>
    public static bool TryMapOutcome(string outcome, out NotificationKind kind)
    {
        switch (outcome)
        {
            case "done":
                kind = NotificationKind.TaskFinished;
                return true;
            case "failed":
            case "done_denied":
                // done_denied：连续 3 轮白名单全拒硬终止——模型失控，值得打扰
                kind = NotificationKind.TaskFailed;
                return true;
            case "timeout":
                kind = NotificationKind.TaskTimeout;
                return true;
            case "waiting_input":
            case "waiting_permission":
                kind = NotificationKind.WaitingInput;
                return true;
            default:
                // idle / waiting_tool / idle_denied / cancelled / session_destroyed 等：静默
                kind = default;
                return false;
        }
    }

    /// <summary>意图 → 默认文案（中文，主进程语言现状与 Electron 版一致）。</summary>
    public static (string Title, string Body) DefaultText(NotificationKind kind) => kind switch
    {
        NotificationKind.TaskFinished => ("任务完成", "昔涟已完成这轮任务，点击查看结果。"),
        NotificationKind.TaskFailed => ("任务出错", "这轮任务运行出错，点击查看原因。"),
        NotificationKind.TaskTimeout => ("任务超时", "这轮任务超时中断了，点击查看详情。"),
        NotificationKind.WaitingInput => ("等待你的输入", "昔涟有问题要问你，点击回到对话。"),
        _ => ("昔涟", ""),
    };

    /// <summary>
    /// 便捷入口：outcome 终态 → 通知意图 → sink 派发。
    /// sink 为 null 或映射不上时静默；异常吞掉（通知绝不影响主流程）。
    /// </summary>
    public static void DispatchOutcome(INotificationSink? sink, string outcome)
    {
        try
        {
            if (sink is null) return;
            if (!TryMapOutcome(outcome, out var kind)) return;
            var (title, body) = DefaultText(kind);
            sink.Show(kind, title, body);
        }
        catch
        {
            // 通知是旁路：任何异常都不上抛
        }
    }
}

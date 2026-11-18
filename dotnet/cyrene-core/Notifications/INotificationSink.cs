namespace CyreneNative.Notifications;

/// <summary>通知意图类别（对齐 Electron 侧 desktop-notifications 的场景语义，issue #153）。</summary>
public enum NotificationKind
{
    /// <summary>任务完成（终态 success）。</summary>
    TaskFinished,

    /// <summary>任务失败（终态 error / failed）。</summary>
    TaskFailed,

    /// <summary>任务超时。</summary>
    TaskTimeout,

    /// <summary>等待用户输入（ask / 审批卡片）。</summary>
    WaitingInput,
}

/// <summary>
/// 通知出口（平台适配点）。cyrene-core 只产意图，不碰 UI——
/// native-windows 的托盘（NotifyIcon 气泡）、Electron 托盘等宿主各自实现。
/// 实现必须线程安全且绝不抛出（通知是旁路，不影响主流程）。
/// </summary>
public interface INotificationSink
{
    /// <summary>展示一条通知；title/body 已本地化文案。</summary>
    void Show(NotificationKind kind, string title, string body);
}

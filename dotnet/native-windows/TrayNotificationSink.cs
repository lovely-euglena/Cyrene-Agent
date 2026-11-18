using System.Windows.Threading;

using WF = System.Windows.Forms;

using CyreneNative.Notifications;

namespace CyreneNative;

/// <summary>
/// .NET 版通知后端的平台适配（issue #153）：INotificationSink → 托盘气泡。
/// Win10+ 的 ShowBalloonTip 自动转 toast 进通知中心；Win7/8 退化为经典气泡。
/// 线程安全：任意线程调用都 BeginInvoke 回托盘 Dispatcher；异常全吞（旁路）。
/// </summary>
public sealed class TrayNotificationSink : INotificationSink
{
    private readonly Dispatcher? _dispatcher;
    private readonly WF.NotifyIcon? _notifyIcon;

    /// <summary>tray 模式装配：托盘进程内直接持 NotifyIcon。</summary>
    public TrayNotificationSink(Dispatcher? dispatcher, WF.NotifyIcon? notifyIcon)
    {
        _dispatcher = dispatcher;
        _notifyIcon = notifyIcon;
    }

    public void Show(NotificationKind kind, string title, string body)
    {
        var icon = kind switch
        {
            NotificationKind.TaskFailed or NotificationKind.TaskTimeout => WF.ToolTipIcon.Error,
            NotificationKind.WaitingInput => WF.ToolTipIcon.Warning,
            _ => WF.ToolTipIcon.Info,
        };
        var dispatcher = _dispatcher;
        var notifyIcon = _notifyIcon;
        if (dispatcher is null || notifyIcon is null) return;
        try
        {
            dispatcher.BeginInvoke(new Action(() =>
            {
                try
                {
                    notifyIcon.ShowBalloonTip(5000, title, body, icon);
                }
                catch { /* 托盘异常不打扰主流程 */ }
            }));
        }
        catch { /* Dispatcher 已关停 */ }
    }
}

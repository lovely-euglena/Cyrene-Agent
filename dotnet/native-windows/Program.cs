using WpfApplication = System.Windows.Application;

namespace CyreneNative;

/// <summary>
/// cyrene-native 进程入口。
///
/// 命令行：
///   cyrene-native [serve]      窗口宿主模式（默认）：承载 splash /
///                              sidebar / tasks 三个原生窗口，协议见
///                              HostProtocol。stdin EOF（宿主退出）→
///                              全窗口安全关闭。
///   cyrene-native --tray       分离托盘模式：NotifyIcon 常驻 +
///                              named pipe cyrene-tray + spawn/管理
///                              Electron 主程序（见 TrayHost）。托盘
///                              独立于 Electron 生死——Electron 全退
///                              后仅托盘驻留（~20MB vs 主进程 ~150MB）。
/// </summary>
public static class Program
{
    [STAThread]
    public static int Main(string[] args)
    {
        if (args.Length > 0 && args[0] == "--tray")
        {
            TrayHost.Run(TrayHost.ResolveElectronExe());
            return 0;
        }

        // MCP 桥宿主模式：无窗口后台进程，承载全部 MCP server 连接管理
        // （重连/超时/进程树清理），协议见 Mcp.McpHost 头注释。
        if (args.Length > 0 && args[0] == "--mcp-host")
        {
            return Mcp.McpHost.Run();
        }

        // SSH 托管宿主：有状态会话常驻（档案/凭据落 --data-dir），协议见 Ssh.SshHost。
        if (args.Length > 0 && args[0] == "--ssh-host")
        {
            return Ssh.SshHost.Run(args);
        }

        // Snipaste 命令行截图：一次性捕获，stdout 单行 JSON（见 Screenshot.SnipasteCapture）。
        if (args.Length > 0 && args[0] == "--snipaste-capture")
        {
            return Screenshot.SnipasteCapture.Run(args);
        }

        // 内置工具宿主：计算/系统交互型工具的 .NET 执行（超时/回退由宿主管理）
        if (args.Length > 0 && args[0] == "--tool-host")
        {
            return Tools.ToolHost.Run();
        }

        // 多 Agent 会话宿主：会话生命周期/状态机/编排（LLM 回调闭环在主进程）
        if (args.Length > 0 && args[0] == "--agent-host")
        {
            return Agents.AgentSessionHost.RunProtocolLoop();
        }

        var app = new WpfApplication
        {
            ShutdownMode = System.Windows.ShutdownMode.OnExplicitShutdown,
        };
        // UI 线程兜底：单个窗口/绘制异常不应让整个 cyrene-native 进程闪退
        // （用户报「日程页拖动后闪退」）。记录后吞掉，其余窗口继续存活。
        app.DispatcherUnhandledException += (_, e) =>
        {
            Console.Error.WriteLine($"[cyrene-native] dispatcher unhandled: {e.Exception}");
            e.Handled = true;
        };
        var protocol = new HostProtocol(
            Console.OpenStandardInput(),
            Console.OpenStandardOutput(),
            (id, element) => RequestRouter.Handle(app, id, element),
            element => RequestRouter.OnEvent(app, element));
        RequestRouter.Protocol = protocol;
        // 宿主退出（stdin EOF）：安全关闭全部窗口并结束进程，避免孤儿常驻。
        protocol.InputClosed += () =>
        {
            try { app.Dispatcher.BeginInvokeShutdown(System.Windows.Threading.DispatcherPriority.Normal); }
            catch { /* 已关闭/调度器不可用：进程即将自然退出 */ }
        };
        // ready 握手：宿主 launch() 阻塞等待此帧（15s 超时回收）。
        // 必须在读线程就位后尽快发——WPF 就绪与否与协议就绪无关
        protocol.NotifyReady();

        app.Run();
        protocol.Dispose();
        return 0;
    }
}

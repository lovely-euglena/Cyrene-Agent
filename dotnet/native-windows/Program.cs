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

        var app = new WpfApplication
        {
            ShutdownMode = System.Windows.ShutdownMode.OnExplicitShutdown,
        };
        var protocol = new HostProtocol(
            Console.OpenStandardInput(),
            Console.OpenStandardOutput(),
            (id, element) => RequestRouter.Handle(app, id, element),
            element => RequestRouter.OnEvent(app, element));
        RequestRouter.Protocol = protocol;
        // ready 握手：宿主 launch() 阻塞等待此帧（15s 超时回收）。
        // 必须在读线程就位后尽快发——WPF 就绪与否与协议就绪无关
        protocol.NotifyReady();

        app.Run();
        protocol.Dispose();
        return 0;
    }
}

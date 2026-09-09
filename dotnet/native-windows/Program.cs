using WpfApplication = System.Windows.Application;

namespace CyreneNative;

/// <summary>
/// cyrene-native 进程入口：承载 splash / sidebar / tasks 三个原生窗口，
/// 取代对应的 Electron BrowserWindow（-3 Chromium 渲染进程）。
///
/// 命令行：
///   cyrene-native [serve]
/// 协议见 HostProtocol。stdin EOF（宿主退出）→ 全窗口安全关闭。
/// </summary>
public static class Program
{
    [STAThread]
    public static int Main(string[] args)
    {
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

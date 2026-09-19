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

        // RAG 数据层宿主：SQLite/WAL + jieba BM25 + 混合检索（阶段 2 E）
        if (args.Length > 0 && args[0] == "--rag-host")
        {
            return Rag.RagHost.RunProtocolLoop();
        }

        // 记忆系统宿主：L0/L1/冲突/反思四表 SQLite 化（阶段 6 I；L2 DMAE 暂缓 A7）
        if (args.Length > 0 && args[0] == "--memory-host")
        {
            return MemoryStore.MemoryHost.RunProtocolLoop();
        }

        // 对话循环宿主：chat-loop 状态机下沉骨架（阶段 8 K）
        if (args.Length > 0 && args[0] == "--loop-host")
        {
            return LoopHostNs.LoopHost.RunProtocolLoop();
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

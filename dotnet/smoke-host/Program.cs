// 冒烟壳入口：同主 Program 的 host 分发，但排除窗口/托盘（Linux 无 WinForms）。
// ClipboardTool 在 ToolHost 分发中被引用——以 #if 方式由 BuiltinTools 替代实现。
using CyreneNative.Tools;
using CyreneNative.Rag;
using CyreneNative.MemoryStore;
using CyreneNative.Agents;
using CyreneNative.LoopHostNs;
using CyreneNative.Mcp;

namespace CyreneSmoke;

internal static class Program
{
    private static int Main(string[] args)
    {
        if (args.Length > 1 && args[0] == "--selftest") return OrchestratorSelfTest.Run();
        if (args.Length > 0 && args[0] == "--tool-host") return ToolHost.Run();
        if (args.Length > 0 && args[0] == "--rag-host") return RagHost.RunProtocolLoop();
        if (args.Length > 0 && args[0] == "--memory-host") return MemoryHost.RunProtocolLoop();
        if (args.Length > 0 && args[0] == "--agent-host") return AgentSessionHost.RunProtocolLoop();
        if (args.Length > 0 && args[0] == "--loop-host") return LoopHost.RunProtocolLoop();
        if (args.Length > 0 && args[0] == "--mcp-host") return McpHost.Run();
        Console.Error.WriteLine("smoke host: 未知模式 " + string.Join(" ", args));
        return 2;
    }
}

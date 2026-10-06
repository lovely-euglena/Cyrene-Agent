// 冒烟壳入口：同主 Program 的 host 分发，但排除窗口/托盘（Linux 无 WinForms）。
// 剪贴板实现在 cyrene-native（WPF）注入 cyrene-core；冒烟壳不注入 = 不可用（正常）。
using CyreneNative.Tools;
using CyreneNative.Rag;
using CyreneNative.MemoryStore;
using CyreneNative.Agents;
using CyreneNative.LoopHostNs;
using CyreneNative.Mcp;
using CyreneNative.Secrets;
using CyreneNative.Llm;

namespace CyreneSmoke;

internal static class Program
{
    private static int Main(string[] args)
    {
        if (args.Length > 1 && args[0] == "--selftest")
        {
            if (args[1] == "sync-protocol")
                return SyncProtocolSelfTest.Run(args.Length > 2 ? args[2] : "fixtures/sync-protocol/cases");
            if (args[1] == "sync-materialize")
                return SyncMaterializeSelfTest.Run(args.Length > 2 ? args[2] : "fixtures/sync-protocol/materialize-cases");
            if (args[1] == "channel-contract")
                return ChannelContractSelfTest.Run(args.Length > 2 ? args[2] : "fixtures/channels");
            if (args[1] == "llm-jobs")
                return LlmJobsSelfTest.Run();
            if (args[1] == "llm-stream")
                return LlmStreamSelfTest.RunAsync().GetAwaiter().GetResult();
            if (args[1] == "scheduler")
                return SchedulerSelfTest.Run();
            return OrchestratorSelfTest.Run();
        }
        if (args.Length > 1 && args[0] == "--pdf-text") return PdfTextProbe.Run(args[1]);
        if (args.Length > 0 && args[0] == "--tool-host") return ToolHost.Run();
        if (args.Length > 0 && args[0] == "--rag-host") return RagHost.RunProtocolLoop();
        if (args.Length > 0 && args[0] == "--memory-host") return MemoryHost.RunProtocolLoop();
        if (args.Length > 0 && args[0] == "--agent-host") return AgentSessionHost.RunProtocolLoop();
        if (args.Length > 0 && args[0] == "--loop-host") return LoopHost.RunProtocolLoop();
        if (args.Length > 0 && args[0] == "--mcp-host") return McpHost.Run();
        // 密钥库宿主（Linux 冒烟：明文测试保护器，plain: 前缀，仅测试链路用）
        if (args.Length > 0 && args[0] == "--secrets-host")
            return SecretsHost.Run(args, new PlainSecretProtector());
        // llm 作业宿主（Linux 冒烟：明文 vault 提供者，鉴权注入/SSE 解析/重试全真链路）
        if (args.Length > 0 && args[0] == "--llm-host")
            return LlmHost.Run(args, new VaultSecretProvider(new SecretVault(ParseDataDir(args) ?? ".", new PlainSecretProtector())));
        Console.Error.WriteLine("smoke host: 未知模式 " + string.Join(" ", args));
        return 2;
    }

    private static string? ParseDataDir(string[] args)
    {
        for (var i = 0; i < args.Length - 1; i++)
            if (args[i] == "--data-dir") return args[i + 1];
        return null;
    }
}

/// <summary>明文测试保护器（plain: 前缀）——仅冒烟壳/测试用，生产用 DPAPI。</summary>
public sealed class PlainSecretProtector : ISecretProtector
{
    public string Scheme => "plain";
    public bool IsAvailable => true;
    public string Protect(string plain) => "plain:" + plain;
    public string? Unprotect(string stored)
        => stored.StartsWith("plain:", StringComparison.Ordinal) ? stored["plain:".Length..] : stored;
}

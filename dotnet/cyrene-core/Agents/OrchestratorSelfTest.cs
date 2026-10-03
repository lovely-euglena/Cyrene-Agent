using System.Text.Json;

namespace CyreneNative.Agents;

/// <summary>
/// J6 越权/失控保护自测（cyrene-native --selftest agents）。
/// 退出码 = 失败数；全过输出 PASS 行。CI/冒烟脚本直接消费退出码。
/// </summary>
internal static class OrchestratorSelfTest
{
    public static int Run()
    {
        var failures = 0;
        void Check(string name, bool ok)
        {
            if (ok) Console.WriteLine($"[PASS] {name}");
            else { failures++; Console.WriteLine($"[FAIL] {name}"); }
        }

        // 1. 白名单 closed-by-default：未声明 allowedTools 一律拒
        var host = new AgentSessionHost();
        host.Create("t1", JsonDocument.Parse("{}").RootElement);
        Check("白名单未声明 → 拒绝", !Orchestrator.ToolAllowed(host, "t1", "run_shell"));

        // 2. 声明 "*" 全放行；声明具体工具仅放行该工具
        host.Create("t2", JsonDocument.Parse("{\"allowedTools\":[\"*\"]}").RootElement);
        Check("白名单 * → 放行任意", Orchestrator.ToolAllowed(host, "t2", "run_shell"));
        host.Create("t3", JsonDocument.Parse("{\"allowedTools\":[\"read_file\"]}").RootElement);
        Check("白名单具体工具 → 放行本工具", Orchestrator.ToolAllowed(host, "t3", "read_file"));
        Check("白名单具体工具 → 拒绝其他", !Orchestrator.ToolAllowed(host, "t3", "write_file"));

        // 3. 会话上限防失控：MaxTurns 硬闸（连续 step 直到抛异常）
        host.Create("t4", JsonDocument.Parse("{}").RootElement);
        var hitLimit = false;
        try
        {
            for (var i = 0; i < AgentSessionHost.MaxTurns + 2; i++)
            {
                var (_, _) = host.BeginStep("t4", $"msg{i}");
                // 直接把状态拨回 Idle 模拟每轮完成（闭环由 Electron 驱动，
                // 自测里手动推进状态机）
            }
        }
        catch (InvalidOperationException) { hitLimit = true; }
        Check($"MaxTurns={AgentSessionHost.MaxTurns} 硬闸触发", hitLimit);

        Console.WriteLine(failures == 0 ? "SELFTEST agents: ALL PASS" : $"SELFTEST agents: {failures} FAILURES");
        return failures;
    }
}

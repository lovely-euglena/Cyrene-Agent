using CyreneNative.Channels;

namespace CyreneSmoke;

/// <summary>
/// 渠道消息契约自测（cyrene-smoke --selftest channel-contract [fixturesDir]）：
/// 用 cyrene-core 归一化实现跑 fixtures/channels/cases，退出码 = 失败数。
/// 与 TS 侧（npx vitest run src/main/channels）共用同一套向量，结果必须一致。
/// </summary>
internal static class ChannelContractSelfTest
{
    public static int Run(string fixturesDir)
    {
        var casesDir = Path.Combine(fixturesDir, "cases");
        if (!Directory.Exists(casesDir))
        {
            Console.WriteLine($"[FAIL] channel-contract cases 目录不存在: {casesDir}");
            Console.WriteLine("SELFTEST channel-contract: 1 FAILURES");
            return 1;
        }
        var failures = 0;
        // runner 自检（P1-5）：布尔 deep-equal 负向探针——人为漂移必须失败，防止比较盲区回归
        var selfCheck = ChannelContractFixture.BooleanCompareSelfCheck();
        if (selfCheck is null)
        {
            Console.WriteLine("[PASS] runner 自检：布尔 deep-equal 漂移可捕获");
        }
        else
        {
            failures++;
            Console.WriteLine($"[FAIL] runner 自检：{selfCheck}");
        }
        var cases = ChannelContractFixture.LoadDirectory(casesDir);
        foreach (var item in cases)
        {
            var result = ChannelContractFixture.Run(item);
            if (result.Ok)
            {
                Console.WriteLine($"[PASS] {item.File}");
            }
            else
            {
                failures++;
                Console.WriteLine($"[FAIL] {item.File} — {result.Detail}");
            }
        }
        Console.WriteLine(failures == 0
            ? $"SELFTEST channel-contract: ALL PASS（{cases.Count} fixtures）"
            : $"SELFTEST channel-contract: {failures} FAILURES");
        return failures;
    }
}

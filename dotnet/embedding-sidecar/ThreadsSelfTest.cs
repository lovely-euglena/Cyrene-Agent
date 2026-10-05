namespace CyreneEmbedSidecar;

/// <summary>
/// `cyrene-embed verify-threads` 自检：CYRENE_EMBED_THREADS 语义三分支——
///   0 = 不设置（ORT 默认全核）；未设置/非法 = 默认半核（上限 4）；>0 = 显式上限。
/// 覆盖决策纯函数、环境变量解析、embedding 与 reranker 两侧 SessionOptions 应用；
/// 只构造会话选项、不加载模型文件，秒级完成。任一项失败退出码 1。
/// </summary>
public static class ThreadsSelfTest
{
    public static int Run()
    {
        var pass = 0;
        var fail = 0;

        void Check(string name, bool ok)
        {
            if (ok)
            {
                pass++;
                Console.WriteLine($"[PASS] {name}");
            }
            else
            {
                fail++;
                Console.WriteLine($"[FAIL] {name}");
            }
        }

        // ── 决策纯函数三分支（不依赖本机核数） ──
        Check("0 → 不设置（ORT 默认全核）", EmbeddingEngine.ResolveIntraOpThreads(0, 8) is null);
        Check("0 → 不设置（单核同样）", EmbeddingEngine.ResolveIntraOpThreads(0, 1) is null);
        Check("未设置/非法（-1）→ 半核，上限 4（16 核 → 4）", EmbeddingEngine.ResolveIntraOpThreads(-1, 16) == 4);
        Check("未设置/非法（-1）→ 半核（4 核 → 2）", EmbeddingEngine.ResolveIntraOpThreads(-1, 4) == 2);
        Check("未设置/非法（-1）→ 半核（2 核 → 1）", EmbeddingEngine.ResolveIntraOpThreads(-1, 2) == 1);
        Check("未设置/非法（-1）→ 单核不设置", EmbeddingEngine.ResolveIntraOpThreads(-1, 1) is null);
        Check(">0 → 显式上限（3）", EmbeddingEngine.ResolveIntraOpThreads(3, 8) == 3);
        Check(">0 超过核数 → 封顶核数（32 → 8）", EmbeddingEngine.ResolveIntraOpThreads(32, 8) == 8);

        // ── 环境变量解析（ReadThreadsEnv） ──
        var savedEnv = Environment.GetEnvironmentVariable("CYRENE_EMBED_THREADS");
        try
        {
            Environment.SetEnvironmentVariable("CYRENE_EMBED_THREADS", null);
            Check("未设置 → -1（默认策略）", EmbeddingEngine.ReadThreadsEnv() == -1);
            Environment.SetEnvironmentVariable("CYRENE_EMBED_THREADS", "0");
            Check("0 → 0（ORT 默认）", EmbeddingEngine.ReadThreadsEnv() == 0);
            Environment.SetEnvironmentVariable("CYRENE_EMBED_THREADS", "6");
            Check("6 → 6（显式上限）", EmbeddingEngine.ReadThreadsEnv() == 6);
            Environment.SetEnvironmentVariable("CYRENE_EMBED_THREADS", "abc");
            Check("非法 abc → -1（默认策略）", EmbeddingEngine.ReadThreadsEnv() == -1);
            Environment.SetEnvironmentVariable("CYRENE_EMBED_THREADS", "-3");
            Check("负数 -3 → -1（默认策略，不视为显式上限）", EmbeddingEngine.ReadThreadsEnv() == -1);
        }
        finally
        {
            Environment.SetEnvironmentVariable("CYRENE_EMBED_THREADS", savedEnv);
        }

        // ── SessionOptions 应用：embedding / reranker 两侧一致 ──
        // 期望值随本机核数计算；0 表示未设置（ORT 默认）。
        var cores = Environment.ProcessorCount;
        var expectedDefault = cores > 1 ? Math.Min(4, Math.Max(1, cores / 2)) : 0;

        void CheckOptions(string name, string? envValue, int expected)
        {
            var previous = Environment.GetEnvironmentVariable("CYRENE_EMBED_THREADS");
            try
            {
                Environment.SetEnvironmentVariable("CYRENE_EMBED_THREADS", envValue);
                using var embedOptions = EmbeddingEngine.CreateSessionOptions();
                using var rerankOptions = RerankerEngine.CreateSessionOptions();
                var embedThreads = embedOptions.IntraOpNumThreads;
                var rerankThreads = rerankOptions.IntraOpNumThreads;
                Check(
                    $"{name}：embedding={embedThreads} reranker={rerankThreads}（期望 {expected}）",
                    embedThreads == expected && rerankThreads == expected);
            }
            catch (Exception ex)
            {
                Check($"{name}：SessionOptions 构造失败 — {ex.Message}", false);
            }
            finally
            {
                Environment.SetEnvironmentVariable("CYRENE_EMBED_THREADS", previous);
            }
        }

        CheckOptions("未设置 → 默认半核（上限 4）", null, expectedDefault);
        CheckOptions("非法值 → 默认半核（上限 4）", "not-a-number", expectedDefault);
        CheckOptions("0 → ORT 默认（不设置）", "0", 0);
        CheckOptions(">0 → 显式上限 3", "3", Math.Min(3, cores));
        CheckOptions(">0 超过核数 → 封顶核数", (cores + 16).ToString(), cores);

        Console.WriteLine($"[verify-threads] {pass} passed, {fail} failed");
        return fail == 0 ? 0 : 1;
    }
}

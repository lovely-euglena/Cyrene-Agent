namespace CyreneEmbedSidecar;

/// <summary>
/// `cyrene-embed verify-models` 自检：模型路由（modelDir 缺省回退 / modelKey
/// 推导）与引擎池（惰性加载复用 / 容量上限 / LRU 卸载 / 租约保护）纯逻辑回归。
/// 用假引擎 + 注入工厂，不加载任何模型文件，秒级完成；任一项失败退出码 1。
/// </summary>
public static class ModelsSelfTest
{
    private sealed class FakeEngine : IDisposable
    {
        public int DisposeCount { get; private set; }
        public void Dispose() => DisposeCount++;
    }

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

        // ── 路由纯函数：缺省回退 / 规范化 / 键推导 ──
        var defaultDir = ModelRouting.NormalizeModelDir(Path.Combine("repo", "models", "Xenova", "bge-m3"));
        var e5Dir = ModelRouting.NormalizeModelDir(Path.Combine("repo", "models", "Xenova", "multilingual-e5-small"));
        Check("请求无 modelDir → 启动默认目录", ModelRouting.ResolveModelDir(null, defaultDir) == defaultDir);
        Check("请求空白 modelDir → 启动默认目录", ModelRouting.ResolveModelDir("   ", defaultDir) == defaultDir);
        Check("请求显式 modelDir → 规范化后路由", ModelRouting.ResolveModelDir(e5Dir, defaultDir) == e5Dir);
        Check("bge-m3 目录名 → 既有键 bgem3", ModelRouting.DeriveModelKey(defaultDir) == "bgem3");
        Check("multilingual-e5-small 目录名 → 宿主键 e5-small", ModelRouting.DeriveModelKey(e5Dir) == "e5-small");
        Check("未知目录名 → 小写去非字母数字", ModelRouting.DeriveModelKey(Path.Combine("repo", "models", "Some_Model-x")) == "somemodelx");
        Check("目录名带尾分隔符 → 同一键", ModelRouting.DeriveModelKey(defaultDir + Path.DirectorySeparatorChar) == "bgem3");
        Check("目录规范化幂等", ModelRouting.NormalizeModelDir(defaultDir + Path.DirectorySeparatorChar) == defaultDir);

        // ── 池：工厂注入，记录每个键的加载次数 ──
        var loads = new Dictionary<string, int>();
        EnginePool<FakeEngine> NewPool(int capacity) =>
            new(capacity, (key) =>
            {
                loads[key] = loads.GetValueOrDefault(key) + 1;
                return new FakeEngine();
            });

        // 1) 惰性加载 + 同键复用
        loads.Clear();
        var pool = NewPool(2);
        FakeEngine first;
        using (var lease = pool.Acquire("dir-a")) first = lease.Engine;
        Check("未命中才加载（惰性）", loads["dir-a"] == 1 && pool.Count == 1);
        using (var lease = pool.Acquire("dir-a"))
        {
            Check("同目录复用同一引擎实例", ReferenceEquals(first, lease.Engine) && loads["dir-a"] == 1);
        }

        // 2) 默认回退经池路由：请求无 modelDir → 默认目录 → 复用不重复加载
        loads.Clear();
        var routed = NewPool(2);
        string Route(string? requestDir) => ModelRouting.ResolveModelDir(requestDir, defaultDir);
        FakeEngine routedDefault;
        using (var lease = routed.Acquire(Route(null))) routedDefault = lease.Engine;
        using (var lease = routed.Acquire(Route(null)))
        {
            Check("默认回退复用启动引擎", ReferenceEquals(routedDefault, lease.Engine) && loads[defaultDir] == 1);
        }
        using (var lease = routed.Acquire(Route(e5Dir)))
        {
            Check("显式 modelDir 路由到独立引擎", !ReferenceEquals(routedDefault, lease.Engine) && loads[e5Dir] == 1);
        }

        // 3) 上限 + LRU：a 最近使用、b 最久未用 → 加载 c 时卸载 b
        loads.Clear();
        var lru = NewPool(2);
        FakeEngine a, b, c;
        using (var lease = lru.Acquire("a")) a = lease.Engine;
        using (var lease = lru.Acquire("b")) b = lease.Engine;
        using (var lease = lru.Acquire("a")) { } // touch a → a 变为最近使用
        using (var lease = lru.Acquire("c")) c = lease.Engine;
        Check("超上限按 LRU 卸载最久未用（Dispose）", b.DisposeCount == 1 && a.DisposeCount == 0 && c.DisposeCount == 0);
        Check("卸载后数量回落到上限", lru.Count == 2 && !lru.ContainsKey("b") && lru.ContainsKey("a") && lru.ContainsKey("c"));

        // 4) 顺序 acquire/release 三次不同目录：稳态不超过上限
        loads.Clear();
        var capped = NewPool(2);
        using (var lease = capped.Acquire("a")) { }
        using (var lease = capped.Acquire("b")) { }
        using (var lease = capped.Acquire("c")) { }
        Check("三次不同目录后稳态数量 = 上限 2", capped.Count == 2);

        // 5) 租约保护：全部租用中不 Dispose 在用引擎（短暂超限），释放后回落
        loads.Clear();
        var leased = NewPool(2);
        var la = leased.Acquire("a");
        var lb = leased.Acquire("b");
        var lc = leased.Acquire("c");
        Check("全部被租用时暂不卸载（不 Dispose 在用引擎）",
            leased.Count == 3 && la.Engine.DisposeCount == 0 && lb.Engine.DisposeCount == 0 && lc.Engine.DisposeCount == 0);
        lb.Dispose();
        Check("租约释放后回落到上限并卸载 LRU", leased.Count == 2 && lb.Engine.DisposeCount == 1);
        lc.Dispose();
        la.Dispose();

        // 6) 池 Dispose：卸载全部；之后 Acquire 抛异常，迟到 Release 安全 no-op
        loads.Clear();
        var disposed = NewPool(2);
        var ld = disposed.Acquire("a");
        disposed.Dispose();
        Check("池 Dispose 卸载全部引擎", ld.Engine.DisposeCount == 1 && disposed.Count == 0);
        ld.Dispose();
        Check("池 Dispose 后迟到 Release 不抛", true);
        try
        {
            disposed.Acquire("b");
            Check("池 Dispose 后 Acquire 抛 ObjectDisposedException", false);
        }
        catch (ObjectDisposedException)
        {
            Check("池 Dispose 后 Acquire 抛 ObjectDisposedException", true);
        }

        Console.WriteLine($"[verify-models] {pass} passed, {fail} failed");
        return fail == 0 ? 0 : 1;
    }
}

// 无头逻辑自测（退出码驱动，与 cyrene-native --selftest 同例）。
// 不依赖 GPU/窗口：模型解析 / 动画曲线 / 物理 / 行为状态机 / 渲染 draw-list。
// Core 依赖项在 DLL 缺失时 SKIP（Linux CI 无 Core——纯逻辑项仍全跑）。

namespace CyreneLive2D.SelfTest;

public static class SelfTestRunner
{
    private static int _pass, _fail, _skip;

    public static int Run(string[] args)
    {
        string? modelDir = null, dataDir = null;
        for (var i = 0; i < args.Length; i++)
        {
            switch (args[i])
            {
                case "--model-dir" when i + 1 < args.Length: modelDir = args[++i]; break;
                case "--data-dir" when i + 1 < args.Length: dataDir = args[++i]; break;
            }
        }

        // 默认探测仓库内模型（开发机）
        modelDir ??= ProbeModelDir();

        Console.WriteLine($"[selftest] modelDir={modelDir ?? "<none>"} dataDir={dataDir ?? "<none>"}");

        Model3Tests.Run(modelDir);
        MotionTests.Run(modelDir);
        ExpressionTests.Run(modelDir);
        PhysicsTests.Run(modelDir);
        PoseTests.Run(modelDir);
        BreathTests.Run(modelDir);
        BehaviorTests.Run(modelDir);
        EngineTests.Run(modelDir);
        WindowTests.Run();
        WindowHostTests.Run();
        CoreTests.Run(modelDir, dataDir);
        CoreDownloaderTests.Run();
        RendererTests.Run(modelDir, dataDir);

        Console.WriteLine($"[selftest] PASS={_pass} FAIL={_fail} SKIP={_skip}");
        return _fail == 0 ? 0 : 1;
    }

    private static string? ProbeModelDir()
    {
        // exe 在 dotnet/live2d/CyreneLive2D/bin/{Cfg}/{tfm}/ 下——向上找仓库根
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        for (var i = 0; i < 8 && dir != null; i++, dir = dir.Parent)
        {
            var candidate = Path.Combine(dir.FullName, "src", "renderer", "public", "models", "cyrene");
            if (Directory.Exists(candidate)) return candidate;
        }
        return null;
    }

    public static void Check(bool condition, string name, string? detail = null)
    {
        if (condition) { _pass++; Console.WriteLine($"  ok  {name}"); }
        else { _fail++; Console.WriteLine($"FAIL  {name}{(detail != null ? $" — {detail}" : "")}"); }
    }

    public static void Skip(string name, string reason)
    {
        _skip++;
        Console.WriteLine($"skip  {name} — {reason}");
    }
}

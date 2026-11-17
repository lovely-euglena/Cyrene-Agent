// cyrene-live2d 入口：Live2D 桌宠渲染侧车（issue #257）。
//
// 形态（与七 host 架构并轨）：
//   cyrene-live2d.exe                 JSON 行协议宿主（默认，Electron 拉起）
//   cyrene-live2d.exe --selftest      无头逻辑自测（退出码驱动，CI 可跑）
//   cyrene-live2d.exe --core-smoke    T0 探针：Core 加载 + 版本 + moc 冒烟
//   cyrene-live2d.exe --render-test   离屏渲染 → PNG（T6 逐像素对照用）
//
// 协议：JSON 行（{op,callId} / {op:"result",callId,ok,...} / {op:"ready"} /
// {op:"shutdown"} / {op:"event",...}），与 tool/voice host 同构。
// stdout 仅协议帧；诊断走 stderr 或 log 帧。

using CyreneLive2D.Core;

namespace CyreneLive2D;

public static class Program
{
    public static int Main(string[] args)
    {
        // GUI 子系统（WinExe）下控制台句柄可能缺失——自测模式附着父控制台。
        if (args.Length > 0 && args[0] is "--selftest" or "--core-smoke" or "--render-test")
        {
            ConsoleAttach.Ensure();
        }

        try
        {
            if (args.Length > 0 && args[0] == "--core-smoke") return CoreSmoke(args[1..]);
            if (args.Length > 0 && args[0] == "--selftest") return SelfTest.SelfTestRunner.Run(args[1..]);
            if (args.Length > 0 && args[0] == "--render-test") return SelfTest.RenderTest.Run(args[1..]);
            return Host.Live2DHost.Run(args);
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[cyrene-live2d] fatal: {ex}");
            return 1;
        }
    }

    /// <summary>T0 探针：csmGetVersion / csmGetLatestMocVersion / revive / 参数计数。</summary>
    private static int CoreSmoke(string[] args)
    {
        string? dataDir = null, modelDir = null, mocPath = null;
        for (var i = 0; i < args.Length; i++)
        {
            switch (args[i])
            {
                case "--data-dir" when i + 1 < args.Length: dataDir = args[++i]; break;
                case "--model-dir" when i + 1 < args.Length: modelDir = args[++i]; break;
                case "--moc" when i + 1 < args.Length: mocPath = args[++i]; break;
            }
        }

        CoreLibrary.Load(dataDir, modelDir);
        var (version, latestMoc) = CoreLibrary.Smoke();
        Console.WriteLine($"core.version={CoreLibrary.VersionString} (0x{version:X8})");
        Console.WriteLine($"core.latestMocVersion={latestMoc}");
        Console.WriteLine($"core.path={CoreLibrary.LoadedPath}");

        if (mocPath != null)
        {
            using var model = Model.CubismModel.FromMoc3(mocPath);
            Console.WriteLine($"moc.version={model.MocVersion}");
            Console.WriteLine($"model.parameters={model.ParameterCount}");
            Console.WriteLine($"model.parts={model.PartCount}");
            Console.WriteLine($"model.drawables={model.DrawableCount}");
            Console.WriteLine($"model.canvas={model.CanvasWidth}x{model.CanvasHeight} ppu={model.PixelsPerUnit}");
        }

        Console.WriteLine("CORE_SMOKE_OK");
        return 0;
    }
}

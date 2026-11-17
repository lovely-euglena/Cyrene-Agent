// 离屏渲染测试（T2 验证 + T6 逐像素对照基建）：
// 加载模型 → 设参数 → 渲一帧 → 落 PNG + 帧统计。
//
// 用法：cyrene-live2d --render-test [--model-dir <dir>] [--out <png>]
//       [--width N --height N] [--zoom F] [--params k=v,...] [--data-dir <dir>]
//
// 默认 400×500（web 轨基础窗口尺寸，PET_RENDER_MAX_DPR=1 → 物理像素即 CSS 像素），
// T6 对照时 web 轨同尺寸截帧即可逐像素比。退出码：0 成功 / 1 失败 / 2 前置缺失。

using System.Diagnostics;
using CyreneLive2D.Core;
using CyreneLive2D.Model;
using CyreneLive2D.Rendering;

namespace CyreneLive2D.SelfTest;

public static class RenderTest
{
    public static int Run(string[] args)
    {
        string? modelDir = null, dataDir = null, outPath = null, paramsSpec = null;
        var width = 400;
        var height = 500;
        var zoom = 1f;
        for (var i = 0; i < args.Length; i++)
        {
            switch (args[i])
            {
                case "--model-dir" when i + 1 < args.Length: modelDir = args[++i]; break;
                case "--data-dir" when i + 1 < args.Length: dataDir = args[++i]; break;
                case "--out" when i + 1 < args.Length: outPath = args[++i]; break;
                case "--width" when i + 1 < args.Length: width = int.Parse(args[++i]); break;
                case "--height" when i + 1 < args.Length: height = int.Parse(args[++i]); break;
                case "--zoom" when i + 1 < args.Length: zoom = float.Parse(args[++i]); break;
                case "--params" when i + 1 < args.Length: paramsSpec = args[++i]; break;
            }
        }

        modelDir ??= ProbeModelDir();
        if (modelDir == null)
        {
            Console.Error.WriteLine("[render-test] 未找到模型目录（--model-dir 指定）。");
            return 2;
        }
        outPath ??= Path.Combine(Path.GetTempPath(), "cyrene-live2d-render.png");

        try
        {
            CoreLibrary.Load(dataDir, modelDir);
        }
        catch (CoreNotAvailableException ex)
        {
            Console.Error.WriteLine($"[render-test] Core 不可用: {ex.Message}");
            return 2;
        }

        var manifestPath = Path.Combine(modelDir, "Cyrene.model3.json");
        if (!File.Exists(manifestPath))
        {
            Console.Error.WriteLine($"[render-test] 缺清单: {manifestPath}");
            return 2;
        }

        var sw = Stopwatch.StartNew();
        var manifest = Model3Json.Load(manifestPath);
        using var model = CubismModel.FromMoc3(Path.Combine(modelDir, manifest.Moc));

        if (paramsSpec != null)
        {
            foreach (var pair in paramsSpec.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
            {
                var eq = pair.IndexOf('=');
                if (eq <= 0) continue;
                var id = pair[..eq];
                var value = float.Parse(pair[(eq + 1)..]);
                if (model.GetParameterIndex(id) < 0)
                {
                    Console.Error.WriteLine($"[render-test] 未知参数: {id}");
                    return 1;
                }
                model.SetParameterValueById(id, value);
            }
        }
        // 必须 csmUpdateModel 后 drawable 顶点/不透明度/动态标志才有效；
        // 静态基准（无 --params）同样需要按默认参数求值一次。
        model.Update();

        using var renderer = new CubismRenderer(model, manifest, modelDir);
        var pixels = renderer.Render(width, height, zoom);
        sw.Stop();

        var (opaque, minX, minY, maxX, maxY) = FrameStats(pixels, width, height);
        PngCodec.Save(outPath, pixels, width, height);

        Console.WriteLine($"[render-test] size={width}x{height} zoom={zoom}");
        Console.WriteLine($"[render-test] canvas={model.CanvasWidth}x{model.CanvasHeight} ppu={model.PixelsPerUnit} baseScale={renderer.ComputeBaseScale():F6}");
        Console.WriteLine($"[render-test] drawables={renderer.DrawableCount} maskGroups={renderer.MaskGroupCount}");
        Console.WriteLine($"[render-test] ttffMs={sw.ElapsedMilliseconds} opaquePixels={opaque} bbox=({minX},{minY})-({maxX},{maxY})");
        Console.WriteLine($"[render-test] out={outPath}");

        if (opaque < 100)
        {
            Console.Error.WriteLine("[render-test] 画面几乎全透明——渲染异常。");
            return 1;
        }
        Console.WriteLine("RENDER_TEST_OK");
        return 0;
    }

    /// <summary>帧统计：不透明像素数与包围盒（alpha>0）。</summary>
    internal static (int opaque, int minX, int minY, int maxX, int maxY) FrameStats(byte[] bgra, int width, int height)
    {
        int opaque = 0, minX = width, minY = height, maxX = -1, maxY = -1;
        for (var y = 0; y < height; y++)
        {
            var row = y * width * 4;
            for (var x = 0; x < width; x++)
            {
                if (bgra[row + x * 4 + 3] == 0) continue;
                opaque++;
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
            }
        }
        return (opaque, minX, minY, maxX, maxY);
    }

    private static string? ProbeModelDir()
    {
        // 与 SelfTestRunner 同策：publish 输出比构建输出深两层，深度留足余量
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        for (var i = 0; i < 12 && dir != null; i++, dir = dir.Parent)
        {
            var candidate = Path.Combine(dir.FullName, "src", "renderer", "public", "models", "cyrene");
            if (Directory.Exists(candidate)) return candidate;
        }
        return null;
    }
}

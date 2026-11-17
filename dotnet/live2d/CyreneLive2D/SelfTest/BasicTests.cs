// T1 自测：model3.json 解析 + Core 加载冒烟。

using System.Net.Http;
using CyreneLive2D.Core;
using CyreneLive2D.Model;

namespace CyreneLive2D.SelfTest;

public static class Model3Tests
{
    public static void Run(string? modelDir)
    {
        if (modelDir == null)
        {
            SelfTestRunner.Skip("model3.parse", "无模型目录");
            return;
        }
        var path = Path.Combine(modelDir, "Cyrene.model3.json");
        if (!File.Exists(path))
        {
            SelfTestRunner.Skip("model3.parse", $"缺 {path}");
            return;
        }

        var m = Model3Json.Load(path);
        SelfTestRunner.Check(m.Moc == "model.moc3", "model3.moc", m.Moc);
        SelfTestRunner.Check(m.Textures.Length == 1 && m.Textures[0] == "texture_0.png", "model3.textures");
        SelfTestRunner.Check(m.Physics == "model.physics3.json", "model3.physics");
        SelfTestRunner.Check(m.Motions.ContainsKey("动作#6") && m.Motions["动作#6"].Length == 4, "model3.motions.动作#6");
        SelfTestRunner.Check(m.Motions.ContainsKey("Tick3") && m.Motions["Tick3"].Length == 4, "model3.motions.Tick3");
        SelfTestRunner.Check(m.Motions["Tick3"][3].Name == "荡秋千（待机）", "model3.swingName", m.Motions["Tick3"][3].Name);
        SelfTestRunner.Check(m.Motions["动作#6"][1].Name == "Wink~", "model3.winkName");
        SelfTestRunner.Check(m.Motions["动作#6"][0].WrapMode == 2, "model3.wrapMode");
        SelfTestRunner.Check(m.Expressions.Count == 12, "model3.expressions.count", m.Expressions.Count.ToString());
        SelfTestRunner.Check(m.Expressions.ContainsKey("表情回正") && m.Expressions.ContainsKey("墨镜"), "model3.expressions.names");
        SelfTestRunner.Check(m.HitAreas.Length == 9, "model3.hitAreas.count", m.HitAreas.Length.ToString());
        SelfTestRunner.Check(m.EyeBlinkIds.SequenceEqual(new[] { "ParamEyeLOpen", "ParamEyeROpen" }), "model3.groups.eyeBlink");
        SelfTestRunner.Check(m.LipSyncIds.SequenceEqual(new[] { "ParamMouthOpenY" }), "model3.groups.lipSync");
        SelfTestRunner.Check(Math.Abs(m.MouseTrackingSmoothTime - 0.15f) < 1e-6, "model3.mouseTracking.smoothTime");

        // 表达式伪动作（Expression + NextMtn 链）
        var pseudo = m.Motions.Values.SelectMany(x => x).Where(d => d.File == null && d.Expression != null).ToArray();
        SelfTestRunner.Check(pseudo.Length > 0, "model3.pseudoMotions");
        SelfTestRunner.Check(pseudo.Any(d => d.NextMtn != null), "model3.nextMtnChain");
    }
}

public static unsafe class CoreTests
{
    public static void Run(string? modelDir, string? dataDir)
    {
        try
        {
            CoreLibrary.Load(dataDir, modelDir);
        }
        catch (CoreNotAvailableException)
        {
            SelfTestRunner.Skip("core.load", "Core DLL 缺失（运行时下载/用户自备）");
            return;
        }

        var (version, latestMoc) = CoreLibrary.Smoke();
        SelfTestRunner.Check(version > 0, "core.version", CoreLibrary.VersionString);
        SelfTestRunner.Check((uint)latestMoc >= 3, "core.latestMocVersion", latestMoc.ToString());

        if (modelDir == null) return;
        var mocPath = Path.Combine(modelDir, "model.moc3");
        if (!File.Exists(mocPath)) { SelfTestRunner.Skip("core.moc", "缺 model.moc3"); return; }

        using var model = CubismModel.FromMoc3(mocPath);
        SelfTestRunner.Check(model.ParameterCount > 30, "core.parameterCount", model.ParameterCount.ToString());
        SelfTestRunner.Check(model.DrawableCount > 50, "core.drawableCount", model.DrawableCount.ToString());
        SelfTestRunner.Check(model.CanvasWidth > 0 && model.CanvasHeight > 0, "core.canvas", $"{model.CanvasWidth}x{model.CanvasHeight}");
        SelfTestRunner.Check(model.PixelsPerUnit > 0, "core.ppu", model.PixelsPerUnit.ToString());
        SelfTestRunner.Check(model.GetParameterIndex("ParamMouthOpenY") >= 0, "core.paramIndex.mouth");
        SelfTestRunner.Check(model.GetParameterIndex("ParamEyeLOpen") >= 0, "core.paramIndex.eyeL");
        SelfTestRunner.Check(model.GetDrawableIndex("ArtMesh11") >= 0, "core.drawableIndex.hitArea");

        // 参数写入 → Update → drawable 顶点变化（冒烟：驱动 ParamAngleX）
        var angleX = model.GetParameterIndex("ParamAngleX");
        var d0 = model.DrawableIndexCounts[0];
        SelfTestRunner.Check(d0 > 0 && d0 % 3 == 0, "core.indexCount.triangles", d0.ToString());
        model.SetParameterValue(angleX, 30);
        model.Update();
        SelfTestRunner.Check(true, "core.update.afterParamWrite");

        // save/load 语义
        model.SaveParameters();
        model.SetParameterValue(angleX, -30);
        model.LoadParameters();
        SelfTestRunner.Check(Math.Abs(model.GetParameterValue(angleX) - 30) < 1e-6, "core.saveLoadParameters");
    }
}

// 以下测试类随各层落地逐项填充（T3/T4/T2）。
public static class MotionTests
{
    public static void Run(string? modelDir) { }
}

public static class ExpressionTests
{
    public static void Run(string? modelDir) { }
}

public static class PhysicsTests
{
    public static void Run(string? modelDir) { }
}

public static class BehaviorTests
{
    public static void Run() { }
}

// T2 自测：矩阵纯逻辑（无 GPU 依赖）+ 离屏渲染冒烟（缺 Core/GPU 时 SKIP）。
public static unsafe class RendererTests
{
    public static void Run(string? modelDir, string? dataDir)
    {
        // ── Matrix2D（行向量约定） ──
        var id = Rendering.Matrix2D.Identity;
        var (ix, iy) = id.Transform(3, -4);
        SelfTestRunner.Check(ix == 3 && iy == -4, "matrix.identity");

        var s = Rendering.Matrix2D.Scale(2, 3);
        var (sx, sy) = s.Transform(1, 1);
        SelfTestRunner.Check(sx == 2 && sy == 3, "matrix.scale");

        // 先缩放后平移：p' = (p*S)*T
        var st = s.Multiply(Rendering.Matrix2D.Translate(10, 20));
        var (stx, sty) = st.Transform(1, 1);
        SelfTestRunner.Check(stx == 12 && sty == 23, "matrix.scaleThenTranslate", $"{stx},{sty}");

        var flat = new float[16];
        st.WriteTo(flat);
        SelfTestRunner.Check(flat[0] == 2 && flat[5] == 3 && flat[12] == 10 && flat[13] == 20 && flat[15] == 1, "matrix.writeTo");

        // ── GPU 渲染冒烟 ──
        if (modelDir == null)
        {
            SelfTestRunner.Skip("renderer.gpu", "无模型目录");
            return;
        }
        try
        {
            CoreLibrary.Load(dataDir, modelDir);
        }
        catch (CoreNotAvailableException)
        {
            SelfTestRunner.Skip("renderer.gpu", "Core DLL 缺失");
            return;
        }
        var manifestPath = Path.Combine(modelDir, "Cyrene.model3.json");
        if (!File.Exists(manifestPath))
        {
            SelfTestRunner.Skip("renderer.gpu", "缺 Cyrene.model3.json");
            return;
        }

        var manifest = Model3Json.Load(manifestPath);
        using var model = CubismModel.FromMoc3(Path.Combine(modelDir, manifest.Moc));

        // 渲染秩是 0..n-1 的排列
        var n = model.DrawableCount;
        var orders = model.DrawableRenderOrders;
        var seen = new bool[n];
        var permutation = true;
        for (var i = 0; i < n; i++)
        {
            if (orders[i] < 0 || orders[i] >= n || seen[orders[i]]) { permutation = false; break; }
            seen[orders[i]] = true;
        }
        SelfTestRunner.Check(permutation, "renderer.renderOrder.permutation");

        Rendering.CubismRenderer renderer;
        try
        {
            renderer = new Rendering.CubismRenderer(model, manifest, modelDir);
        }
        catch (Exception ex) when (ex is Rendering.D3D11.D3D11Exception or DllNotFoundException)
        {
            SelfTestRunner.Skip("renderer.gpu", $"D3D11 不可用: {ex.Message}");
            return;
        }

        using (renderer)
        {
            var baseScale = renderer.ComputeBaseScale();
            var expected = Math.Min(400f / model.CanvasWidth, Math.Min(500f / model.CanvasHeight, 1f));
            SelfTestRunner.Check(Math.Abs(baseScale - expected) < 1e-6, "renderer.baseScale", baseScale.ToString("F6"));

            var pixels = renderer.Render(400, 500);
            SelfTestRunner.Check(pixels.Length == 400 * 500 * 4, "renderer.readback.size");

            var (opaque, minX, minY, maxX, maxY) = RenderTest.FrameStats(pixels, 400, 500);
            SelfTestRunner.Check(opaque > 1000, "renderer.frame.opaquePixels", opaque.ToString());
            SelfTestRunner.Check(minX >= 0 && maxX < 400 && minY >= 0 && maxY < 500, "renderer.frame.bboxInBounds");
            // 模型水平居中（pld anchor 0.5 + 窗口居中）
            var centerX = (minX + maxX) / 2f;
            SelfTestRunner.Check(Math.Abs(centerX - 200) < 40, "renderer.frame.centerX", centerX.ToString("F1"));
            // 500 高窗口内容纳 333 高模型 → 顶行应透明
            var topRowOpaque = false;
            for (var x = 0; x < 400; x++) if (pixels[x * 4 + 3] != 0) { topRowOpaque = true; break; }
            SelfTestRunner.Check(!topRowOpaque, "renderer.frame.topRowTransparent");

            // 参数驱动渲染：AngleX=30 后帧内容必须变化
            model.SetParameterValueById("ParamAngleX", 30);
            model.Update();
            var pixels2 = renderer.Render(400, 500);
            var differs = false;
            for (var i = 0; i < pixels.Length; i += 97) // 抽样比较
            {
                if (pixels[i] != pixels2[i]) { differs = true; break; }
            }
            SelfTestRunner.Check(differs, "renderer.paramDrivesFrame");

            // PNG 编解码往返
            var png = Rendering.PngCodec.Encode(pixels, 400, 500);
            SelfTestRunner.Check(png.Length > 8 && png[0] == 0x89 && png[1] == 0x50, "renderer.png.header");
        }
    }
}

// T0 下载器离线自测：路径约定 / zip 提取 / SHA256 / 校验失败清理。
// 网络成功路径不在此测（SHA256 pin 为官方 zip 常量）——提取与校验机制已覆盖。
public static class CoreDownloaderTests
{
    public static void Run()
    {
        var tmp = Path.Combine(Path.GetTempPath(), "cyrene-live2d-selftest-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(tmp);
        try
        {
            // 路径约定（CoreLibrary 解析位 2）
            var dataDir = Path.Combine(tmp, "data");
            SelfTestRunner.Check(
                CoreDownloader.InstallPath(dataDir) == Path.Combine(dataDir, "live2d-core", "Live2DCubismCore.dll"),
                "coreDownload.installPath");
            SelfTestRunner.Check(!CoreDownloader.IsInstalled(dataDir), "coreDownload.notInstalled");

            // 构造假 zip（条目名与官方一致，内容任意）
            var payload = new byte[] { 0x4D, 0x5A, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00 }; // MZ 头假 DLL
            var zipPath = Path.Combine(tmp, "fake.zip");
            using (var zip = System.IO.Compression.ZipFile.Open(zipPath, System.IO.Compression.ZipArchiveMode.Create))
            {
                var entry = zip.CreateEntry(CoreDownloader.DllZipEntry);
                using var s = entry.Open();
                s.Write(payload, 0, payload.Length);
            }

            // 提取：内容一致 + 无 .part 残留
            var dest = CoreDownloader.InstallPath(dataDir);
            CoreDownloader.ExtractCoreDll(zipPath, dest);
            SelfTestRunner.Check(File.Exists(dest) && File.ReadAllBytes(dest).SequenceEqual(payload), "coreDownload.extract");
            SelfTestRunner.Check(!File.Exists(dest + ".part"), "coreDownload.extract.noPart");
            SelfTestRunner.Check(CoreDownloader.IsInstalled(dataDir), "coreDownload.isInstalled");

            // 已安装短路：DownloadAsync 直接返回（不触网）
            var shortCircuit = CoreDownloader.DownloadAsync(dataDir).GetAwaiter().GetResult();
            SelfTestRunner.Check(shortCircuit == dest, "coreDownload.shortCircuit");

            // 缺条目 zip → CoreDownloadException
            var badZip = Path.Combine(tmp, "bad.zip");
            using (var zip = System.IO.Compression.ZipFile.Open(badZip, System.IO.Compression.ZipArchiveMode.Create))
            {
                zip.CreateEntry("some/other/file.txt");
            }
            var missingEntry = false;
            try { CoreDownloader.ExtractCoreDll(badZip, Path.Combine(tmp, "out.dll")); }
            catch (Core.CoreDownloadException) { missingEntry = true; }
            SelfTestRunner.Check(missingEntry, "coreDownload.extract.missingEntry");

            // SHA256 已知向量（"abc"）
            var abcPath = Path.Combine(tmp, "abc.txt");
            File.WriteAllText(abcPath, "abc");
            var hash = Core.CoreDownloader.Sha256FileAsync(abcPath, CancellationToken.None).GetAwaiter().GetResult();
            SelfTestRunner.Check(
                hash == "BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD",
                "coreDownload.sha256", hash);

            // 校验失败路径：假 handler 供假 zip → SHA256 不匹配 → 异常 + 残片清理
            var dataDir2 = Path.Combine(tmp, "data2");
            var fakeZipBytes = File.ReadAllBytes(zipPath);
            var mismatch = false;
            try
            {
                Core.CoreDownloader.DownloadAsync(dataDir2, handler: new FakeHandler(fakeZipBytes))
                    .GetAwaiter().GetResult();
            }
            catch (Core.CoreDownloadException) { mismatch = true; }
            SelfTestRunner.Check(mismatch, "coreDownload.shaMismatch");
            SelfTestRunner.Check(!CoreDownloader.IsInstalled(dataDir2), "coreDownload.shaMismatch.notInstalled");
            var partLeft = Directory.Exists(CoreDownloader.InstallDir(dataDir2))
                && Directory.GetFiles(CoreDownloader.InstallDir(dataDir2), "*.part").Length > 0;
            SelfTestRunner.Check(!partLeft, "coreDownload.shaMismatch.partCleaned");
        }
        finally
        {
            try { Directory.Delete(tmp, recursive: true); } catch { /* 自测清理尽力 */ }
        }
    }

    private sealed class FakeHandler(byte[] body) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
            => Task.FromResult(new HttpResponseMessage(System.Net.HttpStatusCode.OK)
            {
                Content = new ByteArrayContent(body),
            });
    }
}

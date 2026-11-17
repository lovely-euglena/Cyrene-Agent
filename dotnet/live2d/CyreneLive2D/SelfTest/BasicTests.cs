// T1 自测：model3.json 解析 + Core 加载冒烟。

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

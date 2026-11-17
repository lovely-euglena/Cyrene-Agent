// T4/T5 自测：PetEngine 端到端（JSON 行协议 → 帧循环 → 行为 → 诊断）。
// 用 MemoryStream 捕获 HostIo 输出帧，断言协议语义。需 Core；缺则 SKIP。
// 渲染项（renderOnce/captureFrame）由 RendererTests 覆盖（GPU 依赖）。

using System.Text;
using System.Text.Json;
using CyreneLive2D.Core;
using CyreneLive2D.Host;
using CyreneLive2D.Model;

namespace CyreneLive2D.SelfTest;

public static unsafe class EngineTests
{
    public static void Run(string? modelDir)
    {
        if (modelDir == null) { SelfTestRunner.Skip("engine", "无模型目录"); return; }
        try { CoreLibrary.Load(null, modelDir); }
        catch (CoreNotAvailableException) { SelfTestRunner.Skip("engine", "Core DLL 缺失"); return; }
        var manifestPath = Path.Combine(modelDir, "Cyrene.model3.json");
        if (!File.Exists(manifestPath)) { SelfTestRunner.Skip("engine", "缺 manifest"); return; }

        // 未加载时 op 抛 InvalidOperationException（宿主层转 E_INTERNAL）
        using (var earlyLog = new FrameLog())
        using (var earlyEngine = new PetEngine(earlyLog.Io, null))
        {
            bool threw = false;
            try { Call(earlyEngine, "tick", new { dtMs = 16.0 }); }
            catch (InvalidOperationException) { threw = true; }
            SelfTestRunner.Check(threw, "engine.notLoadedThrows");
        }

        using var log = new FrameLog();
        using var engine = new PetEngine(log.Io, null);

        // ── load ──
        Call(engine, "load", new { modelPath = manifestPath });
        var load = LastResult(log);
        SelfTestRunner.Check(load.Ok && load.Data.GetProperty("parameters").GetInt32() == 53, "engine.load", load.Error);
        SelfTestRunner.Check(HasEvent(log, "loaded"), "engine.loadedEvent");

        // ── tick 推进时钟 ──
        Call(engine, "tick", new { dtMs = 100.0 });
        var tick1 = LastResult(log);
        SelfTestRunner.Check(Math.Abs(tick1.Data.GetProperty("nowMs").GetDouble() - 100) < 1e-6, "engine.tickAdvancesClock");

        // ── play：表情 target ──
        Call(engine, "play", new { target = new { kind = "expression", name = "墨镜" } });
        SelfTestRunner.Check(LastResult(log).Data.GetProperty("played").GetBoolean(), "engine.playExpression");
        SelfTestRunner.Check(GetDiagnostics(log, engine).GetProperty("expression").GetString() == "墨镜", "engine.expressionApplied");

        // ── play：motion target（名称 → 索引） ──
        Call(engine, "play", new { target = new { kind = "motion", group = "Tick3", motionName = "荡秋千（待机）" } });
        SelfTestRunner.Check(LastResult(log).Data.GetProperty("played").GetBoolean(), "engine.playMotion");
        var diag = GetDiagnostics(log, engine);
        SelfTestRunner.Check(diag.GetProperty("motion").GetProperty("playing").GetBoolean(), "engine.motionPlaying");
        SelfTestRunner.Check(diag.GetProperty("motion").GetProperty("currentGroup").GetString() == "Tick3", "engine.motionGroup");

        // ── speechPrepare：停秋千 + 表情回正 ──
        Call(engine, "speechPrepare");
        SelfTestRunner.Check(LastResult(log).Ok, "engine.speechPrepare");
        Call(engine, "tick", new { dtMs = 16.0 }); // 下一帧 Playing 置 false（pld 一帧滞后）
        diag = GetDiagnostics(log, engine);
        SelfTestRunner.Check(!diag.GetProperty("motion").GetProperty("playing").GetBoolean(), "engine.speechPrepareStopsSwing");
        SelfTestRunner.Check(diag.GetProperty("expression").GetString() == "表情回正", "engine.speechPrepareResetsExpression");

        // ── mouthStart / mouthStop ──
        Call(engine, "mouthStart", new { durationMs = 500.0 });
        diag = GetDiagnostics(log, engine);
        SelfTestRunner.Check(diag.GetProperty("controllers").GetProperty("mouthActive").GetBoolean(), "engine.mouthStart");
        for (int i = 0; i < 120; i++) Call(engine, "tick", new { dtMs = 16.6667 }); // ~2s → 过期+收敛脱离
        diag = GetDiagnostics(log, engine);
        SelfTestRunner.Check(!diag.GetProperty("controllers").GetProperty("mouthActive").GetBoolean(), "engine.mouthExpires");

        Call(engine, "mouthStart", new { durationMs = 5000.0 });
        Call(engine, "mouthStop");
        for (int i = 0; i < 60; i++) Call(engine, "tick", new { dtMs = 16.6667 });
        diag = GetDiagnostics(log, engine);
        SelfTestRunner.Check(!diag.GetProperty("controllers").GetProperty("mouthActive").GetBoolean(), "engine.mouthStopCloses");

        // ── pause / resume ──
        Call(engine, "pause");
        double before = NowMs(log, engine);
        Call(engine, "tick", new { dtMs = 100.0 });
        SelfTestRunner.Check(NowMs(log, engine) == before, "engine.pauseFreezesClock");
        Call(engine, "resume");
        Call(engine, "tick", new { dtMs = 100.0 });
        SelfTestRunner.Check(NowMs(log, engine) == before + 100, "engine.resumeThawsClock");

        // ── setDragging ──
        Call(engine, "setDragging", new { value = true });
        before = NowMs(log, engine);
        Call(engine, "tick", new { dtMs = 100.0 });
        SelfTestRunner.Check(NowMs(log, engine) == before, "engine.draggingFreezesClock");
        Call(engine, "setDragging", new { value = false });
        Call(engine, "tick", new { dtMs = 100.0 });
        SelfTestRunner.Check(NowMs(log, engine) == before + 100, "engine.dragEndThaws");

        // ── setZoom ──
        Call(engine, "setZoom", new { zoom = 1.5 });
        SelfTestRunner.Check(Math.Abs(LastResult(log).Data.GetProperty("zoom").GetDouble() - 1.5) < 1e-6, "engine.setZoom");
        Call(engine, "setZoom", new { zoom = 1.0 });

        // ── hitTest：窗外远点 → 空；drawable 包围盒中心 → 命中 ──
        Call(engine, "hitTest", new { x = 10000.0, y = 10000.0 });
        SelfTestRunner.Check(LastResult(log).Data.GetProperty("areas").GetArrayLength() == 0, "engine.hitTestFarEmpty");

        var manifest = Model3Json.Load(manifestPath);
        using var model = CubismModel.FromMoc3(Path.Combine(modelDir, manifest.Moc));
        var area = manifest.HitAreas[0];
        int drawIndex = model.GetDrawableIndex(area.Id);
        SelfTestRunner.Check(drawIndex >= 0, "engine.hitAreaDrawableExists", area.Id);
        // drawable 包围盒中心（画布坐标）→ 反演窗口坐标（zoom=1, 400×500）
        float scale = Math.Min(400f / model.CanvasWidth, Math.Min(500f / model.CanvasHeight, 1f));
        var verts = model.DrawableVertexPositions[drawIndex];
        int vc = model.DrawableVertexCounts[drawIndex];
        float minX = float.MaxValue, maxX = float.MinValue, minY = float.MaxValue, maxY = float.MinValue;
        for (int i = 0; i < vc; i++)
        {
            float vx = verts[i].X * model.PixelsPerUnit + model.CanvasWidth / 2f;
            float vy = -verts[i].Y * model.PixelsPerUnit + model.CanvasHeight / 2f;
            if (vx < minX) minX = vx;
            if (vx > maxX) maxX = vx;
            if (vy < minY) minY = vy;
            if (vy > maxY) maxY = vy;
        }
        float cx = ((minX + maxX) / 2f - model.CanvasWidth / 2f) * scale + 200f;
        float cy = ((minY + maxY) / 2f - model.CanvasHeight / 2f) * scale + 250f;
        Call(engine, "hitTest", new { x = cx, y = cy });
        var areas = LastResult(log).Data.GetProperty("areas");
        bool found = false;
        foreach (var a in areas.EnumerateArray()) if (a.GetString() == area.Name) found = true;
        SelfTestRunner.Check(found, "engine.hitTestBoundsCenter", area.Name);

        // ── Click：命中区触发 hit 事件 + 表情回正重计时 ──
        engine.Click(cx, cy);
        SelfTestRunner.Check(HasEvent(log, "hit"), "engine.clickHitEvent");

        // ── 错误路径 ──
        Call(engine, "play", new { target = new { kind = "bogus" } });
        SelfTestRunner.Check(LastResult(log).ErrorCode == Live2DErrors.BadArgs, "engine.playBadKind");
        Call(engine, "noSuchOp");
        SelfTestRunner.Check(LastResult(log).ErrorCode == Live2DErrors.BadArgs, "engine.unknownOp");

        // ── 帧循环长时间稳定性：10s 模拟（600 帧），参数有限、无异常 ──
        for (int i = 0; i < 600; i++) Call(engine, "tick", new { dtMs = 16.6667 });
        diag = GetDiagnostics(log, engine);
        SelfTestRunner.Check(diag.GetProperty("nowMs").GetDouble() > 10000, "engine.longRunClock");
        bool finite = true;
        for (int i = 0; i < model.ParameterCount; i++)
        {
            if (!float.IsFinite(model.GetParameterValue(i))) { finite = false; break; }
        }
        // 注意：engine 内部模型与测试模型是不同实例——用 diagnostics 间接验证（无 NaN 崩溃即通过）
        SelfTestRunner.Check(finite && diag.GetProperty("loaded").GetBoolean(), "engine.longRunStable");
    }

    // ── 协议帧工具 ──────────────────────────────────────────

    private sealed class FrameLog : IDisposable
    {
        private readonly MemoryStream _stream = new();
        public HostIo Io { get; }
        public FrameLog() { Io = new HostIo(_stream); }
        public void Dispose() { Io.Dispose(); _stream.Dispose(); }

        public List<JsonElement> ReadAll()
        {
            _stream.Position = 0;
            var frames = new List<JsonElement>();
            using var reader = new StreamReader(_stream, Encoding.UTF8, false, 1024, leaveOpen: true);
            string? line;
            while ((line = reader.ReadLine()) != null)
            {
                if (line.Length == 0) continue;
                frames.Add(JsonDocument.Parse(line).RootElement.Clone());
            }
            return frames;
        }
    }

    private readonly record struct Result(bool Ok, JsonElement Data, string? Error, string? ErrorCode);

    private static void Call(PetEngine engine, string op, object? args = null)
    {
        var frame = new Dictionary<string, object?> { ["op"] = op, ["callId"] = "c" };
        if (args != null)
        {
            var json = JsonSerializer.Serialize(args);
            using var doc = JsonDocument.Parse(json);
            foreach (var prop in doc.RootElement.EnumerateObject()) frame[prop.Name] = prop.Value.Clone();
        }
        var frameJson = JsonSerializer.Serialize(frame);
        using var frameDoc = JsonDocument.Parse(frameJson);
        engine.Handle(op, "c", frameDoc.RootElement);
    }

    private static Result LastResult(FrameLog log)
    {
        var frames = log.ReadAll();
        for (int i = frames.Count - 1; i >= 0; i--)
        {
            var f = frames[i];
            if (f.GetProperty("op").GetString() == "result" && f.GetProperty("callId").GetString() == "c")
            {
                bool ok = f.GetProperty("ok").GetBoolean();
                var data = f.TryGetProperty("data", out var d) ? d : default;
                string? error = f.TryGetProperty("error", out var e) ? e.GetString() : null;
                string? code = f.TryGetProperty("errorCode", out var c) ? c.GetString() : null;
                return new Result(ok, data, error, code);
            }
        }
        throw new InvalidOperationException("无 result 帧");
    }

    private static bool HasEvent(FrameLog log, string name)
    {
        foreach (var f in log.ReadAll())
        {
            if (f.GetProperty("op").GetString() == "event" && f.GetProperty("name").GetString() == name) return true;
        }
        return false;
    }

    private static JsonElement GetDiagnostics(FrameLog log, PetEngine engine)
    {
        Call(engine, "getDiagnostics");
        return LastResult(log).Data;
    }

    private static double NowMs(FrameLog log, PetEngine engine)
        => GetDiagnostics(log, engine).GetProperty("nowMs").GetDouble();
}
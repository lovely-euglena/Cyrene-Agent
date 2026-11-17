// T3 自测：动画层（数学 / motion3 解析 / 曲线求值 / 淡入淡出 / 队列 / 优先级状态机 /
// 表情 TS 算术 / 真实模型集成）。纯逻辑项无 Core 依赖；集成项缺 Core 时 SKIP。

using System.Text.Json;
using CyreneLive2D.Core;
using CyreneLive2D.Model;
using CyreneLive2D.Motion;

namespace CyreneLive2D.SelfTest;

public static class MotionTests
{
    private static Motion3 MotionFromJson(string json)
    {
        using var doc = JsonDocument.Parse(json);
        return Motion3.Create(doc.RootElement);
    }

    private static string SingleCurveMotion(string segments, bool restricted = true)
        => $$"""
        {
          "Version": 3,
          "Meta": { "Duration": 1.0, "Fps": 30.0, "Loop": false, "AreBeziersRestricted": {{(restricted ? "true" : "false")}}, "CurveCount": 1, "TotalSegmentCount": 1, "TotalPointCount": 2 },
          "Curves": [ { "Target": "Parameter", "Id": "ParamAngleX", "Segments": {{segments}} } ]
        }
        """;

    public static void Run(string? modelDir)
    {
        // ── 数学工具 ──
        SelfTestRunner.Check(CubismMath.GetEasingSine(0) == 0, "math.easingSine.0");
        SelfTestRunner.Check(CubismMath.GetEasingSine(1) == 1, "math.easingSine.1");
        SelfTestRunner.Check(Math.Abs(CubismMath.GetEasingSine(0.5f) - 0.5f) < 1e-6, "math.easingSine.half");
        SelfTestRunner.Check(CubismMath.GetEasingSine(-1) == 0 && CubismMath.GetEasingSine(2) == 1, "math.easingSine.clamp");

        // Cardano 已知根：t³ 系数 (-0.5,0.75,0.75,-0.5) 在 t=0.5 处为 0
        var root = CubismMath.CardanoAlgorithmForBezier(-0.5f, 0.75f, 0.75f, -0.5f);
        SelfTestRunner.Check(Math.Abs(root - 0.5f) < 1e-4, "math.cardano.half", root.ToString("F6"));
        // a≈0 且 b≈0 → 线性退化：-c/b = 0.5
        var lin = CubismMath.CardanoAlgorithmForBezier(0, 0, 1, -0.5f);
        SelfTestRunner.Check(Math.Abs(lin - 0.5f) < 1e-4, "math.cardano.degenerate", lin.ToString("F6"));
        SelfTestRunner.Check(Math.Abs(CubismMath.QuadraticEquation(0, 2, -1) - 0.5f) < 1e-6, "math.quadratic.linear");
        SelfTestRunner.Check(CubismMath.ModF(4, 3) == 1 && CubismMath.ModF(-1, 3) == -1, "math.modf.sign");
        SelfTestRunner.Check(float.IsNaN(CubismMath.ModF(1, 0)), "math.modf.zero");

        // ── 曲线求值（合成 motion，无需 Core） ──
        var linear = MotionFromJson(SingleCurveMotion("[0, 0, 0, 1, 1]"));
        SelfTestRunner.Check(Math.Abs(linear.EvaluateCurve(0, 0.5f, false, 1) - 0.5f) < 1e-6, "curve.linear.mid");
        SelfTestRunner.Check(linear.EvaluateCurve(0, 0, false, 1) == 0, "curve.linear.start");
        SelfTestRunner.Check(linear.EvaluateCurve(0, 1, false, 1) == 1, "curve.linear.end");

        var stepped = MotionFromJson(SingleCurveMotion("[0, 0, 2, 1, 1]"));
        SelfTestRunner.Check(stepped.EvaluateCurve(0, 0.5f, false, 1) == 0, "curve.stepped.holds");
        SelfTestRunner.Check(stepped.EvaluateCurve(0, 1, false, 1) == 1, "curve.stepped.end");

        var inverse = MotionFromJson(SingleCurveMotion("[0, 0, 3, 1, 1]"));
        SelfTestRunner.Check(inverse.EvaluateCurve(0, 0.5f, false, 1) == 1, "curve.inverseStepped.next");

        // 对称贝塞尔 p0(0,0) p1(0.5,0) p2(0.5,1) p3(1,1)：t=0.5 → value 0.5
        var bezierSeg = "[0, 0, 1, 0.5, 0, 0.5, 1, 1, 1]";
        var bezRestricted = MotionFromJson(SingleCurveMotion(bezierSeg, restricted: true));
        SelfTestRunner.Check(Math.Abs(bezRestricted.EvaluateCurve(0, 0.5f, false, 1) - 0.5f) < 1e-5, "curve.bezier.restricted", bezRestricted.EvaluateCurve(0, 0.5f, false, 1).ToString("F6"));
        var bezCardano = MotionFromJson(SingleCurveMotion(bezierSeg, restricted: false));
        SelfTestRunner.Check(Math.Abs(bezCardano.EvaluateCurve(0, 0.5f, false, 1) - 0.5f) < 1e-4, "curve.bezier.cardano", bezCardano.EvaluateCurve(0, 0.5f, false, 1).ToString("F6"));

        // ── 淡入淡出权重 ──
        var fadeMotion = MotionFromJson("""
        { "Version":3, "Meta":{"Duration":2,"Fps":30,"Loop":false,"AreBeziersRestricted":true,"CurveCount":0,"TotalSegmentCount":0,"TotalPointCount":0}, "FadeInTime":1.0, "FadeOutTime":1.0, "Curves":[] }
        """);
        var entry = new MotionQueueEntry { StartTimeSeconds = 0, FadeInStartTimeSeconds = 0, EndTimeSeconds = -1 };
        SelfTestRunner.Check(fadeMotion.UpdateFadeWeight(entry, 0) == 0, "fade.in.t0");
        SelfTestRunner.Check(Math.Abs(fadeMotion.UpdateFadeWeight(entry, 0.5f) - 0.5f) < 1e-6, "fade.in.half");
        SelfTestRunner.Check(fadeMotion.UpdateFadeWeight(entry, 1) == 1, "fade.in.done");
        SelfTestRunner.Check(fadeMotion.HasJsonFadeIn && fadeMotion.HasJsonFadeOut, "fade.jsonFlags");

        // ── 队列：入场触发旧动作淡出 ──
        var queue = new MotionQueueManager();
        var a = MotionFromJson(SingleCurveMotion("[0, 0, 0, 1, 1]"));
        var b = MotionFromJson(SingleCurveMotion("[0, 0, 0, 1, 1]"));
        var ea = queue.StartMotion(a);
        queue.StartMotion(b);
        SelfTestRunner.Check(ea.IsTriggeredFadeOut, "queue.fadeout.triggered");
        SelfTestRunner.Check(queue.Entries.Count == 2, "queue.twoEntries");

        // ── 循环 V2：跨圈重置 startTime，永不结束（零曲线，不触碰 model） ──
        var loopMotion = MotionFromJson("""
        { "Version":3, "Meta":{"Duration":1,"Fps":30,"Loop":true,"AreBeziersRestricted":true,"CurveCount":0,"TotalSegmentCount":0,"TotalPointCount":0}, "Curves":[] }
        """);
        loopMotion.IsLoop = true;
        var lq = new MotionQueueManager();
        var le = lq.StartMotion(loopMotion);
        lq.DoUpdateMotion(null!, 0.0f); // setup（无参数曲线，model 未被使用）
        lq.DoUpdateMotion(null!, 2.0f); // 跨圈
        SelfTestRunner.Check(!le.IsFinished, "loop.notFinished");
        SelfTestRunner.Check(le.StartTimeSeconds > 0, "loop.startTimeAdvanced", le.StartTimeSeconds.ToString("F4"));

        // ── 优先级状态机 ──
        var state = new MotionState();
        SelfTestRunner.Check(!state.Reserve("g", 0, MotionPriority.None), "state.none.rejected");
        SelfTestRunner.Check(state.Reserve("g", 0, MotionPriority.Normal), "state.normal.reserve");
        SelfTestRunner.Check(!state.Reserve("g", 0, MotionPriority.Normal), "state.sameReserved.rejected");
        SelfTestRunner.Check(state.Start(a, "g", 0, MotionPriority.Normal), "state.normal.start");
        SelfTestRunner.Check(!state.Reserve("g", 1, MotionPriority.Idle), "state.idle.blockedByCurrent");
        SelfTestRunner.Check(!state.Reserve("g", 1, MotionPriority.Normal), "state.normal.blockedByEqual");
        SelfTestRunner.Check(state.Reserve("g", 1, MotionPriority.Force), "state.force.overrides");
        state.Complete();
        SelfTestRunner.Check(state.ShouldRequestIdleMotion(), "state.requestIdle.afterComplete");
        SelfTestRunner.Check(state.Reserve("idle", 0, MotionPriority.Idle), "state.idle.reserve");
        SelfTestRunner.Check(!state.ShouldRequestIdleMotion(), "state.noIdle.whenReserved");
        SelfTestRunner.Check(!state.ShouldOverrideExpression(), "state.preserveExpression.default");

        // ── 真实模型集成（缺 Core SKIP） ──
        RunIntegration(modelDir);
    }

    private static void RunIntegration(string? modelDir)
    {
        if (modelDir == null) { SelfTestRunner.Skip("motion.integration", "无模型目录"); return; }
        try { CoreLibrary.Load(null, modelDir); }
        catch (CoreNotAvailableException) { SelfTestRunner.Skip("motion.integration", "Core DLL 缺失"); return; }
        var manifestPath = Path.Combine(modelDir, "Cyrene.model3.json");
        if (!File.Exists(manifestPath)) { SelfTestRunner.Skip("motion.integration", "缺 manifest"); return; }

        var manifest = Model3Json.Load(manifestPath);
        using var model = CubismModel.FromMoc3(Path.Combine(modelDir, manifest.Moc));
        var manager = new MotionManager(manifest, modelDir);

        // 生命周期：动作#6_0（0.5s）播放 → 结束
        SelfTestRunner.Check(manager.StartMotion("动作#6", 0), "motion.start");
        SelfTestRunner.Check(manager.Playing && manager.State.CurrentGroup == "动作#6", "motion.playing");
        manager.Update(model, 0.0f);
        SelfTestRunner.Check(!manager.IsFinished(), "motion.notFinished.early");
        manager.Update(model, 3.0f); // 动作在此帧的 updateParameters 里结束并出队
        SelfTestRunner.Check(manager.IsFinished(), "motion.queueEmpty");
        manager.Update(model, 3.1f); // pld 一帧滞后：Playing=false / motionFinish 在下一帧顶部置位
        SelfTestRunner.Check(!manager.Playing, "motion.finished");

        // 参数驱动：秋千 Tick3[3] 推动 Param32
        var swing = new MotionManager(manifest, modelDir);
        float before = model.GetParameterValueById("Param32");
        SelfTestRunner.Check(swing.StartMotion("Tick3", 3), "motion.swing.start");
        swing.Update(model, 0.0f);
        swing.Update(model, 1.5f);
        float after = model.GetParameterValueById("Param32");
        SelfTestRunner.Check(Math.Abs(after - before) > 1e-4, "motion.swing.drivesParam32", $"{before:F4}→{after:F4}");
    }
}

public static class ExpressionTests
{
    public static void Run(string? modelDir)
    {
        // ── exp3 解析（真实文件，无需 Core） ──
        if (modelDir != null)
        {
            var exp0 = Path.Combine(modelDir, "expressions", "0.exp3.json");
            if (File.Exists(exp0))
            {
                var e = Expression3.Load(exp0);
                SelfTestRunner.Check(e.Parameters.Count == 4, "expr.parse.count", e.Parameters.Count.ToString());
                SelfTestRunner.Check(e.Parameters.All(p => p.Blend == ExpressionBlendType.Additive && p.Value == 0), "expr.parse.allAddZero");
                SelfTestRunner.Check(e.FadeInSeconds == 1.0f && e.FadeOutSeconds == 1.0f, "expr.parse.defaultFade");
            }
        }

        // ── TS 参数算术（需 Core） ──
        if (modelDir == null) { SelfTestRunner.Skip("expr.arithmetic", "无模型目录"); return; }
        try { CoreLibrary.Load(null, modelDir); }
        catch (CoreNotAvailableException) { SelfTestRunner.Skip("expr.arithmetic", "Core DLL 缺失"); return; }
        var manifestPath = Path.Combine(modelDir, "Cyrene.model3.json");
        if (!File.Exists(manifestPath)) { SelfTestRunner.Skip("expr.arithmetic", "缺 manifest"); return; }
        var manifest = Model3Json.Load(manifestPath);
        using var model = CubismModel.FromMoc3(Path.Combine(modelDir, manifest.Moc));

        // Add：set(current + value*weight)。current=20, value=10, w=0.5 → 25（非原生 15）
        SelfTestRunner.Check(ApplyExpr(model, ExpressionBlendType.Additive, 10, 0.5f, 20) == 25, "expr.add.tsSemantics");
        // Multiply：set(current*(1+(value-1)*weight))。20*(1+1*0.5)=30
        SelfTestRunner.Check(ApplyExpr(model, ExpressionBlendType.Multiply, 2, 0.5f, 20) == 30, "expr.multiply.tsSemantics");
        // Overwrite：blend(current,value,weight)。20*0.5+10*0.5=15
        SelfTestRunner.Check(ApplyExpr(model, ExpressionBlendType.Overwrite, 10, 0.5f, 20) == 15, "expr.overwrite.tsSemantics");

        // ── ExpressionManager 编排 ──
        var em = new ExpressionManager(manifest, modelDir);
        SelfTestRunner.Check(em.DefinitionCount == 12, "exprMgr.count", em.DefinitionCount.ToString());
        SelfTestRunner.Check(em.SetExpression(1), "exprMgr.set");
        SelfTestRunner.Check(!em.SetExpression(1), "exprMgr.sameRejected");
        SelfTestRunner.Check(!em.IsFinished(), "exprMgr.fading");
        em.Update(model, 0.0f);
        em.Update(model, 2.0f); // 超过 1s 淡入 → 权重到 1
        // 表情是持久状态（GetDuration=-1，不"结束"）：淡入完成后持续生效
        SelfTestRunner.Check(!em.IsFinished(), "exprMgr.persistent");
        em.ResetExpression();
        SelfTestRunner.Check(!em.IsFinished(), "exprMgr.resetFading");
    }

    /// <summary>用单个参数表情驱动 ParamAngleX，返回写入后的值（验证 TS 算术）。</summary>
    private static float ApplyExpr(CubismModel model, ExpressionBlendType blend, float value, float weight, float initial)
    {
        model.SetParameterValueById("ParamAngleX", initial);
        var expr = Expression3.CreateEmpty();
        expr.SetFadeInTime(0);
        expr.SetFadeOutTime(0);
        expr.Weight = weight;
        expr.Parameters.Add(new ExpressionParameter { Id = "ParamAngleX", Blend = blend, Value = value });
        var queue = new MotionQueueManager();
        queue.StartMotion(expr);
        queue.DoUpdateMotion(model, 0.0f);
        return model.GetParameterValueById("ParamAngleX");
    }
}
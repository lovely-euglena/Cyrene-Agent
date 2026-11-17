// T4 自测：行为控制器（注视/眨眼/口型/秋千/表情回正/空闲帧率/交互/点击穿透）。
// 状态机与数学项无 Core 依赖；参数写入项缺 Core 时 SKIP。
// 时间全部显式注入，RNG 注入固定值 → 确定性断言。

using CyreneLive2D.Behavior;
using CyreneLive2D.Core;
using CyreneLive2D.Model;
using CyreneLive2D.Motion;

namespace CyreneLive2D.SelfTest;

public static class BehaviorTests
{
    public static void Run(string? modelDir)
    {
        FocusTests();
        IdleFpsTests();
        ClickThroughTests();
        RunWithModel(modelDir);
    }

    // ── 纯逻辑（无 Core） ───────────────────────────────────

    private static void FocusTests()
    {
        var f = new FocusController();
        f.Focus(5, -5);
        SelfTestRunner.Check(f.TargetX == 1 && f.TargetY == -1, "focus.clamp");
        f.Focus(0.3f, 0.4f, instant: true);
        SelfTestRunner.Check(f.X == 0.3f && f.Y == 0.4f, "focus.instant");

        // 收敛：从 (0,0) 追踪 (1,0)，5s 足够
        var f2 = new FocusController();
        f2.Focus(1, 0);
        for (int i = 0; i < 300; i++) f2.Update(16.67f);
        SelfTestRunner.Check(Math.Abs(f2.X - 1) < 0.01 && Math.Abs(f2.Y) < 0.01, "focus.converges", $"{f2.X:F4},{f2.Y:F4}");

        // EPSILON 死区
        var f3 = new FocusController();
        f3.Focus(0.005f, 0.005f);
        f3.Update(16.67f);
        SelfTestRunner.Check(f3.X == 0 && f3.Y == 0, "focus.epsilonDeadZone");

        // 单步：加速度限幅 → 位移有限且为正
        var f4 = new FocusController();
        f4.Focus(1, 0);
        f4.Update(16.67f);
        SelfTestRunner.Check(f4.X > 0 && f4.X < 0.1 && f4.Vx > 0, "focus.accelLimited", f4.X.ToString("F6"));

        // 坐标映射（pld atan2 单位圆怪癖）：baseScale=400/4200
        float s = 400f / 4200f;
        var (cx, cy) = FocusBehavior.MapWindowPoint(200, 250, 400, 500, 4200, 3500, s);
        SelfTestRunner.Check(Math.Abs(cx - 1) < 1e-5 && Math.Abs(cy) < 1e-5, "focusMap.centerQuirk", $"{cx:F4},{cy:F4}");
        var (tx, ty) = FocusBehavior.MapWindowPoint(200, 0, 400, 500, 4200, 3500, s);
        SelfTestRunner.Check(Math.Abs(tx) < 1e-5 && Math.Abs(ty - 1) < 1e-5, "focusMap.topLooksUp", $"{tx:F4},{ty:F4}");
        var (bx, by) = FocusBehavior.MapWindowPoint(200, 500, 400, 500, 4200, 3500, s);
        SelfTestRunner.Check(Math.Abs(bx) < 1e-5 && Math.Abs(by + 1) < 1e-5, "focusMap.bottomLooksDown", $"{bx:F4},{by:F4}");
        var (rx, ry) = FocusBehavior.MapWindowPoint(400, 250, 400, 500, 4200, 3500, s);
        SelfTestRunner.Check(Math.Abs(rx - 1) < 1e-5 && Math.Abs(ry) < 1e-5, "focusMap.rightEdge", $"{rx:F4},{ry:F4}");
    }

    private static void IdleFpsTests()
    {
        var g = new IdleFpsGovernor(0);
        SelfTestRunner.Check(g.CurrentFps == 60, "idleFps.initial60");
        g.Update(5000);
        SelfTestRunner.Check(g.CurrentFps == 60, "idleFps.still60");
        g.Update(65000);
        SelfTestRunner.Check(g.CurrentFps == 24, "idleFps.tier24", g.CurrentFps.ToString());
        g.Update(305000);
        SelfTestRunner.Check(g.CurrentFps == 12, "idleFps.tier12", g.CurrentFps.ToString());
        g.MarkActivity(310000);
        SelfTestRunner.Check(g.CurrentFps == 60, "idleFps.activityRestores");
        g.Update(315000);
        SelfTestRunner.Check(g.CurrentFps == 60, "idleFps.activityResetsTimer");
        // 看门狗间隔：不足 5s 不评估
        var g2 = new IdleFpsGovernor(0);
        g2.Update(64000); // 首次评估（>=5s）→ 24
        SelfTestRunner.Check(g2.CurrentFps == 24, "idleFps.watchFirstEval");
    }

    private static void ClickThroughTests()
    {
        // 2×2 顶向下 RGBA：alpha = [0, 9, 10, 255]
        var pixels = new byte[]
        {
            0, 0, 0, 0,   0, 0, 0, 9,
            0, 0, 0, 10,  0, 0, 0, 255,
        };
        SelfTestRunner.Check(!ClickThrough.HitTestAlpha(pixels, 2, 2, 0, 0), "clickThrough.alpha0");
        SelfTestRunner.Check(!ClickThrough.HitTestAlpha(pixels, 2, 2, 1, 0), "clickThrough.alpha9BelowThreshold");
        SelfTestRunner.Check(ClickThrough.HitTestAlpha(pixels, 2, 2, 0, 1), "clickThrough.alpha10AtThreshold");
        SelfTestRunner.Check(ClickThrough.HitTestAlpha(pixels, 2, 2, 1, 1), "clickThrough.alpha255");
        SelfTestRunner.Check(!ClickThrough.HitTestAlpha(pixels, 2, 2, 2, 0), "clickThrough.outOfBounds");
        SelfTestRunner.Check(!ClickThrough.HitTestAlpha(pixels, 2, 2, -1, 0), "clickThrough.negative");

        var state = new ClickThroughState();
        SelfTestRunner.Check(state.Update(true) == true, "clickThroughState.firstChange");
        SelfTestRunner.Check(state.Update(true) == null, "clickThroughState.idempotent");
        SelfTestRunner.Check(state.Update(false) == false, "clickThroughState.flip");
        state.Reset();
        SelfTestRunner.Check(state.Update(false) == false, "clickThroughState.resetForcesNotify");
    }

    // ── 需 Core 的集成项 ────────────────────────────────────

    private static void RunWithModel(string? modelDir)
    {
        if (modelDir == null) { SelfTestRunner.Skip("behavior.integration", "无模型目录"); return; }
        try { CoreLibrary.Load(null, modelDir); }
        catch (CoreNotAvailableException) { SelfTestRunner.Skip("behavior.integration", "Core DLL 缺失"); return; }
        var manifestPath = Path.Combine(modelDir, "Cyrene.model3.json");
        if (!File.Exists(manifestPath)) { SelfTestRunner.Skip("behavior.integration", "缺 manifest"); return; }

        var manifest = Model3Json.Load(manifestPath);
        using var model = CubismModel.FromMoc3(Path.Combine(modelDir, manifest.Moc));

        BlinkTests(model);
        MouthSyncTests(model);
        ApplyFocusTests(model);
        SpeakingMotionTests(model, manifest, modelDir);
        ExpressionResetTests(manifest, modelDir);
        InteractionTests(model, manifest, modelDir);
    }

    private static void BlinkTests(CubismModel model)
    {
        // random=0.5 → 间隔恒 4250ms
        var blink = new BlinkController(model, 0, () => 0.5);
        blink.Tick(1000);
        SelfTestRunner.Check(model.GetParameterValueById("ParamEyeLOpen") == 1, "blink.idleEyesOpen");

        blink.Tick(4250); // 眨眼起点 elapsed=0 → open=1
        SelfTestRunner.Check(model.GetParameterValueById("ParamEyeLOpen") == 1, "blink.startOpen");
        blink.Tick(4285); // elapsed=35 → open=0.5 → smoothstep=0.5
        SelfTestRunner.Check(Math.Abs(model.GetParameterValueById("ParamEyeLOpen") - 0.5f) < 1e-5, "blink.halfClosed", model.GetParameterValueById("ParamEyeLOpen").ToString("F4"));
        blink.Tick(4320); // elapsed=70 → open=0
        SelfTestRunner.Check(model.GetParameterValueById("ParamEyeROpen") == 0, "blink.fullyClosed");
        blink.Tick(4390); // elapsed=140 → open=0.5
        SelfTestRunner.Check(Math.Abs(model.GetParameterValueById("ParamEyeLOpen") - 0.5f) < 1e-5, "blink.halfOpen");
        blink.Tick(4460); // elapsed=210 → 结束
        SelfTestRunner.Check(model.GetParameterValueById("ParamEyeLOpen") == 1, "blink.finishedOpen");
        blink.Tick(5000); // 下一轮 8710 之前
        SelfTestRunner.Check(model.GetParameterValueById("ParamEyeLOpen") == 1, "blink.nextInterval");
    }

    private static void MouthSyncTests(CubismModel model)
    {
        // random=0 → 开目标 0.85，合目标 0.15
        var mouth = new MouthSyncController(model, () => 0);
        SelfTestRunner.Check(!mouth.IsActive, "mouth.initiallyInactive");

        mouth.Start(1000, 0);
        SelfTestRunner.Check(mouth.IsActive && !mouth.IsClosing, "mouth.startActive");
        mouth.Tick(0); // dt=0 → alpha=0
        SelfTestRunner.Check(model.GetParameterValueById("ParamMouthOpenY") == 0, "mouth.dtZero");

        mouth.Tick(70); // alpha=1-e^-1
        double expect1 = 0.85 * (1 - Math.Exp(-1));
        SelfTestRunner.Check(Math.Abs(model.GetParameterValueById("ParamMouthOpenY") - expect1) < 1e-4, "mouth.smoothOpen", $"{model.GetParameterValueById("ParamMouthOpenY"):F4} vs {expect1:F4}");

        mouth.Tick(180); // 翻转→合目标 0.15；dt=110 钳 100
        double alpha2 = 1 - Math.Exp(-100.0 / 70);
        double expect2 = expect1 + (0.15 - expect1) * alpha2;
        SelfTestRunner.Check(Math.Abs(model.GetParameterValueById("ParamMouthOpenY") - expect2) < 1e-4, "mouth.toggleAndClamp", $"{model.GetParameterValueById("ParamMouthOpenY"):F4} vs {expect2:F4}");

        mouth.Stop(200);
        SelfTestRunner.Check(mouth.IsClosing && mouth.IsActive, "mouth.stopClosing");
        mouth.Tick(270);
        mouth.Tick(340);
        mouth.Tick(410); // 收敛到 <0.02 → 脱离
        SelfTestRunner.Check(!mouth.IsActive && model.GetParameterValueById("ParamMouthOpenY") == 0, "mouth.closedDetach");

        // start(0) → 立即 closing（current 已 0 → 直接写 0 不附着）
        mouth.Start(0, 500);
        SelfTestRunner.Check(!mouth.IsActive && mouth.IsClosing, "mouth.zeroDuration");

        // 时长上限 5min
        mouth.Start(1e9, 600);
        SelfTestRunner.Check(mouth.IsActive, "mouth.clampedDurationActive");
        mouth.Stop(600);
        mouth.Tick(700); mouth.Tick(800); mouth.Tick(900); mouth.Tick(1000);
        SelfTestRunner.Check(!mouth.IsActive, "mouth.cleanup");
    }

    private static void ApplyFocusTests(CubismModel model)
    {
        var f = new FocusController();
        f.Focus(0.5f, -0.5f, instant: true);
        float angleXBefore = model.GetParameterValueById("ParamAngleX");
        float eyeBallXBefore = model.GetParameterValueById("ParamEyeBallX");
        FocusBehavior.ApplyFocus(model, f);
        SelfTestRunner.Check(Math.Abs(model.GetParameterValueById("ParamAngleX") - (angleXBefore + 15)) < 1e-4, "focus.apply.angleX");
        SelfTestRunner.Check(Math.Abs(model.GetParameterValueById("ParamEyeBallX") - (eyeBallXBefore + 0.5f)) < 1e-4, "focus.apply.eyeBallX");
        // AngleZ = x*y*-30 = 0.5*-0.5*-30 = +7.5
        float angleZBefore = model.GetParameterValueById("ParamAngleZ");
        FocusBehavior.ApplyFocus(model, f);
        SelfTestRunner.Check(Math.Abs(model.GetParameterValueById("ParamAngleZ") - (angleZBefore + 7.5f)) < 1e-4, "focus.apply.angleZCross");
    }

    private static void SpeakingMotionTests(CubismModel model, Model3Json manifest, string modelDir)
    {
        var motions = new MotionManager(manifest, modelDir);
        var swing = new SpeakingMotionController(model, motions);

        swing.Start(0);
        SelfTestRunner.Check(motions.State.CurrentGroup == "Tick3" && motions.State.CurrentIndex == 3, "swing.startIdlePriority");
        motions.Update(model, 0);
        motions.Update(model, 1.5f);
        float param32 = model.GetParameterValueById("Param32");
        SelfTestRunner.Check(Math.Abs(param32) > 1e-4, "swing.drivesParam32", param32.ToString("F4"));

        swing.Stop(1500);
        SelfTestRunner.Check(motions.State.CurrentGroup == null, "swing.stopClearsState");
        SelfTestRunner.Check(swing.IsRestoring, "swing.restoreAttached");

        swing.Tick(1500); // t=0 → fade=1 → 保持
        SelfTestRunner.Check(Math.Abs(model.GetParameterValueById("Param32") - param32) < 1e-4, "swing.restoreHoldsAtStart");
        swing.Tick(1675); // t=0.5 → easeOutCubic=0.875 → fade=0.125
        SelfTestRunner.Check(Math.Abs(model.GetParameterValueById("Param32") - param32 * 0.125f) < 1e-3, "swing.restoreEaseOutCubic", model.GetParameterValueById("Param32").ToString("F4"));
        swing.Tick(2000); // t>=1 → fade=0
        SelfTestRunner.Check(model.GetParameterValueById("Param32") == 0, "swing.restoreNeutral");
        SelfTestRunner.Check(model.GetParameterValueById("Param13") == 0 && model.GetParameterValueById("Param14") == 0, "swing.restoreAllParams");
        SelfTestRunner.Check(swing.IsRestoring, "swing.restoreStaysAttached");

        // 全中立 → 不挂恢复钩子
        var motions2 = new MotionManager(manifest, modelDir);
        var swing2 = new SpeakingMotionController(model, motions2);
        swing2.Stop(3000);
        SelfTestRunner.Check(!swing2.IsRestoring, "swing.neutralSkipsRestore");
    }

    private static void ExpressionResetTests(Model3Json manifest, string modelDir)
    {
        var em = new ExpressionManager(manifest, modelDir);
        var ctrl = new ExpressionResetController(em, 0);

        ctrl.Tick(179999);
        SelfTestRunner.Check(ReferenceEquals(em.CurrentExpression, em.DefaultExpression), "exprReset.notBeforeInterval");
        ctrl.Tick(180000);
        SelfTestRunner.Check(!ReferenceEquals(em.CurrentExpression, em.DefaultExpression), "exprReset.firesAtInterval");
        var resetExpr = em.CurrentExpression;

        SelfTestRunner.Check(em.SetExpression("墨镜"), "exprReset.setupSunglasses");
        ctrl.Restart(200000);
        ctrl.Tick(379999);
        SelfTestRunner.Check(!ReferenceEquals(em.CurrentExpression, resetExpr), "exprReset.restartDelays");
        ctrl.Tick(380000);
        SelfTestRunner.Check(ReferenceEquals(em.CurrentExpression, resetExpr), "exprReset.firesAfterRestart");
    }

    private static void InteractionTests(CubismModel model, Model3Json manifest, string modelDir)
    {
        var defs = InteractionController.BuildHitAreaDefs(manifest);
        SelfTestRunner.Check(defs.Length == 9, "interaction.defsCount", defs.Length.ToString());
        SelfTestRunner.Check(defs.All(d => d.Group.Length > 0 && d.MotionName.Length > 0), "interaction.defsParsed");
        SelfTestRunner.Check(defs.Any(d => d.MotionIndex >= 0), "interaction.someRealMotions");

        var motions = new MotionManager(manifest, modelDir);
        var em = new ExpressionManager(manifest, modelDir);
        var interaction = new InteractionController(motions, em, defs);

        int triggers = 0, misses = 0;
        interaction.Trigger += _ => triggers++;
        interaction.Miss += _ => misses++;

        // Cyrene 的命中区全是表达式伪动作 → 走表情回退路径
        var exprDef = defs.FirstOrDefault(d => d.ExpressionName != null);
        if (exprDef != null)
        {
            interaction.RegisterDown(100, 100, new[] { exprDef.Name });
            interaction.RegisterUp(103, 104); // 位移 5px = 阈值
            SelfTestRunner.Check(triggers == 1, "interaction.exprFallbackFires", $"triggers={triggers}");
            SelfTestRunner.Check(!ReferenceEquals(em.CurrentExpression, em.DefaultExpression), "interaction.exprApplied");

            // 位移 10px > 5 → 不触发
            interaction.RegisterDown(100, 100, new[] { exprDef.Name });
            interaction.RegisterUp(106, 108);
            SelfTestRunner.Check(triggers == 1, "interaction.dragIgnored");

            // 触屏阈值 ×4 → 10px 触发（先切走当前表情——pld 重复 set 同名表情返回 false）
            SelfTestRunner.Check(em.SetExpression("表情回正"), "interaction.touchSetup");
            interaction.RegisterDown(100, 100, new[] { exprDef.Name });
            interaction.RegisterUp(106, 108, isTouch: true);
            SelfTestRunner.Check(triggers == 2, "interaction.touchThreshold");
        }
        else
        {
            SelfTestRunner.Skip("interaction.exprFallback", "无表达式命中区");
        }

        // 未知命中名 → 无事件
        interaction.RegisterDown(0, 0, new[] { "不存在的区域" });
        interaction.RegisterUp(0, 0);
        SelfTestRunner.Check(misses == 0, "interaction.unknownNameIgnored");

        // Miss 路径：动作与表情都无法解析（合成定义）
        var fakeDef = new ResolvedHitArea { Name = "fake", Id = "ArtMesh0", Group = "NoSuchGroup", MotionName = "NoSuchExpr", MotionIndex = -1 };
        var fakeInteraction = new InteractionController(motions, em, new[] { fakeDef });
        int fakeMisses = 0;
        fakeInteraction.Miss += _ => fakeMisses++;
        fakeInteraction.RegisterDown(0, 0, new[] { "fake" });
        fakeInteraction.RegisterUp(0, 0);
        SelfTestRunner.Check(fakeMisses == 1, "interaction.missFires");

        // 真实动作路径（Cyrene 命中区无真实动作 → 条件 SKIP）
        var playable = defs.FirstOrDefault(d => d.MotionIndex >= 0
            && motions.Definitions.TryGetValue(d.Group, out var list)
            && d.MotionIndex < list.Length && list[d.MotionIndex].File != null);
        if (playable == null) { SelfTestRunner.Skip("interaction.motionFire", "命中区无真实动作（本模型全为表达式伪动作）"); return; }

        motions.StopAllMotions();
        interaction.RegisterDown(100, 100, new[] { playable.Name });
        interaction.RegisterUp(100, 100);
        SelfTestRunner.Check(motions.Playing, "interaction.motionFire");
    }
}
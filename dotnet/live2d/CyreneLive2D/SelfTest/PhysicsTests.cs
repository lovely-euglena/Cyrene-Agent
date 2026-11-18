// T3 自测：物理 / 姿态 / 呼吸。
// 纯逻辑项（归一化/粒子更新怪癖/解析/pose 结构/breath 参数表）无 Core 依赖；
// 演算集成项缺 Core 时 SKIP。怪癖测试钉死与 web 轨逐式对齐的关键行为。

using System.Numerics;
using System.Text.Json;
using CyreneLive2D.Core;
using CyreneLive2D.Model;
using CyreneLive2D.Motion;

namespace CyreneLive2D.SelfTest;

public static class PhysicsTests
{
    public static void Run(string? modelDir)
    {
        // ── 向量数学 ──
        var halfPi = CubismMath.DirectionToRadian(new Vector2(1, 0), new Vector2(0, 1));
        SelfTestRunner.Check(Math.Abs(halfPi - MathF.PI / 2) < 1e-6, "physicsMath.directionToRadian.quarter", halfPi.ToString("F6"));
        var down = CubismMath.DirectionToRadian(new Vector2(0, 1), new Vector2(0, -1));
        SelfTestRunner.Check(Math.Abs(down - -MathF.PI) < 1e-5 || Math.Abs(down - MathF.PI) < 1e-5, "physicsMath.directionToRadian.wrap", down.ToString("F6"));
        var dir = CubismMath.RadianToDirection(MathF.PI / 2);
        SelfTestRunner.Check(Math.Abs(dir.X - 1) < 1e-6 && Math.Abs(dir.Y) < 1e-6, "physicsMath.radianToDirection.sinCos", $"{dir.X:F4},{dir.Y:F4}");

        // ── 归一化（怪癖 3：isInverted=false 反而取反） ──
        float n1 = Physics3.NormalizeParameterValue(10, -30, 30, 0, -10, 10, 0, true);
        SelfTestRunner.Check(Math.Abs(n1 - 10f / 3f) < 1e-5, "physicsNorm.inverted.keepsSign", n1.ToString("F6"));
        float n2 = Physics3.NormalizeParameterValue(10, -30, 30, 0, -10, 10, 0, false);
        SelfTestRunner.Check(Math.Abs(n2 + 10f / 3f) < 1e-5, "physicsNorm.notInverted.flipsSign", n2.ToString("F6"));
        float n3 = Physics3.NormalizeParameterValue(100, -30, 30, 0, -10, 10, 0, true);
        SelfTestRunner.Check(Math.Abs(n3 - 10) < 1e-5, "physicsNorm.clampToMax", n3.ToString("F6"));
        float n4 = Physics3.NormalizeParameterValue(0, -30, 30, 0, -10, 10, 0, false);
        SelfTestRunner.Check(n4 == 0, "physicsNorm.middleZero");
        // 非对称区间：中点=(min+max)/2=10，与 parameterDefault 无关
        float n5 = Physics3.NormalizeParameterValue(30, -10, 30, 0, -10, 10, 0, false);
        SelfTestRunner.Check(Math.Abs(n5 + 10) < 1e-5, "physicsNorm.asymmetric.upper", n5.ToString("F6"));
        float n6 = Physics3.NormalizeParameterValue(-10, -10, 30, 0, -10, 10, 0, false);
        SelfTestRunner.Check(Math.Abs(n6 - 10) < 1e-5, "physicsNorm.asymmetric.lower", n6.ToString("F6"));

        // ── UpdateParticles 旋转怪癖 1：direction.Y 用新 X ──
        var strand = new[]
        {
            new PhysicsParticle { Radius = 0, Delay = 0, Mobility = 1, Acceleration = 1 },
            new PhysicsParticle
            {
                Radius = 1, Delay = 0, Mobility = 1, Acceleration = 1,
                Position = new Vector2(1, 0), LastGravity = new Vector2(1, 0),
            },
        };
        Physics3.UpdateParticles(strand, 0, 2, Vector2.Zero, 0, Vector2.Zero, 0.01f, 1f / 60f, 5f);
        // r=(π/2)/5；X=cos r=0.951057，Y=sin r*X=0.293893（标准旋转应为 0.309017）
        // 归一化×Radius=1 后 ≈ (0.955423, 0.295243)
        SelfTestRunner.Check(Math.Abs(strand[1].Position.X - 0.955423f) < 1e-4, "physicsParticles.quirk.x", strand[1].Position.X.ToString("F6"));
        SelfTestRunner.Check(Math.Abs(strand[1].Position.Y - 0.295243f) < 1e-4, "physicsParticles.quirk.yNewX", strand[1].Position.Y.ToString("F6"));
        SelfTestRunner.Check(Math.Abs(strand[1].Position.Y - 0.309017f) > 0.01, "physicsParticles.quirk.notStandardRotation");
        SelfTestRunner.Check(strand[1].LastGravity == new Vector2(0, 1), "physicsParticles.lastGravityUpdated");
        SelfTestRunner.Check(strand[1].Force == Vector2.Zero, "physicsParticles.forceCleared");

        // ── 阈值吸附：|X| < MovementThreshold*NormMax → 0 ──
        var strand2 = new[]
        {
            new PhysicsParticle(),
            new PhysicsParticle
            {
                Radius = 5, Delay = 0, Mobility = 1, Acceleration = 1,
                Position = new Vector2(0.0005f, 5), LastGravity = new Vector2(0, 1),
            },
        };
        Physics3.UpdateParticles(strand2, 0, 2, Vector2.Zero, 0, Vector2.Zero, 0.01f, 1f / 60f, 5f);
        SelfTestRunner.Check(strand2[1].Position.X == 0, "physicsParticles.thresholdSnapX", strand2[1].Position.X.ToString("F8"));

        // ── 真实 physics3.json 解析（无需 Core） ──
        ParseTests(modelDir);

        // ── 演算集成（需 Core） ──
        RunIntegration(modelDir);
    }

    private static void ParseTests(string? modelDir)
    {
        if (modelDir == null) { SelfTestRunner.Skip("physics.parse", "无模型目录"); return; }
        var path = Path.Combine(modelDir, "model.physics3.json");
        if (!File.Exists(path)) { SelfTestRunner.Skip("physics.parse", "缺 model.physics3.json"); return; }

        var physics = Physics3.Load(path);
        var rig = physics.Rig;
        SelfTestRunner.Check(rig.Settings.Length == 7, "physics.parse.subRigs", rig.Settings.Length.ToString());
        SelfTestRunner.Check(rig.Fps == 60, "physics.parse.fps", rig.Fps.ToString());
        SelfTestRunner.Check(rig.Inputs.Length == 11, "physics.parse.inputs", rig.Inputs.Length.ToString());
        SelfTestRunner.Check(rig.Outputs.Length == 14, "physics.parse.outputs", rig.Outputs.Length.ToString());
        SelfTestRunner.Check(rig.Particles.Length == 19, "physics.parse.particles", rig.Particles.Length.ToString());
        // 怪癖 5：Create 后 rig.Gravity.Y=0（残留）；有效重力在 Options
        SelfTestRunner.Check(rig.Gravity == Vector2.Zero, "physics.parse.rigGravityZeroed");
        SelfTestRunner.Check(physics.Options.Gravity == new Vector2(0, -1), "physics.parse.optionsGravity");

        var s0 = rig.Settings[0];
        SelfTestRunner.Check(s0.InputCount == 1 && s0.OutputCount == 1 && s0.ParticleCount == 2, "physics.parse.subRig0.counts");
        var in0 = rig.Inputs[s0.BaseInputIndex];
        SelfTestRunner.Check(in0.SourceId == "Param32" && in0.Type == PhysicsSourceType.X && in0.Reflect && in0.Weight == 100, "physics.parse.subRig0.input");
        var out0 = rig.Outputs[s0.BaseOutputIndex];
        SelfTestRunner.Check(out0.DestinationId == "Param31" && out0.Type == PhysicsSourceType.Angle && out0.AngleScale == 80 && out0.VertexIndex == 1, "physics.parse.subRig0.output");
        // 怪癖 4：TranslationScale 恒 0
        SelfTestRunner.Check(out0.TranslationScale == Vector2.Zero, "physics.parse.translationScaleZero");
        SelfTestRunner.Check(s0.NormalizationPosition.Minimum == -10 && s0.NormalizationPosition.Maximum == 10, "physics.parse.normPosition");
        SelfTestRunner.Check(rig.Settings[4].NormalizationAngle.Minimum == -20 && rig.Settings[4].NormalizationAngle.Maximum == 20, "physics.parse.normAngle.asymmetric");

        // 初始摆链：沿 +Y 按 Radius 串联；LastGravity=(0,1)
        int b0 = s0.BaseParticleIndex;
        SelfTestRunner.Check(rig.Particles[b0 + 1].Position == new Vector2(0, 20), "physics.parse.initialChain");
        SelfTestRunner.Check(rig.Particles[b0 + 1].LastGravity == new Vector2(0, 1), "physics.parse.initialLastGravity");
        int b1 = rig.Settings[1].BaseParticleIndex;
        SelfTestRunner.Check(rig.Particles[b1 + 2].Position == new Vector2(0, 60), "physics.parse.initialChain.subRig1");
    }

    private static void RunIntegration(string? modelDir)
    {
        if (modelDir == null) { SelfTestRunner.Skip("physics.integration", "无模型目录"); return; }
        try { CoreLibrary.Load(null, modelDir); }
        catch (CoreNotAvailableException) { SelfTestRunner.Skip("physics.integration", "Core DLL 缺失"); return; }
        var manifestPath = Path.Combine(modelDir, "Cyrene.model3.json");
        var physicsPath = Path.Combine(modelDir, "model.physics3.json");
        if (!File.Exists(manifestPath) || !File.Exists(physicsPath))
        {
            SelfTestRunner.Skip("physics.integration", "缺 manifest/physics");
            return;
        }

        var manifest = Model3Json.Load(manifestPath);
        using var model = CubismModel.FromMoc3(Path.Combine(modelDir, manifest.Moc));

        // 驱动 Param32 → 秋千物理 → Param31 变化，且传播到 Param19（子摆锤 2）
        var physics = Physics3.Load(physicsPath);
        float p31Before = model.GetParameterValueById("Param31");
        float p19Before = model.GetParameterValueById("Param19");
        model.SetParameterValueById("Param32", 10);
        physics.Evaluate(model, 1.0f); // 60 个固定步
        float p31After = model.GetParameterValueById("Param31");
        float p19After = model.GetParameterValueById("Param19");
        SelfTestRunner.Check(Math.Abs(p31After - p31Before) > 0.01, "physics.eval.drivesParam31", $"{p31Before:F4}→{p31After:F4}");
        SelfTestRunner.Check(Math.Abs(p19After - p19Before) > 1e-4, "physics.eval.propagatesToParam19", $"{p19Before:F4}→{p19After:F4}");
        int idx31 = model.GetParameterIndex("Param31");
        SelfTestRunner.Check(p31After >= model.ParameterMinimums[idx31] && p31After <= model.ParameterMaximums[idx31], "physics.eval.outputClamped");

        bool allFinite = true;
        for (int i = 0; i < model.ParameterCount; i++)
        {
            if (!float.IsFinite(model.GetParameterValue(i))) { allFinite = false; break; }
        }
        SelfTestRunner.Check(allFinite, "physics.eval.allParamsFinite");

        // 固定步长 + 剩余时间：dt < 1/60 不推进摆锤。新实例输出索引尚未解析（-1），
        // Interpolate 跳过——Param31 保持原值（与原生/TS 惰性解析一致）。
        var physics2 = Physics3.Load(physicsPath);
        float p31Prev = model.GetParameterValueById("Param31");
        physics2.Evaluate(model, 0.001f);
        SelfTestRunner.Check(model.GetParameterValueById("Param31") == p31Prev, "physics.subStep.lazyIndexNoWrite", model.GetParameterValueById("Param31").ToString("F6"));
        SelfTestRunner.Check(Math.Abs(physics2.CurrentRemainTime - 0.001f) < 1e-6, "physics.subStep.remainTime", physics2.CurrentRemainTime.ToString("F6"));
        physics2.Evaluate(model, 1f / 60f);
        SelfTestRunner.Check(Math.Abs(physics2.CurrentRemainTime - 0.001f) < 1e-5, "physics.step.remainCarried", physics2.CurrentRemainTime.ToString("F6"));

        // MaxDeltaTime：dt>5s → 剩余时间清零（防挂起爆炸），不推进
        var physics3 = Physics3.Load(physicsPath);
        physics3.Evaluate(model, 10f);
        SelfTestRunner.Check(physics3.CurrentRemainTime == 0, "physics.maxDeltaTime.reset");

        // Stabilization：确定性的稳态，重复调用幂等（pld 不用，仅验证移植正确）。
        // 驱动 ParamBreath=1（子摆锤 4 的 Angle 输入）——纯 X 平移输入的稳态角度为 0
        // （摆锤垂直悬挂），Angle 输入旋转重力方向才能产生非零稳态输出 Param25。
        var physics4 = Physics3.Load(physicsPath);
        model.SetParameterValueById("ParamBreath", 1);
        physics4.Stabilization(model);
        float stable1 = model.GetParameterValueById("Param25");
        physics4.Stabilization(model);
        float stable2 = model.GetParameterValueById("Param25");
        SelfTestRunner.Check(Math.Abs(stable1) > 0.01, "physics.stabilization.nonZero", stable1.ToString("F4"));
        SelfTestRunner.Check(Math.Abs(stable1 - stable2) < 1e-5, "physics.stabilization.idempotent");

        // Reset：摆链回到初始位置
        physics.Reset();
        SelfTestRunner.Check(physics.Rig.Particles[1].Position == new Vector2(0, 20), "physics.reset.initialPositions");
    }
}

public static unsafe class PoseTests
{
    public static void Run(string? modelDir)
    {
        // ── 结构解析（合成 JSON，无需 Core） ──
        using (var doc = JsonDocument.Parse("""
        { "FadeInTime": 0.5, "Groups": [ [ {"Id":"PartA","Link":["PartALink"]}, {"Id":"PartB"} ], [ {"Id":"PartC"} ] ] }
        """))
        {
            var pose = Pose3.Create(doc.RootElement);
            SelfTestRunner.Check(pose.GroupCount == 2, "pose.parse.groups", pose.GroupCount.ToString());
            SelfTestRunner.Check(pose.FadeTimeSeconds == 0.5f, "pose.parse.fadeTime");
        }
        using (var doc = JsonDocument.Parse("""{ "FadeInTime": -1, "Groups": [] }"""))
        {
            var pose = Pose3.Create(doc.RootElement);
            SelfTestRunner.Check(pose.FadeTimeSeconds == 0.5f, "pose.parse.negativeFadeDefault");
        }

        // ── 淡入淡出纯数学（双直线 + 背景阈值，无需 Core） ──
        SelfTestRunner.Check(Math.Abs(Pose3.ComputeHiddenOpacity(0.2f) - 0.8125f) < 1e-5, "pose.math.backThreshold", Pose3.ComputeHiddenOpacity(0.2f).ToString("F6"));
        SelfTestRunner.Check(Pose3.ComputeHiddenOpacity(1) == 0, "pose.math.fullyVisible");
        SelfTestRunner.Check(Pose3.ComputeHiddenOpacity(0) == 1, "pose.math.fullyHidden");
        SelfTestRunner.Check(Math.Abs(Pose3.ComputeHiddenOpacity(0.9f) - 0.1f) < 1e-5, "pose.math.linearBranch", Pose3.ComputeHiddenOpacity(0.9f).ToString("F6"));
        // Phi 交点处背景透出 0.25>0.15 → a1 被抬高到 1-0.15/0.5=0.7
        SelfTestRunner.Check(Math.Abs(Pose3.ComputeHiddenOpacity(0.5f) - 0.7f) < 1e-5, "pose.math.phiIntersection", Pose3.ComputeHiddenOpacity(0.5f).ToString("F6"));

        // ── 集成（需 Core + 真实部件） ──
        if (modelDir == null) { SelfTestRunner.Skip("pose.integration", "无模型目录"); return; }
        try { CoreLibrary.Load(null, modelDir); }
        catch (CoreNotAvailableException) { SelfTestRunner.Skip("pose.integration", "Core DLL 缺失"); return; }
        var manifestPath = Path.Combine(modelDir, "Cyrene.model3.json");
        if (!File.Exists(manifestPath)) { SelfTestRunner.Skip("pose.integration", "缺 manifest"); return; }
        var manifest = Model3Json.Load(manifestPath);
        using var model = CubismModel.FromMoc3(Path.Combine(modelDir, manifest.Moc));

        // 真实部件（Cyrene 部件无同名参数）：Reset 初始化不透明度 + 无可见部件回退
        var partIds = model.PartIds.Take(2).ToArray();
        if (partIds.Length < 2) { SelfTestRunner.Skip("pose.integration", "部件不足"); return; }
        var json = $$"""
        { "FadeInTime": 0.5, "Groups": [ [ {"Id":"{{partIds[0]}}"}, {"Id":"{{partIds[1]}}"} ] ] }
        """;
        using var doc2 = JsonDocument.Parse(json);
        var pose2 = Pose3.Create(doc2.RootElement);
        int part0 = model.GetPartIndex(partIds[0]), part1 = model.GetPartIndex(partIds[1]);

        pose2.UpdateParameters(model, 0.1f);
        SelfTestRunner.Check(model.PartOpacities[part0] == 1, "pose.reset.firstVisible");
        SelfTestRunner.Check(model.PartOpacities[part1] == 0, "pose.reset.secondHidden");
        // 无同名参数 → 找不到可见部件 → 回退 visiblePartIndex=0（原生语义），首部件保持显示
        pose2.UpdateParameters(model, 0.1f);
        SelfTestRunner.Check(model.PartOpacities[part0] == 1 && model.PartOpacities[part1] == 0, "pose.fade.noParamFallback");

        // 完整淡入淡出数值（仅「部件=同名参数」的模型适用；Cyrene 不用 pose → SKIP）
        var ids = model.PartIds.Where(id => model.GetParameterIndex(id) >= 0).Take(3).ToArray();
        if (ids.Length < 3) { SelfTestRunner.Skip("pose.fade.full", "无同名参数部件（本模型不使用 pose）"); return; }

        var jsonFull = $$"""
        { "FadeInTime": 0.5, "Groups": [ [ {"Id":"{{ids[0]}}","Link":["{{ids[2]}}"]}, {"Id":"{{ids[1]}}"} ] ] }
        """;
        using var doc3 = JsonDocument.Parse(jsonFull);
        var pose3 = Pose3.Create(doc3.RootElement);

        int fpart0 = model.GetPartIndex(ids[0]), fpart1 = model.GetPartIndex(ids[1]), fpart2 = model.GetPartIndex(ids[2]);
        int param0 = model.GetParameterIndex(ids[0]), param1 = model.GetParameterIndex(ids[1]);

        pose3.UpdateParameters(model, 0.1f);
        SelfTestRunner.Check(model.PartOpacities[fpart0] == 1 && model.PartOpacities[fpart1] == 0, "pose.full.reset");
        SelfTestRunner.Check(model.GetParameterValue(param0) == 1 && model.GetParameterValue(param1) == 0, "pose.full.resetParams");
        SelfTestRunner.Check(model.PartOpacities[fpart2] == 1, "pose.full.linkSync");

        // 切换：part1 参数置 1、part0 置 0 → part1 淡入 0.2，part0 衰减到 0.8125
        model.SetParameterValue(param0, 0);
        model.SetParameterValue(param1, 1);
        pose3.UpdateParameters(model, 0.1f);
        SelfTestRunner.Check(Math.Abs(model.PartOpacities[fpart1] - 0.2f) < 1e-5, "pose.full.fadeIn", model.PartOpacities[fpart1].ToString("F6"));
        SelfTestRunner.Check(Math.Abs(model.PartOpacities[fpart0] - 0.8125f) < 1e-5, "pose.full.fadeOut", model.PartOpacities[fpart0].ToString("F6"));
        SelfTestRunner.Check(Math.Abs(model.PartOpacities[fpart2] - 0.8125f) < 1e-5, "pose.full.linkCopy", model.PartOpacities[fpart2].ToString("F6"));
    }
}

public static class BreathTests
{
    public static void Run(string? modelDir)
    {
        // ── pld 默认参数表（无需 Core） ──
        var breath = Breath.CreateDefault();
        SelfTestRunner.Check(breath.Parameters.Count == 5, "breath.defaults.count", breath.Parameters.Count.ToString());
        SelfTestRunner.Check(
            breath.Parameters[0].ParameterId == "ParamAngleX" && breath.Parameters[0].Peak == 15 && breath.Parameters[0].Cycle == 6.5345f,
            "breath.defaults.angleX");
        SelfTestRunner.Check(
            breath.Parameters[4].ParameterId == "ParamBreath" && breath.Parameters[4].Peak == 0.5f && breath.Parameters[4].Cycle == 3.2345f,
            "breath.defaults.paramBreath");
        SelfTestRunner.Check(breath.Parameters.All(p => p.Offset == 0 && p.Weight == 0.5f), "breath.defaults.offsetWeight");

        // ── 正弦写入（需 Core；TS add 语义：current + value*weight） ──
        if (modelDir == null) { SelfTestRunner.Skip("breath.update", "无模型目录"); return; }
        try { CoreLibrary.Load(null, modelDir); }
        catch (CoreNotAvailableException) { SelfTestRunner.Skip("breath.update", "Core DLL 缺失"); return; }
        var manifestPath = Path.Combine(modelDir, "Cyrene.model3.json");
        if (!File.Exists(manifestPath)) { SelfTestRunner.Skip("breath.update", "缺 manifest"); return; }
        var manifest = Model3Json.Load(manifestPath);
        using var model = CubismModel.FromMoc3(Path.Combine(modelDir, manifest.Moc));

        float breathBefore = model.GetParameterValueById("ParamBreath");
        float angleXBefore = model.GetParameterValueById("ParamAngleX");
        breath.UpdateParameters(model, 0.1f);

        double t = 0.1 * 2 * Math.PI;
        double expectBreath = breathBefore + 0.5 * Math.Sin(t / 3.2345) * 0.5;
        double expectAngleX = angleXBefore + 15 * Math.Sin(t / 6.5345) * 0.5;
        SelfTestRunner.Check(Math.Abs(model.GetParameterValueById("ParamBreath") - expectBreath) < 1e-4, "breath.update.paramBreath", $"{model.GetParameterValueById("ParamBreath"):F6} vs {expectBreath:F6}");
        SelfTestRunner.Check(Math.Abs(model.GetParameterValueById("ParamAngleX") - expectAngleX) < 1e-4, "breath.update.angleX", $"{model.GetParameterValueById("ParamAngleX"):F6} vs {expectAngleX:F6}");

        // 时间累积：第二帧 t=0.2
        float breathMid = model.GetParameterValueById("ParamBreath");
        breath.UpdateParameters(model, 0.1f);
        double t2 = 0.2 * 2 * Math.PI;
        double expectBreath2 = breathMid + 0.5 * Math.Sin(t2 / 3.2345) * 0.5;
        SelfTestRunner.Check(Math.Abs(model.GetParameterValueById("ParamBreath") - expectBreath2) < 1e-4, "breath.update.timeAccumulates");
        SelfTestRunner.Check(Math.Abs(breath.CurrentTime - 0.2f) < 1e-6, "breath.update.currentTime");
    }
}
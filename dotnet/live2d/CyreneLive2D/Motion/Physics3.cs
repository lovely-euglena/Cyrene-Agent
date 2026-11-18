// physics3.json 物理演算（T3）——逐式移植 Framework CubismPhysics.cpp，
// 并已对照 CubismWebFramework cubismphysics.ts（guansss fork，pld 实际使用）逐段核实：
// 两版语义一致，包括以下必须原样保留的「怪癖」：
//   1. UpdateParticles 旋转：direction.X 先算，direction.Y 用「新 X」（非标准旋转）；
//   2. totalTranslation 按 -totalAngle 旋转同样是就地 X→Y（第二行用新 X）；
//   3. NormalizeParameterValue：isInverted=true 保持符号，false 反而取反；
//   4. TranslationScale 解析时从不赋值（恒 0）——X/Y 型输出实际无效，仅 Angle 用 Scale；
//   5. Create 后 rig.Gravity.Y=0（残留字段；有效重力是 Options.Gravity=(0,-1)）；
//   6. 固定步长 1/Fps + 剩余时间插值输出；输入缓存双轨（_parameterCaches 组间传播 /
//      _parameterInputCaches 步间插值）；MaxDeltaTime=5s 超限清零。
// 精度：float（与 C++ csmFloat32 一致；TS 为 double 但参数缓存同为 Float32，
// 差异远低于像素对照 2% 阈值）。pld 不调用 Stabilization——本类保留实现但不接入帧循环。

using System.Numerics;
using System.Text.Json;
using CyreneLive2D.Model;

namespace CyreneLive2D.Motion;

public enum PhysicsSourceType { X, Y, Angle }

public struct PhysicsNormalization
{
    public float Minimum;
    public float Maximum;
    public float Default;
}

public sealed class PhysicsParticle
{
    public Vector2 InitialPosition;
    public float Mobility;
    public float Delay;
    public float Acceleration;
    public float Radius;
    public Vector2 Position;
    public Vector2 LastPosition;
    public Vector2 LastGravity;
    public Vector2 Force;
    public Vector2 Velocity;
}

public sealed class PhysicsSubRig
{
    public int InputCount;
    public int OutputCount;
    public int ParticleCount;
    public int BaseInputIndex;
    public int BaseOutputIndex;
    public int BaseParticleIndex;
    public PhysicsNormalization NormalizationPosition;
    public PhysicsNormalization NormalizationAngle;
}

public sealed class PhysicsInput
{
    public string SourceId = "";
    public int SourceParameterIndex = -1;
    public float Weight;
    public PhysicsSourceType Type;
    public bool Reflect;
}

public sealed class PhysicsOutput
{
    public string DestinationId = "";
    public int DestinationParameterIndex = -1;
    public int VertexIndex;
    /// <summary>恒 0（Framework 解析不赋值——怪癖 4，原样保留）。</summary>
    public Vector2 TranslationScale;
    public float AngleScale;
    public float Weight;
    public PhysicsSourceType Type;
    public bool Reflect;
    public float ValueBelowMinimum;
    public float ValueExceededMaximum;
}

public sealed class PhysicsRig
{
    public PhysicsSubRig[] Settings = Array.Empty<PhysicsSubRig>();
    public PhysicsInput[] Inputs = Array.Empty<PhysicsInput>();
    public PhysicsOutput[] Outputs = Array.Empty<PhysicsOutput>();
    public PhysicsParticle[] Particles = Array.Empty<PhysicsParticle>();
    public Vector2 Gravity;
    public Vector2 Wind;
    public float Fps;
}

public sealed class PhysicsOptions
{
    public Vector2 Gravity = new(0, -1);
    public Vector2 Wind = Vector2.Zero;
}

public sealed unsafe class Physics3
{
    private const float AirResistance = 5.0f;
    private const float MaximumWeight = 100.0f;
    private const float MovementThreshold = 0.001f;
    private const float MaxDeltaTime = 5.0f;

    private PhysicsRig _rig = new();
    private float[][] _currentRigOutputs = Array.Empty<float[]>();
    private float[][] _previousRigOutputs = Array.Empty<float[]>();
    private float _currentRemainTime;
    private float[] _parameterCaches = Array.Empty<float>();
    private float[] _parameterInputCaches = Array.Empty<float>();

    public PhysicsOptions Options { get; set; } = new();

    internal PhysicsRig Rig => _rig;
    internal float CurrentRemainTime => _currentRemainTime;

    // ── 创建 / 解析 ─────────────────────────────────────────

    public static Physics3 Load(string path)
    {
        using var doc = JsonDocument.Parse(File.ReadAllText(path));
        return Create(doc.RootElement);
    }

    public static Physics3 Create(JsonElement root)
    {
        var p = new Physics3();
        p.Parse(root);
        p._rig.Gravity.Y = 0; // Create 怪癖 5（残留字段，不影响演算）
        return p;
    }

    private void Parse(JsonElement root)
    {
        var meta = root.GetProperty("Meta");
        _rig.Fps = meta.TryGetProperty("Fps", out var fpsEl) ? (float)fpsEl.GetDouble() : 0f;
        if (meta.TryGetProperty("EffectiveForces", out var forces))
        {
            _rig.Gravity = ReadVector(forces, "Gravity", new Vector2(0, -1));
            _rig.Wind = ReadVector(forces, "Wind", Vector2.Zero);
        }
        else
        {
            _rig.Gravity = new Vector2(0, -1);
        }

        var settingsEl = root.GetProperty("PhysicsSettings");
        var settings = new List<PhysicsSubRig>();
        var inputs = new List<PhysicsInput>();
        var outputs = new List<PhysicsOutput>();
        var particles = new List<PhysicsParticle>();
        var currentOutputs = new List<float[]>();
        var previousOutputs = new List<float[]>();

        foreach (var s in settingsEl.EnumerateArray())
        {
            var setting = new PhysicsSubRig
            {
                BaseInputIndex = inputs.Count,
                BaseOutputIndex = outputs.Count,
                BaseParticleIndex = particles.Count,
                NormalizationPosition = ReadNormalization(s, "Position"),
                NormalizationAngle = ReadNormalization(s, "Angle"),
            };

            if (s.TryGetProperty("Input", out var inputEl))
            {
                foreach (var i in inputEl.EnumerateArray())
                {
                    inputs.Add(new PhysicsInput
                    {
                        SourceId = i.GetProperty("Source").GetProperty("Id").GetString() ?? "",
                        Weight = (float)i.GetProperty("Weight").GetDouble(),
                        Type = ParseType(i.GetProperty("Type").GetString()),
                        Reflect = i.TryGetProperty("Reflect", out var r) && r.GetBoolean(),
                    });
                }
            }
            setting.InputCount = inputs.Count - setting.BaseInputIndex;

            if (s.TryGetProperty("Output", out var outputEl))
            {
                foreach (var o in outputEl.EnumerateArray())
                {
                    outputs.Add(new PhysicsOutput
                    {
                        DestinationId = o.GetProperty("Destination").GetProperty("Id").GetString() ?? "",
                        VertexIndex = o.GetProperty("VertexIndex").GetInt32(),
                        AngleScale = (float)o.GetProperty("Scale").GetDouble(),
                        Weight = (float)o.GetProperty("Weight").GetDouble(),
                        Type = ParseType(o.GetProperty("Type").GetString()),
                        Reflect = o.TryGetProperty("Reflect", out var r) && r.GetBoolean(),
                    });
                }
            }
            setting.OutputCount = outputs.Count - setting.BaseOutputIndex;
            currentOutputs.Add(new float[setting.OutputCount]);
            previousOutputs.Add(new float[setting.OutputCount]);

            if (s.TryGetProperty("Vertices", out var vertEl))
            {
                foreach (var v in vertEl.EnumerateArray())
                {
                    particles.Add(new PhysicsParticle
                    {
                        Mobility = (float)v.GetProperty("Mobility").GetDouble(),
                        Delay = (float)v.GetProperty("Delay").GetDouble(),
                        Acceleration = (float)v.GetProperty("Acceleration").GetDouble(),
                        Radius = (float)v.GetProperty("Radius").GetDouble(),
                        Position = ReadVector(v, "Position", Vector2.Zero),
                    });
                }
            }
            setting.ParticleCount = particles.Count - setting.BaseParticleIndex;

            settings.Add(setting);
        }

        _rig.Settings = settings.ToArray();
        _rig.Inputs = inputs.ToArray();
        _rig.Outputs = outputs.ToArray();
        _rig.Particles = particles.ToArray();
        _currentRigOutputs = currentOutputs.ToArray();
        _previousRigOutputs = previousOutputs.ToArray();

        Initialize();
    }

    private static Vector2 ReadVector(JsonElement el, string name, Vector2 fallback)
        => el.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Object
            ? new Vector2(
                v.TryGetProperty("X", out var x) ? (float)x.GetDouble() : 0f,
                v.TryGetProperty("Y", out var y) ? (float)y.GetDouble() : 0f)
            : fallback;

    private static PhysicsNormalization ReadNormalization(JsonElement setting, string kind)
    {
        var n = new PhysicsNormalization();
        if (setting.TryGetProperty("Normalization", out var norm) && norm.TryGetProperty(kind, out var k))
        {
            n.Minimum = k.TryGetProperty("Minimum", out var mi) ? (float)mi.GetDouble() : 0f;
            n.Maximum = k.TryGetProperty("Maximum", out var ma) ? (float)ma.GetDouble() : 0f;
            n.Default = k.TryGetProperty("Default", out var de) ? (float)de.GetDouble() : 0f;
        }
        return n;
    }

    private static PhysicsSourceType ParseType(string? type) => type switch
    {
        "X" => PhysicsSourceType.X,
        "Y" => PhysicsSourceType.Y,
        _ => PhysicsSourceType.Angle,
    };

    // ── 初始化 / 重置 ───────────────────────────────────────

    /// <summary>摆锤初始状态：顶点沿 +Y 按 Radius 串联；LastGravity=(0,1)。</summary>
    public void Initialize()
    {
        foreach (var setting in _rig.Settings)
        {
            int b = setting.BaseParticleIndex;
            _rig.Particles[b].InitialPosition = Vector2.Zero;
            _rig.Particles[b].LastPosition = Vector2.Zero;
            _rig.Particles[b].LastGravity = new Vector2(0, 1);
            _rig.Particles[b].Velocity = Vector2.Zero;
            _rig.Particles[b].Force = Vector2.Zero;

            for (int i = 1; i < setting.ParticleCount; i++)
            {
                var p = _rig.Particles[b + i];
                p.InitialPosition = _rig.Particles[b + i - 1].InitialPosition + new Vector2(0, p.Radius);
                p.Position = p.InitialPosition;
                p.LastPosition = p.InitialPosition;
                p.LastGravity = new Vector2(0, 1);
                p.Velocity = Vector2.Zero;
                p.Force = Vector2.Zero;
            }
        }
    }

    public void Reset()
    {
        Options = new PhysicsOptions();
        _rig.Gravity = Vector2.Zero;
        _rig.Wind = Vector2.Zero;
        Initialize();
    }

    // ── 演算 ────────────────────────────────────────────────

    /// <summary>
    /// 物理演算评估（时间单位秒）。固定步长 1/Fps 推进摆锤，剩余时间对前后两次
    /// 输出插值写入模型参数。dt&lt;=0 直接返回；累计 dt&gt;5s 清零（防后台挂起爆炸）。
    /// </summary>
    public void Evaluate(CubismModel model, float deltaTimeSeconds)
    {
        if (deltaTimeSeconds <= 0.0f) return;

        _currentRemainTime += deltaTimeSeconds;
        if (_currentRemainTime > MaxDeltaTime) _currentRemainTime = 0.0f;

        float* parameterValues = model.ParameterValues;
        var minimums = model.ParameterMinimums;
        var maximums = model.ParameterMaximums;
        var defaults = model.ParameterDefaults;
        int paramCount = model.ParameterCount;

        if (_parameterCaches.Length < paramCount) Array.Resize(ref _parameterCaches, paramCount);
        if (_parameterInputCaches.Length < paramCount)
        {
            Array.Resize(ref _parameterInputCaches, paramCount);
            for (int j = 0; j < paramCount; j++) _parameterInputCaches[j] = parameterValues[j];
        }

        float physicsDeltaTime = _rig.Fps > 0.0f ? 1.0f / _rig.Fps : deltaTimeSeconds;

        while (_currentRemainTime >= physicsDeltaTime)
        {
            // 最新输出 → 前次输出
            for (int s = 0; s < _rig.Settings.Length; s++)
            {
                var setting = _rig.Settings[s];
                for (int i = 0; i < setting.OutputCount; i++)
                {
                    _previousRigOutputs[s][i] = _currentRigOutputs[s][i];
                }
            }

            // 输入缓存与当前参数线性插值 → 本步输入（双缓存分离：组间传播 vs 步间插值）
            float inputWeight = physicsDeltaTime / _currentRemainTime;
            for (int j = 0; j < paramCount; j++)
            {
                _parameterCaches[j] = _parameterInputCaches[j] * (1.0f - inputWeight) + parameterValues[j] * inputWeight;
                _parameterInputCaches[j] = _parameterCaches[j];
            }

            for (int s = 0; s < _rig.Settings.Length; s++)
            {
                var setting = _rig.Settings[s];
                float totalAngle = 0.0f;
                var totalTranslation = Vector2.Zero;

                // 输入参数归一化累加
                for (int i = 0; i < setting.InputCount; i++)
                {
                    var input = _rig.Inputs[setting.BaseInputIndex + i];
                    if (input.SourceParameterIndex == -1)
                    {
                        input.SourceParameterIndex = model.GetParameterIndex(input.SourceId);
                    }
                    int idx = input.SourceParameterIndex;
                    if (idx < 0) continue; // 防御：未知参数（原生此处越界 UB）

                    float weight = input.Weight / MaximumWeight;
                    var norm = input.Type == PhysicsSourceType.Angle
                        ? setting.NormalizationAngle
                        : setting.NormalizationPosition;
                    float normalized = NormalizeParameterValue(
                        _parameterCaches[idx], minimums[idx], maximums[idx], defaults[idx],
                        norm.Minimum, norm.Maximum, norm.Default, input.Reflect);

                    switch (input.Type)
                    {
                        case PhysicsSourceType.X: totalTranslation.X += normalized * weight; break;
                        case PhysicsSourceType.Y: totalTranslation.Y += normalized * weight; break;
                        default: totalAngle += normalized * weight; break;
                    }
                }

                // 按 -totalAngle 旋转（就地 X→Y 怪癖 2，第二行用新 X）
                float radAngle = CubismMath.DegreesToRadian(-totalAngle);
                totalTranslation.X = totalTranslation.X * MathF.Cos(radAngle) - totalTranslation.Y * MathF.Sin(radAngle);
                totalTranslation.Y = totalTranslation.X * MathF.Sin(radAngle) + totalTranslation.Y * MathF.Cos(radAngle);

                UpdateParticles(
                    _rig.Particles, setting.BaseParticleIndex, setting.ParticleCount,
                    totalTranslation, totalAngle, Options.Wind,
                    MovementThreshold * setting.NormalizationPosition.Maximum,
                    physicsDeltaTime, AirResistance);

                // 输出：写 _parameterCaches（组间传播），不直接写模型
                for (int i = 0; i < setting.OutputCount; i++)
                {
                    var output = _rig.Outputs[setting.BaseOutputIndex + i];
                    if (output.DestinationParameterIndex == -1)
                    {
                        output.DestinationParameterIndex = model.GetParameterIndex(output.DestinationId);
                    }
                    int destIdx = output.DestinationParameterIndex;
                    int particleIndex = output.VertexIndex;
                    if (destIdx < 0 || particleIndex < 1 || particleIndex >= setting.ParticleCount) continue;

                    int pb = setting.BaseParticleIndex;
                    var translation = _rig.Particles[pb + particleIndex].Position - _rig.Particles[pb + particleIndex - 1].Position;
                    float outputValue = GetOutputValue(output, translation, _rig.Particles, pb, particleIndex, Options.Gravity);

                    _currentRigOutputs[s][i] = outputValue;
                    UpdateOutputParameterValue(ref _parameterCaches[destIdx], minimums[destIdx], maximums[destIdx], outputValue, output);
                }
            }

            _currentRemainTime -= physicsDeltaTime;
        }

        float alpha = _currentRemainTime / physicsDeltaTime;
        Interpolate(model, alpha);
    }

    /// <summary>前后两次摆锤输出按 weight 插值，写入模型参数（直写，非 TS set 语义）。</summary>
    public void Interpolate(CubismModel model, float weight)
    {
        float* parameterValues = model.ParameterValues;
        var minimums = model.ParameterMinimums;
        var maximums = model.ParameterMaximums;

        for (int s = 0; s < _rig.Settings.Length; s++)
        {
            var setting = _rig.Settings[s];
            for (int i = 0; i < setting.OutputCount; i++)
            {
                var output = _rig.Outputs[setting.BaseOutputIndex + i];
                int destIdx = output.DestinationParameterIndex;
                if (destIdx == -1) continue;

                float value = _previousRigOutputs[s][i] * (1 - weight) + _currentRigOutputs[s][i] * weight;
                UpdateOutputParameterValue(ref parameterValues[destIdx], minimums[destIdx], maximums[destIdx], value, output);
            }
        }
    }

    /// <summary>
    /// 以当前参数值演算稳定态（摆锤直接落到受力平衡位置）。
    /// Framework 完整 API 的一部分；pld 不调用——帧循环不接入，仅备查/自测。
    /// </summary>
    public void Stabilization(CubismModel model)
    {
        float* parameterValues = model.ParameterValues;
        var minimums = model.ParameterMinimums;
        var maximums = model.ParameterMaximums;
        var defaults = model.ParameterDefaults;
        int paramCount = model.ParameterCount;

        if (_parameterCaches.Length < paramCount) Array.Resize(ref _parameterCaches, paramCount);
        if (_parameterInputCaches.Length < paramCount) Array.Resize(ref _parameterInputCaches, paramCount);
        for (int j = 0; j < paramCount; j++)
        {
            _parameterCaches[j] = parameterValues[j];
            _parameterInputCaches[j] = parameterValues[j];
        }

        for (int s = 0; s < _rig.Settings.Length; s++)
        {
            var setting = _rig.Settings[s];
            float totalAngle = 0.0f;
            var totalTranslation = Vector2.Zero;

            for (int i = 0; i < setting.InputCount; i++)
            {
                var input = _rig.Inputs[setting.BaseInputIndex + i];
                if (input.SourceParameterIndex == -1)
                {
                    input.SourceParameterIndex = model.GetParameterIndex(input.SourceId);
                }
                int idx = input.SourceParameterIndex;
                if (idx < 0) continue;

                float weight = input.Weight / MaximumWeight;
                var norm = input.Type == PhysicsSourceType.Angle
                    ? setting.NormalizationAngle
                    : setting.NormalizationPosition;
                float normalized = NormalizeParameterValue(
                    parameterValues[idx], minimums[idx], maximums[idx], defaults[idx],
                    norm.Minimum, norm.Maximum, norm.Default, input.Reflect);

                switch (input.Type)
                {
                    case PhysicsSourceType.X: totalTranslation.X += normalized * weight; break;
                    case PhysicsSourceType.Y: totalTranslation.Y += normalized * weight; break;
                    default: totalAngle += normalized * weight; break;
                }
                _parameterCaches[idx] = parameterValues[idx];
            }

            float radAngle = CubismMath.DegreesToRadian(-totalAngle);
            totalTranslation.X = totalTranslation.X * MathF.Cos(radAngle) - totalTranslation.Y * MathF.Sin(radAngle);
            totalTranslation.Y = totalTranslation.X * MathF.Sin(radAngle) + totalTranslation.Y * MathF.Cos(radAngle);

            UpdateParticlesForStabilization(
                _rig.Particles, setting.BaseParticleIndex, setting.ParticleCount,
                totalTranslation, totalAngle, Options.Wind,
                MovementThreshold * setting.NormalizationPosition.Maximum);

            for (int i = 0; i < setting.OutputCount; i++)
            {
                var output = _rig.Outputs[setting.BaseOutputIndex + i];
                if (output.DestinationParameterIndex == -1)
                {
                    output.DestinationParameterIndex = model.GetParameterIndex(output.DestinationId);
                }
                int destIdx = output.DestinationParameterIndex;
                int particleIndex = output.VertexIndex;
                if (destIdx < 0 || particleIndex < 1 || particleIndex >= setting.ParticleCount) continue;

                int pb = setting.BaseParticleIndex;
                var translation = _rig.Particles[pb + particleIndex].Position - _rig.Particles[pb + particleIndex - 1].Position;
                float outputValue = GetOutputValue(output, translation, _rig.Particles, pb, particleIndex, Options.Gravity);

                _currentRigOutputs[s][i] = outputValue;
                _previousRigOutputs[s][i] = outputValue;
                UpdateOutputParameterValue(ref parameterValues[destIdx], minimums[destIdx], maximums[destIdx], outputValue, output);
                _parameterCaches[destIdx] = parameterValues[destIdx];
            }
        }
    }

    // ── 静态演算核心（internal 供自测直接调用） ─────────────

    /// <summary>
    /// 参数归一化（逐式移植）：钳制到参数 [min,max]，按中点分段线性映射到归一化区间，
    /// 最后 isInverted ? result : -result（怪癖 3：false 反而取反）。
    /// parameterDefault 参数保留签名但不参与运算（中点取 (min+max)/2，与源一致）。
    /// </summary>
    internal static float NormalizeParameterValue(
        float value, float parameterMinimum, float parameterMaximum, float parameterDefault,
        float normalizedMinimum, float normalizedMaximum, float normalizedDefault, bool isInverted)
    {
        float result = 0.0f;

        float maxValue = MathF.Max(parameterMaximum, parameterMinimum);
        if (maxValue < value) value = maxValue;
        float minValue = MathF.Min(parameterMaximum, parameterMinimum);
        if (minValue > value) value = minValue;

        float minNormValue = MathF.Min(normalizedMinimum, normalizedMaximum);
        float maxNormValue = MathF.Max(normalizedMinimum, normalizedMaximum);
        float middleNormValue = normalizedDefault;

        float middleValue = GetDefaultValue(minValue, maxValue);
        float paramValue = value - middleValue;

        int sign = paramValue > 0.0f ? 1 : (paramValue < 0.0f ? -1 : 0);
        switch (sign)
        {
            case 1:
            {
                float nLength = maxNormValue - middleNormValue;
                float pLength = maxValue - middleValue;
                if (pLength != 0.0f)
                {
                    result = paramValue * (nLength / pLength);
                    result += middleNormValue;
                }
                break;
            }
            case -1:
            {
                float nLength = minNormValue - middleNormValue;
                float pLength = minValue - middleValue;
                if (pLength != 0.0f)
                {
                    result = paramValue * (nLength / pLength);
                    result += middleNormValue;
                }
                break;
            }
            default:
                result = middleNormValue;
                break;
        }

        return isInverted ? result : result * -1.0f;
    }

    private static float GetRangeValue(float min, float max)
        => MathF.Abs(MathF.Max(min, max) - MathF.Min(min, max));

    private static float GetDefaultValue(float min, float max)
        => MathF.Min(min, max) + GetRangeValue(min, max) / 2.0f;

    /// <summary>
    /// 摆锤粒子更新（逐式移植，含怪癖 1：direction.Y 用旋转后的新 X）。
    /// strand 为全局粒子数组，baseIndex 定位子摆锤起点。
    /// </summary>
    internal static void UpdateParticles(
        PhysicsParticle[] strand, int baseIndex, int strandCount,
        Vector2 totalTranslation, float totalAngle, Vector2 windDirection,
        float thresholdValue, float deltaTimeSeconds, float airResistance)
    {
        strand[baseIndex].Position = totalTranslation;

        float totalRadian = CubismMath.DegreesToRadian(totalAngle);
        var currentGravity = Normalize(CubismMath.RadianToDirection(totalRadian));

        for (int i = 1; i < strandCount; i++)
        {
            var p = strand[baseIndex + i];
            var parent = strand[baseIndex + i - 1];

            p.Force = currentGravity * p.Acceleration + windDirection;
            p.LastPosition = p.Position;

            float delay = p.Delay * deltaTimeSeconds * 30.0f;

            var direction = p.Position - parent.Position;
            float radian = CubismMath.DirectionToRadian(p.LastGravity, currentGravity) / airResistance;

            direction.X = MathF.Cos(radian) * direction.X - direction.Y * MathF.Sin(radian);
            direction.Y = MathF.Sin(radian) * direction.X + direction.Y * MathF.Cos(radian); // 怪癖 1：新 X

            p.Position = parent.Position + direction;

            var velocity = p.Velocity * delay;
            var force = p.Force * delay * delay;
            p.Position = p.Position + velocity + force;

            var newDirection = Normalize(p.Position - parent.Position);
            p.Position = parent.Position + newDirection * p.Radius;

            if (MathF.Abs(p.Position.X) < thresholdValue) p.Position.X = 0.0f;

            if (delay != 0.0f)
            {
                p.Velocity = (p.Position - p.LastPosition) / delay * p.Mobility;
            }

            p.Force = Vector2.Zero;
            p.LastGravity = currentGravity;
        }
    }

    /// <summary>稳定态粒子更新：无速度项，直接沿受力方向落到 Radius 距离。</summary>
    internal static void UpdateParticlesForStabilization(
        PhysicsParticle[] strand, int baseIndex, int strandCount,
        Vector2 totalTranslation, float totalAngle, Vector2 windDirection, float thresholdValue)
    {
        strand[baseIndex].Position = totalTranslation;

        float totalRadian = CubismMath.DegreesToRadian(totalAngle);
        var currentGravity = Normalize(CubismMath.RadianToDirection(totalRadian));

        for (int i = 1; i < strandCount; i++)
        {
            var p = strand[baseIndex + i];
            var parent = strand[baseIndex + i - 1];

            p.Force = currentGravity * p.Acceleration + windDirection;
            p.LastPosition = p.Position;
            p.Velocity = Vector2.Zero;

            var force = Normalize(p.Force) * p.Radius;
            p.Position = parent.Position + force;

            if (MathF.Abs(p.Position.X) < thresholdValue) p.Position.X = 0.0f;

            p.Force = Vector2.Zero;
            p.LastGravity = currentGravity;
        }
    }

    /// <summary>输出值：X/Y 取平移分量；Angle 取与父重力方向的夹角（≥2 级用上一级摆向）。</summary>
    private static float GetOutputValue(
        PhysicsOutput output, Vector2 translation, PhysicsParticle[] particles,
        int baseParticleIndex, int particleIndex, Vector2 parentGravity)
    {
        float outputValue;
        switch (output.Type)
        {
            case PhysicsSourceType.X:
                outputValue = translation.X;
                break;
            case PhysicsSourceType.Y:
                outputValue = translation.Y;
                break;
            default:
                if (particleIndex >= 2)
                {
                    parentGravity = particles[baseParticleIndex + particleIndex - 1].Position
                                  - particles[baseParticleIndex + particleIndex - 2].Position;
                }
                else
                {
                    parentGravity *= -1.0f;
                }
                outputValue = CubismMath.DirectionToRadian(parentGravity, translation);
                break;
        }
        if (output.Reflect) outputValue *= -1.0f;
        return outputValue;
    }

    /// <summary>输出缩放 × 值 → 钳制到参数 [min,max] → 按 Weight/100 混合写回。</summary>
    private static void UpdateOutputParameterValue(
        ref float parameterValue, float parameterValueMinimum, float parameterValueMaximum,
        float translation, PhysicsOutput output)
    {
        float outputScale = output.Type switch
        {
            PhysicsSourceType.X => output.TranslationScale.X,
            PhysicsSourceType.Y => output.TranslationScale.Y,
            _ => output.AngleScale,
        };

        float value = translation * outputScale;

        if (value < parameterValueMinimum)
        {
            if (value < output.ValueBelowMinimum) output.ValueBelowMinimum = value;
            value = parameterValueMinimum;
        }
        else if (value > parameterValueMaximum)
        {
            if (value > output.ValueExceededMaximum) output.ValueExceededMaximum = value;
            value = parameterValueMaximum;
        }

        float weight = output.Weight / MaximumWeight;
        parameterValue = weight >= 1.0f
            ? value
            : parameterValue * (1.0f - weight) + value * weight;
    }

    /// <summary>向量归一化——无零长保护（与源一致；零长产生 NaN 同样传播）。</summary>
    private static Vector2 Normalize(Vector2 v)
    {
        float length = MathF.Pow(v.X * v.X + v.Y * v.Y, 0.5f);
        return new Vector2(v.X / length, v.Y / length);
    }
}
// motion3.json 动作（T3）——逐式移植 Framework CubismMotion.cpp。
// 解析：Meta + Curves（Target/Id/Fade/Segments 扁平数组）→ 展平 Points/Segments。
// 求值：Linear / Bezier（restricted=de Casteljau，否则 Cardano 反解）/ Stepped / InverseStepped。
// 循环：MotionBehavior_V2（duration+=1/fps，终点→始点补正，跨 loop 重置 startTime）。
// 淡入淡出：motion 级 + 每曲线级；EyeBlink/LipSync 模型曲线乘/加到匹配参数。
//
// ⚠️ 与 web 轨一致：pld 从不 setLoop（Meta.Loop 被忽略），动作播一次即止。
//    本类保留 IsLoop 能力供自测，但 MotionManager 创建时不开循环（对齐 pld）。

using System.Text.Json;
using CyreneLive2D.Model;

namespace CyreneLive2D.Motion;

public enum MotionSegmentType { Linear = 0, Bezier = 1, Stepped = 2, InverseStepped = 3 }
public enum MotionCurveTarget { Model, Parameter, PartOpacity }

public struct MotionPoint
{
    public float Time;
    public float Value;
    public MotionPoint(float time, float value) { Time = time; Value = value; }
}

public delegate float SegmentEvaluate(MotionPoint[] points, int baseIndex, float time);

public sealed class MotionSegment
{
    public int BasePointIndex;
    public MotionSegmentType SegmentType;
    public SegmentEvaluate Evaluate = null!;
}

public sealed class MotionCurve
{
    public MotionCurveTarget Target;
    public string Id = "";
    public float FadeInTime = -1.0f;
    public float FadeOutTime = -1.0f;
    public int BaseSegmentIndex;
    public int SegmentCount;
}

public sealed class MotionEvent
{
    public float FireTime;
    public string Value = "";
}

public sealed class MotionData
{
    public float Duration;
    public bool Loop;
    public float Fps = 30.0f;
    public MotionCurve[] Curves = Array.Empty<MotionCurve>();
    public MotionSegment[] Segments = Array.Empty<MotionSegment>();
    public MotionPoint[] Points = Array.Empty<MotionPoint>();
    public MotionEvent[] Events = Array.Empty<MotionEvent>();
}

public sealed class Motion3 : ACubismMotion
{
    private const float FltMax = float.MaxValue;
    private const int MaxTargetSize = 64;

    private MotionData _data = new();
    private string[] _eyeBlinkParameterIds = Array.Empty<string>();
    private string[] _lipSyncParameterIds = Array.Empty<string>();
    private float _modelOpacity = 1.0f;
    private float _lastWeight;
    private float _sourceFrameRate = 30.0f;
    private float _loopDurationSeconds = -1.0f;

    /// <summary>motion3.json 是否显式给了 FadeInTime/FadeOutTime（pld 据此决定是否用 model.json 覆盖）。</summary>
    public bool HasJsonFadeIn { get; private set; }
    public bool HasJsonFadeOut { get; private set; }

    public MotionData Data => _data;
    public float SourceFrameRate => _sourceFrameRate;
    public float ModelOpacityValue => _modelOpacity;
    public float LastWeight => _lastWeight;

    public override float GetDuration() => IsLoop ? -1.0f : _loopDurationSeconds;
    public override float GetLoopDuration() => _loopDurationSeconds;

    public void SetEffectIds(string[] eyeBlinkParameterIds, string[] lipSyncParameterIds)
    {
        _eyeBlinkParameterIds = eyeBlinkParameterIds;
        _lipSyncParameterIds = lipSyncParameterIds;
    }

    // ── 创建 / 解析 ─────────────────────────────────────────

    public static Motion3 Load(string path)
    {
        using var doc = JsonDocument.Parse(File.ReadAllText(path));
        return Create(doc.RootElement);
    }

    public static Motion3 Create(JsonElement root)
    {
        var motion = new Motion3();
        motion.Parse(root);
        motion._sourceFrameRate = motion._data.Fps;
        motion._loopDurationSeconds = motion._data.Duration;
        return motion;
    }

    private void Parse(JsonElement root)
    {
        var meta = root.GetProperty("Meta");
        _data.Duration = (float)meta.GetProperty("Duration").GetDouble();
        _data.Loop = meta.TryGetProperty("Loop", out var loopEl) && loopEl.GetBoolean();
        _data.Fps = (float)meta.GetProperty("Fps").GetDouble();
        bool areBeziersRestricted = meta.TryGetProperty("AreBeziersRestricted", out var abrEl) && abrEl.GetBoolean();

        HasJsonFadeIn = root.TryGetProperty("FadeInTime", out var fadeInEl);
        HasJsonFadeOut = root.TryGetProperty("FadeOutTime", out var fadeOutEl);
        // 负值 → 1.0；缺省 → 1.0（与 Framework Parse 一致）
        FadeInSeconds = HasJsonFadeIn ? ((float)fadeInEl.GetDouble() < 0 ? 1.0f : (float)fadeInEl.GetDouble()) : 1.0f;
        FadeOutSeconds = HasJsonFadeOut ? ((float)fadeOutEl.GetDouble() < 0 ? 1.0f : (float)fadeOutEl.GetDouble()) : 1.0f;

        var curvesEl = root.GetProperty("Curves");
        int curveCount = curvesEl.GetArrayLength();

        // 先统计 segment/point 总数（Meta 给了，但按实际解析更稳）
        var curves = new List<MotionCurve>(curveCount);
        var segments = new List<MotionSegment>();
        var points = new List<MotionPoint>();

        foreach (var curveEl in curvesEl.EnumerateArray())
        {
            var curve = new MotionCurve
            {
                Target = ParseTarget(curveEl.GetProperty("Target").GetString()),
                Id = curveEl.GetProperty("Id").GetString() ?? "",
                BaseSegmentIndex = segments.Count,
            };
            if (curveEl.TryGetProperty("FadeInTime", out var cfi)) curve.FadeInTime = (float)cfi.GetDouble();
            if (curveEl.TryGetProperty("FadeOutTime", out var cfo)) curve.FadeOutTime = (float)cfo.GetDouble();

            var seg = curveEl.GetProperty("Segments");
            int n = seg.GetArrayLength();
            float At(int i) => (float)seg[i].GetDouble();

            int segmentPosition = 0;
            while (segmentPosition < n)
            {
                var segment = new MotionSegment();
                if (segmentPosition == 0)
                {
                    segment.BasePointIndex = points.Count;
                    points.Add(new MotionPoint(At(0), At(1)));
                    segmentPosition += 2;
                }
                else
                {
                    segment.BasePointIndex = points.Count - 1;
                }

                var type = (MotionSegmentType)(int)At(segmentPosition);
                segment.SegmentType = type;
                switch (type)
                {
                    case MotionSegmentType.Linear:
                        segment.Evaluate = LinearEvaluate;
                        points.Add(new MotionPoint(At(segmentPosition + 1), At(segmentPosition + 2)));
                        segmentPosition += 3;
                        break;
                    case MotionSegmentType.Bezier:
                        segment.Evaluate = areBeziersRestricted ? BezierEvaluate : BezierEvaluateCardano;
                        points.Add(new MotionPoint(At(segmentPosition + 1), At(segmentPosition + 2)));
                        points.Add(new MotionPoint(At(segmentPosition + 3), At(segmentPosition + 4)));
                        points.Add(new MotionPoint(At(segmentPosition + 5), At(segmentPosition + 6)));
                        segmentPosition += 7;
                        break;
                    case MotionSegmentType.Stepped:
                        segment.Evaluate = SteppedEvaluate;
                        points.Add(new MotionPoint(At(segmentPosition + 1), At(segmentPosition + 2)));
                        segmentPosition += 3;
                        break;
                    case MotionSegmentType.InverseStepped:
                        segment.Evaluate = InverseSteppedEvaluate;
                        points.Add(new MotionPoint(At(segmentPosition + 1), At(segmentPosition + 2)));
                        segmentPosition += 3;
                        break;
                    default:
                        throw new InvalidDataException($"未知 motion segment 类型: {(int)type}");
                }
                segments.Add(segment);
                curve.SegmentCount++;
            }
            curves.Add(curve);
        }

        _data.Curves = curves.ToArray();
        _data.Segments = segments.ToArray();
        _data.Points = points.ToArray();

        // UserData 事件
        if (root.TryGetProperty("UserData", out var userDataEl) && userDataEl.ValueKind == JsonValueKind.Array)
        {
            var events = new List<MotionEvent>();
            foreach (var e in userDataEl.EnumerateArray())
            {
                events.Add(new MotionEvent
                {
                    FireTime = (float)e.GetProperty("Time").GetDouble(),
                    Value = e.GetProperty("Value").GetString() ?? "",
                });
            }
            _data.Events = events.ToArray();
        }
    }

    private static MotionCurveTarget ParseTarget(string? target) => target switch
    {
        "Model" => MotionCurveTarget.Model,
        "Parameter" => MotionCurveTarget.Parameter,
        "PartOpacity" => MotionCurveTarget.PartOpacity,
        _ => MotionCurveTarget.Parameter,
    };

    // ── 曲线求值（静态，供自测直接调用） ─────────────────────

    private static MotionPoint LerpPoints(MotionPoint a, MotionPoint b, float t)
        => new(a.Time + (b.Time - a.Time) * t, a.Value + (b.Value - a.Value) * t);

    public static float LinearEvaluate(MotionPoint[] points, int b, float time)
    {
        float t = (time - points[b].Time) / (points[b + 1].Time - points[b].Time);
        if (t < 0.0f) t = 0.0f;
        return points[b].Value + (points[b + 1].Value - points[b].Value) * t;
    }

    private static float DeCasteljau(MotionPoint[] p, int b, float t)
    {
        var p01 = LerpPoints(p[b], p[b + 1], t);
        var p12 = LerpPoints(p[b + 1], p[b + 2], t);
        var p23 = LerpPoints(p[b + 2], p[b + 3], t);
        var p012 = LerpPoints(p01, p12, t);
        var p123 = LerpPoints(p12, p23, t);
        return LerpPoints(p012, p123, t).Value;
    }

    /// <summary>restricted 贝塞尔：t 按时间线性归一（AreBeziersRestricted=true）。</summary>
    public static float BezierEvaluate(MotionPoint[] points, int b, float time)
    {
        float t = (time - points[b].Time) / (points[b + 3].Time - points[b].Time);
        if (t < 0.0f) t = 0.0f;
        return DeCasteljau(points, b, t);
    }

    /// <summary>非 restricted 贝塞尔：Cardano 反解 x(t)=time 的 t。</summary>
    public static float BezierEvaluateCardano(MotionPoint[] points, int b, float time)
    {
        float x1 = points[b].Time, x2 = points[b + 3].Time;
        float cx1 = points[b + 1].Time, cx2 = points[b + 2].Time;
        float a = x2 - 3.0f * cx2 + 3.0f * cx1 - x1;
        float bb = 3.0f * cx2 - 6.0f * cx1 + 3.0f * x1;
        float c = 3.0f * cx1 - 3.0f * x1;
        float d = x1 - time;
        float t = CubismMath.CardanoAlgorithmForBezier(a, bb, c, d);
        return DeCasteljau(points, b, t);
    }

    public static float SteppedEvaluate(MotionPoint[] points, int b, float time) => points[b].Value;
    public static float InverseSteppedEvaluate(MotionPoint[] points, int b, float time) => points[b + 1].Value;

    private float CorrectEndPoint(int segmentIndex, int beginIndex, int endIndex, float time, float endTime)
    {
        var p = new MotionPoint[2];
        p[0] = _data.Points[endIndex];
        p[1] = _data.Points[beginIndex];
        p[1].Time = endTime;
        return _data.Segments[segmentIndex].SegmentType switch
        {
            MotionSegmentType.Stepped => SteppedEvaluate(p, 0, time),
            MotionSegmentType.InverseStepped => InverseSteppedEvaluate(p, 0, time),
            _ => LinearEvaluate(p, 0, time),
        };
    }

    public float EvaluateCurve(int index, float time, bool isCorrection, float endTime)
    {
        var curve = _data.Curves[index];
        int target = -1;
        int totalSegmentCount = curve.BaseSegmentIndex + curve.SegmentCount;
        int pointPosition = 0;
        for (int i = curve.BaseSegmentIndex; i < totalSegmentCount; i++)
        {
            pointPosition = _data.Segments[i].BasePointIndex
                + (_data.Segments[i].SegmentType == MotionSegmentType.Bezier ? 3 : 1);
            if (_data.Points[pointPosition].Time > time) { target = i; break; }
        }

        if (target == -1)
        {
            if (isCorrection && time < endTime)
            {
                return CorrectEndPoint(
                    totalSegmentCount - 1,
                    _data.Segments[curve.BaseSegmentIndex].BasePointIndex,
                    pointPosition, time, endTime);
            }
            return _data.Points[pointPosition].Value;
        }

        var segment = _data.Segments[target];
        return segment.Evaluate(_data.Points, segment.BasePointIndex, time);
    }

    public override IReadOnlyList<string> GetFiredEvent(float beforeCheckTimeSeconds, float motionTimeSeconds)
    {
        var fired = new List<string>();
        foreach (var e in _data.Events)
        {
            if (e.FireTime > beforeCheckTimeSeconds && e.FireTime <= motionTimeSeconds) fired.Add(e.Value);
        }
        return fired;
    }

    // ── 参数更新（逐式移植 DoUpdateParameters） ──────────────

    protected override void DoUpdateParameters(CubismModel model, float userTimeSeconds, float fadeWeight, MotionQueueEntry entry)
    {
        // V2：循环状态变化时重算结束时刻
        if (PreviousLoopState != IsLoop)
        {
            AdjustEndTime(entry);
            PreviousLoopState = IsLoop;
        }

        float timeOffsetSeconds = userTimeSeconds - entry.StartTimeSeconds;
        if (timeOffsetSeconds < 0.0f) timeOffsetSeconds = 0.0f;

        float lipSyncValue = FltMax;
        float eyeBlinkValue = FltMax;
        var eyeBlinkFlags = new bool[Math.Min(_eyeBlinkParameterIds.Length, MaxTargetSize)];
        var lipSyncFlags = new bool[Math.Min(_lipSyncParameterIds.Length, MaxTargetSize)];

        float tmpFadeIn = FadeInSeconds <= 0.0f
            ? 1.0f
            : CubismMath.GetEasingSine((userTimeSeconds - entry.FadeInStartTimeSeconds) / FadeInSeconds);
        float tmpFadeOut = (FadeOutSeconds <= 0.0f || entry.EndTimeSeconds < 0.0f)
            ? 1.0f
            : CubismMath.GetEasingSine((entry.EndTimeSeconds - userTimeSeconds) / FadeOutSeconds);

        float time = timeOffsetSeconds;
        float duration = _data.Duration;
        bool isCorrection = IsLoop; // MotionBehavior_V2
        if (IsLoop)
        {
            duration += 1.0f / _data.Fps;
            while (time > duration) time -= duration;
        }

        // Model 曲线（EyeBlink / LipSync / Opacity）
        foreach (var curve in _data.Curves)
        {
            if (curve.Target != MotionCurveTarget.Model) continue;
            float value = EvaluateCurve(Array.IndexOf(_data.Curves, curve), time, isCorrection, duration);
            if (curve.Id == "EyeBlink") eyeBlinkValue = value;
            else if (curve.Id == "LipSync") lipSyncValue = value;
            else if (curve.Id == "Opacity")
            {
                _modelOpacity = value;
                model.SetModelOpacity(_modelOpacity);
            }
        }

        // Parameter 曲线
        for (int c = 0; c < _data.Curves.Length; c++)
        {
            var curve = _data.Curves[c];
            if (curve.Target != MotionCurveTarget.Parameter) continue;

            int parameterIndex = model.GetParameterIndex(curve.Id);
            if (parameterIndex == -1) continue;

            float sourceValue = model.GetParameterValue(parameterIndex);
            float value = EvaluateCurve(c, time, isCorrection, duration);

            if (eyeBlinkValue != FltMax)
            {
                for (int i = 0; i < _eyeBlinkParameterIds.Length && i < MaxTargetSize; i++)
                {
                    if (_eyeBlinkParameterIds[i] == curve.Id) { value *= eyeBlinkValue; eyeBlinkFlags[i] = true; break; }
                }
            }
            if (lipSyncValue != FltMax)
            {
                for (int i = 0; i < _lipSyncParameterIds.Length && i < MaxTargetSize; i++)
                {
                    if (_lipSyncParameterIds[i] == curve.Id) { value += lipSyncValue; lipSyncFlags[i] = true; break; }
                }
            }

            if (model.IsRepeat(parameterIndex)) value = model.GetParameterRepeatValue(parameterIndex, value);

            float v;
            if (curve.FadeInTime < 0.0f && curve.FadeOutTime < 0.0f)
            {
                v = sourceValue + (value - sourceValue) * fadeWeight;
            }
            else
            {
                float fin = curve.FadeInTime < 0.0f
                    ? tmpFadeIn
                    : (curve.FadeInTime == 0.0f ? 1.0f
                        : CubismMath.GetEasingSine((userTimeSeconds - entry.FadeInStartTimeSeconds) / curve.FadeInTime));
                float fout = curve.FadeOutTime < 0.0f
                    ? tmpFadeOut
                    : ((curve.FadeOutTime == 0.0f || entry.EndTimeSeconds < 0.0f) ? 1.0f
                        : CubismMath.GetEasingSine((entry.EndTimeSeconds - userTimeSeconds) / curve.FadeOutTime));
                float paramWeight = Weight * fin * fout;
                v = sourceValue + (value - sourceValue) * paramWeight;
            }
            model.SetParameterValueByIndex(parameterIndex, v);
        }

        // 未被 motion 覆盖的 EyeBlink/LipSync 目标：按 fadeWeight 叠加模型曲线值
        if (eyeBlinkValue != FltMax)
        {
            for (int i = 0; i < _eyeBlinkParameterIds.Length && i < MaxTargetSize; i++)
            {
                if (eyeBlinkFlags[i]) continue;
                int idx = model.GetParameterIndex(_eyeBlinkParameterIds[i]);
                if (idx == -1) continue;
                float sourceValue = model.GetParameterValue(idx);
                model.SetParameterValueByIndex(idx, sourceValue + (eyeBlinkValue - sourceValue) * fadeWeight);
            }
        }
        if (lipSyncValue != FltMax)
        {
            for (int i = 0; i < _lipSyncParameterIds.Length && i < MaxTargetSize; i++)
            {
                if (lipSyncFlags[i]) continue;
                int idx = model.GetParameterIndex(_lipSyncParameterIds[i]);
                if (idx == -1) continue;
                float sourceValue = model.GetParameterValue(idx);
                model.SetParameterValueByIndex(idx, sourceValue + (lipSyncValue - sourceValue) * fadeWeight);
            }
        }

        // PartOpacity 曲线（直接写，无淡入淡出）
        foreach (var curve in _data.Curves)
        {
            if (curve.Target != MotionCurveTarget.PartOpacity) continue;
            int parameterIndex = model.GetParameterIndex(curve.Id);
            if (parameterIndex == -1) continue;
            float value = EvaluateCurve(Array.IndexOf(_data.Curves, curve), time, isCorrection, duration);
            model.SetParameterValueByIndex(parameterIndex, value);
        }

        if (timeOffsetSeconds >= duration)
        {
            if (IsLoop)
            {
                UpdateForNextLoop(entry, userTimeSeconds, time);
            }
            else
            {
                OnFinishedMotion?.Invoke(this);
                entry.IsFinished = true;
            }
        }

        _lastWeight = fadeWeight;
    }

    private void UpdateForNextLoop(MotionQueueEntry entry, float userTimeSeconds, float time)
    {
        // MotionBehavior_V2：回到本圈起点（保留余数 time）
        entry.StartTimeSeconds = userTimeSeconds - time;
        if (IsLoopFadeIn) entry.FadeInStartTimeSeconds = userTimeSeconds - time;
        OnFinishedMotion?.Invoke(this);
    }
}
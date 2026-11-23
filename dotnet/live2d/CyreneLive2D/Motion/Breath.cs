// 呼吸自然运动（T3）——逐式移植 Framework CubismBreath.cpp。
// value = Offset + Peak*sin(2π*t/Cycle)，按 Weight 走 TS addParameterValueById
// （set(current + value*weight)，含 clamp/repeat——与 pld 一致）。
// 默认参数表来自 pld Cubism4InternalModel.init（web 轨基准，manager.ts 未覆盖）。

using CyreneLive2D.Model;

namespace CyreneLive2D.Motion;

public sealed class BreathParameterData
{
    public string ParameterId { get; }
    public float Offset { get; }
    public float Peak { get; }
    public float Cycle { get; }
    public float Weight { get; }

    public BreathParameterData(string parameterId, float offset, float peak, float cycle, float weight)
    {
        ParameterId = parameterId;
        Offset = offset;
        Peak = peak;
        Cycle = cycle;
        Weight = weight;
    }
}

public sealed class Breath
{
    private float _currentTime;
    private BreathParameterData[] _parameters = Array.Empty<BreathParameterData>();

    public float CurrentTime => _currentTime;
    public IReadOnlyList<BreathParameterData> Parameters => _parameters;

    public void SetParameters(BreathParameterData[] parameters) => _parameters = parameters;

    /// <summary>pld 默认呼吸参数（Cubism4InternalModel.init 逐值一致）。</summary>
    public static Breath CreateDefault()
    {
        var breath = new Breath();
        breath.SetParameters(new[]
        {
            new BreathParameterData("ParamAngleX", 0.0f, 15.0f, 6.5345f, 0.5f),
            new BreathParameterData("ParamAngleY", 0.0f, 8.0f, 3.5345f, 0.5f),
            new BreathParameterData("ParamAngleZ", 0.0f, 10.0f, 5.5345f, 0.5f),
            new BreathParameterData("ParamBodyAngleX", 0.0f, 4.0f, 15.5345f, 0.5f),
            new BreathParameterData("ParamBreath", 0.0f, 0.5f, 3.2345f, 0.5f),
        });
        return breath;
    }

    public void UpdateParameters(CubismModel model, float deltaTimeSeconds)
    {
        _currentTime += deltaTimeSeconds;
        float t = _currentTime * 2.0f * CubismMath.Pi;

        foreach (var data in _parameters)
        {
            model.AddParameterValueById(data.ParameterId, data.Offset + data.Peak * MathF.Sin(t / data.Cycle), data.Weight);
        }
    }
}
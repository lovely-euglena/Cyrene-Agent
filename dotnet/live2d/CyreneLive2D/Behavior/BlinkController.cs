// 自动眨眼（T4）——逐式移植 src/renderer/live2d/blink.ts。
// 每帧写入（beforeModelUpdate 钩子位），覆盖动作/表情的眼部曲线——web 轨同序。
// 间隔 uniform[2500,6000)ms；闭合 70ms + 张开 140ms；smoothstep 缓动。
// 时间显式注入（nowMs）；RNG 可注入供确定性自测。
// 注：pld 原装 CubismEyeBlink 在无动作时也写同一组眼参数，但本控制器在帧末
// 必然覆盖之——净效果等价，sidecar 不再重复实现原装眼眨（见 PetEngine.Tick 注释）。

using CyreneLive2D.Model;

namespace CyreneLive2D.Behavior;

public sealed class BlinkController
{
    private const double MinIntervalMs = 2500;
    private const double MaxIntervalMs = 6000;
    private const double CloseMs = 70;
    private const double OpenMs = 140;

    private readonly CubismModel _model;
    private readonly Func<double> _random;
    private double _nextBlinkAt;
    private double _blinkStart = -1; // pld 用 0 哨兵；sidecar 时钟从 0 起，改用 -1

    public BlinkController(CubismModel model, double nowMs, Func<double>? random = null)
    {
        _model = model;
        _random = random ?? (() => Random.Shared.NextDouble());
        _nextBlinkAt = nowMs + RandomInterval();
    }

    private double RandomInterval() => MinIntervalMs + _random() * (MaxIntervalMs - MinIntervalMs);

    public void Tick(double nowMs)
    {
        if (nowMs < _nextBlinkAt)
        {
            SetEyes(1);
            return;
        }

        if (_blinkStart < 0) _blinkStart = nowMs;
        double elapsed = nowMs - _blinkStart;
        if (elapsed >= CloseMs + OpenMs)
        {
            _blinkStart = -1;
            _nextBlinkAt = nowMs + RandomInterval();
            SetEyes(1);
            return;
        }

        double open = elapsed < CloseMs
            ? 1 - elapsed / CloseMs
            : (elapsed - CloseMs) / OpenMs;
        SetEyes(open * open * (3 - 2 * open));
    }

    private void SetEyes(double open)
    {
        _model.SetParameterValueById("ParamEyeLOpen", (float)open, 1f);
        _model.SetParameterValueById("ParamEyeROpen", (float)open, 1f);
    }
}
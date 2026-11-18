// 假口型同步（T4）——逐式移植 src/renderer/live2d/mouth-sync.ts。
// 180ms 翻转开/合目标（0.15~0.85 ± rand*0.18），τ=70ms 指数平滑，
// 帧间隔钳 100ms（防节流跳变）， closing 到 current<0.02 脱离钩子。
// 时长上限 5min；start(<=0) 立即进入 closing。
// 「钩子附着/脱离」用 IsActive 表达：帧循环仅在 IsActive 时调 Tick。
// 时间显式注入；RNG 可注入。写入走 TS set 语义（beforeModelUpdate 位，覆盖动作曲线）。

using CyreneLive2D.Model;

namespace CyreneLive2D.Behavior;

public sealed class MouthSyncController
{
    private const double MaxMouthDurationMs = 5 * 60 * 1000;
    private const double MouthTickMs = 180;
    private const double MinMouthValue = 0.15;
    private const double MaxMouthValue = 0.85;
    private const double SmoothingTauMs = 70;
    private const double CloseThreshold = 0.02;
    private const double MaxFrameDeltaMs = 100;

    private readonly CubismModel _model;
    private readonly Func<double> _random;

    private double _endTime;
    private double _lastToggleAt;
    private double _lastFrameAt;
    private bool _closing = true;
    private bool _mouthOpen;
    private double _target;
    private double _current;

    public bool IsActive { get; private set; }
    public double Current => _current;
    public bool IsClosing => _closing;

    public MouthSyncController(CubismModel model, Func<double>? random = null)
    {
        _model = model;
        _random = random ?? (() => Random.Shared.NextDouble());
    }

    public void Start(double durationMs, double nowMs)
    {
        IsActive = false; // detach
        double safeDuration = Math.Clamp(double.IsFinite(durationMs) ? durationMs : 0, 0, MaxMouthDurationMs);
        if (safeDuration <= 0)
        {
            BeginClosing(nowMs);
            return;
        }

        _closing = false;
        _endTime = nowMs + safeDuration;
        _lastToggleAt = nowMs;
        _lastFrameAt = nowMs;
        _mouthOpen = false;
        PickTarget();
        IsActive = true; // attach
    }

    public void Stop(double nowMs)
    {
        if (_closing) return;
        BeginClosing(nowMs);
    }

    private void BeginClosing(double nowMs)
    {
        IsActive = false; // detach
        _closing = true;
        _target = 0;
        if (_current < CloseThreshold)
        {
            SetMouth(0);
            _current = 0;
            return;
        }
        _lastFrameAt = nowMs;
        IsActive = true; // attach
    }

    private void PickTarget()
    {
        _mouthOpen = !_mouthOpen;
        double random = _random() * 0.18;
        _target = _mouthOpen
            ? MaxMouthValue - random
            : MinMouthValue + random;
    }

    /// <summary>帧更新（仅 IsActive 时由帧循环调用）。</summary>
    public void Tick(double nowMs)
    {
        double dt = Math.Clamp(nowMs - _lastFrameAt, 0, MaxFrameDeltaMs);
        _lastFrameAt = nowMs;

        if (!_closing)
        {
            if (nowMs >= _endTime)
            {
                BeginClosing(nowMs);
                if (!IsActive) return;
            }
            else if (nowMs - _lastToggleAt >= MouthTickMs)
            {
                _lastToggleAt = nowMs;
                PickTarget();
            }
        }

        double alpha = 1 - Math.Exp(-dt / SmoothingTauMs);
        _current += (_target - _current) * alpha;
        SetMouth(_current);

        if (_closing && _current < CloseThreshold)
        {
            _current = 0;
            SetMouth(0);
            IsActive = false; // detach
        }
    }

    private void SetMouth(double value)
        => _model.SetParameterValueById("ParamMouthOpenY", (float)value, 1f);
}
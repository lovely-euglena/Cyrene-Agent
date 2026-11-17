// 表情定时回正（T4）——逐式移植 src/renderer/live2d/expression-reset.ts。
// 每 3min 应用「表情回正」；交互触发（hit）时 restart 重计时。
// web 用 setInterval（首次触发在 +interval）；sidecar 用显式时间驱动。

using CyreneLive2D.Motion;

namespace CyreneLive2D.Behavior;

public sealed class ExpressionResetController
{
    private readonly ExpressionManager _expressions;
    private readonly double _intervalMs;
    private readonly string _expressionName;
    private double _nextResetAt;

    public ExpressionResetController(
        ExpressionManager expressions, double nowMs,
        double intervalMs = 3 * 60 * 1000, string expressionName = "表情回正")
    {
        _expressions = expressions;
        _intervalMs = intervalMs;
        _expressionName = expressionName;
        _nextResetAt = nowMs + _intervalMs;
    }

    public void Tick(double nowMs)
    {
        if (nowMs < _nextResetAt) return;
        ResetNow();
        _nextResetAt = nowMs + _intervalMs;
    }

    public void Restart(double nowMs) => _nextResetAt = nowMs + _intervalMs;

    public bool ResetNow() => _expressions.SetExpression(_expressionName);
}
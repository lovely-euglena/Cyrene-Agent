// 注视控制（T4）——逐式移植 pld FocusController.ts + Live2DModel.focus 坐标映射
// + Cubism4InternalModel.updateFocus 参数写入。
// 时间单位：update 的 dt 为毫秒（pld 同）。
// 坐标映射怪癖：pld 把任意窗口点映射到「单位圆方向」(cos atan2, -sin atan2)，
// 窗口正中心 → atan2(0,0)=0 → 目标 (1,0)（并非居中注视，原样保留）。

using CyreneLive2D.Model;

namespace CyreneLive2D.Behavior;

/// <summary>注视位置插值（pld FocusController 逐式）：加速度/速度双限幅的临界阻尼追踪。</summary>
public sealed class FocusController
{
    private const float Epsilon = 0.01f;
    private const float MaxSpeed = 40f / 7.5f;
    private const float AccelerationTime = 1f / (0.15f * 1000f);

    public float TargetX { get; private set; }
    public float TargetY { get; private set; }
    public float X { get; private set; }
    public float Y { get; private set; }
    public float Vx { get; private set; }
    public float Vy { get; private set; }

    public void Focus(float x, float y, bool instant = false)
    {
        TargetX = Math.Clamp(x, -1f, 1f);
        TargetY = Math.Clamp(y, -1f, 1f);
        if (instant)
        {
            X = TargetX;
            Y = TargetY;
        }
    }

    /// <summary>推进插值。dt 毫秒。</summary>
    public void Update(float dtMs)
    {
        float dx = TargetX - X;
        float dy = TargetY - Y;
        if (MathF.Abs(dx) < Epsilon && MathF.Abs(dy) < Epsilon) return;

        float d = MathF.Sqrt(dx * dx + dy * dy);
        float maxSpeed = MaxSpeed / (1000f / dtMs);

        float ax = maxSpeed * (dx / d) - Vx;
        float ay = maxSpeed * (dy / d) - Vy;

        float a = MathF.Sqrt(ax * ax + ay * ay);
        float maxA = maxSpeed * AccelerationTime * dtMs;
        if (a > maxA)
        {
            ax *= maxA / a;
            ay *= maxA / a;
        }

        Vx += ax;
        Vy += ay;

        float v = MathF.Sqrt(Vx * Vx + Vy * Vy);
        float maxV = 0.5f * (MathF.Sqrt(maxA * maxA + 8f * maxA * d) - maxA);
        if (v > maxV)
        {
            Vx *= maxV / v;
            Vy *= maxV / v;
        }

        X += Vx;
        Y += Vy;
    }
}

public static class FocusBehavior
{
    /// <summary>
    /// 窗口局部坐标 → 注视目标（pld Live2DModel.focus 逐式）：
    /// 先反演渲染布局得模型画布坐标，归一化到 [-1,1]，再 atan2 → 单位圆方向。
    /// scale = baseScale*zoom（画布像素→屏幕像素）；画布坐标 Y 向下。
    /// </summary>
    public static (float X, float Y) MapWindowPoint(
        float cx, float cy, float winW, float winH, float canvasW, float canvasH, float scale)
    {
        float tx = 2f * (cx - winW / 2f) / (scale * canvasW);
        float ty = 2f * (cy - winH / 2f) / (scale * canvasH);
        float radian = MathF.Atan2(ty, tx);
        return (MathF.Cos(radian), -MathF.Sin(radian));
    }

    /// <summary>Cubism4InternalModel.updateFocus 逐式（TS add 语义，weight=1）。</summary>
    public static void ApplyFocus(CubismModel model, FocusController focus)
    {
        model.AddParameterValueById("ParamEyeBallX", focus.X);
        model.AddParameterValueById("ParamEyeBallY", focus.Y);
        model.AddParameterValueById("ParamAngleX", focus.X * 30f);
        model.AddParameterValueById("ParamAngleY", focus.Y * 30f);
        model.AddParameterValueById("ParamAngleZ", focus.X * focus.Y * -30f);
        model.AddParameterValueById("ParamBodyAngleX", focus.X * 10f);
    }
}
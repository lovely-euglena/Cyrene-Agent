// 注视控制（T4）——逐式移植 pld FocusController.ts + Live2DModel.focus 坐标映射
// + Cubism4InternalModel.updateFocus 参数写入。
// 时间单位：update 的 dt 为毫秒（pld 同）。
// 坐标映射怪癖：pld Live2DModel.focus 恒 toModelPosition(skipUpdate:true)，把窗口点
// 反演到模型画布坐标后按 originalWidth/Height 归一化，再 atan2 → 单位圆方向
// (cos, -sin)（并非居中注视，原样保留）。反演用的 worldTransform 取决于渲染状态：
//   - 运行时（首帧后）：worldTransform=真实布局 → 窗口中心 → (0,0) → (1,0)。
//   - load 瞬间（首帧前）：worldTransform 仍单位矩阵 → 窗口中心直接按画布尺寸
//     归一化 → 固定偏心目标（见 MapWindowPointAtLoad）。

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
    /// 运行时（首帧渲染后）窗口局部坐标 → 注视目标（pld Live2DModel.focus 逐式）：
    /// worldTransform 已更新为真实布局，反演渲染布局得模型画布坐标，归一化到
    /// [-1,1]，再 atan2 → 单位圆方向。窗口中心 → (0,0) → (1,0)。
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

    /// <summary>
    /// load 瞬间（首帧渲染前）窗口中心 → 注视目标（web onLoad focus.focusCenter(true)）。
    /// 怪癖：pld focus 恒 toModelPosition(skipUpdate:true)，onLoad 时模型尚未首帧渲染，
    /// transform.worldTransform 仍为单位矩阵；localTransform 亦单位（Cyrene Layout 为空，
    /// pld setupLayout 默认 width/height=LOGICAL → scale(1,1)、offset 0）。于是窗口中心
    /// (winW/2, winH/2) 不经布局反演，直接按 originalWidth/Height 归一化：
    ///   tx = (winW/2)/canvasW*2 - 1 = winW/canvasW - 1（ty 同理）
    /// 得固定偏心目标（400×500 窗口 / 4200×3500 画布 → (-0.726, 0.688)），并非 (1,0)。
    /// 探针实证：identity 假设重算与 web focusController.target 全精度一致。
    /// 注：非空 Layout 需补 localTransform 反演（Cyrene 未用，暂不实现）。
    /// </summary>
    public static (float X, float Y) MapWindowPointAtLoad(float winW, float winH, float canvasW, float canvasH)
    {
        float tx = winW / canvasW - 1f;
        float ty = winH / canvasH - 1f;
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
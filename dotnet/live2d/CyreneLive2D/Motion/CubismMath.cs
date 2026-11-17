// Cubism 数学工具（T3）——逐式移植 Framework CubismMath.cpp / CubismMath.hpp。
// 全部 float 精度（与 C++ csmFloat32 一致），保证贝塞尔求值/淡入淡出与 web 轨数值对齐。
// 参考：Live2D-CubismNativeFramework src/Math/CubismMath.cpp。

namespace CyreneLive2D.Motion;

public static class CubismMath
{
    public const float Pi = 3.1415926535897932384626433832795f;
    public const float Epsilon = 0.00001f;

    public static float RangeF(float value, float min, float max)
        => value < min ? min : (max < value ? max : value);

    public static float DegreesToRadian(float degrees) => degrees / 180.0f * Pi;
    public static float RadianToDegrees(float radian) => radian * 180.0f / Pi;

    /// <summary>正弦缓动（淡入淡出用）：value&lt;0→0，&gt;1→1，否则 0.5-0.5*cos(value*π)。</summary>
    public static float GetEasingSine(float value)
    {
        if (value < 0.0f) return 0.0f;
        if (value > 1.0f) return 1.0f;
        return 0.5f - 0.5f * MathF.Cos(value * Pi);
    }

    /// <summary>二次方程求根（退化一次/常数 handled）。Cardano 的 a≈0 分支用。</summary>
    public static float QuadraticEquation(float a, float b, float c)
    {
        if (MathF.Abs(a) < Epsilon)
        {
            if (MathF.Abs(b) < Epsilon) return -c;
            return -c / b;
        }
        return -(b + MathF.Sqrt(b * b - 4.0f * a * c)) / (2.0f * a);
    }

    /// <summary>
    /// 卡尔丹公式解三次方程 a·t³+b·t²+c·t+d=0，取 [0,1] 内根（贝塞尔 x→t 反解）。
    /// 逐式移植 CubismMath::CardanoAlgorithmForBezier（判别式三分支 + 0.5±0.01 选根）。
    /// </summary>
    public static float CardanoAlgorithmForBezier(float a, float b, float c, float d)
    {
        if (MathF.Abs(a) < Epsilon)
        {
            return RangeF(QuadraticEquation(b, c, d), 0.0f, 1.0f);
        }

        float ba = b / a;
        float ca = c / a;
        float da = d / a;

        float p = (3.0f * ca - ba * ba) / 3.0f;
        float p3 = p / 3.0f;
        float q = (2.0f * ba * ba * ba - 9.0f * ba * ca + 27.0f * da) / 27.0f;
        float q2 = q / 2.0f;
        float discriminant = q2 * q2 + p3 * p3 * p3;

        const float center = 0.5f;
        const float threshold = center + 0.01f;

        if (discriminant < 0.0f)
        {
            float mp3 = -p / 3.0f;
            float mp33 = mp3 * mp3 * mp3;
            float r = MathF.Sqrt(mp33);
            float t = -q / (2.0f * r);
            float cosphi = RangeF(t, -1.0f, 1.0f);
            float phi = MathF.Acos(cosphi);
            float crtr = MathF.Cbrt(r);
            float t1 = 2.0f * crtr;

            float root1 = t1 * MathF.Cos(phi / 3.0f) - ba / 3.0f;
            if (MathF.Abs(root1 - center) < threshold) return RangeF(root1, 0.0f, 1.0f);

            float root2 = t1 * MathF.Cos((phi + 2.0f * Pi) / 3.0f) - ba / 3.0f;
            if (MathF.Abs(root2 - center) < threshold) return RangeF(root2, 0.0f, 1.0f);

            float root3 = t1 * MathF.Cos((phi + 4.0f * Pi) / 3.0f) - ba / 3.0f;
            return RangeF(root3, 0.0f, 1.0f);
        }

        if (discriminant == 0.0f)
        {
            float u1 = q2 < 0.0f ? MathF.Cbrt(-q2) : -MathF.Cbrt(q2);

            float root1 = 2.0f * u1 - ba / 3.0f;
            if (MathF.Abs(root1 - center) < threshold) return RangeF(root1, 0.0f, 1.0f);

            float root2 = -u1 - ba / 3.0f;
            return RangeF(root2, 0.0f, 1.0f);
        }

        float sd = MathF.Sqrt(discriminant);
        float u1p = MathF.Cbrt(sd - q2);
        float v1 = MathF.Cbrt(sd + q2);
        float root1p = u1p - v1 - ba / 3.0f;
        return RangeF(root1p, 0.0f, 1.0f);
    }

    /// <summary>取模（符号随被除数；非有限/除零返回 NaN）。repeat 参数回绕用。</summary>
    public static float ModF(float dividend, float divisor)
    {
        if (!float.IsFinite(dividend) || divisor == 0 || float.IsNaN(dividend) || float.IsNaN(divisor))
        {
            return float.NaN;
        }
        float absDividend = MathF.Abs(dividend);
        float absDivisor = MathF.Abs(divisor);
        float result = absDividend - MathF.Floor(absDividend / absDivisor) * absDivisor;
        return float.CopySign(result, dividend);
    }
}
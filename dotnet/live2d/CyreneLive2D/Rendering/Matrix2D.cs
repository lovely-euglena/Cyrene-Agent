// 仿射矩阵（行向量约定：p' = p * M，与 pixi Matrix / HLSL mul(vector, matrix) 一致）。
// 只保留 2D 仿射 6 分量 [a b c d tx ty]：
//   x' = a*x + c*y + tx
//   y' = b*x + d*y + ty
// 上传 GPU 时展开为 float4x4（行主序）。

namespace CyreneLive2D.Rendering;

public struct Matrix2D
{
    public float A, B, C, D, Tx, Ty;

    public static Matrix2D Identity => new() { A = 1, D = 1 };

    public static Matrix2D Scale(float sx, float sy) => new() { A = sx, D = sy };

    public static Matrix2D Translate(float tx, float ty) => new() { A = 1, D = 1, Tx = tx, Ty = ty };

    /// <summary>this * other（先应用 this，再应用 other——行向量右乘）。</summary>
    public readonly Matrix2D Multiply(Matrix2D o) => new()
    {
        A = A * o.A + B * o.C,
        B = A * o.B + B * o.D,
        C = C * o.A + D * o.C,
        D = C * o.B + D * o.D,
        Tx = Tx * o.A + Ty * o.C + o.Tx,
        Ty = Tx * o.B + Ty * o.D + o.Ty,
    };

    public readonly (float x, float y) Transform(float x, float y)
        => (A * x + C * y + Tx, B * x + D * y + Ty);

    /// <summary>展开为 HLSL float4x4（行主序，16 float）。</summary>
    public readonly void WriteTo(Span<float> dst)
    {
        // 行主序：row0=(A,B,0,0) row1=(C,D,0,0) row2=(0,0,1,0) row3=(Tx,Ty,0,1)
        dst[0] = A; dst[1] = B; dst[2] = 0; dst[3] = 0;
        dst[4] = C; dst[5] = D; dst[6] = 0; dst[7] = 0;
        dst[8] = 0; dst[9] = 0; dst[10] = 1; dst[11] = 0;
        dst[12] = Tx; dst[13] = Ty; dst[14] = 0; dst[15] = 1;
    }
}

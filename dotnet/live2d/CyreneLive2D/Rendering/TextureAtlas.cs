// PNG 图集加载：System.Drawing（GDI+，Windows 内置）解码 → CPU 预乘 alpha →
// D3D11 B8G8R8A8_UNORM 纹理。预乘在上传时做一次（与 pixi-live2d-display 的
// premultipliedAlpha 渲染路径一致——shader 与混合态全部按预乘约定）。

using System.Drawing;
using System.Drawing.Imaging;
using CyreneLive2D.Rendering.D3D11;

namespace CyreneLive2D.Rendering;

internal sealed unsafe class TextureAtlas : IDisposable
{
    public D3D11Texture2D Texture { get; }
    public D3D11ShaderResourceView Srv { get; }
    public int Width { get; }
    public int Height { get; }

    private TextureAtlas(D3D11Texture2D tex, D3D11ShaderResourceView srv, int w, int h)
    {
        Texture = tex; Srv = srv; Width = w; Height = h;
    }

    public static TextureAtlas Load(D3D11Device device, string path)
    {
        using var bmp = new Bitmap(path);
        var w = bmp.Width;
        var h = bmp.Height;
        var data = bmp.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
        try
        {
            // Format32bppArgb 内存字节序 = B,G,R,A（小端 ARGB）——与 DXGI B8G8R8A8 一致
            var bytes = new byte[w * h * 4];
            System.Runtime.InteropServices.Marshal.Copy(data.Scan0, bytes, 0, bytes.Length);
            Premultiply(bytes);
            // 完整 mip 链：pixi 默认 mipmap=POW2（图集为 2 的幂）→ web 轨缩小时
            // 用三线性 mip 滤波；无 mip 时细发丝/翅膀内部颜色与 web 不一致。
            // mip 链 CPU 生成（2×2 box，与 GL/D3D GenerateMips 语义一致）逐层
            // UpdateSubresource 上传——不依赖 GenerateMips（部分 D3D11 实现
            // 如开发沙箱其为 no-op），也避开「初始数据+多层 mip」的创建限制。
            var mips = 1;
            for (var s = Math.Max(w, h); s > 1; s >>= 1) mips++;
            var desc = new Texture2DDesc
            {
                Width = (uint)w,
                Height = (uint)h,
                MipLevels = (uint)mips,
                ArraySize = 1,
                Format = DxgiFormat.B8G8R8A8_UNORM,
                SampleCount = 1,
                SampleQuality = 0,
                Usage = D3D11Usage.Default,
                BindFlags = D3D11Bind.ShaderResource,
            };
            var tex = device.CreateTexture2D(ref desc, null);
            var ctx = device.ImmediateContext;
            var level = bytes;
            var lw = w;
            var lh = h;
            for (var m = 0; m < mips; m++)
            {
                fixed (byte* lp = level)
                    ctx.UpdateSubresource(tex.Handle, (uint)m, IntPtr.Zero, (IntPtr)lp, (uint)(lw * 4), 0);
                if (m + 1 < mips) level = Downscale(level, ref lw, ref lh);
            }
            var srv = device.CreateShaderResourceView(tex.Handle);
            return new TextureAtlas(tex, srv, w, h);
        }
        finally
        {
            bmp.UnlockBits(data);
        }
    }

    /// <summary>2×2 box 降采样（+2 舍入，与 GL/D3D mip 生成一致）；奇数边钳制边缘。</summary>
    private static unsafe byte[] Downscale(byte[] src, ref int w, ref int h)
    {
        var nw = (w + 1) / 2;
        var nh = (h + 1) / 2;
        var dst = new byte[nw * nh * 4];
        fixed (byte* s = src, d = dst)
        {
            for (var y = 0; y < nh; y++)
            {
                var y0 = Math.Min(2 * y, h - 1);
                var y1 = Math.Min(2 * y + 1, h - 1);
                for (var x = 0; x < nw; x++)
                {
                    var x0 = Math.Min(2 * x, w - 1);
                    var x1 = Math.Min(2 * x + 1, w - 1);
                    var a = s + (y0 * w + x0) * 4;
                    var b = s + (y0 * w + x1) * 4;
                    var c = s + (y1 * w + x0) * 4;
                    var e = s + (y1 * w + x1) * 4;
                    var o = d + (y * nw + x) * 4;
                    for (var ch = 0; ch < 4; ch++) o[ch] = (byte)((a[ch] + b[ch] + c[ch] + e[ch] + 2) >> 2);
                }
            }
        }
        w = nw;
        h = nh;
        return dst;
    }

    /// <summary>RGB *= A/255（预乘 alpha，四舍五入与 GPU 采样误差 < 1/255）。</summary>
    private static void Premultiply(byte[] b)
    {
        for (var i = 0; i < b.Length; i += 4)
        {
            var a = b[i + 3];
            if (a == 255) continue;
            if (a == 0) { b[i] = b[i + 1] = b[i + 2] = 0; continue; }
            b[i] = (byte)((b[i] * a + 127) / 255);
            b[i + 1] = (byte)((b[i + 1] * a + 127) / 255);
            b[i + 2] = (byte)((b[i + 2] * a + 127) / 255);
        }
    }

    public void Dispose()
    {
        Srv.Dispose();
        Texture.Dispose();
    }
}

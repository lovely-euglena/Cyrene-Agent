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
            fixed (byte* p = bytes)
            {
                var desc = new Texture2DDesc
                {
                    Width = (uint)w,
                    Height = (uint)h,
                    MipLevels = 1,
                    ArraySize = 1,
                    Format = DxgiFormat.B8G8R8A8_UNORM,
                    SampleCount = 1,
                    SampleQuality = 0,
                    Usage = D3D11Usage.Immutable,
                    BindFlags = D3D11Bind.ShaderResource,
                };
                var initial = new SubresourceData { SysMem = p, SysMemPitch = (uint)(w * 4) };
                var tex = device.CreateTexture2D(ref desc, &initial);
                var srv = device.CreateShaderResourceView(tex.Handle);
                return new TextureAtlas(tex, srv, w, h);
            }
        }
        finally
        {
            bmp.UnlockBits(data);
        }
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

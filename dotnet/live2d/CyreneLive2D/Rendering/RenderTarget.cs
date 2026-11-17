// 离屏渲染目标：颜色纹理 + RTV + SRV + 读回 staging。
// 主缓冲与蒙版缓冲共用；读回用于 UpdateLayeredWindow（DIB）与 T6 逐像素对照。

using CyreneLive2D.Rendering.D3D11;

namespace CyreneLive2D.Rendering;

internal sealed unsafe class RenderTarget : IDisposable
{
    private readonly D3D11Device _device;
    public D3D11Texture2D Texture { get; private set; } = null!;
    public D3D11RenderTargetView Rtv { get; private set; } = null!;
    public D3D11ShaderResourceView Srv { get; private set; } = null!;
    private D3D11Texture2D _staging = null!;
    public int Width { get; private set; }
    public int Height { get; private set; }

    public RenderTarget(D3D11Device device, int width, int height)
    {
        _device = device;
        Resize(width, height);
    }

    public void Resize(int width, int height)
    {
        if (width == Width && height == Height && Texture != null) return;
        Release();
        Width = width;
        Height = height;

        var desc = new Texture2DDesc
        {
            Width = (uint)width,
            Height = (uint)height,
            MipLevels = 1,
            ArraySize = 1,
            Format = DxgiFormat.B8G8R8A8_UNORM,
            SampleCount = 1,
            Usage = D3D11Usage.Default,
            BindFlags = D3D11Bind.RenderTarget | D3D11Bind.ShaderResource,
        };
        Texture = _device.CreateTexture2D(ref desc);
        Rtv = _device.CreateRenderTargetView(Texture.Handle);
        Srv = _device.CreateShaderResourceView(Texture.Handle);

        var stagingDesc = new Texture2DDesc
        {
            Width = (uint)width,
            Height = (uint)height,
            MipLevels = 1,
            ArraySize = 1,
            Format = DxgiFormat.B8G8R8A8_UNORM,
            SampleCount = 1,
            Usage = D3D11Usage.Staging,
            CpuAccessFlags = D3D11CpuAccess.Read,
        };
        _staging = _device.CreateTexture2D(ref stagingDesc);
    }

    /// <summary>
    /// 回读像素到 BGRA 缓冲（顶行在前，与 DIB/PNG 行序一致）。
    /// GPU 渲染 y-up NDC → 纹理行 0 = 画面顶部。
    /// </summary>
    public byte[] Readback()
    {
        var ctx = _device.ImmediateContext;
        ctx.CopyResource(_staging.Handle, Texture.Handle);
        var mapped = ctx.Map(_staging.Handle, 0, D3D11Map.Read);
        try
        {
            var bytes = new byte[Width * Height * 4];
            var src = (byte*)mapped.Data;
            for (var y = 0; y < Height; y++)
            {
                new Span<byte>(src + y * mapped.RowPitch, Width * 4)
                    .CopyTo(bytes.AsSpan(y * Width * 4, Width * 4));
            }
            return bytes;
        }
        finally
        {
            ctx.Unmap(_staging.Handle, 0);
        }
    }

    private void Release()
    {
        Texture?.Dispose();
        Rtv?.Dispose();
        Srv?.Dispose();
        _staging?.Dispose();
    }

    public void Dispose() => Release();
}

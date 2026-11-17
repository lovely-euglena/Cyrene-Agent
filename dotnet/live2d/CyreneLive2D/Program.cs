// cyrene-live2d 入口：Live2D 桌宠渲染侧车（issue #257）。
//
// 形态（与七 host 架构并轨）：
//   cyrene-live2d.exe                 JSON 行协议宿主（默认，Electron 拉起）
//   cyrene-live2d.exe --selftest      无头逻辑自测（退出码驱动，CI 可跑）
//   cyrene-live2d.exe --core-smoke    T0 探针：Core 加载 + 版本 + moc 冒烟
//   cyrene-live2d.exe --render-test   离屏渲染 → PNG（T6 逐像素对照用）
//
// 协议：JSON 行（{op,callId} / {op:"result",callId,ok,...} / {op:"ready"} /
// {op:"shutdown"} / {op:"event",...}），与 tool/voice host 同构。
// stdout 仅协议帧；诊断走 stderr 或 log 帧。

using CyreneLive2D.Core;

namespace CyreneLive2D;

public static class Program
{
    public static int Main(string[] args)
    {
        // GUI 子系统（WinExe）下控制台句柄可能缺失——自测模式附着父控制台。
        if (args.Length > 0 && args[0] is "--selftest" or "--core-smoke" or "--render-test" or "--gpu-smoke")
        {
            ConsoleAttach.Ensure();
        }

        try
        {
            if (args.Length > 0 && args[0] == "--core-smoke") return CoreSmoke(args[1..]);
            if (args.Length > 0 && args[0] == "--gpu-smoke") return GpuSmoke(args[1..]);
            if (args.Length > 0 && args[0] == "--selftest") return SelfTest.SelfTestRunner.Run(args[1..]);
            if (args.Length > 0 && args[0] == "--render-test") return SelfTest.RenderTest.Run(args[1..]);
            return Host.Live2DHost.Run(args);
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[cyrene-live2d] fatal: {ex}");
            return 1;
        }
    }

    /// <summary>T0 探针：csmGetVersion / csmGetLatestMocVersion / revive / 参数计数。</summary>
    private static int CoreSmoke(string[] args)
    {
        string? dataDir = null, modelDir = null, mocPath = null;
        for (var i = 0; i < args.Length; i++)
        {
            switch (args[i])
            {
                case "--data-dir" when i + 1 < args.Length: dataDir = args[++i]; break;
                case "--model-dir" when i + 1 < args.Length: modelDir = args[++i]; break;
                case "--moc" when i + 1 < args.Length: mocPath = args[++i]; break;
            }
        }

        CoreLibrary.Load(dataDir, modelDir);
        var (version, latestMoc) = CoreLibrary.Smoke();
        Console.WriteLine($"core.version={CoreLibrary.VersionString} (0x{version:X8})");
        Console.WriteLine($"core.latestMocVersion={latestMoc}");
        Console.WriteLine($"core.path={CoreLibrary.LoadedPath}");

        if (mocPath != null)
        {
            using var model = Model.CubismModel.FromMoc3(mocPath);
            Console.WriteLine($"moc.version={model.MocVersion}");
            Console.WriteLine($"model.parameters={model.ParameterCount}");
            Console.WriteLine($"model.parts={model.PartCount}");
            Console.WriteLine($"model.drawables={model.DrawableCount}");
            Console.WriteLine($"model.canvas={model.CanvasWidth}x{model.CanvasHeight} ppu={model.PixelsPerUnit}");
        }

        Console.WriteLine("CORE_SMOKE_OK");
        return 0;
    }

    /// <summary>T2 探针：D3D11 管线逐步冒烟（stderr 打点，定位 interop 崩溃用）。</summary>
    private static unsafe int GpuSmoke(string[] args)
    {
        string? modelDir = null;
        for (var i = 0; i < args.Length; i++)
        {
            if (args[i] == "--model-dir" && i + 1 < args.Length) modelDir = args[++i];
        }

        void Step(string name) => Console.Error.WriteLine($"[gpu-smoke] {name}");

        Step("device.create");
        using var device = Rendering.D3D11.D3D11Device.Create();
        var ctx = device.ImmediateContext;

        Step("shader.compile.vs");
        using var vsBlob = Rendering.D3D11.D3D11Native.Compile(Rendering.Shaders.VertexSource, "VSMain", "vs_4_0");
        Step("shader.create.vs");
        var vs = device.CreateVertexShader(vsBlob.BufferPointer, vsBlob.BufferSize);

        Step("inputLayout");
        D3D11InputLayoutProbe(device, vsBlob);

        Step("shader.compile.ps");
        using var psBlob = Rendering.D3D11.D3D11Native.Compile(Rendering.Shaders.PixelNormalSource, "PSMain", "ps_4_0");
        var ps = device.CreatePixelShader(psBlob.BufferPointer, psBlob.BufferSize);

        Step("blendState");
        var blendDesc = new Rendering.D3D11.BlendDesc
        {
            RenderTarget0 = new Rendering.D3D11.RenderTargetBlendDesc
            {
                BlendEnable = 1,
                SrcBlend = Rendering.D3D11.D3D11Blend.One,
                DestBlend = Rendering.D3D11.D3D11Blend.InvSrcAlpha,
                BlendOp = Rendering.D3D11.D3D11Blend.OpAdd,
                SrcBlendAlpha = Rendering.D3D11.D3D11Blend.One,
                DestBlendAlpha = Rendering.D3D11.D3D11Blend.InvSrcAlpha,
                BlendOpAlpha = Rendering.D3D11.D3D11Blend.OpAdd,
                RenderTargetWriteMask = 0xF,
            },
        };
        var blend = device.CreateBlendState(ref blendDesc);

        Step("rasterizer");
        var rasterDesc = new Rendering.D3D11.RasterizerDesc { FillMode = 3, CullMode = 1, DepthClipEnable = 1 };
        var raster = device.CreateRasterizerState(ref rasterDesc);

        Step("sampler");
        var samplerDesc = new Rendering.D3D11.SamplerDesc { Filter = 0x15, AddressU = 3, AddressV = 3, AddressW = 3, MaxAnisotropy = 1, MaxLOD = float.MaxValue };
        var sampler = device.CreateSamplerState(ref samplerDesc);

        Step("constantBuffer");
        var cbDesc = new Rendering.D3D11.BufferDesc { ByteWidth = 128, Usage = Rendering.D3D11.D3D11Usage.Dynamic, BindFlags = Rendering.D3D11.D3D11Bind.ConstantBuffer, CpuAccessFlags = Rendering.D3D11.D3D11CpuAccess.Write };
        var cb = device.CreateBuffer(ref cbDesc);

        Step("renderTarget");
        using var rt = new Rendering.RenderTarget(device, 64, 64);
        ctx.OMSetRenderTargets(rt.Rtv.Handle);
        ctx.ClearRenderTargetView(rt.Rtv.Handle, 0.25f, 0.5f, 0.75f, 1f);
        var pixels = rt.Readback();
        Step($"readback bgra=({pixels[0]},{pixels[1]},{pixels[2]},{pixels[3]})");

        if (modelDir != null)
        {
            Step("textureAtlas");
            var atlas = Rendering.TextureAtlas.Load(device, Path.Combine(modelDir, "texture_0.png"));
            Step($"atlas {atlas.Width}x{atlas.Height}");
            atlas.Dispose();
        }

        vs.Dispose(); ps.Dispose(); blend.Dispose(); raster.Dispose(); sampler.Dispose(); cb.Dispose();
        Console.WriteLine("GPU_SMOKE_OK");
        return 0;
    }

    private static unsafe void D3D11InputLayoutProbe(Rendering.D3D11.D3D11Device device, Rendering.D3D11.ShaderBlob vsBlob)
    {
        fixed (byte* pos = "POSITION\0"u8)
        fixed (byte* uv = "TEXCOORD0\0"u8)
        {
            var elements = stackalloc Rendering.D3D11.InputElementDesc[2];
            elements[0] = new Rendering.D3D11.InputElementDesc { SemanticName = pos, Format = Rendering.D3D11.DxgiFormat.R32G32_FLOAT, AlignedByteOffset = 0 };
            elements[1] = new Rendering.D3D11.InputElementDesc { SemanticName = uv, Format = Rendering.D3D11.DxgiFormat.R32G32_FLOAT, AlignedByteOffset = 8 };
            var layout = device.CreateInputLayout(elements, 2, vsBlob.BufferPointer, vsBlob.BufferSize);
            layout.Dispose();
        }
    }
}

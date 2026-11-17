// Cubism 渲染器（T2 主体）：D3D11 离屏渲染 → BGRA 回读。
//
// 逐帧流程（对照 Framework CubismRenderer 与 pixi-live2d-display WebGL 路径）：
//   1. 按 csmGetRenderOrders 逆排列排序 drawable（sorted[order[i]]=i，
//      与 Framework Vulkan DrawObjectLoop 同式）；
//   2. 蒙版 pass：每个唯一蒙版组一张全尺寸 RT，清 (1,1,1,1)，
//      ZERO/INV_SRC_COLOR 混合写入 channelFlag*alpha（组内按渲染序叠加）；
//      组序=创建序，蒙版 drawable 按无蒙版绘制——与 web 轨低精度蒙版路径
//      一致（pld 默认 _useHighPrecisionMask=false，不处理嵌套蒙版）；
//   3. 主 pass：清 (0,0,0,0)，按序绘制；Normal/Add/Multiply 三混合态，
//      multiply/screen 色 + 不透明度在 PS 内合成（预乘约定）；
//   4. 回读主 RT（BGRA 顶行序，与 DIB/PNG 一致）。
//
// 变换（与 web 轨逐像素对齐的关键，推导见 docs/design/2026-11-17-live2d-dotnet-sidecar.md）：
//   pld: centering = scale(ppu) + translate(W/2,H/2)，anchor(0.5,0.5) 居中，
//        draw() 翻 Y 后进 GL；pixi projection 再翻回——净效果：
//        screen_x = x*ppu*s + winW/2, screen_y = -y*ppu*s + winH/2（y 向下）。
//   本实现直接构造 NDC（y 向上）：MVP = scale(2*ppu*s/winW, 2*ppu*s/winH)。
//   s = baseScale*zoom，baseScale = min(400/W, 500/H, 1)（manager.ts 同值）。
//   与 pld 一致忽略 CanvasOrigin（pld 恒按 W/2,H/2 居中；Cyrene 模型 origin 即中心）。

using CyreneLive2D.Core;
using CyreneLive2D.Model;
using CyreneLive2D.Rendering.D3D11;

namespace CyreneLive2D.Rendering;

internal sealed unsafe class CubismRenderer : IDisposable
{
    /// <summary>基础窗口尺寸（src/renderer/live2d/manager.ts PET_WINDOW_BASE_*）。</summary>
    public const float BaseWindowWidth = 400f;
    public const float BaseWindowHeight = 500f;

    private readonly CubismModel _model;
    private readonly D3D11Device _device;
    private readonly D3D11Context _ctx;
    private readonly TextureAtlas[] _atlases;

    private readonly D3D11VertexShader _vs;
    private readonly D3D11PixelShader _psNormal, _psSetupMask, _psMasked, _psMaskedInverted;
    private readonly D3D11InputLayout _layout;
    private readonly D3D11BlendState _blendNormal, _blendAdd, _blendMultiply, _blendMaskSetup;
    private readonly D3D11RasterizerState _rasterizer;
    private readonly D3D11SamplerState _sampler;
    private readonly D3D11Buffer _constants;

    private D3D11Buffer _vertexBuffer = null!;
    private D3D11Buffer _indexBuffer = null!;
    private int _vertexCapacity, _indexCapacity;

    private readonly RenderTarget _mainTarget;
    private readonly MaskGroup[] _maskGroups;      // 拓扑序（渲染顺序）
    private readonly MaskGroup[] _groupsByIndex;   // 原始组索引 → 组（_drawableGroup 用）
    private readonly int[] _sortedDrawables;
    private readonly int[] _drawableGroup;   // drawable → 蒙版组索引（-1 = 无蒙版）

    private readonly float[] _constantData = new float[Shaders.ConstantBufferSize / 4];
    private float _mvpA, _mvpD;              // 当前帧 MVP 缩放分量（纯缩放，无平移）

    public int MaskGroupCount => _maskGroups.Length;
    public int DrawableCount => _model.DrawableCount;

    public CubismRenderer(CubismModel model, Model3Json manifest, string modelDir)
    {
        _model = model;
        _device = D3D11Device.Create();
        _ctx = _device.ImmediateContext;

        // ── 着色器 ──
        using (var vsBlob = D3D11Native.Compile(Shaders.VertexSource, "VSMain", "vs_4_0"))
        {
            _vs = _device.CreateVertexShader(vsBlob.BufferPointer, vsBlob.BufferSize);
            fixed (byte* pos = "POSITION\0"u8)
            // HLSL `: TEXCOORD0` 是语义 "TEXCOORD" + 索引 0 的简写；输入布局必须用
            // "TEXCOORD" + SemanticIndex=0。写成 "TEXCOORD0" 会签名匹配失败 → E_INVALIDARG。
            fixed (byte* uv = "TEXCOORD\0"u8)
            {
                var elements = stackalloc InputElementDesc[2];
                elements[0] = new InputElementDesc { SemanticName = pos, Format = DxgiFormat.R32G32_FLOAT, AlignedByteOffset = 0 };
                elements[1] = new InputElementDesc { SemanticName = uv, Format = DxgiFormat.R32G32_FLOAT, AlignedByteOffset = 8 };
                _layout = _device.CreateInputLayout(elements, 2, vsBlob.BufferPointer, vsBlob.BufferSize);
            }
        }
        _psNormal = CompilePixel(Shaders.PixelNormalSource);
        _psSetupMask = CompilePixel(Shaders.PixelSetupMaskSource);
        _psMasked = CompilePixel(Shaders.PixelMaskedSource);
        _psMaskedInverted = CompilePixel(Shaders.PixelMaskedInvertedSource);

        // ── 状态对象（混合态表逐条对照 Framework CubismRenderState_D3D11.cpp） ──
        _blendNormal = MakeBlend(D3D11Blend.One, D3D11Blend.InvSrcAlpha, D3D11Blend.One, D3D11Blend.InvSrcAlpha);
        _blendAdd = MakeBlend(D3D11Blend.One, D3D11Blend.One, D3D11Blend.Zero, D3D11Blend.One);
        _blendMultiply = MakeBlend(D3D11Blend.DstColor, D3D11Blend.InvSrcAlpha, D3D11Blend.Zero, D3D11Blend.One);
        _blendMaskSetup = MakeBlend(D3D11Blend.Zero, D3D11Blend.InvSrcColor, D3D11Blend.Zero, D3D11Blend.InvSrcAlpha);

        var rasterDesc = new RasterizerDesc { FillMode = 3, CullMode = 1, DepthClipEnable = 1 };
        _rasterizer = _device.CreateRasterizerState(ref rasterDesc);

        var samplerDesc = new SamplerDesc
        {
            Filter = 0x15,                 // MIN_MAG_MIP_LINEAR
            AddressU = 3, AddressV = 3, AddressW = 3,  // CLAMP
            MaxAnisotropy = 1,
            MaxLOD = float.MaxValue,
        };
        _sampler = _device.CreateSamplerState(ref samplerDesc);

        var cbDesc = new BufferDesc
        {
            ByteWidth = Shaders.ConstantBufferSize,
            Usage = D3D11Usage.Dynamic,
            BindFlags = D3D11Bind.ConstantBuffer,
            CpuAccessFlags = D3D11CpuAccess.Write,
        };
        _constants = _device.CreateBuffer(ref cbDesc);

        // ── 图集 ──
        _atlases = new TextureAtlas[manifest.Textures.Length];
        for (var i = 0; i < _atlases.Length; i++)
        {
            _atlases[i] = TextureAtlas.Load(_device, Path.Combine(modelDir, manifest.Textures[i]));
        }

        // ── 渲染序（逆排列）与蒙版分组 ──
        var n = model.DrawableCount;
        _sortedDrawables = new int[n];
        var orders = model.DrawableRenderOrders;
        for (var i = 0; i < n; i++) _sortedDrawables[orders[i]] = i;

        _drawableGroup = new int[n];
        Array.Fill(_drawableGroup, -1);
        (_maskGroups, _groupsByIndex) = DiscoverMaskGroups();

        _mainTarget = new RenderTarget(_device, 1, 1);
        EnsureGeometryCapacity();
    }

    private D3D11PixelShader CompilePixel(string source)
    {
        using var blob = D3D11Native.Compile(source, "PSMain", "ps_4_0");
        return _device.CreatePixelShader(blob.BufferPointer, blob.BufferSize);
    }

    private D3D11BlendState MakeBlend(uint src, uint dst, uint srcA, uint dstA)
    {
        var desc = new BlendDesc
        {
            RenderTarget0 = new RenderTargetBlendDesc
            {
                BlendEnable = 1,
                SrcBlend = src, DestBlend = dst, BlendOp = D3D11Blend.OpAdd,
                SrcBlendAlpha = srcA, DestBlendAlpha = dstA, BlendOpAlpha = D3D11Blend.OpAdd,
                RenderTargetWriteMask = 0xF,
            },
        };
        return _device.CreateBlendState(ref desc);
    }

    // ── 蒙版分组 ────────────────────────────────────────────

    private sealed class MaskGroup
    {
        public int[] Members = Array.Empty<int>();     // 蒙版 drawable（渲染序）
        public RenderTarget Target = null!;
    }

    /// <summary>
    /// 相同蒙版集合（无序）的 drawable 共享一张蒙版 RT——分组语义与 web 轨
    /// CubismClippingManager.initialize（findSameClip）一致。渲染顺序 = 创建顺序
    /// （drawable 索引扫描的首现序），与 web 轨 setupClippingContext 的遍历顺序一致。
    /// web 轨低精度蒙版路径不处理嵌套蒙版（蒙版 drawable 自身按无蒙版绘制，
    /// 见 cubism4.es.js setupClippingContext 低精度分支），故此处不做依赖分析——
    /// Cyrene 模型唯一蒙版组的成员被自身组蒙版（自依赖），拓扑排序会误报环。
    /// </summary>
    private (MaskGroup[] renderOrder, MaskGroup[] byIndex) DiscoverMaskGroups()
    {
        var n = _model.DrawableCount;
        var maskCounts = _model.DrawableMaskCounts;
        var masks = _model.DrawableMasks;

        var groupIndex = new Dictionary<string, int>(StringComparer.Ordinal);
        var groups = new List<MaskGroup>();

        for (var i = 0; i < n; i++)
        {
            if (maskCounts[i] <= 0) continue;
            var cnt = maskCounts[i];
            // 分组键 = 蒙版集合（无序）；组成员 = 蒙版形状本身（masks[i]，保持原序）。
            // 与 web 轨 CubismClippingContext 一致：_clippingIdList=蒙版形状，
            // _clippedDrawableIndexList=被蒙版 drawable（此处用 _drawableGroup 反查）。
            var keyArr = new int[cnt];
            new Span<int>(masks[i], cnt).CopyTo(keyArr);
            Array.Sort(keyArr);
            var key = string.Join(",", keyArr);
            if (!groupIndex.TryGetValue(key, out var gi))
            {
                gi = groups.Count;
                groupIndex[key] = gi;
                var members = new int[cnt];
                new Span<int>(masks[i], cnt).CopyTo(members);
                groups.Add(new MaskGroup { Members = members });
            }
            _drawableGroup[i] = gi;
        }

        var arr = groups.ToArray();
        return (arr, arr);
    }

    // ── 几何缓冲 ────────────────────────────────────────────

    private void EnsureGeometryCapacity()
    {
        var maxVerts = 0;
        var maxIndices = 0;
        var vcounts = _model.DrawableVertexCounts;
        var icounts = _model.DrawableIndexCounts;
        for (var i = 0; i < _model.DrawableCount; i++)
        {
            if (vcounts[i] > maxVerts) maxVerts = vcounts[i];
            if (icounts[i] > maxIndices) maxIndices = icounts[i];
        }
        GrowVertex(maxVerts);
        GrowIndex(maxIndices);
    }

    private void GrowVertex(int vertexCount)
    {
        if (vertexCount <= _vertexCapacity) return;
        _vertexBuffer?.Dispose();
        _vertexCapacity = Math.Max(vertexCount, _vertexCapacity * 2);
        var desc = new BufferDesc
        {
            ByteWidth = (uint)(_vertexCapacity * 16),
            Usage = D3D11Usage.Dynamic,
            BindFlags = D3D11Bind.VertexBuffer,
            CpuAccessFlags = D3D11CpuAccess.Write,
        };
        _vertexBuffer = _device.CreateBuffer(ref desc);
    }

    private void GrowIndex(int indexCount)
    {
        if (indexCount <= _indexCapacity) return;
        _indexBuffer?.Dispose();
        _indexCapacity = Math.Max(indexCount, _indexCapacity * 2);
        var desc = new BufferDesc
        {
            ByteWidth = (uint)(_indexCapacity * 2),
            Usage = D3D11Usage.Dynamic,
            BindFlags = D3D11Bind.IndexBuffer,
            CpuAccessFlags = D3D11CpuAccess.Write,
        };
        _indexBuffer = _device.CreateBuffer(ref desc);
    }

    // ── 帧渲染 ──────────────────────────────────────────────

    /// <summary>
    /// 渲染一帧并回读 BGRA（顶行在前）。调用前须已 csmUpdateModel。
    /// width/height 为物理像素；zoom 为用户缩放（1=默认）。
    /// </summary>
    public byte[] Render(int width, int height, float zoom = 1f)
    {
        if (width <= 0 || height <= 0) throw new ArgumentException("渲染尺寸必须为正。");

        var baseScale = ComputeBaseScale();
        var s = baseScale * zoom;
        _mvpA = 2f * _model.PixelsPerUnit * s / width;
        _mvpD = 2f * _model.PixelsPerUnit * s / height;

        _mainTarget.Resize(width, height);
        foreach (var g in _maskGroups)
        {
            g.Target ??= new RenderTarget(_device, 1, 1);
            g.Target.Resize(width, height);
        }

        var vp = new Viewport { TopLeftX = 0, TopLeftY = 0, Width = width, Height = height, MinDepth = 0, MaxDepth = 1 };
        _ctx.RSSetViewports(&vp);
        _ctx.RSSetState(_rasterizer.Handle);
        _ctx.IASetInputLayout(_layout.Handle);
        _ctx.IASetPrimitiveTopology(4); // TRIANGLELIST
        _ctx.VSSetShader(_vs.Handle);
        _ctx.PSSetSamplers(0, _sampler.Handle);
        _ctx.VSSetConstantBuffers(0, _constants.Handle);
        _ctx.PSSetConstantBuffers(0, _constants.Handle);

        // ── 蒙版 pass（创建序） ──
        foreach (var g in _maskGroups)
        {
            _ctx.OMSetRenderTargets(g.Target.Rtv.Handle);
            _ctx.ClearRenderTargetView(g.Target.Rtv.Handle, 1, 1, 1, 1);
            _ctx.OMSetBlendState(_blendMaskSetup.Handle, 0, 0, 0, 0, 0xFFFFFFFF);
            foreach (var d in g.Members)
            {
                // web 轨低精度路径：蒙版 drawable 按无蒙版绘制（不处理嵌套）
                DrawDrawable(d, _psSetupMask, _atlases, IntPtr.Zero);
            }
        }

        // ── 主 pass ──
        _ctx.OMSetRenderTargets(_mainTarget.Rtv.Handle);
        _ctx.ClearRenderTargetView(_mainTarget.Rtv.Handle, 0, 0, 0, 0);

        var flags = _model.DrawableConstantFlags;
        var dynamic = _model.DrawableDynamicFlags;
        var opacities = _model.DrawableOpacities;
        foreach (var d in _sortedDrawables)
        {
            if ((dynamic[d] & CsmDynamicFlags.IsVisible) == 0) continue;
            if (opacities[d] <= 0f) continue;

            var blend = (flags[d] & CsmConstantFlags.BlendMultiplicative) != 0 ? _blendMultiply
                : (flags[d] & CsmConstantFlags.BlendAdditive) != 0 ? _blendAdd
                : _blendNormal;
            _ctx.OMSetBlendState(blend.Handle, 0, 0, 0, 0, 0xFFFFFFFF);

            var gi = _drawableGroup[d];
            if (gi >= 0)
            {
                var ps = (flags[d] & CsmConstantFlags.IsInvertedMask) != 0 ? _psMaskedInverted : _psMasked;
                DrawDrawable(d, ps, _atlases, GroupSrv(gi));
            }
            else
            {
                DrawDrawable(d, _psNormal, _atlases, IntPtr.Zero);
            }
        }

        _model.ResetDrawableDynamicFlags();
        return _mainTarget.Readback();
    }

    /// <summary>web 轨 baseScale（manager.ts：min(400/W, 500/H, 1)）。</summary>
    public float ComputeBaseScale()
        => Math.Min(BaseWindowWidth / _model.CanvasWidth, Math.Min(BaseWindowHeight / _model.CanvasHeight, 1f));

    private IntPtr GroupSrv(int groupIndex) => _groupsByIndex[groupIndex].Target.Srv.Handle;

    /// <summary>上传单个 drawable 的几何 + 常量并绘制。maskSrv=0 表示不绑 t1。</summary>
    private void DrawDrawable(int d, D3D11PixelShader ps, TextureAtlas[] atlases, IntPtr maskSrv)
    {
        var vertexCount = _model.DrawableVertexCounts[d];
        var indexCount = _model.DrawableIndexCounts[d];
        if (vertexCount <= 0 || indexCount <= 0) return;

        GrowVertex(vertexCount);
        GrowIndex(indexCount);

        // 顶点：float2 pos（模型单位）+ float2 uv（原样，顶行原点）
        var positions = _model.DrawableVertexPositions[d];
        var uvs = _model.DrawableVertexUvs[d];
        var mapped = _ctx.Map(_vertexBuffer.Handle, 0, D3D11Map.WriteDiscard);
        var floats = (float*)mapped.Data;
        for (var i = 0; i < vertexCount; i++)
        {
            floats[i * 4 + 0] = positions[i].X;
            floats[i * 4 + 1] = positions[i].Y;
            floats[i * 4 + 2] = uvs[i].X;
            floats[i * 4 + 3] = uvs[i].Y;
        }
        _ctx.Unmap(_vertexBuffer.Handle, 0);

        var indices = _model.DrawableIndices[d];
        var mappedIdx = _ctx.Map(_indexBuffer.Handle, 0, D3D11Map.WriteDiscard);
        new Span<ushort>(indices, indexCount).CopyTo(new Span<ushort>(mappedIdx.Data, indexCount));
        _ctx.Unmap(_indexBuffer.Handle, 0);

        // 常量：mvp + baseColor(1,1,1,opacity) + multiply + screen + channelFlag(1,0,0,0)
        var multiply = _model.DrawableMultiplyColors[d];
        var screen = _model.DrawableScreenColors[d];
        _constantData[0] = _mvpA; _constantData[1] = 0; _constantData[2] = 0; _constantData[3] = 0;
        _constantData[4] = 0; _constantData[5] = _mvpD; _constantData[6] = 0; _constantData[7] = 0;
        _constantData[8] = 0; _constantData[9] = 0; _constantData[10] = 1; _constantData[11] = 0;
        _constantData[12] = 0; _constantData[13] = 0; _constantData[14] = 0; _constantData[15] = 1;
        _constantData[16] = 1; _constantData[17] = 1; _constantData[18] = 1; _constantData[19] = _model.DrawableOpacities[d] * _model.ModelOpacity;
        _constantData[20] = multiply.X; _constantData[21] = multiply.Y; _constantData[22] = multiply.Z; _constantData[23] = 1;
        _constantData[24] = screen.X; _constantData[25] = screen.Y; _constantData[26] = screen.Z; _constantData[27] = 1;
        _constantData[28] = 1; _constantData[29] = 0; _constantData[30] = 0; _constantData[31] = 0;

        var mappedCb = _ctx.Map(_constants.Handle, 0, D3D11Map.WriteDiscard);
        fixed (float* src = _constantData)
        {
            Buffer.MemoryCopy(src, mappedCb.Data, Shaders.ConstantBufferSize, Shaders.ConstantBufferSize);
        }
        _ctx.Unmap(_constants.Handle, 0);

        var texIndex = _model.DrawableTextureIndices[d];
        _ctx.PSSetShaderResources(0, atlases[texIndex].Srv.Handle);
        _ctx.PSSetShaderResources(1, maskSrv);
        _ctx.PSSetShader(ps.Handle);
        _ctx.IASetVertexBuffers(0, _vertexBuffer.Handle, 16, 0);
        _ctx.IASetIndexBuffer(_indexBuffer.Handle, DxgiFormat.R16_UINT, 0);
        _ctx.DrawIndexed((uint)indexCount, 0, 0);
    }

    public void Dispose()
    {
        _mainTarget.Dispose();
        foreach (var g in _maskGroups) g.Target?.Dispose();
        _vertexBuffer?.Dispose();
        _indexBuffer?.Dispose();
        _constants.Dispose();
        _sampler.Dispose();
        _rasterizer.Dispose();
        _blendNormal.Dispose();
        _blendAdd.Dispose();
        _blendMultiply.Dispose();
        _blendMaskSetup.Dispose();
        _layout.Dispose();
        _vs.Dispose();
        _psNormal.Dispose();
        _psSetupMask.Dispose();
        _psMasked.Dispose();
        _psMaskedInverted.Dispose();
        foreach (var a in _atlases) a?.Dispose();
        _device.Dispose();
    }
}

// Cubism 渲染器（T2 主体）：D3D11 离屏渲染 → BGRA 回读。
//
// 逐帧流程（对照 pixi-live2d-display WebGL 路径，cubism4.es.js）：
//   1. 按 csmGetRenderOrders 逆排列排序 drawable（sorted[order[i]]=i）；
//   2. 蒙版 pass：256×256 RGBA 图集（pld 默认 maskBufferCount=1、低精度路径），
//      组按 setupLayoutBounds 网格布局 + RGBA 通道打包；清 (1,1,1,1)，
//      ZERO/INV_SRC_COLOR 混合写入 channelFlag*alpha*isInside；
//      组序=创建序，蒙版 drawable 按无蒙版绘制（不处理嵌套蒙版）；
//   3. 主 pass：4x MSAA（pixi antialias:true），清 (0,0,0,0)，按序绘制；
//      Normal/Add/Multiply 三混合态，multiply/screen 色 + 不透明度在 PS 内合成；
//   4. resolve + 回读主 RT（BGRA 顶行序，与 DIB/PNG 一致）。
//
// 变换（与 web 轨逐像素对齐的关键，推导见 docs/design/2026-11-17-live2d-dotnet-sidecar.md）：
//   pld: centering = scale(ppu) + translate(W/2,H/2)，anchor(0.5,0.5) 居中，
//        draw() 翻 Y 后进 GL；pixi projection 再翻回——净效果：
//        screen_x = x*ppu*s + winW/2, screen_y = -y*ppu*s + winH/2（y 向下）。
//   本实现直接构造 NDC（y 向上）：MVP = scale(2*ppu*s/winW, 2*ppu*s/winH)。
//   s = baseScale*zoom，baseScale = min(400/W, 500/H, 1)（manager.ts 同值）。
//   与 pld 一致忽略 CanvasOrigin（pld 恒按 W/2,H/2 居中；Cyrene 模型 origin 即中心）。
//
// 蒙版布局矩阵链（pld setupClippingContext 低精度分支同式）：
//   bounds = 被蒙版 drawable 顶点并集，外扩 5%；scale = layoutBounds/bounds；
//   matrixForDraw = T(layout)·S(scale)·T(-bounds)（模型坐标→图集 [0,1]）；
//   matrixForMask = T(-1,-1)·S(2,2)·matrixForDraw（→单元格 clip [-1,1]）。

using CyreneLive2D.Core;
using CyreneLive2D.Model;
using CyreneLive2D.Rendering.D3D11;

namespace CyreneLive2D.Rendering;

internal sealed unsafe class CubismRenderer : IDisposable
{
    /// <summary>基础窗口尺寸（src/renderer/live2d/manager.ts PET_WINDOW_BASE_*）。</summary>
    public const float BaseWindowWidth = 400f;
    public const float BaseWindowHeight = 500f;

    /// <summary>蒙版图集尺寸（pld CubismClippingManager_WebGL._clippingMaskBufferSize）。</summary>
    private const int MaskBufferSize = 256;
    /// <summary>单图集蒙版组上限（pld ClippingMaskMaxCountOnDefault）。</summary>
    private const int MaxGroupsPerAtlas = 36;
    private const float MaskMargin = 0.05f;

    private static readonly float[][] ChannelColors =
    {
        new[] { 1f, 0f, 0f, 0f }, // R
        new[] { 0f, 1f, 0f, 0f }, // G
        new[] { 0f, 0f, 1f, 0f }, // B
        new[] { 0f, 0f, 0f, 1f }, // A
    };

    private static readonly float[] Identity =
    {
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        0, 0, 0, 1,
    };

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
    private readonly RenderTarget _maskAtlas;
    private readonly MaskGroup[] _maskGroups;      // 创建序（= web 渲染序）
    private readonly int[] _sortedDrawables;
    private readonly int[] _drawableGroup;   // drawable → 蒙版组索引（-1 = 无蒙版）

    private readonly float[] _constantData = new float[Shaders.ConstantBufferSize / 4];
    private readonly float[] _mainMvp = new float[16];

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

        // ── 状态对象（混合态表逐条对照 pld setupShaderProgram） ──
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
        _maskGroups = DiscoverMaskGroups();

        _mainTarget = new RenderTarget(_device, 1, 1, samples: 4); // pixi antialias:true
        _maskAtlas = new RenderTarget(_device, MaskBufferSize, MaskBufferSize);
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
        public int[] Members = Array.Empty<int>();          // 蒙版形状（_clippingIdList，原序）
        public readonly List<int> Clipped = new();          // 被蒙版 drawable（_clippedDrawableIndexList）
        public int Channel;                                 // 布局通道（0-3）
        public float LayoutX, LayoutY, LayoutW, LayoutH;    // 图集单元格 [0,1]
        public bool IsUsing;
        public readonly float[] MatMask = new float[16];    // 模型坐标 → 单元格 clip
        public readonly float[] MatDraw = new float[16];    // 模型坐标 → 图集 [0,1]
    }

    /// <summary>
    /// 相同蒙版集合（无序）的 drawable 共享一个蒙版组——分组语义与 web 轨
    /// CubismClippingManager.initialize（findSameClip）一致。组序 = 创建顺序
    /// （drawable 索引扫描的首现序），与 web 轨 setupClippingContext 遍历顺序一致。
    /// web 轨低精度蒙版路径不处理嵌套蒙版（蒙版 drawable 自身按无蒙版绘制）。
    /// </summary>
    private MaskGroup[] DiscoverMaskGroups()
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
            groups[gi].Clipped.Add(i);
            _drawableGroup[i] = gi;
        }

        if (groups.Count > MaxGroupsPerAtlas)
            throw new NotSupportedException($"蒙版组数 {groups.Count} 超单图集上限 {MaxGroupsPerAtlas}（pld 多图集路径未移植）。");
        return groups.ToArray();
    }

    /// <summary>
    /// pld setupLayoutBounds 同式（renderTextureCount=1）：≤4 组每通道一格，
    /// 5-6 组按 2,2,1,1 分配；单元格网格 1/2/4/9 宫格。
    /// </summary>
    private void SetupLayoutBounds(int usingCount)
    {
        if (usingCount <= 0 || usingCount > MaxGroupsPerAtlas)
        {
            foreach (var g in _maskGroups)
            {
                g.Channel = 0;
                g.LayoutX = 0; g.LayoutY = 0; g.LayoutW = 1; g.LayoutH = 1;
            }
            return;
        }
        var div = usingCount / 4;
        var mod = usingCount % 4;
        var cur = 0;
        for (var ch = 0; ch < 4; ch++)
        {
            var layoutCount = div + (ch < mod ? 1 : 0);
            for (var i = 0; i < layoutCount; i++)
            {
                var g = _maskGroups[cur++];
                g.Channel = ch;
                if (layoutCount == 1)
                {
                    g.LayoutX = 0; g.LayoutY = 0; g.LayoutW = 1; g.LayoutH = 1;
                }
                else if (layoutCount == 2)
                {
                    g.LayoutX = (i % 2) * 0.5f; g.LayoutY = 0; g.LayoutW = 0.5f; g.LayoutH = 1;
                }
                else if (layoutCount <= 4)
                {
                    g.LayoutX = (i % 2) * 0.5f; g.LayoutY = (i / 2) * 0.5f; g.LayoutW = 0.5f; g.LayoutH = 0.5f;
                }
                else
                {
                    g.LayoutX = (i % 3) / 3f; g.LayoutY = (i / 3) / 3f; g.LayoutW = 1f / 3; g.LayoutH = 1f / 3;
                }
            }
        }
    }

    /// <summary>被蒙版 drawable 顶点并集（模型坐标）+ 5% 外扩 + 布局矩阵链。</summary>
    private void UpdateMaskMatrices(MaskGroup g)
    {
        // pld calcClippedDrawTotalBounds 的外层 maxX/maxY 初始为 Number.MIN_VALUE
        // （≈+5e-324，非负无穷）：全负坐标的组上界被撑到 ≈0。逐像素对齐须复现
        // 该语义（float 下 5e-324 即 0）；有正顶点时真实最大值照常生效。
        float minX = float.MaxValue, minY = float.MaxValue, maxX = 0f, maxY = 0f;
        var positions = _model.DrawableVertexPositions;
        var counts = _model.DrawableVertexCounts;
        foreach (var d in g.Clipped)
        {
            for (var v = 0; v < counts[d]; v++)
            {
                var p = positions[d][v];
                if (p.X < minX) minX = p.X;
                if (p.X > maxX) maxX = p.X;
                if (p.Y < minY) minY = p.Y;
                if (p.Y > maxY) maxY = p.Y;
            }
        }
        if (minX == float.MaxValue)
        {
            g.IsUsing = false;
            return;
        }
        g.IsUsing = true;
        var w = maxX - minX;
        var h = maxY - minY;
        var bx = minX - w * MaskMargin;
        var by = minY - h * MaskMargin;
        var bw = w * (1 + 2 * MaskMargin);
        var bh = h * (1 + 2 * MaskMargin);
        var sx = g.LayoutW / bw;
        var sy = g.LayoutH / bh;
        var tx = g.LayoutX - bx * sx;
        var ty = g.LayoutY - by * sy;

        // 行主序（HLSL mul(行向量, 矩阵)）：平移在第 4 行。
        g.MatDraw[0] = sx; g.MatDraw[5] = sy; g.MatDraw[10] = 1; g.MatDraw[15] = 1;
        g.MatDraw[12] = tx; g.MatDraw[13] = ty;
        g.MatMask[0] = 2 * sx; g.MatMask[5] = 2 * sy; g.MatMask[10] = 1; g.MatMask[15] = 1;
        g.MatMask[12] = 2 * tx - 1; g.MatMask[13] = 2 * ty - 1;
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
        var mvpA = 2f * _model.PixelsPerUnit * s / width;
        var mvpD = 2f * _model.PixelsPerUnit * s / height;
        Array.Copy(Identity, _mainMvp, 16);
        _mainMvp[0] = mvpA;
        _mainMvp[5] = mvpD;

        _mainTarget.Resize(width, height);

        _ctx.RSSetState(_rasterizer.Handle);
        _ctx.IASetInputLayout(_layout.Handle);
        _ctx.IASetPrimitiveTopology(4); // TRIANGLELIST
        _ctx.VSSetShader(_vs.Handle);
        _ctx.PSSetSamplers(0, _sampler.Handle);
        _ctx.VSSetConstantBuffers(0, _constants.Handle);
        _ctx.PSSetConstantBuffers(0, _constants.Handle);

        // ── 蒙版 pass（创建序；256 图集，清 1，通道打包） ──
        var usingCount = 0;
        foreach (var g in _maskGroups)
        {
            UpdateMaskMatrices(g);
            if (g.IsUsing) usingCount++;
        }
        SetupLayoutBounds(usingCount);
        // 布局变化后矩阵需按新单元格重算（pld 同帧内先布局后矩阵）
        foreach (var g in _maskGroups) if (g.IsUsing) UpdateMaskMatrices(g);

        if (usingCount > 0)
        {
            var mvp = new Viewport { TopLeftX = 0, TopLeftY = 0, Width = MaskBufferSize, Height = MaskBufferSize, MinDepth = 0, MaxDepth = 1 };
            _ctx.RSSetViewports(&mvp);
            _ctx.OMSetRenderTargets(_maskAtlas.Rtv.Handle);
            _ctx.ClearRenderTargetView(_maskAtlas.Rtv.Handle, 1, 1, 1, 1);
            _ctx.OMSetBlendState(_blendMaskSetup.Handle, 0, 0, 0, 0, 0xFFFFFFFF);
            foreach (var g in _maskGroups)
            {
                if (!g.IsUsing) continue;
                var ch = ChannelColors[g.Channel];
                _constantData[16] = 2 * g.LayoutX - 1;
                _constantData[17] = 2 * g.LayoutY - 1;
                _constantData[18] = 2 * (g.LayoutX + g.LayoutW) - 1;
                _constantData[19] = 2 * (g.LayoutY + g.LayoutH) - 1;
                _constantData[28] = ch[0]; _constantData[29] = ch[1]; _constantData[30] = ch[2]; _constantData[31] = ch[3];
                Array.Copy(g.MatMask, 0, _constantData, 32, 16);
                foreach (var d in g.Members)
                {
                    // web 轨低精度路径：蒙版 drawable 按无蒙版绘制（不处理嵌套）
                    DrawDrawable(d, _psSetupMask, IntPtr.Zero, g.MatMask);
                }
            }
        }

        // ── 主 pass ──
        var vp = new Viewport { TopLeftX = 0, TopLeftY = 0, Width = width, Height = height, MinDepth = 0, MaxDepth = 1 };
        _ctx.RSSetViewports(&vp);
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

            _constantData[16] = 1; _constantData[17] = 1; _constantData[18] = 1;
            var gi = _drawableGroup[d];
            if (gi >= 0)
            {
                var g = _maskGroups[gi];
                var ch = ChannelColors[g.Channel];
                _constantData[28] = ch[0]; _constantData[29] = ch[1]; _constantData[30] = ch[2]; _constantData[31] = ch[3];
                Array.Copy(g.MatDraw, 0, _constantData, 32, 16);
                var ps = (flags[d] & CsmConstantFlags.IsInvertedMask) != 0 ? _psMaskedInverted : _psMasked;
                DrawDrawable(d, ps, _maskAtlas.Srv.Handle, _mainMvp);
            }
            else
            {
                _constantData[28] = 1; _constantData[29] = 0; _constantData[30] = 0; _constantData[31] = 0;
                Array.Copy(Identity, 0, _constantData, 32, 16);
                DrawDrawable(d, _psNormal, IntPtr.Zero, _mainMvp);
            }
        }

        _model.ResetDrawableDynamicFlags();
        return _mainTarget.Readback();
    }

    /// <summary>web 轨 baseScale（manager.ts：min(400/W, 500/H, 1)）。</summary>
    public float ComputeBaseScale()
        => Math.Min(BaseWindowWidth / _model.CanvasWidth, Math.Min(BaseWindowHeight / _model.CanvasHeight, 1f));

    /// <summary>
    /// 上传单个 drawable 的几何并绘制。mvp 行主序 16 float；maskSrv=0 表示不绑 t1。
    /// baseColor.rgb/channelFlag/maskMatrix 由调用方预置 _constantData[16..47]；
    /// 本方法写 mvp、baseColor.a（不透明度）、multiply/screen。
    /// </summary>
    private void DrawDrawable(int d, D3D11PixelShader ps, IntPtr maskSrv, float[] mvp)
    {
        var vertexCount = _model.DrawableVertexCounts[d];
        var indexCount = _model.DrawableIndexCounts[d];
        if (vertexCount <= 0 || indexCount <= 0) return;

        GrowVertex(vertexCount);
        GrowIndex(indexCount);

        // 顶点：float2 pos（模型单位）+ float2 uv（原样，VS 内翻 V）
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

        Array.Copy(mvp, 0, _constantData, 0, 16);
        // setup pass 的 baseColor 整体是单元格 clip 边界（含 .w），不被不透明度覆盖
        if (ps != _psSetupMask)
            _constantData[19] = _model.DrawableOpacities[d] * _model.ModelOpacity;
        var multiply = _model.DrawableMultiplyColors[d];
        var screen = _model.DrawableScreenColors[d];
        _constantData[20] = multiply.X; _constantData[21] = multiply.Y; _constantData[22] = multiply.Z; _constantData[23] = 1;
        _constantData[24] = screen.X; _constantData[25] = screen.Y; _constantData[26] = screen.Z; _constantData[27] = 1;

        var mappedCb = _ctx.Map(_constants.Handle, 0, D3D11Map.WriteDiscard);
        fixed (float* src = _constantData)
        {
            Buffer.MemoryCopy(src, mappedCb.Data, Shaders.ConstantBufferSize, Shaders.ConstantBufferSize);
        }
        _ctx.Unmap(_constants.Handle, 0);

        var texIndex = _model.DrawableTextureIndices[d];
        _ctx.PSSetShaderResources(0, AtlasSrv(texIndex));
        _ctx.PSSetShaderResources(1, maskSrv);
        _ctx.PSSetShader(ps.Handle);
        _ctx.IASetVertexBuffers(0, _vertexBuffer.Handle, 16, 0);
        _ctx.IASetIndexBuffer(_indexBuffer.Handle, DxgiFormat.R16_UINT, 0);
        _ctx.DrawIndexed((uint)indexCount, 0, 0);
    }

    private IntPtr AtlasSrv(int texIndex) => _atlases[texIndex].Srv.Handle;

    public void Dispose()
    {
        _mainTarget.Dispose();
        _maskAtlas.Dispose();
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
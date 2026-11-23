// D3D11 COM interop（手写 P/Invoke，零 NuGet 依赖——任务书「部署纯净」）。
//
// 只声明渲染器用到的接口子集；vtable 槽位按 Wine d3d11.idl 逐条核对，
// 并经沙箱 + GPU 真机双探针实证（与 Windows SDK 运行时 ABI 一致）。
// 注意一个反直觉的 ABI 事实：
//   ID3D11Device 直接继承 IUnknown（无 DeviceChild 前缀，CreateBuffer 紧接 IUnknown；
//   PrivateData 三方法在尾部 34-36），而 ID3D11DeviceContext 有前缀（3=GetDevice）。
//   IUnknown: 0 QI / 1 AddRef / 2 Release
//   ID3D11Device: 3 CreateBuffer / 5 CreateTexture2D / 7 CreateSRV /
//                 9 CreateRTV / 11 CreateInputLayout / 12 CreateVS /
//                 15 CreatePS / 20 CreateBlendState / 22 CreateRasterizerState /
//                 23 CreateSamplerState / 37 GetFeatureLevel / 38 GetCreationFlags /
//                 39 GetDeviceRemovedReason / 40 GetImmediateContext（恒定）
//   ID3D11DeviceContext: 7 VSSetConstantBuffers / 8 PSSetShaderResources /
//                 9 PSSetShader / 10 PSSetSamplers / 11 VSSetShader /
//                 12 DrawIndexed / 14 Map / 15 Unmap / 16 PSSetConstantBuffers /
//                 17 IASetInputLayout / 18 IASetVertexBuffers / 19 IASetIndexBuffer /
//                 24 IASetPrimitiveTopology / 33 OMSetRenderTargets /
//                 35 OMSetBlendState / 43 RSSetState / 44 RSSetViewports /
//                 47 CopyResource / 48 UpdateSubresource / 50 ClearRenderTargetView /
//                 57 ResolveSubresource
//   ID3D11Resource: 7 GetType；ID3D11Texture2D: 10 GetDesc
//   ID3D11View: 7 GetResource；ID3DBlob: 3 GetBufferPointer / 4 GetBufferSize
//   IDXGIFactory1: 12 EnumAdapters1；IDXGIAdapter: 8 GetDesc（DXGI_ADAPTER_DESC）
//
// 所有 HRESULT 失败即抛（渲染错误必须显式暴露，不静默花屏）。

using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;

namespace CyreneLive2D.Rendering.D3D11;

internal static unsafe class Com
{
    // obj 首 8 字节 = vtable 指针；必须先解引用取 vtable 再按槽位索引。
    // 易错点：((void***)obj)[i] 读的是对象自身第 i 个字段（少一层 *），
    // 会把数据当函数指针调用 → 0xC0000005。
    public static void* Slot(IntPtr obj, int index) => (*(void***)obj)[index];

    public static void Release(IntPtr obj)
    {
        if (obj != IntPtr.Zero) ((delegate* unmanaged[Stdcall]<IntPtr, uint>)Slot(obj, 2))(obj);
    }

    public static void Check(int hr, string what)
    {
        if (hr < 0) throw new D3D11Exception($"{what} 失败: HRESULT=0x{hr:X8}");
    }
}

public sealed class D3D11Exception : Exception
{
    public D3D11Exception(string message) : base(message) { }
}

// ── 结构体（与 d3d11.h 布局一致，x64） ─────────────────────

[StructLayout(LayoutKind.Sequential)]
internal struct Texture2DDesc
{
    public uint Width, Height, MipLevels, ArraySize;
    public uint Format;            // DXGI_FORMAT
    public uint SampleCount, SampleQuality;
    public uint Usage;             // D3D11_USAGE
    public uint BindFlags;
    public uint CpuAccessFlags;
    public uint MiscFlags;
}

[StructLayout(LayoutKind.Sequential)]
internal struct BufferDesc
{
    public uint ByteWidth, Usage, BindFlags, CpuAccessFlags, MiscFlags, StructureByteStride;
}

[StructLayout(LayoutKind.Sequential)]
internal unsafe struct SubresourceData
{
    public void* SysMem;
    public uint SysMemPitch, SysMemSlicePitch;
}

[StructLayout(LayoutKind.Sequential)]
internal struct Viewport
{
    public float TopLeftX, TopLeftY, Width, Height, MinDepth, MaxDepth;
}

[StructLayout(LayoutKind.Sequential)]
internal struct RenderTargetBlendDesc
{
    public int BlendEnable;
    public uint SrcBlend, DestBlend, BlendOp;
    public uint SrcBlendAlpha, DestBlendAlpha, BlendOpAlpha;
    public byte RenderTargetWriteMask;
    private byte _pad1, _pad2, _pad3;
}

[StructLayout(LayoutKind.Sequential)]
internal struct BlendDesc
{
    public int AlphaToCoverageEnable;
    public int IndependentBlendEnable;
    public RenderTargetBlendDesc RenderTarget0;
    // 其余 7 个 RT 槽位不用（IndependentBlendEnable=0），但结构体尺寸必须完整
    private RenderTargetBlendDesc _rt1, _rt2, _rt3, _rt4, _rt5, _rt6, _rt7;
}

[StructLayout(LayoutKind.Sequential)]
internal struct RasterizerDesc
{
    public uint FillMode;          // 3 = SOLID
    public uint CullMode;          // 1 = NONE
    public int FrontCounterClockwise;
    public int DepthBias;
    public float DepthBiasClamp, SlopeScaledDepthBias;
    public int DepthClipEnable, ScissorEnable, MultisampleEnable, AntialiasedLineEnable;
}

[StructLayout(LayoutKind.Sequential)]
internal struct SamplerDesc
{
    public uint Filter;
    public uint AddressU, AddressV, AddressW;
    public float MipLODBias;
    public uint MaxAnisotropy;
    public uint ComparisonFunc;
    public float BorderR, BorderG, BorderB, BorderA;
    public float MinLOD, MaxLOD;
}

[StructLayout(LayoutKind.Sequential)]
internal unsafe struct InputElementDesc
{
    public byte* SemanticName;
    public uint SemanticIndex;
    public uint Format;
    public uint InputSlot;
    public uint AlignedByteOffset;
    public uint InputSlotClass;
    public uint InstanceDataStepRate;
}

[StructLayout(LayoutKind.Sequential)]
internal unsafe struct MappedSubresource
{
    public void* Data;
    public uint RowPitch, DepthPitch;
}

// DXGI_ADAPTER_DESC（dxgi.h，x64）。Description 用 fixed char 保持 blittable
// （delegate* unmanaged 函数指针不做MarshalAs 编组）；WCHAR[128] 保证 null 终结。
[StructLayout(LayoutKind.Sequential)]
internal unsafe struct DxgiAdapterDesc
{
    public fixed char Description[128];
    public uint VendorId, DeviceId, SubSysId, Revision;
    public nuint DedicatedVideoMemory, DedicatedSystemMemory, SharedSystemMemory;
    public long AdapterLuid;
}

internal static class DxgiFormat
{
    public const uint R32G32_FLOAT = 16;
    public const uint R32G32B32A32_FLOAT = 2;
    public const uint B8G8R8A8_UNORM = 87;
    public const uint R16_UINT = 57; // DXGI_FORMAT_R16_UINT（53 TYPELESS/54 FLOAT/55 D16/56 UNORM/57 UINT/58 SNORM/59 SINT）
}

internal static class D3D11Usage
{
    public const uint Default = 0, Immutable = 1, Dynamic = 2, Staging = 3;
}

internal static class D3D11Bind
{
    public const uint VertexBuffer = 1, IndexBuffer = 2, ConstantBuffer = 4, ShaderResource = 8, RenderTarget = 0x20;
}

internal static class D3D11CpuAccess
{
    public const uint Write = 0x10000, Read = 0x20000;
}

internal static class D3D11Map
{
    public const uint Read = 1, Write = 2, ReadWrite = 3, WriteDiscard = 4;
}

internal static class D3D11Blend
{
    public const uint Zero = 1, One = 2, SrcColor = 3, InvSrcColor = 4, SrcAlpha = 5, InvSrcAlpha = 6,
        DstAlpha = 7, InvDstAlpha = 8, DstColor = 9, InvDstColor = 10;
    public const uint OpAdd = 1;
}

// ── 接口包装 ────────────────────────────────────────────────

internal sealed unsafe class D3D11Device : IDisposable
{
    public IntPtr Handle;
    public D3D11Context ImmediateContext = null!;

    public static D3D11Device Create()
    {
        IntPtr device = IntPtr.Zero, context = IntPtr.Zero;
        uint featureLevel = 0;
        // D3D11_CREATE_DEVICE_BGRA_SUPPORT = 0x20。
        // 多适配器机器（云桌面/无头独显）默认适配器可能是虚拟显示的
        // Microsoft Basic Render Driver（软件）——NULL+HARDWARE 会静默落在它上面
        // （GPU 真机实证：adapter[0]=Basic Render Driver，独显在 [1]）。
        // 故先枚举 DXGI 显式选首个有专用显存的适配器；指定适配器时 driverType 必须 UNKNOWN(0)。
        var adapter = PickHardwareAdapter(out var adapterName);
        var hr = -1;
        if (adapter != IntPtr.Zero)
        {
            hr = D3D11Native.D3D11CreateDevice(adapter, 0 /*UNKNOWN*/, IntPtr.Zero, 0x20,
                null, 0, 7, &device, &featureLevel, &context);
            Com.Release(adapter);
            if (hr >= 0) Console.Error.WriteLine($"[d3d11] adapter={adapterName}");
        }
        if (hr < 0)
        {
            // 无独显适配器/创建失败：默认适配器硬件 → WARP（软件）
            hr = D3D11Native.D3D11CreateDevice(IntPtr.Zero, 1 /*HARDWARE*/, IntPtr.Zero, 0x20,
                null, 0, 7, &device, &featureLevel, &context);
            if (hr < 0)
            {
                hr = D3D11Native.D3D11CreateDevice(IntPtr.Zero, 5 /*WARP*/, IntPtr.Zero, 0x20,
                    null, 0, 7, &device, &featureLevel, &context);
                if (hr >= 0) Console.Error.WriteLine("[d3d11] adapter=WARP（软件回退）");
            }
            else Console.Error.WriteLine("[d3d11] adapter=默认（未找到专用显存适配器）");
        }
        Com.Check(hr, "D3D11CreateDevice");
        var d = new D3D11Device { Handle = device, ImmediateContext = new D3D11Context { Handle = context } };
        return d;
    }

    /// <summary>枚举 DXGI 适配器，返回首个 DedicatedVideoMemory&gt;0 者（调用方 Release）；无则 IntPtr.Zero。</summary>
    private static unsafe IntPtr PickHardwareAdapter(out string name)
    {
        name = "";
        var iid = new Guid("770aae78-f26f-4dba-a829-253c83d1b387"); // IDXGIFactory1
        IntPtr factory;
        if (D3D11Native.CreateDXGIFactory1(&iid, &factory) < 0) return IntPtr.Zero;
        try
        {
            var enumFn = (delegate* unmanaged[Stdcall]<IntPtr, uint, IntPtr*, int>)Com.Slot(factory, 12);
            for (uint i = 0; ; i++)
            {
                IntPtr ad;
                if (enumFn(factory, i, &ad) < 0) break; // DXGI_ERROR_NOT_FOUND 终结
                var descFn = (delegate* unmanaged[Stdcall]<IntPtr, DxgiAdapterDesc*, int>)Com.Slot(ad, 8);
                DxgiAdapterDesc desc;
                if (descFn(ad, &desc) >= 0 && desc.DedicatedVideoMemory > 0)
                {
                    name = new string(desc.Description);
                    return ad;
                }
                Com.Release(ad);
            }
        }
        finally { Com.Release(factory); }
        return IntPtr.Zero;
    }

    public D3D11Texture2D CreateTexture2D(ref Texture2DDesc desc, SubresourceData* initial = null)
    {
        IntPtr tex;
        var hr = ((delegate* unmanaged[Stdcall]<IntPtr, Texture2DDesc*, SubresourceData*, IntPtr*, int>)Com.Slot(Handle, 5))(Handle, (Texture2DDesc*)Unsafe.AsPointer(ref desc), initial, &tex);
        Com.Check(hr, "CreateTexture2D");
        return new D3D11Texture2D { Handle = tex };
    }

    public D3D11ShaderResourceView CreateShaderResourceView(IntPtr resource)
    {
        IntPtr srv;
        var hr = ((delegate* unmanaged[Stdcall]<IntPtr, IntPtr, void*, IntPtr*, int>)Com.Slot(Handle, 7))(Handle, resource, null, &srv);
        Com.Check(hr, "CreateShaderResourceView");
        return new D3D11ShaderResourceView { Handle = srv };
    }

    public D3D11RenderTargetView CreateRenderTargetView(IntPtr resource)
    {
        IntPtr rtv;
        var hr = ((delegate* unmanaged[Stdcall]<IntPtr, IntPtr, void*, IntPtr*, int>)Com.Slot(Handle, 9))(Handle, resource, null, &rtv);
        Com.Check(hr, "CreateRenderTargetView");
        return new D3D11RenderTargetView { Handle = rtv };
    }

    public D3D11Buffer CreateBuffer(ref BufferDesc desc, SubresourceData* initial = null)
    {
        IntPtr buf;
        var hr = ((delegate* unmanaged[Stdcall]<IntPtr, BufferDesc*, SubresourceData*, IntPtr*, int>)Com.Slot(Handle, 3))(Handle, (BufferDesc*)Unsafe.AsPointer(ref desc), initial, &buf);
        Com.Check(hr, "CreateBuffer");
        return new D3D11Buffer { Handle = buf };
    }

    public D3D11InputLayout CreateInputLayout(InputElementDesc* elements, int count, void* shaderBytecode, nuint bytecodeSize)
    {
        IntPtr layout;
        var hr = ((delegate* unmanaged[Stdcall]<IntPtr, InputElementDesc*, uint, void*, nuint, IntPtr*, int>)Com.Slot(Handle, 11))(Handle, elements, (uint)count, shaderBytecode, bytecodeSize, &layout);
        Com.Check(hr, "CreateInputLayout");
        return new D3D11InputLayout { Handle = layout };
    }

    public D3D11VertexShader CreateVertexShader(void* bytecode, nuint size)
    {
        IntPtr shader;
        var hr = ((delegate* unmanaged[Stdcall]<IntPtr, void*, nuint, void*, IntPtr*, int>)Com.Slot(Handle, 12))(Handle, bytecode, size, null, &shader);
        Com.Check(hr, "CreateVertexShader");
        return new D3D11VertexShader { Handle = shader };
    }

    public D3D11PixelShader CreatePixelShader(void* bytecode, nuint size)
    {
        IntPtr shader;
        var hr = ((delegate* unmanaged[Stdcall]<IntPtr, void*, nuint, void*, IntPtr*, int>)Com.Slot(Handle, 15))(Handle, bytecode, size, null, &shader);
        Com.Check(hr, "CreatePixelShader");
        return new D3D11PixelShader { Handle = shader };
    }

    public D3D11BlendState CreateBlendState(ref BlendDesc desc)
    {
        IntPtr state;
        var hr = ((delegate* unmanaged[Stdcall]<IntPtr, BlendDesc*, IntPtr*, int>)Com.Slot(Handle, 20))(Handle, (BlendDesc*)Unsafe.AsPointer(ref desc), &state);
        Com.Check(hr, "CreateBlendState");
        return new D3D11BlendState { Handle = state };
    }

    public D3D11RasterizerState CreateRasterizerState(ref RasterizerDesc desc)
    {
        IntPtr state;
        var hr = ((delegate* unmanaged[Stdcall]<IntPtr, RasterizerDesc*, IntPtr*, int>)Com.Slot(Handle, 22))(Handle, (RasterizerDesc*)Unsafe.AsPointer(ref desc), &state);
        Com.Check(hr, "CreateRasterizerState");
        return new D3D11RasterizerState { Handle = state };
    }

    public D3D11SamplerState CreateSamplerState(ref SamplerDesc desc)
    {
        IntPtr state;
        var hr = ((delegate* unmanaged[Stdcall]<IntPtr, SamplerDesc*, IntPtr*, int>)Com.Slot(Handle, 23))(Handle, (SamplerDesc*)Unsafe.AsPointer(ref desc), &state);
        Com.Check(hr, "CreateSamplerState");
        return new D3D11SamplerState { Handle = state };
    }

    public void Dispose()
    {
        ImmediateContext?.Dispose();
        Com.Release(Handle);
        Handle = IntPtr.Zero;
    }
}

internal sealed unsafe class D3D11Context : IDisposable
{
    public IntPtr Handle;

    public void VSSetConstantBuffers(uint start, IntPtr buffer)
    {
        var arr = stackalloc IntPtr[1] { buffer };
        ((delegate* unmanaged[Stdcall]<IntPtr, uint, uint, IntPtr*, void>)Com.Slot(Handle, 7))(Handle, start, 1, arr);
    }

    public void PSSetConstantBuffers(uint start, IntPtr buffer)
    {
        var arr = stackalloc IntPtr[1] { buffer };
        ((delegate* unmanaged[Stdcall]<IntPtr, uint, uint, IntPtr*, void>)Com.Slot(Handle, 16))(Handle, start, 1, arr);
    }

    public void PSSetShaderResources(uint start, IntPtr srv)
    {
        var arr = stackalloc IntPtr[1] { srv };
        ((delegate* unmanaged[Stdcall]<IntPtr, uint, uint, IntPtr*, void>)Com.Slot(Handle, 8))(Handle, start, 1, arr);
    }

    public void PSSetShader(IntPtr shader)
        => ((delegate* unmanaged[Stdcall]<IntPtr, IntPtr, void*, uint, void>)Com.Slot(Handle, 9))(Handle, shader, null, 0);

    public void VSSetShader(IntPtr shader)
        => ((delegate* unmanaged[Stdcall]<IntPtr, IntPtr, void*, uint, void>)Com.Slot(Handle, 11))(Handle, shader, null, 0);

    public void PSSetSamplers(uint start, IntPtr sampler)
    {
        var arr = stackalloc IntPtr[1] { sampler };
        ((delegate* unmanaged[Stdcall]<IntPtr, uint, uint, IntPtr*, void>)Com.Slot(Handle, 10))(Handle, start, 1, arr);
    }

    public void IASetInputLayout(IntPtr layout)
        => ((delegate* unmanaged[Stdcall]<IntPtr, IntPtr, void>)Com.Slot(Handle, 17))(Handle, layout);

    public void IASetVertexBuffers(uint start, IntPtr buffer, uint stride, uint offset)
    {
        var bufs = stackalloc IntPtr[1] { buffer };
        var strides = stackalloc uint[1] { stride };
        var offsets = stackalloc uint[1] { offset };
        ((delegate* unmanaged[Stdcall]<IntPtr, uint, uint, IntPtr*, uint*, uint*, void>)Com.Slot(Handle, 18))(Handle, start, 1, bufs, strides, offsets);
    }

    public void IASetIndexBuffer(IntPtr buffer, uint format, uint offset)
        => ((delegate* unmanaged[Stdcall]<IntPtr, IntPtr, uint, uint, void>)Com.Slot(Handle, 19))(Handle, buffer, format, offset);

    public void IASetPrimitiveTopology(uint topology)
        => ((delegate* unmanaged[Stdcall]<IntPtr, uint, void>)Com.Slot(Handle, 24))(Handle, topology);

    public void OMSetRenderTargets(IntPtr rtv)
    {
        var rtvs = stackalloc IntPtr[1] { rtv };
        ((delegate* unmanaged[Stdcall]<IntPtr, uint, IntPtr*, IntPtr, void>)Com.Slot(Handle, 33))(Handle, 1, rtvs, IntPtr.Zero);
    }

    public void OMSetBlendState(IntPtr state, float blendFactor0, float blendFactor1, float blendFactor2, float blendFactor3, uint sampleMask)
    {
        var factor = stackalloc float[4] { blendFactor0, blendFactor1, blendFactor2, blendFactor3 };
        ((delegate* unmanaged[Stdcall]<IntPtr, IntPtr, float*, uint, void>)Com.Slot(Handle, 35))(Handle, state, factor, sampleMask);
    }

    public void RSSetState(IntPtr state)
        => ((delegate* unmanaged[Stdcall]<IntPtr, IntPtr, void>)Com.Slot(Handle, 43))(Handle, state);

    public void RSSetViewports(Viewport* vp)
        => ((delegate* unmanaged[Stdcall]<IntPtr, uint, Viewport*, void>)Com.Slot(Handle, 44))(Handle, 1, vp);

    public void ClearRenderTargetView(IntPtr rtv, float r, float g, float b, float a)
    {
        var color = stackalloc float[4] { r, g, b, a };
        ((delegate* unmanaged[Stdcall]<IntPtr, IntPtr, float*, void>)Com.Slot(Handle, 50))(Handle, rtv, color);
    }

    public void DrawIndexed(uint indexCount, uint startIndex, int baseVertex)
        => ((delegate* unmanaged[Stdcall]<IntPtr, uint, uint, int, void>)Com.Slot(Handle, 12))(Handle, indexCount, startIndex, baseVertex);

    public void CopyResource(IntPtr dst, IntPtr src)
        => ((delegate* unmanaged[Stdcall]<IntPtr, IntPtr, IntPtr, void>)Com.Slot(Handle, 47))(Handle, dst, src);

    /// <summary>UpdateSubresource（vtable 48）：CPU 数据写入默认用法纹理（box=null 全资源）。</summary>
    public void UpdateSubresource(IntPtr resource, uint subresource, IntPtr srcBox, IntPtr mem, uint pitch, uint slicePitch)
        => ((delegate* unmanaged[Stdcall]<IntPtr, IntPtr, uint, IntPtr, IntPtr, uint, uint, void>)Com.Slot(Handle, 48))(Handle, resource, subresource, srcBox, mem, pitch, slicePitch);

    /// <summary>ResolveSubresource（vtable 57）：MSAA 纹理 → 非 MSAA 纹理（读回前必须 resolve）。</summary>
    public void ResolveSubresource(IntPtr dst, uint dstSub, IntPtr src, uint srcSub, uint format)
        => ((delegate* unmanaged[Stdcall]<IntPtr, IntPtr, uint, IntPtr, uint, uint, void>)Com.Slot(Handle, 57))(Handle, dst, dstSub, src, srcSub, format);

    public MappedSubresource Map(IntPtr resource, uint subresource, uint mapType)
    {
        MappedSubresource mapped;
        var hr = ((delegate* unmanaged[Stdcall]<IntPtr, IntPtr, uint, uint, uint, MappedSubresource*, int>)Com.Slot(Handle, 14))(Handle, resource, subresource, mapType, 0, &mapped);
        Com.Check(hr, "Map");
        return mapped;
    }

    public void Unmap(IntPtr resource, uint subresource)
        => ((delegate* unmanaged[Stdcall]<IntPtr, IntPtr, uint, void>)Com.Slot(Handle, 15))(Handle, resource, subresource);

    public void Dispose() { Com.Release(Handle); Handle = IntPtr.Zero; }
}

internal sealed class D3D11Texture2D : IDisposable
{
    public IntPtr Handle;
    public void Dispose() { Com.Release(Handle); Handle = IntPtr.Zero; }
}

internal sealed class D3D11ShaderResourceView : IDisposable
{
    public IntPtr Handle;
    public void Dispose() { Com.Release(Handle); Handle = IntPtr.Zero; }
}

internal sealed class D3D11RenderTargetView : IDisposable
{
    public IntPtr Handle;
    public void Dispose() { Com.Release(Handle); Handle = IntPtr.Zero; }
}

internal sealed class D3D11Buffer : IDisposable
{
    public IntPtr Handle;
    public void Dispose() { Com.Release(Handle); Handle = IntPtr.Zero; }
}

internal sealed class D3D11InputLayout : IDisposable
{
    public IntPtr Handle;
    public void Dispose() { Com.Release(Handle); Handle = IntPtr.Zero; }
}

internal sealed class D3D11VertexShader : IDisposable
{
    public IntPtr Handle;
    public void Dispose() { Com.Release(Handle); Handle = IntPtr.Zero; }
}

internal sealed class D3D11PixelShader : IDisposable
{
    public IntPtr Handle;
    public void Dispose() { Com.Release(Handle); Handle = IntPtr.Zero; }
}

internal sealed class D3D11BlendState : IDisposable
{
    public IntPtr Handle;
    public void Dispose() { Com.Release(Handle); Handle = IntPtr.Zero; }
}

internal sealed class D3D11RasterizerState : IDisposable
{
    public IntPtr Handle;
    public void Dispose() { Com.Release(Handle); Handle = IntPtr.Zero; }
}

internal sealed class D3D11SamplerState : IDisposable
{
    public IntPtr Handle;
    public void Dispose() { Com.Release(Handle); Handle = IntPtr.Zero; }
}

internal sealed unsafe class ShaderBlob : IDisposable
{
    public IntPtr Handle;
    public void* BufferPointer => ((delegate* unmanaged[Stdcall]<IntPtr, void*>)Com.Slot(Handle, 3))(Handle);
    public nuint BufferSize => ((delegate* unmanaged[Stdcall]<IntPtr, nuint>)Com.Slot(Handle, 4))(Handle);
    public string? AsString() => Marshal.PtrToStringAnsi((IntPtr)BufferPointer, (int)BufferSize);
    public void Dispose() { Com.Release(Handle); Handle = IntPtr.Zero; }
}

internal static unsafe class D3D11Native
{
    [DllImport("d3d11.dll")]
    public static extern int D3D11CreateDevice(IntPtr adapter, uint driverType, IntPtr software, uint flags,
        uint* featureLevels, uint featureLevelsCount, uint sdkVersion, IntPtr* device, uint* featureLevel, IntPtr* context);

    [DllImport("dxgi.dll")]
    public static extern int CreateDXGIFactory1(Guid* riid, IntPtr* ppFactory);

    [DllImport("d3dcompiler_47.dll")]
    public static extern int D3DCompile(void* srcData, nuint srcDataSize, byte* sourceName, void* defines, void* include,
        byte* entrypoint, byte* target, uint flags1, uint flags2, IntPtr* code, IntPtr* errorMsgs);

    /// <summary>编译 HLSL（失败抛异常，含编译器日志）。</summary>
    public static ShaderBlob Compile(string source, string entrypoint, string target)
    {
        var srcBytes = System.Text.Encoding.UTF8.GetBytes(source);
        var entryBytes = System.Text.Encoding.UTF8.GetBytes(entrypoint + "\0");
        var targetBytes = System.Text.Encoding.UTF8.GetBytes(target + "\0");
        fixed (void* src = srcBytes)
        fixed (byte* entry = entryBytes)
        fixed (byte* tgt = targetBytes)
        {
            IntPtr code = IntPtr.Zero, errors = IntPtr.Zero;
            var hr = D3DCompile(src, (nuint)srcBytes.Length, null, null, null, entry, tgt, 0, 0, &code, &errors);
            if (hr < 0)
            {
                var msg = errors != IntPtr.Zero ? new ShaderBlob { Handle = errors }.AsString() : null;
                if (errors != IntPtr.Zero) Com.Release(errors);
                throw new D3D11Exception($"HLSL 编译失败 ({entrypoint}/{target}): {msg}");
            }
            if (errors != IntPtr.Zero) Com.Release(errors);
            return new ShaderBlob { Handle = code };
        }
    }
}

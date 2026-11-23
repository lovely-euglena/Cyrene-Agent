// gpu-probe.cs — D3D11 手写 interop 最小诊断探针（issue #257 T2）。
//
// 目的：逐步验证 vtable 槽位与结构体布局。每步先写日志再调用，崩溃时日志
// 最后一行即崩溃点。日志文件：exe 同目录 gpu-probe-log.txt。
//
// 编译（任意 Windows，内置 .NET Framework csc，C# 7.3）：
//   C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /platform:x64 /optimize+ /unsafe /out:gpu-probe.exe gpu-probe.cs
// 运行：gpu-probe.exe，把 gpu-probe-log.txt 发回。
//
// vtable 布局（Wine d3d11.idl 逐条核对 + 沙箱/真机双探针实证，2026-11）：
//   ID3D11Device : IUnknown（无 DeviceChild 前缀！PrivateData 三方法在尾部 34-36）：
//     CreateBuffer=3, Texture2D=5, SRV=7, RTV=9, InputLayout=11, VS=12, PS=15,
//     Blend=20, Rasterizer=22, Sampler=23；GetFeatureLevel=37, GetCreationFlags=38,
//     GetDeviceRemovedReason=39, GetImmediateContext=40（恒定，与 Windows 版本无关）。
//   ID3D11DeviceContext : ID3D11DeviceChild（有前缀，3=GetDevice）：VSSetCB=7,
//     PSSetSRV=8, PSSetShader=9, PSSetSamplers=10, VSSetShader=11, DrawIndexed=12,
//     Map=14, Unmap=15, PSSetCB=16, IASetLayout=17, IASetVB=18, IASetIB=19,
//     Topology=24, OMSetRT=33, OMSetBlend=35, RSSetState=43, RSSetViewports=44,
//     CopyResource=47, ClearRTV=50。
//   易错点 1：取槽位必须先解引用 vtable 指针——(*(void***)obj)[i]；
//     ((void***)obj)[i] 读的是对象自身字段（少一层 *）→ 0xC0000005。
//   易错点 2：输入布局语义名——HLSL `: TEXCOORD0` 的签名是 "TEXCOORD"+索引 0，
//     布局写 "TEXCOORD0" 会 E_INVALIDARG（#257 根因，曾误判为沙箱环境缺陷）。

using System;
using System.IO;
using System.Runtime.InteropServices;

static unsafe class GpuProbe
{
    // ── 结构体（d3d11.h 布局，x64） ──────────────────────────
    [StructLayout(LayoutKind.Sequential)]
    struct BufferDesc { public uint ByteWidth, Usage, BindFlags, CpuAccessFlags, MiscFlags, StructureByteStride; }

    [StructLayout(LayoutKind.Sequential)]
    struct Texture2DDesc
    {
        public uint Width, Height, MipLevels, ArraySize, Format, SampleCount, SampleQuality, Usage, BindFlags, CpuAccessFlags, MiscFlags;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct SubresourceData { public void* SysMem; public uint SysMemPitch, SysMemSlicePitch; }

    [StructLayout(LayoutKind.Sequential)]
    struct InputElementDesc
    {
        public byte* SemanticName;
        public uint SemanticIndex, Format, InputSlot, AlignedByteOffset, InputSlotClass, InstanceDataStepRate;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct RTBlendDesc
    {
        public int BlendEnable;
        public uint SrcBlend, DestBlend, BlendOp, SrcBlendAlpha, DestBlendAlpha, BlendOpAlpha;
        public byte WriteMask;
        private byte _p1, _p2, _p3;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct BlendDesc
    {
        public int AlphaToCoverageEnable, IndependentBlendEnable;
        public RTBlendDesc RT0;
        private RTBlendDesc _rt1, _rt2, _rt3, _rt4, _rt5, _rt6, _rt7;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct RasterizerDesc
    {
        public uint FillMode, CullMode;
        public int FrontCCW, DepthBias;
        public float DepthBiasClamp, SlopeScaledDepthBias;
        public int DepthClipEnable, ScissorEnable, MultisampleEnable, AntialiasedLineEnable;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct SamplerDesc
    {
        public uint Filter, AddressU, AddressV, AddressW;
        public float MipLODBias;
        public uint MaxAnisotropy, ComparisonFunc;
        public float BorderR, BorderG, BorderB, BorderA, MinLOD, MaxLOD;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct MappedSubresource { public void* Data; public uint RowPitch, DepthPitch; }

    // ── 委托（x64 统一调用约定） ─────────────────────────────
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate uint FnUInt(IntPtr self);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate uint FnRelease(IntPtr self);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void FnGetCtx(IntPtr self, IntPtr* outCtx);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int FnCreateBuffer(IntPtr self, BufferDesc* d, SubresourceData* init, IntPtr* o);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int FnCreateTex2D(IntPtr self, Texture2DDesc* d, SubresourceData* init, IntPtr* o);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int FnCreateView(IntPtr self, IntPtr res, void* d, IntPtr* o);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int FnCreateShader(IntPtr self, void* code, UIntPtr size, IntPtr linkage, IntPtr* o);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int FnCreateLayout(IntPtr self, InputElementDesc* e, uint n, void* code, UIntPtr size, IntPtr* o);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int FnCreateLayoutN(IntPtr self, InputElementDesc* e, IntPtr n, void* code, UIntPtr size, IntPtr* o);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int FnCreateLayoutRaw(IntPtr self, IntPtr e, IntPtr n, IntPtr code, IntPtr size, IntPtr o);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int FnCreateState(IntPtr self, void* d, IntPtr* o);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate IntPtr FnBlobPtr(IntPtr self);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate UIntPtr FnBlobSize(IntPtr self);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void FnOMSetRT(IntPtr self, uint n, IntPtr* rtvs, IntPtr dsv);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void FnClearRTV(IntPtr self, IntPtr rtv, float* color);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void FnCopyRes(IntPtr self, IntPtr dst, IntPtr src);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int FnMap(IntPtr self, IntPtr res, uint sub, uint type, uint flags, MappedSubresource* o);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void FnUnmap(IntPtr self, IntPtr res, uint sub);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void FnSet1(IntPtr self, IntPtr a);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void FnSetShader(IntPtr self, IntPtr sh, IntPtr* inst, uint n);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void FnSetArr(IntPtr self, uint start, uint n, IntPtr* arr);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void FnIASetVB(IntPtr self, uint start, uint n, IntPtr* bufs, uint* strides, uint* offsets);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void FnIASetIB(IntPtr self, IntPtr buf, uint fmt, uint offset);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void FnTopology(IntPtr self, uint t);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void FnDrawIndexed(IntPtr self, uint n, uint start, int baseVtx);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void FnOMSetBlend(IntPtr self, IntPtr state, float* factor, uint mask);

    [DllImport("d3d11.dll")]
    static extern int D3D11CreateDevice(IntPtr adapter, uint driverType, IntPtr software, uint flags,
        uint* featureLevels, uint levelCount, uint sdkVersion, IntPtr* device, uint* featureLevel, IntPtr* context);

    [DllImport("d3dcompiler_47.dll")]
    static extern int D3DCompile(void* src, UIntPtr srcSize, byte* name, void* defines, void* include,
        byte* entry, byte* target, uint f1, uint f2, IntPtr* code, IntPtr* errors);

    [DllImport("kernel32.dll", CharSet = CharSet.Ansi)]
    static extern IntPtr GetModuleHandle(string name);
    [DllImport("kernel32.dll", CharSet = CharSet.Ansi)]
    static extern IntPtr GetProcAddress(IntPtr module, string name);
    [DllImport("gdi32.dll")]
    static extern bool DeleteObject(IntPtr obj);

    // 6 参数委托 stub 判定：与 CreateInputLayout 同构（this+5，含指针/uint/out）
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate IntPtr FnCreateDIB(IntPtr hdc, IntPtr pbmi, uint usage, IntPtr* bits, IntPtr section, uint offset);

    static StreamWriter _log;
    static void Log(string msg)
    {
        var line = DateTime.Now.ToString("HH:mm:ss.fff") + " " + msg;
        _log.WriteLine(line);
        _log.Flush();
        Console.WriteLine(line);
    }
    static string Hex(IntPtr p) { return "0x" + p.ToInt64().ToString("X"); }
    static string Hex(long v) { return "0x" + v.ToString("X"); }

    static void* Slot(IntPtr obj, int i)
    {
        // obj 首 8 字节 = vtable 指针；先解引用取 vtable，再按槽位索引。
        void** vtable = *(void***)obj.ToPointer();
        return vtable[i];
    }
    static T Fn<T>(IntPtr obj, int i) where T : class
    { return Marshal.GetDelegateForFunctionPointer<T>(new IntPtr(Slot(obj, i))); }

    const string VsSrc = "struct V{float4 p:SV_Position;float2 t:TEXCOORD0;};V main(float2 p:POSITION,float2 t:TEXCOORD0){V o;o.p=float4(p,0,1);o.t=t;return o;}";
    const string PsSrc = "struct V{float4 p:SV_Position;float2 t:TEXCOORD0;};float4 main(V i):SV_Target{return float4(i.t,0,1);}";

    static IntPtr Compile(string src, string entry, string target)
    {
        var srcB = System.Text.Encoding.UTF8.GetBytes(src);
        var entryB = System.Text.Encoding.UTF8.GetBytes(entry + "\0");
        var targetB = System.Text.Encoding.UTF8.GetBytes(target + "\0");
        fixed (void* s = srcB)
        fixed (byte* e = entryB)
        fixed (byte* t = targetB)
        {
            IntPtr code = IntPtr.Zero, errs = IntPtr.Zero;
            int hr = D3DCompile(s, (UIntPtr)srcB.Length, null, null, null, e, t, 0, 0, &code, &errs);
            Log("D3DCompile(" + entry + "/" + target + ") hr=" + Hex(hr) + " code=" + Hex(code));
            if (hr < 0)
            {
                if (errs != IntPtr.Zero)
                {
                    var ptr = Fn<FnBlobPtr>(errs, 3)(errs);
                    var sz = Fn<FnBlobSize>(errs, 4)(errs);
                    Log("compile errors: " + Marshal.PtrToStringAnsi(ptr, (int)sz));
                    Fn<FnRelease>(errs, 2)(errs);
                }
                throw new Exception("D3DCompile failed hr=" + Hex(hr));
            }
            if (errs != IntPtr.Zero) Fn<FnRelease>(errs, 2)(errs);
            return code;
        }
    }

    static int Main()
    {
        var logPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "gpu-probe-log.txt");
        _log = new StreamWriter(logPath, false, System.Text.Encoding.UTF8);
        try
        {
            Log("=== gpu-probe start ===");
            Log("os=" + Environment.OSVersion + " is64=" + Environment.Is64BitProcess + " machine=" + Environment.MachineName);
            if (!Environment.Is64BitProcess) { Log("FATAL: 必须 x64 运行"); return 1; }

            // ── 1. 创建设备 ──
            IntPtr device = IntPtr.Zero, ctx = IntPtr.Zero;
            uint fl = 0;
            Log("calling D3D11CreateDevice(HARDWARE)...");
            int hr = D3D11CreateDevice(IntPtr.Zero, 1, IntPtr.Zero, 0x20, null, 0, 7, &device, &fl, &ctx);
            Log("hr=" + Hex(hr) + " device=" + Hex(device) + " ctx=" + Hex(ctx) + " featureLevel=" + Hex(fl));
            if (hr < 0)
            {
                Log("HARDWARE failed, calling D3D11CreateDevice(WARP)...");
                hr = D3D11CreateDevice(IntPtr.Zero, 5, IntPtr.Zero, 0x20, null, 0, 7, &device, &fl, &ctx);
                Log("hr=" + Hex(hr) + " device=" + Hex(device) + " ctx=" + Hex(ctx) + " featureLevel=" + Hex(fl));
                if (hr < 0) { Log("FATAL: 设备创建失败"); return 1; }
            }

            // ── 2. vtable 读取健全性：AddRef/Release（槽 1/2，两布局通用） ──
            Log("== vtable sanity ==");
            Log("calling AddRef(slot1)...");
            uint refs = Fn<FnUInt>(device, 1)(device);
            Log("AddRef -> " + refs + " (expect >= 2)");
            Log("calling Release(slot2)...");
            uint refs2 = Fn<FnRelease>(device, 2)(device);
            Log("Release -> " + refs2 + " (expect " + (refs - 1) + ")");
            if (refs < 2 || refs2 != refs - 1) { Log("FATAL: vtable 读取异常"); return 1; }

            // ── 3. 布局判定：GetImmediateContext（Win8+=41，旧=40） ──
            Log("== layout identification ==");
            int ctxSlot = -1;
            for (int s = 40; s <= 41; s++)
            {
                IntPtr got = IntPtr.Zero;
                Log("calling slot" + s + " as GetImmediateContext...");
                Fn<FnGetCtx>(device, s)(device, &got);
                Log("slot" + s + " -> " + Hex(got) + " match=" + (got == ctx));
                if (got != IntPtr.Zero) Fn<FnRelease>(got, 2)(got);
                if (got == ctx) { ctxSlot = s; break; }
            }
            if (ctxSlot < 0) { Log("FATAL: LAYOUT_UNKNOWN — GetImmediateContext 不在 40/41，停止。"); return 1; }
            Log("calling GetFeatureLevel(slot" + (ctxSlot - 3) + ")...");
            uint fl2 = Fn<FnUInt>(device, ctxSlot - 3)(device);
            Log("calling GetCreationFlags(slot" + (ctxSlot - 2) + ")...");
            uint flags2 = Fn<FnUInt>(device, ctxSlot - 2)(device);
            Log("calling GetDeviceRemovedReason(slot" + (ctxSlot - 1) + ")...");
            uint removed = Fn<FnUInt>(device, ctxSlot - 1)(device);
            Log("featureLevel=" + Hex(fl2) + " (expect " + Hex(fl) + ") creationFlags=" + Hex(flags2) + " (expect 0x20) removedReason=" + Hex(removed) + " (expect 0x0)");
            if (fl2 != fl || flags2 != 0x20) { Log("FATAL: getter 校验失败"); return 1; }
            Log("LAYOUT_CONFIRMED（device 无 DeviceChild 前缀；GetImmediateContext=" + ctxSlot + "）");

            // ── 4. 管线逐步创建（device 槽位固定，mingw d3d11.h 核对） ──
            Log("== pipeline ==");

            Log("calling CreateBuffer(slot3) dynamic CB 128B...");
            var cbd = new BufferDesc { ByteWidth = 128, Usage = 2, BindFlags = 4, CpuAccessFlags = 0x10000 };
            IntPtr cb;
            hr = Fn<FnCreateBuffer>(device, 3)(device, &cbd, null, &cb);
            Log("hr=" + Hex(hr) + " cb=" + Hex(cb));
            if (hr < 0) return 1;

            Log("compiling trivial VS...");
            IntPtr vsBlob = Compile(VsSrc, "main", "vs_4_0");
            Log("calling blob.GetBufferPointer(slot3)/GetBufferSize(slot4)...");
            void* vsCode = (void*)Fn<FnBlobPtr>(vsBlob, 3)(vsBlob);
            UIntPtr vsSize = Fn<FnBlobSize>(vsBlob, 4)(vsBlob);
            Log("vsCode=" + Hex(new IntPtr(vsCode)) + " vsSize=" + vsSize.ToUInt64());

            Log("calling CreateVertexShader(slot12)...");
            IntPtr vs;
            hr = Fn<FnCreateShader>(device, 12)(device, vsCode, vsSize, IntPtr.Zero, &vs);
            Log("hr=" + Hex(hr) + " vs=" + Hex(vs));
            if (hr < 0) return 1;

            Log("calling CreateInputLayout(slot11)...");
            IntPtr layout;
            IntPtr pPos = Marshal.StringToHGlobalAnsi("POSITION");
            // HLSL `: TEXCOORD0` 编译后签名是 "TEXCOORD" + 索引 0——布局语义名必须是
            // "TEXCOORD"（写 "TEXCOORD0" 匹配不到签名 → E_INVALIDARG，#257 根因）。
            IntPtr pUv = Marshal.StringToHGlobalAnsi("TEXCOORD");
            var elems = stackalloc InputElementDesc[2];
            elems[0] = new InputElementDesc { SemanticName = (byte*)pPos, Format = 16, AlignedByteOffset = 0 };
            elems[1] = new InputElementDesc { SemanticName = (byte*)pUv, Format = 16, AlignedByteOffset = 8 };
            hr = Fn<FnCreateLayout>(device, 11)(device, elems, 2, vsCode, vsSize, &layout);
            Log("hr=" + Hex(hr) + " layout=" + Hex(layout));
            if (hr < 0)
            {
                // 变体诊断：定位 E_INVALIDARG 来源
                Log("vsCode head bytes: " + ((byte*)vsCode)[0].ToString("X2") + " " + ((byte*)vsCode)[1].ToString("X2") + " " + ((byte*)vsCode)[2].ToString("X2") + " " + ((byte*)vsCode)[3].ToString("X2") + " (expect 44 58 42 43 = DXBC)");
                // 解析 DXBC chunk 表，确认 ISGN（输入签名）存在及其内容
                {
                    byte* b = (byte*)vsCode;
                    var head = "";
                    for (int hi = 0; hi < 64; hi++) head += b[hi].ToString("X2") + " ";
                    Log("DXBC head64: " + head);
                    uint chunkCount = (uint)(b[28] | (b[29] << 8) | (b[30] << 16) | (b[31] << 24));
                    Log("DXBC chunkCount=" + chunkCount);
                    // header(32) 后是 chunkCount 个 DWORD 偏移表，再才是 chunk 数据
                    for (int ci = 0; ci < chunkCount && ci < 16; ci++)
                    {
                        int off = b[32 + ci * 4] | (b[33 + ci * 4] << 8) | (b[34 + ci * 4] << 16) | (b[35 + ci * 4] << 24);
                        if (off + 8 > (int)vsSize) { Log("chunk table truncated"); break; }
                        string cc = "" + (char)b[off] + (char)b[off + 1] + (char)b[off + 2] + (char)b[off + 3];
                        uint csz = (uint)(b[off + 4] | (b[off + 5] << 8) | (b[off + 6] << 16) | (b[off + 7] << 24));
                        Log("chunk " + cc + " size=" + csz);
                        if (csz > vsSize.ToUInt64() || off + 8 + (int)csz > (int)vsSize) { Log("chunk size invalid, stop"); break; }
                        if (cc == "ISGN" && csz >= 4)
                        {
                            byte* d = b + off + 8;
                            var isgnDump = "";
                            for (int di = 0; di < (int)csz && di < 80; di++) isgnDump += d[di].ToString("X2") + " ";
                            Log("ISGN raw: " + isgnDump);
                            uint n = (uint)(d[0] | (d[1] << 8) | (d[2] << 16) | (d[3] << 24));
                            Log("ISGN elementCount=" + n);
                            for (uint ei = 0; ei < n && ei < 8; ei++)
                            {
                                byte* e = d + 8 + ei * 24; // ISGN 头 = count(4) + reserved(4)
                                uint nameOff = (uint)(e[0] | (e[1] << 8) | (e[2] << 16) | (e[3] << 24));
                                uint nameIdx = (uint)(e[4] | (e[5] << 8) | (e[6] << 16) | (e[7] << 24));
                                uint sysVal = (uint)(e[8] | (e[9] << 8) | (e[10] << 16) | (e[11] << 24));
                                uint fmt = (uint)(e[12] | (e[13] << 8) | (e[14] << 16) | (e[15] << 24));
                                uint reg = (uint)(e[16] | (e[17] << 8) | (e[18] << 16) | (e[19] << 24));
                                uint mask = e[20];
                                string sem = Marshal.PtrToStringAnsi(new IntPtr(d + nameOff));
                                Log("ISGN[" + ei + "] sem=" + sem + " idx=" + nameIdx + " sys=" + sysVal + " fmt=" + fmt + " reg=" + reg + " mask=" + mask.ToString("X"));
                            }
                        }
                        off += 8 + (int)csz;
                    }
                }
                byte* e0 = (byte*)&elems[0];
                var dump = "";
                for (int bi = 0; bi < 32; bi++) dump += e0[bi].ToString("X2") + " ";
                Log("elems[0] bytes: " + dump);
                Log("pPos=" + Hex(pPos) + " str=" + Marshal.PtrToStringAnsi(pPos) + " pUv=" + Hex(pUv) + " str=" + Marshal.PtrToStringAnsi(pUv));

                IntPtr l1;
                hr = Fn<FnCreateLayout>(device, 11)(device, elems, 1, vsCode, vsSize, &l1);
                Log("variant 1elem(POSITION only) hr=" + Hex(hr));
                if (hr == 0) Fn<FnRelease>(l1, 2)(l1);

                elems[0].AlignedByteOffset = 0xFFFFFFFF; // D3D11_APPEND_ALIGNED_ELEMENT
                elems[1].AlignedByteOffset = 0xFFFFFFFF;
                hr = Fn<FnCreateLayout>(device, 11)(device, elems, 2, vsCode, vsSize, &l1);
                Log("variant APPEND_ALIGNED hr=" + Hex(hr));
                if (hr == 0) Fn<FnRelease>(l1, 2)(l1);
                elems[0].AlignedByteOffset = 0;
                elems[1].AlignedByteOffset = 8;

                // 变体：元素放 HGlobal 非托管内存（排除 stackalloc 因素）
                IntPtr hElems = Marshal.AllocHGlobal(64);
                Marshal.Copy(new byte[64], 0, hElems, 64);
                // 手工写两个元素（小端）：name ptr / index / format / slot / offset / class / step
                Marshal.WriteIntPtr(hElems, 0, pPos);
                Marshal.WriteInt32(hElems, 8, 0);
                Marshal.WriteInt32(hElems, 12, 16);
                Marshal.WriteInt32(hElems, 16, 0);
                Marshal.WriteInt32(hElems, 20, 0);
                Marshal.WriteInt32(hElems, 24, 0);
                Marshal.WriteInt32(hElems, 28, 0);
                Marshal.WriteIntPtr(hElems, 32, pUv);
                Marshal.WriteInt32(hElems, 40, 0);
                Marshal.WriteInt32(hElems, 44, 16);
                Marshal.WriteInt32(hElems, 48, 0);
                Marshal.WriteInt32(hElems, 52, 8);
                Marshal.WriteInt32(hElems, 56, 0);
                Marshal.WriteInt32(hElems, 60, 0);
                hr = Fn<FnCreateLayout>(device, 11)(device, (InputElementDesc*)hElems, 2, vsCode, vsSize, &l1);
                Log("variant HGlobal elems hr=" + Hex(hr));
                if (hr == 0) Fn<FnRelease>(l1, 2)(l1);
                Marshal.FreeHGlobal(hElems);

                // 变体：n 声明为 IntPtr（排除 uint 参数 marshalling 问题）
                hr = Fn<FnCreateLayoutN>(device, 11)(device, elems, (IntPtr)2, vsCode, vsSize, &l1);
                Log("variant IntPtr-n hr=" + Hex(hr));
                if (hr == 0) Fn<FnRelease>(l1, 2)(l1);

                // 变体：重新编译一份新 blob
                IntPtr vsBlob2 = Compile(VsSrc, "main", "vs_4_0");
                void* vsCode2 = (void*)Fn<FnBlobPtr>(vsBlob2, 3)(vsBlob2);
                UIntPtr vsSize2 = Fn<FnBlobSize>(vsBlob2, 4)(vsBlob2);
                hr = Fn<FnCreateLayout>(device, 11)(device, elems, 2, vsCode2, vsSize2, &l1);
                Log("variant fresh blob hr=" + Hex(hr));
                if (hr == 0) Fn<FnRelease>(l1, 2)(l1);
                Fn<FnRelease>(vsBlob2, 2)(vsBlob2);

                // 变体：全 IntPtr 原始委托（排除混合类型 stub 问题）
                hr = Fn<FnCreateLayoutRaw>(device, 11)(device, new IntPtr(elems), (IntPtr)2, new IntPtr(vsCode), (IntPtr)vsSize.ToUInt64(), new IntPtr(&l1));
                Log("variant raw-IntPtr hr=" + Hex(hr));
                if (hr == 0) Fn<FnRelease>(l1, 2)(l1);

                // 决定性测试：WARP 纯软件设备上重试（排除虚拟硬件适配器缺陷）
                IntPtr wdev = IntPtr.Zero, wctx = IntPtr.Zero;
                uint wfl = 0;
                Log("creating WARP device...");
                hr = D3D11CreateDevice(IntPtr.Zero, 5, IntPtr.Zero, 0x20, null, 0, 7, &wdev, &wfl, &wctx);
                Log("WARP hr=" + Hex(hr) + " dev=" + Hex(wdev) + " fl=" + Hex(wfl));
                if (hr == 0)
                {
                    IntPtr wvs;
                    hr = Fn<FnCreateShader>(wdev, 12)(wdev, vsCode, vsSize, IntPtr.Zero, &wvs);
                    Log("WARP CreateVS hr=" + Hex(hr));
                    hr = Fn<FnCreateLayout>(wdev, 11)(wdev, elems, 2, vsCode, vsSize, &l1);
                    Log("WARP CreateInputLayout hr=" + Hex(hr));
                    if (hr == 0)
                    {
                        Log("WARP_OK — 硬件适配器实现缺陷，WARP 可用");
                        Fn<FnRelease>(l1, 2)(l1);
                    }
                    if (wvs != IntPtr.Zero) Fn<FnRelease>(wvs, 2)(wvs);
                    Fn<FnRelease>(wctx, 2)(wctx);
                    Fn<FnRelease>(wdev, 2)(wdev);
                }

                // 判定：6 参数委托 stub 是否正常（已知正确的 WinAPI，同构调用）
                IntPtr gdi32 = GetModuleHandle("gdi32.dll");
                IntPtr pDIB = GetProcAddress(gdi32, "CreateDIBSection");
                Log("gdi32=" + Hex(gdi32) + " CreateDIBSection=" + Hex(pDIB));
                IntPtr bmi = Marshal.AllocHGlobal(44);
                for (int zi = 0; zi < 44; zi++) Marshal.WriteByte(bmi, zi, 0);
                Marshal.WriteInt32(bmi, 0, 40);   // biSize
                Marshal.WriteInt32(bmi, 4, 4);    // biWidth
                Marshal.WriteInt32(bmi, 8, 4);    // biHeight
                Marshal.WriteInt16(bmi, 12, 1);   // biPlanes
                Marshal.WriteInt16(bmi, 14, 32);  // biBitCount
                IntPtr dibBits;
                var dibFn = Marshal.GetDelegateForFunctionPointer<FnCreateDIB>(pDIB);
                IntPtr hbmp = dibFn(IntPtr.Zero, bmi, 0, &dibBits, IntPtr.Zero, 0);
                Log("CreateDIBSection(6-arg delegate) -> hbmp=" + Hex(hbmp) + " bits=" + Hex(dibBits) + (hbmp != IntPtr.Zero && dibBits != IntPtr.Zero ? " STUB_OK" : " STUB_BROKEN"));
                if (hbmp != IntPtr.Zero) DeleteObject(hbmp);
                Marshal.FreeHGlobal(bmi);

                Log("FATAL: CreateInputLayout 全部变体失败");
                return 1;
            }
            Marshal.FreeHGlobal(pPos); Marshal.FreeHGlobal(pUv);

            Log("compiling trivial PS...");
            IntPtr psBlob = Compile(PsSrc, "main", "ps_4_0");
            void* psCode = (void*)Fn<FnBlobPtr>(psBlob, 3)(psBlob);
            UIntPtr psSize = Fn<FnBlobSize>(psBlob, 4)(psBlob);
            Log("calling CreatePixelShader(slot15)...");
            IntPtr ps;
            hr = Fn<FnCreateShader>(device, 15)(device, psCode, psSize, IntPtr.Zero, &ps);
            Log("hr=" + Hex(hr) + " ps=" + Hex(ps));
            if (hr < 0) return 1;

            Log("calling CreateTexture2D(slot5) 64x64 BGRA RT+SRV...");
            var td = new Texture2DDesc
            {
                Width = 64, Height = 64, MipLevels = 1, ArraySize = 1, Format = 87,
                SampleCount = 1, SampleQuality = 0, Usage = 0, BindFlags = 0x20 | 0x8,
            };
            IntPtr tex;
            hr = Fn<FnCreateTex2D>(device, 5)(device, &td, null, &tex);
            Log("hr=" + Hex(hr) + " tex=" + Hex(tex));
            if (hr < 0) return 1;

            Log("calling CreateRenderTargetView(slot9)...");
            IntPtr rtv;
            hr = Fn<FnCreateView>(device, 9)(device, tex, null, &rtv);
            Log("hr=" + Hex(hr) + " rtv=" + Hex(rtv));
            if (hr < 0) return 1;

            Log("calling CreateShaderResourceView(slot7)...");
            IntPtr srv;
            hr = Fn<FnCreateView>(device, 7)(device, tex, null, &srv);
            Log("hr=" + Hex(hr) + " srv=" + Hex(srv));
            if (hr < 0) return 1;

            Log("calling CreateBlendState(slot20)...");
            var bd = new BlendDesc
            {
                RT0 = new RTBlendDesc
                {
                    BlendEnable = 1, SrcBlend = 2, DestBlend = 6, BlendOp = 1,
                    SrcBlendAlpha = 2, DestBlendAlpha = 6, BlendOpAlpha = 1, WriteMask = 0xF,
                },
            };
            IntPtr blend;
            hr = Fn<FnCreateState>(device, 20)(device, &bd, &blend);
            Log("hr=" + Hex(hr) + " blend=" + Hex(blend));
            if (hr < 0) return 1;

            Log("calling CreateRasterizerState(slot22)...");
            var rd = new RasterizerDesc { FillMode = 3, CullMode = 1, DepthClipEnable = 1 };
            IntPtr raster;
            hr = Fn<FnCreateState>(device, 22)(device, &rd, &raster);
            Log("hr=" + Hex(hr) + " raster=" + Hex(raster));
            if (hr < 0) return 1;

            Log("calling CreateSamplerState(slot23)...");
            var sd = new SamplerDesc { Filter = 0x15, AddressU = 3, AddressV = 3, AddressW = 3, MaxAnisotropy = 1, MaxLOD = float.MaxValue };
            IntPtr sampler;
            hr = Fn<FnCreateState>(device, 23)(device, &sd, &sampler);
            Log("hr=" + Hex(hr) + " sampler=" + Hex(sampler));
            if (hr < 0) return 1;

            // ── 5. context：清屏 + 回读 ──
            Log("== context clear/readback ==");
            Log("calling OMSetRenderTargets(slot33)...");
            IntPtr rtvLocal = rtv;
            Fn<FnOMSetRT>(ctx, 33)(ctx, 1, &rtvLocal, IntPtr.Zero);
            Log("calling ClearRenderTargetView(slot50) color=(0.25,0.5,0.75,1)...");
            float* color = stackalloc float[4];
            color[0] = 0.25f; color[1] = 0.5f; color[2] = 0.75f; color[3] = 1f;
            Fn<FnClearRTV>(ctx, 50)(ctx, rtv, color);

            Log("creating staging texture...");
            var std = new Texture2DDesc
            {
                Width = 64, Height = 64, MipLevels = 1, ArraySize = 1, Format = 87,
                SampleCount = 1, Usage = 3, CpuAccessFlags = 0x20000,
            };
            IntPtr staging;
            hr = Fn<FnCreateTex2D>(device, 5)(device, &std, null, &staging);
            Log("hr=" + Hex(hr) + " staging=" + Hex(staging));
            if (hr < 0) return 1;

            Log("calling CopyResource(slot47)...");
            Fn<FnCopyRes>(ctx, 47)(ctx, staging, tex);
            Log("calling Map(slot14, READ)...");
            MappedSubresource mapped;
            hr = Fn<FnMap>(ctx, 14)(ctx, staging, 0, 1, 0, &mapped);
            Log("hr=" + Hex(hr) + " data=" + Hex(new IntPtr(mapped.Data)) + " rowPitch=" + mapped.RowPitch);
            if (hr < 0) return 1;
            byte* px = (byte*)mapped.Data;
            Log("clear readback pixel(0,0) BGRA=(" + px[0] + "," + px[1] + "," + px[2] + "," + px[3] + ") expect=(64,128,191,255)");
            Fn<FnUnmap>(ctx, 15)(ctx, staging, 0);

            // ── 6. mini-draw：验证 IA/VS/PS/Draw 槽位 ──
            Log("== mini draw ==");
            Log("creating dynamic VB/IB...");
            var vbd = new BufferDesc { ByteWidth = 3 * 16, Usage = 2, BindFlags = 1, CpuAccessFlags = 0x10000 };
            IntPtr vb;
            hr = Fn<FnCreateBuffer>(device, 3)(device, &vbd, null, &vb);
            Log("vb hr=" + Hex(hr));
            var ibd = new BufferDesc { ByteWidth = 3 * 2, Usage = 2, BindFlags = 2, CpuAccessFlags = 0x10000 };
            IntPtr ib;
            hr = Fn<FnCreateBuffer>(device, 3)(device, &ibd, null, &ib);
            Log("ib hr=" + Hex(hr));
            if (hr < 0) return 1;

            Log("Map(VB, WRITE_DISCARD) + 写三角形...");
            hr = Fn<FnMap>(ctx, 14)(ctx, vb, 0, 4, 0, &mapped);
            Log("hr=" + Hex(hr));
            if (hr < 0) return 1;
            float* v = (float*)mapped.Data;
            v[0] = -0.5f; v[1] = -0.5f; v[2] = 0f; v[3] = 0f;
            v[4] = 0.5f; v[5] = -0.5f; v[6] = 1f; v[7] = 0f;
            v[8] = 0f; v[9] = 0.5f; v[10] = 0.5f; v[11] = 1f;
            Fn<FnUnmap>(ctx, 15)(ctx, vb, 0);

            Log("Map(IB, WRITE_DISCARD) + 写索引...");
            hr = Fn<FnMap>(ctx, 14)(ctx, ib, 0, 4, 0, &mapped);
            Log("hr=" + Hex(hr));
            if (hr < 0) return 1;
            ushort* idx = (ushort*)mapped.Data;
            idx[0] = 0; idx[1] = 1; idx[2] = 2;
            Fn<FnUnmap>(ctx, 15)(ctx, ib, 0);

            Log("calling IASetInputLayout(17) IASetPrimitiveTopology(24) IASetVertexBuffers(18) IASetIndexBuffer(19)...");
            Fn<FnSet1>(ctx, 17)(ctx, layout);
            Fn<FnTopology>(ctx, 24)(ctx, 4);
            IntPtr vbLocal = vb; uint stride = 16, offset = 0;
            Fn<FnIASetVB>(ctx, 18)(ctx, 0, 1, &vbLocal, &stride, &offset);
            Fn<FnIASetIB>(ctx, 19)(ctx, ib, 57, 0);

            Log("calling VSSetShader(11) PSSetShader(9) VSSetConstantBuffers(7) PSSetConstantBuffers(16) PSSetShaderResources(8) PSSetSamplers(10) OMSetBlendState(35)...");
            Fn<FnSetShader>(ctx, 11)(ctx, vs, null, 0);
            Fn<FnSetShader>(ctx, 9)(ctx, ps, null, 0);
            IntPtr cbLocal = cb;
            Fn<FnSetArr>(ctx, 7)(ctx, 0, 1, &cbLocal);
            Fn<FnSetArr>(ctx, 16)(ctx, 0, 1, &cbLocal);
            IntPtr srvLocal = srv;
            Fn<FnSetArr>(ctx, 8)(ctx, 0, 1, &srvLocal);
            IntPtr sampLocal = sampler;
            Fn<FnSetArr>(ctx, 10)(ctx, 0, 1, &sampLocal);
            float* factor = stackalloc float[4];
            factor[0] = 0f; factor[1] = 0f; factor[2] = 0f; factor[3] = 0f;
            Fn<FnOMSetBlend>(ctx, 35)(ctx, blend, factor, 0xFFFFFFFF);

            Log("calling RSSetState(43)...");
            Fn<FnSet1>(ctx, 43)(ctx, raster);

            Log("calling DrawIndexed(slot12, 3 indices)...");
            Fn<FnDrawIndexed>(ctx, 12)(ctx, 3, 0, 0);

            Log("readback after draw...");
            Fn<FnCopyRes>(ctx, 47)(ctx, staging, tex);
            hr = Fn<FnMap>(ctx, 14)(ctx, staging, 0, 1, 0, &mapped);
            Log("hr=" + Hex(hr));
            if (hr < 0) return 1;
            px = (byte*)mapped.Data;
            int center = (32 * (int)mapped.RowPitch) + 32 * 4;
            Log("pixel(0,0) BGRA=(" + px[0] + "," + px[1] + "," + px[2] + "," + px[3] + ") expect clear=(64,128,191,255)");
            Log("pixel(32,32) BGRA=(" + px[center] + "," + px[center + 1] + "," + px[center + 2] + "," + px[center + 3] + ") expect 非清屏色（三角形覆盖）");
            bool drewOk = px[center] != 64 || px[center + 1] != 128 || px[center + 2] != 191;
            Fn<FnUnmap>(ctx, 15)(ctx, staging, 0);

            // ── 7. 释放 ──
            Log("== release ==");
            IntPtr[] objs = { staging, ib, vb, sampler, raster, blend, srv, rtv, tex, ps, layout, vs, cb, psBlob, vsBlob, ctx, device };
            foreach (var o in objs)
            {
                if (o != IntPtr.Zero) Fn<FnRelease>(o, 2)(o);
            }
            Log("released all");

            Log(drewOk ? "PROBE_OK（vtable 布局与全部管线槽位验证通过）" : "PROBE_DRAW_FAILED（创建/清屏通过，但三角形未画出）");
            return drewOk ? 0 : 1;
        }
        catch (Exception ex)
        {
            Log("EXCEPTION: " + ex);
            return 1;
        }
        finally
        {
            _log.Flush();
            _log.Dispose();
        }
    }
}
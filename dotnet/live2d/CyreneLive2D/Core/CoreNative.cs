// Cubism Core C API 的 P/Invoke 封装（T0/T1）。
//
// 签名权威来源：Cubism SDK for Native 5-r.4 的 Core/include/Live2DCubismCore.h
// （Core 5.1.0，与 web 轨对齐；下载 pin 的 SHA256 见 CoreDownloader.SdkSha256；
// csmGetRenderOrders 在 Core 6 改名，经 CoreLibrary 函数指针兼容
// csmGetDrawableRenderOrders 旧名）。要点：
//   - Core 不分配内存：moc 缓冲按 csmAlignofMoc=64 对齐、model 缓冲按
//     csmAlignofModel=16 对齐，由调用方提供（NativeMemory.AlignedAlloc）。
//   - csmReviveMocInPlace 就地改写缓冲——文件字节必须先拷贝进对齐缓冲。
//   - 旧版 Core（Cubism 4 早期）导出名带 _30 后缀（csmReviveMocInPlace_30），
//     CoreLibrary 做导出探测兜底（任务书 T0 风险项）。
//   - Windows x64 只有一种调用约定；x86 DLL 为 stdcall（CSM_CORE_WIN32_DLL），
//     本侧车只发布 win-x64，Cdecl/StdCall 在 x64 上等价。
//
// License：Live2D Proprietary Software License——Core 二进制不随仓分发，
// 运行时下载（CoreDownloader）或用户自备（见 CoreLibrary 探测顺序）。

using System.Runtime.InteropServices;

namespace CyreneLive2D.Core;

/// <summary>csmVector2（Live2DCubismCore.h）。</summary>
[StructLayout(LayoutKind.Sequential)]
public struct CsmVector2
{
    public float X;
    public float Y;
}

/// <summary>csmVector4（Live2DCubismCore.h）。</summary>
[StructLayout(LayoutKind.Sequential)]
public struct CsmVector4
{
    public float X;
    public float Y;
    public float Z;
    public float W;
}

/// <summary>常量 drawable 标志位（csmFlags 位掩码）。</summary>
[Flags]
public enum CsmConstantFlags : byte
{
    None = 0,
    BlendAdditive = 1 << 0,
    BlendMultiplicative = 1 << 1,
    IsDoubleSided = 1 << 2,
    IsInvertedMask = 1 << 3,
}

/// <summary>动态 drawable 标志位。</summary>
[Flags]
public enum CsmDynamicFlags : byte
{
    None = 0,
    IsVisible = 1 << 0,
    VisibilityDidChange = 1 << 1,
    OpacityDidChange = 1 << 2,
    DrawOrderDidChange = 1 << 3,
    RenderOrderDidChange = 1 << 4,
    VertexPositionsDidChange = 1 << 5,
    BlendColorDidChange = 1 << 6,
}

/// <summary>moc3 文件格式版本（csmMocVersion）。</summary>
public enum CsmMocVersion : uint
{
    Unknown = 0,
    V30 = 1, // 3.0.00 - 3.2.07
    V33 = 2, // 3.3.00 - 3.3.03
    V40 = 3, // 4.0.00 - 4.1.05
    V42 = 4, // 4.2.00 - 4.2.04
    V50 = 5, // 5.0.00 - 5.2.03
    V53 = 6, // 5.3.00 -
}

/// <summary>
/// Core C API 原始导入。所有函数以 <see cref="CoreLibrary.DllName"/> 解析——
/// 实际路径由 <see cref="CoreLibrary"/> 的 DllImportResolver 注入（运行时下载/用户自备）。
/// 返回的指针全部指向 Core 管理的内存（model 缓冲内），不得释放。
/// </summary>
public static unsafe class CoreNative
{
    public const int AlignofMoc = 64;   // csmAlignofMoc
    public const int AlignofModel = 16; // csmAlignofModel

    // ── 版本 ────────────────────────────────────────────────
    [DllImport(CoreLibrary.DllName, CallingConvention = CallingConvention.Cdecl)]
    public static extern uint csmGetVersion();

    [DllImport(CoreLibrary.DllName, CallingConvention = CallingConvention.Cdecl)]
    public static extern CsmMocVersion csmGetLatestMocVersion();

    [DllImport(CoreLibrary.DllName, CallingConvention = CallingConvention.Cdecl)]
    public static extern CsmMocVersion csmGetMocVersion(void* address, uint size);

    // ── 一致性 / 日志 ───────────────────────────────────────
    [DllImport(CoreLibrary.DllName, CallingConvention = CallingConvention.Cdecl)]
    public static extern int csmHasMocConsistency(void* address, uint size);

    [DllImport(CoreLibrary.DllName, CallingConvention = CallingConvention.Cdecl)]
    public static extern void csmSetLogFunction(delegate* unmanaged[Cdecl]<byte*, void> handler);

    // ── MOC / MODEL 生命周期 ────────────────────────────────
    [DllImport(CoreLibrary.DllName, CallingConvention = CallingConvention.Cdecl)]
    public static extern void* csmReviveMocInPlace(void* address, uint size);

    [DllImport(CoreLibrary.DllName, CallingConvention = CallingConvention.Cdecl)]
    public static extern uint csmGetSizeofModel(void* moc);

    [DllImport(CoreLibrary.DllName, CallingConvention = CallingConvention.Cdecl)]
    public static extern void* csmInitializeModelInPlace(void* moc, void* address, uint size);

    [DllImport(CoreLibrary.DllName, CallingConvention = CallingConvention.Cdecl)]
    public static extern void csmUpdateModel(void* model);

    // csmGetRenderOrders / csmGetDrawableRenderOrders 经 CoreLibrary.GetRenderOrders
    // 函数指针调用（Core 5/6 导出名不同，DllImport 无法兼容）。

    // ── 画布 ────────────────────────────────────────────────
    [DllImport(CoreLibrary.DllName, CallingConvention = CallingConvention.Cdecl)]
    public static extern void csmReadCanvasInfo(void* model, CsmVector2* outSizeInPixels, CsmVector2* outOriginInPixels, float* outPixelsPerUnit);

    // ── 参数 ────────────────────────────────────────────────
    [DllImport(CoreLibrary.DllName, CallingConvention = CallingConvention.Cdecl)]
    public static extern int csmGetParameterCount(void* model);

    [DllImport(CoreLibrary.DllName, CallingConvention = CallingConvention.Cdecl)]
    public static extern byte** csmGetParameterIds(void* model);

    [DllImport(CoreLibrary.DllName, CallingConvention = CallingConvention.Cdecl)]
    public static extern int* csmGetParameterTypes(void* model);

    [DllImport(CoreLibrary.DllName, CallingConvention = CallingConvention.Cdecl)]
    public static extern float* csmGetParameterMinimumValues(void* model);

    [DllImport(CoreLibrary.DllName, CallingConvention = CallingConvention.Cdecl)]
    public static extern float* csmGetParameterMaximumValues(void* model);

    [DllImport(CoreLibrary.DllName, CallingConvention = CallingConvention.Cdecl)]
    public static extern float* csmGetParameterDefaultValues(void* model);

    [DllImport(CoreLibrary.DllName, CallingConvention = CallingConvention.Cdecl)]
    public static extern float* csmGetParameterValues(void* model);

    [DllImport(CoreLibrary.DllName, CallingConvention = CallingConvention.Cdecl)]
    public static extern int* csmGetParameterRepeats(void* model);

    // ── 部件 ────────────────────────────────────────────────
    [DllImport(CoreLibrary.DllName, CallingConvention = CallingConvention.Cdecl)]
    public static extern int csmGetPartCount(void* model);

    [DllImport(CoreLibrary.DllName, CallingConvention = CallingConvention.Cdecl)]
    public static extern byte** csmGetPartIds(void* model);

    [DllImport(CoreLibrary.DllName, CallingConvention = CallingConvention.Cdecl)]
    public static extern float* csmGetPartOpacities(void* model);

    [DllImport(CoreLibrary.DllName, CallingConvention = CallingConvention.Cdecl)]
    public static extern int* csmGetPartParentPartIndices(void* model);

    // ── Drawable ────────────────────────────────────────────
    [DllImport(CoreLibrary.DllName, CallingConvention = CallingConvention.Cdecl)]
    public static extern int csmGetDrawableCount(void* model);

    [DllImport(CoreLibrary.DllName, CallingConvention = CallingConvention.Cdecl)]
    public static extern byte** csmGetDrawableIds(void* model);

    [DllImport(CoreLibrary.DllName, CallingConvention = CallingConvention.Cdecl)]
    public static extern CsmConstantFlags* csmGetDrawableConstantFlags(void* model);

    [DllImport(CoreLibrary.DllName, CallingConvention = CallingConvention.Cdecl)]
    public static extern CsmDynamicFlags* csmGetDrawableDynamicFlags(void* model);

    [DllImport(CoreLibrary.DllName, CallingConvention = CallingConvention.Cdecl)]
    public static extern int* csmGetDrawableTextureIndices(void* model);

    [DllImport(CoreLibrary.DllName, CallingConvention = CallingConvention.Cdecl)]
    public static extern int* csmGetDrawableDrawOrders(void* model);

    [DllImport(CoreLibrary.DllName, CallingConvention = CallingConvention.Cdecl)]
    public static extern float* csmGetDrawableOpacities(void* model);

    [DllImport(CoreLibrary.DllName, CallingConvention = CallingConvention.Cdecl)]
    public static extern int* csmGetDrawableMaskCounts(void* model);

    [DllImport(CoreLibrary.DllName, CallingConvention = CallingConvention.Cdecl)]
    public static extern int** csmGetDrawableMasks(void* model);

    [DllImport(CoreLibrary.DllName, CallingConvention = CallingConvention.Cdecl)]
    public static extern int* csmGetDrawableVertexCounts(void* model);

    [DllImport(CoreLibrary.DllName, CallingConvention = CallingConvention.Cdecl)]
    public static extern CsmVector2** csmGetDrawableVertexPositions(void* model);

    [DllImport(CoreLibrary.DllName, CallingConvention = CallingConvention.Cdecl)]
    public static extern CsmVector2** csmGetDrawableVertexUvs(void* model);

    [DllImport(CoreLibrary.DllName, CallingConvention = CallingConvention.Cdecl)]
    public static extern int* csmGetDrawableIndexCounts(void* model);

    [DllImport(CoreLibrary.DllName, CallingConvention = CallingConvention.Cdecl)]
    public static extern ushort** csmGetDrawableIndices(void* model);

    [DllImport(CoreLibrary.DllName, CallingConvention = CallingConvention.Cdecl)]
    public static extern CsmVector4* csmGetDrawableMultiplyColors(void* model);

    [DllImport(CoreLibrary.DllName, CallingConvention = CallingConvention.Cdecl)]
    public static extern CsmVector4* csmGetDrawableScreenColors(void* model);

    [DllImport(CoreLibrary.DllName, CallingConvention = CallingConvention.Cdecl)]
    public static extern int* csmGetDrawableParentPartIndices(void* model);

    [DllImport(CoreLibrary.DllName, CallingConvention = CallingConvention.Cdecl)]
    public static extern void csmResetDrawableDynamicFlags(void* model);

    /// <summary>把 ANSI 字符串指针数组读成 string[]（Core 的 Id 数组均为 null 结尾 ANSI）。</summary>
    public static string[] ReadIds(byte** ids, int count)
    {
        var result = new string[count];
        for (var i = 0; i < count; i++)
        {
            result[i] = Marshal.PtrToStringAnsi((IntPtr)ids[i]) ?? "";
        }
        return result;
    }
}

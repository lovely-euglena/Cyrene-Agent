// Cubism Core 动态库的解析 / 加载 / 版本探测（T0）。
//
// License 合规：Core 二进制不随仓分发。解析顺序（先命中先用）：
//   1. CYRENE_CUBISM_CORE_DLL 环境变量（显式指定，开发/CI 用）
//   2. {dataDir}/live2d-core/Live2DCubismCore.dll（运行时下载落盘位）
//   3. 模型目录旁挂：{modelDir}/Live2DCubismCore.dll 或 {modelDir}/core/Live2DCubismCore.dll
//      （任务书兜底：「用户放入模型目录」）
//   4. 可执行文件目录 / live2d-core 子目录（随包自愿放置）
//   5. 系统默认搜索（PATH 等）
//
// 版本漂移兜底：csmReviveMocInPlace 在 Cubism 4 早期 DLL 中名为
// csmReviveMocInPlace_30——加载时探测导出名，统一走函数指针。

using System.Runtime.InteropServices;

namespace CyreneLive2D.Core;

public static unsafe class CoreLibrary
{
    public const string DllName = "Live2DCubismCore";
    public const string DllFileName = "Live2DCubismCore.dll";

    private static IntPtr _handle;
    private static string? _loadedPath;
    private static bool _resolverInstalled;

    /// <summary>已加载的 Core 版本（csmGetVersion 原始值）。</summary>
    public static uint Version { get; private set; }

    /// <summary>实际加载的 DLL 路径（诊断用）。</summary>
    public static string? LoadedPath => _loadedPath;

    /// <summary>revive 入口（兼容 _30 旧导出名）。</summary>
    public static delegate* unmanaged[Cdecl]<void*, uint, void*> ReviveMocInPlace { get; private set; }

    /// <summary>渲染序入口（Core 6 名 csmGetRenderOrders；Core 5 名 csmGetDrawableRenderOrders）。</summary>
    public static delegate* unmanaged[Cdecl]<void*, int*> GetRenderOrders { get; private set; }

    public static bool IsLoaded => _handle != IntPtr.Zero;

    /// <summary>格式化版本号：0x04020004 → "4.2.4"。</summary>
    public static string VersionString
    {
        get
        {
            var v = Version;
            return $"{(v >> 24) & 0xFF}.{(v >> 16) & 0xFF}.{v & 0xFFFF}";
        }
    }

    /// <summary>
    /// 解析并加载 Core。失败抛 <see cref="CoreNotAvailableException"/>（宿主据此
    /// 回 E_CORE_MISSING，Electron 侧回退 web 轨）。
    /// </summary>
    public static void Load(string? dataDir, string? modelDir)
    {
        if (IsLoaded) return;

        var candidates = new List<string>();
        var envPath = Environment.GetEnvironmentVariable("CYRENE_CUBISM_CORE_DLL");
        if (!string.IsNullOrWhiteSpace(envPath)) candidates.Add(envPath);
        if (!string.IsNullOrWhiteSpace(dataDir))
            candidates.Add(Path.Combine(dataDir, "live2d-core", DllFileName));
        if (!string.IsNullOrWhiteSpace(modelDir))
        {
            candidates.Add(Path.Combine(modelDir, DllFileName));
            candidates.Add(Path.Combine(modelDir, "core", DllFileName));
        }
        var exeDir = AppContext.BaseDirectory;
        candidates.Add(Path.Combine(exeDir, DllFileName));
        candidates.Add(Path.Combine(exeDir, "live2d-core", DllFileName));

        foreach (var path in candidates)
        {
            if (!File.Exists(path)) continue;
            if (TryLoadFrom(path)) return;
        }

        // 系统默认搜索（PATH / 已加载模块）
        if (NativeLibrary.TryLoad(DllName, out _handle))
        {
            _loadedPath = DllName;
            if (TryInitialize()) return;
            NativeLibrary.Free(_handle);
            _handle = IntPtr.Zero;
        }

        throw new CoreNotAvailableException(
            "未找到 Live2DCubismCore.dll。请通过应用内下载（设置→桌宠）或从 " +
            "https://www.live2d.com/en/sdk/download/native/ 下载 Cubism SDK for Native，" +
            $"将 Core/dll/windows/x86_64/{DllFileName} 放入模型目录或 {Path.Combine(dataDir ?? "<dataDir>", "live2d-core")}。");
    }

    private static bool TryLoadFrom(string path)
    {
        if (!NativeLibrary.TryLoad(path, out _handle)) return false;
        _loadedPath = Path.GetFullPath(path);
        if (TryInitialize()) return true;
        NativeLibrary.Free(_handle);
        _handle = IntPtr.Zero;
        _loadedPath = null;
        return false;
    }

    private static bool TryInitialize()
    {
        InstallResolver();

        if (!NativeLibrary.TryGetExport(_handle, "csmGetVersion", out var verPtr)) return false;
        var getVersion = (delegate* unmanaged[Cdecl]<uint>)verPtr;
        Version = getVersion();

        // revive 入口版本探测：新名优先，旧名（_30）兜底
        if (NativeLibrary.TryGetExport(_handle, "csmReviveMocInPlace", out var revivePtr))
        {
            ReviveMocInPlace = (delegate* unmanaged[Cdecl]<void*, uint, void*>)revivePtr;
        }
        else if (NativeLibrary.TryGetExport(_handle, "csmReviveMocInPlace_30", out revivePtr))
        {
            ReviveMocInPlace = (delegate* unmanaged[Cdecl]<void*, uint, void*>)revivePtr;
        }
        else
        {
            return false;
        }

        // 渲染序入口版本探测：Core 6（csmGetRenderOrders）优先，Core 5 旧名兜底
        if (NativeLibrary.TryGetExport(_handle, "csmGetRenderOrders", out var ordersPtr))
        {
            GetRenderOrders = (delegate* unmanaged[Cdecl]<void*, int*>)ordersPtr;
        }
        else if (NativeLibrary.TryGetExport(_handle, "csmGetDrawableRenderOrders", out ordersPtr))
        {
            GetRenderOrders = (delegate* unmanaged[Cdecl]<void*, int*>)ordersPtr;
        }
        else
        {
            return false;
        }

        return true;
    }

    private static void InstallResolver()
    {
        if (_resolverInstalled) return;
        NativeLibrary.SetDllImportResolver(typeof(CoreNative).Assembly, (name, assembly, searchPath) =>
        {
            if (name == DllName && _handle != IntPtr.Zero) return _handle;
            return IntPtr.Zero; // 其余走默认
        });
        _resolverInstalled = true;
    }

    /// <summary>T0 冒烟：版本 / 最新 moc 版本 / 日志回调可用性。</summary>
    public static (uint version, CsmMocVersion latestMoc) Smoke()
    {
        EnsureLoaded();
        return (Version, CoreNative.csmGetLatestMocVersion());
    }

    public static void EnsureLoaded()
    {
        if (!IsLoaded) throw new CoreNotAvailableException("Core 尚未加载（先调用 CoreLibrary.Load）。");
    }
}

/// <summary>Core 不可用（缺失/导出不符）。Electron 侧据此回退 web 轨。</summary>
public sealed class CoreNotAvailableException : Exception
{
    public CoreNotAvailableException(string message) : base(message) { }
}

using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.Json;

namespace CyreneNative.Tools;

/// <summary>now：时区感知当前时间。宿主注入用户时区（connectConfig 帧）。</summary>
internal static class NowTool
{
    internal static string? Timezone { get; set; }

    public static object Execute(JsonElement? args)
    {
        var tz = Timezone;
        if (string.IsNullOrEmpty(tz)) tz = "Asia/Shanghai";
        var format = args?.TryGetProperty("format", out var f) == true ? f.GetString() : "default";
        var now = DateTimeOffset.Now;
        return format switch
        {
            "epoch" => now.ToUnixTimeMilliseconds().ToString(),
            "iso" => now.ToString("O"),
            _ => HumanReadable(now, tz),
        };
    }

    private static object HumanReadable(DateTimeOffset now, string tz)
    {
        string local;
        try { local = TimeZoneInfo.ConvertTime(now, TimeZoneInfo.FindSystemTimeZoneById(tz)).ToString("yyyy-MM-dd dddd HH:mm:ss"); }
        catch { local = now.ToString("yyyy-MM-dd dddd HH:mm:ss"); }
        return $"{local}（时区 {tz}）\n{JsonSerializer.Serialize(new { now = now.ToUnixTimeMilliseconds(), iso = now.ToString("O"), timezone = tz })}";
    }
}

/// <summary>clipboard：WPF 剪贴板，STA 线程 marshal（后台线程调用安全）。</summary>
internal static class ClipboardTool
{
    private const int ReadLimit = 200_000;

    public static object Execute(JsonElement? args)
    {
        var action = args?.TryGetProperty("action", out var a) == true ? a.GetString() : "read";
        if (action == "write")
        {
            var text = args?.TryGetProperty("text", out var t) == true ? t.GetString() : "";
            RunSta<bool>(() => { System.Windows.Clipboard.SetText(text ?? ""); return true; });
            return new { written = (text ?? "").Length };
        }
        // read
        var got = RunSta<string?>(() => System.Windows.Clipboard.ContainsText() ? System.Windows.Clipboard.GetText() : null);
        if (string.IsNullOrEmpty(got)) return new { text = "", empty = true };
        return new { text = got.Length > ReadLimit ? got[..ReadLimit] + $"\n…（已截断，共 {got.Length} 字符）" : got };
    }

    private static T RunSta<T>(Func<T> func)
    {
        if (Thread.CurrentThread.GetApartmentState() == ApartmentState.STA) return func();
        T result = default!;
        var t = new Thread(() => result = func());
        t.SetApartmentState(ApartmentState.STA);
        t.Start();
        t.Join(TimeSpan.FromSeconds(3));
        return result;
    }
}

/// <summary>sysinfo：系统信息快照（native API，无 PowerShell 子进程）。</summary>
internal static class SysInfo
{
    [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
    private struct MEMORYSTATUSEX
    {
        public uint dwLength;
        public uint dwMemoryLoad;
        public ulong ullTotalPhys;
        public ulong ullAvailPhys;
        public ulong ullTotalPageFile, ullAvailPageFile, ullTotalVirtual, ullAvailVirtual, ullAvailExtendedVirtual;
    }

    [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
    [return: System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.Bool)]
    private static extern bool GlobalMemoryStatusEx(ref MEMORYSTATUSEX lpBuffer);

    public static object Execute()
    {
        var proc = Process.GetCurrentProcess();
        var mem = new MEMORYSTATUSEX { dwLength = (uint)System.Runtime.InteropServices.Marshal.SizeOf<MEMORYSTATUSEX>() };
        _ = GlobalMemoryStatusEx(ref mem);
        return new
        {
            os = Environment.OSVersion.VersionString,
            machine = Environment.MachineName,
            cpuCount = Environment.ProcessorCount,
            processUptimeMs = (long)(DateTime.UtcNow - proc.StartTime.ToUniversalTime()).TotalMilliseconds,
            workingSetMB = Math.Round(proc.WorkingSet64 / 1024.0 / 1024.0, 1),
            totalPhysicalGB = Math.Round(mem.ullTotalPhys / 1024.0 / 1024 / 1024, 1),
            availablePhysicalGB = Math.Round(mem.ullAvailPhys / 1024.0 / 1024 / 1024, 1),
            memoryLoadPct = mem.dwMemoryLoad,
            dotnetVersion = Environment.Version.ToString(),
        };
    }
}

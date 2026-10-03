using System.Diagnostics;
using System.Runtime.InteropServices;

namespace CyreneNative.Tools;

/// <summary>
/// sysinfo：系统信息快照（native API，无 PowerShell 子进程）。
/// Windows 走 GlobalMemoryStatusEx；Linux 读 /proc/meminfo；其余平台内存字段为 0。
/// </summary>
internal static class SysInfo
{
    [StructLayout(LayoutKind.Sequential)]
    private struct MEMORYSTATUSEX
    {
        public uint dwLength;
        public uint dwMemoryLoad;
        public ulong ullTotalPhys;
        public ulong ullAvailPhys;
        public ulong ullTotalPageFile, ullAvailPageFile, ullTotalVirtual, ullAvailVirtual, ullAvailExtendedVirtual;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GlobalMemoryStatusEx(ref MEMORYSTATUSEX lpBuffer);

    public static object Execute()
    {
        var proc = Process.GetCurrentProcess();
        double totalGb = 0, availGb = 0;
        uint load = 0;
        if (OperatingSystem.IsWindows())
        {
            var mem = new MEMORYSTATUSEX { dwLength = (uint)Marshal.SizeOf<MEMORYSTATUSEX>() };
            if (GlobalMemoryStatusEx(ref mem))
            {
                totalGb = mem.ullTotalPhys / 1024.0 / 1024 / 1024;
                availGb = mem.ullAvailPhys / 1024.0 / 1024 / 1024;
                load = mem.dwMemoryLoad;
            }
        }
        else if (OperatingSystem.IsLinux())
        {
            (totalGb, availGb) = ReadLinuxMemInfo();
            if (totalGb > 0)
                load = (uint)Math.Clamp(Math.Round((totalGb - availGb) / totalGb * 100), 0, 100);
        }
        return new
        {
            os = Environment.OSVersion.VersionString,
            machine = Environment.MachineName,
            cpuCount = Environment.ProcessorCount,
            processUptimeMs = (long)(DateTime.UtcNow - proc.StartTime.ToUniversalTime()).TotalMilliseconds,
            workingSetMB = Math.Round(proc.WorkingSet64 / 1024.0 / 1024.0, 1),
            totalPhysicalGB = Math.Round(totalGb, 1),
            availablePhysicalGB = Math.Round(availGb, 1),
            memoryLoadPct = load,
            dotnetVersion = Environment.Version.ToString(),
        };
    }

    /// <summary>解析 /proc/meminfo 的 MemTotal / MemAvailable（KB → GB）。失败返回 (0,0)。</summary>
    private static (double TotalGb, double AvailableGb) ReadLinuxMemInfo()
    {
        try
        {
            double totalKb = 0, availKb = 0;
            foreach (var line in File.ReadLines("/proc/meminfo"))
            {
                if (line.StartsWith("MemTotal:", StringComparison.Ordinal)) totalKb = ParseKb(line);
                else if (line.StartsWith("MemAvailable:", StringComparison.Ordinal)) availKb = ParseKb(line);
                if (totalKb > 0 && availKb > 0) break;
            }
            return (totalKb / 1024 / 1024, availKb / 1024 / 1024);
        }
        catch
        {
            return (0, 0);
        }
    }

    private static double ParseKb(string line)
    {
        var parts = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        return parts.Length >= 2
            && double.TryParse(parts[1], System.Globalization.CultureInfo.InvariantCulture, out var kb)
            ? kb : 0;
    }
}

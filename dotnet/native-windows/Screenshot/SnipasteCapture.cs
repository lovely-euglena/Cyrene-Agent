using System.Diagnostics;
using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Media.Imaging;
using Microsoft.Win32;

namespace CyreneNative.Screenshot;

/// <summary>
/// Snipaste 命令行截图（cyrene-native --snipaste-capture）。
///
/// 一次性进程：探测 Snipaste → 确保常驻进程在跑 → 调
/// `Snipaste.exe snip --block -o clipboard` → 用剪贴板差值判定成功/取消 →
/// 落盘 PNG → stdout 输出单行 JSON。
///
/// 参数：
///   --output-dir &lt;dir&gt;          截图目录（clipboard-and-file 模式必填）
///   --mode clipboard-only|clipboard-and-file   默认 clipboard-and-file
///   --snipaste-path &lt;exe&gt;       显式路径（设置里手填；填了不回退自动探测）
///   --timeout-ms &lt;n&gt;            单次截图交互硬上限，默认 10 分钟
///   --resident-timeout-ms &lt;n&gt;   拉起常驻进程后的就绪等待上限，默认 8 秒
///
/// 输出（stdout 单行 JSON；诊断走 stderr）：
///   {"ok":true,"filePath":"...","width":800,"height":600}
///   {"ok":false,"error":"SNIPASTE_NOT_FOUND|SNIPASTE_START_FAILED|SNIPASTE_TIMEOUT|SCREENSHOT_CANCELLED|INVALID_SNIPASTE_IMAGE|SNIPASTE_FAILED","message":"..."}
///
/// STA：Main 带 [STAThread]，剪贴板访问必须在调用线程完成（本类全程同步）。
/// </summary>
internal static class SnipasteCapture
{
    private const string ExeName = "Snipaste.exe";

    private sealed record CaptureOptions(
        string OutputDir,
        string Mode,
        string? SnipastePath,
        int TimeoutMs,
        int ResidentTimeoutMs);

    private sealed record CaptureResult(string? FilePath, int Width, int Height);

    private sealed class SnipasteCaptureException(string code, string message) : Exception(message)
    {
        public string Code { get; } = code;
    }

    public static int Run(string[] args)
    {
        CaptureOptions options;
        try
        {
            options = ParseArgs(args);
        }
        catch (Exception ex)
        {
            WriteResult(false, "SNIPASTE_ARGS_INVALID", ex.Message, null, 0, 0);
            return 0;
        }

        try
        {
            var result = Capture(options);
            WriteResult(true, null, null, result.FilePath, result.Width, result.Height);
        }
        catch (SnipasteCaptureException ex)
        {
            WriteResult(false, ex.Code, ex.Message, null, 0, 0);
        }
        catch (Exception ex)
        {
            WriteResult(false, "SNIPASTE_FAILED", ex.Message, null, 0, 0);
        }
        return 0;
    }

    private static CaptureOptions ParseArgs(string[] args)
    {
        string? outputDir = null;
        var mode = "clipboard-and-file";
        string? snipastePath = null;
        var timeoutMs = 10 * 60_000;
        var residentTimeoutMs = 8_000;

        for (var i = 0; i < args.Length; i++)
        {
            switch (args[i])
            {
                case "--output-dir":
                    outputDir = RequireValue(args, ref i);
                    break;
                case "--mode":
                    mode = RequireValue(args, ref i);
                    break;
                case "--snipaste-path":
                    snipastePath = RequireValue(args, ref i);
                    break;
                case "--timeout-ms":
                    if (!int.TryParse(RequireValue(args, ref i), out timeoutMs) || timeoutMs < 1000)
                        throw new ArgumentException("--timeout-ms 必须是 ≥1000 的整数");
                    break;
                case "--resident-timeout-ms":
                    if (!int.TryParse(RequireValue(args, ref i), out residentTimeoutMs) || residentTimeoutMs < 500)
                        throw new ArgumentException("--resident-timeout-ms 必须是 ≥500 的整数");
                    break;
                default:
                    throw new ArgumentException($"未知参数: {args[i]}");
            }
        }

        if (mode is not ("clipboard-only" or "clipboard-and-file"))
            throw new ArgumentException($"--mode 只能是 clipboard-only 或 clipboard-and-file，收到: {mode}");
        if (mode == "clipboard-and-file" && string.IsNullOrWhiteSpace(outputDir))
            throw new ArgumentException("clipboard-and-file 模式必须提供 --output-dir");

        return new CaptureOptions((outputDir ?? "").Trim(), mode, snipastePath, timeoutMs, residentTimeoutMs);
    }

    private static string RequireValue(string[] args, ref int index)
    {
        if (index + 1 >= args.Length) throw new ArgumentException($"{args[index]} 缺少参数值");
        index++;
        return args[index];
    }

    private static CaptureResult Capture(CaptureOptions options)
    {
        var exe = ResolveSnipasteExe(options.SnipastePath)
            ?? throw new SnipasteCaptureException(
                "SNIPASTE_NOT_FOUND",
                "未检测到 Snipaste，请在设置中填写 Snipaste.exe 路径");

        EnsureResidentRunning(exe, options.ResidentTimeoutMs);

        var before = TryReadClipboardPng();

        using var process = StartSnipCommand(exe);
        if (!process.WaitForExit(options.TimeoutMs))
        {
            TryKill(process);
            throw new SnipasteCaptureException("SNIPASTE_TIMEOUT", "Snipaste 截图等待超时");
        }

        var after = TryReadClipboardPng();
        if (after is null || (before is not null && before.AsSpan().SequenceEqual(after)))
        {
            throw new SnipasteCaptureException("SCREENSHOT_CANCELLED", "已取消截图");
        }

        var size = ReadPngSize(after)
            ?? throw new SnipasteCaptureException("INVALID_SNIPASTE_IMAGE", "剪贴板截图不是有效 PNG");

        string? filePath = null;
        if (options.Mode == "clipboard-and-file")
        {
            Directory.CreateDirectory(options.OutputDir);
            filePath = Path.Combine(options.OutputDir, $"{Guid.NewGuid():D}.png");
            File.WriteAllBytes(filePath, after);
        }

        return new CaptureResult(filePath, size.Width, size.Height);
    }

    private static Process StartSnipCommand(string exe)
    {
        var startInfo = new ProcessStartInfo(exe, "snip --block -o clipboard")
        {
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        return Process.Start(startInfo)
            ?? throw new SnipasteCaptureException("SNIPASTE_START_FAILED", "无法启动 Snipaste");
    }

    private static void TryKill(Process process)
    {
        try { process.Kill(entireProcessTree: true); }
        catch { /* 已退出 */ }
    }

    // ── 常驻进程 ─────────────────────────────────────────────

    private static void EnsureResidentRunning(string exe, int timeoutMs)
    {
        if (IsResidentRunning()) return;
        try
        {
            Process.Start(new ProcessStartInfo(exe) { UseShellExecute = true });
        }
        catch
        {
            // 拉起失败由下方轮询统一报错
        }

        var deadline = Environment.TickCount64 + timeoutMs;
        while (Environment.TickCount64 < deadline)
        {
            Thread.Sleep(250);
            if (IsResidentRunning()) return;
        }
        throw new SnipasteCaptureException("SNIPASTE_START_FAILED", "Snipaste 常驻进程未就绪");
    }

    private static bool IsResidentRunning()
    {
        try
        {
            return Process.GetProcessesByName("Snipaste").Length > 0;
        }
        catch
        {
            return false;
        }
    }

    // ── 探测 ────────────────────────────────────────────────

    private static string? ResolveSnipasteExe(string? explicitPath)
    {
        var explicitClean = Clean(explicitPath);
        if (!string.IsNullOrEmpty(explicitClean)) return File.Exists(explicitClean) ? explicitClean : null;

        var envPath = Clean(Environment.GetEnvironmentVariable("CYRENE_SNIPASTE_PATH"));
        if (!string.IsNullOrEmpty(envPath)) return File.Exists(envPath) ? envPath : null;

        var fromPath = FindInPath();
        if (fromPath is not null) return fromPath;

        foreach (var candidate in CommonCandidates())
        {
            if (File.Exists(candidate)) return candidate;
        }

        return FindInRegistry();
    }

    private static string? Clean(string? value)
    {
        var trimmed = value?.Trim().Trim('"');
        return string.IsNullOrEmpty(trimmed) ? null : trimmed;
    }

    private static string? FindInPath()
    {
        var pathValue = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (var entry in pathValue.Split(';'))
        {
            var dir = Clean(entry);
            if (string.IsNullOrEmpty(dir)) continue;
            var candidate = Path.Combine(dir, ExeName);
            if (File.Exists(candidate)) return candidate;
        }
        return null;
    }

    private static IEnumerable<string> CommonCandidates()
    {
        var programFiles = Clean(Environment.GetEnvironmentVariable("ProgramFiles"));
        var programFilesX86 = Clean(Environment.GetEnvironmentVariable("ProgramFiles(x86)"));
        var localAppData = Clean(Environment.GetEnvironmentVariable("LOCALAPPDATA"));
        var appData = Clean(Environment.GetEnvironmentVariable("APPDATA"));

        if (programFiles is not null) yield return Path.Combine(programFiles, "Snipaste", ExeName);
        if (programFilesX86 is not null) yield return Path.Combine(programFilesX86, "Snipaste", ExeName);
        if (localAppData is not null)
        {
            yield return Path.Combine(localAppData, "Programs", "Snipaste", ExeName);
            yield return Path.Combine(localAppData, "Microsoft", "WindowsApps", ExeName);
        }
        if (appData is not null) yield return Path.Combine(appData, "Snipaste", ExeName);
    }

    private static string? FindInRegistry()
    {
        var view = Environment.Is64BitOperatingSystem ? RegistryView.Registry64 : RegistryView.Registry32;
        foreach (var hive in new[] { RegistryHive.CurrentUser, RegistryHive.LocalMachine })
        {
            using var baseKey = RegistryKey.OpenBaseKey(hive, view);
            var path = @"Software\Microsoft\Windows\CurrentVersion\Uninstall";
            using var uninstall = baseKey.OpenSubKey(path);
            if (uninstall is null) continue;
            foreach (var subKeyName in uninstall.GetSubKeyNames())
            {
                using var sub = uninstall.OpenSubKey(subKeyName);
                if (sub is null) continue;
                var displayName = sub.GetValue("DisplayName") as string;
                if (displayName is null || !displayName.Contains("Snipaste", StringComparison.OrdinalIgnoreCase)) continue;
                var resolved = ResolveFromUninstallEntry(sub);
                if (resolved is not null) return resolved;
            }
        }
        return null;
    }

    private static string? ResolveFromUninstallEntry(RegistryKey sub)
    {
        var displayIcon = Clean(sub.GetValue("DisplayIcon") as string);
        if (!string.IsNullOrEmpty(displayIcon))
        {
            var withoutIndex = displayIcon.EndsWith(",0", StringComparison.Ordinal)
                ? displayIcon[..^2]
                : displayIcon;
            withoutIndex = Clean(withoutIndex);
            if (!string.IsNullOrEmpty(withoutIndex)
                && File.Exists(withoutIndex)
                && withoutIndex.EndsWith(".exe", StringComparison.OrdinalIgnoreCase))
            {
                return withoutIndex;
            }
        }

        var installLocation = Clean(sub.GetValue("InstallLocation") as string);
        if (!string.IsNullOrEmpty(installLocation))
        {
            var candidate = installLocation.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)
                ? installLocation
                : Path.Combine(installLocation, ExeName);
            if (File.Exists(candidate)) return candidate;
        }
        return null;
    }

    // ── 剪贴板 / PNG ─────────────────────────────────────────

    private static byte[]? TryReadClipboardPng()
    {
        for (var attempt = 0; attempt < 3; attempt++)
        {
            try
            {
                var image = Clipboard.GetImage();
                if (image is null) return null;
                var encoder = new PngBitmapEncoder();
                encoder.Frames.Add(BitmapFrame.Create(image));
                using var stream = new MemoryStream();
                encoder.Save(stream);
                return stream.ToArray();
            }
            catch
            {
                Thread.Sleep(100);
            }
        }
        return null;
    }

    private static (int Width, int Height)? ReadPngSize(byte[] buffer)
    {
        if (buffer.Length < 24) return null;
        ReadOnlySpan<byte> signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
        for (var i = 0; i < signature.Length; i++)
        {
            if (buffer[i] != signature[i]) return null;
        }
        var width = (buffer[16] << 24) | (buffer[17] << 16) | (buffer[18] << 8) | buffer[19];
        var height = (buffer[20] << 24) | (buffer[21] << 16) | (buffer[22] << 8) | buffer[23];
        if (width <= 0 || height <= 0) return null;
        return (width, height);
    }

    // ── 输出 ────────────────────────────────────────────────

    private static void WriteResult(bool ok, string? error, string? message, string? filePath, int width, int height)
    {
        var payload = JsonSerializer.Serialize(new
        {
            ok,
            error,
            message,
            filePath,
            width,
            height,
        });
        Console.Out.WriteLine(payload);
        Console.Out.Flush();
    }
}

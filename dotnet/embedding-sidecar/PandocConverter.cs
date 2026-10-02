using System.Diagnostics;
using System.Text;
using System.Text.RegularExpressions;

namespace CyreneEmbedSidecar;

/// <summary>
/// Pandoc 文档转换（文档导入链路的唯一实现，TS 侧只做路由与传参）：
///   扩展名路由 → 可执行文件解析（自定义路径 / PATH）→ 能力探测
///   （--version + --list-input-formats，按 exe + mtime 缓存）→ 转换
///   （stdin 输入、优先 --sandbox、超时/取消 kill、stdout 上限）
///   → markdown 清洗（图片/属性/HTML/控制字符/空行、4M 字符上限）。
///
/// 安全约定：
///   - 不经 shell；argv 里不出现用户文件路径（内容走 stdin）；
///   - 输入 ≤ 50MB、stdout ≤ 8MB、默认超时 60s；取消/超时/超限都 kill；
///   - 临时目录 %TEMP%/cyrene-pandoc-*，finally 清理（媒体文件不落地保留）。
/// </summary>
public static class PandocConverter
{
    public const int MaxInputBytes = 50 * 1024 * 1024;
    public const int MaxOutputBytes = 8 * 1024 * 1024;
    public const int MaxCleanChars = 4_000_000;
    public const int DefaultTimeoutMs = 60_000;

    /// <summary>扩展名 → pandoc reader 名（与 TS file-ingest.ts 的 PANDOC_EXTS 同源，改动需双端同步）。</summary>
    private static readonly Dictionary<string, string> InputExts = new(StringComparer.OrdinalIgnoreCase)
    {
        [".docx"] = "docx",
        [".odt"] = "odt",
        [".rtf"] = "rtf",
        [".epub"] = "epub",
        [".fb2"] = "fb2",
        [".ipynb"] = "ipynb",
        [".tex"] = "latex",
        [".latex"] = "latex",
        [".rst"] = "rst",
        [".org"] = "org",
        [".opml"] = "opml",
        [".dbk"] = "docbook",
        [".docbook"] = "docbook",
        [".textile"] = "textile",
        [".t2t"] = "t2t",
        [".asciidoc"] = "asciidoc",
        [".adoc"] = "asciidoc",
        [".typ"] = "typst",
        [".djot"] = "djot",
        [".muse"] = "muse",
        [".mdoc"] = "mdoc",
        [".icml"] = "icml",
        [".jats"] = "jats",
        [".wiki"] = "mediawiki",
        [".creole"] = "creole",
    };

    public sealed record ProbeResult(string Version, HashSet<string> InputFormats, string Exe);

    /// <summary>Ok=true 时 Text 为清洗后的 markdown；失败时 Reason 可直接展示给用户。</summary>
    public sealed record ConvertResult(bool Ok, string? Text, string? Reason, string Code);

    public static bool IsPandocExt(string ext) => InputExts.ContainsKey(ext);

    public static string? GetReader(string ext) => InputExts.TryGetValue(ext, out var reader) ? reader : null;

    // ── 可执行文件解析 ──

    /// <summary>自定义路径为文件直接用、目录拼 pandoc(.exe)；空则查 PATH。找不到返回 null。</summary>
    public static string? ResolveExecutable(string? customPath)
    {
        var trimmed = (customPath ?? "").Trim().Trim('"');
        if (trimmed.Length > 0) return ResolveCandidate(trimmed);

        var pathEnv = Environment.GetEnvironmentVariable("PATH") ?? "";
        var name = OperatingSystem.IsWindows() ? "pandoc.exe" : "pandoc";
        foreach (var dir in pathEnv.Split(Path.PathSeparator))
        {
            if (string.IsNullOrWhiteSpace(dir)) continue;
            var candidate = Path.Combine(dir, name);
            if (File.Exists(candidate)) return candidate;
        }
        return null;
    }

    private static string? ResolveCandidate(string candidate)
    {
        if (File.Exists(candidate)) return candidate;
        if (Directory.Exists(candidate))
        {
            foreach (var name in new[] { "pandoc.exe", "pandoc" })
            {
                var full = Path.Combine(candidate, name);
                if (File.Exists(full)) return full;
            }
            return null;
        }
        // 用户只粘贴了无扩展名路径：Windows 下补 .exe 再试
        if (OperatingSystem.IsWindows() && Path.GetExtension(candidate).Length == 0)
        {
            var withExe = candidate + ".exe";
            if (File.Exists(withExe)) return withExe;
        }
        return null;
    }

    // ── 能力探测（按 exe + mtime 缓存） ──

    private static readonly object ProbeLock = new();
    private static readonly Dictionary<string, (long MtimeTicks, ProbeResult? Result)> ProbeCache = new();

    public static ProbeResult? Probe(string exe)
    {
        long mtimeTicks;
        try
        {
            mtimeTicks = File.GetLastWriteTimeUtc(exe).Ticks;
        }
        catch
        {
            return null;
        }
        lock (ProbeLock)
        {
            if (ProbeCache.TryGetValue(exe, out var cached) && cached.MtimeTicks == mtimeTicks) return cached.Result;
        }
        var result = ProbeUncached(exe);
        lock (ProbeLock)
        {
            ProbeCache[exe] = (mtimeTicks, result);
        }
        return result;
    }

    private static ProbeResult? ProbeUncached(string exe)
    {
        var versionRun = RunCaptured(exe, new[] { "--version" });
        if (versionRun is null || versionRun.Value.ExitCode != 0) return null;
        var version = ParseVersion(versionRun.Value.Stdout);
        if (version is null) return null;

        var formatsRun = RunCaptured(exe, new[] { "--list-input-formats" });
        if (formatsRun is null || formatsRun.Value.ExitCode != 0) return null;
        var formats = new HashSet<string>(
            formatsRun.Value.Stdout.Split('\n').Select(line => line.Trim()).Where(line => line.Length > 0));
        return new ProbeResult(version, formats, exe);
    }

    /// <summary>从 `pandoc --version` 输出解析版本号（如 "3.1.2"）；失败返回 null。</summary>
    public static string? ParseVersion(string stdout)
    {
        var match = Regex.Match(stdout, @"pandoc(?:\.exe)?\s+([0-9][0-9A-Za-z.\-+]*)", RegexOptions.IgnoreCase);
        return match.Success ? match.Groups[1].Value : null;
    }

    private static (int ExitCode, string Stdout)? RunCaptured(string exe, string[] args)
    {
        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = exe,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8,
            };
            foreach (var arg in args) psi.ArgumentList.Add(arg);
            using var process = Process.Start(psi);
            if (process is null) return null;
            var stdout = process.StandardOutput.ReadToEnd();
            process.StandardError.ReadToEnd();
            if (!process.WaitForExit(5_000))
            {
                TryKill(process);
                return null;
            }
            return (process.ExitCode, stdout);
        }
        catch
        {
            return null;
        }
    }

    // ── 转换 ──

    /// <summary>扩展名 → 转换 → 清洗的高层入口。失败 reason 为可展示中文文案。</summary>
    public static ConvertResult ConvertFile(
        string filePath,
        string? pandocPath,
        Func<bool> isCancelled,
        int timeoutMs = DefaultTimeoutMs)
    {
        var ext = Path.GetExtension(filePath).ToLowerInvariant();
        var reader = GetReader(ext);
        if (reader is null)
        {
            return new ConvertResult(false, null, $"不是 Pandoc 支持的格式 {ext}", "unsupported-format");
        }

        var exe = ResolveExecutable(pandocPath);
        if (exe is null)
        {
            return new ConvertResult(false, null, "需要安装 Pandoc 才能读取此格式（设置 → 偏好设置 → 文档转换）", "not-installed");
        }
        var probe = Probe(exe);
        if (probe is null)
        {
            return new ConvertResult(false, null, $"无法运行 Pandoc（{exe}），请检查路径或重新安装", "failed");
        }
        if (!probe.InputFormats.Contains(reader))
        {
            return new ConvertResult(false, null, $"当前 Pandoc {probe.Version} 不支持读取 {ext}，请升级 Pandoc", "unsupported-format");
        }

        FileInfo info;
        try
        {
            info = new FileInfo(filePath);
        }
        catch (Exception ex)
        {
            return new ConvertResult(false, null, ex.Message, "failed");
        }
        if (!info.Exists) return new ConvertResult(false, null, "不是文件", "failed");
        if (info.Length > MaxInputBytes)
        {
            return new ConvertResult(false, null, $"文件超过 {MaxInputBytes / (1024 * 1024)}MB，暂不转换", "too-large");
        }

        byte[] input;
        try
        {
            input = File.ReadAllBytes(filePath);
        }
        catch (Exception ex)
        {
            return new ConvertResult(false, null, ex.Message, "failed");
        }

        var tempDir = Path.Combine(Path.GetTempPath(), $"cyrene-pandoc-{Guid.NewGuid():N}");
        try
        {
            Directory.CreateDirectory(tempDir);
            var result = RunOnce(exe, reader, input, isCancelled, timeoutMs, MaxOutputBytes, true, tempDir);
            // 旧版 pandoc 不识别 --sandbox：去掉重试一次（仅限该错误）
            if (!result.Ok && result.Code == "failed" && result.Reason is not null
                && result.Reason.Contains("Unrecognized option", StringComparison.OrdinalIgnoreCase)
                && result.Reason.Contains("sandbox", StringComparison.OrdinalIgnoreCase))
            {
                result = RunOnce(exe, reader, input, isCancelled, timeoutMs, MaxOutputBytes, false, tempDir);
            }
            if (!result.Ok) return result;

            var (text, truncated) = CleanMarkdown(result.Text ?? "");
            return new ConvertResult(true, text, truncated ? "truncated" : null, "ok");
        }
        finally
        {
            try
            {
                Directory.Delete(tempDir, recursive: true);
            }
            catch
            {
                // 临时目录清理失败不覆盖主结果
            }
        }
    }

    private static ConvertResult RunOnce(
        string exe,
        string reader,
        byte[] input,
        Func<bool> isCancelled,
        int timeoutMs,
        int maxOutputBytes,
        bool sandbox,
        string tempDir)
    {
        // 进入时已取消：不启动子进程
        if (isCancelled()) return new ConvertResult(false, null, "已取消", "cancelled");

        var args = new List<string>
        {
            $"--from={reader}",
            "--to=markdown",
            "--wrap=none",
            $"--extract-media={Path.Combine(tempDir, "media")}",
        };
        if (sandbox) args.Insert(0, "--sandbox");

        var psi = new ProcessStartInfo
        {
            FileName = exe,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };
        foreach (var arg in args) psi.ArgumentList.Add(arg);

        using var process = new Process { StartInfo = psi };
        try
        {
            if (!process.Start()) return new ConvertResult(false, null, "无法启动 Pandoc", "not-installed");
        }
        catch (Exception ex)
        {
            return new ConvertResult(false, null, $"无法运行 Pandoc：{ex.Message}", "not-installed");
        }

        // stdin 写文件内容（独立线程，避免与 stdout 读死锁）
        _ = Task.Run(() =>
        {
            try
            {
                process.StandardInput.BaseStream.Write(input, 0, input.Length);
                process.StandardInput.Close();
            }
            catch
            {
                // 子进程提前退出导致的管道断开：由退出码分支给出真实错误
            }
        });

        var stdout = new MemoryStream();
        var stderr = new StringBuilder();
        var outputTooLarge = false;

        var stdoutTask = Task.Run(() =>
        {
            var buffer = new byte[64 * 1024];
            try
            {
                int read;
                while ((read = process.StandardOutput.BaseStream.Read(buffer, 0, buffer.Length)) > 0)
                {
                    if (stdout.Length + read > maxOutputBytes)
                    {
                        outputTooLarge = true;
                        TryKill(process);
                        break;
                    }
                    stdout.Write(buffer, 0, read);
                }
            }
            catch
            {
                // 读管道异常按退出码处理
            }
        });
        var stderrTask = Task.Run(() =>
        {
            try
            {
                var buffer = new char[4096];
                int read;
                while ((read = process.StandardError.Read(buffer, 0, buffer.Length)) > 0)
                {
                    if (stderr.Length < 16 * 1024) stderr.Append(buffer, 0, read);
                }
            }
            catch
            {
                // 同上
            }
        });

        var deadline = Environment.TickCount64 + timeoutMs;
        var cancelled = false;
        var timedOut = false;
        while (!process.WaitForExit(100))
        {
            if (isCancelled())
            {
                cancelled = true;
                TryKill(process);
                break;
            }
            if (Environment.TickCount64 > deadline)
            {
                timedOut = true;
                TryKill(process);
                break;
            }
        }
        if (cancelled || timedOut) process.WaitForExit(2_000);
        try
        {
            Task.WaitAll(new[] { stdoutTask, stderrTask }, 3_000);
        }
        catch
        {
            // 任务超时不影响主结果
        }

        if (cancelled) return new ConvertResult(false, null, "已取消", "cancelled");
        if (timedOut) return new ConvertResult(false, null, $"转换超时（{timeoutMs / 1000} 秒）", "timeout");
        if (outputTooLarge) return new ConvertResult(false, null, $"转换输出超过 {maxOutputBytes / (1024 * 1024)}MB", "output-too-large");
        if (!process.HasExited) return new ConvertResult(false, null, "Pandoc 未正常退出", "failed");
        if (process.ExitCode != 0)
        {
            var detail = LastLines(stderr.ToString());
            var reason = detail.Length > 0 ? $"Pandoc 退出码 {process.ExitCode}：{detail}" : $"Pandoc 退出码 {process.ExitCode}";
            return new ConvertResult(false, null, reason, "failed");
        }
        return new ConvertResult(true, Encoding.UTF8.GetString(stdout.ToArray()), null, "ok");
    }

    private static void TryKill(Process process)
    {
        try
        {
            if (!process.HasExited) process.Kill(entireProcessTree: true);
        }
        catch
        {
            // 进程已退出
        }
    }

    private static string LastLines(string text)
    {
        var lines = text.Split('\n').Select(line => line.TrimEnd('\r')).Where(line => line.Length > 0).ToArray();
        return string.Join(" | ", lines.TakeLast(3));
    }

    // ── 格式清洗 ──

    private static readonly Regex ImageRe = new(@"!\[([^\]]*)\]\(([^)]*)\)", RegexOptions.Compiled);
    private static readonly Regex EmptyLinkRe = new(@"\[\]\([^)]*\)", RegexOptions.Compiled);
    private static readonly Regex AttrDotHashRe = new(@"\{[.#][^{}\n]*\}", RegexOptions.Compiled);
    private static readonly Regex AttrKeyValueRe = new(@"\{[^{}\n]*=[^{}\n]*\}", RegexOptions.Compiled);
    private static readonly Regex BrRe = new(@"<br\s*/?>", RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex HtmlTagRe = new(
        @"</?(?:div|span|p|hr|table|thead|tbody|tfoot|tr|td|th|caption|colgroup|col|em|strong|b|i|u|s|del|ins|sub|sup|small|big|mark|blockquote|pre|code|kbd|samp|var|cite|q|abbr|address|article|aside|footer|header|main|nav|section|figure|figcaption|dl|dt|dd|ul|ol|li|img|a|font|center|strike|tt)\b[^>]*>",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex ControlRe = new(@"[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]", RegexOptions.Compiled);
    private static readonly Regex TrailingWsRe = new(@"[ \t]+\n", RegexOptions.Compiled);
    private static readonly Regex BlankLinesRe = new(@"\n{3,}", RegexOptions.Compiled);

    /// <summary>
    /// 清洗 pandoc 输出的 markdown：图片 → [图片]/[图片：alt]；空链接/属性块/HTML 壳去除；
    /// 控制字符与行尾空白清理；3+ 连续空行折叠为 2；超过 4M 字符截断并附说明。
    /// </summary>
    public static (string Text, bool Truncated) CleanMarkdown(string input)
    {
        var text = input.Replace("\r\n", "\n").Replace('\r', '\n');
        text = ImageRe.Replace(text, match =>
        {
            var alt = match.Groups[1].Value.Trim();
            return alt.Length > 0 ? $"[图片：{alt}]" : "[图片]";
        });
        text = EmptyLinkRe.Replace(text, "");
        text = AttrDotHashRe.Replace(text, "");
        text = AttrKeyValueRe.Replace(text, "");
        text = BrRe.Replace(text, "\n");
        text = HtmlTagRe.Replace(text, "");
        text = ControlRe.Replace(text, "");
        text = TrailingWsRe.Replace(text, "\n");
        text = BlankLinesRe.Replace(text, "\n\n");
        text = text.Trim();

        if (text.Length > MaxCleanChars)
        {
            return (text[..MaxCleanChars] + "\n\n> [内容过长，已截断]", true);
        }
        return (text, false);
    }
}

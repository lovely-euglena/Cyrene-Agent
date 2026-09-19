using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.Json;

namespace CyreneNative.Tools;

/// <summary>
/// fs 工具的 .NET 实现（D2）——与 fs-tools.ts 语义对齐：
///   read_file：带行号 JSON 结构化输出 / 10MB 上限 / 二进制启发 /
///              startLine/maxLines 精确翻页 / totalLines 真实计数
///   write_file：父目录自动创建 / 写后回显字节数
///   list_dir：文件夹在前文件在后 / 隐藏文件开关 / 图片计数标注 /
///              LIST_MAX_ENTRIES 截断 / [D][F][L][?] 行格式
/// 错误码（B5 契约）：E_FS_PATH / E_FS_NOT_FOUND / E_FS_TOO_LARGE /
///   E_FS_BINARY / E_FS_IO（与 TS 侧 retryable 语义同源）。
/// </summary>
internal static class FsTools
{
    private const int ReadMaxBytes = 10 * 1024 * 1024;
    private const int ListMaxEntries = 500;
    private static readonly HashSet<string> ImageExts =
        new(StringComparer.OrdinalIgnoreCase) { ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg" };

    public static string ReadFile(JsonElement args)
    {
        var path = args.TryGetProperty("path", out var p) ? p.GetString() : null;
        if (string.IsNullOrWhiteSpace(path))
            return Err("E_FS_PATH", "path 不能为空", false);
        path = Path.GetFullPath(path);
        if (!File.Exists(path))
            return Err("E_FS_NOT_FOUND", $"文件不存在或无法访问: {path}。不要重复读取相同路径，请先用 search_text 或 list_dir 重新定位文件。", true);
        var fi = new FileInfo(path);
        if ((fi.Attributes & FileAttributes.Directory) != 0)
            return Err("E_FS_PATH", "不是文件（是目录或其它）: " + path, false);
        var startLine = Math.Max(1, args.TryGetProperty("startLine", out var sl) && sl.ValueKind == JsonValueKind.Number ? sl.GetInt32() : 1);
        var maxLines = Math.Clamp(args.TryGetProperty("maxLines", out var ml) && ml.ValueKind == JsonValueKind.Number ? ml.GetInt32() : 500, 1, 2000);

        byte[] buf;
        try { buf = File.ReadAllBytes(path); }
        catch (Exception ex) { return Err("E_FS_IO", "读取失败: " + ex.Message, false); }

        if (buf.Length > ReadMaxBytes)
            return Err("E_FS_TOO_LARGE", $"文件超过 10MB（当前 {HumanBytes(buf.Length)}），read_file 暂不支持读取。可用 search_text 直接获取匹配行的上下文。", false);
        var head = buf.AsSpan(0, Math.Min(buf.Length, 4096));
        var nullCount = 0;
        foreach (var b in head) if (b == 0) nullCount++;
        if (nullCount > head.Length * 0.05)
            return Err("E_FS_BINARY", "这看起来是二进制文件，read_file 只支持文本。如果是图片，请改用 read_image。", false);

        var text = Encoding.UTF8.GetString(buf);
        var window = new List<string>();
        var totalLines = 1;
        var currentLine = 1;
        var lineStart = 0;
        for (var i = 0; i < text.Length; i++)
        {
            if (text[i] == '\n')
            {
                if (currentLine >= startLine && window.Count < maxLines)
                {
                    var lineEnd = i;
                    if (lineEnd > lineStart && text[lineEnd - 1] == '\r') lineEnd--;
                    window.Add(text[lineStart..lineEnd]);
                }
                currentLine++;
                totalLines++;
                lineStart = i + 1;
            }
        }
        if (currentLine >= startLine && window.Count < maxLines) window.Add(text[lineStart..]);

        var content = string.Join("\n", window.Select((line, i) => $"{startLine + i,5} | {line}"));
        return JsonSerializer.Serialize(new
        {
            path,
            startLine,
            endLine = startLine + window.Count - 1,
            totalLines,
            content,
            truncated = false,
        });
    }

    public static string WriteFile(JsonElement args)
    {
        var path = args.TryGetProperty("path", out var p) ? p.GetString() : null;
        var content = args.TryGetProperty("content", out var c) ? c.GetString() : null;
        if (string.IsNullOrWhiteSpace(path)) return Err("E_FS_PATH", "path 不能为空", false);
        path = Path.GetFullPath(path);
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            File.WriteAllText(path, content ?? "");
            return JsonSerializer.Serialize(new { path, bytes = Encoding.UTF8.GetByteCount(content ?? "") });
        }
        catch (Exception ex)
        {
            return Err("E_FS_IO", "写入失败: " + ex.Message, true);
        }
    }

    public static string ListDir(JsonElement args)
    {
        var raw = (args.TryGetProperty("path", out var p) ? p.GetString() : "")?.Trim();
        if (string.IsNullOrEmpty(raw) || !Path.IsPathRooted(raw))
            return "[错误] path 必须是绝对路径";
        var dirPath = Path.GetFullPath(raw);
        if (!Directory.Exists(dirPath)) return "[错误] 目录不存在或无法访问: " + dirPath;

        var showHidden = args.TryGetProperty("showHidden", out var h) && h.ValueKind == JsonValueKind.True;
        var filter = args.TryGetProperty("filter", out var f) && f.ValueKind == JsonValueKind.String ? f.GetString()!.Trim() : "";

        IEnumerable<FileSystemInfo> entries;
        try { entries = new DirectoryInfo(dirPath).EnumerateFileSystemInfos(); }
        catch (Exception ex) { return "[错误] 读取目录失败: " + ex.Message; }

        var list = entries.ToList();
        if (!showHidden) list = list.Where(e => !e.Name.StartsWith('.')).ToList();
        list.Sort((a, b) =>
        {
            var da = (a.Attributes & FileAttributes.Directory) != 0 ? 0 : 1;
            var db = (b.Attributes & FileAttributes.Directory) != 0 ? 0 : 1;
            return da != db ? da - db : string.Compare(a.Name, b.Name, StringComparison.OrdinalIgnoreCase);
        });

        var truncated = list.Count > ListMaxEntries;
        var slice = truncated ? list.GetRange(0, ListMaxEntries) : list;
        var imageCount = list.Count(e => (e.Attributes & FileAttributes.Directory) == 0 && ImageExts.Contains(Path.GetExtension(e.Name)));

        var lines = new List<string> { "dir: " + dirPath };
        var meta = "count: " + list.Count;
        if (imageCount > 0) meta += $" (其中图片 {imageCount} 张)";
        if (filter.Length > 0) meta += " (filter: " + filter + ")";
        if (truncated) meta += $" (仅显示前 {ListMaxEntries} 项)";
        lines.Add(meta);
        lines.Add("");
        foreach (var e in slice)
        {
            switch (e)
            {
                case DirectoryInfo:
                    lines.Add("[D] " + e.Name + "/");
                    break;
                case FileInfo f2:
                    var tag = ImageExts.Contains(f2.Extension) ? "  [图片]" : "";
                    lines.Add("[F] " + e.Name + "  " + HumanBytes(f2.Length) + tag);
                    break;
                default:
                    lines.Add((e.Attributes & FileAttributes.ReparsePoint) != 0 ? "[L] " + e.Name : "[?] " + e.Name);
                    break;
            }
        }
        return string.Join("\n", lines);
    }

    internal static string HumanBytes(long bytes)
    {
        string[] units = { "B", "KB", "MB", "GB" };
        double v = bytes;
        var u = 0;
        while (v >= 1024 && u < units.Length - 1) { v /= 1024; u++; }
        return u == 0 ? $"{v:0}B" : $"{v:0.#}{units[u]}";
    }

    internal static string Err(string code, string message, bool retryable) =>
        JsonSerializer.Serialize(new { success = false, errorCode = code, error = message, retryable });
}

/// <summary>
/// git 工具的 .NET 实现（D2）：status / log / diff —— 进程 spawn + 10s 超时
/// + 进程树清理（TaskKill /T /F 兜底），输出格式与 git-tools.ts 对齐
/// （git 原生 stdout 透传，错误前缀 [错误]）。
/// </summary>
internal static class GitTools
{
    private const int TimeoutMs = 10_000;

    public static async Task<string> Run(JsonElement args)
    {
        var sub = args.TryGetProperty("sub", out var s) ? s.GetString() : "status";
        var cwd = args.TryGetProperty("cwd", out var c) ? c.GetString() : null;
        if (string.IsNullOrEmpty(cwd) || !Directory.Exists(cwd))
            return "[错误] cwd 不存在: " + cwd;
        var (gitArgs, name) = sub switch
        {
            "log" => ("--no-pager log --oneline -n 50", "git log"),
            "diff" => ("--no-pager diff --stat", "git diff"),
            _ => ("--no-pager status --short --branch", "git status"),
        };
        return await RunGit(gitArgs, cwd!, name);
    }

    private static async Task<string> RunGit(string gitArgs, string cwd, string name)
    {
        var psi = new ProcessStartInfo("git", gitArgs)
        {
            WorkingDirectory = cwd,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };
        using var proc = Process.Start(psi);
        if (proc is null) return "[错误] git 启动失败";
        using var cts = new CancellationTokenSource(TimeoutMs);
        try
        {
            var stdoutTask = proc.StandardOutput.ReadToEndAsync(cts.Token);
            var stderrTask = proc.StandardError.ReadToEndAsync(cts.Token);
            await proc.WaitForExitAsync(cts.Token);
            var stdout = await stdoutTask;
            var stderr = await stderrTask;
            if (proc.ExitCode != 0)
                return $"[错误] {name} 失败（exit {proc.ExitCode}）: {stderr.Trim()}";
            return stdout.Length == 0 ? "（无输出）" : stdout.TrimEnd();
        }
        catch (OperationCanceledException)
        {
            KillTree(proc);
            return $"[错误] {name} 超时（>{TimeoutMs / 1000}s），已终止";
        }
    }

    private static void KillTree(Process proc)
    {
        try { _ = Process.Start(new ProcessStartInfo("taskkill", $"/PID {proc.Id} /T /F") { CreateNoWindow = true, UseShellExecute = false }); }
        catch { try { proc.Kill(true); } catch { /* ignore */ } }
    }
}

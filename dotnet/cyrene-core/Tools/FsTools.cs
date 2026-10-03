using System.IO;
using System.Text;
using System.Text.Json;

namespace CyreneNative.Tools;

/// <summary>
/// fs 工具的 .NET 实现（D2）——与 fs-tools.ts 语义对齐：
///   read_file：带行号 JSON 结构化输出 / 10MB 上限 / 二进制启发 /
///              startLine/maxLines 精确翻页 / totalLines 真实计数 / 仅绝对路径
///   write_file：父目录自动创建 / 覆盖或追加（末尾缺换行补 \n）/
///              ToolFileChange 证据（changes/diff，见 ToolEvidence.cs）
///   list_dir：文件夹在前文件在后 / 隐藏文件开关 / 图片计数标注 /
///              LIST_MAX_ENTRIES 截断（200，与 TS 对齐）/ [D][F][L][?] 行格式
/// 策略层不在本类：覆盖防骤降（checkOverwriteDrop）与 review 基线
/// （captureBefore）由 TS 宿主包装器在调用前执行。
/// 错误码（B5 契约）：E_FS_PATH / E_FS_NOT_FOUND / E_FS_TOO_LARGE /
///   E_FS_BINARY / E_FS_IO（与 TS 侧 retryable 语义同源）。
/// </summary>
internal static class FsTools
{
    private const int ReadMaxBytes = 10 * 1024 * 1024;
    // 截断上限与 TS LIST_MAX_ENTRIES 对齐（曾漂移为 500，双轨 diff 会不一致）
    private const int ListMaxEntries = 200;
    private static readonly HashSet<string> ImageExts =
        new(StringComparer.OrdinalIgnoreCase) { ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg" };

    public static string ReadFile(JsonElement args)
    {
        // 入参防御：args 非对象 / path 非字符串时给出人话错误，
        // 不让 GetString()/TryGetProperty 抛 .NET 内部英文异常（冒烟 P2/P4）
        if (args.ValueKind != JsonValueKind.Object)
            return Err("E_FS_PATH", "参数必须是 JSON 对象（含 path 绝对路径）", false);
        if (!args.TryGetProperty("path", out var pathEl))
            return Err("E_FS_PATH", "path 不能为空", false);
        if (pathEl.ValueKind != JsonValueKind.String)
            return Err("E_FS_PATH", $"path 必须是字符串（收到 {pathEl.ValueKind}）", false);
        var path = pathEl.GetString();
        if (string.IsNullOrWhiteSpace(path))
            return Err("E_FS_PATH", "path 不能为空", false);
        // 与 TS ensureAbsolute 对齐：read_file 只接受绝对路径（相对路径不得按
        // 宿主 CWD 解析，否则同一入参两轨读到不同文件）
        if (!Path.IsPathRooted(path))
            return Err("E_FS_PATH", "path 必须是绝对路径: " + path, false);
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
        var endLine = startLine + window.Count - 1;
        return JsonSerializer.Serialize(new
        {
            path,
            startLine,
            endLine,
            totalLines,
            content,
            // 窗口没盖满全部行时必须置位（Bug，冒烟 P1：曾硬编码 false，
            // 600 行读 500 行仍报 false，与 fs-tools.ts 同步修复）
            truncated = endLine < totalLines,
        });
    }

    public static string WriteFile(JsonElement args)
    {
        // 同 ReadFile：非对象 args / 非字符串 path·content 给人话错误
        if (args.ValueKind != JsonValueKind.Object)
            return Err("E_FS_PATH", "参数必须是 JSON 对象（含 path/content）", false);
        if (!args.TryGetProperty("path", out var pathEl) || pathEl.ValueKind != JsonValueKind.String)
            return Err("E_FS_PATH", "path 必须是非空字符串", false);
        var rawPath = pathEl.GetString();
        if (string.IsNullOrWhiteSpace(rawPath)) return Err("E_FS_PATH", "path 不能为空", false);
        string? content = null;
        if (args.TryGetProperty("content", out var c))
        {
            if (c.ValueKind is not (JsonValueKind.String or JsonValueKind.Null))
                return Err("E_FS_PATH", $"content 必须是字符串（收到 {c.ValueKind}）", false);
            content = c.ValueKind == JsonValueKind.String ? c.GetString() : null;
        }
        // 布尔参数与 TS 判定同口径：append === true；createDirs !== false（缺省 true）
        var append = args.TryGetProperty("append", out var ap) && ap.ValueKind == JsonValueKind.True;
        var createDirs = !(args.TryGetProperty("createDirs", out var cd) && cd.ValueKind == JsonValueKind.False);
        var text = content ?? "";

        string path;
        try { path = Path.GetFullPath(rawPath); }
        catch (Exception ex) { return Err("E_FS_PATH", "path 非法: " + ex.Message, false); }

        var existedBefore = File.Exists(path);
        string? existingContent = null;
        if (existedBefore)
        {
            try { existingContent = File.ReadAllText(path); }
            catch (Exception ex) { return Err("E_FS_IO", "写前读取原文件失败: " + ex.Message, false); }
        }

        try
        {
            if (createDirs)
            {
                var dir = Path.GetDirectoryName(path);
                if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
            }
            if (append)
            {
                // 追加写：原文件末尾缺换行时补一个，避免两段内容粘在同一行（TS 同）
                var needsNewline = existingContent is { Length: > 0 } && !existingContent.EndsWith('\n');
                File.AppendAllText(path, (needsNewline ? "\n" : "") + text);
            }
            else
            {
                File.WriteAllText(path, text);
            }
        }
        catch (Exception ex)
        {
            return Err("E_FS_IO", "写入失败: " + ex.Message, true);
        }

        long sizeBytes;
        try { sizeBytes = new FileInfo(path).Length; }
        catch (Exception ex) { return Err("E_FS_IO", "写入完成但无法确认文件状态: " + ex.Message, false); }

        // Diff Review 证据：新文件/追加=added，覆盖已有=modified（与 fs-tools.ts 同结构、
        // 同上限）；覆盖防骤降/review 基线由 TS 宿主包装器在调用前完成。
        var insertions = ToolEvidence.CountLines(text);
        List<object> diff;
        string kind;
        int deletions;
        if (append || !existedBefore)
        {
            kind = "added";
            deletions = 0;
            diff = insertions == 0
                ? new List<object>()
                : ToolEvidence.BuildFullFileDiff(text.Split('\n').Take(insertions), "add");
        }
        else
        {
            kind = "modified";
            deletions = ToolEvidence.CountLines(existingContent);
            // 覆盖写 = 整文件替换：旧全文 remove + 新全文 add，行级上限由 Finalize 控制
            diff = ToolEvidence.BuildReplacedDiff(
                (existingContent ?? "").Replace("\r\n", "\n").Split('\n'),
                text.Replace("\r\n", "\n").Split('\n'));
        }

        var change = new Dictionary<string, object?>
        {
            ["file"] = path,
            ["kind"] = kind,
            ["insertions"] = insertions,
            ["deletions"] = deletions,
            ["diff"] = diff,
        };
        var changes = new List<Dictionary<string, object?>> { change };
        ToolEvidence.Finalize(changes);

        return JsonSerializer.Serialize(new
        {
            success = true,
            tool = "write_file",
            path,
            append,
            exists = File.Exists(path),
            sizeBytes,
            writtenBytes = Encoding.UTF8.GetByteCount(text),
            changes,
        });
    }

    public static string ListDir(JsonElement args)
    {
        // 入参防御：args 非对象 / path 非字符串 → E_FS_PATH（冒烟 P2 同类）
        if (args.ValueKind != JsonValueKind.Object)
            throw new ToolHostException("E_FS_PATH", "参数必须是 JSON 对象（含 path 绝对路径）");
        if (!args.TryGetProperty("path", out var p))
            throw new ToolHostException("E_FS_PATH", "path 不能为空");
        if (p.ValueKind != JsonValueKind.String)
            throw new ToolHostException("E_FS_PATH", $"path 必须是字符串（收到 {p.ValueKind}）");
        var raw = p.GetString()?.Trim();
        if (string.IsNullOrEmpty(raw) || !Path.IsPathRooted(raw))
            throw new ToolHostException("E_FS_PATH", "path 必须是绝对路径");
        var dirPath = Path.GetFullPath(raw);
        if (!Directory.Exists(dirPath)) throw new ToolHostException("E_FS_NOT_FOUND", "目录不存在或无法访问: " + dirPath);

        var showHidden = args.TryGetProperty("showHidden", out var h) && h.ValueKind == JsonValueKind.True;
        var filter = args.TryGetProperty("filter", out var f) && f.ValueKind == JsonValueKind.String ? f.GetString()!.Trim() : "";

        IEnumerable<FileSystemInfo> entries;
        try { entries = new DirectoryInfo(dirPath).EnumerateFileSystemInfos(); }
        catch (ToolHostException) { throw; }
        catch (Exception ex) { throw new ToolHostException("E_FS_IO", "读取目录失败: " + ex.Message); }

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
        // 与 TS humanBytes 对齐：B 无小数；KB/MB 1 位；GB 2 位（toFixed 同口径）
        return u switch
        {
            0 => $"{v:0}B",
            3 => v.ToString("0.00") + "GB",
            _ => v.ToString("0.0") + units[u],
        };
    }

    internal static string Err(string code, string message, bool retryable) =>
        JsonSerializer.Serialize(new { success = false, errorCode = code, error = message, retryable });
}

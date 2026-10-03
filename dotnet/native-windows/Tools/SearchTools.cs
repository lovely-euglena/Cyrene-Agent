using System.IO;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace CyreneNative.Tools;

/// <summary>
/// search_text（含 Glob/Grep 别名共用）：工作区文本搜索——与 search-text-tools.ts 同语义。
///   - 工作区根由 TS 包装器经内部参数 `__cyreneWorkspaceRoot` 注入（模型不可见）
///   - 忽略目录/扩展名、文件大小 1MB、单行 500 字符、匹配上限 100、上下文上限 5
///   - literal/regex 两模式；regex 用 ECMAScript 选项贴近 JS 语义；无效正则按无匹配处理
///   - 路径逃逸拒绝 / message / rejectedPaths / skippedDirs 输出逐字段对齐
/// </summary>
internal static class SearchTools
{
    private const int MaxMatches = 100;
    private const int MaxContextLines = 5;
    private const int MaxLineLength = 500;
    private const long MaxFileSize = 1024 * 1024;

    private static readonly HashSet<string> IgnoredDirs = new(StringComparer.Ordinal)
    {
        ".git", ".svn", ".hg",
        "node_modules", "bower_components",
        "dist", "build", "out", "output", "release",
        ".next", ".nuxt", ".cache",
        "__pycache__", ".pytest_cache",
        ".idea", ".vscode",
        "coverage", ".nyc_output",
        "target", "vendor", ".venv", "venv",
        ".worktrees", "worktrees",
    };

    private static readonly HashSet<string> IgnoredExts = new(StringComparer.OrdinalIgnoreCase)
    {
        ".exe", ".dll", ".so", ".dylib",
        ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".svg",
        ".mp3", ".mp4", ".wav", ".avi", ".mov",
        ".zip", ".tar", ".gz", ".rar", ".7z",
        ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
        ".woff", ".woff2", ".ttf", ".eot",
        ".pyc", ".pyo", ".class", ".o", ".obj",
    };

    private sealed record SearchMatch(
        string Path, int Line, int? Column, string Preview,
        List<string> Before, List<string> After);

    public static string Search(JsonElement args)
    {
        var query = GetString(args, "query").Trim();
        if (query.Length == 0) return InvalidQueryResult();

        var workspaceRootRaw = GetString(args, "__cyreneWorkspaceRoot");
        if (string.IsNullOrWhiteSpace(workspaceRootRaw))
            throw new ToolHostException("E_SEARCH_NO_ROOT", "缺少工作区根（__cyreneWorkspaceRoot），search_text 需经宿主包装器调用");
        var workspaceRoot = Path.GetFullPath(workspaceRootRaw);

        var mode = GetString(args, "mode") == "regex" ? "regex" : "literal";
        // TS: Math.min(100, Math.max(1, Number(args.maxMatches) || 20))；contextLines 同理（0 → 默认 2）
        var maxMatches = (int)Math.Min(MaxMatches, Math.Max(1, NumOr(args, "maxMatches", 20)));
        var contextLines = (int)Math.Min(MaxContextLines, Math.Max(0, NumOr(args, "contextLines", 2)));
        var caseSensitive = args.TryGetProperty("caseSensitive", out var cs) && cs.ValueKind == JsonValueKind.True;

        var paths = GetStringArray(args, "paths") ?? new List<string> { "." };
        var fileGlobs = GetStringArray(args, "fileGlobs");
        var fileExtension = args.TryGetProperty("fileExtension", out var fe) && fe.ValueKind == JsonValueKind.String
            ? fe.GetString()!.Trim().TrimStart('.').ToLowerInvariant()
            : null;
        if (fileExtension is { Length: 0 }) fileExtension = null;

        var allMatches = new List<SearchMatch>();
        var rejectedPaths = new List<string>();
        var skippedDirs = new List<string>();

        foreach (var p in paths)
        {
            if (allMatches.Count >= maxMatches) break;
            var resolvedPath = Path.GetFullPath(Path.Combine(workspaceRoot, p));
            if (!IsWithinWorkspace(resolvedPath, workspaceRoot))
            {
                rejectedPaths.Add(p);
                continue;
            }
            if (Directory.Exists(resolvedPath))
            {
                WalkDir(resolvedPath, workspaceRoot, query, mode, caseSensitive, contextLines,
                    maxMatches - allMatches.Count, fileGlobs, fileExtension, allMatches, skippedDirs);
            }
            else if (File.Exists(resolvedPath))
            {
                var relativePath = RelativePath(workspaceRoot, resolvedPath);
                if (!ShouldIgnoreFile(resolvedPath))
                {
                    if (fileExtension != null && Path.GetExtension(resolvedPath).TrimStart('.').ToLowerInvariant() != fileExtension) continue;
                    if (fileGlobs is { Count: > 0 } && !fileGlobs.Any(g => MatchesGlob(relativePath, g))) continue;
                    allMatches.AddRange(SearchInFile(resolvedPath, relativePath, query, mode, caseSensitive,
                        contextLines, maxMatches - allMatches.Count));
                }
            }
        }

        string? message = null;
        if (rejectedPaths.Count > 0 && allMatches.Count == 0)
            message = $"路径 {string.Join(", ", rejectedPaths)} 在工作区外被拒绝，搜索未执行。Grep 只能搜索工作区内文件。要确认工作区外文件是否存在，请用 Glob 或 run_shell。";
        else if (rejectedPaths.Count > 0)
            message = $"路径 {string.Join(", ", rejectedPaths)} 在工作区外被拒绝，已跳过。";
        else if (allMatches.Count == 0)
            message = "未找到匹配内容。这不代表目标文件不存在——Grep 搜索的是文件内容，不是文件名。要查找文件请用 Glob。";
        if (skippedDirs.Count > 0)
        {
            var note = $"已排除镜像/依赖目录：{string.Join(", ", skippedDirs.Take(5))}。这些目录里的内容不是当前工作区代码，不参与匹配。";
            message = message == null ? note : $"{message} {note}";
        }

        var returned = Math.Min(allMatches.Count, maxMatches);
        var result = new Dictionary<string, object?>
        {
            ["matches"] = allMatches.Take(maxMatches).Select(m => MatchJson(m)).ToList(),
            ["totalMatches"] = allMatches.Count,
            ["returnedMatches"] = returned,
            ["truncated"] = allMatches.Count > maxMatches,
            ["searchType"] = "content",
        };
        if (message != null) result["message"] = message;
        if (rejectedPaths.Count > 0) result["rejectedPaths"] = rejectedPaths;
        if (skippedDirs.Count > 0) result["skippedDirs"] = skippedDirs.Take(10).ToList();
        return JsonSerializer.Serialize(result);
    }

    private static Dictionary<string, object?> MatchJson(SearchMatch m)
    {
        var json = new Dictionary<string, object?>
        {
            ["path"] = m.Path,
            ["line"] = m.Line,
        };
        if (m.Column.HasValue) json["column"] = m.Column.Value;
        json["preview"] = m.Preview;
        json["before"] = m.Before;
        json["after"] = m.After;
        return json;
    }

    private static void WalkDir(
        string dir, string workspaceRoot, string query, string mode, bool caseSensitive,
        int contextLines, int maxMatches, List<string>? fileGlobs, string? fileExtension,
        List<SearchMatch> allMatches, List<string> skippedDirs)
    {
        if (allMatches.Count >= maxMatches) return;
        FileSystemInfo[] entries;
        try { entries = new DirectoryInfo(dir).GetFileSystemInfos(); }
        catch { return; }

        foreach (var entry in entries)
        {
            if (allMatches.Count >= maxMatches) return;
            // TS Dirent 对符号链接既非 isDirectory 也非 isFile → 跳过；镜像该行为
            if ((entry.Attributes & FileAttributes.ReparsePoint) != 0) continue;

            var fullPath = entry.FullName;
            var relativePath = RelativePath(workspaceRoot, fullPath);

            if ((entry.Attributes & FileAttributes.Directory) != 0)
            {
                if (IgnoredDirs.Contains(entry.Name))
                {
                    if (!skippedDirs.Contains(entry.Name)) skippedDirs.Add(entry.Name);
                }
                else
                {
                    WalkDir(fullPath, workspaceRoot, query, mode, caseSensitive, contextLines,
                        maxMatches, fileGlobs, fileExtension, allMatches, skippedDirs);
                }
            }
            else
            {
                if (ShouldIgnoreFile(entry.Name)) continue;
                if (fileExtension != null && Path.GetExtension(entry.Name).TrimStart('.').ToLowerInvariant() != fileExtension) continue;
                if (fileGlobs is { Count: > 0 } && !fileGlobs.Any(g => MatchesGlob(relativePath, g))) continue;
                allMatches.AddRange(SearchInFile(fullPath, relativePath, query, mode, caseSensitive,
                    contextLines, maxMatches - allMatches.Count));
            }
        }
    }

    private static List<SearchMatch> SearchInFile(
        string filePath, string relativePath, string query, string mode, bool caseSensitive,
        int contextLines, int remainingMatches)
    {
        var results = new List<SearchMatch>();
        if (remainingMatches <= 0) return results;

        FileInfo fi;
        try { fi = new FileInfo(filePath); } catch { return results; }
        if (!fi.Exists || fi.Length > MaxFileSize) return results;
        if ((fi.Attributes & FileAttributes.Directory) != 0) return results;

        string[] lines;
        try { lines = File.ReadAllText(filePath).Split('\n'); }
        catch { return results; }

        Regex searchRegex;
        try
        {
            var pattern = mode == "regex" ? query : EscapeLiteral(query);
            var options = RegexOptions.ECMAScript | RegexOptions.CultureInvariant;
            if (!caseSensitive) options |= RegexOptions.IgnoreCase;
            searchRegex = new Regex(pattern, options);
        }
        catch
        {
            return results; // 无效正则：与 TS 相同，按无匹配处理
        }

        for (var i = 0; i < lines.Length; i++)
        {
            if (results.Count >= remainingMatches) break;
            var line = lines[i];
            if (line.Length > MaxLineLength) continue; // 跳过超长行
            var m = searchRegex.Match(line);
            if (!m.Success) continue;

            var before = new List<string>();
            var after = new List<string>();
            for (var j = Math.Max(0, i - contextLines); j < i; j++)
                before.Add(lines[j].Length > MaxLineLength ? lines[j][..MaxLineLength] : lines[j]);
            for (var j = i + 1; j <= Math.Min(lines.Length - 1, i + contextLines); j++)
                after.Add(lines[j].Length > MaxLineLength ? lines[j][..MaxLineLength] : lines[j]);

            results.Add(new SearchMatch(
                relativePath,
                i + 1,
                m.Index + 1,
                line.Length > MaxLineLength ? line[..MaxLineLength] : line,
                before, after));
        }
        return results;
    }

    private static bool IsWithinWorkspace(string resolved, string workspaceRoot)
    {
        var root = Path.GetFullPath(workspaceRoot);
        return resolved.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.Ordinal) || resolved == root;
    }

    private static string RelativePath(string workspaceRoot, string fullPath)
        => Path.GetRelativePath(workspaceRoot, fullPath).Replace('\\', '/');

    private static bool ShouldIgnoreFile(string name)
        => IgnoredExts.Contains(Path.GetExtension(name));

    /// <summary>与 TS normalizeGlob/matchesGlob 同构（无路径前缀自动 **/）。</summary>
    private static bool MatchesGlob(string filePath, string pattern)
    {
        var normalized = pattern.Contains('/') || pattern.StartsWith("**/", StringComparison.Ordinal)
            ? pattern
            : "**/" + pattern;
        var regexStr = normalized
            .Replace(".", "\\.")
            .Replace("**", "⟨GLOBSTAR⟩")
            .Replace("*", "[^/]*")
            .Replace("⟨GLOBSTAR⟩", ".*")
            .Replace("?", "[^/]");
        try { return Regex.IsMatch(filePath, "^" + regexStr + "$", RegexOptions.ECMAScript); }
        catch { return false; }
    }

    /// <summary>JS query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") 的等价实现。</summary>
    private static string EscapeLiteral(string query)
    {
        const string specials = ".*+?^${}()|[]\\";
        var sb = new System.Text.StringBuilder(query.Length);
        foreach (var ch in query)
        {
            if (specials.IndexOf(ch) >= 0) sb.Append('\\');
            sb.Append(ch);
        }
        return sb.ToString();
    }

    private static string InvalidQueryResult() => JsonSerializer.Serialize(new Dictionary<string, object?>
    {
        ["success"] = false,
        ["errorCode"] = "INVALID_QUERY",
        ["error"] = "query 不能为空",
        ["retryable"] = false,
        ["matches"] = new List<object>(),
        ["totalMatches"] = 0,
        ["returnedMatches"] = 0,
        ["truncated"] = false,
    });

    private static string GetString(JsonElement args, string key)
        => args.ValueKind == JsonValueKind.Object && args.TryGetProperty(key, out var el) && el.ValueKind == JsonValueKind.String
            ? el.GetString()!
            : "";

    private static double NumOr(JsonElement args, string key, double fallback)
    {
        if (args.ValueKind == JsonValueKind.Object && args.TryGetProperty(key, out var el) && el.ValueKind == JsonValueKind.Number)
        {
            var v = el.GetDouble();
            if (v != 0 && !double.IsNaN(v)) return v; // JS Number(x) || fallback
        }
        return fallback;
    }

    private static List<string>? GetStringArray(JsonElement args, string key)
    {
        if (args.ValueKind != JsonValueKind.Object || !args.TryGetProperty(key, out var el) || el.ValueKind != JsonValueKind.Array)
            return null;
        var list = new List<string>();
        foreach (var item in el.EnumerateArray())
        {
            // TS: Array.isArray ? map(String)——数字/布尔也给 JS String 近似
            list.Add(item.ValueKind switch
            {
                JsonValueKind.String => item.GetString()!,
                JsonValueKind.Number => HostLocale.Fmt(item.GetDouble()),
                JsonValueKind.True => "true",
                JsonValueKind.False => "false",
                JsonValueKind.Null => "null",
                _ => item.ToString(),
            });
        }
        return list;
    }
}

using System.Diagnostics;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;

namespace CyreneNative.Tools;

/// <summary>
/// ast_grep_search / ast_grep_replace（与 ast-grep-tools.ts 同语义，IKJK3V T2 库替代批）。
///
/// 无官方 .NET 绑定 → 随包 ast-grep CLI 走 JSON（tree-sitter 自研成本高一个量级）：
///   - CLI 路径由 TS 包装器解析后经内部参数注入（__astGrepCommand；找不到则 TS 走 napi）；
///   - 工作区根经内部参数注入（__cyreneWorkspaceRoot）；文件收集/语言过滤/Skip 目录/
///     上限（500 文件、50 匹配）与 TS 逐项对齐；CLI 按扩展名自动识别语言；
///   - search：--json=stream 逐匹配解析 → TS 输出形状（line/column 1-based、endLine、text、file）；
///   - replace：-r 模板经 CLI 展开（replacement 字段，$$$ 语义与 napi 展开一致）；
///     C# 侧做重叠编辑去重（保留最外层）、按字节偏移拼接新文本、行级 diff 证据（上限同 ToolEvidence）；
///     dryRun 只预览不落盘。exit code 1 = 无匹配（ast-grep 约定），stderr 非空或异常退出 → 抛错误帧回退 TS。
/// </summary>
internal static class AstGrepTool
{
    private static readonly Dictionary<string, string> ExtToLang = new(StringComparer.OrdinalIgnoreCase)
    {
        [".ts"] = "TypeScript", [".tsx"] = "Tsx", [".mts"] = "TypeScript", [".cts"] = "TypeScript",
        [".js"] = "JavaScript", [".jsx"] = "Jsx", [".mjs"] = "JavaScript", [".cjs"] = "JavaScript",
        [".py"] = "Python", [".rs"] = "Rust", [".go"] = "Go", [".java"] = "Java", [".json"] = "Json",
        [".yaml"] = "Yaml", [".yml"] = "Yaml", [".css"] = "Css", [".html"] = "Html",
        [".c"] = "C", [".h"] = "C", [".cpp"] = "Cpp", [".cc"] = "Cpp", [".hpp"] = "Cpp",
    };

    private static readonly HashSet<string> SkipDirs = new(StringComparer.Ordinal)
    {
        "node_modules", ".git", "dist", "release", "build", "out",
        ".next", ".nuxt", "target", "vendor", "__pycache__", ".venv", "venv",
        ".worktrees", "worktrees",
    };

    private const int MaxFiles = 500;
    private const int MaxMatchesDefault = 50;
    private const int CliTimeoutMs = 30_000;

    private static readonly string[] SupportedLanguages = ExtToLang.Values
        .Distinct(StringComparer.Ordinal).OrderBy(x => x, StringComparer.Ordinal).ToArray();

    private static readonly JsonSerializerOptions Json = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    // ── 入口 ────────────────────────────────────────────────

    public static string Search(JsonElement args)
    {
        if (!TryReadCommon(args, out var pattern, out var language, out var paths, out var error))
            return ErrorJson("matches", error);
        var workspace = Str(args, "__cyreneWorkspaceRoot").Trim();
        if (workspace.Length == 0)
            return ErrorJson("matches", "未绑定工作区，无法执行代码搜索");

        var maxMatches = ReadMaxMatches(args);
        var (files, skipped) = CollectFiles(workspace, paths, language);
        var command = Str(args, "__astGrepCommand").Trim();

        var matches = new List<object>();
        var filesWithMatches = 0;
        var truncated = false;
        if (files.Count > 0)
        {
            if (command.Length == 0) throw new ToolHostException("E_AST_GREP_MISSING", "ast-grep CLI 不可用（__astGrepCommand 未注入）");
            var cli = RunCli(command, pattern, null, files);
            var byFile = cli.GroupBy(m => NormalizePath(m.File)).ToDictionary(g => g.Key, g => g.OrderBy(m => m.StartByte).ToList());
            foreach (var file in files)
            {
                if (matches.Count >= maxMatches) { truncated = true; break; }
                if (!byFile.TryGetValue(NormalizePath(file.AbsPath), out var found) || found.Count == 0) continue;
                filesWithMatches++;
                foreach (var m in found)
                {
                    if (matches.Count >= maxMatches) { truncated = true; break; }
                    matches.Add(new
                    {
                        line = m.StartLine + 1,
                        column = m.StartColumn + 1,
                        endLine = m.EndLine + 1,
                        text = m.Text,
                        file = file.RelPath,
                    });
                }
            }
        }

        var result = new Dictionary<string, object?>
        {
            ["success"] = true,
            ["pattern"] = pattern,
            ["language"] = language ?? "auto",
            ["scannedFiles"] = files.Count,
            ["filesWithMatches"] = filesWithMatches,
            ["matchCount"] = matches.Count,
            ["truncated"] = truncated,
            ["matches"] = matches,
        };
        if (skipped.Count > 0) result["skipped"] = skipped.Take(20).ToList();
        return JsonSerializer.Serialize(result, Json);
    }

    public static string Replace(JsonElement args)
    {
        if (!TryReadCommon(args, out var pattern, out var language, out var paths, out var error))
            return ErrorJson("changed", error);
        var workspace = Str(args, "__cyreneWorkspaceRoot").Trim();
        if (workspace.Length == 0)
            return ErrorJson("changed", "未绑定工作区，无法执行代码改写");

        var rewrite = Str(args, "rewrite");
        var dryRun = !(args.ValueKind == JsonValueKind.Object && args.TryGetProperty("dryRun", out var d) && d.ValueKind == JsonValueKind.False);
        var (files, skipped) = CollectFiles(workspace, paths, language);
        var command = Str(args, "__astGrepCommand").Trim();

        var planned = new List<object>();
        var changes = new List<Dictionary<string, object?>>();
        var errors = new List<string>();
        var pendingWrites = new List<(string AbsPath, string RelPath, byte[] Bytes)>();
        var totalMatches = 0;

        if (files.Count > 0)
        {
            if (command.Length == 0) throw new ToolHostException("E_AST_GREP_MISSING", "ast-grep CLI 不可用（__astGrepCommand 未注入）");
            var cli = RunCli(command, pattern, rewrite, files);
            var byFile = cli.GroupBy(m => NormalizePath(m.File)).ToDictionary(g => g.Key, g => g.OrderBy(m => m.StartByte).ToList());
            foreach (var file in files)
            {
                if (!byFile.TryGetValue(NormalizePath(file.AbsPath), out var found) || found.Count == 0) continue;

                // 重叠编辑去重：按起点排序，跳过被前一个覆盖的编辑（保留最外层，与 TS 同）
                var edits = new List<CliMatch>();
                var lastEnd = -1;
                foreach (var m in found)
                {
                    if (m.StartByte < lastEnd) continue;
                    edits.Add(m);
                    lastEnd = m.EndByte;
                }

                byte[] source;
                try { source = File.ReadAllBytes(file.AbsPath); }
                catch { skipped.Add(file.RelPath); continue; }

                if (edits.Any(e => e.StartByte < 0 || e.EndByte > source.Length || e.StartByte > e.EndByte))
                {
                    errors.Add($"{file.RelPath}: 编辑偏移越界（文件已变化？）");
                    continue;
                }

                var newBytes = ApplyEdits(source, edits);
                if (newBytes.AsSpan().SequenceEqual(source)) continue; // 改写后无变化（与 TS newSource === source 同）

                var insertions = 0;
                var deletions = 0;
                var diff = new List<object>();
                foreach (var e in edits)
                {
                    foreach (var line in e.Text.Split('\n'))
                    {
                        diff.Add(new { type = "remove", text = ToolEvidence.ClipLine(line) });
                        deletions++;
                    }
                    foreach (var line in (e.Replacement ?? "").Split('\n'))
                    {
                        diff.Add(new { type = "add", text = ToolEvidence.ClipLine(line) });
                        insertions++;
                    }
                }

                planned.Add(new { file = file.RelPath, matchCount = found.Count });
                changes.Add(new Dictionary<string, object?>
                {
                    ["file"] = file.RelPath,
                    ["kind"] = "modified",
                    ["insertions"] = insertions,
                    ["deletions"] = deletions,
                    ["diff"] = diff,
                });
                totalMatches += found.Count;
                pendingWrites.Add((file.AbsPath, file.RelPath, newBytes));
            }
        }

        ToolEvidence.Finalize(changes);

        if (dryRun)
        {
            var result = new Dictionary<string, object?>
            {
                ["success"] = true,
                ["dryRun"] = true,
                ["pattern"] = pattern,
                ["rewrite"] = rewrite,
                ["filesToChange"] = planned.Count,
                ["totalMatches"] = totalMatches,
                ["planned"] = planned,
                ["changes"] = changes,
            };
            if (skipped.Count > 0) result["skipped"] = skipped.Take(20).ToList();
            if (errors.Count > 0) result["parseErrors"] = errors.Take(10).ToList();
            result["note"] = "这是预览。确认无误后用 dryRun: false 重新调用以实际写入。";
            return JsonSerializer.Serialize(result, Json);
        }

        // 正式写入：任一写入异常继续写其余，错误汇总返回（与 TS 同）
        var changed = new List<string>();
        foreach (var (absPath, relPath, bytes) in pendingWrites)
        {
            try
            {
                File.WriteAllBytes(absPath, bytes);
                changed.Add(relPath);
            }
            catch (Exception ex)
            {
                errors.Add($"{absPath}: {ex.Message}");
            }
        }

        var writeResult = new Dictionary<string, object?>
        {
            ["success"] = errors.Count == 0,
            ["dryRun"] = false,
            ["pattern"] = pattern,
            ["rewrite"] = rewrite,
            ["changedFiles"] = changed.Count,
            ["totalMatches"] = totalMatches,
            ["changed"] = changed,
            ["changes"] = changes,
        };
        if (skipped.Count > 0) writeResult["skipped"] = skipped.Take(20).ToList();
        if (errors.Count > 0) writeResult["errors"] = errors.Take(10).ToList();
        return JsonSerializer.Serialize(writeResult, Json);
    }

    // ── 文件收集（与 TS collectFiles 同规则）────────────────

    private sealed record CollectedFile(string RelPath, string AbsPath, string Lang);

    private static (List<CollectedFile> Files, List<string> Skipped) CollectFiles(string workspaceRoot, List<string>? inputPaths, string? language)
    {
        var files = new List<CollectedFile>();
        var skipped = new List<string>();
        var langExts = language is null
            ? null
            : ExtToLang.Where(kv => kv.Value == language).Select(kv => kv.Key).ToHashSet(StringComparer.OrdinalIgnoreCase);

        void Walk(string absDir, string relDir)
        {
            if (files.Count >= MaxFiles) return;
            string[] entries;
            try { entries = Directory.GetFileSystemEntries(absDir); }
            catch { skipped.Add(relDir); return; }
            foreach (var entry in entries)
            {
                if (files.Count >= MaxFiles) return;
                var name = Path.GetFileName(entry);
                if (name.StartsWith('.') || SkipDirs.Contains(name)) continue;
                var rel = relDir.Length > 0 ? relDir + "/" + name : name;
                if (Directory.Exists(entry))
                {
                    Walk(entry, rel);
                }
                else if (File.Exists(entry))
                {
                    var ext = Path.GetExtension(name).ToLowerInvariant();
                    if (!ExtToLang.TryGetValue(ext, out var lang)) continue;
                    if (langExts is not null && !langExts.Contains(ext)) continue;
                    files.Add(new CollectedFile(rel, entry, lang));
                }
            }
        }

        foreach (var inputPath in inputPaths ?? new List<string> { "." })
        {
            string abs;
            try { abs = Path.GetFullPath(Path.Combine(workspaceRoot, inputPath)); }
            catch { skipped.Add(inputPath); continue; }
            if (!IsWithinWorkspace(abs, workspaceRoot)) { skipped.Add(inputPath); continue; }
            if (Directory.Exists(abs))
            {
                Walk(abs, ToDisplayPath(inputPath));
            }
            else if (File.Exists(abs))
            {
                var ext = Path.GetExtension(abs).ToLowerInvariant();
                if (!ExtToLang.TryGetValue(ext, out var lang) || (langExts is not null && !langExts.Contains(ext)))
                {
                    skipped.Add(inputPath);
                    continue;
                }
                files.Add(new CollectedFile(ToDisplayPath(inputPath), abs, lang));
            }
            else
            {
                skipped.Add(inputPath);
            }
        }
        return (files, skipped);
    }

    private static bool IsWithinWorkspace(string absPath, string workspaceRoot)
    {
        // 口径与 SearchTools.cs / TS isWithinWorkspace 一致（Ordinal，不做大小写折叠）
        var root = Path.GetFullPath(workspaceRoot);
        var resolved = Path.GetFullPath(absPath);
        return string.Equals(resolved, root, StringComparison.Ordinal)
            || resolved.StartsWith(root.EndsWith(Path.DirectorySeparatorChar) ? root : root + Path.DirectorySeparatorChar, StringComparison.Ordinal);
    }

    private static string ToDisplayPath(string relPath)
    {
        var normalized = relPath.Replace('\\', '/');
        if (normalized is "." or "./") return "";
        return normalized.StartsWith("./") ? normalized[2..] : normalized;
    }

    // ── CLI 调用 ────────────────────────────────────────────

    private sealed record CliMatch(string File, int StartByte, int EndByte, int StartLine, int StartColumn, int EndLine, string Text, string? Replacement);

    private static List<CliMatch> RunCli(string command, string pattern, string? rewrite, List<CollectedFile> files)
    {
        var psi = new ProcessStartInfo(command)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };
        psi.ArgumentList.Add("run");
        psi.ArgumentList.Add("-p");
        psi.ArgumentList.Add(pattern);
        if (rewrite is not null)
        {
            psi.ArgumentList.Add("-r");
            psi.ArgumentList.Add(rewrite);
        }
        psi.ArgumentList.Add("--json=stream");
        foreach (var f in files) psi.ArgumentList.Add(f.AbsPath);

        using var proc = Process.Start(psi) ?? throw new ToolHostException("E_AST_GREP_CLI", "ast-grep 启动失败");
        // 双流并发读取 + 超时前置（对照 GitTools.RunGit）：顺序读取时超时不可达，
        // 且 stderr 写满管道缓冲会死锁；超时按进程树 Kill 防孙进程孤儿化。
        var stdoutTask = proc.StandardOutput.ReadToEndAsync();
        var stderrTask = proc.StandardError.ReadToEndAsync();
        if (!proc.WaitForExit(CliTimeoutMs))
        {
            try { proc.Kill(entireProcessTree: true); } catch { /* 已退出 */ }
            throw new ToolHostException("E_AST_GREP_TIMEOUT", "ast-grep 执行超时");
        }
        var stdout = stdoutTask.GetAwaiter().GetResult();
        var stderr = stderrTask.GetAwaiter().GetResult();
        // 注：GetAwaiter().GetResult() 与 GitTools.RunGit 同款既有模式——WaitForExit
        // 只等进程退出，理论上存在「进程已退出但管道未 EOF」的长挂窗口；ast-grep 退出
        // 即关闭 stdout/stderr，实际不可达。如后续统一改读任务超时（Task.WhenAny），
        // 与 GitTools 一并处理，此处不改行为。
        // exit 1 = 无匹配（ast-grep 约定，stdout 空）；stderr 非空/异常退出 → 抛错误帧回退 TS
        if (stderr.Trim().Length > 0 || proc.ExitCode is not (0 or 1))
            throw new ToolHostException("E_AST_GREP_CLI", "ast-grep 执行失败: " + stderr.Trim());

        var matches = new List<CliMatch>();
        foreach (var line in stdout.Split('\n'))
        {
            if (line.Trim().Length == 0) continue;
            try
            {
                using var doc = JsonDocument.Parse(line);
                var root = doc.RootElement;
                var range = root.GetProperty("range");
                var byteOffset = range.GetProperty("byteOffset");
                var start = range.GetProperty("start");
                var end = range.GetProperty("end");
                matches.Add(new CliMatch(
                    root.TryGetProperty("file", out var f) ? f.GetString() ?? "" : "",
                    byteOffset.GetProperty("start").GetInt32(),
                    byteOffset.GetProperty("end").GetInt32(),
                    start.GetProperty("line").GetInt32(),
                    start.GetProperty("column").GetInt32(),
                    end.GetProperty("line").GetInt32(),
                    root.TryGetProperty("text", out var t) ? t.GetString() ?? "" : "",
                    root.TryGetProperty("replacement", out var r) ? r.GetString() : null));
            }
            catch (JsonException)
            {
                // 协议外行：忽略
            }
        }
        return matches;
    }

    private static byte[] ApplyEdits(byte[] source, List<CliMatch> edits)
    {
        var result = new List<byte>(source.Length);
        var cursor = 0;
        foreach (var edit in edits)
        {
            if (edit.StartByte > cursor) result.AddRange(source[cursor..edit.StartByte]);
            result.AddRange(Encoding.UTF8.GetBytes(edit.Replacement ?? ""));
            cursor = edit.EndByte;
        }
        if (cursor < source.Length) result.AddRange(source[cursor..]);
        return result.ToArray();
    }

    // ── 参数解析 ────────────────────────────────────────────

    private static bool TryReadCommon(JsonElement args, out string pattern, out string? language, out List<string>? paths, out string error)
    {
        pattern = Str(args, "pattern").Trim();
        language = null;
        paths = null;
        error = "";
        if (pattern.Length == 0) { error = "pattern 参数不能为空"; return false; }
        if (args.ValueKind == JsonValueKind.Object && args.TryGetProperty("language", out var langEl))
        {
            var lang = langEl.ValueKind == JsonValueKind.String ? langEl.GetString()! : "";
            if (!SupportedLanguages.Contains(lang, StringComparer.Ordinal))
            {
                error = $"不支持的语言 \"{lang}\"。支持：{string.Join(", ", SupportedLanguages)}";
                return false;
            }
            language = lang;
        }
        if (args.ValueKind == JsonValueKind.Object && args.TryGetProperty("paths", out var pathsEl))
        {
            if (pathsEl.ValueKind != JsonValueKind.Array)
            {
                error = "paths 必须是字符串数组";
                return false;
            }
            paths = new List<string>();
            foreach (var p in pathsEl.EnumerateArray())
            {
                if (p.ValueKind != JsonValueKind.String) { error = "paths 必须是字符串数组"; return false; }
                paths.Add(p.GetString()!);
            }
        }
        return true;
    }

    private static string ErrorJson(string listKey, string error)
        => JsonSerializer.Serialize(new Dictionary<string, object?>
        {
            ["success"] = false,
            [listKey] = new List<object>(),
            ["errors"] = new[] { error },
        }, Json);

    private static int ReadMaxMatches(JsonElement args)
    {
        if (args.ValueKind == JsonValueKind.Object && args.TryGetProperty("maxMatches", out var m) && m.ValueKind == JsonValueKind.Number)
        {
            var value = m.GetDouble();
            if (value >= 1 && value == Math.Floor(value)) return (int)value;
        }
        return MaxMatchesDefault;
    }

    private static string NormalizePath(string path)
        => Path.GetFullPath(path).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);

    private static string Str(JsonElement el, string key)
        => el.ValueKind == JsonValueKind.Object && el.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String
            ? v.GetString()!
            : "";
}

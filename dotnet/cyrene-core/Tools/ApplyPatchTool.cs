using System.IO;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.RegularExpressions;
using IOPath = System.IO.Path;

namespace CyreneNative.Tools;

/// <summary>
/// apply_patch：Codex 结构化补丁批量编辑（与 apply-patch-tools.ts 同语义）。
///   - Update File（@@ 分块 + 可选 Move to）/ Add File / Delete File
///   - 预验证事务：解析 → 全量匹配/存在性/路径沙箱预检，任一失败则全部不执行
///   - 路径沙箱：工作区根经内部参数 `__cyreneRoot` 注入（模型不可见）
///   - 保留原文件 EOL（CRLF/LF）；按 \r?\n 拆行（混合 EOL 不残留在行内容）
///   - 两段式（TS 包装器编排）：`__dryRun=true` 只解析+预检，成功返回
///     {success,prepared,hunks} 供包装层捕获 review 基线，随后再发正式调用落盘；
///     预检失败对象与 TS 输出同构，原样透传且无任何副作用
///   - evidence：changes/diff 由 ToolEvidence 生成（60/200/200 上限同构）
/// </summary>
internal static class ApplyPatchTool
{
    /// <summary>与 TS JSON.stringify 对齐：中文不转义（含 applied/errors/diff 文本）。</summary>
    private static readonly JsonSerializerOptions Json = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    private static readonly UTF8Encoding Utf8NoBom = new(encoderShouldEmitUTF8Identifier: false);

    private sealed class ChunkLine
    {
        public string Type = ""; // context | removal | addition
        public string Content = "";
    }

    private sealed class Chunk
    {
        public readonly List<ChunkLine> Lines = new();
    }

    private sealed class Hunk
    {
        public string Type = ""; // add | delete | update
        public string Path = "";
        public string Content = ""; // add
        public string? MovePath; // update
        public readonly List<Chunk> Chunks = new(); // update
    }

    public static string Execute(JsonElement args)
    {
        var patch = Str(args, "patch").Trim();
        if (patch.Length == 0) return FailureJson(new List<string> { "patch 参数不能为空" });

        var root = Str(args, "__cyreneRoot");
        if (string.IsNullOrWhiteSpace(root))
            throw new ToolHostException("E_APPLY_PATCH_NO_ROOT", "缺少 __cyreneRoot（工作区根），apply_patch 需经宿主包装器调用");

        var dryRun = args.ValueKind == JsonValueKind.Object
            && args.TryGetProperty("__dryRun", out var dr) && dr.ValueKind == JsonValueKind.True;

        return Apply(patch, root, dryRun);
    }

    private static string Apply(string patch, string root, bool dryRun)
    {
        var (hunks, parseErrors) = Parse(patch);
        if (parseErrors.Count > 0) return FailureJson(parseErrors);
        if (hunks.Count == 0) return FailureJson(new List<string> { "patch 不包含任何操作" });

        // ── 阶段 1：预验证全部 hunk（任一失败 → 全部不执行）──
        var errors = new List<string>();
        foreach (var hunk in hunks)
        {
            var resolved = ResolvePath(root, hunk.Path);
            if (!IsWithinWorkspace(resolved, root))
            {
                errors.Add($"路径逃逸: {hunk.Path} 在工作区外");
                continue;
            }

            if (hunk.Type == "add")
            {
                if (File.Exists(resolved)) errors.Add($"文件已存在，无法新增: {hunk.Path}");
            }
            else if (hunk.Type == "delete")
            {
                if (!File.Exists(resolved)) errors.Add($"文件不存在，无法删除: {hunk.Path}");
            }
            else if (hunk.Type == "update")
            {
                if (!File.Exists(resolved))
                {
                    errors.Add($"文件不存在，无法更新: {hunk.Path}");
                    continue;
                }

                var fileLines = SplitLines(ReadUtf8(resolved));
                var searchStart = 0;
                for (var ci = 0; ci < hunk.Chunks.Count; ci++)
                {
                    var match = FindChunkMatch(fileLines, searchStart, hunk.Chunks[ci]);
                    if (match is null)
                    {
                        errors.Add($"{hunk.Path}: 第 {ci + 1} 个编辑块未找到匹配的上下文");
                        break;
                    }
                    // 模拟应用 chunk，更新 searchStart（与 TS 预检同口径）
                    searchStart = match.Value.Start + PostImage(hunk.Chunks[ci]).Count;
                }

                if (hunk.MovePath is not null)
                {
                    var moveResolved = ResolvePath(root, hunk.MovePath);
                    if (!IsWithinWorkspace(moveResolved, root)) errors.Add($"移动目标路径逃逸: {hunk.MovePath}");
                }
            }
        }

        if (errors.Count > 0) return FailureJson(errors);

        if (dryRun)
        {
            var hunksJson = hunks.Select(h =>
            {
                var d = new Dictionary<string, object?> { ["type"] = h.Type, ["path"] = h.Path };
                if (!string.IsNullOrEmpty(h.MovePath)) d["movePath"] = h.MovePath;
                return d;
            }).ToList();
            return SerializeJson(new Dictionary<string, object?>
            {
                ["success"] = true,
                ["prepared"] = true,
                ["hunks"] = hunksJson,
            });
        }

        // ── 阶段 2：执行全部 hunk ──
        var applied = new List<string>();
        var changes = new List<Dictionary<string, object?>>();
        foreach (var hunk in hunks)
        {
            var resolved = ResolvePath(root, hunk.Path);
            try
            {
                if (hunk.Type == "add") ExecuteAdd(hunk, resolved, applied, changes);
                else if (hunk.Type == "delete") ExecuteDelete(hunk, resolved, applied, changes);
                else if (hunk.Type == "update") ExecuteUpdate(hunk, resolved, root, applied, changes, errors);
            }
            catch (Exception ex)
            {
                errors.Add($"{hunk.Path}: {ex.Message}");
            }
        }

        ToolEvidence.Finalize(changes);
        return SerializeJson(new Dictionary<string, object?>
        {
            ["success"] = errors.Count == 0,
            ["applied"] = applied,
            ["errors"] = errors,
            ["changes"] = changes,
        });
    }

    // ── 执行（与 TS applyPatchHunks 阶段 2 同构）─────────────

    private static void ExecuteAdd(
        Hunk hunk, string resolved,
        List<string> applied, List<Dictionary<string, object?>> changes)
    {
        var dir = IOPath.GetDirectoryName(resolved);
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
        File.WriteAllText(resolved, hunk.Content, Utf8NoBom);
        applied.Add($"新增文件: {hunk.Path}");
        var addLines = hunk.Content.Split('\n').ToList();
        changes.Add(Change(hunk.Path, "added", addLines.Count, 0, ToolEvidence.BuildFullFileDiff(addLines, "add")));
    }

    private static void ExecuteDelete(
        Hunk hunk, string resolved,
        List<string> applied, List<Dictionary<string, object?>> changes)
    {
        var content = File.Exists(resolved) ? ReadUtf8(resolved) : "";
        File.Delete(resolved);
        applied.Add($"删除文件: {hunk.Path}");
        var delLines = content.Split('\n').ToList();
        changes.Add(Change(hunk.Path, "deleted", 0, delLines.Count, ToolEvidence.BuildFullFileDiff(delLines, "remove")));
    }

    private static void ExecuteUpdate(
        Hunk hunk, string resolved, string root,
        List<string> applied, List<Dictionary<string, object?>> changes, List<string> errors)
    {
        var content = ReadUtf8(resolved);
        var eol = content.Contains("\r\n") ? "\r\n" : "\n";
        var fileLines = SplitLines(content);
        var searchStart = 0;
        var chunkFailed = false;
        var diffLines = new List<object>();
        var insertions = 0;
        var deletions = 0;

        foreach (var chunk in hunk.Chunks)
        {
            var (lines, nextSearch, error) = ApplyChunkToFile(fileLines, chunk, searchStart, hunk.Path);
            if (error is not null)
            {
                // 预验证后文件被外部修改的竞态：跳过写入，避免写出错误内容（TS 同）
                errors.Add(error);
                chunkFailed = true;
                break;
            }
            fileLines = lines;
            searchStart = nextSearch;
            // chunk.lines 按行序保留 context/removal/addition 相对位置，直接映射为 diff 行
            foreach (var line in chunk.Lines)
            {
                if (line.Type == "addition")
                {
                    diffLines.Add(new { type = "add", text = ToolEvidence.ClipLine(line.Content) });
                    insertions++;
                }
                else if (line.Type == "removal")
                {
                    diffLines.Add(new { type = "remove", text = ToolEvidence.ClipLine(line.Content) });
                    deletions++;
                }
                else
                {
                    diffLines.Add(new { type = "context", text = ToolEvidence.ClipLine(line.Content) });
                }
            }
        }

        if (chunkFailed) return; // 该 hunk 不落盘、不进 applied/changes（错误已入列）

        File.WriteAllText(resolved, string.Join(eol, fileLines), Utf8NoBom);

        if (hunk.MovePath is not null)
        {
            var moveResolved = ResolvePath(root, hunk.MovePath);
            var moveDir = IOPath.GetDirectoryName(moveResolved);
            if (!string.IsNullOrEmpty(moveDir)) Directory.CreateDirectory(moveDir);
            File.Move(resolved, moveResolved, overwrite: true);
            applied.Add($"更新并移动: {hunk.Path} → {hunk.MovePath}");
            changes.Add(Change(hunk.MovePath, "renamed", insertions, deletions, diffLines));
        }
        else
        {
            applied.Add($"更新文件: {hunk.Path}");
            changes.Add(Change(hunk.Path, "modified", insertions, deletions, diffLines));
        }
    }

    // ── 解析（与 TS parsePatch 同构）─────────────────────────

    private static (List<Hunk> Hunks, List<string> Errors) Parse(string patchText)
    {
        // 去掉每行结尾的 \r：patch 文本若按 CRLF 传输，残留的 \r 会进入行内容导致匹配失败
        var lines = patchText.Split('\n').Select(l => l.EndsWith('\r') ? l[..^1] : l).ToArray();
        var hunks = new List<Hunk>();
        var errors = new List<string>();

        var i = 0;
        while (i < lines.Length && lines[i].Trim() != "*** Begin Patch") i++;
        if (i >= lines.Length) return (hunks, new List<string> { "patch 必须以 *** Begin Patch 开头" });
        i++; // 跳过 *** Begin Patch

        while (i < lines.Length)
        {
            var line = lines[i];

            if (line.Trim() == "*** End Patch") break;

            // *** Update File: path
            if (line.StartsWith("*** Update File: ", StringComparison.Ordinal))
            {
                var filePath = line["*** Update File: ".Length..].Trim();
                i++;

                // 可选 *** Move to: newpath
                string? movePath = null;
                if (i < lines.Length && lines[i].StartsWith("*** Move to: ", StringComparison.Ordinal))
                {
                    movePath = lines[i]["*** Move to: ".Length..].Trim();
                    i++;
                }

                var chunks = new List<Chunk>();
                Chunk? currentChunk = null;

                while (i < lines.Length && !lines[i].StartsWith("*** ", StringComparison.Ordinal))
                {
                    var patchLine = lines[i];

                    if (patchLine.Trim() == "@@")
                    {
                        if (currentChunk is not null) chunks.Add(currentChunk);
                        currentChunk = new Chunk();
                        i++;
                        continue;
                    }

                    currentChunk ??= new Chunk();

                    if (patchLine.StartsWith('+')) currentChunk.Lines.Add(new ChunkLine { Type = "addition", Content = patchLine[1..] });
                    else if (patchLine.StartsWith('-')) currentChunk.Lines.Add(new ChunkLine { Type = "removal", Content = patchLine[1..] });
                    else if (patchLine.StartsWith(' ')) currentChunk.Lines.Add(new ChunkLine { Type = "context", Content = patchLine[1..] });
                    else if (patchLine.Length == 0) currentChunk.Lines.Add(new ChunkLine { Type = "context", Content = "" });
                    i++;
                }

                if (currentChunk is not null) chunks.Add(currentChunk);

                if (chunks.Count == 0)
                {
                    errors.Add($"{filePath}: Update File 不包含任何编辑块（缺少 @@ ... 内容）");
                }
                else
                {
                    var hunk = new Hunk { Type = "update", Path = filePath };
                    if (!string.IsNullOrEmpty(movePath)) hunk.MovePath = movePath;
                    hunk.Chunks.AddRange(chunks);
                    hunks.Add(hunk);
                }
                continue;
            }

            // *** Add File: path
            if (line.StartsWith("*** Add File: ", StringComparison.Ordinal))
            {
                var filePath = line["*** Add File: ".Length..].Trim();
                i++;

                var contentLines = new List<string>();
                while (i < lines.Length && !lines[i].StartsWith("*** ", StringComparison.Ordinal))
                {
                    if (lines[i].StartsWith('+')) contentLines.Add(lines[i][1..]);
                    else if (lines[i].Length == 0) contentLines.Add("");
                    i++;
                }

                hunks.Add(new Hunk { Type = "add", Path = filePath, Content = string.Join("\n", contentLines) });
                continue;
            }

            // *** Delete File: path
            if (line.StartsWith("*** Delete File: ", StringComparison.Ordinal))
            {
                var filePath = line["*** Delete File: ".Length..].Trim();
                hunks.Add(new Hunk { Type = "delete", Path = filePath });
                i++;
                continue;
            }

            // 未知行，跳过
            i++;
        }

        return (hunks, errors);
    }

    // ── 匹配（与 TS findSequence / applyChunkToFile 同构）────

    private static List<string> PreImage(Chunk chunk)
        => chunk.Lines.Where(l => l.Type != "addition").Select(l => l.Content).ToList();

    private static List<string> PostImage(Chunk chunk)
        => chunk.Lines.Where(l => l.Type != "removal").Select(l => l.Content).ToList();

    private static (int Start, int End)? FindChunkMatch(List<string> fileLines, int startSearch, Chunk chunk)
    {
        var preImage = PreImage(chunk);
        if (preImage.Count == 0)
        {
            // 纯添加（无上下文、无删除）：在搜索起点插入
            return (startSearch, startSearch);
        }
        return FindSequence(fileLines, startSearch, preImage);
    }

    private static (int Start, int End)? FindSequence(List<string> fileLines, int startSearch, List<string> pattern)
    {
        if (pattern.Count == 0) return null;

        for (var i = startSearch; i <= fileLines.Count - pattern.Count; i++)
        {
            var matched = true;
            for (var j = 0; j < pattern.Count; j++)
            {
                if (fileLines[i + j] != pattern[j])
                {
                    matched = false;
                    break;
                }
            }
            if (matched) return (i, i + pattern.Count);
        }
        return null;
    }

    private static (List<string> Lines, int NextSearch, string? Error) ApplyChunkToFile(
        List<string> fileLines, Chunk chunk, int searchStart, string hunkPath)
    {
        var match = FindChunkMatch(fileLines, searchStart, chunk);
        if (match is null)
        {
            var expected = PreImage(chunk);
            var error = "未找到匹配的上下文。期望找到:\n" + string.Join("\n", expected.Select(l => "  " + l));
            return (fileLines, fileLines.Count, $"{hunkPath}: {error}");
        }

        // 用 postImage 替换 preImage（保持 context 行，用 additions 替换 removals）
        var postImage = PostImage(chunk);
        var newLines = fileLines.Take(match.Value.Start)
            .Concat(postImage)
            .Concat(fileLines.Skip(match.Value.End))
            .ToList();

        return (newLines, match.Value.Start + postImage.Count, null);
    }

    // ── 辅助 ─────────────────────────────────────────────────

    private static List<string> SplitLines(string content) => Regex.Split(content, "\r?\n").ToList();

    private static string ReadUtf8(string path) => Encoding.UTF8.GetString(File.ReadAllBytes(path));

    private static string ResolvePath(string root, string p) => IOPath.GetFullPath(IOPath.Combine(root, p));

    /// <summary>与 TS isWithinWorkspace 同口径（resolved === root 或 root + 分隔符 前缀）。</summary>
    private static bool IsWithinWorkspace(string resolved, string root)
    {
        var normalizedRoot = IOPath.GetFullPath(root);
        return resolved == normalizedRoot
            || resolved.StartsWith(normalizedRoot + IOPath.DirectorySeparatorChar, StringComparison.Ordinal);
    }

    private static Dictionary<string, object?> Change(
        string file, string kind, int insertions, int deletions, List<object> diff)
        => new()
        {
            ["file"] = file,
            ["kind"] = kind,
            ["insertions"] = insertions,
            ["deletions"] = deletions,
            ["diff"] = diff,
        };

    /// <summary>与 TS 失败输出同构：{success:false, applied:[], errors:[...]}。</summary>
    private static string FailureJson(List<string> errors) => SerializeJson(new Dictionary<string, object?>
    {
        ["success"] = false,
        ["applied"] = new List<string>(),
        ["errors"] = errors,
    });

    private static string SerializeJson(object value) => JsonSerializer.Serialize(value, Json);

    private static string Str(JsonElement args, string key)
        => args.ValueKind == JsonValueKind.Object && args.TryGetProperty(key, out var el) && el.ValueKind == JsonValueKind.String
            ? el.GetString()!
            : "";
}

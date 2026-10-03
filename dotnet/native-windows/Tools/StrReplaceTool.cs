using System.IO;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace CyreneNative.Tools;

/// <summary>
/// str_replace：精确字符串替换（匹配核心与 life-tools.ts / str-replace-core.ts 对齐）。
///   - 三层逐级放宽：精确 → EOL 归一化 → 空白归一化（命中后按文件真实缩进重排 new_string）
///   - 批量 edits 顺序应用，任一失败整体不生效（不落盘）
///   - 两段式执行（TS 包装器编排）：`__dryRun=true` 只匹配并返回 {success,prepared}，
///     供包装层确认匹配成功后再写 review 基线；随后再发一次不带 __dryRun 的调用落盘。
///     失败结果（含 diagnostic 诊断）在 dry-run 阶段原样返回，不触发任何副作用。
///   - evidence：changes/diff 由 ToolEvidence 生成（与 TS finalizeFileChanges 同上限）
/// </summary>
internal static class StrReplaceTool
{
    private sealed record Edit(string OldString, string NewString);
    private sealed record Segment(List<string> BeforeLines, List<string> AfterLines);

    private sealed class ApplyResult
    {
        public bool Ok;
        public string ErrorCode = "";
        public string Error = "";
        public string NewContent = "";
        public bool EolNormalized;
        public bool WhitespaceNormalized;
        public int AppliedEdits;
        public List<Segment> Segments = new();
        public Dictionary<string, object?>? Diagnostic;
    }

    public static string Execute(JsonElement args)
    {
        var filePath = Str(args, "file_path");
        if (filePath.Length == 0)
            return JsonError("INVALID_PATH", "file_path 不能为空", retryable: false);
        if (!File.Exists(filePath))
            return JsonError("FILE_NOT_FOUND",
                $"文件不存在：{filePath}。不要重复相同路径，请先用 Read 或 Grep 确认文件存在。", retryable: true);

        // 参数形态：edits 非空数组走批量；否则要求单发 old/new 齐备
        var edits = new List<Edit>();
        if (args.TryGetProperty("edits", out var editsEl) && editsEl.ValueKind == JsonValueKind.Array)
        {
            foreach (var e in editsEl.EnumerateArray())
            {
                if (e.ValueKind != JsonValueKind.Object) continue;
                if (e.TryGetProperty("old_string", out var os) && os.ValueKind == JsonValueKind.String
                    && e.TryGetProperty("new_string", out var ns) && ns.ValueKind == JsonValueKind.String)
                    edits.Add(new Edit(os.GetString()!, ns.GetString()!));
            }
        }
        if (edits.Count == 0)
        {
            var oldStr = Str(args, "old_string");
            var newStr = Str(args, "new_string");
            if (oldStr.Length == 0 && newStr.Length == 0)
            {
                var keys = args.ValueKind == JsonValueKind.Object
                    ? string.Join(", ", args.EnumerateObject().Select(p => p.Name))
                    : "";
                return JsonError("INVALID_INPUT",
                    "需要提供 old_string/new_string（单处替换）或 edits 数组（多处替换），本次收到的参数键：" + keys,
                    retryable: false);
            }
            edits.Add(new Edit(oldStr, newStr));
        }

        string content;
        // 与 TS fs.readFileSync("utf8") 对齐：不做 BOM 剥离（按原始 UTF-8 解码）
        try { content = Encoding.UTF8.GetString(File.ReadAllBytes(filePath)); }
        catch (Exception ex) { throw new ToolHostException("E_STR_REPLACE_READ", "读取文件失败: " + ex.Message); }

        var result = ApplyStrReplaceEdits(content, edits);
        if (!result.Ok) return FailureJson(result);

        var dryRun = args.TryGetProperty("__dryRun", out var dr) && dr.ValueKind == JsonValueKind.True;
        if (dryRun) return "{\"success\":true,\"prepared\":true}";

        try { File.WriteAllText(filePath, result.NewContent); }
        catch (Exception ex) { throw new ToolHostException("E_STR_REPLACE_WRITE", "写入失败: " + ex.Message); }

        long sizeBytes;
        try { sizeBytes = new FileInfo(filePath).Length; }
        catch (Exception ex) { throw new ToolHostException("E_STR_REPLACE_WRITE", "写入完成但无法确认文件状态: " + ex.Message); }

        var changes = result.Segments.Select(seg =>
        {
            var change = new Dictionary<string, object?>
            {
                ["file"] = filePath,
                ["kind"] = "modified",
                ["insertions"] = ToolEvidence.CountLines(string.Join("\n", seg.AfterLines)),
                ["deletions"] = ToolEvidence.CountLines(string.Join("\n", seg.BeforeLines)),
                ["diff"] = ToolEvidence.BuildReplacedDiff(seg.BeforeLines, seg.AfterLines),
            };
            return change;
        }).ToList();
        ToolEvidence.Finalize(changes);

        var output = new Dictionary<string, object?>
        {
            ["tool"] = "str_replace",
            ["filePath"] = filePath,
            ["action"] = "modified",
            ["sizeBytes"] = sizeBytes,
            ["success"] = true,
            ["eolNormalized"] = result.EolNormalized,
            ["whitespaceNormalized"] = result.WhitespaceNormalized,
            ["appliedEdits"] = result.AppliedEdits,
            ["changes"] = changes,
        };
        return JsonSerializer.Serialize(output);
    }

    // ── 核心（str-replace-core.ts 同构）──────────────────────

    private static ApplyResult ApplyStrReplaceEdits(string content, List<Edit> edits)
    {
        if (edits.Count == 0)
            return new ApplyResult { Ok = false, ErrorCode = "INVALID_INPUT", Error = "edits 不能为空数组" };

        var current = content;
        var eolNormalized = false;
        var whitespaceNormalized = false;
        var segments = new List<Segment>();
        for (var i = 0; i < edits.Count; i++)
        {
            var result = ApplySingleEdit(current, edits[i], edits.Count > 1 ? i : (int?)null);
            if (!result.Ok) return result;
            current = result.NewContent;
            eolNormalized = eolNormalized || result.EolNormalized;
            whitespaceNormalized = whitespaceNormalized || result.WhitespaceNormalized;
            segments.AddRange(result.Segments);
        }
        return new ApplyResult
        {
            Ok = true,
            NewContent = current,
            EolNormalized = eolNormalized,
            WhitespaceNormalized = whitespaceNormalized,
            AppliedEdits = edits.Count,
            Segments = segments,
        };
    }

    private static ApplyResult ApplySingleEdit(string content, Edit edit, int? editIndex)
    {
        var oldStr = edit.OldString;
        var newStr = edit.NewString;
        if (oldStr.Length == 0)
        {
            // 空文件播种：文件内容为空时允许空 old_string；文件非空仍拒绝
            if (content.Length == 0)
                return new ApplyResult
                {
                    Ok = true,
                    NewContent = newStr,
                    AppliedEdits = 1,
                    Segments = { new Segment(new List<string>(), SplitLf(newStr)) },
                };
            return new ApplyResult
            {
                Ok = false,
                ErrorCode = "INVALID_INPUT",
                Error = "old_string 不能为空（文件非空）。文件为空时可传空 old_string 播种写入完整内容。",
            };
        }

        var fileEol = content.Contains("\r\n") ? "CRLF" : "LF";
        var fileLines = content.Split('\n');

        // ── 第一层：精确匹配（含 EOL 归一化对齐）──
        var matchStr = oldStr;
        var replaceStr = newStr;
        if (fileEol == "CRLF" && !oldStr.Contains('\r'))
        {
            matchStr = oldStr.Replace("\n", "\r\n");
            replaceStr = newStr.Replace("\n", "\r\n");
        }
        else if (fileEol == "LF" && oldStr.Contains("\r\n"))
        {
            matchStr = oldStr.Replace("\r\n", "\n");
            replaceStr = newStr.Replace("\r\n", "\n");
        }
        var eolNormalized = matchStr != oldStr;

        var exactCount = CountOccurrences(content, matchStr);
        if (exactCount == 1)
        {
            var idx = content.IndexOf(matchStr, StringComparison.Ordinal);
            var newContent = content[..idx] + replaceStr + content[(idx + matchStr.Length)..];
            return new ApplyResult
            {
                Ok = true,
                NewContent = newContent,
                EolNormalized = eolNormalized,
                AppliedEdits = 1,
                Segments = { new Segment(SplitLf(matchStr), SplitLf(replaceStr)) },
            };
        }
        if (exactCount > 1)
        {
            var oldLines = matchStr.Split('\n');
            var positions = new List<object>();
            for (var i = 0; i + oldLines.Length <= fileLines.Length; i++)
            {
                if (string.Join("\n", fileLines.Skip(i).Take(oldLines.Length)) == matchStr)
                {
                    positions.Add(new Dictionary<string, object?>
                    {
                        ["line"] = i + 1,
                        ["context"] = BuildWindowContext(fileLines, i, oldLines.Length),
                    });
                    if (positions.Count >= 5) break;
                }
            }
            return new ApplyResult
            {
                Ok = false,
                ErrorCode = "MULTIPLE_MATCHES",
                Error = $"old_string 在文件中匹配 {exactCount} 处，需要更长的上下文使其唯一。",
                Diagnostic = Diagnostic("multiple_matches", editIndex, oldStr.Length, fileEol, new Dictionary<string, object?>
                {
                    ["matchCount"] = exactCount,
                    ["positions"] = positions,
                }),
            };
        }

        // ── 第二层：空白归一化匹配 ──
        var isCrlfFile = fileEol == "CRLF";
        var lfContent = isCrlfFile ? content.Replace("\r\n", "\n") : content;
        var lfLines = lfContent.Split('\n');
        var oldNormalized = ToNormalizedLines(oldStr);
        var fileNormalized = lfLines.Select(NormalizeLine).ToList();
        var windows = FindNormalizedWindows(fileNormalized, oldNormalized);

        if (windows.Count == 1)
        {
            var start = windows[0];
            var size = oldNormalized.Count;
            var fileSlice = string.Join("\n", lfLines.Skip(start).Take(size));
            var oldIndent = LeadingWhitespace(SplitLf(oldStr)[0]);
            var fileIndent = LeadingWhitespace(lfLines.Length > start ? lfLines[start] : "");
            var adjustedNew = ReindentNewString(newStr, oldIndent, fileIndent);
            var newContentLf = string.Join("\n",
                lfLines.Take(start).Concat(adjustedNew.Split('\n')).Concat(lfLines.Skip(start + size)));
            return new ApplyResult
            {
                Ok = true,
                NewContent = isCrlfFile ? newContentLf.Replace("\n", "\r\n") : newContentLf,
                EolNormalized = eolNormalized,
                WhitespaceNormalized = true,
                AppliedEdits = 1,
                Segments = { new Segment(fileSlice.Split('\n').ToList(), adjustedNew.Split('\n').ToList()) },
            };
        }
        if (windows.Count > 1)
        {
            var positions = windows.Take(5).Select(start => (object)new Dictionary<string, object?>
            {
                ["line"] = start + 1,
                ["context"] = BuildWindowContext(lfLines, start, oldNormalized.Count),
            }).ToList();
            return new ApplyResult
            {
                Ok = false,
                ErrorCode = "MULTIPLE_MATCHES",
                Error = $"old_string 空白归一化后在文件中匹配 {windows.Count} 处，需要更长的上下文使其唯一。",
                Diagnostic = Diagnostic("multiple_matches", editIndex, oldStr.Length, fileEol, new Dictionary<string, object?>
                {
                    ["matchCount"] = windows.Count,
                    ["positions"] = positions,
                }),
            };
        }

        // ── 第三层：not_found 诊断 ──
        var nearest = FindNearestMatch(fileLines.ToList(), oldStr);
        return new ApplyResult
        {
            Ok = false,
            ErrorCode = "OLD_STRING_NOT_FOUND",
            Error = "old_string 在文件中未找到。已自动尝试 CRLF/LF 归一化与空白/缩进归一化仍未匹配，" +
                    "请用 read_file 核对实际内容（缩进、空格、标点）后重试。",
            Diagnostic = Diagnostic("not_found", editIndex, oldStr.Length, fileEol, new Dictionary<string, object?>
            {
                ["nearestMatch"] = nearest == null ? null : new Dictionary<string, object?>
                {
                    ["line"] = nearest.Value.Line,
                    ["similarity"] = nearest.Value.Similarity,
                    ["context"] = nearest.Value.Context,
                },
            }),
        };
    }

    // ── 辅助（与 TS 同名函数同口径）─────────────────────────

    private static Dictionary<string, object?> Diagnostic(
        string kind, int? editIndex, int oldStringLength, string fileEol, Dictionary<string, object?> tail)
    {
        var d = new Dictionary<string, object?>
        {
            ["kind"] = kind,
        };
        if (editIndex.HasValue) d["editIndex"] = editIndex.Value;
        d["oldStringLength"] = oldStringLength;
        d["fileEol"] = fileEol;
        foreach (var kv in tail) d[kv.Key] = kv.Value;
        return d;
    }

    private static string FailureJson(ApplyResult result)
    {
        var json = new Dictionary<string, object?>
        {
            ["success"] = false,
            ["errorCode"] = result.ErrorCode,
            ["error"] = result.Error,
            ["retryable"] = false,
        };
        if (result.Diagnostic != null) json["diagnostic"] = result.Diagnostic;
        return JsonSerializer.Serialize(json);
    }

    private static string JsonError(string code, string message, bool retryable)
        => JsonSerializer.Serialize(new Dictionary<string, object?>
        {
            ["success"] = false,
            ["errorCode"] = code,
            ["error"] = message,
            ["retryable"] = retryable,
        });

    private static List<string> SplitLf(string text) => text.Replace("\r\n", "\n").Split('\n').ToList();

    /// <summary>行内空白折叠 + 去首尾空白（TS normalizeLine）。</summary>
    private static string NormalizeLine(string line) => Regex.Replace(line, @"\s+", " ").Trim();

    private static List<string> ToNormalizedLines(string content)
        => content.Replace("\r\n", "\n").Split('\n').Select(NormalizeLine).ToList();

    /// <summary>取行首前导空白（空格/Tab 序列）。</summary>
    private static string LeadingWhitespace(string line)
    {
        var i = 0;
        while (i < line.Length && (line[i] == ' ' || line[i] == '\t')) i++;
        return line[..i];
    }

    private static List<int> FindNormalizedWindows(List<string> fileLines, List<string> oldLines)
    {
        var hits = new List<int>();
        var windowSize = oldLines.Count;
        if (windowSize == 0 || windowSize > fileLines.Count) return hits;
        for (var i = 0; i + windowSize <= fileLines.Count; i++)
        {
            var matched = true;
            for (var j = 0; j < windowSize; j++)
            {
                if (fileLines[i + j] != oldLines[j]) { matched = false; break; }
            }
            if (matched) hits.Add(i);
        }
        return hits;
    }

    /// <summary>缩进对齐：new_string 按文件匹配片段的真实缩进重写前导空白（TS 规则同）。</summary>
    private static string ReindentNewString(string newStr, string oldIndent, string fileIndent)
    {
        if (oldIndent == fileIndent) return newStr;
        var lines = newStr.Replace("\r\n", "\n").Split('\n').Select(line =>
        {
            if (line.Length == 0) return line;
            if (line.StartsWith(oldIndent, StringComparison.Ordinal)) return fileIndent + line[oldIndent.Length..];
            if (line[0] != ' ' && line[0] != '\t') return fileIndent + line;
            return line;
        });
        return string.Join("\n", lines);
    }

    private static (int Line, double Similarity, string Context)? FindNearestMatch(List<string> lines, string oldStr)
    {
        var firstLine = NormalizeLine(SplitLf(oldStr).FirstOrDefault() ?? "");
        if (firstLine.Length == 0) return null;

        int bestLine = 0;
        double bestSim = 0;
        for (var i = 0; i < lines.Count; i++)
        {
            var sim = LineSimilarity(firstLine, NormalizeLine(lines[i]));
            if (sim > 0.5 && sim > bestSim)
            {
                bestSim = sim;
                bestLine = i + 1;
            }
        }
        if (bestSim == 0) return null;

        var contextStart = Math.Max(0, bestLine - 3);
        var contextEnd = Math.Min(lines.Count, bestLine + 2);
        var context = string.Join("\n", Enumerable.Range(contextStart, contextEnd - contextStart).Select(idx =>
        {
            var ln = idx + 1;
            var marker = ln == bestLine ? ">" : " ";
            return $"{marker} {ln,4} | {lines[idx]}";
        }));
        return (bestLine, bestSim, context);
    }

    /// <summary>字符集相似度（JS Set(string) 语义近似：UTF-16 单元集合）。</summary>
    private static double LineSimilarity(string a, string b)
    {
        if (a == b) return 1;
        if (a.Length == 0 || b.Length == 0) return 0;
        var setA = new HashSet<char>(a);
        var setB = new HashSet<char>(b);
        var intersection = setA.Count(c => setB.Contains(c));
        return (double)intersection / Math.Max(setA.Count, setB.Count);
    }

    /// <summary>窗口（0-based 起始 + 行数）前后各 2 行上下文。</summary>
    private static string BuildWindowContext(string[] lines, int start, int size)
    {
        var contextStart = Math.Max(0, start - 2);
        var contextEnd = Math.Min(lines.Length, start + size + 2);
        var parts = new List<string>();
        for (var idx = contextStart; idx < contextEnd; idx++)
        {
            var ln = idx + 1;
            var marker = ln >= start + 1 && ln <= start + size ? ">" : " ";
            parts.Add($"{marker} {ln,4} | {lines[idx]}");
        }
        return string.Join("\n", parts);
    }

    private static int CountOccurrences(string text, string needle)
    {
        if (needle.Length == 0) return 0;
        var count = 0;
        var idx = 0;
        while ((idx = text.IndexOf(needle, idx, StringComparison.Ordinal)) >= 0)
        {
            count++;
            idx += needle.Length;
        }
        return count;
    }

    private static string Str(JsonElement args, string key)
        => args.ValueKind == JsonValueKind.Object && args.TryGetProperty(key, out var el) && el.ValueKind == JsonValueKind.String
            ? el.GetString()!
            : "";
}

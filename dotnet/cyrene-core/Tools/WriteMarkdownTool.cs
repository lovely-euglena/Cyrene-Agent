using System.Text.Encodings.Web;
using System.Text.Json;

namespace CyreneNative.Tools;

/// <summary>
/// write_markdown：笔记文件写入（.md/.txt，与 document-tools.ts 同语义，IKJK3V T2 库替代批）。
///
/// 分工（与 fs_write_file 同款）：
///   - TS 包装器负责 filename 校验 / 路径解析 / 覆盖防骤降（checkOverwriteDrop）/ review 基线；
///     语义拒绝直接抛 ToolExecutionError，不因轨道切换改变。
///   - 本工具只做落盘（追加补换行）与 changes 证据（added/modified，上限同 ToolEvidence）。
///     输出 JSON 键序与 TS buildWriteMarkdownResult 一致：success/tool/path/append/changes。
/// </summary>
internal static class WriteMarkdownTool
{
    private static readonly JsonSerializerOptions Json = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping, // 中文不转义（对齐 TS JSON.stringify）
    };

    public static string Execute(JsonElement args)
    {
        var path = Str(args, "path").Trim();
        if (path.Length == 0) throw new ToolHostException("E_WRITE_MARKDOWN_PATH", "path 不能为空（TS 预检注入绝对路径）");
        var text = Str(args, "content");
        var append = args.TryGetProperty("append", out var ap) && ap.ValueKind == JsonValueKind.True;

        string? existingContent = null;
        if (File.Exists(path))
        {
            try { existingContent = File.ReadAllText(path); }
            catch (Exception ex) { throw new ToolHostException("E_WRITE_MARKDOWN_IO", "写前读取原文件失败: " + ex.Message); }
        }

        try
        {
            var dir = Path.GetDirectoryName(path);
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
            if (append && existingContent is not null)
            {
                // 追加写：原文件末尾缺换行时补一个，避免两段内容粘在同一行（TS 同）
                var needsNewline = existingContent.Length > 0 && !existingContent.EndsWith('\n');
                File.WriteAllText(path, existingContent + (needsNewline ? "\n" : "") + text);
            }
            else
            {
                File.WriteAllText(path, text);
            }
        }
        catch (Exception ex)
        {
            throw new ToolHostException("E_WRITE_MARKDOWN_IO", "写入失败: " + ex.Message);
        }

        // Diff Review 证据：追加/新建 = added，覆盖已有 = modified（与 buildWriteMarkdownResult 同构）
        var insertions = ToolEvidence.CountLines(text);
        List<object> diff;
        string kind;
        int deletions;
        if (append || existingContent is null)
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
            diff = ToolEvidence.BuildReplacedDiff(
                existingContent.Replace("\r\n", "\n").Split('\n'),
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
            tool = "write_markdown",
            path,
            append,
            changes,
        }, Json);
    }

    private static string Str(JsonElement el, string key)
        => el.ValueKind == JsonValueKind.Object && el.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String
            ? v.GetString()!
            : "";
}

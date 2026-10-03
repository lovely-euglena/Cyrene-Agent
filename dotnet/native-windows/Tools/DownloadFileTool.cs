using System.Text.Json;
using System.Text.RegularExpressions;

namespace CyreneNative.Tools;

/// <summary>
/// download_file：从 URL 下载二进制文件落盘（与 download-file-tool.ts 同语义）。
///   - 输出根由 TS 包装器经内部参数 `__cyreneRoot` 注入（工作区根 / 桌面）
///   - 危险字符 / 目录穿越 / 危险后缀黑名单 / 64MiB 上限 / 30s 空闲超时
///   - 先完整缓冲校验再一次性落盘：中断不留半截文件
///   - 失败以与 TS 相同的文案字符串返回；基础设施缺失（root 未注入）抛错误帧回退
/// </summary>
internal static class DownloadFileTool
{
    private const int IdleTimeoutMs = 30_000;
    private const long MaxBytes = 64L * 1024 * 1024;
    private const string UserAgent = "Mozilla/5.0 (Cyrene Agent) Chrome/120 Safari/537.36";

    private static readonly HttpClient Http = new() { Timeout = Timeout.InfiniteTimeSpan };

    private static readonly HashSet<string> DangerousExts = new(StringComparer.OrdinalIgnoreCase)
    {
        ".exe", ".bat", ".cmd", ".com", ".scr", ".msi",
        ".ps1", ".vbs", ".lnk", ".jar", ".sh",
    };

    private static readonly Dictionary<string, string> ContentTypeExt = new(StringComparer.OrdinalIgnoreCase)
    {
        ["image/png"] = ".png",
        ["image/jpeg"] = ".jpg",
        ["image/gif"] = ".gif",
        ["image/webp"] = ".webp",
        ["image/svg+xml"] = ".svg",
        ["image/bmp"] = ".bmp",
        ["image/x-icon"] = ".ico",
        ["image/avif"] = ".avif",
        ["application/pdf"] = ".pdf",
        ["application/zip"] = ".zip",
        ["application/x-7z-compressed"] = ".7z",
        ["application/gzip"] = ".gz",
        ["audio/mpeg"] = ".mp3",
        ["audio/wav"] = ".wav",
        ["audio/ogg"] = ".ogg",
        ["video/mp4"] = ".mp4",
        ["video/webm"] = ".webm",
        ["text/plain"] = ".txt",
        ["application/json"] = ".json",
    };

    public static string Execute(JsonElement args)
    {
        var url = Str(args, "url").Trim();
        if (!Regex.IsMatch(url, "^https?://", RegexOptions.IgnoreCase))
            return "[错误] url 必须以 http:// 或 https:// 开头";

        var root = Str(args, "__cyreneRoot");
        if (string.IsNullOrWhiteSpace(root))
            throw new ToolHostException("E_DOWNLOAD_NO_ROOT", "缺少 __cyreneRoot（输出根），download_file 需经宿主包装器调用");

        // ── 文件名：显式传入优先，否则从 URL 推断；都没有先用占位名等 Content-Type 补扩展名 ──
        var filename = Str(args, "filename").Trim();
        if (filename.Length == 0) filename = FilenameFromUrl(url) ?? "";
        if (filename.Length == 0) filename = "download";
        if (HasDangerousChars(filename))
            return "[错误] filename 含非法字符（<>:\"|?*）";

        // 路径沙箱校验（联网之前拒绝）
        var outputPath = ResolveOutputPath(filename, root);
        if (outputPath == null)
            return "[错误] 路径不合法（禁止目录穿越或绝对路径）: " + filename;
        if (DangerousExts.Contains(Path.GetExtension(outputPath)))
            return "[错误] 禁止下载可执行/脚本文件: " + Path.GetExtension(outputPath);

        try
        {
            using var req = new HttpRequestMessage(HttpMethod.Get, url);
            req.Headers.TryAddWithoutValidation("User-Agent", UserAgent);
            req.Headers.TryAddWithoutValidation("Accept", "*/*");
            using var resp = Http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead).GetAwaiter().GetResult();
            if (!resp.IsSuccessStatusCode)
                return "[错误] HTTP " + (int)resp.StatusCode + " " + resp.ReasonPhrase;

            // Content-Length 预检
            var declared = resp.Content.Headers.ContentLength ?? 0;
            if (declared > MaxBytes)
                return $"[错误] 文件过大：{declared} 字节超过上限 {MaxBytes} 字节";

            // 缺扩展名时按 Content-Type 补全
            var finalPath = outputPath;
            if (Path.GetExtension(outputPath).Length == 0)
            {
                var ctype = (resp.Content.Headers.ContentType?.MediaType ?? "").ToLowerInvariant();
                if (!ContentTypeExt.TryGetValue(ctype, out var ext))
                    return "[错误] 无法确定文件扩展名（Content-Type: " + (ctype.Length > 0 ? ctype : "未知") + "），请显式传入 filename 参数（如 cat.png）";
                finalPath = outputPath + ext;
            }

            // 流式读取 + 完整缓冲（30s 空闲超时；超限/中断不留半截文件）
            using var stream = resp.Content.ReadAsStream();
            using var buffer = new MemoryStream();
            var chunk = new byte[81920];
            long total = 0;
            for (;;)
            {
                int n;
                using (var cts = new CancellationTokenSource(IdleTimeoutMs))
                {
                    try
                    {
                        n = stream.ReadAsync(chunk.AsMemory(0, chunk.Length), cts.Token).GetAwaiter().GetResult();
                    }
                    catch (OperationCanceledException)
                    {
                        return "[错误] 下载失败: 空闲超时（30s 无数据）";
                    }
                }
                if (n <= 0) break;
                total += n;
                if (total > MaxBytes)
                    return $"[错误] 文件过大：超过上限 {MaxBytes} 字节，已中止";
                buffer.Write(chunk, 0, n);
            }

            var dir = Path.GetDirectoryName(finalPath);
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
            File.WriteAllBytes(finalPath, buffer.ToArray());

            var sizeText = total >= 1024 * 1024
                ? ((double)total / 1024 / 1024).ToString("0.0", System.Globalization.CultureInfo.InvariantCulture) + " MiB"
                : (long)Math.Floor((double)total / 1024 + 0.5) + " KiB";
            return $"[download_file] 已保存：{finalPath}（{sizeText}）";
        }
        catch (Exception ex)
        {
            return "[错误] 下载失败: " + ex.Message;
        }
    }

    private static bool HasDangerousChars(string filename) => Regex.IsMatch(filename, "[<>:\"|?*]");

    /// <summary>与 TS resolveOutputPath 同规则：normalize 后禁含 ".."、禁绝对路径、必须落在 root 内。</summary>
    private static string? ResolveOutputPath(string filename, string root)
    {
        var slashed = filename.Replace('\\', '/');
        var parts = new List<string>();
        foreach (var raw in slashed.Split('/'))
        {
            if (raw.Length == 0 || raw == ".") continue;
            if (raw == "..")
            {
                if (parts.Count == 0) parts.Add(".."); // 保留前导 .. → 后续命中 ".." 检查被拒
                else parts.RemoveAt(parts.Count - 1);
                continue;
            }
            parts.Add(raw);
        }
        var normalized = string.Join("/", parts);
        if (normalized.Contains("..") || Path.IsPathRooted(normalized)) return null;

        var rootFull = Path.GetFullPath(root);
        var fullPath = Path.GetFullPath(Path.Combine(rootFull, normalized.Replace('/', Path.DirectorySeparatorChar)));
        var relative = Path.GetRelativePath(rootFull, fullPath);
        if (relative == ".." || relative.StartsWith(".." + Path.DirectorySeparatorChar, StringComparison.Ordinal) || Path.IsPathRooted(relative))
            return null;
        return fullPath;
    }

    /// <summary>从 URL 推断文件名（pathname 最后一段，URL 解码；必须像文件名）。</summary>
    private static string? FilenameFromUrl(string url)
    {
        try
        {
            var pathname = new Uri(url).AbsolutePath;
            var last = pathname.Split('/').Where(s => s.Length > 0).LastOrDefault() ?? "";
            last = Uri.UnescapeDataString(last);
            if (last.Length == 0 || !last.Contains('.') || last.StartsWith('.')) return null;
            return last;
        }
        catch
        {
            return null;
        }
    }

    private static string Str(JsonElement args, string key)
        => args.ValueKind == JsonValueKind.Object && args.TryGetProperty(key, out var el) && el.ValueKind == JsonValueKind.String
            ? el.GetString()!
            : "";
}

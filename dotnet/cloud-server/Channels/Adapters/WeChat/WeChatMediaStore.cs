using System.Text;

namespace CyreneCloud.Channels.Adapters.WeChat;

/// <summary>
/// 微信媒体缓存（设计 §3.3/§3.5）：入站图片/可分析文件落 `&lt;dataDir&gt;/media/wechat/`（0600，
/// 目录 0700 best-effort）；文件名镜像桌面 buildStoredFileName（wechat-&lt;msgId&gt;-&lt;ts&gt;-&lt;base&gt;&lt;ext&gt;）；
/// 总量按 CLOUD_CHANNEL_MEDIA_DIR_MB 做 LRU 淘汰 + TTL 7 天清理（框架 ChannelMediaStore 未落地，
/// 本实现自包含，避免重设计框架）。
/// </summary>
public sealed class WeChatMediaStore
{
    public static readonly TimeSpan DefaultTtl = TimeSpan.FromDays(7);

    private readonly string _dir;
    private readonly long _maxTotalBytes;

    public WeChatMediaStore(string dataDir, int maxTotalMb = 256)
    {
        _dir = Path.Combine(Path.GetFullPath(dataDir), "media", "wechat");
        _maxTotalBytes = Math.Max(1, maxTotalMb) * 1024L * 1024L;
        Directory.CreateDirectory(_dir);
        TryHardenDirectory(_dir);
    }

    public string DirectoryPath => _dir;

    /// <summary>落盘并返回绝对路径；写前按总量上限淘汰最旧文件。</summary>
    public async Task<string> SaveAsync(
        string messageId, string fileName, string extension, byte[] data,
        CancellationToken cancellationToken = default)
    {
        EnforceCapacity(data.Length);
        var baseName = Sanitize(Path.GetFileNameWithoutExtension(BaseName(fileName)));
        if (baseName.Length == 0) baseName = "attachment";
        var stem = $"wechat-{Sanitize(messageId)}-{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}-{baseName}";
        var path = Path.Combine(_dir, stem + extension);
        var counter = 1;
        while (File.Exists(path))
        {
            path = Path.Combine(_dir, $"{stem}-{counter++}{extension}");
        }
        await File.WriteAllBytesAsync(path, data, cancellationToken);
        TryHardenFile(path);
        return path;
    }

    /// <summary>扩展名选择（桌面 pickInboundExtension 同口径）：描述符优先，其次按图片魔数推断。</summary>
    public static string PickExtension(string extension, string kind, byte[] data)
    {
        if (!string.IsNullOrEmpty(extension)) return extension;
        if (kind == "image") return InferImageExtension(data) ?? ".jpg";
        return ".bin";
    }

    /// <summary>清理超过 TTL 的缓存文件（适配器启动时 best-effort 调用）。</summary>
    public Task<int> CleanupExpiredAsync(TimeSpan ttl, CancellationToken cancellationToken = default)
    {
        var removed = 0;
        var cutoff = DateTime.UtcNow - ttl;
        try
        {
            foreach (var path in Directory.EnumerateFiles(_dir))
            {
                cancellationToken.ThrowIfCancellationRequested();
                try
                {
                    if (File.GetLastWriteTimeUtc(path) < cutoff)
                    {
                        File.Delete(path);
                        removed++;
                    }
                }
                catch
                {
                    // 单个文件失败不影响其它清理
                }
            }
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch
        {
            // best-effort
        }
        return Task.FromResult(removed);
    }

    // ── 容量 / 权限 / 名称 ──────────────────────────────────────────────────

    private void EnforceCapacity(long incomingBytes)
    {
        try
        {
            var files = Directory.EnumerateFiles(_dir)
                .Select(path => new FileInfo(path))
                .Where(info => info.Exists)
                .OrderBy(info => info.LastWriteTimeUtc)
                .ToList();
            var total = files.Sum(info => info.Length);
            foreach (var info in files)
            {
                if (total + incomingBytes <= _maxTotalBytes) break;
                try
                {
                    total -= info.Length;
                    info.Delete();
                }
                catch
                {
                    // 被占用/删除失败：跳过，继续尝试更旧文件
                }
            }
        }
        catch
        {
            // best-effort：容量控制失败不阻断落盘
        }
    }

    private static void TryHardenDirectory(string dir)
    {
        if (!OperatingSystem.IsLinux()) return;
        try
        {
            File.SetUnixFileMode(dir,
                UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        }
        catch
        {
            // best-effort（与 StorageHardening 同姿态）
        }
    }

    private static void TryHardenFile(string path)
    {
        if (!OperatingSystem.IsLinux()) return;
        try
        {
            File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        }
        catch
        {
            // best-effort
        }
    }

    /// <summary>JS path.basename（win32/posix 分隔符都认；末尾分隔符剥掉）。</summary>
    internal static string BaseName(string value)
    {
        var end = value.Length;
        while (end > 0 && (value[end - 1] == '/' || value[end - 1] == '\\')) end--;
        if (end == 0) return "";
        var start = end;
        while (start > 0 && value[start - 1] != '/' && value[start - 1] != '\\') start--;
        return value[start..end];
    }

    /// <summary>桌面 sanitizeFileName 同口径：非法字符替换为下划线。</summary>
    internal static string Sanitize(string value)
    {
        var builder = new StringBuilder(value.Length);
        foreach (var character in value)
        {
            builder.Append(character < 0x20 || character is '<' or '>' or ':' or '"' or '/' or '\\' or '|' or '?' or '*'
                ? '_'
                : character);
        }
        return builder.ToString().Trim();
    }

    private static string? InferImageExtension(byte[] data)
    {
        if (data.Length >= 8
            && data[0] == 0x89 && data[1] == 0x50 && data[2] == 0x4E && data[3] == 0x47
            && data[4] == 0x0D && data[5] == 0x0A && data[6] == 0x1A && data[7] == 0x0A) return ".png";
        if (data.Length >= 3 && data[0] == 0xFF && data[1] == 0xD8 && data[2] == 0xFF) return ".jpg";
        if (data.Length >= 6
            && Encoding.ASCII.GetString(data, 0, 6) is "GIF87a" or "GIF89a") return ".gif";
        if (data.Length >= 12 && Encoding.ASCII.GetString(data, 8, 4) == "WEBP") return ".webp";
        if (data.Length >= 2 && data[0] == (byte)'B' && data[1] == (byte)'M') return ".bmp";
        return null;
    }

    /// <summary>桌面 mimeFromExtension 同表。</summary>
    public static string MimeFromExtension(string extension) => extension.ToLowerInvariant() switch
    {
        ".png" => "image/png",
        ".jpg" or ".jpeg" => "image/jpeg",
        ".webp" => "image/webp",
        ".gif" => "image/gif",
        ".bmp" => "image/bmp",
        ".txt" or ".md" or ".markdown" or ".log" or ".csv" or ".tsv" => "text/plain",
        ".json" => "application/json",
        ".pdf" => "application/pdf",
        ".docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ".xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        _ => "application/octet-stream",
    };
}

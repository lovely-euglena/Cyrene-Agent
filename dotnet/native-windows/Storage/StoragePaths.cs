namespace CyreneNative.Storage;

/// <summary>
/// 云存储路径处理：统一以「档案根相对路径」为工具坐标系。
///
/// - 工具入参 path 一律相对档案 rootPath（"" = 根）；`/a/b` 也是根下 a/b。
/// - NormalizeRelative 负责折叠 `.`/`..`，越出根直接 STORAGE_PATH_INVALID。
/// - Provider 内部再把相对路径与各自根（POSIX 前缀 / S3 prefix）拼成服务端路径。
/// </summary>
internal static class StoragePaths
{
    /// <summary>把用户输入规范化为根相对路径（"" = 根）。越界抛 STORAGE_PATH_INVALID。</summary>
    public static string NormalizeRelative(string? raw)
    {
        if (string.IsNullOrEmpty(raw)) return "";
        if (raw.Contains('\0')) throw StorageException.Invalid("路径包含非法字符");

        var stack = new List<string>();
        foreach (var seg in raw.Replace('\\', '/').Split('/'))
        {
            if (seg.Length == 0 || seg == ".") continue;
            if (seg == "..")
            {
                if (stack.Count == 0)
                    throw StorageException.Invalid($"路径越出档案根目录：{raw}");
                stack.RemoveAt(stack.Count - 1);
                continue;
            }
            stack.Add(seg);
        }
        return string.Join("/", stack);
    }

    /// <summary>保存时的 root 规范化（ftp/ftps/sftp/webdav）：绝对 POSIX 路径，无尾斜杠，根为 "/"。</summary>
    public static string NormalizeRootPath(string? raw)
    {
        var s = (raw ?? "/").Replace('\\', '/').Trim();
        if (s.Length == 0) return "/";
        if (!s.StartsWith('/')) s = "/" + s;
        var stack = new List<string>();
        foreach (var seg in s.Split('/'))
        {
            if (seg.Length == 0 || seg == ".") continue;
            if (seg == "..")
            {
                if (stack.Count > 0) stack.RemoveAt(stack.Count - 1);
                continue; // 绝对路径：根之上再 .. 视作根
            }
            stack.Add(seg);
        }
        return stack.Count == 0 ? "/" : "/" + string.Join("/", stack);
    }

    /// <summary>S3 prefix 规范化：去首尾斜杠，根为空串。</summary>
    public static string NormalizeS3Prefix(string? raw)
        => (raw ?? "").Replace('\\', '/').Trim().Trim('/');

    /// <summary>POSIX 拼接：root="/" 或 "" 时直接用相对路径。</summary>
    public static string CombinePosix(string root, string rel)
    {
        var r = string.IsNullOrEmpty(root) ? "/" : root;
        if (rel.Length == 0) return r;
        return r == "/" ? "/" + rel : r.TrimEnd('/') + "/" + rel;
    }

    /// <summary>S3 key 拼接：prefix 为空时直接用相对路径。</summary>
    public static string CombineS3(string prefix, string rel)
    {
        var p = (prefix ?? "").Trim('/');
        if (p.Length == 0) return rel;
        return rel.Length == 0 ? p : p + "/" + rel;
    }

    /// <summary>POSIX 绝对路径 → 根相对展示（列表条目用）。</summary>
    public static string ToRelative(string root, string absolute)
    {
        var r = string.IsNullOrEmpty(root) ? "/" : root.TrimEnd('/');
        if (r.Length == 0 || r == "/") return absolute.TrimStart('/');
        if (absolute == r) return "";
        return absolute.StartsWith(r + "/", StringComparison.Ordinal) ? absolute[(r.Length + 1)..] : absolute.TrimStart('/');
    }

    /// <summary>S3 key → 根相对展示。</summary>
    public static string ToRelativeS3(string prefix, string key)
    {
        var p = (prefix ?? "").Trim('/');
        if (p.Length == 0) return key.TrimStart('/');
        if (key == p) return "";
        if (key.StartsWith(p + "/", StringComparison.Ordinal)) return key[(p.Length + 1)..];
        return key.TrimStart('/');
    }
}

using System.IO;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Xml.Linq;

namespace CyreneNative.Storage;

/// <summary>
/// WebDAV Provider（自带极简实现，基于 HttpClient）：
/// PROPFIND 列目录/stat、GET/PUT 传输、MKCOL 建目录、DELETE 删除、MOVE/COPY 移动复制。
/// 不引第三方库的原因：HttpClientHandler 原生支持 Basic/Digest/NTLM 协商与自签证书回调，
/// 依赖面更小（选型变化见设计文档 §5 注）。
/// </summary>
internal sealed class WebDavStorageProvider : IStorageProvider
{
    private readonly StorageProfile _profile;
    private readonly HttpClient _http;
    private readonly string _scheme;
    private readonly string _authority;
    private readonly string _basePrefix; // BaseUrl 自带的路径前缀（如 /dav）
    private readonly string _rootRel;    // 档案 root 规范化（"/" 或 "/data"）
    private bool _connected;

    public WebDavStorageProvider(StorageProfile profile)
    {
        _profile = profile;
        var handler = new HttpClientHandler
        {
            AllowAutoRedirect = true,
            PreAuthenticate = true,
        };
        if (!string.IsNullOrWhiteSpace(profile.Username) && profile.WebDavAuthType != "none")
        {
            handler.Credentials = new NetworkCredential(profile.Username, profile.Password ?? "");
        }
        if (profile.AllowInvalidCert)
        {
            handler.ServerCertificateCustomValidationCallback = (_, _, _, _) => true;
        }
        _http = new HttpClient(handler) { Timeout = Timeout.InfiniteTimeSpan };
        _http.DefaultRequestHeaders.UserAgent.ParseAdd("Cyrene-Storage/1.0");

        var baseUri = new Uri(profile.BaseUrl, UriKind.Absolute);
        _scheme = baseUri.Scheme;
        _authority = baseUri.Authority;
        _basePrefix = baseUri.AbsolutePath.TrimEnd('/');
        _rootRel = StoragePaths.NormalizeRootPath(profile.RootPath);
    }

    public bool IsConnected => _connected;

    public void Connect()
    {
        // PROPFIND depth 0 探根：404 说明 rootPath 配错，401/403 走错误映射
        using var resp = SendPropfind("", depth: "0", allowNotFound: true);
        if (resp.StatusCode == HttpStatusCode.NotFound)
            throw StorageException.NotFound($"WebDAV 根路径不存在：{_profile.BaseUrl}{_rootRel}");
        _connected = true;
    }

    public StorageEntry? Stat(string relPath)
    {
        if (relPath.Length == 0) return RootEntry();
        using var resp = SendPropfind(relPath, depth: "0", allowNotFound: true);
        if (resp.StatusCode == HttpStatusCode.NotFound) return null;
        var xml = resp.Content.ReadAsStringAsync().GetAwaiter().GetResult();
        var response = ParseResponses(xml).FirstOrDefault();
        return response is null ? null : ToEntry(response, relPath);
    }

    public List<StorageEntry> List(string relPath, int maxEntries, out bool truncated)
    {
        using var resp = SendPropfind(relPath, depth: "1", allowNotFound: false);
        var xml = resp.Content.ReadAsStringAsync().GetAwaiter().GetResult();
        var entries = new List<StorageEntry>(Math.Min(maxEntries, 64));
        truncated = false;
        foreach (var response in ParseResponses(xml))
        {
            var href = Href(response);
            if (href is null) continue;
            var rel = HrefToRelative(href);
            if (rel is null || rel == relPath) continue; // 跳过集合自身
            if (entries.Count >= maxEntries) { truncated = true; break; }
            entries.Add(ToEntry(response, rel));
        }
        return entries;
    }

    public Stream OpenRead(string relPath)
    {
        using var resp = Send(HttpMethod.Get, relPath, null, HttpCompletionOption.ResponseHeadersRead);
        using var stream = resp.Content.ReadAsStream();
        var buffer = new MemoryStream();
        stream.CopyTo(buffer);
        buffer.Position = 0;
        return buffer;
    }

    public void Put(string relPath, Stream source, long length, bool createParents)
    {
        if (createParents) EnsureDir(ParentOf(relPath));
        using var content = new StreamContent(source);
        content.Headers.ContentLength = length;
        content.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue("application/octet-stream");
        using var resp = Send(HttpMethod.Put, relPath, content, HttpCompletionOption.ResponseContentRead);
    }

    public void Download(string relPath, Stream destination)
    {
        using var resp = Send(HttpMethod.Get, relPath, null, HttpCompletionOption.ResponseHeadersRead);
        using var stream = resp.Content.ReadAsStream();
        stream.CopyTo(destination);
    }

    public void Delete(string relPath, bool recursive)
    {
        if (relPath.Length == 0) throw StorageException.Invalid("不能删除档案根目录");
        var entry = Stat(relPath) ?? throw StorageException.NotFound($"远端不存在：{relPath}");
        if (entry.Type == "dir")
        {
            if (recursive)
            {
                DeleteRecursive(relPath); // 子项 + 目录本身
                return;
            }
            if (List(relPath, 1, out _).Count > 0)
                throw StorageException.Io($"目录非空（需要 recursive=true）：{relPath}");
        }
        DeleteFile(relPath);
    }

    public void Mkdir(string relPath, bool recursive)
    {
        if (relPath.Length == 0) return;
        if (recursive)
        {
            EnsureDir(relPath);
            return;
        }
        try
        {
            using var resp = Send(new HttpMethod("MKCOL"), relPath, null, HttpCompletionOption.ResponseContentRead);
        }
        catch (StorageException)
        {
            if (!ExistsQuiet(relPath)) throw; // 405/409 = 已存在 → 幂等成功
        }
    }

    public void Move(string fromRel, string toRel, bool overwrite)
        => MoveOrCopy(new HttpMethod("MOVE"), fromRel, toRel, overwrite);

    public void Copy(string fromRel, string toRel, bool overwrite)
        => MoveOrCopy(new HttpMethod("COPY"), fromRel, toRel, overwrite);

    public long Test()
    {
        var sw = System.Diagnostics.Stopwatch.StartNew();
        using var resp = SendPropfind("", depth: "0", allowNotFound: true);
        if (resp.StatusCode == HttpStatusCode.NotFound)
            throw StorageException.NotFound($"WebDAV 根路径不存在：{_profile.BaseUrl}{_rootRel}");
        _connected = true;
        sw.Stop();
        return sw.ElapsedMilliseconds;
    }

    public void Dispose() => _http.Dispose();

    // ── 路径/URI ────────────────────────────────────────────

    /// <summary>baseUrl 路径前缀 + 档案 root + 相对路径（POSIX，未转义）。</summary>
    private string FullPath(string rel)
    {
        var combined = _rootRel + (rel.Length == 0 || _rootRel == "/" ? rel : "/" + rel);
        if (combined.Length == 0) return _basePrefix;
        return _basePrefix.TrimEnd('/') + "/" + combined.TrimStart('/');
    }

    private Uri UriFor(string rel)
    {
        var path = FullPath(rel);
        var sb = new StringBuilder().Append(_scheme).Append("://").Append(_authority);
        foreach (var seg in path.Split('/'))
        {
            if (seg.Length == 0) continue;
            sb.Append('/').Append(Uri.EscapeDataString(seg));
        }
        if (sb.Length == _scheme.Length + _authority.Length + 3) sb.Append('/');
        return new Uri(sb.ToString());
    }

    private string? HrefToRelative(string href)
    {
        string path;
        if (Uri.TryCreate(href, UriKind.Absolute, out var uri)) path = uri.AbsolutePath;
        else path = href;
        path = Uri.UnescapeDataString(path);

        if (_basePrefix.Length > 0)
        {
            if (!path.StartsWith(_basePrefix, StringComparison.Ordinal)) return null;
            path = path[_basePrefix.Length..];
        }
        if (_rootRel.Length > 1)
        {
            if (!path.StartsWith(_rootRel, StringComparison.Ordinal)) return null;
            path = path[_rootRel.Length..];
        }
        return path.Trim('/');
    }

    // ── 请求 ────────────────────────────────────────────────

    private static readonly string PropfindBody =
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>" +
        "<d:propfind xmlns:d=\"DAV:\"><d:prop>" +
        "<d:resourcetype/><d:getcontentlength/><d:getlastmodified/>" +
        "</d:prop></d:propfind>";

    private HttpResponseMessage SendPropfind(string rel, string depth, bool allowNotFound)
    {
        using var content = new StringContent(PropfindBody, Encoding.UTF8, "application/xml");
        var request = new HttpRequestMessage(new HttpMethod("PROPFIND"), UriFor(rel)) { Content = content };
        request.Headers.TryAddWithoutValidation("Depth", depth);
        var resp = _http.Send(request, HttpCompletionOption.ResponseContentRead);
        if (resp.StatusCode == HttpStatusCode.NotFound && allowNotFound) return resp;
        if ((int)resp.StatusCode >= 400)
        {
            var status = resp.StatusCode;
            resp.Dispose();
            throw MapStatus(status, rel);
        }
        return resp;
    }

    private HttpResponseMessage Send(HttpMethod method, string rel, HttpContent? content, HttpCompletionOption completion)
    {
        var request = new HttpRequestMessage(method, UriFor(rel));
        if (content is not null) request.Content = content;
        var resp = _http.Send(request, completion);
        if ((int)resp.StatusCode >= 400)
        {
            var status = resp.StatusCode;
            resp.Dispose();
            throw MapStatus(status, rel);
        }
        return resp;
    }

    private static StorageException MapStatus(HttpStatusCode status, string rel) => status switch
    {
        HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden =>
            new StorageException("STORAGE_AUTH_FAILED", $"WebDAV 认证/权限失败（HTTP {(int)status}）：{rel}"),
        HttpStatusCode.NotFound =>
            new StorageException("STORAGE_NOT_FOUND", $"远端不存在：{rel}"),
        HttpStatusCode.Conflict =>
            new StorageException("STORAGE_ALREADY_EXISTS", $"目标已存在：{rel}"),
        HttpStatusCode.PreconditionFailed =>
            new StorageException("STORAGE_ALREADY_EXISTS", $"目标已存在（Precondition Failed）：{rel}"),
        _ => new StorageException("STORAGE_IO_ERROR", $"WebDAV 请求失败（HTTP {(int)status}）：{rel}"),
    };

    private void MoveOrCopy(HttpMethod method, string fromRel, string toRel, bool overwrite)
    {
        using var request = new HttpRequestMessage(method, UriFor(fromRel));
        request.Headers.TryAddWithoutValidation("Destination", UriFor(toRel).AbsoluteUri);
        request.Headers.TryAddWithoutValidation("Overwrite", overwrite ? "T" : "F");
        using var resp = _http.Send(request, HttpCompletionOption.ResponseContentRead);
        if ((int)resp.StatusCode >= 400) throw MapStatus(resp.StatusCode, toRel);
    }

    private void EnsureDir(string rel)
    {
        if (rel.Length == 0) return;
        var current = "";
        foreach (var seg in rel.Split('/'))
        {
            if (seg.Length == 0) continue;
            current = current.Length == 0 ? seg : current + "/" + seg;
            try
            {
                using var resp = Send(new HttpMethod("MKCOL"), current, null, HttpCompletionOption.ResponseContentRead);
            }
            catch (StorageException)
            {
                if (!ExistsQuiet(current)) throw; // 已存在（405/409）容错继续
            }
        }
    }

    private bool ExistsQuiet(string rel)
    {
        try
        {
            return Stat(rel) is not null;
        }
        catch
        {
            return false;
        }
    }

    private void DeleteRecursive(string rel)
    {
        foreach (var child in List(rel, 10_000, out _))
        {
            if (child.Type == "dir") DeleteRecursive(child.Path);
            else DeleteFile(child.Path);
        }
        DeleteFile(rel);
    }

    private void DeleteFile(string rel)
    {
        using var resp = Send(HttpMethod.Delete, rel, null, HttpCompletionOption.ResponseContentRead);
    }

    // ── 解析 ────────────────────────────────────────────────

    private static IEnumerable<XElement> ParseResponses(string xml)
    {
        XDocument doc;
        try { doc = XDocument.Parse(xml); }
        catch { yield break; }
        if (doc.Root is null) yield break;
        foreach (var el in doc.Root.Descendants())
        {
            if (el.Name.LocalName == "response") yield return el;
        }
    }

    private static XElement? FirstChild(XElement element, string localName)
        => element.Elements().FirstOrDefault(e => e.Name.LocalName == localName);

    private static string? Href(XElement response) => FirstChild(response, "href")?.Value;

    private static string TypeOf(XElement response)
    {
        var resourceType = response.Descendants().FirstOrDefault(e => e.Name.LocalName == "resourcetype");
        var isCollection = resourceType?.Elements().Any(e => e.Name.LocalName == "collection") == true;
        return isCollection ? "dir" : "file";
    }

    private static long? ContentLengthOf(XElement response)
    {
        var el = response.Descendants().FirstOrDefault(e => e.Name.LocalName == "getcontentlength");
        return el is not null && long.TryParse(el.Value, out var size) ? size : null;
    }

    private static string? LastModifiedOf(XElement response)
    {
        var el = response.Descendants().FirstOrDefault(e => e.Name.LocalName == "getlastmodified");
        return el is not null && DateTimeOffset.TryParse(el.Value, out var dt) ? dt.UtcDateTime.ToString("O") : null;
    }

    private static StorageEntry RootEntry() => new() { Name = "", Path = "", Type = "dir" };

    private static StorageEntry ToEntry(XElement response, string rel)
    {
        var type = TypeOf(response);
        var name = rel.Contains('/') ? rel[(rel.LastIndexOf('/') + 1)..] : rel;
        return new StorageEntry
        {
            Name = name,
            Path = rel,
            Type = type,
            Size = type == "file" ? ContentLengthOf(response) : null,
            ModifiedAt = LastModifiedOf(response),
        };
    }

    private static string ParentOf(string rel)
    {
        var idx = rel.LastIndexOf('/');
        return idx <= 0 ? "" : rel[..idx];
    }
}

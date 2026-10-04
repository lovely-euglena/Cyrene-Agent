using System.Collections.Concurrent;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using ReverseMarkdown;

namespace CyreneNative.Tools;

/// <summary>
/// fetch_url：拉取 URL 正文（与 fetch-url-tool.ts 同语义，IKJK3V T2 库替代批）。
///
///   - 两条抓取路径：GitHub 仓库主页走官方 API（元信息 + README 原文）；
///     普通网页抓 HTML → 正文提取（剥导航/页头/页脚/侧栏，优先 article/main）→ 转 markdown。
///   - 库替代：Turndown → ReverseMarkdown（v6，AngleSharp 解析）。配置对齐 Turndown 口径：
///     ATX 标题 / 围栏代码块（GithubFlavored）/ "-" 列表 / 未知标签 Bypass（保留内容剥标签）/
///     输出统一 LF。已知格式差异（列表缩进、链接/强调边界等）见 dual-track 归一说明——
///     语义等价，不承诺逐字节一致（不同库无法逐字对齐，双轨以归一投影比对）。
///   - 缓存：30 分钟固定 TTL（不续期；容量 100 超限整体清空；命中标注 [缓存] 摄取时间）。
///   - 安全/健壮：20s 超时；单次最多 512KB（超出截断并标注）；HTTP 错误返回 [错误] 文本。
///   - 测试注入口（模型不可见）：__githubApiBase 覆盖 GitHub API 基址（默认 api.github.com）。
/// </summary>
internal static class FetchUrlTool
{
    private const int FetchTimeoutMs = 20_000;
    private const int FetchMaxBytes = 512 * 1024;
    private const int MainRegionMinTextChars = 200;
    private const long CacheTtlMs = 30 * 60_000;
    private const int CacheMaxEntries = 100;
    private const string UserAgent = "Mozilla/5.0 (Cyrene Agent) Chrome/120 Safari/537.36";
    private const string DefaultGithubApiBase = "https://api.github.com";

    private static readonly HttpClient Http = new() { Timeout = Timeout.InfiniteTimeSpan }; // 超时走按请求 CTS
    private static readonly ConcurrentDictionary<string, (string Value, long At)> Cache = new();

    private static readonly Converter Md = CreateConverter();

    private static Converter CreateConverter()
    {
        var config = new Config
        {
            // pre → 围栏代码块（对齐 Turndown codeBlockStyle=fenced）
            GithubFlavored = true,
            Formatting =
            {
                ListBulletChar = '-',
                OutputLineEnding = "\n", // 默认 Environment.NewLine 会把 Windows 输出带成 CRLF
            },
            // 未知标签保留内容、剥掉标签（对齐 Turndown 默认规则）
            Tags = { Unknown = Config.UnknownTagsOption.Bypass },
        };
        return new Converter(config);
    }

    public static string Execute(JsonElement args)
    {
        var url = Str(args, "url").Trim();
        if (!Regex.IsMatch(url, "^https?://", RegexOptions.IgnoreCase))
            return "[错误] url 必须以 http:// 或 https:// 开头";

        var asMarkdown = !IsRawFormat(args);

        // 缓存命中：直接复用并标注抓取时间（固定 TTL 不续期）
        var cacheKey = url + "|" + (asMarkdown ? "markdown" : "raw");
        if (Cache.TryGetValue(cacheKey, out var hit))
        {
            if (DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - hit.At < CacheTtlMs)
                return "[缓存] 摄取于 " + FormatCacheTime(hit.At) + "，30 分钟内直接复用\n\n" + hit.Value;
            Cache.TryRemove(cacheKey, out _);
        }

        // GitHub 仓库主页特化：官方 API 直取 README + 元信息（format=raw 不做特化）
        if (asMarkdown)
        {
            var repo = MatchGithubRepoUrl(url);
            if (repo is not null)
            {
                var summary = FetchGithubRepoSummary(repo.Value, url, Str(args, "__githubApiBase"));
                if (summary is not null)
                {
                    CacheSet(cacheKey, summary);
                    return summary;
                }
            }
        }

        return FetchNormal(url, asMarkdown, cacheKey);
    }

    // ── 普通抓取 ─────────────────────────────────────────────

    private static string FetchNormal(string url, bool asMarkdown, string cacheKey)
    {
        try
        {
            using var cts = new CancellationTokenSource(FetchTimeoutMs);
            using var request = new HttpRequestMessage(HttpMethod.Get, url);
            request.Headers.TryAddWithoutValidation("User-Agent", UserAgent);
            request.Headers.TryAddWithoutValidation("Accept", "text/html,text/markdown,text/plain,*/*;q=0.8");
            using var resp = Http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cts.Token)
                .GetAwaiter().GetResult();
            if (!resp.IsSuccessStatusCode)
                return "[错误] HTTP " + (int)resp.StatusCode + " " + (resp.ReasonPhrase ?? "");

            var ctype = resp.Content.Headers.ContentType?.ToString() ?? "";
            var (slice, truncated) = ReadCapped(resp, cts.Token);
            var text = Encoding.UTF8.GetString(slice);
            if (asMarkdown && Regex.IsMatch(ctype, "text/html|application/xhtml", RegexOptions.IgnoreCase))
                text = StripHtml(text);

            var meta = "URL: " + url + "\nContent-Type: " + ctype
                + (truncated ? "\n[已截断到 " + FetchMaxBytes + " 字节]" : "") + "\n\n";
            var result = meta + text;
            CacheSet(cacheKey, result);
            return result;
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or OperationCanceledException or IOException)
        {
            return "[错误] fetch 失败: " + ex.Message;
        }
    }

    /// <summary>读取响应体到最多 max+1 字节：多出的 1 字节只用于判定截断，输出切片与 TS 一致。</summary>
    private static (byte[] Slice, bool Truncated) ReadCapped(HttpResponseMessage resp, CancellationToken ct)
    {
        using var stream = resp.Content.ReadAsStream(ct);
        var buffer = new MemoryStream();
        var chunk = new byte[64 * 1024];
        while (buffer.Length <= FetchMaxBytes)
        {
            var read = stream.Read(chunk, 0, chunk.Length);
            if (read <= 0) break;
            buffer.Write(chunk, 0, read);
        }
        var all = buffer.ToArray();
        var truncated = all.Length > FetchMaxBytes;
        return truncated ? (all[..FetchMaxBytes], true) : (all, false);
    }

    // ── HTML 正文提取 / markdown 转换 ────────────────────────

    private static string StripHtml(string html)
    {
        // 先去 script/style/注释（转换库不会自动去这些，留着会污染 markdown）
        var s = Regex.Replace(html, "<script[\\s\\S]*?</script>", " ", RegexOptions.IgnoreCase);
        s = Regex.Replace(s, "<style[\\s\\S]*?</style>", " ", RegexOptions.IgnoreCase);
        s = Regex.Replace(s, "<!--[\\s\\S]*?-->", " ");
        // 整体移除页面骨架区块（导航/页头/页脚/侧栏）
        s = Regex.Replace(s, "<(nav|header|footer|aside)\\b[^>]*>[\\s\\S]*?</\\1\\s*>", " ", RegexOptions.IgnoreCase);

        // 正文容器优先：article → main（文字量不足视为空壳，回退整页）
        var source = ExtractMainRegion(s) ?? s;

        try
        {
            var md = Md.Convert(source);
            return Regex.Replace(md, "\n{3,}", "\n\n").Trim();
        }
        catch
        {
            // 转换失败（畸形 HTML）：退回纯标签剥离
            var t = Regex.Replace(source, "<[^>]+>", " ");
            t = t.Replace("&nbsp;", " ").Replace("&amp;", "&").Replace("&lt;", "<")
                .Replace("&gt;", ">").Replace("&quot;", "\"").Replace("&#39;", "'");
            t = Regex.Replace(t, "[ \t]+", " ");
            t = Regex.Replace(t, "\\s*\n\\s*", "\n");
            return t.Trim();
        }
    }

    /// <summary>找正文容器：先试 article 再试 main；开始取第一个、结束取最后一个；文字太少返回 null。</summary>
    private static string? ExtractMainRegion(string cleaned)
    {
        foreach (var tag in new[] { "article", "main" })
        {
            var open = Regex.Match(cleaned, "<" + tag + "\\b[^>]*>", RegexOptions.IgnoreCase);
            if (!open.Success) continue;
            var close = LastIndexOfTagClose(cleaned, tag);
            if (close < 0 || close <= open.Index) continue;
            var region = cleaned[open.Index..close];
            var textLen = Regex.Replace(region, "<[^>]+>", "").Replace(" ", "").Length;
            if (textLen >= MainRegionMinTextChars) return region;
        }
        return null;
    }

    /// <summary>最后一个 &lt;/tag&gt; 的结束下标（含闭合标签本身）。</summary>
    private static int LastIndexOfTagClose(string html, string tag)
    {
        var last = -1;
        foreach (Match m in Regex.Matches(html, "</" + tag + "\\s*>", RegexOptions.IgnoreCase))
            last = m.Index + m.Length;
        return last;
    }

    // ── GitHub 仓库主页特化 ──────────────────────────────────

    // github.com 下这些一级路径不是用户名，对应的二级页面不是仓库主页
    private static readonly HashSet<string> GithubReservedPrefixes = new(StringComparer.OrdinalIgnoreCase)
    {
        "topics", "orgs", "users", "settings", "sponsors", "collections", "features",
        "marketplace", "apps", "gists", "site", "security", "about", "pricing",
        "enterprise", "explore", "trending", "search", "notifications", "dashboard",
        "new", "pulls", "issues", "watching", "organizations", "codespaces",
    };

    /// <summary>识别 github.com/{owner}/{repo} 仓库主页地址，其它返回 null。</summary>
    private static (string Owner, string Repo)? MatchGithubRepoUrl(string rawUrl)
    {
        if (!Uri.TryCreate(rawUrl, UriKind.Absolute, out var u)) return null;
        if (!Regex.IsMatch(u.Host, "^(www\\.)?github\\.com$", RegexOptions.IgnoreCase)) return null;
        var m = Regex.Match(u.AbsolutePath, "^/([^/]+)/([^/]+?)(?:\\.git)?/?$");
        if (!m.Success) return null;
        var owner = m.Groups[1].Value;
        var repo = m.Groups[2].Value;
        if (owner.Length == 0 || repo.Length == 0) return null;
        if (GithubReservedPrefixes.Contains(owner)) return null;
        return (owner, repo);
    }

    /// <summary>拉取 GitHub 仓库元信息 + README 原文；任何失败返回 null，由调用方回退普通抓取。</summary>
    private static string? FetchGithubRepoSummary((string Owner, string Repo) repo, string url, string apiBaseOverride)
    {
        var apiBase = apiBaseOverride.Trim().Length > 0 ? apiBaseOverride.Trim().TrimEnd('/') : DefaultGithubApiBase;
        var baseUrl = apiBase + "/repos/" + repo.Owner + "/" + repo.Repo;
        try
        {
            using var cts = new CancellationTokenSource(FetchTimeoutMs);
            // 顺序拉取（共享 20s 预算；TS 侧并行，行为等价——任一失败都整体回退）
            var meta = FetchText(baseUrl, "application/vnd.github+json", cts.Token);
            var readme = FetchRaw(baseUrl + "/readme", "application/vnd.github.raw", cts.Token);
            if (readme is null) return null; // README 拿不到（私有/不存在/限流/超时）→ 回退普通抓取

            var (readmeSlice, truncated) = readme.Value;
            var readmeText = Encoding.UTF8.GetString(readmeSlice);

            var header = "";
            if (meta is { Ok: true, Body: { } metaBody })
            {
                try
                {
                    header = FormatGithubMeta(metaBody, repo) + "\n\n---\n\n";
                }
                catch
                {
                    // 元信息 JSON 解析失败不影响 README 输出
                }
            }

            var metaLine = "URL: " + url + "\n来源: GitHub API（仓库元信息 + README 原文）"
                + (truncated ? "\n[README 已截断到 " + FetchMaxBytes + " 字节]" : "") + "\n\n";
            return metaLine + header + readmeText.Trim();
        }
        catch
        {
            // 网络失败或超时 → 回退普通抓取
            return null;
        }
    }

    /// <summary>GET 文本响应；网络异常返回 null（对齐 TS Promise.all 任一失败整体回退）。</summary>
    private static (bool Ok, string Body)? FetchText(string url, string accept, CancellationToken ct)
    {
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, url);
            request.Headers.TryAddWithoutValidation("User-Agent", UserAgent);
            request.Headers.TryAddWithoutValidation("Accept", accept);
            using var resp = Http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct)
                .GetAwaiter().GetResult();
            var body = resp.Content.ReadAsStringAsync(ct).GetAwaiter().GetResult();
            return (resp.IsSuccessStatusCode, body);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or OperationCanceledException or IOException)
        {
            return null;
        }
    }

    /// <summary>GET 原始字节（README，按 512KB 截断）；网络异常/非 2xx 返回 null。</summary>
    private static (byte[] Slice, bool Truncated)? FetchRaw(string url, string accept, CancellationToken ct)
    {
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, url);
            request.Headers.TryAddWithoutValidation("User-Agent", UserAgent);
            request.Headers.TryAddWithoutValidation("Accept", accept);
            using var resp = Http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct)
                .GetAwaiter().GetResult();
            if (!resp.IsSuccessStatusCode) return null;
            return ReadCapped(resp, ct);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or OperationCanceledException or IOException)
        {
            return null;
        }
    }

    /// <summary>仓库元信息 → markdown 头部；字段缺失跳过不硬凑。</summary>
    private static string FormatGithubMeta(string metaJson, (string Owner, string Repo) repo)
    {
        using var doc = JsonDocument.Parse(metaJson);
        var meta = doc.RootElement;
        if (meta.ValueKind != JsonValueKind.Object) return "";

        var lines = new List<string> { "# " + repo.Owner + "/" + repo.Repo };
        var desc = Str(meta, "description").Trim();
        if (desc.Length > 0)
        {
            lines.Add("");
            lines.Add("> " + desc);
        }
        var stats = new List<string>();
        if (meta.TryGetProperty("stargazers_count", out var stars) && stars.ValueKind == JsonValueKind.Number)
            stats.Add("stars: " + stars.GetRawText());
        if (meta.TryGetProperty("forks_count", out var forks) && forks.ValueKind == JsonValueKind.Number)
            stats.Add("forks: " + forks.GetRawText());
        var language = Str(meta, "language");
        if (language.Length > 0) stats.Add("language: " + language);
        var defaultBranch = Str(meta, "default_branch");
        if (defaultBranch.Length > 0) stats.Add("默认分支: " + defaultBranch);
        if (meta.TryGetProperty("license", out var license) && license.ValueKind == JsonValueKind.Object)
        {
            var spdx = Str(license, "spdx_id");
            if (spdx.Length > 0 && spdx != "NOASSERTION") stats.Add("license: " + spdx);
        }
        if (stats.Count > 0)
        {
            lines.Add("");
            lines.Add(string.Join(" · ", stats));
        }
        return string.Join("\n", lines);
    }

    // ── 通用 ────────────────────────────────────────────────

    private static bool IsRawFormat(JsonElement args)
        => args.ValueKind == JsonValueKind.Object && args.TryGetProperty("format", out var f)
           && f.ValueKind == JsonValueKind.String && f.GetString() == "raw";

    private static void CacheSet(string key, string value)
    {
        if (Cache.Count >= CacheMaxEntries) Cache.Clear(); // 超容量整体清空，不搞 LRU
        Cache[key] = (value, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
    }

    /// <summary>缓存时间展示：对齐 TS `toLocaleString("zh-CN", {hour12:false})` 的 "yyyy/M/d HH:mm:ss"。</summary>
    private static string FormatCacheTime(long unixMs)
        => DateTimeOffset.FromUnixTimeMilliseconds(unixMs).ToLocalTime().ToString("yyyy/M/d HH:mm:ss");

    private static string Str(JsonElement el, string key)
        => el.ValueKind == JsonValueKind.Object && el.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String
            ? v.GetString()!
            : "";
}

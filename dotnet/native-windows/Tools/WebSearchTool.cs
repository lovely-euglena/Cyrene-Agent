using System.Collections.Concurrent;
using System.Globalization;
using System.Net.Http;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace CyreneNative.Tools;

/// <summary>
/// web_search：博查 / Tavily / AnySearch 多源搜索（与 web-search-tool.ts 同语义）。
///   - 引擎与各源 key 由 config 帧注入（B1：进程内存驻留，不落盘）；
///   - 30 分钟 TTL 结果缓存（固定 TTL 不续期；容量 100 超限整体清空；命中补 cached/cachedAt）；
///   - 校验失败抛与 TS 同名错误码（E_SEARCH_NOT_ENABLED / E_SEARCH_QUERY_EMPTY /
///     E_SEARCH_KEY_MISSING / E_SEARCH_ENGINE_NOT_SUPPORTED:engine）；
///   - 网络/HTTP/解析失败抛错误帧 → TS 包装层回退原实现（错误语义零漂移）。
/// </summary>
internal static class WebSearchTool
{
    private const int TimeoutSeconds = 20;
    private const int MaxSnippetLen = 500;
    private const long CacheTtlMs = 30 * 60_000;
    private const int CacheMaxEntries = 100;

    private static readonly JsonSerializerOptions Json = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping, // 中文不转 \uXXXX（与 TS JSON.stringify 对齐）
    };
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(60) };
    private static readonly ConcurrentDictionary<string, (string OutputJson, long At)> Cache = new();

    public static string Execute(JsonElement args)
    {
        var engine = ToolHostConfig.WebSearchEngine;
        if (engine == "off") throw new ToolHostException("E_SEARCH_NOT_ENABLED", "E_SEARCH_NOT_ENABLED");

        var query = Str(args, "query").Trim();
        if (query.Length == 0) throw new ToolHostException("E_SEARCH_QUERY_EMPTY", "E_SEARCH_QUERY_EMPTY");

        // 缓存命中：标注 cached/cachedAt，让模型自知结果的新鲜度（TS 同；key 对空白归一）
        var cacheKey = engine + "|" + Regex.Replace(query, @"\s+", " ");
        if (Cache.TryGetValue(cacheKey, out var hit))
        {
            if (DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - hit.At < CacheTtlMs)
                return AppendCached(hit.OutputJson, hit.At);
            Cache.TryRemove(cacheKey, out _);
        }

        var output = engine switch
        {
            "bocha" => SearchBocha(query),
            "tavily" => SearchTavily(query),
            "anySearch" => SearchAnySearch(query),
            _ => throw new ToolHostException("E_SEARCH_ENGINE_NOT_SUPPORTED", $"E_SEARCH_ENGINE_NOT_SUPPORTED:{engine}"),
        };

        // 只有成功走到这里才写缓存：搜索函数失败时抛错，不污染缓存
        if (Cache.Count >= CacheMaxEntries) Cache.Clear(); // TS：超过容量整体清空，不搞 LRU
        Cache[cacheKey] = (output, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        return output;
    }

    // ── 博查 ────────────────────────────────────────────────

    private static string SearchBocha(string query)
    {
        var key = ToolHostConfig.WebSearchBochaKey;
        if (key.Length == 0) throw new ToolHostException("E_SEARCH_KEY_MISSING", "E_SEARCH_KEY_MISSING");
        var body = Serialize(new Dictionary<string, object?> { ["query"] = query, ["count"] = 8, ["summary"] = true });
        var (status, text) = Post("https://api.bochaai.com/v1/web-search", body, ("Authorization", "Bearer " + key));
        EnsureOk(status);

        var results = new List<Dictionary<string, object?>>();
        using (var doc = Parse(text))
        {
            var root = doc.RootElement;
            JsonElement? value = null;
            // TS：raw.data?.webPages?.value ?? raw.webPages?.value ?? []
            if (root.TryGetProperty("data", out var data) && data.ValueKind == JsonValueKind.Object
                && TryWebPagesValue(data, out var v1))
                value = v1;
            else if (TryWebPagesValue(root, out var v2))
                value = v2;

            if (value is { } arr)
            {
                foreach (var r in arr.EnumerateArray())
                {
                    var summary = Str(r, "summary");
                    var snippet = TruncateSnippet(summary.Length > 0 ? summary : Str(r, "snippet"));
                    var item = new Dictionary<string, object?>
                    {
                        ["title"] = Str(r, "name"),
                        ["url"] = Str(r, "url"),
                        ["snippet"] = snippet,
                    };
                    var siteName = Str(r, "siteName");
                    if (siteName.Length > 0) item["source"] = siteName; // TS：...(r.siteName ? {source} : {})
                    results.Add(item);
                }
            }
        }
        return OutputJson(query, results);
    }

    private static bool TryWebPagesValue(JsonElement obj, out JsonElement value)
    {
        value = default;
        if (!obj.TryGetProperty("webPages", out var wp) || wp.ValueKind != JsonValueKind.Object) return false;
        if (!wp.TryGetProperty("value", out var v) || v.ValueKind != JsonValueKind.Array) return false;
        value = v;
        return true;
    }

    // ── Tavily ──────────────────────────────────────────────

    private static string SearchTavily(string query)
    {
        var key = ToolHostConfig.WebSearchTavilyKey;
        if (key.Length == 0) throw new ToolHostException("E_SEARCH_KEY_MISSING", "E_SEARCH_KEY_MISSING");
        var body = Serialize(new Dictionary<string, object?>
        {
            ["api_key"] = key,
            ["query"] = query,
            ["max_results"] = 8,
            ["include_answer"] = true,
        });
        var (status, text) = Post("https://api.tavily.com/search", body);
        EnsureOk(status);

        var results = new List<Dictionary<string, object?>>();
        using (var doc = Parse(text))
        {
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
                throw new ToolHostException("E_SEARCH_PARSE", "搜索失败：响应不是 JSON 对象");
            var answer = Str(root, "answer");
            if (root.TryGetProperty("results", out var arr) && arr.ValueKind == JsonValueKind.Array)
            {
                foreach (var r in arr.EnumerateArray())
                {
                    var content = Str(r, "content");
                    // TS：snippet = truncateSnippet(answer && content ? `${answer}\n${content}` : content || "")
                    var snippet = TruncateSnippet(answer.Length > 0 && content.Length > 0 ? answer + "\n" + content : content);
                    results.Add(new Dictionary<string, object?>
                    {
                        ["title"] = Str(r, "title"),
                        ["url"] = Str(r, "url"),
                        ["snippet"] = snippet,
                    });
                }
            }
        }
        return OutputJson(query, results);
    }

    // ── AnySearch ───────────────────────────────────────────

    private static string SearchAnySearch(string query)
    {
        var body = Serialize(new Dictionary<string, object?> { ["query"] = query, ["max_results"] = 8 });
        var key = ToolHostConfig.WebSearchAnySearchKey;
        var (status, text) = key.Length > 0
            ? Post("https://api.anysearch.com/v1/search", body, ("Authorization", "Bearer " + key))
            : Post("https://api.anysearch.com/v1/search", body); // TS：key 可空，空则不带头
        EnsureOk(status);

        var results = new List<Dictionary<string, object?>>();
        using (var doc = Parse(text))
        {
            var root = doc.RootElement;
            // TS 直接读 data.data.results（结构缺失即抛），这里镜像为解析错误
            if (!root.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.Object
                || !data.TryGetProperty("results", out var arr) || arr.ValueKind != JsonValueKind.Array)
                throw new ToolHostException("E_SEARCH_PARSE", "搜索失败：响应缺少 data.results");
            foreach (var r in arr.EnumerateArray())
            {
                var content = Str(r, "content");
                var snippet = TruncateSnippet(content.Length > 0 ? content : Str(r, "snippet"));
                results.Add(new Dictionary<string, object?>
                {
                    ["title"] = Str(r, "title"),
                    ["url"] = Str(r, "url"),
                    ["snippet"] = snippet,
                });
            }
        }
        return OutputJson(query, results);
    }

    // ── 通用 ────────────────────────────────────────────────

    private static string OutputJson(string query, List<Dictionary<string, object?>> results)
        => Serialize(new Dictionary<string, object?>
        {
            ["success"] = true,
            ["query"] = query,
            ["resultCount"] = results.Count,
            ["results"] = results,
        });

    /// <summary>命中缓存：TS `{...hit.value, cached:true, cachedAt}` 的同构拼接（键序保持）。</summary>
    private static string AppendCached(string outputJson, long at)
    {
        var trimmed = outputJson.TrimEnd();
        if (trimmed == "{}") // 空对象特判：避免拼出 {,"cached":...} 非法 JSON
            return "{\"cached\":true,\"cachedAt\":\"" + IsoFromMs(at) + "\"}";
        if (!trimmed.EndsWith('}')) return outputJson;
        return trimmed[..^1] + ",\"cached\":true,\"cachedAt\":\"" + IsoFromMs(at) + "\"}";
    }

    private static string IsoFromMs(long unixMs)
        => DateTimeOffset.FromUnixTimeMilliseconds(unixMs).UtcDateTime
            .ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);

    /// <summary>TS truncateSnippet：空白折叠 → trim → 超 500 截断加省略号。</summary>
    private static string TruncateSnippet(string text)
    {
        var clean = Regex.Replace(text, @"\s+", " ").Trim();
        return clean.Length > MaxSnippetLen ? clean[..MaxSnippetLen] + "..." : clean;
    }

    private static string Str(JsonElement el, string key)
        => el.ValueKind == JsonValueKind.Object && el.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String
            ? v.GetString()!
            : "";

    private static (int Status, string Body) Post(string url, string json, params (string Name, string Value)[] headers)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, url)
        {
            Content = new StringContent(json, Encoding.UTF8, "application/json"),
        };
        foreach (var (name, value) in headers) request.Headers.TryAddWithoutValidation(name, value);
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(TimeoutSeconds));
        try
        {
            using var response = Http.SendAsync(request, cts.Token).GetAwaiter().GetResult();
            var body = response.Content.ReadAsStringAsync(cts.Token).GetAwaiter().GetResult();
            return ((int)response.StatusCode, body);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or OperationCanceledException)
        {
            throw new ToolHostException("E_SEARCH_NETWORK", "搜索失败：" + ex.Message);
        }
    }

    private static void EnsureOk(int status)
    {
        if (status < 200 || status > 299)
            throw new ToolHostException("E_SEARCH_HTTP", $"搜索失败：HTTP {status}");
    }

    private static JsonDocument Parse(string text)
    {
        try
        {
            return JsonDocument.Parse(text);
        }
        catch (JsonException ex)
        {
            throw new ToolHostException("E_SEARCH_PARSE", "搜索失败：" + ex.Message);
        }
    }

    private static string Serialize(object value) => JsonSerializer.Serialize(value, Json);
}

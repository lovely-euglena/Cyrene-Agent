using System.Collections.Concurrent;
using System.Globalization;
using System.Text.Json;

namespace CyreneNative.Tools;

/// <summary>
/// exchange_rate：frankfurter.app 免 key 汇率查询（与 life-tools.ts 同语义）。
///   - 30 分钟 TTL 结果缓存（进程内；host 常驻，生命周期比 TS 进程内缓存长，语义一致）
///   - 同币种直返；HTTP 非 2xx / 不支持币种返回与 TS 相同的文案
///   - 意外异常抛 ToolHostException → 错误帧 → TS 包装层回退原实现（错误语义零漂移）
/// 日期展示走 ToolHostConfig（timezone / dateLocale，config 帧注入）。
/// </summary>
internal static class ExchangeRateTool
{
    private const long CacheTtlMs = 30 * 60_000;
    private const int CacheMaxEntries = 100;
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(60) };
    private static readonly ConcurrentDictionary<string, (double Value, long At)> Cache = new();

    public static string Execute(JsonElement args)
    {
        var from = Str(args, "from", "USD").ToUpperInvariant();
        var to = Str(args, "to", "CNY").ToUpperInvariant();
        var amount = Num(args, "amount");
        if (amount == 0) amount = 1; // TS: Number(args.amount) || 1
        if (from == to)
            return $"[exchange_rate] {Fmt(amount)} {from} = {Fmt(amount)} {to}（同币种）";

        var cacheKey = from + "|" + to;
        var hit = GetCached(cacheKey);
        if (hit is not null)
        {
            // 缓存命中：用当前 amount 重算，并标注汇率获取时间（TS 同）
            var fetchedAt = DateTimeOffset.FromUnixTimeMilliseconds(hit.Value.At).ToLocalTime()
                .ToString("yyyy/M/d HH:mm:ss", CultureInfo.InvariantCulture);
            var hitResult = (amount * hit.Value.Value).ToString("0.00", CultureInfo.InvariantCulture);
            return $"[缓存] 汇率获取于 {fetchedAt}，30 分钟内复用\n"
                 + $"[exchange_rate] {Fmt(amount)} {from} = {hitResult} {to}（汇率 {Fmt(hit.Value.Value)}，更新于 {FormatDate(DateTimeOffset.Now)}）";
        }

        var url = $"https://api.frankfurter.app/latest?from={from}&to={to}";
        HttpResponseMessage resp;
        string body;
        try
        {
            resp = Http.GetAsync(url).GetAwaiter().GetResult();
            body = resp.Content.ReadAsStringAsync().GetAwaiter().GetResult();
        }
        catch (Exception ex)
        {
            // 网络异常：抛出（宿主错误帧）→ TS 包装层回退原实现，行为与原路径一致
            throw new ToolHostException("E_EXCHANGE_RATE", "汇率查询失败: " + ex.Message);
        }
        using (resp)
        {
            if (!resp.IsSuccessStatusCode) return $"[错误] 汇率查询失败：HTTP {(int)resp.StatusCode}";
        }

        double rate;
        try
        {
            using var doc = JsonDocument.Parse(body);
            if (!doc.RootElement.TryGetProperty("rates", out var rates)
                || !rates.TryGetProperty(to, out var rateEl) || rateEl.ValueKind != JsonValueKind.Number)
                return $"[exchange_rate] 查不到 {from} → {to}，可能是不支持的币种";
            rate = rateEl.GetDouble();
        }
        catch (JsonException ex)
        {
            throw new ToolHostException("E_EXCHANGE_RATE", "汇率响应解析失败: " + ex.Message);
        }

        var result = (amount * rate).ToString("0.00", CultureInfo.InvariantCulture);
        SetCached(cacheKey, rate); // 只有成功拿到汇率才写缓存；错误/不支持的币种不缓存
        return $"[exchange_rate] {Fmt(amount)} {from} = {result} {to}（汇率 {Fmt(rate)}，更新于 {FormatDate(DateTimeOffset.Now)}）";
    }

    /// <summary>TS `${number}` 语义的近似：不变文化最短往返表示。</summary>
    private static string Fmt(double value) => value.ToString(CultureInfo.InvariantCulture);

    private static string Str(JsonElement args, string key, string fallback)
        => args.TryGetProperty(key, out var el) && el.ValueKind == JsonValueKind.String && !string.IsNullOrEmpty(el.GetString())
            ? el.GetString()!
            : fallback;

    private static double Num(JsonElement args, string key)
        => args.TryGetProperty(key, out var el) && el.ValueKind == JsonValueKind.Number ? el.GetDouble() : 0;

    private static (double Value, long At)? GetCached(string key)
    {
        if (!Cache.TryGetValue(key, out var entry)) return null;
        if (DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - entry.At >= CacheTtlMs)
        {
            Cache.TryRemove(key, out _);
            return null;
        }
        return entry;
    }

    private static void SetCached(string key, double value)
    {
        if (Cache.Count >= CacheMaxEntries) Cache.Clear(); // TS：超过容量整体清空，不搞 LRU
        Cache[key] = (value, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
    }

    /// <summary>按 ToolHostConfig 的时区 + locale 输出短日期（TS toLocaleDateString 同口径）。</summary>
    private static string FormatDate(DateTimeOffset time)
    {
        DateTimeOffset local;
        try { local = TimeZoneInfo.ConvertTime(time, TimeZoneInfo.FindSystemTimeZoneById(ToolHostConfig.Timezone)); }
        catch { local = time; }
        try { return local.ToString("d", CultureInfo.GetCultureInfo(ToolHostConfig.DateLocale)); }
        catch { return local.ToString("d", CultureInfo.GetCultureInfo("zh-CN")); }
    }
}

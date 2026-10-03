using System.Collections.Concurrent;
using System.Globalization;
using System.Net.Http;
using System.Text.Encodings.Web;
using System.Text.Json;

namespace CyreneNative.Tools;

/// <summary>
/// weather：天气查询（open-meteo 免 key / 高德需 key），与 weather-tool.ts 同语义。
///   - 城市解析缓存 24h；天气结果缓存 30 分钟（命中照常发卡片 + 补 cached/cachedAt）
///   - 高德 key 经 config 帧注入（B1：仅宿主内存驻留，不落盘）
///   - weather_card 以 op:"event" 帧回传：卡片与工具结果解耦，渲染端不因缓存命中丢卡
///   - 错误文案与 TS 逐字对齐（找不到城市 / 未启用 / 未配置 key / 未知源）
/// </summary>
internal static class WeatherTool
{
    private const int TimeoutSeconds = 15;
    private const long WeatherCacheTtlMs = 30 * 60_000;
    private const long GeocodeCacheTtlMs = 24 * 60 * 60_000;
    private const int CacheMaxEntries = 100;

    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(60) };
    private static readonly JsonSerializerOptions Json = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        Converters = { new SafeDoubleJsonConverter() }, // NaN/±Infinity → null（与 TS JSON.stringify 口径对齐）
    };
    private static readonly ConcurrentDictionary<string, (string Json, long At)> OmCityCache = new();
    private static readonly ConcurrentDictionary<string, (string Json, long At)> AmapDistrictCache = new();
    private static readonly ConcurrentDictionary<string, (string DataJson, string CardJson, long At)> WeatherCache = new();

    private static readonly string[] WindDirs =
    {
        "北", "东北偏北", "东北", "东北偏东", "东", "东南偏东", "东南", "东南偏南",
        "南", "西南偏南", "西南", "西南偏西", "西", "西北偏西", "西北", "西北偏北",
    };

    public static string Execute(JsonElement args)
    {
        if (!ToolHostConfig.WeatherEnabled) return "[错误] 天气查询功能未启用，请在设置里开启";

        var source = ToolHostConfig.WeatherSource;
        var city = Str(args, "city").Trim();
        if (city.Length == 0) city = ToolHostConfig.WeatherCity.Trim();
        if (city.Length == 0)
            return "[提示] 没有指定城市，也没设置默认城市。请告诉用户：在 设置 → 我的信息 填默认城市，或直接说出要查的城市名。";

        if (source == "open-meteo") return OmFetchWeather(city);
        if (source == "amap")
        {
            var key = ToolHostConfig.WeatherAmapKey;
            if (key.Length == 0)
                return "[错误] 还没有配置高德天气 Key。请在 设置 → 插件 → 天气查询 填入高德 Key，或切换天气源为 Open-Meteo（免配置）。";
            return AmapFetchWeather(city, key);
        }
        return $"[错误] 未知的天气源\"{source}\"。请在 设置 → 插件 → 天气查询 选择 Open-Meteo 或 高德天气。";
    }

    // ── Open-Meteo（免 key 免配置）──────────────────────────

    private sealed record OmCity(string Name, double Latitude, double Longitude, string Country, string Admin1);

    private static string OmFetchWeather(string city)
    {
        var cacheKey = "open-meteo|" + city;
        if (WeatherCache.TryGetValue(cacheKey, out var hit) && DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - hit.At < WeatherCacheTtlMs)
        {
            ToolHost.EmitEvent("weather_card", ParseElement(hit.CardJson));
            return AppendCached(hit.DataJson, hit.At);
        }

        var loc = OmResolveCity(city);
        if (loc is null) return $"[错误] 找不到城市\"{city}\"，请确认城市名（支持中文/拼音）。";
        var adm = loc.Admin1.Length > 0 ? loc.Admin1 : loc.Country;

        const string currentParams =
            "temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,wind_direction_10m,surface_pressure,uv_index,visibility";
        const string dailyParams =
            "temperature_2m_max,temperature_2m_min,weather_code,wind_speed_10m_max,wind_direction_10m_dominant";
        var url = $"https://api.open-meteo.com/v1/forecast?latitude={HostLocale.Fmt(loc.Latitude)}&longitude={HostLocale.Fmt(loc.Longitude)}&current={currentParams}&daily={dailyParams}&timezone=auto";

        var (status, body) = Get(url);
        if (status != 200) return $"[错误] 天气查询失败：HTTP {status}";

        try
        {
            using var doc = JsonDocument.Parse(body);
            var root = doc.RootElement;
            if (!root.TryGetProperty("current", out var c) || c.ValueKind != JsonValueKind.Object)
                return "[错误] 天气查询失败：Open-Meteo 未返回数据";

            var code = Num(c, "weather_code");
            var pressureRaw = Num(c, "surface_pressure");
            var pressure = double.IsFinite(pressureRaw) ? HostLocale.JsRound(pressureRaw) : double.NaN;
            var temperature = Num(c, "temperature_2m");
            var feelsLike = Num(c, "apparent_temperature");
            var humidity = Num(c, "relative_humidity_2m");
            var windDeg = Num(c, "wind_direction_10m");
            var windSpeed = Num(c, "wind_speed_10m");
            var precipitation = Num(c, "precipitation");
            var visibilityRaw = Num(c, "visibility");
            var visibility = double.IsFinite(visibilityRaw) ? HostLocale.JsRound(visibilityRaw / 1000) : double.NaN;

            var data = new Dictionary<string, object?>
            {
                ["city"] = loc.Name,
                ["region"] = adm,
                ["weather"] = WmoText(code),
                ["temperature"] = temperature,
                ["feelsLike"] = feelsLike,
                ["humidity"] = humidity,
                ["windDirection"] = OmWindDir(windDeg),
                ["windSpeed"] = HostLocale.Fmt(windSpeed) + "km/h",
                ["precipitation"] = precipitation,
                ["pressure"] = pressure,
                ["uv"] = Num(c, "uv_index"),
                ["visibility"] = visibility,
                ["source"] = "Open-Meteo",
                ["updateTime"] = HostLocale.FormatTimeShort(DateTimeOffset.Now),
            };
            // 卡片数据随缓存一起保存：命中时照常回调，天气卡片不因缓存消失
            var card = new Dictionary<string, object?>
            {
                ["source"] = "open-meteo",
                ["location"] = new Dictionary<string, object?> { ["province"] = adm, ["city"] = loc.Name },
                ["weatherCode"] = code,
                ["temp"] = temperature,
                ["feelsLike"] = feelsLike,
                ["humidity"] = humidity,
                ["windDeg"] = windDeg,
                ["windSpeed"] = windSpeed,
                ["precipitation"] = precipitation,
                ["pressure"] = pressure,
            };
            var dataJson = JsonSerializer.Serialize(data, Json);
            var cardJson = JsonSerializer.Serialize(card, Json);
            SetWeatherCache(cacheKey, dataJson, cardJson);
            ToolHost.EmitEvent("weather_card", card);
            return dataJson;
        }
        catch (JsonException ex)
        {
            return "[错误] 天气查询失败：" + ex.Message;
        }
    }

    private static OmCity? OmResolveCity(string city)
    {
        var cacheKey = city + "|" + ToolHostConfig.WeatherLanguage;
        if (OmCityCache.TryGetValue(cacheKey, out var hit) && DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - hit.At < GeocodeCacheTtlMs)
            return DeserializeCity(hit.Json);

        var url = "https://geocoding-api.open-meteo.com/v1/search?name=" + Uri.EscapeDataString(city)
            + "&count=1&language=" + Uri.EscapeDataString(ToolHostConfig.WeatherLanguage) + "&format=json";
        int status;
        string body;
        try
        {
            (status, body) = Get(url);
        }
        catch (ToolHostException)
        {
            // 网络失败与"找不到城市"同路径：不上报差异（TS 同语义）
            return null;
        }
        if (status != 200) return null;

        try
        {
            using var doc = JsonDocument.Parse(body);
            if (!doc.RootElement.TryGetProperty("results", out var results) || results.ValueKind != JsonValueKind.Array
                || results.GetArrayLength() == 0)
                return null;
            var first = results[0];
            var resolved = new OmCity(
                Str(first, "name"),
                Num(first, "latitude"),
                Num(first, "longitude"),
                Str(first, "country"),
                Str(first, "admin1"));
            if (OmCityCache.Count >= CacheMaxEntries) OmCityCache.Clear();
            // 契约：与 DeserializeCity 配对——序列化不启用 PropertyNamingPolicy，属性名保持 PascalCase
            OmCityCache[cacheKey] = (JsonSerializer.Serialize(resolved, Json), DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            return resolved;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    /// <summary>契约：与 OmResolveCity 的缓存序列化配对，均不使用 PropertyNamingPolicy（PascalCase 属性名），改契约须两侧同步。</summary>
    private static OmCity? DeserializeCity(string json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            var el = doc.RootElement;
            return new OmCity(Str(el, "Name"), Num(el, "Latitude"), Num(el, "Longitude"), Str(el, "Country"), Str(el, "Admin1"));
        }
        catch (JsonException)
        {
            return null;
        }
    }

    // ── 高德（需 key）──────────────────────────────────────

    private static string AmapFetchWeather(string city, string key)
    {
        var cacheKey = "amap|" + city;
        if (WeatherCache.TryGetValue(cacheKey, out var hit) && DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - hit.At < WeatherCacheTtlMs)
        {
            ToolHost.EmitEvent("weather_card", ParseElement(hit.CardJson));
            return AppendCached(hit.DataJson, hit.At);
        }

        var adcode = AmapResolveAdcode(city, key);
        if (adcode is null) return $"[错误] 找不到城市\"{city}\"，请确认城市名（支持中文，如\"无锡\"）。";

        var url = $"https://restapi.amap.com/v3/weather/weatherInfo?city={Uri.EscapeDataString(adcode)}&key={Uri.EscapeDataString(key)}&extensions=base";
        var (status, body) = Get(url);
        if (status != 200) return $"[错误] 天气查询失败：HTTP {status}";

        try
        {
            using var doc = JsonDocument.Parse(body);
            var root = doc.RootElement;
            var amapStatus = Str(root, "status");
            if (amapStatus != "1" || !root.TryGetProperty("lives", out var lives) || lives.ValueKind != JsonValueKind.Array
                || lives.GetArrayLength() == 0)
            {
                return $"[错误] 天气查询失败：高德返回 status={(amapStatus.Length > 0 ? amapStatus : "?")}";
            }
            var w = lives[0];
            var province = Str(w, "province");
            var cityName = Str(w, "city");
            var reporttime = Str(w, "reporttime");
            var updateTime = reporttime.Length >= 16 ? reporttime[11..16] : HostLocale.FormatTimeShort(DateTimeOffset.Now);

            var data = new Dictionary<string, object?>
            {
                ["city"] = cityName,
                ["region"] = province,
                ["weather"] = Str(w, "weather"),
                ["temperature"] = Num(w, "temperature"),
                ["humidity"] = Num(w, "humidity"),
                ["windDirection"] = Str(w, "winddirection"),
                ["windSpeed"] = Str(w, "windpower") + "级",
                ["source"] = "高德天气",
                ["updateTime"] = updateTime,
            };
            var card = new Dictionary<string, object?>
            {
                ["source"] = "amap",
                ["location"] = new Dictionary<string, object?> { ["province"] = province, ["city"] = cityName },
                ["weather"] = Str(w, "weather"),
                ["temp"] = Num(w, "temperature"),
                ["humidity"] = Num(w, "humidity"),
                ["windDirection"] = Str(w, "winddirection"),
                ["windPower"] = Str(w, "windpower"),
                ["reporttime"] = reporttime,
            };
            var dataJson = JsonSerializer.Serialize(data, Json);
            var cardJson = JsonSerializer.Serialize(card, Json);
            SetWeatherCache(cacheKey, dataJson, cardJson);
            ToolHost.EmitEvent("weather_card", card);
            return dataJson;
        }
        catch (JsonException ex)
        {
            return "[错误] 天气查询失败：" + ex.Message;
        }
    }

    private static string? AmapResolveAdcode(string city, string key)
    {
        if (AmapDistrictCache.TryGetValue(city, out var hit)
            && DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - hit.At < GeocodeCacheTtlMs)
            return Str(ParseElement(hit.Json), "adcode");

        var url = "https://restapi.amap.com/v3/config/district?keywords=" + Uri.EscapeDataString(city)
            + "&subdistrict=0&key=" + Uri.EscapeDataString(key);
        int status;
        string body;
        try
        {
            (status, body) = Get(url);
        }
        catch (ToolHostException)
        {
            return null;
        }
        if (status != 200) return null;

        try
        {
            using var doc = JsonDocument.Parse(body);
            var root = doc.RootElement;
            if (Str(root, "status") != "1" || !root.TryGetProperty("districts", out var districts)
                || districts.ValueKind != JsonValueKind.Array || districts.GetArrayLength() == 0)
                return null;
            var first = districts[0];
            var adcode = Str(first, "adcode");
            if (AmapDistrictCache.Count >= CacheMaxEntries) AmapDistrictCache.Clear();
            AmapDistrictCache[city] = (JsonSerializer.Serialize(new Dictionary<string, object?> { ["adcode"] = adcode }, Json),
                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            return adcode.Length > 0 ? adcode : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    // ── 基础 ────────────────────────────────────────────────

    private static (int Status, string Body) Get(string url)
    {
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(TimeoutSeconds));
        try
        {
            using var response = Http.GetAsync(url, cts.Token).GetAwaiter().GetResult();
            var body = response.Content.ReadAsStringAsync(cts.Token).GetAwaiter().GetResult();
            return ((int)response.StatusCode, body);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or OperationCanceledException)
        {
            // 网络层失败抛错误帧 → TS 包装层回退原实现（错误语义零漂移）
            throw new ToolHostException("E_WEATHER_NETWORK", ex.Message);
        }
    }

    private static void SetWeatherCache(string key, string dataJson, string cardJson)
    {
        if (WeatherCache.Count >= CacheMaxEntries) WeatherCache.Clear();
        WeatherCache[key] = (dataJson, cardJson, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
    }

    /// <summary>命中缓存：TS `{...data, cached:true, cachedAt}` 的同构拼接（键序保持）。</summary>
    private static string AppendCached(string dataJson, long at)
    {
        var trimmed = dataJson.TrimEnd();
        if (trimmed == "{}") // 空对象特判：避免拼出 {,"cached":...} 非法 JSON
            return "{\"cached\":true,\"cachedAt\":\"" + IsoFromMs(at) + "\"}";
        if (!trimmed.EndsWith('}')) return dataJson;
        return trimmed[..^1] + ",\"cached\":true,\"cachedAt\":\"" + IsoFromMs(at) + "\"}";
    }

    private static string IsoFromMs(long unixMs)
        => DateTimeOffset.FromUnixTimeMilliseconds(unixMs).UtcDateTime
            .ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);

    private static JsonElement ParseElement(string json)
    {
        using var doc = JsonDocument.Parse(json);
        return doc.RootElement.Clone();
    }

    private static string Str(JsonElement el, string key)
        => el.ValueKind == JsonValueKind.Object && el.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String
            ? v.GetString()!
            : "";

    private static double Num(JsonElement el, string key)
        => el.ValueKind == JsonValueKind.Object && el.TryGetProperty(key, out var v) ? HostLocale.Num(v) : double.NaN;

    private static string OmWindDir(double deg)
    {
        if (!double.IsFinite(deg)) return "未知";
        var idx = (int)(HostLocale.JsRound(deg / 22.5) % 16);
        return WindDirs[idx < 0 ? idx + 16 : idx];
    }

    /// <summary>缺失（NaN）时的宽松兜底：避免 (int)NaN 的未定义值。</summary>
    private static string WmoText(double code)
        => double.IsFinite(code) ? WmoText((int)code) : "未知（代码NaN）";

    private static string WmoText(int code) => code switch
    {
        0 => "晴", 1 => "晴间多云", 2 => "多云", 3 => "阴",
        45 => "雾", 48 => "雾凇",
        51 => "小雨", 53 => "中雨", 55 => "大雨",
        56 => "冻雨", 57 => "强冻雨",
        61 => "小雨", 63 => "中雨", 65 => "大雨",
        66 => "冻雨", 67 => "强冻雨",
        71 => "小雪", 73 => "中雪", 75 => "大雪",
        77 => "雪粒",
        80 => "阵雨", 81 => "强阵雨", 82 => "暴雨",
        85 => "阵雪", 86 => "强阵雪",
        95 => "雷暴", 96 => "雷暴伴冰雹", 99 => "强雷暴伴冰雹",
        _ => $"未知（代码{code}）",
    };
}

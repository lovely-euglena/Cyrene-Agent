using System.Globalization;
using System.Net.Http;
using System.Text.Json;

namespace CyreneNative.Tools;

/// <summary>
/// plan_trip：高德路线规划（驾车/步行/骑行/公交），与 travel-tools.ts 同语义。
///   - amapKey 经 config 帧注入（B1：仅宿主内存驻留，不落盘）
///   - HTTP 15s 超时；网络层失败上抛错误帧（E_TRAVEL_NETWORK → TS 回退），
///     解析失败/未找到路线按 TS 同文案返回（结果字符串）
/// </summary>
internal static class TravelTool
{
    private const int TimeoutSeconds = 15;
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(60) };

    public static string Execute(JsonElement args)
    {
        if (!ToolHostConfig.TravelEnabled) return "[错误] 出行工具未启用，请在设置里开启";

        var amapKey = ToolHostConfig.TravelAmapKey;
        if (amapKey.Length == 0)
            return "[提示] 高德 API Key 未配置。可在 设置→插件 中找到 🚗出行工具，填入高德 Web 服务 API Key（注册地址：https://lbs.amap.com）。";

        var origin = Str(args, "origin").Trim();
        var destination = Str(args, "destination").Trim();
        if (origin.Length == 0 || destination.Length == 0) return "[错误] 请提供起点和终点";

        var mode = JsString(args, "mode", "驾车").Trim();

        // 地理编码：地名 → 坐标
        var origLoc = Geocode(origin, amapKey);
        var destLoc = Geocode(destination, amapKey);
        if (origLoc is null) return $"[错误] 无法解析起点「{origin}」的位置，请尝试更具体的名称";
        if (destLoc is null) return $"[错误] 无法解析终点「{destination}」的位置，请尝试更具体的名称";

        switch (mode)
        {
            case "驾车":
            case "开车":
                return PlanDriving(origLoc, destLoc, amapKey);
            case "步行":
            case "走路":
                return PlanWalking(origLoc, destLoc, amapKey);
            case "骑行":
            case "骑车":
            case "自行车":
                return PlanCycling(origLoc, destLoc, amapKey);
            case "公交":
            case "公共交通":
            case "地铁":
            case "公交地铁":
            {
                var city = Str(args, "city").Trim();
                if (city.Length == 0) return "[错误] 公交路线必须提供城市（参数 city），例如 city='北京'";
                return PlanTransit(origLoc, destLoc, city, amapKey);
            }
            default:
                return $"[错误] 不支持的出行方式「{mode}」。支持：驾车、步行、骑行、公交";
        }
    }

    /// <summary>驾车路径规划。</summary>
    private static string PlanDriving(string origin, string destination, string key)
    {
        var url = $"https://restapi.amap.com/v3/direction/driving?origin={Uri.EscapeDataString(origin)}&destination={Uri.EscapeDataString(destination)}&extensions=base&strategy=0&key={Uri.EscapeDataString(key)}";
        try
        {
            var (status, body) = Get(url);
            if (status != 200) return $"[错误] 驾车路线查询失败：HTTP {status}";
            using var doc = JsonDocument.Parse(body);
            if (!TryFirstPath(doc.RootElement, out var path)) return "[错误] 未找到驾车路线";
            var distKm = Fixed(Num(path, "distance") / 1000, 1);
            var durMin = HostLocale.JsRound(Num(path, "duration") / 60);
            var toll = Num(path, "tolls");
            var lights = Str(path, "traffic_lights");
            var lines = new List<string>
            {
                "🚗 驾车路线",
                $"距离：{distKm} 公里",
                $"预计用时：{durMin} 分钟",
                toll > 0 ? $"路费：{Fixed(toll, 0)} 元" : "路费：免费",
                $"红绿灯：{(lights.Length > 0 ? lights : "0")} 个",
            };
            return string.Join("\n", lines);
        }
        catch (ToolHostException)
        {
            // 网络层失败上抛错误帧 → TS 包装层回退原实现（与 weather/web_search 同策略）
            throw;
        }
        catch (Exception ex)
        {
            return "[错误] 驾车路线查询失败：" + ex.Message;
        }
    }

    /// <summary>步行路径规划（最长 100km）。</summary>
    private static string PlanWalking(string origin, string destination, string key)
    {
        var url = $"https://restapi.amap.com/v3/direction/walking?origin={Uri.EscapeDataString(origin)}&destination={Uri.EscapeDataString(destination)}&key={Uri.EscapeDataString(key)}";
        try
        {
            var (status, body) = Get(url);
            if (status != 200) return $"[错误] 步行路线查询失败：HTTP {status}";
            using var doc = JsonDocument.Parse(body);
            if (!TryFirstPath(doc.RootElement, out var path)) return "[错误] 未找到步行路线";
            var distM = Num(path, "distance");
            var durMin = HostLocale.JsRound(Num(path, "duration") / 60);
            var distStr = distM >= 1000 ? Fixed(distM / 1000, 1) + " 公里" : Fixed(distM, 0) + " 米";
            return string.Join("\n", new[] { "🚶 步行路线", $"距离：{distStr}", $"预计用时：{durMin} 分钟" });
        }
        catch (ToolHostException)
        {
            // 网络层失败上抛错误帧 → TS 包装层回退原实现（与 weather/web_search 同策略）
            throw;
        }
        catch (Exception ex)
        {
            return "[错误] 步行路线查询失败：" + ex.Message;
        }
    }

    /// <summary>骑行路径规划（最长 500km）。</summary>
    private static string PlanCycling(string origin, string destination, string key)
    {
        var url = $"https://restapi.amap.com/v4/direction/bicycling?origin={Uri.EscapeDataString(origin)}&destination={Uri.EscapeDataString(destination)}&key={Uri.EscapeDataString(key)}";
        try
        {
            var (status, body) = Get(url);
            if (status != 200) return $"[错误] 骑行路线查询失败：HTTP {status}";
            using var doc = JsonDocument.Parse(body);
            var root = doc.RootElement;
            if (!root.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.Object
                || !data.TryGetProperty("paths", out var paths) || paths.ValueKind != JsonValueKind.Array || paths.GetArrayLength() == 0)
                return "[错误] 未找到骑行路线";
            var path = paths[0];
            var distKm = Fixed(Num(path, "distance") / 1000, 1);
            var durMin = HostLocale.JsRound(Num(path, "duration") / 60);
            return string.Join("\n", new[] { "🚲 骑行路线", $"距离：{distKm} 公里", $"预计用时：{durMin} 分钟" });
        }
        catch (ToolHostException)
        {
            // 网络层失败上抛错误帧 → TS 包装层回退原实现（与 weather/web_search 同策略）
            throw;
        }
        catch (Exception ex)
        {
            return "[错误] 骑行路线查询失败：" + ex.Message;
        }
    }

    /// <summary>公交路径规划（支持公交/地铁/火车综合换乘）。</summary>
    private static string PlanTransit(string origin, string destination, string city, string key)
    {
        var url = "https://restapi.amap.com/v3/direction/transit/integrated"
            + $"?origin={Uri.EscapeDataString(origin)}&destination={Uri.EscapeDataString(destination)}&city={Uri.EscapeDataString(city)}&strategy=0&extensions=base&key={Uri.EscapeDataString(key)}";
        try
        {
            var (status, body) = Get(url);
            if (status != 200) return $"[错误] 公交路线查询失败：HTTP {status}";
            using var doc = JsonDocument.Parse(body);
            var root = doc.RootElement;
            if (!root.TryGetProperty("route", out var route) || route.ValueKind != JsonValueKind.Object
                || !route.TryGetProperty("transits", out var transits) || transits.ValueKind != JsonValueKind.Array || transits.GetArrayLength() == 0)
                return "[错误] 未找到公交路线";
            var transit = transits[0];
            var durMin = HostLocale.JsRound(Num(transit, "duration") / 60);
            var price = Fixed(Num(transit, "cost"), 0);
            var walkDist = Num(transit, "walking_distance");
            var walkStr = walkDist > 0 ? $"（步行 {Fixed(walkDist, 0)} 米）" : "";

            // 提取换乘方案简述（空步骤与 TS 一样被过滤，但序号保持原 segment 序号）
            var steps = new List<string>();
            if (transit.TryGetProperty("segments", out var segments) && segments.ValueKind == JsonValueKind.Array)
            {
                var idx = 0;
                foreach (var seg in segments.EnumerateArray())
                {
                    idx++;
                    if (seg.TryGetProperty("bus", out var bus) && bus.ValueKind == JsonValueKind.Object
                        && bus.TryGetProperty("buslines", out var buslines) && buslines.ValueKind == JsonValueKind.Array
                        && buslines.GetArrayLength() > 0)
                    {
                        var line = buslines[0];
                        var depart = line.TryGetProperty("depart_stop", out var ds) && ds.ValueKind == JsonValueKind.Object ? Str(ds, "name") : "";
                        var arrive = line.TryGetProperty("arrival_stop", out var arr) && arr.ValueKind == JsonValueKind.Object ? Str(arr, "name") : "";
                        steps.Add($"  {idx}. 乘 {Str(line, "name")}：{depart} → {arrive}");
                    }
                    else if (seg.TryGetProperty("walking", out var walking) && walking.ValueKind == JsonValueKind.Object)
                    {
                        steps.Add($"  {idx}. 步行 {Fixed(Num(walking, "distance"), 0)} 米");
                    }
                }
            }

            var lines = new List<string>
            {
                "🚌 公交路线",
                $"预计用时：{durMin} 分钟",
                $"票价：{price} 元{walkStr}",
            };
            var taxiCost = Str(route, "taxi_cost");
            if (taxiCost.Length > 0) lines.Add($"打车参考价：{taxiCost} 元");
            if (steps.Count > 0)
            {
                lines.Add("换乘方案：");
                lines.AddRange(steps);
            }
            return string.Join("\n", lines);
        }
        catch (ToolHostException)
        {
            // 网络层失败上抛错误帧 → TS 包装层回退原实现（与 weather/web_search 同策略）
            throw;
        }
        catch (Exception ex)
        {
            return "[错误] 公交路线查询失败：" + ex.Message;
        }
    }

    // ── 基础 ────────────────────────────────────────────────

    /// <summary>高德地理编码：地名 → "经度,纬度"；失败/解析异常 → null（TS 同）。</summary>
    private static string? Geocode(string address, string key)
    {
        var url = $"https://restapi.amap.com/v3/geocode/geo?address={Uri.EscapeDataString(address)}&output=JSON&key={Uri.EscapeDataString(key)}";
        try
        {
            var (status, body) = Get(url);
            if (status != 200) return null;
            using var doc = JsonDocument.Parse(body);
            var root = doc.RootElement;
            if (Str(root, "status") != "1" || !root.TryGetProperty("geocodes", out var geos)
                || geos.ValueKind != JsonValueKind.Array || geos.GetArrayLength() == 0)
                return null;
            return Str(geos[0], "location");
        }
        catch (ToolHostException)
        {
            // 网络层失败上抛错误帧 → TS 包装层回退原实现（与 weather/web_search 同策略）
            throw;
        }
        catch
        {
            return null;
        }
    }

    private static bool TryFirstPath(JsonElement root, out JsonElement path)
    {
        path = default;
        if (!root.TryGetProperty("route", out var route) || route.ValueKind != JsonValueKind.Object) return false;
        if (!route.TryGetProperty("paths", out var paths) || paths.ValueKind != JsonValueKind.Array || paths.GetArrayLength() == 0) return false;
        path = paths[0];
        return true;
    }

    private static (int Status, string Body) Get(string url)
    {
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(TimeoutSeconds));
        try
        {
            using var response = Http.SendAsync(new HttpRequestMessage(HttpMethod.Get, url), cts.Token).GetAwaiter().GetResult();
            var body = response.Content.ReadAsStringAsync(cts.Token).GetAwaiter().GetResult();
            return ((int)response.StatusCode, body);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or OperationCanceledException)
        {
            throw new ToolHostException("E_TRAVEL_NETWORK", ex.Message);
        }
    }

    /// <summary>
    /// JS <c>Number.prototype.toFixed</c> 近似：平局（tie）向 +∞ 取整——JS 规范为「距离相等时取较大 n」，
    /// 本项目非负的距离/路费场景下与 AwayFromZero 等价；若不指定舍入模式，.NET <c>F</c> 格式默认
    /// 银行家舍入（ToEven），会出现 2.25 → "2.2" 这类与 JS 相反的平局结果。极端浮点边界仍有 1ulp 级差异。
    /// </summary>
    private static string Fixed(double value, int digits)
        => Math.Round(value, digits, MidpointRounding.ToPositiveInfinity)
            .ToString("F" + digits.ToString(CultureInfo.InvariantCulture), CultureInfo.InvariantCulture);

    /// <summary>`String(args.mode ?? "驾车")` 近似：属性缺失用 fallback；字符串原样（含空串）；其余按显示口径。</summary>
    private static string JsString(JsonElement args, string key, string fallback)
    {
        if (args.ValueKind != JsonValueKind.Object || !args.TryGetProperty(key, out var v)) return fallback;
        return v.ValueKind switch
        {
            JsonValueKind.String => v.GetString()!,
            JsonValueKind.Number => HostLocale.Fmt(v.GetDouble()),
            JsonValueKind.True => "true",
            JsonValueKind.False => "false",
            JsonValueKind.Null => "null",
            _ => "",
        };
    }

    private static string Str(JsonElement el, string key)
        => el.ValueKind == JsonValueKind.Object && el.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String
            ? v.GetString()!
            : "";

    private static double Num(JsonElement el, string key)
        => el.ValueKind == JsonValueKind.Object && el.TryGetProperty(key, out var v) ? HostLocale.Num(v) : double.NaN;
}

using System.Text.Json;

namespace CyreneNative.Tools;

/// <summary>now：时区感知当前时间。宿主 config 帧注入用户时区（ToolHostConfig）。</summary>
internal static class NowTool
{
    public static object Execute(JsonElement? args)
    {
        var tz = ToolHostConfig.Timezone;
        if (string.IsNullOrEmpty(tz)) tz = "Asia/Shanghai";
        var format = args?.TryGetProperty("format", out var f) == true ? f.GetString() : "default";
        var now = DateTimeOffset.Now;
        return format switch
        {
            "epoch" => now.ToUnixTimeMilliseconds().ToString(),
            "iso" => now.ToString("O"),
            _ => HumanReadable(now, tz),
        };
    }

    private static object HumanReadable(DateTimeOffset now, string tz)
    {
        string local;
        try { local = TimeZoneInfo.ConvertTime(now, TimeZoneInfo.FindSystemTimeZoneById(tz)).ToString("yyyy-MM-dd dddd HH:mm:ss"); }
        catch { local = now.ToString("yyyy-MM-dd dddd HH:mm:ss"); }
        return $"{local}（时区 {tz}）\n{JsonSerializer.Serialize(new { now = now.ToUnixTimeMilliseconds(), iso = now.ToString("O"), timezone = tz })}";
    }
}

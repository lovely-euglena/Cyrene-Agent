using System.Globalization;
using System.Text.Json;

namespace CyreneNative.Tools;

/// <summary>
/// TS ↔ C# 展示口径助手：数字/日期格式化与 JS truthy 判定。
/// 目标是与 TS 侧模板字符串 / toLocale* 输出逐字一致（双轨等价验收）。
/// 时区与 locale 来自 ToolHostConfig（config 帧注入）。
/// </summary>
internal static class HostLocale
{
    /// <summary>TS `${number}` 语义的近似：不变文化最短往返表示。</summary>
    public static string Fmt(double value) => value.ToString(CultureInfo.InvariantCulture);

    /// <summary>TS toLocaleDateString(dateLocale, { timeZone }) 近似（短日期）。</summary>
    public static string FormatDate(DateTimeOffset time)
    {
        DateTimeOffset local;
        try { local = TimeZoneInfo.ConvertTime(time, TimeZoneInfo.FindSystemTimeZoneById(ToolHostConfig.Timezone)); }
        catch { local = time; }
        try { return local.ToString("d", CultureInfo.GetCultureInfo(ToolHostConfig.DateLocale)); }
        catch { return local.ToString("d", CultureInfo.GetCultureInfo("zh-CN")); }
    }

    /// <summary>TS toLocaleString("zh-CN", { hour12: false }) 近似（系统本地时区）。</summary>
    public static string FormatDateTimeLocal(long epochMs)
        => DateTimeOffset.FromUnixTimeMilliseconds(epochMs).ToLocalTime()
            .ToString("yyyy/M/d HH:mm:ss", CultureInfo.InvariantCulture);

    /// <summary>JS truthy 判定（true / 非 0 数字 / 非空字符串）。</summary>
    public static bool Truthy(JsonElement el) => el.ValueKind switch
    {
        JsonValueKind.True => true,
        JsonValueKind.Number => el.GetDouble() != 0,
        JsonValueKind.String => el.GetString() is { Length: > 0 },
        _ => false,
    };
}

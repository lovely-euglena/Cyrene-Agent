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
    /// <summary>TS `${number}` 语义的近似：不变文化最短往返表示。
    /// 适用域：0.0001 ≤ |v| &lt; 1e17 的常规金额/天数范围与 JS 一致；范围外 .NET 默认
    /// "G" 格式比 JS 更早进入 E 记法且风格不同（1e-5 → 1E-05 vs 0.00001；
    /// 1e17 → 1E+17 vs 100000000000000000），业务入参不会触及。</summary>
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

    /// <summary>JS Math.round 语义（.5 向上取整，与 TS 显示口径一致）。</summary>
    public static long JsRound(double value) => (long)Math.Floor(value + 0.5);

    /// <summary>TS toLocaleString(dateLocale, { hour:"2-digit", minute:"2-digit", timeZone }) 近似
    /// （小时:分钟；24 小时制 locale 输出 HH:mm，12 小时制输出 h:mm tt）。</summary>
    public static string FormatTimeShort(DateTimeOffset time)
    {
        DateTimeOffset local;
        try { local = TimeZoneInfo.ConvertTime(time, TimeZoneInfo.FindSystemTimeZoneById(ToolHostConfig.Timezone)); }
        catch { local = time; }
        try
        {
            var culture = CultureInfo.GetCultureInfo(ToolHostConfig.DateLocale);
            return culture.DateTimeFormat.ShortTimePattern.Contains("tt", StringComparison.OrdinalIgnoreCase)
                ? local.ToString("h:mm tt", culture)
                : local.ToString("HH:mm", culture);
        }
        catch
        {
            return local.ToString("HH:mm", CultureInfo.InvariantCulture);
        }
    }

    /// <summary>JS Number(value) 语义近似：number 原样；string 按不变文化解析
    /// （失败 NaN）；true/false/null → 1/0/0；其余 NaN。
    /// 调用方按 TS `||` / Number.isFinite 口径兜底（模型偶发把数字写成字符串）。</summary>
    public static double Num(JsonElement el) => el.ValueKind switch
    {
        JsonValueKind.Number => el.GetDouble(),
        JsonValueKind.String => double.TryParse(el.GetString(), NumberStyles.Float, CultureInfo.InvariantCulture, out var v)
            ? v
            : double.NaN,
        JsonValueKind.True => 1,
        JsonValueKind.False => 0,
        JsonValueKind.Null => 0,
        _ => double.NaN,
    };

    /// <summary>JS truthy 判定（true / 非 0 数字 / 非空字符串）。</summary>
    public static bool Truthy(JsonElement el) => el.ValueKind switch
    {
        JsonValueKind.True => true,
        JsonValueKind.Number => el.GetDouble() != 0,
        JsonValueKind.String => el.GetString() is { Length: > 0 },
        _ => false,
    };
}

using System.Text.Json;

namespace CyreneNative.Channels;

/// <summary>JSON 取值助手：镜像 JS 侧 `String(x ?? "")` / `typeof x === "string"` 等常用语义。</summary>
public static class ChannelJsonValue
{
    /// <summary>JS `String(value ?? "")`（string/number/bool；其余类型返回空串）。</summary>
    public static string StringOrEmpty(JsonElement parent, string name)
    {
        if (!parent.TryGetProperty(name, out var value)) return "";
        return value.ValueKind switch
        {
            JsonValueKind.String => value.GetString() ?? "",
            JsonValueKind.Number => value.GetRawText(),
            JsonValueKind.True => "true",
            JsonValueKind.False => "false",
            _ => "",
        };
    }

    /// <summary>
    /// JS `String(value ?? "")` 全语义：string 原样、number/bool 字面量、数组逗号连接、
    /// 对象 "[object Object]"、null/缺省空串（飞书 text 兜底等畸形输入对齐 TS 用）。
    /// </summary>
    public static string JsStringOrEmpty(JsonElement parent, string name)
    {
        if (!parent.TryGetProperty(name, out var value)) return "";
        return JsString(value);
    }

    private static string JsString(JsonElement value) => value.ValueKind switch
    {
        JsonValueKind.String => value.GetString() ?? "",
        JsonValueKind.Number => value.GetRawText(),
        JsonValueKind.True => "true",
        JsonValueKind.False => "false",
        JsonValueKind.Array => string.Join(",", value.EnumerateArray().Select(JsString)),
        JsonValueKind.Object => "[object Object]",
        _ => "",
    };

    /// <summary>JS `typeof x === "string" ? x : undefined`。</summary>
    public static string? OptionalString(JsonElement parent, string name) =>
        parent.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    /// <summary>数字（含整型）；非数字返回 null。</summary>
    public static double? NumberOrNull(JsonElement parent, string name)
    {
        if (!parent.TryGetProperty(name, out var value) || value.ValueKind != JsonValueKind.Number) return null;
        return value.TryGetDouble(out var number) ? number : null;
    }

    /// <summary>Unix 毫秒 → DateTimeOffset（UTC）。</summary>
    public static DateTimeOffset FromUnixTimeMilliseconds(double milliseconds) =>
        DateTimeOffset.FromUnixTimeMilliseconds((long)milliseconds);

    /// <summary>
    /// Unix 毫秒 → DateTimeOffset（UTC），带范围收口：非有限值或超出 DateTimeOffset 可表示范围
    /// （如 19 位毫秒数）返回 null，由调用方回退 now——避免 (long) 溢出后
    /// FromUnixTimeMilliseconds 抛 ArgumentOutOfRangeException 丢整条事件（P2-1 飞书/微信同口径）。
    /// 残余双端差异：TS new Date 可表示范围为 ±8.64e15，越界为 Invalid Date（契约序列化 null）；
    /// 未越界但年份 &gt;9999 时 TS 输出 5 位年份 ISO。见 fixtures/channels/README.md「已知超纲差异」。
    /// </summary>
    public static DateTimeOffset? TryFromUnixTimeMilliseconds(double? milliseconds)
    {
        if (milliseconds is not { } value || !double.IsFinite(value)) return null;
        var truncated = Math.Truncate(value);
        if (truncated < DateTimeOffset.MinValue.ToUnixTimeMilliseconds()
            || truncated > DateTimeOffset.MaxValue.ToUnixTimeMilliseconds())
        {
            return null;
        }
        return FromUnixTimeMilliseconds(truncated);
    }
}

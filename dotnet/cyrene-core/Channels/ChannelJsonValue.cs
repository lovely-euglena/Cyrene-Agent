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
}

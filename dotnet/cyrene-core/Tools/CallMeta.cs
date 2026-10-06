using System.Text.Json;

namespace CyreneNative.Tools;

/// <summary>
/// call 帧 meta 元数据读取（IKJLP4：内部参数协议字段化）。
///
/// 内部参数不再经 args 的 `__` 键传递——只从 call 帧独立 meta 字段读取；
/// args 里的 `__` 旧键一律不认（明确不保留）。meta 仅由主进程可信装配
/// （TS nativeFirst / withNativeFirst / 直连调用方），模型不可见。
/// 缺失字段按各工具既有的前置条件错误处理（如 E_*_NO_ROOT）。
/// </summary>
internal static class CallMeta
{
    /// <summary>读取字符串字段（缺失 / 非字符串 → 空串）。</summary>
    public static string Str(JsonElement meta, string key)
        => meta.ValueKind == JsonValueKind.Object && meta.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()!
            : "";

    /// <summary>true 判定（仅 JsonValueKind.True 为真）。</summary>
    public static bool IsTrue(JsonElement meta, string key)
        => meta.ValueKind == JsonValueKind.Object && meta.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.True;

    /// <summary>读取对象字段（如 gitIdentity；缺失 / 非对象 → false）。</summary>
    public static bool TryObject(JsonElement meta, string key, out JsonElement value)
    {
        if (meta.ValueKind == JsonValueKind.Object && meta.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.Object)
        {
            value = v;
            return true;
        }
        value = default;
        return false;
    }
}

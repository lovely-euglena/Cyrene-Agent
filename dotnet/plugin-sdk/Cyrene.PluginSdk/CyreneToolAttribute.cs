namespace Cyrene.PluginSdk;

/// <summary>
/// 声明一个暴露给宿主 Agent 的工具方法。
/// 方法签名约定：<c>Task&lt;object?&gt; Name(JsonElement args)</c>，
/// 或同步的 <c>object? Name(JsonElement args)</c>。
/// 返回值序列化为 JSON 后作为工具结果回传。
/// </summary>
[AttributeUsage(AttributeTargets.Method, AllowMultiple = false, Inherited = true)]
public sealed class CyreneToolAttribute : Attribute
{
    /// <summary>工具短 id（宿主侧全 id 为 "pluginId__短id"）。</summary>
    public string Id { get; }

    /// <summary>工具显示名（给 Agent 的模型看）。</summary>
    public string Name { get; }

    /// <summary>工具描述——模型据此决定何时调用，写清楚输入输出。</summary>
    public string Description { get; }

    /// <summary>
    /// 输入 JSON Schema（字符串形式）。形如：
    /// <c>{"type":"object","properties":{"q":{"type":"string"}},"required":["q"]}</c>
    /// </summary>
    public string Schema { get; set; } = """{"type":"object","properties":{}}""";

    public CyreneToolAttribute(string id, string name, string description)
    {
        Id = id;
        Name = name;
        Description = description;
    }
}

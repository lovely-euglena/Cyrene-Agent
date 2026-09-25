namespace Cyrene.PluginSdk;

/// <summary>
/// 声明一个暴露给宿主 Agent 的工具方法。
/// 方法签名约定：<c>Task&lt;T&gt; Name(JsonElement args)</c>、<c>Task Name()</c>
/// 或同步的 <c>object? Name(JsonElement args)</c>；参数只允许「无参」或
/// 「单个 JsonElement」，签名不合法在 init 时告警并跳过（不注册）。
/// 返回值序列化为 JSON 后作为工具结果回传；Task&lt;T&gt; 会 await 后取 T。
/// </summary>
[AttributeUsage(AttributeTargets.Method, AllowMultiple = false, Inherited = true)]
public sealed class CyreneToolAttribute : Attribute
{
    /// <summary>工具短 id（宿主侧全 id 为 "pluginId_短id"，单下划线）。</summary>
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

    /// <summary>
    /// 风险级（可选，透传给宿主权限策略 Permission Policy）。取值：
    /// <c>safe | fs-read | fs-write | shell | network | input-control</c>。
    /// 缺省/非法值按宿主默认 safe 处理——需要写文件、执行命令或联网的工具
    /// 务必显式声明，否则不会触发对应的权限审批。
    /// </summary>
    public string? Risk { get; set; }

    public CyreneToolAttribute(string id, string name, string description)
    {
        Id = id;
        Name = name;
        Description = description;
    }
}

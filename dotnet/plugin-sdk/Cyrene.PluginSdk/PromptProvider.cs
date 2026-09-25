using System.Text.Json;

namespace Cyrene.PluginSdk;

/// <summary>
/// 每轮对话的提示词 Provider：宿主在组装上下文时调用，返回值作为插件上下文块注入。
/// 超时（2s）与长度截断（单条 16k / 总量 32k）由宿主统一执行，与 Node 轨一致。
/// </summary>
public sealed class PromptProvider
{
    /// <summary>Provider 唯一 id（只允许字母/数字/._-，最长 64）。</summary>
    public required string Id { get; init; }

    /// <summary>生效的会话模式（缺省 = 全部）：chat / work / learn / code。</summary>
    public string[]? Modes { get; init; }

    /// <summary>
    /// 生效场景（缺省 = conversation + scheduler，与 Node 轨旧行为一致）：
    /// conversation / scheduler / moments-post / plugin-agent。
    /// </summary>
    public string[]? Sources { get; init; }

    /// <summary>构建提示词内容；返回空字符串表示本轮不注入。</summary>
    public required Func<PromptBuildInput, CancellationToken, Task<string>> Provide { get; init; }
}

/// <summary>提示词 Provider 的构建输入（宿主投影，不含不可序列化的内部字段）。</summary>
public sealed class PromptBuildInput
{
    /// <summary>场景来源：conversation / scheduler / moments-post / plugin-agent。</summary>
    public string Source { get; init; } = "";

    /// <summary>会话模式：chat / work / learn / code（moments-post 场景为空）。</summary>
    public string Mode { get; init; } = "";

    /// <summary>本轮用户文本。</summary>
    public string UserText { get; init; } = "";

    /// <summary>会话归属（渠道/定时任务场景可能为空）。</summary>
    public string? ConversationId { get; init; }

    /// <summary>渠道来源（仅渠道会话有值）。</summary>
    public string? Channel { get; init; }

    internal static PromptBuildInput FromJson(JsonElement el)
    {
        if (el.ValueKind != JsonValueKind.Object) return new PromptBuildInput();
        return new PromptBuildInput
        {
            Source = GetString(el, "source") ?? "",
            Mode = GetString(el, "mode") ?? "",
            UserText = GetString(el, "userText") ?? "",
            ConversationId = GetString(el, "conversationId"),
            Channel = GetString(el, "channel"),
        };
    }

    private static string? GetString(JsonElement el, string name)
        => el.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;
}

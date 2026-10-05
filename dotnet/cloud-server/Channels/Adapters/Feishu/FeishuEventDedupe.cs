using System.Text.Json;
using CyreneNative.Channels;

namespace CyreneCloud.Channels.Adapters.Feishu;

/// <summary>
/// 飞书事件去重（§6.2）：<c>seen_messages</c> 双键——<c>message_id</c>（平台重投）+ <c>header.event_id</c>
/// （同一事件的多次重试）。两键均首次才视为新事件；任一已见即跳过（但仍回 200，不触发 agent）。
///
/// 键前缀与 ChannelDispatcher 的裸 message_id 去重键刻意区分：适配器先落双键，Dispatcher 再按
/// messageId 落一次（阶段 2 框架语义），互不干扰且幂等。
/// </summary>
public static class FeishuEventDedupe
{
    public const string MessageKeyPrefix = "msg:";
    public const string EventKeyPrefix = "evt:";

    /// <summary>从（已解密的）事件 envelope 提取双键；非消息事件可能为 null。</summary>
    public static (string? MessageKey, string? EventKey) Keys(JsonElement envelope)
    {
        string? messageId = null;
        if (envelope.ValueKind == JsonValueKind.Object
            && envelope.TryGetProperty("event", out var eventElement)
            && eventElement.ValueKind == JsonValueKind.Object
            && eventElement.TryGetProperty("message", out var message)
            && message.ValueKind == JsonValueKind.Object)
        {
            messageId = ChannelJsonValue.OptionalString(message, "message_id");
        }

        string? eventId = null;
        if (envelope.ValueKind == JsonValueKind.Object
            && envelope.TryGetProperty("header", out var header)
            && header.ValueKind == JsonValueKind.Object)
        {
            eventId = ChannelJsonValue.OptionalString(header, "event_id");
        }

        return (
            string.IsNullOrEmpty(messageId) ? null : MessageKeyPrefix + messageId,
            string.IsNullOrEmpty(eventId) ? null : EventKeyPrefix + eventId);
    }

    /// <summary>
    /// 双键落 seen_messages；返回 true = 新事件（应处理），false = 任一键已见（重复）。
    /// store 为 null（渠道层未启用存储）时恒 true（调用方自行决定语义）。
    /// </summary>
    public static async Task<bool> MarkSeenAsync(
        ChannelStore? store, JsonElement envelope, CancellationToken cancellationToken = default)
    {
        var (messageKey, eventKey) = Keys(envelope);
        if (store is null || (messageKey is null && eventKey is null)) return true;
        var first = true;
        if (messageKey is not null)
        {
            first &= await store.MarkSeenAsync(ChannelIds.Feishu, messageKey, cancellationToken);
        }
        if (eventKey is not null)
        {
            first &= await store.MarkSeenAsync(ChannelIds.Feishu, eventKey, cancellationToken);
        }
        return first;
    }
}

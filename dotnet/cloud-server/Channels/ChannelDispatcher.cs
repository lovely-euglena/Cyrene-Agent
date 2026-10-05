using CyreneCloud.Dialog;
using CyreneCloud.Storage;
using CyreneNative.Channels;

namespace CyreneCloud.Channels;

/// <summary>
/// 归属门闩（§2.5 入站：owner≠server 直接丢弃，防交接窗口误处理）。
/// 阶段 4 由 ChannelOwnershipService 实现租约判定并替换本默认实现；
/// 框架批默认放行（无归属控制面 = 服务端独占）。
/// </summary>
public interface IChannelOwnershipGate
{
    ValueTask<bool> CanProcessAsync(string channel, CancellationToken cancellationToken = default);
}

/// <summary>默认门闩：全部放行（阶段 4 之前的占位）。</summary>
public sealed class AllowAllChannelOwnershipGate : IChannelOwnershipGate
{
    public ValueTask<bool> CanProcessAsync(string channel, CancellationToken cancellationToken = default) =>
        ValueTask.FromResult(true);
}

/// <summary>
/// 渠道入站调度（§2.5）：
/// seen 去重 → 归属门闩 → ServerEventWriter 写 user 事件（channelSource presentation）
/// → DialogEngine 生成 → 写 assistant 事件 → ChannelDeliveryService 投递 → receipt。
///
/// 幂等双保险：seen_messages（平台重投）+ eventId（ch-.../gen-...）；
/// 生成窗口崩溃不自动补偿（receipt 缺失可见，§2.5）。
/// </summary>
public sealed class ChannelDispatcher
{
    private readonly ChannelStore _store;
    private readonly ServerEventWriter _writer;
    private readonly IDialogEngine _engine;
    private readonly ChannelDeliveryService _delivery;
    private readonly IChannelOwnershipGate _ownershipGate;
    private readonly ILogger<ChannelDispatcher> _logger;

    public ChannelDispatcher(
        ChannelStore store,
        ServerEventWriter writer,
        IDialogEngine engine,
        ChannelDeliveryService delivery,
        ILogger<ChannelDispatcher> logger,
        IChannelOwnershipGate? ownershipGate = null)
    {
        _store = store;
        _writer = writer;
        _engine = engine;
        _delivery = delivery;
        _logger = logger;
        _ownershipGate = ownershipGate ?? new AllowAllChannelOwnershipGate();
    }

    /// <summary>处理一条入站消息；返回实际投递的出站消息（仅观测用），跳过/失败返回 null。</summary>
    public async Task<OutgoingMessage?> HandleIncomingAsync(
        IncomingMessage message, CancellationToken cancellationToken = default)
    {
        var channel = message.Channel;
        var dedupeKey = BuildDedupeKey(message);
        if (!await _store.MarkSeenAsync(channel, dedupeKey, cancellationToken))
        {
            _logger.LogDebug("渠道消息重复，跳过 channel={Channel}", channel);
            return null;
        }
        if (!await _ownershipGate.CanProcessAsync(channel, cancellationToken))
        {
            _logger.LogDebug("归属门闩丢弃（owner≠server）channel={Channel}", channel);
            return null;
        }

        var sessionId = ChannelSessionId.MakeSessionId(channel, message.ChatId);
        var userWrite = await _writer.WriteChannelUserMessageAsync(sessionId, message, cancellationToken);
        if (userWrite.IsDuplicate)
        {
            // eventId 已存在：进程在 seen 之后、事件写入之前崩溃过的重投，幂等跳过
            _logger.LogDebug("渠道用户事件已存在，跳过 channel={Channel} event={Event}", channel, userWrite.EventId);
            return null;
        }
        if (!userWrite.IsWritten)
        {
            _logger.LogWarning("渠道用户事件写库被拒 channel={Channel} event={Event} errors={Errors}",
                channel, userWrite.EventId, string.Join(",", userWrite.Errors.Select(item => item.Code)));
            return null;
        }

        var reply = await _engine.GenerateAsync(sessionId, cancellationToken);
        if (reply is null) return null;

        var assistantWrite = await _writer.WriteChannelAssistantMessageAsync(
            sessionId, reply.EventId, reply.TurnId, reply.Text, cancellationToken);
        if (!assistantWrite.IsWritten)
        {
            _logger.LogWarning("渠道回复事件写库被拒 channel={Channel} event={Event} status={Status}",
                channel, reply.EventId, assistantWrite.Status);
            return null;
        }

        await _store.RememberRecipientAsync(channel, message.ChatId, message.ThreadId, cancellationToken);
        var outgoing = BuildOutgoing(message, reply.Text);
        var delivery = await _delivery.SendAsync(outgoing, cancellationToken);
        await _store.RecordReceiptAsync(
            channel, sessionId, assistantWrite.EventId,
            delivery.Ok ? ChannelStore.StatusDelivered : ChannelStore.StatusFailed,
            delivery.Error, cancellationToken);
        if (!delivery.Ok)
        {
            _logger.LogWarning("渠道回复投递失败 channel={Channel} event={Event} error={Error}",
                channel, assistantWrite.EventId, delivery.Error);
            return null;
        }
        return outgoing;
    }

    /// <summary>去重键：平台消息 id 优先；缺省 at:text（与事件 id 回退源同构）。</summary>
    private static string BuildDedupeKey(IncomingMessage message) =>
        !string.IsNullOrEmpty(message.MessageId)
            ? message.MessageId
            : $"{ChannelSessionId.UtcNowIso(message.At)}|{message.Text}";

    private static OutgoingMessage BuildOutgoing(IncomingMessage message, string text) => new()
    {
        Channel = message.Channel,
        ChatType = message.ChatType,
        TargetId = message.ChatId,
        ThreadId = message.ThreadId,
        ReplyContext = string.IsNullOrEmpty(message.MessageId)
            ? null
            : new OutgoingReplyContext { MessageId = message.MessageId! },
        Parts = [new OutgoingPart { Kind = OutgoingPartKinds.Text, Text = text }],
    };
}

using CyreneCloud.Storage;
using CyreneNative.Channels;

namespace CyreneCloud.Channels;

/// <summary>
/// 主动消息投递（docs/design/2026-10-05-server-channel.md §5.4）。
///
/// 桌面在 owner=server 时把 proactive 文本转发到 POST /v1/channels/{id}/proactive；
/// 本服务以 intentId 幂等（eventId = proactive-&lt;sha256(sessionId:intentId)[..32]&gt;），
/// 收件人取 channel_recipients（服务端入站时更新），先写事件再投递并记回执。
/// 服务端自主调度（到点触发）依赖 IKJK2O，本批不做（Q3）。
/// </summary>
public sealed class ChannelProactiveService
{
    private readonly ChannelStore _store;
    private readonly ServerEventWriter _writer;
    private readonly ChannelDeliveryService _delivery;
    private readonly ChannelOwnershipService _ownership;
    private readonly ILogger<ChannelProactiveService> _logger;

    public ChannelProactiveService(
        ChannelStore store,
        ServerEventWriter writer,
        ChannelDeliveryService delivery,
        ChannelOwnershipService ownership,
        ILogger<ChannelProactiveService> logger)
    {
        _store = store;
        _writer = writer;
        _delivery = delivery;
        _ownership = ownership;
        _logger = logger;
    }

    /// <summary>
    /// 投递一条主动消息。sessionId 缺省时按收件人派生（与桌面 makeSessionId 同构，R5），
    /// 保证同一 intentId 无论请求是否携带 sessionId 都落在同一事件 id。
    /// </summary>
    public async Task<ProactiveDeliveryOutcome> DeliverAsync(
        string channel, string? sessionId, string intentId, string text,
        CancellationToken cancellationToken = default)
    {
        // 唯一调度（§5.4）：owner=desktop 时服务端绝不直发，桌面负责本机发送
        if (!await _ownership.CanProcessAsync(channel, cancellationToken).ConfigureAwait(false))
        {
            return new ProactiveDeliveryOutcome(
                ProactiveDeliveryStatus.OwnedByOther, null, false, false, "E_CHANNEL_OWNED_BY_OTHER");
        }

        var recipient = await _store.GetRecentRecipientAsync(channel, cancellationToken).ConfigureAwait(false);
        if (recipient is null)
        {
            // 无收件人 → 400（桌面记失败，不回退本机——避免双发，§5.4）
            return new ProactiveDeliveryOutcome(
                ProactiveDeliveryStatus.RecipientMissing, null, false, false, "E_CHANNEL_RECIPIENT_MISSING");
        }

        var effectiveSession = string.IsNullOrWhiteSpace(sessionId)
            ? ChannelSessionId.MakeSessionId(channel, recipient.TargetId)
            : sessionId;

        // 先写事件后发送（§2.5）：重复 intentId 直接幂等确认，不重发
        var write = await _writer.WriteProactiveMessageAsync(effectiveSession, intentId, text, cancellationToken)
            .ConfigureAwait(false);
        if (write.IsDuplicate)
        {
            _logger.LogInformation(
                "主动消息幂等重复 event=proactive_duplicate channel={Channel} eventId={EventId}", channel, write.EventId);
            return new ProactiveDeliveryOutcome(ProactiveDeliveryStatus.Duplicate, write.EventId, true, true, null);
        }
        if (!write.IsWritten)
        {
            _logger.LogWarning(
                "主动消息事件写库失败 channel={Channel} errors={Errors}",
                channel, string.Join(",", write.Errors.Select(item => item.Code)));
            return new ProactiveDeliveryOutcome(
                ProactiveDeliveryStatus.WriteFailed, write.EventId, false, false, "E_CHANNEL_SEND_FAILED");
        }

        var capability = ChannelCapabilities.For(channel);
        var parts = capability.MaxTextLength > 0 && text.Length > capability.MaxTextLength
            ? ChannelTextSplitting.SplitBySentenceBreaks(text)
            : [text.Trim()];
        var failed = false;
        string? error = null;
        foreach (var part in parts)
        {
            if (string.IsNullOrEmpty(part)) continue;
            var outgoing = new OutgoingMessage
            {
                Channel = channel,
                ChatType = ChannelChatTypes.Private,
                TargetId = recipient.TargetId,
                ThreadId = recipient.ThreadId,
                Parts = [new OutgoingPart { Kind = OutgoingPartKinds.Text, Text = part }],
            };
            var result = await _delivery.SendAsync(outgoing, cancellationToken).ConfigureAwait(false);
            if (result.Ok) continue;
            failed = true;
            error = result.Error ?? "E_CHANNEL_SEND_FAILED";
            break;
        }

        await _store.RecordReceiptAsync(
            channel, effectiveSession, write.EventId,
            failed ? ChannelStore.StatusFailed : ChannelStore.StatusDelivered,
            failed ? error : null, cancellationToken).ConfigureAwait(false);
        if (failed)
        {
            _logger.LogWarning(
                "主动消息投递失败 channel={Channel} eventId={EventId} error={Error}", channel, write.EventId, error);
            return new ProactiveDeliveryOutcome(ProactiveDeliveryStatus.FailedDelivery, write.EventId, false, false, error);
        }
        return new ProactiveDeliveryOutcome(ProactiveDeliveryStatus.Delivered, write.EventId, true, false, null);
    }
}

public enum ProactiveDeliveryStatus
{
    /// <summary>写入事件并投递成功。</summary>
    Delivered,
    /// <summary>intentId 已处理过：幂等确认，不重发。</summary>
    Duplicate,
    /// <summary>事件已写入但投递失败（回执 failed）。</summary>
    FailedDelivery,
    /// <summary>无收件人（400 E_CHANNEL_RECIPIENT_MISSING）。</summary>
    RecipientMissing,
    /// <summary>owner=desktop，服务端拒发（409 E_CHANNEL_OWNED_BY_OTHER）。</summary>
    OwnedByOther,
    /// <summary>事件写库失败（500 E_CHANNEL_SEND_FAILED）。</summary>
    WriteFailed,
}

public sealed record ProactiveDeliveryOutcome(
    ProactiveDeliveryStatus Status, string? EventId, bool Delivered, bool Duplicate, string? Error);

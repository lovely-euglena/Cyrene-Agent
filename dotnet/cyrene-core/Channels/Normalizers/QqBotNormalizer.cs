using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace CyreneNative.Channels.Normalizers;

/// <summary>
/// QQ 官方 bot 归一化与被动回复请求体构造（C# 镜像）。
///
/// 语义源 = TS `src/main/channels/normalizers/qqbot.ts`（从桌面 qqbot-adapter 抽出）；
/// fixtures/channels 双端锁定。入站仅 C2C/群 @/群全量消息；出站仅文本被动回复
/// （分片 + msg_seq 递增 + 超限错误）。
/// </summary>
public static class QqBotNormalizer
{
    private static readonly HashSet<string> MessageEvents = new(StringComparer.Ordinal)
    {
        "C2C_MESSAGE_CREATE",
        "GROUP_AT_MESSAGE_CREATE",
        "GROUP_MESSAGE_CREATE",
    };

    public static IncomingMessage? NormalizeInbound(string eventType, JsonElement data, DateTimeOffset now)
    {
        if (!MessageEvents.Contains(eventType)) return null;
        if (data.ValueKind != JsonValueKind.Object) return null;
        var author = data.TryGetProperty("author", out var authorElement) && authorElement.ValueKind == JsonValueKind.Object
            ? authorElement
            : default;
        var isGroup = eventType != "C2C_MESSAGE_CREATE";
        var senderId = author.ValueKind == JsonValueKind.Object
            ? ChannelJsonValue.StringOrEmpty(author, isGroup ? "member_openid" : "user_openid")
            : "";
        var chatId = isGroup
            ? ChannelJsonValue.StringOrEmpty(data, "group_openid")
            : senderId;
        if (senderId.Length == 0 || chatId.Length == 0) return null;

        var content = ChannelJsonValue.StringOrEmpty(data, "content").Trim();
        var attachments = ParseAttachments(data);
        if (content.Length == 0 && attachments.Count == 0) return null;

        var senderName = author.ValueKind == JsonValueKind.Object
            ? ChannelJsonValue.OptionalString(author, "username")
            : null;
        return new IncomingMessage
        {
            Channel = ChannelIds.QqBot,
            ChatType = isGroup ? ChannelChatTypes.Group : ChannelChatTypes.Private,
            MessageId = ChannelJsonValue.StringOrEmpty(data, "id"),
            SenderId = senderId,
            SenderName = string.IsNullOrEmpty(senderName) ? null : senderName,
            ChatId = chatId,
            Text = content,
            Attachments = attachments.Count > 0 ? attachments : null,
            At = ParseTimestamp(data, now),
        };
    }

    private static List<ChannelAttachment> ParseAttachments(JsonElement data)
    {
        var attachments = new List<ChannelAttachment>();
        if (!data.TryGetProperty("attachments", out var raw) || raw.ValueKind != JsonValueKind.Array) return attachments;
        foreach (var item in raw.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.Object) continue;
            var contentType = ChannelJsonValue.StringOrEmpty(item, "content_type");
            var url = ChannelJsonValue.OptionalString(item, "voice_wav_url")
                ?? ChannelJsonValue.OptionalString(item, "url")
                ?? "";
            if (url.Length == 0) continue;
            var kind = ChannelAttachmentKinds.File;
            if (contentType.StartsWith("image/", StringComparison.Ordinal)) kind = ChannelAttachmentKinds.Image;
            else if (contentType == "voice") kind = ChannelAttachmentKinds.Audio;
            else if (contentType.StartsWith("video/", StringComparison.Ordinal)) kind = ChannelAttachmentKinds.Video;
            var caption = ChannelJsonValue.OptionalString(item, "filename");
            attachments.Add(new ChannelAttachment
            {
                Kind = kind,
                Url = url,
                Mime = contentType.Length > 0 ? contentType : null,
                Caption = string.IsNullOrEmpty(caption) ? null : caption,
            });
        }
        return attachments;
    }

    private static DateTimeOffset ParseTimestamp(JsonElement data, DateTimeOffset now)
    {
        var value = ChannelJsonValue.OptionalString(data, "timestamp");
        if (!string.IsNullOrEmpty(value) && DateTimeOffset.TryParse(
                value, CultureInfo.InvariantCulture, DateTimeStyles.None, out var parsed))
        {
            return parsed;
        }
        return now;
    }

    // ── 出站 ────────────────────────────────────────────────────────────────

    /// <summary>
    /// OutgoingMessage → 被动回复请求体列表（分片 + msg_seq 递增 + 超限错误）。
    /// msgSeqUsed = 该触发消息已用掉的次数（桌面语义：从 0 起）。
    /// </summary>
    public static QqBotReplyPlan BuildPassiveReplies(
        OutgoingMessage message, string messageId, int msgSeqUsed = 0, int? seqLimit = null)
    {
        var chunks = new List<string>();
        string? lastError = null;
        foreach (var part in message.Parts)
        {
            if (part.Kind == OutgoingPartKinds.Text)
            {
                chunks.AddRange(ChannelTextSplitting.SplitQqText(part.Text ?? ""));
            }
            else if (part.Kind == OutgoingPartKinds.Card)
            {
                var pieces = new List<string> { part.Title ?? "", part.Markdown ?? "" };
                if (part.Fields is not null)
                {
                    pieces.AddRange(part.Fields.Select(field => $"{field.Key}: {field.Value}"));
                }
                var text = string.Join("\n", pieces.Where(piece => piece.Length > 0));
                chunks.AddRange(ChannelTextSplitting.SplitQqText(text));
            }
            else
            {
                lastError = $"QQ Bot 官方渠道暂不支持发送 {part.Kind} 类型内容";
            }
        }
        if (chunks.Count == 0)
        {
            return new QqBotReplyPlan([], lastError ?? "没有可发送的 QQ Bot 内容");
        }

        var requests = new List<QqBotReplyRequest>();
        var used = msgSeqUsed;
        var limit = seqLimit ?? int.MaxValue;
        foreach (var chunk in chunks)
        {
            if (used >= limit)
            {
                lastError = $"回复次数达上限，余下 {chunks.Count - requests.Count} 段未发送";
                break;
            }
            used++;
            requests.Add(new QqBotReplyRequest
            {
                MsgType = 0,
                Content = chunk,
                MsgId = messageId,
                MsgSeq = used,
            });
        }
        return lastError is null ? new QqBotReplyPlan(requests, null) : new QqBotReplyPlan(requests, lastError);
    }
}

public sealed class QqBotReplyRequest
{
    [JsonPropertyName("msg_type")] public required int MsgType { get; init; }
    [JsonPropertyName("content")] public required string Content { get; init; }
    [JsonPropertyName("msg_id")] public required string MsgId { get; init; }
    [JsonPropertyName("msg_seq")] public required int MsgSeq { get; init; }
}

/// <summary>出站计划：error 非空时 requests 可能含已发送的前缀（桌面同语义）。</summary>
public sealed record QqBotReplyPlan(List<QqBotReplyRequest> Requests, string? Error);

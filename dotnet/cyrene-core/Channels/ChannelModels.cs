using System.Globalization;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace CyreneNative.Channels;

/// <summary>
/// 服务端渠道消息契约 v1（docs/design/2026-10-05-server-channel.md §2.2 字段级镜像）。
///
/// 语义源 = TS `src/main/channels/types.ts`；C# 以 record/class + camelCase JSON 镜像，
/// fixtures/channels 双端锁定（TS vitest ↔ smoke-host --selftest channel-contract）。
/// 字段名、可空语义、时间格式逐字一致；枚举字符串大小写敏感；缺省键必须缺省
/// （序列化用 <see cref="ChannelJson.Options"/> 的 WhenWritingNull）。
/// </summary>
public static class ChannelIds
{
    public const string WeChat = "wechat";
    public const string Feishu = "feishu";
    public const string QqBot = "qqbot";
}

public static class ChannelChatTypes
{
    public const string Private = "private";
    public const string Group = "group";
}

public static class ChannelPhases
{
    public const string Running = "running";
    public const string Offline = "offline";
    public const string Starting = "starting";
    public const string ConfigMissing = "config_missing";
    public const string Error = "error";
}

/// <summary>渠道 JSON 约定：camelCase + 缺省键缺省 + 严格 UTC 毫秒时间。</summary>
public static class ChannelJson
{
    /// <summary>模型与 fixtures 的规范序列化选项（camelCase；null 属性不写）。</summary>
    public static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        Converters = { new IsoUtcMillisecondsConverter() },
    };

    /// <summary>紧凑序列化（飞书 content 字符串等内嵌 JSON；不转义非 ASCII，与 JS JSON.stringify 对齐）。</summary>
    public static readonly JsonSerializerOptions Compact = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };
}

/// <summary>
/// `yyyy-MM-ddTHH:mm:ss.fffZ` 严格转换（与同步协议 ts / TS Date.toISOString 同格式）。
/// 读：只接受该格式（UTC 毫秒）；写：统一 UTC。
/// </summary>
public sealed class IsoUtcMillisecondsConverter : JsonConverter<DateTimeOffset>
{
    public const string Format = "yyyy-MM-dd'T'HH:mm:ss.fff'Z'";

    public override DateTimeOffset Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        var text = reader.GetString();
        if (text is null || !DateTimeOffset.TryParseExact(
                text, Format, CultureInfo.InvariantCulture,
                DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var value))
        {
            throw new JsonException($"非法 UTC 毫秒时间: {text}");
        }
        return value;
    }

    public override void Write(Utf8JsonWriter writer, DateTimeOffset value, JsonSerializerOptions options) =>
        writer.WriteStringValue(value.UtcDateTime.ToString(Format, CultureInfo.InvariantCulture));
}

public sealed class ChannelAttachment
{
    [JsonPropertyName("kind")] public required string Kind { get; init; }
    [JsonPropertyName("url")] public string? Url { get; init; }
    [JsonPropertyName("filePath")] public string? FilePath { get; init; }
    [JsonPropertyName("mime")] public string? Mime { get; init; }
    [JsonPropertyName("caption")] public string? Caption { get; init; }
}

public static class ChannelAttachmentKinds
{
    public const string Image = "image";
    public const string Audio = "audio";
    public const string File = "file";
    public const string Video = "video";
}

public sealed class ChannelMention
{
    [JsonPropertyName("userId")] public required string UserId { get; init; }
    [JsonPropertyName("name")] public string? Name { get; init; }
    [JsonPropertyName("isBot")] public bool? IsBot { get; init; }
}

public sealed class ChannelReplyContext
{
    [JsonPropertyName("messageId")] public required string MessageId { get; init; }
    [JsonPropertyName("senderId")] public string? SenderId { get; init; }
    [JsonPropertyName("senderName")] public string? SenderName { get; init; }
    [JsonPropertyName("text")] public string? Text { get; init; }
}

/// <summary>入站消息（adapters → dispatcher）。</summary>
public sealed class IncomingMessage
{
    [JsonPropertyName("channel")] public required string Channel { get; init; }
    [JsonPropertyName("chatType")] public string? ChatType { get; init; }
    [JsonPropertyName("messageId")] public string? MessageId { get; init; }
    [JsonPropertyName("senderId")] public required string SenderId { get; init; }
    [JsonPropertyName("senderName")] public string? SenderName { get; init; }
    [JsonPropertyName("chatId")] public required string ChatId { get; init; }
    [JsonPropertyName("threadId")] public string? ThreadId { get; init; }
    [JsonPropertyName("text")] public required string Text { get; init; }
    [JsonPropertyName("attachments")] public List<ChannelAttachment>? Attachments { get; init; }
    [JsonPropertyName("mentions")] public List<ChannelMention>? Mentions { get; init; }
    [JsonPropertyName("reply")] public ChannelReplyContext? Reply { get; init; }
    [JsonPropertyName("at")] public required DateTimeOffset At { get; init; }
}

public static class OutgoingPartKinds
{
    public const string Text = "text";
    public const string Image = "image";
    public const string Audio = "audio";
    public const string File = "file";
    public const string Video = "video";
    public const string Card = "card";
    public const string Sticker = "sticker";
}

/// <summary>出站片段（与 TS OutgoingPart 同构的扁平模型；kind 决定有效字段）。</summary>
public sealed class OutgoingPart
{
    [JsonPropertyName("kind")] public required string Kind { get; init; }
    [JsonPropertyName("text")] public string? Text { get; init; }
    [JsonPropertyName("url")] public string? Url { get; init; }
    [JsonPropertyName("filePath")] public string? FilePath { get; init; }
    [JsonPropertyName("caption")] public string? Caption { get; init; }
    [JsonPropertyName("mime")] public string? Mime { get; init; }
    [JsonPropertyName("name")] public string? Name { get; init; }
    [JsonPropertyName("title")] public string? Title { get; init; }
    [JsonPropertyName("markdown")] public string? Markdown { get; init; }
    [JsonPropertyName("fields")] public List<ChannelCardField>? Fields { get; init; }
    [JsonPropertyName("stickerId")] public string? StickerId { get; init; }
    [JsonPropertyName("imagePath")] public string? ImagePath { get; init; }
}

public sealed class ChannelCardField
{
    [JsonPropertyName("key")] public required string Key { get; init; }
    [JsonPropertyName("value")] public required string Value { get; init; }
}

public sealed class OutgoingReplyContext
{
    [JsonPropertyName("messageId")] public required string MessageId { get; init; }
    [JsonPropertyName("mentionUserId")] public string? MentionUserId { get; init; }
}

/// <summary>出站消息（dispatcher → adapters）。</summary>
public sealed class OutgoingMessage
{
    [JsonPropertyName("channel")] public required string Channel { get; init; }
    [JsonPropertyName("chatType")] public string? ChatType { get; init; }
    [JsonPropertyName("targetId")] public required string TargetId { get; init; }
    [JsonPropertyName("threadId")] public string? ThreadId { get; init; }
    [JsonPropertyName("replyContext")] public OutgoingReplyContext? ReplyContext { get; init; }
    [JsonPropertyName("parts")] public required List<OutgoingPart> Parts { get; init; }
}

/// <summary>渠道能力声明（服务端冻结值见 §2.2 能力表 / <see cref="ChannelCapabilities"/>）。</summary>
public sealed class ChannelCapability
{
    [JsonPropertyName("text")] public required bool Text { get; init; }
    [JsonPropertyName("image")] public required bool Image { get; init; }
    [JsonPropertyName("audio")] public required bool Audio { get; init; }
    [JsonPropertyName("file")] public required bool File { get; init; }
    [JsonPropertyName("video")] public required bool Video { get; init; }
    [JsonPropertyName("markdown")] public required bool Markdown { get; init; }
    [JsonPropertyName("card")] public required bool Card { get; init; }
    [JsonPropertyName("sticker")] public required bool Sticker { get; init; }
    [JsonPropertyName("maxTextLength")] public required int MaxTextLength { get; init; }
}

/// <summary>渠道状态（UI/状态端点展示用）。</summary>
public sealed class ChannelStatus
{
    [JsonPropertyName("enabled")] public required bool Enabled { get; init; }
    [JsonPropertyName("phase")] public required string Phase { get; init; }
    [JsonPropertyName("message")] public string? Message { get; init; }
    [JsonPropertyName("detail")] public JsonElement? Detail { get; init; }
}

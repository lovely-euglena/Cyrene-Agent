using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace CyreneNative.Channels.Normalizers;

/// <summary>
/// 飞书事件归一化与出站请求体构造（C# 镜像）。
///
/// 语义源 = TS `src/main/channels/normalizers/feishu.ts`（入站行为对齐桌面 normalizeLarkMessage）；
/// fixtures/channels 双端锁定。入站仅私聊（chat_type=p2p）；出站逐 part 一条
/// `im/v1/messages` body（image_key/file_key 由调用方先上传注入）。
/// </summary>
public static class FeishuNormalizer
{
    public static FeishuNormalizedInbound? NormalizeInbound(JsonElement raw, DateTimeOffset now)
    {
        if (raw.ValueKind != JsonValueKind.Object) return null;
        if (!raw.TryGetProperty("header", out var header) || header.ValueKind != JsonValueKind.Object) return null;
        if (ChannelJsonValue.OptionalString(header, "event_type") != "im.message.receive_v1") return null;
        if (!raw.TryGetProperty("event", out var eventElement) || eventElement.ValueKind != JsonValueKind.Object) return null;
        if (!eventElement.TryGetProperty("message", out var message) || message.ValueKind != JsonValueKind.Object) return null;
        if (ChannelJsonValue.OptionalString(message, "chat_type") != "p2p") return null;

        var senderId = "";
        if (eventElement.TryGetProperty("sender", out var sender) && sender.ValueKind == JsonValueKind.Object
            && sender.TryGetProperty("sender_id", out var senderIds) && senderIds.ValueKind == JsonValueKind.Object)
        {
            senderId = ChannelJsonValue.OptionalString(senderIds, "open_id") ?? "";
        }

        var rawType = ChannelJsonValue.OptionalString(message, "message_type");
        if (string.IsNullOrEmpty(rawType)) rawType = "text";
        var content = ParseContentObject(message);

        string text;
        var media = new List<FeishuInboundMedia>();
        switch (rawType)
        {
            case "text":
                text = content is not null && ChannelJsonValue.OptionalString(content.Value, "text") is { } parsedText
                    ? parsedText
                    : ChannelJsonValue.OptionalString(message, "content") ?? "";
                break;
            case "image":
                text = "[image]";
                if (content is not null && ChannelJsonValue.OptionalString(content.Value, "image_key") is { } imageKey)
                    media.Add(new FeishuInboundMedia { Kind = "image", FileKey = imageKey });
                break;
            case "file":
                text = "[file]";
                if (content is not null && ChannelJsonValue.OptionalString(content.Value, "file_key") is { } fileKey)
                {
                    media.Add(new FeishuInboundMedia
                    {
                        Kind = "file",
                        FileKey = fileKey,
                        FileName = ChannelJsonValue.OptionalString(content.Value, "file_name"),
                    });
                }
                break;
            case "audio":
                text = "[audio]";
                if (content is not null && ChannelJsonValue.OptionalString(content.Value, "file_key") is { } audioKey)
                {
                    var duration = ChannelJsonValue.NumberOrNull(content.Value, "duration");
                    media.Add(new FeishuInboundMedia
                    {
                        Kind = "audio",
                        FileKey = audioKey,
                        Duration = duration is null ? null : (long)duration.Value,
                    });
                }
                break;
            case "video":
                text = "[video]";
                if (content is not null && ChannelJsonValue.OptionalString(content.Value, "file_key") is { } videoKey)
                {
                    media.Add(new FeishuInboundMedia
                    {
                        Kind = "video",
                        FileKey = videoKey,
                        FileName = ChannelJsonValue.OptionalString(content.Value, "file_name"),
                    });
                }
                break;
            case "sticker":
                text = "[sticker]";
                if (content is not null && ChannelJsonValue.OptionalString(content.Value, "file_key") is { } stickerKey)
                    media.Add(new FeishuInboundMedia { Kind = "image", FileKey = stickerKey });
                break;
            default:
                text = $"[{rawType}]";
                break;
        }

        var at = ParseEpochMs(eventElement, "timestamp") ?? ParseEpochMs(header, "create_time") ?? now;
        var threadId = ChannelJsonValue.OptionalString(message, "thread_id");
        var result = new FeishuNormalizedInbound
        {
            Message = new IncomingMessage
            {
                Channel = ChannelIds.Feishu,
                SenderId = senderId,
                ChatId = ChannelJsonValue.OptionalString(message, "chat_id") ?? "",
                ThreadId = string.IsNullOrEmpty(threadId) ? null : threadId,
                MessageId = ChannelJsonValue.OptionalString(message, "message_id") ?? "",
                Text = text,
                At = at,
            },
            Media = media,
        };
        return result;
    }

    private static JsonElement? ParseContentObject(JsonElement message)
    {
        var content = ChannelJsonValue.OptionalString(message, "content");
        if (content is null) return null;
        try
        {
            using var document = JsonDocument.Parse(content);
            return document.RootElement.ValueKind == JsonValueKind.Object ? document.RootElement.Clone() : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static DateTimeOffset? ParseEpochMs(JsonElement parent, string name)
    {
        if (!parent.TryGetProperty(name, out var value)) return null;
        double? milliseconds = value.ValueKind switch
        {
            JsonValueKind.Number => value.TryGetDouble(out var number) ? number : null,
            JsonValueKind.String => double.TryParse(
                value.GetString(), NumberStyles.Float, CultureInfo.InvariantCulture, out var parsed) ? parsed : null,
            _ => null,
        };
        if (milliseconds is null || !double.IsFinite(milliseconds.Value)) return null;
        return ChannelJsonValue.FromUnixTimeMilliseconds(milliseconds.Value);
    }

    // ── 出站 ────────────────────────────────────────────────────────────────

    public static FeishuSendPlan BuildSendRequests(OutgoingMessage message, FeishuSendContext? context = null)
    {
        context ??= new FeishuSendContext();
        var receiveIdType = context.ReceiveIdType
            ?? (message.ChatType == ChannelChatTypes.Group ? "chat_id" : "open_id");
        var requests = new List<FeishuSendRequest>();
        FeishuSendPlan Fail(string error) => new(receiveIdType, [], error);

        foreach (var part in message.Parts)
        {
            switch (part.Kind)
            {
                case OutgoingPartKinds.Text:
                    requests.Add(new FeishuSendRequest
                    {
                        ReceiveId = message.TargetId,
                        MsgType = "text",
                        Content = JsonSerializer.Serialize(new JsonObject { ["text"] = part.Text ?? "" }, ChannelJson.Compact),
                    });
                    break;
                case OutgoingPartKinds.Image:
                {
                    var upload = TryGetUpload(context.Uploads, part.FilePath);
                    if (string.IsNullOrEmpty(upload?.ImageKey))
                        return Fail($"缺少图片上传结果: {part.FilePath ?? "url"}");
                    requests.Add(new FeishuSendRequest
                    {
                        ReceiveId = message.TargetId,
                        MsgType = "image",
                        Content = JsonSerializer.Serialize(new JsonObject { ["image_key"] = upload.ImageKey }, ChannelJson.Compact),
                    });
                    break;
                }
                case OutgoingPartKinds.Sticker:
                {
                    var upload = TryGetUpload(context.Uploads, part.ImagePath);
                    if (string.IsNullOrEmpty(upload?.ImageKey))
                        return Fail($"缺少图片上传结果: {part.ImagePath}");
                    requests.Add(new FeishuSendRequest
                    {
                        ReceiveId = message.TargetId,
                        MsgType = "image",
                        Content = JsonSerializer.Serialize(new JsonObject { ["image_key"] = upload.ImageKey }, ChannelJson.Compact),
                    });
                    break;
                }
                case OutgoingPartKinds.File:
                {
                    var upload = TryGetUpload(context.Uploads, part.FilePath);
                    if (string.IsNullOrEmpty(upload?.FileKey))
                        return Fail($"缺少文件上传结果: {part.FilePath}");
                    var fileName = string.IsNullOrEmpty(part.Name) ? WeChatNormalizer.BaseName(part.FilePath!) : part.Name;
                    requests.Add(new FeishuSendRequest
                    {
                        ReceiveId = message.TargetId,
                        MsgType = "file",
                        Content = JsonSerializer.Serialize(
                            new JsonObject { ["file_key"] = upload.FileKey, ["file_name"] = fileName }, ChannelJson.Compact),
                    });
                    break;
                }
                case OutgoingPartKinds.Audio:
                {
                    var upload = TryGetUpload(context.Uploads, part.FilePath);
                    if (string.IsNullOrEmpty(upload?.FileKey))
                        return Fail($"缺少音频上传结果: {part.FilePath}");
                    var payload = new JsonObject { ["file_key"] = upload.FileKey };
                    if (part.FilePath is not null && context.Durations is not null
                        && context.Durations.TryGetValue(part.FilePath, out var duration))
                    {
                        payload["duration"] = duration;
                    }
                    requests.Add(new FeishuSendRequest
                    {
                        ReceiveId = message.TargetId,
                        MsgType = "audio",
                        Content = JsonSerializer.Serialize(payload, ChannelJson.Compact),
                    });
                    break;
                }
                case OutgoingPartKinds.Video:
                {
                    var upload = TryGetUpload(context.Uploads, part.FilePath);
                    if (string.IsNullOrEmpty(upload?.FileKey))
                        return Fail($"缺少视频上传结果: {part.FilePath}");
                    var payload = new JsonObject { ["file_key"] = upload.FileKey };
                    if (!string.IsNullOrEmpty(upload.ImageKey)) payload["image_key"] = upload.ImageKey;
                    requests.Add(new FeishuSendRequest
                    {
                        ReceiveId = message.TargetId,
                        MsgType = "media",
                        Content = JsonSerializer.Serialize(payload, ChannelJson.Compact),
                    });
                    break;
                }
                case OutgoingPartKinds.Card:
                {
                    requests.Add(new FeishuSendRequest
                    {
                        ReceiveId = message.TargetId,
                        MsgType = "interactive",
                        Content = JsonSerializer.Serialize(CardPayload(part), ChannelJson.Compact),
                    });
                    break;
                }
            }
        }
        return new FeishuSendPlan(receiveIdType, requests, null);
    }

    private static FeishuUploadResult? TryGetUpload(Dictionary<string, FeishuUploadResult>? uploads, string? path)
    {
        if (string.IsNullOrEmpty(path) || uploads is null) return null;
        return uploads.TryGetValue(path, out var upload) ? upload : null;
    }

    private static JsonObject CardPayload(OutgoingPart part)
    {
        var elements = new JsonArray
        {
            new JsonObject
            {
                ["tag"] = "div",
                ["text"] = new JsonObject { ["tag"] = "lark_md", ["content"] = part.Markdown ?? "" },
            },
        };
        if (part.Fields is { Count: > 0 })
        {
            var fields = new JsonArray();
            foreach (var field in part.Fields)
            {
                fields.Add(new JsonObject
                {
                    ["is_short"] = true,
                    ["text"] = new JsonObject { ["tag"] = "lark_md", ["content"] = $"**{field.Key}**\n{field.Value}" },
                });
            }
            elements.Add(new JsonObject { ["tag"] = "div", ["fields"] = fields });
        }
        return new JsonObject
        {
            ["schema"] = "2.0",
            ["header"] = new JsonObject
            {
                ["title"] = new JsonObject { ["tag"] = "plain_text", ["content"] = part.Title ?? "" },
                ["template"] = "blue",
            },
            ["elements"] = elements,
        };
    }

    /// <summary>飞书资源类型 → 扩展名 + MIME（适配器下载落盘用；桌面既有表）。</summary>
    public static (string Ext, string Mime) ResourceKindToExt(string ktype) => ktype switch
    {
        "image" => (".png", "image/png"),
        "audio" => (".mp3", "audio/mpeg"),
        "video" => (".mp4", "video/mp4"),
        "file" => (".bin", "application/octet-stream"),
        "sticker" => (".png", "image/png"),
        _ => (".bin", "application/octet-stream"),
    };
}

public sealed class FeishuNormalizedInbound
{
    [JsonPropertyName("message")] public required IncomingMessage Message { get; init; }
    [JsonPropertyName("media")] public required List<FeishuInboundMedia> Media { get; init; }
}

public sealed class FeishuInboundMedia
{
    [JsonPropertyName("kind")] public required string Kind { get; init; }
    [JsonPropertyName("fileKey")] public required string FileKey { get; init; }
    [JsonPropertyName("fileName")] public string? FileName { get; init; }
    [JsonPropertyName("duration")] public long? Duration { get; init; }
}

public sealed class FeishuUploadResult
{
    [JsonPropertyName("image_key")] public string? ImageKey { get; init; }
    [JsonPropertyName("file_key")] public string? FileKey { get; init; }
}

public sealed class FeishuSendContext
{
    /// <summary>receive_id_type（缺省：私聊 open_id / 群 chat_id）</summary>
    public string? ReceiveIdType { get; init; }
    public Dictionary<string, FeishuUploadResult>? Uploads { get; init; }
    public Dictionary<string, long>? Durations { get; init; }
}

public sealed class FeishuSendRequest
{
    [JsonPropertyName("receive_id")] public required string ReceiveId { get; init; }
    [JsonPropertyName("msg_type")] public required string MsgType { get; init; }
    /// <summary>飞书要求 content 为 JSON 字符串（紧凑、无空格）</summary>
    [JsonPropertyName("content")] public required string Content { get; init; }
}

/// <summary>出站计划：receiveIdType 供调用方拼 query；error 非空时 requests 恒为空。</summary>
public sealed record FeishuSendPlan(string ReceiveIdType, List<FeishuSendRequest> Requests, string? Error);

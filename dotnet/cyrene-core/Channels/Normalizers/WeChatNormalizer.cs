using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace CyreneNative.Channels.Normalizers;

/// <summary>
/// 微信 iLink 归一化与出站请求体构造（C# 镜像）。
///
/// 语义源 = TS `src/main/channels/normalizers/wechat.ts`（行为对齐桌面 ilink-bot-adapter）；
/// fixtures/channels 双端锁定。入站：多 text_item 顺序拼接、message_type !== 1 过滤、
/// 媒体描述符（复用桌面 inbound-media 同表）；出站：sendmessage 请求体（CDN 上传结果注入）。
/// </summary>
public static class WeChatNormalizer
{
    private static readonly HashSet<string> AnalyzableFileExtensions = new(StringComparer.Ordinal)
    {
        ".txt", ".md", ".markdown",
        ".json", ".csv", ".tsv", ".yaml", ".yml",
        ".pdf", ".docx", ".xlsx",
        ".js", ".ts", ".tsx", ".jsx", ".py", ".java", ".go", ".rs", ".cpp", ".c", ".h", ".cs",
        ".html", ".css", ".xml", ".toml", ".ini", ".env", ".log",
    };

    private static readonly HashSet<string> ImageExtensions = new(StringComparer.Ordinal)
    {
        ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp",
    };

    /// <summary>
    /// iLink WireMessage → 归一化入站结果。
    /// 返回 null = 非用户消息（message_type !== 1）或 payload 不是对象；
    /// `now` 仅在缺 create_time_ms 时兜底。
    /// </summary>
    public static WeChatNormalizedInbound? NormalizeInbound(JsonElement raw, DateTimeOffset now)
    {
        if (raw.ValueKind != JsonValueKind.Object) return null;
        var messageType = ChannelJsonValue.NumberOrNull(raw, "message_type");
        if (messageType is null || (int)messageType.Value != 1) return null;

        var fromUserId = ChannelJsonValue.OptionalString(raw, "from_user_id") ?? "";
        var createTimeMs = ChannelJsonValue.NumberOrNull(raw, "create_time_ms");
        var items = raw.TryGetProperty("item_list", out var list) && list.ValueKind == JsonValueKind.Array
            ? list
            : default;

        var message = new IncomingMessage
        {
            Channel = ChannelIds.WeChat,
            SenderId = fromUserId,
            ChatId = fromUserId,
            MessageId = ChannelJsonValue.StringOrEmpty(raw, "message_id"),
            Text = ExtractText(items),
            At = createTimeMs is not null && double.IsFinite(createTimeMs.Value)
                ? ChannelJsonValue.FromUnixTimeMilliseconds(createTimeMs.Value)
                : now,
        };
        return new WeChatNormalizedInbound { Message = message, Media = DescribeMedia(items) };
    }

    /// <summary>多个 text_item 顺序拼接（与协议客户端 / TS 同实现）。</summary>
    public static string ExtractText(JsonElement items)
    {
        if (items.ValueKind != JsonValueKind.Array) return "";
        var builder = new System.Text.StringBuilder();
        foreach (var item in items.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.Object) continue;
            if (ChannelJsonValue.NumberOrNull(item, "type") is not { } type || (int)type != 1) continue;
            if (!item.TryGetProperty("text_item", out var textItem) || textItem.ValueKind != JsonValueKind.Object) continue;
            var text = ChannelJsonValue.OptionalString(textItem, "text");
            if (!string.IsNullOrEmpty(text)) builder.Append(text);
        }
        return builder.ToString();
    }

    private static List<WeChatInboundMedia> DescribeMedia(JsonElement items)
    {
        var media = new List<WeChatInboundMedia>();
        if (items.ValueKind != JsonValueKind.Array) return media;
        foreach (var item in items.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.Object) continue;
            var type = ChannelJsonValue.NumberOrNull(item, "type");
            if (type is null) continue;
            switch ((int)type.Value)
            {
                case 2 when item.TryGetProperty("image_item", out var image) && image.ValueKind == JsonValueKind.Object:
                {
                    var fileName = AsFileName(image, "微信图片");
                    media.Add(NewMedia("image", fileName, analyzable: true, AsCdnMedia(image), null));
                    break;
                }
                case 3 when item.TryGetProperty("voice_item", out var voice) && voice.ValueKind == JsonValueKind.Object:
                {
                    var fileName = AsFileName(voice, "微信语音");
                    var sampleRate = ChannelJsonValue.NumberOrNull(voice, "sample_rate");
                    media.Add(NewMedia("voice", fileName, analyzable: false, AsCdnMedia(voice),
                        sampleRate is null ? null : (int)sampleRate.Value));
                    break;
                }
                case 4 when item.TryGetProperty("file_item", out var file) && file.ValueKind == JsonValueKind.Object:
                {
                    var fileName = AsFileName(file, "微信文件");
                    media.Add(NewMedia("file", fileName, IsAnalyzableFile(fileName), AsCdnMedia(file), null));
                    break;
                }
                case 5 when item.TryGetProperty("video_item", out var video) && video.ValueKind == JsonValueKind.Object:
                {
                    var fileName = AsFileName(video, "微信视频");
                    media.Add(NewMedia("video", fileName, analyzable: false, AsCdnMedia(video), null));
                    break;
                }
            }
        }
        return media;
    }

    private static WeChatInboundMedia NewMedia(string kind, string fileName, bool analyzable, WeChatCdnMedia? media, int? sampleRate) => new()
    {
        Kind = kind,
        FileName = fileName,
        Extension = GetFileExtension(fileName),
        Analyzable = analyzable,
        Media = media,
        SampleRate = sampleRate,
    };

    private static string AsFileName(JsonElement item, string fallback)
    {
        var value = ChannelJsonValue.OptionalString(item, "file_name")
            ?? ChannelJsonValue.OptionalString(item, "name");
        if (value is null) return fallback;
        var trimmed = value.Trim();
        return trimmed.Length == 0 ? fallback : BaseName(trimmed);
    }

    private static bool IsAnalyzableFile(string fileName)
    {
        var extension = GetFileExtension(fileName);
        return AnalyzableFileExtensions.Contains(extension) || ImageExtensions.Contains(extension);
    }

    /// <summary>JS path.extname 同口径（小写；dotfile 返回空串）。</summary>
    internal static string GetFileExtension(string fileName)
    {
        var baseName = BaseName(fileName);
        var dot = baseName.LastIndexOf('.');
        if (dot <= 0) return "";
        return baseName[dot..].ToLowerInvariant();
    }

    /// <summary>JS path.basename（win32/posix 分隔符都认；末尾分隔符剥掉）。</summary>
    internal static string BaseName(string value)
    {
        var end = value.Length;
        while (end > 0 && (value[end - 1] == '/' || value[end - 1] == '\\')) end--;
        if (end == 0) return "";
        var start = end;
        while (start > 0 && value[start - 1] != '/' && value[start - 1] != '\\') start--;
        return value[start..end];
    }

    private static WeChatCdnMedia? AsCdnMedia(JsonElement item)
    {
        if (!item.TryGetProperty("media", out var media) || media.ValueKind != JsonValueKind.Object) return null;
        var encryptQueryParam = ChannelJsonValue.OptionalString(media, "encrypt_query_param");
        var aesKey = ChannelJsonValue.OptionalString(media, "aes_key");
        if (encryptQueryParam is null || aesKey is null) return null;
        var encryptType = ChannelJsonValue.NumberOrNull(media, "encrypt_type");
        return new WeChatCdnMedia
        {
            EncryptQueryParam = encryptQueryParam,
            AesKey = aesKey,
            EncryptType = encryptType is null ? null : (int)encryptType.Value,
            FullUrl = ChannelJsonValue.OptionalString(media, "full_url"),
        };
    }

    // ── 出站 ────────────────────────────────────────────────────────────────

    /// <summary>OutgoingMessage → iLink sendmessage 请求体列表（与 TS buildWechatSendRequests 同实现）。</summary>
    public static WeChatSendPlan BuildSendRequests(OutgoingMessage message, WeChatSendContext context)
    {
        var requests = new List<JsonElement>();
        foreach (var part in message.Parts)
        {
            switch (part.Kind)
            {
                case OutgoingPartKinds.Text:
                {
                    var text = (part.Text ?? "").Trim();
                    if (text.Length == 0) continue;
                    requests.Add(Request(message.TargetId, context,
                        new JsonArray { TextItem(text) }));
                    break;
                }
                case OutgoingPartKinds.Image:
                {
                    if (string.IsNullOrEmpty(part.FilePath))
                        return new WeChatSendPlan([], "微信图片发送需要本地 filePath");
                    if (!TryGetUpload(context.Uploads, part.FilePath, out var media))
                        return new WeChatSendPlan([], $"缺少上传结果: {part.FilePath}");
                    requests.Add(Request(message.TargetId, context,
                        new JsonArray { ImageItem(media) }));
                    break;
                }
                case OutgoingPartKinds.Sticker:
                {
                    if (!TryGetUpload(context.Uploads, part.ImagePath, out var media))
                        return new WeChatSendPlan([], $"缺少上传结果: {part.ImagePath}");
                    requests.Add(Request(message.TargetId, context,
                        new JsonArray { ImageItem(media) }));
                    break;
                }
                case OutgoingPartKinds.Audio:
                {
                    if (string.IsNullOrEmpty(part.FilePath) || context.Voices is null
                        || !context.Voices.TryGetValue(part.FilePath, out var voice))
                    {
                        return new WeChatSendPlan([], $"缺少语音编码结果: {part.FilePath}");
                    }
                    requests.Add(Request(message.TargetId, context, new JsonArray { VoiceItem(voice) }));
                    break;
                }
                case OutgoingPartKinds.File:
                {
                    if (string.IsNullOrEmpty(part.FilePath) || !TryGetUpload(context.Uploads, part.FilePath, out var media))
                        return new WeChatSendPlan([], $"缺少上传结果: {part.FilePath}");
                    var fileName = BaseName(string.IsNullOrEmpty(part.Name) ? part.FilePath : part.Name);
                    requests.Add(Request(message.TargetId, context, new JsonArray { FileItem(media, fileName) }));
                    break;
                }
                case OutgoingPartKinds.Video:
                {
                    if (string.IsNullOrEmpty(part.FilePath) || !TryGetUpload(context.Uploads, part.FilePath, out var media))
                        return new WeChatSendPlan([], $"缺少上传结果: {part.FilePath}");
                    requests.Add(Request(message.TargetId, context, new JsonArray { VideoItem(media) }));
                    break;
                }
                // card：微信 capability=false，桌面适配器同样无分支（静默跳过）
            }
        }
        return new WeChatSendPlan(requests, null);
    }

    private static bool TryGetUpload(
        Dictionary<string, WeChatCdnMedia>? uploads, string? path, out WeChatCdnMedia media)
    {
        media = null!;
        if (string.IsNullOrEmpty(path) || uploads is null) return false;
        return uploads.TryGetValue(path, out media!);
    }

    private static JsonElement Request(string targetId, WeChatSendContext context, JsonArray itemList) =>
        JsonSerializer.SerializeToElement(new JsonObject
        {
            ["msg"] = new JsonObject
            {
                ["from_user_id"] = "",
                ["to_user_id"] = targetId,
                ["client_id"] = context.ClientId,
                ["message_type"] = 2,
                ["message_state"] = 2,
                ["context_token"] = context.ContextToken,
                ["item_list"] = itemList,
            },
            ["base_info"] = new JsonObject { ["channel_version"] = "2.0.0" },
        }, ChannelJson.Options);

    private static JsonObject TextItem(string text) => new() { ["type"] = 1, ["text_item"] = new JsonObject { ["text"] = text } };

    private static JsonObject ImageItem(WeChatCdnMedia media) => new() { ["type"] = 2, ["image_item"] = new JsonObject { ["media"] = MediaJson(media) } };

    private static JsonObject VoiceItem(WeChatVoiceUpload voice) => new()
    {
        ["type"] = 3,
        ["voice_item"] = new JsonObject
        {
            ["media"] = MediaJson(voice.Media),
            ["encode_type"] = voice.EncodeType,
            ["sample_rate"] = voice.SampleRate,
            ["playtime"] = voice.Playtime,
        },
    };

    private static JsonObject FileItem(WeChatCdnMedia media, string fileName) => new()
    {
        ["type"] = 4,
        ["file_item"] = new JsonObject { ["file_name"] = fileName, ["media"] = MediaJson(media) },
    };

    private static JsonObject VideoItem(WeChatCdnMedia media) => new() { ["type"] = 5, ["video_item"] = new JsonObject { ["media"] = MediaJson(media) } };

    private static JsonObject MediaJson(WeChatCdnMedia media)
    {
        var json = new JsonObject
        {
            ["encrypt_query_param"] = media.EncryptQueryParam,
            ["aes_key"] = media.AesKey,
        };
        if (media.EncryptType is not null) json["encrypt_type"] = media.EncryptType;
        if (media.FullUrl is not null) json["full_url"] = media.FullUrl;
        return json;
    }
}

public sealed class WeChatNormalizedInbound
{
    [JsonPropertyName("message")] public required IncomingMessage Message { get; init; }
    [JsonPropertyName("media")] public required List<WeChatInboundMedia> Media { get; init; }
}

/// <summary>入站媒体描述符（与桌面 inbound-media.ts InboundMediaDescriptor 同字段）。</summary>
public sealed class WeChatInboundMedia
{
    [JsonPropertyName("kind")] public required string Kind { get; init; }
    [JsonPropertyName("fileName")] public required string FileName { get; init; }
    [JsonPropertyName("extension")] public required string Extension { get; init; }
    [JsonPropertyName("analyzable")] public required bool Analyzable { get; init; }
    [JsonPropertyName("media")] public WeChatCdnMedia? Media { get; init; }
    [JsonPropertyName("sampleRate")] public int? SampleRate { get; init; }
}

/// <summary>iLink CDN 媒体（wire 命名 snake_case）。</summary>
public sealed class WeChatCdnMedia
{
    [JsonPropertyName("encrypt_query_param")] public required string EncryptQueryParam { get; init; }
    [JsonPropertyName("aes_key")] public required string AesKey { get; init; }
    [JsonPropertyName("encrypt_type")] public int? EncryptType { get; init; }
    [JsonPropertyName("full_url")] public string? FullUrl { get; init; }
}

public sealed class WeChatVoiceUpload
{
    [JsonPropertyName("media")] public required WeChatCdnMedia Media { get; init; }
    [JsonPropertyName("playtime")] public required int Playtime { get; init; }
    [JsonPropertyName("sampleRate")] public required int SampleRate { get; init; }
    [JsonPropertyName("encodeType")] public required int EncodeType { get; init; }
}

public sealed class WeChatSendContext
{
    public required string ContextToken { get; init; }
    public required string ClientId { get; init; }
    public Dictionary<string, WeChatCdnMedia>? Uploads { get; init; }
    public Dictionary<string, WeChatVoiceUpload>? Voices { get; init; }
}

/// <summary>出站计划：requests 逐条 sendmessage；error 非空时 requests 恒为空。</summary>
public sealed record WeChatSendPlan(List<JsonElement> Requests, string? Error);

using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using CyreneNative.Channels;
using CyreneNative.Channels.Normalizers;

namespace CyreneCloud.Channels.Adapters.WeChat;

/// <summary>
/// 微信 iLink 协议客户端（桌面 `src/main/channels/adapters/wechat/ilink-protocol-client.ts` 的移植）。
///
/// 同端点、同字段、同头（设计 §3.1）：getupdates 长轮询（服务端挂 35s，客户端 40s 超时）、
/// sendmessage（from_user_id=""、随机 client_id、message_type/state=2、context_token 原样回传）、
/// getuploadurl；响应体上限 4MB（§3.5）。ret 缺省视为成功（上游成功响应常无 ret），
/// ret=-14 → <see cref="ILinkSessionExpiredException"/>（不重试，等人工重登）。
/// 构造注入 <see cref="HttpClient"/>（测试用 mock HttpMessageHandler，无网络）。
/// </summary>
public sealed class ILinkProtocolClient
{
    public const string DefaultBaseUrl = "https://ilinkai.weixin.qq.com";
    public const string ChannelVersion = "2.0.0";

    /// <summary>getupdates 长轮询超时：上游挂 35s，客户端 40s 打断（与桌面一致）。</summary>
    public static readonly TimeSpan LongPollTimeout = TimeSpan.FromSeconds(40);

    private static readonly TimeSpan DefaultTimeout = TimeSpan.FromSeconds(30);
    private const int MaxResponseBytes = 4 * 1024 * 1024;

    private readonly HttpClient _http;
    private readonly string _baseUrl;
    private readonly string _botToken;
    private readonly string _wechatUin;

    public ILinkProtocolClient(
        ILinkCredentials credentials,
        HttpClient? http = null,
        Func<string>? wechatUin = null)
    {
        _http = http ?? WeChatHttp.CreateClient();
        _baseUrl = (string.IsNullOrWhiteSpace(credentials.BaseUrl) ? DefaultBaseUrl : credentials.BaseUrl.TrimEnd('/'));
        _botToken = credentials.BotToken;
        _botId = credentials.IlinkBotId;
        _wechatUin = (wechatUin ?? RandomWechatUin)();
    }

    private readonly string _botId;

    public string BotId => _botId;

    // ── 长轮询 ──────────────────────────────────────────────────────────────

    /// <summary>
    /// 拉取新消息：返回过滤后的用户消息（message_type===1）与轮转后的 get_updates_buf。
    /// ret=-14 抛会话过期；显式非 0 记错误。
    /// </summary>
    public async Task<ILinkGetUpdatesResult> GetUpdatesAsync(string buf = "", CancellationToken cancellationToken = default)
    {
        var body = JsonSerializer.SerializeToElement(new JsonObject
        {
            ["get_updates_buf"] = buf,
            ["base_info"] = new JsonObject { ["channel_version"] = ChannelVersion },
        }, ChannelJson.Compact);
        var data = await DoJsonAsync(HttpMethod.Post, "/ilink/bot/getupdates", body, LongPollTimeout, cancellationToken);
        if (data.ValueKind != JsonValueKind.Object)
        {
            throw new ILinkProtocolException("iLink getupdates 响应不是 JSON 对象");
        }
        var ret = ChannelJsonValue.NumberOrNull(data, "ret");
        if (ret == -14)
        {
            throw new ILinkSessionExpiredException("iLink session expired (ret=-14)");
        }
        if (ret is not null && ret != 0)
        {
            throw new ILinkProtocolException(
                $"iLink getupdates failed: ret={ret} {ChannelJsonValue.OptionalString(data, "errmsg")}");
        }

        var messages = new List<WeixinMessage>();
        if (data.TryGetProperty("msgs", out var msgs) && msgs.ValueKind == JsonValueKind.Array)
        {
            foreach (var wire in msgs.EnumerateArray())
            {
                var messageType = ChannelJsonValue.NumberOrNull(wire, "message_type");
                if (messageType is null || (int)messageType.Value != 1) continue; // 过滤 bot 自身回声
                messages.Add(ToWeixinMessage(wire));
            }
        }
        return new ILinkGetUpdatesResult(messages, ChannelJsonValue.OptionalString(data, "get_updates_buf") ?? "");
    }

    private static WeixinMessage ToWeixinMessage(JsonElement wire)
    {
        var items = wire.TryGetProperty("item_list", out var list) && list.ValueKind == JsonValueKind.Array
            ? list.Clone()
            : default;
        var messageType = ChannelJsonValue.NumberOrNull(wire, "message_type") ?? 0;
        return new WeixinMessage
        {
            MsgId = ChannelJsonValue.StringOrEmpty(wire, "message_id"),
            FromUserId = ChannelJsonValue.OptionalString(wire, "from_user_id") ?? "",
            ToUserId = ChannelJsonValue.OptionalString(wire, "to_user_id") ?? "",
            MsgType = (int)messageType,
            Content = WeChatNormalizer.ExtractText(items),
            Items = items,
            ContextToken = ChannelJsonValue.OptionalString(wire, "context_token") ?? "",
            CreateTimeMs = ChannelJsonValue.NumberOrNull(wire, "create_time_ms"),
            Raw = wire.Clone(),
        };
    }

    // ── 发送 ────────────────────────────────────────────────────────────────

    /// <summary>发文本消息（最常用）。</summary>
    public Task<ILinkSendResult> SendTextAsync(
        string toUserId, string text, string contextToken, CancellationToken cancellationToken = default) =>
        SendMessageAsync(toUserId, [TextItem(text)], contextToken, cancellationToken);

    /// <summary>通用 sendmessage：itemList 为 1 个或多个 item（text/image/voice/file/video）。</summary>
    public Task<ILinkSendResult> SendMessageAsync(
        string toUserId, JsonArray itemList, string contextToken, CancellationToken cancellationToken = default) =>
        SendRequestAsync(BuildSendMessageBody(toUserId, itemList, contextToken), cancellationToken);

    /// <summary>
    /// 发送预构造的 sendmessage 请求体（出站归一化 WeChatNormalizer.BuildSendRequests 的产物）。
    /// 网络/协议错误归一为 Failure（不抛）；ret=-14 抛会话过期；调用方取消时向上抛。
    /// </summary>
    public async Task<ILinkSendResult> SendRequestAsync(JsonElement request, CancellationToken cancellationToken = default)
    {
        try
        {
            var data = await DoJsonAsync(HttpMethod.Post, "/ilink/bot/sendmessage", request, DefaultTimeout, cancellationToken);
            var ret = ChannelJsonValue.NumberOrNull(data, "ret");
            if (ret == -14)
            {
                throw new ILinkSessionExpiredException("session expired on send");
            }
            if (ret is not null && ret != 0)
            {
                return ILinkSendResult.Failure(ChannelJsonValue.OptionalString(data, "errmsg") ?? $"ret={ret}");
            }
            return ILinkSendResult.Success;
        }
        catch (ILinkSessionExpiredException)
        {
            throw;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            return ILinkSendResult.Failure(ex.Message);
        }
    }

    /// <summary>构造 sendmessage 请求体（与桌面 / 契约 fixture 字段级一致）。</summary>
    public static JsonElement BuildSendMessageBody(string toUserId, JsonArray itemList, string contextToken) =>
        JsonSerializer.SerializeToElement(new JsonObject
        {
            ["msg"] = new JsonObject
            {
                ["from_user_id"] = "",
                ["to_user_id"] = toUserId,
                ["client_id"] = Guid.NewGuid().ToString(),
                ["message_type"] = 2,
                ["message_state"] = 2,
                ["context_token"] = contextToken,
                ["item_list"] = itemList,
            },
            ["base_info"] = new JsonObject { ["channel_version"] = ChannelVersion },
        }, ChannelJson.Compact);

    public static JsonObject TextItem(string text) => new()
    {
        ["type"] = 1,
        ["text_item"] = new JsonObject { ["text"] = text },
    };

    // ── 上传 ────────────────────────────────────────────────────────────────

    public async Task<ILinkGetUploadUrlResponse> GetUploadUrlAsync(
        ILinkGetUploadUrlRequest request, CancellationToken cancellationToken = default)
    {
        var node = JsonSerializer.SerializeToNode(request, ChannelJson.Options)!.AsObject();
        node["base_info"] = new JsonObject { ["channel_version"] = ChannelVersion };
        var body = JsonSerializer.SerializeToElement(node, ChannelJson.Compact);
        var data = await DoJsonAsync(HttpMethod.Post, "/ilink/bot/getuploadurl", body, DefaultTimeout, cancellationToken);
        var ret = ChannelJsonValue.NumberOrNull(data, "ret");
        if (ret == -14)
        {
            throw new ILinkSessionExpiredException("session expired on getuploadurl");
        }
        if (ret is not null && ret != 0)
        {
            throw new ILinkProtocolException(
                $"iLink getuploadurl failed: {ChannelJsonValue.OptionalString(data, "errmsg") ?? $"ret={ret}"}");
        }
        return JsonSerializer.Deserialize<ILinkGetUploadUrlResponse>(data.GetRawText(), ChannelJson.Options)
            ?? throw new ILinkProtocolException("iLink getuploadurl 响应解析失败");
    }

    // ── 低层 ────────────────────────────────────────────────────────────────

    private async Task<JsonElement> DoJsonAsync(
        HttpMethod method, string path, JsonElement? body, TimeSpan timeout, CancellationToken cancellationToken)
    {
        try
        {
            using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            linked.CancelAfter(timeout);
            using var request = new HttpRequestMessage(method, _baseUrl + path);
            if (body is not null)
            {
                request.Content = new StringContent(body.Value.GetRawText(), Encoding.UTF8, "application/json");
            }
            AddAuthHeaders(request);
            using var response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, linked.Token);
            var text = await WeChatHttp.ReadLimitedStringAsync(response.Content, MaxResponseBytes, linked.Token);
            if (!response.IsSuccessStatusCode)
            {
                throw new ILinkProtocolException($"HTTP {(int)response.StatusCode} {method} {path}: {Truncate(text)}");
            }
            try
            {
                using var document = JsonDocument.Parse(text);
                return document.RootElement.Clone();
            }
            catch (JsonException)
            {
                throw new ILinkProtocolException($"非 JSON 响应 {method} {path}: {Truncate(text)}");
            }
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            throw new ILinkProtocolException($"{method} {path} 超时（{timeout.TotalSeconds:0}s）");
        }
    }

    private void AddAuthHeaders(HttpRequestMessage request)
    {
        request.Headers.TryAddWithoutValidation("AuthorizationType", "ilink_bot_token");
        request.Headers.TryAddWithoutValidation("Authorization", $"Bearer {_botToken}");
        request.Headers.TryAddWithoutValidation("X-WECHAT-UIN", _wechatUin);
    }

    private static string Truncate(string text) => text.Length <= 200 ? text : text[..200];

    /// <summary>weclaw 口径：随机 uint32 → 十进制字符串 → base64（每次进程随机）。</summary>
    public static string RandomWechatUin()
    {
        var value = Random.Shared.NextInt64(0, 0x1_0000_0000L);
        return Convert.ToBase64String(Encoding.UTF8.GetBytes(value.ToString(CultureInfo.InvariantCulture)));
    }
}

/// <summary>
/// iLink 匿名登录客户端（get_bot_qrcode / get_qrcode_status；无 bot 凭据，仅 X-WECHAT-UIN）。
/// 桌面同流程见 `qr.ts` + `init.ts`（qrcode_img_content 是 liteapp URL，需渲染成二维码）。
/// </summary>
public sealed class ILinkLoginClient
{
    private readonly HttpClient _http;
    private readonly string _baseUrl;
    private readonly string _wechatUin;

    public ILinkLoginClient(HttpClient http, string baseUrl, Func<string>? wechatUin = null)
    {
        _http = http;
        _baseUrl = string.IsNullOrWhiteSpace(baseUrl) ? ILinkProtocolClient.DefaultBaseUrl : baseUrl.TrimEnd('/');
        _wechatUin = (wechatUin ?? ILinkProtocolClient.RandomWechatUin)();
    }

    /// <summary>拿登录二维码（bot_type=3）：qrcode 是轮询 ticket，qrcode_img_content 是 liteapp URL。</summary>
    public async Task<ILinkQrCodeResponse> FetchQrCodeAsync(CancellationToken cancellationToken = default)
    {
        var data = await GetJsonAsync(
            $"{_baseUrl}/ilink/bot/get_bot_qrcode?bot_type=3", cancellationToken);
        var response = JsonSerializer.Deserialize<ILinkQrCodeResponse>(data.GetRawText(), ChannelJson.Options)
            ?? throw new ILinkProtocolException("get_bot_qrcode 响应解析失败");
        if (string.IsNullOrEmpty(response.Qrcode) || string.IsNullOrEmpty(response.QrcodeImgContent))
        {
            throw new ILinkProtocolException("get_bot_qrcode 缺少 qrcode / qrcode_img_content");
        }
        return response;
    }

    /// <summary>轮询扫码状态（上游 long-poll 40s）。</summary>
    public async Task<ILinkQrStatusResponse> PollQrStatusAsync(string qrcode, CancellationToken cancellationToken = default)
    {
        var data = await GetJsonAsync(
            $"{_baseUrl}/ilink/bot/get_qrcode_status?qrcode={Uri.EscapeDataString(qrcode)}", cancellationToken);
        return JsonSerializer.Deserialize<ILinkQrStatusResponse>(data.GetRawText(), ChannelJson.Options)
            ?? throw new ILinkProtocolException("get_qrcode_status 响应解析失败");
    }

    private async Task<JsonElement> GetJsonAsync(string url, CancellationToken cancellationToken)
    {
        try
        {
            using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            linked.CancelAfter(ILinkProtocolClient.LongPollTimeout);
            using var request = new HttpRequestMessage(HttpMethod.Get, url);
            request.Headers.TryAddWithoutValidation("X-WECHAT-UIN", _wechatUin);
            using var response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, linked.Token);
            var text = await WeChatHttp.ReadLimitedStringAsync(response.Content, 4 * 1024 * 1024, linked.Token);
            if (!response.IsSuccessStatusCode)
            {
                throw new ILinkProtocolException($"HTTP {(int)response.StatusCode} GET {url}: {text[..Math.Min(200, text.Length)]}");
            }
            using var document = JsonDocument.Parse(text);
            return document.RootElement.Clone();
        }
        catch (JsonException)
        {
            throw new ILinkProtocolException($"非 JSON 响应 GET {url}");
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            throw new ILinkProtocolException($"GET {url} 超时");
        }
    }
}

/// <summary>服务端自持的 iLink 凭据（扫码登录产物；JSON 存 ChannelStore，AES-GCM）。</summary>
public sealed class ILinkCredentials
{
    [JsonPropertyName("botToken")] public required string BotToken { get; init; }
    [JsonPropertyName("ilinkBotId")] public required string IlinkBotId { get; init; }
    [JsonPropertyName("baseUrl")] public string BaseUrl { get; init; } = ILinkProtocolClient.DefaultBaseUrl;
    [JsonPropertyName("ilinkUserId")] public string IlinkUserId { get; init; } = "";
    [JsonPropertyName("accountId")] public string? AccountId { get; init; }
}

/// <summary>已展开的 iLink 入站消息（与桌面 WeixinMessage 同字段）。</summary>
public sealed class WeixinMessage
{
    public required string MsgId { get; init; }
    public required string FromUserId { get; init; }
    public required string ToUserId { get; init; }
    public required int MsgType { get; init; }
    public required string Content { get; init; }
    public required JsonElement Items { get; init; }
    public required string ContextToken { get; init; }
    public double? CreateTimeMs { get; init; }
    public required JsonElement Raw { get; init; }
}

public sealed record ILinkGetUpdatesResult(List<WeixinMessage> Messages, string Buf);

public sealed record ILinkSendResult(bool Ok, string? Error)
{
    public static ILinkSendResult Success { get; } = new(true, null);
    public static ILinkSendResult Failure(string error) => new(false, error);
}

/// <summary>getuploadurl 请求（wire snake_case）。</summary>
public sealed class ILinkGetUploadUrlRequest
{
    [JsonPropertyName("filekey")] public required string FileKey { get; init; }
    [JsonPropertyName("media_type")] public required int MediaType { get; init; }
    [JsonPropertyName("to_user_id")] public required string ToUserId { get; init; }
    [JsonPropertyName("rawsize")] public required long RawSize { get; init; }
    [JsonPropertyName("rawfilemd5")] public required string RawFileMd5 { get; init; }
    [JsonPropertyName("filesize")] public required long FileSize { get; init; }
    [JsonPropertyName("thumb_rawsize")] public long? ThumbRawSize { get; init; }
    [JsonPropertyName("thumb_rawfilemd5")] public string? ThumbRawFileMd5 { get; init; }
    [JsonPropertyName("thumb_filesize")] public long? ThumbFileSize { get; init; }
    [JsonPropertyName("no_need_thumb")] public bool? NoNeedThumb { get; init; }
    [JsonPropertyName("aeskey")] public string? AesKey { get; init; }
}

public sealed class ILinkGetUploadUrlResponse
{
    [JsonPropertyName("upload_param")] public string? UploadParam { get; init; }
    [JsonPropertyName("thumb_upload_param")] public string? ThumbUploadParam { get; init; }
    [JsonPropertyName("upload_full_url")] public string? UploadFullUrl { get; init; }
}

public sealed class ILinkQrCodeResponse
{
    [JsonPropertyName("qrcode")] public string? Qrcode { get; init; }
    [JsonPropertyName("qrcode_img_content")] public string? QrcodeImgContent { get; init; }
}

public sealed class ILinkQrStatusResponse
{
    [JsonPropertyName("status")] public string? Status { get; init; }
    [JsonPropertyName("bot_token")] public string? BotToken { get; init; }
    [JsonPropertyName("ilink_bot_id")] public string? IlinkBotId { get; init; }
    [JsonPropertyName("baseurl")] public string? BaseUrl { get; init; }
    [JsonPropertyName("ilink_user_id")] public string? IlinkUserId { get; init; }
}

/// <summary>会话过期（ret=-14）：停轮询、状态 error、等待人工重登；不重试（重试无意义）。</summary>
public sealed class ILinkSessionExpiredException : Exception
{
    public ILinkSessionExpiredException(string message) : base(message) { }
}

/// <summary>iLink 协议/HTTP 层错误（非会话过期）。</summary>
public sealed class ILinkProtocolException : Exception
{
    public ILinkProtocolException(string message) : base(message) { }
}

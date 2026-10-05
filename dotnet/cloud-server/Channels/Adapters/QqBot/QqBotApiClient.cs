using System.Globalization;
using System.Text;
using System.Text.Json;
using CyreneNative.Channels;
using CyreneNative.Channels.Normalizers;

namespace CyreneCloud.Channels.Adapters.QqBot;

/// <summary>QQ 开放平台 API 错误（错误消息不含凭据；code 为上游业务码）。</summary>
public sealed class QqBotApiException : Exception
{
    public QqBotApiException(string message, int status, string? code = null) : base(message)
    {
        Status = status;
        Code = code;
    }

    public int Status { get; }
    public string? Code { get; }
}

/// <summary>被动回复目标：private = 用户 openid；group = 群 openid。</summary>
public sealed class QqBotSendTarget
{
    public required string OpenId { get; init; }
    public string ChatType { get; init; } = ChannelChatTypes.Private;
}

/// <summary>
/// QQ 官方机器人（QQ 开放平台 API v2）REST 客户端（TS `qqbot-api-client.ts` 的 C# 移植）。
///
/// 职责：
///   1) access_token 生命周期管理（getAppAccessToken + 过期前 5 分钟刷新 + 并发去重）
///   2) 被动回复消息发送（/v2/users/{openid}/messages 与 /v2/groups/{group_openid}/messages）
///   3) 网关地址查询（GET /gateway）
///
/// 协议要点：token 端点 POST {appId, clientSecret} → {access_token, expires_in}（秒，一般 7200）；
/// 业务 API 头 `Authorization: QQBot &lt;token&gt;`；2025-04-21 后官方停止主动推送，
/// 所有发送必须携带 msg_id（被动回复）。
/// </summary>
public sealed class QqBotApiClient : IDisposable
{
    public const string DefaultTokenUrl = "https://bots.qq.com/app/getAppAccessToken";
    public const string DefaultApiBase = "https://api.sgroup.qq.com";

    private static readonly TimeSpan TokenRefreshMargin = TimeSpan.FromMinutes(5);

    private readonly string _appId;
    private readonly string _appSecret;
    private readonly HttpClient _http;
    private readonly bool _ownsHttp;
    private readonly string _apiBase;
    private readonly string _tokenUrl;
    private readonly TimeProvider _time;
    private readonly SemaphoreSlim _tokenGate = new(1, 1);

    private string _token = "";
    private DateTimeOffset _tokenExpiresAt;

    public QqBotApiClient(
        string appId,
        string appSecret,
        HttpClient? httpClient = null,
        string? apiBase = null,
        string? tokenUrl = null,
        TimeProvider? timeProvider = null)
    {
        _appId = appId;
        _appSecret = appSecret;
        _ownsHttp = httpClient is null;
        _http = httpClient ?? new HttpClient();
        _apiBase = (apiBase ?? DefaultApiBase).TrimEnd('/');
        _tokenUrl = tokenUrl ?? DefaultTokenUrl;
        _time = timeProvider ?? TimeProvider.System;
    }

    /// <summary>拿一个有效 token（过期前 5 分钟自动刷新；并发调用共享同一次刷新）。</summary>
    public async Task<string> GetAccessTokenAsync(CancellationToken cancellationToken = default)
    {
        if (HasValidToken()) return _token;
        await _tokenGate.WaitAsync(cancellationToken);
        try
        {
            if (HasValidToken()) return _token;
            await RefreshTokenAsync(cancellationToken);
            return _token;
        }
        finally
        {
            _tokenGate.Release();
        }
    }

    private bool HasValidToken() =>
        _token.Length > 0 && _time.GetUtcNow() < _tokenExpiresAt - TokenRefreshMargin;

    private async Task RefreshTokenAsync(CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, _tokenUrl)
        {
            Content = new StringContent(
                JsonSerializer.Serialize(new Dictionary<string, string>
                {
                    ["appId"] = _appId,
                    ["clientSecret"] = _appSecret,
                }),
                Encoding.UTF8,
                "application/json"),
        };
        using var response = await _http.SendAsync(request, cancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            throw new QqBotApiException(
                $"获取 access_token 失败 (HTTP {(int)response.StatusCode})", (int)response.StatusCode);
        }
        var body = await response.Content.ReadAsStringAsync(cancellationToken);
        using var document = JsonDocument.Parse(body);
        var root = document.RootElement;
        var token = root.TryGetProperty("access_token", out var tokenElement) && tokenElement.ValueKind == JsonValueKind.String
            ? tokenElement.GetString()
            : null;
        if (string.IsNullOrEmpty(token))
        {
            throw new QqBotApiException("access_token 响应缺少 access_token", 200);
        }
        var expiresInSeconds = 7200d;
        if (root.TryGetProperty("expires_in", out var expiresElement))
        {
            expiresInSeconds = expiresElement.ValueKind switch
            {
                JsonValueKind.Number when expiresElement.TryGetDouble(out var number) => number,
                JsonValueKind.String when double.TryParse(
                    expiresElement.GetString(), NumberStyles.Float, CultureInfo.InvariantCulture, out var parsed) => parsed,
                _ => 7200d,
            };
            if (!double.IsFinite(expiresInSeconds) || expiresInSeconds <= 0) expiresInSeconds = 7200d;
        }
        _token = token;
        _tokenExpiresAt = _time.GetUtcNow().AddSeconds(expiresInSeconds);
    }

    /// <summary>查询 WebSocket 网关地址。</summary>
    public async Task<string> GetGatewayUrlAsync(CancellationToken cancellationToken = default)
    {
        using var document = await RequestAsync(HttpMethod.Get, "/gateway", content: null, cancellationToken);
        var url = document.RootElement.TryGetProperty("url", out var urlElement) && urlElement.ValueKind == JsonValueKind.String
            ? urlElement.GetString()
            : null;
        if (string.IsNullOrEmpty(url))
        {
            throw new QqBotApiException("gateway 响应缺少 url", 200);
        }
        return url;
    }

    /// <summary>
    /// 被动回复一条文本消息（msg_type 0）。请求体由 core Normalizer 构造
    /// （QqBotNormalizer.BuildPassiveReplies），字段与 fixtures 逐字一致。
    /// </summary>
    public async Task SendTextAsync(
        QqBotSendTarget target, QqBotReplyRequest request, CancellationToken cancellationToken = default)
    {
        var path = target.ChatType == ChannelChatTypes.Group
            ? $"/v2/groups/{Uri.EscapeDataString(target.OpenId)}/messages"
            : $"/v2/users/{Uri.EscapeDataString(target.OpenId)}/messages";
        using var _ = await RequestAsync(
            HttpMethod.Post, path, JsonSerializer.Serialize(request, ChannelJson.Compact), cancellationToken);
    }

    private async Task<JsonDocument> RequestAsync(
        HttpMethod method, string path, string? content, CancellationToken cancellationToken)
    {
        var token = await GetAccessTokenAsync(cancellationToken);
        using var request = new HttpRequestMessage(method, $"{_apiBase}{path}");
        request.Headers.TryAddWithoutValidation("Authorization", $"QQBot {token}");
        if (content is not null)
        {
            request.Content = new StringContent(content, Encoding.UTF8, "application/json");
        }
        using var response = await _http.SendAsync(request, cancellationToken);
        var body = await response.Content.ReadAsStringAsync(cancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            string? code = null;
            string? detail = null;
            try
            {
                using var errorDocument = JsonDocument.Parse(body);
                var root = errorDocument.RootElement;
                if (root.TryGetProperty("code", out var codeElement))
                {
                    code = codeElement.ValueKind == JsonValueKind.String ? codeElement.GetString() : codeElement.GetRawText();
                }
                if (root.TryGetProperty("message", out var messageElement) && messageElement.ValueKind == JsonValueKind.String)
                {
                    detail = messageElement.GetString();
                }
            }
            catch (JsonException)
            {
                // 非 JSON 错误体：忽略
            }
            var suffix = detail is null ? "" : $" {detail} (code {code ?? "-"})";
            throw new QqBotApiException(
                $"QQ Bot API {path} 失败 (HTTP {(int)response.StatusCode}){suffix}",
                (int)response.StatusCode,
                code);
        }
        return string.IsNullOrWhiteSpace(body) ? JsonDocument.Parse("{}") : JsonDocument.Parse(body);
    }

    public void Dispose()
    {
        _tokenGate.Dispose();
        if (_ownsHttp) _http.Dispose();
    }
}

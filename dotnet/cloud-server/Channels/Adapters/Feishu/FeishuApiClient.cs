using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using CyreneNative.Channels.Normalizers;

namespace CyreneCloud.Channels.Adapters.Feishu;

/// <summary>飞书 OpenAPI 调用失败（只带错误码/短消息，不含凭据与正文）。</summary>
public sealed class FeishuApiException : Exception
{
    public string ErrorCode { get; }

    /// <summary>飞书响应体 code（HTTP 层失败时为 null）。</summary>
    public int? ApiCode { get; }

    public FeishuApiException(string errorCode, string message, int? apiCode = null) : base(message)
    {
        ErrorCode = errorCode;
        ApiCode = apiCode;
    }
}

/// <summary>
/// 飞书最小 REST 客户端（§6.1 决策：不引入社区 SDK；纯 HttpClient + 手写 JSON）。
///
/// 覆盖：tenant_access_token 缓存（过期前 5 分钟刷新、并发去重）、
/// im/v1/messages 发送、im/v1/images / im/v1/files 上传、im/v1/messages/{id}/resources/{key} 下载。
/// 构造函数可注入 <see cref="HttpMessageHandler"/>（单测/回放零网络）；
/// baseUrl 可经 <see cref="BaseUrlEnv"/> 指向 mock 上游（channel-smoke）。
/// </summary>
public sealed class FeishuApiClient : IDisposable
{
    public const string DefaultBaseUrl = "https://open.feishu.cn";
    public const string BaseUrlEnv = "CLOUD_CHANNEL_FEISHU_BASE_URL";

    private static readonly TimeSpan TokenRefreshMargin = TimeSpan.FromMinutes(5);

    /// <summary>媒体下载传输超时（含响应体读取；测试可注入更短值）。</summary>
    public static readonly TimeSpan DefaultTransferTimeout = TimeSpan.FromSeconds(60);

    private readonly HttpClient _http;
    private readonly bool _ownsHandler;
    private readonly string _baseUrl;
    private readonly string? _appId;
    private readonly string? _appSecret;
    private readonly TimeProvider _clock;
    private readonly TimeSpan _transferTimeout;
    private readonly ILogger<FeishuApiClient>? _logger;
    private readonly SemaphoreSlim _tokenGate = new(1, 1);
    private string? _token;
    private DateTimeOffset _tokenExpiresAt = DateTimeOffset.MinValue;
    private bool _disposed;

    public FeishuApiClient(
        string? appId,
        string? appSecret,
        HttpMessageHandler? handler = null,
        string? baseUrl = null,
        TimeProvider? clock = null,
        ILogger<FeishuApiClient>? logger = null,
        TimeSpan? transferTimeout = null)
    {
        _appId = string.IsNullOrWhiteSpace(appId) ? null : appId.Trim();
        _appSecret = string.IsNullOrWhiteSpace(appSecret) ? null : appSecret.Trim();
        _baseUrl = (baseUrl
            ?? Environment.GetEnvironmentVariable(BaseUrlEnv)
            ?? DefaultBaseUrl).TrimEnd('/');
        _ownsHandler = handler is null;
        _http = new HttpClient(handler ?? new HttpClientHandler(), disposeHandler: _ownsHandler)
        {
            Timeout = TimeSpan.FromSeconds(30),
        };
        _clock = clock ?? TimeProvider.System;
        _transferTimeout = transferTimeout ?? DefaultTransferTimeout;
        _logger = logger;
    }

    public bool Configured => _appId is not null && _appSecret is not null;

    public string BaseUrl => _baseUrl;

    // ── 凭据 ─────────────────────────────────────────────────────────────────

    /// <summary>tenant_access_token：缓存至过期前 5 分钟；并发刷新由信号量去重。</summary>
    public async Task<string> GetTenantAccessTokenAsync(CancellationToken cancellationToken = default)
    {
        if (!Configured)
        {
            throw new FeishuApiException("E_FEISHU_CONFIG_MISSING", "飞书 App ID / App Secret 未配置");
        }
        if (IsTokenValid()) return _token!;

        await _tokenGate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            if (IsTokenValid()) return _token!;
            var payload = JsonSerializer.Serialize(new { app_id = _appId, app_secret = _appSecret });
            using var request = new HttpRequestMessage(
                HttpMethod.Post, $"{_baseUrl}/open-apis/auth/v3/tenant_access_token/internal")
            {
                Content = new StringContent(payload, Encoding.UTF8, "application/json"),
            };
            using var response = await _http.SendAsync(request, cancellationToken).ConfigureAwait(false);
            var root = await ReadJsonAsync(response, cancellationToken).ConfigureAwait(false);
            var token = OptionalDataString(root, null, "tenant_access_token");
            if (string.IsNullOrEmpty(token))
            {
                throw new FeishuApiException("E_FEISHU_TOKEN_EMPTY", "tenant_access_token 为空");
            }
            var expireSeconds = root.TryGetProperty("expire", out var expire)
                && expire.ValueKind == JsonValueKind.Number && expire.TryGetInt32(out var seconds)
                ? seconds
                : 7200;
            _token = token;
            _tokenExpiresAt = _clock.GetUtcNow().AddSeconds(expireSeconds);
            _logger?.LogDebug("飞书 tenant_access_token 已刷新 expireSeconds={ExpireSeconds}", expireSeconds);
            return token;
        }
        finally
        {
            _tokenGate.Release();
        }
    }

    private bool IsTokenValid() =>
        _token is not null && _clock.GetUtcNow() < _tokenExpiresAt - TokenRefreshMargin;

    // ── 发送 ─────────────────────────────────────────────────────────────────

    /// <summary>im/v1/messages 发送一条消息；返回平台 message_id（可能为 null）。</summary>
    public async Task<string?> SendMessageAsync(
        string receiveIdType, FeishuSendRequest request, CancellationToken cancellationToken = default)
    {
        var body = JsonSerializer.Serialize(new
        {
            receive_id = request.ReceiveId,
            msg_type = request.MsgType,
            content = request.Content,
        });
        var url = $"{_baseUrl}/open-apis/im/v1/messages?receive_id_type={Uri.EscapeDataString(receiveIdType)}";
        using var response = await SendAuthorizedAsync(HttpMethod.Post, url, body, cancellationToken).ConfigureAwait(false);
        var root = await ReadJsonAsync(response, cancellationToken).ConfigureAwait(false);
        return OptionalDataString(root, "data", "message_id");
    }

    // ── 上传 ─────────────────────────────────────────────────────────────────

    /// <summary>im/v1/images 上传消息图片（image_type=message）→ image_key。</summary>
    public async Task<string> UploadImageAsync(string filePath, CancellationToken cancellationToken = default)
    {
        var bytes = await File.ReadAllBytesAsync(filePath, cancellationToken).ConfigureAwait(false);
        using var content = new MultipartFormDataContent();
        content.Add(new StringContent("message"), "image_type");
        content.Add(new ByteArrayContent(bytes), "image", Path.GetFileName(filePath));
        var root = await SendMultipartAsync($"{_baseUrl}/open-apis/im/v1/images", content, cancellationToken)
            .ConfigureAwait(false);
        var key = OptionalDataString(root, "data", "image_key");
        if (string.IsNullOrEmpty(key))
        {
            throw new FeishuApiException("E_FEISHU_IMAGE_KEY", "上传图片未返回 image_key");
        }
        return key;
    }

    /// <summary>im/v1/files 上传文件 → file_key。fileType: opus / mp4 / pdf / stream 等。</summary>
    public async Task<string> UploadFileAsync(
        string filePath, string fileName, string fileType, long? durationMs = null,
        CancellationToken cancellationToken = default)
    {
        var bytes = await File.ReadAllBytesAsync(filePath, cancellationToken).ConfigureAwait(false);
        using var content = new MultipartFormDataContent();
        content.Add(new StringContent(fileType), "file_type");
        content.Add(new StringContent(fileName), "file_name");
        if (durationMs is > 0)
        {
            content.Add(new StringContent(durationMs.Value.ToString()), "duration");
        }
        content.Add(new ByteArrayContent(bytes), "file", fileName);
        var root = await SendMultipartAsync($"{_baseUrl}/open-apis/im/v1/files", content, cancellationToken)
            .ConfigureAwait(false);
        var key = OptionalDataString(root, "data", "file_key");
        if (string.IsNullOrEmpty(key))
        {
            throw new FeishuApiException("E_FEISHU_FILE_KEY", "上传文件未返回 file_key");
        }
        return key;
    }

    // ── 下载（入站媒体）──────────────────────────────────────────────────────

    /// <summary>
    /// im/v1/messages/{message_id}/resources/{file_key} 流式落盘（≤ maxBytes，超出即中止删除）。
    /// resourceType: image | file（音频/视频/文件均按 file 下载，与桌面实现一致）。
    /// </summary>
    public async Task<long> DownloadResourceAsync(
        string messageId, string fileKey, string resourceType, string destPath, long maxBytes,
        CancellationToken cancellationToken = default)
    {
        var url = $"{_baseUrl}/open-apis/im/v1/messages/{Uri.EscapeDataString(messageId)}"
            + $"/resources/{Uri.EscapeDataString(fileKey)}?type={Uri.EscapeDataString(resourceType)}";
        // ResponseHeadersRead 下 HttpClient.Timeout 只覆盖到响应头（后台路径还常传 CancellationToken.None），
        // 上游发头后卡住会无限悬挂：比照 WeChatCdnClient 用 linked CTS 兜住整个传输（含响应体读取）。
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        linked.CancelAfter(_transferTimeout);
        try
        {
            var token = await GetTenantAccessTokenAsync(linked.Token).ConfigureAwait(false);
            using var request = new HttpRequestMessage(HttpMethod.Get, url);
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            using var response = await _http
                .SendAsync(request, HttpCompletionOption.ResponseHeadersRead, linked.Token).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
            {
                var text = await response.Content.ReadAsStringAsync(linked.Token).ConfigureAwait(false);
                throw new FeishuApiException(
                    $"E_FEISHU_HTTP_{(int)response.StatusCode}", Truncate(text, 200));
            }
            var declared = response.Content.Headers.ContentLength;
            if (declared is > 0 && declared.Value > maxBytes)
            {
                throw new FeishuApiException("E_FEISHU_MEDIA_TOO_LARGE", $"媒体超过上限 {maxBytes} 字节");
            }

            var dir = Path.GetDirectoryName(destPath);
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
            long total = 0;
            await using var source = await response.Content.ReadAsStreamAsync(linked.Token).ConfigureAwait(false);
            await using var target = File.Create(destPath);
            var buffer = new byte[81920];
            int read;
            while ((read = await source.ReadAsync(buffer, linked.Token).ConfigureAwait(false)) > 0)
            {
                total += read;
                if (total > maxBytes)
                {
                    throw new FeishuApiException("E_FEISHU_MEDIA_TOO_LARGE", $"媒体超过上限 {maxBytes} 字节");
                }
                await target.WriteAsync(buffer.AsMemory(0, read), linked.Token).ConfigureAwait(false);
            }
            TryHardenFile(destPath);
            return total;
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            TryDelete(destPath);
            throw new FeishuApiException(
                "E_FEISHU_MEDIA_TIMEOUT", $"媒体下载超时（{_transferTimeout.TotalSeconds:0}s）");
        }
        catch
        {
            TryDelete(destPath);
            throw;
        }
    }

    // ── HTTP 辅助 ────────────────────────────────────────────────────────────

    private async Task<HttpResponseMessage> SendAuthorizedAsync(
        HttpMethod method, string url, string jsonBody, CancellationToken cancellationToken)
    {
        var token = await GetTenantAccessTokenAsync(cancellationToken).ConfigureAwait(false);
        var request = new HttpRequestMessage(method, url)
        {
            Content = new StringContent(jsonBody, Encoding.UTF8, "application/json"),
        };
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        return await _http.SendAsync(request, cancellationToken).ConfigureAwait(false);
    }

    private async Task<JsonElement> SendMultipartAsync(
        string url, HttpContent content, CancellationToken cancellationToken)
    {
        var token = await GetTenantAccessTokenAsync(cancellationToken).ConfigureAwait(false);
        using var request = new HttpRequestMessage(HttpMethod.Post, url) { Content = content };
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        using var response = await _http.SendAsync(request, cancellationToken).ConfigureAwait(false);
        return await ReadJsonAsync(response, cancellationToken).ConfigureAwait(false);
    }

    /// <summary>解析 JSON 响应：HTTP 失败或 body code≠0 → FeishuApiException（错误码 E_FEISHU_&lt;code&gt;）。</summary>
    private static async Task<JsonElement> ReadJsonAsync(HttpResponseMessage response, CancellationToken cancellationToken)
    {
        var text = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
        JsonElement root;
        try
        {
            using var document = JsonDocument.Parse(text);
            root = document.RootElement.Clone();
        }
        catch (JsonException)
        {
            throw new FeishuApiException(
                $"E_FEISHU_HTTP_{(int)response.StatusCode}", $"非 JSON 响应: {Truncate(text, 120)}");
        }
        var code = root.TryGetProperty("code", out var codeElement)
            && codeElement.ValueKind == JsonValueKind.Number
            && codeElement.TryGetInt32(out var parsed)
            ? parsed
            : 0;
        if (!response.IsSuccessStatusCode || code != 0)
        {
            var message = root.TryGetProperty("msg", out var msgElement)
                ? msgElement.GetString() ?? ""
                : "";
            // HTTP 层失败优先报 HTTP 状态（body 可能是网关/反代的非业务错误体）
            var errorCode = !response.IsSuccessStatusCode
                ? $"E_FEISHU_HTTP_{(int)response.StatusCode}"
                : $"E_FEISHU_{code}";
            throw new FeishuApiException(
                errorCode, Truncate(message, 200), code != 0 ? code : null);
        }
        return root;
    }

    private static string? OptionalDataString(JsonElement root, string? dataProperty, string name)
    {
        var scope = root;
        if (dataProperty is not null)
        {
            if (!root.TryGetProperty(dataProperty, out var data) || data.ValueKind != JsonValueKind.Object)
            {
                return null;
            }
            scope = data;
        }
        return scope.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;
    }

    private static string Truncate(string value, int max) =>
        value.Length <= max ? value : value[..max] + "…";

    private static void TryDelete(string path)
    {
        try
        {
            if (File.Exists(path)) File.Delete(path);
        }
        catch
        {
            // best-effort 清理
        }
    }

    private static void TryHardenFile(string path)
    {
        if (!OperatingSystem.IsLinux()) return;
        try
        {
            File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        }
        catch
        {
            // best-effort（进程 umask 0077 已兜底）
        }
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _tokenGate.Dispose();
        _http.Dispose();
    }
}

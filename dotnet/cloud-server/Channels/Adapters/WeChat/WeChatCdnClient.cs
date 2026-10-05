using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using CyreneNative.Channels;
using CyreneNative.Channels.Normalizers;

namespace CyreneCloud.Channels.Adapters.WeChat;

/// <summary>iLink 媒体类型（wire media_type）。</summary>
public static class WeChatMediaTypes
{
    public const int Image = 1;
    public const int Video = 2;
    public const int File = 3;
    public const int Voice = 4;
}

/// <summary>
/// iLink CDN 媒体客户端（桌面 `wechat-media-upload.ts` / `wechat-media-download.ts` 的移植）。
///
/// 上传：AES-128-ECB 加密 → getuploadurl（filekey/rawsize/rawfilemd5/filesize/aeskey）→
/// CDN `POST /c2c/upload`（x-encrypted-param 响应头）；下载：`GET /c2c/download?encrypted_query_param=`，
/// aes_key 支持 hex / base64 / 双层 hex，encrypt_type===0 时不解密。全部走注入的 HttpClient（测试 mock）；
/// CDN GET/POST 用 linked CTS 限时（默认 60s），连接挂起不会无限期阻塞长轮询。
/// </summary>
public sealed class WeChatCdnClient
{
    public const string DefaultBaseUrl = "https://novac2c.cdn.weixin.qq.com/c2c";

    /// <summary>CDN 传输超时（含连接与响应体读取；测试可注入更短值）。</summary>
    public static readonly TimeSpan DefaultTransferTimeout = TimeSpan.FromSeconds(60);

    private readonly HttpClient _http;
    private readonly string _baseUrl;
    private readonly TimeSpan _transferTimeout;

    public WeChatCdnClient(HttpClient http, string? baseUrl = null, TimeSpan? transferTimeout = null)
    {
        _http = http;
        _baseUrl = string.IsNullOrWhiteSpace(baseUrl) ? DefaultBaseUrl : baseUrl.TrimEnd('/');
        _transferTimeout = transferTimeout ?? DefaultTransferTimeout;
    }

    // ── 下载 ────────────────────────────────────────────────────────────────

    public async Task<byte[]> DownloadAsync(
        WeChatCdnMedia media, long maxBytes, CancellationToken cancellationToken = default)
    {
        var encryptQueryParam = media.EncryptQueryParam.Trim();
        if (encryptQueryParam.Length == 0)
        {
            throw new WeChatCdnException("missing WeChat encrypted query param");
        }
        var key = DecodeAesKey(media.AesKey);
        var url = $"{_baseUrl}/download?encrypted_query_param={Uri.EscapeDataString(encryptQueryParam)}";
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        linked.CancelAfter(_transferTimeout);
        try
        {
            using var response = await _http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, linked.Token);
            if (!response.IsSuccessStatusCode)
            {
                var message = await SafeReadAsync(response, linked.Token);
                throw new WeChatCdnException($"CDN download failed: HTTP {(int)response.StatusCode} {Truncate(message)}");
            }
            var encrypted = await WeChatHttp.ReadLimitedBytesAsync(response.Content, maxBytes, linked.Token);
            return media.EncryptType == 0 ? encrypted : DecryptEcb(encrypted, key);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            throw new WeChatCdnException($"CDN 下载超时（{_transferTimeout.TotalSeconds:0}s）");
        }
    }

    // ── 上传 ────────────────────────────────────────────────────────────────

    /// <summary>上传字节并返回 CDNMedia；aesKey/fileKey 可注入（测试确定性）。</summary>
    public async Task<WeChatCdnMedia> UploadAsync(
        ILinkProtocolClient client,
        string toUserId,
        byte[] data,
        int mediaType,
        CancellationToken cancellationToken = default,
        byte[]? aesKey = null,
        string? fileKey = null)
    {
        var key = aesKey ?? RandomNumberGenerator.GetBytes(16);
        if (key.Length != 16)
        {
            throw new ArgumentException($"AES key 必须 16 字节，实际 {key.Length}", nameof(aesKey));
        }
        var filekey = fileKey ?? Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant();
        var ciphertext = EncryptEcb(data, key);
        var uploadParams = await client.GetUploadUrlAsync(new ILinkGetUploadUrlRequest
        {
            FileKey = filekey,
            MediaType = mediaType,
            ToUserId = toUserId,
            RawSize = data.LongLength,
            RawFileMd5 = Convert.ToHexString(MD5.HashData(data)).ToLowerInvariant(),
            FileSize = ciphertext.LongLength,
            NoNeedThumb = true,
            AesKey = Convert.ToHexString(key).ToLowerInvariant(),
        }, cancellationToken);

        var uploadFullUrl = uploadParams.UploadFullUrl?.Trim();
        if (string.IsNullOrEmpty(uploadFullUrl) && string.IsNullOrEmpty(uploadParams.UploadParam))
        {
            throw new WeChatCdnException("getuploadurl returned no upload URL");
        }
        var uploadUrl = !string.IsNullOrEmpty(uploadFullUrl)
            ? uploadFullUrl
            : $"{_baseUrl}/upload?encrypted_query_param={Uri.EscapeDataString(uploadParams.UploadParam!)}" +
              $"&filekey={Uri.EscapeDataString(filekey)}";

        using var content = new ByteArrayContent(ciphertext);
        content.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        linked.CancelAfter(_transferTimeout);
        try
        {
            using var response = await _http.PostAsync(uploadUrl, content, linked.Token);
            if (!response.IsSuccessStatusCode)
            {
                var errorMessage = response.Headers.TryGetValues("x-error-message", out var values)
                    ? values.FirstOrDefault()
                    : null;
                throw new WeChatCdnException($"CDN upload failed: {errorMessage ?? $"HTTP {(int)response.StatusCode}"}");
            }
            if (!response.Headers.TryGetValues("x-encrypted-param", out var paramValues)
                || string.IsNullOrEmpty(paramValues.FirstOrDefault()))
            {
                throw new WeChatCdnException("CDN upload response missing x-encrypted-param header");
            }
            return new WeChatCdnMedia
            {
                EncryptQueryParam = paramValues.First()!,
                AesKey = EncodeAesKeyBase64(key),
                EncryptType = 1,
            };
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            throw new WeChatCdnException($"CDN 上传超时（{_transferTimeout.TotalSeconds:0}s）");
        }
    }

    /// <summary>读文件上传（大小超限在读取前拒绝，避免大文件进内存）。</summary>
    public async Task<WeChatCdnMedia> UploadFileAsync(
        ILinkProtocolClient client,
        string toUserId,
        string filePath,
        int mediaType,
        long maxBytes,
        CancellationToken cancellationToken = default)
    {
        var info = new FileInfo(filePath);
        if (!info.Exists)
        {
            throw new WeChatCdnException($"文件不存在: {Path.GetFileName(filePath)}");
        }
        if (info.Length > maxBytes)
        {
            throw new WeChatMediaTooLargeException(maxBytes);
        }
        var data = await File.ReadAllBytesAsync(filePath, cancellationToken);
        return await UploadAsync(client, toUserId, data, mediaType, cancellationToken);
    }

    // ── AES / 密钥格式 ──────────────────────────────────────────────────────

    /// <summary>hex(32) → 16 字节；base64 → 16 字节；base64 解出 hex(32) 文本 → 再 hex 解码。</summary>
    public static byte[] DecodeAesKey(string value)
    {
        var raw = value.Trim();
        if (IsHex32(raw))
        {
            return Convert.FromHexString(raw);
        }
        byte[] decoded;
        try
        {
            decoded = Convert.FromBase64String(raw);
        }
        catch (FormatException)
        {
            decoded = [];
        }
        if (decoded.Length == 16)
        {
            return decoded;
        }
        var decodedText = Encoding.UTF8.GetString(decoded);
        if (IsHex32(decodedText))
        {
            return Convert.FromHexString(decodedText);
        }
        throw new WeChatCdnException("unsupported WeChat AES key format");
    }

    public static byte[] DecryptEcb(byte[] data, byte[] key)
    {
        if (key.Length != 16) throw new WeChatCdnException($"AES key must be 16 bytes, got {key.Length}");
        using var aes = Aes.Create();
        aes.Key = key;
        aes.Mode = CipherMode.ECB;
        aes.Padding = PaddingMode.PKCS7;
        using var decryptor = aes.CreateDecryptor();
        return decryptor.TransformFinalBlock(data, 0, data.Length);
    }

    public static byte[] EncryptEcb(byte[] data, byte[] key)
    {
        if (key.Length != 16) throw new WeChatCdnException($"AES key must be 16 bytes, got {key.Length}");
        using var aes = Aes.Create();
        aes.Key = key;
        aes.Mode = CipherMode.ECB;
        aes.Padding = PaddingMode.PKCS7;
        using var encryptor = aes.CreateEncryptor();
        return encryptor.TransformFinalBlock(data, 0, data.Length);
    }

    /// <summary>与桌面 encodeAesKeyBase64 一致：hex 文本的 base64（不是 key 字节的 base64）。</summary>
    public static string EncodeAesKeyBase64(byte[] key) =>
        Convert.ToBase64String(Encoding.UTF8.GetBytes(Convert.ToHexString(key).ToLowerInvariant()));

    private static bool IsHex32(string value) =>
        value.Length == 32 && value.All(character =>
            character is >= '0' and <= '9' or >= 'a' and <= 'f' or >= 'A' and <= 'F');

    private static async Task<string> SafeReadAsync(HttpResponseMessage response, CancellationToken cancellationToken)
    {
        try
        {
            return await response.Content.ReadAsStringAsync(cancellationToken);
        }
        catch
        {
            return "";
        }
    }

    private static string Truncate(string text) => text.Length <= 120 ? text : text[..120];
}

/// <summary>CDN/媒体协议错误（非会话过期）。</summary>
public sealed class WeChatCdnException : Exception
{
    public WeChatCdnException(string message) : base(message) { }
}

/// <summary>媒体超过大小上限（入站 10/20MB 分档、出站单请求上限）。</summary>
public sealed class WeChatMediaTooLargeException : Exception
{
    public WeChatMediaTooLargeException(long maxBytes)
        : base($"媒体超过大小上限（{maxBytes / 1024 / 1024}MB）")
    {
        MaxBytes = maxBytes;
    }

    public long MaxBytes { get; }
}

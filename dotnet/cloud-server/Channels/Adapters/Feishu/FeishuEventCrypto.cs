using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace CyreneCloud.Channels.Adapters.Feishu;

/// <summary>
/// 飞书 webhook 安全校验（设计 §6.2）：
///
/// 1. Verification Token 定长比较（<see cref="VerifyToken"/>）；
/// 2. 签名校验 <c>sha256(timestamp + nonce + encryptKey + rawBody)</c>（官方文档算法）；
/// 3. 时间戳新鲜度 ±5 分钟（防重放）；
/// 4. 加密事件 AES-256-CBC 解密：key = SHA-256(EncryptKey)、IV = 密文前 16 字节（PKCS7）。
///
/// 官方测试向量：<c>Decrypt("P37w+VZImNgPEO1RBhJ6RtKl7n6zymIbEG1pReEzghk=", "test key") == "hello world"</c>
/// （飞书开放平台「步骤三：接收事件」示例，见 FeishuSelfTest 与 fixtures/channels/feishu-webhook/）。
/// </summary>
public sealed class FeishuEventCrypto
{
    public const string ErrorConfig = "E_FEISHU_CONFIG";
    public const string ErrorTimestamp = "E_FEISHU_TIMESTAMP";
    public const string ErrorSignature = "E_FEISHU_SIGNATURE";
    public const string ErrorToken = "E_FEISHU_TOKEN";
    public const string ErrorDecrypt = "E_FEISHU_DECRYPT";
    public const string ErrorEncryptKeyMissing = "E_FEISHU_ENCRYPT_KEY_MISSING";

    /// <summary>时间戳新鲜度窗口（§6.2：±5 分钟）。</summary>
    public static readonly TimeSpan DefaultMaxSkew = TimeSpan.FromMinutes(5);

    private readonly string _verificationToken;
    private readonly string? _encryptKey;
    private readonly TimeProvider _clock;
    private readonly TimeSpan _maxSkew;

    public FeishuEventCrypto(
        string? verificationToken,
        string? encryptKey,
        TimeProvider? clock = null,
        TimeSpan? maxSkew = null)
    {
        _verificationToken = verificationToken ?? "";
        _encryptKey = string.IsNullOrEmpty(encryptKey) ? null : encryptKey;
        _clock = clock ?? TimeProvider.System;
        _maxSkew = maxSkew ?? DefaultMaxSkew;
    }

    /// <summary>Verification Token 或 Encrypt Key 至少配置一项，否则无法校验任何请求。</summary>
    public bool Configured => _verificationToken.Length > 0 || _encryptKey is not null;

    public bool HasVerificationToken => _verificationToken.Length > 0;

    public bool HasEncryptKey => _encryptKey is not null;

    /// <summary>Verification Token 定长比较；空配置/空入参一律 false（防「空 token 放行」）。</summary>
    public bool VerifyToken(string? token)
    {
        if (_verificationToken.Length == 0 || string.IsNullOrEmpty(token)) return false;
        var expected = Encoding.UTF8.GetBytes(_verificationToken);
        var actual = Encoding.UTF8.GetBytes(token);
        try
        {
            return CryptographicOperations.FixedTimeEquals(expected, actual);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(actual);
        }
    }

    /// <summary>请求时间戳（Unix 秒）是否落在 ±maxSkew 窗口内。</summary>
    public bool IsTimestampFresh(string? timestamp)
    {
        if (!long.TryParse(timestamp, NumberStyles.Integer, CultureInfo.InvariantCulture, out var seconds))
        {
            return false;
        }
        var at = DateTimeOffset.FromUnixTimeSeconds(seconds);
        return (_clock.GetUtcNow() - at).Duration() <= _maxSkew;
    }

    /// <summary>sha256(timestamp + nonce + encryptKey + rawBody) 小写 hex；无 Encrypt Key 返回 null。</summary>
    public string? ComputeSignature(string timestamp, string nonce, ReadOnlySpan<byte> rawBody)
    {
        if (_encryptKey is null) return null;
        var prefix = Encoding.UTF8.GetBytes(timestamp + nonce + _encryptKey);
        var buffer = new byte[prefix.Length + rawBody.Length];
        try
        {
            prefix.CopyTo(buffer, 0);
            rawBody.CopyTo(buffer.AsSpan(prefix.Length));
            return Convert.ToHexString(SHA256.HashData(buffer)).ToLowerInvariant();
        }
        finally
        {
            CryptographicOperations.ZeroMemory(buffer);
        }
    }

    /// <summary>签名定长比较（大小写不敏感；签名头缺失/格式不符直接 false）。</summary>
    public bool VerifySignature(string timestamp, string nonce, ReadOnlySpan<byte> rawBody, string? signature)
    {
        if (string.IsNullOrEmpty(signature)) return false;
        var computed = ComputeSignature(timestamp, nonce, rawBody);
        if (computed is null) return false;
        var expected = Encoding.ASCII.GetBytes(computed);
        var actual = Encoding.ASCII.GetBytes(signature.Trim().ToLowerInvariant());
        try
        {
            return CryptographicOperations.FixedTimeEquals(expected, actual);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(actual);
        }
    }

    /// <summary>
    /// AES-256-CBC 解密（key = SHA-256(EncryptKey)，IV = 密文前 16 字节，PKCS7）。
    /// 失败（无 key / base64 非法 / 长度非法 / padding 错）返回 null，不抛异常。
    /// </summary>
    public string? Decrypt(string encryptBase64)
    {
        if (_encryptKey is null || string.IsNullOrEmpty(encryptBase64)) return null;
        try
        {
            var data = Convert.FromBase64String(encryptBase64);
            if (data.Length <= 16 || (data.Length - 16) % 16 != 0) return null;
            var key = SHA256.HashData(Encoding.UTF8.GetBytes(_encryptKey));
            using var aes = Aes.Create();
            aes.Mode = CipherMode.CBC;
            aes.Padding = PaddingMode.PKCS7;
            aes.Key = key;
            var plain = aes.DecryptCbc(data.AsSpan(16), data.AsSpan(0, 16), PaddingMode.PKCS7);
            return Encoding.UTF8.GetString(plain);
        }
        catch (CryptographicException)
        {
            return null;
        }
        catch (FormatException)
        {
            return null;
        }
    }

    /// <summary>
    /// 完整请求校验：新鲜度 → 签名（有 Encrypt Key 时强制）→ 解密（body 为 <c>{"encrypt":...}</c> 时）。
    /// 返回 Ok 时 <see cref="FeishuVerifyResult.Plaintext"/> 为明文 JSON 文本（challenge/事件）。
    /// </summary>
    public FeishuVerifyResult Verify(string? timestamp, string? nonce, string? signature, byte[] rawBody)
    {
        if (!Configured) return FeishuVerifyResult.Failure(ErrorConfig);
        if (!IsTimestampFresh(timestamp)) return FeishuVerifyResult.Failure(ErrorTimestamp);
        if (_encryptKey is not null && !VerifySignature(timestamp!, nonce ?? "", rawBody, signature))
        {
            return FeishuVerifyResult.Failure(ErrorSignature);
        }

        var bodyText = Encoding.UTF8.GetString(rawBody);
        var plaintext = bodyText;
        if (TryReadEncryptValue(bodyText, out var encrypted))
        {
            if (_encryptKey is null) return FeishuVerifyResult.Failure(ErrorEncryptKeyMissing);
            var decrypted = Decrypt(encrypted);
            if (decrypted is null) return FeishuVerifyResult.Failure(ErrorDecrypt);
            plaintext = decrypted;
        }
        return FeishuVerifyResult.Success(plaintext);
    }

    private static bool TryReadEncryptValue(string body, out string encrypted)
    {
        encrypted = "";
        if (!body.TrimStart().StartsWith('{')) return false;
        try
        {
            using var document = JsonDocument.Parse(body);
            if (document.RootElement.ValueKind == JsonValueKind.Object
                && document.RootElement.TryGetProperty("encrypt", out var value)
                && value.ValueKind == JsonValueKind.String)
            {
                encrypted = value.GetString() ?? "";
                return encrypted.Length > 0;
            }
        }
        catch (JsonException)
        {
            // 非 JSON 明文（challenge 前的探测请求等）：按明文走后续流程
        }
        return false;
    }
}

/// <summary>webhook 校验结果：Ok=false 时 Error 为 <see cref="FeishuEventCrypto"/> 错误码。</summary>
public sealed record FeishuVerifyResult(bool Ok, string? Plaintext, string? Error)
{
    public static FeishuVerifyResult Success(string plaintext) => new(true, plaintext, null);

    public static FeishuVerifyResult Failure(string error) => new(false, null, error);
}

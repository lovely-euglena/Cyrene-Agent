using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using CyreneNative.Channels;
using CyreneNative.Sync;
using CyreneCloud.Storage;

namespace CyreneCloud.Webhook;

/// <summary>webhook.received 载荷序列化：null source 落盘即省键（协议校验要求存在即 string）。</summary>
internal static class WebhookJson
{
    public static readonly JsonSerializerOptions Options = new()
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };
}

/// <summary>
/// Webhook 入站处理器（IKKIZR 批次 1）：HMAC-SHA256 验签 + 时间戳新鲜度 → 事件入流。
///
/// 签名方案：
/// - 请求头 <c>X-Webhook-Timestamp</c>（Unix 秒）与 <c>X-Webhook-Signature: v1=&lt;hex&gt;</c>；
/// - 签名串 = <c>{timestamp}.{rawBody}</c>，密钥为 endpoint secret，HMAC-SHA256 小写 hex；
/// - 时间戳超出容差（默认 ±300s）拒绝 → 防重放（nonce 去重表属后续批次，容差窗口内重放
///   由 eventId 幂等去重兜底：同 body 永远映射同一 eventId，重复投递进 Duplicate 不重复入库）。
///
/// 事件构造（协议 v0 扩展类型 webhook.received，IKKIZR）：
/// - sessionId = <c>webhook-{endpointId}</c>（每 endpoint 独立会话流，客户端按流消费）；
/// - eventId = <c>wh-{sha256(rawBody)[..32]}</c>（内容寻址幂等）；
/// - payload = {endpointId, source?, receivedAt, body(UTF-8 解码，超限截断), truncated}。
///
/// 日志只含 endpointId / 结果 / 长度，不含请求体与密钥。
/// </summary>
public sealed class WebhookInboundProcessor
{
    public const string SignatureHeader = "X-Webhook-Signature";
    public const string TimestampHeader = "X-Webhook-Timestamp";

    private readonly WebhookInboundOptions _options;
    private readonly TimeProvider _clock;

    public WebhookInboundProcessor(WebhookInboundOptions options, TimeProvider? clock = null)
    {
        _options = options;
        _clock = clock ?? TimeProvider.System;
    }

    public WebhookInboundOptions Options => _options;

    /// <summary>验签结果码：与 HTTP 状态一一对应（Ok→200，其余由端点映射）。</summary>
    public enum VerifyOutcome
    {
        Ok,
        MissingHeaders,
        UnknownEndpoint,
        BadTimestamp,
        BadSignature,
    }

    /// <summary>构造签名串的标准字节（测试向量共用）。</summary>
    public static byte[] SigningPayload(long timestamp, byte[] rawBody)
    {
        var prefix = Encoding.ASCII.GetBytes($"{timestamp}.");
        var merged = new byte[prefix.Length + rawBody.Length];
        Buffer.BlockCopy(prefix, 0, merged, 0, prefix.Length);
        Buffer.BlockCopy(rawBody, 0, merged, prefix.Length, rawBody.Length);
        return merged;
    }

    /// <summary>计算签名（小写 hex；测试与客户端构造请求共用同一算法）。</summary>
    public static string ComputeSignature(string secret, long timestamp, byte[] rawBody)
    {
        using var hmac = new HMACSHA256(Encoding.UTF8.GetBytes(secret));
        return Convert.ToHexString(hmac.ComputeHash(SigningPayload(timestamp, rawBody))).ToLowerInvariant();
    }

    /// <summary>验签 + 新鲜度（恒定时间比较）。</summary>
    public VerifyOutcome Verify(WebhookEndpoint endpoint, string? timestampHeader, string? signatureHeader, byte[] rawBody)
    {
        if (string.IsNullOrWhiteSpace(timestampHeader) || string.IsNullOrWhiteSpace(signatureHeader)) return VerifyOutcome.MissingHeaders;
        if (!long.TryParse(timestampHeader, out var timestamp)) return VerifyOutcome.BadTimestamp;
        var now = _clock.GetUtcNow().ToUnixTimeSeconds();
        var tolerance = _options.TimestampToleranceSeconds;
        if (Math.Abs(now - timestamp) > tolerance) return VerifyOutcome.BadTimestamp;
        const string prefix = "v1=";
        if (!signatureHeader.StartsWith(prefix, StringComparison.Ordinal)) return VerifyOutcome.BadSignature;
        var provided = signatureHeader[prefix.Length..];
        var expected = ComputeSignature(endpoint.Secret, timestamp, rawBody);
        if (provided.Length != expected.Length) return VerifyOutcome.BadSignature;
        return CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(provided), Encoding.ASCII.GetBytes(expected))
            ? VerifyOutcome.Ok
            : VerifyOutcome.BadSignature;
    }

    /// <summary>构造 webhook.received 事件（eventId 内容寻址幂等；body 超限截断并标记）。</summary>
    public ServerEventDraft BuildEvent(WebhookEndpoint endpoint, byte[] rawBody, DateTimeOffset receivedAt)
    {
        var body = Encoding.UTF8.GetString(rawBody);
        var truncated = false;
        if (body.Length > SyncProtocolV0.WebhookBodyMaxChars)
        {
            body = body[..SyncProtocolV0.WebhookBodyMaxChars];
            truncated = true;
        }
        var eventId = $"wh-{Convert.ToHexString(SHA256.HashData(rawBody)).ToLowerInvariant()[..32]}";
        var payload = JsonSerializer.SerializeToElement(new
        {
            endpointId = endpoint.Id,
            source = endpoint.Source,
            receivedAt = ChannelSessionId.UtcNowIso(receivedAt),
            body,
            truncated,
        }, WebhookJson.Options);
        return new ServerEventDraft($"webhook-{endpoint.Id}", "webhook.received", eventId, payload);
    }
}

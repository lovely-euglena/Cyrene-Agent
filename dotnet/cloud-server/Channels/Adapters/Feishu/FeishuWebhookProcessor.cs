using System.Text.Json;
using CyreneNative.Channels;

namespace CyreneCloud.Channels.Adapters.Feishu;

/// <summary>webhook 原始请求（路由层读取；rawBody 必须是未反序列化的原始字节，签名以它为输入）。</summary>
public sealed record FeishuWebhookRequest(
    string? Timestamp, string? Nonce, string? Signature, byte[] RawBody);

/// <summary>webhook 处理结果：StatusCode + 响应 JSON（challenge 回显 / code:0 / 错误码）。</summary>
public sealed record FeishuWebhookOutcome(int StatusCode, JsonElement Body);

/// <summary>
/// 飞书 webhook 处理器（设计 §6.2）：路由 <c>POST /v1/channels/feishu/webhook</c>（兼容别名 /events）的
/// 全部业务逻辑，可脱离 HTTP 单测/回放。
///
/// 流程：时间戳新鲜度 → 签名（有 Encrypt Key 时强制）→ 解密 → challenge 回显 / 事件路由。
/// 事件：适配器已托管 → 立即 200，异步交给 <see cref="FeishuAdapter"/>（含去重与 Dispatcher）；
/// 未托管（配置缺失/生成关闭/归属=desktop）→ 仍落 seen_messages 双键去重但不触发 agent（§6.2）。
/// </summary>
public sealed class FeishuWebhookProcessor
{
    public const string ErrorBadJson = "E_FEISHU_BAD_JSON";
    public const string ErrorChallenge = "E_FEISHU_CHALLENGE";

    private readonly FeishuEventCrypto _crypto;
    private readonly ChannelStore? _store;
    private readonly ChannelManager? _manager;
    private readonly ILogger<FeishuWebhookProcessor> _logger;

    public FeishuWebhookProcessor(
        FeishuEventCrypto crypto,
        ChannelStore? store,
        ChannelManager? manager,
        ILogger<FeishuWebhookProcessor> logger)
    {
        _crypto = crypto;
        _store = store;
        _manager = manager;
        _logger = logger;
    }

    /// <summary>
    /// 处理一次 webhook 请求。processInline=true 时同步等待事件处理完成（自测/回放用）；
    /// false 时事件后台处理并立即返回 200（§6.2：&lt;3s 回执）。
    /// </summary>
    public async Task<FeishuWebhookOutcome> HandleAsync(
        FeishuWebhookRequest request, bool processInline = false, CancellationToken cancellationToken = default)
    {
        var verify = _crypto.Verify(request.Timestamp, request.Nonce, request.Signature, request.RawBody);
        if (!verify.Ok)
        {
            _logger.LogWarning("飞书 webhook 校验失败 error={Error}", verify.Error);
            return Outcome(401, new { code = verify.Error });
        }

        JsonElement payload;
        try
        {
            using var document = JsonDocument.Parse(verify.Plaintext!);
            payload = document.RootElement.Clone();
        }
        catch (JsonException)
        {
            return Outcome(400, new { code = ErrorBadJson });
        }
        if (payload.ValueKind != JsonValueKind.Object)
        {
            return Outcome(400, new { code = ErrorBadJson });
        }

        // challenge（url_verification）：Verification Token 定长比较后原样回显
        if (ChannelJsonValue.OptionalString(payload, "type") == "url_verification")
        {
            if (!TokenAccepted(ChannelJsonValue.OptionalString(payload, "token")))
            {
                return Outcome(401, new { code = FeishuEventCrypto.ErrorToken });
            }
            var challenge = ChannelJsonValue.OptionalString(payload, "challenge");
            if (string.IsNullOrEmpty(challenge))
            {
                return Outcome(400, new { code = ErrorChallenge });
            }
            return Outcome(200, new { challenge });
        }

        // 事件：header.token 二次校验（防伪造；与签名/解密互为冗余）
        var headerToken = payload.TryGetProperty("header", out var header) && header.ValueKind == JsonValueKind.Object
            ? ChannelJsonValue.OptionalString(header, "token")
            : null;
        if (!TokenAccepted(headerToken))
        {
            return Outcome(401, new { code = FeishuEventCrypto.ErrorToken });
        }

        var adapter = _manager?.GetAdapter(ChannelIds.Feishu) as FeishuAdapter;
        if (adapter is null)
        {
            var first = await FeishuEventDedupe.MarkSeenAsync(_store, payload, cancellationToken).ConfigureAwait(false);
            _logger.LogDebug("飞书事件未托管，仅去重 duplicate={Duplicate}", !first);
            return Outcome(200, new { code = 0, duplicate = !first });
        }

        if (processInline)
        {
            var result = await adapter.HandleEventAsync(payload, cancellationToken).ConfigureAwait(false);
            return Outcome(200, Describe(result, payload));
        }

        _ = ProcessInBackgroundAsync(adapter, payload);
        return Outcome(200, new { code = 0 });
    }

    private async Task ProcessInBackgroundAsync(FeishuAdapter adapter, JsonElement payload)
    {
        try
        {
            await adapter.HandleEventAsync(payload, CancellationToken.None).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "飞书事件异步处理失败");
        }
    }

    /// <summary>
    /// Verification Token 判定：配置了 token 则必须定长匹配；未配置（仅 Encrypt Key，签名已通过）
    /// 时放行——与 FeishuEventCrypto.Configured 的口径一致，注册门槛（FeishuAdapterRegistration）
    /// 仍要求 token 齐备。
    /// </summary>
    private bool TokenAccepted(string? token) =>
        !_crypto.HasVerificationToken || _crypto.VerifyToken(token);

    private static object Describe(FeishuHandleResult result, JsonElement envelope)
    {
        var (messageKey, _) = FeishuEventDedupe.Keys(envelope);
        return new
        {
            code = 0,
            duplicate = result.Duplicate,
            ignored = result.Ignored,
            messageId = result.Message?.MessageId
                ?? (messageKey is null ? null : messageKey[FeishuEventDedupe.MessageKeyPrefix.Length..]),
            text = result.Message?.Text,
            media = result.Message?.Attachments?.Count ?? 0,
        };
    }

    private static FeishuWebhookOutcome Outcome(int statusCode, object body) =>
        new(statusCode, JsonSerializer.SerializeToElement(body, ChannelJson.Options));
}

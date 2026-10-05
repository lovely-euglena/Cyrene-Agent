using CyreneNative.Channels;

namespace CyreneCloud.Channels;

/// <summary>
/// 渠道控制面端点组（docs/design/2026-10-05-server-channel.md §5.2，端点冻结）。
///
/// 复用 /v1/* Bearer 鉴权中间件（device token 或 CLOUD_TOKEN）；归属变更与 proactive
/// 走 sync 限流桶（复用，不新增配额面）。holder = 当前鉴权 principal（deviceId / master）。
/// </summary>
public static class ChannelApi
{
    public static void MapChannelApi(this WebApplication app)
    {
        var group = app.MapGroup("/v1/channels").RequireRateLimiting("sync");

        // GET /v1/channels/ownership —— 归属快照（桌面 30s 轮询）
        group.MapGet("/ownership", (ChannelOwnershipService ownership) =>
            Results.Json(ownership.GetSnapshot()));

        // GET /v1/channels/status —— 渠道状态 + owner（UI/桌面轮询）
        group.MapGet("/status", (ChannelManager manager, ChannelOwnershipService ownership) =>
        {
            var statuses = manager.GetAllStatus();
            var snapshot = ownership.GetSnapshot();
            var channels = manager.ListChannels().Select(id =>
            {
                statuses.TryGetValue(id, out var status);
                snapshot.Channels.TryGetValue(id, out var channelOwnership);
                return new
                {
                    id,
                    phase = status?.Phase ?? ChannelPhases.Offline,
                    enabled = status?.Enabled ?? false,
                    owner = channelOwnership?.Owner ?? ChannelOwnershipService.OwnerServer,
                    detail = status?.Detail,
                };
            }).ToArray();
            return Results.Json(new { channels });
        });

        // POST /v1/channels/ownership/claim —— 桌面认领（先停服务端适配器再授予；Q8 先到先得）
        group.MapPost("/ownership/claim", async (
            HttpContext context, ChannelManager manager, ChannelOwnershipService ownership,
            ChannelClaimRequest? request, CancellationToken cancellationToken) =>
        {
            var channels = request?.Channels ?? [];
            if (channels.Length == 0) return Results.BadRequest(new { code = ChannelErrorCodes.BadRequest });
            var invalid = ValidateChannels(manager, channels);
            if (invalid is not null) return invalid;
            var holder = context.Items["principal"]?.ToString() ?? "";
            if (holder.Length == 0) return Unauthorized();
            var result = await ownership.ClaimAsync(channels, holder, request!.TtlSeconds, cancellationToken);
            return Results.Json(new
            {
                granted = result.Granted,
                denied = result.Denied,
                leaseExpiresAt = result.LeaseExpiresAt is { } lease ? ChannelSessionId.UtcNowIso(lease) : null,
            });
        });

        // POST /v1/channels/ownership/heartbeat —— 心跳续约；lost 渠道桌面须立刻停本机适配器
        group.MapPost("/ownership/heartbeat", async (
            HttpContext context, ChannelManager manager, ChannelOwnershipService ownership,
            ChannelHeartbeatRequest? request, CancellationToken cancellationToken) =>
        {
            var channels = request?.Channels ?? [];
            if (channels.Length == 0) return Results.BadRequest(new { code = ChannelErrorCodes.BadRequest });
            var invalid = ValidateChannels(manager, channels);
            if (invalid is not null) return invalid;
            var holder = context.Items["principal"]?.ToString() ?? "";
            if (holder.Length == 0) return Unauthorized();
            var result = await ownership.HeartbeatAsync(channels, holder, cancellationToken);
            return Results.Json(new { renewed = result.Renewed, lost = result.Lost });
        });

        // POST /v1/channels/ownership/release —— 交回服务端（宽限 5s 后恢复，§5.3）
        group.MapPost("/ownership/release", async (
            HttpContext context, ChannelManager manager, ChannelOwnershipService ownership,
            ChannelReleaseRequest? request, CancellationToken cancellationToken) =>
        {
            var channels = request?.Channels ?? [];
            if (channels.Length == 0) return Results.BadRequest(new { code = ChannelErrorCodes.BadRequest });
            var invalid = ValidateChannels(manager, channels);
            if (invalid is not null) return invalid;
            var holder = context.Items["principal"]?.ToString() ?? "";
            if (holder.Length == 0) return Unauthorized();
            var result = await ownership.ReleaseAsync(channels, holder, cancellationToken);
            return Results.Json(new { released = result.Released });
        });

        // POST /v1/channels/{id}/proactive —— 主动消息唯一化投递（intentId 幂等，§5.4）
        group.MapPost("/{channel}/proactive", async (
            ChannelManager manager, ChannelProactiveService proactive, string channel,
            ChannelProactiveRequest? request, CancellationToken cancellationToken) =>
        {
            if (!ChannelCapabilities.IsKnown(channel))
                return Results.BadRequest(new { code = ChannelErrorCodes.Unknown, channel });
            if (!manager.Has(channel))
                return Results.BadRequest(new { code = ChannelErrorCodes.NotHosted, channel });
            // capability 前置拒绝（§2.6）：proactive:false 渠道不写事件、不尝试投递
            if (!ChannelAdapterCatalog.SupportsProactive(channel))
                return Results.BadRequest(new { code = ChannelErrorCodes.Unsupported, channel });
            if (request is null || string.IsNullOrWhiteSpace(request.IntentId) || string.IsNullOrWhiteSpace(request.Text))
                return Results.BadRequest(new { code = ChannelErrorCodes.BadRequest });

            var outcome = await proactive.DeliverAsync(
                channel, request.SessionId, request.IntentId!, request.Text!, cancellationToken);
            return outcome.Status switch
            {
                ProactiveDeliveryStatus.RecipientMissing =>
                    Results.BadRequest(new { code = ChannelErrorCodes.RecipientMissing }),
                ProactiveDeliveryStatus.OwnedByOther =>
                    Results.Json(new { code = ChannelErrorCodes.OwnedByOther }, statusCode: StatusCodes.Status409Conflict),
                ProactiveDeliveryStatus.Unsupported =>
                    Results.BadRequest(new { code = ChannelErrorCodes.Unsupported, channel }),
                ProactiveDeliveryStatus.WriteFailed =>
                    Results.Json(new { code = ChannelErrorCodes.SendFailed, error = outcome.Error },
                        statusCode: StatusCodes.Status500InternalServerError),
                _ => Results.Json(new
                {
                    eventId = outcome.EventId,
                    delivered = outcome.Delivered,
                    duplicate = outcome.Duplicate ? true : (bool?)null,
                    error = outcome.Error,
                }),
            };
        });
    }

    private static IResult? ValidateChannels(ChannelManager manager, string[] channels)
    {
        foreach (var channel in channels)
        {
            if (!ChannelCapabilities.IsKnown(channel))
                return Results.BadRequest(new { code = ChannelErrorCodes.Unknown, channel });
            if (!manager.Has(channel))
                return Results.BadRequest(new { code = ChannelErrorCodes.NotHosted, channel });
        }
        return null;
    }

    private static IResult Unauthorized() =>
        Results.Json(new { code = "E_UNAUTHORIZED" }, statusCode: StatusCodes.Status401Unauthorized);
}

/// <summary>渠道控制面错误码（§5.2 冻结；BadRequest 用于请求体缺字段的客户端错误）。</summary>
public static class ChannelErrorCodes
{
    public const string Unknown = "E_CHANNEL_UNKNOWN";
    public const string NotHosted = "E_CHANNEL_NOT_HOSTED";
    public const string OwnedByOther = "E_CHANNEL_OWNED_BY_OTHER";
    public const string RecipientMissing = "E_CHANNEL_RECIPIENT_MISSING";
    public const string SendFailed = "E_CHANNEL_SEND_FAILED";
    public const string Login = "E_CHANNEL_LOGIN";
    public const string BadRequest = "E_CHANNEL_REQUEST";
    /// <summary>渠道 capability 不支持该操作（proactive:false；本批 qqbot）。</summary>
    public const string Unsupported = "E_CHANNEL_UNSUPPORTED";
}

public sealed record ChannelClaimRequest(string[]? Channels, int? TtlSeconds);

public sealed record ChannelHeartbeatRequest(string[]? Channels);

public sealed record ChannelReleaseRequest(string[]? Channels);

public sealed record ChannelProactiveRequest(string? SessionId, string? IntentId, string? Text);

using System.Globalization;
using System.Text.Json;
using CyreneNative.Channels;
using CyreneNative.Channels.Normalizers;

namespace CyreneCloud.Channels.Adapters.QqBot;

/// <summary>
/// QQ 官方机器人渠道适配器（TS `qqbot-adapter.ts` 的服务端移植；设计 §7）。
///
/// 与 NapCat（桌面 "qq" 渠道）不同：走官方开放平台（AppID/AppSecret → access_token →
/// WS 网关收事件、REST 被动回复），用户/群以 openid 标识。2025-04-21 后官方停止主动推送，
/// 服务端只支持**被动回复**（必须在触发消息窗口内携带 msg_id），
/// capability <c>proactive:false</c>，主动通知走微信/飞书（服务端）或 NapCat（桌面）。
///
/// 边界（本批冻结）：
///   - 入站仅 C2C 私聊；群事件记日志忽略（§1.3「服务端仅私聊」）；
///   - 出站仅文本（图片/语音后置，Q7 拍板），复用 core <see cref="QqBotNormalizer"/> 分片；
///   - 被动回复窗口/次数：单聊 60 分钟 4 条、群聊 5 分钟 5 条（§7.2）；
///   - 白名单：allowAnyPrivate（默认关）/ allowedOpenIds；被拒 openid 进 status detail；
///   - URL 消息发送失败：单次重试由 ChannelDeliveryService 负责，失败记 receipt failed；
///     <c>CLOUD_CHANNEL_QQBOT_STRIP_URLS=1</c> 时发送前把 URL 替换为占位。
/// </summary>
public sealed class QqBotAdapter : IChannelAdapter
{
    /// <summary>§7.3 产品文案：QQ 官方 bot 不适用主动通知。</summary>
    public const string ProactiveNotice = "QQ 官方 bot 不适用主动通知；主动通知请用微信/飞书（服务端）或 NapCat（桌面）";

    public const string ErrorCodeGateway = "E_QQBOT_GATEWAY";
    public const string ErrorCodeSend = "E_QQBOT_SEND";

    private static readonly TimeSpan DedupeTtl = TimeSpan.FromMinutes(10);
    private static readonly TimeSpan PrivateReplyWindow = TimeSpan.FromMinutes(60);
    private static readonly TimeSpan GroupReplyWindow = TimeSpan.FromMinutes(5);
    private const int PrivateReplyLimit = 4;
    private const int GroupReplyLimit = 5;
    private const int DedupePruneThreshold = 64;

    private readonly ChannelOptions _options;
    private readonly ILogger<QqBotAdapter> _logger;
    private readonly QqBotApiClient? _injectedApi;
    private readonly Func<QqBotWsClientOptions, QqBotWsClient>? _wsClientFactory;
    private readonly TimeProvider _time;

    private readonly object _sync = new();
    private readonly Dictionary<string, DateTimeOffset> _seen = new(StringComparer.Ordinal);
    private readonly Dictionary<string, ReplyContext> _replyByChatId = new(StringComparer.Ordinal);
    private readonly Dictionary<string, ReplyContext> _replyByMessageId = new(StringComparer.Ordinal);

    private QqBotApiClient? _api;
    private bool _ownsApi;
    private QqBotWsClient? _ws;
    private ChannelStatus _status;
    private DateTimeOffset? _startedAt;
    private bool _wsReady;
    private string _lastErrorCode = "";
    private string? _lastRejectedOpenId;
    private long _ignoredGroupEvents;

    public QqBotAdapter(
        ChannelOptions options,
        ILogger<QqBotAdapter> logger,
        QqBotApiClient? apiClient = null,
        Func<QqBotWsClientOptions, QqBotWsClient>? wsClientFactory = null,
        TimeProvider? timeProvider = null)
    {
        _options = options;
        _logger = logger;
        _injectedApi = apiClient;
        _wsClientFactory = wsClientFactory;
        _time = timeProvider ?? TimeProvider.System;
        _status = new ChannelStatus
        {
            Enabled = IsConfigured,
            Phase = ChannelPhases.Offline,
            Message = "未启动",
            Detail = BuildDetail(),
        };
    }

    public string Id => ChannelIds.QqBot;

    public string DisplayName => "QQ 机器人（官方）";

    public ChannelCapability Capability => ChannelCapabilities.For(ChannelIds.QqBot);

    public Func<IncomingMessage, CancellationToken, Task<OutgoingMessage?>>? OnMessage { get; set; }

    private bool IsConfigured =>
        !string.IsNullOrWhiteSpace(_options.QqBotAppId) && !string.IsNullOrWhiteSpace(_options.QqBotAppSecret);

    public async Task StartAsync(CancellationToken cancellationToken = default)
    {
        if (!IsConfigured)
        {
            SetStatus(
                ChannelPhases.ConfigMissing,
                "缺少 AppID / AppSecret，请到 q.qq.com 创建机器人后填写");
            return;
        }
        _startedAt = _time.GetUtcNow();
        SetStatus(ChannelPhases.Starting, "正在连接 QQ 开放平台网关");
        var api = _injectedApi ?? new QqBotApiClient(
            _options.QqBotAppId!, _options.QqBotAppSecret!, timeProvider: _time);
        _ownsApi = _injectedApi is null;
        _api = api;
        try
        {
            var gatewayUrl = await api.GetGatewayUrlAsync(cancellationToken);
            var ws = CreateWsClient(gatewayUrl, api);
            _ws = ws;
            await ws.StartAsync(cancellationToken);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            SetStatus(ChannelPhases.Offline, "已停止");
        }
        catch (Exception ex)
        {
            _lastErrorCode = ErrorCodeGateway;
            _logger.LogError(ex, "QQ Bot 网关启动失败 channel={Channel}", Id);
            SetStatus(ChannelPhases.Error, ex.Message);
        }
    }

    public async Task StopAsync(CancellationToken cancellationToken = default)
    {
        var ws = _ws;
        _ws = null;
        if (ws is not null)
        {
            try
            {
                await ws.StopAsync(cancellationToken);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "QQ Bot 网关停止异常 channel={Channel}", Id);
            }
        }
        var api = _api;
        _api = null;
        if (api is not null && _ownsApi) api.Dispose();
        _ownsApi = false;
        _wsReady = false;
        lock (_sync)
        {
            _seen.Clear();
            _replyByChatId.Clear();
            _replyByMessageId.Clear();
        }
        SetStatus(ChannelPhases.Offline, "已停止");
    }

    public ChannelStatus GetStatus() => _status;

    public async Task<ChannelSendResult> SendAsync(
        OutgoingMessage message, CancellationToken cancellationToken = default)
    {
        var api = _api;
        if (api is null || !_wsReady)
        {
            return ChannelSendResult.Failure("QQ 机器人网关未连接");
        }
        var chatType = string.IsNullOrEmpty(message.ChatType) ? ChannelChatTypes.Private : message.ChatType;
        ReplyContext? context;
        lock (_sync)
        {
            context = ResolveReplyContextLocked(message);
        }
        if (context is null)
        {
            return ChannelSendResult.Failure("官方 QQ Bot 仅支持被动回复（没有可引用的入站消息）");
        }
        var isGroup = chatType == ChannelChatTypes.Group;
        var window = isGroup ? GroupReplyWindow : PrivateReplyWindow;
        if (_time.GetUtcNow() - context.ReceivedAt > window)
        {
            return ChannelSendResult.Failure($"被动回复窗口已过（{(isGroup ? "5 分钟" : "60 分钟")}）");
        }
        var limit = isGroup ? GroupReplyLimit : PrivateReplyLimit;
        if (context.SeqUsed >= limit)
        {
            return ChannelSendResult.Failure($"该消息回复次数已达上限（{limit} 次）");
        }

        var plan = QqBotNormalizer.BuildPassiveReplies(message, context.MessageId, context.SeqUsed, limit);
        if (plan.Requests.Count == 0)
        {
            return ChannelSendResult.Failure(plan.Error ?? "没有可发送的 QQ Bot 内容");
        }

        var sent = 0;
        string? lastError = plan.Error;
        foreach (var request in plan.Requests)
        {
            var content = _options.QqBotStripUrls ? QqBotUrlPolicy.StripUrls(request.Content) : request.Content;
            var outgoingRequest = content == request.Content
                ? request
                : new QqBotReplyRequest
                {
                    MsgType = request.MsgType,
                    Content = content,
                    MsgId = request.MsgId,
                    MsgSeq = request.MsgSeq,
                };
            // 桌面语义：发送尝试即消耗一次 msg_seq（失败也消耗，避免并发双发抢同一序号）
            Interlocked.Increment(ref context.SeqUsed);
            try
            {
                await api.SendTextAsync(
                    new QqBotSendTarget { OpenId = message.TargetId, ChatType = chatType },
                    outgoingRequest,
                    cancellationToken);
                sent++;
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                lastError = ex.Message;
                if (!_options.QqBotStripUrls && QqBotUrlPolicy.ContainsUrl(request.Content))
                {
                    lastError += "（含链接的消息可能被上游拒绝；可设置 CLOUD_CHANNEL_QQBOT_STRIP_URLS=1 用占位替换）";
                }
                _lastErrorCode = ErrorCodeSend;
                _logger.LogWarning(ex, "QQ Bot 发送失败 channel={Channel} msgSeq={Seq}", Id, request.MsgSeq);
            }
        }
        if (sent > 0)
        {
            if (lastError is not null)
            {
                _logger.LogWarning("QQ Bot 消息部分发送失败 channel={Channel} error={Error}", Id, lastError);
            }
            return ChannelSendResult.Success;
        }
        return ChannelSendResult.Failure(lastError ?? "QQ Bot 发送失败");
    }

    private QqBotWsClient CreateWsClient(string gatewayUrl, QqBotApiClient api)
    {
        var wsOptions = new QqBotWsClientOptions
        {
            GatewayUrl = gatewayUrl,
            GetAccessToken = api.GetAccessTokenAsync,
            TimeProvider = _time,
            OnDispatch = HandleDispatch,
            OnReadyChange = HandleReadyChange,
            OnError = HandleWsError,
        };
        return _wsClientFactory?.Invoke(wsOptions) ?? new QqBotWsClient(wsOptions);
    }

    private void HandleDispatch(string type, JsonElement data)
    {
        var incoming = QqBotNormalizer.NormalizeInbound(type, data, _time.GetUtcNow());
        if (incoming is null) return;

        // §1.3 / §7.2：服务端本批仅私聊；群消息记日志忽略（status detail 可见）
        if (incoming.ChatType != ChannelChatTypes.Private)
        {
            Interlocked.Increment(ref _ignoredGroupEvents);
            RefreshStatusDetail();
            _logger.LogDebug("QQ Bot 群消息忽略（服务端本批仅私聊）type={Type}", type);
            return;
        }

        if (!IsAllowed(incoming.SenderId))
        {
            _lastRejectedOpenId = incoming.SenderId;
            RefreshStatusDetail();
            _logger.LogInformation("QQ Bot 消息被白名单拒绝 channel={Channel}", Id);
            return;
        }

        if (!string.IsNullOrEmpty(incoming.MessageId))
        {
            lock (_sync)
            {
                PruneDedupeLocked();
                if (_seen.ContainsKey(incoming.MessageId)) return;
                _seen[incoming.MessageId] = _time.GetUtcNow() + DedupeTtl;
                var context = new ReplyContext
                {
                    MessageId = incoming.MessageId,
                    ChatId = incoming.ChatId,
                    ReceivedAt = _time.GetUtcNow(),
                };
                _replyByChatId[incoming.ChatId] = context;
                _replyByMessageId[incoming.MessageId] = context;
                PruneRepliesLocked();
            }
        }
        _ = DeliverIncomingAsync(incoming);
    }

    private bool IsAllowed(string openId) =>
        _options.QqBotAllowAnyPrivate || _options.QqBotAllowedOpenIds.Contains(openId, StringComparer.Ordinal);

    private async Task DeliverIncomingAsync(IncomingMessage incoming)
    {
        try
        {
            var handler = OnMessage;
            if (handler is null) return;
            await handler(incoming, CancellationToken.None);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "QQ Bot 入站处理失败 channel={Channel}", Id);
        }
    }

    private ReplyContext? ResolveReplyContextLocked(OutgoingMessage message)
    {
        var requestedId = message.ReplyContext?.MessageId;
        if (!string.IsNullOrEmpty(requestedId)
            && _replyByMessageId.TryGetValue(requestedId, out var byMessage))
        {
            return byMessage;
        }
        if (_replyByChatId.TryGetValue(message.TargetId, out var latest)
            && (string.IsNullOrEmpty(requestedId) || latest.MessageId == requestedId))
        {
            return latest;
        }
        return null;
    }

    private void PruneDedupeLocked()
    {
        if (_seen.Count < DedupePruneThreshold) return;
        var now = _time.GetUtcNow();
        foreach (var key in _seen.Where(pair => pair.Value <= now).Select(pair => pair.Key).ToArray())
        {
            _seen.Remove(key);
        }
    }

    private void PruneRepliesLocked()
    {
        var now = _time.GetUtcNow();
        foreach (var key in _replyByMessageId
                     .Where(pair => now - pair.Value.ReceivedAt > PrivateReplyWindow)
                     .Select(pair => pair.Key)
                     .ToArray())
        {
            var context = _replyByMessageId[key];
            _replyByMessageId.Remove(key);
            if (_replyByChatId.TryGetValue(context.ChatId, out var current) && ReferenceEquals(current, context))
            {
                _replyByChatId.Remove(context.ChatId);
            }
        }
    }

    private void HandleReadyChange(bool ready)
    {
        _wsReady = ready;
        var nickname = _ws?.BotNickname ?? "";
        SetStatus(
            ready ? ChannelPhases.Running : ChannelPhases.Starting,
            ready ? $"网关已连接{(nickname.Length > 0 ? $"（{nickname}）" : "")}" : "网关重连中");
    }

    private void HandleWsError(Exception error)
    {
        _lastErrorCode = ErrorCodeGateway;
        _logger.LogWarning(error, "QQ Bot 网关错误 channel={Channel}", Id);
        RefreshStatusDetail();
    }

    private void SetStatus(string phase, string message)
    {
        _status = new ChannelStatus
        {
            Enabled = IsConfigured,
            Phase = phase,
            Message = message,
            Detail = BuildDetail(),
        };
    }

    private void RefreshStatusDetail() =>
        _status = new ChannelStatus
        {
            Enabled = _status.Enabled,
            Phase = _status.Phase,
            Message = _status.Message,
            Detail = BuildDetail(),
        };

    private JsonElement BuildDetail() => JsonSerializer.SerializeToElement(new
    {
        owner = "server",
        since = _startedAt,
        appId = _options.QqBotAppId,
        wsReady = _wsReady,
        botNickname = _ws?.BotNickname is { Length: > 0 } nickname ? nickname : null,
        proactive = false,
        notice = ProactiveNotice,
        lastErrorCode = _lastErrorCode.Length > 0 ? _lastErrorCode : null,
        lastRejectedOpenid = _lastRejectedOpenId,
        ignoredGroupEvents = _ignoredGroupEvents > 0 ? _ignoredGroupEvents : (long?)null,
    }, ChannelJson.Options);

    /// <summary>被动回复上下文：触发消息 + 窗口起点 + 已用 msg_seq 次数。</summary>
    private sealed class ReplyContext
    {
        public required string MessageId { get; init; }
        public required string ChatId { get; init; }
        public required DateTimeOffset ReceivedAt { get; init; }
        public int SeqUsed;
    }
}

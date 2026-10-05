using System.Collections.Concurrent;
using System.Text.Json;
using CyreneNative.Channels;
using CyreneNative.Channels.Normalizers;

namespace CyreneCloud.Channels.Adapters.WeChat;

/// <summary>
/// 微信 iLink 渠道适配器（<see cref="IChannelAdapter"/>；桌面 `ilink-bot-adapter.ts` 的服务端同构）。
///
/// 职责：长轮询 getupdates（网络异常 2s 退避；ret=-14 停轮询等人工重登；连续失败 5 次状态 error 但继续重试）
/// → 入站归一化（复用 cyrene-core <see cref="WeChatNormalizer"/>）→ 媒体下载/落盘（图片 10MB / 文件 20MB 分档，
/// 超限文案拒绝）→ OnMessage（dispatcher）→ 出站文本/图片/文件/视频（CDN 上传 → sendmessage item）；
/// 语音按 §4.1 文本降级（<see cref="ISilkCodec"/> 阶段 7 占位）。
/// 凭据由 <see cref="ChannelStore"/> 自持（AES-GCM），扫码登录见 <see cref="WeChatQrLogin"/>。
/// </summary>
public sealed class ILinkBotAdapter : IChannelAdapter
{
    public const string CredentialChannel = ChannelIds.WeChat;

    private static readonly TimeSpan DefaultReconnectBackoff = TimeSpan.FromSeconds(2);
    private const int ErrorThreshold = 5;
    private const int ImageMaxMb = 10;

    private readonly ChannelOptions _options;
    private readonly ChannelStore _store;
    private readonly WeChatMediaStore _mediaStore;
    private readonly WeChatCdnClient _cdn;
    private readonly ISilkCodec _silk;
    private readonly ILogger<ILinkBotAdapter> _logger;
    private readonly Func<ILinkCredentials, ILinkProtocolClient> _clientFactory;
    private readonly TimeSpan _reconnectBackoff;

    private readonly object _sync = new();
    private readonly ConcurrentDictionary<string, ReplyContextEntry> _replyContextByTarget = new(StringComparer.Ordinal);
    private long _replyContextSequence;

    /// <summary>P2-8：_replyContextByTarget 默认上限（超出按最久未更新 LRU 淘汰，§3.5 内存口径）。</summary>
    internal const int DefaultReplyContextLimit = 1024;

    /// <summary>selftest 可调小以验证淘汰；生产用 <see cref="DefaultReplyContextLimit"/>。</summary>
    internal int ReplyContextLimit { get; set; } = DefaultReplyContextLimit;

    /// <summary>selftest 观测用：当前 target → context_token 条目数。</summary>
    internal int ReplyContextCount => _replyContextByTarget.Count;

    private ILinkProtocolClient? _client;
    private CancellationTokenSource? _pollCts;
    private Task? _pollTask;
    private ChannelStatus _status = new() { Enabled = false, Phase = ChannelPhases.Offline };
    private DateTimeOffset _since = DateTimeOffset.UtcNow;
    private string? _botId;
    private string? _credentialProtection;
    private string? _lastErrorCode;
    private int _consecutiveFailures;

    public ILinkBotAdapter(
        ChannelOptions options,
        ChannelStore store,
        WeChatMediaStore mediaStore,
        WeChatCdnClient cdn,
        ISilkCodec silk,
        ILogger<ILinkBotAdapter> logger,
        Func<ILinkCredentials, ILinkProtocolClient>? clientFactory = null,
        TimeSpan? reconnectBackoff = null)
    {
        _options = options;
        _store = store;
        _mediaStore = mediaStore;
        _cdn = cdn;
        _silk = silk;
        _logger = logger;
        _clientFactory = clientFactory ?? (credentials => new ILinkProtocolClient(credentials));
        _reconnectBackoff = reconnectBackoff ?? DefaultReconnectBackoff;
    }

    public string Id => ChannelIds.WeChat;
    public string DisplayName => "微信";
    public ChannelCapability Capability => ChannelCapabilities.For(ChannelIds.WeChat);

    public Func<IncomingMessage, CancellationToken, Task<OutgoingMessage?>>? OnMessage { get; set; }

    // ── 生命周期 ────────────────────────────────────────────────────────────

    public async Task StartAsync(CancellationToken cancellationToken = default)
    {
        lock (_sync)
        {
            if (_client is not null) return; // 幂等（ChannelManager 单实例守卫之外的兜底）
        }
        SetStatus(ChannelPhases.Starting, "正在连接微信…");

        string? raw;
        try
        {
            raw = await _store.LoadCredentialAsync(CredentialChannel, cancellationToken);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            SetStatus(ChannelPhases.Error, $"凭据读取失败：{ex.Message}");
            return;
        }

        ILinkCredentials? credentials = null;
        if (!string.IsNullOrWhiteSpace(raw))
        {
            try
            {
                credentials = JsonSerializer.Deserialize<ILinkCredentials>(raw, ChannelJson.Options);
            }
            catch (JsonException)
            {
                credentials = null;
            }
        }
        if (credentials is null || string.IsNullOrEmpty(credentials.BotToken) || string.IsNullOrEmpty(credentials.IlinkBotId))
        {
            SetStatus(ChannelPhases.ConfigMissing, "未登录，请先扫码");
            return;
        }

        try
        {
            _credentialProtection = await _store.CredentialProtectionAsync(CredentialChannel, cancellationToken);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _credentialProtection = null;
        }

        var client = _clientFactory(credentials);
        var pollCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        lock (_sync)
        {
            if (_client is not null)
            {
                pollCts.Dispose();
                client.Dispose(); // 本轮客户端未启用：释放自建连接池
                return;
            }
            _client = client;
            _pollCts = pollCts;
            _botId = credentials.IlinkBotId;
            _since = DateTimeOffset.UtcNow;
            _lastErrorCode = null;
            _consecutiveFailures = 0;
            _pollTask = Task.Run(() => PollLoopAsync(client, pollCts.Token), CancellationToken.None);
        }
        SetStatus(ChannelPhases.Running, "微信已连接");
        _logger.LogInformation("微信渠道已连接 channel=wechat botId={BotId}", credentials.IlinkBotId);
        _ = _mediaStore.CleanupExpiredAsync(WeChatMediaStore.DefaultTtl, CancellationToken.None);
    }

    public async Task StopAsync(CancellationToken cancellationToken = default)
    {
        CancellationTokenSource? pollCts;
        Task? pollTask;
        ILinkProtocolClient? client;
        lock (_sync)
        {
            pollCts = _pollCts;
            pollTask = _pollTask;
            client = _client;
            _pollCts = null;
            _pollTask = null;
            _client = null;
        }
        if (pollCts is not null)
        {
            try
            {
                pollCts.Cancel();
            }
            catch (ObjectDisposedException)
            {
                // 已释放：忽略
            }
        }
        var drained = true;
        if (pollTask is not null)
        {
            try
            {
                await pollTask.WaitAsync(TimeSpan.FromSeconds(5), cancellationToken);
            }
            catch (TimeoutException)
            {
                drained = false;
                _logger.LogWarning("微信轮询任务未在 5s 内退出 channel=wechat");
            }
            catch (OperationCanceledException)
            {
                // 停止信号：视为已打断
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "微信轮询任务退出异常 channel=wechat");
            }
        }
        if (pollCts is not null)
        {
            if (drained || pollTask is null)
            {
                pollCts.Dispose();
            }
            else
            {
                // 轮询任务未退出：token 可能仍在途，待任务结束后释放
                _ = pollTask.ContinueWith(_ => pollCts.Dispose(), CancellationToken.None,
                    TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
            }
        }
        client?.Dispose(); // 仅自建 HttpClient 真正释放；注入的连接由调用方管理
        _replyContextByTarget.Clear();
        SetStatus(ChannelPhases.Offline, "已停止");
    }

    public ChannelStatus GetStatus()
    {
        lock (_sync) return _status;
    }

    private void SetStatus(string phase, string? message)
    {
        lock (_sync)
        {
            var detail = new Dictionary<string, object?>
            {
                ["owner"] = "server", // 阶段 4 归属服务接管后改写
                ["since"] = ChannelSessionId.UtcNowIso(_since),
                ["botId"] = _botId,
                ["voice"] = false,
                ["credentialProtection"] = _credentialProtection,
                ["lastErrorCode"] = _lastErrorCode,
            };
            _status = new ChannelStatus
            {
                Enabled = phase != ChannelPhases.Offline,
                Phase = phase,
                Message = message,
                Detail = JsonSerializer.SerializeToElement(detail, ChannelJson.Options),
            };
        }
    }

    // ── 长轮询 ──────────────────────────────────────────────────────────────

    private async Task PollLoopAsync(ILinkProtocolClient client, CancellationToken cancellationToken)
    {
        var buf = "";
        while (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                var updates = await client.GetUpdatesAsync(buf, cancellationToken);
                if (_consecutiveFailures > 0 || GetStatus().Phase != ChannelPhases.Running)
                {
                    _consecutiveFailures = 0;
                    _lastErrorCode = null;
                    SetStatus(ChannelPhases.Running, "微信已连接");
                }
                buf = updates.Buf;
                foreach (var message in updates.Messages)
                {
                    await DispatchInboundAsync(client, message, cancellationToken);
                }
            }
            catch (ILinkSessionExpiredException)
            {
                _lastErrorCode = "E_CHANNEL_LOGIN_EXPIRED";
                SetStatus(ChannelPhases.Error, "会话已过期，请重新扫码登录");
                _logger.LogError("微信 iLink 会话已过期，等待人工重登 channel=wechat botId={BotId}", _botId);
                return; // 会话过期重试无意义（§3.1）
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception ex)
            {
                _consecutiveFailures++;
                _lastErrorCode = ex.GetType().Name;
                if (_consecutiveFailures >= ErrorThreshold)
                {
                    SetStatus(ChannelPhases.Error,
                        $"微信连接不稳定（连续失败 {_consecutiveFailures} 次），正在重试");
                }
                _logger.LogWarning("微信长轮询失败 attempt={Attempt} error={Error}",
                    _consecutiveFailures, ex.Message);
                try
                {
                    await Task.Delay(_reconnectBackoff, cancellationToken);
                }
                catch (OperationCanceledException)
                {
                    return;
                }
            }
        }
    }

    // ── 入站 ────────────────────────────────────────────────────────────────

    /// <summary>处理一条已展开的 iLink 消息（internal 供 selftest 直接驱动）。</summary>
    internal async Task DispatchInboundAsync(
        ILinkProtocolClient client, WeixinMessage message, CancellationToken cancellationToken)
    {
        var handler = OnMessage;
        if (handler is null)
        {
            _logger.LogWarning("收到微信入站消息但 OnMessage 未注入，跳过 messageId={MessageId}", message.MsgId);
            return;
        }
        var fromUserId = message.FromUserId;
        if (!string.IsNullOrEmpty(fromUserId))
        {
            RememberReplyContext(fromUserId, message.ContextToken);
        }
        var normalized = WeChatNormalizer.NormalizeInbound(message.Raw, DateTimeOffset.UtcNow);
        if (normalized is null) return;
        var media = normalized.Media;

        // 语音（阶段 7）：V1 未配置 ASR → 同桌面口径文案，不派发（§4.1）
        if (media.Any(item => item.Kind == "voice"))
        {
            await SendInterceptTextAsync(client, fromUserId, message.ContextToken,
                WeChatPrompts.AsrMissing(WeChatPrompts.DefaultUserName), cancellationToken);
            return;
        }
        // 视频 / 不可分析文件：文案提示（不落盘；§3.3）
        if (media.Any(item => item.Kind == "video"))
        {
            await SendInterceptTextAsync(client, fromUserId, message.ContextToken,
                WeChatPrompts.Video(WeChatPrompts.DefaultUserName), cancellationToken);
            return;
        }
        if (media.Any(item => item.Kind == "file" && !item.Analyzable))
        {
            await SendInterceptTextAsync(client, fromUserId, message.ContextToken,
                WeChatPrompts.UnsupportedFile(WeChatPrompts.DefaultUserName), cancellationToken);
            return;
        }

        var attachments = new List<ChannelAttachment>();
        foreach (var item in media)
        {
            var downloadable = item.Kind == "image" || (item.Kind == "file" && item.Analyzable);
            if (!downloadable) continue;
            if (item.Media is null)
            {
                await SendInterceptTextAsync(client, fromUserId, message.ContextToken,
                    WeChatPrompts.DownloadMissing(WeChatPrompts.DefaultUserName), cancellationToken);
                return;
            }
            var maxBytes = item.Kind == "image" ? ImageMaxBytes() : FileMaxBytes();
            byte[] data;
            try
            {
                data = await _cdn.DownloadAsync(item.Media, maxBytes, cancellationToken);
            }
            catch (WeChatMediaTooLargeException ex)
            {
                await SendInterceptTextAsync(client, fromUserId, message.ContextToken,
                    WeChatPrompts.TooLarge(WeChatPrompts.DefaultUserName, ex.MaxBytes), cancellationToken);
                return;
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                _logger.LogWarning("微信入站媒体下载失败 kind={Kind} error={Error}", item.Kind, ex.Message);
                await SendInterceptTextAsync(client, fromUserId, message.ContextToken,
                    WeChatPrompts.DownloadFailed(WeChatPrompts.DefaultUserName, ex.Message), cancellationToken);
                return;
            }
            var extension = WeChatMediaStore.PickExtension(item.Extension, item.Kind, data);
            var filePath = await _mediaStore.SaveAsync(message.MsgId, item.FileName, extension, data, cancellationToken);
            attachments.Add(new ChannelAttachment
            {
                Kind = item.Kind == "image" ? ChannelAttachmentKinds.Image : ChannelAttachmentKinds.File,
                FilePath = filePath,
                Mime = WeChatMediaStore.MimeFromExtension(extension),
                Caption = item.FileName,
            });
        }

        var text = normalized.Message.Text;
        if (string.IsNullOrWhiteSpace(text) && attachments.Count > 0)
        {
            text = BuildPlaceholder(media);
        }
        var incoming = new IncomingMessage
        {
            Channel = ChannelIds.WeChat,
            SenderId = fromUserId,
            ChatId = fromUserId,
            MessageId = normalized.Message.MessageId,
            Text = text,
            Attachments = attachments.Count > 0 ? attachments : null,
            At = normalized.Message.At,
        };
        try
        {
            await handler(incoming, cancellationToken);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            // 停止中：丢弃在途处理
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "微信入站消息处理失败 messageId={MessageId}", message.MsgId);
        }
    }

    /// <summary>
    /// 记录 target → context_token（出站回复用）。P2-8：超过上限按最久未更新淘汰（LRU），
    /// 避免多用户 24/7 下无界增长（§3.5 适配器状态内存口径）。
    /// </summary>
    private void RememberReplyContext(string target, string contextToken)
    {
        _replyContextByTarget[target] = new ReplyContextEntry(
            contextToken, Interlocked.Increment(ref _replyContextSequence));
        var limit = ReplyContextLimit;
        if (limit <= 0 || _replyContextByTarget.Count <= limit) return;
        var overflow = _replyContextByTarget.Count - limit;
        foreach (var pair in _replyContextByTarget.OrderBy(pair => pair.Value.Sequence).Take(overflow))
        {
            _replyContextByTarget.TryRemove(pair.Key, out _);
        }
    }

    /// <summary>出站回复上下文（token + 单调序号；同毫秒写入也能稳定按最久未更新淘汰）。</summary>
    private sealed record ReplyContextEntry(string Token, long Sequence);

    /// <summary>事件文本占位（§3.3）：[图片] / [文件: name]。</summary>
    internal static string BuildPlaceholder(IEnumerable<WeChatInboundMedia> media)
    {
        var placeholders = new List<string>();
        foreach (var item in media)
        {
            if (item.Kind == "image") placeholders.Add("[图片]");
            else if (item.Kind == "file" && item.Analyzable) placeholders.Add($"[文件: {item.FileName}]");
        }
        return string.Join(" ", placeholders);
    }

    private async Task SendInterceptTextAsync(
        ILinkProtocolClient client, string toUserId, string contextToken, string text, CancellationToken cancellationToken)
    {
        if (string.IsNullOrEmpty(toUserId) || string.IsNullOrEmpty(contextToken)) return;
        try
        {
            var result = await client.SendTextAsync(toUserId, text, contextToken, cancellationToken);
            if (!result.Ok)
            {
                _logger.LogWarning("微信入站拦截回复发送失败 error={Error}", result.Error);
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            // 停止中：忽略
        }
        catch (Exception ex)
        {
            _logger.LogWarning("微信入站拦截回复异常 error={Error}", ex.Message);
        }
    }

    private long ImageMaxBytes() => Math.Min(ImageMaxMb, _options.WeChatMediaMaxMb) * 1024L * 1024L;

    private long FileMaxBytes() => _options.WeChatMediaMaxMb * 1024L * 1024L;

    // ── 出站 ────────────────────────────────────────────────────────────────

    public async Task<ChannelSendResult> SendAsync(OutgoingMessage message, CancellationToken cancellationToken = default)
    {
        var client = _client;
        if (client is null) return ChannelSendResult.Failure("微信未连接");
        if (!_replyContextByTarget.TryGetValue(message.TargetId, out var replyContext)
            || string.IsNullOrEmpty(replyContext.Token))
        {
            return ChannelSendResult.Failure("缺少微信 context_token，无法回复");
        }
        var contextToken = replyContext.Token;

        var anyOk = false;
        string? lastError = null;
        foreach (var part in message.Parts)
        {
            (bool Ok, string? Error) result;
            switch (part.Kind)
            {
                case OutgoingPartKinds.Text:
                {
                    var text = (part.Text ?? "").Trim();
                    if (text.Length == 0) continue;
                    // §2.5：超 maxTextLength（2048）按桌面 splitTextBySentenceBreaks 同口径分片
                    var chunks = text.Length <= Capability.MaxTextLength
                        ? new List<string> { text }
                        : ChannelTextSplitting.SplitBySentenceBreaks(text);
                    foreach (var chunk in chunks)
                    {
                        var sent = await client.SendTextAsync(message.TargetId, chunk, contextToken, cancellationToken);
                        if (sent.Ok)
                        {
                            anyOk = true;
                        }
                        else
                        {
                            lastError = sent.Error ?? "微信文本发送失败";
                            _logger.LogWarning("微信出站片段失败 kind={Kind} error={Error}", part.Kind, lastError);
                        }
                    }
                    continue;
                }
                case OutgoingPartKinds.Image:
                    result = await TrySendMediaPartAsync(
                        client, message, part, contextToken, part.FilePath, WeChatMediaTypes.Image, cancellationToken);
                    break;
                case OutgoingPartKinds.Sticker:
                    result = await TrySendMediaPartAsync(
                        client, message, part, contextToken, part.ImagePath, WeChatMediaTypes.Image, cancellationToken);
                    break;
                case OutgoingPartKinds.File:
                    result = await TrySendMediaPartAsync(
                        client, message, part, contextToken, part.FilePath, WeChatMediaTypes.File, cancellationToken);
                    break;
                case OutgoingPartKinds.Video:
                    result = await TrySendMediaPartAsync(
                        client, message, part, contextToken, part.FilePath, WeChatMediaTypes.Video, cancellationToken);
                    break;
                case OutgoingPartKinds.Audio:
                    // §4.1 V1：ISilkCodec 不可用 → 跳过并记 lastErr（状态 detail voice:false）
                    result = _silk.IsAvailable
                        ? await TrySendVoicePartAsync(client, message, part, contextToken, cancellationToken)
                        : (false, WeChatPrompts.VoiceUnavailable);
                    break;
                case OutgoingPartKinds.Card:
                    continue; // capability=false，与桌面适配器一致静默跳过
                default:
                    continue;
            }
            if (result.Ok)
            {
                anyOk = true;
            }
            else
            {
                lastError = result.Error ?? $"微信{PartName(part.Kind)}发送失败";
                _logger.LogWarning("微信出站片段失败 kind={Kind} error={Error}", part.Kind, lastError);
            }
        }
        if (!anyOk && lastError is not null) return ChannelSendResult.Failure(lastError);
        return ChannelSendResult.Success;
    }

    private async Task<(bool Ok, string? Error)> TrySendMediaPartAsync(
        ILinkProtocolClient client,
        OutgoingMessage message,
        OutgoingPart part,
        string contextToken,
        string? filePath,
        int mediaType,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrEmpty(filePath))
        {
            return (false, $"微信{PartName(part.Kind)}发送需要本地 filePath");
        }
        try
        {
            var media = await _cdn.UploadFileAsync(
                client, message.TargetId, filePath, mediaType, FileMaxBytes(), cancellationToken);
            var plan = WeChatNormalizer.BuildSendRequests(SinglePartMessage(message, part), new WeChatSendContext
            {
                ContextToken = contextToken,
                ClientId = Guid.NewGuid().ToString(),
                Uploads = new Dictionary<string, WeChatCdnMedia> { [filePath] = media },
            });
            return await SendPlanAsync(client, plan, PartName(part.Kind), cancellationToken);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            return (false, ex.Message);
        }
    }

    private async Task<(bool Ok, string? Error)> TrySendVoicePartAsync(
        ILinkProtocolClient client,
        OutgoingMessage message,
        OutgoingPart part,
        string contextToken,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrEmpty(part.FilePath))
        {
            return (false, "微信语音发送需要本地 filePath");
        }
        try
        {
            var source = await File.ReadAllBytesAsync(part.FilePath, cancellationToken);
            var encoded = await _silk.EncodeAsync(source, 24000, cancellationToken);
            var media = await _cdn.UploadAsync(
                client, message.TargetId, encoded.Data, WeChatMediaTypes.Voice, cancellationToken);
            var plan = WeChatNormalizer.BuildSendRequests(SinglePartMessage(message, part), new WeChatSendContext
            {
                ContextToken = contextToken,
                ClientId = Guid.NewGuid().ToString(),
                Voices = new Dictionary<string, WeChatVoiceUpload>
                {
                    [part.FilePath] = new WeChatVoiceUpload
                    {
                        Media = media,
                        Playtime = encoded.DurationMs,
                        SampleRate = encoded.SampleRate,
                        EncodeType = encoded.EncodeType,
                    },
                },
            });
            return await SendPlanAsync(client, plan, PartName(part.Kind), cancellationToken);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            return (false, ex.Message);
        }
    }

    private static async Task<(bool Ok, string? Error)> SendPlanAsync(
        ILinkProtocolClient client, WeChatSendPlan plan, string partName, CancellationToken cancellationToken)
    {
        if (plan.Error is not null) return (false, plan.Error);
        if (plan.Requests.Count == 0) return (false, $"微信{partName}请求构造为空");
        var result = await client.SendRequestAsync(plan.Requests[0], cancellationToken);
        return result.Ok ? (true, null) : (false, result.Error ?? $"微信{partName}发送失败");
    }

    private static OutgoingMessage SinglePartMessage(OutgoingMessage source, OutgoingPart part) => new()
    {
        Channel = source.Channel,
        ChatType = source.ChatType,
        TargetId = source.TargetId,
        ThreadId = source.ThreadId,
        Parts = [part],
    };

    private static string PartName(string kind) => kind switch
    {
        OutgoingPartKinds.Text => "文本",
        OutgoingPartKinds.Image => "图片",
        OutgoingPartKinds.File => "文件",
        OutgoingPartKinds.Video => "视频",
        OutgoingPartKinds.Audio => "语音",
        OutgoingPartKinds.Sticker => "表情",
        _ => "消息",
    };
}

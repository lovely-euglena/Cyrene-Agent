using System.Text.Json;
using CyreneNative.Channels;
using CyreneNative.Channels.Normalizers;

namespace CyreneCloud.Channels.Adapters.Feishu;

/// <summary>飞书入站处理结果（webhook 回执/自测观测用）。</summary>
public sealed record FeishuHandleResult(
    bool Duplicate, bool Ignored, IncomingMessage? Message, OutgoingMessage? Outgoing);

/// <summary>
/// 飞书适配器（设计 §6，IKJK2S）：webhook 事件接收 + 自研最小 REST 发送 + 媒体下载/转码。
///
/// 与微信/QQ 的「适配器自带长连接/轮询」不同：飞书入站由 <see cref="FeishuWebhookProcessor"/>
/// 经公开路由 <c>POST /v1/channels/feishu/webhook</c> 驱动，<see cref="StartAsync"/> 只做
/// 状态与托管生命周期标记（webhook 常开）；出站走 <see cref="FeishuApiClient"/>。
///
/// 媒体：入站 ≤20MB 流式落盘（mediaDir），附件路径注入 text（`[附件: path]`，镜像桌面）；
/// 出站语音用 <see cref="FeishuMediaTranscoder"/> 转 Ogg Opus，ffmpeg 不可用或
/// CLOUD_CHANNEL_FEISHU_AUDIO=0 时降级为文本提示（§6.3）。
/// </summary>
public sealed class FeishuAdapter : IChannelAdapter
{
    /// <summary>入站媒体单文件上限（§6.3：≤20MB）。</summary>
    public const long MaxMediaBytes = 20L * 1024 * 1024;

    /// <summary>语音转码不可用时的文本降级（§6.3；CLOUD_CHANNEL_FEISHU_AUDIO=0 同口径）。</summary>
    public const string AudioFallbackText = "（语音消息：服务端未启用语音转码，已降级为文本提示）";

    private readonly ChannelOptions _options;
    private readonly ChannelStore _store;
    private readonly FeishuApiClient _api;
    private readonly FeishuMediaTranscoder _transcoder;
    private readonly string _mediaDir;
    private readonly ILogger<FeishuAdapter> _logger;
    private readonly object _sync = new();

    private volatile bool _started;
    private DateTimeOffset _since = DateTimeOffset.UtcNow;
    private string? _lastErrorCode;
    private DateTimeOffset? _lastEventAt;
    private long _received;
    private long _duplicates;
    private bool? _transcoderAvailable;

    public FeishuAdapter(
        ChannelOptions options,
        ChannelStore store,
        FeishuApiClient api,
        FeishuMediaTranscoder transcoder,
        string mediaDir,
        ILogger<FeishuAdapter> logger)
    {
        _options = options;
        _store = store;
        _api = api;
        _transcoder = transcoder;
        _mediaDir = mediaDir;
        _logger = logger;
    }

    public string Id => ChannelIds.Feishu;

    public string DisplayName => "飞书";

    public ChannelCapability Capability => ChannelCapabilities.For(ChannelIds.Feishu);

    public Func<IncomingMessage, CancellationToken, Task<OutgoingMessage?>>? OnMessage { get; set; }

    /// <summary>凭据齐备（App ID/Secret + Verification Token；Encrypt Key 可选）。</summary>
    public bool Configured =>
        !string.IsNullOrWhiteSpace(_options.FeishuAppId)
        && !string.IsNullOrWhiteSpace(_options.FeishuAppSecret)
        && !string.IsNullOrWhiteSpace(_options.FeishuVerificationToken);

    /// <summary>有效语音能力：开关开启且 ffmpeg 探针可用（状态 detail 标注；能力表保持冻结值）。</summary>
    public bool VoiceAvailable => _options.FeishuAudio && _transcoderAvailable == true;

    // ── 生命周期（webhook 常开；Start/Stop 只切托管状态）──────────────────────

    public Task StartAsync(CancellationToken cancellationToken = default)
    {
        lock (_sync)
        {
            _started = true;
            _since = DateTimeOffset.UtcNow;
        }
        _logger.LogInformation("飞书适配器已启动（webhook 接收就绪）");
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken = default)
    {
        _started = false;
        _logger.LogInformation("飞书适配器已停止（webhook 仍接收，入站按归属门闩处理）");
        return Task.CompletedTask;
    }

    public ChannelStatus GetStatus()
    {
        var configured = Configured;
        var phase = !configured
            ? ChannelPhases.ConfigMissing
            : (_started ? ChannelPhases.Running : ChannelPhases.Offline);
        var detail = JsonSerializer.SerializeToElement(new
        {
            owner = "server",
            since = ChannelSessionId.UtcNowIso(_since),
            webhook = _started ? "ready" : "stopped",
            audio = _options.FeishuAudio,
            transcoder = _transcoderAvailable switch
            {
                true => "available",
                false => "unavailable",
                null => "unknown",
            },
            received = _received,
            duplicates = _duplicates,
            lastEventAt = _lastEventAt is null ? null : ChannelSessionId.UtcNowIso(_lastEventAt.Value),
            lastErrorCode = _lastErrorCode,
        }, ChannelJson.Options);
        return new ChannelStatus
        {
            Enabled = configured,
            Phase = phase,
            Message = !configured
                ? "飞书 App ID / App Secret / Verification Token 缺失"
                : (_started ? "webhook 接收就绪" : "未启动"),
            Detail = detail,
        };
    }

    // ── 入站（webhook 处理器调用）────────────────────────────────────────────

    /// <summary>
    /// 处理一条已解密的事件 envelope：双键去重 → 归一化（仅 p2p）→ 媒体下载 → OnMessage（Dispatcher）。
    /// 重复/忽略/未注册回调时返回对应结果且不抛异常（异常由 webhook 处理器兜底记录）。
    /// </summary>
    public async Task<FeishuHandleResult> HandleEventAsync(
        JsonElement envelope, CancellationToken cancellationToken = default)
    {
        var (messageKey, eventKey) = FeishuEventDedupe.Keys(envelope);
        if (messageKey is null && eventKey is null)
        {
            return new FeishuHandleResult(false, true, null, null);
        }
        var first = await FeishuEventDedupe.MarkSeenAsync(_store, envelope, cancellationToken).ConfigureAwait(false);
        if (!first)
        {
            Interlocked.Increment(ref _duplicates);
            _logger.LogDebug("飞书事件重复，跳过 eventId={EventKey}", eventKey);
            return new FeishuHandleResult(true, false, null, null);
        }

        var normalized = FeishuNormalizer.NormalizeInbound(envelope, DateTimeOffset.UtcNow);
        if (normalized is null)
        {
            // 非 im.message.receive_v1 / 群消息 / 结构不合法：记日志忽略（§6.2 仅私聊）
            _logger.LogDebug("飞书事件忽略（非 p2p 消息或未知事件）eventId={EventKey}", eventKey);
            return new FeishuHandleResult(false, true, null, null);
        }

        var message = await EnrichWithMediaAsync(normalized, cancellationToken).ConfigureAwait(false);
        Interlocked.Increment(ref _received);
        _lastEventAt = DateTimeOffset.UtcNow;
        if (OnMessage is null)
        {
            _logger.LogWarning("飞书入站消息未注册 dispatcher，仅完成去重与归一化");
            return new FeishuHandleResult(false, false, message, null);
        }
        var outgoing = await OnMessage(message, cancellationToken).ConfigureAwait(false);
        return new FeishuHandleResult(false, false, message, outgoing);
    }

    /// <summary>下载媒体描述符到 mediaDir 并填充 attachments；失败仅跳过该附件（不阻断消息）。</summary>
    private async Task<IncomingMessage> EnrichWithMediaAsync(
        FeishuNormalizedInbound normalized, CancellationToken cancellationToken)
    {
        if (normalized.Media.Count == 0) return normalized.Message;
        var message = normalized.Message;
        var attachments = new List<ChannelAttachment>();
        var text = message.Text;
        foreach (var media in normalized.Media)
        {
            var (extension, mime) = FeishuNormalizer.ResourceKindToExt(media.Kind);
            var resourceType = media.Kind is "image" ? "image" : "file";
            var keySuffix = Sanitize(media.FileKey);
            keySuffix = keySuffix.Length <= 8 ? keySuffix : keySuffix[^8..];
            var destPath = Path.Combine(
                _mediaDir, $"feishu-{Sanitize(message.MessageId ?? "msg")}-{keySuffix}{extension}");
            try
            {
                await _api.DownloadResourceAsync(
                    message.MessageId ?? "", media.FileKey, resourceType, destPath,
                    MaxMediaBytes, cancellationToken).ConfigureAwait(false);
                attachments.Add(new ChannelAttachment
                {
                    Kind = media.Kind,
                    FilePath = destPath,
                    Mime = mime,
                    Caption = media.FileName,
                });
                text = (string.IsNullOrEmpty(text) ? "" : text + "\n") + $"[附件: {destPath}]";
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                _logger.LogWarning(
                    "飞书媒体下载失败 kind={Kind} fileKey={FileKey} error={Error}",
                    media.Kind, media.FileKey, ex.Message);
            }
        }
        if (attachments.Count == 0) return message;
        return new IncomingMessage
        {
            Channel = message.Channel,
            ChatType = message.ChatType,
            MessageId = message.MessageId,
            SenderId = message.SenderId,
            SenderName = message.SenderName,
            ChatId = message.ChatId,
            ThreadId = message.ThreadId,
            Text = text,
            Attachments = attachments,
            Mentions = message.Mentions,
            Reply = message.Reply,
            At = message.At,
        };
    }

    // ── 出站 ─────────────────────────────────────────────────────────────────

    public async Task<ChannelSendResult> SendAsync(
        OutgoingMessage message, CancellationToken cancellationToken = default)
    {
        if (!Configured)
        {
            return ChannelSendResult.Failure("E_FEISHU_CONFIG_MISSING");
        }
        if (message.Parts.Count == 0)
        {
            return ChannelSendResult.Failure("E_FEISHU_EMPTY_MESSAGE");
        }

        try
        {
            var uploads = new Dictionary<string, FeishuUploadResult>();
            var parts = new List<OutgoingPart>();
            foreach (var part in message.Parts)
            {
                switch (part.Kind)
                {
                    case OutgoingPartKinds.Text:
                    case OutgoingPartKinds.Card:
                        parts.Add(part);
                        break;
                    case OutgoingPartKinds.Image:
                        parts.Add(part);
                        if (part.FilePath is not null)
                        {
                            uploads[part.FilePath] = new FeishuUploadResult
                            {
                                ImageKey = await _api.UploadImageAsync(part.FilePath, cancellationToken)
                                    .ConfigureAwait(false),
                            };
                        }
                        break;
                    case OutgoingPartKinds.Sticker:
                        parts.Add(part);
                        if (part.ImagePath is not null)
                        {
                            uploads[part.ImagePath] = new FeishuUploadResult
                            {
                                ImageKey = await _api.UploadImageAsync(part.ImagePath, cancellationToken)
                                    .ConfigureAwait(false),
                            };
                        }
                        break;
                    case OutgoingPartKinds.File:
                        parts.Add(part);
                        if (part.FilePath is not null)
                        {
                            uploads[part.FilePath] = new FeishuUploadResult
                            {
                                FileKey = await _api.UploadFileAsync(
                                    part.FilePath, ResolveFileName(part), "stream", null, cancellationToken)
                                    .ConfigureAwait(false),
                            };
                        }
                        break;
                    case OutgoingPartKinds.Video:
                        parts.Add(part);
                        if (part.FilePath is not null)
                        {
                            uploads[part.FilePath] = new FeishuUploadResult
                            {
                                FileKey = await _api.UploadFileAsync(
                                    part.FilePath, ResolveFileName(part), "mp4", null, cancellationToken)
                                    .ConfigureAwait(false),
                            };
                        }
                        break;
                    case OutgoingPartKinds.Audio:
                    {
                        var fallback = await PrepareAudioAsync(part, uploads, cancellationToken)
                            .ConfigureAwait(false);
                        parts.Add(fallback ?? part);
                        break;
                    }
                    default:
                        parts.Add(part);
                        break;
                }
            }

            var effective = new OutgoingMessage
            {
                Channel = message.Channel,
                ChatType = message.ChatType,
                TargetId = message.TargetId,
                ThreadId = message.ThreadId,
                ReplyContext = message.ReplyContext,
                Parts = parts,
            };
            var plan = FeishuNormalizer.BuildSendRequests(effective, new FeishuSendContext
            {
                Uploads = uploads,
            });
            if (plan.Error is not null)
            {
                RecordError("E_FEISHU_SEND_PLAN");
                return ChannelSendResult.Failure(plan.Error);
            }

            string? firstError = null;
            var anyOk = false;
            foreach (var request in plan.Requests)
            {
                try
                {
                    await _api.SendMessageAsync(plan.ReceiveIdType, request, cancellationToken).ConfigureAwait(false);
                    anyOk = true;
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    firstError ??= ex is FeishuApiException api ? api.ErrorCode : "E_FEISHU_SEND_FAILED";
                    _logger.LogWarning("飞书发送失败 msgType={MsgType} error={Error}", request.MsgType, ex.Message);
                }
            }
            if (!anyOk)
            {
                RecordError(firstError ?? "E_FEISHU_SEND_FAILED");
                return ChannelSendResult.Failure(firstError ?? "E_FEISHU_SEND_FAILED");
            }
            RecordSuccess();
            return ChannelSendResult.Success;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            return ChannelSendResult.Failure("canceled");
        }
        catch (FeishuApiException ex)
        {
            RecordError(ex.ErrorCode);
            return ChannelSendResult.Failure(ex.ErrorCode);
        }
        catch (Exception ex)
        {
            RecordError("E_FEISHU_SEND_FAILED");
            _logger.LogWarning("飞书发送异常: {Message}", ex.Message);
            return ChannelSendResult.Failure("E_FEISHU_SEND_FAILED");
        }
    }

    /// <summary>
    /// 语音 part 处理：已是 Ogg Opus 直接上传；否则 ffmpeg 转码后上传；
    /// 开关关闭/ffmpeg 不可用/转码失败 → 返回文本降级 part（§6.3）。
    /// </summary>
    private async Task<OutgoingPart?> PrepareAudioAsync(
        OutgoingPart part, Dictionary<string, FeishuUploadResult> uploads, CancellationToken cancellationToken)
    {
        if (part.FilePath is null) return null; // 交给 Normalizer 报「缺少音频上传结果」
        if (!_options.FeishuAudio)
        {
            return new OutgoingPart { Kind = OutgoingPartKinds.Text, Text = AudioFallbackText };
        }

        string? uploadPath = part.FilePath;
        if (!LooksLikeOggOpus(part))
        {
            try
            {
                uploadPath = await _transcoder
                    .TranscodeToOggOpusAsync(part.FilePath, _mediaDir, cancellationToken).ConfigureAwait(false);
                _transcoderAvailable = true;
            }
            catch (FeishuTranscodeException ex)
            {
                _transcoderAvailable = false;
                _logger.LogWarning("飞书语音转码降级为文本 error={Error} detail={Detail}", ex.ErrorCode, ex.Message);
                return new OutgoingPart { Kind = OutgoingPartKinds.Text, Text = AudioFallbackText };
            }
        }

        try
        {
            uploads[part.FilePath] = new FeishuUploadResult
            {
                FileKey = await _api.UploadFileAsync(
                    uploadPath, ResolveFileName(part, ".ogg"), "opus", null, cancellationToken)
                    .ConfigureAwait(false),
            };
            return null;
        }
        finally
        {
            if (!string.Equals(uploadPath, part.FilePath, StringComparison.Ordinal))
            {
                TryDelete(uploadPath);
            }
        }
    }

    private static bool LooksLikeOggOpus(OutgoingPart part)
    {
        if (part.Mime == "audio/ogg" || part.Mime == "audio/opus") return true;
        if (part.FilePath is not null
            && Path.GetExtension(part.FilePath).Equals(".opus", StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }
        return part.FilePath is not null && FeishuMediaTranscoder.IsOggOpusFile(part.FilePath);
    }

    private static string ResolveFileName(OutgoingPart part, string fallbackExtension = ".bin") =>
        !string.IsNullOrEmpty(part.Name)
            ? part.Name!
            : Path.GetFileName(part.FilePath ?? "") is { Length: > 0 } name
                ? name
                : $"file{fallbackExtension}";

    private void RecordError(string errorCode)
    {
        _lastErrorCode = errorCode;
    }

    private void RecordSuccess()
    {
        _lastErrorCode = null;
    }

    private static string Sanitize(string value)
    {
        var invalid = Path.GetInvalidFileNameChars();
        var builder = new System.Text.StringBuilder(value.Length);
        foreach (var ch in value)
        {
            builder.Append(Array.IndexOf(invalid, ch) >= 0 ? '_' : ch);
        }
        return builder.ToString();
    }

    private static void TryDelete(string path)
    {
        try
        {
            if (File.Exists(path)) File.Delete(path);
        }
        catch
        {
            // best-effort 清理（转码临时文件）
        }
    }
}

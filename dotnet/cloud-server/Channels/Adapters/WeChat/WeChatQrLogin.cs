using System.Text.Json;
using CyreneNative.Channels;
using QRCoder;

namespace CyreneCloud.Channels.Adapters.WeChat;

/// <summary>
/// 微信 iLink 扫码登录服务（设计 §3.4）。
///
/// `get_bot_qrcode` → 用 qrcode_img_content（liteapp URL）渲染 PNG（QRCoder，内存持有不落盘，TTL 5 分钟）
/// → 后台轮询 `get_qrcode_status` → confirmed 时凭据 JSON 加密写 <see cref="ChannelStore"/> 并自动重启适配器；
/// 重复 start 覆盖旧 loginId（旧二维码作废）；logout 幂等（删凭据 + 停适配器）。
/// </summary>
public sealed class WeChatQrLogin
{
    public static readonly TimeSpan LoginTtl = TimeSpan.FromMinutes(5);

    private static readonly TimeSpan DefaultPollRetryDelay = TimeSpan.FromSeconds(1);

    private readonly ChannelStore _store;
    private readonly ChannelManager _manager;
    private readonly ILogger<WeChatQrLogin> _logger;
    private readonly Func<ILinkLoginClient> _clientFactory;
    private readonly TimeSpan _pollRetryDelay;

    private readonly object _sync = new();
    private LoginState? _current;
    private CancellationTokenSource? _pollCts;

    public WeChatQrLogin(
        ChannelOptions options,
        ChannelStore store,
        ChannelManager manager,
        ILogger<WeChatQrLogin> logger,
        Func<ILinkLoginClient>? clientFactory = null,
        TimeSpan? pollRetryDelay = null)
    {
        _store = store;
        _manager = manager;
        _logger = logger;
        _clientFactory = clientFactory
            ?? (() => new ILinkLoginClient(WeChatHttp.CreateClient(), options.WeChatBaseUrl));
        _pollRetryDelay = pollRetryDelay ?? DefaultPollRetryDelay;
    }

    public sealed record StartResult(
        bool Ok, string? LoginId, string? PngBase64, DateTimeOffset ExpiresAt, string? Error);

    public sealed record StatusResult(string Status, string? BotId, string? Error);

    /// <summary>发起登录：拉二维码 → 渲染 PNG → 记录 loginId 并后台轮询。</summary>
    public async Task<StartResult> StartAsync(CancellationToken cancellationToken = default)
    {
        var client = _clientFactory();
        ILinkQrCodeResponse qr;
        try
        {
            qr = await client.FetchQrCodeAsync(cancellationToken);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            _logger.LogWarning("微信二维码获取失败 error={Error}", ex.Message);
            return new StartResult(false, null, null, default, $"获取二维码失败：{ex.Message}");
        }

        string pngBase64;
        try
        {
            pngBase64 = QrPngRenderer.RenderBase64(qr.QrcodeImgContent!);
        }
        catch (Exception ex)
        {
            _logger.LogWarning("微信二维码渲染失败 error={Error}", ex.Message);
            return new StartResult(false, null, null, default, "二维码渲染失败，请重试");
        }

        var state = new LoginState(Guid.NewGuid().ToString("N"), qr.Qrcode!, DateTimeOffset.UtcNow + LoginTtl);
        CancellationTokenSource pollCts;
        lock (_sync)
        {
            // 旧 loginId 作废：只取消不 Dispose（旧轮询可能仍在在途请求中引用该 token）
            _pollCts?.Cancel();
            pollCts = new CancellationTokenSource();
            _pollCts = pollCts;
            _current = state;
        }
        _ = Task.Run(() => PollLoopAsync(client, state, pollCts.Token), CancellationToken.None);
        _logger.LogInformation("微信扫码登录已发起 loginId={LoginId}", state.LoginId);
        return new StartResult(true, state.LoginId, pngBase64, state.ExpiresAt, null);
    }

    /// <summary>查询登录状态；未知/被覆盖的 loginId 返回 error（旧二维码作废）。</summary>
    public StatusResult GetStatus(string loginId)
    {
        lock (_sync)
        {
            if (_current is null || _current.LoginId != loginId)
            {
                return new StatusResult("error", null, "登录会话不存在或已被替换");
            }
            if (DateTimeOffset.UtcNow >= _current.ExpiresAt && _current.Status is "pending" or "scanned")
            {
                _current.Status = "expired";
                _current.Error = "二维码已过期，请重新扫码";
            }
            return new StatusResult(_current.Status, _current.BotId, _current.Error);
        }
    }

    /// <summary>登出（幂等）：取消轮询 → 删凭据 → 停适配器。</summary>
    public async Task LogoutAsync(CancellationToken cancellationToken = default)
    {
        CancellationTokenSource? pollCts;
        lock (_sync)
        {
            pollCts = _pollCts;
            _pollCts = null;
            _current = null;
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
        await _store.DeleteCredentialAsync(ILinkBotAdapter.CredentialChannel, cancellationToken);
        await _manager.StopAsync(ILinkBotAdapter.CredentialChannel, cancellationToken);
        _logger.LogInformation("微信渠道已登出 channel=wechat");
    }

    // ── 轮询 ────────────────────────────────────────────────────────────────

    private async Task PollLoopAsync(ILinkLoginClient client, LoginState state, CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested && DateTimeOffset.UtcNow < state.ExpiresAt)
        {
            ILinkQrStatusResponse status;
            try
            {
                status = await client.PollQrStatusAsync(state.Qrcode, cancellationToken);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception ex)
            {
                // 网络抖动：保持 pending，按退避重试（与桌面 login() 的 continue 同口径）
                _logger.LogWarning("微信扫码状态轮询失败 error={Error}", ex.Message);
                try
                {
                    await Task.Delay(_pollRetryDelay, cancellationToken);
                }
                catch (OperationCanceledException)
                {
                    return;
                }
                continue;
            }

            switch (status.Status)
            {
                case "confirmed":
                    await ConfirmAsync(state, status, cancellationToken);
                    return;
                case "expired":
                    SetState(state, "expired", "二维码已过期，请重新扫码");
                    return;
                case "scanned":
                    SetState(state, "scanned", null);
                    break;
                default: // init / pending / scanning / 其它
                    SetState(state, "pending", null);
                    break;
            }
        }
        if (state.Status is "pending" or "scanned")
        {
            SetState(state, "expired", "二维码已过期，请重新扫码");
        }
    }

    private async Task ConfirmAsync(LoginState state, ILinkQrStatusResponse status, CancellationToken cancellationToken)
    {
        if (string.IsNullOrEmpty(status.BotToken) || string.IsNullOrEmpty(status.IlinkBotId))
        {
            SetState(state, "error", "扫码确认但缺少 bot 凭据，请重新发起");
            return;
        }
        var credentials = new ILinkCredentials
        {
            BotToken = status.BotToken!,
            IlinkBotId = status.IlinkBotId!,
            BaseUrl = string.IsNullOrWhiteSpace(status.BaseUrl) ? ILinkProtocolClient.DefaultBaseUrl : status.BaseUrl!,
            IlinkUserId = status.IlinkUserId ?? "",
        };
        try
        {
            var json = JsonSerializer.Serialize(credentials, ChannelJson.Options);
            await _store.SaveCredentialAsync(ILinkBotAdapter.CredentialChannel, json, cancellationToken);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            return;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "微信凭据落库失败 channel=wechat");
            SetState(state, "error", $"凭据保存失败：{ex.Message}");
            return;
        }
        state.BotId = credentials.IlinkBotId;
        SetState(state, "confirmed", null);
        _logger.LogInformation("微信扫码登录成功 botId={BotId}", credentials.IlinkBotId);
        await RestartAdapterAsync(cancellationToken);
    }

    private async Task RestartAdapterAsync(CancellationToken cancellationToken)
    {
        try
        {
            await _manager.StopAsync(ILinkBotAdapter.CredentialChannel, cancellationToken);
            await _manager.StartAsync(ILinkBotAdapter.CredentialChannel, cancellationToken);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "微信登录后重启适配器失败（下次启动/重试仍会加载新凭据）");
        }
    }

    private void SetState(LoginState state, string status, string? error)
    {
        lock (_sync)
        {
            state.Status = status;
            state.Error = error;
        }
    }

    private sealed class LoginState(string loginId, string qrcode, DateTimeOffset expiresAt)
    {
        public string LoginId { get; } = loginId;
        public string Qrcode { get; } = qrcode;
        public DateTimeOffset ExpiresAt { get; } = expiresAt;
        public string Status { get; set; } = "pending";
        public string? BotId { get; set; }
        public string? Error { get; set; }
    }
}

/// <summary>二维码 PNG 渲染（QRCoder；内容为 liteapp URL，微信只认 URL 二维码，不认裸 ticket）。</summary>
internal static class QrPngRenderer
{
    public static string RenderBase64(string content, int pixelsPerModule = 8)
    {
        using var generator = new QRCodeGenerator();
        using var data = generator.CreateQrCode(content, QRCodeGenerator.ECCLevel.M);
        var png = new PngByteQRCode(data).GetGraphic(pixelsPerModule);
        return Convert.ToBase64String(png);
    }
}

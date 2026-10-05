using CyreneNative.Channels;

namespace CyreneCloud.Channels;

/// <summary>
/// 统一发送边界（TS `src/main/channels/delivery-service.ts` 的镜像 + §2.5 重试口径）。
///
/// 找到 adapter 后发送；失败同轮重试 1 次（退避 1s）；仍失败返回 failed（不自动无限重发）。
/// 错误只带适配器返回的错误码/人话，日志不含消息正文与凭据。
/// </summary>
public sealed class ChannelDeliveryService
{
    private static readonly TimeSpan DefaultRetryDelay = TimeSpan.FromSeconds(1);

    private readonly ChannelManager _manager;
    private readonly ILogger<ChannelDeliveryService> _logger;
    private readonly TimeSpan _retryDelay;

    public ChannelDeliveryService(
        ChannelManager manager,
        ILogger<ChannelDeliveryService> logger,
        TimeSpan? retryDelay = null)
    {
        _manager = manager;
        _logger = logger;
        _retryDelay = retryDelay ?? DefaultRetryDelay;
    }

    public async Task<ChannelDeliveryResult> SendAsync(
        OutgoingMessage message, CancellationToken cancellationToken = default)
    {
        var adapter = _manager.GetAdapter(message.Channel);
        if (adapter is null)
        {
            return new ChannelDeliveryResult(false, "adapter_not_found");
        }

        var first = await TrySendAsync(adapter, message, cancellationToken);
        if (first.Ok) return first;

        // 同轮重试 1 次（退避 1s，§2.5）；停止信号直接放弃
        try
        {
            await Task.Delay(_retryDelay, cancellationToken);
        }
        catch (OperationCanceledException)
        {
            return new ChannelDeliveryResult(false, first.Error ?? "canceled");
        }
        var second = await TrySendAsync(adapter, message, cancellationToken);
        if (second.Ok) return second;
        return new ChannelDeliveryResult(false, second.Error ?? first.Error ?? "send_failed");
    }

    private async Task<ChannelDeliveryResult> TrySendAsync(
        IChannelAdapter adapter, OutgoingMessage message, CancellationToken cancellationToken)
    {
        try
        {
            var result = await adapter.SendAsync(message, cancellationToken);
            if (result.Ok) return new ChannelDeliveryResult(true, null);
            _logger.LogWarning("渠道发送失败 channel={Channel} error={Error}", message.Channel, result.Error);
            return new ChannelDeliveryResult(false, result.Error ?? "send_failed");
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            return new ChannelDeliveryResult(false, "canceled");
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "渠道发送异常 channel={Channel}", message.Channel);
            return new ChannelDeliveryResult(false, ex.Message);
        }
    }
}

public sealed record ChannelDeliveryResult(bool Ok, string? Error);

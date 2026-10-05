using CyreneNative.Channels;

namespace CyreneCloud.Channels;

/// <summary>
/// 渠道适配器接口（TS `src/main/channels/adapters/base.ts` 的镜像）。
///
/// 适配器只负责协议收发、消息归一化与账号凭证管理；不直接调用智能体，
/// 也不重复发送入站回调的返回值（Dispatcher 负责投递）。
/// 具体适配器（微信 iLink / 飞书 / QQ 官方）属阶段 3-6，经 <see cref="ChannelAdapterCatalog"/> 注册。
/// </summary>
public interface IChannelAdapter
{
    string Id { get; }
    string DisplayName { get; }
    ChannelCapability Capability { get; }

    /// <summary>管理器在启动前注入；适配器通过此回调把入站消息交给调度器。</summary>
    Func<IncomingMessage, CancellationToken, Task<OutgoingMessage?>>? OnMessage { get; set; }

    Task StartAsync(CancellationToken cancellationToken = default);
    Task StopAsync(CancellationToken cancellationToken = default);

    /// <summary>出站：把统一 OutgoingMessage 翻译成平台协议发出去。</summary>
    Task<ChannelSendResult> SendAsync(OutgoingMessage message, CancellationToken cancellationToken = default);

    /// <summary>UI/状态端点展示用；轮询调用，适配器内部缓存即可。</summary>
    ChannelStatus GetStatus();
}

/// <summary>发送结果（错误只带渠道错误码/人话，不带凭据与正文）。</summary>
public sealed record ChannelSendResult(bool Ok, string? Error)
{
    public static ChannelSendResult Success { get; } = new(true, null);
    public static ChannelSendResult Failure(string error) => new(false, error);
}

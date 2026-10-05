using CyreneNative.Channels;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace CyreneCloud.Channels.Adapters.QqBot;

/// <summary>
/// QQ 官方 bot 注册项（设计 §7.1：保留、仅被动回复）。
/// <c>SupportsProactive = false</c> → capabilities.channels.proactive 不含 qqbot（§2.6 / §7.3）。
/// </summary>
public sealed class QqBotAdapterRegistration : IChannelAdapterRegistration
{
    public string ChannelId => ChannelIds.QqBot;

    public bool SupportsProactive => false;

    public bool IsConfigured(ChannelOptions options) =>
        !string.IsNullOrWhiteSpace(options.QqBotAppId) && !string.IsNullOrWhiteSpace(options.QqBotAppSecret);

    public IChannelAdapter Create(IServiceProvider services) => new QqBotAdapter(
        services.GetRequiredService<ChannelOptions>(),
        services.GetRequiredService<ILogger<QqBotAdapter>>());
}

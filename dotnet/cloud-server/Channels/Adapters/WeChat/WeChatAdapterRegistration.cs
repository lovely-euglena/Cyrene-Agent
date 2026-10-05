using CyreneNative.Channels;

namespace CyreneCloud.Channels.Adapters.WeChat;

/// <summary>
/// 微信 iLink 适配器注册项（阶段 3；<see cref="ChannelAdapterCatalog.All"/> 追加一行即被托管服务发现）。
/// wechat 支持主动消息（capability/§2.6 channels.proactive）；配置齐备 = CLOUD_CHANNELS 含 wechat
/// （登录凭据为运行期状态，扫码后由 <see cref="WeChatQrLogin"/> 落库并重启适配器）。
/// </summary>
public sealed class WeChatAdapterRegistration : IChannelAdapterRegistration
{
    public string ChannelId => ChannelIds.WeChat;

    public bool SupportsProactive => true;

    public bool IsConfigured(ChannelOptions options) => options.IsChannelEnabled(ChannelId);

    public IChannelAdapter Create(IServiceProvider services) => new ILinkBotAdapter(
        services.GetRequiredService<ChannelOptions>(),
        services.GetRequiredService<ChannelStore>(),
        services.GetRequiredService<WeChatMediaStore>(),
        services.GetRequiredService<WeChatCdnClient>(),
        services.GetRequiredService<ISilkCodec>(),
        services.GetRequiredService<ILogger<ILinkBotAdapter>>());
}

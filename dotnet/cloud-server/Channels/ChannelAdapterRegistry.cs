using CyreneCloud.Channels.Adapters.Feishu;

namespace CyreneCloud.Channels;

/// <summary>
/// 适配器注册项（可扩展注册表条目）。
///
/// 阶段 3-6 各渠道适配器在自己的目录实现一个 registration（如
/// `Adapters/WeChat/WeChatAdapterRegistration.cs`），并在 <see cref="ChannelAdapterCatalog.All"/>
/// 追加一行即可被托管服务发现——框架侧零改动。
/// </summary>
public interface IChannelAdapterRegistration
{
    /// <summary>渠道 id（wechat / feishu / qqbot）。</summary>
    string ChannelId { get; }

    /// <summary>是否支持服务端主动消息（§2.6 channels.proactive；qqbot = false）。</summary>
    bool SupportsProactive { get; }

    /// <summary>凭据/配置是否齐备（决定 hosted 声明与是否启动）。</summary>
    bool IsConfigured(ChannelOptions options);

    IChannelAdapter Create(IServiceProvider services);
}

/// <summary>
/// 适配器注册表（阶段 3-6 的插入位）。
///
/// 阶段 5 起：飞书（webhook + 自研 REST）。
/// 追加示例（阶段 3/6）：
/// <code>new WeChatAdapterRegistration(),</code>
/// </summary>
public static class ChannelAdapterCatalog
{
    public static IReadOnlyList<IChannelAdapterRegistration> All { get; } =
    [
        new FeishuAdapterRegistration(),
    ];
}

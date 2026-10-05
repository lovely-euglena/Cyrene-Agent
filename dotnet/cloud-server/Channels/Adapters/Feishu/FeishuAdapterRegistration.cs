using CyreneNative.Channels;

namespace CyreneCloud.Channels.Adapters.Feishu;

/// <summary>
/// 飞书适配器注册项（阶段 5）：ChannelAdapterCatalog 追加一行即可被托管服务发现。
///
/// 配置门槛：App ID / App Secret（REST 发送与 token）+ Verification Token（webhook 校验）齐备；
/// Encrypt Key 可选（配置后强制签名校验 + 加密事件解密）。
/// 主动消息：支持（§6.4；收件人由服务端 recipients 表控制，投递端点属阶段 4）。
/// </summary>
public sealed class FeishuAdapterRegistration : IChannelAdapterRegistration
{
    public string ChannelId => ChannelIds.Feishu;

    public bool SupportsProactive => true;

    public bool IsConfigured(ChannelOptions options) =>
        !string.IsNullOrWhiteSpace(options.FeishuAppId)
        && !string.IsNullOrWhiteSpace(options.FeishuAppSecret)
        && !string.IsNullOrWhiteSpace(options.FeishuVerificationToken);

    public IChannelAdapter Create(IServiceProvider services)
    {
        var options = services.GetRequiredService<ChannelOptions>();
        var store = services.GetRequiredService<ChannelStore>();
        var loggerFactory = services.GetRequiredService<ILoggerFactory>();
        var api = new FeishuApiClient(
            options.FeishuAppId, options.FeishuAppSecret, logger: loggerFactory.CreateLogger<FeishuApiClient>());
        var transcoder = new FeishuMediaTranscoder(logger: loggerFactory.CreateLogger<FeishuMediaTranscoder>());
        // 归属门闩注入（P2-4b）：桌面持有期间适配器预检跳过媒体下载（无则退化为放行）
        var ownershipGate = services.GetService<ChannelOwnershipService>();
        return new FeishuAdapter(
            options, store, api, transcoder, ResolveMediaDir(),
            loggerFactory.CreateLogger<FeishuAdapter>(), ownershipGate);
    }

    /// <summary>入站媒体落盘目录（data/media/feishu；与 §3.3 媒体缓存同根，LRU/TTL 由后续媒体清理接入）。</summary>
    public static string ResolveMediaDir()
    {
        var dataDir = Environment.GetEnvironmentVariable("CYRENE_CLOUD_DATA")
            ?? Path.Combine(AppContext.BaseDirectory, "data");
        return Path.Combine(dataDir, "media", "feishu");
    }
}

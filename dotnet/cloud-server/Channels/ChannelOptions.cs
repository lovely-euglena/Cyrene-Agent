using CyreneNative.Channels;

namespace CyreneCloud.Channels;

/// <summary>
/// 渠道层配置（env，冻结面见 docs/design/2026-10-05-server-channel.md §2.3）。
/// CLOUD_CHANNELS 为空 = 渠道层整体关闭（不注册托管服务、零内存占用）。
/// </summary>
public sealed class ChannelOptions
{
    public static readonly string[] KnownChannels = [ChannelIds.WeChat, ChannelIds.Feishu, ChannelIds.QqBot];

    /// <summary>CLOUD_CHANNELS（逗号列表；空 = 关闭）。</summary>
    public IReadOnlyList<string> EnabledChannels { get; init; } = [];

    public bool ChannelsEnabled => EnabledChannels.Count > 0;

    /// <summary>CLOUD_CHANNEL_OWNERSHIP_TTL_SECONDS（桌面认领租约 TTL，阶段 4 用）。</summary>
    public int OwnershipTtlSeconds { get; init; } = 180;

    /// <summary>CLOUD_CHANNEL_FAILOVER_GRACE_SECONDS（桌面兜底不可达宽限，阶段 4 用）。</summary>
    public int FailoverGraceSeconds { get; init; } = 300;

    public string WeChatBaseUrl { get; init; } = "https://ilinkai.weixin.qq.com";
    public int WeChatMediaMaxMb { get; init; } = 20;

    /// <summary>数据目录根（媒体缓存等；Program 传 CYRENE_CLOUD_DATA，测试传临时目录）。</summary>
    public string DataDir { get; init; } = Path.Combine(AppContext.BaseDirectory, "data");

    public string? FeishuAppId { get; init; }
    public string? FeishuAppSecret { get; init; }
    public string? FeishuVerificationToken { get; init; }
    public string? FeishuEncryptKey { get; init; }
    /// <summary>CLOUD_CHANNEL_FEISHU_AUDIO（默认开；ffmpeg 不可用时置 0 走文本降级）。</summary>
    public bool FeishuAudio { get; init; } = true;

    public string? QqBotAppId { get; init; }
    public string? QqBotAppSecret { get; init; }
    public bool QqBotAllowAnyPrivate { get; init; }
    public IReadOnlyList<string> QqBotAllowedOpenIds { get; init; } = [];
    public bool QqBotStripUrls { get; init; }

    public string? AsrProvider { get; init; }
    public string? AsrBaseUrl { get; init; }
    public string? AsrApiKey { get; init; }
    public string? TtsProvider { get; init; }
    public string? TtsBaseUrl { get; init; }
    public string? TtsApiKey { get; init; }

    /// <summary>CLOUD_CHANNEL_VISION（direct = 图片模型直读；缺省 caption 优先）。</summary>
    public string? Vision { get; init; }

    /// <summary>CLOUD_CHANNEL_MEDIA_DIR_MB（媒体缓存总量上限）。</summary>
    public int MediaDirMb { get; init; } = 256;

    public bool IsChannelEnabled(string id) =>
        EnabledChannels.Contains(id, StringComparer.OrdinalIgnoreCase);

    public static ChannelOptions FromEnvironment(string? dataDir = null)
    {
        var enabled = (Environment.GetEnvironmentVariable("CLOUD_CHANNELS") ?? "")
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(item => item.ToLowerInvariant())
            .Distinct(StringComparer.Ordinal)
            .ToArray();
        return new ChannelOptions
        {
            EnabledChannels = enabled,
            DataDir = dataDir
                ?? Environment.GetEnvironmentVariable("CYRENE_CLOUD_DATA")
                ?? Path.Combine(AppContext.BaseDirectory, "data"),
            OwnershipTtlSeconds = ReadInt("CLOUD_CHANNEL_OWNERSHIP_TTL_SECONDS", 180),
            FailoverGraceSeconds = ReadInt("CLOUD_CHANNEL_FAILOVER_GRACE_SECONDS", 300),
            WeChatBaseUrl = ReadString("CLOUD_CHANNEL_WECHAT_BASE_URL") ?? "https://ilinkai.weixin.qq.com",
            WeChatMediaMaxMb = ReadInt("CLOUD_CHANNEL_WECHAT_MEDIA_MAX_MB", 20),
            FeishuAppId = ReadString("CLOUD_CHANNEL_FEISHU_APP_ID"),
            FeishuAppSecret = ReadString("CLOUD_CHANNEL_FEISHU_APP_SECRET"),
            FeishuVerificationToken = ReadString("CLOUD_CHANNEL_FEISHU_VERIFICATION_TOKEN"),
            FeishuEncryptKey = ReadString("CLOUD_CHANNEL_FEISHU_ENCRYPT_KEY"),
            FeishuAudio = ReadBool("CLOUD_CHANNEL_FEISHU_AUDIO", true),
            QqBotAppId = ReadString("CLOUD_CHANNEL_QQBOT_APP_ID"),
            QqBotAppSecret = ReadString("CLOUD_CHANNEL_QQBOT_APP_SECRET"),
            QqBotAllowAnyPrivate = ReadBool("CLOUD_CHANNEL_QQBOT_ALLOW_ANY_PRIVATE", false),
            QqBotAllowedOpenIds = (ReadString("CLOUD_CHANNEL_QQBOT_ALLOWED_OPENIDS") ?? "")
                .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries),
            QqBotStripUrls = ReadBool("CLOUD_CHANNEL_QQBOT_STRIP_URLS", false),
            AsrProvider = ReadString("CLOUD_CHANNEL_ASR_PROVIDER"),
            AsrBaseUrl = ReadString("CLOUD_CHANNEL_ASR_BASE_URL"),
            AsrApiKey = ReadString("CLOUD_CHANNEL_ASR_API_KEY"),
            TtsProvider = ReadString("CLOUD_CHANNEL_TTS_PROVIDER"),
            TtsBaseUrl = ReadString("CLOUD_CHANNEL_TTS_BASE_URL"),
            TtsApiKey = ReadString("CLOUD_CHANNEL_TTS_API_KEY"),
            Vision = ReadString("CLOUD_CHANNEL_VISION"),
            MediaDirMb = ReadInt("CLOUD_CHANNEL_MEDIA_DIR_MB", 256),
        };
    }

    private static string? ReadString(string name)
    {
        var value = Environment.GetEnvironmentVariable(name);
        return string.IsNullOrWhiteSpace(value) ? null : value.Trim();
    }

    private static int ReadInt(string name, int fallback) =>
        int.TryParse(Environment.GetEnvironmentVariable(name), out var value) && value > 0 ? value : fallback;

    private static bool ReadBool(string name, bool fallback)
    {
        var value = Environment.GetEnvironmentVariable(name);
        if (string.IsNullOrWhiteSpace(value)) return fallback;
        return value.Trim() is "1" or "true" or "TRUE" or "True" or "yes" or "on";
    }
}

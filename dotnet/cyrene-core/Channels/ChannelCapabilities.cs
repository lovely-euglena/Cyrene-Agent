namespace CyreneNative.Channels;

/// <summary>
/// 服务端渠道能力冻结表（docs/design/2026-10-05-server-channel.md §2.2）。
/// 与 TS `src/main/channels/normalizers/capability.ts` 逐字一致，fixtures capability 用例双端锁定。
/// 注意与桌面 adapter 声明的刻意差异：服务端按分期冻结（飞书 audio 在 ffmpeg 落地前为 false）。
/// </summary>
public static class ChannelCapabilities
{
    private static readonly ChannelCapability WeChat = new()
    {
        Text = true, Image = true, Audio = false, File = true, Video = true,
        Markdown = false, Card = false, Sticker = true, MaxTextLength = 2048,
    };

    private static readonly ChannelCapability Feishu = new()
    {
        Text = true, Image = true, Audio = false, File = true, Video = true,
        Markdown = true, Card = true, Sticker = true, MaxTextLength = 4000,
    };

    private static readonly ChannelCapability QqBot = new()
    {
        Text = true, Image = false, Audio = false, File = false, Video = false,
        Markdown = false, Card = false, Sticker = false, MaxTextLength = 0,
    };

    public static ChannelCapability For(string channel) => channel switch
    {
        ChannelIds.WeChat => WeChat,
        ChannelIds.Feishu => Feishu,
        ChannelIds.QqBot => QqBot,
        _ => throw new ArgumentException($"未知渠道: {channel}", nameof(channel)),
    };

    public static bool IsKnown(string channel) =>
        channel is ChannelIds.WeChat or ChannelIds.Feishu or ChannelIds.QqBot;
}

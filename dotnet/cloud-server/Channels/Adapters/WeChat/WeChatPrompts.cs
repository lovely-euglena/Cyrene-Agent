namespace CyreneCloud.Channels.Adapters.WeChat;

/// <summary>
/// 微信渠道文案（与桌面 `inbound-media.ts` 同口径）。
/// 服务端无「桌面收件箱」能力，非可分析文件/视频不再承诺「保存到桌面」，改为换格式引导。
/// </summary>
internal static class WeChatPrompts
{
    public const string DefaultUserName = "伙伴";

    public static string AsrMissing(string name) =>
        $"{name}，人家现在还没有配置语音识别，暂时听不懂这条语音。可以发文字给我哦~~";

    public static string UnsupportedFile(string name) =>
        $"{name}，这个文件人家还分析不了呢。可以换成文字，或者把内容转成常见格式（PDF / txt 等）再发给我哦~~";

    public static string Video(string name) =>
        $"{name}，视频人家现在还看不了呢。可以先发文字或者截图给我哦~~";

    public static string DownloadMissing(string name) =>
        $"{name}，这个微信附件缺少下载信息，可以再发一次试试看哦~~";

    public static string DownloadFailed(string name, string reason) =>
        $"{name}，这个微信附件下载失败啦：{reason}。可以再发一次试试看哦~~";

    public static string TooLarge(string name, long maxBytes) =>
        $"{name}，这个微信附件太大啦（超过 {maxBytes / 1024 / 1024}MB），人家暂时收不了呢~~";

    public const string VoiceUnavailable = "语音编码不可用（SILK 分期，阶段 7 落地）";
}

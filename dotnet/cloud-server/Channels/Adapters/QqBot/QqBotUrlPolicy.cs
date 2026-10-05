using System.Text.RegularExpressions;

namespace CyreneCloud.Channels.Adapters.QqBot;

/// <summary>
/// URL 消息策略（§7.2）：QQ 上游对含链接的消息可能发送失败。
/// 默认保持内容诚实（不替换）；<c>CLOUD_CHANNEL_QQBOT_STRIP_URLS=1</c> 时把 URL 替换为占位。
/// </summary>
public static partial class QqBotUrlPolicy
{
    public const string Placeholder = "[链接]";

    [GeneratedRegex(@"https?://[^\s]+", RegexOptions.IgnoreCase)]
    private static partial Regex UrlPattern();

    public static bool ContainsUrl(string? text) => !string.IsNullOrEmpty(text) && UrlPattern().IsMatch(text);

    public static string StripUrls(string text) => UrlPattern().Replace(text, Placeholder);
}

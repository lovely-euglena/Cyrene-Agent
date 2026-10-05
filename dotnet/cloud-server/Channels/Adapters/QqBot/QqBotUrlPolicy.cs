using System.Text.RegularExpressions;

namespace CyreneCloud.Channels.Adapters.QqBot;

/// <summary>
/// URL 消息策略（§7.2）：QQ 上游对含链接的消息可能发送失败。
/// 默认保持内容诚实（不替换）；<c>CLOUD_CHANNEL_QQBOT_STRIP_URLS=1</c> 时把 URL 替换为占位。
/// </summary>
public static partial class QqBotUrlPolicy
{
    public const string Placeholder = "[链接]";

    /// <summary>
    /// P2-3c：匹配到空白或 CJK/全角标点即截断，避免 `[^\s]+` 贪婪吞掉 URL 后的中文
    /// （如「看 https://a.example/x，谢谢」不应把「，谢谢」一并替换）。
    /// 覆盖：CJK 汉字（含扩展 A）、CJK 标点、全角形式、常见中文引号/破折号/省略号。
    /// </summary>
    [GeneratedRegex(
        @"https?://[^\s\u2013\u2014\u2018-\u201F\u2026\u3000-\u303F\u3400-\u4DBF\u4E00-\u9FFF\uFF00-\uFFEF]+",
        RegexOptions.IgnoreCase)]
    private static partial Regex UrlPattern();

    public static bool ContainsUrl(string? text) => !string.IsNullOrEmpty(text) && UrlPattern().IsMatch(text);

    public static string StripUrls(string text) => UrlPattern().Replace(text, Placeholder);
}

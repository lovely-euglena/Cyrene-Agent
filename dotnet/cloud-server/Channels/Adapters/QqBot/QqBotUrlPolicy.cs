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
    /// P2-3c / P2-6.4：匹配到空白或 CJK/全角标点即截断，避免 `[^\s]+` 贪婪吞掉 URL 后的中文
    /// （如「看 https://a.example/x，谢谢」不应把「，谢谢」一并替换）。
    /// 覆盖：CJK 汉字（含扩展 A）、CJK 部首/笔画/兼容区、假名、谚文（含兼容 Jamo）、注音、
    /// 常见全角标点与半角片假名（FF00–FFEF）、竖排/CJK 兼容形式；
    /// 补充平面 CJK 扩展 B–H 无对应可用的 .NET 命名块（\p{Lo} 也不识别代理对），
    /// 用高位代理区段 D840–D888 截断（正则按 UTF-16 码元匹配，遇高位代理即停）。
    /// </summary>
    [GeneratedRegex(
        @"https?://[^\s\u2013\u2014\u2018-\u201F\u2026\u2E80-\u2EFF\u3000-\u303F\u3040-\u30FF\u3100-\u312F\u3130-\u318F\u31A0-\u31BF\u31C0-\u31EF\u31F0-\u31FF\u3200-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7AF\uD840-\uD888\uF900-\uFAFF\uFE10-\uFE1F\uFE30-\uFE6F\uFF00-\uFFEF]+",
        RegexOptions.IgnoreCase)]
    private static partial Regex UrlPattern();

    public static bool ContainsUrl(string? text) => !string.IsNullOrEmpty(text) && UrlPattern().IsMatch(text);

    public static string StripUrls(string text) => UrlPattern().Replace(text, Placeholder);
}

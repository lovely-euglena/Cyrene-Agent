using System.Text;
using System.Text.RegularExpressions;

namespace CyreneNative.Channels;

/// <summary>
/// 渠道文本分片（§2.5：超 maxTextLength 按桌面同口径切分；fixtures text-split 双端锁定）。
///
/// 与 TS 逐字一致：
///   - <see cref="SplitBySentenceBreaks"/> = src/shared/message-segmentation.ts（wechat/feishu）；
///   - <see cref="SplitQqText"/> = src/main/channels/normalizers/qq-text.ts（qqbot/NapCat）。
/// 迭代按 Unicode 码点（JS Array.from / for...of 语义），不按 UTF-16 码元。
/// </summary>
public static class ChannelTextSplitting
{
    public const int MaxMessageSegments = 10;
    public const int QqTextChunkCodepoints = 1500;

    private static readonly Regex SentenceBreak = new("[。！？!?；;]", RegexOptions.Compiled);
    private static readonly Regex LeadingWhitespace = new(@"^\s$", RegexOptions.Compiled);
    private static readonly Regex QqBreak = new("[。！？!?；;…\n]", RegexOptions.Compiled);

    /// <summary>按句末标点切分（最多 maxParts 段；首尾空白 trim；空文本返回空列表）。</summary>
    public static List<string> SplitBySentenceBreaks(string text, int maxParts = MaxMessageSegments)
    {
        var parts = new List<string>();
        var clean = text.Trim();
        if (clean.Length == 0) return parts;
        var safeMaxParts = Math.Max(1, (int)Math.Floor((double)maxParts));
        var buffer = new StringBuilder();
        foreach (var rune in clean.EnumerateRunes())
        {
            var ch = rune.ToString();
            if (buffer.Length == 0 && LeadingWhitespace.IsMatch(ch)) continue;
            buffer.Append(ch);
            if (parts.Count < safeMaxParts - 1 && SentenceBreak.IsMatch(ch))
            {
                parts.Add(buffer.ToString());
                buffer.Clear();
            }
        }
        if (buffer.Length > 0) parts.Add(buffer.ToString());
        return parts;
    }

    /// <summary>QQ 文本分片：按码点上限窗口 + 句末/换行断点回退（与桌面 splitQqText 同口径）。</summary>
    public static List<string> SplitQqText(string text, int maxCodepoints = QqTextChunkCodepoints)
    {
        var result = new List<string>();
        var source = text.Trim();
        if (source.Length == 0) return result;
        var rest = source.EnumerateRunes().ToList();
        while (rest.Count > maxCodepoints)
        {
            var window = rest.Take(maxCodepoints).ToList();
            var splitAt = -1;
            for (var i = window.Count - 1; i >= (int)Math.Floor(maxCodepoints * 0.55); i--)
            {
                if (QqBreak.IsMatch(window[i].ToString()))
                {
                    splitAt = i + 1;
                    break;
                }
            }
            if (splitAt < 0) splitAt = maxCodepoints;
            result.Add(RunesToString(window.Take(splitAt)).Trim());
            rest = rest.Skip(splitAt).ToList();
        }
        var tail = RunesToString(rest).Trim();
        if (tail.Length > 0) result.Add(tail);
        return result.Where(part => part.Length > 0).ToList();
    }

    private static string RunesToString(IEnumerable<Rune> runes)
    {
        var builder = new StringBuilder();
        foreach (var rune in runes) builder.Append(rune.ToString());
        return builder.ToString();
    }
}

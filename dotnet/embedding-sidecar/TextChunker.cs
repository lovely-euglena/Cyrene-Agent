using System.Text.RegularExpressions;

namespace CyreneEmbedSidecar;

/// <summary>
/// 滑动窗口 Chunk 切分（src/main/rag/chunk.ts 同构；verify-chunks 逐块对账）。
/// 不做段落/句子逻辑判断，按 token 估算滑动；overlap 保证断点双覆盖；
/// Markdown 标题给 chunk 加【标题链】前缀。
/// </summary>
public static class TextChunker
{
    public const int DocumentChunkSize = 512;
    public const int DocumentChunkOverlap = 128;

    public sealed record Chunk(string Id, string Text, string Source, int Index);

    private static readonly Regex ChineseChars = new("[\u4e00-\u9fff]", RegexOptions.Compiled);
    private static readonly Regex Whitespace = new("\\s+", RegexOptions.Compiled);
    private static readonly Regex Heading = new("^(#{1,6})\\s+(.+)$", RegexOptions.Compiled);

    /// <summary>Token 估算：汉字逐字 + 其余按空白切分（与 TS estimateTokens 同构）。</summary>
    public static int EstimateTokens(string text)
    {
        var chinese = ChineseChars.Matches(text).Count;
        var rest = ChineseChars.Replace(text, " ");
        var others = Whitespace.Split(rest).Count((s) => s.Length > 0);
        return chinese + others;
    }

    private static bool IsSentencePunct(char c) => c is '。' or '！' or '？' or '\n' or '.' or '!' or '?';

    /// <summary>从 pos 起找下一个句子边界（含连续标点），找不到返回 -1。</summary>
    private static int FindNextSentenceBoundary(string text, int pos)
    {
        for (var i = pos; i < text.Length; i++)
        {
            if (!IsSentencePunct(text[i])) continue;
            var j = i + 1;
            while (j < text.Length && IsSentencePunct(text[j])) j++;
            return j;
        }
        return -1;
    }

    /// <summary>按字符位置滑窗（token 与字符按比例换算；与 TS iterateSlidingWindowChars 同构）。</summary>
    private static List<(int Start, int End, string Text)> IterateSlidingWindowChars(
        string text,
        int chunkSize,
        int overlap)
    {
        var spans = new List<(int, int, string)>();
        if (string.IsNullOrEmpty(text) || string.IsNullOrWhiteSpace(text)) return spans;

        var totalChars = text.Length;
        if (EstimateTokens(text) <= chunkSize)
        {
            spans.Add((0, totalChars, text));
            return spans;
        }

        int? prevStart = null, prevEnd = null;
        string? prevText = null;
        var step = chunkSize - overlap;
        var totalTokens = EstimateTokens(text);
        var tokensPerChar = (double)totalTokens / totalChars;

        double posStart = 0;
        var chunkIndex = 0;
        while (posStart < totalChars)
        {
            var startToken = (int)Math.Round(posStart * tokensPerChar, MidpointRounding.AwayFromZero);
            var endToken = startToken + chunkSize;
            var posEndChar = Math.Min(
                totalChars,
                (int)Math.Round((double)endToken / tokensPerChar, MidpointRounding.AwayFromZero));

            // 剩余内容不足 chunkSize 的 1/3：合并进上一个 chunk
            if (chunkIndex > 0 && (totalChars - posStart) < chunkSize * tokensPerChar * 0.33)
            {
                if (prevStart.HasValue)
                {
                    prevText = text[prevStart.Value..];
                    prevEnd = totalChars;
                }
                break;
            }

            // 句子边界保护（最多再延伸 chunkSize 的 20%）
            var maxExtend = posEndChar + (int)Math.Round(chunkSize * 0.2 * tokensPerChar, MidpointRounding.AwayFromZero);
            var boundary = FindNextSentenceBoundary(text, posEndChar);
            if (boundary != -1 && boundary <= Math.Min(maxExtend, totalChars)) posEndChar = boundary;

            if (prevStart.HasValue) spans.Add((prevStart.Value, prevEnd!.Value, prevText!));
            var start = (int)Math.Round(posStart, MidpointRounding.AwayFromZero);
            prevStart = start;
            prevEnd = posEndChar;
            prevText = text[start..posEndChar];

            chunkIndex++;
            posStart += step / tokensPerChar;
        }
        if (prevStart.HasValue) spans.Add((prevStart.Value, prevEnd!.Value, prevText!));
        return spans;
    }

    private sealed record TitleRecord(int Level, string Title, int TokenPos);

    private static List<TitleRecord> ExtractTitles(string text)
    {
        var titles = new List<TitleRecord>();
        var tokenPos = 0;
        foreach (var line in text.Split('\n'))
        {
            var match = Heading.Match(line);
            if (match.Success)
            {
                titles.Add(new TitleRecord(match.Groups[1].Value.Length, match.Groups[2].Value.Trim(), tokenPos));
            }
            tokenPos += EstimateTokens(line + "\n");
        }
        return titles;
    }

    private static string GetTitlePrefix(int tokenPos, List<TitleRecord> titles)
    {
        var active = new List<TitleRecord>();
        foreach (var t in titles)
        {
            if (t.TokenPos > tokenPos) break;
            while (active.Count > 0 && active[^1].Level >= t.Level) active.RemoveAt(active.Count - 1);
            active.Add(t);
        }
        return active.Count == 0 ? "" : string.Join(" > ", active.Select((t) => t.Title));
    }

    /// <summary>主入口：切分文本为 chunk 列表（与 TS chunkText 同构）。</summary>
    public static List<Chunk> ChunkText(
        string text,
        string source,
        int chunkSize = DocumentChunkSize,
        int overlap = DocumentChunkOverlap)
    {
        var titles = ExtractTitles(text);
        var hasTitles = titles.Count > 0;

        var chunks = new List<Chunk>();
        var i = 0;
        foreach (var span in IterateSlidingWindowChars(text, chunkSize, overlap))
        {
            var content = span.Text.Trim();
            if (content.Length == 0) continue;

            if (hasTitles)
            {
                var startTokenPos = (int)Math.Round(
                    (double)EstimateTokens(text[..span.Start]),
                    MidpointRounding.AwayFromZero);
                var prefix = GetTitlePrefix(startTokenPos, titles);
                if (prefix.Length > 0) content = $"【{prefix}】{content}";
            }

            chunks.Add(new Chunk($"{source}_{i}", content, source, i));
            i++;
        }
        return chunks;
    }
}

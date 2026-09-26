namespace CyreneEmbedSidecar;

/// <summary>
/// BM25 检索（TS retriever.ts bm25Search / bm25Score 同构）：
/// - 分词 = JiebaTokenizer（.NET 自闭环；方案 B 接受与 jieba-rs 的切分差异）
/// - k1=1.2 / b=0.75；名词加权 1.3、停用词降权 0.3（JiebaNet 真实词性）
/// - 返回全部候选（含 0 分）排序后取 topK —— 与 TS 行为一致
/// </summary>
public static class Bm25Scorer
{
    private const double K1 = 1.2;
    private const double B = 0.75;
    private const double StopWeight = 0.3;
    private const double NounWeight = 1.3;

    public sealed record Scored(MemoryEntry Entry, double Score);

    public static List<Scored> Search(
        IReadOnlyList<MemoryEntry> entries,
        string query,
        string? source,
        int topK,
        IReadOnlyCollection<string>? importIds,
        IReadOnlyCollection<string>? allowedEntryIds,
        IReadOnlyCollection<string> customWords)
    {
        var allowedImports = importIds is { Count: > 0 } ? new HashSet<string>(importIds) : null;
        // 与 RagStore 同口径：allowedEntryIds=[] 参与过滤（全排除）；null 才不过滤
        var allowedEntries = allowedEntryIds is null ? null : new HashSet<string>(allowedEntryIds);

        var docs = new List<MemoryEntry>();
        foreach (var entry in entries)
        {
            if (!string.IsNullOrEmpty(source) && entry.Source != source) continue;
            if (allowedImports != null)
            {
                var importId = "";
                if (entry.Metadata != null
                    && entry.Metadata.TryGetValue("importId", out var v)
                    && v.ValueKind == System.Text.Json.JsonValueKind.String)
                {
                    importId = v.GetString() ?? "";
                }
                if (!allowedImports.Contains(importId)) continue;
            }
            if (allowedEntries != null && !allowedEntries.Contains(entry.Id)) continue;
            docs.Add(entry);
        }
        if (docs.Count == 0) return new List<Scored>();

        var queryTokens = JiebaTokenizer.Tokenize(query, customWords);
        var docTokensList = docs.Select((d) => JiebaTokenizer.Tokenize(d.Text, customWords)).ToList();
        var totalDocs = docs.Count;
        var avgDocLen = docTokensList.Sum((t) => (double)t.Count) / totalDocs;

        // 文档频率（每文档内按词去重）
        var docFreq = new Dictionary<string, int>();
        foreach (var tokens in docTokensList)
        {
            var seen = new HashSet<string>();
            foreach (var t in tokens)
            {
                if (seen.Add(t.Word))
                {
                    docFreq[t.Word] = docFreq.GetValueOrDefault(t.Word) + 1;
                }
            }
        }

        var scored = new List<Scored>(docs.Count);
        for (var i = 0; i < docs.Count; i++)
        {
            scored.Add(new Scored(docs[i], Score(queryTokens, docTokensList[i], docFreq, totalDocs, avgDocLen)));
        }
        scored.Sort((a, b) => b.Score.CompareTo(a.Score));
        return scored.Take(topK).ToList();
    }

    private static double Score(
        List<JiebaTokenizer.Token> queryTokens,
        List<JiebaTokenizer.Token> docTokens,
        Dictionary<string, int> docFreq,
        int totalDocs,
        double avgDocLen)
    {
        double score = 0;
        var tf = new Dictionary<string, int>();
        foreach (var t in docTokens) tf[t.Word] = tf.GetValueOrDefault(t.Word) + 1;

        // 与 TS 一致：query 中重复词重复计分
        foreach (var qt in queryTokens)
        {
            var df = docFreq.GetValueOrDefault(qt.Word);
            if (df == 0) continue;

            var idf = Math.Log((totalDocs - df + 0.5) / (df + 0.5) + 1);
            var termFreq = tf.GetValueOrDefault(qt.Word);
            var numerator = termFreq * (K1 + 1);
            var denominator = termFreq + K1 * (1 - B + B * (avgDocLen != 0 ? docTokens.Count / avgDocLen : 1));
            var termScore = idf * (numerator / denominator);

            if (qt.IsNoun) termScore *= NounWeight;
            if (qt.IsStop) termScore *= StopWeight;

            score += termScore;
        }
        return score;
    }
}

namespace CyreneEmbedSidecar;

/// <summary>
/// 混合检索（TS HybridRetriever.retrieve 同构；reranker 精排仍由 TS 侧编排）：
/// 向量 topK×3 + BM25 topK×3 → max 归一化加权（默认 0.7/0.3）→ 排序取 topK。
/// </summary>
public static class HybridSearch
{
    public static List<Bm25Scorer.Scored> Retrieve(
        RagStore store,
        EmbeddingEngine embedder,
        string query,
        string? source,
        int topK,
        IReadOnlyCollection<string>? importIds,
        IReadOnlyCollection<string>? allowedEntryIds,
        IReadOnlyCollection<string> customWords,
        double vectorWeight = 0.7,
        double bm25Weight = 0.3,
        bool updateRecall = true,
        long? nowOverride = null)
    {
        if (store.Entries.Count == 0) return new List<Bm25Scorer.Scored>();

        var now = nowOverride ?? DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var queryVector = embedder.Embed(new[] { query })[0].Select((f) => (double)f).ToArray();

        var vectorResults = store.Search(queryVector, source, topK * 3, 0.3, importIds, allowedEntryIds, now, updateRecall);
        var bm25Results = Bm25Scorer.Search(store.Snapshot(), query, source, topK * 3, importIds, allowedEntryIds, customWords);

        var merged = new Dictionary<string, (MemoryEntry Entry, double VectorScore, double Bm25Score)>();
        foreach (var (entry, score) in vectorResults)
        {
            merged[entry.Id] = (entry, score, 0);
        }
        foreach (var r in bm25Results)
        {
            if (merged.TryGetValue(r.Entry.Id, out var existing))
            {
                merged[r.Entry.Id] = (existing.Entry, existing.VectorScore, r.Score);
            }
            else
            {
                merged[r.Entry.Id] = (r.Entry, 0, r.Score);
            }
        }

        var all = merged.Values.ToList();
        var maxV = Math.Max(all.Count > 0 ? all.Max((m) => m.VectorScore) : 0, 1);
        var maxB = Math.Max(all.Count > 0 ? all.Max((m) => m.Bm25Score) : 0, 1);

        var scored = all
            .Select((m) => new Bm25Scorer.Scored(
                m.Entry,
                m.VectorScore / maxV * vectorWeight + m.Bm25Score / maxB * bm25Weight))
            .ToList();
        scored.Sort((a, b) => b.Score.CompareTo(a.Score));
        return scored.Take(topK).ToList();
    }
}

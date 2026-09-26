using System.Text.Json;

namespace CyreneEmbedSidecar;

/// <summary>
/// 批量写入条目（与 TS addPreparedBatch 同构：id = source_now_i_rand4）。
/// </summary>
public sealed record PreparedItem(
    string Text,
    string Source,
    double[] Embedding,
    Dictionary<string, JsonElement>? Metadata);

/// <summary>
/// 向量库抽象：JSON（RagStore，回退）与 SQLite（SqliteRagStore，默认）两种实现。
/// 检索/召回/统计语义完全一致；差异仅在持久化与新鲜度机制。
/// </summary>
public interface IRagStore
{
    IReadOnlyList<MemoryEntry> Entries { get; }

    /// <summary>外部（TS 进程）写入后同步内存副本；无变化时仅一次廉价检查。</summary>
    void RefreshIfChanged();

    /// <summary>条目浅拷贝快照（供 BM25 等读路径使用）。</summary>
    List<MemoryEntry> Snapshot();

    bool HasImportedDocumentChunks(string importId);

    (int Total, Dictionary<string, int> Sources) Stats();

    /// <summary>批量追加并持久化（事务）。</summary>
    List<MemoryEntry> AddPreparedBatch(IReadOnlyList<PreparedItem> items);

    /// <summary>向量检索 +（可选）召回回写，语义与 TS JsonVectorStore.search 一致。</summary>
    List<(MemoryEntry Entry, double Score)> Search(
        IReadOnlyList<double> queryEmbedding,
        string? source,
        int topK,
        double minScore,
        IReadOnlyCollection<string>? importIds,
        IReadOnlyCollection<string>? allowedEntryIds,
        long now,
        bool updateRecall = true);
}

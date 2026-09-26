using System.Text.Json;
using System.Text.Json.Serialization;

namespace CyreneEmbedSidecar;

/// <summary>
/// 记忆条目（与 TS vectorstore.ts MemoryEntry 同 schema，JSON 直接互读互写）。
/// embedding 用 double[]：TS 侧 numbers 即 double；float32 值可精确表示为 double，
/// double 序列化文本与 JS Number 的 shortest-round-trip 一致，回写不改变数值语义。
/// </summary>
public sealed class MemoryEntry
{
    public string Id { get; set; } = "";
    public string Text { get; set; } = "";
    public double[] Embedding { get; set; } = Array.Empty<double>();
    public string Source { get; set; } = "";
    public double Weight { get; set; } = 1.0;
    public long CreatedAt { get; set; }
    public long LastRecalledAt { get; set; }
    public Dictionary<string, JsonElement>? Metadata { get; set; }
}

/// <summary>
/// JSON 向量库（memory-store.json）：加载/保存 + 向量检索 + IVF + 召回回写。
/// 语义与 TS JsonVectorStore 对齐；SQLite 化后作为回退实现（CYRENE_RAG_STORE=json），
/// 默认走 <see cref="SqliteRagStore"/>。两者共用 Ivf 与评分公式。
/// </summary>
public sealed class RagStore : IRagStore, IDisposable
{
    private static readonly JsonSerializerOptions StoreJson = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private readonly string _dir;
    private readonly string _filePath;
    private readonly object _sync = new();
    private List<MemoryEntry> _entries = new();
    private Ivf.Index? _ivf;

    private long _fileWriteTicks;
    private long _fileLength = -1;

    public IReadOnlyList<MemoryEntry> Entries => _entries;

    public RagStore(string dir)
    {
        _dir = dir;
        _filePath = Path.Combine(dir, "memory-store.json");
        Reload();
    }

    private void Reload()
    {
        try
        {
            if (File.Exists(_filePath))
            {
                var info = new FileInfo(_filePath);
                _fileWriteTicks = info.LastWriteTimeUtc.Ticks;
                _fileLength = info.Length;
                _entries = JsonSerializer.Deserialize<List<MemoryEntry>>(File.ReadAllText(_filePath), StoreJson)
                           ?? new List<MemoryEntry>();
            }
            else
            {
                _entries = new List<MemoryEntry>();
                _fileWriteTicks = 0;
                _fileLength = -1;
            }
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[rag] failed to load vector store: {ex.Message}");
            // 重置磁盘快照：解析失败（如 TS 写入未完成）时强制下次 RefreshIfChanged 重试，
            // 避免"陈旧空副本记录为最新"后反向覆盖磁盘
            _entries = new List<MemoryEntry>();
            _fileWriteTicks = 0;
            _fileLength = -1;
        }
        _ivf = null;
    }

    public void Save()
    {
        try
        {
            lock (_sync)
            {
                Directory.CreateDirectory(_dir);
                // 原子写：先写 tmp 再 move（TS 侧并发读时不会读到半截 JSON）。
                // 快照取 tmp（move 保留 mtime）：若外部写入发生在我们 move 之后，
                // mtime 会变化 → RefreshIfChanged 正确重载。
                var tmp = _filePath + ".tmp";
                File.WriteAllText(tmp, JsonSerializer.Serialize(_entries, StoreJson));
                var info = new FileInfo(tmp);
                _fileWriteTicks = info.LastWriteTimeUtc.Ticks;
                _fileLength = info.Length;
                File.Move(tmp, _filePath, overwrite: true);
            }
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[rag] failed to save vector store: {ex.Message}");
        }
    }

    /// <summary>文件被外部（TS 进程）改写或删除时重载；否则用内存副本。</summary>
    public void RefreshIfChanged()
    {
        lock (_sync)
        {
            if (!File.Exists(_filePath))
            {
                // 外部删库：同步清空（否则下次保存会把陈旧条目写回去）
                if (_fileLength != -1)
                {
                    _entries = new List<MemoryEntry>();
                    _ivf = null;
                    _fileWriteTicks = 0;
                    _fileLength = -1;
                }
                return;
            }
            var info = new FileInfo(_filePath);
            if (info.LastWriteTimeUtc.Ticks != _fileWriteTicks || info.Length != _fileLength)
            {
                Reload();
            }
        }
    }

    /// <summary>条目快照（浅拷贝列表；供 BM25 等并发读路径使用）。</summary>
    public List<MemoryEntry> Snapshot()
    {
        lock (_sync)
        {
            return new List<MemoryEntry>(_entries);
        }
    }

    /// <summary>批量追加（与 TS addPreparedBatch 同构：id = source_now_i_rand4）。</summary>
    public List<MemoryEntry> AddPreparedBatch(IReadOnlyList<PreparedItem> items)
    {
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var results = new List<MemoryEntry>(items.Count);
        lock (_sync)
        {
            // 跨进程安全：导入可能持续数分钟，期间 TS 侧可能已写入（记忆/召回），
            // 先同步盘面再追加，避免整库保存覆盖外部写入
            RefreshIfChanged();
            for (var i = 0; i < items.Count; i++)
            {
                var entry = new MemoryEntry
                {
                    Id = $"{items[i].Source}_{now}_{i}_{RandomString(4)}",
                    Text = items[i].Text,
                    Embedding = items[i].Embedding,
                    Source = items[i].Source,
                    Weight = 1.0,
                    CreatedAt = now,
                    LastRecalledAt = now,
                    Metadata = items[i].Metadata,
                };
                _entries.Add(entry);
                results.Add(entry);
            }
            _ivf = null;
            Save();
        }
        return results;
    }

    public bool HasImportedDocumentChunks(string importId)
    {
        lock (_sync)
        {
            // 缓存判定需基于最新盘面（导入可能由另一进程/另一请求完成）
            RefreshIfChanged();
            return _entries.Any((entry) =>
                entry.Source == "imported_doc"
                && entry.Metadata != null
                && entry.Metadata.TryGetValue("importId", out var v)
                && v.ValueKind == JsonValueKind.String
                && v.GetString() == importId);
        }
    }

    private static readonly char[] Base36 = "0123456789abcdefghijklmnopqrstuvwxyz".ToCharArray();

    private static string RandomString(int length)
    {
        var chars = new char[length];
        for (var i = 0; i < length; i++) chars[i] = Base36[Random.Shared.Next(Base36.Length)];
        return new string(chars);
    }

    /// <summary>统计（含跨进程写入后的新鲜数据）。</summary>
    public (int Total, Dictionary<string, int> Sources) Stats()
    {
        lock (_sync)
        {
            var sources = new Dictionary<string, int>();
            foreach (var e in _entries)
            {
                sources[e.Source] = sources.GetValueOrDefault(e.Source) + 1;
            }
            return (_entries.Count, sources);
        }
    }

    // ── IVF 倒排索引（共用 Ivf 实现，见 Ivf.cs） ──

    private void EnsureIndex()
    {
        if (_ivf != null) return;
        var n = _entries.Count;
        if (n < 2) return;
        var k = Math.Max(2, Math.Min(512, (int)Math.Round(Math.Sqrt(n) / 2, MidpointRounding.AwayFromZero)));
        var t0 = Environment.TickCount64;
        _ivf = Ivf.Build(_entries, k);
        Console.Error.WriteLine($"[rag] IVF index rebuilt: K={k}, entries={n}, took {Environment.TickCount64 - t0}ms");
    }

    public List<(MemoryEntry Entry, double Score)> Search(
        IReadOnlyList<double> queryEmbedding,
        string? source,
        int topK,
        double minScore,
        IReadOnlyCollection<string>? importIds,
        IReadOnlyCollection<string>? allowedEntryIds,
        long now,
        bool updateRecall = true)
    {
        lock (_sync)
        {
            // 搜索前同步盘面（TS 侧写入可能已落盘）
            RefreshIfChanged();
            return SearchCore(queryEmbedding, source, topK, minScore, importIds, allowedEntryIds, now, updateRecall);
        }
    }

    private List<(MemoryEntry Entry, double Score)> SearchCore(
        IReadOnlyList<double> queryEmbedding,
        string? source,
        int topK,
        double minScore,
        IReadOnlyCollection<string>? importIds,
        IReadOnlyCollection<string>? allowedEntryIds,
        long now,
        bool updateRecall)
    {
        var results = new List<(MemoryEntry, double)>();
        if (_entries.Count == 0) return results;

        EnsureIndex();

        var allowedImports = importIds is { Count: > 0 } ? new HashSet<string>(importIds) : null;
        // ⚠️ 语义对齐 TS：allowedEntryIds=[] 表示"全部排除"（空集合仍参与过滤），
        // 而 importIds=[] 表示"不过滤"（TS 用 !size 判断）。null 才是"不过滤"。
        var allowedEntries = allowedEntryIds is null ? null : new HashSet<string>(allowedEntryIds);
        bool ShouldKeep(MemoryEntry entry)
        {
            if (allowedImports != null)
            {
                var importId = "";
                if (entry.Metadata != null && entry.Metadata.TryGetValue("importId", out var v) && v.ValueKind == JsonValueKind.String)
                {
                    importId = v.GetString() ?? "";
                }
                if (!allowedImports.Contains(importId)) return false;
            }
            if (allowedEntries != null && !allowedEntries.Contains(entry.Id)) return false;
            return true;
        }

        void Consider(MemoryEntry entry)
        {
            var sim = Ivf.Dot(queryEmbedding, entry.Embedding);
            var hoursSinceRecall = (now - entry.LastRecalledAt) / (1000.0 * 60 * 60);
            var decay = Math.Pow(0.95, hoursSinceRecall / 24);
            var weighted = sim * entry.Weight * decay;
            if (weighted >= minScore) results.Add((entry, weighted));
        }

        if (_ivf != null && string.IsNullOrEmpty(source))
        {
            var k = _ivf.Centroids.Length;
            var nprobe = Math.Max(2, (int)Math.Round(k / 8.0, MidpointRounding.AwayFromZero));
            var clusterDists = new (int Idx, double Dist)[k];
            for (var c = 0; c < k; c++)
            {
                clusterDists[c] = (c, 1 - Ivf.Dot(queryEmbedding, _ivf.Centroids[c]));
            }
            Array.Sort(clusterDists, (a, b) => a.Dist.CompareTo(b.Dist));
            var probe = new HashSet<int>(clusterDists.Take(nprobe).Select((c) => c.Idx));
            foreach (var clusterIdx in probe)
            {
                foreach (var entryIdx in _ivf.Clusters[clusterIdx])
                {
                    var entry = _entries[entryIdx];
                    if (!ShouldKeep(entry)) continue;
                    Consider(entry);
                }
            }
        }
        else
        {
            foreach (var entry in _entries)
            {
                if (!string.IsNullOrEmpty(source) && entry.Source != source) continue;
                if (!ShouldKeep(entry)) continue;
                Consider(entry);
            }
        }

        results.Sort((a, b) => b.Item2.CompareTo(a.Item2));
        var top = results.Take(topK).ToList();

        if (updateRecall && top.Count > 0)
        {
            // 跨进程安全：计算期间 TS 可能已写入，先同步盘面再按 id 重新定位回写
            RefreshIfChanged();
            var mutated = false;
            foreach (var (entry, _) in top)
            {
                var fresh = _entries.FirstOrDefault((e) => e.Id == entry.Id);
                if (fresh is null) continue;
                fresh.LastRecalledAt = now;
                fresh.Weight = Math.Min(fresh.Weight + 0.05, 5.0);
                mutated = true;
            }
            if (mutated) Save();
        }

        return top;
    }

    /// <summary>JSON 实现无外部资源；提供 Dispose 以与 SqliteRagStore 的 using 语义一致。</summary>
    public void Dispose()
    {
    }
}

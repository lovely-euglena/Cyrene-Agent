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
/// 语义与 TS JsonVectorStore 对齐（Phase B 对账基准见 scripts/diagnostics/rag-search-*）。
/// </summary>
public sealed class RagStore
{
    private static readonly JsonSerializerOptions StoreJson = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private readonly string _dir;
    private readonly string _filePath;
    private List<MemoryEntry> _entries = new();
    private IvfIndex? _ivf;

    private long _fileWriteTicks;
    private long _fileLength;

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
            }
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[rag] failed to load vector store: {ex.Message}");
            _entries = new List<MemoryEntry>();
        }
        _ivf = null;
    }

    public void Save()
    {
        try
        {
            Directory.CreateDirectory(_dir);
            File.WriteAllText(_filePath, JsonSerializer.Serialize(_entries, StoreJson));
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[rag] failed to save vector store: {ex.Message}");
        }
    }

    /// <summary>文件被外部（TS 进程）改写时重载；否则用内存副本。</summary>
    public void RefreshIfChanged()
    {
        if (!File.Exists(_filePath)) return;
        var info = new FileInfo(_filePath);
        if (info.LastWriteTimeUtc.Ticks != _fileWriteTicks || info.Length != _fileLength)
        {
            Reload();
        }
    }

    // ── IVF 倒排索引（k-means++ / nprobe 探测；与 TS buildIvfIndex 同构） ──

    private sealed class IvfIndex
    {
        public double[][] Centroids = Array.Empty<double[]>();
        public List<int>[] Clusters = Array.Empty<List<int>>();
    }

    private void EnsureIndex()
    {
        if (_ivf != null) return;
        var n = _entries.Count;
        if (n < 2) return;
        var k = Math.Max(2, Math.Min(512, (int)Math.Round(Math.Sqrt(n) / 2, MidpointRounding.AwayFromZero)));
        var t0 = Environment.TickCount64;
        _ivf = BuildIvfIndex(_entries, k);
        Console.Error.WriteLine($"[rag] IVF index rebuilt: K={k}, entries={n}, took {Environment.TickCount64 - t0}ms");
    }

    private static IvfIndex BuildIvfIndex(List<MemoryEntry> entries, int k, int maxIter = 20)
    {
        var vectors = entries.Select((e) => e.Embedding).ToArray();
        var dim = vectors.Length > 0 ? vectors[0].Length : 0;
        if (dim == 0 || vectors.Length == 0)
        {
            return new IvfIndex { Centroids = Array.Empty<double[]>(), Clusters = Array.Empty<List<int>>() };
        }

        var effectiveK = Math.Min(k, vectors.Length);
        var clusters = new List<int>[effectiveK];
        for (var i = 0; i < effectiveK; i++) clusters[i] = new List<int>();

        var rng = new Random();
        var centroids = KmeansPlusPlusInit(vectors, effectiveK, rng);

        for (var iter = 0; iter < maxIter; iter++)
        {
            for (var i = 0; i < effectiveK; i++) clusters[i].Clear();

            for (var i = 0; i < vectors.Length; i++)
            {
                var bestIdx = 0;
                var bestSim = double.NegativeInfinity;
                for (var c = 0; c < effectiveK; c++)
                {
                    var sim = Dot(vectors[i], centroids[c]);
                    if (sim > bestSim)
                    {
                        bestSim = sim;
                        bestIdx = c;
                    }
                }
                clusters[bestIdx].Add(i);
            }

            var newCentroids = new double[effectiveK][];
            for (var c = 0; c < effectiveK; c++)
            {
                var members = clusters[c];
                if (members.Count == 0)
                {
                    newCentroids[c] = (double[])centroids[c].Clone();
                    continue;
                }
                var sum = new double[dim];
                foreach (var idx in members)
                {
                    var v = vectors[idx];
                    for (var d = 0; d < dim; d++) sum[d] += v[d];
                }
                var norm = 0.0;
                for (var d = 0; d < dim; d++) norm += sum[d] * sum[d];
                norm = Math.Sqrt(norm);
                if (norm > 0)
                {
                    for (var d = 0; d < dim; d++) sum[d] /= norm;
                }
                newCentroids[c] = sum;
            }

            var changed = false;
            for (var c = 0; c < effectiveK; c++)
            {
                if (Dot(newCentroids[c], centroids[c]) < 0.999)
                {
                    changed = true;
                    break;
                }
            }
            centroids = newCentroids;
            if (!changed) break;
        }

        return new IvfIndex { Centroids = centroids, Clusters = clusters };
    }

    private static double[][] KmeansPlusPlusInit(double[][] vectors, int k, Random rng)
    {
        var centroids = new List<double[]>(k);
        var firstIdx = rng.Next(vectors.Length);
        centroids.Add((double[])vectors[firstIdx].Clone());

        for (var c = 1; c < k; c++)
        {
            var dists = new double[vectors.Length];
            for (var i = 0; i < vectors.Length; i++)
            {
                var minDist = double.PositiveInfinity;
                foreach (var cent in centroids)
                {
                    var d = 1 - Dot(vectors[i], cent);
                    if (d < minDist) minDist = d;
                }
                dists[i] = minDist * minDist;
            }
            var total = dists.Sum();
            if (total <= 0)
            {
                while (centroids.Count < k)
                {
                    centroids.Add((double[])vectors[centroids.Count % vectors.Length].Clone());
                }
                break;
            }
            var r = rng.NextDouble() * total;
            for (var i = 0; i < dists.Length; i++)
            {
                r -= dists[i];
                if (r <= 0)
                {
                    centroids.Add((double[])vectors[i].Clone());
                    break;
                }
            }
        }
        return centroids.ToArray();
    }

    /// <summary>余弦相似度（向量已归一化，等价于点积；double 精度与 JS 一致）。</summary>
    private static double Dot(IReadOnlyList<double> a, IReadOnlyList<double> b)
    {
        var dot = 0.0;
        for (var i = 0; i < a.Count; i++) dot += a[i] * b[i];
        return dot;
    }

    // ── 向量检索（TS JsonVectorStore.search 同构：IVF 加速度路径 + 全量路径） ──

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
        var results = new List<(MemoryEntry, double)>();
        if (_entries.Count == 0) return results;

        EnsureIndex();

        var allowedImports = importIds is { Count: > 0 } ? new HashSet<string>(importIds) : null;
        var allowedEntries = allowedEntryIds is { Count: > 0 } ? new HashSet<string>(allowedEntryIds) : null;
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
            var sim = Dot(queryEmbedding, entry.Embedding);
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
                clusterDists[c] = (c, 1 - Dot(queryEmbedding, _ivf.Centroids[c]));
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

        if (updateRecall)
        {
            foreach (var (entry, _) in top)
            {
                entry.LastRecalledAt = now;
                entry.Weight = Math.Min(entry.Weight + 0.05, 5.0);
            }
            if (top.Count > 0) Save();
        }

        return top;
    }
}

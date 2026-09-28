using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Data.Sqlite;

namespace CyreneEmbedSidecar;

/// <summary>
/// SQLite 向量库（memory.db，WAL）：条目/向量/元数据落库 + 内存副本 + rev 跨进程新鲜度。
///
/// 设计（与 TS SqliteVectorStore 对齐）：
/// - 双进程（Electron TS 与 sidecar）直连同一 WAL 库；busy_timeout 处理写冲突，
///   行级写替代整文件重写（导入批次/召回回写不再 O(n) 刷盘）
/// - rev：rag_meta 版本号，任何行写入 +1；读侧对比 rev 决定是否重载内存副本
/// - 本地写后对比 pre/post rev：若期间有外部提交则整体重载，避免缓存缺失外部条目
/// - 首次打开自动从 memory-store.json 迁移（幂等，保留 JSON 原文件作为回滚快照）；
///   JSON 比记录时间更新时软合并（INSERT OR IGNORE 缺失 id，不回灌覆盖库内数据）
/// - 检索/召回/统计语义与 RagStore（JSON）完全一致（共用 Ivf 与评分公式）
/// </summary>
public sealed class SqliteRagStore : IRagStore, IDisposable
{
    private const string SchemaVersion = "1";

    private static readonly JsonSerializerOptions EntryJson = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private readonly string _dir;
    private readonly string _dbPath;
    private readonly string _legacyJsonPath;
    private readonly object _sync = new();
    private readonly SqliteConnection _db;
    private List<MemoryEntry> _entries = new();
    private Ivf.Index? _ivf;
    private string? _rev;

    public SqliteRagStore(string dir)
    {
        _dir = dir;
        _dbPath = Path.Combine(dir, "memory.db");
        _legacyJsonPath = Path.Combine(dir, "memory-store.json");
        Directory.CreateDirectory(dir);
        _db = OpenConnection(_dbPath);
        EnsureSchema();
        MigrateLegacyJsonIfNeeded();
        SoftMergeLegacyJsonIfNewer();
        ReloadLocked();
    }

    public IReadOnlyList<MemoryEntry> Entries => _entries;

    // ── 连接 / schema / 元数据 ──

    private static SqliteConnection OpenConnection(string dbPath)
    {
        var builder = new SqliteConnectionStringBuilder
        {
            DataSource = dbPath,
            Mode = SqliteOpenMode.ReadWriteCreate,
            Pooling = false,
        };
        var conn = new SqliteConnection(builder.ToString());
        conn.Open();
        Exec(conn, "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;");
        return conn;
    }

    private static void Exec(SqliteConnection conn, string sql)
    {
        using var cmd = conn.CreateCommand();
        cmd.CommandText = sql;
        cmd.ExecuteNonQuery();
    }

    private void EnsureSchema()
    {
        Exec(_db, $"""
            CREATE TABLE IF NOT EXISTS rag_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS entries (
              id TEXT PRIMARY KEY,
              text TEXT NOT NULL,
              source TEXT NOT NULL,
              embedding BLOB NOT NULL,
              dim INTEGER NOT NULL,
              weight REAL NOT NULL DEFAULT 1.0,
              created_at INTEGER NOT NULL,
              last_recalled_at INTEGER NOT NULL,
              metadata TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_entries_source ON entries(source);
            INSERT OR IGNORE INTO rag_meta(key, value) VALUES ('rev', '0');
            INSERT OR IGNORE INTO rag_meta(key, value) VALUES ('schema_version', '{SchemaVersion}');
            """);
    }

    private string? GetMeta(string key)
    {
        using var cmd = _db.CreateCommand();
        cmd.CommandText = "SELECT value FROM rag_meta WHERE key = $k";
        cmd.Parameters.AddWithValue("$k", key);
        return cmd.ExecuteScalar() as string;
    }

    private void SetMeta(string key, string value)
    {
        using var cmd = _db.CreateCommand();
        cmd.CommandText =
            "INSERT INTO rag_meta(key, value) VALUES ($k, $v) ON CONFLICT(key) DO UPDATE SET value = excluded.value";
        cmd.Parameters.AddWithValue("$k", key);
        cmd.Parameters.AddWithValue("$v", value);
        cmd.ExecuteNonQuery();
    }

    private long? GetMetaLong(string key) => long.TryParse(GetMeta(key), out var v) ? v : null;

    private string? ReadRev() => GetMeta("rev");

    private static string NextRev(string? rev) => (long.TryParse(rev, out var v) ? v + 1 : 1).ToString();

    private static void BumpRev(SqliteConnection conn, SqliteTransaction tx)
    {
        using var cmd = conn.CreateCommand();
        cmd.Transaction = tx;
        cmd.CommandText = "UPDATE rag_meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'rev'";
        cmd.ExecuteNonQuery();
    }

    // ── 加载 / 刷新 ──

    private void ReloadLocked()
    {
        var list = new List<MemoryEntry>();
        using (var cmd = _db.CreateCommand())
        {
            cmd.CommandText =
                "SELECT id, text, source, embedding, weight, created_at, last_recalled_at, metadata FROM entries";
            using var reader = cmd.ExecuteReader();
            while (reader.Read())
            {
                list.Add(new MemoryEntry
                {
                    Id = reader.GetString(0),
                    Text = reader.GetString(1),
                    Source = reader.GetString(2),
                    Embedding = BlobToEmbedding((byte[])reader.GetValue(3)),
                    Weight = reader.GetDouble(4),
                    CreatedAt = reader.GetInt64(5),
                    LastRecalledAt = reader.GetInt64(6),
                    Metadata = reader.IsDBNull(7)
                        ? null
                        : JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(reader.GetString(7), EntryJson),
                });
            }
        }
        _entries = list;
        _ivf = null;
        _rev = ReadRev();
    }

    /// <summary>外部（TS 进程）写入后重载；rev 未变则仅一次索引查询。</summary>
    public void RefreshIfChanged()
    {
        lock (_sync)
        {
            var rev = ReadRev();
            if (rev != _rev) ReloadLocked();
        }
    }

    public List<MemoryEntry> Snapshot()
    {
        lock (_sync)
        {
            return new List<MemoryEntry>(_entries);
        }
    }

    // ── 写入 ──

    public List<MemoryEntry> AddPreparedBatch(IReadOnlyList<PreparedItem> items)
    {
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var results = new List<MemoryEntry>(items.Count);
        for (var i = 0; i < items.Count; i++)
        {
            results.Add(new MemoryEntry
            {
                Id = $"{items[i].Source}_{now}_{i}_{RandomString(4)}",
                Text = items[i].Text,
                Embedding = items[i].Embedding,
                Source = items[i].Source,
                Weight = 1.0,
                CreatedAt = now,
                LastRecalledAt = now,
                Metadata = items[i].Metadata,
            });
        }

        lock (_sync)
        {
            RefreshIfChanged();
            var preRev = ReadRev();
            using (var tx = _db.BeginTransaction(deferred: false))
            {
                InsertRowsLocked(results, tx);
                BumpRev(_db, tx);
                tx.Commit();
            }
            var postRev = ReadRev();
            if (postRev != NextRev(preRev))
            {
                // 期间有外部提交：整体重载，避免内存副本缺外部条目
                ReloadLocked();
            }
            else
            {
                _entries.AddRange(results);
                _ivf = null;
                _rev = postRev;
            }
        }
        return results;
    }

    private void InsertRowsLocked(IReadOnlyList<MemoryEntry> entries, SqliteTransaction? tx, bool ignoreConflicts = false)
    {
        using var cmd = _db.CreateCommand();
        cmd.Transaction = tx;
        cmd.CommandText =
            $"INSERT {(ignoreConflicts ? "OR IGNORE " : "OR REPLACE ")}INTO entries " +
            "(id, text, source, embedding, dim, weight, created_at, last_recalled_at, metadata) " +
            "VALUES ($id, $text, $source, $embedding, $dim, $weight, $created, $recalled, $metadata)";
        var pId = cmd.Parameters.Add("$id", SqliteType.Text);
        var pText = cmd.Parameters.Add("$text", SqliteType.Text);
        var pSource = cmd.Parameters.Add("$source", SqliteType.Text);
        var pEmbedding = cmd.Parameters.Add("$embedding", SqliteType.Blob);
        var pDim = cmd.Parameters.Add("$dim", SqliteType.Integer);
        var pWeight = cmd.Parameters.Add("$weight", SqliteType.Real);
        var pCreated = cmd.Parameters.Add("$created", SqliteType.Integer);
        var pRecalled = cmd.Parameters.Add("$recalled", SqliteType.Integer);
        var pMetadata = cmd.Parameters.Add("$metadata", SqliteType.Text);
        foreach (var e in entries)
        {
            pId.Value = e.Id;
            pText.Value = e.Text;
            pSource.Value = e.Source;
            pEmbedding.Value = EmbeddingToBlob(e.Embedding);
            pDim.Value = e.Embedding.Length;
            pWeight.Value = e.Weight;
            pCreated.Value = e.CreatedAt;
            pRecalled.Value = e.LastRecalledAt;
            pMetadata.Value = e.Metadata is null ? DBNull.Value : JsonSerializer.Serialize(e.Metadata, EntryJson);
            cmd.ExecuteNonQuery();
        }
    }

    private void UpdateRecallRowsLocked(IReadOnlyList<MemoryEntry> entries, SqliteTransaction tx)
    {
        using var cmd = _db.CreateCommand();
        cmd.Transaction = tx;
        cmd.CommandText = "UPDATE entries SET weight = $weight, last_recalled_at = $recalled WHERE id = $id";
        var pWeight = cmd.Parameters.Add("$weight", SqliteType.Real);
        var pRecalled = cmd.Parameters.Add("$recalled", SqliteType.Integer);
        var pId = cmd.Parameters.Add("$id", SqliteType.Text);
        foreach (var e in entries)
        {
            pWeight.Value = e.Weight;
            pRecalled.Value = e.LastRecalledAt;
            pId.Value = e.Id;
            cmd.ExecuteNonQuery();
        }
    }

    // ── 兼容 JSON（迁移 / 软合并） ──

    private long LegacyJsonMtime()
    {
        try
        {
            return new DateTimeOffset(File.GetLastWriteTimeUtc(_legacyJsonPath)).ToUnixTimeMilliseconds();
        }
        catch
        {
            return 0;
        }
    }

    private void MigrateLegacyJsonIfNeeded()
    {
        if (!File.Exists(_legacyJsonPath)) return;
        long count;
        using (var cmd = _db.CreateCommand())
        {
            cmd.CommandText = "SELECT COUNT(*) FROM entries";
            count = Convert.ToInt64(cmd.ExecuteScalar());
        }
        if (count > 0) return; // 已有数据：交给软合并处理

        List<MemoryEntry>? legacy;
        try
        {
            legacy = JsonSerializer.Deserialize<List<MemoryEntry>>(File.ReadAllText(_legacyJsonPath), EntryJson);
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[sqlite] legacy json parse failed: {ex.Message}");
            return;
        }

        lock (_sync)
        {
            if (legacy is { Count: > 0 })
            {
                using var tx = _db.BeginTransaction(deferred: false);
                InsertRowsLocked(legacy, tx, ignoreConflicts: true);
                BumpRev(_db, tx);
                tx.Commit();
                Console.Error.WriteLine($"[sqlite] migrated {legacy.Count} entries from memory-store.json");
            }
            SetMeta("json_merged_mtime", LegacyJsonMtime().ToString());
            // 索引元数据（TS 侧使用）随迁移保留
            var metaPath = Path.Combine(_dir, "memory-store-meta.json");
            if (File.Exists(metaPath))
            {
                try
                {
                    SetMeta("index_meta", File.ReadAllText(metaPath));
                }
                catch
                {
                    /* 尽力而为 */
                }
            }
        }
    }

    /// <summary>
    /// JSON 比记录的合并时间更新（例如切到 json 回退模式写了一段）→ 软合并缺失条目。
    /// 只 INSERT 缺失 id，不回灌覆盖库内数据；JSON 侧的删除不会同步（文档注明）。
    /// </summary>
    private void SoftMergeLegacyJsonIfNewer()
    {
        if (!File.Exists(_legacyJsonPath)) return;
        var mtime = LegacyJsonMtime();
        if (mtime <= (GetMetaLong("json_merged_mtime") ?? 0)) return;

        List<MemoryEntry>? legacy;
        try
        {
            legacy = JsonSerializer.Deserialize<List<MemoryEntry>>(File.ReadAllText(_legacyJsonPath), EntryJson);
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[sqlite] legacy json merge skipped: {ex.Message}");
            return;
        }

        lock (_sync)
        {
            var existing = new HashSet<string>();
            using (var cmd = _db.CreateCommand())
            {
                cmd.CommandText = "SELECT id FROM entries";
                using var reader = cmd.ExecuteReader();
                while (reader.Read()) existing.Add(reader.GetString(0));
            }
            var missing = (legacy ?? new List<MemoryEntry>()).Where((e) => !existing.Contains(e.Id)).ToList();
            if (missing.Count > 0)
            {
                using (var tx = _db.BeginTransaction(deferred: false))
                {
                    InsertRowsLocked(missing, tx, ignoreConflicts: true);
                    BumpRev(_db, tx);
                    tx.Commit();
                }
                Console.Error.WriteLine($"[sqlite] soft-merged {missing.Count} entries from newer memory-store.json");
            }
            SetMeta("json_merged_mtime", mtime.ToString());
        }
    }

    // ── 查询 / 统计 ──

    public bool HasImportedDocumentChunks(string importId)
    {
        lock (_sync)
        {
            RefreshIfChanged();
            return _entries.Any((entry) =>
                entry.Source == "imported_doc"
                && entry.Metadata != null
                && entry.Metadata.TryGetValue("importId", out var v)
                && v.ValueKind == JsonValueKind.String
                && v.GetString() == importId);
        }
    }

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

    // ── 向量检索（与 RagStore.Search 同构） ──

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
            // 跨进程安全：计算期间 TS 可能已写入，先同步 rev 再按 id 重新定位回写
            RefreshIfChanged();
            var changed = new List<MemoryEntry>();
            foreach (var (entry, _) in top)
            {
                var fresh = _entries.FirstOrDefault((e) => e.Id == entry.Id);
                if (fresh is null) continue;
                fresh.LastRecalledAt = now;
                fresh.Weight = Math.Min(fresh.Weight + 0.05, 5.0);
                changed.Add(fresh);
            }
            if (changed.Count > 0)
            {
                var preRev = ReadRev();
                using (var tx = _db.BeginTransaction(deferred: false))
                {
                    UpdateRecallRowsLocked(changed, tx);
                    BumpRev(_db, tx);
                    tx.Commit();
                }
                var postRev = ReadRev();
                if (postRev != NextRev(preRev)) ReloadLocked();
                else _rev = postRev;
            }
        }

        return top;
    }

    private void EnsureIndex()
    {
        if (_ivf != null) return;
        var n = _entries.Count;
        if (n < 2) return;
        var k = Math.Max(2, Math.Min(512, (int)Math.Round(Math.Sqrt(n) / 2, MidpointRounding.AwayFromZero)));
        var t0 = Environment.TickCount64;
        _ivf = Ivf.Build(_entries, k);
        Console.Error.WriteLine($"[sqlite] IVF index rebuilt: K={k}, entries={n}, took {Environment.TickCount64 - t0}ms");
    }

    // ── 工具 ──

    private static byte[] EmbeddingToBlob(double[] embedding)
    {
        var floats = new float[embedding.Length];
        for (var i = 0; i < embedding.Length; i++) floats[i] = (float)embedding[i];
        var bytes = new byte[floats.Length * 4];
        Buffer.BlockCopy(floats, 0, bytes, 0, bytes.Length);
        return bytes;
    }

    private static double[] BlobToEmbedding(byte[] blob)
    {
        var count = blob.Length / 4;
        var floats = new float[count];
        Buffer.BlockCopy(blob, 0, floats, 0, count * 4);
        var result = new double[count];
        for (var i = 0; i < count; i++) result[i] = floats[i];
        return result;
    }

    private static readonly char[] Base36 = "0123456789abcdefghijklmnopqrstuvwxyz".ToCharArray();

    private static string RandomString(int length)
    {
        var chars = new char[length];
        for (var i = 0; i < length; i++) chars[i] = Base36[Random.Shared.Next(Base36.Length)];
        return new string(chars);
    }

    public void Dispose()
    {
        lock (_sync)
        {
            _db.Dispose();
        }
    }
}

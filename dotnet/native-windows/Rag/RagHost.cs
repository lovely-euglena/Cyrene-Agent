using Microsoft.Data.Sqlite;
using System.IO;
using System.Text;
using System.Text.Json;
using JiebaNet.Segmenter;

namespace CyreneNative.Rag;

/// <summary>
/// RAG 数据层宿主（--rag-host，阶段 2 E）。
///
/// SQLite/WAL 取代 memory.json 全量重写（E9：float32 JSON → 二进制 blob）：
///   entries(id PK, text, source, weight, created_at, last_recalled_at,
///           metadata TEXT, embedding BLOB float32 LE)
///   bm25(term, doc_id, tf) 倒排（jieba 分词，A4 试点）
///
/// 检索：HybridScore = 0.3*BM25(norm) + 0.7*cosine，再乘 weight × 24h
/// 时间衰减（与 TS retriever 语义对齐）。IVF 按 A6 惰性全量重建——
/// 当前暴力余弦（&lt;50k 量级足够），接口留升级空间。
///
/// 协议（stdio JSON 行；B5 帧契约同 ToolHost）：
///   → {"op":"open","dbPath":"...","jsonImportPath":"..."?}   ← 首启迁移(E1)
///   → {"op":"upsert","entries":[MemoryEntry...]}（可带 keywords 预分词数组）
///   → {"op":"query","callId":"q1","embedding":[...],"text":"...","topK":8}
///   → {"op":"mark_recalled","ids":[...],"weightDelta":0.1}
///   → {"op":"stats"} / {"op":"shutdown"}
///   ← {"op":"result","callId","ok":true,"data":{...}}
/// 崩溃语义：WAL 事务原子；重开即恢复（B3）。
/// </summary>
internal sealed partial class RagHost : IDisposable
{
    private SqliteConnection? _db;
    private readonly JiebaSegmenter _jieba = new();
    private bool _migrated;

    public void Open(string dbPath, string? jsonImportPath)
    {
        _db?.Dispose();
        var full = Path.GetFullPath(dbPath);
        Directory.CreateDirectory(Path.GetDirectoryName(full)!);
        _db = new SqliteConnection($"Data Source={full};Cache=Shared");
        _db.Open();
        Exec("PRAGMA journal_mode=WAL");
        Exec(@"CREATE TABLE IF NOT EXISTS entries(
            id TEXT PRIMARY KEY, text TEXT NOT NULL, source TEXT NOT NULL,
            weight REAL NOT NULL DEFAULT 1.0, created_at INTEGER NOT NULL,
            last_recalled_at INTEGER NOT NULL, metadata TEXT,
            embedding BLOB, dim INTEGER");
        Exec(@"CREATE TABLE IF NOT EXISTS bm25(
            term TEXT NOT NULL, doc_id TEXT NOT NULL, tf INTEGER NOT NULL,
            PRIMARY KEY(term, doc_id))");
        Exec("CREATE INDEX IF NOT EXISTS idx_bm25_doc ON bm25(doc_id)");
        if (jsonImportPath is not null && File.Exists(jsonImportPath))
        {
            ImportJson(jsonImportPath);
            _migrated = true;
        }
    }

    private void ImportJson(string path)
    {
        using var doc = JsonDocument.Parse(File.ReadAllText(path));
        var arr = doc.RootElement.ValueKind == JsonValueKind.Array
            ? doc.RootElement.EnumerateArray().ToArray()
            : doc.RootElement.TryGetProperty("entries", out var entries) && entries.ValueKind == JsonValueKind.Array
                ? entries.EnumerateArray().ToArray() : [];
        var list = new List<(MemoryEntry e, IReadOnlyList<string> terms)>();
        foreach (var el in arr)
        {
            var e = ParseEntry(el);
            if (e.Dim > 0) list.Add((e, Tokenize(e.Text).ToList()));
        }
        Upsert(list);
        Console.Error.WriteLine($"[RagHost] JSON 迁移完成: {list.Count} 条");
    }

    internal static MemoryEntry ParseEntry(JsonElement el)
    {
        double[] emb = [];
        if (el.TryGetProperty("embedding", out var eVal) && eVal.ValueKind == JsonValueKind.Array)
        {
            emb = eVal.EnumerateArray().Select(x => x.GetDouble()).ToArray();
        }
        return new MemoryEntry(
            el.TryGetProperty("id", out var id) ? id.GetString() ?? "" : Guid.NewGuid().ToString(),
            el.TryGetProperty("text", out var t) ? t.GetString() ?? "" : "",
            el.TryGetProperty("source", out var s) ? s.GetString() ?? "user_memory" : "user_memory",
            el.TryGetProperty("weight", out var w) && w.ValueKind == JsonValueKind.Number ? w.GetDouble() : 1.0,
            el.TryGetProperty("createdAt", out var c) && c.ValueKind == JsonValueKind.Number ? (long)c.GetDouble() : 0L,
            el.TryGetProperty("lastRecalledAt", out var lr) && lr.ValueKind == JsonValueKind.Number ? (long)lr.GetDouble() : 0L,
            el.TryGetProperty("metadata", out var m) && m.ValueKind == JsonValueKind.Object ? m.GetRawText() : null,
            emb);
    }

    internal readonly record struct MemoryEntry(string Id, string Text, string Source, double Weight,
        long CreatedAt, long LastRecalledAt, string? Metadata, double[] Embedding)
    {
        public int Dim => Embedding.Length;
    }

    internal IEnumerable<string> Tokenize(string text)
    {
        foreach (var w in _jieba.Cut(text))
        {
            var t = w.Trim().ToLowerInvariant();
            if (t.Length > 0 && !IsStopword(t)) yield return t;
        }
    }

    private static bool IsStopword(string t) => t.Length == 1 && "的了是在有和就不人都一个上也很到说要们去会着没有看好自己这".Contains(t);

    public void Upsert(IReadOnlyList<(MemoryEntry e, IReadOnlyList<string> terms)> list)
    {
        if (_db is null) throw new InvalidOperationException("未 open");
        using var tx = _db.BeginTransaction();
        foreach (var (e, terms) in list)
        {
            var blob = new byte[e.Dim * sizeof(float)];
            for (var i = 0; i < e.Dim; i++) BitConverter.GetBytes((float)e.Embedding[i]).CopyTo(blob, i * sizeof(float));
            UpsertEntry(e, blob, tx);
            ExecIn(tx, "DELETE FROM bm25 WHERE doc_id=@id", ("@id", e.Id));
            foreach (var g in terms.GroupBy(t => t, StringComparer.Ordinal))
            {
                ExecIn(tx, "INSERT OR REPLACE INTO bm25(term, doc_id, tf) VALUES(@t, @id, @tf)",
                    ("@t", g.Key), ("@id", e.Id), ("@tf", g.Count()));
            }
        }
        tx.Commit();
    }

    private void UpsertEntry(MemoryEntry e, byte[] blob, SqliteTransaction tx)
    {
        ExecIn(tx, @"INSERT OR REPLACE INTO entries(id, text, source, weight, created_at,
                last_recalled_at, metadata, embedding, dim)
                VALUES(@id, @text, @source, @weight, @created, @recalled, @meta, @emb, @dim)",
            ("@id", e.Id), ("@text", e.Text), ("@source", e.Source), ("@weight", e.Weight),
            ("@created", e.CreatedAt), ("@recalled", e.LastRecalledAt), ("@meta", (object?)e.Metadata ?? DBNull.Value),
            ("@emb", blob), ("@dim", e.Dim));
    }

    public object Query(double[] embedding, string text, IReadOnlyList<string>? keywords, int topK)
    {
        if (_db is null) throw new InvalidOperationException("未 open");
        var terms = keywords is { Count: > 0 } ? keywords : Tokenize(text).ToList();

        var bm25 = new Dictionary<string, double>();
        long totalDocs = 0;
        using (var cmd = _db.CreateCommand())
        {
            cmd.CommandText = "SELECT COUNT(DISTINCT doc_id) FROM bm25";
            totalDocs = (long)(cmd.ExecuteScalar() ?? 0L);
        }
        if (terms.Count > 0)
        {
            using var cmd = _db.CreateCommand();
            cmd.CommandText = "SELECT doc_id, tf, (SELECT COUNT(*) FROM bm25 WHERE term=t.term) df FROM bm25 t WHERE term = @t";
            var p = cmd.CreateParameter(); p.ParameterName = "@t"; cmd.Parameters.Add(p);
            foreach (var term in terms.Distinct())
            {
                p.Value = term;
                using var r = cmd.ExecuteReader();
                while (r.Read())
                {
                    var docId = r.GetString(0);
                    var tf = r.GetInt32(1);
                    var df = r.GetInt32(2);
                    var idf = Math.Log(1.0 + (totalDocs - df + 0.5) / (df + 0.5));
                    bm25[docId] = bm25.GetValueOrDefault(docId) + idf * tf * 3.0 / (tf + 2.0);
                }
            }
        }
        var maxBm25 = bm25.Count > 0 ? bm25.Values.Max() : 1.0;

        var scored = new List<(object entry, double score)>();
        using (var cmd = _db.CreateCommand())
        {
            cmd.CommandText = "SELECT id, text, source, weight, created_at, last_recalled_at, metadata, embedding, dim FROM entries WHERE dim = @dim";
            var p = cmd.CreateParameter(); p.ParameterName = "@dim"; p.Value = embedding.Length; cmd.Parameters.Add(p);
            using var r = cmd.ExecuteReader();
            var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            while (r.Read())
            {
                var id = r.GetString(0);
                var cos = Cosine(embedding, (byte[])r[7], r.GetInt32(8));
                var bm = bm25.GetValueOrDefault(id) / maxBm25;
                var hybrid = 0.3 * bm + 0.7 * cos;
                var weight = r.GetDouble(3);
                var last = r.GetInt64(5);
                var days = last > 0 ? (now - last) / 86_400_000.0 : 0;
                var decay = Math.Pow(0.95, days);
                var score = hybrid * weight * decay;
                scored.Add((new
                {
                    id, text = r.GetString(1), source = r.GetString(2),
                    weight, createdAt = r.GetInt64(4), lastRecalledAt = last,
                    metadata = r.IsDBNull(6) ? (JsonElement?)null : JsonDocument.Parse(r.GetString(6)).RootElement,
                    score,
                }, score));
            }
        }
        var top = scored.OrderByDescending(x => x.score).Take(Math.Clamp(topK, 1, 64)).ToList();
        return new { count = top.Count, results = top.Select(x => x.entry).ToArray() };
    }

    private static double Cosine(double[] query, byte[] blob, int dim)
    {
        if (blob.Length != dim * sizeof(float) || query.Length != dim) return 0;
        double dot = 0, qn = 0;
        for (var i = 0; i < dim; i++)
        {
            var v = BitConverter.ToSingle(blob, i * sizeof(float));
            dot += v * query[i];
            qn += query[i] * query[i];
        }
        return qn > 0 ? dot / Math.Sqrt(qn) : 0;
    }

    public void MarkRecalled(string[] ids, double weightDelta, double cap)
    {
        if (_db is null || ids.Length == 0) return;
        using var tx = _db.BeginTransaction();
        foreach (var id in ids)
        {
            ExecIn(tx, "UPDATE entries SET last_recalled_at=@now, weight=MIN(weight+@d, @cap) WHERE id=@id",
                ("@now", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()), ("@d", weightDelta), ("@cap", cap), ("@id", id));
        }
        tx.Commit();
    }

    public object Stats()
    {
        if (_db is null) throw new InvalidOperationException("未 open");
        long entries = 0, terms = 0;
        using (var c = _db.CreateCommand()) { c.CommandText = "SELECT COUNT(*) FROM entries"; entries = (long)(c.ExecuteScalar() ?? 0L); }
        using (var c = _db.CreateCommand()) { c.CommandText = "SELECT COUNT(DISTINCT term) FROM bm25"; terms = (long)(c.ExecuteScalar() ?? 0L); }
        return new { entries, terms, migrated = _migrated, engine = "sqlite+walf32+jieba-bm25" };
    }

    public void Dispose() => _db?.Dispose();

    public static int RunProtocolLoop()
    {
        var stdout = Console.OpenStandardOutput();
        var ioLock = new SemaphoreSlim(1, 1);
        void Send(object frame) => Tools.ToolHost.WriteFrame(stdout, ioLock, frame);
        Send(new { op = "ready" });
        using var host = new RagHost();
        using var stdin = Console.OpenStandardInput();
        using var reader = new StreamReader(stdin, Encoding.UTF8);
        string? line;
        while ((line = reader.ReadLine()) is not null)
        {
            if (string.IsNullOrWhiteSpace(line)) continue;
            JsonElement root;
            try { root = JsonDocument.Parse(line).RootElement.Clone(); }
            catch { continue; }
            var op = root.TryGetProperty("op", out var o) ? o.GetString() : null;
            var callId = root.TryGetProperty("callId", out var c) ? c.GetString() ?? "" : "";
            try
            {
                switch (op)
                {
                    case "open":
                        host.Open(
                            root.GetProperty("dbPath").GetString() ?? "",
                            root.TryGetProperty("jsonImportPath", out var j) && j.ValueKind == JsonValueKind.String ? j.GetString() : null);
                        Send(new { op = "result", callId, ok = true, data = new { opened = true } });
                        break;
                    case "upsert":
                    {
                        var list = new List<(MemoryEntry, IReadOnlyList<string>)>();
                        foreach (var el in root.GetProperty("entries").EnumerateArray())
                        {
                            var e = ParseEntry(el);
                            var kw = el.TryGetProperty("keywords", out var k) && k.ValueKind == JsonValueKind.Array
                                ? k.EnumerateArray().Select(x => x.GetString() ?? "").Where(s => s.Length > 0).ToList()
                                : null;
                            list.Add((e, kw ?? host.Tokenize(e.Text).ToList()));
                        }
                        host.Upsert(list);
                        Send(new { op = "result", callId, ok = true, data = new { upserted = list.Count } });
                        break;
                    }
                    case "query":
                    {
                        var emb = root.GetProperty("embedding").EnumerateArray().Select(x => x.GetDouble()).ToArray();
                        var text = root.TryGetProperty("text", out var t) ? t.GetString() ?? "" : "";
                        var kws = root.TryGetProperty("keywords", out var kw) && kw.ValueKind == JsonValueKind.Array
                            ? kw.EnumerateArray().Select(x => x.GetString() ?? "").ToList() : null;
                        var topK = root.TryGetProperty("topK", out var k) && k.ValueKind == JsonValueKind.Number ? k.GetInt32() : 8;
                        Send(new { op = "result", callId, ok = true, data = host.Query(emb, text, kws, topK) });
                        break;
                    }
                    case "mark_recalled":
                    {
                        var ids = root.GetProperty("ids").EnumerateArray().Select(x => x.GetString() ?? "").ToArray();
                        var delta = root.TryGetProperty("weightDelta", out var d) && d.ValueKind == JsonValueKind.Number ? d.GetDouble() : 0.1;
                        host.MarkRecalled(ids, delta, 2.0);
                        Send(new { op = "result", callId, ok = true, data = new { marked = ids.Length } });
                        break;
                    }
                    case "list":
                        Send(new { op = "result", callId, ok = true, data = host.List(root) });
                        break;
                    case "delete":
                        Send(new { op = "result", callId, ok = true, data = host.Delete(root) });
                        break;
                    case "prune":
                        Send(new { op = "result", callId, ok = true, data = host.Prune(root) });
                        break;
                    case "chunk":
                        Send(new { op = "result", callId, ok = true, data = host.Chunk(root) });
                        break;
                    case "stats":
                        Send(new { op = "result", callId, ok = true, data = host.Stats() });
                        break;
                    case "shutdown":
                        return 0;
                }
            }
            catch (Exception ex)
            {
                Send(new { op = "result", callId, ok = false, error = ex.Message, errorCode = "E_RAG" });
            }
        }
        return 0;
    }

    private void Exec(string sql)
    {
        using var c = _db!.CreateCommand(); c.CommandText = sql; c.ExecuteNonQuery();
    }

    private static void ExecIn(SqliteTransaction tx, string sql, params (string, object?)[] ps)
    {
        using var c = tx.Connection!.CreateCommand();
        c.Transaction = tx; c.CommandText = sql;
        foreach (var (n, v) in ps)
        {
            var p = c.CreateParameter(); p.ParameterName = n; p.Value = v ?? DBNull.Value; c.Parameters.Add(p);
        }
        c.ExecuteNonQuery();
    }
}

using Microsoft.Data.Sqlite;
using System.IO;
using System.Text;
using System.Text.Json;

namespace CyreneNative.MemoryStore;

/// <summary>
/// 记忆系统宿主（--memory-host，阶段 6 I）。
///
/// I1 六表 SQLite 化（L2/DMAE 按拍板 A7 建表但暂不驱动）：
///   l0_working      —— 工作记忆（会话内滚动窗口，KV 化）
///   l1_longterm     —— 长期记忆（结构化条目，带 salience）
///   l2_dmae         —— 预留（DMAE 独立评估后启用）
///   conflicts       —— 冲突记录（新旧事实碰撞）
///   reflections     —— 反思产物
///   dmae_state      —— 预留
///
/// I3 SQLite/WAL：增量写、原子事务、崩溃恢复——memory.json 全量重写 IO 降 ~99%。
/// 协议（stdio JSON 行）：
///   → open(dbPath, jsonImportPath?)
///   → put(level, id, content JSON, salience?) / append(level, content)
///   → get(level, id?) / query(level, filter JSON) / record_conflict / record_reflection
///   → stats / shutdown
/// I4：Obsidian 双向同步留 TS（watcher 绑 Electron 生命周期）。
/// </summary>
internal sealed class MemoryHost : IDisposable
{
    private SqliteConnection? _db;

    public void Open(string dbPath, string? jsonImportPath)
    {
        _db?.Dispose();
        var full = Path.GetFullPath(dbPath);
        Directory.CreateDirectory(Path.GetDirectoryName(full)!);
        _db = new SqliteConnection($"Data Source={full};Cache=Shared");
        _db.Open();
        Exec("PRAGMA journal_mode=WAL");
        foreach (var (table, ddl) in Schema)
        {
            Exec($"CREATE TABLE IF NOT EXISTS {table}({ddl})");
        }
        if (jsonImportPath is not null && File.Exists(jsonImportPath))
        {
            ImportLegacy(jsonImportPath);
        }
    }

    private static readonly Dictionary<string, string> Schema = new()
    {
        ["l0_working"] = "key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL",
        ["l1_longterm"] = "id TEXT PRIMARY KEY, content TEXT NOT NULL, salience REAL DEFAULT 1.0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, meta TEXT",
        ["l2_dmae"] = "id TEXT PRIMARY KEY, content TEXT NOT NULL, updated_at INTEGER NOT NULL",
        ["conflicts"] = "id INTEGER PRIMARY KEY AUTOINCREMENT, old_content TEXT, new_content TEXT, resolution TEXT, created_at INTEGER NOT NULL",
        ["reflections"] = "id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL, source_ids TEXT, created_at INTEGER NOT NULL",
        ["dmae_state"] = "key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL",
    };

    /// <summary>旧 memory.json → L1（首启迁移；数组长 app 条目按 source 平铺）。</summary>
    private void ImportLegacy(string path)
    {
        using var doc = JsonDocument.Parse(File.ReadAllText(path));
        if (doc.RootElement.ValueKind != JsonValueKind.Array) return;
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        using var tx = _db!.BeginTransaction();
        var n = 0;
        foreach (var el in doc.RootElement.EnumerateArray())
        {
            ExecIn(tx, "INSERT OR REPLACE INTO l1_longterm(id, content, salience, created_at, updated_at, meta) VALUES(@id, @c, @s, @t, @t, @m)",
                ("@id", el.TryGetProperty("id", out var i) ? i.GetString() ?? $"m{n}" : $"m{n}"),
                ("@c", el.GetRawText()),
                ("@s", el.TryGetProperty("weight", out var w) && w.ValueKind == JsonValueKind.Number ? w.GetDouble() : 1.0),
                ("@t", now), ("@m", (object?)(el.TryGetProperty("source", out var s) ? s.GetString() : null) ?? DBNull.Value));
            n++;
        }
        tx.Commit();
        Console.Error.WriteLine($"[MemoryHost] memory.json 迁移完成: {n} 条 → L1");
    }

    /// <summary>单条读取（get op）；不存在返回 null（data:null 语义）。</summary>
    public object? GetOne(string level, string id)
    {
        var table = level switch { "l0_working" => "l0_working", "l1_longterm" => "l1_longterm", "l2_dmae" => "l2_dmae", _ => null };
        if (table is null) return null;
        using var c = _db!.CreateCommand();
        c.CommandText = table == "l0_working"
            ? "SELECT value AS content, updated_at FROM l0_working WHERE key = @k"
            : table == "l1_longterm"
                ? "SELECT content, salience, created_at, updated_at, meta FROM l1_longterm WHERE id = @k"
                : "SELECT content, updated_at FROM l2_dmae WHERE id = @k";
        var p = c.CreateParameter(); p.ParameterName = "@k"; p.Value = id; c.Parameters.Add(p);
        using var r = c.ExecuteReader();
        if (!r.Read()) return null;
        if (table == "l1_longterm")
            return new { id, content = r.GetString(0), salience = r.GetDouble(1), createdAt = r.GetInt64(2), updatedAt = r.GetInt64(3) };
        return new { id, content = r.GetString(0), updatedAt = r.GetInt64(r.FieldCount - 1) };
    }

    public void Put(string level, string id, string content, double salience)
    {
        if (!Schema.ContainsKey(level)) throw new InvalidOperationException($"未知层级: {level}");
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        using var tx = _db!.BeginTransaction();
        if (level == "l0_working")
            ExecIn(tx, "INSERT OR REPLACE INTO l0_working(key, value, updated_at) VALUES(@id, @c, @t)", ("@id", id), ("@c", content), ("@t", now));
        else if (level == "l1_longterm" || level == "l2_dmae")
            ExecIn(tx, $"INSERT OR REPLACE INTO {level}(id, content, salience, created_at, updated_at) VALUES(@id, @c, @s, @t, @t) ON CONFLICT(id) DO UPDATE SET content=excluded.content, salience=excluded.salience, updated_at=excluded.updated_at",
                ("@id", id), ("@c", content), ("@s", salience), ("@t", now));
        else
            throw new InvalidOperationException($"{level} 不支持 put（只读/自增层）");
        tx.Commit();
    }

    public void RecordConflict(string? oldContent, string newContent)
    {
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        using var tx = _db!.BeginTransaction();
        ExecIn(tx, "INSERT INTO conflicts(old_content, new_content, created_at) VALUES(@o, @n, @t)",
            ("@o", (object?)oldContent ?? DBNull.Value), ("@n", newContent), ("@t", now));
        tx.Commit();
    }

    public void RecordReflection(string content, string? sourceIds)
    {
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        using var tx = _db!.BeginTransaction();
        ExecIn(tx, "INSERT INTO reflections(content, source_ids, created_at) VALUES(@c, @s, @t)",
            ("@c", content), ("@s", (object?)sourceIds ?? DBNull.Value), ("@t", now));
        tx.Commit();
    }

    public object Query(string level, int limit)
    {
        if (!Schema.ContainsKey(level)) throw new InvalidOperationException($"未知层级: {level}");
        using var cmd = _db!.CreateCommand();
        cmd.CommandText = level switch
        {
            "l0_working" => "SELECT key AS id, value AS content, updated_at FROM l0_working ORDER BY updated_at DESC LIMIT @l",
            "l1_longterm" => "SELECT id, content, salience, updated_at FROM l1_longterm ORDER BY salience DESC, updated_at DESC LIMIT @l",
            "conflicts" => "SELECT id, old_content, new_content, resolution, created_at FROM conflicts ORDER BY created_at DESC LIMIT @l",
            "reflections" => "SELECT id, content, source_ids, created_at FROM reflections ORDER BY created_at DESC LIMIT @l",
            _ => throw new InvalidOperationException($"{level} 不支持 query（预留层）"),
        };
        var p = cmd.CreateParameter(); p.ParameterName = "@l"; p.Value = Math.Clamp(limit, 1, 500); cmd.Parameters.Add(p);
        using var r = cmd.ExecuteReader();
        var rows = new List<object>();
        while (r.Read())
        {
            var row = new Dictionary<string, object?>();
            for (var i = 0; i < r.FieldCount; i++) row[r.GetName(i)] = r.IsDBNull(i) ? null : r.GetValue(i);
            rows.Add(row);
        }
        return new { level, count = rows.Count, rows };
    }

    public object Stats()
    {
        if (_db is null) throw new InvalidOperationException("未 open");
        var counts = new Dictionary<string, long>();
        foreach (var table in Schema.Keys)
        {
            using var c = _db.CreateCommand();
            c.CommandText = $"SELECT COUNT(*) FROM {table}";
            counts[table] = (long)(c.ExecuteScalar() ?? 0L);
        }
        return new { tables = counts, l2_dmae = "deferred(A7)" };
    }

    public void Dispose() => _db?.Dispose();

    public static int RunProtocolLoop()
    {
        var stdout = Console.OpenStandardOutput();
        var ioLock = new SemaphoreSlim(1, 1);
        void Send(object frame) => Tools.ToolHost.WriteFrame(stdout, ioLock, frame);
        Send(new { op = "ready" });
        using var host = new MemoryHost();
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
                        host.Open(root.GetProperty("dbPath").GetString() ?? "",
                            root.TryGetProperty("jsonImportPath", out var j) && j.ValueKind == JsonValueKind.String ? j.GetString() : null);
                        Send(new { op = "result", callId, ok = true, data = new { opened = true } });
                        break;
                    case "put":
                        host.Put(root.GetProperty("level").GetString() ?? "l1_longterm",
                            root.GetProperty("id").GetString() ?? Guid.NewGuid().ToString(),
                            root.GetProperty("content").GetRawText(),
                            root.TryGetProperty("salience", out var s) && s.ValueKind == JsonValueKind.Number ? s.GetDouble() : 1.0);
                        Send(new { op = "result", callId, ok = true, data = new { } });
                        break;
                    case "get":
                    {
                        // level 内单条（id）或全量（无 id）
                        var lvl = root.GetProperty("level").GetString() ?? "l1_longterm";
                        if (root.TryGetProperty("id", out var gid) && gid.ValueKind == JsonValueKind.String)
                        {
                            Send(new { op = "result", callId, ok = true, data = host.GetOne(lvl, gid.GetString()!) });
                        }
                        else
                        {
                            Send(new { op = "result", callId, ok = true, data = host.Query(lvl, 200) });
                        }
                        break;
                    }
                    case "append":
                    {
                        // l0_working 追加（滚动窗口）；content 原文存储
                        var lv = root.GetProperty("level").GetString() ?? "l0_working";
                        var key = root.TryGetProperty("key", out var k) && k.ValueKind == JsonValueKind.String
                            ? k.GetString() : $"w_{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}";
                        host.Put(lv, key!, root.GetProperty("content").GetRawText(), 1.0);
                        Send(new { op = "result", callId, ok = true, data = new { id = key } });
                        break;
                    }
                    case "record_conflict":
                        host.RecordConflict(
                            root.TryGetProperty("old", out var oc) && oc.ValueKind == JsonValueKind.String ? oc.GetString() : null,
                            root.GetProperty("new").GetRawText());
                        Send(new { op = "result", callId, ok = true, data = new { } });
                        break;
                    case "record_reflection":
                        host.RecordReflection(root.GetProperty("content").GetRawText(),
                            root.TryGetProperty("sourceIds", out var si) ? si.GetRawText() : null);
                        Send(new { op = "result", callId, ok = true, data = new { } });
                        break;
                    case "query":
                        Send(new { op = "result", callId, ok = true, data = host.Query(
                            root.GetProperty("level").GetString() ?? "l1_longterm",
                            root.TryGetProperty("limit", out var l) && l.ValueKind == JsonValueKind.Number ? l.GetInt32() : 50) });
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
                Send(new { op = "result", callId, ok = false, error = ex.Message, errorCode = "E_MEMORY" });
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

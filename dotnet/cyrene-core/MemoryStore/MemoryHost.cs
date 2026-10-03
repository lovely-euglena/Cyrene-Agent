using Microsoft.Data.Sqlite;
using System.IO;
using System.Text;
using System.Text.Json;

namespace CyreneNative.MemoryStore;

/// <summary>
/// 记忆系统宿主（--memory-host）。
///
/// 行模型统一为「id/key + 内容 JSON + 时间戳」，让 TS memory-store 可 0/1 直切：
///   l0_working   —— L0 画像（KV：key/value，key 固定 "l0"）
///   l1_longterm  —— L1 近期状态（单条目 id="l1"，content=JSON）
///   l2_dmae      —— L2 记忆条目（id/content=JSON/salience/created_at/updated_at）
///   evidence     —— 记忆证据（id/content=JSON/created_at）
///   conflicts    —— 冲突记录（id/content=JSON/created_at）
///   reflections  —— 反思记录（id/content=JSON/created_at）
///   dmae_state   —— L2 DMAE 运行时状态（KV：key=l2Id，value=JSON）
///
/// 协议（stdio JSON 行）：
///   → open(dbPath, jsonImportPath?)
///   → put(level, id, content JSON, salience?, createdAt?, updatedAt?)
///   → append(level=l0_working, key?, content) / get(level, id?) / query(level, limit?)
///   → replace(level, rows[]) / clear(level) / delete(level, id)
///   → record_conflict(old, new) / record_reflection(content, sourceIds)
///   → stats / shutdown
/// 旧 memory.json（对象形或数组形）在首次 open 时一次性导入。
/// </summary>
internal sealed class MemoryHost : IDisposable
{
    private SqliteConnection? _db;

    private static readonly Dictionary<string, string> Schema = new()
    {
        ["l0_working"] = "key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL",
        ["l1_longterm"] = "id TEXT PRIMARY KEY, content TEXT NOT NULL, salience REAL DEFAULT 1.0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL",
        ["l2_dmae"] = "id TEXT PRIMARY KEY, content TEXT NOT NULL, salience REAL DEFAULT 1.0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL",
        ["evidence"] = "id TEXT PRIMARY KEY, content TEXT NOT NULL, created_at INTEGER NOT NULL",
        ["conflicts"] = "id TEXT PRIMARY KEY, content TEXT NOT NULL, created_at INTEGER NOT NULL",
        ["reflections"] = "id TEXT PRIMARY KEY, content TEXT NOT NULL, created_at INTEGER NOT NULL",
        ["dmae_state"] = "key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL",
    };

    private static bool IsKv(string level) => level == "l0_working" || level == "dmae_state";
    private static bool HasSalience(string level) => level == "l1_longterm" || level == "l2_dmae";
    private static string IdColumn(string level) => IsKv(level) ? "key" : "id";

    public void Open(string dbPath, string? jsonImportPath)
    {
        _db?.Dispose();
        var full = Path.GetFullPath(dbPath);
        Directory.CreateDirectory(Path.GetDirectoryName(full)!);
        _db = new SqliteConnection($"Data Source={full};Cache=Shared");
        _db.Open();
        Exec("PRAGMA journal_mode=WAL");
        Exec("PRAGMA synchronous=NORMAL");
        foreach (var (table, ddl) in Schema)
        {
            Exec($"CREATE TABLE IF NOT EXISTS {table}({ddl})");
        }
        if (jsonImportPath is not null && File.Exists(jsonImportPath))
        {
            ImportLegacy(jsonImportPath);
        }
    }

    /// <summary>旧 memory.json → 七表（对象形新格式；数组形按旧版 L1 迁移）。</summary>
    private void ImportLegacy(string path)
    {
        using var doc = JsonDocument.Parse(File.ReadAllText(path));
        var root = doc.RootElement;
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

        if (root.ValueKind == JsonValueKind.Array)
        {
            // 旧版：数组形长期记忆
            using var tx = _db!.BeginTransaction();
            var n = 0;
            foreach (var el in root.EnumerateArray())
            {
                var id = el.TryGetProperty("id", out var i) ? i.GetString() ?? $"m{n}" : $"m{n}";
                var salience = el.TryGetProperty("weight", out var w) && w.ValueKind == JsonValueKind.Number ? w.GetDouble() : 1.0;
                InsertRow(tx, "l1_longterm", id, el.GetRawText(), salience, now, now);
                n++;
            }
            tx.Commit();
            Console.Error.WriteLine($"[MemoryHost] memory.json 迁移完成(数组形): {n} 条 → l1_longterm");
            return;
        }

        if (root.ValueKind != JsonValueKind.Object) return;

        using var tx2 = _db!.BeginTransaction();
        var counts = new Dictionary<string, int>();

        if (root.TryGetProperty("l0", out var l0) && l0.ValueKind == JsonValueKind.Object)
        {
            PutKv(tx2, "l0_working", "l0", l0.GetRawText(), now);
            counts["l0"] = 1;
        }
        if (root.TryGetProperty("l1", out var l1) && l1.ValueKind == JsonValueKind.Object)
        {
            InsertRow(tx2, "l1_longterm", "l1", l1.GetRawText(), 1.0, now, now);
            counts["l1"] = 1;
        }
        counts["l2"] = ImportArray(tx2, root, "l2", "l2_dmae", withSalience: true, now);
        counts["evidence"] = ImportArray(tx2, root, "evidence", "evidence", withSalience: false, now);
        counts["conflictLogs"] = ImportArray(tx2, root, "conflictLogs", "conflicts", withSalience: false, now);
        counts["reflectionLogs"] = ImportArray(tx2, root, "reflectionLogs", "reflections", withSalience: false, now);

        if (root.TryGetProperty("l2DmaeStates", out var states) && states.ValueKind == JsonValueKind.Array)
        {
            var n = 0;
            foreach (var st in states.EnumerateArray())
            {
                var id = st.TryGetProperty("l2Id", out var sid) ? sid.GetString() : null;
                if (string.IsNullOrEmpty(id)) { n++; continue; }
                PutKv(tx2, "dmae_state", id!, st.GetRawText(), now);
                n++;
            }
            counts["l2DmaeStates"] = n;
        }
        tx2.Commit();
        Console.Error.WriteLine($"[MemoryHost] memory.json 迁移完成: {JsonSerializer.Serialize(counts)}");
    }

    private static int ImportArray(SqliteTransaction tx, JsonElement root, string prop, string level, bool withSalience, long now)
    {
        if (!root.TryGetProperty(prop, out var arr) || arr.ValueKind != JsonValueKind.Array) return 0;
        var n = 0;
        foreach (var el in arr.EnumerateArray())
        {
            var id = el.TryGetProperty("id", out var i) ? i.GetString() : null;
            if (string.IsNullOrEmpty(id)) id = $"{level}_{n}";
            var created = el.TryGetProperty("createdAt", out var c) && c.ValueKind == JsonValueKind.Number ? c.GetInt64() : now;
            var updated = el.TryGetProperty("lastAccessedAt", out var u) && u.ValueKind == JsonValueKind.Number ? u.GetInt64() : created;
            var salience = withSalience && el.TryGetProperty("weight", out var w) && w.ValueKind == JsonValueKind.Number ? w.GetDouble() : 1.0;
            InsertRow(tx, level, id!, el.GetRawText(), salience, created, updated);
            n++;
        }
        return n;
    }

    // ── 写入 ────────────────────────────────────────────────

    public void Put(string level, string id, string contentJson, double salience, long? createdAt, long? updatedAt)
    {
        EnsureLevel(level);
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        using var tx = _db!.BeginTransaction();
        if (IsKv(level)) PutKv(tx, level, id, contentJson, updatedAt ?? now);
        else InsertRow(tx, level, id, contentJson, salience, createdAt ?? now, updatedAt ?? now);
        tx.Commit();
    }

    /// <summary>整层替换：clear + 批量写入（一次事务），用于 TS 全量持久化。</summary>
    public int Replace(string level, JsonElement rows)
    {
        EnsureLevel(level);
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        using var tx = _db!.BeginTransaction();
        ExecIn(tx, $"DELETE FROM {level}");
        var n = 0;
        if (rows.ValueKind == JsonValueKind.Array)
        {
            foreach (var row in rows.EnumerateArray())
            {
                var id = row.TryGetProperty("id", out var i) ? i.GetString()
                    : row.TryGetProperty("key", out var k) ? k.GetString()
                    : Guid.NewGuid().ToString();
                var content = row.TryGetProperty("content", out var c) ? c.GetRawText() : "null";
                var salience = row.TryGetProperty("salience", out var s) && s.ValueKind == JsonValueKind.Number ? s.GetDouble() : 1.0;
                var created = row.TryGetProperty("createdAt", out var ca) && ca.ValueKind == JsonValueKind.Number ? ca.GetInt64() : now;
                var updated = row.TryGetProperty("updatedAt", out var ua) && ua.ValueKind == JsonValueKind.Number ? ua.GetInt64() : now;
                if (IsKv(level)) PutKv(tx, level, id ?? Guid.NewGuid().ToString(), content, updated);
                else InsertRow(tx, level, id ?? Guid.NewGuid().ToString(), content, salience, created, updated);
                n++;
            }
        }
        tx.Commit();
        return n;
    }

    public void Delete(string level, string id)
    {
        EnsureLevel(level);
        using var c = _db!.CreateCommand();
        c.CommandText = $"DELETE FROM {level} WHERE {IdColumn(level)} = @id";
        var p = c.CreateParameter(); p.ParameterName = "@id"; p.Value = id; c.Parameters.Add(p);
        c.ExecuteNonQuery();
    }

    public void Clear(string level)
    {
        EnsureLevel(level);
        Exec($"DELETE FROM {level}");
    }

    public void RecordConflict(string? oldContent, string newContent)
    {
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var id = $"conflict_{now}_{Guid.NewGuid():N}";
        var payload = JsonSerializer.Serialize(new { old = oldContent, @new = newContent });
        using var tx = _db!.BeginTransaction();
        ExecIn(tx, "INSERT OR REPLACE INTO conflicts(id, content, created_at) VALUES(@id, @c, @t)",
            ("@id", id), ("@c", payload), ("@t", now));
        tx.Commit();
    }

    public void RecordReflection(string content, string? sourceIds)
    {
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var id = $"reflection_{now}_{Guid.NewGuid():N}";
        var payload = JsonSerializer.Serialize(new { content, sourceIds });
        using var tx = _db!.BeginTransaction();
        ExecIn(tx, "INSERT OR REPLACE INTO reflections(id, content, created_at) VALUES(@id, @c, @t)",
            ("@id", id), ("@c", payload), ("@t", now));
        tx.Commit();
    }

    // ── 读取 ────────────────────────────────────────────────

    /// <summary>单条读取；不存在返回 null。</summary>
    public object? GetOne(string level, string id)
    {
        EnsureLevel(level);
        using var c = _db!.CreateCommand();
        c.CommandText = SelectSql(level) + $" WHERE {IdColumn(level)} = @k";
        var p = c.CreateParameter(); p.ParameterName = "@k"; p.Value = id; c.Parameters.Add(p);
        using var r = c.ExecuteReader();
        if (!r.Read()) return null;
        return ReadRow(r, level, id);
    }

    public object Query(string level, int limit, string? filter = null)
    {
        EnsureLevel(level);
        using var cmd = _db!.CreateCommand();
        var order = IsKv(level) ? "updated_at" : HasSalience(level) ? "updated_at" : "created_at";
        cmd.CommandText = SelectSql(level) + $" ORDER BY {order} DESC LIMIT @l";
        var p = cmd.CreateParameter(); p.ParameterName = "@l"; p.Value = Math.Clamp(limit, 1, 100_000); cmd.Parameters.Add(p);
        using var r = cmd.ExecuteReader();
        var rows = new List<object>();
        while (r.Read())
        {
            rows.Add(ReadRow(r, level, r.GetString(0)));
        }
        return new { level, count = rows.Count, rows };
    }

    private static string SelectSql(string level) => level switch
    {
        "l0_working" or "dmae_state" => $"SELECT {IdColumn(level)}, value, updated_at FROM {level}",
        "l1_longterm" or "l2_dmae" => $"SELECT {IdColumn(level)}, content, salience, created_at, updated_at FROM {level}",
        _ => $"SELECT {IdColumn(level)}, content, created_at FROM {level}",
    };

    private static object ReadRow(SqliteDataReader r, string level, string id)
    {
        if (IsKv(level))
            return new { id, content = r.GetString(1), updatedAt = r.GetInt64(2) };
        if (HasSalience(level))
            return new { id, content = r.GetString(1), salience = r.GetDouble(2), createdAt = r.GetInt64(3), updatedAt = r.GetInt64(4) };
        return new { id, content = r.GetString(1), createdAt = r.GetInt64(2) };
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
        return new { tables = counts };
    }

    public void Dispose() => _db?.Dispose();

    // ── 内部 ────────────────────────────────────────────────

    private static void EnsureLevel(string level)
    {
        if (!Schema.ContainsKey(level)) throw new InvalidOperationException($"未知层级: {level}");
    }

    private static void PutKv(SqliteTransaction tx, string level, string key, string value, long updatedAt)
    {
        ExecIn(tx, $"INSERT OR REPLACE INTO {level}(key, value, updated_at) VALUES(@id, @c, @t)",
            ("@id", key), ("@c", value), ("@t", updatedAt));
    }

    private static void InsertRow(SqliteTransaction tx, string level, string id, string content, double salience, long createdAt, long updatedAt)
    {
        if (HasSalience(level))
        {
            ExecIn(tx, $"INSERT OR REPLACE INTO {level}(id, content, salience, created_at, updated_at) VALUES(@id, @c, @s, @cr, @up)",
                ("@id", id), ("@c", content), ("@s", salience), ("@cr", createdAt), ("@up", updatedAt));
        }
        else
        {
            ExecIn(tx, $"INSERT OR REPLACE INTO {level}(id, content, created_at) VALUES(@id, @c, @t)",
                ("@id", id), ("@c", content), ("@t", createdAt));
        }
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
                        host.Put(
                            root.TryGetProperty("level", out var pl) ? pl.GetString() ?? "l2_dmae" : "l2_dmae",
                            IdOf(root) ?? Guid.NewGuid().ToString(),
                            root.TryGetProperty("content", out var pc) ? pc.GetRawText() : "null",
                            root.TryGetProperty("salience", out var ps) && ps.ValueKind == JsonValueKind.Number ? ps.GetDouble() : 1.0,
                            root.TryGetProperty("createdAt", out var pca) && pca.ValueKind == JsonValueKind.Number ? pca.GetInt64() : null,
                            root.TryGetProperty("updatedAt", out var pua) && pua.ValueKind == JsonValueKind.Number ? pua.GetInt64() : null);
                        Send(new { op = "result", callId, ok = true, data = new { } });
                        break;
                    case "replace":
                    {
                        var level = root.TryGetProperty("level", out var rl) ? rl.GetString() ?? "l2_dmae" : "l2_dmae";
                        var rows = root.TryGetProperty("rows", out var rr) ? rr : default;
                        var n = host.Replace(level, rows);
                        Send(new { op = "result", callId, ok = true, data = new { count = n } });
                        break;
                    }
                    case "clear":
                        host.Clear(root.TryGetProperty("level", out var cl) ? cl.GetString() ?? "l2_dmae" : "l2_dmae");
                        Send(new { op = "result", callId, ok = true, data = new { } });
                        break;
                    case "delete":
                        host.Delete(
                            root.TryGetProperty("level", out var dl) ? dl.GetString() ?? "l2_dmae" : "l2_dmae",
                            IdOf(root) ?? "");
                        Send(new { op = "result", callId, ok = true, data = new { } });
                        break;
                    case "get":
                    {
                        var lvl = root.TryGetProperty("level", out var gl) ? gl.GetString() ?? "l2_dmae" : "l2_dmae";
                        var gid = IdOf(root);
                        if (gid is not null)
                        {
                            Send(new { op = "result", callId, ok = true, data = host.GetOne(lvl, gid) });
                        }
                        else
                        {
                            Send(new { op = "result", callId, ok = true, data = host.Query(lvl, 100_000) });
                        }
                        break;
                    }
                    case "append":
                    {
                        var lv = root.TryGetProperty("level", out var al) ? al.GetString() ?? "l0_working" : "l0_working";
                        var key = root.TryGetProperty("key", out var k) && k.ValueKind == JsonValueKind.String
                            ? k.GetString() : $"w_{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}";
                        host.Put(lv, key!, root.TryGetProperty("content", out var ac) ? ac.GetRawText() : "null", 1.0, null, null);
                        Send(new { op = "result", callId, ok = true, data = new { id = key } });
                        break;
                    }
                    case "reorder":
                    {
                        // 兼容旧协议：无实际语义，返回 ok
                        Send(new { op = "result", callId, ok = true, data = new { } });
                        break;
                    }
                    case "record_conflict":
                        host.RecordConflict(
                            root.TryGetProperty("old", out var oc) && oc.ValueKind == JsonValueKind.String ? oc.GetString() : null,
                            root.TryGetProperty("new", out var nc) ? nc.GetRawText() : "null");
                        Send(new { op = "result", callId, ok = true, data = new { } });
                        break;
                    case "record_reflection":
                        host.RecordReflection(
                            root.TryGetProperty("content", out var rc) ? rc.GetRawText() : "null",
                            root.TryGetProperty("sourceIds", out var si) ? si.GetRawText() : null);
                        Send(new { op = "result", callId, ok = true, data = new { } });
                        break;
                    case "query":
                        Send(new { op = "result", callId, ok = true, data = host.Query(
                            root.TryGetProperty("level", out var ql) ? ql.GetString() ?? "l2_dmae" : "l2_dmae",
                            root.TryGetProperty("limit", out var lim) && lim.ValueKind == JsonValueKind.Number ? lim.GetInt32() : 50,
                            root.TryGetProperty("filter", out var flt) ? flt.GetRawText() : null) });
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

    private static string? IdOf(JsonElement root)
    {
        if (root.TryGetProperty("id", out var i) && i.ValueKind == JsonValueKind.String) return i.GetString();
        if (root.TryGetProperty("key", out var k) && k.ValueKind == JsonValueKind.String) return k.GetString();
        return null;
    }
}

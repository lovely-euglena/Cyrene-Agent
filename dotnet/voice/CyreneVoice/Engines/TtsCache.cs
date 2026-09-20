using Microsoft.Data.Sqlite;
using System.Text;
using System.IO;
using System.Security.Cryptography;

namespace CyreneVoice.Engines;

/// <summary>
/// TTS 缓存（F2.4）——移植 src/main/tts/tts-cache.ts 语义：
///   key = sha256(engine + voice + text + speed + volume + 模型参数)
///   命中 → 直接回二进制段；未命中 → 合成后落库。
/// SQLite 单文件（./data/tts-cache/cache.db，HostConfig 派生），
/// LRU 清理由宿主按 maxEntries 配置触发（与 TS 版容量语义一致）。
/// </summary>
internal sealed class TtsCache : IDisposable
{
    private readonly SqliteConnection? _db;
    private readonly long _maxEntries;
    private bool _broken;

    public TtsCache(string dbPath, long maxEntries = 500)
    {
        _maxEntries = maxEntries;
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(dbPath))!);
            _db = new SqliteConnection($"Data Source={dbPath};Cache=Shared");
            _db.Open();
            using var c = _db.CreateCommand();
            c.CommandText = @"CREATE TABLE IF NOT EXISTS tts_cache(
                key TEXT PRIMARY KEY, audio BLOB NOT NULL, format TEXT NOT NULL,
                bytes INTEGER NOT NULL, created_at INTEGER NOT NULL)";
            c.ExecuteNonQuery();
        }
        catch
        {
            _broken = true;   // 缓存失败不阻断合成（降级直传）
        }
    }

    public static string KeyOf(string engine, string voice, string text,
        double? speed, double? volume, string? extra)
    {
        var raw = $"{engine}|{voice}|{text}|{speed ?? 1}|{volume ?? 1}|{extra ?? ""}";
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(raw)));
    }

    public (byte[] audio, string format)? Get(string key)
    {
        if (_broken) return null;
        try
        {
            using var c = _db!.CreateCommand();
            c.CommandText = "SELECT audio, format FROM tts_cache WHERE key = @k";
            var p = c.CreateParameter(); p.ParameterName = "@k"; p.Value = key; c.Parameters.Add(p);
            using var r = c.ExecuteReader();
            if (!r.Read()) return null;
            return (r.GetFieldValue<byte[]>(0), r.GetString(1));
        }
        catch { return null; }
    }

    public void Put(string key, byte[] audio, string format)
    {
        if (_broken) return;
        try
        {
            using var tx = _db!.BeginTransaction();
            using (var c = _db.CreateCommand())
            {
                c.Transaction = tx;
                c.CommandText = @"INSERT OR REPLACE INTO tts_cache(key, audio, format, bytes, created_at)
                                  VALUES(@k, @a, @f, @n, @t)";
                foreach (var (n, v) in new (string, object)[] { ("@k", key), ("@a", audio), ("@f", format) })
                {
                    var p = c.CreateParameter(); p.ParameterName = n; p.Value = v; c.Parameters.Add(p);
                }
                var pn = c.CreateParameter(); pn.ParameterName = "@n"; pn.Value = audio.Length; c.Parameters.Add(pn);
                var pt = c.CreateParameter(); pt.ParameterName = "@t"; pt.Value = DateTimeOffset.UtcNow.ToUnixTimeSeconds(); c.Parameters.Add(pt);
                c.ExecuteNonQuery();
            }
            // LRU：超容量删最旧
            using (var c2 = _db.CreateCommand())
            {
                c2.Transaction = tx;
                c2.CommandText = @"DELETE FROM tts_cache WHERE key IN (
                    SELECT key FROM tts_cache ORDER BY created_at DESC LIMIT -1 OFFSET @max)";
                var p = c2.CreateParameter(); p.ParameterName = "@max"; p.Value = _maxEntries; c2.Parameters.Add(p);
                c2.ExecuteNonQuery();
            }
            tx.Commit();
        }
        catch { /* 缓存写失败忽略 */ }
    }

    public void Dispose() => _db?.Dispose();
}

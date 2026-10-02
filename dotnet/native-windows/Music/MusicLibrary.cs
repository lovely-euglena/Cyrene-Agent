using System.IO;
using Microsoft.Data.Sqlite;

namespace CyreneNative;

/// <summary>
/// 本地音乐曲库（SQLite，窗口与 Agent 共用）：
///   - folders：用户添加的音乐根目录；
///   - tracks：扫描出的曲目（P1 元数据来自文件名/目录，TagLib# 读写为 P2）；
///   - 增量扫描：path + size + mtime 比对；mark-and-sweep 删除已移除文件。
/// 线程模型：所有公开方法内部加锁，连接按调用打开（WPF 线程与工具线程均可）。
/// </summary>
public sealed class MusicLibrary
{
    public sealed record MusicTrack(
        string Path,
        string Folder,
        string Title,
        string Artist,
        string Album,
        string Ext,
        long Size,
        long Mtime);

    public sealed record ScanResult(int Added, int Updated, int Removed, int Total);

    public sealed record FolderEntry(string Path, long TrackCount);

    /// <summary>扫描扩展名白名单（与设计文档一致；mpv 可播放的更广格式由手动打开兜底）。</summary>
    private static readonly HashSet<string> SupportedExts = new(StringComparer.OrdinalIgnoreCase)
    {
        ".mp3", ".flac", ".m4a", ".aac", ".ogg", ".opus", ".wav", ".ape", ".wv", ".wma",
    };

    private readonly string _dbPath;
    private readonly object _lock = new();

    public MusicLibrary(string dbPath)
    {
        _dbPath = dbPath;
        var directory = Path.GetDirectoryName(dbPath);
        if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);
    }

    private SqliteConnection Open()
    {
        var connection = new SqliteConnection($"Data Source={_dbPath}");
        connection.Open();
        using var command = connection.CreateCommand();
        command.CommandText = """
            CREATE TABLE IF NOT EXISTS folders (
                path TEXT PRIMARY KEY,
                added_at TEXT NOT NULL,
                last_scan_at TEXT
            );
            CREATE TABLE IF NOT EXISTS tracks (
                path TEXT PRIMARY KEY,
                folder TEXT NOT NULL,
                title TEXT NOT NULL,
                artist TEXT NOT NULL,
                album TEXT NOT NULL,
                ext TEXT NOT NULL,
                size INTEGER NOT NULL,
                mtime INTEGER NOT NULL,
                seen INTEGER NOT NULL DEFAULT 1,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_tracks_folder ON tracks(folder);
            CREATE INDEX IF NOT EXISTS idx_tracks_title ON tracks(title);
            """;
        command.ExecuteNonQuery();
        return connection;
    }

    public static bool IsSupportedFile(string path) => SupportedExts.Contains(Path.GetExtension(path));

    /// <summary>从文件名/目录推导标题与歌手：`歌手 - 标题` 优先，否则整个文件名当标题。</summary>
    public static (string Title, string Artist) DeriveNames(string filePath)
    {
        var name = Path.GetFileNameWithoutExtension(filePath);
        var separator = name.IndexOf(" - ", StringComparison.Ordinal);
        if (separator > 0)
        {
            return (name[(separator + 3)..].Trim(), name[..separator].Trim());
        }
        return (name.Trim(), "");
    }

    public ScanResult Scan(IReadOnlyList<string> folders, Func<bool> isCancelled, Action<int>? onProgress = null)
    {
        lock (_lock)
        {
            using var connection = Open();
            using var transaction = connection.BeginTransaction();
            var added = 0;
            var updated = 0;
            var seen = 0;

            var validFolders = folders
                .Where(folder => !string.IsNullOrWhiteSpace(folder) && Directory.Exists(folder))
                .Select(Path.GetFullPath)
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToList();

            foreach (var folder in validFolders)
            {
                if (isCancelled()) break;
                SetFolderSeen(connection, transaction, folder, 0);
                foreach (var file in EnumerateAudioFiles(folder))
                {
                    if (isCancelled()) break;
                    var result = UpsertTrack(connection, transaction, folder, file);
                    if (result == 1) added++;
                    else if (result == 2) updated++;
                    seen++;
                    if (seen % 200 == 0) onProgress?.Invoke(seen);
                }
                TouchFolder(connection, transaction, folder);
            }

            // mark-and-sweep：本次未扫到的曲目删除（含被移除的目录）
            int removed;
            using (var sweep = connection.CreateCommand())
            {
                sweep.Transaction = transaction;
                sweep.CommandText = "DELETE FROM tracks WHERE seen = 0";
                removed = sweep.ExecuteNonQuery();
            }

            // folders 表同步：去掉已不在配置里的根目录
            using (var sync = connection.CreateCommand())
            {
                sync.Transaction = transaction;
                var parameters = validFolders.Select((_, index) => $"@f{index}").ToList();
                sync.CommandText = parameters.Count == 0
                    ? "DELETE FROM folders"
                    : $"DELETE FROM folders WHERE path NOT IN ({string.Join(",", parameters)})";
                for (var i = 0; i < validFolders.Count; i++) sync.Parameters.AddWithValue($"@f{i}", validFolders[i]);
                sync.ExecuteNonQuery();
            }

            transaction.Commit();

            int total;
            using (var count = connection.CreateCommand())
            {
                count.CommandText = "SELECT COUNT(*) FROM tracks";
                total = Convert.ToInt32(count.ExecuteScalar());
            }
            return new ScanResult(added, updated, removed, total);
        }
    }

    private static void SetFolderSeen(SqliteConnection connection, SqliteTransaction transaction, string folder, int value)
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "UPDATE tracks SET seen = @seen WHERE folder = @folder";
        command.Parameters.AddWithValue("@seen", value);
        command.Parameters.AddWithValue("@folder", folder);
        command.ExecuteNonQuery();
    }

    private static void TouchFolder(SqliteConnection connection, SqliteTransaction transaction, string folder)
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
            INSERT INTO folders (path, added_at, last_scan_at) VALUES (@path, @now, @now)
            ON CONFLICT(path) DO UPDATE SET last_scan_at = @now
            """;
        command.Parameters.AddWithValue("@path", folder);
        command.Parameters.AddWithValue("@now", DateTime.UtcNow.ToString("o"));
        command.ExecuteNonQuery();
    }

    /// <summary>0=未变，1=新增，2=更新。</summary>
    private static int UpsertTrack(SqliteConnection connection, SqliteTransaction transaction, string folder, string file)
    {
        FileInfo info;
        try
        {
            info = new FileInfo(file);
            if (!info.Exists) return 0;
        }
        catch
        {
            return 0;
        }

        long existingSize = -1;
        long existingMtime = -1;
        using (var lookup = connection.CreateCommand())
        {
            lookup.Transaction = transaction;
            lookup.CommandText = "SELECT size, mtime FROM tracks WHERE path = @path";
            lookup.Parameters.AddWithValue("@path", file);
            using var reader = lookup.ExecuteReader();
            if (reader.Read())
            {
                existingSize = reader.GetInt64(0);
                existingMtime = reader.GetInt64(1);
            }
        }
        if (existingSize == info.Length && existingMtime == info.LastWriteTimeUtc.Ticks)
        {
            using var touch = connection.CreateCommand();
            touch.Transaction = transaction;
            touch.CommandText = "UPDATE tracks SET seen = 1 WHERE path = @path";
            touch.Parameters.AddWithValue("@path", file);
            touch.ExecuteNonQuery();
            return 0;
        }

        var (title, artist) = DeriveNames(file);
        var album = Path.GetFileName(Path.GetDirectoryName(file) ?? "") ?? "";
        using var upsert = connection.CreateCommand();
        upsert.Transaction = transaction;
        upsert.CommandText = """
            INSERT INTO tracks (path, folder, title, artist, album, ext, size, mtime, seen, updated_at)
            VALUES (@path, @folder, @title, @artist, @album, @ext, @size, @mtime, 1, @now)
            ON CONFLICT(path) DO UPDATE SET
                folder = excluded.folder,
                title = excluded.title,
                artist = excluded.artist,
                album = excluded.album,
                ext = excluded.ext,
                size = excluded.size,
                mtime = excluded.mtime,
                seen = 1,
                updated_at = excluded.updated_at
            """;
        upsert.Parameters.AddWithValue("@path", file);
        upsert.Parameters.AddWithValue("@folder", folder);
        upsert.Parameters.AddWithValue("@title", title);
        upsert.Parameters.AddWithValue("@artist", artist);
        upsert.Parameters.AddWithValue("@album", album);
        upsert.Parameters.AddWithValue("@ext", Path.GetExtension(file).ToLowerInvariant());
        upsert.Parameters.AddWithValue("@size", info.Length);
        upsert.Parameters.AddWithValue("@mtime", info.LastWriteTimeUtc.Ticks);
        upsert.Parameters.AddWithValue("@now", DateTime.UtcNow.ToString("o"));
        upsert.ExecuteNonQuery();
        return existingSize < 0 ? 1 : 2;
    }

    private static IEnumerable<string> EnumerateAudioFiles(string root)
    {
        var pending = new Stack<string>();
        pending.Push(root);
        while (pending.Count > 0)
        {
            var current = pending.Pop();
            string[] entries;
            try
            {
                entries = Directory.GetFileSystemEntries(current);
            }
            catch
            {
                continue;
            }
            foreach (var entry in entries)
            {
                var name = Path.GetFileName(entry);
                if (name.StartsWith('.')) continue;
                // 注意：Directory/File.Exists 对正常路径不抛异常；yield 不能放在 try/catch 里
                if (Directory.Exists(entry))
                {
                    pending.Push(entry);
                }
                else if (File.Exists(entry) && IsSupportedFile(entry))
                {
                    yield return entry;
                }
            }
        }
    }

    public List<MusicTrack> Query(string? search, string? folder, int limit = 300)
    {
        lock (_lock)
        {
            using var connection = Open();
            using var command = connection.CreateCommand();
            var conditions = new List<string>();
            if (!string.IsNullOrWhiteSpace(search))
            {
                conditions.Add("(title LIKE @q ESCAPE '\\' OR artist LIKE @q ESCAPE '\\' OR album LIKE @q ESCAPE '\\')");
                var escaped = search.Trim()
                    .Replace("\\", "\\\\")
                    .Replace("%", "\\%")
                    .Replace("_", "\\_");
                command.Parameters.AddWithValue("@q", $"%{escaped}%");
            }
            if (!string.IsNullOrWhiteSpace(folder))
            {
                conditions.Add("folder = @folder");
                command.Parameters.AddWithValue("@folder", folder);
            }
            var where = conditions.Count > 0 ? $"WHERE {string.Join(" AND ", conditions)}" : "";
            command.CommandText = $"SELECT path, folder, title, artist, album, ext, size, mtime FROM tracks {where} ORDER BY artist, title LIMIT @limit";
            command.Parameters.AddWithValue("@limit", Math.Clamp(limit, 1, 2000));
            using var reader = command.ExecuteReader();
            var result = new List<MusicTrack>();
            while (reader.Read())
            {
                result.Add(new MusicTrack(
                    reader.GetString(0),
                    reader.GetString(1),
                    reader.GetString(2),
                    reader.GetString(3),
                    reader.GetString(4),
                    reader.GetString(5),
                    reader.GetInt64(6),
                    reader.GetInt64(7)));
            }
            return result;
        }
    }

    public MusicTrack? GetTrack(string path)
    {
        lock (_lock)
        {
            using var connection = Open();
            using var command = connection.CreateCommand();
            command.CommandText = "SELECT path, folder, title, artist, album, ext, size, mtime FROM tracks WHERE path = @path";
            command.Parameters.AddWithValue("@path", path);
            using var reader = command.ExecuteReader();
            if (!reader.Read()) return null;
            return new MusicTrack(
                reader.GetString(0),
                reader.GetString(1),
                reader.GetString(2),
                reader.GetString(3),
                reader.GetString(4),
                reader.GetString(5),
                reader.GetInt64(6),
                reader.GetInt64(7));
        }
    }

    public List<FolderEntry> ListFolders()
    {
        lock (_lock)
        {
            using var connection = Open();
            using var command = connection.CreateCommand();
            command.CommandText = """
                SELECT f.path, COUNT(t.path) FROM folders f
                LEFT JOIN tracks t ON t.folder = f.path
                GROUP BY f.path ORDER BY f.added_at
                """;
            using var reader = command.ExecuteReader();
            var result = new List<FolderEntry>();
            while (reader.Read()) result.Add(new FolderEntry(reader.GetString(0), reader.GetInt64(1)));
            return result;
        }
    }

    public int Count()
    {
        lock (_lock)
        {
            using var connection = Open();
            using var command = connection.CreateCommand();
            command.CommandText = "SELECT COUNT(*) FROM tracks";
            return Convert.ToInt32(command.ExecuteScalar());
        }
    }
}

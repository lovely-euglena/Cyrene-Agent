using System.Text.Json;
using CyreneNative.Sync;
using Microsoft.Data.Sqlite;

namespace CyreneCloud.Storage;

/// <summary>
/// append-only 事件库（SQLite WAL，2G 预算）。
///
/// - 持久性：WAL + synchronous=FULL——push 返回 200 的事件断电后不丢（事件库语义优先于写吞吐）；
/// - 幂等：event_id 唯一索引，首见生效（重复只计数）；
/// - 排序：客户端收敛序 = (lamport, deviceId, seq)（协议 v0）；服务端游标 = 插入序 id；
/// - 链校验（v0 过渡策略，Q3 内容哈希重算待定稿）：
///   * per-(sessionId, deviceId) 链接：hash 为「已上链」标记；
///   * 已上链事件：存在链尾（该对上最近已上链事件）⇒ prevHash 必须等于链尾 hash；
///     无链尾 ⇒ prevHash 必须缺省（链首）；
///   * 未上链事件（无 hash）：prevHash 必须缺省；允许与已上链事件混用（过渡期）；
///   * 同 (sessionId, deviceId) 的 seq 必须严格递增（重复 eventId 除外）；
/// - 原子性：整批校验 + 插入在同一事务；任一错误整批回滚（fail-closed）。
/// </summary>
public sealed class EventStore
{
    /// <summary>链链接不符 / 半链（有 prevHash 无 hash / prevHash 不等于链尾）。</summary>
    public const string ErrorChain = "E_SYNC_CHAIN";

    /// <summary>同 (sessionId, deviceId) 的 seq 非严格递增。</summary>
    public const string ErrorSeq = "E_SYNC_SEQ";

    private const string EventColumns =
        "event_id, session_id, type, lamport, device_id, seq, ts, payload, prev_hash, hash, id";

    private readonly string _connectionString;
    private readonly SemaphoreSlim _writeLock = new(1, 1);

    public EventStore(string dbPath)
    {
        var fullPath = Path.GetFullPath(dbPath);
        var dir = Path.GetDirectoryName(fullPath);
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
        _connectionString = new SqliteConnectionStringBuilder { DataSource = fullPath, Pooling = true }.ToString();
        Initialize();
        StorageHardening.TryHarden(fullPath);
    }

    private SqliteConnection Open()
    {
        var connection = new SqliteConnection(_connectionString);
        connection.Open();
        using var pragma = connection.CreateCommand();
        pragma.CommandText = "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;";
        pragma.ExecuteNonQuery();
        return connection;
    }

    private void Initialize()
    {
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = """
            CREATE TABLE IF NOT EXISTS events (
              id           INTEGER PRIMARY KEY AUTOINCREMENT,
              event_id     TEXT NOT NULL UNIQUE,
              session_id   TEXT NOT NULL,
              type         TEXT NOT NULL,
              lamport      INTEGER NOT NULL,
              device_id    TEXT NOT NULL,
              seq          INTEGER NOT NULL,
              ts           TEXT NOT NULL,
              payload      TEXT NOT NULL,
              prev_hash    TEXT,
              hash         TEXT,
              received_at  TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_events_order ON events(session_id, lamport, device_id, seq);
            CREATE INDEX IF NOT EXISTS idx_events_chain ON events(session_id, device_id, seq);
            """;
        command.ExecuteNonQuery();
    }

    public long CurrentCursor()
    {
        using var connection = Open();
        return CurrentCursor(connection);
    }

    private static long CurrentCursor(SqliteConnection connection)
    {
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT COALESCE(MAX(id), 0) FROM events";
        return (long)command.ExecuteScalar()!;
    }

    /// <summary>
    /// 整批校验 + 幂等插入（原子；写锁异步/可取消等待）。链/序号错误进 Errors（此时本批未写入任何事件）。
    /// lineByEventId：eventId → 输入 JSONL 0 基物理行号（与 SyncProtocolV0 错误索引同一空间；缺省回退排序后下标）。
    /// </summary>
    public async Task<PushOutcome> PushBatchAsync(
        IReadOnlyList<SyncEventV0> events,
        IReadOnlyDictionary<string, int>? lineByEventId = null,
        CancellationToken cancellationToken = default)
    {
        await _writeLock.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            using var connection = Open();
            using var transaction = connection.BeginTransaction();
            var accepted = 0;
            var duplicates = 0;
            var hasError = false;
            var errors = new List<SyncReadError>();
            for (var index = 0; index < events.Count; index++)
            {
                // 批内逐事件响应取消：中断即抛出 → 事务 Dispose 回滚；append-only 下断开后重复推送幂等无害
                cancellationToken.ThrowIfCancellationRequested();
                var syncEvent = events[index];
                if (EventIdExists(connection, transaction, syncEvent.EventId))
                {
                    duplicates++;
                    continue;
                }
                var error = CheckChain(connection, transaction, syncEvent);
                if (error is not null)
                {
                    var errorIndex = lineByEventId is not null && lineByEventId.TryGetValue(syncEvent.EventId, out var sourceLine)
                        ? sourceLine
                        : index;
                    errors.Add(new SyncReadError(errorIndex, error));
                    hasError = true;
                    continue;
                }
                if (!hasError)
                {
                    // fail-fast：首个错误后不再写库（继续校验只为多报错误；整批仍回滚）
                    Insert(connection, transaction, syncEvent);
                    accepted++;
                }
            }
            if (errors.Count > 0)
            {
                transaction.Rollback();
                return new PushOutcome(0, 0, CurrentCursor(connection), errors);
            }
            transaction.Commit();
            return new PushOutcome(accepted, duplicates, CurrentCursor(connection), errors);
        }
        finally
        {
            _writeLock.Release();
        }
    }

    private static bool EventIdExists(SqliteConnection connection, SqliteTransaction transaction, string eventId)
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "SELECT 1 FROM events WHERE event_id=@id LIMIT 1";
        command.Parameters.AddWithValue("@id", eventId);
        return command.ExecuteScalar() is not null;
    }

    /// <summary>链与序号校验（返回错误码；null = 通过）。</summary>
    private static string? CheckChain(SqliteConnection connection, SqliteTransaction transaction, SyncEventV0 syncEvent)
    {
        if (syncEvent.Hash is null && syncEvent.PrevHash is not null) return ErrorChain;

        long? tailSeq = null;
        using (var command = connection.CreateCommand())
        {
            command.Transaction = transaction;
            command.CommandText = "SELECT seq FROM events WHERE session_id=@s AND device_id=@d ORDER BY seq DESC LIMIT 1";
            command.Parameters.AddWithValue("@s", syncEvent.SessionId);
            command.Parameters.AddWithValue("@d", syncEvent.DeviceId);
            var result = command.ExecuteScalar();
            if (result is not null) tailSeq = (long)result;
        }
        if (tailSeq is not null && syncEvent.Seq <= tailSeq) return ErrorSeq;

        if (syncEvent.Hash is not null)
        {
            string? lastChainedHash = null;
            using (var command = connection.CreateCommand())
            {
                command.Transaction = transaction;
                command.CommandText =
                    "SELECT hash FROM events WHERE session_id=@s AND device_id=@d AND hash IS NOT NULL ORDER BY seq DESC LIMIT 1";
                command.Parameters.AddWithValue("@s", syncEvent.SessionId);
                command.Parameters.AddWithValue("@d", syncEvent.DeviceId);
                var result = command.ExecuteScalar();
                if (result is not null) lastChainedHash = (string)result;
            }
            if (lastChainedHash is null)
            {
                if (syncEvent.PrevHash is not null) return ErrorChain;
            }
            else if (syncEvent.PrevHash != lastChainedHash)
            {
                return ErrorChain;
            }
        }
        return null;
    }

    private static void Insert(SqliteConnection connection, SqliteTransaction transaction, SyncEventV0 syncEvent)
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
            INSERT INTO events (event_id, session_id, type, lamport, device_id, seq, ts, payload, prev_hash, hash, received_at)
            VALUES (@eventId, @sessionId, @type, @lamport, @deviceId, @seq, @ts, @payload, @prevHash, @hash, @receivedAt)
            """;
        command.Parameters.AddWithValue("@eventId", syncEvent.EventId);
        command.Parameters.AddWithValue("@sessionId", syncEvent.SessionId);
        command.Parameters.AddWithValue("@type", syncEvent.Type);
        command.Parameters.AddWithValue("@lamport", syncEvent.Lamport);
        command.Parameters.AddWithValue("@deviceId", syncEvent.DeviceId);
        command.Parameters.AddWithValue("@seq", syncEvent.Seq);
        command.Parameters.AddWithValue("@ts", syncEvent.Ts);
        command.Parameters.AddWithValue("@payload", syncEvent.Payload.GetRawText());
        command.Parameters.AddWithValue("@prevHash", (object?)syncEvent.PrevHash ?? DBNull.Value);
        command.Parameters.AddWithValue("@hash", (object?)syncEvent.Hash ?? DBNull.Value);
        command.Parameters.AddWithValue("@receivedAt", DateTimeOffset.UtcNow.ToString("O"));
        command.ExecuteNonQuery();
    }

    /// <summary>插入序增量读取（异步形态 + 逐行响应取消：客户端断开后不再继续整页读取）。</summary>
    public async Task<FetchOutcome> FetchAsync(long since, int limit, string? sessionId, CancellationToken cancellationToken = default)
    {
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = sessionId is null
            ? $"SELECT {EventColumns} FROM events WHERE id>@since ORDER BY id LIMIT @n"
            : $"SELECT {EventColumns} FROM events WHERE id>@since AND session_id=@session ORDER BY id LIMIT @n";
        command.Parameters.AddWithValue("@since", since);
        command.Parameters.AddWithValue("@n", limit + 1);
        if (sessionId is not null) command.Parameters.AddWithValue("@session", sessionId);

        var events = new List<SyncEventV0>();
        var cursor = since;
        var hasMore = false;
        await using var reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (events.Count == limit)
            {
                hasMore = true;
                break;
            }
            events.Add(Map(reader));
            cursor = reader.GetInt64(10);
        }
        return new FetchOutcome(events, cursor, hasMore);
    }

    /// <summary>全量流（clone；插入序，以 maxId 为上界固定快照——保证流内容 ⊆ 声明的 X-Sync-Cursor）。</summary>
    public IEnumerable<SyncEventV0> StreamAll(string? sessionId, long maxId)
    {
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = sessionId is null
            ? $"SELECT {EventColumns} FROM events WHERE id<=@max ORDER BY id"
            : $"SELECT {EventColumns} FROM events WHERE id<=@max AND session_id=@session ORDER BY id";
        command.Parameters.AddWithValue("@max", maxId);
        if (sessionId is not null) command.Parameters.AddWithValue("@session", sessionId);
        using var reader = command.ExecuteReader();
        while (reader.Read()) yield return Map(reader);
    }

    /// <summary>按 EventColumns 列序映射（改 SELECT 列必须同步此索引）。</summary>
    private static SyncEventV0 Map(SqliteDataReader reader) => new()
    {
        EventId = reader.GetString(0),
        SessionId = reader.GetString(1),
        Type = reader.GetString(2),
        Lamport = reader.GetInt64(3),
        DeviceId = reader.GetString(4),
        Seq = reader.GetInt64(5),
        Ts = reader.GetString(6),
        Payload = ParsePayload(reader.GetString(7)),
        PrevHash = reader.IsDBNull(8) ? null : reader.GetString(8),
        Hash = reader.IsDBNull(9) ? null : reader.GetString(9),
    };

    /// <summary>JsonDocument 用后即弃、Clone() 脱离文档：避免不可释放文档在 clone 全量流下累积堆压力。</summary>
    private static JsonElement ParsePayload(string json)
    {
        using var document = JsonDocument.Parse(json);
        return document.RootElement.Clone();
    }
}

/// <summary>push 结果（Errors 非空 = 整批回滚，Accepted/Duplicates 无意义）。</summary>
public sealed record PushOutcome(int Accepted, int Duplicates, long Cursor, List<SyncReadError> Errors);

/// <summary>fetch 结果（Cursor 为本页最后一条的插入游标；无新事件时原样返回 since）。</summary>
public sealed record FetchOutcome(List<SyncEventV0> Events, long Cursor, bool HasMore);

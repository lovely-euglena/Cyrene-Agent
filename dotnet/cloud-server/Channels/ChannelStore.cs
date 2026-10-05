using System.Security.Cryptography;
using System.Text;
using CyreneCloud.Storage;
using Microsoft.Data.Sqlite;

namespace CyreneCloud.Channels;

/// <summary>
/// 渠道运行数据库（channels.db，独立于 events.db；§2.4 决策 R2）。
///
/// 承载 credentials / recipients / ownership / seen_messages / delivery_receipts；
/// 同目录、WAL、0600/0700（best-effort，与 events.db 同姿态）。
/// 归属权状态机属阶段 4（本批只提供表与读写原语）。
/// </summary>
public sealed class ChannelStore
{
    public const string StatusDelivered = "delivered";
    public const string StatusFailed = "failed";

    private readonly string _connectionString;
    private readonly ChannelCredentialProtector? _protector;

    public ChannelStore(string dbPath, ChannelCredentialProtector? protector = null)
    {
        _protector = protector;
        var fullPath = Path.GetFullPath(dbPath);
        var dir = Path.GetDirectoryName(fullPath);
        if (!string.IsNullOrEmpty(dir))
        {
            Directory.CreateDirectory(dir);
            StorageHardening.TryHardenDirectory(fullPath); // 目录 0700：须先于首次打开 DB
        }
        _connectionString = new SqliteConnectionStringBuilder { DataSource = fullPath, Pooling = true }.ToString();
        Initialize();
        StorageHardening.TryHardenFiles(fullPath); // DB/-wal/-shm 0600：Initialize 后才存在
    }

    private SqliteConnection Open()
    {
        var connection = new SqliteConnection(_connectionString);
        connection.Open();
        using var pragma = connection.CreateCommand();
        pragma.CommandText = "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;";
        pragma.ExecuteNonQuery();
        return connection;
    }

    private void Initialize()
    {
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = """
            CREATE TABLE IF NOT EXISTS channel_credentials (
              channel      TEXT PRIMARY KEY,
              value        TEXT NOT NULL,
              protection   TEXT NOT NULL,
              updated_at   TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS channel_recipients (
              channel      TEXT NOT NULL,
              target_id    TEXT NOT NULL,
              thread_id    TEXT,
              last_at      TEXT NOT NULL,
              PRIMARY KEY (channel, target_id)
            );
            CREATE TABLE IF NOT EXISTS channel_ownership (
              channel           TEXT PRIMARY KEY,
              owner             TEXT NOT NULL,
              holder            TEXT,
              lease_expires_at  TEXT,
              updated_at        TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS channel_seen_messages (
              channel     TEXT NOT NULL,
              dedupe_key  TEXT NOT NULL,
              seen_at     TEXT NOT NULL,
              PRIMARY KEY (channel, dedupe_key)
            );
            CREATE INDEX IF NOT EXISTS idx_channel_seen_time ON channel_seen_messages(seen_at);
            CREATE TABLE IF NOT EXISTS channel_delivery_receipts (
              id          INTEGER PRIMARY KEY AUTOINCREMENT,
              channel     TEXT NOT NULL,
              session_id  TEXT NOT NULL,
              event_id    TEXT NOT NULL,
              status      TEXT NOT NULL,
              error_code  TEXT,
              created_at  TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_channel_receipts ON channel_delivery_receipts(channel, id);
            """;
        command.ExecuteNonQuery();
    }

    // ── seen_messages（平台重投去重；TTL 30 天由托管服务清理）──────────────────

    /// <summary>标记入站消息已见；返回 true = 首次（应处理），false = 重复（跳过）。</summary>
    public async Task<bool> MarkSeenAsync(string channel, string dedupeKey, CancellationToken cancellationToken = default)
    {
        await using var connection = Open();
        await using var command = connection.CreateCommand();
        command.CommandText = """
            INSERT OR IGNORE INTO channel_seen_messages (channel, dedupe_key, seen_at)
            VALUES (@channel, @key, @seenAt)
            """;
        command.Parameters.AddWithValue("@channel", channel);
        command.Parameters.AddWithValue("@key", dedupeKey);
        command.Parameters.AddWithValue("@seenAt", DateTimeOffset.UtcNow.ToString("O"));
        return await command.ExecuteNonQueryAsync(cancellationToken) > 0;
    }

    /// <summary>清理超过 TTL 的去重记录（§3.5：seen_messages 按 TTL 30 天清理）。</summary>
    public async Task<int> CleanupSeenAsync(TimeSpan ttl, CancellationToken cancellationToken = default)
    {
        var cutoff = DateTimeOffset.UtcNow - ttl;
        await using var connection = Open();
        await using var command = connection.CreateCommand();
        command.CommandText = "DELETE FROM channel_seen_messages WHERE seen_at < @cutoff";
        command.Parameters.AddWithValue("@cutoff", cutoff.ToString("O"));
        return await command.ExecuteNonQueryAsync(cancellationToken);
    }

    // ── recipients（主动消息收件人；每次入站更新，镜像桌面语义）──────────────

    public async Task RememberRecipientAsync(
        string channel, string targetId, string? threadId, CancellationToken cancellationToken = default)
    {
        await using var connection = Open();
        await using var command = connection.CreateCommand();
        command.CommandText = """
            INSERT INTO channel_recipients (channel, target_id, thread_id, last_at)
            VALUES (@channel, @target, @thread, @lastAt)
            ON CONFLICT(channel, target_id) DO UPDATE SET thread_id=@thread, last_at=@lastAt
            """;
        command.Parameters.AddWithValue("@channel", channel);
        command.Parameters.AddWithValue("@target", targetId);
        command.Parameters.AddWithValue("@thread", (object?)threadId ?? DBNull.Value);
        command.Parameters.AddWithValue("@lastAt", DateTimeOffset.UtcNow.ToString("O"));
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    /// <summary>最近一次入站联系人（主动消息投递目标）。</summary>
    public async Task<RecipientRecord?> GetRecentRecipientAsync(string channel, CancellationToken cancellationToken = default)
    {
        await using var connection = Open();
        await using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT channel, target_id, thread_id, last_at FROM channel_recipients
            WHERE channel=@channel ORDER BY last_at DESC LIMIT 1
            """;
        command.Parameters.AddWithValue("@channel", channel);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        if (!await reader.ReadAsync(cancellationToken)) return null;
        return new RecipientRecord(
            reader.GetString(0),
            reader.GetString(1),
            reader.IsDBNull(2) ? null : reader.GetString(2),
            reader.GetString(3));
    }

    // ── delivery_receipts（投递回执；失败不自动重发，人工可见）──────────────

    public async Task RecordReceiptAsync(
        string channel, string sessionId, string eventId, string status, string? errorCode,
        CancellationToken cancellationToken = default)
    {
        await using var connection = Open();
        await using var command = connection.CreateCommand();
        command.CommandText = """
            INSERT INTO channel_delivery_receipts (channel, session_id, event_id, status, error_code, created_at)
            VALUES (@channel, @session, @event, @status, @error, @createdAt)
            """;
        command.Parameters.AddWithValue("@channel", channel);
        command.Parameters.AddWithValue("@session", sessionId);
        command.Parameters.AddWithValue("@event", eventId);
        command.Parameters.AddWithValue("@status", status);
        command.Parameters.AddWithValue("@error", (object?)errorCode ?? DBNull.Value);
        command.Parameters.AddWithValue("@createdAt", DateTimeOffset.UtcNow.ToString("O"));
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    public async Task<List<ReceiptRecord>> ListReceiptsAsync(
        string channel, int limit = 20, CancellationToken cancellationToken = default)
    {
        await using var connection = Open();
        await using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT channel, session_id, event_id, status, error_code, created_at
            FROM channel_delivery_receipts WHERE channel=@channel ORDER BY id DESC LIMIT @limit
            """;
        command.Parameters.AddWithValue("@channel", channel);
        command.Parameters.AddWithValue("@limit", Math.Clamp(limit, 1, 500));
        var receipts = new List<ReceiptRecord>();
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken))
        {
            receipts.Add(new ReceiptRecord(
                reader.GetString(0),
                reader.GetString(1),
                reader.GetString(2),
                reader.GetString(3),
                reader.IsDBNull(4) ? null : reader.GetString(4),
                reader.GetString(5)));
        }
        return receipts;
    }

    // ── credentials（服务端自持；AES-GCM 或 0600 明文降级，§2.3）────────────

    /// <summary>保存凭据（整体加密；无 CLOUD_TOKEN 时 0600 明文并标注 protection=plain）。</summary>
    public async Task SaveCredentialAsync(string channel, string value, CancellationToken cancellationToken = default)
    {
        var stored = _protector is null ? value : _protector.Protect(value);
        var protection = _protector?.Scheme ?? ChannelCredentialProtector.PlainScheme;
        await using var connection = Open();
        await using var command = connection.CreateCommand();
        command.CommandText = """
            INSERT INTO channel_credentials (channel, value, protection, updated_at)
            VALUES (@channel, @value, @protection, @updatedAt)
            ON CONFLICT(channel) DO UPDATE SET value=@value, protection=@protection, updated_at=@updatedAt
            """;
        command.Parameters.AddWithValue("@channel", channel);
        command.Parameters.AddWithValue("@value", stored);
        command.Parameters.AddWithValue("@protection", protection);
        command.Parameters.AddWithValue("@updatedAt", DateTimeOffset.UtcNow.ToString("O"));
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    /// <summary>读取凭据；密文但保护器缺失（CLOUD_TOKEN 被移除）时返回 null。</summary>
    public async Task<string?> LoadCredentialAsync(string channel, CancellationToken cancellationToken = default)
    {
        var row = await LoadCredentialRowAsync(channel, cancellationToken);
        if (row is null) return null;
        if (row.Value.Protection == ChannelCredentialProtector.PlainScheme) return row.Value.Value;
        return _protector?.Unprotect(row.Value.Value);
    }

    /// <summary>凭据保护姿态（"aes-gcm" / "plain"；状态端点标注用）。</summary>
    public async Task<string?> CredentialProtectionAsync(string channel, CancellationToken cancellationToken = default)
    {
        var row = await LoadCredentialRowAsync(channel, cancellationToken);
        return row?.Protection;
    }

    public async Task DeleteCredentialAsync(string channel, CancellationToken cancellationToken = default)
    {
        await using var connection = Open();
        await using var command = connection.CreateCommand();
        command.CommandText = "DELETE FROM channel_credentials WHERE channel=@channel";
        command.Parameters.AddWithValue("@channel", channel);
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    private async Task<(string Value, string Protection)?> LoadCredentialRowAsync(
        string channel, CancellationToken cancellationToken)
    {
        await using var connection = Open();
        await using var command = connection.CreateCommand();
        command.CommandText = "SELECT value, protection FROM channel_credentials WHERE channel=@channel";
        command.Parameters.AddWithValue("@channel", channel);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        if (!await reader.ReadAsync(cancellationToken)) return null;
        return (reader.GetString(0), reader.GetString(1));
    }

    // ── ownership（阶段 4 状态机使用的读写原语；本批不实现判定逻辑）──────────

    public async Task UpsertOwnershipAsync(
        string channel, string owner, string? holder, DateTimeOffset? leaseExpiresAt,
        CancellationToken cancellationToken = default)
    {
        await using var connection = Open();
        await using var command = connection.CreateCommand();
        command.CommandText = """
            INSERT INTO channel_ownership (channel, owner, holder, lease_expires_at, updated_at)
            VALUES (@channel, @owner, @holder, @lease, @updatedAt)
            ON CONFLICT(channel) DO UPDATE SET
              owner=@owner, holder=@holder, lease_expires_at=@lease, updated_at=@updatedAt
            """;
        command.Parameters.AddWithValue("@channel", channel);
        command.Parameters.AddWithValue("@owner", owner);
        command.Parameters.AddWithValue("@holder", (object?)holder ?? DBNull.Value);
        command.Parameters.AddWithValue("@lease", leaseExpiresAt is null ? DBNull.Value : leaseExpiresAt.Value.ToString("O"));
        command.Parameters.AddWithValue("@updatedAt", DateTimeOffset.UtcNow.ToString("O"));
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    public async Task<List<OwnershipRecord>> ListOwnershipAsync(CancellationToken cancellationToken = default)
    {
        await using var connection = Open();
        await using var command = connection.CreateCommand();
        command.CommandText = "SELECT channel, owner, holder, lease_expires_at, updated_at FROM channel_ownership ORDER BY channel";
        var records = new List<OwnershipRecord>();
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken))
        {
            records.Add(new OwnershipRecord(
                reader.GetString(0),
                reader.GetString(1),
                reader.IsDBNull(2) ? null : reader.GetString(2),
                reader.IsDBNull(3) ? null : reader.GetString(3),
                reader.GetString(4)));
        }
        return records;
    }
}

public sealed record RecipientRecord(string Channel, string TargetId, string? ThreadId, string LastAt);

public sealed record ReceiptRecord(
    string Channel, string SessionId, string EventId, string Status, string? ErrorCode, string CreatedAt);

public sealed record OwnershipRecord(
    string Channel, string Owner, string? Holder, string? LeaseExpiresAt, string UpdatedAt);

/// <summary>
/// 渠道凭据保护器（§2.3）：AES-GCM，密钥 = SHA256(CLOUD_TOKEN + ":" + 数据目录机器指纹)。
/// 无 CLOUD_TOKEN 时工厂返回 null（调用方降级 0600 明文并在状态标注 plain）。
/// </summary>
public sealed class ChannelCredentialProtector
{
    public const string AesGcmScheme = "aes-gcm";
    public const string PlainScheme = "plain";

    private readonly byte[] _key;

    private ChannelCredentialProtector(byte[] key)
    {
        _key = key;
    }

    public string Scheme => AesGcmScheme;

    public static ChannelCredentialProtector? Create(string? masterToken, string dataDir)
    {
        if (string.IsNullOrEmpty(masterToken)) return null;
        var fingerprint = $"{Environment.MachineName}|{Path.GetFullPath(dataDir)}";
        var key = SHA256.HashData(Encoding.UTF8.GetBytes($"{masterToken}:{fingerprint}"));
        return new ChannelCredentialProtector(key);
    }

    /// <summary>格式：aes-gcm:&lt;b64 nonce&gt;:&lt;b64 cipher&gt;:&lt;b64 tag&gt;。</summary>
    public string Protect(string plain)
    {
        var nonce = RandomNumberGenerator.GetBytes(12);
        var plainBytes = Encoding.UTF8.GetBytes(plain);
        var cipher = new byte[plainBytes.Length];
        var tag = new byte[16];
        using var aes = new AesGcm(_key, tag.Length);
        aes.Encrypt(nonce, plainBytes, cipher, tag);
        return $"{AesGcmScheme}:{Convert.ToBase64String(nonce)}:{Convert.ToBase64String(cipher)}:{Convert.ToBase64String(tag)}";
    }

    public string? Unprotect(string stored)
    {
        var parts = stored.Split(':');
        if (parts.Length != 4 || parts[0] != AesGcmScheme) return null;
        try
        {
            var nonce = Convert.FromBase64String(parts[1]);
            var cipher = Convert.FromBase64String(parts[2]);
            var tag = Convert.FromBase64String(parts[3]);
            var plain = new byte[cipher.Length];
            using var aes = new AesGcm(_key, tag.Length);
            aes.Decrypt(nonce, cipher, tag, plain);
            return Encoding.UTF8.GetString(plain);
        }
        catch (CryptographicException)
        {
            return null;
        }
        catch (FormatException)
        {
            return null;
        }
    }
}

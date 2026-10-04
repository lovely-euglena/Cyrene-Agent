using System.Security.Cryptography;
using System.Text;
using CyreneCloud.Storage;
using Microsoft.Data.Sqlite;

namespace CyreneCloud.Auth;

/// <summary>
/// 设备与配对码存储（IKJK2K）。与 EventStore 共用同一 SQLite 文件（WAL，各自连接）。
///
/// - device token = 32 字节随机（base64url，前缀 cyn_）；**库内只存 SHA-256 哈希**，签发后仅回显一次；
/// - 配对码 = 8 位易读字母表（无 0/O/1/I/L），一次性 + TTL（默认 5 分钟），库内只存哈希；
/// - 撤销即时生效（每请求查库）；轮换 = 原子替换哈希（旧 token 立即失效）；
/// - 本类不写日志；调用方也不得把 token / 配对码打进日志（冒烟含脱敏断言）。
/// </summary>
public sealed class AuthStore
{
    private const string CodeAlphabet = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
    private const int CodeLength = 8;

    private readonly string _connectionString;
    private readonly string _dbPath;
    private readonly TimeSpan _pairTtl;

    public AuthStore(string dbPath, TimeSpan pairTtl)
    {
        _dbPath = Path.GetFullPath(dbPath);
        var dir = Path.GetDirectoryName(_dbPath);
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
        _connectionString = new SqliteConnectionStringBuilder { DataSource = _dbPath, Pooling = true }.ToString();
        _pairTtl = pairTtl;
        Initialize();
        StorageHardening.TryHarden(_dbPath);
    }

    /// <summary>设备信息（token 永不外泄；Revoked = 撤销标记，撤销即时生效）。</summary>
    public sealed record DeviceInfo(string DeviceId, string Name, string CreatedAt, string? LastSeenAt, bool Revoked);

    /// <summary>兑换结果：Ok=false 时 Error=E_PAIR_CODE（无效/已用/过期统一不区分，防枚举）。</summary>
    public sealed record RedeemResult(bool Ok, string? Error, string? DeviceId = null, string? Name = null, string? Token = null);

    /// <summary>签发一次性配对码（返回显示格式 XXXX-XXXX；库内只存规范化后的哈希）。</summary>
    public (string Code, string ExpiresAt) CreatePairCode(string createdBy)
    {
        var code = RandomCode();
        var now = DateTimeOffset.UtcNow;
        var expires = now.Add(_pairTtl);
        using var connection = Open();
        using (var prune = connection.CreateCommand())
        {
            prune.CommandText = "DELETE FROM pairing_codes WHERE expires_at < @cutoff";
            prune.Parameters.AddWithValue("@cutoff", now.AddHours(-1).ToString("O"));
            prune.ExecuteNonQuery();
        }

        using var command = connection.CreateCommand();
        command.CommandText = """
            INSERT INTO pairing_codes (code_hash, created_by, created_at, expires_at)
            VALUES (@hash, @by, @now, @expires)
            """;
        command.Parameters.AddWithValue("@hash", Sha256Hex(code));
        command.Parameters.AddWithValue("@by", createdBy);
        command.Parameters.AddWithValue("@now", now.ToString("O"));
        command.Parameters.AddWithValue("@expires", expires.ToString("O"));
        command.ExecuteNonQuery();
        return (FormatCode(code), expires.ToString("O"));
    }

    /// <summary>兑换配对码 → 签发 device token（原子：一次性以 UPDATE ... WHERE redeemed_at IS NULL 保证）。</summary>
    public RedeemResult Redeem(string? rawCode, string? deviceName)
    {
        var code = NormalizeCode(rawCode);
        if (code is null) return new RedeemResult(false, "E_PAIR_CODE");
        var name = string.IsNullOrWhiteSpace(deviceName) ? "未命名设备" : deviceName.Trim();
        if (name.Length > 64) name = name[..64];

        var now = DateTimeOffset.UtcNow;
        var deviceId = "dev_" + RandomHex(6);
        var token = "cyn_" + Base64Url(RandomNumberGenerator.GetBytes(32));

        using var connection = Open();
        using var transaction = connection.BeginTransaction();
        using (var redeem = connection.CreateCommand())
        {
            redeem.Transaction = transaction;
            redeem.CommandText = """
                UPDATE pairing_codes SET redeemed_at=@now, redeemed_by=@device
                WHERE code_hash=@hash AND redeemed_at IS NULL AND expires_at > @now
                """;
            redeem.Parameters.AddWithValue("@now", now.ToString("O"));
            redeem.Parameters.AddWithValue("@device", deviceId);
            redeem.Parameters.AddWithValue("@hash", Sha256Hex(code));
            if (redeem.ExecuteNonQuery() == 0)
            {
                transaction.Rollback();
                return new RedeemResult(false, "E_PAIR_CODE");
            }
        }

        using (var insert = connection.CreateCommand())
        {
            insert.Transaction = transaction;
            insert.CommandText = """
                INSERT INTO devices (device_id, name, token_hash, created_at)
                VALUES (@id, @name, @hash, @now)
                """;
            insert.Parameters.AddWithValue("@id", deviceId);
            insert.Parameters.AddWithValue("@name", name);
            insert.Parameters.AddWithValue("@hash", Sha256Hex(token));
            insert.Parameters.AddWithValue("@now", now.ToString("O"));
            insert.ExecuteNonQuery();
        }

        transaction.Commit();
        return new RedeemResult(true, null, deviceId, name, token);
    }

    /// <summary>按 token 鉴权（撤销即 401；命中节流更新 last_seen，避免与 push 抢写锁）。</summary>
    public bool TryAuthenticate(string token, out string deviceId, out string name)
    {
        deviceId = "";
        name = "";
        if (string.IsNullOrEmpty(token)) return false;

        var now = DateTimeOffset.UtcNow;
        using var connection = Open();
        using (var find = connection.CreateCommand())
        {
            find.CommandText = "SELECT device_id, name, revoked_at FROM devices WHERE token_hash=@hash";
            find.Parameters.AddWithValue("@hash", Sha256Hex(token));
            using var reader = find.ExecuteReader();
            if (!reader.Read() || !reader.IsDBNull(2)) return false;
            deviceId = reader.GetString(0);
            name = reader.GetString(1);
        }

        using var touch = connection.CreateCommand();
        touch.CommandText =
            "UPDATE devices SET last_seen_at=@now WHERE device_id=@id AND (last_seen_at IS NULL OR last_seen_at < @cutoff)";
        touch.Parameters.AddWithValue("@now", now.ToString("O"));
        touch.Parameters.AddWithValue("@id", deviceId);
        touch.Parameters.AddWithValue("@cutoff", now.AddMinutes(-5).ToString("O"));
        touch.ExecuteNonQuery();
        return true;
    }

    public List<DeviceInfo> ListDevices()
    {
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT device_id, name, created_at, last_seen_at, revoked_at FROM devices ORDER BY created_at";
        using var reader = command.ExecuteReader();
        var devices = new List<DeviceInfo>();
        while (reader.Read())
        {
            devices.Add(new DeviceInfo(
                reader.GetString(0),
                reader.GetString(1),
                reader.GetString(2),
                reader.IsDBNull(3) ? null : reader.GetString(3),
                !reader.IsDBNull(4)));
        }
        return devices;
    }

    /// <summary>撤销设备；已撤销视为幂等成功，不存在返回 false。</summary>
    public bool Revoke(string deviceId)
    {
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = "UPDATE devices SET revoked_at=@now WHERE device_id=@id AND revoked_at IS NULL";
        command.Parameters.AddWithValue("@now", DateTimeOffset.UtcNow.ToString("O"));
        command.Parameters.AddWithValue("@id", deviceId);
        if (command.ExecuteNonQuery() > 0) return true;

        using var exists = connection.CreateCommand();
        exists.CommandText = "SELECT 1 FROM devices WHERE device_id=@id LIMIT 1";
        exists.Parameters.AddWithValue("@id", deviceId);
        return exists.ExecuteScalar() is not null;
    }

    /// <summary>轮换 token（旧 token 立即失效）；不存在或已撤销返回 (false, null)。</summary>
    public (bool Ok, string? Token) Rotate(string deviceId)
    {
        var token = "cyn_" + Base64Url(RandomNumberGenerator.GetBytes(32));
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = "UPDATE devices SET token_hash=@hash WHERE device_id=@id AND revoked_at IS NULL";
        command.Parameters.AddWithValue("@hash", Sha256Hex(token));
        command.Parameters.AddWithValue("@id", deviceId);
        return command.ExecuteNonQuery() > 0 ? (true, token) : (false, null);
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
            CREATE TABLE IF NOT EXISTS devices (
              device_id    TEXT PRIMARY KEY,
              name         TEXT NOT NULL,
              token_hash   TEXT NOT NULL UNIQUE,
              created_at   TEXT NOT NULL,
              last_seen_at TEXT,
              revoked_at   TEXT
            );
            CREATE TABLE IF NOT EXISTS pairing_codes (
              code_hash    TEXT PRIMARY KEY,
              created_by   TEXT NOT NULL,
              created_at   TEXT NOT NULL,
              expires_at   TEXT NOT NULL,
              redeemed_at  TEXT,
              redeemed_by  TEXT
            );
            """;
        command.ExecuteNonQuery();
    }

    private static string RandomCode()
    {
        var buffer = new char[CodeLength];
        for (var i = 0; i < CodeLength; i++)
        {
            buffer[i] = CodeAlphabet[RandomNumberGenerator.GetInt32(CodeAlphabet.Length)];
        }
        return new string(buffer);
    }

    private static string RandomHex(int bytes) =>
        Convert.ToHexString(RandomNumberGenerator.GetBytes(bytes)).ToLowerInvariant();

    private static string Base64Url(byte[] bytes) =>
        Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private static string Sha256Hex(string value) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();

    private static string FormatCode(string code) => code[..4] + "-" + code[4..];

    /// <summary>规范化用户输入：去空格/连字符、大写；非法（长度/字符集）返回 null。</summary>
    private static string? NormalizeCode(string? input)
    {
        if (string.IsNullOrWhiteSpace(input)) return null;
        var buffer = new StringBuilder(CodeLength);
        foreach (var ch in input)
        {
            if (ch is ' ' or '-') continue;
            var upper = char.ToUpperInvariant(ch);
            if (!CodeAlphabet.Contains(upper)) return null;
            buffer.Append(upper);
            if (buffer.Length > CodeLength) return null;
        }
        return buffer.Length == CodeLength ? buffer.ToString() : null;
    }
}

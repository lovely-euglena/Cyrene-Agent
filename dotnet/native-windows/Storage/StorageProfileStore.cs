using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using CyreneNative.Ssh;

namespace CyreneNative.Storage;

/// <summary>
/// 云存储档案存储：&lt;data-dir&gt;/storage-profiles.json。
/// 秘密（密码/口令/密钥）用 DPAPI（CurrentUser）加密后落盘；列表投影不透出秘密。
/// 与 SshProfileStore 同约定：兼容手编明文、DPAPI 不可用降级 plain:、更新的空秘密保留旧值。
/// </summary>
internal sealed class StorageProfileStore
{
    private static readonly string[] Protocols = ["ftp", "ftps", "sftp", "webdav", "s3"];

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private sealed class StoreFile
    {
        public int Version { get; set; } = 1;
        public List<StorageProfileRecord> Profiles { get; set; } = new();
    }

    private readonly string _dataDir;
    private readonly string _path;
    private readonly object _gate = new();
    private List<StorageProfileRecord> _records;

    public StorageProfileStore(string dataDir)
    {
        _dataDir = dataDir;
        _path = Path.Combine(dataDir, "storage-profiles.json");
        _records = Load();
    }

    public string FilePath => _path;

    public List<StorageProfile> List()
    {
        lock (_gate)
        {
            return _records.Select(ToProfile).ToList();
        }
    }

    public StorageProfile? Get(string id)
    {
        lock (_gate)
        {
            var record = _records.FirstOrDefault(r => r.Id == id);
            return record is null ? null : ToProfile(record);
        }
    }

    public StorageProfile GetOrThrow(string id)
        => Get(id) ?? throw new StorageException("STORAGE_PROFILE_NOT_FOUND", $"云存储档案不存在：{id}");

    public bool Remove(string id)
    {
        lock (_gate)
        {
            var removed = _records.RemoveAll(r => r.Id == id) > 0;
            if (removed) Save();
            return removed;
        }
    }

    /// <summary>
    /// 新增/更新档案。fromSshProfile 仅在 sftp 且字段空缺时做一次性拷贝（不引运行时耦合）。
    /// </summary>
    public StorageProfile Upsert(StorageProfile input, string? fromSshProfile = null)
    {
        lock (_gate)
        {
            var now = DateTimeOffset.UtcNow.ToString("O");
            var record = string.IsNullOrEmpty(input.Id)
                ? null
                : _records.FirstOrDefault(r => r.Id == input.Id);
            if (record is null)
            {
                record = new StorageProfileRecord
                {
                    Id = string.IsNullOrEmpty(input.Id) ? Guid.NewGuid().ToString("N") : input.Id,
                    CreatedAt = now,
                };
                _records.Add(record);
            }

            ApplySshPrefill(input, fromSshProfile);

            var protocol = (input.Protocol ?? "").Trim().ToLowerInvariant();
            if (protocol.Length == 0) protocol = "sftp";
            if (!Protocols.Contains(protocol))
                throw new StorageException("STORAGE_PROFILE_ERROR", $"未知协议：{input.Protocol}（支持 {string.Join("/", Protocols)}）");

            record.Protocol = protocol;
            record.Host = (input.Host ?? "").Trim();
            record.Username = (input.Username ?? "").Trim();
            record.RootPath = protocol == "s3"
                ? StoragePaths.NormalizeS3Prefix(input.RootPath)
                : StoragePaths.NormalizeRootPath(input.RootPath);
            record.TlsMode = input.TlsMode == "implicit" ? "implicit" : "explicit";
            record.AllowInvalidCert = input.AllowInvalidCert;
            record.Passive = input.Passive;
            record.AuthType = input.AuthType == "privateKey" ? "privateKey" : "password";
            record.PrivateKeyPath = string.IsNullOrWhiteSpace(input.PrivateKeyPath) ? null : input.PrivateKeyPath.Trim();
            record.BaseUrl = (input.BaseUrl ?? "").Trim();
            record.WebDavAuthType = input.WebDavAuthType is "digest" or "none" ? input.WebDavAuthType : "basic";
            record.Bucket = (input.Bucket ?? "").Trim();
            record.Endpoint = (input.Endpoint ?? "").Trim().TrimEnd('/');
            record.Region = (input.Region ?? "").Trim();
            record.PathStyle = input.PathStyle;
            record.Port = input.Port is > 0 and <= 65535
                ? input.Port
                : protocol switch
                {
                    "ftp" => 21,
                    "ftps" => record.TlsMode == "implicit" ? 990 : 21,
                    "sftp" => 22,
                    _ => 0,
                };

            record.Name = string.IsNullOrWhiteSpace(input.Name)
                ? FirstNonEmpty(record.Host, record.BaseUrl, record.Bucket, record.Id)
                : input.Name.Trim();

            // 秘密：空 = 保留旧值；写入即加密（明文兼容字段清理，不再写回）
            if (!string.IsNullOrEmpty(input.Password)) record.PasswordEnc = Protect(input.Password);
            if (!string.IsNullOrEmpty(input.Passphrase)) record.PassphraseEnc = Protect(input.Passphrase);
            if (!string.IsNullOrEmpty(input.AccessKeyId)) record.AccessKeyIdEnc = Protect(input.AccessKeyId);
            if (!string.IsNullOrEmpty(input.SecretAccessKey)) record.SecretAccessKeyEnc = Protect(input.SecretAccessKey);
            if (!string.IsNullOrEmpty(input.SessionToken)) record.SessionTokenEnc = Protect(input.SessionToken);
            record.Password = null;
            record.Passphrase = null;
            record.AccessKeyId = null;
            record.SecretAccessKey = null;
            record.SessionToken = null;
            record.UpdatedAt = now;

            Validate(record);
            Save();
            return ToProfile(record);
        }
    }

    /// <summary>fromSshProfile：只补空缺字段（用户显式给的字段优先）。</summary>
    private void ApplySshPrefill(StorageProfile input, string? fromSshProfile)
    {
        if (string.IsNullOrWhiteSpace(fromSshProfile)) return;
        var ssh = new SshProfileStore(_dataDir).List().FirstOrDefault(p =>
            string.Equals(p.Id, fromSshProfile, StringComparison.OrdinalIgnoreCase) ||
            string.Equals(p.Name, fromSshProfile, StringComparison.OrdinalIgnoreCase) ||
            string.Equals(p.Host, fromSshProfile, StringComparison.OrdinalIgnoreCase))
            ?? throw new StorageException("STORAGE_PROFILE_NOT_FOUND", $"SSH 档案不存在：{fromSshProfile}");

        if (string.IsNullOrWhiteSpace(input.Protocol)) input.Protocol = "sftp";
        if (input.Protocol != "sftp")
            throw new StorageException("STORAGE_PROFILE_ERROR", "fromSshProfile 仅适用于 sftp 档案");

        if (string.IsNullOrWhiteSpace(input.Host)) input.Host = ssh.Host;
        if (input.Port <= 0) input.Port = ssh.Port;
        if (string.IsNullOrWhiteSpace(input.Username)) input.Username = ssh.Username;
        if (string.IsNullOrWhiteSpace(input.AuthType)) input.AuthType = ssh.AuthType;
        if (string.IsNullOrWhiteSpace(input.PrivateKeyPath)) input.PrivateKeyPath = ssh.PrivateKeyPath;
        if (string.IsNullOrEmpty(input.Password)) input.Password = ssh.Password;
        if (string.IsNullOrEmpty(input.Passphrase)) input.Passphrase = ssh.Passphrase;
        if (string.IsNullOrWhiteSpace(input.Name)) input.Name = ssh.Name;
    }

    private static void Validate(StorageProfileRecord record)
    {
        switch (record.Protocol)
        {
            case "ftp":
            case "ftps":
                if (string.IsNullOrWhiteSpace(record.Host))
                    throw new StorageException("STORAGE_PROFILE_ERROR", "host 不能为空");
                break;
            case "sftp":
                if (string.IsNullOrWhiteSpace(record.Host))
                    throw new StorageException("STORAGE_PROFILE_ERROR", "host 不能为空");
                if (string.IsNullOrWhiteSpace(record.Username))
                    throw new StorageException("STORAGE_PROFILE_ERROR", "sftp 档案需要 username");
                if (record.AuthType == "privateKey" && string.IsNullOrWhiteSpace(record.PrivateKeyPath))
                    throw new StorageException("STORAGE_PROFILE_ERROR", "privateKey 认证必须提供 privateKeyPath");
                break;
            case "webdav":
                if (string.IsNullOrWhiteSpace(record.BaseUrl))
                    throw new StorageException("STORAGE_PROFILE_ERROR", "webdav 档案需要 baseUrl");
                if (!Uri.TryCreate(record.BaseUrl, UriKind.Absolute, out var uri) ||
                    (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps))
                    throw new StorageException("STORAGE_PROFILE_ERROR", $"baseUrl 必须是 http/https 绝对地址：{record.BaseUrl}");
                break;
            case "s3":
                if (string.IsNullOrWhiteSpace(record.Bucket))
                    throw new StorageException("STORAGE_PROFILE_ERROR", "s3 档案需要 bucket");
                break;
        }
    }

    private static string FirstNonEmpty(params string[] values)
    {
        foreach (var v in values)
        {
            if (!string.IsNullOrWhiteSpace(v)) return v;
        }
        return "";
    }

    /// <summary>列表投影：不透出任何秘密（含加密串）。</summary>
    public static object ToPublic(StorageProfile profile) => new
    {
        profile.Id,
        profile.Name,
        profile.Protocol,
        profile.Host,
        profile.Port,
        profile.Username,
        profile.RootPath,
        profile.TlsMode,
        profile.AllowInvalidCert,
        profile.Passive,
        profile.AuthType,
        profile.PrivateKeyPath,
        profile.BaseUrl,
        profile.WebDavAuthType,
        profile.Bucket,
        profile.Endpoint,
        profile.Region,
        profile.PathStyle,
        hasPassword = !string.IsNullOrEmpty(profile.Password),
        hasPassphrase = !string.IsNullOrEmpty(profile.Passphrase),
        hasAccessKey = !string.IsNullOrEmpty(profile.AccessKeyId),
        profile.CreatedAt,
        profile.UpdatedAt,
    };

    private StorageProfile ToProfile(StorageProfileRecord record) => new()
    {
        Id = record.Id,
        Name = record.Name,
        Protocol = record.Protocol,
        Host = record.Host,
        Port = record.Port,
        Username = record.Username,
        RootPath = record.RootPath,
        TlsMode = record.TlsMode,
        AllowInvalidCert = record.AllowInvalidCert,
        Passive = record.Passive,
        AuthType = record.AuthType,
        PrivateKeyPath = record.PrivateKeyPath,
        BaseUrl = record.BaseUrl,
        WebDavAuthType = record.WebDavAuthType,
        Bucket = record.Bucket,
        Endpoint = record.Endpoint,
        Region = record.Region,
        PathStyle = record.PathStyle,
        Password = record.Password ?? Unprotect(record.PasswordEnc),
        Passphrase = record.Passphrase ?? Unprotect(record.PassphraseEnc),
        AccessKeyId = record.AccessKeyId ?? Unprotect(record.AccessKeyIdEnc),
        SecretAccessKey = record.SecretAccessKey ?? Unprotect(record.SecretAccessKeyEnc),
        SessionToken = record.SessionToken ?? Unprotect(record.SessionTokenEnc),
        CreatedAt = record.CreatedAt,
        UpdatedAt = record.UpdatedAt,
    };

    private List<StorageProfileRecord> Load()
    {
        try
        {
            if (!File.Exists(_path)) return new List<StorageProfileRecord>();
            var json = File.ReadAllText(_path, Encoding.UTF8);
            return JsonSerializer.Deserialize<StoreFile>(json, JsonOptions)?.Profiles ?? new List<StorageProfileRecord>();
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[storage-host] 读取档案失败: {ex.Message}");
            return new List<StorageProfileRecord>();
        }
    }

    private void Save()
    {
        var dir = Path.GetDirectoryName(_path);
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
        var json = JsonSerializer.Serialize(new StoreFile { Profiles = _records }, JsonOptions);
        var tmp = _path + ".tmp";
        File.WriteAllText(tmp, json, Encoding.UTF8);
        File.Move(tmp, _path, overwrite: true);
    }

    // ── DPAPI（与 SshProfileStore 同约定）─────────────────────

    private static string Protect(string plain)
    {
        try
        {
            var bytes = ProtectedData.Protect(Encoding.UTF8.GetBytes(plain), null, DataProtectionScope.CurrentUser);
            return "dpapi:" + Convert.ToBase64String(bytes);
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[storage-host] DPAPI 不可用，降级明文存储: {ex.Message}");
            return "plain:" + plain;
        }
    }

    private static string? Unprotect(string? stored)
    {
        if (string.IsNullOrEmpty(stored)) return null;
        if (stored.StartsWith("plain:", StringComparison.Ordinal)) return stored["plain:".Length..];
        if (!stored.StartsWith("dpapi:", StringComparison.Ordinal)) return stored; // 兼容直接明文
        try
        {
            var bytes = Convert.FromBase64String(stored["dpapi:".Length..]);
            return Encoding.UTF8.GetString(ProtectedData.Unprotect(bytes, null, DataProtectionScope.CurrentUser));
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[storage-host] 解密失败（换机器/换用户？）: {ex.Message}");
            return null;
        }
    }
}

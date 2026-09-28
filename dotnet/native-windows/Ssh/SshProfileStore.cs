using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace CyreneNative.Ssh;

/// <summary>
/// SSH 档案（主机 + 认证方式）；密码/口令用 DPAPI（CurrentUser）加密后落盘。
/// 存储位置： &lt;data-dir&gt;/ssh-profiles.json（data-dir 由宿主启动参数下发）。
///
/// 兼容手编文件：读取时若字段是明文 password / passphrase（没有 *Enc），可直接使用，
/// 下次保存自动升级为加密形态；DPAPI 不可用时降级 plain: 前缀并如实记录。
/// </summary>
internal sealed class SshProfile
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public string Host { get; set; } = "";
    public int Port { get; set; } = 22;
    public string Username { get; set; } = "";
    /// <summary>password | privateKey</summary>
    public string AuthType { get; set; } = "password";
    public string? PrivateKeyPath { get; set; }
    public string? Password { get; set; }
    public string? Passphrase { get; set; }
    public string CreatedAt { get; set; } = "";
    public string UpdatedAt { get; set; } = "";
}

/// <summary>落盘 DTO：敏感字段只写 *Enc 形态。</summary>
internal sealed class SshProfileRecord
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public string Host { get; set; } = "";
    public int Port { get; set; } = 22;
    public string Username { get; set; } = "";
    public string AuthType { get; set; } = "password";
    public string? PrivateKeyPath { get; set; }
    public string? PasswordEnc { get; set; }
    public string? PassphraseEnc { get; set; }
    /// <summary>兼容手编：明文密码（读取后不写回）。</summary>
    public string? Password { get; set; }
    /// <summary>兼容手编：明文口令（读取后不写回）。</summary>
    public string? Passphrase { get; set; }
    public string CreatedAt { get; set; } = "";
    public string UpdatedAt { get; set; } = "";
}

internal sealed class SshProfileStore
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private sealed class StoreFile
    {
        public int Version { get; set; } = 1;
        public List<SshProfileRecord> Profiles { get; set; } = new();
    }

    private readonly string _path;
    private readonly object _gate = new();
    private List<SshProfileRecord> _records;

    public SshProfileStore(string dataDir)
    {
        _path = Path.Combine(dataDir, "ssh-profiles.json");
        _records = Load();
    }

    public string FilePath => _path;

    public List<SshProfile> List()
    {
        lock (_gate)
        {
            return _records.Select(ToProfile).ToList();
        }
    }

    public SshProfile? Get(string id)
    {
        lock (_gate)
        {
            var record = _records.FirstOrDefault(r => r.Id == id);
            return record is null ? null : ToProfile(record);
        }
    }

    public SshProfile Upsert(SshProfile input)
    {
        lock (_gate)
        {
            var now = DateTimeOffset.UtcNow.ToString("O");
            var record = string.IsNullOrEmpty(input.Id)
                ? null
                : _records.FirstOrDefault(r => r.Id == input.Id);
            if (record is null)
            {
                record = new SshProfileRecord
                {
                    Id = string.IsNullOrEmpty(input.Id) ? Guid.NewGuid().ToString("N") : input.Id,
                    CreatedAt = now,
                };
                _records.Add(record);
            }

            record.Name = string.IsNullOrWhiteSpace(input.Name) ? input.Host : input.Name.Trim();
            record.Host = input.Host.Trim();
            record.Port = input.Port is > 0 and <= 65535 ? input.Port : 22;
            record.Username = input.Username.Trim();
            record.AuthType = input.AuthType == "privateKey" ? "privateKey" : "password";
            record.PrivateKeyPath = string.IsNullOrWhiteSpace(input.PrivateKeyPath) ? null : input.PrivateKeyPath.Trim();
            if (!string.IsNullOrEmpty(input.Password)) record.PasswordEnc = Protect(input.Password);
            if (!string.IsNullOrEmpty(input.Passphrase)) record.PassphraseEnc = Protect(input.Passphrase);
            record.Password = null;      // 不再写明文
            record.Passphrase = null;
            record.UpdatedAt = now;

            Validate(record);
            Save();
            return ToProfile(record);
        }
    }

    public bool Remove(string id)
    {
        lock (_gate)
        {
            var removed = _records.RemoveAll(r => r.Id == id) > 0;
            if (removed) Save();
            return removed;
        }
    }

    /// <summary>列表投影：不透出密码/口令（含加密串）。</summary>
    public static object ToPublic(SshProfile profile) => new
    {
        profile.Id,
        profile.Name,
        profile.Host,
        profile.Port,
        profile.Username,
        profile.AuthType,
        profile.PrivateKeyPath,
        profile.CreatedAt,
        profile.UpdatedAt,
        hasPassword = !string.IsNullOrEmpty(profile.Password),
        hasPassphrase = !string.IsNullOrEmpty(profile.Passphrase),
    };

    private static void Validate(SshProfileRecord record)
    {
        if (string.IsNullOrWhiteSpace(record.Host)) throw new InvalidOperationException("host 不能为空");
        if (string.IsNullOrWhiteSpace(record.Username)) throw new InvalidOperationException("username 不能为空");
        if (record.AuthType == "privateKey" && string.IsNullOrWhiteSpace(record.PrivateKeyPath))
            throw new InvalidOperationException("privateKey 认证必须提供 privateKeyPath");
    }

    private SshProfile ToProfile(SshProfileRecord record) => new()
    {
        Id = record.Id,
        Name = record.Name,
        Host = record.Host,
        Port = record.Port,
        Username = record.Username,
        AuthType = record.AuthType,
        PrivateKeyPath = record.PrivateKeyPath,
        Password = record.Password ?? Unprotect(record.PasswordEnc),
        Passphrase = record.Passphrase ?? Unprotect(record.PassphraseEnc),
        CreatedAt = record.CreatedAt,
        UpdatedAt = record.UpdatedAt,
    };

    private List<SshProfileRecord> Load()
    {
        try
        {
            if (!File.Exists(_path)) return new List<SshProfileRecord>();
            var json = File.ReadAllText(_path, Encoding.UTF8);
            return JsonSerializer.Deserialize<StoreFile>(json, JsonOptions)?.Profiles ?? new List<SshProfileRecord>();
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[ssh-host] 读取档案失败: {ex.Message}");
            return new List<SshProfileRecord>();
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

    // ── DPAPI ───────────────────────────────────────────────

    private static string Protect(string plain)
    {
        try
        {
            var bytes = ProtectedData.Protect(Encoding.UTF8.GetBytes(plain), null, DataProtectionScope.CurrentUser);
            return "dpapi:" + Convert.ToBase64String(bytes);
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[ssh-host] DPAPI 不可用，降级明文存储: {ex.Message}");
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
            Console.Error.WriteLine($"[ssh-host] 解密失败（换机器/换用户？）: {ex.Message}");
            return null;
        }
    }
}

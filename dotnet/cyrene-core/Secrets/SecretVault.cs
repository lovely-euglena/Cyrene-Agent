using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace CyreneNative.Secrets;

/// <summary>
/// 值保护器抽象：DPAPI（CurrentUser）实现留 native-windows（DpapiSecretProtector）；
/// 冒烟壳/测试注入明文保护器（plain: 前缀，仅测试）；服务端注入自己的实现。
/// </summary>
public interface ISecretProtector
{
    /// <summary>加密（返回带前缀的存储形态，如 "dpapi:base64"）。</summary>
    string Protect(string plain);

    /// <summary>解密；失败（换机器/换用户/损坏）返回 null。</summary>
    string? Unprotect(string stored);

    string Scheme { get; }

    /// <summary>平台可用性（DPAPI 仅 Windows；不可用时 vault 拒绝 Put——绝不降级明文）。</summary>
    bool IsAvailable { get; }
}

/// <summary>
/// 密钥库 vault（Phase 1 / A20 / IKJLB2 设计 §4）。
///
/// 文件：&lt;dataDir&gt;/secrets-vault.json
///   {"version":1,"migratedAt":null|"ISO","entries":{"<name>":{"enc":"dpapi:…","createdAt":…,"updatedAt":…}}}
///
/// 纪律：
///   - 原子写：.tmp 写全 → 旧文件转 .bak → .tmp 原子替换（崩溃任意点不损坏，验收用例 9）；
///   - 跨进程互斥：Local\CyreneSecretsVault（llm-host 只读 + secrets-host 写并发，限同登录会话）；
///   - 绝不落明文：保护器不可用 → Put 抛出（不降级明文——密钥库与 SSH 档案不同，
///     静默明文等于白做）；list 只回元信息不回 value；
///   - migratedAt：TS 迁移（A4）完成标记，host 缺失策略（迁移前回退/迁移后硬失败）依据。
/// </summary>
public sealed class SecretVault
{
    private readonly string _filePath;
    private readonly ISecretProtector _protector;
    private static readonly Mutex GlobalMutex = new(false, @"Local\CyreneSecretsVault");

    public SecretVault(string dataDir, ISecretProtector protector)
    {
        _protector = protector;
        Directory.CreateDirectory(dataDir);
        _filePath = Path.Combine(dataDir, "secrets-vault.json");
    }

    public string FilePath => _filePath;
    public ISecretProtector Protector => _protector;
    public bool ProtectorAvailable => _protector.IsAvailable;

    private sealed class VaultFile
    {
        [JsonPropertyName("version")] public int Version { get; set; } = 1;
        [JsonPropertyName("migratedAt")] public string? MigratedAt { get; set; }
        [JsonPropertyName("entries")] public Dictionary<string, VaultEntry> Entries { get; set; } = new(StringComparer.Ordinal);
    }

    private sealed class VaultEntry
    {
        [JsonPropertyName("enc")] public string Enc { get; set; } = "";
        [JsonPropertyName("createdAt")] public string CreatedAt { get; set; } = "";
        [JsonPropertyName("updatedAt")] public string UpdatedAt { get; set; } = "";
    }

    private readonly object _fileGate = new();

    private VaultFile Load()
    {
        if (!File.Exists(_filePath)) return new VaultFile();
        try
        {
            return JsonSerializer.Deserialize<VaultFile>(File.ReadAllText(_filePath)) ?? new VaultFile();
        }
        catch (Exception ex)
        {
            // 损坏：不静默清空（密钥无价）；尝试 .bak
            var bak = _filePath + ".bak";
            if (File.Exists(bak))
            {
                try
                {
                    Console.Error.WriteLine($"[secrets] vault 损坏（{ex.Message}），回退 .bak");
                    return JsonSerializer.Deserialize<VaultFile>(File.ReadAllText(bak)) ?? new VaultFile();
                }
                catch { /* bak 也坏：抛给上层 */ }
            }
            throw new IOException($"secrets vault 损坏且无可用备份: {ex.Message}");
        }
    }

    private void Save(VaultFile vault)
    {
        var tmp = _filePath + ".tmp";
        var bak = _filePath + ".bak";
        File.WriteAllText(tmp, JsonSerializer.Serialize(vault, new JsonSerializerOptions { WriteIndented = true }));
        if (File.Exists(_filePath)) File.Copy(_filePath, bak, overwrite: true);
        File.Move(tmp, _filePath, overwrite: true);
        TightenUnixMode(_filePath); // vault 含密钥（加密态）：Unix 收紧 0600，Windows no-op（P1-9）
    }

    /// <summary>Unix 平台收紧文件权限至 0600（owner rw）；Windows / 不支持时静默跳过。</summary>
    private static void TightenUnixMode(string path)
    {
        try
        {
            if (!OperatingSystem.IsWindows() && File.Exists(path))
                File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        }
        catch { /* 平台不支持（如容器内特殊 fs）：不阻断 */ }
    }

    /// <summary>跨进程安全执行 vault 读写（互斥失败不致命：单机场景 Mutex 可用性极高）。</summary>
    private T WithLock<T>(Func<T> action)
    {
        try
        {
            if (!GlobalMutex.WaitOne(TimeSpan.FromSeconds(5)))
                throw new IOException("secrets vault 互斥等待超时");
        }
        catch (AbandonedMutexException) { /* 前持有者崩溃：锁已得手，继续 */ }
        try { return action(); }
        finally { try { GlobalMutex.ReleaseMutex(); } catch { /* 未持有（WaitOne 异常路径） */ } }
    }

    /// <summary>取值；不存在/解密失败/保护器不可用 → null。</summary>
    public string? Get(string name)
    {
        if (!_protector.IsAvailable) return null;
        return WithLock(() =>
        {
            var vault = Load();
            if (!vault.Entries.TryGetValue(name, out var e)) return null;
            return _protector.Unprotect(e.Enc);
        });
    }

    /// <summary>写入/覆盖；保护器不可用直接抛（绝不落明文）。</summary>
    public void Put(string name, string value)
    {
        if (string.IsNullOrEmpty(name)) throw new ArgumentException("vault key 名不能为空", nameof(name));
        if (!_protector.IsAvailable)
            throw new InvalidOperationException($"值保护器 {_protector.Scheme} 不可用（拒绝明文降级）");
        var now = DateTimeOffset.UtcNow.ToString("o");
        WithLock(() =>
        {
            var vault = Load();
            if (vault.Entries.TryGetValue(name, out var existing))
            {
                existing.Enc = _protector.Protect(value);
                existing.UpdatedAt = now;
            }
            else
            {
                vault.Entries[name] = new VaultEntry { Enc = _protector.Protect(value), CreatedAt = now, UpdatedAt = now };
            }
            Save(vault);
            return true;
        });
    }

    public bool Delete(string name)
    {
        return WithLock(() =>
        {
            var vault = Load();
            var removed = vault.Entries.Remove(name);
            if (removed) Save(vault);
            return removed;
        });
    }

    /// <summary>列条目元信息——绝不含 value（验收用例 3）。</summary>
    public List<SecretEntryInfo> List()
    {
        return WithLock(() =>
        {
            var vault = Load();
            var list = new List<SecretEntryInfo>(vault.Entries.Count);
            foreach (var (name, e) in vault.Entries)
                list.Add(new SecretEntryInfo(name, e.CreatedAt, e.UpdatedAt));
            list.Sort((a, b) => string.CompareOrdinal(a.Name, b.Name));
            return list;
        });
    }

    public int Count => WithLock(() => Load().Entries.Count);

    public DateTimeOffset? MigratedAt
    {
        get
        {
            return WithLock<DateTimeOffset?>(() =>
            {
                var m = Load().MigratedAt;
                return m != null && DateTimeOffset.TryParse(m, System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.RoundtripKind, out var t)
                    ? t : null;
            });
        }
    }

    /// <summary>迁移完成标记（A4：import → 回读校验 → .bak → 源清空 全部成功后调用）。</summary>
    public void MarkMigrated()
    {
        WithLock(() =>
        {
            var vault = Load();
            vault.MigratedAt ??= DateTimeOffset.UtcNow.ToString("o");
            Save(vault);
            return true;
        });
    }
}

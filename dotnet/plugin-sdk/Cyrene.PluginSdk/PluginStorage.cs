using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Cyrene.PluginSdk;

/// <summary>
/// 插件私有 KV 存储。与 Node 轨完全同格式：每个 key 一个
/// <c>&lt;DataDir&gt;/&lt;key&gt;.json</c>，写入先落 .tmp 再原子替换。
/// 两种运行时读写同一目录，插件从 Node 轨迁 .NET 轨可以直接复用数据。
/// 配额是软限制：只约束本 API 的写入；宿主可用 CYRENE_PLUGIN_STORAGE_QUOTA_MB
/// （MiB，0 = 不限）覆盖默认 64 MiB。
/// </summary>
public sealed class PluginStorage
{
    private static readonly Regex KeyRegex = new("^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$", RegexOptions.Compiled);
    private static readonly JsonSerializerOptions WriteOptions = new() { WriteIndented = true };
    private const long DefaultQuotaMb = 64;
    private const string QuotaEnv = "CYRENE_PLUGIN_STORAGE_QUOTA_MB";
    private const double QuotaWarnRatio = 0.8;

    private readonly CyrenePluginBase _plugin;
    private readonly object _quotaLock = new();
    private long _quotaBytes = -1;
    private long _usedBytes;
    private bool _usedInitialized;
    private bool _quotaWarned;

    internal PluginStorage(CyrenePluginBase plugin) => _plugin = plugin;

    /// <summary>插件私有数据目录（init 后有效）。</summary>
    public string RootDir => _plugin.ResolveDataDir();

    /// <summary>读取 key 对应的 JSON；不存在或损坏返回 <c>default</c>。</summary>
    public T? Get<T>(string key)
    {
        var path = FileFor(key);
        if (!File.Exists(path)) return default;
        try
        {
            return JsonSerializer.Deserialize<T>(File.ReadAllText(path));
        }
        catch
        {
            // 与 Node 轨一致：损坏的 key 当作不存在，不让插件加载失败
            return default;
        }
    }

    /// <summary>写入 key 对应的 JSON（原子写：先写 .tmp 再替换）；超出配额抛 InvalidOperationException。</summary>
    public void Set<T>(string key, T value)
    {
        var path = FileFor(key);
        var json = JsonSerializer.Serialize(value, WriteOptions);
        var bytes = Encoding.UTF8.GetByteCount(json);
        if (_quotaBytes < 0) _quotaBytes = ResolveQuotaBytes();
        lock (_quotaLock)
        {
            var existing = File.Exists(path) ? new FileInfo(path).Length : 0;
            var nextBytes = EnsureUsedBytes() + bytes - existing;
            if (_quotaBytes > 0 && nextBytes > _quotaBytes)
            {
                throw new InvalidOperationException(
                    $"插件存储超出配额（{_quotaBytes / 1024 / 1024} MiB），写入被拒绝: {key}");
            }
            if (_quotaBytes > 0 && !_quotaWarned && nextBytes > _quotaBytes * QuotaWarnRatio)
            {
                _quotaWarned = true;
                Console.Error.WriteLine(
                    $"[cyrene-plugin] [storage] 已使用 {nextBytes / 1024.0 / 1024.0:F1} MiB，接近配额上限");
            }
            var tmp = path + ".tmp";
            File.WriteAllText(tmp, json);
            File.Move(tmp, path, overwrite: true);
            _usedBytes = nextBytes;
            _usedInitialized = true;
        }
    }

    private static long ResolveQuotaBytes()
    {
        var raw = Environment.GetEnvironmentVariable(QuotaEnv);
        if (long.TryParse(raw, out var mb) && mb >= 0) return mb * 1024 * 1024;
        return DefaultQuotaMb * 1024 * 1024;
    }

    /// <summary>用量惰性初始化：首次写入统计目录内 .json 总大小，之后按增量维护。</summary>
    private long EnsureUsedBytes()
    {
        if (_usedInitialized) return _usedBytes;
        long total = 0;
        try
        {
            var root = _plugin.ResolveDataDir();
            if (!string.IsNullOrEmpty(root) && Directory.Exists(root))
            {
                foreach (var file in Directory.EnumerateFiles(root, "*.json"))
                {
                    try { total += new FileInfo(file).Length; }
                    catch { /* 并发删除/不可读：不阻塞写入 */ }
                }
            }
        }
        catch
        {
            total = 0;
        }
        _usedBytes = total;
        _usedInitialized = true;
        return total;
    }

    private string FileFor(string key)
    {
        if (string.IsNullOrEmpty(key) || !KeyRegex.IsMatch(key))
        {
            throw new ArgumentException($"非法存储 key: {key}", nameof(key));
        }
        var root = _plugin.ResolveDataDir();
        if (string.IsNullOrEmpty(root))
        {
            throw new InvalidOperationException("插件数据目录尚未初始化（init 之前不可用）");
        }
        return Path.Combine(root, key + ".json");
    }
}

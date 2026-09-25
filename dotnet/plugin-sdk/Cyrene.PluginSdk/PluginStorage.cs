using System.Text.Json;
using System.Text.RegularExpressions;

namespace Cyrene.PluginSdk;

/// <summary>
/// 插件私有 KV 存储。与 Node 轨完全同格式：每个 key 一个
/// <c>&lt;DataDir&gt;/&lt;key&gt;.json</c>，写入先落 .tmp 再原子替换。
/// 两种运行时读写同一目录，插件从 Node 轨迁 .NET 轨可以直接复用数据。
/// </summary>
public sealed class PluginStorage
{
    private static readonly Regex KeyRegex = new("^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$", RegexOptions.Compiled);
    private static readonly JsonSerializerOptions WriteOptions = new() { WriteIndented = true };

    private readonly CyrenePluginBase _plugin;

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

    /// <summary>写入 key 对应的 JSON（原子写：先写 .tmp 再替换）。</summary>
    public void Set<T>(string key, T value)
    {
        var path = FileFor(key);
        var tmp = path + ".tmp";
        File.WriteAllText(tmp, JsonSerializer.Serialize(value, WriteOptions));
        File.Move(tmp, path, overwrite: true);
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

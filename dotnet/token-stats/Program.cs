// cyrene-token：精确 token 统计宿主（下载管理全在 .NET，Node 只传文本/模型名）。
//
// 协议：4B 小端长度 + JSON 帧（与 cyrene-embed / cyrene-native 同构）：
//   宿主 → 本进程：
//     {"id":n,"op":"count","model":"deepseek-v4.1-flash","texts":["..."],"source":"modelscope","allowDownload":true}
//     {"id":n,"op":"status","model":"..."}     // 省略 model = 全部
//     {"id":n,"op":"delete","model":"..."}
//     {"id":n,"op":"ping"}
//   本进程 → 宿主：
//     {"id":0,"op":"ready"}                     // 启动握手
//     {"id":n,"ok":true,...} / {"id":n,"ok":false,"error":"..."}
//
// 下载管理（本进程独有职责）：
//   - 清单：tokenizer-sources.json（模型 → huggingface / modelscope 仓库）
//   - 源顺序：请求 source → 其余源回退；URL 构造、超时、重试、原子落盘、
//     内容校验（JSON 形状 + 最小体积）、缓存目录管理全部在此实现。
//   - Node/TS 只负责把文本与模型名传进来，不做任何下载/URL 逻辑。
//
// 命令行：cyrene-token [serve] --data-dir <目录> [--source modelscope|huggingface|hf-mirror]
//         cyrene-token --selftest            清单/缓存自检（不联网）

using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Tokenizers.DotNet;

namespace CyreneToken;

internal sealed class TokenizerSource
{
    public string? Huggingface { get; set; }
    public string? Modelscope { get; set; }
}

internal sealed class TokenizerManifest
{
    public int Version { get; set; }
    public Dictionary<string, TokenizerSource> Models { get; set; } = new(StringComparer.OrdinalIgnoreCase);
}

internal static class TokenizerStore
{
    /// <summary>源顺序：镜像优先（hf 官方直连在部分网络不可达，仅作最后回退）。</summary>
    public static readonly string[] AllSources = ["modelscope", "hf-mirror", "huggingface"];

    private static readonly HttpClient Http = CreateClient();

    private static HttpClient CreateClient()
    {
        var client = new HttpClient { Timeout = TimeSpan.FromSeconds(120) };
        client.DefaultRequestHeaders.UserAgent.ParseAdd("cyrene-agent-token/1.0");
        return client;
    }

    public static string BuildUrl(string source, string repo) => source switch
    {
        "modelscope" => $"https://modelscope.cn/models/{repo}/resolve/master/tokenizer.json",
        "huggingface" => $"https://huggingface.co/{repo}/resolve/main/tokenizer.json",
        _ => $"https://hf-mirror.com/{repo}/resolve/main/tokenizer.json",
    };

    public static string TokenizerPath(string dataDir, string model) =>
        Path.Combine(dataDir, "tokenizers", model, "tokenizer.json");

    /// <summary>
    /// 确保 tokenizer 就位：已存在且有效直接返回；否则按源顺序下载（原子落盘）。
    /// </summary>
    public static async Task<(bool Ok, bool Downloaded, string? Path, string? Error)> EnsureAsync(
        TokenizerManifest manifest,
        string dataDir,
        string model,
        string preferredSource,
        bool allowDownload,
        CancellationToken cancellationToken)
    {
        var target = TokenizerPath(dataDir, model);
        if (IsValidTokenizerFile(target))
            return (true, false, target, null);

        if (!manifest.Models.TryGetValue(model, out var source))
            return (false, false, null, $"模型 {model} 暂无官方 tokenizer 下载源");

        if (!allowDownload)
            return (false, false, null, "本地未安装 tokenizer，且当前未允许下载");

        var ordered = AllSources
            .OrderBy(sourceName => sourceName == preferredSource ? 0 : 1)
            .ToList();
        var errors = new List<string>();
        foreach (var sourceName in ordered)
        {
            var repo = sourceName == "modelscope" ? source.Modelscope : source.Huggingface;
            if (string.IsNullOrWhiteSpace(repo)) continue;
            try
            {
                var bytes = await Http.GetByteArrayAsync(BuildUrl(sourceName, repo), cancellationToken);
                if (!LooksLikeTokenizer(bytes))
                {
                    errors.Add($"{sourceName}: 文件无效（{bytes.Length} 字节）");
                    continue;
                }
                Directory.CreateDirectory(Path.GetDirectoryName(target)!);
                var temp = target + ".part";
                await File.WriteAllBytesAsync(temp, bytes, cancellationToken);
                File.Move(temp, target, overwrite: true);
                return (true, true, target, null);
            }
            catch (Exception ex)
            {
                errors.Add($"{sourceName}: {ex.Message}");
            }
        }
        return (false, false, null, $"tokenizer 下载失败（{model}）：{string.Join(" | ", errors)}");
    }

    public static bool IsValidTokenizerFile(string path)
    {
        try
        {
            var info = new FileInfo(path);
            if (!info.Exists || info.Length < 1024) return false;
            using var stream = File.OpenRead(path);
            var buffer = new byte[Math.Min(1024, info.Length)];
            var read = stream.Read(buffer, 0, buffer.Length);
            var head = Encoding.UTF8.GetString(buffer, 0, read).TrimStart('\uFEFF', ' ', '\t', '\r', '\n');
            // 只做便宜的形状校验：大 added_tokens 会让 "model" 落在头部之外；
            // 真正的有效性由 Tokenizer 构造时兜底（失败会删除重下）
            return head.StartsWith('{');
        }
        catch
        {
            return false;
        }
    }

    private static bool LooksLikeTokenizer(byte[] bytes)
    {
        if (bytes.Length < 1024) return false;
        var head = Encoding.UTF8.GetString(bytes, 0, Math.Min(bytes.Length, 1024)).TrimStart('\uFEFF', ' ', '\t', '\r', '\n');
        return head.StartsWith('{');
    }

    public static void Delete(string dataDir, string model)
    {
        var directory = Path.GetDirectoryName(TokenizerPath(dataDir, model));
        if (directory is not null && Directory.Exists(directory)) Directory.Delete(directory, recursive: true);
    }
}

/// <summary>已加载 tokenizer 缓存（libtokenizers 初始化非线程安全：加载串行）。</summary>
internal sealed class TokenizerCache : IDisposable
{
    private readonly object _lock = new();
    private readonly Dictionary<string, Tokenizer> _cache = new(StringComparer.OrdinalIgnoreCase);

    public Tokenizer Get(string model, string path)
    {
        lock (_lock)
        {
            if (_cache.TryGetValue(model, out var cached)) return cached;
            var tokenizer = new Tokenizer(path);
            _cache[model] = tokenizer;
            return tokenizer;
        }
    }

    public void Dispose()
    {
        lock (_lock)
        {
            foreach (var tokenizer in _cache.Values)
            {
                try { tokenizer.Dispose(); } catch { }
            }
            _cache.Clear();
        }
    }
}

internal static class Program
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private static readonly object StdoutLock = new();

    public static async Task<int> Main(string[] args)
    {
        var dataDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            "cyrene", "token-stats");
        var source = "modelscope";
        var selfTest = false;

        for (var i = 0; i < args.Length; i++)
        {
            switch (args[i])
            {
                case "serve":
                    break;
                case "--data-dir" when i + 1 < args.Length:
                    dataDir = args[++i];
                    break;
                case "--source" when i + 1 < args.Length:
                    source = args[++i];
                    break;
                case "--selftest":
                    selfTest = true;
                    break;
            }
        }

        var manifest = LoadManifest();
        if (manifest is null)
        {
            Console.Error.WriteLine("[cyrene-token] 无法加载 tokenizer-sources.json");
            return 2;
        }

        if (selfTest)
        {
            Console.WriteLine($"[cyrene-token] manifest v{manifest.Version}: {manifest.Models.Count} 个模型");
            foreach (var (model, entry) in manifest.Models.OrderBy(pair => pair.Key, StringComparer.OrdinalIgnoreCase))
            {
                var installed = TokenizerStore.IsValidTokenizerFile(TokenizerStore.TokenizerPath(dataDir, model));
                Console.WriteLine($"  {model,-24} hf={entry.Huggingface ?? "-"} ms={entry.Modelscope ?? "-"} installed={installed}");
            }
            return 0;
        }

        return await ServeAsync(manifest, dataDir, source);
    }

    private static TokenizerManifest? LoadManifest()
    {
        foreach (var candidate in new[]
                 {
                     Path.Combine(AppContext.BaseDirectory, "tokenizer-sources.json"),
                     Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "tokenizer-sources.json"),
                 })
        {
            try
            {
                if (File.Exists(candidate))
                    return JsonSerializer.Deserialize<TokenizerManifest>(File.ReadAllText(candidate), Json);
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[cyrene-token] 清单解析失败 {candidate}: {ex.Message}");
            }
        }
        return null;
    }

    private static async Task<int> ServeAsync(TokenizerManifest manifest, string dataDir, string defaultSource)
    {
        Directory.CreateDirectory(Path.Combine(dataDir, "tokenizers"));
        using var cache = new TokenizerCache();
        using var stdin = Console.OpenStandardInput();
        using var stdout = Console.OpenStandardOutput();

        WriteFrame(stdout, new { id = 0, op = "ready" });

        while (true)
        {
            var frame = await ReadFrameAsync(stdin);
            if (frame is null) break; // stdin EOF：宿主退出
            var root = JsonSerializer.Deserialize<JsonElement>(frame, Json);
            if (!root.TryGetProperty("id", out var idElement) || !idElement.TryGetInt32(out var id)) continue;
            _ = Task.Run(() => HandleRequestAsync(stdout, cache, manifest, dataDir, defaultSource, id, root));
        }

        cache.Dispose();
        return 0;
    }

    private static async Task HandleRequestAsync(
        Stream stdout,
        TokenizerCache cache,
        TokenizerManifest manifest,
        string dataDir,
        string defaultSource,
        int id,
        JsonElement root)
    {
        var op = root.TryGetProperty("op", out var opElement) ? opElement.GetString() ?? "" : "";
        try
        {
            switch (op)
            {
                case "ping":
                    WriteFrame(stdout, new { id, ok = true, runtime = "Tokenizers.DotNet/1.4.1" });
                    break;

                case "count":
                {
                    var model = ReadString(root, "model");
                    var texts = ReadStringArray(root, "texts");
                    var source = ReadString(root, "source") is { Length: > 0 } requested ? requested : defaultSource;
                    var allowDownload = !root.TryGetProperty("allowDownload", out var allowElement)
                                        || allowElement.ValueKind != JsonValueKind.False;

                    var ensured = await TokenizerStore.EnsureAsync(manifest, dataDir, model, source, allowDownload, CancellationToken.None);
                    if (!ensured.Ok || ensured.Path is null)
                    {
                        WriteFrame(stdout, new { id, ok = false, error = ensured.Error ?? "tokenizer 不可用" });
                        break;
                    }

                    Tokenizer tokenizer;
                    try
                    {
                        tokenizer = cache.Get(model, ensured.Path);
                    }
                    catch (Exception ex)
                    {
                        // 文件损坏/格式不被支持：删除后允许下次重下，报明确错误
                        TokenizerStore.Delete(dataDir, model);
                        WriteFrame(stdout, new { id, ok = false, error = $"tokenizer 无法加载（已删除，可重试）：{ex.Message}" });
                        break;
                    }
                    var counts = new int[texts.Count];
                    for (var i = 0; i < texts.Count; i++)
                    {
                        counts[i] = tokenizer.Encode(texts[i] ?? "").Length;
                    }
                    WriteFrame(stdout, new { id, ok = true, model, counts, downloaded = ensured.Downloaded, path = ensured.Path });
                    break;
                }

                case "status":
                {
                    var model = ReadString(root, "model");
                    if (model.Length > 0)
                    {
                        var path = TokenizerStore.TokenizerPath(dataDir, model);
                        var installed = TokenizerStore.IsValidTokenizerFile(path);
                        var known = manifest.Models.ContainsKey(model);
                        WriteFrame(stdout, new { id, ok = true, models = new[] { new { model, installed, known, path = installed ? path : null } }, dir = dataDir });
                    }
                    else
                    {
                        var models = manifest.Models.Keys
                            .OrderBy(name => name, StringComparer.OrdinalIgnoreCase)
                            .Select(name => new
                            {
                                model = name,
                                installed = TokenizerStore.IsValidTokenizerFile(TokenizerStore.TokenizerPath(dataDir, name)),
                                known = true,
                                path = (string?)null,
                            })
                            .ToList();
                        WriteFrame(stdout, new { id, ok = true, models, dir = dataDir });
                    }
                    break;
                }

                case "delete":
                {
                    var model = ReadString(root, "model");
                    cache.Dispose();
                    TokenizerStore.Delete(dataDir, model);
                    WriteFrame(stdout, new { id, ok = true, removed = model });
                    break;
                }

                default:
                    WriteFrame(stdout, new { id, ok = false, error = $"不支持的操作: {op}" });
                    break;
            }
        }
        catch (Exception ex)
        {
            WriteFrame(stdout, new { id, ok = false, error = ex.Message });
        }
    }

    private static string ReadString(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString() ?? ""
            : "";

    private static List<string> ReadStringArray(JsonElement element, string name)
    {
        if (!element.TryGetProperty(name, out var value) || value.ValueKind != JsonValueKind.Array)
            return new List<string>();
        return value.EnumerateArray()
            .Select(item => item.ValueKind == JsonValueKind.String ? item.GetString() ?? "" : "")
            .ToList();
    }

    // ── 帧协议（4B 小端长度 + JSON；与 cyrene-embed 同构） ──

    private static void WriteFrame(Stream stdout, object payload)
    {
        var json = JsonSerializer.Serialize(payload, Json);
        var bytes = Encoding.UTF8.GetBytes(json);
        var prefix = BitConverter.GetBytes(bytes.Length);
        lock (StdoutLock)
        {
            stdout.Write(prefix, 0, 4);
            stdout.Write(bytes, 0, bytes.Length);
            stdout.Flush();
        }
    }

    private static async Task<string?> ReadFrameAsync(Stream stdin)
    {
        var prefix = new byte[4];
        if (!await ReadExactAsync(stdin, prefix, 4)) return null;
        var length = BitConverter.ToInt32(prefix, 0);
        if (length is < 0 or > 64 * 1024 * 1024) throw new IOException($"frame length out of range: {length}");
        var payload = new byte[length];
        if (!await ReadExactAsync(stdin, payload, length)) return null;
        return Encoding.UTF8.GetString(payload);
    }

    private static async Task<bool> ReadExactAsync(Stream stream, byte[] buffer, int count)
    {
        var read = 0;
        while (read < count)
        {
            var n = await stream.ReadAsync(buffer.AsMemory(read, count - read));
            if (n <= 0) return false;
            read += n;
        }
        return true;
    }
}

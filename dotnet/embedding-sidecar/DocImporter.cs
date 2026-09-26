using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace CyreneEmbedSidecar;

/// <summary>
/// 文档导入（document-index-worker.ts 同构）：
///   读取 → 扩展名/二进制/大小路由 → 缓存命中 → 分块（TextChunker）
///   → 批量 embedding（engine，16/批）→ 向量库批量落盘 → 缓存写入。
///
/// 大文件（>30k 字符）才索引；小文件返回文本由宿主按附件处理。
/// 进度由宿主通过 onProgress 转发为通知帧；取消由宿主回调 isCancelled。
/// </summary>
public sealed class DocImporter
{
    public const int SmallThreshold = 30_000;
    private const string ChunkStrategyVersion = "document-chunks-v1";
    private const string CacheFileName = "document-cache.json";
    private const int BatchSize = 16;

    /// <summary>与 TS file-ingest.ts UNSUPPORTED_EXTS 同源（改动需双端同步）。</summary>
    private static readonly HashSet<string> UnsupportedExts = new(StringComparer.OrdinalIgnoreCase)
    {
        ".zip", ".7z", ".rar", ".tar", ".gz",
        ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
        ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".ico",
        ".mp3", ".mp4", ".wav", ".avi", ".mov",
        ".exe", ".dll", ".so", ".dylib", ".bin",
        ".class", ".jar", ".pyc",
        ".o", ".a", ".wasm",
    };

    public sealed record Progress(string Status, int? CompletedChunks = null, int? TotalChunks = null);

    public sealed record Result(
        string Kind,
        string Name,
        int Chunks,
        string? ImportId,
        bool Cached,
        string? Text,
        string? Reason);

    public static Result Import(
        string filePath,
        string ragDataDir,
        EmbeddingEngine engine,
        RagStore store,
        Func<bool> isCancelled,
        Action<Progress>? onProgress)
    {
        var name = Path.GetFileName(filePath);
        if (Directory.Exists(filePath) || !File.Exists(filePath))
        {
            return new Result("unsupported", name, 0, null, false, null, "不是文件");
        }

        var ext = Path.GetExtension(filePath).ToLowerInvariant();
        if (UnsupportedExts.Contains(ext))
        {
            return new Result("unsupported", name, 0, null, false, null, $"暂不支持的文件格式 {ext}（MVP-0 仅支持文本）");
        }

        byte[] bytes;
        try
        {
            bytes = File.ReadAllBytes(filePath);
        }
        catch (Exception ex)
        {
            return new Result("unsupported", name, 0, null, false, null, ex.Message);
        }
        if (IsBinary(bytes))
        {
            return new Result("unsupported", name, 0, null, false, null, "二进制文件，暂不支持");
        }

        var text = Encoding.UTF8.GetString(bytes);
        if (string.IsNullOrWhiteSpace(text))
        {
            return new Result("empty", name, 0, null, false, null, null);
        }
        if (text.Length <= SmallThreshold)
        {
            return new Result("text", name, 0, null, false, text, null);
        }

        // ── 大文件：缓存命中检查（identity 与 TS 文档缓存逐字节一致） ──
        onProgress?.Invoke(new Progress("reading"));
        var textSha = Sha256Hex(text.Replace("\r\n", "\n").Replace("\r", "\n"));
        var cacheKey = Sha256Hex(BuildCacheIdentityJson(textSha));
        var cache = ReadCache(ragDataDir);
        if (cache.Records.TryGetValue(cacheKey, out var cached)
            && !string.IsNullOrEmpty(cached.ImportId)
            && store.HasImportedDocumentChunks(cached.ImportId))
        {
            onProgress?.Invoke(new Progress("cached", cached.ChunkCount, cached.ChunkCount));
            onProgress?.Invoke(new Progress("done", cached.ChunkCount, cached.ChunkCount));
            return new Result("indexed", name, cached.ChunkCount, cached.ImportId, true, null, null);
        }

        var chunks = TextChunker.ChunkText(text, "doc_" + name);
        onProgress?.Invoke(new Progress("chunking", chunks.Count, chunks.Count));
        if (isCancelled()) return Cancelled(name);

        var importId = $"import-{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}-{Guid.NewGuid()}";
        onProgress?.Invoke(new Progress("embedding", 0, chunks.Count));

        var persisted = 0;
        for (var start = 0; start < chunks.Count; start += BatchSize)
        {
            if (isCancelled()) return Cancelled(name);

            var batch = chunks.GetRange(start, Math.Min(BatchSize, chunks.Count - start));
            var embeddings = engine.Embed(batch.Select((c) => c.Text).ToArray());

            var items = new List<RagStore.PreparedItem>(batch.Count);
            for (var i = 0; i < batch.Count; i++)
            {
                items.Add(new RagStore.PreparedItem(
                    batch[i].Text,
                    "imported_doc",
                    embeddings[i].Select((f) => (double)f).ToArray(),
                    new Dictionary<string, JsonElement>
                    {
                        ["fileName"] = JsonSerializer.SerializeToElement(name),
                        ["chunkIndex"] = JsonSerializer.SerializeToElement(batch[i].Index),
                        ["importId"] = JsonSerializer.SerializeToElement(importId),
                    }));
            }
            store.AddPreparedBatch(items);
            persisted += batch.Count;
            onProgress?.Invoke(new Progress("embedding", persisted, chunks.Count));
        }

        WriteCacheRecord(ragDataDir, cacheKey, importId, persisted, name);
        onProgress?.Invoke(new Progress("done", persisted, persisted));
        return new Result("indexed", name, persisted, importId, false, null, null);
    }

    private static Result Cancelled(string name) => new("cancelled", name, 0, null, false, null, "cancelled");

    private static bool IsBinary(byte[] bytes)
    {
        var len = Math.Min(bytes.Length, 8192);
        for (var i = 0; i < len; i++)
        {
            if (bytes[i] == 0) return true;
        }
        return false;
    }

    public static string Sha256Hex(string input)
    {
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(input));
        return Convert.ToHexStringLower(hash);
    }

    /// <summary>
    /// 文档缓存 identity 的规范化 JSON（与 TS buildDocumentCacheIdentityFromTextSha
    /// 的 JSON.stringify 输出逐字节一致——字段序/省略 endpoint 是缓存 key 的一部分）。
    /// </summary>
    private static string BuildCacheIdentityJson(string textSha256) =>
        $"{{\"textSha256\":\"{textSha256}\",\"embeddingProvider\":\"local\",\"embeddingModel\":\"Xenova/bge-m3\",\"dimensions\":1024,\"chunkStrategyVersion\":\"{ChunkStrategyVersion}\",\"chunkSize\":{TextChunker.DocumentChunkSize},\"chunkOverlap\":{TextChunker.DocumentChunkOverlap}}}";

    // ── document-cache.json（与 TS document-cache.ts 同 schema） ──

    private static readonly JsonSerializerOptions CacheJson = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true,
    };

    private static readonly object CacheLock = new();

    private sealed class CacheFile
    {
        public Dictionary<string, CacheRecord> Records { get; set; } = new();
    }

    private sealed class CacheRecord
    {
        public string Key { get; set; } = "";
        public string ImportId { get; set; } = "";
        public int ChunkCount { get; set; }
        public string FileName { get; set; } = "";
        public string CreatedAt { get; set; } = "";
    }

    private static CacheFile ReadCache(string ragDataDir)
    {
        try
        {
            var path = Path.Combine(ragDataDir, CacheFileName);
            if (!File.Exists(path)) return new CacheFile();
            var parsed = JsonSerializer.Deserialize<CacheFile>(File.ReadAllText(path), CacheJson);
            return parsed?.Records != null ? parsed : new CacheFile();
        }
        catch
        {
            return new CacheFile();
        }
    }

    private static void WriteCacheRecord(string ragDataDir, string key, string importId, int chunkCount, string fileName)
    {
        lock (CacheLock)
        {
            try
            {
                var cache = ReadCache(ragDataDir);
                cache.Records[key] = new CacheRecord
                {
                    Key = key,
                    ImportId = importId,
                    ChunkCount = chunkCount,
                    FileName = fileName,
                    CreatedAt = DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ"),
                };
                Directory.CreateDirectory(ragDataDir);
                var target = Path.Combine(ragDataDir, CacheFileName);
                var temporary = target + ".tmp";
                File.WriteAllText(temporary, JsonSerializer.Serialize(cache, CacheJson));
                File.Move(temporary, target, overwrite: true);
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[doc] cache write failed: {ex.Message}");
            }
        }
    }
}

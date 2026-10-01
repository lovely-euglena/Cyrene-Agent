using System.IO;
using System.Text;
using System.Text.Json;

namespace CyreneNative.Storage;

/// <summary>
/// 云存储托管宿主（cyrene-native --storage-host）。
///
/// 常驻后台进程：连接/凭据/会话常驻（会话复用 + 懒重连），档案落 data-dir（DPAPI 加密）。
/// Electron 侧只做薄代理（native-storage-host.ts + cloud_* 工具注册）。
///
/// 协议（stdio JSON 行，与 --ssh-host / --tool-host 同构）：
///   ← {"op":"ready"}
///   → {"op":"profiles.list"}
///   → {"op":"profiles.upsert","callId":"c1","profile":{...},"fromSshProfile":"NAS"}
///   → {"op":"profiles.remove","callId":"c2","id":"..."}
///   → {"op":"profiles.test","callId":"c3","profileId":"..."}
///   → {"op":"status"}
///   → {"op":"read","callId":"c4","profileId":"...","path":"a/b.txt","maxBytes":262144,"maxEntries":500}
///   → {"op":"write","callId":"c5","profileId":"...","path":"a/b.txt","content":"...","localPath":"...","overwrite":false,"createParents":true}
///   → {"op":"download","callId":"c6","profileId":"...","path":"a/b.txt","localPath":"D:\\x","overwrite":false}
///   → {"op":"mkdir","callId":"c7","profileId":"...","path":"a/b","recursive":true}
///   → {"op":"delete","callId":"c8","profileId":"...","paths":["a/b"],"recursive":false}
///   → {"op":"move","callId":"c9","profileId":"...","from":"a","to":"b","overwrite":false}
///   → {"op":"copy","callId":"c10","profileId":"...","from":"a","to":"b","overwrite":false}
///   → {"op":"close","profileId":"..."} / {"op":"shutdown"}
///   ← {"op":"result","callId":"c1","ok":true,"data":...}
///   ← {"op":"result","callId":"c1","ok":false,"error":"...","errorCode":"STORAGE_*","retryable":false}
///   ← {"op":"log","level":"info|warn|error","message":"..."}
///
/// stdout 协议独占：诊断走 stderr/log 帧。
/// </summary>
internal static class StorageHost
{
    private const int DefaultInlineBytes = 256 * 1024;
    private const int MaxInlineBytes = 2 * 1024 * 1024;

    private static StorageProfileStore _store = null!;
    private static StorageSessionManager _manager = null!;
    private static readonly SemaphoreSlim IoLock = new(1, 1);
    private static Stream _stdout = null!;
    /// <summary>退出幂等门：shutdown op 与 stdin EOF 双路径只跑一次 CloseAll+Exit。</summary>
    private static int _exiting;
    /// <summary>在途请求计数：EOF/shutdown 前限时排空，保证脚本化一次性调用能拿到 result。</summary>
    private static int _inflight;

    public static int Run(string[] args)
    {
        _stdout = Console.OpenStandardOutput();
        var dataDir = ParseDataDir(args);
        if (string.IsNullOrEmpty(dataDir))
        {
            Console.Error.WriteLine("[storage-host] missing --data-dir (protocol violation)");
            return 2;
        }
        _store = new StorageProfileStore(dataDir);
        _manager = new StorageSessionManager(_store);

        WriteFrame(new { op = "ready" });

        using var cts = new CancellationTokenSource();
        Console.CancelKeyPress += (_, e) => { e.Cancel = true; cts.Cancel(); };

        using var stdin = Console.OpenStandardInput();
        using var reader = new StreamReader(stdin, Encoding.UTF8);
        string? line;
        while (!cts.IsCancellationRequested && (line = reader.ReadLine()) is not null)
        {
            if (string.IsNullOrWhiteSpace(line)) continue;
            JsonDocument doc;
            try { doc = JsonDocument.Parse(line); }
            catch
            {
                WriteFrame(new { op = "log", level = "warn", message = "非 JSON 行已忽略" });
                continue;
            }
            var root = doc.RootElement.Clone();
            doc.Dispose();
            Interlocked.Increment(ref _inflight);
            _ = Task.Run(() =>
            {
                try { Handle(root); }
                catch (Exception ex)
                {
                    WriteFrame(new { op = "log", level = "error", message = ex.Message });
                }
                finally { Interlocked.Decrement(ref _inflight); }
            });
        }

        // stdin EOF：限时排空在途请求（脚本化一次性调用），再关会话退出
        if (Interlocked.Exchange(ref _exiting, 1) == 0)
        {
            DrainInflight(TimeSpan.FromSeconds(10));
            _manager.CloseAll();
        }
        return 0;
    }

    private static string? ParseDataDir(string[] args)
    {
        for (var i = 0; i < args.Length - 1; i++)
        {
            if (args[i] == "--data-dir") return args[i + 1];
        }
        return null;
    }

    private static void Handle(JsonElement root)
    {
        var op = root.TryGetProperty("op", out var opEl) ? opEl.GetString() : null;
        if (op == "shutdown")
        {
            if (Interlocked.Exchange(ref _exiting, 1) == 0)
            {
                _ = Task.Run(() =>
                {
                    DrainInflight(TimeSpan.FromSeconds(5));
                    try { _manager.CloseAll(); } catch { /* 退出路径尽力 */ }
                    IoLock.Wait(500);
                    IoLock.Release();
                    Environment.Exit(0);
                });
            }
            return;
        }

        var callId = root.TryGetProperty("callId", out var idEl) ? idEl.GetString() ?? "" : "";
        try
        {
            var data = Dispatch(op, root);
            WriteFrame(new { op = "result", callId, ok = true, data });
        }
        catch (StorageException sex)
        {
            WriteFrame(new { op = "result", callId, ok = false, error = sex.Message, errorCode = sex.Code, retryable = sex.Retryable });
        }
        catch (Exception ex)
        {
            var mapped = StorageErrors.Map(ex);
            WriteFrame(new { op = "result", callId, ok = false, error = mapped.Message, errorCode = mapped.Code, retryable = mapped.Retryable });
        }
    }

    private static object? Dispatch(string? op, JsonElement root)
    {
        switch (op)
        {
            case "profiles.list":
                return _store.List().Select(StorageProfileStore.ToPublic).ToList();

            case "profiles.upsert":
            {
                if (!root.TryGetProperty("profile", out var profileEl) || profileEl.ValueKind != JsonValueKind.Object)
                    throw new StorageException("STORAGE_PROFILE_ERROR", "profiles.upsert 需要 profile 对象");
                var input = ParseProfile(profileEl);
                var fromSsh = OptString(root, "fromSshProfile");
                return StorageProfileStore.ToPublic(_store.Upsert(input, fromSsh));
            }

            case "profiles.remove":
                return _store.Remove(RequireString(root, "id"));

            case "profiles.test":
            {
                var profileId = RequireString(root, "profileId");
                return _manager.Run(profileId, provider => (object)new { ok = true, latencyMs = provider.Test() }, 30_000);
            }

            case "status":
                return new { sessions = _manager.ListSessions() };

            case "read":
                return ReadOp(root);

            case "write":
                return WriteOp(root);

            case "download":
                return DownloadOp(root);

            case "mkdir":
            {
                var profileId = RequireString(root, "profileId");
                var rel = StoragePaths.NormalizeRelative(OptString(root, "path"));
                var recursive = OptBool(root, "recursive") ?? true;
                _manager.Run(profileId, provider => { provider.Mkdir(rel, recursive); return true; });
                return new { path = rel };
            }

            case "delete":
                return DeleteOp(root);

            case "move":
                return MoveCopyOp(root, isMove: true);

            case "copy":
                return MoveCopyOp(root, isMove: false);

            case "close":
                _manager.Close(OptString(root, "profileId"));
                return true;

            default:
                throw new StorageException("STORAGE_UNSUPPORTED", $"未知 op: {op}");
        }
    }

    // ── 操作 ────────────────────────────────────────────────

    private static object ReadOp(JsonElement root)
    {
        var profileId = RequireString(root, "profileId");
        var rel = StoragePaths.NormalizeRelative(OptString(root, "path"));
        var maxBytes = Math.Clamp(OptInt(root, "maxBytes") ?? DefaultInlineBytes, 1_024, MaxInlineBytes);
        var maxEntries = Math.Clamp(OptInt(root, "maxEntries") ?? 500, 1, 2_000);

        return _manager.Run(profileId, provider =>
        {
            var entry = provider.Stat(rel)
                ?? throw StorageException.NotFound($"远端不存在：{(rel.Length == 0 ? "/" : rel)}");
            if (entry.Type == "dir")
            {
                var entries = provider.List(rel, maxEntries, out var truncated);
                return (object)new { kind = "dir", path = rel, entries, truncated };
            }

            var size = entry.Size ?? -1;
            if (size < 0 || size > maxBytes)
            {
                return new
                {
                    kind = "file",
                    path = rel,
                    size,
                    modifiedAt = entry.ModifiedAt,
                    truncated = true,
                    text = (string?)null,
                    hint = size < 0
                        ? "对象大小未知，请用 cloud_download 下载"
                        : $"文件 {size} 字节超过内联上限 {maxBytes}，请用 cloud_download 下载",
                };
            }

            using var stream = provider.OpenRead(rel);
            using var buffer = new MemoryStream();
            stream.CopyTo(buffer, 64 * 1024);
            var bytes = buffer.ToArray();
            if (!TryDecodeUtf8(bytes, out var text))
            {
                return new
                {
                    kind = "binary",
                    path = rel,
                    size,
                    modifiedAt = entry.ModifiedAt,
                    hint = "二进制文件，请用 cloud_download 下载到本地后用 read_file 打开",
                };
            }
            return new { kind = "text", path = rel, size, modifiedAt = entry.ModifiedAt, text, truncated = false };
        });
    }

    private static object WriteOp(JsonElement root)
    {
        var profileId = RequireString(root, "profileId");
        var rel = StoragePaths.NormalizeRelative(RequireString(root, "path"));
        if (rel.Length == 0) throw StorageException.Invalid("不能写入档案根目录");
        var overwrite = OptBool(root, "overwrite") ?? false;
        var createParents = OptBool(root, "createParents") ?? true;
        var content = OptString(root, "content");
        var localPath = OptString(root, "localPath");
        if (content is null && localPath is null)
            throw StorageException.Invalid("write 需要 content 或 localPath");
        if (content is not null && localPath is not null)
            throw StorageException.Invalid("content 与 localPath 只能二选一");

        if (localPath is not null)
        {
            var file = new FileInfo(localPath);
            if (!file.Exists) throw StorageException.NotFound($"本地文件不存在：{localPath}");
            return _manager.Run(profileId, provider =>
            {
                EnsureOverwrite(provider, rel, overwrite);
                using var fs = file.OpenRead();
                provider.Put(rel, fs, file.Length, createParents);
                return (object)new { path = rel, bytes = file.Length };
            });
        }

        var bytes = Encoding.UTF8.GetBytes(content!);
        return _manager.Run(profileId, provider =>
        {
            EnsureOverwrite(provider, rel, overwrite);
            using var ms = new MemoryStream(bytes);
            provider.Put(rel, ms, bytes.Length, createParents);
            return (object)new { path = rel, bytes = bytes.Length };
        });
    }

    private static object DownloadOp(JsonElement root)
    {
        var profileId = RequireString(root, "profileId");
        var rel = StoragePaths.NormalizeRelative(RequireString(root, "path"));
        if (rel.Length == 0) throw StorageException.Invalid("不能下载档案根目录");
        var overwrite = OptBool(root, "overwrite") ?? false;
        var target = Path.GetFullPath(RequireString(root, "localPath"));
        if (Directory.Exists(target)) throw StorageException.Invalid($"本地目标是目录：{target}");

        if (!overwrite && File.Exists(target))
            throw StorageException.AlreadyExists($"本地已存在：{target}（overwrite=true 可覆盖）");
        var parent = Path.GetDirectoryName(target);
        if (!string.IsNullOrEmpty(parent)) Directory.CreateDirectory(parent);

        var tmp = target + ".cyrene-tmp-" + Guid.NewGuid().ToString("N")[..8];
        return _manager.Run(profileId, provider =>
        {
            var entry = provider.Stat(rel)
                ?? throw StorageException.NotFound($"远端不存在：{rel}");
            if (entry.Type == "dir") throw StorageException.Unsupported("不能下载目录（用 cloud_read 查看目录）");
            try
            {
                using (var fs = File.Create(tmp)) provider.Download(rel, fs);
                File.Move(tmp, target, overwrite: true);
            }
            catch
            {
                try { File.Delete(tmp); } catch { /* 尽力清理 */ }
                throw;
            }
            return (object)new { path = rel, localPath = target, bytes = entry.Size };
        });
    }

    private static object DeleteOp(JsonElement root)
    {
        var profileId = RequireString(root, "profileId");
        var recursive = OptBool(root, "recursive") ?? false;
        if (!root.TryGetProperty("paths", out var pathsEl) || pathsEl.ValueKind != JsonValueKind.Array)
            throw StorageException.Invalid("delete 需要 paths 数组");

        var paths = new List<string>();
        foreach (var item in pathsEl.EnumerateArray())
        {
            if (item.ValueKind == JsonValueKind.String)
            {
                var rel = StoragePaths.NormalizeRelative(item.GetString());
                if (rel.Length > 0) paths.Add(rel);
            }
        }
        if (paths.Count == 0) throw StorageException.Invalid("delete 的 paths 不能为空");

        return _manager.Run(profileId, provider =>
        {
            var deleted = new List<string>();
            var failed = new List<object>();
            foreach (var rel in paths)
            {
                try
                {
                    provider.Delete(rel, recursive);
                    deleted.Add(rel);
                }
                catch (StorageException ex)
                {
                    failed.Add(new { path = rel, errorCode = ex.Code, message = ex.Message });
                }
            }
            return (object)new { deleted, failed };
        });
    }

    private static object MoveCopyOp(JsonElement root, bool isMove)
    {
        var profileId = RequireString(root, "profileId");
        var from = StoragePaths.NormalizeRelative(RequireString(root, "from"));
        var to = StoragePaths.NormalizeRelative(RequireString(root, "to"));
        if (from.Length == 0 || to.Length == 0)
            throw StorageException.Invalid("不能移动/复制档案根目录");
        if (from == to)
            throw StorageException.Invalid("from 与 to 相同");
        var overwrite = OptBool(root, "overwrite") ?? false;

        return _manager.Run(profileId, provider =>
        {
            if (provider.Stat(from) is null)
                throw StorageException.NotFound($"远端不存在：{from}");
            if (!overwrite && provider.Stat(to) is not null)
                throw StorageException.AlreadyExists($"目标已存在：{to}（overwrite=true 可覆盖）");
            if (isMove) provider.Move(from, to, overwrite);
            else provider.Copy(from, to, overwrite);
            return (object)new { from, to };
        });
    }

    private static void EnsureOverwrite(IStorageProvider provider, string rel, bool overwrite)
    {
        if (!overwrite && provider.Stat(rel) is not null)
            throw StorageException.AlreadyExists($"远端已存在：{rel}（overwrite=true 可覆盖）");
    }

    // ── 解析 ────────────────────────────────────────────────

    private static StorageProfile ParseProfile(JsonElement el)
    {
        var endpoint = GetString(el, "endpoint") ?? "";
        return new StorageProfile
        {
            Id = GetString(el, "id") ?? "",
            Name = GetString(el, "name") ?? "",
            Protocol = GetString(el, "protocol") ?? "",
            Host = GetString(el, "host") ?? "",
            Port = GetInt(el, "port") ?? 0,
            Username = GetString(el, "username") ?? "",
            RootPath = GetString(el, "rootPath") ?? "/",
            TlsMode = GetString(el, "tlsMode") ?? "",
            AllowInvalidCert = GetBool(el, "allowInvalidCert") ?? false,
            Passive = GetBool(el, "passive") ?? true,
            AuthType = GetString(el, "authType") ?? "",
            PrivateKeyPath = GetString(el, "privateKeyPath"),
            BaseUrl = GetString(el, "baseUrl") ?? "",
            WebDavAuthType = GetString(el, "webdavAuthType") ?? "",
            Bucket = GetString(el, "bucket") ?? "",
            Endpoint = endpoint,
            Region = GetString(el, "region") ?? "",
            PathStyle = GetBool(el, "pathStyle") ?? endpoint.Length > 0,
            Password = GetString(el, "password"),
            Passphrase = GetString(el, "passphrase"),
            AccessKeyId = GetString(el, "accessKeyId"),
            SecretAccessKey = GetString(el, "secretAccessKey"),
            SessionToken = GetString(el, "sessionToken"),
        };
    }

    private static string RequireString(JsonElement root, string name)
    {
        var value = OptString(root, name);
        if (string.IsNullOrWhiteSpace(value))
            throw StorageException.Invalid($"{name} 不能为空");
        return value;
    }

    private static string? OptString(JsonElement root, string name)
        => root.TryGetProperty(name, out var el) && el.ValueKind == JsonValueKind.String ? el.GetString() : null;

    private static bool? OptBool(JsonElement root, string name)
        => root.TryGetProperty(name, out var el) && el.ValueKind is JsonValueKind.True or JsonValueKind.False ? el.GetBoolean() : null;

    private static int? OptInt(JsonElement root, string name)
        => root.TryGetProperty(name, out var el) && el.ValueKind == JsonValueKind.Number ? el.GetInt32() : null;

    private static string? GetString(JsonElement el, string name) => OptString(el, name);

    private static int? GetInt(JsonElement el, string name) => OptInt(el, name);

    private static bool? GetBool(JsonElement el, string name) => OptBool(el, name);

    private static bool TryDecodeUtf8(byte[] bytes, out string text)
    {
        var probe = bytes.AsSpan(0, Math.Min(bytes.Length, 8_000));
        if (probe.IndexOf((byte)0) >= 0) { text = ""; return false; }
        try
        {
            text = new UTF8Encoding(false, true).GetString(bytes);
            return true;
        }
        catch (DecoderFallbackException)
        {
            text = "";
            return false;
        }
    }

    private static void DrainInflight(TimeSpan timeout)
    {
        var deadline = DateTime.UtcNow + timeout;
        while (Volatile.Read(ref _inflight) > 0 && DateTime.UtcNow < deadline)
        {
            Thread.Sleep(20);
        }
    }

    private static void WriteFrame(object frame)
    {
        var json = JsonSerializer.Serialize(frame, new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
        });
        IoLock.Wait();
        try
        {
            _stdout.Write(Encoding.UTF8.GetBytes(json + "\n"));
            _stdout.Flush();
        }
        finally
        {
            IoLock.Release();
        }
    }
}

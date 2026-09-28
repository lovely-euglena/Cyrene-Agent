using System.IO;
using System.Text;
using System.Text.Json;

namespace CyreneNative.Ssh;

/// <summary>
/// SSH 托管宿主（cyrene-native --ssh-host）。
///
/// 常驻后台进程：持有 SSH 会话（有状态、跨工具调用复用），档案与凭据落 data-dir；
/// Electron 侧只做薄代理（native-ssh-host.ts + 工具注册）。
///
/// 协议（stdio JSON 行，与 --tool-host / --mcp-host 同构）：
///   ← {"op":"ready"}
///   → {"op":"profiles.list"}
///   → {"op":"profiles.upsert","callId":"c1","profile":{...}}
///   → {"op":"profiles.remove","callId":"c2","id":"..."}
///   → {"op":"open","callId":"c3","profileId":"..."}
///   → {"op":"exec","callId":"c4","profileId":"...","command":"...","cwd":"...","timeoutMs":120000}
///   → {"op":"close","callId":"c5","profileId":"..."}
///   → {"op":"status"}
///   → {"op":"shutdown"}
///   ← {"op":"result","callId":"c1","ok":true,"data":...}
///   ← {"op":"result","callId":"c2","ok":false,"error":"..."}
///   ← {"op":"log","level":"info|warn|error","message":"..."}
///
/// stdout 协议独占：诊断走 stderr/log 帧。
/// </summary>
internal static class SshHost
{
    private static SshProfileStore _store = null!;
    private static SshSessionManager _manager = null!;
    private static readonly SemaphoreSlim IoLock = new(1, 1);
    private static Stream _stdout = null!;

    public static int Run(string[] args)
    {
        _stdout = Console.OpenStandardOutput();
        var dataDir = ParseDataDir(args) ?? Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            "live2d-cyrene");
        _store = new SshProfileStore(dataDir);
        _manager = new SshSessionManager(_store);

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
            _ = Task.Run(() =>
            {
                try { Handle(root); }
                catch (Exception ex)
                {
                    WriteFrame(new { op = "log", level = "error", message = ex.Message });
                }
            });
        }

        _manager.CloseAll();
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
            _manager.CloseAll();
            Environment.Exit(0);
        }

        var callId = root.TryGetProperty("callId", out var idEl) ? idEl.GetString() ?? "" : "";
        try
        {
            var data = Dispatch(op, root);
            // 同步分支：直接 Object 返回
            WriteFrame(new { op = "result", callId, ok = true, data });
        }
        catch (Exception ex)
        {
            WriteFrame(new { op = "result", callId, ok = false, error = ex.Message });
        }
    }

    private static object? Dispatch(string? op, JsonElement root)
    {
        switch (op)
        {
            case "profiles.list":
                return _store.List().Select(SshProfileStore.ToPublic).ToList();

            case "profiles.upsert":
            {
                var profileElement = root.TryGetProperty("profile", out var p) && p.ValueKind == JsonValueKind.Object
                    ? p
                    : throw new InvalidOperationException("profiles.upsert 需要 profile 对象");
                var input = ParseProfile(profileElement);
                var saved = _store.Upsert(input);
                return SshProfileStore.ToPublic(saved);
            }

            case "profiles.remove":
            {
                var id = RequireString(root, "id");
                return _store.Remove(id);
            }

            case "status":
                return new { sessions = _manager.List() };

            case "open":
            {
                var profileId = RequireString(root, "profileId");
                _manager.OpenAsync(profileId).GetAwaiter().GetResult();
                return new { profileId, state = "ready" };
            }

            case "exec":
            {
                var profileId = RequireString(root, "profileId");
                var command = RequireString(root, "command");
                var cwd = root.TryGetProperty("cwd", out var c) && c.ValueKind == JsonValueKind.String
                    ? c.GetString()
                    : null;
                var timeoutMs = root.TryGetProperty("timeoutMs", out var t) && t.ValueKind == JsonValueKind.Number
                    ? t.GetInt32()
                    : 120_000;
                var result = _manager.ExecAsync(profileId, command, cwd, timeoutMs).GetAwaiter().GetResult();
                return result;
            }

            case "close":
            {
                var profileId = RequireString(root, "profileId");
                _manager.Close(profileId);
                return true;
            }

            default:
                throw new InvalidOperationException($"未知 op: {op}");
        }
    }

    private static string RequireString(JsonElement root, string name)
    {
        if (!root.TryGetProperty(name, out var el) || el.ValueKind != JsonValueKind.String)
            throw new InvalidOperationException($"{name} 必须是字符串");
        var value = el.GetString();
        if (string.IsNullOrWhiteSpace(value)) throw new InvalidOperationException($"{name} 不能为空");
        return value;
    }

    private static SshProfile ParseProfile(JsonElement element)
    {
        var profile = new SshProfile();
        if (element.TryGetProperty("id", out var id) && id.ValueKind == JsonValueKind.String) profile.Id = id.GetString() ?? "";
        if (element.TryGetProperty("name", out var name) && name.ValueKind == JsonValueKind.String) profile.Name = name.GetString() ?? "";
        if (element.TryGetProperty("host", out var host) && host.ValueKind == JsonValueKind.String) profile.Host = host.GetString() ?? "";
        if (element.TryGetProperty("username", out var user) && user.ValueKind == JsonValueKind.String) profile.Username = user.GetString() ?? "";
        if (element.TryGetProperty("port", out var port) && port.ValueKind == JsonValueKind.Number) profile.Port = port.GetInt32();
        if (element.TryGetProperty("authType", out var auth) && auth.ValueKind == JsonValueKind.String) profile.AuthType = auth.GetString() ?? "password";
        if (element.TryGetProperty("privateKeyPath", out var key) && key.ValueKind == JsonValueKind.String) profile.PrivateKeyPath = key.GetString();
        if (element.TryGetProperty("password", out var password) && password.ValueKind == JsonValueKind.String) profile.Password = password.GetString();
        if (element.TryGetProperty("passphrase", out var passphrase) && passphrase.ValueKind == JsonValueKind.String) profile.Passphrase = passphrase.GetString();
        return profile;
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

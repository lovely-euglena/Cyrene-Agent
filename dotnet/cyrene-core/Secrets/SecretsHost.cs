using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using System.Threading;
using CyreneNative.Secrets;

namespace CyreneNative.Secrets;

/// <summary>
/// 密钥库托管宿主（cyrene-native --secrets-host，Phase 1 / A1）。
///
/// 常驻后台进程：DPAPI vault 落 --data-dir；TS 经 CYRENE_SECRETS_HOST 开关拉起
/// （SecretsHostClient），模型/视觉/TTS/ASR 密钥读写全部经此，源 JSON 清痕。
///
/// 协议（stdio JSON 行，与 --ssh-host / --tool-host 同构；result 携带 data 信封）：
///   ← {"op":"ready"}
///   → {"op":"secret.get","callId","name"}            ← {"op":"result","callId","ok":true,"data":{"value":"…|null"}}
///   → {"op":"secret.put","callId","name","value"}     ← {"op":"result","callId","ok":true,"data":{}}
///   → {"op":"secret.delete","callId","name"}          ← {"op":"result","callId","ok":true,"data":{"removed":true|false}}
///   → {"op":"secret.list","callId"}                   ← {"op":"result","callId","ok":true,"data":{"entries":[{name,createdAt,updatedAt}]}}（无 value）
///   → {"op":"secret.import","callId","values":{…}}    ← {"op":"result","callId","ok":true,"data":{"imported":N}}
///   → {"op":"secret.status","callId"}                 ← {"op":"result","callId","ok":true,"data":{count,migrated,migratedAt,protector,available}}
///   → {"op":"secret.mark-migrated","callId"}          ← {"op":"result","callId","ok":true,"data":{}}
///   → {"op":"shutdown"}
/// 失败：{"op":"result","callId","ok":false,"error":"…","errorCode":"E_SECRET_…","retryable":false}（对齐 StorageHost 约定）
///
/// 读帧线程纪律（StorageHost 先例）：op 丢 Task.Run；EOF → 排空 → 退出。
/// </summary>
public static class SecretsHost
{
    private static readonly object IoLock = new();
    private static TextWriter _stdout = null!;

    /// <summary>protector 必须注入：native 用 DPAPI（Windows），冒烟壳用明文测试保护器。</summary>
    public static int Run(string[] args, ISecretProtector protector)
    {
        var dataDir = ParseDataDir(args);
        if (dataDir == null)
        {
            Console.Error.WriteLine("[secrets-host] missing --data-dir (protocol violation)");
            return 2;
        }

        _stdout = Console.Out;
        SecretVault vault;
        try { vault = new SecretVault(dataDir, protector); }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[secrets-host] vault 初始化失败: {ex.Message}");
            return 3;
        }

        WriteFrame(new { op = "ready" });

        string? line;
        while ((line = Console.ReadLine()) != null)
        {
            line = line.Trim();
            if (line.Length == 0) continue;
            JsonElement frame;
            try { frame = JsonDocument.Parse(line).RootElement.Clone(); }
            catch (JsonException) { continue; }

            var op = frame.TryGetProperty("op", out var opEl) && opEl.ValueKind == JsonValueKind.String ? opEl.GetString() : null;
            if (op == "shutdown") break;
            if (op == null) continue;

            // 顺序分发（与 StorageHost 的 Task.Run 不同）：vault 操作全是本地快操作，
            // 且 get/put/delete/list 间存在因果序（帧序即语义）——乱序会破坏迁移
            // import→status→mark 的次序，必须逐帧同步处理。
            try { Dispatch(vault, op, frame); }
            catch (Exception ex)
            {
                var callId = Str(frame, "callId");
                if (callId != null)
                    WriteFrame(new { op = "result", callId, ok = false, error = Trunc(ex.Message), errorCode = "E_SECRET_HOST_ERROR", retryable = false });
            }
        }
        return 0;
    }

    private static void Dispatch(SecretVault vault, string op, JsonElement frame)
    {
        var callId = Str(frame, "callId");
        switch (op)
        {
            case "secret.get":
            {
                var name = Str(frame, "name");
                string? value = null;
                try { value = name != null ? vault.Get(name) : null; }
                catch (Exception ex) { Fail(callId, "E_SECRET_GET_FAILED", ex.Message); return; }
                Ok(callId, new { value });
                return;
            }
            case "secret.put":
            {
                var name = Str(frame, "name");
                var value = Str(frame, "value");
                if (name == null || value == null || value.Length == 0)
                { Fail(callId, "E_SECRET_BAD_REQUEST", "name/value required（空 value 拒绝——清 key 用 secret.delete）"); return; }
                try { vault.Put(name, value); }
                catch (Exception ex) { Fail(callId, "E_SECRET_PUT_FAILED", ex.Message); return; }
                Ok(callId, new { });
                return;
            }
            case "secret.delete":
            {
                var name = Str(frame, "name");
                if (name == null) { Fail(callId, "E_SECRET_BAD_REQUEST", "name required"); return; }
                var removed = vault.Delete(name);
                Ok(callId, new { removed });
                return;
            }
            case "secret.list":
            {
                var entries = vault.List();
                Ok(callId, new { entries });
                return;
            }
            case "secret.import":
            {
                if (!frame.TryGetProperty("values", out var values) || values.ValueKind != JsonValueKind.Object)
                { Fail(callId, "E_SECRET_BAD_REQUEST", "values object required"); return; }
                var imported = 0;
                foreach (var p in values.EnumerateObject())
                {
                    if (p.Value.ValueKind != JsonValueKind.String) continue;
                    vault.Put(p.Name, p.Value.GetString() ?? "");
                    imported++;
                }
                Ok(callId, new { imported });
                return;
            }
            case "secret.status":
            {
                Ok(callId, new
                {
                    count = vault.Count,
                    migrated = vault.MigratedAt != null,
                    migratedAt = vault.MigratedAt?.ToString("o"),
                    protector = vault.Protector.Scheme,
                    available = vault.ProtectorAvailable,
                });
                return;
            }
            case "secret.mark-migrated":
            {
                vault.MarkMigrated();
                Ok(callId, new { });
                return;
            }
            default:
                Fail(callId, "E_SECRET_BAD_REQUEST", $"unknown op: {op}");
                return;
        }
    }

    private static string? Str(JsonElement frame, string prop)
        => frame.TryGetProperty(prop, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    private static void Ok(string? callId, object data)
    {
        if (callId != null) WriteFrame(new { op = "result", callId, ok = true, data });
    }

    private static void Fail(string? callId, string code, string message)
    {
        if (callId != null)
            WriteFrame(new { op = "result", callId, ok = false, error = Trunc(message), errorCode = code, retryable = false });
    }

    private static string Trunc(string s) => s.Length <= 300 ? s : s[..300];

    /// <summary>共享 --data-dir 解析（Program.cs 的 --llm-host 复用）。</summary>
    public static string? ParseDataDir(string[] args)
    {
        for (var i = 0; i < args.Length - 1; i++)
            if (args[i] == "--data-dir") return args[i + 1];
        return null;
    }

    private static void WriteFrame(object frame)
    {
        var json = JsonSerializer.Serialize(frame, new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
        });
        lock (IoLock)
        {
            _stdout.Write(json + "\n");
            _stdout.Flush();
        }
    }
}

using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace CyreneNative.Sync;

/// <summary>
/// 云端昔涟 · 同步协议 v0：事件读取器与校验器（C# 侧）。
///
/// 契约权威：docs/specs/2026-10-04-sync-protocol-v0.md + fixtures/sync-protocol/
/// （双端共享测试向量；TS 对照实现 src/main/sync/sync-protocol.ts）。
/// 纯函数零 I/O：JSONL 文本 → 规范化事件序列 + 错误清单：
/// - 行级容错：跳过空白行；末条非空行 JSON 不完整 ⇒ 修剪（TruncatedTail），
///   其余坏行记 E_SYNC_BAD_JSON；
/// - 幂等去重：首见 EventId 保留，重复进 DroppedDuplicates（按出现序）；
/// - 确定性排序：(Lamport, DeviceId 序数, Seq)；全同键保持输入序（LINQ 稳定排序）。
/// 校验规则、错误码与上述语义必须与 TS 侧逐字一致，由 fixtures 锁定。
/// </summary>
public static class SyncProtocolV0
{
    public const string ErrorBadJson = "E_SYNC_BAD_JSON";
    public const string ErrorEnvelope = "E_SYNC_ENVELOPE";
    public const string ErrorType = "E_SYNC_TYPE";
    public const string ErrorPayload = "E_SYNC_PAYLOAD";

    /// <summary>id 字段上限（UTF-16 码元，与 TS side 的 .length 对齐）。</summary>
    public const int MaxIdLength = 200;
    public const long MaxSafeInteger = 9007199254740991;

    public static readonly string[] EventTypes = ["session.create", "message.append", "turn_rewind", "tombstone"];

    /// <summary>CTA presentation patch 顶层键白名单（v0 仅校验键集合与 patchRevision）。</summary>
    public static readonly string[] PresentationPatchKeys =
    [
        "content", "reasoning", "reasoningBlocks", "processMessages", "agentRounds",
        "taskDelegations", "channelSource", "sticker", "toolExecutions", "runActivity",
        "runSnapshot", "ttsCacheKey", "ttsCacheVersion", "musicCard", "contextUsage", "delta",
    ];

    private static readonly HashSet<string> EventTypeSet = new(EventTypes, StringComparer.Ordinal);
    private static readonly HashSet<string> PresentationPatchKeySet = new(PresentationPatchKeys, StringComparer.Ordinal);
    private static readonly HashSet<string> EnvelopeKeySet =
    [
        "eventId", "sessionId", "type", "lamport", "deviceId", "seq", "ts", "payload", "prevHash", "hash",
    ];

    private static readonly Regex IdRegex = new(@"^[^\u0000-\u001f\u007f]{1,200}$", RegexOptions.Compiled);
    private static readonly Regex IsoUtcRegex = new(@"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$", RegexOptions.Compiled);
    private static readonly Regex Hex64Regex = new(@"^[0-9a-f]{64}$", RegexOptions.Compiled);

    /// <summary>JSONL 批读取：容错 → 校验 → 去重 → 规范排序。</summary>
    public static SyncReadResult ReadBatch(string jsonlText)
    {
        var result = new SyncReadResult();
        if (jsonlText.StartsWith('\uFEFF')) jsonlText = jsonlText[1..];
        var lines = jsonlText.Split('\n');
        var lastNonEmpty = -1;
        for (var i = 0; i < lines.Length; i++)
        {
            if (TrimLine(lines[i]).Length > 0) lastNonEmpty = i;
        }

        var seen = new HashSet<string>(StringComparer.Ordinal);
        for (var i = 0; i < lines.Length; i++)
        {
            var line = TrimLine(lines[i]);
            if (line.Length == 0) continue;
            JsonElement root;
            try
            {
                using var document = JsonDocument.Parse(line);
                root = document.RootElement.Clone();
            }
            catch (JsonException)
            {
                if (i == lastNonEmpty) result.TruncatedTail = true;
                else result.Errors.Add(new SyncReadError(i, ErrorBadJson));
                continue;
            }
            var code = ValidateEvent(root);
            if (code is not null)
            {
                result.Errors.Add(new SyncReadError(i, code));
                continue;
            }
            var syncEvent = ToEvent(root);
            if (!seen.Add(syncEvent.EventId))
            {
                result.DroppedDuplicates.Add(syncEvent.EventId);
                continue;
            }
            result.LineByEventId.TryAdd(syncEvent.EventId, i);
            result.Events.Add(syncEvent);
        }

        result.Events = result.Events
            .OrderBy(item => item.Lamport)
            .ThenBy(item => item.DeviceId, StringComparer.Ordinal)
            .ThenBy(item => item.Seq)
            .ToList();
        return result;
    }

    /// <summary>单事件校验：返回 null = 有效；错误码优先级 BAD_JSON &gt; ENVELOPE &gt; TYPE &gt; PAYLOAD。</summary>
    public static string? ValidateEvent(JsonElement value)
    {
        if (value.ValueKind != JsonValueKind.Object) return ErrorEnvelope;
        foreach (var property in value.EnumerateObject())
        {
            if (!EnvelopeKeySet.Contains(property.Name)) return ErrorEnvelope;
        }
        if (!TryGetId(value, "eventId", out _)) return ErrorEnvelope;
        if (!TryGetId(value, "sessionId", out _)) return ErrorEnvelope;
        if (!TryGetId(value, "deviceId", out _)) return ErrorEnvelope;
        if (!TryGetSafeInt(value, "lamport", out _) || !TryGetSafeInt(value, "seq", out _)) return ErrorEnvelope;
        if (!value.TryGetProperty("ts", out var ts) || ts.ValueKind != JsonValueKind.String || !IsoUtcRegex.IsMatch(ts.GetString()!))
        {
            return ErrorEnvelope;
        }
        if (!value.TryGetProperty("type", out var typeElement) || typeElement.ValueKind != JsonValueKind.String)
        {
            return ErrorEnvelope;
        }
        if (!OptionalField(value, "prevHash", field => field.ValueKind == JsonValueKind.String && Hex64Regex.IsMatch(field.GetString()!)))
        {
            return ErrorEnvelope;
        }
        if (!OptionalField(value, "hash", field => field.ValueKind == JsonValueKind.String && Hex64Regex.IsMatch(field.GetString()!)))
        {
            return ErrorEnvelope;
        }
        var type = typeElement.GetString()!;
        if (!EventTypeSet.Contains(type)) return ErrorType;
        if (!value.TryGetProperty("payload", out var payload) || payload.ValueKind != JsonValueKind.Object) return ErrorPayload;
        return ValidatePayload(type, payload) ? null : ErrorPayload;
    }

    private static bool ValidatePayload(string type, JsonElement payload) => type switch
    {
        "session.create" => HasOnlyKeys(payload, "title", "createdAt")
            && payload.TryGetProperty("title", out var title) && title.ValueKind == JsonValueKind.String
            && title.GetString()!.Length <= 200
            && payload.TryGetProperty("createdAt", out var createdAt)
            && createdAt.ValueKind == JsonValueKind.String && IsoUtcRegex.IsMatch(createdAt.GetString()!),
        "message.append" => ValidateMessageAppend(payload),
        "turn_rewind" => ValidateTurnRewind(payload),
        "tombstone" => HasOnlyKeys(payload, "targetUserTurnId", "reason")
            && TryGetId(payload, "targetUserTurnId", out _)
            && payload.TryGetProperty("reason", out var reason)
            && reason.ValueKind == JsonValueKind.String && reason.GetString() == "pending_withdrawn",
        _ => false,
    };

    private static bool ValidateMessageAppend(JsonElement payload)
    {
        if (!HasOnlyKeys(payload, "role", "text", "turnId", "presentation")) return false;
        if (!payload.TryGetProperty("role", out var role) || role.ValueKind != JsonValueKind.String) return false;
        var roleValue = role.GetString();
        if (roleValue != "user" && roleValue != "assistant") return false;
        if (!payload.TryGetProperty("text", out var text) || text.ValueKind != JsonValueKind.String) return false;
        if (roleValue == "user")
        {
            if (!TryGetId(payload, "turnId", out _)) return false;
        }
        else if (!OptionalField(payload, "turnId", field => field.ValueKind == JsonValueKind.String && IdRegex.IsMatch(field.GetString()!)))
        {
            return false;
        }
        return OptionalField(payload, "presentation", IsPresentationPatch);
    }

    private static bool ValidateTurnRewind(JsonElement payload)
    {
        if (!HasOnlyKeys(payload, "anchorUserTurnId", "disposition", "reason", "replacementUser", "revision")) return false;
        if (!TryGetId(payload, "anchorUserTurnId", out _)) return false;
        if (!payload.TryGetProperty("disposition", out var disposition) || disposition.ValueKind != JsonValueKind.String) return false;
        var dispositionValue = disposition.GetString();
        if (dispositionValue != "keep_user" && dispositionValue != "replace_user") return false;
        if (!payload.TryGetProperty("reason", out var reason) || reason.ValueKind != JsonValueKind.String) return false;
        var reasonValue = reason.GetString();
        if (reasonValue != "edit" && reasonValue != "regenerate") return false;
        if (dispositionValue == "replace_user")
        {
            if (!payload.TryGetProperty("replacementUser", out var replacement) || !IsReplacementUser(replacement)) return false;
            return payload.TryGetProperty("revision", out var revision) && IsSafeIntegerElement(revision, 1);
        }
        return !payload.TryGetProperty("replacementUser", out _) && !payload.TryGetProperty("revision", out _);
    }

    private static bool IsReplacementUser(JsonElement value) =>
        value.ValueKind == JsonValueKind.Object
        && HasOnlyKeys(value, "text")
        && value.TryGetProperty("text", out var text) && text.ValueKind == JsonValueKind.String;

    private static bool IsPresentationPatch(JsonElement value)
    {
        if (value.ValueKind != JsonValueKind.Object || !HasOnlyKeys(value, "patchRevision", "patch")) return false;
        if (!value.TryGetProperty("patchRevision", out var revision) || !IsSafeIntegerElement(revision, 1)) return false;
        if (!value.TryGetProperty("patch", out var patch) || patch.ValueKind != JsonValueKind.Object) return false;
        var count = 0;
        foreach (var property in patch.EnumerateObject())
        {
            count++;
            if (!PresentationPatchKeySet.Contains(property.Name)) return false;
        }
        return count > 0;
    }

    private static bool TryGetId(JsonElement obj, string name, out string value)
    {
        value = "";
        if (!obj.TryGetProperty(name, out var element) || element.ValueKind != JsonValueKind.String) return false;
        var text = element.GetString()!;
        value = text;
        return IdRegex.IsMatch(text);
    }

    private static bool TryGetSafeInt(JsonElement obj, string name, out long value)
    {
        value = 0;
        if (!obj.TryGetProperty(name, out var element) || !IsSafeIntegerElement(element, 0)) return false;
        value = (long)element.GetDouble();
        return true;
    }

    /// <summary>JSON 数字是否构成 [min, 2^53-1] 内的整数（与 JS Number.isSafeInteger 对齐：<c>1.0</c> 视为 1）。</summary>
    private static bool IsSafeIntegerElement(JsonElement element, long min)
    {
        if (element.ValueKind != JsonValueKind.Number || !element.TryGetDouble(out var value)) return false;
        if (double.IsNaN(value) || double.IsInfinity(value)) return false;
        if (value < min || value > MaxSafeInteger) return false;
        return Math.Truncate(value) == value;
    }

    private static bool HasOnlyKeys(JsonElement obj, params string[] allowed)
    {
        foreach (var property in obj.EnumerateObject())
        {
            if (Array.IndexOf(allowed, property.Name) < 0) return false;
        }
        return true;
    }

    private static bool OptionalField(JsonElement obj, string name, Func<JsonElement, bool> predicate) =>
        !obj.TryGetProperty(name, out var element) || predicate(element);

    /// <summary>与 JS trim() 对齐（.NET Trim 不含 U+FEFF，JS 含）。</summary>
    private static string TrimLine(string line) => line.Trim().Trim('\uFEFF');

    private static SyncEventV0 ToEvent(JsonElement root)
    {
        return new SyncEventV0
        {
            EventId = root.GetProperty("eventId").GetString()!,
            SessionId = root.GetProperty("sessionId").GetString()!,
            Type = root.GetProperty("type").GetString()!,
            Lamport = (long)root.GetProperty("lamport").GetDouble(),
            DeviceId = root.GetProperty("deviceId").GetString()!,
            Seq = (long)root.GetProperty("seq").GetDouble(),
            Ts = root.GetProperty("ts").GetString()!,
            Payload = root.GetProperty("payload").Clone(),
            PrevHash = root.TryGetProperty("prevHash", out var prevHash) ? prevHash.GetString() : null,
            Hash = root.TryGetProperty("hash", out var hash) ? hash.GetString() : null,
        };
    }
}

/// <summary>批读取结果。</summary>
public sealed class SyncReadResult
{
    /// <summary>校验通过的事件，已去重 + 规范排序。可被 LINQ 排序重赋。</summary>
    public List<SyncEventV0> Events { get; set; } = [];

    /// <summary>坏行清单（输入序）。</summary>
    public List<SyncReadError> Errors { get; } = [];

    /// <summary>因 EventId 重复被丢弃的事件（按出现序，可能重复出现同一 id）。</summary>
    public List<string> DroppedDuplicates { get; } = [];

    /// <summary>eventId → 输入 0 基物理行号（首见；与 <see cref="SyncReadError.Index"/> 同一空间）。</summary>
    public Dictionary<string, int> LineByEventId { get; } = new(StringComparer.Ordinal);

    /// <summary>末条非空行 JSON 不完整（半截批，建议从上一游标重拉）。</summary>
    public bool TruncatedTail { get; set; }
}

/// <summary>坏行（Index 为 0 基物理行号，含被跳过的空白行）。</summary>
public sealed record SyncReadError(int Index, string Code);

/// <summary>v0 事件（JsonPropertyName 锁定 wire 格式，不受宿主 SerializerOptions 影响）。</summary>
public sealed class SyncEventV0
{
    [JsonPropertyName("eventId")] public required string EventId { get; init; }
    [JsonPropertyName("sessionId")] public required string SessionId { get; init; }
    [JsonPropertyName("type")] public required string Type { get; init; }
    [JsonPropertyName("lamport")] public long Lamport { get; init; }
    [JsonPropertyName("deviceId")] public required string DeviceId { get; init; }
    [JsonPropertyName("seq")] public long Seq { get; init; }
    [JsonPropertyName("ts")] public required string Ts { get; init; }
    [JsonPropertyName("payload")] public required JsonElement Payload { get; init; }
    [JsonPropertyName("prevHash")] public string? PrevHash { get; init; }
    [JsonPropertyName("hash")] public string? Hash { get; init; }
}

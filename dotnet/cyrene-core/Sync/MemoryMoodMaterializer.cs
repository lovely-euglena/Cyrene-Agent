using System.Text.Json;

namespace CyreneNative.Sync;

/// <summary>
/// 记忆与心情物化器（设计 §2）：纯函数折叠 { memories, mood }。
///
/// 输入约定：已去重 + 规范序（lamport, deviceId, seq）的事件（readBatch 的输出）。
/// 折叠规则：
/// - memory.write op=upsert：memories[memoryId] = { content, weight, pinned }（后写覆盖）；
/// - memory.write op=delete：sticky 墓碑（删除后同 id 的更晚 upsert 忽略，不复活）；
/// - mood.shift：mood = feeling（后写覆盖）；
/// - 其它类型：no-op（不参与本物化）。
/// 与 TS 侧 memory-mood-materializer.ts 镜像，由 fixtures/sync-protocol/materialize-cases 锁定。
/// </summary>
public static class MemoryMoodMaterializer
{
    public static MemoryMoodMaterializeResult Materialize(IReadOnlyList<SyncEventV0> events)
    {
        var result = new MemoryMoodMaterializeResult();
        var deleted = new HashSet<string>(StringComparer.Ordinal);
        foreach (var syncEvent in events)
        {
            switch (syncEvent.Type)
            {
                case "memory.write":
                    ApplyMemoryWrite(syncEvent.Payload, result.Memories, deleted);
                    break;
                case "mood.shift":
                    if (syncEvent.Payload.TryGetProperty("feeling", out var feeling)
                        && feeling.ValueKind == JsonValueKind.String)
                    {
                        result.Mood = feeling.GetString();
                    }
                    break;
            }
        }
        return result;
    }

    private static void ApplyMemoryWrite(JsonElement payload, Dictionary<string, MemoryEntry> memories, HashSet<string> deleted)
    {
        if (!payload.TryGetProperty("memoryId", out var idElement) || idElement.ValueKind != JsonValueKind.String) return;
        var memoryId = idElement.GetString()!;
        if (!payload.TryGetProperty("op", out var opElement) || opElement.ValueKind != JsonValueKind.String) return;
        switch (opElement.GetString())
        {
            case "delete":
                deleted.Add(memoryId);
                memories.Remove(memoryId);
                break;
            case "upsert" when !deleted.Contains(memoryId):
                if (!payload.TryGetProperty("content", out var contentElement) || contentElement.ValueKind != JsonValueKind.String) return;
                if (!payload.TryGetProperty("weight", out var weightElement) || weightElement.ValueKind != JsonValueKind.Number) return;
                var pinned = payload.TryGetProperty("pinned", out var pinnedElement) && pinnedElement.ValueKind == JsonValueKind.True;
                memories[memoryId] = new MemoryEntry(contentElement.GetString()!, (long)weightElement.GetDouble(), pinned);
                break;
        }
    }
}

/// <summary>物化结果：memories（memoryId → 快照；被删除 / 未出现的条目不出现）+ mood（无心情事件时 null）。</summary>
public sealed class MemoryMoodMaterializeResult
{
    public Dictionary<string, MemoryEntry> Memories { get; } = new(StringComparer.Ordinal);
    public string? Mood { get; set; }
}

/// <summary>记忆快照（物化输出；weight 为整数快照）。</summary>
public sealed record MemoryEntry(string Content, long Weight, bool Pinned);

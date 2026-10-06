using System.Text.Json;
using CyreneNative.Sync;

namespace CyreneSmoke;

/// <summary>
/// 记忆/心情物化契约自测（cyrene-smoke --selftest sync-materialize [casesDir]）：
/// 用 C# 读取器跑 fixtures/sync-protocol/materialize-cases：
/// readBatch(input) → 断言 errors / droppedDuplicates（给出时）→ 物化折叠 → 深比较 { memories, mood }。
/// 退出码 = 失败数。与 TS 侧（npx vitest run src/main/sync）共用同一套向量，结果必须一致。
/// </summary>
internal static class SyncMaterializeSelfTest
{
    public static int Run(string casesDir)
    {
        if (!Directory.Exists(casesDir))
        {
            Console.WriteLine($"[FAIL] sync-materialize cases 目录不存在: {casesDir}");
            Console.WriteLine("SELFTEST sync-materialize: 1 FAILURES");
            return 1;
        }
        var failures = 0;
        var files = Directory.GetFiles(casesDir, "*.json");
        Array.Sort(files, StringComparer.Ordinal);
        foreach (var file in files)
        {
            var name = Path.GetFileName(file);
            string detail;
            bool ok;
            try
            {
                using var document = JsonDocument.Parse(File.ReadAllText(file));
                var root = document.RootElement;
                var input = root.GetProperty("input").GetString() ?? "";
                var expect = root.GetProperty("expect");
                var batch = SyncProtocolV0.ReadBatch(input);
                ok = CompareRead(batch, expect, out detail)
                    && CompareMaterialized(MemoryMoodMaterializer.Materialize(batch.Events), expect, out detail);
            }
            catch (Exception ex)
            {
                ok = false;
                detail = ex.Message;
            }
            if (ok)
            {
                Console.WriteLine($"[PASS] {name}");
            }
            else
            {
                failures++;
                Console.WriteLine($"[FAIL] {name} — {detail}");
            }
        }
        Console.WriteLine(failures == 0
            ? $"SELFTEST sync-materialize: ALL PASS（{files.Length} fixtures）"
            : $"SELFTEST sync-materialize: {failures} FAILURES");
        return failures;
    }

    /// <summary>读取层断言：errors / droppedDuplicates 仅在 expect 给出时比较（README 物化契约）。</summary>
    private static bool CompareRead(SyncReadResult result, JsonElement expect, out string detail)
    {
        if (expect.TryGetProperty("errors", out var errorsElement))
        {
            var expectedErrors = errorsElement.EnumerateArray()
                .Select(item => (Index: item.GetProperty("index").GetInt32(), Code: item.GetProperty("code").GetString() ?? ""))
                .ToArray();
            if (expectedErrors.Length != result.Errors.Count)
            {
                detail = $"errors 数量: got {result.Errors.Count} want {expectedErrors.Length}";
                return false;
            }
            for (var i = 0; i < expectedErrors.Length; i++)
            {
                if (result.Errors[i].Index != expectedErrors[i].Index || result.Errors[i].Code != expectedErrors[i].Code)
                {
                    detail = $"errors[{i}]: got ({result.Errors[i].Index},{result.Errors[i].Code}) want ({expectedErrors[i].Index},{expectedErrors[i].Code})";
                    return false;
                }
            }
        }

        if (expect.TryGetProperty("droppedDuplicates", out var droppedElement))
        {
            var expectedDropped = droppedElement.EnumerateArray().Select(item => item.GetString() ?? "").ToArray();
            if (!expectedDropped.SequenceEqual(result.DroppedDuplicates, StringComparer.Ordinal))
            {
                detail = $"droppedDuplicates: got [{string.Join(",", result.DroppedDuplicates)}] want [{string.Join(",", expectedDropped)}]";
                return false;
            }
        }

        detail = "";
        return true;
    }

    /// <summary>物化层深比较：memories 键集合 + 字段逐一；mood 可为 null（缺省按 null）。</summary>
    private static bool CompareMaterialized(MemoryMoodMaterializeResult actual, JsonElement expect, out string detail)
    {
        var expectedIds = new List<string>();
        if (expect.TryGetProperty("memories", out var memoriesElement))
        {
            foreach (var property in memoriesElement.EnumerateObject())
            {
                expectedIds.Add(property.Name);
                if (!actual.Memories.TryGetValue(property.Name, out var entry))
                {
                    detail = $"memories 缺少 {property.Name}";
                    return false;
                }
                var want = property.Value;
                var wantContent = want.GetProperty("content").GetString() ?? "";
                var wantWeight = (long)want.GetProperty("weight").GetDouble();
                var wantPinned = want.TryGetProperty("pinned", out var pinnedElement) && pinnedElement.GetBoolean();
                if (entry.Content != wantContent || entry.Weight != wantWeight || entry.Pinned != wantPinned)
                {
                    detail = $"memories[{property.Name}]: got ({entry.Content},{entry.Weight},{entry.Pinned})"
                        + $" want ({wantContent},{wantWeight},{wantPinned})";
                    return false;
                }
            }
        }
        if (actual.Memories.Count != expectedIds.Count)
        {
            var extras = actual.Memories.Keys.Except(expectedIds, StringComparer.Ordinal).ToArray();
            detail = $"memories 多余键 [{string.Join(",", extras)}]";
            return false;
        }

        if (!expect.TryGetProperty("mood", out var moodElement) || moodElement.ValueKind == JsonValueKind.Null)
        {
            if (actual.Mood is not null)
            {
                detail = $"mood: got {actual.Mood.Feeling} want null";
                return false;
            }
        }
        else
        {
            var wantFeeling = moodElement.TryGetProperty("feeling", out var feelingElement) ? feelingElement.GetString() : null;
            var gotFeeling = actual.Mood?.Feeling;
            if (gotFeeling != wantFeeling)
            {
                detail = $"mood: got {gotFeeling ?? "null"} want {wantFeeling ?? "null"}";
                return false;
            }
        }

        detail = "";
        return true;
    }
}

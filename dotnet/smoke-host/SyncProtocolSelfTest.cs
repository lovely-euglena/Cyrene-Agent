using System.Text.Json;
using CyreneNative.Sync;

namespace CyreneSmoke;

/// <summary>
/// 同步协议 v0 契约自测（cyrene-smoke --selftest sync-protocol [casesDir]）：
/// 用 C# 读取器跑 fixtures/sync-protocol/cases，退出码 = 失败数。
/// 与 TS 侧（npx vitest run src/main/sync）共用同一套向量，结果必须一致。
/// </summary>
internal static class SyncProtocolSelfTest
{
    public static int Run(string casesDir)
    {
        if (!Directory.Exists(casesDir))
        {
            Console.WriteLine($"[FAIL] sync-protocol cases 目录不存在: {casesDir}");
            Console.WriteLine("SELFTEST sync-protocol: 1 FAILURES");
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
                ok = Compare(SyncProtocolV0.ReadBatch(input), expect, out detail);
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
            ? $"SELFTEST sync-protocol: ALL PASS（{files.Length} fixtures）"
            : $"SELFTEST sync-protocol: {failures} FAILURES");
        return failures;
    }

    private static bool Compare(SyncReadResult result, JsonElement expect, out string detail)
    {
        var expectedIds = expect.TryGetProperty("events", out var eventsElement)
            ? eventsElement.EnumerateArray().Select(item => item.GetString() ?? "").ToArray()
            : Array.Empty<string>();
        var actualIds = result.Events.Select(item => item.EventId).ToArray();
        if (!expectedIds.SequenceEqual(actualIds, StringComparer.Ordinal))
        {
            detail = $"events: got [{string.Join(",", actualIds)}] want [{string.Join(",", expectedIds)}]";
            return false;
        }

        var expectedErrors = expect.TryGetProperty("errors", out var errorsElement)
            ? errorsElement.EnumerateArray()
                .Select(item => (Index: item.GetProperty("index").GetInt32(), Code: item.GetProperty("code").GetString() ?? ""))
                .ToArray()
            : Array.Empty<(int Index, string Code)>();
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

        var expectedDropped = expect.TryGetProperty("droppedDuplicates", out var droppedElement)
            ? droppedElement.EnumerateArray().Select(item => item.GetString() ?? "").ToArray()
            : Array.Empty<string>();
        if (!expectedDropped.SequenceEqual(result.DroppedDuplicates, StringComparer.Ordinal))
        {
            detail = $"droppedDuplicates: got [{string.Join(",", result.DroppedDuplicates)}] want [{string.Join(",", expectedDropped)}]";
            return false;
        }

        var expectedTruncated = expect.TryGetProperty("truncatedTail", out var truncatedElement) && truncatedElement.GetBoolean();
        if (expectedTruncated != result.TruncatedTail)
        {
            detail = $"truncatedTail: got {result.TruncatedTail} want {expectedTruncated}";
            return false;
        }

        detail = "";
        return true;
    }
}

namespace CyreneNative.Tools;

/// <summary>
/// 工具变更证据（ToolFileChange）构建——与 TS registry/tool-evidence.ts 同构。
///
/// evidence 帧协议 v1（2026-10-03）：写类工具经 ToolHost result 帧返回的 `data`
/// 仍是完整工具输出 JSON，且必须包含 `changes: ToolFileChange[]` 字段；TS 宿主侧
/// tool-round / tool-dispatcher 复用 extractFileChangesFromOutput 提取并渲染
/// Diff Review 卡片——与 TS 工具轨同一契约，不新增帧类型。
/// review 基线（captureBefore）与覆盖防骤降（checkOverwriteDrop）属 TS 策略层，
/// 由宿主包装器在调用前执行；本类只负责输出证据的构造与上限裁剪。
///
/// 上限对齐（防止撑爆消息存储）：单文件 60 行 / 累计 200 行 / 单行 200 字符。
/// </summary>
internal static class ToolEvidence
{
    public const int MaxLinesPerFile = 60;
    public const int MaxTotalLines = 200;
    public const int MaxLineChars = 200;

    /// <summary>单行裁剪：超过 200 字符截断并加省略号（与 TS clipLine 一致）。</summary>
    public static string ClipLine(string text)
        => text.Length > MaxLineChars ? text[..MaxLineChars] + "…" : text;

    /// <summary>行数统计（按 LF 拆分、末尾空行不计——与 TS countLines 一致）。</summary>
    public static int CountLines(string? text)
    {
        if (string.IsNullOrEmpty(text)) return 0;
        var lines = text.Split('\n');
        return lines[^1].Length == 0 ? lines.Length - 1 : lines.Length;
    }

    /// <summary>整文件新增/删除 diff（全部行；调用方先按上限裁剪行源）。</summary>
    public static List<object> BuildFullFileDiff(IEnumerable<string> lines, string mode)
        => lines.Select(line => (object)new { type = mode, text = ClipLine(line) }).ToList();

    /// <summary>精确替换区域 diff：先全部 remove 再全部 add（与 TS buildReplacedDiff 一致，无 context）。</summary>
    public static List<object> BuildReplacedDiff(IEnumerable<string> beforeLines, IEnumerable<string> afterLines)
    {
        var lines = new List<object>();
        foreach (var text in beforeLines) lines.Add(new { type = "remove", text = ClipLine(text) });
        foreach (var text in afterLines) lines.Add(new { type = "add", text = ClipLine(text) });
        return lines;
    }

    /// <summary>
    /// 汇总变更并施加总量上限（与 TS finalizeFileChanges 一致）：
    /// 超过每文件上限：截断 diff 行并置 truncated（统计数字保留）；
    /// 超过总上限：后续变更移除 diff 只留统计。
    /// </summary>
    public static void Finalize(List<Dictionary<string, object?>> changes)
    {
        var total = 0;
        foreach (var change in changes)
        {
            if (change.TryGetValue("diff", out var raw) && raw is List<object> { Count: > 0 } diff)
            {
                if (total >= MaxTotalLines)
                {
                    change.Remove("diff");
                    change["truncated"] = true;
                    continue;
                }
                var budget = Math.Min(MaxLinesPerFile, MaxTotalLines - total);
                if (diff.Count > budget)
                {
                    change["diff"] = diff.GetRange(0, budget);
                    change["truncated"] = true;
                    total = MaxTotalLines;
                }
                else
                {
                    total += diff.Count;
                }
            }
        }
    }
}

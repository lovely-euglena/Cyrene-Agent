using System.Text.Json;

namespace CyreneNative.Rag;

/// <summary>
/// RagHost 扩展 op（E2 补全计划缺口）：
///   list     —— 按 source 列条目（TS getEntriesBySource 对接）
///   delete   —— 按 ids / importId 删（TS deleteEntriesByIds 对接）
///   prune    —— 低权重清理
///   chunk    —— chunkText 移植（E6：滑动窗口 + Markdown 标题前缀，
///               与 src/main/rag/chunk.ts 语义对齐）
/// </summary>
internal sealed partial class RagHost
{
    private object List(JsonElement root)
    {
        var source = root.TryGetProperty("source", out var s) && s.ValueKind != JsonValueKind.Null
            ? s.GetString() : null;
        var results = new List<object>();
        using var cmd = _db!.CreateCommand();
        cmd.CommandText = source is null
            ? "SELECT id, text, source, weight, created_at, last_recalled_at, metadata FROM entries"
            : "SELECT id, text, source, weight, created_at, last_recalled_at, metadata FROM entries WHERE source = @s";
        if (source is not null)
        {
            var p = cmd.CreateParameter(); p.ParameterName = "@s"; p.Value = source; cmd.Parameters.Add(p);
        }
        using var r = cmd.ExecuteReader();
        while (r.Read())
        {
            results.Add(new
            {
                id = r.GetString(0),
                text = r.GetString(1),
                source = r.GetString(2),
                weight = r.GetDouble(3),
                createdAt = r.GetInt64(4),
                lastRecalledAt = r.GetInt64(5),
                metadata = r.IsDBNull(6) ? (JsonElement?)null : JsonDocument.Parse(r.GetString(6)).RootElement,
            });
        }
        return new { count = results.Count, entries = results };
    }

    private object Delete(JsonElement root)
    {
        var deleted = 0;
        using var tx = _db!.BeginTransaction();
        if (root.TryGetProperty("ids", out var ids) && ids.ValueKind == JsonValueKind.Array && ids.GetArrayLength() > 0)
        {
            foreach (var id in ids.EnumerateArray())
            {
                ExecIn(tx, "DELETE FROM entries WHERE id = @id", ("@id", id.GetString() ?? ""));
                ExecIn(tx, "DELETE FROM bm25 WHERE doc_id = @id", ("@id", id.GetString() ?? ""));
                deleted++;
            }
        }
        if (root.TryGetProperty("importId", out var imp))
        {
            var importId = imp.GetString() ?? "";
            var fileName = root.TryGetProperty("fileName", out var fn) && fn.ValueKind == JsonValueKind.String
                ? fn.GetString() : null;
            var where = fileName is null
                ? "WHERE json_extract(metadata, '$.importId') = @i"
                : "WHERE json_extract(metadata, '$.importId') = @i AND json_extract(metadata, '$.fileName') = @f";
            using var c = tx.Connection!.CreateCommand(); c.Transaction = tx; c.CommandText = $"DELETE FROM entries {where}";
            var p1 = c.CreateParameter(); p1.ParameterName = "@i"; p1.Value = importId; c.Parameters.Add(p1);
            if (fileName is not null)
            {
                var p2 = c.CreateParameter(); p2.ParameterName = "@f"; p2.Value = fileName; c.Parameters.Add(p2);
            }
            deleted += c.ExecuteNonQuery();
        }
        tx.Commit();
        return new { deleted };
    }

    private object Prune(JsonElement root)
    {
        var minWeight = root.TryGetProperty("minWeight", out var w) && w.ValueKind == JsonValueKind.Number
            ? w.GetDouble() : 0.1;
        using var tx = _db!.BeginTransaction();
        using var c = tx.Connection!.CreateCommand(); c.Transaction = tx;
        c.CommandText = "DELETE FROM entries WHERE weight < @w AND source != 'user_memory'";
        var p = c.CreateParameter(); p.ParameterName = "@w"; p.Value = minWeight; c.Parameters.Add(p);
        var n = c.ExecuteNonQuery();
        tx.Commit();
        return new { pruned = n };
    }

    // ── chunkText 移植（E6）──

    private const int DocumentChunkSize = 512;
    private const int DocumentChunkOverlap = 128;

    private static int EstimateTokens(string text)
    {
        var chinese = 0;
        foreach (var ch in text)
            if (ch >= '\u4e00' && ch <= '\u9fff') chinese++;
        var others = 0;
        var inWord = false;
        foreach (var ch in text)
        {
            var isCjk = ch >= '\u4e00' && ch <= '\u9fff';
            if (!isCjk && !char.IsWhiteSpace(ch)) { if (!inWord) { others++; inWord = true; } }
            else inWord = false;
        }
        return chinese + others;
    }

    private static int FindNextSentenceBoundary(string text, int pos)
    {
        for (var i = pos; i < text.Length; i++)
        {
            var c = text[i];
            if (c is '。' or '！' or '？' or '\n' or '.' or '!' or '?')
            {
                var j = i + 1;
                while (j < text.Length && "。！？\n.!?".IndexOf(text[j]) >= 0) j++;
                return j;
            }
        }
        return -1;
    }

    /// <summary>Markdown 标题前缀提取（最近一个 # 标题）。</summary>
    private static string? LastHeadingBefore(string text, int pos)
    {
        var best = (int?)null;
        for (var i = 0; i < Math.Min(pos, text.Length); i++)
        {
            if (text[i] == '#' && (i == 0 || text[i - 1] == '\n'))
            {
                var j = i;
                while (j < text.Length && text[j] == '#') j++;
                var end = text.IndexOf('\n', j);
                var title = text[j..(end < 0 ? text.Length : end)].Trim();
                if (title.Length > 0) best = j;
            }
        }
        if (best is null) return null;
        {
            var j = best.Value;
            while (j < text.Length && text[j] == '#') j++;
            var end = text.IndexOf('\n', j);
            return text[j..(end < 0 ? text.Length : end)].Trim();
        }
    }

    private object Chunk(JsonElement root)
    {
        var text = root.TryGetProperty("text", out var t) ? t.GetString() ?? "" : "";
        var source = root.TryGetProperty("source", out var s) ? s.GetString() ?? "doc" : "doc";
        var chunks = new List<object>();
        if (string.IsNullOrWhiteSpace(text)) return new { chunks };

        var totalChars = text.Length;
        var chunkSize = root.TryGetProperty("chunkSize", out var cs) && cs.ValueKind == JsonValueKind.Number
            ? (int)cs.GetInt32() : DocumentChunkSize;
        var overlap = root.TryGetProperty("overlap", out var ov) && ov.ValueKind == JsonValueKind.Number
            ? (int)ov.GetInt32() : DocumentChunkOverlap;

        if (EstimateTokens(text) <= chunkSize)
        {
            chunks.Add(new { id = $"{source}_0", text, source, index = 0 });
            return new { chunks };
        }

        var step = chunkSize - overlap;
        var totalTokens = EstimateTokens(text);
        var tokensPerChar = totalTokens / (double)totalChars;
        var posStart = 0;
        var chunkIndex = 0;
        while (posStart < totalChars)
        {
            var startToken = (int)Math.Round(posStart * tokensPerChar);
            var endToken = startToken + chunkSize;
            var posEnd = (int)Math.Min(totalChars, Math.Round(endToken / tokensPerChar));
            if (posEnd >= totalChars) posEnd = totalChars;
            else
            {
                var boundary = FindNextSentenceBoundary(text, posEnd);
                if (boundary > 0 && boundary < totalChars) posEnd = Math.Min(boundary, posEnd + 64);
                else posEnd = Math.Min(posEnd + 32, totalChars);
            }
            if (posEnd <= posStart) posEnd = Math.Min(posStart + 1, totalChars);

            var heading = LastHeadingBefore(text, posStart);
            var body = text[posStart..posEnd].Trim();
            var chunkText = string.IsNullOrEmpty(heading) || body.StartsWith(heading)
                ? body
                : $"## {heading}\n{body}";

            chunks.Add(new { id = $"{source}_{chunkIndex}", text = chunkText, source, index = chunkIndex });
            chunkIndex++;

            if (posEnd >= totalChars) break;
            var nextStart = (int)Math.Round((startToken + step) / tokensPerChar);
            if (nextStart <= posStart) nextStart = posStart + 1;
            posStart = Math.Min(nextStart, totalChars - 1);
            if (posEnd == totalChars) break;
        }
        return new { chunks };
    }
}

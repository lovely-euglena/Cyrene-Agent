using System.Text.Json;

namespace CyreneEmbedSidecar;

/// <summary>
/// HuggingFace tokenizer.json (Unigram model) 的最小复刻，覆盖 bge-m3（XLM-R 系）：
///   - Metaspace pre-tokenizer（add_prefix_space / prepend_scheme=always）：
///     文本前置 "▁"，空格替换为 "▁"
///   - Unigram Viterbi：每段求 score 总和最大的切分，未知片段回退 <unk>
///   - TemplateProcessing post-processor：单句包 &lt;s&gt; … &lt;/s&gt;
///   - Precompiled charsmap normalizer 未复刻（NFKC 表，对中英文常见文本
///     近似恒等；verify 模式用 tokenIds 逐条对账，偏差可见）
/// </summary>
public sealed class HfUnigramTokenizer
{
    private readonly Dictionary<string, (int Id, float Score)> _vocab;
    // span 查找视图：Viterbi 内循环用 ReadOnlySpan<char> 查词表，
    // 消掉每个候选的 Substring 堆分配（内层是 O(n×24) 次查询）
    private readonly Dictionary<string, (int Id, float Score)>.AlternateLookup<ReadOnlySpan<char>> _vocabLookup;
    private readonly int _unkId;
    private readonly int _bosId;   // <s>
    private readonly int _eosId;   // </s>
    private readonly float _unkScore;

    private HfUnigramTokenizer(Dictionary<string, (int, float)> vocab, int unkId, int bosId, int eosId)
    {
        _vocab = vocab;
        _vocabLookup = vocab.GetAlternateLookup<ReadOnlySpan<char>>();
        _unkId = unkId;
        _bosId = bosId;
        _eosId = eosId;
        _unkScore = vocab.TryGetValue("<unk>", out var unk) ? unk.Item2 : -10.0f;
    }

    public int VocabSize => _vocab.Count;
    public int UnkId => _unkId;

    /// <summary>解析 tokenizer.json 构建分词器。</summary>
    public static HfUnigramTokenizer FromTokenizerJson(string tokenizerJsonPath)
    {
        using var doc = JsonDocument.Parse(File.ReadAllText(tokenizerJsonPath));
        var root = doc.RootElement;

        var model = root.GetProperty("model");
        if (model.GetProperty("type").GetString() != "Unigram")
        {
            throw new NotSupportedException(
                $"tokenizer.json model type {model.GetProperty("type").GetString()} is not Unigram; only XLM-R style is supported");
        }

        var vocab = new Dictionary<string, (int, float)>(capacity: 260_000);
        // ⚠️ JsonElement 数组索引器是 O(下标) 的线性跳读，for i + vocabArr[i]
        // 会退化成 O(n²)（250k 词条 ≈ 625 亿次访问）；必须用 EnumerateArray
        var idx = 0;
        foreach (var entry in model.GetProperty("vocab").EnumerateArray())
        {
            vocab[entry[0].GetString()!] = (idx, entry[1].GetSingle());
            idx++;
        }

        int unkId = model.TryGetProperty("unk_id", out var unkEl)
            ? unkEl.GetInt32()
            : vocab.GetValueOrDefault("<unk>", (0, 0f)).Item1;
        int bosId = vocab.GetValueOrDefault("<s>", (0, 0f)).Item1;
        int eosId = vocab.GetValueOrDefault("</s>", (0, 0f)).Item1;

        return new HfUnigramTokenizer(vocab, unkId, bosId, eosId);
    }

    /// <summary>分词（含前后特殊 token），返回 input_ids。</summary>
    public int[] EncodeToIds(string text)
    {
        var ids = new List<int>(capacity: text.Length / 2 + 8);
        ids.Add(_bosId);
        // 全链路 span/ids 直出：不产生中间 piece 字符串
        var normalized = NmtNormalize(text);
        normalized = normalized.Replace(' ', '▁');
        normalized = (normalized.Length > 0 && normalized[0] != '▁') ? "▁" + normalized : normalized;

        var segments = normalized.Split('▁', StringSplitOptions.RemoveEmptyEntries);
        foreach (var raw in segments)
        {
            if (raw.Length == 0) continue;
            // segment = "▁" + raw：直接在原 string 上偏移 1 构造 span，避免拼接分配
            AppendSegmentIds(ids, raw, prefixSpace: true);
        }
        ids.Add(_eosId);
        return ids.ToArray();
    }

    /// <summary>
    /// 对单个 segment（前导 "▁" 由 offset 表示，不实体化）做 Viterbi，
    /// 直接把 token ids 追加进 ids。
    /// </summary>
    private void AppendSegmentIds(List<int> ids, string raw, bool prefixSpace)
    {
        // 逻辑段 = "▁" + raw；物理上用 span 视图 [^1, len+1) 表示
        var n = raw.Length + 1;
        Span<char> segment = n <= 512 ? stackalloc char[512] : new char[n];
        segment[0] = '▁';
        raw.AsSpan().CopyTo(segment[1..]);

        // best[i] = 覆盖前 i 个字符的最大 score；from[i] = 最优前驱长度
        var best = new double[n + 1];
        var from = new int[n + 1];

        best[0] = 0.0;
        for (var i = 1; i <= n; i++)
        {
            double maxScore = double.NegativeInfinity;
            var maxLen = -1;
            for (var start = i - 1; start >= 0; start--)
            {
                // span 切片查词表：零堆分配（原先每个候选 Substring 一次分配）
                if (_vocabLookup.TryGetValue(segment.Slice(start, i - start), out var hit))
                {
                    var score = best[start] + hit.Score;
                    if (score > maxScore) { maxScore = score; maxLen = i - start; }
                }
                // 长片段尽早剪枝：Unigram 单字覆盖所有常见字符，超过 24 字符的
                // 无匹配前缀不可能再出现匹配（词表无超长中文 token）
                if (i - start > 24) break;
            }
            if (maxLen < 0)
            {
                // 该位置无词表匹配：单字符走 <unk>
                maxLen = 1;
                maxScore = best[i - 1] + _unkScore - 10.0;
            }
            best[i] = maxScore;
            from[i] = maxLen;
        }

        // 回溯：直接查 Id（不再构造 piece 字符串）
        var pos = n;
        var stackStart = ids.Count;
        while (pos > 0)
        {
            var len = from[pos];
            var pieceSpan = segment.Slice(pos - len, len);
            ids.Add(_vocabLookup.TryGetValue(pieceSpan, out var hit) ? hit.Id : _unkId);
            pos -= len;
        }
        // 回溯顺序是反的，就地反转刚追加的区段
        ids.Reverse(stackStart, ids.Count - stackStart);
    }

    /// <summary>
    /// NMT 风格 NFKC 近似归一化（全角→半角）。覆盖：
    ///   - U+FF01–FF5E（！－～）：线性偏移 -0xFEE0 → 对应 ASCII 0x21–0x7E
    ///     （全角标点、字母、数字）
    ///   - U+3000（　　全角空格）→ 半角空格
    ///   - U+FF0E 特例本就落在 FF 区间内（→ '.'），无需单列
    ///   - CJK 兼容 ideograph（U+F900 区）与希腊/西里尔全角形（U+FF21 区）
    ///     均被 FF 区间覆盖或保持原样（词表有对应 token 时不受影响）
    /// 大小写折叠（lowercase）不在此做——XLM-R charsmap 不做 case fold。
    /// </summary>
    private static string NmtNormalize(string text)
    {
        var needsNormalize = false;
        foreach (var ch in text)
        {
            if (ch is >= '\uFF01' and <= '\uFF5E' or '\u3000')
            {
                needsNormalize = true;
                break;
            }
        }
        if (!needsNormalize) return text;

        var chars = text.ToCharArray();
        for (var i = 0; i < chars.Length; i++)
        {
            var ch = chars[i];
            if (ch is >= '\uFF01' and <= '\uFF5E')
            {
                chars[i] = (char)(ch - 0xFEE0);
            }
            else if (ch == '\u3000')
            {
                chars[i] = ' ';
            }
        }
        return new string(chars);
    }
}

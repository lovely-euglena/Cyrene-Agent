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
    private readonly int _unkId;
    private readonly int _bosId;   // <s>
    private readonly int _eosId;   // </s>

    private HfUnigramTokenizer(Dictionary<string, (int, float)> vocab, int unkId, int bosId, int eosId)
    {
        _vocab = vocab;
        _unkId = unkId;
        _bosId = bosId;
        _eosId = eosId;
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
        foreach (var piece in SplitUnigram(text))
        {
            ids.Add(_vocab.TryGetValue(piece, out var hit) ? hit.Id : _unkId);
        }
        ids.Add(_eosId);
        return ids.ToArray();
    }

    /// <summary>
    /// Metaspace 预处理 + Unigram Viterbi。HF 的执行顺序是 pre-tokenize（按 ▁ 切段）
    /// 后对每段独立做 Unigram 编码，段边界不参与 merge。
    /// </summary>
    private IEnumerable<string> SplitUnigram(string text)
    {
        // NFKC 归一化：近似复刻 HF Precompiled charsmap（sentencepiece NMT_NFKC）。
        // 关键作用：全角标点（，：！）→ 半角、全角字母数字 → 半角。
        // 实测差例：中文文本的 "，" 归一化后是半角 ","（vocab id=4），
        // 不归一化则查表 miss 落 <unk>（id=3）——XLM-R vocab 无全角标点。
        //
        // 不用 string.Normalize(FormKC)：本工程 InvariantGlobalization=true
        // （NativeAOT 部署不依赖 ICU），Invariant 模式下 Normalize 是 no-op。
        // 手写全角→半角映射（U+FF01–FF5E 线性偏移 0xFEE0 + U+3000 全角空格），
        // 覆盖中英文文本 NFKC 差异的 99%+；verify 模式 tokenIds 对账兜底。
        var normalized = NmtNormalize(text);

        // Metaspace: prepend "▁"（prepend_scheme=always），空格 → "▁"
        normalized = normalized.Replace(' ', '▁');
        normalized = (normalized.Length > 0 && normalized[0] != '▁') ? "▁" + normalized : normalized;

        // Metaspace pre-tokenize：按 ▁ 切成段，每段保留前导 ▁
        // （"▁a▁b" → ["▁a", "▁b"]：split 之后把前导 ▁ 还给每段）
        var segments = normalized.Split('▁', StringSplitOptions.RemoveEmptyEntries);
        foreach (var raw in segments)
        {
            if (raw.Length == 0) continue;
            var segment = "▁" + raw;
            foreach (var piece in ViterbiSplit(segment))
            {
                yield return piece;
            }
        }
    }

    /// <summary>单段 Unigram Viterbi：score 和最大的切分路径。未知字符回退 <unk>。</summary>
    private IEnumerable<string> ViterbiSplit(string segment)
    {
        var n = segment.Length;
        if (n == 0) yield break;

        // best[i] = 覆盖前 i 个字符的最大 score；from[i] = 最优前驱长度
        // （heap 数组而非 stackalloc：中文长段无空格，段长可达数十万字符，
        //  stackalloc 大段会栈溢出——StackOverflowException 不可捕获）
        var best = new double[n + 1];
        var from = new int[n + 1];

        best[0] = 0.0;
        for (var i = 1; i <= n; i++)
        {
            double maxScore = double.NegativeInfinity;
            var maxLen = -1;
            for (var start = i - 1; start >= 0; start--)
            {
                var piece = segment.Substring(start, i - start);
                if (_vocab.TryGetValue(piece, out var hit))
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
                // 该位置无词表匹配：单字符走 <unk>（score 取 unk 概率的下界近似）
                maxLen = 1;
                maxScore = best[i - 1] + _vocab.GetValueOrDefault("<unk>").Score - 10.0;
            }
            best[i] = maxScore;
            from[i] = maxLen;
        }

        // 回溯
        var pieces = new List<string>(n);
        var pos = n;
        while (pos > 0)
        {
            var len = from[pos];
            pieces.Add(segment.Substring(pos - len, len));
            pos -= len;
        }
        for (var i = pieces.Count - 1; i >= 0; i--)
        {
            yield return pieces[i];
        }
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

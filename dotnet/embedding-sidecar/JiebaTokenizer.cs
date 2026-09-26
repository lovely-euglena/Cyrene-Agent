using System.Text.RegularExpressions;
using JiebaNet.Segmenter;
using JiebaNet.Segmenter.PosSeg;

namespace CyreneEmbedSidecar;

/// <summary>
/// BM25 分词器：@node-rs/jieba（jieba-rs）语义的 .NET 移植。
/// 与 TS 侧 retriever.ts 的 tokenize() 逐词对账（verify-tokenize 命令）：
///   - 纯 ASCII 文本走空格切分（tag=eng，不做 jieba）
///   - 否则 jieba.cut(hmm=true) → 自定义词重组（窗口匹配）→ 逐词 jieba.tag(hmm=true) 取首个标签
///   - 停用词表 / 词性集合 / 降权系数与 TS 同源（改动需双端同步）
/// </summary>
public static class JiebaTokenizer
{
    public sealed record Token(string Word, string Tag, bool IsStop, bool IsNoun);

    private static readonly Lazy<JiebaSegmenter> Segmenter = new(() => new JiebaSegmenter());
    private static readonly Lazy<PosSegmenter> Pos = new(() => new PosSegmenter());
    private static readonly Lazy<bool> ConfigReady = new(EnsureResources);

    private static readonly Regex AsciiOnly = new("^[a-zA-Z0-9\\s]+$", RegexOptions.Compiled);
    private static readonly Regex Whitespace = new("\\s+", RegexOptions.Compiled);

    /// <summary>常用停用词（与 TS retriever.ts STOP_WORDS 同源，~120 个）。</summary>
    private static readonly HashSet<string> StopWords = new(new[]
    {
        "的", "了", "是", "在", "我", "你", "他", "她", "它",
        "有", "不", "也", "就", "都", "这", "那", "还", "要",
        "和", "与", "或", "但", "而", "且", "及", "之", "为",
        "上", "下", "中", "里", "外", "前", "后", "左", "右",
        "到", "去", "来", "从", "把", "被", "让", "给", "对",
        "吗", "呢", "吧", "啊", "嘛", "哦", "嗯", "呀", "哇",
        "很", "太", "更", "最", "非", "没", "将", "已", "能",
        "会", "可", "以", "好", "多", "少", "大", "小", "真",
        "个", "些", "点", "样", "种", "些", "哪", "谁", "什",
        "做", "当", "看", "听", "说", "想", "觉", "知", "道",
        "过", "完", "着", "住", "得", "地", "于", "其", "该",
        "我们", "你们", "他们", "她们", "它们",
        "自己", "什么", "怎么", "为什么", "因为", "所以",
        "这个", "那个", "这些", "那些", "这里", "那里",
        "一个", "一种", "一些", "的话", "时候", "地方",
        "东西", "事情", "问题", "就是", "可以", "但是",
        "没有", "不要", "不是", "不会", "不能", "应该",
        "已经", "可能", "觉得", "知道", "告诉",
    });

    /// <summary>非名词/非动词的常见虚词性标签（BM25 降权）。</summary>
    private static readonly HashSet<string> StopTags = new(new[] { "u", "c", "p", "d", "r", "y", "o", "e", "m", "q", "f" });

    /// <summary>名词性标签（BM25 加权）。</summary>
    private static readonly HashSet<string> NounTags = new(new[] { "n", "nr", "ns", "nt", "nz", "ng", "vn", "an" });

    /// <summary>分词（jieba + 自定义词重组 + 纯 ASCII 快捷路径）。</summary>
    public static List<Token> Tokenize(string text, IReadOnlyCollection<string> customWords)
    {
        // 纯英文/数字文本走空格分词（jieba 不适合纯英文）—— 与 TS 同规则
        if (AsciiOnly.IsMatch(text))
        {
            return Whitespace.Split(text)
                .Where((w) => w.Length > 0)
                .Select((w) => new Token(w.ToLowerInvariant(), "eng", false, false))
                .ToList();
        }

        try
        {
            _ = ConfigReady.Value;
            var rawCuts = Segmenter.Value.Cut(text, cutAll: false, hmm: true).ToList();
            var mergedCuts = MergeCustomWords(rawCuts, customWords);

            var result = new List<Token>(mergedCuts.Count);
            foreach (var word in mergedCuts)
            {
                // 与 TS 一致：对每个合并后的词独立打标签，取首个标签；空结果回退 "x"
                var first = Pos.Value.Cut(word, hmm: true).FirstOrDefault();
                var tag = first?.Flag ?? "x";
                result.Add(new Token(
                    word.ToLowerInvariant(),
                    tag,
                    StopWords.Contains(word) || StopTags.Contains(tag),
                    NounTags.Contains(tag)));
            }
            return result;
        }
        catch
        {
            // jieba 失败回退单字切分（与 TS catch 分支同构）
            var tokens = new List<Token>();
            foreach (Match m in Regex.Matches(text, "[\\u4e00-\\u9fff]|[a-zA-Z]+|\\d+"))
            {
                var s = m.Value;
                if (Regex.IsMatch(s, "[\\u4e00-\\u9fff]"))
                {
                    foreach (var c in s)
                    {
                        tokens.Add(new Token(c.ToString(), "x", StopWords.Contains(c.ToString()), false));
                    }
                }
                else
                {
                    tokens.Add(new Token(s.ToLowerInvariant(), "eng", false, false));
                }
            }
            return tokens;
        }
    }

    /// <summary>
    /// JiebaNet.Segmenter 1.0.6 把词典等资源内嵌在 DLL，但运行时按
    /// AppDomain 数据 "JiebaConfigFileDir" + "/Resources/" 从磁盘加载
    /// （SDK 项目不部署 Resources/）。这里首次使用时把内嵌资源释放到
    /// 临时目录并设置 AppDomain 数据指路（幂等，跨进程共享）。
    /// </summary>
    private static bool EnsureResources()
    {
        var asm = typeof(JiebaSegmenter).Assembly;
        const string prefix = "JiebaNet.Segmenter.Resources.";
        var baseDir = Path.Combine(Path.GetTempPath(), "cyrene-jieba-v1");
        var dir = Path.Combine(baseDir, "Resources");
        Directory.CreateDirectory(dir);
        foreach (var name in asm.GetManifestResourceNames())
        {
            if (!name.StartsWith(prefix, StringComparison.Ordinal)) continue;
            var file = Path.Combine(dir, name[prefix.Length..]);
            if (File.Exists(file)) continue;
            try
            {
                using var stream = asm.GetManifestResourceStream(name)!;
                using var fs = File.Create(file);
                stream.CopyTo(fs);
                Console.Error.WriteLine($"[jieba] extracted {name[prefix.Length..]} ({fs.Length / 1024} KB)");
            }
            catch (IOException)
            {
                // 并发释放竞态：另一个进程已写出即可
                if (!File.Exists(file)) throw;
            }
        }
        // ConfigManager.ConfigFileBaseDir = <JiebaConfigFileDir>/Resources
        AppDomain.CurrentDomain.SetData("JiebaConfigFileDir", baseDir);
        return true;
    }

    /// <summary>
    /// 自定义词重组（与 TS mergeCustomWords 同构）：
    /// 把被 jieba 切散的自定义词（如"昔涟"→"昔","涟"）在 token 序列里合并回来。
    /// 按词长倒序优先匹配长词。
    /// </summary>
    private static List<string> MergeCustomWords(List<string> tokens, IReadOnlyCollection<string> customWords)
    {
        if (customWords.Count == 0 || tokens.Count < 2) return tokens;

        var sortedWords = customWords.OrderByDescending((w) => w.Length).ToList();
        var result = new List<string>(tokens.Count);
        var i = 0;
        while (i < tokens.Count)
        {
            var matched = false;
            foreach (var word in sortedWords)
            {
                if (i + word.Length > tokens.Count) continue;
                var ok = true;
                for (var j = 0; j < word.Length; j++)
                {
                    if (!string.Equals(tokens[i + j], word[j].ToString(), StringComparison.Ordinal))
                    {
                        ok = false;
                        break;
                    }
                }
                if (ok)
                {
                    result.Add(word);
                    i += word.Length;
                    matched = true;
                    break;
                }
            }
            if (!matched)
            {
                result.Add(tokens[i]);
                i++;
            }
        }
        return result;
    }
}

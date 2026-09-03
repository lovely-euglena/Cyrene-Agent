using System.Text.Json;
using CyreneEmbedSidecar;

// 用法：
//   verify <modelDir> <dump.json>   数值一致性验证：tokenIds 对账 + 向量余弦
//   bench  <modelDir> [textCount]   性能基准（自生成混合长短文本）
//   serve  <modelDir>               stdio 帧协议服务（Electron spawn）
//
// modelDir 指向 Xenova/bge-m3 布局（tokenizer.json + onnx/model_quantized.onnx）

var command = args.Length > 0 ? args[0] : "serve";
var modelDir = args.Length > 1 ? args[1]
    : Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", "models", "Xenova", "bge-m3"));

switch (command)
{
    case "verify":
        Verify.Run(modelDir, args.Length > 2 ? args[2] : "scripts/diagnostics/embedding-verify-data.json");
        return 0;
    case "bench":
        Bench.Run(modelDir, args.Length > 2 ? int.Parse(args[2]) : 48);
        return 0;
    case "serve":
        Server.Run(modelDir);
        return 0;
    default:
        Console.Error.WriteLine($"unknown command: {command}");
        return 2;
}

internal static class Verify
{
    public static void Run(string modelDir, string dumpPath)
    {
        using var doc = JsonDocument.Parse(File.ReadAllText(dumpPath));
        var root = doc.RootElement;
        var texts = root.GetProperty("texts").EnumerateArray().Select(t => t.GetString()!).ToArray();
        var expectedIds = root.GetProperty("tokenIds").EnumerateArray()
            .Select(a => a.EnumerateArray().Select(v => v.GetInt32()).ToArray()).ToArray();
        var expectedVectors = root.GetProperty("vectors").EnumerateArray()
            .Select(a => a.EnumerateArray().Select(v => (float)v.GetDouble()).ToArray()).ToArray();

        Console.WriteLine($"[verify] model dir: {modelDir}");

        // 1) tokenIds 对账（HfUnigramTokenizer 的直接产物，秒级）
        var tokenizer = HfUnigramTokenizer.FromTokenizerJson(Path.Combine(modelDir, "tokenizer.json"));
        int tokenMatches = 0, tokenTotal = 0;
        for (var i = 0; i < texts.Length; i++)
        {
            tokenTotal += expectedIds[i].Length;
            var actual = tokenizer.EncodeToIds(texts[i]);
            if (actual.SequenceEqual(expectedIds[i]))
            {
                tokenMatches += actual.Length;
            }
            else
            {
                var diffPos = DiffPosition(actual, expectedIds[i]);
                Console.WriteLine($"[verify] tokenIds mismatch #{i}: actual len={actual.Length}, expected len={expectedIds[i].Length}, first diff at {diffPos}");
                Console.WriteLine($"         actual:   {Show(actual, diffPos)}");
                Console.WriteLine($"         expected: {Show(expectedIds[i], diffPos)}");
            }
        }
        Console.WriteLine($"[verify] tokenizer: {tokenMatches}/{tokenTotal} tokens exact match");

        // 2) 向量一致性（需加载 ONNX session）
        var loadStart = System.Diagnostics.Stopwatch.GetTimestamp();
        using var engine = EmbeddingEngine.Load(modelDir);
        Console.WriteLine($"[verify] engine loaded in {System.Diagnostics.Stopwatch.GetElapsedTime(loadStart).TotalMilliseconds:F0}ms, dims={engine.Dimensions}");

        // 2a) 逐条推理（无 padding）：dump 数据来自 JS 逐条推理，先隔离
        //     batch padding 对 int8 动态量化 scale 的影响
        var seqVectors = new float[texts.Length][];
        for (var i = 0; i < texts.Length; i++) seqVectors[i] = engine.Embed(new[] { texts[i] })[0];
        ReportConsistency("sequential", seqVectors, expectedVectors, out var worstSeq);

        // 2b) 多文本入口（内部逐条）：生产路径
        var vectors = engine.Embed(texts);
        ReportConsistency("multi-text", vectors, expectedVectors, out var worstBatch);

        var pass = worstSeq > 0.9995 && worstBatch > 0.9995;
        Console.WriteLine($"[verify] {(pass ? "PASS" : "FAIL")} (threshold cosine > 0.9995)");
        if (!pass) Environment.Exit(1);
    }

    private static void ReportConsistency(string label, float[][] actual, float[][] expected, out double worstCos)
    {
        worstCos = 1.0;
        var maxAbs = 0.0;
        for (var i = 0; i < actual.Length; i++)
        {
            worstCos = Math.Min(worstCos, Cosine(actual[i], expected[i]));
            for (var k = 0; k < actual[i].Length; k++)
            {
                maxAbs = Math.Max(maxAbs, Math.Abs(actual[i][k] - expected[i][k]));
            }
        }
        Console.WriteLine($"[verify] vectors({label}): worst cosine={worstCos:F8}, max |diff|={maxAbs:E2}");
    }

    private static int DiffPosition(int[] a, int[] b)
    {
        var n = Math.Min(a.Length, b.Length);
        for (var i = 0; i < n; i++) if (a[i] != b[i]) return i;
        return n;
    }

    private static string Show(int[] ids, int pos)
    {
        var start = Math.Max(0, pos - 4);
        var end = Math.Min(ids.Length, pos + 6);
        var parts = Enumerable.Range(start, end - start).Select(i => $"{i}:{ids[i]}{(i == pos ? "*" : "")}");
        return string.Join(" ", parts);
    }

    private static double Cosine(float[] a, float[] b)
    {
        double dot = 0, na = 0, nb = 0;
        for (var i = 0; i < a.Length; i++)
        {
            dot += a[i] * b[i];
            na += a[i] * a[i];
            nb += b[i] * b[i];
        }
        return dot / (Math.Sqrt(na) * Math.Sqrt(nb) + 1e-12);
    }
}

internal static class Bench
{
    public static void Run(string modelDir, int textCount)
    {
        var shortTexts = new[]
        {
            "昔涟趴在桌边看着你工作，尾巴轻轻晃了一下",
            "The user is focused on coding, typing fast",
            "雨天，窗户上有水珠",
            "用户刚刚夸奖了昔涟",
            "深夜了，昔涟提醒你早点休息",
        };
        var longTexts = new[]
        {
            "昔涟注意到你连续工作了很久，轻轻地给你递上一杯热茶，然后把音量调小了一些，不想打扰你的思路。",
            "RAG 检索链路包含三个阶段：文档摄入时先分块并生成 embedding 写入向量库；检索时把查询文本转成向量做近邻搜索；最后可选地用 cross-encoder 对候选重排。分块策略决定了检索粒度，过大的块稀释语义，过小的块丢失上下文。",
        };
        var texts = new List<string>(textCount);
        var rng = new Random(42);
        for (var i = 0; i < textCount; i++)
        {
            texts.Add(rng.Next(3) == 0 ? longTexts[i % longTexts.Length] : shortTexts[i % shortTexts.Length]);
        }

        Console.WriteLine($"[bench] model dir: {modelDir}");
        var loadStart = System.Diagnostics.Stopwatch.GetTimestamp();
        using var engine = EmbeddingEngine.Load(modelDir);
        Console.WriteLine($"[bench] engine loaded in {System.Diagnostics.Stopwatch.GetElapsedTime(loadStart).TotalMilliseconds:F0}ms, dims={engine.Dimensions}");

        // 逐条
        var sw = System.Diagnostics.Stopwatch.StartNew();
        foreach (var text in texts) engine.Embed(new[] { text });
        sw.Stop();
        Console.WriteLine($"[bench] sequential: {texts.Count} texts in {sw.ElapsedMilliseconds}ms ({sw.ElapsedMilliseconds * 1.0 / texts.Count:F1}ms/text)");

        // 生产路径（多文本入口，内部逐条，与 sequential 数值一致）
        sw.Restart();
        var _ = engine.Embed(texts);
        sw.Stop();
        Console.WriteLine($"[bench] embed(N):   {texts.Count} texts in {sw.ElapsedMilliseconds}ms ({sw.ElapsedMilliseconds * 1.0 / texts.Count:F1}ms/text)");
        Console.WriteLine($"[bench] 对比基线 JS WASM：逐条 749.0ms/text（同机 48 条混合文本）");
    }
}

internal static class Server
{
    public static void Run(string modelDir)
    {
        // Phase B：stdio 帧协议（长度前缀 + JSON 请求 + 二进制 float 响应）
        // 先实现 verify/bench，serve 骨架占位
        Console.Error.WriteLine("[serve] protocol not implemented yet — Phase B");
        Environment.Exit(2);
    }
}

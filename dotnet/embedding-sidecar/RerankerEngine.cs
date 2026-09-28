using Microsoft.ML.OnnxRuntime;

namespace CyreneEmbedSidecar;

/// <summary>
/// bge-reranker-base cross-encoder：XLM-R 句对编码 + 单 logit 相关性打分。
///
/// - 逐条前向（与 transformers.js batch=1 的数值语义一致；int8 动态量化的
///   per-tensor scale 对 batch 组合敏感，不做组批）
/// - 输出原始 logits，不做 softmax（num_labels=1 时 softmax 恒为 1）
/// - 模型目录 = models/bge-reranker-base（tokenizer.json + onnx/model_quantized.onnx），
///   由宿主显式传入（TS 侧 getProjectModelDir 解析）
/// </summary>
public sealed class RerankerEngine : IDisposable
{
    private readonly InferenceSession _session;
    private readonly HfUnigramTokenizer _tokenizer;
    private readonly RunOptions _runOptions = new();
    private readonly string[] _outputNames;
    private readonly bool _needsTokenTypeIds;

    public int MaxLength { get; }

    private RerankerEngine(InferenceSession session, HfUnigramTokenizer tokenizer, int maxLength)
    {
        _session = session;
        _tokenizer = tokenizer;
        MaxLength = maxLength;
        _outputNames = session.OutputMetadata.Keys.ToArray();
        _needsTokenTypeIds = session.InputMetadata.ContainsKey("token_type_ids");
    }

    public static RerankerEngine Load(string rerankerDir, int maxLength = 512)
    {
        var tokenizerPath = Path.Combine(rerankerDir, "tokenizer.json");
        var onnxPath = Path.Combine(rerankerDir, "onnx", "model_quantized.onnx");
        if (!File.Exists(onnxPath))
        {
            throw new FileNotFoundException($"reranker onnx not found: {onnxPath}");
        }

        Console.Error.WriteLine($"[rerank] loading tokenizer: {tokenizerPath}");
        var tokenizer = HfUnigramTokenizer.FromTokenizerJson(tokenizerPath);
        Console.Error.WriteLine($"[rerank] loading onnx session: {onnxPath}");
        var options = new SessionOptions();
        var threads = EmbeddingEngine.ReadThreadsEnv();
        if (threads > 0)
        {
            options.IntraOpNumThreads = Math.Min(threads, Environment.ProcessorCount);
        }
        else if (Environment.ProcessorCount > 1)
        {
            options.IntraOpNumThreads = Math.Min(4, Math.Max(1, Environment.ProcessorCount / 2));
        }
        options.AppendExecutionProvider_CPU();
        var session = new InferenceSession(onnxPath, options);
        Console.Error.WriteLine(
            $"[rerank] session ready (inputs={string.Join(",", session.InputMetadata.Keys)}, threads={options.IntraOpNumThreads})");
        return new RerankerEngine(session, tokenizer, maxLength);
    }

    /// <summary>逐条打分（输入顺序返回）。score = 相关性 logit，越大越相关。</summary>
    public float[] Score(string query, IReadOnlyList<string> documents)
    {
        var scores = new float[documents.Count];
        for (var i = 0; i < documents.Count; i++)
        {
            var ids = _tokenizer.EncodePairToIds(query, documents[i], MaxLength);
            scores[i] = RunSingle(ids);
        }
        return scores;
    }

    private float RunSingle(int[] ids)
    {
        lock (_runLock)
        {
            return RunSingleCore(ids);
        }
    }

    private readonly object _runLock = new();

    private float RunSingleCore(int[] ids)
    {
        var seqLen = ids.Length;
        var inputIds = new long[seqLen];
        var attentionMask = new long[seqLen];
        for (var j = 0; j < seqLen; j++)
        {
            inputIds[j] = ids[j];
            attentionMask[j] = 1;
        }

        using var inputIdsOrt = OrtValue.CreateTensorValueFromMemory(inputIds, new long[] { 1, seqLen });
        using var maskOrt = OrtValue.CreateTensorValueFromMemory(attentionMask, new long[] { 1, seqLen });
        var inputs = new Dictionary<string, OrtValue>(2)
        {
            ["input_ids"] = inputIdsOrt,
            ["attention_mask"] = maskOrt,
        };
        OrtValue? tokenTypesOrt = null;
        if (_needsTokenTypeIds)
        {
            tokenTypesOrt = OrtValue.CreateTensorValueFromMemory(new long[seqLen], new long[] { 1, seqLen });
            inputs["token_type_ids"] = tokenTypesOrt;
        }

        try
        {
            using var outputs = _session.Run(_runOptions, inputs, _outputNames);
            var logits = outputs[0].GetTensorDataAsSpan<float>();
            return logits.Length > 0 ? logits[0] : 0f;
        }
        finally
        {
            tokenTypesOrt?.Dispose();
            inputs.Clear();
        }
    }

    public void Dispose() => _session.Dispose();
}

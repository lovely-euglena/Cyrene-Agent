using Microsoft.ML.OnnxRuntime;

namespace CyreneEmbedSidecar;

/// <summary>
/// cross-encoder reranker：XLM-R 句对编码 + 单 logit 相关性打分。
///
/// - 逐条前向（与 transformers.js batch=1 的数值语义一致；int8 动态量化的
///   per-tensor scale 对 batch 组合敏感，不做组批）
/// - 输出原始 logits，不做 softmax（num_labels=1 时 softmax 恒为 1）
/// - 模型目录（tokenizer.json + onnx/model_quantized.onnx），由宿主显式传入
///   （TS 侧 getProjectModelDir 解析）：bge-reranker-base / bge-reranker-v2-m3
///   均为 XLM-RoBERTa 系，输入名/输出名差异由元数据自适应覆盖：
///     输入 input_ids + attention_mask；token_type_ids 仅当 ONNX 声明时补全零
///     （v2-m3 type_vocab_size=1，导出无此输入；base 同）；
///     输出优先 logits（sequence-classification 单输出），未知导出回退第一个。
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
        // 输出名自适应：优先 logits；未知导出回退第一个输出（防止多输出时
        // 取错段）。仅请求打分所需的那个输出。
        var preferred = session.OutputMetadata.ContainsKey("logits")
            ? "logits"
            : session.OutputMetadata.Keys.First();
        _outputNames = new[] { preferred };
        _needsTokenTypeIds = session.InputMetadata.ContainsKey("token_type_ids");
    }

    /// <summary>
    /// 加载 reranker（tokenizer.json + onnx/model_quantized.onnx）。
    /// maxLength 默认 512（bge-reranker-base tokenizer 上限，协议/TS 侧冻结）；
    /// v2-m3 的 tokenizer_config model_max_length=8192，如需长文重排再按元数据放开。
    /// </summary>
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
        var options = CreateSessionOptions();
        var session = new InferenceSession(onnxPath, options);
        Console.Error.WriteLine(
            $"[rerank] session ready (inputs={string.Join(",", session.InputMetadata.Keys)}, threads={(options.IntraOpNumThreads > 0 ? options.IntraOpNumThreads.ToString() : "default")})");
        return new RerankerEngine(session, tokenizer, maxLength);
    }

    /// <summary>
    /// 会话选项（线程语义与 EmbeddingEngine 共用同一入口；verify-threads
    /// 自检对两侧 IntraOpNumThreads 对账，防止以后单侧改动产生分歧）。
    /// </summary>
    internal static SessionOptions CreateSessionOptions() => EmbeddingEngine.CreateSessionOptions();

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

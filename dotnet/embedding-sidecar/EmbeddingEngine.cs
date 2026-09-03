using Microsoft.ML.OnnxRuntime;

namespace CyreneEmbedSidecar;

/// <summary>
/// bge-m3 embedding 推理引擎：ONNX Runtime native 后端 + Unigram 分词 +
/// attention-mask mean pooling + L2 归一化 + 排序组批。
///
/// 与 Electron 侧 transformers.js（WASM）共用同一份 onnx/model_quantized.onnx
/// 权重；向量语义一致（残差为 int8 量化噪声，verify 模式对账）。
/// </summary>
public sealed class EmbeddingEngine : IDisposable
{
    private readonly InferenceSession _session;
    private readonly HfUnigramTokenizer _tokenizer;
    private readonly string _modelKey;
    public int Dimensions { get; }

    public string ModelKey => _modelKey;

    private EmbeddingEngine(InferenceSession session, HfUnigramTokenizer tokenizer, string modelKey, int dims)
    {
        _session = session;
        _tokenizer = tokenizer;
        _modelKey = modelKey;
        Dimensions = dims;
    }

    /// <summary>modelDir 指向 Xenova/bge-m3 布局（tokenizer.json + onnx/model_quantized.onnx）。</summary>
    public static EmbeddingEngine Load(string modelDir, string modelKey = "bgem3")
    {
        var tokenizerPath = Path.Combine(modelDir, "tokenizer.json");
        var onnxPath = Path.Combine(modelDir, "onnx", "model_quantized.onnx");

        Console.Error.WriteLine($"[engine] loading tokenizer: {tokenizerPath}");
        var tokenizer = HfUnigramTokenizer.FromTokenizerJson(tokenizerPath);
        Console.Error.WriteLine($"[engine] tokenizer ready: vocab={tokenizer.VocabSize}");

        Console.Error.WriteLine($"[engine] loading onnx session: {onnxPath}");
        var options = new SessionOptions();
        // CPU 推理；ORT 会自动用满物理核（弱机器上可用 IntraOpNumThreads 限流）
        options.AppendExecutionProvider_CPU();
        var session = new InferenceSession(onnxPath, options);
        Console.Error.WriteLine("[engine] session ready");

        var dims = session.OutputMetadata["last_hidden_state"].Dimensions;
        // [batch, seq, dim] → 取最后一维
        var embedDim = dims.Length > 0 && dims[^1] > 0 ? dims[^1] : 1024;

        return new EmbeddingEngine(session, tokenizer, modelKey, embedDim);
    }

    /// <summary>
    /// 批量 embedding（输入顺序返回）。
    ///
    /// ⚠️ 内部逐条推理，不做 batch 前向。实测（verify 模式）：
    /// Xenova quantized 模型含 96 个 DynamicQuantizeLinear——激活
    /// 量化 scale 按 per-tensor min/max 计算，n&gt;1 时联合 min/max
    /// 必然变化 → 量化 scale 变化 → 向量偏移 ~1%（cosine≈0.99）。
    /// 等长无 padding 批同样如此（JS WASM 的 kernel 恰好不敏感，但
    /// ORT native 上不可复现逐条数值）。
    ///
    /// 数值一致性是硬约束（与 Electron 侧 transformers.js 共存同一
    /// LanceDB 索引），因此牺牲批前向吞吐，逐条推理与 JS 逐条
    /// 逐位一致（cosine=1.0, max|diff|≈5e-7）。提速收益来自
    /// native MLAS kernel（对 WASM 3~10x），与 batch 无关。
    /// </summary>
    public float[][] Embed(IReadOnlyList<string> texts)
    {
        if (texts.Count == 0) return Array.Empty<float[]>();

        var results = new float[texts.Count][];
        for (var i = 0; i < texts.Count; i++)
        {
            var ids = _tokenizer.EncodeToIds(texts[i]);
            var vector = new float[Dimensions];
            RunSingle(ids, vector);
            results[i] = vector;
        }

        return results;
    }

    /// <summary>单条前向：tokenize 后的 ids → 归一化向量（n=1，无 padding）。</summary>
    private void RunSingle(int[] ids, float[] vector)
    {
        var seqLen = ids.Length;
        var dims = Dimensions;

        // n=1：input_ids 与 attention_mask 全 1（无 padding）
        var inputIds = new long[seqLen];
        var attentionMask = new long[seqLen];
        for (var j = 0; j < seqLen; j++)
        {
            inputIds[j] = ids[j];
            attentionMask[j] = 1;
        }

        using var inputIdsOrt = OrtValue.CreateTensorValueFromMemory(inputIds, new long[] { 1, seqLen });
        using var maskOrt = OrtValue.CreateTensorValueFromMemory(attentionMask, new long[] { 1, seqLen });
        using var runOptions = new RunOptions();

        var inputs = new Dictionary<string, OrtValue>
        {
            ["input_ids"] = inputIdsOrt,
            ["attention_mask"] = maskOrt,
        };

        using var outputs = _session.Run(runOptions, inputs, new[] { "last_hidden_state" });
        // ResultCollection：按 outputNames 顺序排列
        var hidden = outputs[0].GetTensorDataAsSpan<float>();
        // [1, seqLen, dim]

        // mask-aware mean pooling（n=1 无 padding，全位有效）
        for (var j = 0; j < seqLen; j++)
        {
            var baseOffset = j * dims;
            for (var k = 0; k < dims; k++)
            {
                vector[k] += hidden[baseOffset + k];
            }
        }
        var denom = (float)seqLen;
        for (var k = 0; k < dims; k++) vector[k] /= denom;

        // L2 normalize（bge-m3 检索用余弦相似度，归一化后点积即余弦）
        float norm = 0f;
        for (var k = 0; k < dims; k++) norm += vector[k] * vector[k];
        norm = MathF.Sqrt(norm);
        if (norm > 0f)
        {
            for (var k = 0; k < dims; k++) vector[k] /= norm;
        }
    }

    public void Dispose() => _session.Dispose();
}

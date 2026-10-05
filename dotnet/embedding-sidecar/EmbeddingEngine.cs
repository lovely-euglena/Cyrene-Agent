using System.Text.Json;
using Microsoft.ML.OnnxRuntime;

namespace CyreneEmbedSidecar;

/// <summary>
/// embedding 推理引擎：ONNX Runtime native 后端 + Unigram 分词 +
/// attention-mask mean pooling + L2 归一化。
///
/// 与 Electron 侧 transformers.js（WASM）共用同一份 onnx/model_quantized.onnx
/// 权重；向量语义一致（残差为 int8 量化噪声，verify 模式对账）。
///
/// 模型自适应（IKIH28 第二向量模型 Xenova/multilingual-e5-small，384 维）：
///   - 输入名按 session 元数据：input_ids / attention_mask 必需，
///     token_type_ids 存在时补全零（e5-small 的 BERT 系导出必需，
///     bge-m3 的 XLM-R 导出无此输入）。
///   - 输出名优先 last_hidden_state，未知导出回退第一个输出；维度取该输出
///     最后一维（bge-m3=1024，e5-small=384）。
///   - 截断长度优先 tokenizer_config.json 的 model_max_length（与
///     transformers.js truncation 同口径），回退 config.json 的
///     max_position_embeddings；缺失则不截断（保持旧行为）。
/// </summary>
public sealed class EmbeddingEngine : IDisposable
{
    private readonly InferenceSession _session;
    private readonly HfUnigramTokenizer _tokenizer;
    private readonly string _modelKey;
    private readonly RunOptions _runOptions;
    private readonly Dictionary<string, OrtValue> _inputTemplate = new(2);
    private readonly bool _needsTokenTypeIds;
    private readonly string[] _outputNames;
    private readonly int _maxLength;
    public int Dimensions { get; }

    public string ModelKey => _modelKey;

    private EmbeddingEngine(
        InferenceSession session,
        HfUnigramTokenizer tokenizer,
        string modelKey,
        int dims,
        bool needsTokenTypeIds,
        string[] outputNames,
        int maxLength)
    {
        _session = session;
        _tokenizer = tokenizer;
        _modelKey = modelKey;
        Dimensions = dims;
        _needsTokenTypeIds = needsTokenTypeIds;
        _outputNames = outputNames;
        _maxLength = maxLength;
        _runOptions = new RunOptions();
    }

    /// <summary>
    /// modelDir 指向 Xenova 布局（tokenizer.json + onnx/model_quantized.onnx）：
    /// bge-m3（1024 维）或 multilingual-e5-small（384 维）等。
    /// </summary>
    public static EmbeddingEngine Load(string modelDir, string modelKey = "bgem3")
    {
        var tokenizerPath = Path.Combine(modelDir, "tokenizer.json");
        var onnxPath = Path.Combine(modelDir, "onnx", "model_quantized.onnx");

        Console.Error.WriteLine($"[engine] loading tokenizer: {tokenizerPath}");
        var tokenizer = HfUnigramTokenizer.FromTokenizerJson(tokenizerPath);
        Console.Error.WriteLine($"[engine] tokenizer ready: vocab={tokenizer.VocabSize}");

        Console.Error.WriteLine($"[engine] loading onnx session: {onnxPath}");
        var options = CreateSessionOptions();
        var session = new InferenceSession(onnxPath, options);
        Console.Error.WriteLine(
            $"[engine] session ready (intra-op threads={(options.IntraOpNumThreads > 0 ? options.IntraOpNumThreads.ToString() : "default")})");

        var outputNames = ResolveOutputNames(session);
        var needsTokenTypeIds = session.InputMetadata.ContainsKey("token_type_ids");
        var maxLength = ReadModelMaxLength(modelDir);

        var dims = session.OutputMetadata[outputNames[0]].Dimensions;
        // [batch, seq, dim] → 取最后一维
        var embedDim = dims.Length > 0 && dims[^1] > 0 ? dims[^1] : 1024;

        Console.Error.WriteLine(
            $"[engine] metadata: inputs={string.Join(",", session.InputMetadata.Keys)}, output={outputNames[0]}, maxLength={(maxLength > 0 ? maxLength.ToString() : "unlimited")}");

        return new EmbeddingEngine(session, tokenizer, modelKey, embedDim, needsTokenTypeIds, outputNames, maxLength);
    }

    /// <summary>
    /// 输出名自适应：优先 last_hidden_state（feature-extraction 导出），
    /// 未知导出回退第一个输出，避免硬编码 KeyNotFoundException。
    /// </summary>
    private static string[] ResolveOutputNames(InferenceSession session)
    {
        var preferred = session.OutputMetadata.ContainsKey("last_hidden_state")
            ? "last_hidden_state"
            : session.OutputMetadata.Keys.First();
        return new[] { preferred };
    }

    /// <summary>
    /// 最大输入长度（截断用）：优先 tokenizer_config.json 的 model_max_length
    /// （transformers.js truncation 同口径），回退 config.json 的
    /// max_position_embeddings；都缺失返回 0（不截断）。
    /// </summary>
    private static int ReadModelMaxLength(string modelDir)
    {
        var candidates = new[]
        {
            ("tokenizer_config.json", "model_max_length"),
            ("config.json", "max_position_embeddings"),
        };
        foreach (var (file, key) in candidates)
        {
            try
            {
                var path = Path.Combine(modelDir, file);
                if (!File.Exists(path)) continue;
                using var doc = JsonDocument.Parse(File.ReadAllText(path));
                if (doc.RootElement.TryGetProperty(key, out var el)
                    && el.ValueKind == JsonValueKind.Number
                    && el.TryGetInt32(out var value)
                    && value > 0)
                {
                    return value;
                }
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[engine] read {file} failed: {ex.Message}");
            }
        }
        return 0;
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
            // 截断：e5-small 等 512 上限模型必须（超出会让位置嵌入 gather 越界），
            // 口径与 transformers.js truncation 一致（右截断，尾部 </s> 可能被截掉）
            if (_maxLength > 0 && ids.Length > _maxLength)
            {
                ids = ids[.._maxLength];
            }
            var vector = new float[Dimensions];
            RunSingle(ids, vector);
            results[i] = vector;
        }

        return results;
    }

    internal static int ReadThreadsEnv()
    {
        // -1 = 未设置/非法（走默认策略）；0 = ORT 默认（不设置 IntraOpNumThreads）；>0 = 显式上限
        var raw = Environment.GetEnvironmentVariable("CYRENE_EMBED_THREADS");
        return int.TryParse(raw, out var v) && v >= 0 ? v : -1;
    }

    /// <summary>
    /// 线程数决策（纯函数，verify-threads 自检直接断言三分支；embedding/reranker 共用）：
    ///   raw &gt; 0  → 显式上限，封顶物理核数
    ///   raw == 0 → null：不设置 IntraOpNumThreads，走 ORT 默认全核
    ///   raw &lt; 0  → 默认策略：物理核一半（上限 4）；单核不设置（返回 null）
    /// </summary>
    internal static int? ResolveIntraOpThreads(int raw, int processorCount)
    {
        if (raw > 0) return Math.Min(raw, processorCount);
        if (raw < 0 && processorCount > 1) return Math.Min(4, Math.Max(1, processorCount / 2));
        return null;
    }

    /// <summary>
    /// 会话选项（线程策略 + CPU EP；不加载模型文件，verify-threads 自检可用）。
    /// embedding 与 reranker 共用本入口，保证两侧线程语义一致。
    /// </summary>
    internal static SessionOptions CreateSessionOptions()
    {
        // 线程数：默认物理核一半（max 4）——桌宠场景 sidecar 满核推理会与
        // Electron 渲染/Live2D 抢核。CYRENE_EMBED_THREADS 覆盖语义：
        //   未设置/非法 = 默认策略；0 = 不设置（走 ORT 默认全核）；>0 = 显式上限
        var options = new SessionOptions();
        var threads = ResolveIntraOpThreads(ReadThreadsEnv(), Environment.ProcessorCount);
        if (threads is { } value) options.IntraOpNumThreads = value;
        options.AppendExecutionProvider_CPU();
        return options;
    }

    /// <summary>单条前向：tokenize 后的 ids → 归一化向量（n=1，无 padding）。</summary>
    private void RunSingle(int[] ids, float[] vector)
    {
        // ORT session 可并发，但 _inputTemplate 复用与批量语义要求串行（导入后台线程 + 检索并发）
        lock (_runLock)
        {
            RunSingleCore(ids, vector);
        }
    }

    private readonly object _runLock = new();

    private void RunSingleCore(int[] ids, float[] vector)
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
        var inputs = _inputTemplate;
        inputs["input_ids"] = inputIdsOrt;
        inputs["attention_mask"] = maskOrt;
        // BERT 系导出（e5-small）要求 token_type_ids，单句全 0；XLM-R 系无此输入
        OrtValue? tokenTypesOrt = null;
        if (_needsTokenTypeIds)
        {
            tokenTypesOrt = OrtValue.CreateTensorValueFromMemory(new long[seqLen], new long[] { 1, seqLen });
            inputs["token_type_ids"] = tokenTypesOrt;
        }

        try
        {
            using var outputs = _session.Run(_runOptions, inputs, _outputNames);
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

            // L2 normalize（检索用余弦相似度，归一化后点积即余弦）
            float norm = 0f;
            for (var k = 0; k < dims; k++) norm += vector[k] * vector[k];
            norm = MathF.Sqrt(norm);
            if (norm > 0f)
            {
                for (var k = 0; k < dims; k++) vector[k] /= norm;
            }
        }
        finally
        {
            tokenTypesOrt?.Dispose();
            inputs.Clear(); // 释放对 OrtValue 的引用（OrtValue 自身 using 释放）
        }
    }

    public void Dispose() => _session.Dispose();
}

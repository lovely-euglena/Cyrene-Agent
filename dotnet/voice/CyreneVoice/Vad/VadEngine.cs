using Microsoft.ML.OnnxRuntime;
using System.IO;
using System.Text;
using System.Text.Json;

namespace CyreneVoice.Vad;

/// <summary>
/// Silero VAD + 三模式路由（阶段 4 G，B9 隐私铁律：静默段不上云）。
///
/// 输入：16kHz mono s16le PCM（512 samples ≈ 32ms/帧，G2.1）。
/// 模型：silero_vad.onnx（~2MB，MIT）——启动时从 exe 同级 models/ 或
/// ./data/models/ 找；找不到则 local/hybrid 降级 cloud 语义（发警告帧）。
///
/// 三模式（A9 默认 hybrid）：
///   local  —— 100% 本地：speech_prob > 阈值 连续 N 帧开段，< 阈值连续 M 帧收段
///   hybrid —— 本地门控 + 云端句尾：语音段内推流，句尾判定靠本地
///             最短静默帧数（替代云端 max_sentence_silence）
///   cloud  —— 现状兜底：不做本地判定，全帧放行（由云端切句）
///
/// G4.3 自动环境校准：首 25 帧（~800ms）噪声基线采样，阈值自适应为
/// base + noiseFloor * 系数；运行中每 200 帧复核一次。
/// </summary>
internal sealed class VadEngine : IDisposable
{
        public string Mode { get; private set; } = "hybrid";
    public double Threshold { get; private set; } = 0.5;

    private const int FrameSamples = 512;          // silero v5 输入窗
    private const int MinSpeechFrames = 3;          // 开段确认（~96ms）
    private const int MinSilenceFrames = 16;        // 收段判定（~512ms，可配）
    private const int CalibFrames = 25;             // G4.3 基线采样
    private const int ReCalibEvery = 200;

    private InferenceSession? _session;
    private float[] _state = new float[128];        // silero LSTM 状态
    private int _stateCount = 2;
    private float[] _context = new float[64];       // v4 context（v5 置空）
    private int _contextLen = 0;

    private readonly Queue<float> _ring = new();   // 环形帧概率
    private int _speechRun, _silenceRun;
    private bool _inSpeech;
    private double _noiseFloor = 0.08;
    private int _calibLeft = CalibFrames, _framesSinceCalib;
    private readonly List<byte> _calibBuf = new();

    public delegate void Sink(object frame);
    private readonly Sink _send;

    public VadEngine(Sink send) => _send = send;

    public void Configure(JsonElement root)
    {
        if (root.TryGetProperty("mode", out var m) && m.GetString() is { } mode)
        {
            Mode = mode is "local" or "hybrid" or "cloud" ? mode : "hybrid";
        }
        if (root.TryGetProperty("threshold", out var t) && t.ValueKind == JsonValueKind.Number)
            Threshold = Math.Clamp(t.GetDouble(), 0.05, 0.95);
        if (root.TryGetProperty("minSilenceMs", out var ms) && ms.ValueKind == JsonValueKind.Number)
        {
            // 帧数换算（32ms/帧），覆盖 MinSilenceFrames
            _minSilenceFrames = (int)Math.Clamp(ms.GetDouble() / 32.0, 4, 64);
        }
        TryLoadModel();
    }

    private int _minSilenceFrames = MinSilenceFrames;

    private void TryLoadModel()
    {
        if (Mode == "cloud") return;                // 兜底模式无需模型
        if (_session is not null) return;
        var candidates = new[]
        {
            Path.Combine(AppContext.BaseDirectory, "models", "silero_vad.onnx"),
            Path.Combine(AppContext.BaseDirectory, "..", "data", "models", "silero_vad.onnx"),
        };
        foreach (var p in candidates.Where(File.Exists))
        {
            _session = new InferenceSession(p);
            _send(new { op = "log", level = "info", message = $"VAD 模型已加载: {p}" });
            return;
        }
        // 模型缺失：保持 local/hybrid 模式，改走能量启发式门控（Handle
        // 里 _session==null 分支）——绝不降级 cloud 全放行（B9：静默段
        // 不上云优先于模型可用性；能量门控对静音/语音的区分足够可靠）
        _send(new { op = "log", level = "warn", message = "silero_vad.onnx 未找到——降级能量启发式门控（仍拦静默段，B9）" });
    }

    public void Handle(string callId, JsonElement root)
    {
        var b64 = root.TryGetProperty("pcm16Base64", out var b) ? b.GetString() : null;
        if (string.IsNullOrEmpty(b64)) return;
        var pcm = Convert.FromBase64String(b64);
        // 16bit LE → float32 归一，按 512 样切帧
        int sampleCount = pcm.Length / 2;
        var floats = new float[sampleCount];
        for (int i = 0; i < sampleCount; i++)
            floats[i] = BitConverter.ToInt16(pcm, i * 2) / 32768f;

        if (Mode == "cloud")
        {
            // 现状兜底：全帧放行（由云端切句）——隐私铁律提示在配置层
            _send(new { op = "vad_result", callId, speech = true, prob = 1.0, mode = "cloud" });
            return;
        }

        for (int off = 0; off + FrameSamples <= floats.Length; off += FrameSamples)
        {
            var frame = new float[FrameSamples];
            Array.Copy(floats, off, frame, 0, FrameSamples);
            double prob = _session is not null ? Inference(frame) : EnergyHeuristic(frame);
            PushProb(callId, prob);
        }
    }

    /// <summary>Silero v5 ONNX 推理（input/state/context → output/state）。</summary>
    private double Inference(float[] frame)
    {
        try
        {
            // NamedOnnxValue 兼容 API（比 OrtValue 重载稳定，1.x 全系可用）
            var inputs = new List<NamedOnnxValue>
            {
                NamedOnnxValue.CreateFromTensor("input", new Microsoft.ML.OnnxRuntime.Tensors.DenseTensor<float>(frame, new[] { 1, FrameSamples })),
                NamedOnnxValue.CreateFromTensor("state", new Microsoft.ML.OnnxRuntime.Tensors.DenseTensor<float>(_state, new[] { 2, 1, 64 })),
                NamedOnnxValue.CreateFromTensor("sr", new Microsoft.ML.OnnxRuntime.Tensors.DenseTensor<long>(new long[] { 16000 }, new[] { 1 })),
            };
            using var results = _session!.Run(inputs);
            var output = results.First(r => r.Name == "output").AsTensor<float>()!.ToArray();
            var newState = results.First(r => r.Name == "stateN").AsTensor<float>()!.ToArray();
            if (newState.Length == _state.Length) Array.Copy(newState, _state, newState.Length);
            return output.Length > 0 ? output[0] : 0.0;
        }
        catch
        {
            _session?.Dispose();
            _session = null;
            return EnergyHeuristic(frame);
        }
    }

    /// <summary>模型不可用时的能量启发（保底，不追求精度）。</summary>
    private double EnergyHeuristic(float[] frame)
    {
        double rms = Math.Sqrt(frame.Sum(x => (double)x * x) / frame.Length);
        return Math.Clamp(rms * 12.0, 0.0, 1.0);
    }

    private void PushProb(string callId, double prob)
    {
        // G4.3 校准：首段噪声基线
        if (_calibLeft > 0 && !_inSpeech)
        {
            _noiseFloor = _noiseFloor * 0.9 + prob * 0.1;
            if (--_calibLeft == 0)
                _send(new { op = "log", level = "info", message = $"VAD 环境校准完成: noiseFloor={_noiseFloor:F3}" });
            return;
        }
        if (++_framesSinceCalib >= ReCalibEvery) { _framesSinceCalib = 0; _calibLeft = 5; }

        var threshold = Math.Max(Threshold, _noiseFloor * 1.6);
        if (!_inSpeech)
        {
            _speechRun = prob > threshold ? _speechRun + 1 : 0;
            if (_speechRun >= MinSpeechFrames)
            {
                _inSpeech = true;
                _silenceRun = 0;
                _send(new { op = "vad_result", callId, speech = true, prob = Math.Round(prob, 3), speechStart = true, mode = Mode });
            }
        }
        else
        {
            _silenceRun = prob < threshold ? _silenceRun + 1 : 0;
            if (_silenceRun >= _minSilenceFrames)
            {
                _inSpeech = false;
                _speechRun = 0;
                _send(new { op = "vad_result", callId, speech = false, prob = Math.Round(prob, 3), speechEnd = true, mode = Mode });
            }
        }
    }

    public void Dispose() => _session?.Dispose();
}

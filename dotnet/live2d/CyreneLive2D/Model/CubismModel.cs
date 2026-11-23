// CubismUserModel 等价类（T1）：moc3 加载 + 参数/部件/drawable 访问 + 画布信息。
//
// 内存约定（Live2DCubismCore.h）：
//   - moc 缓冲 64 字节对齐，csmReviveMocInPlace 就地改写；
//   - model 缓冲 16 字节对齐，csmInitializeModelInPlace 在其上构造；
//   - 两块缓冲均由本类持有（NativeMemory.AlignedAlloc），Dispose 时释放。
//
// saveParameters/loadParameters 语义与 Framework CubismModel 一致：
// 每帧 motion 更新前 save，帧末 load 还原——motion/表情/物理的写入都是
// 叠加在「保存的基值」上的瞬态值（pixi-live2d-display 同序）。

using System.Runtime.InteropServices;
using CyreneLive2D.Core;

namespace CyreneLive2D.Model;

public sealed unsafe class CubismModel : IDisposable
{
    private void* _mocBuffer;
    private uint _mocSize;
    private void* _moc;
    private void* _modelBuffer;
    private void* _model;

    private float[] _savedParameters = Array.Empty<float>();
    private readonly Dictionary<string, int> _parameterIndex = new(StringComparer.Ordinal);
    private readonly Dictionary<string, int> _partIndex = new(StringComparer.Ordinal);
    private readonly Dictionary<string, int> _drawableIndex = new(StringComparer.Ordinal);

    public string[] ParameterIds { get; private set; } = Array.Empty<string>();
    public float[] ParameterMinimums { get; private set; } = Array.Empty<float>();
    public float[] ParameterMaximums { get; private set; } = Array.Empty<float>();
    public float[] ParameterDefaults { get; private set; } = Array.Empty<float>();
    public int[] ParameterRepeats { get; private set; } = Array.Empty<int>();
    public string[] PartIds { get; private set; } = Array.Empty<string>();
    public string[] DrawableIds { get; private set; } = Array.Empty<string>();

    /// <summary>画布尺寸（像素）。</summary>
    public float CanvasWidth { get; private set; }
    public float CanvasHeight { get; private set; }
    /// <summary>画布原点（像素）。</summary>
    public float CanvasOriginX { get; private set; }
    public float CanvasOriginY { get; private set; }
    /// <summary>模型单位 → 像素。</summary>
    public float PixelsPerUnit { get; private set; }

    public CsmMocVersion MocVersion { get; private set; }
    public int ParameterCount => ParameterIds.Length;
    public int PartCount => PartIds.Length;
    public int DrawableCount => DrawableIds.Length;

    /// <summary>Core 模型句柄（渲染器直读 drawable 数据用）。</summary>
    public void* Handle => _model;

    private CubismModel() { }

    /// <summary>从 moc3 文件加载。Core 须已 <see cref="CoreLibrary.Load"/>。</summary>
    public static CubismModel FromMoc3(string path)
    {
        CoreLibrary.EnsureLoaded();
        var bytes = File.ReadAllBytes(path);
        return FromMoc3Bytes(bytes);
    }

    public static CubismModel FromMoc3Bytes(byte[] bytes)
    {
        CoreLibrary.EnsureLoaded();
        var m = new CubismModel();
        m.Initialize(bytes);
        return m;
    }

    private void Initialize(byte[] bytes)
    {
        if (bytes.Length < 4) throw new InvalidDataException("moc3 文件过小。");

        _mocSize = (uint)bytes.Length;
        _mocBuffer = NativeMemory.AlignedAlloc((nuint)_mocSize, CoreNative.AlignofMoc);
        try
        {
            new Span<byte>(bytes).CopyTo(new Span<byte>(_mocBuffer, (int)_mocSize));

            // 一致性校验（Core 4.2+ 提供；失败不致命——旧模型可能误报，仅警告）
            if (CoreNative.csmHasMocConsistency(_mocBuffer, _mocSize) == 0)
            {
                // 不抛：csmHasMocConsistency 对部分合法旧模型返回 0（见 Core CHANGELOG 2023-03-16）
            }

            MocVersion = CoreNative.csmGetMocVersion(_mocBuffer, _mocSize);
            _moc = CoreLibrary.ReviveMocInPlace(_mocBuffer, _mocSize);
            if (_moc == null) throw new InvalidDataException("csmReviveMocInPlace 失败：moc3 损坏或版本不受支持。");

            var modelSize = CoreNative.csmGetSizeofModel(_moc);
            if (modelSize == 0) throw new InvalidDataException("csmGetSizeofModel 返回 0。");
            _modelBuffer = NativeMemory.AlignedAlloc(modelSize, CoreNative.AlignofModel);
            _model = CoreNative.csmInitializeModelInPlace(_moc, _modelBuffer, modelSize);
            if (_model == null) throw new InvalidDataException("csmInitializeModelInPlace 失败。");

            CacheMetadata();
            CoreNative.csmUpdateModel(_model);
        }
        catch
        {
            // 构造失败不会被 Dispose——就地释放已分配的对齐缓冲，避免永久泄漏
            if (_modelBuffer != null) { NativeMemory.AlignedFree(_modelBuffer); _modelBuffer = null; _model = null; }
            NativeMemory.AlignedFree(_mocBuffer); _mocBuffer = null; _moc = null;
            throw;
        }
    }

    private void CacheMetadata()
    {
        var paramCount = CoreNative.csmGetParameterCount(_model);
        ParameterIds = CoreNative.ReadIds(CoreNative.csmGetParameterIds(_model), paramCount);
        ParameterMinimums = ReadFloats(CoreNative.csmGetParameterMinimumValues(_model), paramCount);
        ParameterMaximums = ReadFloats(CoreNative.csmGetParameterMaximumValues(_model), paramCount);
        ParameterDefaults = ReadFloats(CoreNative.csmGetParameterDefaultValues(_model), paramCount);
        ParameterRepeats = ReadInts(CoreNative.csmGetParameterRepeats(_model), paramCount);
        for (var i = 0; i < paramCount; i++) _parameterIndex[ParameterIds[i]] = i;

        var partCount = CoreNative.csmGetPartCount(_model);
        PartIds = CoreNative.ReadIds(CoreNative.csmGetPartIds(_model), partCount);
        for (var i = 0; i < partCount; i++) _partIndex[PartIds[i]] = i;

        var drawableCount = CoreNative.csmGetDrawableCount(_model);
        DrawableIds = CoreNative.ReadIds(CoreNative.csmGetDrawableIds(_model), drawableCount);
        for (var i = 0; i < drawableCount; i++) _drawableIndex[DrawableIds[i]] = i;

        CsmVector2 size, origin;
        float ppu;
        CoreNative.csmReadCanvasInfo(_model, &size, &origin, &ppu);
        CanvasWidth = size.X;
        CanvasHeight = size.Y;
        CanvasOriginX = origin.X;
        CanvasOriginY = origin.Y;
        PixelsPerUnit = ppu;

        _savedParameters = (float[])ParameterDefaults.Clone();
    }

    private static float[] ReadFloats(float* ptr, int count)
    {
        var arr = new float[count];
        new Span<float>(ptr, count).CopyTo(arr);
        return arr;
    }

    private static int[] ReadInts(int* ptr, int count)
    {
        var arr = new int[count];
        new Span<int>(ptr, count).CopyTo(arr);
        return arr;
    }

    // ── 参数访问 ────────────────────────────────────────────

    public int GetParameterIndex(string id) => _parameterIndex.TryGetValue(id, out var i) ? i : -1;
    public int GetPartIndex(string id) => _partIndex.TryGetValue(id, out var i) ? i : -1;
    public int GetDrawableIndex(string id) => _drawableIndex.TryGetValue(id, out var i) ? i : -1;

    public float* ParameterValues => CoreNative.csmGetParameterValues(_model);

    /// <summary>当前参数值 Span（中帧快照/诊断用）。</summary>
    public unsafe Span<float> ParameterValuesSpan => new(ParameterValues, ParameterCount);
    public float* PartOpacities => CoreNative.csmGetPartOpacities(_model);

    public float GetParameterValue(int index) => ParameterValues[index];

    public float GetParameterValueById(string id)
    {
        var i = GetParameterIndex(id);
        return i >= 0 ? ParameterValues[i] : 0f;
    }

    /// <summary>直接写入（不做 repeat/clamp——Core 更新时自行处理）。</summary>
    public void SetParameterValue(int index, float value) => ParameterValues[index] = value;

    public void SetParameterValueById(string id, float value)
    {
        var i = GetParameterIndex(id);
        if (i >= 0) ParameterValues[i] = value;
    }

    // ── TS 语义参数算术（pixi-live2d-display 走 CubismWebFramework，与原生 C++ 不同） ──
    // 关键差异：Web 的 add/multiply 都是「先算目标值，再走 setParameterValueByIndex」，
    // 而 setParameterValueByIndex 会先 repeat/clamp 再按 weight 混合。逐式对齐 TS：
    //   setByIndex(i, v, w)   = blend(current, repeatOrClamp(v), w)
    //   addByIndex(i, v, w)   = setByIndex(i, current + v*w, 1)
    //   multiplyByIndex(i,v,w)= setByIndex(i, current*(1+(v-1)*w), 1)
    // 原生 C++ 的 add 是 current*(1-w)+v*w（无 clamp），与 Web 不一致——像素对照以 Web 为准。

    /// <summary>repeat 参数判定（Editor 设定；SDK 侧覆盖此处不适用）。</summary>
    public bool IsRepeat(int index) => index >= 0 && index < ParameterCount && ParameterRepeats[index] != 0;

    /// <summary>非 repeat 参数钳制到 [min,max]（TS getParameterClampValue）。</summary>
    public float GetParameterClampValue(int index, float value)
    {
        var min = ParameterMinimums[index];
        var max = ParameterMaximums[index];
        return value < min ? min : (value > max ? max : value);
    }

    /// <summary>
    /// TS setParameterValueByIndex：repeat 回绕 / 非 repeat 钳制，再按 weight 混合。
    /// weight==1 直接赋值。motion/表情/行为写参数一律走这里（区别于上方直写 setter）。
    /// </summary>
    public void SetParameterValueByIndex(int index, float value, float weight = 1f)
    {
        if (index < 0 || index >= ParameterCount) return;
        value = IsRepeat(index) ? GetParameterRepeatValue(index, value) : GetParameterClampValue(index, value);
        var current = ParameterValues[index];
        ParameterValues[index] = weight == 1f ? value : current * (1f - weight) + value * weight;
    }

    public void SetParameterValueById(string id, float value, float weight)
        => SetParameterValueByIndex(GetParameterIndex(id), value, weight);

    /// <summary>TS addParameterValueByIndex：set(current + value*weight)。</summary>
    public void AddParameterValue(int index, float value, float weight = 1f)
    {
        if (index < 0 || index >= ParameterCount) return;
        SetParameterValueByIndex(index, ParameterValues[index] + value * weight);
    }

    public void AddParameterValueById(string id, float value, float weight = 1f)
        => AddParameterValue(GetParameterIndex(id), value, weight);

    /// <summary>TS multiplyParameterValueByIndex：set(current*(1+(value-1)*weight))。</summary>
    public void MultiplyParameterValue(int index, float value, float weight = 1f)
    {
        if (index < 0 || index >= ParameterCount) return;
        SetParameterValueByIndex(index, ParameterValues[index] * (1f + (value - 1f) * weight));
    }

    public void MultiplyParameterValueById(string id, float value, float weight = 1f)
        => MultiplyParameterValue(GetParameterIndex(id), value, weight);

    /// <summary>模型整体不透明度（motion 的 Model/Opacity 曲线写入；渲染器逐 drawable 乘上）。</summary>
    public float ModelOpacity { get; private set; } = 1f;

    public void SetModelOpacity(float value) => ModelOpacity = value;

    /// <summary>repeat 参数回绕（Framework GetParameterRepeatValue 语义）。</summary>
    public float GetParameterRepeatValue(int index, float value)
    {
        var max = ParameterMaximums[index];
        var min = ParameterMinimums[index];
        var size = max - min;
        if (size <= 0) return value;
        if (value > max)
        {
            var over = Mod(value - max, size);
            if (!float.IsNaN(over)) value = min + over;
        }
        else if (value < min)
        {
            var under = Mod(min - value, size);
            if (!float.IsNaN(under)) value = max - under;
        }
        return value;
    }

    private static float Mod(float a, float b)
    {
        var r = a % b;
        return r < 0 ? r + b : r;
    }

    // ── 帧参数保存/还原 ─────────────────────────────────────

    public void SaveParameters()
    {
        var values = ParameterValues;
        if (_savedParameters.Length < ParameterCount) Array.Resize(ref _savedParameters, ParameterCount);
        for (var i = 0; i < ParameterCount; i++) _savedParameters[i] = values[i];
    }

    public void LoadParameters()
    {
        var values = ParameterValues;
        var n = Math.Min(ParameterCount, _savedParameters.Length);
        for (var i = 0; i < n; i++) values[i] = _savedParameters[i];
    }

    /// <summary>csmUpdateModel：按当前参数值重算顶点。</summary>
    public void Update() => CoreNative.csmUpdateModel(_model);

    // ── Drawable 直读（渲染器用；指针指向 Core 内存，帧内有效） ──

    public CsmConstantFlags* DrawableConstantFlags => CoreNative.csmGetDrawableConstantFlags(_model);
    public CsmDynamicFlags* DrawableDynamicFlags => CoreNative.csmGetDrawableDynamicFlags(_model);
    /// <summary>渲染秩数组：sorted[order[i]]=i 即绘制序（Core 5 旧名/Core 6 新名经 CoreLibrary 兼容）。</summary>
    public int* DrawableRenderOrders => CoreLibrary.GetRenderOrders(_model);
    public int* DrawableTextureIndices => CoreNative.csmGetDrawableTextureIndices(_model);
    public int* DrawableDrawOrders => CoreNative.csmGetDrawableDrawOrders(_model);
    public float* DrawableOpacities => CoreNative.csmGetDrawableOpacities(_model);
    public int* DrawableMaskCounts => CoreNative.csmGetDrawableMaskCounts(_model);
    public int** DrawableMasks => CoreNative.csmGetDrawableMasks(_model);
    public int* DrawableVertexCounts => CoreNative.csmGetDrawableVertexCounts(_model);
    public CsmVector2** DrawableVertexPositions => CoreNative.csmGetDrawableVertexPositions(_model);
    public CsmVector2** DrawableVertexUvs => CoreNative.csmGetDrawableVertexUvs(_model);
    public int* DrawableIndexCounts => CoreNative.csmGetDrawableIndexCounts(_model);
    public ushort** DrawableIndices => CoreNative.csmGetDrawableIndices(_model);
    public CsmVector4* DrawableMultiplyColors => CoreNative.csmGetDrawableMultiplyColors(_model);
    public CsmVector4* DrawableScreenColors => CoreNative.csmGetDrawableScreenColors(_model);
    public int* DrawableParentPartIndices => CoreNative.csmGetDrawableParentPartIndices(_model);

    public void ResetDrawableDynamicFlags() => CoreNative.csmResetDrawableDynamicFlags(_model);

    public void Dispose()
    {
        if (_modelBuffer != null) { NativeMemory.AlignedFree(_modelBuffer); _modelBuffer = null; _model = null; }
        if (_mocBuffer != null) { NativeMemory.AlignedFree(_mocBuffer); _mocBuffer = null; _moc = null; }
    }
}

// 桌宠引擎编排：模型 + 行为 + 渲染 + 窗口壳的生命周期与帧循环。
// 分层：Model/（纯逻辑，可无头自测）→ Motion/ → Behavior/ → Rendering/（D3D11）→ Window/（Win32）。
// 本类把协议 op 落到各层；帧循环顺序与 pixi-live2d-display 逐帧对齐（见 Tick）。

using System.Text.Json;
using System.Linq;
using CyreneLive2D.Behavior;
using CyreneLive2D.Core;
using CyreneLive2D.Host;
using CyreneLive2D.Model;
using CyreneLive2D.Motion;
using CyreneLive2D.Rendering;
using CyreneLive2D.Rendering.D3D11;

namespace CyreneLive2D;

public sealed class PetEngine : IDisposable
{
    // web 轨基准窗口（manager.ts PET_WINDOW_BASE_*；baseScale 恒对基准计算，zoom 不变性）
    private const float BaseWindowWidth = 400f;
    private const float BaseWindowHeight = 500f;

    private readonly HostIo _io;
    private readonly string? _dataDir;
    private CubismModel? _model;
    private string? _modelDir;
    private Model3Json? _manifest;
    private CubismRenderer? _renderer;

    // 动画/自然运动层（T3）
    private MotionManager? _motions;
    private ExpressionManager? _expressions;
    private Physics3? _physics;
    private Pose3? _pose;
    private Breath? _breath;

    // 行为层（T4）
    private FocusController? _focus;
    private float[] _midFrameParams = Array.Empty<float>();
    private BlinkController? _blink;
    private MouthSyncController? _mouth;
    private SpeakingMotionController? _swing;
    private ExpressionResetController? _exprReset;
    private IdleFpsGovernor? _idleFps;
    private InteractionController? _interaction;

    // 时钟与生命周期状态
    private double _nowMs;
    private bool _hiddenPaused;
    private bool _dragging;
    private bool _interactiveOverride;
    private float _zoom = 1f;
    private int _winW = (int)BaseWindowWidth, _winH = (int)BaseWindowHeight;
    private float _lastClickX, _lastClickY;

    /// <summary>
    /// 真实时间时钟源（宿主 Stopwatch 注入）。web 轨的表情回正（setInterval）与
    /// 空闲帧率分档走 performance.now()，不受 ticker 暂停影响；sidecar 的 _nowMs
    /// 在暂停期冻结，故这两个计时器须用真实时间驱动才与 web 对齐。
    /// 未注入（无头自测）回退 _nowMs，保持确定性驱动。
    /// </summary>
    public Func<double>? RealTimeMsProvider { get; set; }
    private double RealNowMs => RealTimeMsProvider?.Invoke() ?? _nowMs;

    public PetEngine(HostIo io, string? dataDir)
    {
        _io = io;
        _dataDir = dataDir;
    }

    public bool IsLoaded => _model != null;
    public double NowMs => _nowMs;
    public bool IsPaused => _hiddenPaused || _dragging;

    // 窗口宿主读取的几何/状态（DIP 坐标空间，与 web 轨一致）
    public float Zoom => _zoom;
    public int WinW => _winW;
    public int WinH => _winH;
    public int CurrentFps => _idleFps?.CurrentFps ?? 60;
    public bool InteractiveOverride => _interactiveOverride;

    /// <summary>窗口控制面（T2a）；无头自测为 null，窗口 op 退化为无操作。</summary>
    public Window.IWindowControl? WindowControl { get; set; }

    public void Handle(string op, string callId, JsonElement frame)
    {
        switch (op)
        {
            case Live2DOps.Load:
                HandleLoad(callId, frame);
                break;

            case Live2DOps.GetDiagnostics:
                _io.SendResult(callId, GetDiagnostics(
                    frame.TryGetProperty("includeParameters", out var ipEl) && ipEl.ValueKind == JsonValueKind.True));
                break;

            case Live2DOps.SetParameter:
            {
                RequireLoaded();
                var id = frame.TryGetProperty("id", out var idEl) ? idEl.GetString() : null;
                var value = frame.TryGetProperty("value", out var vEl) ? (float)vEl.GetDouble() : 0f;
                if (string.IsNullOrEmpty(id)) { _io.SendError(callId, "缺少 id", Live2DErrors.BadArgs); break; }
                _model!.SetParameterValueById(id, value);
                _io.SendResult(callId);
                break;
            }

            case Live2DOps.Play:
                HandlePlay(callId, frame);
                break;

            case Live2DOps.SpeechPrepare:
                RequireLoaded();
                // web main.ts onPrepare：表情回正 + 停口型 + 停秋千
                _exprReset!.ResetNow();
                _mouth!.Stop(_nowMs);
                _swing!.Stop(_nowMs);
                _io.SendResult(callId);
                break;

            case Live2DOps.MouthStart:
            {
                RequireLoaded();
                var durationMs = frame.TryGetProperty("durationMs", out var dEl) ? dEl.GetDouble() : 0;
                _mouth!.Start(durationMs, _nowMs);
                _swing!.Start(_nowMs);
                _io.SendResult(callId);
                break;
            }

            case Live2DOps.MouthStop:
                RequireLoaded();
                _mouth!.Stop(_nowMs);
                _swing!.Stop(_nowMs);
                _io.SendResult(callId);
                break;

            case Live2DOps.Pause:
                _hiddenPaused = true;
                _io.SendResult(callId);
                break;

            case Live2DOps.Resume:
                _hiddenPaused = false;
                _io.SendResult(callId);
                break;

            case Live2DOps.SetDragging:
            {
                var value = frame.TryGetProperty("value", out var vEl) && vEl.GetBoolean();
                SetDragging(value);
                _io.SendResult(callId);
                break;
            }

            case Live2DOps.SetInteractive:
            {
                // 手动覆盖（托盘拖拽模式）；窗口壳据此强制可交互
                _interactiveOverride = frame.TryGetProperty("value", out var vEl) && vEl.GetBoolean();
                WindowOp(callId, () => WindowControl?.SetInteractiveOverride(_interactiveOverride));
                break;
            }

            case Live2DOps.SetZoom:
            {
                var zoom = frame.TryGetProperty("zoom", out var zEl) ? (float)zEl.GetDouble() : 1f;
                _zoom = Math.Clamp(zoom, 0.5f, 2f);
                _io.SendResult(callId, new { zoom = _zoom });
                break;
            }

            case Live2DOps.SetBounds:
            {
                // DIP 几何状态（hitTest/focus 映射用）+ 窗口壳实际落位
                var x = frame.TryGetProperty("x", out var xEl) ? xEl.GetInt32() : 0;
                var y = frame.TryGetProperty("y", out var yEl) ? yEl.GetInt32() : 0;
                if (frame.TryGetProperty("width", out var wEl)) _winW = Math.Max(1, wEl.GetInt32());
                if (frame.TryGetProperty("height", out var hEl)) _winH = Math.Max(1, hEl.GetInt32());
                WindowOp(callId, () => WindowControl?.SetBoundsDip(x, y, _winW, _winH));
                break;
            }

            case Live2DOps.HitTest:
            {
                RequireLoaded();
                var x = frame.TryGetProperty("x", out var xEl) ? (float)xEl.GetDouble() : 0f;
                var y = frame.TryGetProperty("y", out var yEl) ? (float)yEl.GetDouble() : 0f;
                _io.SendResult(callId, new { areas = HitTestAreas(x, y), x, y });
                break;
            }

            case Live2DOps.Tick:
            {
                RequireLoaded();
                var dtMs = frame.TryGetProperty("dtMs", out var dEl) ? dEl.GetDouble() : 16.6667;
                Tick(dtMs);
                _io.SendResult(callId, new { nowMs = _nowMs });
                break;
            }

            case Live2DOps.RenderOnce:
            case Live2DOps.CaptureFrame:
                HandleRender(callId, op, frame);
                break;

            case Live2DOps.Show:
                WindowOp(callId, () => WindowControl?.Show());
                break;

            case Live2DOps.Hide:
                WindowOp(callId, () => WindowControl?.Hide());
                break;

            case Live2DOps.SetAlwaysOnTop:
            {
                var value = frame.TryGetProperty("value", out var vEl) && vEl.GetBoolean();
                WindowOp(callId, () => WindowControl?.SetAlwaysOnTop(value));
                break;
            }

            default:
                _io.SendError(callId, $"未知 op: {op}", Live2DErrors.BadArgs);
                break;
        }
    }

    private void HandleLoad(string callId, JsonElement frame)
    {
        var modelPath = frame.TryGetProperty("modelPath", out var pEl) ? pEl.GetString() : null;
        if (string.IsNullOrWhiteSpace(modelPath) || !File.Exists(modelPath))
        {
            _io.SendError(callId, $"modelPath 不存在: {modelPath}", Live2DErrors.BadArgs);
            return;
        }

        _modelDir = Path.GetDirectoryName(Path.GetFullPath(modelPath));
        var dataDir = frame.TryGetProperty("dataDir", out var dEl) ? dEl.GetString() : null;
        var effectiveDataDir = dataDir ?? _dataDir;

        // T0：Core 解析。缺失且有 dataDir → 须已获下载同意（Live2D Proprietary
        // License 合规：官方下载页要求先同意许可，程序化下载不能绕过同意动作）
        // 才从官方源下载（SHA256 校验）后重试；未同意 → E_CORE_CONSENT（宿主
        // 弹窗确认后带 coreDownloadConsent=true 重试）；无 dataDir 或下载失败 →
        // E_CORE_MISSING / E_CORE_DOWNLOAD（Electron 回退 web 轨）。
        try
        {
            CoreLibrary.Load(effectiveDataDir, _modelDir);
        }
        catch (CoreNotAvailableException)
        {
            if (string.IsNullOrWhiteSpace(effectiveDataDir))
            {
                _io.SendError(callId, "Core 缺失且未指定 dataDir，无法自动下载", Live2DErrors.CoreMissing);
                return;
            }
            var consent = frame.TryGetProperty("coreDownloadConsent", out var cEl) && cEl.ValueKind == JsonValueKind.True;
            if (!consent)
            {
                _io.SendError(callId,
                    "Cubism Core 缺失：从 Live2D 官方源下载前须同意 Live2D Proprietary Software License（首次使用同意弹窗）",
                    Live2DErrors.CoreConsent);
                return;
            }
            try
            {
                // 协议循环内同步等待（加载期无帧循环，阻塞可接受；进度经 stderr 日志）
                CoreDownloader.DownloadAsync(effectiveDataDir,
                    p => Console.Error.WriteLine($"[core-download] {p.Phase} {p.ReceivedBytes}/{p.TotalBytes?.ToString() ?? "?"} {p.Percent?.ToString() ?? "-"}%"))
                    .GetAwaiter().GetResult();
                CoreLibrary.Load(effectiveDataDir, _modelDir);
            }
            catch (CoreDownloadException ex)
            {
                _io.SendError(callId, ex.Message, Live2DErrors.CoreDownload);
                return;
            }
        }

        // T1：manifest + moc3
        try
        {
            _manifest = Model3Json.Load(modelPath);
            _renderer?.Dispose();
            _renderer = null;
            _model?.Dispose();
            _model = CubismModel.FromMoc3(Path.Combine(_modelDir!, _manifest.Moc));
        }
        catch (Exception ex) when (ex is InvalidDataException or IOException or JsonException)
        {
            _io.SendError(callId, $"模型加载失败: {ex.Message}", Live2DErrors.ModelLoad);
            return;
        }

        InitializeBehaviorLayers();

        _io.SendResult(callId, new
        {
            coreVersion = CoreLibrary.VersionString,
            corePath = CoreLibrary.LoadedPath,
            mocVersion = _model.MocVersion.ToString(),
            parameters = _model.ParameterCount,
            parts = _model.PartCount,
            drawables = _model.DrawableCount,
            canvasWidth = _model.CanvasWidth,
            canvasHeight = _model.CanvasHeight,
            pixelsPerUnit = _model.PixelsPerUnit,
            motionGroups = _manifest.Motions.Keys.ToArray(),
            expressions = _manifest.Expressions.Keys.ToArray(),
            hitAreas = _manifest.HitAreas.Select(h => h.Name).ToArray(),
        });
        _io.SendEvent(Live2DOps.Loaded, new { modelPath });
    }

    /// <summary>加载后初始化动画/自然运动/行为层（web main.ts onLoad 同序）。</summary>
    private void InitializeBehaviorLayers()
    {
        _nowMs = 0;
        _hiddenPaused = false;
        _dragging = false;

        _expressions = new ExpressionManager(_manifest!, _modelDir!);
        _motions = new MotionManager(_manifest!, _modelDir!) { ExpressionManager = _expressions };

        _physics = null;
        if (_manifest!.Physics != null)
        {
            var path = Path.Combine(_modelDir!, _manifest.Physics);
            if (File.Exists(path)) _physics = Physics3.Load(path);
            else Console.Error.WriteLine($"[live2d] physics 文件缺失: {path}");
        }
        _pose = null;
        if (_manifest.Pose != null)
        {
            var path = Path.Combine(_modelDir!, _manifest.Pose);
            if (File.Exists(path)) _pose = Pose3.Load(path);
            else Console.Error.WriteLine($"[live2d] pose 文件缺失: {path}");
        }
        _breath = Breath.CreateDefault();

        _focus = new FocusController();
        FocusCenterAtLoad(); // web onLoad：focus.focusCenter(true)（首帧前陈旧单位矩阵怪癖）
        _blink = new BlinkController(_model!, _nowMs);
        _mouth = new MouthSyncController(_model!);
        _swing = new SpeakingMotionController(_model!, _motions);
        _exprReset = new ExpressionResetController(_expressions, RealNowMs);
        _idleFps = new IdleFpsGovernor(RealNowMs);

        var hitDefs = InteractionController.BuildHitAreaDefs(_manifest);
        _interaction = new InteractionController(_motions, _expressions, hitDefs);
        _interaction.Trigger += area =>
        {
            _exprReset!.Restart(RealNowMs);
            _io.SendEvent(Live2DOps.Hit, new { areas = new[] { area.Name }, x = _lastClickX, y = _lastClickY });
        };
        _interaction.Miss += area =>
            _io.SendEvent(Live2DOps.Miss, new { area = area.Name });
    }

    /// <summary>
    /// 帧循环（与 pld Cubism4InternalModel.update 逐帧对齐）：
    /// focus 插值 → motions → saveParameters → expressions → focus 写入 → breath →
    /// physics → pose → beforeModelUpdate 钩子（口型/眨眼/秋千恢复）→ update → loadParameters。
    /// 注：pld 原装 CubismEyeBlink 在无动作时写眼参数，但自定义 BlinkController 在帧末
    /// 必然覆盖同一组参数——净效果等价，故不重复实现原装眼眨。
    /// dtMs/nowMs 显式推进（诊断 tick op 与自测可确定性驱动）。
    /// </summary>
    public void Tick(double dtMs)
    {
        if (_model == null || IsPaused || dtMs < 0) return;
        _nowMs += dtMs;
        float dtSec = (float)(dtMs / 1000.0);
        float nowSec = (float)(_nowMs / 1000.0);

        _idleFps!.Update(RealNowMs); // 真实时间：暂停期空闲计时不冻结（对齐 web）
        _focus!.Update((float)dtMs);

        _motions!.Update(_model, nowSec);
        _model.SaveParameters();
        _expressions!.Update(_model, nowSec);

        FocusBehavior.ApplyFocus(_model, _focus);
        _breath!.UpdateParameters(_model, dtSec);
        _physics?.Evaluate(_model, dtSec);
        _pose?.UpdateParameters(_model, dtSec);

        // beforeModelUpdate 钩子位（覆盖动作曲线）
        if (_mouth!.IsActive) _mouth.Tick(_nowMs);
        _blink!.Tick(_nowMs);
        _swing!.Tick(_nowMs);
        _exprReset!.Tick(RealNowMs); // 真实时间：隐藏超 3min 恢复即回正（对齐 web）

        // 中帧参数快照（全部写入完成、Update/loadParameters 回滚前）——
        // 双轨行为数值对照用（getDiagnostics includeParameters）。
        if (_midFrameParams.Length != _model.ParameterCount) _midFrameParams = new float[_model.ParameterCount];
        _model.ParameterValuesSpan.CopyTo(_midFrameParams);

        _model.Update();
        _model.LoadParameters();
    }

    /// <summary>窗口点击（窗口层 T2a 调用）：hitTest → down/up → 触发/未触发事件。</summary>
    public void Click(float x, float y)
    {
        if (_model == null || _interaction == null) return;
        _lastClickX = x;
        _lastClickY = y;
        var names = HitTestAreas(x, y);
        _interaction.RegisterDown(x, y, names);
        _interaction.RegisterUp(x, y);
    }

    /// <summary>互动信号（鼠标扫过窗面）：回满帧率。</summary>
    public void MarkActivity() => _idleFps?.MarkActivity(RealNowMs);

    // ── 播放 / 命中 ─────────────────────────────────────────

    private void HandlePlay(string callId, JsonElement frame)
    {
        RequireLoaded();
        if (!frame.TryGetProperty("target", out var target) || target.ValueKind != JsonValueKind.Object)
        {
            _io.SendError(callId, "缺少 target", Live2DErrors.BadArgs);
            return;
        }
        var kind = target.TryGetProperty("kind", out var kEl) ? kEl.GetString() : null;
        bool played;
        if (kind == "motion")
        {
            var group = target.TryGetProperty("group", out var gEl) ? gEl.GetString() : null;
            var motionName = target.TryGetProperty("motionName", out var nEl) ? nEl.GetString() : null;
            if (string.IsNullOrEmpty(group) || string.IsNullOrEmpty(motionName))
            {
                _io.SendError(callId, "motion target 缺 group/motionName", Live2DErrors.BadArgs);
                return;
            }
            // manager.playAction：索引查找 → motion；未注册 → 表情回退
            int index = FindMotionIndex(group, motionName);
            played = index >= 0
                ? _motions!.StartMotion(group, index)
                : _expressions!.SetExpression(motionName);
        }
        else if (kind == "expression")
        {
            var name = target.TryGetProperty("name", out var nEl) ? nEl.GetString() : null;
            if (string.IsNullOrEmpty(name))
            {
                _io.SendError(callId, "expression target 缺 name", Live2DErrors.BadArgs);
                return;
            }
            played = _expressions!.SetExpression(name);
        }
        else
        {
            _io.SendError(callId, $"未知 target.kind: {kind}", Live2DErrors.BadArgs);
            return;
        }
        _io.SendResult(callId, new { played });
    }

    private int FindMotionIndex(string group, string motionName)
    {
        if (!_motions!.Definitions.TryGetValue(group, out var defs)) return -1;
        for (int i = 0; i < defs.Length; i++)
        {
            if (defs[i].Name == motionName) return i;
        }
        return -1;
    }

    /// <summary>
    /// 窗口坐标 → 命中区域名（pld InternalModel.isHit 逐式：drawable 包围盒判定）。
    /// 先反演渲染布局到模型画布坐标（Y 向下），再对每个命中区 drawable 顶点求包围盒。
    /// </summary>
    public unsafe string[] HitTestAreas(float x, float y)
    {
        if (_model == null || _manifest == null) return Array.Empty<string>();
        float scale = ComputeBaseScale() * _zoom;
        float mx = (x - _winW / 2f) / scale + _model.CanvasWidth / 2f;
        float my = (y - _winH / 2f) / scale + _model.CanvasHeight / 2f;

        var hits = new List<string>();
        foreach (var area in _manifest.HitAreas)
        {
            int drawIndex = _model.GetDrawableIndex(area.Id);
            if (drawIndex < 0) continue;

            int vertexCount = _model.DrawableVertexCounts[drawIndex];
            if (vertexCount <= 0) continue;
            var vertices = _model.DrawableVertexPositions[drawIndex];

            float left = float.MaxValue, right = float.MinValue;
            float top = float.MaxValue, bottom = float.MinValue;
            for (int i = 0; i < vertexCount; i++)
            {
                // 模型单位 → 画布像素（pld getDrawableVertices 同式）
                float vx = vertices[i].X * _model.PixelsPerUnit + _model.CanvasWidth / 2f;
                float vy = -vertices[i].Y * _model.PixelsPerUnit + _model.CanvasHeight / 2f;
                if (vx < left) left = vx;
                if (vx > right) right = vx;
                if (vy < top) top = vy;
                if (vy > bottom) bottom = vy;
            }

            if (left <= mx && mx <= right && top <= my && my <= bottom) hits.Add(area.Name);
        }
        return hits.ToArray();
    }

    /// <summary>baseScale 恒对基准窗口计算（zoom 不变性，manager.ts 同语义）。</summary>
    private float ComputeBaseScale()
        => Math.Min(BaseWindowWidth / _model!.CanvasWidth, Math.Min(BaseWindowHeight / _model.CanvasHeight, 1f));

    /// <summary>
    /// load 瞬间居中注视（web onLoad focus.focusCenter(true)）：首帧渲染前
    /// worldTransform 仍单位矩阵 → 走 MapWindowPointAtLoad 偏心目标怪癖。
    /// </summary>
    private void FocusCenterAtLoad()
    {
        if (_model == null || _focus == null) return;
        var (tx, ty) = FocusBehavior.MapWindowPointAtLoad(_winW, _winH, _model.CanvasWidth, _model.CanvasHeight);
        _focus.Focus(tx, ty, instant: true);
    }

    /// <summary>运行时居中注视（拖拽 pointerdown focus.pause(true) → focusCenter）：首帧后 worldTransform 已更新，走真实布局反演。</summary>
    private void FocusCenter(bool instant)
    {
        if (_model == null || _focus == null) return;
        var (tx, ty) = FocusBehavior.MapWindowPoint(
            _winW / 2f, _winH / 2f, _winW, _winH,
            _model.CanvasWidth, _model.CanvasHeight, ComputeBaseScale() * _zoom);
        _focus.Focus(tx, ty, instant);
    }

    /// <summary>拖拽状态（窗口壳鼠标按下/抬起调用；op setDragging 同入口）。</summary>
    public void SetDragging(bool value)
    {
        _dragging = value;
        if (value)
        {
            // web pointerdown：focus.pause(true) → 平滑回中（atan2 怪癖目标 (1,0)）
            FocusCenter(instant: false);
        }
    }

    /// <summary>光标注视（窗口壳 50ms 轮询调用）：窗口局部 DIP → 单位圆方向目标。</summary>
    public void FocusAtWindowPoint(float xDip, float yDip)
    {
        if (_model == null || _focus == null) return;
        var (tx, ty) = FocusBehavior.MapWindowPoint(
            xDip, yDip, _winW, _winH,
            _model.CanvasWidth, _model.CanvasHeight, ComputeBaseScale() * _zoom);
        _focus.Focus(tx, ty);
    }

    /// <summary>
    /// 渲染一帧并返回预乘 BGRA（顶行在前）。窗口壳呈现 / 离屏诊断共用。
    /// width/height 物理像素；zoom 已含 DPI 缩放（窗口壳传入 zoom×dpiScale）。
    /// GPU 失败抛 D3D11Exception；未加载抛 InvalidOperationException。
    /// </summary>
    public byte[] RenderFrame(int width, int height, float zoom)
    {
        RequireLoaded();
        _renderer ??= new CubismRenderer(_model!, _manifest!, _modelDir!);
        return _renderer.Render(width, height, zoom);
    }

    /// <summary>窗口 op 统一包裹：创建/落位失败 → E_WINDOW（无头时 WindowControl=null 直接成功）。</summary>
    private void WindowOp(string callId, Action action)
    {
        try
        {
            action();
            _io.SendResult(callId);
        }
        catch (Exception ex)
        {
            _io.SendError(callId, ex.Message, Live2DErrors.Window);
        }
    }

    private void RequireLoaded()
    {
        if (_model == null) throw new InvalidOperationException("模型未加载（先 load）。");
    }

    /// <summary>
    /// 离屏渲染（无窗口）：renderOnce 返回帧统计，captureFrame 返回 base64 PNG。
    /// T5 窗口壳落地前供 TS 侧验证渲染管线；窗口呈现后 captureFrame 语义不变。
    /// </summary>
    private void HandleRender(string callId, string op, JsonElement frame)
    {
        RequireLoaded();
        var width = frame.TryGetProperty("width", out var wEl) ? wEl.GetInt32() : _winW;
        var height = frame.TryGetProperty("height", out var hEl) ? hEl.GetInt32() : _winH;
        var zoom = frame.TryGetProperty("zoom", out var zEl) ? (float)zEl.GetDouble() : _zoom;
        if (width <= 0 || height <= 0 || width > 8192 || height > 8192)
        {
            _io.SendError(callId, "width/height 越界（1..8192）", Live2DErrors.BadArgs);
            return;
        }

        try
        {
            _renderer ??= new CubismRenderer(_model!, _manifest!, _modelDir!);
            var pixels = _renderer.Render(width, height, zoom);
            if (op == Live2DOps.CaptureFrame)
            {
                var png = PngCodec.Encode(pixels, width, height);
                _io.SendResult(callId, new { width, height, png = Convert.ToBase64String(png) });
            }
            else
            {
                var opaque = 0;
                for (var i = 3; i < pixels.Length; i += 4) if (pixels[i] != 0) opaque++;
                _io.SendResult(callId, new { width, height, opaquePixels = opaque, maskGroups = _renderer.MaskGroupCount });
            }
        }
        catch (D3D11Exception ex)
        {
            _io.SendError(callId, ex.Message, Live2DErrors.Render);
        }
    }

    private object GetDiagnostics(bool includeParameters = false) => new
    {
        loaded = IsLoaded,
        coreVersion = CoreLibrary.IsLoaded ? CoreLibrary.VersionString : null,
        corePath = CoreLibrary.LoadedPath,
        modelDir = _modelDir,
        parameters = _model?.ParameterCount ?? 0,
        drawables = _model?.DrawableCount ?? 0,
        nowMs = _nowMs,
        paused = IsPaused,
        dragging = _dragging,
        interactiveOverride = _interactiveOverride,
        zoom = _zoom,
        winW = _winW,
        winH = _winH,
        idleFps = _idleFps?.CurrentFps ?? 0,
        motion = _motions == null ? null : new
        {
            playing = _motions.Playing,
            currentGroup = _motions.State.CurrentGroup,
            currentIndex = _motions.State.CurrentIndex,
        },
        expression = _expressions?.CurrentExpressionName,
        controllers = _model == null ? null : new
        {
            physics = _physics != null,
            pose = _pose != null,
            breath = _breath != null,
            mouthActive = _mouth!.IsActive,
            swingRestoring = _swing!.IsRestoring,
            focusX = _focus!.X,
            focusY = _focus.Y,
        },
        // 探针/诊断用参数快照（opt-in；中帧值=全部写入完成、loadParameters 回滚前，
        // 双轨行为数值对照，#257 动作态探针）
        parameterValues = includeParameters && _model != null && _midFrameParams.Length == _model.ParameterCount
            ? Enumerable.Range(0, _model.ParameterCount)
                .Select(i => new { id = _model.ParameterIds[i], value = _midFrameParams[i] })
                .ToArray()
            : null,
    };

    public void Dispose()
    {
        _renderer?.Dispose();
        _renderer = null;
        _model?.Dispose();
        _model = null;
        _motions = null;
        _expressions = null;
        _physics = null;
        _pose = null;
        _breath = null;
        _focus = null;
        _blink = null;
        _mouth = null;
        _swing = null;
        _exprReset = null;
        _idleFps = null;
        _interaction = null;
    }
}
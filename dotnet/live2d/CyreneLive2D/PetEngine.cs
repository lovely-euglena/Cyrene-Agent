// 桌宠引擎编排：模型 + 行为 + 渲染 + 窗口壳的生命周期与帧循环。
// 分层：Model/（纯逻辑，可无头自测）→ Rendering/（D3D11）→ Window/（Win32）。
// 本类把协议 op 落到各层；帧循环顺序与 pixi-live2d-display 逐帧对齐（见 Tick）。

using System.Text.Json;
using CyreneLive2D.Core;
using CyreneLive2D.Host;
using CyreneLive2D.Model;
using CyreneLive2D.Rendering;
using CyreneLive2D.Rendering.D3D11;

namespace CyreneLive2D;

public sealed class PetEngine : IDisposable
{
    private readonly HostIo _io;
    private readonly string? _dataDir;
    private CubismModel? _model;
    private string? _modelDir;
    private Model3Json? _manifest;
    private CubismRenderer? _renderer;

    public PetEngine(HostIo io, string? dataDir)
    {
        _io = io;
        _dataDir = dataDir;
    }

    public bool IsLoaded => _model != null;

    public void Handle(string op, string callId, JsonElement frame)
    {
        switch (op)
        {
            case Live2DOps.Load:
                HandleLoad(callId, frame);
                break;

            case Live2DOps.GetDiagnostics:
                _io.SendResult(callId, GetDiagnostics());
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

            case Live2DOps.RenderOnce:
            case Live2DOps.CaptureFrame:
                HandleRender(callId, op, frame);
                break;

            case Live2DOps.HitTest:
            case Live2DOps.Show:
            case Live2DOps.Hide:
            case Live2DOps.SetBounds:
            case Live2DOps.SetZoom:
            case Live2DOps.SetAlwaysOnTop:
            case Live2DOps.Play:
            case Live2DOps.SpeechPrepare:
            case Live2DOps.MouthStart:
            case Live2DOps.MouthStop:
            case Live2DOps.SetDragging:
            case Live2DOps.SetInteractive:
            case Live2DOps.Pause:
            case Live2DOps.Resume:
                // 渲染/窗口/行为层接线后逐项落地（T2–T5）
                _io.SendError(callId, $"op {op} 尚未接线", Live2DErrors.Internal);
                break;

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

        // T0：Core 解析（缺失 → E_CORE_MISSING，Electron 回退 web 轨）
        CoreLibrary.Load(effectiveDataDir, _modelDir);

        // T1：manifest + moc3
        _manifest = Model3Json.Load(modelPath);
        _renderer?.Dispose();
        _renderer = null;
        _model?.Dispose();
        _model = CubismModel.FromMoc3(Path.Combine(_modelDir!, _manifest.Moc));

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
        var width = frame.TryGetProperty("width", out var wEl) ? wEl.GetInt32() : 400;
        var height = frame.TryGetProperty("height", out var hEl) ? hEl.GetInt32() : 500;
        var zoom = frame.TryGetProperty("zoom", out var zEl) ? (float)zEl.GetDouble() : 1f;
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

    private object GetDiagnostics() => new
    {
        loaded = IsLoaded,
        coreVersion = CoreLibrary.IsLoaded ? CoreLibrary.VersionString : null,
        corePath = CoreLibrary.LoadedPath,
        modelDir = _modelDir,
        parameters = _model?.ParameterCount ?? 0,
        drawables = _model?.DrawableCount ?? 0,
    };

    public void Dispose()
    {
        _renderer?.Dispose();
        _renderer = null;
        _model?.Dispose();
        _model = null;
    }
}

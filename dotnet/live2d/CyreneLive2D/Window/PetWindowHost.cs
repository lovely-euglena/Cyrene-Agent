// 窗口宿主（T2a）：把 PetEngine 的无头帧循环接到真实分层窗口。
//
// 职责：
//   - 懒创建 LayeredWindow；DIP↔物理像素换算（PerMonitorV2）；
//   - 帧泵 Pump(nowMs)：消息分发 → 光标轮询（注视+点击穿透）→ tick/render/present；
//   - 点击穿透：50ms 轮询光标下像素 alpha（ClickThrough），幂等翻转 + interactive 事件；
//   - 拖拽：鼠标按下/移动/抬起 → dragStart/dragMove/dragEnd 事件（主进程落位），
//     位移 ≤5px（DIP）判定为点击 → engine.Click；
//   - 渲染分辨率 = 物理像素，zoom×dpiScale 保持模型 DIP 尺寸恒定（DPR=1 时与 web 轨逐像素一致）。
//
// 单线程：所有方法都在宿主消息泵线程调用（与 Win32 消息同线程）。

using System.Diagnostics;
using CyreneLive2D.Behavior;
using CyreneLive2D.Host;
using CyreneLive2D.Rendering.D3D11;

namespace CyreneLive2D.Window;

public sealed class PetWindowHost : IWindowControl, IDisposable
{
    private const double CursorPollIntervalMs = 50;
    private const double FrameStatsIntervalMs = 2000;
    private const float ClickThresholdDip = 5f;

    private readonly PetEngine _engine;
    private readonly HostIo _io;
    private LayeredWindow? _window;

    // DIP 几何（setBounds 下发；默认基准窗口）
    private int _xDip, _yDip, _wDip = 400, _hDip = 500;

    // 最近一帧（点击穿透 alpha 采样 + 暂停期落位复呈用）
    private byte[]? _lastFrame;
    private int _frameW, _frameH;
    private bool _boundsDirty; // setBounds 后尚未落位（暂停期无渲染帧泵送）

    private readonly ClickThroughState _clickState = new();
    private double _lastCursorPollAt;
    private double _lastFrameAt;
    private double _lastTickAt;
    private double _lastRenderErrorLogAt;

    // 拖拽状态
    private bool _dragging;
    private int _downLocalX, _downLocalY;

    // frameStats
    private double _lastFrameStatsAt;
    private int _frameCount;
    private double _frameMsAccum;

    public PetWindowHost(PetEngine engine, HostIo io)
    {
        _engine = engine;
        _io = io;
    }

    /// <summary>是否处于主动渲染状态（宿主据此选择睡眠粒度）。</summary>
    public bool IsRendering => _window != null && _window.IsVisible && _engine.IsLoaded && !_engine.IsPaused;

    /// <summary>自测钩子：底层窗口（同程序集可见）。</summary>
    internal LayeredWindow? WindowForTest => _window;

    // ── IWindowControl ──────────────────────────────────────

    public void Show()
    {
        var win = EnsureWindow();
        ApplyPhysicalBounds(win);
        win.Show();
        _clickState.Reset(); // 强制重新评估穿透
    }

    public void Hide() => _window?.Hide();

    public void SetBoundsDip(int x, int y, int width, int height)
    {
        _xDip = x; _yDip = y;
        _wDip = Math.Max(1, width); _hDip = Math.Max(1, height);
        var win = EnsureWindow();
        ApplyPhysicalBounds(win);
        _boundsDirty = true;
    }

    /// <summary>自测钩子：注入上一帧（无头自测无模型渲染，验证暂停期落位用）。</summary>
    internal void SeedLastFrameForTest(byte[] pixels, int width, int height)
    {
        _lastFrame = pixels;
        _frameW = width;
        _frameH = height;
    }

    public void SetAlwaysOnTop(bool value) => EnsureWindow().SetTopMost(value);

    public void SetInteractiveOverride(bool value) => _clickState.Reset();

    private LayeredWindow EnsureWindow()
    {
        if (_window != null) return _window;
        // 先按 DIP 初值创建（隐藏），随后 ApplyPhysicalBounds 用真实 DPI 校正
        _window = new LayeredWindow(_xDip, _yDip, _wDip, _hDip);
        _window.MouseDown += OnMouseDown;
        _window.MouseMove += OnMouseMove;
        _window.MouseUp += OnMouseUp;
        return _window;
    }

    private void ApplyPhysicalBounds(LayeredWindow win)
    {
        float s = win.Dpi / 96f;
        int px = (int)Math.Round(_xDip * s);
        int py = (int)Math.Round(_yDip * s);
        int pw = Math.Max(1, (int)Math.Round(_wDip * s));
        int ph = Math.Max(1, (int)Math.Round(_hDip * s));
        win.SetBounds(px, py, pw, ph);
    }

    // ── 帧泵 ────────────────────────────────────────────────

    /// <summary>宿主循环每轮调用。nowMs 为宿主 Stopwatch 毫秒。</summary>
    public void Pump(double nowMs)
    {
        PumpMessages();
        if (_window == null) return;

        PollCursor(nowMs);

        if (!_engine.IsLoaded || _engine.IsPaused || !_window.IsVisible)
        {
            _lastTickAt = nowMs; // 暂停期不累计 dt
            // 拖拽/暂停期 setBounds 仍须即时落位：ULW 窗口的位置只能由
            // UpdateLayeredWindow 落定（SetWindowPos 对 ULW 窗不可靠），
            // 故用上一帧复呈（不 Tick、不重渲）。尺寸变化则等恢复后重渲。
            if (_boundsDirty && _window.IsVisible && _lastFrame != null
                && _lastFrame.Length == _window.Width * _window.Height * 4)
            {
                try
                {
                    _window.Present(_lastFrame);
                    _boundsDirty = false;
                }
                catch (Exception ex) when (ex is InvalidOperationException or D3D11Exception)
                {
                    // ULW 落位失败（UpdateLayeredWindow 抛 InvalidOperationException）：限频
                    // 日志，保留窗口与脏位，下轮重试（审核 #1416 P2-3）
                    if (nowMs - _lastRenderErrorLogAt > 1000)
                    {
                        _lastRenderErrorLogAt = nowMs;
                        _io.Log("error", $"暂停期落位失败: {ex.Message}");
                    }
                }
            }
            return;
        }

        double interval = 1000.0 / Math.Max(1, _engine.CurrentFps);
        if (nowMs - _lastFrameAt < interval) return;

        double dt = _lastTickAt <= 0 ? interval : nowMs - _lastTickAt;
        _lastFrameAt = nowMs;
        _lastTickAt = nowMs;

        _engine.Tick(dt);

        var sw = Stopwatch.StartNew();
        try
        {
            RenderAndPresent();
            _frameCount++;
            _frameMsAccum += sw.Elapsed.TotalMilliseconds;
        }
        catch (Exception ex) when (ex is D3D11Exception or InvalidOperationException)
        {
            // GPU 失败 / ULW Present 失败：限频日志，保留窗口（不崩溃）；下一帧重试
            // （审核 #1416 P2-3：异常冒到 Live2DHost 主循环会致侧车退出、桌宠丢失）
            if (nowMs - _lastRenderErrorLogAt > 1000)
            {
                _lastRenderErrorLogAt = nowMs;
                _io.Log("error", $"渲染失败: {ex.Message}");
            }
        }

        if (nowMs - _lastFrameStatsAt >= FrameStatsIntervalMs)
        {
            double elapsed = nowMs - _lastFrameStatsAt;
            if (_lastFrameStatsAt > 0 && _frameCount > 0)
            {
                _io.SendEvent(Live2DOps.FrameStats, new
                {
                    fps = Math.Round(_frameCount * 1000.0 / elapsed, 1),
                    frameMs = Math.Round(_frameMsAccum / _frameCount, 2),
                });
            }
            _lastFrameStatsAt = nowMs;
            _frameCount = 0;
            _frameMsAccum = 0;
        }
    }

    private void RenderAndPresent()
    {
        var win = _window!;
        float s = win.Dpi / 96f;
        int pw = Math.Max(1, (int)Math.Round(_engine.WinW * s));
        int ph = Math.Max(1, (int)Math.Round(_engine.WinH * s));
        if (win.Width != pw || win.Height != ph)
            win.SetBounds(win.X, win.Y, pw, ph);

        // 物理分辨率渲染；zoom×dpiScale 保持模型 DIP 尺寸恒定
        var pixels = _engine.RenderFrame(pw, ph, _engine.Zoom * s);
        win.Present(pixels);
        _lastFrame = pixels;
        _frameW = pw;
        _frameH = ph;
        _boundsDirty = false;
    }

    private static void PumpMessages()
    {
        while (Win32.PeekMessageW(out var msg, IntPtr.Zero, 0, 0, Win32.PM_REMOVE))
        {
            Win32.TranslateMessage(ref msg);
            Win32.DispatchMessageW(ref msg);
        }
    }

    // ── 光标轮询：注视 + 点击穿透 ───────────────────────────

    private void PollCursor(double nowMs)
    {
        if (nowMs - _lastCursorPollAt < CursorPollIntervalMs) return;
        _lastCursorPollAt = nowMs;
        var win = _window!;
        if (!Win32.GetCursorPos(out var pt)) return;

        int lx = pt.X - win.X;
        int ly = pt.Y - win.Y;
        bool inside = lx >= 0 && ly >= 0 && lx < win.Width && ly < win.Height;
        float dpiScale = win.Dpi / 96f;

        // 注视：光标 → 窗口局部 DIP → 单位圆方向（拖拽/暂停/隐藏时不更新）
        if (!_dragging && win.IsVisible && _engine.IsLoaded && !_engine.IsPaused)
            _engine.FocusAtWindowPoint(lx / dpiScale, ly / dpiScale);

        // 点击穿透判定
        bool interactive;
        if (_engine.InteractiveOverride || _dragging) interactive = true;
        else if (!inside || !win.IsVisible || _lastFrame == null) interactive = false;
        else interactive = ClickThrough.HitTestAlpha(_lastFrame, _frameW, _frameH, lx, ly);

        bool? changed = _clickState.Update(interactive);
        if (changed.HasValue)
        {
            win.SetClickThrough(!changed.Value);
            _io.SendEvent(Live2DOps.Interactive, new { value = changed.Value });
            if (changed.Value) _engine.MarkActivity();
        }
    }

    // ── 拖拽 / 点击 ─────────────────────────────────────────

    private void OnMouseDown(int x, int y)
    {
        if (_window == null) return;
        _dragging = true;
        _downLocalX = x;
        _downLocalY = y;
        _engine.SetDragging(true);
        Win32.SetCapture(_window.Handle);
        Win32.GetCursorPos(out var pt);
        _io.SendEvent(Live2DOps.DragStart, new { screenX = pt.X, screenY = pt.Y });
    }

    private void OnMouseMove(int x, int y)
    {
        if (_dragging)
        {
            Win32.GetCursorPos(out var pt);
            _io.SendEvent(Live2DOps.DragMove, new { screenX = pt.X, screenY = pt.Y });
        }
        else
        {
            _engine.MarkActivity();
        }
    }

    private void OnMouseUp(int x, int y)
    {
        if (!_dragging || _window == null) return;
        Win32.ReleaseCapture();
        _dragging = false;
        _engine.SetDragging(false);

        float dpiScale = _window.Dpi / 96f;
        float dx = (x - _downLocalX) / dpiScale;
        float dy = (y - _downLocalY) / dpiScale;
        if (MathF.Sqrt(dx * dx + dy * dy) <= ClickThresholdDip)
            _engine.Click(_downLocalX / dpiScale, _downLocalY / dpiScale);

        _io.SendEvent(Live2DOps.DragEnd, new { });
        _clickState.Reset(); // 拖拽结束重新评估穿透
    }

    public void Dispose()
    {
        if (_window != null)
        {
            _window.MouseDown -= OnMouseDown;
            _window.MouseMove -= OnMouseMove;
            _window.MouseUp -= OnMouseUp;
            _window.Dispose();
            _window = null;
        }
    }
}
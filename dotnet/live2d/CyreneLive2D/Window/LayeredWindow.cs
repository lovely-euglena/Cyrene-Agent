// 分层窗口壳（T2a）——WS_EX_LAYERED + UpdateLayeredWindow 逐像素 alpha 呈现。
//
// 像素管线：渲染器回读（预乘 BGRA，顶行在前）→ memcpy 到 CreateDIBSection
// （32bpp BI_RGB，biHeight=-h 顶向下）→ UpdateLayeredWindow(ULW_ALPHA,
// AC_SRC_OVER|AC_SRC_ALPHA)。无格式转换、无 Y 翻转。
//
// 坐标：物理像素（进程 PerMonitorV2 DPI 感知在首次创建前设置；
// DIP→物理换算由宿主接线层负责）。窗口初始隐藏、不激活、不进 Alt-Tab。
//
// 消息：单线程消息泵（宿主循环 PeekMessage/DispatchMessage）；
// 鼠标消息经事件转发（窗口局部坐标），其余走 DefWindowProc。
// 点击穿透 = WS_EX_TRANSPARENT 位切换（幂等）。

using System.Collections.Concurrent;
using System.Runtime.InteropServices;

namespace CyreneLive2D.Window;

public sealed class LayeredWindow : IDisposable
{
    private const string ClassName = "CyreneLive2DPetWindow";
    private static bool _classRegistered;
    private static bool _dpiAwarenessSet;
    private static readonly ConcurrentDictionary<IntPtr, LayeredWindow> Instances = new();

    private IntPtr _hwnd;
    private IntPtr _memDc;
    private IntPtr _dib;
    private IntPtr _dibBits;
    private IntPtr _oldBitmap;
    private readonly WndProcDelegate _wndProc; // 防 GC（非托管回调）
    private int _x, _y, _width, _height;
    private bool _clickThrough;
    private bool _topMost;
    private bool _visible;
    private bool _disposed;

    /// <summary>鼠标按下（窗口局部物理像素）。</summary>
    public event Action<int, int>? MouseDown;
    /// <summary>鼠标移动（窗口局部物理像素；仅窗口捕获期间）。</summary>
    public event Action<int, int>? MouseMove;
    /// <summary>鼠标抬起（窗口局部物理像素）。</summary>
    public event Action<int, int>? MouseUp;

    public IntPtr Handle => _hwnd;
    public int X => _x;
    public int Y => _y;
    public int Width => _width;
    public int Height => _height;
    public bool IsVisible => _visible;
    public bool IsClickThrough => _clickThrough;
    public bool IsTopMost => _topMost;

    /// <summary>窗口 DPI（PerMonitorV2；失败回退 96）。宿主层 DIP 换算用。</summary>
    public uint Dpi => _hwnd != IntPtr.Zero ? Win32.GetDpiForWindow(_hwnd) : 96u;

    public LayeredWindow(int x, int y, int width, int height)
    {
        if (width <= 0 || height <= 0) throw new ArgumentException("窗口尺寸必须为正。");
        _x = x; _y = y; _width = width; _height = height;
        _wndProc = WndProc;

        EnsureDpiAwareness();
        EnsureClassRegistered();

        _hwnd = Win32.CreateWindowExW(
            Win32.WS_EX_LAYERED | Win32.WS_EX_TOOLWINDOW | Win32.WS_EX_NOACTIVATE | Win32.WS_EX_TRANSPARENT,
            ClassName, "Cyrene Live2D",
            Win32.WS_POPUP,
            x, y, width, height,
            IntPtr.Zero, IntPtr.Zero, Win32.GetModuleHandleW(null), IntPtr.Zero);
        if (_hwnd == IntPtr.Zero)
            throw new InvalidOperationException($"CreateWindowEx 失败: Win32Error={Marshal.GetLastWin32Error()}");

        _clickThrough = true; // 初始穿透（模型加载前不拦截鼠标）
        Instances[_hwnd] = this;
        CreateDib(width, height);
    }

    private static void EnsureDpiAwareness()
    {
        if (_dpiAwarenessSet) return;
        _dpiAwarenessSet = true;
        // 失败（旧系统/已设置）忽略——回退系统 DPI 虚拟化
        Win32.SetProcessDpiAwarenessContext(Win32.DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }

    private static void EnsureClassRegistered()
    {
        if (_classRegistered) return;
        var wc = new WNDCLASSW
        {
            style = 0,
            lpfnWndProc = Marshal.GetFunctionPointerForDelegate(StaticWndProc),
            hInstance = Win32.GetModuleHandleW(null),
            lpszClassName = ClassName,
        };
        ushort atom = Win32.RegisterClassW(ref wc);
        if (atom == 0)
            throw new InvalidOperationException($"RegisterClass 失败: Win32Error={Marshal.GetLastWin32Error()}");
        _classRegistered = true;
    }

    // 静态跳板 → 实例 WndProc（hwnd 查表；查不到走默认处理）
    private static readonly WndProcDelegate StaticWndProc = StaticWndProcImpl;

    private static IntPtr StaticWndProcImpl(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam)
    {
        if (Instances.TryGetValue(hWnd, out var window))
            return window.WndProc(hWnd, msg, wParam, lParam);
        return Win32.DefWindowProcW(hWnd, msg, wParam, lParam);
    }

    private IntPtr WndProc(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam)
    {
        switch (msg)
        {
            case Win32.WM_NCHITTEST:
                // 强制客户区命中——分层窗口默认可能返回 HTTRANSPARENT
                return new IntPtr(Win32.HTCLIENT);

            case Win32.WM_LBUTTONDOWN:
                MouseDown?.Invoke(LowWord(lParam), HighWord(lParam));
                return IntPtr.Zero;

            case Win32.WM_MOUSEMOVE:
                MouseMove?.Invoke(LowWord(lParam), HighWord(lParam));
                return IntPtr.Zero;

            case Win32.WM_LBUTTONUP:
                MouseUp?.Invoke(LowWord(lParam), HighWord(lParam));
                return IntPtr.Zero;

            case Win32.WM_DESTROY:
                Instances.TryRemove(hWnd, out _);
                return IntPtr.Zero;

            default:
                return Win32.DefWindowProcW(hWnd, msg, wParam, lParam);
        }
    }

    private static int LowWord(IntPtr p) => (short)(p.ToInt64() & 0xFFFF);
    private static int HighWord(IntPtr p) => (short)((p.ToInt64() >> 16) & 0xFFFF);

    // ── DIB 管理 ────────────────────────────────────────────

    private void CreateDib(int width, int height)
    {
        DestroyDib();

        var bmi = new BITMAPINFOHEADER
        {
            biSize = (uint)Marshal.SizeOf<BITMAPINFOHEADER>(),
            biWidth = width,
            biHeight = -height, // 顶向下（与渲染回读同序，无 Y 翻转）
            biPlanes = 1,
            biBitCount = 32,
            biCompression = Win32.BI_RGB,
        };

        _memDc = Win32.CreateCompatibleDC(IntPtr.Zero);
        _dib = Win32.CreateDIBSection(_memDc, ref bmi, Win32.DIB_RGB_COLORS, out _dibBits, IntPtr.Zero, 0);
        if (_dib == IntPtr.Zero || _dibBits == IntPtr.Zero)
            throw new InvalidOperationException($"CreateDIBSection 失败: Win32Error={Marshal.GetLastWin32Error()}");
        _oldBitmap = Win32.SelectObject(_memDc, _dib);
    }

    private void DestroyDib()
    {
        if (_memDc != IntPtr.Zero)
        {
            if (_oldBitmap != IntPtr.Zero) Win32.SelectObject(_memDc, _oldBitmap);
            Win32.DeleteDC(_memDc);
            _memDc = IntPtr.Zero;
            _oldBitmap = IntPtr.Zero;
        }
        if (_dib != IntPtr.Zero)
        {
            Win32.DeleteObject(_dib);
            _dib = IntPtr.Zero;
            _dibBits = IntPtr.Zero;
        }
    }

    // ── 呈现 ────────────────────────────────────────────────

    /// <summary>
    /// 呈现一帧：pixels 为预乘 BGRA（顶行在前，长度须 = width*height*4）。
    /// 同时落位窗口（UpdateLayeredWindow 自带 move+size 语义）。
    /// </summary>
    public void Present(byte[] pixels)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        if (pixels.Length != _width * _height * 4)
            throw new ArgumentException($"像素缓冲长度 {pixels.Length} ≠ {_width}×{_height}×4。");

        Marshal.Copy(pixels, 0, _dibBits, pixels.Length);

        var screenDc = Win32.GetDC(IntPtr.Zero);
        try
        {
            var dst = new POINT(_x, _y);
            var size = new SIZE(_width, _height);
            var src = new POINT(0, 0);
            var blend = new BLENDFUNCTION
            {
                BlendOp = Win32.AC_SRC_OVER,
                BlendFlags = 0,
                SourceConstantAlpha = 255,
                AlphaFormat = Win32.AC_SRC_ALPHA,
            };
            if (!Win32.UpdateLayeredWindow(_hwnd, screenDc, ref dst, ref size, _memDc, ref src, 0, ref blend, Win32.ULW_ALPHA))
                throw new InvalidOperationException($"UpdateLayeredWindow 失败: Win32Error={Marshal.GetLastWin32Error()}");
        }
        finally
        {
            Win32.ReleaseDC(IntPtr.Zero, screenDc);
        }
    }

    // ── 窗口状态 ────────────────────────────────────────────

    /// <summary>移动/缩放（物理像素）。尺寸变化重建 DIB；下次 Present 落位。</summary>
    public void SetBounds(int x, int y, int width, int height)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        if (width <= 0 || height <= 0) throw new ArgumentException("窗口尺寸必须为正。");
        _x = x; _y = y;
        if (width != _width || height != _height)
        {
            _width = width; _height = height;
            CreateDib(width, height);
        }
    }

    public void Show()
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        if (_visible) return;
        Win32.ShowWindow(_hwnd, Win32.SW_SHOWNOACTIVATE);
        _visible = true;
    }

    public void Hide()
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        if (!_visible) return;
        Win32.ShowWindow(_hwnd, Win32.SW_HIDE);
        _visible = false;
    }

    /// <summary>点击穿透开关（WS_EX_TRANSPARENT；幂等）。</summary>
    public void SetClickThrough(bool enabled)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        if (enabled == _clickThrough) return;
        int ex = Win32.GetWindowLongW(_hwnd, Win32.GWL_EXSTYLE);
        ex = enabled ? ex | (int)Win32.WS_EX_TRANSPARENT : ex & ~(int)Win32.WS_EX_TRANSPARENT;
        Win32.SetWindowLongW(_hwnd, Win32.GWL_EXSTYLE, ex);
        _clickThrough = enabled;
    }

    /// <summary>置顶开关（screen-saver 级置顶由宿主语义决定；此处 HWND_TOPMOST）。</summary>
    public void SetTopMost(bool enabled)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        if (enabled == _topMost) return;
        Win32.SetWindowPos(_hwnd, enabled ? Win32.HWND_TOPMOST : Win32.HWND_NOTOPMOST,
            0, 0, 0, 0, Win32.SWP_NOMOVE | Win32.SWP_NOSIZE | Win32.SWP_NOACTIVATE);
        _topMost = enabled;
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        if (_hwnd != IntPtr.Zero)
        {
            Win32.DestroyWindow(_hwnd);
            Instances.TryRemove(_hwnd, out _);
            _hwnd = IntPtr.Zero;
        }
        DestroyDib();
    }
}
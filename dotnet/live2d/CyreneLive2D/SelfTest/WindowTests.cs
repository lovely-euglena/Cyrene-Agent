// T2a 自测：分层窗口壳（创建/纯色呈现/穿透位切换/缩放重建/消息分发）。
// 需要桌面会话；CreateWindowEx 失败（无头 CI）时整组 SKIP。
// 不依赖 Core/GPU——纯色填充直接验证 ULW 像素管线。

using System.Runtime.InteropServices;
using CyreneLive2D.Window;

namespace CyreneLive2D.SelfTest;

public static class WindowTests
{
    public static void Run()
    {
        LayeredWindow window;
        try
        {
            window = new LayeredWindow(-10000, -10000, 8, 8); // 屏幕外，避免干扰
        }
        catch (Exception ex)
        {
            SelfTestRunner.Skip("window", $"无桌面会话或创建失败: {ex.Message}");
            return;
        }

        try
        {
            SelfTestRunner.Check(window.Handle != IntPtr.Zero, "window.create");
            SelfTestRunner.Check(!window.IsVisible, "window.initiallyHidden");
            SelfTestRunner.Check(window.IsClickThrough, "window.initiallyClickThrough");

            // ── 纯色呈现（预乘 BGRA：不透明红 = 00,00,FF,FF） ──
            var pixels = new byte[8 * 8 * 4];
            for (int i = 0; i < pixels.Length; i += 4)
            {
                pixels[i] = 0;     // B
                pixels[i + 1] = 0; // G
                pixels[i + 2] = 255; // R
                pixels[i + 3] = 255; // A
            }
            window.Present(pixels);
            SelfTestRunner.Check(true, "window.presentSolid");

            // 半透明像素（预乘：A=128 → RGB 各 128 的红）同样可呈现
            for (int i = 0; i < pixels.Length; i += 4)
            {
                pixels[i] = 0;
                pixels[i + 1] = 0;
                pixels[i + 2] = 128;
                pixels[i + 3] = 128;
            }
            window.Present(pixels);
            SelfTestRunner.Check(true, "window.presentSemiTransparent");

            // 缓冲长度校验
            bool threw = false;
            try { window.Present(new byte[16]); }
            catch (ArgumentException) { threw = true; }
            SelfTestRunner.Check(threw, "window.presentSizeGuard");

            // ── 点击穿透位切换（直接读 exstyle 验证） ──
            window.SetClickThrough(false);
            int ex = Win32.GetWindowLongW(window.Handle, Win32.GWL_EXSTYLE);
            SelfTestRunner.Check((ex & (int)Win32.WS_EX_TRANSPARENT) == 0, "window.clickThroughOff");
            SelfTestRunner.Check(!window.IsClickThrough, "window.clickThroughStateOff");
            window.SetClickThrough(false); // 幂等
            window.SetClickThrough(true);
            ex = Win32.GetWindowLongW(window.Handle, Win32.GWL_EXSTYLE);
            SelfTestRunner.Check((ex & (int)Win32.WS_EX_TRANSPARENT) != 0, "window.clickThroughOn");

            // ── 显隐 ──
            window.Show();
            SelfTestRunner.Check(window.IsVisible, "window.show");
            window.Show(); // 幂等
            window.Hide();
            SelfTestRunner.Check(!window.IsVisible, "window.hide");

            // ── 置顶 ──
            window.SetTopMost(true);
            SelfTestRunner.Check(window.IsTopMost, "window.topMostOn");
            window.SetTopMost(false);
            SelfTestRunner.Check(!window.IsTopMost, "window.topMostOff");

            // ── 缩放重建 DIB → 新尺寸呈现 ──
            window.SetBounds(-10000, -10000, 16, 12);
            SelfTestRunner.Check(window.Width == 16 && window.Height == 12, "window.setBounds");
            var resized = new byte[16 * 12 * 4];
            for (int i = 3; i < resized.Length; i += 4) resized[i] = 255;
            window.Present(resized);
            SelfTestRunner.Check(true, "window.presentAfterResize");

            // ── 消息分发：PostMessage → PeekMessage/Dispatch → 事件 ──
            int downX = -1, downY = -1, upX = -1, upY = -1;
            window.MouseDown += (x, y) => { downX = x; downY = y; };
            window.MouseUp += (x, y) => { upX = x; upY = y; };
            Win32.PostMessageW(window.Handle, Win32.WM_LBUTTONDOWN, IntPtr.Zero, MakeLParam(10, 20));
            Win32.PostMessageW(window.Handle, Win32.WM_LBUTTONUP, IntPtr.Zero, MakeLParam(12, 24));
            PumpMessages();
            SelfTestRunner.Check(downX == 10 && downY == 20, "window.mouseDownEvent", $"{downX},{downY}");
            SelfTestRunner.Check(upX == 12 && upY == 24, "window.mouseUpEvent", $"{upX},{upY}");

            // 负坐标（多显示器屏幕外）：lParam 有符号 short 解码
            Win32.PostMessageW(window.Handle, Win32.WM_MOUSEMOVE, IntPtr.Zero, MakeLParam(-5, -7));
            int moveX = 0, moveY = 0;
            window.MouseMove += (x, y) => { moveX = x; moveY = y; };
            PumpMessages();
            SelfTestRunner.Check(moveX == -5 && moveY == -7, "window.mouseMoveNegative", $"{moveX},{moveY}");
        }
        finally
        {
            window.Dispose();
            window.Dispose(); // 双重 Dispose 安全
        }
        SelfTestRunner.Check(true, "window.dispose");
    }

    private static IntPtr MakeLParam(int x, int y)
        => new((uint)(ushort)x | ((uint)(ushort)y << 16));

    private static void PumpMessages()
    {
        while (Win32.PeekMessageW(out var msg, IntPtr.Zero, 0, 0, Win32.PM_REMOVE))
        {
            Win32.TranslateMessage(ref msg);
            Win32.DispatchMessageW(ref msg);
        }
    }
}
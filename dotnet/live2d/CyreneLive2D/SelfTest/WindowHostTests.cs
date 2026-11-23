// T2a 自测：窗口宿主接线（DIP 换算 / 拖拽事件 / 点击穿透覆盖 / 显隐）。
// 无头可跑：不加载模型、不渲染（Pump 在未加载时仅分发消息+光标轮询）。
// 需要桌面会话；窗口创建失败时整组 SKIP。

using System.Text;
using System.Text.Json;
using CyreneLive2D.Host;
using CyreneLive2D.Window;

namespace CyreneLive2D.SelfTest;

public static class WindowHostTests
{
    public static void Run()
    {
        using var log = new FrameLog();
        using var engine = new PetEngine(log.Io, null);
        using var host = new PetWindowHost(engine, log.Io);
        engine.WindowControl = host;

        try
        {
            host.Show();
        }
        catch (Exception ex)
        {
            SelfTestRunner.Skip("windowHost", $"无桌面会话或创建失败: {ex.Message}");
            return;
        }

        var win = host.WindowForTest;
        if (win == null)
        {
            SelfTestRunner.Skip("windowHost", "窗口未创建");
            return;
        }
        SelfTestRunner.Check(win.IsVisible, "windowHost.showCreatesWindow");

        // ── DIP→物理换算（按真实 DPI 校验） ──
        float s = win.Dpi / 96f;
        host.SetBoundsDip(-10000, -10000, 400, 500);
        SelfTestRunner.Check(win.Width == (int)Math.Round(400 * s) && win.Height == (int)Math.Round(500 * s),
            "windowHost.dipToPhysical", $"{win.Width}×{win.Height} dpi={win.Dpi}");
        SelfTestRunner.Check(win.X == (int)Math.Round(-10000 * s) && win.Y == (int)Math.Round(-10000 * s),
            "windowHost.dipPosition");

        // ── 点击穿透覆盖：setInteractive(true) → 下一轮 Pump 强制可交互 ──
        Call(engine, "setInteractive", new { value = true });
        host.Pump(100); // 触发光标轮询（首次 nowMs-0>=50）
        SelfTestRunner.Check(!win.IsClickThrough, "windowHost.overrideInteractive");
        SelfTestRunner.Check(HasEvent(log, "interactive", true), "windowHost.interactiveEvent");

        Call(engine, "setInteractive", new { value = false });
        host.Pump(200);
        // 无模型 → _lastFrame=null → 穿透恢复
        SelfTestRunner.Check(win.IsClickThrough, "windowHost.overrideReleased");

        // ── 拖拽：投递鼠标消息 → Pump 分发 → dragStart/dragEnd 事件 ──
        Win32.PostMessageW(win.Handle, Win32.WM_LBUTTONDOWN, IntPtr.Zero, MakeLParam(100, 100));
        host.Pump(300);
        SelfTestRunner.Check(HasEvent(log, "dragStart"), "windowHost.dragStartEvent");
        SelfTestRunner.Check(engine.IsPaused, "windowHost.dragPausesEngine");

        Win32.PostMessageW(win.Handle, Win32.WM_MOUSEMOVE, IntPtr.Zero, MakeLParam(110, 110));
        host.Pump(350);
        SelfTestRunner.Check(HasEvent(log, "dragMove"), "windowHost.dragMoveEvent");

        // ── 拖拽暂停期 setBounds 即时落位（P1：不能等松手才跳位） ──
        // 无头自测无模型渲染 → 注入上一帧，验证暂停分支的复呈落位路径。
        host.SeedLastFrameForTest(new byte[win.Width * win.Height * 4], win.Width, win.Height);
        host.SetBoundsDip(-9950, -9900, 400, 500); // 拖拽中主进程下发新位置（尺寸不变）
        host.Pump(360);
        SelfTestRunner.Check(engine.IsPaused, "windowHost.dragStillPaused");
        SelfTestRunner.Check(win.X == (int)Math.Round(-9950 * s) && win.Y == (int)Math.Round(-9900 * s),
            "windowHost.dragBoundsImmediate", $"{win.X},{win.Y}");

        Win32.PostMessageW(win.Handle, Win32.WM_LBUTTONUP, IntPtr.Zero, MakeLParam(100, 100));
        host.Pump(400);
        SelfTestRunner.Check(HasEvent(log, "dragEnd"), "windowHost.dragEndEvent");
        SelfTestRunner.Check(!engine.IsPaused, "windowHost.dragEndResumes");

        // ── 显隐 op ──
        Call(engine, "hide");
        SelfTestRunner.Check(!win.IsVisible, "windowHost.hideOp");
        Call(engine, "show");
        SelfTestRunner.Check(win.IsVisible, "windowHost.showOp");

        // ── 置顶 op ──
        Call(engine, "setAlwaysOnTop", new { value = true });
        SelfTestRunner.Check(win.IsTopMost, "windowHost.alwaysOnTop");
        Call(engine, "setAlwaysOnTop", new { value = false });
        SelfTestRunner.Check(!win.IsTopMost, "windowHost.alwaysOnTopOff");

        // ── 未加载时 IsRendering=false（宿主睡眠粒度） ──
        SelfTestRunner.Check(!host.IsRendering, "windowHost.notRenderingWithoutModel");
    }

    private static IntPtr MakeLParam(int x, int y)
        => new((uint)(ushort)x | ((uint)(ushort)y << 16));

    private static void Call(PetEngine engine, string op, object? args = null)
    {
        var frame = new Dictionary<string, object?> { ["op"] = op, ["callId"] = "c" };
        if (args != null)
        {
            var json = JsonSerializer.Serialize(args);
            using var doc = JsonDocument.Parse(json);
            foreach (var prop in doc.RootElement.EnumerateObject()) frame[prop.Name] = prop.Value.Clone();
        }
        var frameJson = JsonSerializer.Serialize(frame);
        using var frameDoc = JsonDocument.Parse(frameJson);
        engine.Handle(op, "c", frameDoc.RootElement);
    }

    private static bool HasEvent(FrameLog log, string name, bool? value = null)
    {
        foreach (var f in log.ReadAll())
        {
            if (f.GetProperty("op").GetString() != "event") continue;
            if (f.GetProperty("name").GetString() != name) continue;
            if (value.HasValue)
            {
                if (f.TryGetProperty("payload", out var p) && p.TryGetProperty("value", out var v) && v.GetBoolean() == value.Value)
                    return true;
            }
            else return true;
        }
        return false;
    }

    private sealed class FrameLog : IDisposable
    {
        private readonly MemoryStream _stream = new();
        public HostIo Io { get; }
        public FrameLog() { Io = new HostIo(_stream); }
        public void Dispose() { Io.Dispose(); _stream.Dispose(); }

        public List<JsonElement> ReadAll()
        {
            _stream.Position = 0;
            var frames = new List<JsonElement>();
            using var reader = new StreamReader(_stream, Encoding.UTF8, false, 1024, leaveOpen: true);
            string? line;
            while ((line = reader.ReadLine()) != null)
            {
                if (line.Length == 0) continue;
                frames.Add(JsonDocument.Parse(line).RootElement.Clone());
            }
            return frames;
        }
    }
}
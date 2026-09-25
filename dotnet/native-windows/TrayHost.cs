using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Text.Json;
using System.Windows;
using System.Windows.Threading;
using WpfApplication = System.Windows.Application;
using WF = System.Windows.Forms;

namespace CyreneNative;

/// <summary>
/// 分离式托盘宿主（cyrene-native --tray）。
///
/// 架构：托盘进程常驻（约 15-25MB），Electron 主程序成为「按需工作进程」——
/// 用户把桌宠/窗口全关后 Electron 可整体退出，仅托盘驻留，从托盘再拉起。
/// 通信：named pipe cyrene-tray（JSON 行协议，\n 分隔）：
///   Electron → tray：{"op":"tray.ready"} / {"op":"tray.icon","path":...} /
///                    {"op":"tray.notify","text":...} / {"op":"tray.byefrom.electron"}
///   tray → Electron：{"op":"cmd","action":"chat|sidebar|settings|toggle-pet|show-pet|quit"}
/// Electron 直启（未经过托盘 spawn）或 pipe 断开时走 Electron 内置 Tray 兜底，
/// 两种模式对用户等价。
/// </summary>
public sealed class TrayHost
{
    private const string PipeName = "cyrene-tray";
    private WF.NotifyIcon? _notifyIcon;
    private System.Diagnostics.Process? _electron;
    private NamedPipeServerStream? _pipe;
    private CancellationTokenSource? _pipeCts;
    private string _electronExe = "";
    private bool _electronLaunching;
    /// <summary>Electron 未连接时暂存的托盘动作，连接建立后补投一次。</summary>
    private string? _pendingAction;

    /// <summary>托盘模式入口：WPF Dispatcher 消息循环 + NotifyIcon。</summary>
    public static void Run(string electronExe)
    {
        var app = new WpfApplication { ShutdownMode = System.Windows.ShutdownMode.OnExplicitShutdown };
        var host = new TrayHost { _electronExe = electronExe };
        app.Dispatcher.Invoke(() => host.Attach(app));
        // 托盘常驻：启动即拉起 Electron（用户双击托盘 exe 的预期）
        app.Dispatcher.BeginInvoke(new Action(host.LaunchElectron), DispatcherPriority.Background);
        app.Run();
        host.DetachIcon();
    }

    private void Attach(WpfApplication app)
    {
        var iconPath = Path.Combine(AppContext.BaseDirectory, "assets", "loading.png");
        var menu = new WF.ContextMenuStrip();
        menu.Items.Add("打开聊天窗口", null, (_, _) => SendCmd("chat"));
        menu.Items.Add("打开状态面板", null, (_, _) => SendCmd("sidebar"));
        menu.Items.Add("设置", null, (_, _) => SendCmd("settings"));
        menu.Items.Add(new WF.ToolStripSeparator());
        menu.Items.Add("显示/隐藏桌宠", null, (_, _) => SendCmd("toggle-pet"));
        menu.Items.Add(new WF.ToolStripSeparator());
        menu.Items.Add("退出", null, (_, _) =>
        {
            // 退出 = Electron 一起退（托盘是父入口，退出语义包含整个应用）。
            // 先发 quit 走受控退出（总超时 10s），等它自然退出；超时才强杀，
            // 且必须整棵进程树一起杀——只杀 Cyrene.exe 会留下渲染进程/子宿主
            // （用户报「托盘退出时有进程残留」）。
            SendCmd("quit");
            var p = _electron;
            if (p is not null && !p.HasExited)
            {
                try
                {
                    p.WaitForExit(15000);
                }
                catch { /* 超时强杀 */ }
                if (!p.HasExited)
                {
                    try { p.Kill(entireProcessTree: true); } catch { }
                }
            }
            app.Dispatcher.BeginInvokeShutdown(DispatcherPriority.Background);
        });

        _notifyIcon = new WF.NotifyIcon
        {
            Text = "Cyrene",
            Visible = true,
            ContextMenuStrip = menu,
        };
        try
        {
            // ExtractAssociatedIcon 返回 Icon 直接可用；托盘要求 32×32
            _notifyIcon.Icon = System.Drawing.Icon.ExtractAssociatedIcon(
                System.Environment.ProcessPath ?? "");
        }
        catch
        {
            // 图标提取失败：fallback 到 SystemIcons.Application，托盘不空白
            _notifyIcon.Icon = System.Drawing.SystemIcons.Application;
        }
        _notifyIcon.DoubleClick += (_, _) => SendCmd("chat");
        StartPipeServer();
    }

    private void DetachIcon()
    {
        try { _notifyIcon?.Dispose(); } catch { }
        _pipeCts?.Cancel();
        try { _pipe?.Disconnect(); } catch { }
        _pipeCts = null;
        _pipe = null;
    }

    // ── Electron 子进程管理 ─────────────────────────────────────

    private void LaunchElectron()
    {
        if (_electronLaunching) return;
        // 已在运行：不重复拉起（单实例锁会拒绝）；动作已暂存，等管道重连补投。
        // ⚠️ 不可在此递归 SendCmd——管道断开时会在 SendCmd↔LaunchElectron
        // 之间无限递归直至栈溢出。
        if (_electron is not null && !_electron.HasExited) return;
        if (!File.Exists(_electronExe))
        {
            System.Diagnostics.Debug.WriteLine($"[TrayHost] Electron exe not found: {_electronExe}");
            return;
        }
        _electronLaunching = true;
        try
        {
            _electron = System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo
            {
                FileName = _electronExe,
                UseShellExecute = true,
                WorkingDirectory = Path.GetDirectoryName(_electronExe) ?? "",
            });
            _electron!.Exited += (_, _) =>
            {
                // Electron 意外退出/被用户关闭：托盘常驻，等待用户再次拉起
                _electron = null;
            };
            _electron.EnableRaisingEvents = true;
        }
        catch (Exception ex)
        {
            System.Diagnostics.Debug.WriteLine($"[TrayHost] failed to launch Electron: {ex.Message}");
        }
        finally
        {
            _electronLaunching = false;
        }
    }

    // ── pipe 服务端（接收 Electron 的状态上报） ────────────────

    private void StartPipeServer()
    {
        _pipeCts = new CancellationTokenSource();
        var ct = _pipeCts.Token;
        System.Threading.Tasks.Task.Run(async () =>
        {
            while (!ct.IsCancellationRequested)
            {
                NamedPipeServerStream? server = null;
                try
                {
                    server = new NamedPipeServerStream(
                        PipeName,
                        PipeDirection.InOut,
                        NamedPipeServerStream.MaxAllowedServerInstances,
                        PipeTransmissionMode.Byte,
                        PipeOptions.Asynchronous);
                    await server.WaitForConnectionAsync(ct);
                    if (_pipe is { IsConnected: true })
                    {
                        // 已有连接（多实例守护交给 Electron 单实例锁）：拒绝新连接
                        try { server.Disconnect(); } catch { }
                        server.Dispose();
                        continue;
                    }
                    _pipe = server;
                    // 连接建立后补投 Electron 未运行时点击的托盘动作
                    FlushPendingAction(server);
                    await ReadLoopAsync(server, ct);
                }
                catch (OperationCanceledException) { break; }
                catch (IOException)
                {
                    // Electron 断开：回循环等重连（托盘常驻语义）
                }
                catch (Exception ex)
                {
                    System.Diagnostics.Debug.WriteLine($"[TrayHost] pipe error: {ex.Message}");
                    await System.Threading.Tasks.Task.Delay(1000, ct).ContinueWith(_ => { });
                }
                finally
                {
                    try { server?.Dispose(); } catch { }
                    if (ReferenceEquals(_pipe, server)) _pipe = null;
                }
            }
        }, ct);
    }

    private static async System.Threading.Tasks.Task ReadLoopAsync(NamedPipeServerStream pipe, CancellationToken ct)
    {
        var buffer = new byte[8192];
        var lineBuffer = new StringBuilder();
        while (!ct.IsCancellationRequested && pipe.IsConnected)
        {
            var read = await pipe.ReadAsync(buffer, 0, buffer.Length, ct);
            if (read <= 0) break;
            lineBuffer.Append(Encoding.UTF8.GetString(buffer, 0, read));
            while (lineBuffer.ToString().Contains('\n'))
            {
                var content = lineBuffer.ToString();
                var idx = content.IndexOf('\n');
                var line = content[..idx].Trim();
                lineBuffer.Remove(0, idx + 1);
                if (line.Length == 0) continue;
                HandleElectronMessage(line);
            }
        }
    }

    private static void HandleElectronMessage(string line)
    {
        try
        {
            using var doc = JsonDocument.Parse(line);
            var op = doc.RootElement.TryGetProperty("op", out var opEl) ? opEl.GetString() : null;
            switch (op)
            {
                case "tray.ready":
                    System.Diagnostics.Debug.WriteLine("[TrayHost] Electron ready");
                    break;
                case "tray.icon":
                    // 状态图标切换（陪伴中/思考中）——后续接 Electron 侧推送
                    break;
                case "tray.notify":
                    // 气泡通知
                    break;
                default:
                    System.Diagnostics.Debug.WriteLine($"[TrayHost] unknown op: {op}");
                    break;
            }
        }
        catch (JsonException)
        {
            // 忽略坏帧
        }
    }

    // ── 托盘 → Electron 命令 ───────────────────────────────────

    private void SendCmd(string action)
    {
        var pipe = _pipe;
        if (pipe is not { IsConnected: true } || !TryWriteCmd(pipe, action))
        {
            // Electron 未运行/管道断开：暂存动作并（必要时）拉起，连接建立后补投。
            // 旧实现直接丢动作 → 托盘「打开状态面板」在 Electron 未运行时拉起后
            // 不打开任何窗口（用户报「状态页无法从托盘打开」）。
            _pendingAction = action;
            _pipe = null;
            LaunchElectron();
        }
    }

    private static bool TryWriteCmd(NamedPipeServerStream pipe, string action)
    {
        try
        {
            var payload = Encoding.UTF8.GetBytes($"{{\"op\":\"cmd\",\"action\":\"{action}\"}}\n");
            lock (pipe)
            {
                pipe.Write(payload, 0, payload.Length);
                pipe.Flush();
            }
            return true;
        }
        catch (IOException)
        {
            return false;
        }
    }

    private void FlushPendingAction(NamedPipeServerStream pipe)
    {
        var action = _pendingAction;
        if (action is null) return;
        if (TryWriteCmd(pipe, action)) _pendingAction = null;
    }

    /// <summary>从本 exe 位置推导同级 Electron 主程序（resources/native-windows → ../../Cyrene.exe）。</summary>
    public static string ResolveElectronExe()
    {
        var dir = AppContext.BaseDirectory;
        // 打包布局：<root>/resources/native-windows/cyrene-native.exe → <root>/Cyrene.exe
        var root = Path.GetFullPath(Path.Combine(dir, "..", ".."));
        var packaged = Path.Combine(root, "Cyrene.exe");
        if (File.Exists(packaged)) return packaged;
        // 开发布局（repo/release/win-unpacked）：native bin 在 dotnet/ 下 → 上两级
        var dev = Path.Combine(Path.GetFullPath(Path.Combine(dir, "..", "..")), "Cyrene.exe");
        return File.Exists(dev) ? dev : packaged;
    }
}

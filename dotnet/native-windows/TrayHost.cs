using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Text.Json;
using System.Windows;
using System.Windows.Threading;
using CyreneNative.Scheduler;
using WpfApplication = System.Windows.Application;
using WF = System.Windows.Forms;

namespace CyreneNative;

/// <summary>
/// 分离式托盘宿主（cyrene-native --tray）。
///
/// 架构：托盘进程常驻（约 15-25MB），Electron 主程序成为「按需工作进程」——
/// 用户把桌宠/窗口全关后 Electron 可整体退出，仅托盘驻留，从托盘再拉起。
/// 单实例：Global\cyrene-tray Mutex（机器级，与管道名同作用域；双托盘会双调度，设计 §7）。
/// 通信：named pipe cyrene-tray（JSON 行协议，\n 分隔）：
///   Electron → tray：{"op":"tray.ready"} / {"op":"tray.icon","path":...} /
///                    {"op":"tray.notify","text":...} / {"op":"tray.tooltip","text":...} /
///                    {"op":"tray.drag-mode-state","checked":bool}（勾选对齐）/
///                    {"op":"tray.byefrom.electron"} /
///                    sched.*（见 TraySchedulerHost；带 id 必回 reply）
///   tray → Electron：{"op":"cmd","action":"chat|sidebar|settings|hide-windows|
///                    toggle-pet|show-pet|drag-mode|quit"} / {"op":"event",name:"sched.*",data}
/// Electron 直启（未经过托盘 spawn）或 pipe 断开时走 Electron 内置 Tray 兜底，
/// 两种模式对用户等价。
/// </summary>
public sealed class TrayHost
{
    private const string PipeName = "cyrene-tray";
    private WF.NotifyIcon? _notifyIcon;
    /// <summary>「桌宠拖动模式」菜单项（Electron 状态帧按实际结果对齐勾选）。</summary>
    private WF.ToolStripMenuItem? _dragModeItem;
    private System.Diagnostics.Process? _electron;
    private NamedPipeServerStream? _pipe;
    private CancellationTokenSource? _pipeCts;
    private System.Windows.Threading.Dispatcher? _dispatcher;
    /// <summary>当前托盘图标的 HICON 句柄（PNG→Icon 转换产物，替换/退出时销毁）。</summary>
    private IntPtr _trayIconHandle = IntPtr.Zero;
    private string _electronExe = "";
    private string _dataDir = "";
    /// <summary>--scheduler：托盘启动即启用常驻调度；缺省仅托盘 UI，待 sched.mode arm。</summary>
    private bool _schedulerEnabled;
    private bool _electronLaunching;
    /// <summary>Electron 未连接时暂存的托盘动作（含可选勾选状态），连接建立后补投一次。</summary>
    private (string Action, bool? Checked)? _pendingAction;
    /// <summary>常驻调度宿主（IKJK51）：SchedulerStore/Engine + sched.* 协议。</summary>
    private TraySchedulerHost? _scheduler;


    /// <summary>
    /// WinForms 托盘菜单现代化：默认经典灰 → 项目浅色扁平风（对齐 native 设置窗
    /// NativeTheme 色板：Surface 白底、Pink 强调悬停、TextDefault 文字、1px 软边框）。
    /// WinForms 菜单不支持 WPF 圆角，用无边框 + 悬停色块贴近整体观感。
    /// </summary>
    private static void ApplyModernMenuStyle(WF.ContextMenuStrip menu)
    {
        menu.RenderMode = WF.ToolStripRenderMode.ManagerRenderMode;
        var cm = WF.ToolStripManager.RenderMode;
        menu.BackColor = System.Drawing.Color.FromArgb(0xFA, 0xFA, 0xFC);
        menu.ForeColor = System.Drawing.Color.FromArgb(0x2C, 0x2C, 0x2E);
        menu.Font = new System.Drawing.Font("Microsoft YaHei UI", 9.5f, System.Drawing.FontStyle.Regular);
        menu.ShowImageMargin = false;
        menu.Renderer = new TrayMenuRenderer();
    }

    /// <summary>托盘菜单自绘：悬停 PinkSoft 色块 + 分隔线 BorderSoft + 选中勾 Pink。</summary>
    private sealed class TrayMenuRenderer : WF.ToolStripProfessionalRenderer
    {
        public TrayMenuRenderer() : base(new TrayMenuColorTable()) { }

        protected override void OnRenderMenuItemBackground(WF.ToolStripItemRenderEventArgs e)
        {
            var item = e.Item as WF.ToolStripMenuItem;
            if (item is not null && (item.Selected || item.Pressed))
            {
                using var brush = new System.Drawing.SolidBrush(System.Drawing.Color.FromArgb(0xFF, 0xEC, 0xF2));
                var bounds = new System.Drawing.Rectangle(System.Drawing.Point.Empty, e.Item.Size);
                e.Graphics.FillRectangle(brush, bounds);
            }
            // 非悬停：透明底（菜单 BackColor 已浅色）
        }

        protected override void OnRenderItemCheck(WF.ToolStripItemImageRenderEventArgs e)
        {
            // 勾选标记用主题 Pink，避免默认黑勾
            using var pen = new System.Drawing.Pen(System.Drawing.Color.FromArgb(0xFF, 0x5B, 0x8A), 2f);
            var r = e.ImageRectangle;
            e.Graphics.DrawLine(pen, r.Left + r.Width / 4, r.Top + r.Height / 2, r.Left + r.Width / 2, r.Top + 3 * r.Height / 4);
            e.Graphics.DrawLine(pen, r.Left + r.Width / 2, r.Top + 3 * r.Height / 4, r.Left + 3 * r.Width / 4, r.Top + r.Height / 4);
        }
    }

    private sealed class TrayMenuColorTable : WF.ProfessionalColorTable
    {
        // 全部回菜单底色：消灭默认蓝/灰高亮与 3D 边框（扁平化）
        public override System.Drawing.Color MenuItemSelected => System.Drawing.Color.FromArgb(0xFF, 0xEC, 0xF2);
        public override System.Drawing.Color MenuItemSelectedGradientBegin => System.Drawing.Color.FromArgb(0xFF, 0xEC, 0xF2);
        public override System.Drawing.Color MenuItemSelectedGradientEnd => System.Drawing.Color.FromArgb(0xFF, 0xEC, 0xF2);
        public override System.Drawing.Color MenuItemPressedGradientBegin => System.Drawing.Color.FromArgb(0xFF, 0xEC, 0xF2);
        public override System.Drawing.Color MenuItemPressedGradientEnd => System.Drawing.Color.FromArgb(0xFF, 0xEC, 0xF2);
        public override System.Drawing.Color MenuItemBorder => System.Drawing.Color.FromArgb(0xFF, 0xEC, 0xF2);
        public override System.Drawing.Color ToolStripDropDownBackground => System.Drawing.Color.FromArgb(0xFA, 0xFA, 0xFC);
        public override System.Drawing.Color ImageMarginGradientBegin => System.Drawing.Color.FromArgb(0xFA, 0xFA, 0xFC);
        public override System.Drawing.Color ImageMarginGradientMiddle => System.Drawing.Color.FromArgb(0xFA, 0xFA, 0xFC);
        public override System.Drawing.Color ImageMarginGradientEnd => System.Drawing.Color.FromArgb(0xFA, 0xFA, 0xFC);
        public override System.Drawing.Color MenuBorder => System.Drawing.Color.FromArgb(0xE5, 0xE5, 0xEA);
        public override System.Drawing.Color SeparatorDark => System.Drawing.Color.FromArgb(0xE5, 0xE5, 0xEA);
        public override System.Drawing.Color SeparatorLight => System.Drawing.Color.FromArgb(0xE5, 0xE5, 0xEA);
    }

    /// <summary>托盘模式入口：单实例守护 + WPF Dispatcher 消息循环 + NotifyIcon。</summary>
    public static int Run(string electronExe, string dataDir, bool schedulerEnabled)
    {
        // 单实例守护（设计 §7 + 复审 P2-6）：双托盘会双调度；管道名是机器级
        // （\\.\pipe\cyrene-tray），锁也用 Global 命名空间——同机多会话/多用户
        // 下与管道作用域一致，避免 Local 会话级锁各起一个托盘共享同一 data-dir。
        using var mutex = new Mutex(initiallyOwned: true, @"Global\cyrene-tray", out var createdNew);
        if (!createdNew) return 0;
        var app = new WpfApplication { ShutdownMode = System.Windows.ShutdownMode.OnExplicitShutdown };
        var host = new TrayHost { _electronExe = electronExe, _dataDir = dataDir, _schedulerEnabled = schedulerEnabled };
        app.Dispatcher.Invoke(() => host.Attach(app));
        // 托盘常驻：启动即拉起 Electron（用户双击托盘 exe 的预期）
        app.Dispatcher.BeginInvoke(new Action(host.LaunchElectron), DispatcherPriority.Background);
        app.Run();
        host.DetachIcon();
        return 0;
    }

    private void Attach(WpfApplication app)
    {
        _dispatcher = app.Dispatcher;
        StartScheduler();
        var menu = new WF.ContextMenuStrip();
        ApplyModernMenuStyle(menu);
        menu.Items.Add("打开聊天窗口", null, (_, _) => SendCmd("chat"));
        menu.Items.Add("打开状态面板", null, (_, _) => SendCmd("sidebar"));
        menu.Items.Add("设置", null, (_, _) => SendCmd("settings"));
        // 隐藏窗口（§6）：只藏 Electron 窗口，托盘与调度继续常驻
        menu.Items.Add("隐藏窗口", null, (_, _) => SendCmd("hide-windows"));
        menu.Items.Add(new WF.ToolStripSeparator());
        menu.Items.Add("显示/隐藏桌宠", null, (_, _) => SendCmd("toggle-pet"));
        // 桌宠拖动模式（对齐 Electron 内置托盘菜单项；宿主 setPetDragMode 设置目标状态）
        var dragItem = new WF.ToolStripMenuItem("桌宠拖动模式") { CheckOnClick = false };
        _dragModeItem = dragItem;
        dragItem.Click += (_, _) =>
        {
            // 勾选状态即目标状态，随指令透传（修复「只能开不能关」）；
            // 点击先保守翻转给即时反馈，宿主执行后回执 tray.drag-mode-state
            // 帧（见 HandleElectronMessage），按实际结果再次对齐。
            dragItem.Checked = !dragItem.Checked;
            SendCmd("drag-mode", dragItem.Checked);
        };
        menu.Items.Add(dragItem);
        menu.Items.Add(new WF.ToolStripSeparator());
        // 完全退出（§6）：停调度（engine.Stop()）→ 受控退出 Electron → 扫尾 → 托盘退出。
        menu.Items.Add("完全退出", null, (_, _) =>
        {
            // 先停调度：退出窗口内不再触发，也不再把任务拉起为 headless。
            _scheduler?.Stop();
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
            // 扫尾：同安装目录下残留的辅助进程（native 宿主/sidecar/截图）一并清理
            KillSiblingHelpers();
            app.Dispatcher.BeginInvokeShutdown(DispatcherPriority.Background);
        });

        _notifyIcon = new WF.NotifyIcon
        {
            Text = "Cyrene",
            Visible = true,
            ContextMenuStrip = menu,
        };
        _notifyIcon.Icon = LoadInitialIcon();
        _notifyIcon.DoubleClick += (_, _) => SendCmd("chat");
        StartPipeServer();
    }

    /// <summary>
    /// 常驻调度宿主（IKJK51）：store.Load →（--scheduler 时）engine.Start。
    /// 初始化失败不拖垮托盘（sched.* 帧回 ok:false，托盘 UI 仍可用）。
    /// </summary>
    private void StartScheduler()
    {
        try
        {
            var scheduler = new TraySchedulerHost(
                _dataDir, _electronExe, _schedulerEnabled, SendEvent, ShowTrayBalloon,
                () => _pipe is { IsConnected: true });
            scheduler.Start();
            _scheduler = scheduler;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[TrayHost] scheduler init failed: {ex.Message}");
            _scheduler = null;
        }
    }

    /// <summary>初始托盘图标：优先 Electron 主程序图标（真实应用图标），
    /// 失败回退本进程图标 / 系统默认，保证托盘不空白。</summary>
    private System.Drawing.Icon LoadInitialIcon()
    {
        foreach (var source in new[] { _electronExe, System.Environment.ProcessPath })
        {
            try
            {
                if (string.IsNullOrEmpty(source) || !File.Exists(source)) continue;
                var icon = System.Drawing.Icon.ExtractAssociatedIcon(source);
                if (icon is not null) return icon;
            }
            catch { /* 尝试下一个来源 */ }
        }
        return System.Drawing.SystemIcons.Application;
    }

    /// <summary>Electron 下发的状态图标（PNG 落盘路径）→ HICON → 更新托盘。
    /// 旧句柄在替换成功后销毁；临时 PNG 用后即删。</summary>
    private void ApplyTrayIconFile(string path)
    {
        _dispatcher?.BeginInvoke(new Action(() =>
        {
            try
            {
                IntPtr handle;
                using (var bitmap = new System.Drawing.Bitmap(path))
                {
                    handle = bitmap.GetHicon();
                }
                if (_notifyIcon is null)
                {
                    NativeMethods.DestroyIcon(handle);
                    return;
                }
                _notifyIcon.Icon = System.Drawing.Icon.FromHandle(handle);
                var previous = _trayIconHandle;
                _trayIconHandle = handle;
                if (previous != IntPtr.Zero) NativeMethods.DestroyIcon(previous);
                Console.Error.WriteLine($"[TrayHost] tray icon updated: {Path.GetFileName(path)}");
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[TrayHost] tray.icon failed: {ex.Message}");
            }
            finally
            {
                try { File.Delete(path); } catch { /* 临时文件清理失败不致命 */ }
            }
        }));
    }

    /// <summary>.NET 版通知后端（issue #153）：core 终态意图 → 托盘气泡适配器。
    /// 供 agent-host 链路注入（无托盘进程的宿主传 null 静默）。</summary>
    public CyreneNative.Notifications.INotificationSink? CreateNotificationSink() =>
        _notifyIcon is null ? null : new TrayNotificationSink(_dispatcher, _notifyIcon);

    /// <summary>系统级气泡通知（Electron tray.notify）：托盘是常驻进程，
    /// 通知不依赖 Electron 窗口是否可见。</summary>
    private void ShowTrayBalloon(string title, string content)
    {
        _dispatcher?.BeginInvoke(new Action(() =>
        {
            try
            {
                _notifyIcon?.ShowBalloonTip(5000, title, content, WF.ToolTipIcon.Info);
                Console.Error.WriteLine($"[TrayHost] tray.notify: {title} | {content}");
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[TrayHost] tray.notify failed: {ex.Message}");
            }
        }));
    }

    private void DetachIcon()
    {
        // 完全退出流程已停；其余退出路径（异常/会话结束）兜底停引擎。
        try { _scheduler?.Stop(); } catch { }
        _scheduler = null;
        try { _notifyIcon?.Dispose(); } catch { }
        if (_trayIconHandle != IntPtr.Zero)
        {
            NativeMethods.DestroyIcon(_trayIconHandle);
            _trayIconHandle = IntPtr.Zero;
        }
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

    private async System.Threading.Tasks.Task ReadLoopAsync(NamedPipeServerStream pipe, CancellationToken ct)
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

    private void HandleElectronMessage(string line)
    {
        try
        {
            using var doc = JsonDocument.Parse(line);
            var root = doc.RootElement;
            var op = root.TryGetProperty("op", out var opEl) && opEl.ValueKind == JsonValueKind.String
                ? opEl.GetString()
                : null;
            if (string.IsNullOrEmpty(op)) return;
            // 协议兼容（设计 §4）：带 id（number/string）的帧必回 reply；
            // 无 id 维持旧单向语义（tray.ready/icon/notify/tooltip 原样）。
            JsonElement? requestId = root.TryGetProperty("id", out var idEl)
                && idEl.ValueKind is JsonValueKind.String or JsonValueKind.Number
                    ? idEl.Clone()
                    : null;

            if (op.StartsWith("sched.", StringComparison.Ordinal))
            {
                var scheduler = _scheduler;
                var result = scheduler is null
                    ? SchedulerOpResult.Failure("scheduler unavailable")
                    : scheduler.Handle(op, root);
                if (requestId is { } schedId) SendReply(schedId, result.Ok, result.Data, result.Error);
                return;
            }

            switch (op)
            {
                case "tray.ready":
                    System.Diagnostics.Debug.WriteLine("[TrayHost] Electron ready");
                    break;
                case "tray.icon":
                    // 状态图标（陪伴中/思考中/自定义应用图标）：PNG 路径 → HICON
                    var iconPath = root.TryGetProperty("path", out var p) ? p.GetString() : null;
                    if (!string.IsNullOrEmpty(iconPath)) ApplyTrayIconFile(iconPath);
                    break;
                case "tray.notify":
                    // 气泡通知：{title, content}（缺省标题 Cyrene）
                    var title = root.TryGetProperty("title", out var tEl) ? tEl.GetString() : null;
                    var content = root.TryGetProperty("content", out var cEl) ? cEl.GetString() : null;
                    ShowTrayBalloon(
                        string.IsNullOrEmpty(title) ? "Cyrene" : title,
                        content ?? "");
                    break;
                case "tray.tooltip":
                    var text = root.TryGetProperty("text", out var textEl) ? textEl.GetString() : null;
                    if (!string.IsNullOrEmpty(text)) _dispatcher?.BeginInvoke(new Action(() =>
                    {
                        try { if (_notifyIcon is not null) _notifyIcon.Text = text.Length > 63 ? text[..63] : text; }
                        catch { /* 提示更新失败不致命 */ }
                    }));
                    break;
                case "tray.drag-mode-state":
                    // Electron 侧拖动模式实际状态（连接建立时同步 / 命令执行结果回执）：
                    // 勾选按宿主真实结果对齐，不再只靠点击时的保守翻转。
                    if (doc.RootElement.TryGetProperty("checked", out var dragEl)
                        && dragEl.ValueKind is JsonValueKind.True or JsonValueKind.False)
                    {
                        var dragChecked = dragEl.GetBoolean();
                        _dispatcher?.BeginInvoke(new Action(() =>
                        {
                            try { if (_dragModeItem is not null) _dragModeItem.Checked = dragChecked; }
                            catch { /* 菜单更新失败不致命 */ }
                        }));
                    }
                    break;
                default:
                    System.Diagnostics.Debug.WriteLine($"[TrayHost] unknown op: {op}");
                    if (requestId is { } unknownId) SendReply(unknownId, false, null, $"unknown op: {op}");
                    return;
            }
            if (requestId is { } ackId) SendReply(ackId, true, null, null);
        }
        catch (JsonException)
        {
            // 忽略坏帧
        }
    }

    // ── 托盘 → Electron 命令 ───────────────────────────────────

    private void SendCmd(string action, bool? checkedState = null)
    {
        var pipe = _pipe;
        if (pipe is not { IsConnected: true } || !TryWriteCmd(pipe, action, checkedState))
        {
            // Electron 未运行/管道断开：暂存动作并（必要时）拉起，连接建立后补投。
            // 旧实现直接丢动作 → 托盘「打开状态面板」在 Electron 未运行时拉起后
            // 不打开任何窗口（用户报「状态页无法从托盘打开」）。
            _pendingAction = (action, checkedState);
            _pipe = null;
            LaunchElectron();
        }
    }

    private static bool TryWriteCmd(NamedPipeServerStream pipe, string action, bool? checkedState = null)
    {
        try
        {
            // checkedState 仅「桌宠拖动模式」携带（菜单勾选 → Electron setPetDragMode）
            var checkedJson = checkedState is null ? "" : $",\"checked\":{(checkedState.Value ? "true" : "false")}";
            var payload = Encoding.UTF8.GetBytes($"{{\"op\":\"cmd\",\"action\":\"{action}\"{checkedJson}}}\n");
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
        var pending = _pendingAction;
        if (pending is null) return;
        if (TryWriteCmd(pipe, pending.Value.Action, pending.Value.Checked)) _pendingAction = null;
    }

    // ── 托盘 → Electron 事件/回执（sched.* 协议，设计 §4） ─────────

    /// <summary>事件帧：{op:"event",name,data}（与 SendCmd 并存；cmd 行为不变）。</summary>
    private bool SendEvent(string name, object data)
        => SendJson(new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            ["op"] = "event",
            ["name"] = name,
            ["data"] = data,
        });

    /// <summary>回执帧：{op:"reply",id,ok,error?,data?}（id 原样回显，number/string 均可）。</summary>
    private void SendReply(JsonElement id, bool ok, object? data, string? error)
    {
        var payload = new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            ["op"] = "reply",
            ["id"] = id,
            ["ok"] = ok,
        };
        if (ok)
        {
            if (data is not null) payload["data"] = data;
        }
        else
        {
            payload["error"] = error ?? "unknown error";
        }
        SendJson(payload);
    }

    /// <summary>统一出站序列化（Web defaults = camelCase）；未连接/写失败返回 false。</summary>
    private bool SendJson(object payload)
    {
        var pipe = _pipe;
        if (pipe is not { IsConnected: true }) return false;
        try
        {
            var bytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(payload, SchedulerJson.Options) + "\n");
            lock (pipe)
            {
                pipe.Write(bytes, 0, bytes.Length);
                pipe.Flush();
            }
            return true;
        }
        catch (Exception ex) when (ex is IOException or ObjectDisposedException or InvalidOperationException)
        {
            return false;
        }
    }

    /// <summary>
    /// 退出兜底：同安装目录下残留的辅助进程（native 宿主 / embed sidecar /
    /// 截图 helper / 语音）一并清理。Electron 侧已有集中回收
    /// （src/main/child-processes.ts），这里覆盖 Electron 被强杀或其清理
    /// 未跑完的路径——托盘是最后退出的进程，负责扫尾。
    /// </summary>
    private void KillSiblingHelpers()
    {
        try
        {
            var root = Path.GetDirectoryName(_electronExe);
            if (string.IsNullOrEmpty(root)) return;
            foreach (var name in new[] { "cyrene-native", "CyreneEmbedSidecar", "cyrene-screenshot", "CyreneVoice" })
            {
                foreach (var process in System.Diagnostics.Process.GetProcessesByName(name))
                {
                    try
                    {
                        if (process.Id == Environment.ProcessId) continue;
                        var path = process.MainModule?.FileName ?? "";
                        if (path.StartsWith(root, StringComparison.OrdinalIgnoreCase))
                        {
                            process.Kill(entireProcessTree: true);
                        }
                    }
                    catch { /* 权限/已退出 */ }
                    finally { process.Dispose(); }
                }
            }
        }
        catch { /* 扫尾失败不影响托盘退出 */ }
    }

    /// <summary>从本 exe 位置推导同级 Electron 主程序（resources/native-windows → ../../Cyrene.exe）。</summary>
    public static string ResolveElectronExe()
    {
        var dir = AppContext.BaseDirectory;
        // 打包布局：<root>/resources/native-windows/cyrene-native.exe → <root>/Cyrene.exe
        var packaged = Path.GetFullPath(Path.Combine(dir, "..", "..", "Cyrene.exe"));
        if (File.Exists(packaged)) return packaged;
        // 开发布局：dotnet bin/publish 层级不定，向上找仓库根的 release/win-unpacked/Cyrene.exe
        var current = new DirectoryInfo(Path.GetFullPath(dir));
        for (var i = 0; i < 8 && current is not null; i++, current = current.Parent)
        {
            var candidate = Path.Combine(current.FullName, "release", "win-unpacked", "Cyrene.exe");
            if (File.Exists(candidate)) return candidate;
        }
        return packaged;
    }
}

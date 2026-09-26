using System.IO;
using System.Text.Json;
using WpfApp = System.Windows.Application;

namespace CyreneNative;

/// <summary>窗口路由：把宿主的 win.* / state.* 命令分发到窗口实例。</summary>
public static class RequestRouter
{
    public static HostProtocol? Protocol { get; set; }

    private static readonly Dictionary<string, NativeWindow> Windows = new();

    public static async Task Handle(System.Windows.Application app, int id, JsonElement element)
    {
        var op = element.TryGetProperty("op", out var opEl) ? opEl.GetString() : null;
        switch (op)
        {
            case "win.spawn":
            {
                var kind = element.GetProperty("kind").GetString()!;
                var layout = element.TryGetProperty("layout", out var layoutEl) ? layoutEl : default;
                app.Dispatcher.Invoke(() =>
                {
                    if (Windows.TryGetValue(kind, out var existing) && !existing.IsClosed)
                    {
                        existing.Activate();
                        // 已开窗：显式 section 请求重定向（设置窗）
                        if (existing is SettingsWindow settingsWindow)
                        {
                            var section = ReadSection(layout);
                            if (section is not null) settingsWindow.SwitchToSection(section);
                        }
                    }
                    else
                    {
                        NativeWindow window = kind switch
                        {
                            "settings" => new SettingsWindow(layout),
                            "plugins" => new PluginManagerWindow(layout),
                            "splash" => new SplashWindow(),
                            "sidebar" => new SidebarWindow(layout),
                            "tasks" => new TasksWindow(layout),
                            _ => throw new ArgumentException($"unknown window kind: {kind}"),
                        };
                        window.ClosedEvent += k =>
                        {
                            Windows.Remove(k);
                            Protocol?.SendEvent(new { op = "event", name = "win.closed", kind = k });
                        };
                        Windows[kind] = window;
                    }
                    Protocol?.ReplyOk(id);
                });
                break;
            }
            case "win.close":
            {
                var kind = element.GetProperty("kind").GetString()!;
                app.Dispatcher.Invoke(() =>
                {
                    if (Windows.TryGetValue(kind, out var w)) w.Close();
                    Protocol?.ReplyOk(id);
                });
                break;
            }
            case "win.show":
            {
                var kind = element.GetProperty("kind").GetString()!;
                app.Dispatcher.Invoke(() =>
                {
                    if (Windows.TryGetValue(kind, out var w)) w.ShowWindow();
                    Protocol?.ReplyOk(id);
                });
                break;
            }
            case "win.layout":
            {
                // pet 窗移动的布局联动：全部窗口重新应用位置
                var layout = element.GetProperty("layout");
                app.Dispatcher.Invoke(() =>
                {
                    foreach (var w in Windows.Values) w.ApplyLayout(layout);
                    Protocol?.ReplyOk(id);
                });
                break;
            }
            case "state.runtime":
            {
                var state = element.GetProperty("state");
                app.Dispatcher.Invoke(() =>
                {
                    if (Windows.TryGetValue("sidebar", out var w) && w is SidebarWindow sidebar)
                        sidebar.ApplyRuntimeState(state);
                    Protocol?.ReplyOk(id);
                });
                break;
            }
            case "state.model":
            {
                var config = element.GetProperty("config");
                app.Dispatcher.Invoke(() =>
                {
                    if (Windows.TryGetValue("sidebar", out var w) && w is SidebarWindow sidebar)
                        sidebar.ApplyModelConfig(config);
                    Protocol?.ReplyOk(id);
                });
                break;
            }
            case "state.tasks":
            {
                var tasks = element.TryGetProperty("tasks", out var tasksEl) ? tasksEl : default;
                var usage = element.TryGetProperty("usage", out var usageEl) ? usageEl : default;
                app.Dispatcher.Invoke(() =>
                {
                    if (Windows.TryGetValue("tasks", out var w) && w is TasksWindow tasksWindow)
                        tasksWindow.ApplyState(tasks, usage);
                    Protocol?.ReplyOk(id);
                });
                break;
            }
            case "state.plugins":
            {
                var payload = element.TryGetProperty("plugins", out var pEl) ? pEl : default;
                app.Dispatcher.Invoke(() =>
                {
                    if (Windows.TryGetValue("plugins", out var w) && w is PluginManagerWindow pluginsWindow)
                        pluginsWindow.ApplyState(payload);
                    Protocol?.ReplyOk(id);
                });
                break;
            }
            case "state.settings":
            {
                var settings = element.TryGetProperty("settings", out var sEl) ? sEl : default;
                app.Dispatcher.Invoke(() =>
                {
                    if (Windows.TryGetValue("settings", out var w) && w is SettingsWindow settingsWindow)
                        settingsWindow.ApplySettings(settings);
                    Protocol?.ReplyOk(id);
                });
                break;
            }
            case "state.settings-notice":
            {
                // 设置窗 section 反馈（保存/测试/同步结果；就地状态行，不重建 section）
                var notice = element.TryGetProperty("notice", out var noticeEl) ? noticeEl : default;
                app.Dispatcher.Invoke(() =>
                {
                    if (Windows.TryGetValue("settings", out var w) && w is SettingsWindow settingsWindow)
                        settingsWindow.ApplyNotice(notice);
                    Protocol?.ReplyOk(id);
                });
                break;
            }
            case "settings.set":
            {
                // native 设置窗 → 宿主：写设置键（白名单在 SendSettingForwarded）
                var key = element.TryGetProperty("key", out var kEl) ? kEl.GetString() : null;
                var value = element.TryGetProperty("value", out var vEl) ? (JsonElement?)vEl : null;
                SendSettingForwarded(key, value);
                Protocol?.ReplyOk(id);
                break;
            }
            default:
                Protocol?.ReplyError(id, $"unsupported op: {op}");
                break;
        }
        await Task.CompletedTask;
    }

    public static void OnEvent(System.Windows.Application app, JsonElement element)
    {
        // 宿主→native 目前无 event 帧（事件都是 native→host 方向）
    }

    /// <summary>读取 win.spawn layout.section（设置窗显式定位；缺省/非法返回 null）。</summary>
    private static string? ReadSection(JsonElement layout)
    {
        if (layout.ValueKind != JsonValueKind.Object) return null;
        if (!layout.TryGetProperty("section", out var s) || s.ValueKind != JsonValueKind.String) return null;
        var value = s.GetString();
        return string.IsNullOrEmpty(value) ? null : value;
    }

    /// <summary>
    /// 设置窗写入设置键（宿主负责落盘与联动生效）。
    /// 走 cmd 事件通道（{"op":"event","name":"cmd","kind":"settings",
    /// "action":"set","key":...,"value":...}）——与 SendCommand 同链路，
    /// 避免与宿主请求/响应的 id 空间冲突（host.ts 的 handleFrame 把带
    /// id 的非 event 帧一律当响应处理）。
    /// </summary>
    public static void SendSetting(string key, object? value)
    {
        var payload = new Dictionary<string, object?>
        {
            ["op"] = "event",
            ["name"] = "cmd",
            ["kind"] = "settings",
            ["action"] = "set",
            ["key"] = key,
            ["value"] = value,
        };
        Protocol?.SendEvent(payload);
    }

    /// <summary>settings.set 帧的宿主侧转发（cmd 事件通道 + 白名单）。</summary>
    private static void SendSettingForwarded(string? key, JsonElement? value)
    {
        // 白名单与宿主 native-settings-protocol.ts 完全一致（契约测试锁定）：
        // launchAtLogin / petVisible / petAlwaysOnTop / petZoom / uiIcon /
        // windowCornerRadius / toastSoundEnabled / chatLineHeight /
        // assistantBubbleEnabled / disableGpuElectron / gitCommitAuthorName /
        // gitCommitAuthorEmail / sidebarVisible / tasksVisible 为 UI 写入键；
        // preferences 段（截图后端 / 偏好开关 / 朋友圈 / CITA / 自定义采样）：
        // screenshotBackend / snipastePath / mobileMessageSegmentation /
        // proactiveChatMode / proactiveDeliveryTarget / chatSocialContextEnabled /
        // momentsEnabled / cyreneMomentsPostingEnabled / cyreneMomentsReactionsEnabled /
        // momentsCharacterReactionsEnabled / momentsLiveliness / citaEnabled / customStyle；
        // uiTheme / language 为读方向+前向兼容键。历史键名（autoStart/
        // trayResident/theme）已废弃。
        var allowed = new HashSet<string> {
            "launchAtLogin", "petVisible", "petAlwaysOnTop", "petZoom", "uiIcon",
            "uiTheme", "language", "windowCornerRadius", "toastSoundEnabled",
            "chatLineHeight", "assistantBubbleEnabled", "disableGpuElectron",
            "chatParaSpacing",
            "gitCommitAuthorName", "gitCommitAuthorEmail", "sidebarVisible", "tasksVisible",
            "screenshotBackend", "snipastePath", "mobileMessageSegmentation",
            "proactiveChatMode", "proactiveDeliveryTarget", "chatSocialContextEnabled",
            "momentsEnabled", "cyreneMomentsPostingEnabled", "cyreneMomentsReactionsEnabled",
            "momentsCharacterReactionsEnabled", "momentsLiveliness", "citaEnabled", "customStyle",
            "ragDownloadMirror",
        };
        if (string.IsNullOrEmpty(key) || !allowed.Contains(key)) return;
        SendSetting(key, value.HasValue ? value.Value : null);
    }

    /// <summary>
    /// 设置窗写入用户资料字段（白名单/取值校验在宿主侧执行）：
    /// {"op":"event","name":"cmd","kind":"settings","action":"set-user-profile","profile":{...}}
    /// </summary>
    public static void SendUserProfile(IDictionary<string, object?> profile)
    {
        var payload = new Dictionary<string, object?>
        {
            ["op"] = "event",
            ["name"] = "cmd",
            ["kind"] = "settings",
            ["action"] = "set-user-profile",
            ["profile"] = profile,
        };
        Protocol?.SendEvent(payload);
    }

    /// <summary>
    /// 设置窗「更换头像」：宿主弹系统文件框并保存（native 不传路径），
    /// 完成后宿主重推设置快照刷新头像图片。
    /// </summary>
    public static void SendPickAvatar()
    {
        SendCommand("settings", "pick-avatar");
    }

    /// <summary>
    /// 设置窗 section 动作（API 与模型 / 记忆 / 定时任务）：
    /// {"op":"event","name":"cmd","kind":"settings","action":&lt;kind&gt;,"verb":&lt;verb&gt;,"payload":{...}}
    /// kind/verb 的合法集合由宿主 native-settings-protocol 契约测试锁定。
    /// </summary>
    public static void SendSettingsAction(string kind, string verb, Dictionary<string, object?>? payload = null)
    {
        var body = new Dictionary<string, object?>
        {
            ["op"] = "event",
            ["name"] = "cmd",
            ["kind"] = "settings",
            ["action"] = kind,
            ["verb"] = verb,
        };
        if (payload is not null) body["payload"] = payload;
        Protocol?.SendEvent(body);
    }

    /// <summary>窗口请求宿主动作（openSettings 等）；extra 附加字段随 cmd 帧透传。</summary>
    public static void SendCommand(string kind, string action, string? section = null, Dictionary<string, object?>? extra = null)
    {
        var payload = new Dictionary<string, object?> { ["op"] = "event", ["name"] = "cmd", ["kind"] = kind, ["action"] = action };
        if (section is not null) payload["section"] = section;
        if (extra is not null)
        {
            foreach (var pair in extra) payload[pair.Key] = pair.Value;
        }
        Protocol?.SendEvent(payload);
    }
}

/// <summary>窗口抽象：布局应用 + 生命周期事件（WPF 窗与 WinForms 窗统一）。</summary>
public abstract class NativeWindow
{
    public abstract string Kind { get; }
    public abstract bool IsClosed { get; }
    public abstract void Close();
    public abstract void ShowWindow();
    public abstract void Activate();
    public abstract void ApplyLayout(JsonElement layout);
    public event Action<string>? ClosedEvent;
    protected void RaiseClosed() => ClosedEvent?.Invoke(Kind);
}

using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;

namespace CyreneNative;

/// <summary>
/// WPF 插件管理窗（插件页 .NET 重写）。
///
/// 分层语义：插件「管理」（列表/开关/市场安装）= 本窗；插件「运行时面板」
/// （Panel Bridge 动态内容）= Electron（生态适配层，open-panel cmd 转宿主）。
///
/// 协议（复用三件套 stdio 帧协议）：
///   宿主 → native：state.plugins 快照推送
///     { "op":"state.plugins", "plugins":[{id,name,version,description,
///        enabled,origin,settingsPanel}...], "market":[{id,name,version,
///        description,author}...], "installing":[id...] }
///   native → 宿主：cmd 事件
///     {"op":"event","name":"cmd","kind":"plugins",
///      "action":"enable|disable|uninstall|install|openPanel|refresh",
///      "id":...}
/// </summary>
public sealed class PluginManagerWindow : NativeWindow
{
    private readonly Window _window;
    private readonly TabControl _tabs;
    private readonly StackPanel _installedList;
    private readonly StackPanel _marketList;
    private readonly TextBlock _status;
    private readonly TextBlock _marketStatus;
    private bool _runtimeEnabled = true;

    private List<PluginInfo> _installed = new();
    private List<MarketEntry> _market = new();
    private List<string> _installing = new();
    private List<MarketSource> _marketSources = new();
    private string _marketError = "";

    private record PluginInfo(string Id, string Name, string Version, string Description, bool Enabled, string Origin, bool HasPanel, string Runtime);
    private record MarketEntry(string Id, string Name, string Version, string Description, string Author);
    private record MarketSource(string Url, bool Ok, bool Used);

    public PluginManagerWindow(JsonElement layout)
    {
        _installedList = new StackPanel();
        _marketList = new StackPanel();
        _status = new TextBlock
        {
            FontSize = 12,
            Foreground = NativeTheme.TextMutedBrush,
            Margin = new Thickness(16, 6, 16, 6),
        };
        _marketStatus = new TextBlock
        {
            FontSize = 11.5,
            Foreground = NativeTheme.TextMutedBrush,
            Margin = new Thickness(12, 8, 12, 0),
            TextWrapping = TextWrapping.Wrap,
        };

        _tabs = new TabControl
        {
            Background = Brushes.White,
            BorderBrush = new SolidColorBrush(Color.FromRgb(0xE5, 0xE5, 0xEA)),
            Padding = new Thickness(0),
        };
        var tabInstalled = new TabItem { Header = "已安装", FontSize = 13 };
        tabInstalled.Content = MakeScroll(_installedList);
        var tabMarket = new TabItem { Header = "插件市场", FontSize = 13 };
        var marketPanel = new DockPanel();
        DockPanel.SetDock(_marketStatus, System.Windows.Controls.Dock.Top);
        marketPanel.Children.Add(_marketStatus);
        marketPanel.Children.Add(MakeScroll(_marketList));
        tabMarket.Content = marketPanel;
        _tabs.Items.Add(tabInstalled);
        _tabs.Items.Add(tabMarket);

        var root = new DockPanel();
        DockPanel.SetDock(_status, System.Windows.Controls.Dock.Bottom);
        root.Children.Add(_status);
        root.Children.Add(_tabs);

        _window = new Window
        {
            Title = "昔涟 · 插件",
            Width = 880,
            Height = 640,
            MinWidth = 720,
            MinHeight = 520,
            WindowStartupLocation = WindowStartupLocation.CenterScreen,
            ShowActivated = true,
            // 无边框圆角窗 + 自绘标题栏（系统边框是直角，无法统一圆角）
            WindowStyle = WindowStyle.None,
            AllowsTransparency = true,
            Background = Brushes.Transparent,
        };

        var shellGrid = new Grid();
        shellGrid.RowDefinitions.Add(new RowDefinition { Height = new GridLength(40) });
        shellGrid.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        var titleBar = NativeTheme.BuildTitleBar(_window, "昔涟 · 插件");
        Grid.SetRow(titleBar, 0);
        shellGrid.Children.Add(titleBar);
        Grid.SetRow(root, 1);
        shellGrid.Children.Add(root);
        NativeTheme.ClipRounded(shellGrid, 12);
        _window.Content = new Border
        {
            CornerRadius = new CornerRadius(12),
            Background = NativeTheme.SurfaceAppBrush,
            BorderBrush = NativeTheme.BorderSoftBrush,
            BorderThickness = new Thickness(1),
            Child = shellGrid,
        };

        NativeTheme.Apply(_window);
        ApplyWindowBoundsFromLayout(layout);
    }

    private static ScrollViewer MakeScroll(UIElement content)
    {
        var sp = new StackPanel();
        sp.Children.Add(content);
        return new ScrollViewer { Content = sp, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, Padding = new Thickness(12) };
    }

    private void ApplyWindowBoundsFromLayout(JsonElement layout)
    {
        try
        {
            if (layout.ValueKind != JsonValueKind.Object) return;
            if (layout.TryGetProperty("width", out var w) && w.TryGetInt32(out var wi)) _window.Width = wi;
            if (layout.TryGetProperty("height", out var h) && h.TryGetInt32(out var hi)) _window.Height = hi;
        }
        catch { /* 布局缺省用默认 */ }
    }

    // ── 快照渲染 ──

    public void ApplyState(JsonElement payload)
    {
        if (payload.ValueKind != JsonValueKind.Object) return;
        _installed = ParseList<PluginInfo>(payload, "plugins", el => new PluginInfo(
            Str(el, "id"), Str(el, "name"), Str(el, "version") ?? "-",
            Str(el, "description") ?? "", Bool(el, "enabled"), Str(el, "origin") ?? "user",
            // 宿主快照字段为 settingsPanel（设置面板 HTML 文件名，仅合法时透出）
            Str(el, "settingsPanel") is { Length: > 0 },
            // 双轨标识（node/dotnet）；旧宿主快照无此字段时按 node 显示
            Str(el, "runtime") ?? "node"));
        _market = ParseList<MarketEntry>(payload, "market", el => new MarketEntry(
            Str(el, "id"), Str(el, "name"), Str(el, "version") ?? "-",
            Str(el, "description") ?? "", Str(el, "author") ?? ""));
        _marketSources = ParseList<MarketSource>(payload, "marketSources", el => new MarketSource(
            Str(el, "url") ?? "", Bool(el, "ok"), Bool(el, "used")));
        _marketError = Str(payload, "marketError") ?? "";
        if (payload.TryGetProperty("installing", out var inst) && inst.ValueKind == JsonValueKind.Array)
        {
            _installing = inst.EnumerateArray().Select(x => x.GetString() ?? "").Where(s => s.Length > 0).ToList();
        }
        _runtimeEnabled = payload.TryGetProperty("runtimeEnabled", out var rt) && rt.ValueKind == JsonValueKind.True;
        RenderInstalled();
        RenderMarket();
        RenderMarketStatus();
        _status.Text = _installing.Count > 0
            ? $"正在安装：{string.Join("、", _installing)} …"
            : $"已安装 {_installed.Count} 个插件 · 市场收录 {_market.Count} 个";
    }

    /// <summary>市场索引源状态行：Gitee/GitHub 双源死活 + 失败原因。</summary>
    private void RenderMarketStatus()
    {
        if (_marketSources.Count == 0)
        {
            _marketStatus.Text = _marketError.Length > 0 ? $"⚠ {_marketError}" : "";
            _marketStatus.Foreground = new SolidColorBrush(Color.FromRgb(0xD3, 0x3A, 0x3A));
            return;
        }
        var parts = _marketSources.Select(s =>
        {
            var name = s.Url.Contains("github", StringComparison.OrdinalIgnoreCase) ? "GitHub" : "Gitee";
            var state = !s.Ok ? "不可用" : (s.Used ? "使用中" : "备用");
            return $"{name}：{state}";
        });
        var text = "索引源  " + string.Join("    ", parts);
        if (_marketError.Length > 0) text += $"    ·    {_marketError}";
        _marketStatus.Text = text;
        _marketStatus.Foreground = new SolidColorBrush(_marketSources.Any(s => s.Ok)
            ? Color.FromRgb(0x66, 0x77, 0x66)
            : Color.FromRgb(0xD3, 0x3A, 0x3A));
    }

    private static string? Str(JsonElement el, string key)
        => el.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    private static bool Bool(JsonElement el, string key)
        => el.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.True;

    private static List<T> ParseList<T>(JsonElement payload, string key, Func<JsonElement, T> map)
    {
        if (!payload.TryGetProperty(key, out var arr) || arr.ValueKind != JsonValueKind.Array) return new();
        return arr.EnumerateArray().Select(map).ToList();
    }

    private void RenderInstalled()
    {
        _installedList.Children.Clear();
        if (!_runtimeEnabled)
        {
            // 运行时未启用（默认关省内存）：给一键启用提示条
            var tip = new Border
            {
                Background = new SolidColorBrush(Color.FromRgb(0xFF, 0xF4, 0xE5)),
                BorderBrush = new SolidColorBrush(Color.FromRgb(0xF0, 0xC4, 0x8A)),
                BorderThickness = new Thickness(1),
                CornerRadius = new CornerRadius(6),
                Padding = new Thickness(12, 8, 12, 8),
                Margin = new Thickness(0, 0, 0, 8),
                Child = new StackPanel { Orientation = System.Windows.Controls.Orientation.Horizontal },
            };
            var sp = (StackPanel)tip.Child;
            sp.Children.Add(new TextBlock
            {
                Text = "插件运行时未启用——已跳过插件系统以节省内存。",
                FontSize = 12.5,
                VerticalAlignment = VerticalAlignment.Center,
                Margin = new Thickness(0, 0, 10, 0),
                Foreground = new SolidColorBrush(Color.FromRgb(0x8A, 0x5A, 0x00)),
            });
            var enableBtn = new Button
            {
                Content = "启用插件运行时",
                Width = 150, Height = 28, FontSize = 12,
                Style = NativeTheme.PrimaryButtonStyle,
            };
            enableBtn.Click += (_, _) => RequestRouter.SendCommand("plugins", "enable-runtime");
            sp.Children.Add(enableBtn);
            _installedList.Children.Add(tip);
        }
        if (_installed.Count == 0 && _runtimeEnabled)
        {
            _installedList.Children.Add(new TextBlock
            {
                Text = "暂无插件。到「插件市场」看看，或从 ZIP 导入（设置 → 旧版插件页）。",
                FontSize = 12.5,
                Foreground = NativeTheme.TextMutedBrush,
                Margin = new Thickness(8, 24, 8, 8),
                TextAlignment = TextAlignment.Center,
            });
            return;
        }
        foreach (var p in _installed)
        {
            _installedList.Children.Add(MakeInstalledCard(p));
        }
    }

    private Border MakeInstalledCard(PluginInfo p)
    {
        var headerText = new TextBlock { Text = $"{p.Name}  {p.Version}", FontSize = 13.5, FontWeight = FontWeights.SemiBold, Foreground = NativeTheme.TextStrongBrush };
        var header = new StackPanel { Orientation = Orientation.Horizontal };
        header.Children.Add(headerText);
        header.Children.Add(MakeRuntimeBadge(p.Runtime));
        var desc = new TextBlock { Text = p.Description, FontSize = 12, Foreground = NativeTheme.TextMutedBrush, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 2, 0, 0) };

        var toggle = new CheckBox { Content = "启用", IsChecked = p.Enabled, VerticalAlignment = VerticalAlignment.Center, Cursor = System.Windows.Input.Cursors.Hand };
        toggle.Checked += (_, _) => RequestRouter.SendCommand("plugins", "enable", p.Id);
        toggle.Unchecked += (_, _) => RequestRouter.SendCommand("plugins", "disable", p.Id);

        var btnPanel = new StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center };
        if (p.HasPanel)
        {
            var openBtn = MakeMiniButton("打开面板");
            openBtn.Click += (_, _) => RequestRouter.SendCommand("plugins", "openPanel", p.Id);
            btnPanel.Children.Add(openBtn);
        }
        if (p.Origin == "user")
        {
            var delBtn = MakeMiniButton("卸载", danger: true);
            delBtn.Click += (_, _) =>
            {
                delBtn.IsEnabled = false;
                RequestRouter.SendCommand("plugins", "uninstall", p.Id);
            };
            btnPanel.Children.Add(delBtn);
        }
        btnPanel.Children.Add(toggle);

        var row = new DockPanel();
        DockPanel.SetDock(btnPanel, System.Windows.Controls.Dock.Right);
        row.Children.Add(btnPanel);
        var left = new StackPanel();
        left.Children.Add(header);
        left.Children.Add(desc);
        row.Children.Add(left);

        return new Border
        {
            Child = row,
            Background = Brushes.White,
            CornerRadius = new CornerRadius(10),
            Padding = new Thickness(14, 10, 14, 10),
            Margin = new Thickness(0, 0, 0, 8),
            BorderBrush = NativeTheme.BorderSoftBrush,
            BorderThickness = new Thickness(1),
        };
    }

    /// <summary>双轨标识徽标（Node / .NET）——旧版插件列表没有运行时信息，管理窗区分两轨。</summary>
    private static Border MakeRuntimeBadge(string runtime)
    {
        var isDotnet = string.Equals(runtime, "dotnet", StringComparison.OrdinalIgnoreCase);
        return new Border
        {
            Margin = new Thickness(8, 1, 0, 0),
            Padding = new Thickness(6, 1, 6, 1),
            CornerRadius = new CornerRadius(6),
            VerticalAlignment = VerticalAlignment.Center,
            Background = new SolidColorBrush(isDotnet ? Color.FromRgb(0xF5, 0xF3, 0xFF) : Color.FromRgb(0xF3, 0xF4, 0xF6)),
            Child = new TextBlock
            {
                Text = isDotnet ? ".NET" : "Node",
                FontSize = 10.5,
                FontWeight = FontWeights.Medium,
                Foreground = new SolidColorBrush(isDotnet ? Color.FromRgb(0x7C, 0x3A, 0xED) : Color.FromRgb(0x6B, 0x72, 0x80)),
            },
        };
    }

    private void RenderMarket()
    {
        _marketList.Children.Clear();
        var installedIds = _installed.Select(p => p.Id).ToHashSet();
        foreach (var m in _market)
        {
            _marketList.Children.Add(MakeMarketCard(m, installedIds.Contains(m.Id)));
        }
    }

    private Border MakeMarketCard(MarketEntry m, bool installed)
    {
        var header = new TextBlock { Text = $"{m.Name}  {m.Version}", FontSize = 13.5, FontWeight = FontWeights.SemiBold, Foreground = NativeTheme.TextStrongBrush };
        var meta = new TextBlock { Text = $"by {m.Author}", FontSize = 11.5, Foreground = NativeTheme.TextMutedBrush, Margin = new Thickness(0, 1, 0, 0) };
        var desc = new TextBlock { Text = m.Description, FontSize = 12, Foreground = NativeTheme.TextMutedBrush, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 2, 0, 0) };

        var btn = MakeMiniButton(installed ? "已安装" : "安装", primary: !installed);
        btn.IsEnabled = !installed && !_installing.Contains(m.Id);
        if (installed)
        {
            btn.Style = NativeTheme.SuccessButtonStyle;
        }
        btn.Click += (_, _) =>
        {
            btn.IsEnabled = false;
            btn.Content = "安装中…";
            RequestRouter.SendCommand("plugins", "install", m.Id);
        };

        var row = new DockPanel();
        DockPanel.SetDock(btn, System.Windows.Controls.Dock.Right);
        row.Children.Add(btn);
        var left = new StackPanel();
        left.Children.Add(header);
        left.Children.Add(meta);
        left.Children.Add(desc);
        row.Children.Add(left);

        return new Border
        {
            Child = row,
            Background = Brushes.White,
            CornerRadius = new CornerRadius(10),
            Padding = new Thickness(14, 10, 14, 10),
            Margin = new Thickness(0, 0, 0, 8),
            BorderBrush = NativeTheme.BorderSoftBrush,
            BorderThickness = new Thickness(1),
        };
    }

    private static Button MakeMiniButton(string text, bool primary = false, bool danger = false)
    {
        return new Button
        {
            Content = text,
            Height = 28,
            FontSize = 12,
            Margin = new Thickness(6, 0, 0, 0),
            Style = primary
                ? NativeTheme.PrimaryButtonStyle
                : danger ? NativeTheme.DangerButtonStyle : NativeTheme.SecondaryButtonStyle,
        };
    }

    // ── NativeWindow 实现 ──

    public override string Kind => "plugins";
    public override bool IsClosed => _window == null;

    public override void ShowWindow() => _window.Show();
    public override void Activate() => _window.Activate();
    public override void Close() => _window.Dispatcher.Invoke(() => _window.Close());

    public override void ApplyLayout(JsonElement layout)
    {
        if (layout.ValueKind != JsonValueKind.Object) return;
        if (layout.TryGetProperty("plugins", out var p)) ApplyState(p);
    }
}

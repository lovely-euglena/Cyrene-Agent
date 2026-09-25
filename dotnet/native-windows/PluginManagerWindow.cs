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
///      "action":"enable|disable|uninstall|install|openWindow|openPanel|refresh",
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
    /// <summary>搜索关键词（名称 / id / 描述，大小写不敏感；空串 = 不过滤）</summary>
    private string _search = "";
    /// <summary>最近一次宿主操作的提示（导入 ZIP / 刷新结果），随快照下发</summary>
    private (string Kind, string Message)? _notice;
    /// <summary>资源限制（「设置」页）：生效值与是否由设置页显式配置</summary>
    private int _storageQuotaMb = 64;
    private int _memoryLimitMb = 2048;
    private bool _storageQuotaConfigured;
    private bool _memoryLimitConfigured;
    private TextBox? _storageQuotaBox;
    private TextBox? _memoryLimitBox;
    private TextBlock? _limitsHint;
    private TextBlock? _limitsStatus;

    private record PluginInfo(string Id, string Name, string Version, string Description, bool Enabled, string Origin, bool HasPanel, string Runtime, bool CanOpen);
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
        var tabLimits = new TabItem { Header = "设置", FontSize = 13 };
        tabLimits.Content = MakeLimitsPanel();
        _tabs.Items.Add(tabLimits);

        var root = new DockPanel();
        DockPanel.SetDock(_status, System.Windows.Controls.Dock.Bottom);
        root.Children.Add(_status);
        var toolbar = MakeToolbar();
        DockPanel.SetDock(toolbar, System.Windows.Controls.Dock.Top);
        root.Children.Add(toolbar);
        root.Children.Add(_tabs);

        _window = new Window
        {
            Title = "昔涟 · 插件",
            Width = 912,
            Height = 672,
            MinWidth = 752,
            MinHeight = 552,
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
        var contentBorder = new Border
        {
            CornerRadius = new CornerRadius(12),
            Background = NativeTheme.SurfaceAppBrush,
            BorderBrush = NativeTheme.BorderSoftBrush,
            BorderThickness = new Thickness(1),
            Margin = new Thickness(16), // 透明留白：给窗口投影
            Child = shellGrid,
        };
        var windowShell = new Grid();
        windowShell.Children.Add(NativeTheme.MakeWindowShadowLayer(12));
        windowShell.Children.Add(contentBorder);
        _window.Content = windowShell;

        NativeTheme.Apply(_window);
        ApplyWindowBoundsFromLayout(layout);
    }

    private static ScrollViewer MakeScroll(UIElement content)
    {
        var sp = new StackPanel();
        sp.Children.Add(content);
        return new ScrollViewer { Content = sp, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, Padding = new Thickness(12) };
    }

    /// <summary>「设置」页：插件资源限制（软限制，防无限占用；0 = 不限）。</summary>
    private ScrollViewer MakeLimitsPanel()
    {
        var panel = new StackPanel { Margin = new Thickness(4, 8, 4, 8) };
        panel.Children.Add(new TextBlock
        {
            Text = "资源限制",
            FontSize = 14,
            FontWeight = FontWeights.Medium,
            Foreground = NativeTheme.TextStrongBrush,
            Margin = new Thickness(0, 0, 0, 4),
        });
        panel.Children.Add(new TextBlock
        {
            Text = "软限制：存储配额只约束走插件存储 API 的写入（保存后对之后启动/重启的插件生效）；"
                 + "内存上限仅作用于 .NET 插件进程（实时生效，超出即终止）。0 = 不限。",
            FontSize = 11.5,
            Foreground = NativeTheme.TextMutedBrush,
            TextWrapping = TextWrapping.Wrap,
            Margin = new Thickness(0, 0, 0, 14),
        });

        _storageQuotaBox = MakeLimitBox(_storageQuotaMb);
        panel.Children.Add(MakeLimitRow("KV 存储配额（MiB）", _storageQuotaBox));
        _memoryLimitBox = MakeLimitBox(_memoryLimitMb);
        panel.Children.Add(MakeLimitRow("内存上限（MiB，仅 .NET 插件）", _memoryLimitBox));

        _limitsHint = new TextBlock
        {
            FontSize = 11.5,
            Foreground = NativeTheme.TextMutedBrush,
            TextWrapping = TextWrapping.Wrap,
            Margin = new Thickness(0, 6, 0, 10),
        };
        panel.Children.Add(_limitsHint);

        var saveBtn = new Button
        {
            Content = "保存资源限制",
            Style = NativeTheme.PrimaryButtonStyle,
            HorizontalAlignment = HorizontalAlignment.Left,
            Padding = new Thickness(16, 6, 16, 6),
        };
        saveBtn.Click += (_, _) => SaveLimitsFromInputs();
        panel.Children.Add(saveBtn);

        _limitsStatus = new TextBlock
        {
            FontSize = 11.5,
            Foreground = NativeTheme.TextMutedBrush,
            TextWrapping = TextWrapping.Wrap,
            Margin = new Thickness(0, 10, 0, 0),
        };
        panel.Children.Add(_limitsStatus);
        return new ScrollViewer { Content = panel, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, Padding = new Thickness(16) };
    }

    private static TextBox MakeLimitBox(int value) => new()
    {
        Text = value.ToString(),
        Width = 120,
        FontSize = 12.5,
        Style = NativeTheme.TextBoxStyle,
        HorizontalAlignment = HorizontalAlignment.Left,
    };

    private static StackPanel MakeLimitRow(string label, TextBox box)
    {
        var row = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 3, 0, 3) };
        row.Children.Add(new TextBlock
        {
            Text = label,
            Width = 280,
            FontSize = 12.5,
            Foreground = NativeTheme.TextDefaultBrush,
            VerticalAlignment = VerticalAlignment.Center,
        });
        row.Children.Add(box);
        return row;
    }

    private static string FormatLimit(int value) => value <= 0 ? "不限" : $"{value} MiB";

    private void SyncLimitInputs()
    {
        if (_storageQuotaBox is { IsKeyboardFocused: false }) _storageQuotaBox.Text = _storageQuotaMb.ToString();
        if (_memoryLimitBox is { IsKeyboardFocused: false }) _memoryLimitBox.Text = _memoryLimitMb.ToString();
    }

    private void SetLimitsStatus(string text, bool error)
    {
        if (_limitsStatus is null) return;
        _limitsStatus.Text = text;
        _limitsStatus.Foreground = error
            ? new SolidColorBrush(Color.FromRgb(0xD3, 0x3A, 0x3A))
            : NativeTheme.TextMutedBrush;
    }

    private void SaveLimitsFromInputs()
    {
        if (!int.TryParse(_storageQuotaBox?.Text.Trim(), out var storage) || storage < 0 || storage > 10240)
        {
            SetLimitsStatus("存储配额需为 0-10240 的整数（MiB，0 = 不限）", error: true);
            return;
        }
        if (!int.TryParse(_memoryLimitBox?.Text.Trim(), out var memory) || memory < 0 || memory > 65536)
        {
            SetLimitsStatus("内存上限需为 0-65536 的整数（MiB，0 = 不限）", error: true);
            return;
        }
        RequestRouter.SendCommand("plugins", "set-limits", null, new Dictionary<string, object?>
        {
            ["storageQuotaMb"] = storage,
            ["memoryLimitMb"] = memory,
        });
        SetLimitsStatus("正在保存…", error: false);
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
            Str(el, "runtime") ?? "node",
            // open 能力：运行中且插件实现了打开窗口
            Bool(el, "canOpen")));
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
        if (payload.TryGetProperty("limits", out var limitsEl) && limitsEl.ValueKind == JsonValueKind.Object)
        {
            if (limitsEl.TryGetProperty("storageQuotaMb", out var sq) && sq.TryGetInt32(out var sqi)) _storageQuotaMb = sqi;
            if (limitsEl.TryGetProperty("memoryLimitMb", out var mq) && mq.TryGetInt32(out var mqi)) _memoryLimitMb = mqi;
            _storageQuotaConfigured = Bool(limitsEl, "storageQuotaConfigured");
            _memoryLimitConfigured = Bool(limitsEl, "memoryLimitConfigured");
            SyncLimitInputs();
            if (_limitsHint is not null)
            {
                _limitsHint.Text = $"当前生效：存储 {FormatLimit(_storageQuotaMb)} · 内存 {FormatLimit(_memoryLimitMb)}"
                    + ((!_storageQuotaConfigured || !_memoryLimitConfigured) ? "（未配置项来自环境变量/默认值）" : "");
            }
        }
        // 宿主操作提示（导入 ZIP / 刷新结果）：有则显示，否则回落到计数行
        _notice = null;
        if (payload.TryGetProperty("notice", out var noticeEl) && noticeEl.ValueKind == JsonValueKind.Object)
        {
            var message = Str(noticeEl, "message") ?? "";
            if (message.Length > 0) _notice = (Str(noticeEl, "kind") ?? "ok", message);
        }
        RenderInstalled();
        RenderMarket();
        RenderMarketStatus();
        if (_notice is { } notice)
        {
            _status.Text = notice.Message;
            _status.Foreground = new SolidColorBrush(notice.Kind == "error"
                ? Color.FromRgb(0xD3, 0x3A, 0x3A)
                : Color.FromRgb(0x2E, 0x7D, 0x32));
        }
        else
        {
            _status.Text = _installing.Count > 0
                ? $"正在安装：{string.Join("、", _installing)} …"
                : $"已安装 {_installed.Count} 个插件 · 市场收录 {_market.Count} 个";
            _status.Foreground = NativeTheme.TextMutedBrush;
        }
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

    /// <summary>工具条：搜索框（左）+ 刷新 / 导入 ZIP（右）。旧版插件页的本地 ZIP 入口。</summary>
    private Grid MakeToolbar()
    {
        var toolbar = new Grid { Margin = new Thickness(12, 8, 12, 4), Height = 34 };
        toolbar.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        toolbar.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

        var searchHost = new Grid
        {
            MaxWidth = 300,
            Height = 30,
            HorizontalAlignment = HorizontalAlignment.Left,
            VerticalAlignment = VerticalAlignment.Center,
        };
        var searchBox = new TextBox { FontSize = 12.5, Padding = new Thickness(8, 5, 8, 4) };
        var hint = new TextBlock
        {
            Text = "搜索插件（名称 / id / 描述）",
            FontSize = 12,
            Margin = new Thickness(10, 0, 0, 0),
            VerticalAlignment = VerticalAlignment.Center,
            Foreground = NativeTheme.TextMutedBrush,
            IsHitTestVisible = false,
        };
        searchBox.TextChanged += (_, _) =>
        {
            _search = searchBox.Text.Trim();
            hint.Visibility = _search.Length == 0 ? Visibility.Visible : Visibility.Collapsed;
            RenderInstalled();
            RenderMarket();
        };
        searchHost.Children.Add(searchBox);
        searchHost.Children.Add(hint);
        Grid.SetColumn(searchHost, 0);
        toolbar.Children.Add(searchHost);

        var actions = new StackPanel
        {
            Orientation = System.Windows.Controls.Orientation.Horizontal,
            VerticalAlignment = VerticalAlignment.Center,
        };
        var refreshBtn = MakeMiniButton("刷新");
        refreshBtn.Click += (_, _) => RequestRouter.SendCommand("plugins", "refresh");
        var importBtn = MakeMiniButton("导入 ZIP", primary: true);
        importBtn.Click += (_, _) => RequestRouter.SendCommand("plugins", "import-zip");
        actions.Children.Add(refreshBtn);
        actions.Children.Add(importBtn);
        Grid.SetColumn(actions, 1);
        toolbar.Children.Add(actions);
        return toolbar;
    }

    /// <summary>搜索过滤：任一字段包含关键词即命中（大小写不敏感）。</summary>
    private bool MatchesSearch(params string?[] fields)
    {
        if (_search.Length == 0) return true;
        foreach (var field in fields)
        {
            if (!string.IsNullOrEmpty(field) && field.Contains(_search, StringComparison.OrdinalIgnoreCase)) return true;
        }
        return false;
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
        var matched = _installed.Where(p => MatchesSearch(p.Id, p.Name, p.Description)).ToList();
        if (matched.Count == 0 && _runtimeEnabled)
        {
            _installedList.Children.Add(new TextBlock
            {
                Text = _search.Length > 0
                    ? $"没有匹配「{_search}」的插件"
                    : "暂无插件。到「插件市场」看看，或用上方「导入 ZIP」安装本地插件包。",
                FontSize = 12.5,
                Foreground = NativeTheme.TextMutedBrush,
                Margin = new Thickness(8, 24, 8, 8),
                TextAlignment = TextAlignment.Center,
            });
            return;
        }
        foreach (var p in matched)
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
        if (p.CanOpen)
        {
            var openBtn = MakeMiniButton("打开");
            openBtn.Click += (_, _) => RequestRouter.SendCommand("plugins", "openWindow", p.Id);
            btnPanel.Children.Add(openBtn);
        }
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
            Effect = NativeTheme.CardShadow(),
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
        var matched = _market.Where(m => MatchesSearch(m.Id, m.Name, m.Description, m.Author)).ToList();
        foreach (var m in matched)
        {
            _marketList.Children.Add(MakeMarketCard(m, installedIds.Contains(m.Id)));
        }
        if (matched.Count == 0 && _market.Count > 0)
        {
            _marketList.Children.Add(new TextBlock
            {
                Text = $"没有匹配「{_search}」的插件",
                FontSize = 12.5,
                Foreground = NativeTheme.TextMutedBrush,
                Margin = new Thickness(8, 24, 8, 8),
                TextAlignment = TextAlignment.Center,
            });
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
            Effect = NativeTheme.CardShadow(),
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

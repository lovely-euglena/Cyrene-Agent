using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;

namespace CyreneNative;

/// <summary>
/// WPF 原生设置窗（设置页 .NET 重写一期）。
///
/// 范围（渐进迁移）：
///   - 真 section：通用 / 外观 / 关于
///   - 占位 section（API/记忆/TTS/ASR/插件/用户/任务/渠道）：显示
///     「在旧版设置中打开」按钮 → cmd 事件 → 宿主弹 Electron 设置窗
///     （渠道设置独立 Electron 弹窗，用户指定不迁 .NET）
///
/// 数据流：settings.* 协议（RequestRouter）——
///   宿主 → native：{"op":"state.settings","settings":{...}} 快照推送
///   native → 宿主：{"id":n,"op":"settings.set","key":"...","value":...}
///                  {"id":n,"op":"settings.open","section":"legacy|channels|api"}
/// 复用三件套的 stdio 帧协议（同一 HostProtocol/RequestRouter）。
/// </summary>
public sealed class SettingsWindow : NativeWindow
{
    private readonly Window _window;
    private readonly ScrollViewer _scroll;
    private readonly StackPanel _sections;
    private readonly Dictionary<string, FrameworkElement> _sectionHosts = new();
    private string _activeSection = "general";

    public override string Kind => "settings";
    public override bool IsClosed => _window == null;

    private JsonElement _settings;

    public SettingsWindow(JsonElement layout)
    {
        _settings = layout.ValueKind == JsonValueKind.Object && layout.TryGetProperty("settings", out var s)
            ? s
            : default;

        _window = new Window
        {
            Title = "昔涟 · 设置",
            Width = 920,
            Height = 640,
            WindowStartupLocation = WindowStartupLocation.CenterScreen,
            WindowStyle = WindowStyle.None,
            ResizeMode = ResizeMode.NoResize,
            Background = new SolidColorBrush(Color.FromRgb(0xF7, 0xF7, 0xFA)),
            ShowInTaskbar = true,
        };

        var root = new Border { BorderBrush = new SolidColorBrush(Color.FromArgb(0x22, 0x88, 0x88, 0x99)), BorderThickness = new Thickness(1) };
        var grid = new Grid();
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(190) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        root.Child = grid;
        _window.Content = root;

        // ── 左侧导航 ──
        var nav = new Border
        {
            Background = new SolidColorBrush(Color.FromRgb(0xEF, 0xEF, 0xF4)),
            Child = new StackPanel { Margin = new Thickness(0, 40, 0, 12) },
        };
        Grid.SetColumn(nav, 0);
        grid.Children.Add(nav);
        var navPanel = (StackPanel)nav.Child;

        // ── 右侧内容区 ──
        _scroll = new ScrollViewer { VerticalScrollBarVisibility = ScrollBarVisibility.Auto, Padding = new Thickness(0, 40, 0, 0) };
        _sections = new StackPanel { Margin = new Thickness(24, 0, 24, 24) };
        _scroll.Content = _sections;
        Grid.SetColumn(_scroll, 1);
        grid.Children.Add(_scroll);

        // 标题栏拖动区（无边框窗）
        var dragBar = new Border
        {
            Height = 38,
            Background = Brushes.Transparent,
            Cursor = System.Windows.Input.Cursors.Arrow,
            VerticalAlignment = VerticalAlignment.Top,
        };
        dragBar.MouseLeftButtonDown += (_, e) => { try { _window.DragMove(); } catch { /* maximized */ } };
        root.Child = dragBar;

        BuildSections(navPanel);
        _window.Closed += (_, _) => RaiseClosed();
    }

    private void BuildSections(StackPanel nav)
    {
        void AddSection(string id, string label, bool native, string? legacyHash = null, bool pluginManager = false)
        {
            var btn = new RadioButton
            {
                Content = $"  {label}",
                GroupName = "settings-nav",
                Foreground = new SolidColorBrush(Color.FromRgb(0x33, 0x33, 0x44)),
                FontSize = 13,
                Padding = new Thickness(10, 9, 8, 9),
                Cursor = System.Windows.Input.Cursors.Hand,
                Tag = id,
            };
            btn.Checked += (_, _) => SwitchSection(id);
            nav.Children.Add(btn);

            var host = new StackPanel { Visibility = Visibility.Collapsed };
            _sectionHosts[id] = host;
            _sections.Children.Add(host);
            host.Children.Add(native
                ? BuildNativeSection(id)
                : BuildLegacySection(id, label, legacyHash ?? id, pluginManager));
            if (id == "general") { btn.IsChecked = true; }
        }

        AddSection("general", "通用", native: true);
        AddSection("appearance", "外观", native: true);
        AddSection("api", "API 与模型", native: false, legacyHash: "api");
        AddSection("memory", "记忆", native: false, legacyHash: "memory");
        AddSection("tts", "语音合成 TTS", native: false, legacyHash: "tts");
        AddSection("asr", "语音识别 ASR", native: false, legacyHash: "asr");
        AddSection("plugins", "插件", native: false, legacyHash: "plugins", pluginManager: true);
        AddSection("user", "用户", native: false, legacyHash: "user");
        AddSection("tasks", "定时任务", native: false, legacyHash: "tasks");
        AddSection("channels", "渠道配置", native: false, legacyHash: "channels");
        AddSection("about", "关于", native: true);
    }

    private void SwitchSection(string id)
    {
        _activeSection = id;
        foreach (var (key, host) in _sectionHosts)
        {
            host.Visibility = key == id ? Visibility.Visible : Visibility.Collapsed;
        }
    }

    // ── 原生 section：通用 / 外观 / 关于 ──

    private FrameworkElement BuildNativeSection(string id) => id switch
    {
        "general" => BuildGeneralSection(),
        "appearance" => BuildAppearanceSection(),
        "about" => BuildAboutSection(),
        _ => new TextBlock { Text = "未知分区" },
    };

    private FrameworkElement BuildGeneralSection()
    {
        var panel = new StackPanel();
        panel.Children.Add(MakeHeader("通用"));
        panel.Children.Add(MakeHint("开机自启 / 托盘 / 桌宠偏好等设置项（一期原生）"));
        panel.Children.Add(MakeToggleRow("开机自启", GetBool("autoStart"), v => SetSetting("autoStart", v)));
        panel.Children.Add(MakeToggleRow("托盘常驻", GetBool("trayResident", true), v => SetSetting("trayResident", v)));
        panel.Children.Add(MakeToggleRow("桌宠显示", GetBool("petVisible", true), v => SetSetting("petVisible", v)));
        panel.Children.Add(MakeHint("其余通用设置项在旧版设置中（后续版本逐步迁移）"));
        panel.Children.Add(MakeLegacyButton("general"));
        return panel;
    }

    private FrameworkElement BuildAppearanceSection()
    {
        var panel = new StackPanel();
        panel.Children.Add(MakeHeader("外观"));
        panel.Children.Add(MakeHint("主题与图标（一期原生）；高级外观（字体/缩放）见旧版"));
        var combo = new ComboBox { Width = 220, Margin = new Thickness(0, 10, 0, 4), FontSize = 12 };
        combo.Items.Add("pearl-white（默认）");
        combo.Items.Add("rose-dark");
        combo.SelectedIndex = GetString("theme", "pearl-white").Contains("dark") ? 1 : 0;
        combo.SelectionChanged += (_, _) => SetSetting("theme", combo.SelectedIndex == 1 ? "rose-dark" : "pearl-white");
        var themeRow = MakeRow("主题", combo);
        panel.Children.Add(themeRow);
        panel.Children.Add(MakeLegacyButton("appearance"));
        return panel;
    }

    private FrameworkElement BuildAboutSection()
    {
        var panel = new StackPanel();
        panel.Children.Add(MakeHeader("关于"));
        panel.Children.Add(MakeHint("Cyrene · 桌面伴侣（原生设置窗一期）"));
        panel.Children.Add(MakeHint($"cyrene-native 运行时：.NET {Environment.Version}"));
        panel.Children.Add(MakeHint("协议：stdio 帧（与宿主同链路）"));
        return panel;
    }

    // ── 占位 section ──

    private FrameworkElement BuildLegacySection(string id, string label, string hash, bool pluginManager = false)
    {
        var panel = new StackPanel();
        panel.Children.Add(MakeHeader(label));
        panel.Children.Add(MakeHint("该分区暂未迁移到原生窗口——点下方按钮在原版设置页中打开。"));
        panel.Children.Add(MakeLegacyButton(hash, pluginManager));
        return panel;
    }

    private Button MakeLegacyButton(string section, bool pluginManager = false)
    {
        var btn = new Button
        {
            Content = pluginManager ? "打开插件管理（原生窗口）"
              : section == "channels" ? "打开渠道配置（独立窗口）" : "在旧版设置中打开",
            Width = 220,
            Height = 32,
            Margin = new Thickness(0, 14, 0, 0),
            FontSize = 12,
            Background = new SolidColorBrush(Color.FromRgb(0xE8, 0xE8, 0xF0)),
            BorderBrush = new SolidColorBrush(Color.FromRgb(0xC5, 0xC5, 0xD5)),
            BorderThickness = new Thickness(1),
            Cursor = System.Windows.Input.Cursors.Hand,
        };
        if (pluginManager)
        {
            // 插件管理 = .NET PluginManagerWindow（cmd kind:plugins）
            btn.Click += (_, _) => RequestRouter.SendCommand("plugins", "open");
        }
        else
        {
            // 其余占位 section 回 Electron 旧版设置页（带 hash 定位）
            btn.Click += (_, _) => RequestRouter.SendCommand("settings", "open-legacy", section);
        }
        return btn;
    }

    /// <summary>宿主推送的设置快照（state.settings）。</summary>
    public void ApplySettings(JsonElement settings)
    {
        if (settings.ValueKind != JsonValueKind.Object) return;
        _settings = settings;
        // 简化处理：切换回来时重渲染——一期用 Visibility 切换不重建，
        // toggles 读 _settings 即时值需要刷新；标记 dirty 后续优化
    }

    private bool GetBool(string key, bool fallback = false)
        => _settings.ValueKind == JsonValueKind.Object
           && _settings.TryGetProperty(key, out var v)
           && v.ValueKind == JsonValueKind.True ? true
           : _settings.ValueKind == JsonValueKind.Object
             && _settings.TryGetProperty(key, out var v2) && v2.ValueKind == JsonValueKind.False ? false
             : fallback;

    private string GetString(string key, string fallback = "")
        => _settings.ValueKind == JsonValueKind.Object
           && _settings.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String
            ? v.GetString() ?? fallback
            : fallback;

    private void SetSetting(string key, object value)
    {
        RequestRouter.SendSetting(key, value);
    }

    // ── 控件工厂 ──

    private static TextBlock MakeHeader(string text) => new()
    {
        Text = text,
        FontSize = 17,
        FontWeight = FontWeights.SemiBold,
        Foreground = new SolidColorBrush(Color.FromRgb(0x22, 0x22, 0x33)),
        Margin = new Thickness(0, 0, 0, 10),
    };

    private static TextBlock MakeHint(string text) => new()
    {
        Text = text,
        FontSize = 12,
        Foreground = new SolidColorBrush(Color.FromRgb(0x77, 0x77, 0x88)),
        Margin = new Thickness(0, 2, 0, 2),
    };

    private static Border MakeRow(string label, FrameworkElement control)
    {
        var sp = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 10, 0, 10) };
        sp.Children.Add(new TextBlock { Text = label, FontSize = 13, Width = 140, VerticalAlignment = VerticalAlignment.Center });
        sp.Children.Add(control);
        return new Border { Child = sp, Padding = new Thickness(0, 2, 0, 2) };
    }

    private static Border MakeToggleRow(string label, bool initial, Action<bool> onChange)
    {
        var toggle = new CheckBox { IsChecked = initial, Cursor = System.Windows.Input.Cursors.Hand };
        toggle.Checked += (_, _) => onChange(true);
        toggle.Unchecked += (_, _) => onChange(false);
        return MakeRow(label, toggle);
    }

    // ── NativeWindow 实现 ──

    public override void ShowWindow() => _window.Show();
    public override void Activate() => _window.Activate();
    public override void Close() => _window.Dispatcher.Invoke(() => _window.Close());

    public override void ApplyLayout(JsonElement layout)
    {
        if (layout.ValueKind != JsonValueKind.Object) return;
        if (layout.TryGetProperty("settings", out var s))
        {
            ApplySettings(s);
        }
    }
}

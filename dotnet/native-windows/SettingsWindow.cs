using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;

namespace CyreneNative;

/// <summary>
/// WPF 原生设置窗（设置页 .NET 重写）。
///
/// 范围（渐进迁移）：
///   - 真 section：通用 / 外观 / 用户信息 / 关于
///   - 占位 section（API/记忆/TTS/ASR/插件/任务/渠道）：显示
///     「在旧版设置中打开」按钮 → cmd 事件 → 宿主弹 Electron 设置窗
///     （插件 section 走 .NET PluginManagerWindow；渠道设置独立 Electron 弹窗）
///
/// 数据流：settings.* 协议（RequestRouter）——
///   宿主 → native：{"op":"state.settings","settings":{...}} 快照推送
///                  （窗口 spawn 后到达即重建原生 section，值随快照刷新）
///   native → 宿主：{"id":n,"op":"settings.set","key":"...","value":...}
///                  {"op":"event","name":"cmd","kind":"settings","action":"set",...}
///                  {"op":"event","name":"cmd","kind":"settings","action":"set-user-profile",...}
///                  {"op":"event","name":"cmd","kind":"settings","action":"pick-avatar"}
///                  {"id":n,"op":"settings.open","section":"legacy|channels|api"}
/// 复用三件套的 stdio 帧协议（同一 HostProtocol/RequestRouter）。
///
/// ⚠️ 读写键名契约：see src/main/windows/native-settings-protocol.ts。
/// 历史 bug：本文件曾用 autoStart/trayResident/theme 读写，与宿主快照
/// launchAtLogin/uiTheme 不一致 → 开关永远显示默认值、写入被白名单丢弃。
/// 契约测试会扫描本文件提取 SetSetting 调用中的键名并校验白名单。
/// </summary>
public sealed class SettingsWindow : NativeWindow
{
    private readonly Window _window;
    private readonly ScrollViewer _scroll;
    private readonly StackPanel _sections;
    private readonly Dictionary<string, StackPanel> _sectionHosts = new();
    /// <summary>用户已输入但尚未提交的控件刷新（快照重建时停掉）</summary>
    private readonly List<DispatcherTimer> _debounceTimers = new();
    private readonly string _genderGroupId = Guid.NewGuid().ToString("N");
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
        _window.Closed += (_, _) => { StopDebounceTimers(); RaiseClosed(); };
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
        AddSection("user", "用户信息", native: true);
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

    // ── 原生 section：通用 / 外观 / 用户信息 / 关于 ──

    private static bool IsNativeSection(string id)
        => id is "general" or "appearance" or "user" or "about";

    private FrameworkElement BuildNativeSection(string id) => id switch
    {
        "general" => BuildGeneralSection(),
        "appearance" => BuildAppearanceSection(),
        "user" => BuildUserSection(),
        "about" => BuildAboutSection(),
        _ => new TextBlock { Text = "未知分区" },
    };

    private FrameworkElement BuildGeneralSection()
    {
        var panel = new StackPanel();
        panel.Children.Add(MakeHeader("通用"));
        panel.Children.Add(MakeHint("启动行为与桌宠偏好（原生设置一期）"));
        panel.Children.Add(MakeToggleRow("开机自启", GetBool("launchAtLogin"), v => SetSetting("launchAtLogin", v)));
        panel.Children.Add(MakeToggleRow("桌宠显示", GetBool("petVisible", true), v => SetSetting("petVisible", v)));
        panel.Children.Add(MakeToggleRow("桌宠始终置顶", GetBool("petAlwaysOnTop", true), v => SetSetting("petAlwaysOnTop", v)));
        panel.Children.Add(MakeHint("其余通用设置项在旧版设置中（后续版本逐步迁移）"));
        panel.Children.Add(MakeLegacyButton("general"));
        return panel;
    }

    private FrameworkElement BuildAppearanceSection()
    {
        var panel = new StackPanel();
        panel.Children.Add(MakeHeader("外观"));
        panel.Children.Add(MakeHint("窗口圆角与提醒音效（原生设置一期）；字体/图标等高级外观见旧版"));
        panel.Children.Add(MakeSliderRow("窗口圆角", GetInt("windowCornerRadius", 24), 0, 40, "px",
            v => SetSetting("windowCornerRadius", v)));
        panel.Children.Add(MakeToggleRow("提醒音效", GetBool("toastSoundEnabled", true),
            v => SetSetting("toastSoundEnabled", v)));
        panel.Children.Add(MakeLegacyButton("appearance"));
        return panel;
    }

    private FrameworkElement BuildUserSection()
    {
        var panel = new StackPanel();
        panel.Children.Add(MakeHeader("用户信息"));
        panel.Children.Add(MakeHint("昔涟对你的称呼与本地资料；字段失焦或回车即保存"));

        var user = GetNode("user");

        // 头像：快照 data URL 解码显示；「更换头像」由宿主弹文件框（native 不传路径）
        var avatarRow = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 8, 0, 10) };
        var avatarBox = new Border
        {
            Width = 64,
            Height = 64,
            CornerRadius = new CornerRadius(32),
            Background = new SolidColorBrush(Color.FromRgb(0xE8, 0xE8, 0xF0)),
            ClipToBounds = true,
        };
        var avatarImage = new Image { Stretch = Stretch.UniformToFill };
        var decoded = TryDecodeDataUrl(GetString(user, "avatarDataUrl"));
        if (decoded != null) avatarImage.Source = decoded;
        avatarBox.Child = avatarImage;
        avatarRow.Children.Add(avatarBox);
        var uploadButton = new Button
        {
            Content = "更换头像",
            Width = 120,
            Height = 32,
            Margin = new Thickness(16, 16, 0, 0),
            FontSize = 12,
            Background = new SolidColorBrush(Color.FromRgb(0xE8, 0xE8, 0xF0)),
            BorderBrush = new SolidColorBrush(Color.FromRgb(0xC5, 0xC5, 0xD5)),
            BorderThickness = new Thickness(1),
            Cursor = System.Windows.Input.Cursors.Hand,
        };
        uploadButton.Click += (_, _) => RequestRouter.SendPickAvatar();
        avatarRow.Children.Add(uploadButton);
        panel.Children.Add(avatarRow);

        panel.Children.Add(MakeTextRow("昵称", GetString(user, "nickname"), v => SetUserProfile("nickname", v)));
        panel.Children.Add(MakeTextRow("称呼偏好", GetString(user, "callPreference"), v => SetUserProfile("callPreference", v)));
        panel.Children.Add(MakeTextRow("生日", GetString(user, "birthday"), v => SetUserProfile("birthday", v)));
        panel.Children.Add(MakeTextRow("默认城市", GetString(user, "defaultCity"), v => SetUserProfile("defaultCity", v)));
        panel.Children.Add(MakeTimezoneRow(user));
        panel.Children.Add(MakeGenderRow(user));
        return panel;
    }

    private FrameworkElement BuildAboutSection()
    {
        var panel = new StackPanel();
        panel.Children.Add(MakeHeader("关于"));
        panel.Children.Add(MakeHint("Cyrene · 桌面伴侣"));
        panel.Children.Add(MakeHint($"版本：{GetString("version", "未知")}（原生设置窗）"));
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

    /// <summary>
    /// 宿主推送的设置快照（state.settings）。
    /// 重建全部原生 section：控件值随快照刷新（spawn 后快照到达是主要路径；
    /// 头像更换后也经此刷新图片）。重建前停掉未提交的防抖定时器，避免旧控件
    /// 在重建后写出陈旧值。
    /// </summary>
    public void ApplySettings(JsonElement settings)
    {
        if (settings.ValueKind != JsonValueKind.Object) return;
        _settings = settings;
        StopDebounceTimers();
        foreach (var (id, host) in _sectionHosts)
        {
            if (!IsNativeSection(id)) continue;
            host.Children.Clear();
            host.Children.Add(BuildNativeSection(id));
        }
    }

    private void StopDebounceTimers()
    {
        foreach (var timer in _debounceTimers) timer.Stop();
        _debounceTimers.Clear();
    }

    // ── 快照读取 ──

    private JsonElement GetNode(string key)
        => _settings.ValueKind == JsonValueKind.Object && _settings.TryGetProperty(key, out var v) ? v : default;

    private bool GetBool(string key, bool fallback = false)
        => _settings.ValueKind == JsonValueKind.Object
           && _settings.TryGetProperty(key, out var v)
           && v.ValueKind == JsonValueKind.True ? true
           : _settings.ValueKind == JsonValueKind.Object
             && _settings.TryGetProperty(key, out var v2) && v2.ValueKind == JsonValueKind.False ? false
             : fallback;

    private int GetInt(string key, int fallback)
        => _settings.ValueKind == JsonValueKind.Object
           && _settings.TryGetProperty(key, out var v)
           && v.ValueKind == JsonValueKind.Number
           && v.TryGetInt32(out var n) ? n : fallback;

    private string GetString(string key, string fallback = "")
        => GetString(_settings, key, fallback);

    private static string GetString(JsonElement node, string key, string fallback = "")
        => node.ValueKind == JsonValueKind.Object
           && node.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String
            ? v.GetString() ?? fallback
            : fallback;

    // ── 写入 ──

    private static void SetSetting(string key, object value)
    {
        RequestRouter.SendSetting(key, value);
    }

    private static void SetUserProfile(string field, object value)
    {
        RequestRouter.SendUserProfile(new Dictionary<string, object?> { [field] = value });
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

    /// <summary>滑杆行：拖动/键盘调整经 250ms 防抖后写一次（避免保存风暴）。</summary>
    private Border MakeSliderRow(string label, int initial, int min, int max, string unit, Action<int> onChange)
    {
        var row = new StackPanel { Orientation = Orientation.Horizontal };
        var slider = new Slider
        {
            Width = 200,
            Minimum = min,
            Maximum = max,
            Value = Math.Max(min, Math.Min(max, initial)),
            IsSnapToTickEnabled = true,
            TickFrequency = 1,
            VerticalAlignment = VerticalAlignment.Center,
        };
        var valueText = new TextBlock
        {
            Text = $"{(int)Math.Round(slider.Value)}{unit}",
            Width = 56,
            FontSize = 12,
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(10, 0, 0, 0),
        };
        var timer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(250) };
        timer.Tick += (_, _) =>
        {
            timer.Stop();
            onChange((int)Math.Round(slider.Value));
        };
        slider.ValueChanged += (_, _) =>
        {
            valueText.Text = $"{(int)Math.Round(slider.Value)}{unit}";
            timer.Stop();
            timer.Start();
        };
        _debounceTimers.Add(timer);
        row.Children.Add(slider);
        row.Children.Add(valueText);
        return MakeRow(label, row);
    }

    /// <summary>文本行：失焦或回车提交；与初值相同不发请求。</summary>
    private static Border MakeTextRow(string label, string initial, Action<string> onCommit, double width = 260)
    {
        var box = new TextBox
        {
            Text = initial,
            Width = width,
            FontSize = 12,
            Padding = new Thickness(6, 4, 6, 4),
            VerticalContentAlignment = VerticalAlignment.Center,
        };
        var lastCommitted = initial;
        void Commit()
        {
            var text = box.Text.Trim();
            if (text == lastCommitted) return;
            lastCommitted = text;
            onCommit(text);
        }
        box.LostFocus += (_, _) => Commit();
        box.KeyDown += (_, e) =>
        {
            if (e.Key == System.Windows.Input.Key.Enter) Commit();
        };
        return MakeRow(label, box);
    }

    /// <summary>时区行：选项来自宿主快照（与渲染页共享白名单）。</summary>
    private Border MakeTimezoneRow(JsonElement user)
    {
        var current = GetString(user, "timezone", "Asia/Shanghai");
        var options = user.ValueKind == JsonValueKind.Object
            && user.TryGetProperty("timezoneOptions", out var opts)
            && opts.ValueKind == JsonValueKind.Array ? opts : default;

        var combo = new ComboBox { Width = 260, FontSize = 12 };
        var selectedIndex = 0;
        if (options.ValueKind == JsonValueKind.Array)
        {
            var index = 0;
            foreach (var opt in options.EnumerateArray())
            {
                var value = GetString(opt, "value");
                combo.Items.Add(GetString(opt, "label", value));
                if (value == current) selectedIndex = index;
                index++;
            }
        }
        combo.SelectedIndex = combo.Items.Count > 0 ? selectedIndex : -1;
        combo.SelectionChanged += (_, _) =>
        {
            var index = combo.SelectedIndex;
            if (options.ValueKind != JsonValueKind.Array || index < 0 || index >= options.GetArrayLength()) return;
            var value = GetString(options[index], "value");
            if (value.Length > 0 && value != current)
            {
                current = value;
                SetUserProfile("timezone", value);
            }
        };
        return MakeRow("时区", combo);
    }

    /// <summary>性别行：三档单选，点击即写。</summary>
    private Border MakeGenderRow(JsonElement user)
    {
        var current = GetString(user, "gender", "secret");
        var group = new StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center };

        void AddGender(string value, string label)
        {
            var radio = new RadioButton
            {
                Content = label,
                GroupName = _genderGroupId,
                IsChecked = current == value,
                Margin = new Thickness(0, 0, 16, 0),
                FontSize = 12,
                Cursor = System.Windows.Input.Cursors.Hand,
            };
            radio.Checked += (_, _) =>
            {
                if (current == value) return;
                current = value;
                SetUserProfile("gender", value);
            };
            group.Children.Add(radio);
        }

        AddGender("secret", "保密");
        AddGender("male", "男");
        AddGender("female", "女");
        return MakeRow("性别", group);
    }

    /// <summary>头像 data URL → BitmapImage（解码失败返回 null，显示占位底色）。</summary>
    private static ImageSource? TryDecodeDataUrl(string dataUrl)
    {
        if (string.IsNullOrWhiteSpace(dataUrl)) return null;
        var comma = dataUrl.IndexOf(',');
        if (comma < 0 || !dataUrl.StartsWith("data:", StringComparison.OrdinalIgnoreCase)) return null;
        try
        {
            var bytes = Convert.FromBase64String(dataUrl[(comma + 1)..]);
            using var stream = new MemoryStream(bytes);
            var image = new BitmapImage();
            image.BeginInit();
            image.CacheOption = BitmapCacheOption.OnLoad;
            image.StreamSource = stream;
            image.EndInit();
            image.Freeze();
            return image;
        }
        catch
        {
            return null;
        }
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
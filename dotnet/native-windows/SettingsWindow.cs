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
///   - 真 section：通用 / 外观 / 用户信息 / API 与模型 / 记忆 / 定时任务 / 关于
///   - 占位 section（TTS/ASR/插件/渠道）：显示跳转按钮 → cmd 事件
///     （插件 section 走 .NET PluginManagerWindow；TTS/ASR/渠道走 Electron）
///
/// 数据流：settings.* 协议（RequestRouter）——
///   宿主 → native：{"op":"state.settings","settings":{...}} 快照推送
///                  （按 section 数据源判定差异重建，避免打断未提交输入）
///                  {"op":"state.settings-notice","notice":{...}} 反馈帧（就地状态行）
///   native → 宿主：{"id":n,"op":"settings.set","key":"...","value":...}
///                  {"op":"event","name":"cmd","kind":"settings","action":"set",...}
///                  {"op":"event","name":"cmd","kind":"settings","action":"set-user-profile",...}
///                  {"op":"event","name":"cmd","kind":"settings","action":"pick-avatar"}
///                  {"op":"event","name":"cmd","kind":"settings","action":"api|memory|scheduler","verb":...,"payload":{...}}
/// 复用三件套的 stdio 帧协议（同一 HostProtocol/RequestRouter）。
///
/// 分文件：SettingsWindow.Api.cs / SettingsWindow.Memory.cs / SettingsWindow.Tasks.cs。
///
/// ⚠️ 读写键名契约：see src/main/windows/native-settings-protocol.ts。
/// 历史 bug：本文件曾用 autoStart/trayResident/theme 读写，与宿主快照
/// launchAtLogin/uiTheme 不一致 → 开关永远显示默认值、写入被白名单丢弃。
/// 契约测试会扫描本文件提取 SetSetting 调用中的键名并校验白名单。
/// </summary>
public sealed partial class SettingsWindow : NativeWindow
{
    private readonly Window _window;
    private readonly ScrollViewer _scroll;
    private readonly StackPanel _sections;
    private readonly Dictionary<string, StackPanel> _sectionHosts = new();
    private readonly Dictionary<string, RadioButton> _navButtons = new();
    /// <summary>宿主显式定位的初始 section（layout.section；未知/缺省 → general）</summary>
    private readonly string? _initialSection;
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
        _initialSection = layout.ValueKind == JsonValueKind.Object
            && layout.TryGetProperty("section", out var sec)
            && sec.ValueKind == JsonValueKind.String
            ? sec.GetString()
            : null;

        _window = new Window
        {
            Title = "昔涟 · 设置",
            Width = 920,
            Height = 640,
            WindowStartupLocation = WindowStartupLocation.CenterScreen,
            WindowStyle = WindowStyle.None,
            ResizeMode = ResizeMode.NoResize,
            // 无边框圆角窗：窗口本身全透明，圆角由 root Border + 裁剪提供
            AllowsTransparency = true,
            Background = Brushes.Transparent,
            ShowInTaskbar = true,
            // 任务栏/Alt-Tab 图标：从打包布局同级的 Cyrene.exe 提取（缺失则留空）
            Icon = ResolveAppIcon(),
        };
        NativeTheme.Apply(_window);

        var root = new Border
        {
            BorderBrush = new SolidColorBrush(Color.FromArgb(0x22, 0x88, 0x88, 0x99)),
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(12),
            Background = NativeTheme.SurfaceAppBrush,
        };
        var grid = new Grid();
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(190) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        grid.RowDefinitions.Add(new RowDefinition { Height = new GridLength(40) });
        grid.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        root.Child = grid;
        _window.Content = root;
        // 圆角裁剪：Border 不会自动把子元素裁到圆角，导航/标题栏会溢出方形角
        NativeTheme.ClipRounded(grid, 12);

        // ── 顶部标题栏：应用图标 + 标题 + 最小化/关闭（无边框窗的可见拖拽区） ──
        var header = new Border
        {
            Background = Brushes.White,
            BorderBrush = NativeTheme.BorderSoftBrush,
            BorderThickness = new Thickness(0, 0, 0, 1),
        };
        var headerGrid = new Grid();
        headerGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        headerGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        headerGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        var headerTitle = new TextBlock
        {
            Text = "昔涟 · 设置",
            FontSize = 13,
            FontWeight = FontWeights.SemiBold,
            Foreground = new SolidColorBrush(Color.FromRgb(0x33, 0x33, 0x44)),
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(16, 0, 0, 0),
        };
        Grid.SetColumn(headerTitle, 0);
        headerGrid.Children.Add(headerTitle);
        var minBtn = MakeTitleBarButton("—", () => _window.WindowState = WindowState.Minimized);
        var closeBtn = MakeTitleBarButton("✕", () => _window.Close());
        Grid.SetColumn(minBtn, 1);
        Grid.SetColumn(closeBtn, 2);
        headerGrid.Children.Add(minBtn);
        headerGrid.Children.Add(closeBtn);
        header.Child = headerGrid;
        header.MouseLeftButtonDown += (_, _) => { try { _window.DragMove(); } catch { /* not pressed */ } };
        Grid.SetColumnSpan(header, 2);
        Grid.SetRow(header, 0);
        grid.Children.Add(header);

        // ── 左侧导航 ──
        var nav = new Border
        {
            Background = NativeTheme.SurfaceNavBrush,
            Child = new StackPanel { Margin = new Thickness(0, 8, 0, 12) },
        };
        Grid.SetColumn(nav, 0);
        Grid.SetRow(nav, 1);
        grid.Children.Add(nav);
        var navPanel = (StackPanel)nav.Child;

        // ── 右侧内容区 ──
        _scroll = new ScrollViewer { VerticalScrollBarVisibility = ScrollBarVisibility.Auto, Padding = new Thickness(0) };
        _sections = new StackPanel { Margin = new Thickness(24, 16, 24, 24) };
        _scroll.Content = _sections;
        Grid.SetColumn(_scroll, 1);
        Grid.SetRow(_scroll, 1);
        grid.Children.Add(_scroll);

        BuildSections(navPanel);
        _window.Closed += (_, _) => { StopDebounceTimers(); RaiseClosed(); };
    }

    /// <summary>标题栏按钮（最小化/关闭）：扁平图标按钮样式。</summary>
    private static Button MakeTitleBarButton(string glyph, Action onClick)
    {
        var btn = new Button { Content = glyph, Style = NativeTheme.FlatIconButtonStyle };
        btn.Click += (_, _) => onClick();
        return btn;
    }

    /// <summary>应用图标：从同级 Cyrene.exe 提取关联图标（失败返回 null，不影响窗口）。</summary>
    private static ImageSource? ResolveAppIcon()
    {
        try
        {
            var exe = TrayHost.ResolveElectronExe();
            if (!File.Exists(exe)) return null;
            using var icon = System.Drawing.Icon.ExtractAssociatedIcon(exe);
            if (icon is null) return null;
            var source = System.Windows.Interop.Imaging.CreateBitmapSourceFromHIcon(
                icon.Handle,
                new Int32Rect(0, 0, icon.Width, icon.Height),
                BitmapSizeOptions.FromEmptyOptions());
            source.Freeze();
            return source;
        }
        catch
        {
            return null;
        }
    }

    /// <summary>导航项样式：圆角高亮条（选中/悬停）—— 见 NativeTheme。</summary>
    private static Style BuildNavItemStyle() => NativeTheme.NavItemStyle;

    private void BuildSections(StackPanel nav)
    {
        var navStyle = BuildNavItemStyle();
        // 导航头部品牌行（logo + 昔涟）——对齐 Electron 设置页 settings-nav__brand
        var brand = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(14, 2, 8, 10) };
        var brandLogo = new Image
        {
            Width = 22,
            Height = 22,
            Stretch = Stretch.Uniform,
            VerticalAlignment = VerticalAlignment.Center,
        };
        var brandSource = TryLoadAssetImage(Path.Combine("icons", "settings-logo.png"));
        if (brandSource is not null) brandLogo.Source = brandSource;
        brand.Children.Add(brandLogo);
        brand.Children.Add(new TextBlock
        {
            Text = "昔涟",
            FontSize = 14,
            FontWeight = FontWeights.SemiBold,
            Foreground = NativeTheme.TextStrongBrush,
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(8, 0, 0, 0),
        });
        nav.Children.Add(brand);
        void AddSection(string id, string label, bool native, string? legacyHash = null, bool pluginManager = false)
        {
            var btn = new RadioButton
            {
                Content = label,
                GroupName = "settings-nav",
                Style = navStyle,
                Tag = id,
            };
            btn.Checked += (_, _) => SwitchSection(id);
            nav.Children.Add(btn);
            _navButtons[id] = btn;

            var host = new StackPanel { Visibility = Visibility.Collapsed };
            _sectionHosts[id] = host;
            _sections.Children.Add(host);
            // 原生 section 懒构建：窗口打开只建当前 section，切换时再建。
            // 旧实现在构造时一次性构建全部 section（含列表/表单），是设置窗
            // 打开延时的主因。占位 section 很轻，仍即时构建。
            if (!native)
            {
                host.Children.Add(BuildLegacySection(id, label, legacyHash ?? id, pluginManager));
            }
        }

        AddSection("general", "通用", native: true);
        AddSection("appearance", "外观", native: true);
        AddSection("api", "API 与模型", native: true);
        AddSection("api-advanced", "高级设置", native: true);
        AddSection("memory", "记忆", native: true);
        AddSection("tts", "语音合成 TTS", native: false, legacyHash: "tts");
        AddSection("asr", "语音识别 ASR", native: false, legacyHash: "asr");
        AddSection("plugins", "插件", native: false, legacyHash: "plugins", pluginManager: true);
        AddSection("user", "用户信息", native: true);
        AddSection("tasks", "定时任务", native: true);
        AddSection("channels", "渠道配置", native: false, legacyHash: "channels");
        AddSection("disclaimer", "免责声明", native: true);
        AddSection("about", "关于", native: true);

        // 初始 section：优先宿主显式定位（layout.section），未知/缺省 → 通用
        var initial = _initialSection is not null && _navButtons.ContainsKey(_initialSection)
            ? _initialSection
            : "general";
        _navButtons[initial].IsChecked = true;
    }

    /// <summary>首次显示该 section 时才构建其内容（懒构建）。</summary>
    private void EnsureSectionBuilt(string id)
    {
        if (!IsNativeSection(id)) return;
        if (!_sectionHosts.TryGetValue(id, out var host)) return;
        if (host.Children.Count > 0) return;
        _sectionSources[id] = SectionSourceJson(id);
        host.Children.Add(BuildNativeSection(id));
        RenderNotice(id);
    }

    /// <summary>
    /// 宿主指定要打开的 section（win.spawn layout.section；已开窗时由
    /// RequestRouter 重定向）。未知 id 忽略，避免白屏。
    /// </summary>
    public void SwitchToSection(string section)
    {
        if (!_navButtons.TryGetValue(section, out var btn))
        {
            return;
        }
        if (btn.IsChecked == true)
        {
            SwitchSection(section);
            return;
        }
        btn.IsChecked = true; // 触发 Checked → SwitchSection
    }

    private void SwitchSection(string id)
    {
        _activeSection = id;
        EnsureSectionBuilt(id);
        foreach (var (key, host) in _sectionHosts)
        {
            host.Visibility = key == id ? Visibility.Visible : Visibility.Collapsed;
        }
    }

    // ── 原生 section：通用 / 外观 / 用户信息 / API 与模型 / 记忆 / 定时任务 / 关于 ──

    private static bool IsNativeSection(string id)
        => id is "general" or "appearance" or "user" or "api" or "api-advanced" or "disclaimer" or "memory" or "tasks" or "about";

    private FrameworkElement BuildNativeSection(string id) => id switch
    {
        "general" => BuildGeneralSection(),
        "appearance" => BuildAppearanceSection(),
        "user" => BuildUserSection(),
        "api" => BuildApiSection(),
        "api-advanced" => BuildRuntimeSection(),
        "disclaimer" => BuildDisclaimerSection(),
        "memory" => BuildMemorySection(),
        "tasks" => BuildTasksSection(),
        "about" => BuildAboutSection(),
        _ => new TextBlock { Text = "未知分区" },
    };

    private FrameworkElement BuildGeneralSection()
    {
        var panel = new StackPanel();
        panel.Children.Add(MakeHeader("通用"));
        panel.Children.Add(MakeHint("启动行为、窗口显示与系统行为（对齐 Electron 通用设置）。"));
        panel.Children.Add(MakeSubHeader("启动与提醒"));
        panel.Children.Add(MakeToggleRow("开机自启", GetBool("launchAtLogin"), v => SetSetting("launchAtLogin", v)));
        panel.Children.Add(MakeToggleRow("提醒音效", GetBool("toastSoundEnabled", true),
            v => SetSetting("toastSoundEnabled", v)));

        panel.Children.Add(MakeSubHeader("窗口"));
        panel.Children.Add(MakeToggleRow("状态栏窗口", GetBool("sidebarVisible", true),
            v => SetSetting("sidebarVisible", v)));
        panel.Children.Add(MakeToggleRow("日程栏窗口", GetBool("tasksVisible", true),
            v => SetSetting("tasksVisible", v)));
        panel.Children.Add(MakeHint("关闭状态栏/日程栏后立即隐藏；再次打开从托盘或此处恢复。"));

        panel.Children.Add(MakeSubHeader("性能"));
        panel.Children.Add(MakeToggleRow("禁用 GPU 渲染", GetBool("disableGpuElectron"),
            v => SetSetting("disableGpuElectron", v)));
        panel.Children.Add(MakeHint("无 GPU 或花屏时开启；下次启动生效。"));

        panel.Children.Add(MakeSubHeader("Git 提交身份"));
        panel.Children.Add(MakeHint("代码 Git 面板提交时使用；邮箱必填。"));
        panel.Children.Add(MakeTextRow("作者名", GetString("gitCommitAuthorName", "Cyrene"),
            v => SetSetting("gitCommitAuthorName", v)));
        panel.Children.Add(MakeTextRow("邮箱", GetString("gitCommitAuthorEmail"),
            v => SetSetting("gitCommitAuthorEmail", v)));

        panel.Children.Add(MakeHint("其余通用设置项（语言等）在旧版设置中。"));
        panel.Children.Add(MakeLegacyButton("general"));
        return panel;
    }

    private FrameworkElement BuildAppearanceSection()
    {
        var panel = new StackPanel();
        panel.Children.Add(MakeHeader("外观"));
        panel.Children.Add(MakeHint("桌宠、窗口与聊天排版（对齐 Electron 外观设置）。"));
        panel.Children.Add(MakeSectionStatus("appearance"));

        panel.Children.Add(MakeSubHeader("昔涟桌宠"));
        panel.Children.Add(MakeToggleRow("桌宠显示", GetBool("petVisible", true), v => SetSetting("petVisible", v)));
        panel.Children.Add(MakeToggleRow("桌宠始终置顶", GetBool("petAlwaysOnTop", true),
            v => SetSetting("petAlwaysOnTop", v)));
        panel.Children.Add(MakeDoubleSliderRow("桌宠缩放", GetDouble("petZoom", 1), 0.5, 2, 0.1, "%",
            v => SetSetting("petZoom", Math.Round(v, 1)), v => $"{Math.Round(v * 100)}%"));

        panel.Children.Add(MakeSubHeader("窗口"));
        panel.Children.Add(MakeSliderRow("窗口圆角", GetInt("windowCornerRadius", 24), 0, 40, "px",
            v => SetSetting("windowCornerRadius", v)));

        panel.Children.Add(MakeSubHeader("界面"));
        panel.Children.Add(MakeUiIconRow(GetString("uiIcon", "cyrene-sun")));
        panel.Children.Add(MakeUiFontRow());

        panel.Children.Add(MakeSubHeader("聊天排版"));
        panel.Children.Add(MakeDoubleSliderRow("行间距", GetDouble("chatLineHeight", 1.75), 1.2, 2.0, 0.05, "",
            v => SetSetting("chatLineHeight", Math.Round(v, 2)), v => v.ToString("0.00")));
        panel.Children.Add(MakeToggleRow("昔涟回复气泡", GetBool("assistantBubbleEnabled"),
            v => SetSetting("assistantBubbleEnabled", v)));

        panel.Children.Add(MakeLegacyButton("appearance"));
        return panel;
    }

    /// <summary>桌面图标二选一（绮梦/晴光）：显示预设图片，选中带粉色描边。</summary>
    private FrameworkElement MakeUiIconRow(string current)
    {
        var selected = current == "cyrene-pink" ? "cyrene-pink" : "cyrene-sun";
        var row = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 6, 0, 6) };
        Border? pinkTile = null;
        Border? sunTile = null;
        void Refresh()
        {
            if (pinkTile is not null)
            {
                pinkTile.BorderBrush = selected == "cyrene-pink" ? NativeTheme.PinkBrush : NativeTheme.BorderSoftBrush;
                pinkTile.BorderThickness = new Thickness(selected == "cyrene-pink" ? 2 : 1);
            }
            if (sunTile is not null)
            {
                sunTile.BorderBrush = selected == "cyrene-sun" ? NativeTheme.PinkBrush : NativeTheme.BorderSoftBrush;
                sunTile.BorderThickness = new Thickness(selected == "cyrene-sun" ? 2 : 1);
            }
        }
        Border MakeTile(string id, string label)
        {
            var content = new StackPanel { Orientation = Orientation.Vertical, Width = 64 };
            var image = new Image { Width = 40, Height = 40, Stretch = Stretch.Uniform };
            var source = TryLoadAssetImage(Path.Combine("icons", $"{id}.png"));
            if (source is not null) image.Source = source;
            content.Children.Add(image);
            content.Children.Add(new TextBlock
            {
                Text = label,
                FontSize = 11,
                Foreground = NativeTheme.TextMutedBrush,
                HorizontalAlignment = HorizontalAlignment.Center,
                Margin = new Thickness(0, 4, 0, 0),
            });
            var tile = new Border
            {
                Child = content,
                CornerRadius = new CornerRadius(10),
                Background = Brushes.White,
                BorderBrush = NativeTheme.BorderSoftBrush,
                BorderThickness = new Thickness(1),
                Padding = new Thickness(10, 8, 10, 8),
                Margin = new Thickness(0, 0, 10, 0),
                Cursor = System.Windows.Input.Cursors.Hand,
            };
            tile.MouseLeftButtonUp += (_, _) =>
            {
                selected = id;
                SetSetting("uiIcon", id);
                Refresh();
            };
            return tile;
        }
        pinkTile = MakeTile("cyrene-pink", "绮梦");
        sunTile = MakeTile("cyrene-sun", "晴光");
        Refresh();
        row.Children.Add(pinkTile);
        row.Children.Add(sunTile);
        return MakeRow("桌面图标", row);
    }

    /** 从 assets 目录加载图片（缺失返回 null，UI 退化为无图）。 */
    private static ImageSource? TryLoadAssetImage(string relativePath)
    {
        try
        {
            var path = Path.Combine(AppContext.BaseDirectory, "assets", relativePath);
            if (!File.Exists(path)) return null;
            var image = new BitmapImage();
            image.BeginInit();
            image.CacheOption = BitmapCacheOption.OnLoad;
            image.UriSource = new Uri(path);
            image.EndInit();
            image.Freeze();
            return image;
        }
        catch
        {
            return null;
        }
    }

    /// <summary>界面字体：显示当前字体 + 导入/恢复默认（宿主弹文件框，native 不传路径）。</summary>
    private FrameworkElement MakeUiFontRow()
    {
        var font = GetNode("uiFont");
        var displayName = GetString(font, "displayName");
        if (displayName.Length == 0) displayName = GetString(font, "kind", "source-han") == "custom" ? "自定义字体" : "思源黑体（默认）";
        var row = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 6, 0, 6) };
        var label = new TextBlock
        {
            Text = displayName,
            FontSize = 12.5,
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(0, 0, 10, 0),
        };
        row.Children.Add(label);
        var importBtn = MakeButton("导入字体", () => RequestRouter.SendCommand("settings", "ui-font-import"), minWidth: 88);
        var resetBtn = MakeButton("恢复默认", () => RequestRouter.SendCommand("settings", "ui-font-reset"), minWidth: 84);
        row.Children.Add(importBtn);
        row.Children.Add(resetBtn);
        return MakeRow("界面字体", row);
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

        panel.Children.Add(MakeTextRow("昵称", GetString(user, "nickname"), v => SetUserProfile("nickname", v),
            placeholder: "你想让昔涟怎么称呼你"));
        panel.Children.Add(MakeTextRow("称呼偏好", GetString(user, "callPreference"), v => SetUserProfile("callPreference", v),
            placeholder: "例如：伙伴（留空用昵称）"));
        // 生日用日期选择器（旧实现自由文本，可写入非法值）
        var birthdayPicker = new DatePicker
        {
            Width = 260,
            FontSize = 12,
            SelectedDate = TryParseDateOnly(GetString(user, "birthday")),
        };
        birthdayPicker.SelectedDateChanged += (_, _) =>
        {
            SetUserProfile("birthday", birthdayPicker.SelectedDate?.ToString("yyyy-MM-dd") ?? "");
        };
        panel.Children.Add(MakeRow("生日", birthdayPicker));
        panel.Children.Add(MakeTextRow("默认城市", GetString(user, "defaultCity"), v => SetUserProfile("defaultCity", v),
            placeholder: "例如：上海、北京、广州"));
        panel.Children.Add(MakeTimezoneRow(user));
        panel.Children.Add(MakeGenderRow(user));
        return panel;
    }

    private FrameworkElement BuildAboutSection()
    {
        var panel = new StackPanel();
        panel.Children.Add(MakeHeader("关于"));
        // 应用图标 + 品牌行（对齐 Electron 设置页导航头部的 logo/标语）
        var logo = new Image
        {
            Width = 64,
            Height = 64,
            Stretch = Stretch.Uniform,
            HorizontalAlignment = HorizontalAlignment.Left,
            Margin = new Thickness(0, 4, 0, 8),
        };
        var logoSource = TryLoadAssetImage(Path.Combine("icons", "cyrene-pink.png"));
        if (logoSource is not null) logo.Source = logoSource;
        panel.Children.Add(logo);
        panel.Children.Add(MakeHint("昔涟 · 轻量情感陪伴桌面 Agent"));
        panel.Children.Add(MakeHint($"版本：v{GetString("version", "未知")}"));
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
        else if (section == "channels")
        {
            // 渠道配置 = Electron 独立窗（宿主 openChannels 动作）
            btn.Click += (_, _) => RequestRouter.SendCommand("settings", "openChannels");
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
    /// 按 section 数据源子集判定差异，只重建变化的 section：
    ///   - 列表型 section（记忆/定时任务）随数据刷新
    ///   - 表单型 section（API/用户）不会被无关推送打断（保住未提交输入）
    /// 重建前停掉未提交的防抖定时器，避免旧控件在重建后写出陈旧值。
    /// </summary>
    public void ApplySettings(JsonElement settings)
    {
        if (settings.ValueKind != JsonValueKind.Object) return;
        _settings = settings;
        StopDebounceTimers();
        foreach (var (id, host) in _sectionHosts)
        {
            if (!IsNativeSection(id)) continue;
            // 懒构建：未显示过的 section 不随快照重建（首次显示时按最新快照构建）
            if (host.Children.Count == 0) continue;
            var source = SectionSourceJson(id);
            if (_sectionSources.TryGetValue(id, out var previous) && previous == source) continue;
            _sectionSources[id] = source;
            host.Children.Clear();
            host.Children.Add(BuildNativeSection(id));
            RenderNotice(id);
        }
    }

    // ── section 差异判定 / 反馈帧 ──

    private readonly Dictionary<string, string> _sectionSources = new();
    private readonly Dictionary<string, TextBlock> _sectionStatus = new();
    /** 各 section 最近一次宿主反馈（section 重建后在状态行回填，避免提示被冲掉） */
    private readonly Dictionary<string, (string Text, string Level)> _lastNotices = new();

    /// <summary>各 section 的数据源子集（用于按 section 判定是否重建）。</summary>
    private string SectionSourceJson(string id) => id switch
    {
        "general" => string.Join("|",
            GetBool("launchAtLogin"), GetBool("toastSoundEnabled", true),
            GetBool("sidebarVisible", true), GetBool("tasksVisible", true),
            GetBool("disableGpuElectron"),
            GetString("gitCommitAuthorName"), GetString("gitCommitAuthorEmail")),
        "appearance" => string.Join("|",
            GetBool("petVisible", true), GetBool("petAlwaysOnTop", true), GetDouble("petZoom", 1),
            GetInt("windowCornerRadius", -1), GetString("uiIcon"), NodeRawJson("uiFont"),
            GetDouble("chatLineHeight", 1.75), GetBool("assistantBubbleEnabled")),
        "user" => NodeRawJson("user"),
        "api" => NodeRawJson("api"),
        "api-advanced" => NodeRawJson("runtime"),
        "disclaimer" => "",
        "memory" => NodeRawJson("memory"),
        "tasks" => NodeRawJson("tasks"),
        // 关于：静态内容（版本号启动后不变），只需首次构建
        _ => "",
    };

    private string NodeRawJson(string key)
    {
        var node = GetNode(key);
        return node.ValueKind == JsonValueKind.Undefined ? "" : node.GetRawText();
    }

    /// <summary>section 状态行注册（每次重建覆盖注册）。</summary>
    private void RegisterSectionStatus(string section, TextBlock status)
    {
        _sectionStatus[section] = status;
    }

    /// <summary>宿主反馈帧（state.settings-notice）：就地更新对应 section 状态行。</summary>
    public void ApplyNotice(JsonElement notice)
    {
        if (notice.ValueKind != JsonValueKind.Object) return;
        var section = GetString(notice, "section");
        var text = GetString(notice, "text");
        var level = GetString(notice, "level", "info");
        if (section.Length == 0 || text.Length == 0) return;
        _lastNotices[section] = (text, level);
        // api 保存成功回执：记住新档案 id，重建后的表单直接进入编辑态
        //（旧实现保存新增档案后 ProfileId 仍为 null，再保存会命中去重失败）
        if (section == "api" && notice.TryGetProperty("data", out var data) && data.ValueKind == JsonValueKind.Object)
        {
            var savedProfileId = GetString(data, "savedProfileId");
            if (savedProfileId.Length > 0 && _apiForm is not null) _apiForm.ProfileId = savedProfileId;
        }
        RenderNotice(section);
    }

    /// <summary>把最近一次 section 反馈渲染到状态行（section 重建后回填，避免提示被冲掉）。</summary>
    private void RenderNotice(string section)
    {
        if (!_sectionStatus.TryGetValue(section, out var status)) return;
        if (!_lastNotices.TryGetValue(section, out var notice)) return;
        status.Text = $"· {notice.Text}";
        status.Foreground = new SolidColorBrush(notice.Level switch
        {
            "ok" => Color.FromRgb(0x1D, 0x9A, 0x54),
            "error" => Color.FromRgb(0xD3, 0x3A, 0x3A),
            _ => Color.FromRgb(0x66, 0x66, 0x77),
        });
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

    private double GetDouble(string key, double fallback)
        => _settings.ValueKind == JsonValueKind.Object
           && _settings.TryGetProperty(key, out var v)
           && v.ValueKind == JsonValueKind.Number
           && v.TryGetDouble(out var n) ? n : fallback;

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
        FontSize = 19,
        FontWeight = FontWeights.SemiBold,
        Foreground = NativeTheme.TextStrongBrush,
        Margin = new Thickness(0, 0, 0, 8),
    };

    private static TextBlock MakeHint(string text) => new()
    {
        Text = text,
        FontSize = 12,
        Foreground = NativeTheme.TextMutedBrush,
        TextWrapping = TextWrapping.Wrap,
        Margin = new Thickness(0, 2, 0, 2),
    };

    /// <summary>section 状态行（反馈帧就地更新；注册到 _sectionStatus）。</summary>
    private TextBlock MakeSectionStatus(string section)
    {
        var status = new TextBlock
        {
            Text = "",
            FontSize = 12,
            Foreground = NativeTheme.TextMutedBrush,
            Margin = new Thickness(0, 4, 0, 6),
            TextWrapping = TextWrapping.Wrap,
        };
        RegisterSectionStatus(section, status);
        return status;
    }

    private static TextBlock MakeSubHeader(string text) => new()
    {
        Text = text,
        FontSize = 14,
        FontWeight = FontWeights.SemiBold,
        Foreground = NativeTheme.TextStrongBrush,
        Margin = new Thickness(0, 16, 0, 6),
    };

    private static Button MakeButton(string text, Action onClick, bool primary = false, double minWidth = 96)
    {
        var button = new Button
        {
            Content = text,
            MinWidth = minWidth,
            Margin = new Thickness(0, 4, 8, 4),
            Style = primary ? NativeTheme.PrimaryButtonStyle : NativeTheme.SecondaryButtonStyle,
        };
        button.Click += (_, _) => onClick();
        return button;
    }

    private static TextBlock MakeCardTitle(string text) => new()
    {
        Text = text,
        FontSize = 13,
        FontWeight = FontWeights.SemiBold,
        Foreground = NativeTheme.TextStrongBrush,
        TextWrapping = TextWrapping.Wrap,
    };

    private static TextBlock MakeCardMeta(string text) => new()
    {
        Text = text,
        FontSize = 11,
        Foreground = NativeTheme.TextMutedBrush,
        TextWrapping = TextWrapping.Wrap,
        Margin = new Thickness(0, 2, 0, 2),
    };

    /// <summary>卡片容器（白底圆角边框 + 内部竖直 StackPanel）。</summary>
    private static Border MakeCard(out StackPanel content)
    {
        content = new StackPanel();
        return new Border
        {
            BorderBrush = NativeTheme.BorderSoftBrush,
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(12),
            Background = Brushes.White,
            Padding = new Thickness(14, 12, 14, 12),
            Margin = new Thickness(0, 6, 0, 6),
            Child = content,
        };
    }

    private static string FormatUnixMs(double ms)
    {
        if (ms <= 0) return "-";
        try
        {
            return DateTimeOffset.FromUnixTimeMilliseconds((long)ms).ToLocalTime().ToString("yyyy-MM-dd HH:mm");
        }
        catch
        {
            return "-";
        }
    }

    // ── 快照读取（嵌套节点静态重载；section 分文件共用） ──

    private static JsonElement GetNode(JsonElement node, string key)
        => node.ValueKind == JsonValueKind.Object && node.TryGetProperty(key, out var v) ? v : default;

    private static bool GetBool(JsonElement node, string key, bool fallback = false)
        => node.ValueKind == JsonValueKind.Object && node.TryGetProperty(key, out var v)
            ? v.ValueKind == JsonValueKind.True ? true
              : v.ValueKind == JsonValueKind.False ? false
              : fallback
            : fallback;

    private static int GetInt(JsonElement node, string key, int fallback)
        => node.ValueKind == JsonValueKind.Object
           && node.TryGetProperty(key, out var v)
           && v.ValueKind == JsonValueKind.Number
           && v.TryGetInt32(out var n) ? n : fallback;

    private static double GetDouble(JsonElement node, string key, double fallback)
        => node.ValueKind == JsonValueKind.Object
           && node.TryGetProperty(key, out var v)
           && v.ValueKind == JsonValueKind.Number
           && v.TryGetDouble(out var n) ? n : fallback;

    private static Border MakeRow(string label, FrameworkElement control)
    {
        var sp = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 10, 0, 10) };
        sp.Children.Add(new TextBlock
        {
            Text = label,
            FontSize = 12.5,
            Width = 140,
            Foreground = NativeTheme.TextDefaultBrush,
            VerticalAlignment = VerticalAlignment.Center,
        });
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

    /// <summary>浮点滑杆行（桌宠缩放 / 行间距）：250ms 防抖后写一次。</summary>
    private Border MakeDoubleSliderRow(
        string label,
        double initial,
        double min,
        double max,
        double step,
        string unit,
        Action<double> onChange,
        Func<double, string>? format = null)
    {
        var row = new StackPanel { Orientation = Orientation.Horizontal };
        var slider = new Slider
        {
            Width = 200,
            Minimum = min,
            Maximum = max,
            Value = Math.Max(min, Math.Min(max, initial)),
            IsSnapToTickEnabled = true,
            TickFrequency = step,
            VerticalAlignment = VerticalAlignment.Center,
        };
        string Format(double v) => format?.Invoke(v) ?? $"{v:0.##}{unit}";
        var valueText = new TextBlock
        {
            Text = Format(slider.Value),
            Width = 60,
            FontSize = 12,
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(10, 0, 0, 0),
        };
        var timer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(250) };
        timer.Tick += (_, _) =>
        {
            timer.Stop();
            onChange(slider.Value);
        };
        slider.ValueChanged += (_, _) =>
        {
            valueText.Text = Format(slider.Value);
            timer.Stop();
            timer.Start();
        };
        _debounceTimers.Add(timer);
        row.Children.Add(slider);
        row.Children.Add(valueText);
        return MakeRow(label, row);
    }

    /// <summary>文本行：失焦或回车提交；与初值相同不发请求。placeholder 为空时不显示占位。</summary>
    private static Border MakeTextRow(string label, string initial, Action<string> onCommit, double width = 260, string? placeholder = null)
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
        if (placeholder is null) return MakeRow(label, box);

        // 占位文本：WPF TextBox 无 placeholder，用覆盖层 + 空文本切换模拟
        var host = new Grid { Width = width };
        host.Children.Add(box);
        var placeholderText = new TextBlock
        {
            Text = placeholder,
            FontSize = 12,
            Foreground = NativeTheme.TextMutedBrush,
            Margin = new Thickness(9, 0, 0, 0),
            VerticalAlignment = VerticalAlignment.Center,
            IsHitTestVisible = false,
            Visibility = box.Text.Length == 0 ? Visibility.Visible : Visibility.Collapsed,
        };
        box.TextChanged += (_, _) =>
        {
            placeholderText.Visibility = box.Text.Length == 0 ? Visibility.Visible : Visibility.Collapsed;
        };
        host.Children.Add(placeholderText);
        return MakeRow(label, host);
    }

    /** 解析 yyyy-MM-dd（非法返回 null，DatePicker 显示空） */
    private static DateTime? TryParseDateOnly(string value)
        => DateTime.TryParseExact(value, "yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture,
            System.Globalization.DateTimeStyles.None, out var date)
            ? date
            : null;

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

    public override void ShowWindow()
    {
        if (!_window.IsVisible) _window.Show();
        _window.Activate();
    }

    public override void Activate()
    {
        if (!_window.IsVisible) _window.Show();
        if (_window.WindowState == WindowState.Minimized) _window.WindowState = WindowState.Normal;
        _window.Activate();
        _window.Focus();
    }

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
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
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
///   - 真 section：记忆 / 用户信息 / 定时任务 / 工具配置 / 偏好 / 外观 / 通用 /
///     API / 高级（运行设置）/ 昔涟 / TTS / ASR / Token / 免责声明 / 关于
///   - 占位 section（连接手机）：显示跳转按钮 → cmd 事件（Electron 独立窗口）
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
    /// <summary>插件卡配置区折叠状态（key = 工具卡 collapseKey；窗口生命周期内记忆）</summary>
    private readonly HashSet<string> _collapsedToolCards = new();
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
            Width = 1092,
            Height = 952,
            WindowStartupLocation = WindowStartupLocation.CenterScreen,
            WindowStyle = WindowStyle.None,
            ResizeMode = ResizeMode.NoResize,
            // 无边框圆角窗：窗口本身全透明，圆角由 root Border + 裁剪提供
            AllowsTransparency = true,
            Background = Brushes.Transparent,
            ShowInTaskbar = true,
            // 任务栏/Alt-Tab 图标：从打包布局同级的 Cyrene.exe 提取（缺失则留空）
            Icon = AppIcons.Image,
        };
        NativeTheme.Apply(_window);

        var root = new Border
        {
            BorderBrush = new SolidColorBrush(Color.FromArgb(0x22, 0x88, 0x88, 0x99)),
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(12),
            // 窗口壳体白底（Electron [pearl-white] .settings-shell → --rb-card-bg #FFFFFF）
            Background = Brushes.White,
            Margin = new Thickness(16), // 透明留白：给窗口投影
        };
        var grid = new Grid();
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(168) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        grid.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        root.Child = grid;
        // 投影层 + 内容壳（同圆角；阴影画在 16px 透明留白里）
        _rootBorder = root;
        _shadowLayer = NativeTheme.MakeWindowShadowLayer(12);
        var shell = new Grid();
        shell.Children.Add(_shadowLayer);
        shell.Children.Add(root);
        _window.Content = shell;
        // 圆角裁剪：Border 不会自动把子元素裁到圆角，导航/标题栏会溢出方形角。
        // 用可更新几何体，窗口圆角随设置（windowCornerRadius）切换。
        _clipGeometry = new RectangleGeometry { RadiusX = 12, RadiusY = 12 };
        grid.Clip = _clipGeometry;
        void UpdateClip() => _clipGeometry.Rect = new Rect(0, 0, grid.ActualWidth, grid.ActualHeight);
        grid.SizeChanged += (_, _) => UpdateClip();
        UpdateClip();

        // ── 右侧：标题栏（当前 section 标题 + 说明 + 最小化/关闭）+ 内容区 ──
        // 对齐旧版设置页布局：导航列在最左（含品牌行），内容列顶部是 section 标题栏
        var contentGrid = new Grid();
        contentGrid.RowDefinitions.Add(new RowDefinition { Height = new GridLength(64) });
        contentGrid.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });

        var titleBar = new Border
        {
            // pearl-white .settings-titlebar → --rb-bg-1 #F5F5F7 + --rb-border-soft 下边线
            Background = NativeTheme.SurfaceNavBrush,
            BorderBrush = NativeTheme.BorderSoftBrush,
            BorderThickness = new Thickness(0, 0, 0, 1),
            CornerRadius = new CornerRadius(12, 12, 0, 0),
        };
        var titleGrid = new Grid();
        titleGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        titleGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        titleGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        var titleStack = new StackPanel { VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(24, 0, 12, 0) };
        _sectionTitle.Text = "设置";
        _sectionTitle.FontSize = 16;
        _sectionTitle.FontWeight = FontWeights.Medium;
        _sectionTitle.Foreground = NativeTheme.TextStrongBrush;
        _sectionHint.FontSize = 12;
        // pearl-white 覆盖组把 titlebar hint 一并设为 --rb-text-strong（theme.css:159）
        _sectionHint.Foreground = NativeTheme.TextStrongBrush;
        _sectionHint.Margin = new Thickness(0, 2, 0, 0);
        _sectionHint.TextTrimming = TextTrimming.CharacterEllipsis;
        titleStack.Children.Add(_sectionTitle);
        titleStack.Children.Add(_sectionHint);
        Grid.SetColumn(titleStack, 0);
        titleGrid.Children.Add(titleStack);
        var minBtn = NativeTheme.MakeMinimizeButton(() => _window, 30);
        var closeBtn = NativeTheme.MakeCloseButton(() => _window, 30);
        closeBtn.Margin = new Thickness(2, 0, 12, 0);
        Grid.SetColumn(minBtn, 1);
        Grid.SetColumn(closeBtn, 2);
        titleGrid.Children.Add(minBtn);
        titleGrid.Children.Add(closeBtn);
        titleBar.Child = titleGrid;
        _titleBar = titleBar;
        titleBar.MouseLeftButtonDown += (_, _) => { try { _window.DragMove(); } catch { /* not pressed */ } };
        Grid.SetRow(titleBar, 0);
        contentGrid.Children.Add(titleBar);

        // ── 左侧导航（品牌行 + 可滚动 section 列表 + 版本页脚）——对齐 Electron .settings-nav ──
        // Electron：padding 18/12/14、右侧 1px 分隔线；header 不滚动、列表滚动、footer 常驻。
        var nav = new Border
        {
            Background = NativeTheme.SurfaceNavBrush,
            BorderBrush = NativeTheme.BorderSoftBrush,
            BorderThickness = new Thickness(0, 0, 1, 0),
        };
        var navRoot = new Grid { Margin = new Thickness(12, 18, 12, 14) };
        navRoot.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        navRoot.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        navRoot.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        nav.Child = navRoot;
        Grid.SetColumn(nav, 0);
        Grid.SetRow(nav, 0);
        grid.Children.Add(nav);
        var navPanel = new StackPanel();
        var navScroll = new ScrollViewer
        {
            VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
            HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled,
            Content = navPanel,
            Focusable = false,
        };
        Grid.SetRow(navScroll, 1);
        navRoot.Children.Add(navScroll);
        // 页脚版本（Electron .settings-nav__footer，vite 注入「昔涟 v<version>」）
        _navVersion = new TextBlock
        {
            FontSize = 12,
            Foreground = NativeTheme.NavTextBrush,
            HorizontalAlignment = HorizontalAlignment.Center,
            TextAlignment = TextAlignment.Center,
            Margin = new Thickness(8, 10, 8, 0),
        };
        Grid.SetRow(_navVersion, 2);
        navRoot.Children.Add(_navVersion);
        _navVersion.Text = VersionText();

        _scroll = new ScrollViewer { VerticalScrollBarVisibility = ScrollBarVisibility.Auto, Padding = new Thickness(0) };
        _sections = new StackPanel { Margin = new Thickness(24, 16, 24, 24) };
        _scroll.Content = _sections;
        Grid.SetRow(_scroll, 1);
        contentGrid.Children.Add(_scroll);

        Grid.SetColumn(contentGrid, 1);
        grid.Children.Add(contentGrid);

        BuildSections(navRoot, navPanel);
        _window.Closed += (_, _) => { StopDebounceTimers(); DisposeTtsPreview(); RaiseClosed(); };
    }

    private readonly TextBlock _sectionTitle = new();
    private readonly TextBlock _sectionHint = new();

    /// <summary>导航页脚版本行（Electron .settings-nav__footer：昔涟 v&lt;version&gt;）。</summary>
    private TextBlock? _navVersion;

    /// <summary>版本文案（vite appVersionPlugin 同款：昔涟 v&lt;version&gt;）。</summary>
    private string VersionText()
    {
        var version = GetString("version", "");
        return version.Length > 0 ? $"昔涟 v{version}" : "昔涟";
    }

    // ── 窗口外观（投影 / 圆角跟随设置） ──
    private Border? _rootBorder;
    private Border? _shadowLayer;
    private Border? _titleBar;
    private RectangleGeometry? _clipGeometry;
    private double _cornerRadius = 12;

    /// <summary>窗口圆角跟随设置（windowCornerRadius 0–40：内容壳/投影层/标题栏/裁剪同步）。</summary>
    private void ApplyWindowRadius(double radius)
    {
        radius = Math.Clamp(radius, 0, 40);
        if (Math.Abs(radius - _cornerRadius) < 0.5) return;
        _cornerRadius = radius;
        if (_rootBorder is not null) _rootBorder.CornerRadius = new CornerRadius(radius);
        if (_shadowLayer is not null) _shadowLayer.CornerRadius = new CornerRadius(radius);
        if (_titleBar is not null) _titleBar.CornerRadius = new CornerRadius(radius, radius, 0, 0);
        if (_clipGeometry is not null)
        {
            _clipGeometry.RadiusX = radius;
            _clipGeometry.RadiusY = radius;
        }
    }

    /// <summary>宿主 win.radius 广播 / spawn 补发（与快照路径同一实现）。</summary>
    public override void ApplyCornerRadius(double radius) => ApplyWindowRadius(radius);

    /// <summary>导航项样式：圆角高亮条（选中/悬停）—— 见 NativeTheme。</summary>
    private static Style BuildNavItemStyle() => NativeTheme.NavItemStyle;

    private void BuildSections(Grid navRoot, StackPanel nav)
    {
        var navStyle = BuildNavItemStyle();
        // 导航头部品牌行（logo + 昔涟）——对齐 Electron 设置页 settings-nav__brand
        // （.settings-nav__header padding 0 8px 14px；不随列表滚动）
        var brand = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(8, 0, 8, 14) };
        var brandLogo = new Image
        {
            Width = 28,
            Height = 28,
            Stretch = Stretch.Uniform,
            VerticalAlignment = VerticalAlignment.Center,
        };
        var brandSource = TryLoadAssetImage(Path.Combine("icons", "settings-logo.png"));
        if (brandSource is not null) brandLogo.Source = brandSource;
        brand.Children.Add(brandLogo);
        brand.Children.Add(new TextBlock
        {
            Text = "昔涟",
            FontSize = 20,
            FontWeight = FontWeights.SemiBold,
            Foreground = NativeTheme.TextStrongBrush,
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(8, 0, 0, 0),
        });
        Grid.SetRow(brand, 0);
        navRoot.Children.Add(brand);

        // 分组分隔线——Electron <hr class="nav-divider">（pearl-white：--rb-border-strong，margin 9px 2px）；
        // 列表 gap 5 由导航项自身 margin-bottom 提供，故下边距补到 14（5+9 与 9+5 等效 14）。
        void AddDivider()
        {
            nav.Children.Add(new Border
            {
                Height = 1,
                Background = NativeTheme.BorderStrongBrush,
                Margin = new Thickness(2, 9, 2, 14),
            });
        }

        void AddSection(string id, string label, bool native, string? legacyHash = null, bool pluginManager = false)
        {
            // 导航项内容：图标（对齐渲染页 SVG 几何/图片）+ 文本（gap 8 = .nav-item gap）
            var content = new StackPanel { Orientation = Orientation.Horizontal };
            var icon = SettingsNavIcons.Create(id);
            if (icon is not null)
            {
                icon.VerticalAlignment = VerticalAlignment.Center;
                content.Children.Add(icon);
            }
            content.Children.Add(new TextBlock
            {
                Text = label,
                VerticalAlignment = VerticalAlignment.Center,
                Margin = new Thickness(icon is null ? 0 : 8, 0, 0, 0),
            });
            var btn = new RadioButton
            {
                Content = content,
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

        // 顺序/分组/文案对齐渲染页 index.html 导航（上游 2026-09 更新后在先）：
        //   记忆/用户信息 │ 定时任务/工具配置 │ 偏好/外观/通用/API/高级/昔涟/连接手机/TTS/ASR/Token │ 免责声明
        AddSection("memory", "记忆", native: true);
        AddSection("user", "用户信息", native: true);
        AddDivider();
        AddSection("tasks", "定时任务", native: true);
        AddSection("plugins", "工具配置", native: true);
        AddDivider();
        AddSection("preferences", "偏好设置", native: true);
        AddSection("appearance", "外观设置", native: true);
        AddSection("general", "通用设置", native: true);
        AddSection("api", "API 设置", native: true);
        AddSection("api-advanced", "高级设置", native: true);
        AddSection("cyrene", "昔涟设置", native: true);
        AddSection("channels", "连接手机", native: false, legacyHash: "channels");
        AddSection("tts", "TTS 设置", native: true);
        AddSection("asr", "ASR 设置", native: true);
        // OCR 设置仍在 Electron 设置页：WPF 导航只放入口（native:false → 占位跳转按钮）
        AddSection("ocr", "OCR 设置", native: false, legacyHash: "ocr");
        // 云存储设置同样在 Electron 设置页：WPF 导航只放入口
        AddSection("cloud-storage", "云存储", native: false, legacyHash: "cloud-storage");
        AddSection("tokens", "Token 用量", native: true);
        AddDivider();
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
        // 内容区标题栏跟随当前 section（旧版 section-title / section-hint 语义）
        if (SettingsNavIcons.SectionMeta.TryGetValue(id, out var meta))
        {
            _sectionTitle.Text = meta.Title;
            _sectionHint.Text = meta.Hint;
        }
        foreach (var (key, host) in _sectionHosts)
        {
            host.Visibility = key == id ? Visibility.Visible : Visibility.Collapsed;
        }
    }

    // ── 原生 section：记忆 / 用户信息 / 定时任务 / 工具配置 / 偏好 / 外观 / 通用 / API / 高级 / 昔涟 / TTS / ASR / Token / 免责声明 / 关于 ──

    private static bool IsNativeSection(string id)
        => id is "general" or "preferences" or "appearance" or "user" or "api" or "api-advanced" or "cyrene" or "disclaimer" or "memory" or "tasks" or "tokens" or "plugins" or "tts" or "asr" or "about";

    private FrameworkElement BuildNativeSection(string id) => id switch
    {
        "general" => BuildGeneralSection(),
        "preferences" => BuildPreferencesSection(),
        "appearance" => BuildAppearanceSection(),
        "user" => BuildUserSection(),
        "api" => BuildApiSection(),
        "api-advanced" => BuildRuntimeSection(),
        "cyrene" => BuildCyreneSection(),
        "disclaimer" => BuildDisclaimerSection(),
        "memory" => BuildMemorySection(),
        "tasks" => BuildTasksSection(),
        "tokens" => BuildTokensSection(),
        "plugins" => BuildPluginsSection(),
        "tts" => BuildTtsSection(),
        "asr" => BuildAsrSection(),
        "about" => BuildAboutSection(),
        _ => new TextBlock { Text = "未知分区" },
    };

    private FrameworkElement BuildGeneralSection()
    {
        var panel = new StackPanel();
        panel.Children.Add(MakePanelHeading(
            NativeTheme.VectorGlyph(Glyphs.Gear, 24, NativeTheme.TextDefaultBrush),
            "通用设置",
            "控制状态栏、日程栏、基础音频和系统行为。"));
        panel.Children.Add(MakeSectionStatus("general"));
        panel.Children.Add(BlockMark());
        panel.Children.Add(MakeSubHeader("启动与提醒"));
        panel.Children.Add(MakeToggleRow("开机自启", GetBool("launchAtLogin"), v => SetSetting("launchAtLogin", v)));
        panel.Children.Add(MakeToggleRow("提醒音效", GetBool("toastSoundEnabled", true),
            v => SetSetting("toastSoundEnabled", v)));

        panel.Children.Add(BlockMark());
        panel.Children.Add(MakeSubHeader("窗口"));
        panel.Children.Add(MakeToggleRow("状态栏窗口", GetBool("sidebarVisible", true),
            v => SetSetting("sidebarVisible", v)));
        panel.Children.Add(MakeToggleRow("日程栏窗口", GetBool("tasksVisible", true),
            v => SetSetting("tasksVisible", v)));
        panel.Children.Add(MakeHint("关闭状态栏/日程栏后立即隐藏；再次打开从托盘或此处恢复。"));

        panel.Children.Add(BlockMark());
        panel.Children.Add(MakeSubHeader("性能"));
        panel.Children.Add(MakeToggleRow("禁用 GPU 渲染", GetBool("disableGpuElectron"),
            v => SetSetting("disableGpuElectron", v)));
        // 旧版行内链接：查看 chrome://gpu 判断当前是否使用 GPU 渲染
        var gpuHint = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(0, 2, 0, 2),
        };
        gpuHint.Children.Add(MakeHint("无 GPU 或花屏时开启；下次启动生效。可以通过查看"));
        var gpuLink = new TextBlock
        {
            Text = "GPU Internals 页面",
            FontSize = 12.5,
            Foreground = NativeTheme.Pink600Brush,
            TextDecorations = TextDecorations.Underline,
            Cursor = System.Windows.Input.Cursors.Hand,
            VerticalAlignment = VerticalAlignment.Center,
        };
        gpuLink.MouseLeftButtonUp += (_, _) => RequestRouter.SendSettingsAction("general", "open-gpu-internals");
        gpuHint.Children.Add(gpuLink);
        gpuHint.Children.Add(MakeHint("得知当前是否使用 GPU 渲染。"));
        panel.Children.Add(gpuHint);

        panel.Children.Add(BlockMark());
        panel.Children.Add(MakeSubHeader("聊天记录"));
        void ClearChatHistory()
        {
            var confirm = MessageBox.Show(
                "清空所有聊天会话？\n此操作会删除全部历史对话，无法恢复。",
                "清空聊天记录",
                MessageBoxButton.OKCancel,
                MessageBoxImage.Warning);
            if (confirm != MessageBoxResult.OK) return;
            // 结果反馈走宿主 notice（general 状态行）
            RequestRouter.SendSettingsAction("general", "clear-chat-history");
        }
        panel.Children.Add(MakeDescribedRow("聊天记录管理", "清空全部本地聊天会话。",
            MakeButton("清空记录", ClearChatHistory, minWidth: 96)));

        panel.Children.Add(BlockMark());
        panel.Children.Add(MakeSubHeader("数据与存储"));
        BuildPortableBlock(panel);
        BuildCacheDirBlock(panel);

        panel.Children.Add(BlockMark());
        panel.Children.Add(MakeSubHeader("语言"));
        panel.Children.Add(MakeDescribedRow("语言", "当前仅支持中文，其他语言待开发。",
            MakeChoiceGroup(
                new[]
                {
                    ("zh-CN", "中文", true),
                    ("en", "EN", false),
                    ("ja", "日文", false),
                    ("ko", "韩语", false),
                },
                GetString("language", "zh-CN"),
                _ => { })));

        panel.Children.Add(BlockMark());
        panel.Children.Add(MakeSubHeader("Git 提交身份"));
        panel.Children.Add(MakeHint("代码 Git 面板提交时使用；邮箱必填。"));
        panel.Children.Add(MakeTextRow("作者名", GetString("gitCommitAuthorName", "Cyrene"),
            v => SetSetting("gitCommitAuthorName", v)));
        panel.Children.Add(MakeTextRow("邮箱", GetString("gitCommitAuthorEmail"),
            v => SetSetting("gitCommitAuthorEmail", v)));

        // 关于（对齐上游通用页 .setting-row--about：版本 + 副标题；完整运行信息在「关于」section）
        panel.Children.Add(BlockMark());
        panel.Children.Add(MakeSubHeader("关于"));
        panel.Children.Add(MakeText($"{VersionText()} · 轻量情感陪伴桌面 Agent", 14,
            NativeTheme.TextMutedBrush, lineHeight: 22.4, margin: new Thickness(0, 4, 0, 4)));
        CardifySubBlocks(panel);

        return panel;
    }

    private FrameworkElement BuildAppearanceSection()
    {
        var panel = new StackPanel();
        panel.Children.Add(MakePanelHeading(
            NativeTheme.VectorGlyph(Glyphs.Palette, 24, NativeTheme.TextDefaultBrush),
            "外观设置",
            "调整白调界面的窗口布局与昔涟桌宠显示方式。"));
        panel.Children.Add(MakeSectionStatus("appearance"));

        // ── 布局（旧版 appearance-section：多窗口选中 / 单窗口 SOON 占位） ──
        panel.Children.Add(BlockMark());
        panel.Children.Add(MakeSubHeader("布局"));
        panel.Children.Add(MakeHint("选择昔涟与聊天、状态和日程窗口的组织方式。"));
        var layoutRow = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 6, 0, 6) };
        layoutRow.Children.Add(MakeLayoutCard("▦", "多窗口", "各功能使用独立窗口", active: true, soon: false));
        layoutRow.Children.Add(MakeLayoutCard("▣", "单窗口", "集中在一个主窗口中", active: false, soon: true));
        panel.Children.Add(layoutRow);

        panel.Children.Add(BlockMark());
        panel.Children.Add(MakeSubHeader("昔涟桌宠"));
        panel.Children.Add(MakeToggleRow("桌宠显示", GetBool("petVisible", true), v => SetSetting("petVisible", v)));
        panel.Children.Add(MakeToggleRow("桌宠始终置顶", GetBool("petAlwaysOnTop", true),
            v => SetSetting("petAlwaysOnTop", v)));
        panel.Children.Add(MakeDoubleSliderRow("桌宠缩放", GetDouble("petZoom", 1), 0.5, 2, 0.1, "%",
            v => SetSetting("petZoom", Math.Round(v, 1)), v => $"{Math.Round(v * 100)}%"));

        panel.Children.Add(BlockMark());
        panel.Children.Add(MakeSubHeader("窗口"));
        panel.Children.Add(MakeSliderRow("窗口圆角", GetInt("windowCornerRadius", 24), 0, 40, "px",
            v => SetSetting("windowCornerRadius", v)));

        panel.Children.Add(BlockMark());
        panel.Children.Add(MakeSubHeader("界面"));
        panel.Children.Add(MakeUiIconRow(GetString("uiIcon", "cyrene-sticker")));
        panel.Children.Add(MakeUiFontRow());
        panel.Children.Add(MakeSoonPlaceholderRow("聊天背景"));

        panel.Children.Add(BlockMark());
        panel.Children.Add(MakeSubHeader("聊天排版"));
        panel.Children.Add(MakeDoubleSliderRow("行间距", GetDouble("chatLineHeight", 1.75), 1.2, 2.0, 0.05, "",
            v => SetSetting("chatLineHeight", Math.Round(v, 2)), v => v.ToString("0.00")));
        panel.Children.Add(MakeDoubleSliderRow("段落间距", GetDouble("chatParaSpacing", 0.5), 0.2, 1.2, 0.05, "em",
            v => SetSetting("chatParaSpacing", Math.Round(v, 2)), v => v.ToString("0.00") + "em"));
        panel.Children.Add(MakeToggleRow("昔涟回复气泡", GetBool("assistantBubbleEnabled"),
            v => SetSetting("assistantBubbleEnabled", v)));
        CardifySubBlocks(panel);

        return panel;
    }

    /// <summary>外观「布局」卡（旧版 appearance-option：图标 + 标题/说明；SOON = 禁用占位）。</summary>
    private static Border MakeLayoutCard(string glyph, string title, string description, bool active, bool soon)
    {
        var copy = new StackPanel { VerticalAlignment = VerticalAlignment.Center };
        var titleRow = new StackPanel { Orientation = Orientation.Horizontal };
        titleRow.Children.Add(new TextBlock
        {
            Text = title,
            FontSize = 13.5,
            FontWeight = FontWeights.SemiBold,
            Foreground = NativeTheme.TextStrongBrush,
            VerticalAlignment = VerticalAlignment.Center,
        });
        if (soon) titleRow.Children.Add(MakeSoonBadge());
        copy.Children.Add(titleRow);
        copy.Children.Add(new TextBlock
        {
            Text = description,
            FontSize = 12,
            Foreground = NativeTheme.TextMutedBrush,
            Margin = new Thickness(0, 3, 0, 0),
        });
        var content = new StackPanel { Orientation = Orientation.Horizontal };
        content.Children.Add(new TextBlock
        {
            Text = glyph,
            FontSize = 18,
            Foreground = active ? NativeTheme.PinkBrush : NativeTheme.TextMutedBrush,
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(0, 0, 10, 0),
        });
        content.Children.Add(copy);
        return new Border
        {
            Child = content,
            Width = 236,
            CornerRadius = new CornerRadius(12),
            BorderThickness = new Thickness(active ? 2 : 1),
            BorderBrush = active ? NativeTheme.PinkBrush : NativeTheme.BorderSoftBrush,
            Background = Brushes.White,
            Padding = new Thickness(12, 10, 12, 10),
            Margin = new Thickness(0, 0, 10, 0),
            Opacity = soon ? 0.6 : 1,
        };
    }

    /// <summary>外观占位行（旧版 appearance-placeholder：禁用 + SOON 徽标）。</summary>
    private static Border MakeSoonPlaceholderRow(string label)
    {
        var content = new StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center };
        content.Children.Add(new TextBlock
        {
            Text = label,
            FontSize = 14,
            Foreground = NativeTheme.TextMutedBrush,
            VerticalAlignment = VerticalAlignment.Center,
        });
        content.Children.Add(MakeSoonBadge());
        return new Border
        {
            Child = content,
            CornerRadius = new CornerRadius(12),
            BorderBrush = NativeTheme.BorderSoftBrush,
            BorderThickness = new Thickness(1),
            Background = NativeTheme.CardSoftBgBrush,
            Padding = new Thickness(14, 10, 14, 10),
            Margin = new Thickness(0, 6, 0, 6),
            Opacity = 0.7,
        };
    }

    /// <summary>SOON 徽标（外观布局/聊天背景占位；同旧版 .soon-badge）。</summary>
    private static Border MakeSoonBadge() => new()
    {
        CornerRadius = new CornerRadius(9),
        Background = NativeTheme.Pink50Brush,
        BorderBrush = NativeTheme.Pink200Brush,
        BorderThickness = new Thickness(1),
        Padding = new Thickness(6, 1, 6, 1),
        Margin = new Thickness(8, 0, 0, 0),
        VerticalAlignment = VerticalAlignment.Center,
        Child = new TextBlock { Text = "SOON", FontSize = 10.5, Foreground = NativeTheme.Pink600Brush },
    };

    /// <summary>桌面图标三选一（贴纸/绮梦/晴光）：显示预设图片，选中带粉色描边。</summary>
    private FrameworkElement MakeUiIconRow(string current)
    {
        var selected = current == "cyrene-sticker" || current == "cyrene-pink" || current == "cyrene-sun"
            ? current
            : "cyrene-sticker";
        var row = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 6, 0, 6) };
        Border? stickerTile = null;
        Border? pinkTile = null;
        Border? sunTile = null;
        void Refresh()
        {
            if (stickerTile is not null)
            {
                stickerTile.BorderBrush = selected == "cyrene-sticker" ? NativeTheme.PinkBrush : NativeTheme.BorderSoftBrush;
                stickerTile.BorderThickness = new Thickness(selected == "cyrene-sticker" ? 2 : 1);
            }
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
                FontSize = 14,
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
        stickerTile = MakeTile("cyrene-sticker", "贴纸");
        pinkTile = MakeTile("cyrene-pink", "绮梦");
        sunTile = MakeTile("cyrene-sun", "晴光");
        Refresh();
        row.Children.Add(stickerTile);
        row.Children.Add(pinkTile);
        row.Children.Add(sunTile);
        return MakeRow("桌面图标", row);
    }

    /** 图片加载：统一走 NativeTheme（assets 目录，缺失返回 null）。 */
    private static ImageSource? TryLoadAssetImage(string relativePath) => NativeTheme.TryLoadAssetImage(relativePath);

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
            FontSize = 14,
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(0, 0, 10, 0),
        };
        row.Children.Add(label);
        var importBtn = MakeActionButton("导入字体", () => RequestRouter.SendCommand("settings", "ui-font-import"), minWidth: 88);
        var resetBtn = MakeActionButton("恢复默认", () => RequestRouter.SendCommand("settings", "ui-font-reset"), minWidth: 84);
        // 旧版：仅自定义字体（kind=custom）显示「恢复默认」
        resetBtn.Visibility = GetString(font, "kind", "source-han") == "custom"
            ? Visibility.Visible
            : Visibility.Collapsed;
        row.Children.Add(importBtn);
        row.Children.Add(resetBtn);
        return MakeRow("界面字体", row);
    }

    private FrameworkElement BuildAboutSection()
    {
        var panel = new StackPanel();
        panel.Children.Add(MakeHeader("关于"));
        panel.Children.Add(BlockMark());
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
        CardifySubBlocks(panel);
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
              : section == "channels" ? "打开连接手机（独立窗口）"
              : section == "ocr" ? "打开 OCR 设置（旧版窗口）" : "在旧版设置中打开",
            Width = 220,
            Margin = new Thickness(0, 14, 0, 0),
            FontSize = 14,
            Cursor = System.Windows.Input.Cursors.Hand,
            HorizontalAlignment = HorizontalAlignment.Left,
            Style = NativeTheme.GhostPillStyle,
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
        if (_navVersion is not null) _navVersion.Text = VersionText();
        StopDebounceTimers();
        // 窗口圆角跟随设置（快照键 windowCornerRadius；旧实现 native 硬编码 12）
        var radius = GetInt("windowCornerRadius", -1);
        if (radius >= 0) ApplyWindowRadius(radius);
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
            GetBool("disableGpuElectron"), GetString("language", "zh-CN"),
            GetString("gitCommitAuthorName"), GetString("gitCommitAuthorEmail")),
        "appearance" => string.Join("|",
            GetBool("petVisible", true), GetBool("petAlwaysOnTop", true), GetDouble("petZoom", 1),
            GetInt("windowCornerRadius", -1), GetString("uiIcon"), NodeRawJson("uiFont"),
            GetDouble("chatLineHeight", 1.75), GetBool("assistantBubbleEnabled"),
            GetDouble("chatParaSpacing", 0.5)),
        "user" => NodeRawJson("user"),
        "preferences" => NodeRawJson("preferences"),
        "api" => NodeRawJson("api"),
        "api-advanced" => NodeRawJson("runtime"),
        "cyrene" => NodeRawJson("cyrene"),
        "disclaimer" => "",
        "memory" => NodeRawJson("memory"),
        "tasks" => NodeRawJson("tasks"),
        "tokens" => NodeRawJson("tokens"),
        "plugins" => NodeRawJson("plugins"),
        "tts" => NodeRawJson("tts"),
        "asr" => NodeRawJson("asr"),
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
        FontSize = 20,
        FontWeight = FontWeights.SemiBold,
        Foreground = NativeTheme.TextStrongBrush,
        Margin = new Thickness(0, 0, 0, 8),
    };

    private static TextBlock MakeHint(string text) => new()
    {
        Text = text,
        FontSize = 14,
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
            FontSize = 12.5,
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

    /// <summary>时间范围小胶囊（.token-range__btn：12/600、padding 5/16、全圆角）。</summary>
    private static Button MakeRangeButton(string text, bool active, Action onClick)
    {
        var button = new Button
        {
            Content = text,
            Style = active ? NativeTheme.PillSmallStyle : NativeTheme.GhostPillSmallStyle,
            Margin = new Thickness(0, 0, 6, 0),
        };
        button.Click += (_, _) => onClick();
        return button;
    }

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

    /// <summary>
    /// 设置页操作按钮（pearl-white 胶囊）：次要 = 幽灵白底描边（.ghost-btn），
    /// 主操作 = 粉色实心（.save-btn）。尺寸随内容，不再固定 96 最小宽。
    /// </summary>
    private static Button MakeActionButton(string text, Action onClick, bool primary = false, double minWidth = 0)
    {
        var button = new Button
        {
            Content = text,
            Style = primary ? NativeTheme.PillPrimaryStyle : NativeTheme.GhostPillStyle,
            Margin = new Thickness(0, 4, 8, 4),
            HorizontalAlignment = HorizontalAlignment.Left,
            VerticalAlignment = VerticalAlignment.Center,
        };
        if (minWidth > 0) button.MinWidth = minWidth;
        button.Click += (_, _) => onClick();
        return button;
    }

    private static TextBlock MakeCardTitle(string text) => new()
    {
        Text = text,
        FontSize = 14,
        FontWeight = FontWeights.SemiBold,
        Foreground = NativeTheme.TextStrongBrush,
        TextWrapping = TextWrapping.Wrap,
    };

    private static TextBlock MakeCardMeta(string text) => new()
    {
        Text = text,
        FontSize = 14,
        Foreground = NativeTheme.TextMutedBrush,
        TextWrapping = TextWrapping.Wrap,
        Margin = new Thickness(0, 2, 0, 2),
    };

    /// <summary>卡片容器（白底圆角边框 + 轻投影 + 内部竖直 StackPanel）。</summary>
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
            Effect = NativeTheme.CardShadow(),
        };
    }

    /// <summary>
    /// 子块分界标记（自身不渲染）：配合 CardifySubBlocks 把每个子项目包成卡片。
    /// 用法：在 section 构造里，每个子块第一行前 panel.Children.Add(BlockMark())，
    /// 最后调 CardifySubBlocks(panel)。
    /// </summary>
    private static Border BlockMark() => new()
    {
        Tag = "cyrene-block-mark",
        Height = 0,
        Visibility = Visibility.Collapsed,
    };

    /// <summary>
    /// 把 section 内容按 BlockMark 分组包进卡片（设置页统一卡片样式）：
    /// 每组（标记与下一个标记之间，不含标记）成为一个白底圆角卡片；
    /// 首个标记之前的前导元素（面板标题 / 状态行）保持裸放。
    /// </summary>
    private static void CardifySubBlocks(StackPanel panel)
    {
        var groups = new List<List<UIElement>>();
        var preamble = new List<UIElement>();
        List<UIElement>? current = null;
        foreach (var child in panel.Children.Cast<UIElement>().ToArray())
        {
            if (child is Border { Tag: "cyrene-block-mark" })
            {
                current = new List<UIElement>();
                groups.Add(current);
                continue;
            }
            (current ?? preamble).Add(child);
        }
        if (groups.Count == 0) return;
        panel.Children.Clear();
        foreach (var element in preamble) panel.Children.Add(element);
        foreach (var group in groups)
        {
            if (group.Count == 0) continue;
            var card = MakeCard(out var body);
            foreach (var element in group) body.Children.Add(element);
            panel.Children.Add(card);
        }
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
            FontSize = 14,
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

    /// <summary>偏好多行式设置行：标题 + 说明在左（撑满），控件在右。可选图标显示在标题左侧。</summary>
    private static Border MakeDescribedRow(string title, string description, FrameworkElement control, FrameworkElement? icon = null)
    {
        var grid = new Grid { Margin = new Thickness(0, 10, 0, 10) };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        if (icon is not null)
        {
            icon.VerticalAlignment = VerticalAlignment.Top;
            icon.Margin = new Thickness(0, 3, 12, 0);
            Grid.SetColumn(icon, 0);
            grid.Children.Add(icon);
        }
        var copyColumn = icon is null ? 0 : 1;
        var controlColumn = icon is null ? 1 : 2;
        var copy = new StackPanel { VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(0, 0, 16, 0) };
        copy.Children.Add(new TextBlock
        {
            Text = title,
            FontSize = 14,
            FontWeight = FontWeights.SemiBold,
            Foreground = NativeTheme.TextStrongBrush,
        });
        copy.Children.Add(new TextBlock
        {
            Text = description,
            FontSize = 14,
            Foreground = NativeTheme.TextMutedBrush,
            TextWrapping = TextWrapping.Wrap,
            Margin = new Thickness(0, 2, 0, 0),
        });
        Grid.SetColumn(copy, copyColumn);
        grid.Children.Add(copy);
        Grid.SetColumn(control, controlColumn);
        grid.Children.Add(control);
        return new Border { Child = grid, Padding = new Thickness(0, 2, 0, 2) };
    }

    /// <summary>
    /// 子模块标题（图标 + 标题 + 徽标 + 说明 + 粉色提示）——对齐 Electron .memory-card__head：
    /// 图标 18/22 顶部对齐、标题 14/600、说明 14 default（上距 3）、提示 11 粉色斜体（上距 4）。
    /// </summary>
    private static FrameworkElement MakeModuleHead(FrameworkElement icon, string title, string? badge = null,
        string? description = null, string? hint = null)
    {
        var grid = new Grid { Margin = new Thickness(0, 14, 0, 8) };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        grid.ColumnDefinitions.Add(new ColumnDefinition());
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        icon.VerticalAlignment = VerticalAlignment.Top;
        icon.Margin = new Thickness(0, 3, 12, 0);
        Grid.SetColumn(icon, 0);
        grid.Children.Add(icon);

        var copy = new StackPanel();
        copy.Children.Add(MakeText(title, 14, NativeTheme.TextStrongBrush, weight: FontWeights.SemiBold, lineHeight: 21));
        if (!string.IsNullOrEmpty(description))
        {
            copy.Children.Add(MakeText(description, 14, NativeTheme.TextDefaultBrush,
                lineHeight: 21, margin: new Thickness(0, 3, 0, 0)));
        }
        if (!string.IsNullOrEmpty(hint))
        {
            var hintText = MakeText(hint, 11, NativeTheme.Pink600Brush,
                lineHeight: 16.5, margin: new Thickness(0, 4, 0, 0));
            hintText.FontStyle = FontStyles.Italic;
            copy.Children.Add(hintText);
        }
        Grid.SetColumn(copy, 1);
        grid.Children.Add(copy);

        if (!string.IsNullOrEmpty(badge))
        {
            var badgeHost = new Border
            {
                CornerRadius = new CornerRadius(9),
                Background = NativeTheme.Pink50Brush,
                Padding = new Thickness(10, 2, 10, 2),
                VerticalAlignment = VerticalAlignment.Top,
                Child = MakeText(badge, 11, NativeTheme.Pink600Brush, lineHeight: 16.5),
            };
            Grid.SetColumn(badgeHost, 2);
            grid.Children.Add(badgeHost);
        }
        return grid;
    }

    /// <summary>
    /// 面板标题砖里的头像（32×32）：tint=true 用 OpacityMask 着色（白线稿在浅色砖上不可见，
    /// 需按渲染页换用深色线稿的等效做法）。
    /// </summary>
    private static FrameworkElement MakeHeadingAvatar(string assetRelativePath, bool tint, double size = 32)
    {
        var source = NativeTheme.TryLoadAssetImage(assetRelativePath);
        if (source is null) return new Grid { Width = size, Height = size };
        if (!tint)
        {
            return new Image { Source = source, Width = size, Height = size, Stretch = Stretch.Uniform };
        }
        return new System.Windows.Shapes.Rectangle
        {
            Width = size,
            Height = size,
            Fill = NativeTheme.TextDefaultBrush,
            OpacityMask = new ImageBrush(source) { Stretch = Stretch.Uniform },
        };
    }

    private static Border MakeDescribedToggleRow(string title, string description, bool initial, Action<bool> onChange)
    {
        var toggle = new CheckBox { IsChecked = initial, Cursor = System.Windows.Input.Cursors.Hand };
        toggle.Checked += (_, _) => onChange(true);
        toggle.Unchecked += (_, _) => onChange(false);
        return MakeDescribedRow(title, description, toggle);
    }

    /// <summary>单选按钮组（点击即写；选中态主按钮样式即时高亮）。onSelect 为 null = 只读禁用组。</summary>
    private static StackPanel MakeChoiceGroup(
        (string Value, string Text, bool Enabled)[] options,
        string current,
        Action<string>? onSelect)
    {
        var group = new StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center };
        var buttons = new Dictionary<string, Button>();
        foreach (var (value, text, enabled) in options)
        {
            var button = MakeButton(text, () =>
            {
                if (onSelect is null || !enabled) return;
                foreach (var (optionValue, _, _) in options)
                {
                    if (buttons.TryGetValue(optionValue, out var other))
                    {
                        other.Style = optionValue == value
                            ? NativeTheme.PrimaryButtonStyle
                            : NativeTheme.SecondaryButtonStyle;
                    }
                }
                onSelect(value);
            }, primary: value == current, minWidth: 76);
            // 只读组（旧版禁用占位）或渠道不可用项：禁用点击
            button.IsEnabled = onSelect is not null && enabled;
            buttons[value] = button;
            group.Children.Add(button);
        }
        return group;
    }

    /// <summary>居中文本输入（与 MakeTextRow 同提交语义：失焦 / 回车写一次）。</summary>
    private static Grid MakeTextControl(string initial, Action<string> onCommit, double width, string? placeholder)
    {
        var box = new TextBox
        {
            Text = initial,
            Width = width,
            FontSize = 14,
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
        var host = new Grid { Width = width };
        host.Children.Add(box);
        if (placeholder is not null)
        {
            var placeholderText = new TextBlock
            {
                Text = placeholder,
                FontSize = 14,
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
        }
        return host;
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
            FontSize = 14,
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
            FontSize = 14,
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
            FontSize = 14,
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
            FontSize = 14,
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

    /** 解析 yyyy-MM-dd（非法返回 null，日期框显示空） */
    private static DateTime? TryParseDateOnly(string value)
        => DateTime.TryParseExact(value, "yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture,
            System.Globalization.DateTimeStyles.None, out var date)
            ? date
            : null;

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

    /// <summary>
    /// 通用 section「便携模式 / 数据目录」子块：原生启停/目录/应用（不再跳旧版 Electron 页）。
    /// 数据来自快照 portable 节点（host getPortableStatus），应用走 cmd settings portable apply；
    /// 迁移/覆盖确认用 WPF 弹窗，结果随请求下发（宿主不再弹 Electron 框）。
    /// </summary>
    /// <summary>
    /// 缓存目录（数据/缓存分离）：模型下载 / TTS 音频 / 渠道媒体 / 插件包等
    /// 可重建产物统一落此目录，与用户数据（聊天记录/设置/记忆）分开存放。
    /// 数据来自快照 cacheDir 节点（getCacheDirStatus），应用走 cmd settings cache set。
    /// 外观与便携块一致（输入框 + 浏览 + 应用按钮 + 当前生效提示）。
    /// </summary>
    private void BuildCacheDirBlock(StackPanel panel)
    {
        var node = GetNode("cacheDir");
        if (node.ValueKind != JsonValueKind.Object)
        {
            return; // 宿主未提供快照（旧宿主）时整块隐藏，不留半成品 UI
        }

        var effectiveDir = GetString(node, "effectiveDir");
        var overrideDir = GetString(node, "override");
        var portableActive = GetBool(node, "portableActive");

        var dirBox = new TextBox
        {
            Text = overrideDir,
            Style = NativeTheme.InputSmallStyle,
            Width = 300,
        };
        var browseBtn = MakeActionButton("浏览…", () =>
        {
            var picker = new Microsoft.Win32.OpenFolderDialog
            {
                Title = "选择缓存目录",
                Multiselect = false,
            };
            if (Directory.Exists(effectiveDir)) picker.InitialDirectory = effectiveDir;
            if (picker.ShowDialog(_window) == true && picker.FolderName.Length > 0)
            {
                dirBox.Text = picker.FolderName;
            }
        });
        dirBox.Margin = new Thickness(0, 0, 8, 0);
        var dirRow = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            VerticalAlignment = VerticalAlignment.Center,
        };
        dirRow.Children.Add(dirBox);
        dirRow.Children.Add(browseBtn);
        dirRow.Margin = new Thickness(0, 0, 10, 0);

        panel.Children.Add(MakeDescribedRow("缓存目录",
            "模型下载、语音缓存、渠道媒体与插件包等可重建产物的存放位置；与聊天记录等数据分开。留空 = 默认（" +
            (portableActive ? "便携模式：程序目录旁 cache" : "系统缓存目录") + "）。修改后重启完全生效。",
            dirRow));
        panel.Children.Add(MakeHint($"当前生效：{effectiveDir}"));
        panel.Children.Add(MakeHint("缓存可随时删除（下次使用时自动重建）；更改目录不迁移旧缓存。"));
        panel.Children.Add(MakeActionButton("应用缓存目录", () =>
        {
            var input = dirBox.Text.Trim();
            RequestRouter.SendSettingsAction("cache", "set", new Dictionary<string, object?>
            {
                ["dir"] = input,
            });
        }, primary: true));
    }

    private void BuildPortableBlock(StackPanel panel)
    {
        var portable = GetNode("portable");
        if (portable.ValueKind != JsonValueKind.Object)
        {
            panel.Children.Add(MakeHint("便携模式状态不可用（宿主未提供快照）。"));
            return;
        }

        var enabled = GetBool(portable, "enabled");
        var displayDir = GetString(portable, "displayDir");
        var effectiveDir = GetString(portable, "effectiveDataDir");
        var suggestedDir = GetString(portable, "suggestedDir");
        var installRoot = GetString(portable, "installRoot");
        var systemDir = GetString(portable, "systemDataDir");

        var dirBox = new TextBox
        {
            Text = displayDir.Length > 0 ? displayDir : (enabled ? suggestedDir : ""),
            Style = NativeTheme.InputSmallStyle,
            Width = 300,
            IsEnabled = enabled,
        };
        var browseBtn = MakeActionButton("浏览…", () =>
        {
            var picker = new Microsoft.Win32.OpenFolderDialog
            {
                Title = "选择数据目录",
                Multiselect = false,
            };
            if (Directory.Exists(effectiveDir)) picker.InitialDirectory = effectiveDir;
            else if (Directory.Exists(installRoot)) picker.InitialDirectory = installRoot;
            if (picker.ShowDialog(_window) == true && picker.FolderName.Length > 0)
            {
                dirBox.Text = picker.FolderName;
            }
        });
        browseBtn.IsEnabled = enabled;
        dirBox.Margin = new Thickness(0, 0, 8, 0);
        var dirRow = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            VerticalAlignment = VerticalAlignment.Center,
            Visibility = enabled ? Visibility.Visible : Visibility.Collapsed,
        };
        dirRow.Children.Add(dirBox);
        dirRow.Children.Add(browseBtn);
        dirRow.Margin = new Thickness(0, 0, 10, 0);

        var toggle = new CheckBox
        {
            IsChecked = enabled,
            Style = NativeTheme.SwitchStyle,
            VerticalAlignment = VerticalAlignment.Center,
            Cursor = System.Windows.Input.Cursors.Hand,
        };
        toggle.Checked += (_, _) =>
        {
            dirRow.Visibility = Visibility.Visible;
            dirBox.IsEnabled = true;
            browseBtn.IsEnabled = true;
            if (dirBox.Text.Trim().Length == 0) dirBox.Text = suggestedDir;
        };
        toggle.Unchecked += (_, _) =>
        {
            dirRow.Visibility = Visibility.Collapsed;
            dirBox.IsEnabled = false;
            browseBtn.IsEnabled = false;
        };

        panel.Children.Add(MakeDescribedRow("便携模式",
            "把聊天记录、配置与插件数据保存到程序目录（或自定义文件夹），随程序一起移动；修改后应用会自动重启。",
            toggle));
        panel.Children.Add(MakeDescribedRow("数据目录",
            "支持相对路径（相对程序目录，如 data）；留空 = 程序目录下 data。",
            dirRow));
        panel.Children.Add(MakeHint($"当前生效目录：{effectiveDir}"));
        if (!enabled && systemDir.Length > 0)
        {
            panel.Children.Add(MakeHint($"未启用便携模式；系统默认目录：{systemDir}"));
        }
        panel.Children.Add(MakeActionButton("应用并重启", () =>
            ApplyPortableFromNative(toggle, dirBox, installRoot, systemDir, suggestedDir, effectiveDir),
            primary: true));
    }

    /// <summary>便携模式应用：本地校验 → WPF 迁移/覆盖确认 → cmd settings portable apply。</summary>
    private void ApplyPortableFromNative(
        CheckBox toggle,
        TextBox dirBox,
        string installRoot,
        string systemDir,
        string suggestedDir,
        string effectiveDir)
    {
        var enabled = toggle.IsChecked == true;
        string target;
        if (enabled)
        {
            var input = dirBox.Text.Trim();
            if (installRoot.Length == 0 || suggestedDir.Length == 0)
            {
                MessageBox.Show(_window, "无法读取程序目录，暂不能应用便携模式。", "便携模式",
                    MessageBoxButton.OK, MessageBoxImage.Warning);
                return;
            }
            try
            {
                target = input.Length == 0 ? suggestedDir : Path.GetFullPath(Path.Combine(installRoot, input));
            }
            catch (Exception ex)
            {
                MessageBox.Show(_window, "数据目录路径无效：" + ex.Message, "便携模式",
                    MessageBoxButton.OK, MessageBoxImage.Warning);
                return;
            }
            var rootTrimmed = installRoot.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            var targetTrimmed = target.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            if (string.Equals(targetTrimmed, rootTrimmed, StringComparison.OrdinalIgnoreCase))
            {
                MessageBox.Show(_window, "数据目录不能是程序目录本身，请用程序目录下的子目录（如 data）。",
                    "便携模式", MessageBoxButton.OK, MessageBoxImage.Warning);
                return;
            }
        }
        else
        {
            target = systemDir;
        }

        var choice = PortableConfirmDialog.Show(_window, "更改数据存储位置",
            "是否把现有数据迁移到新目录？",
            $"当前数据目录：\n{effectiveDir}\n\n新数据目录：\n{target}\n\n" +
            "迁移 = 复制聊天记录、设置与插件数据到新目录后重启；不迁移则新目录从现有内容开始（旧目录保留，可手动删除）。",
            new[] { "迁移数据并重启", "仅切换，不迁移", "取消" },
            defaultIndex: 0,
            cancelIndex: 2);
        if (choice != 0 && choice != 1) return;

        bool? overwrite = null;
        if (choice == 0)
        {
            try
            {
                if (Directory.Exists(target) && Directory.EnumerateFileSystemEntries(target).Any())
                {
                    var confirm = PortableConfirmDialog.Show(_window, "目标目录已有数据",
                        "迁移会先清空目标目录中的现有内容。",
                        $"{target}\n\n覆盖后原有内容无法恢复，是否继续？",
                        new[] { "覆盖并迁移", "取消" },
                        defaultIndex: 1,
                        cancelIndex: 1);
                    if (confirm != 0) return;
                    overwrite = true;
                }
            }
            catch (Exception ex)
            {
                MessageBox.Show(_window, "检查目标目录失败：" + ex.Message, "便携模式",
                    MessageBoxButton.OK, MessageBoxImage.Warning);
                return;
            }
        }

        RequestRouter.SendSettingsAction("portable", "apply", new Dictionary<string, object?>
        {
            ["enabled"] = enabled,
            ["dir"] = enabled ? dirBox.Text.Trim() : "",
            ["migrationChoice"] = choice == 0 ? "migrate" : "switch",
            ["overwrite"] = overwrite,
        });
    }

    // ── NativeWindow 实现 ──
    public override void ShowWindow() => Activate();

    public override void Activate()
    {
        if (!_window.IsVisible) _window.Show();
        if (_window.WindowState == WindowState.Minimized) _window.WindowState = WindowState.Normal;
        _window.Activate();
        _window.Focus();
    }

    public override void Close() => _window.Dispatcher.Invoke(() =>
    {
        _window.Close();
        // 关窗后归还内存：设置窗会把宿主私有工作集从 ~6MB 推到 ~120MB，而其中
        // 大头是 WPF 的**非托管**渲染/字体缓存（实测托管堆仅 ~5MB，GC 收不回）。
        // 等 Closed 事件（宿主把窗口移出字典）跑完后，在空闲优先级：
        //   1) 断开 section 视觉树引用（可回收部分交给 GC）；
        //   2) SetProcessWorkingSetSize(-1,-1) trim 工作集，把常驻页交还系统
        //      （下次打开按需换入，观察不到延时）。
        _window.Dispatcher.BeginInvoke(new Action(() =>
        {
            try
            {
                foreach (var host in _sectionHosts.Values) host.Children.Clear();
                _sections.Children.Clear();
                _window.Content = null;
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("[SettingsWindow] cleanup before GC failed: " + ex.Message);
            }
            GC.Collect(2, GCCollectionMode.Optimized, blocking: false);
            GC.WaitForPendingFinalizers();
            GC.Collect(2, GCCollectionMode.Optimized, blocking: false);
            try
            {
                using var process = System.Diagnostics.Process.GetCurrentProcess();
                SetProcessWorkingSetSize(process.Handle, new IntPtr(-1), new IntPtr(-1));
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("[SettingsWindow] working set trim failed: " + ex.Message);
            }
        }), DispatcherPriority.ApplicationIdle);
    });

    [System.Runtime.InteropServices.DllImport("kernel32.dll")]
    private static extern bool SetProcessWorkingSetSize(IntPtr process, IntPtr minimumWorkingSetSize, IntPtr maximumWorkingSetSize);

    public override void ApplyLayout(JsonElement layout)
    {
        if (layout.ValueKind != JsonValueKind.Object) return;
        if (layout.TryGetProperty("settings", out var s))
        {
            ApplySettings(s);
        }
    }
}

/// <summary>
/// 便携模式确认弹窗（迁移选择 / 覆盖确认共用）：标题栏 + 说明 + 可配置按钮组。
/// 同步 ShowDialog；返回值 = 按钮下标（关闭窗口按 cancelIndex）。
/// </summary>
internal sealed class PortableConfirmDialog : Window
{
    public int Result { get; private set; }

    public static int Show(
        Window owner,
        string title,
        string message,
        string detail,
        string[] buttons,
        int defaultIndex,
        int cancelIndex)
    {
        var dialog = new PortableConfirmDialog(title, message, detail, buttons, defaultIndex, cancelIndex)
        {
            Owner = owner,
        };
        dialog.ShowDialog();
        return dialog.Result;
    }

    private PortableConfirmDialog(
        string title,
        string message,
        string detail,
        string[] buttons,
        int defaultIndex,
        int cancelIndex)
    {
        Result = cancelIndex;
        Title = title;
        Icon = AppIcons.Image;
        Width = 560;
        SizeToContent = SizeToContent.Height;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;
        ResizeMode = ResizeMode.NoResize;
        ShowInTaskbar = false;
        WindowStyle = WindowStyle.None;
        AllowsTransparency = true;
        Background = Brushes.Transparent;
        NativeTheme.Apply(this);

        var root = new StackPanel { Margin = new Thickness(20, 14, 20, 16) };
        var shellGrid = new Grid();
        shellGrid.RowDefinitions.Add(new RowDefinition { Height = new GridLength(40) });
        shellGrid.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        var titleBar = NativeTheme.BuildTitleBar(this, title);
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
            Margin = new Thickness(16),
            Child = shellGrid,
        };
        var windowShell = new Grid();
        windowShell.Children.Add(NativeTheme.MakeWindowShadowLayer(12));
        windowShell.Children.Add(contentBorder);
        Content = windowShell;

        root.Children.Add(new TextBlock
        {
            Text = message,
            FontSize = 14,
            FontWeight = FontWeights.SemiBold,
            Foreground = NativeTheme.TextStrongBrush,
            TextWrapping = TextWrapping.Wrap,
        });
        root.Children.Add(new TextBlock
        {
            Text = detail,
            FontSize = 13,
            Foreground = NativeTheme.TextMutedBrush,
            TextWrapping = TextWrapping.Wrap,
            Margin = new Thickness(0, 8, 0, 0),
        });

        var actions = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            HorizontalAlignment = HorizontalAlignment.Right,
            Margin = new Thickness(0, 14, 0, 0),
        };
        for (var i = 0; i < buttons.Length; i++)
        {
            var index = i;
            var button = new Button
            {
                Content = buttons[i],
                MinWidth = 96,
                Margin = new Thickness(8, 0, 0, 0),
                Style = i == defaultIndex ? NativeTheme.PrimaryButtonStyle : NativeTheme.SecondaryButtonStyle,
            };
            button.Click += (_, _) =>
            {
                Result = index;
                Close();
            };
            actions.Children.Add(button);
        }
        root.Children.Add(actions);
    }
}
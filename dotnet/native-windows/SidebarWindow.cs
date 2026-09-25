using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
namespace CyreneNative;

/// <summary>
/// 昔涟·状态 sidebar（WPF 透明窗，粉紫玻璃质感复刻 sidebar.css）。
/// 数据由宿主推送（state.runtime / state.model），用户动作回发
/// cmd 事件（openChat / openSettings / openCall / togglePin / modelSwitch）。
/// 布局：与 pet 窗联动（layout.sidebar 位置），320×760。
/// </summary>
public sealed class SidebarWindow : NativeWindow
{
    private readonly Window _window;
    private readonly TextBlock _statusLabel = new() { FontSize = 14, FontWeight = FontWeights.Medium };
    private readonly TextBlock _feelingLabel = new() { FontSize = 14, FontWeight = FontWeights.Medium };
    private readonly System.Windows.Controls.Image _statusIcon = new() { Width = 48, Height = 48 };
    private readonly System.Windows.Controls.Image _feelingIcon = new() { Width = 48, Height = 48 };
    private readonly TextBlock _modelLabel = new() { FontSize = 12, Opacity = 0.9, TextTrimming = TextTrimming.CharacterEllipsis };
    private readonly TextBlock _onlineLabel = new() { FontSize = 11, Opacity = 0.65 };
    private readonly Border _root;

    private bool _pinned;

    /// <summary>窗口投影的透明边距（窗口比内容壳大 2*margin；位置补偿见 ApplyLayout）。</summary>
    private const int WindowShadowMargin = 16;

    public override string Kind => "sidebar";
    public override bool IsClosed => _window == null;

    public SidebarWindow(JsonElement layout)
    {
        _root = new Border
        {
            CornerRadius = new CornerRadius(24),
            BorderBrush = NativeTheme.BorderSoftBrush, // pearl-white 壳边框 #E5E5EA
            BorderThickness = new Thickness(1),
            // 浅色壳（对齐 theme.css pearl-white）：白底 + 左上淡粉环境渐变。
            // 旧版是深色玻璃渐变；pearl-white 成为默认主题后，深色壳与白底
            // 聊天/设置窗割裂，这里跟随主题统一（外壳可命中，不用分离 Visual）。
            Background = MakePearlBrush(),
            Padding = new Thickness(0),
        };
        var grid = new Grid();
        grid.RowDefinitions.Add(new RowDefinition { Height = new GridLength(52) }); // titlebar
        grid.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        grid.RowDefinitions.Add(new RowDefinition { Height = new GridLength(68) }); // 底部按钮排
        _root.Child = grid;

        // ── titlebar（拖拽区 + 置顶/最小化/关闭） ──
        var titlebar = new Grid { Background = NativeTheme.SurfaceNavBrush };
        titlebar.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        titlebar.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        titlebar.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        titlebar.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        var title = new TextBlock
        {
            Text = "昔涟 · 状态",
            FontSize = 12,
            FontWeight = FontWeights.Medium,
            Foreground = NativeTheme.TextStrongBrush,
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(14, 0, 0, 0),
        };
        Grid.SetColumn(title, 0);
        titlebar.Children.Add(title);

        var btnStyle = MakeTitleButtonStyle();
        // 置顶：本地切换 Topmost（对齐 Electron 状态栏 SIDEBAR_TOGGLE_ALWAYS_ON_TOP
        // 的语义），并同步按钮高亮/提示。旧实现发 togglePin 给宿主，宿主只重新
        // 显示窗口；_pinned 从未赋值 → 置顶永远无效。
        System.Windows.Controls.Button pinBtn = null!;
        void TogglePin()
        {
            _pinned = !_pinned;
            _window.Topmost = _pinned;
            pinBtn.Foreground = new SolidColorBrush(_pinned ? NativeTheme.Pink : NativeTheme.TextMuted);
            pinBtn.ToolTip = _pinned ? "取消置顶" : "置顶";
        }
        pinBtn = MakeTitleButton("置顶", "✔", btnStyle, TogglePin);
        var minBtn = MakeTitleButton("最小化", "—", btnStyle, () => _window.WindowState = WindowState.Minimized);
        var closeBtn = MakeTitleButton("关闭", "✕", btnStyle, () => _window.Close());
        Grid.SetColumn(pinBtn, 1); Grid.SetColumn(minBtn, 2); Grid.SetColumn(closeBtn, 3);
        titlebar.Children.Add(pinBtn);
        titlebar.Children.Add(minBtn);
        titlebar.Children.Add(closeBtn);
        // 标题栏底边线（pearl-white titlebar 与内容的分隔）
        var titleLine = new Border
        {
            Height = 1,
            Background = NativeTheme.BorderSoftBrush,
            VerticalAlignment = VerticalAlignment.Bottom,
        };
        Grid.SetColumnSpan(titleLine, 4);
        titlebar.Children.Add(titleLine);

        // 拖拽移动（对齐 -webkit-app-region: drag；按钮区域 no-drag 由事件冒泡天然区分）
        titlebar.MouseLeftButtonDown += (_, e) =>
        {
            if (e.ButtonState == MouseButtonState.Pressed) _window.DragMove();
        };

        Grid.SetRow(titlebar, 0);
        grid.Children.Add(titlebar);

        // ── 主体：状态/心情/模型（白卡 + 轻投影，对齐 pearl-white 卡片语言） ──
        var body = new StackPanel { Margin = new Thickness(14, 14, 14, 8) };
        body.Children.Add(MakeCard(MakeStatusRow()));
        body.Children.Add(MakeCard(MakeFeelingRow()));
        body.Children.Add(MakeCard(MakeModelBlock()));
        Grid.SetRow(body, 1);
        grid.Children.Add(body);

        // ── 底部：打开聊天 / 语音通话 / 设置（等宽铺满，旧版按钮为整行大按钮） ──
        var footer = new UniformGrid
        {
            Columns = 3,
            Margin = new Thickness(12, 0, 12, 0),
            VerticalAlignment = VerticalAlignment.Center,
        };
        var chatBtn = MakePillButton("打开聊天", large: true);
        chatBtn.Click += (_, _) => RequestRouter.SendCommand(Kind, "openChat");
        var callBtn = MakePillButton("语音通话", large: true);
        callBtn.Click += (_, _) => RequestRouter.SendCommand(Kind, "openCall");
        var settingsBtn = MakePillButton("设置", large: true);
        settingsBtn.Click += (_, _) => RequestRouter.SendCommand(Kind, "openSettings");
        foreach (var (btn, isLast) in new[] { (chatBtn, false), (callBtn, false), (settingsBtn, true) })
        {
            btn.Margin = new Thickness(0, 0, isLast ? 0 : 8, 0);
            footer.Children.Add(btn);
        }
        Grid.SetRow(footer, 2);
        grid.Children.Add(footer);

        // 窗口投影：内容壳四周留 16px 透明边（窗口整体 +32，位置在 ApplyLayout 补偿）
        _root.Margin = new Thickness(WindowShadowMargin);
        var windowShell = new Grid();
        windowShell.Children.Add(NativeTheme.MakeWindowShadowLayer(24));
        windowShell.Children.Add(_root);

        _window = new Window
        {
            Width = 352,
            Height = 792,
            MinWidth = 56,
            MinHeight = 540,
            WindowStyle = WindowStyle.None,
            AllowsTransparency = true,
            Background = Brushes.Transparent,
            ResizeMode = ResizeMode.CanResize,
            ShowInTaskbar = false,
            ShowActivated = false,
            Content = windowShell,
            Topmost = _pinned,
        };
        _window.Closed += (_, _) => RaiseClosed();
        // pearl-white 浅色壳：窗口级深色默认前景（未显式设色的文本才看得清）
        _window.Foreground = NativeTheme.TextDefaultBrush;

        if (layout.ValueKind == JsonValueKind.Object) ApplyLayout(layout);
    }

    public void ApplyRuntimeState(JsonElement state)
    {
        var status = state.TryGetProperty("status", out var s) ? s.GetString() : null;
        var feeling = state.TryGetProperty("feeling", out var f) ? f.GetString() : null;
        var runtimeSync = state.TryGetProperty("runtimeSync", out var rs) ? rs.GetString() : "llm";

        if (runtimeSync == "off")
        {
            _statusLabel.Text = "运行状态同步未启用";
            _feelingLabel.Text = "请到设置里开启";
            _statusIcon.Source = null;
            _feelingIcon.Source = null;
            return;
        }
        _statusLabel.Text = status ?? "陪伴中";
        _feelingLabel.Text = feeling ?? "平静";
        _statusIcon.Source = LoadStatusIcon(status ?? "陪伴中", "status");
        _feelingIcon.Source = LoadStatusIcon(feeling ?? "平静", "feeling");
    }

    public void ApplyModelConfig(JsonElement config)
    {
        var displayName = config.TryGetProperty("displayName", out var d) ? d.GetString() : null;
        var shortName = config.TryGetProperty("shortName", out var s) ? s.GetString() : null;
        var connected = config.TryGetProperty("connected", out var c) && c.GetBoolean();
        _modelLabel.Text = displayName ?? shortName ?? "未配置";
        _onlineLabel.Text = connected ? "在线" : "离线";
        _onlineLabel.Foreground = new SolidColorBrush(connected
            ? (Color)ColorConverter.ConvertFromString("#15803D")
            : (Color)ColorConverter.ConvertFromString("#B91C1C"));
    }

    private ImageSource? LoadStatusIcon(string name, string category)
    {
        // 提醒中 → 提醒.png（对齐 STATUS_ICON 映射）
        var file = name == "提醒中" ? "提醒" : name;
        var path = Path.Combine(AppContext.BaseDirectory, "assets", category, file + ".png");
        return File.Exists(path) ? new BitmapImage(new Uri(path)) : null;
    }

    private StackPanel MakeStatusRow()
    {
        var row = new StackPanel { Orientation = Orientation.Horizontal };
        _statusIcon.VerticalAlignment = VerticalAlignment.Center;
        _statusLabel.VerticalAlignment = VerticalAlignment.Center;
        _statusLabel.Foreground = NativeTheme.TextStrongBrush;
        _statusLabel.Margin = new Thickness(10, 0, 0, 0);
        row.Children.Add(_statusIcon);
        row.Children.Add(_statusLabel);
        return row;
    }

    private StackPanel MakeFeelingRow()
    {
        var row = new StackPanel { Orientation = Orientation.Horizontal };
        _feelingIcon.VerticalAlignment = VerticalAlignment.Center;
        _feelingLabel.VerticalAlignment = VerticalAlignment.Center;
        _feelingLabel.Foreground = NativeTheme.TextStrongBrush;
        _feelingLabel.Margin = new Thickness(10, 0, 0, 0);
        row.Children.Add(_feelingIcon);
        row.Children.Add(_feelingLabel);
        return row;
    }

    /// <summary>模型块：小标题 + 模型名 + 切换按钮 + 在线状态。</summary>
    private StackPanel MakeModelBlock()
    {
        var stack = new StackPanel();
        stack.Children.Add(new TextBlock
        {
            Text = "模型",
            FontSize = 11,
            Foreground = NativeTheme.TextMutedBrush,
            Margin = new Thickness(0, 0, 0, 6),
        });
        var modelRow = new StackPanel { Orientation = Orientation.Horizontal };
        _modelLabel.VerticalAlignment = VerticalAlignment.Center;
        _modelLabel.Foreground = NativeTheme.TextDefaultBrush;
        _modelLabel.FontSize = 13;
        _modelLabel.Margin = new Thickness(0, 0, 10, 0);
        _modelLabel.MaxWidth = 170; // 给「切换」按钮留位，长模型名省略号截断
        modelRow.Children.Add(_modelLabel);
        var switchBtn = MakePillButton("切换");
        // 旧版语义（sidebar.ts）：切换模型 = 打开 API 设置页，而不是默认页
        switchBtn.Click += (_, _) => RequestRouter.SendCommand(Kind, "openSettings", "api");
        modelRow.Children.Add(switchBtn);
        stack.Children.Add(modelRow);
        _onlineLabel.Foreground = NativeTheme.TextMutedBrush;
        _onlineLabel.Margin = new Thickness(0, 6, 0, 0);
        stack.Children.Add(_onlineLabel);
        return stack;
    }

    /// <summary>白卡容器（pearl-white：白底 + 软边框 + 轻投影）。</summary>
    private static Border MakeCard(FrameworkElement content) => new()
    {
        Background = Brushes.White,
        BorderBrush = NativeTheme.BorderSoftBrush,
        BorderThickness = new Thickness(1),
        CornerRadius = new CornerRadius(12),
        Padding = new Thickness(14, 12, 14, 12),
        Margin = new Thickness(0, 0, 0, 10),
        Child = content,
        Effect = NativeTheme.CardShadow(),
    };

    private static Style MakeTitleButtonStyle()
    {
        var style = new Style(typeof(Button));
        style.Setters.Add(new Setter(Button.ForegroundProperty, NativeTheme.TextMutedBrush));
        style.Setters.Add(new Setter(Button.BackgroundProperty, Brushes.Transparent));
        style.Setters.Add(new Setter(Button.BorderThicknessProperty, new Thickness(0)));
        style.Setters.Add(new Setter(Button.FontSizeProperty, 11.0));
        style.Setters.Add(new Setter(Button.PaddingProperty, new Thickness(7, 3, 7, 3)));
        style.Setters.Add(new Setter(Button.MarginProperty, new Thickness(2, 0, 2, 0)));
        style.Setters.Add(new Setter(Button.CursorProperty, Cursors.Hand));
        // 圆角 hover 底（对齐 pearl-white 窗口按钮的 hover 语言）
        var template = new ControlTemplate(typeof(Button));
        var bd = new FrameworkElementFactory(typeof(Border), "bg");
        bd.SetValue(Border.BackgroundProperty, Brushes.Transparent);
        bd.SetValue(Border.CornerRadiusProperty, new CornerRadius(6));
        var presenter = new FrameworkElementFactory(typeof(ContentPresenter));
        presenter.SetValue(ContentPresenter.HorizontalAlignmentProperty, HorizontalAlignment.Center);
        presenter.SetValue(ContentPresenter.VerticalAlignmentProperty, VerticalAlignment.Center);
        bd.AppendChild(presenter);
        template.VisualTree = bd;
        var hover = new Trigger { Property = UIElement.IsMouseOverProperty, Value = true };
        hover.Setters.Add(new Setter(Border.BackgroundProperty, NativeTheme.BorderSoftBrush) { TargetName = "bg" });
        hover.Setters.Add(new Setter(Control.ForegroundProperty, NativeTheme.TextStrongBrush));
        template.Triggers.Add(hover);
        var pressed = new Trigger { Property = Button.IsPressedProperty, Value = true };
        pressed.Setters.Add(new Setter(Border.BackgroundProperty, NativeTheme.BorderStrongBrush) { TargetName = "bg" });
        template.Triggers.Add(pressed);
        style.Setters.Add(new Setter(Button.TemplateProperty, template));
        return style;
    }

    private static System.Windows.Controls.Button MakeTitleButton(string tip, string glyph, Style style, Action onClick)
    {
        var btn = new Button { Content = glyph, ToolTip = tip, Style = style };
        btn.Click += (_, _) => onClick();
        return btn;
    }

    private static System.Windows.Controls.Button MakePillButton(string text, bool large = false)
    {
        var normalFill = Brushes.White;
        var normalBorder = NativeTheme.BorderStrongBrush;
        var hoverFill = NativeTheme.PinkSoftBrush;
        var hoverBorder = NativeTheme.Brush(Color.FromRgb(0xFF, 0xB1, 0xCB));
        var pressedFill = NativeTheme.Brush(Color.FromRgb(0xFF, 0xD6, 0xE4));

        var style = new Style(typeof(System.Windows.Controls.Button));
        style.Setters.Add(new Setter(Button.ForegroundProperty, NativeTheme.TextDefaultBrush));
        // 底部三个主操作按钮加大：与旧版整行按钮的体量对齐
        style.Setters.Add(new Setter(Button.FontSizeProperty, large ? 14.0 : 12.0));
        style.Setters.Add(new Setter(Button.MinHeightProperty, large ? 40.0 : 28.0));
        style.Setters.Add(new Setter(Button.PaddingProperty, large ? new Thickness(12, 9, 12, 9) : new Thickness(14, 6, 14, 6)));
        style.Setters.Add(new Setter(Button.CursorProperty, Cursors.Hand));
        style.Setters.Add(new Setter(Button.HorizontalContentAlignmentProperty, HorizontalAlignment.Center));
        style.Setters.Add(new Setter(Button.VerticalContentAlignmentProperty, VerticalAlignment.Center));

        var template = new ControlTemplate(typeof(System.Windows.Controls.Button));
        var border = new FrameworkElementFactory(typeof(Border), "pill");
        border.SetValue(Border.CornerRadiusProperty, new CornerRadius(12));
        border.SetValue(Border.BackgroundProperty, normalFill);
        border.SetValue(Border.BorderBrushProperty, normalBorder);
        border.SetValue(Border.BorderThicknessProperty, new Thickness(1));
        var presenter = new FrameworkElementFactory(typeof(ContentPresenter));
        presenter.SetValue(ContentPresenter.HorizontalAlignmentProperty, HorizontalAlignment.Center);
        presenter.SetValue(ContentPresenter.VerticalAlignmentProperty, VerticalAlignment.Center);
        border.AppendChild(presenter);
        template.VisualTree = border;

        var hover = new Trigger { Property = Button.IsMouseOverProperty, Value = true };
        hover.Setters.Add(new Setter(Border.BackgroundProperty, hoverFill) { TargetName = "pill" });
        hover.Setters.Add(new Setter(Border.BorderBrushProperty, hoverBorder) { TargetName = "pill" });
        template.Triggers.Add(hover);
        var pressed = new Trigger { Property = Button.IsPressedProperty, Value = true };
        pressed.Setters.Add(new Setter(Border.BackgroundProperty, pressedFill) { TargetName = "pill" });
        template.Triggers.Add(pressed);

        style.Setters.Add(new Setter(Button.TemplateProperty, template));
        return new System.Windows.Controls.Button { Content = text, Style = style };
    }

    /// <summary>pearl-white 浅色壳：白底 + 左上淡粉环境渐变（对齐 theme.css 的淡粉渐变层）。</summary>
    private static System.Windows.Media.Brush MakePearlBrush()
    {
        return new LinearGradientBrush
        {
            StartPoint = new Point(0, 0),
            EndPoint = new Point(0.65, 1),
            GradientStops =
            {
                new GradientStop((Color)ColorConverter.ConvertFromString("#FFF3F8"), 0),
                new GradientStop(Colors.White, 0.55),
                new GradientStop(Colors.White, 1),
            },
        };
    }

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
        // ShowActivated=false 的窗在后台请求激活时常拿不到前台：短暂置顶抢占，
        // 随后归还用户 pin 状态（否则托盘「打开状态面板」看起来没反应）。
        var pinned = _pinned;
        _window.Topmost = true;
        _window.Topmost = pinned;
    }
    public override void Close() => _window.Dispatcher.Invoke(() => _window.Close());

    public override void ApplyLayout(JsonElement layout)
    {
        // layout.sidebar: {x, y, width, height}
        if (layout.ValueKind != JsonValueKind.Object) return;
        if (!layout.TryGetProperty("sidebar", out var sidebar)) return;
        // 内容壳比窗口小 2*margin：窗口坐标 = 宿主坐标 - margin，视觉位置不变
        if (sidebar.TryGetProperty("x", out var x) && x.TryGetInt32(out var xi))
            _window.Left = xi - WindowShadowMargin;
        if (sidebar.TryGetProperty("y", out var y) && y.TryGetInt32(out var yi))
            _window.Top = yi - WindowShadowMargin;
    }
}

using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
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

    public override string Kind => "sidebar";
    public override bool IsClosed => _window == null;

    public SidebarWindow(JsonElement layout)
    {
        _root = new Border
        {
            CornerRadius = new CornerRadius(24),
            BorderBrush = new SolidColorBrush(Color.FromArgb(0x5B, 0xFF, 0xBE, 0xE2)), // rgba(255,190,226,0.36)
            BorderThickness = new Thickness(1),
            Background = MakeGlassBrush(),
            Padding = new Thickness(0),
        };
        var grid = new Grid();
        grid.RowDefinitions.Add(new RowDefinition { Height = new GridLength(52) }); // titlebar
        grid.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        grid.RowDefinitions.Add(new RowDefinition { Height = new GridLength(56) }); // 底部按钮排
        _root.Child = grid;

        // ── titlebar（拖拽区 + 置顶/最小化/关闭） ──
        var titlebar = new Grid();
        titlebar.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        titlebar.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        titlebar.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        titlebar.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        var title = new TextBlock
        {
            Text = "昔涟 · 状态",
            FontSize = 12,
            Opacity = 0.75,
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
            pinBtn.Foreground = new SolidColorBrush(_pinned ? Colors.White : Color.FromArgb(0xCC, 0xFF, 0xE3, 0xF2));
            pinBtn.ToolTip = _pinned ? "取消置顶" : "置顶";
        }
        pinBtn = MakeTitleButton("置顶", "✔", btnStyle, TogglePin);
        var minBtn = MakeTitleButton("最小化", "—", btnStyle, () => _window.WindowState = WindowState.Minimized);
        var closeBtn = MakeTitleButton("关闭", "✕", btnStyle, () => _window.Close());
        Grid.SetColumn(pinBtn, 1); Grid.SetColumn(minBtn, 2); Grid.SetColumn(closeBtn, 3);
        titlebar.Children.Add(pinBtn);
        titlebar.Children.Add(minBtn);
        titlebar.Children.Add(closeBtn);

        // 拖拽移动（对齐 -webkit-app-region: drag；按钮区域 no-drag 由事件冒泡天然区分）
        titlebar.MouseLeftButtonDown += (_, e) =>
        {
            if (e.ButtonState == MouseButtonState.Pressed) _window.DragMove();
        };

        Grid.SetRow(titlebar, 0);
        grid.Children.Add(titlebar);

        // ── 主体：状态/心情/模型 ──
        var body = new StackPanel { Margin = new Thickness(16, 20, 16, 12) };
        body.Children.Add(MakeStatusRow());
        body.Children.Add(MakeDivider());
        body.Children.Add(MakeFeelingRow());
        body.Children.Add(MakeDivider());
        var modelHeader = new TextBlock { Text = "模型", FontSize = 11, Opacity = 0.6, Margin = new Thickness(2, 6, 0, 4) };
        body.Children.Add(modelHeader);
        var modelRow = new StackPanel { Orientation = Orientation.Horizontal };
        _modelLabel.VerticalAlignment = VerticalAlignment.Center;
        modelRow.Children.Add(_modelLabel);
        var switchBtn = MakePillButton("切换");
        switchBtn.Click += (_, _) => RequestRouter.SendCommand(Kind, "modelSwitch");
        modelRow.Children.Add(switchBtn);
        body.Children.Add(modelRow);
        body.Children.Add(_onlineLabel);
        Grid.SetRow(body, 1);
        grid.Children.Add(body);

        // ── 底部：打开聊天 / 语音 ──
        var footer = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            HorizontalAlignment = HorizontalAlignment.Center,
            VerticalAlignment = VerticalAlignment.Center,
        };
        var chatBtn = MakePillButton("打开聊天");
        chatBtn.Click += (_, _) => RequestRouter.SendCommand(Kind, "openChat");
        var callBtn = MakePillButton("语音通话");
        callBtn.Click += (_, _) => RequestRouter.SendCommand(Kind, "openCall");
        var settingsBtn = MakePillButton("设置");
        settingsBtn.Click += (_, _) => RequestRouter.SendCommand(Kind, "openSettings");
        footer.Children.Add(chatBtn);
        footer.Children.Add(callBtn);
        footer.Children.Add(settingsBtn);
        Grid.SetRow(footer, 2);
        grid.Children.Add(footer);

        _window = new Window
        {
            Width = 320,
            Height = 760,
            MinWidth = 56,
            MinHeight = 540,
            WindowStyle = WindowStyle.None,
            AllowsTransparency = true,
            Background = Brushes.Transparent,
            ResizeMode = ResizeMode.CanResize,
            ShowInTaskbar = false,
            ShowActivated = false,
            Content = _root,
            Topmost = _pinned,
        };
        _window.Closed += (_, _) => RaiseClosed();

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
            ? (Color)ColorConverter.ConvertFromString("#6ee7a0")
            : (Color)ColorConverter.ConvertFromString("#ff9c9c"));
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
        row.Children.Add(_statusIcon);
        row.Children.Add(_statusLabel);
        return row;
    }

    private StackPanel MakeFeelingRow()
    {
        var row = new StackPanel { Orientation = Orientation.Horizontal };
        _feelingIcon.VerticalAlignment = VerticalAlignment.Center;
        _feelingLabel.VerticalAlignment = VerticalAlignment.Center;
        row.Children.Add(_feelingIcon);
        row.Children.Add(_feelingLabel);
        return row;
    }

    private static Border MakeDivider() => new()
    {
        Height = 1,
        Background = new SolidColorBrush(Color.FromArgb(0x14, 0xFF, 0xFF, 0xFF)),
        Margin = new Thickness(0, 14, 0, 14),
    };

    private static Style MakeTitleButtonStyle()
    {
        var style = new Style(typeof(Button));
        style.Setters.Add(new Setter(Button.ForegroundProperty, new SolidColorBrush(Color.FromArgb(0xCC, 0xFF, 0xE3, 0xF2))));
        style.Setters.Add(new Setter(Button.BackgroundProperty, Brushes.Transparent));
        style.Setters.Add(new Setter(Button.BorderThicknessProperty, new Thickness(0)));
        style.Setters.Add(new Setter(Button.FontSizeProperty, 11.0));
        style.Setters.Add(new Setter(Button.PaddingProperty, new Thickness(6, 2, 6, 2)));
        style.Setters.Add(new Setter(Button.CursorProperty, Cursors.Hand));
        var trigger = new Trigger { Property = UIElement.IsMouseOverProperty, Value = true };
        trigger.Setters.Add(new Setter(Button.ForegroundProperty, Brushes.White));
        style.Triggers.Add(trigger);
        return style;
    }

    private static System.Windows.Controls.Button MakeTitleButton(string tip, string glyph, Style style, Action onClick)
    {
        var btn = new Button { Content = glyph, ToolTip = tip, Style = style };
        btn.Click += (_, _) => onClick();
        return btn;
    }

    private static System.Windows.Controls.Button MakePillButton(string text)
    {
        var btn = new Button
        {
            Content = text,
            FontSize = 12,
            Foreground = new SolidColorBrush(Color.FromArgb(0xF0, 0xFF, 0xE3, 0xF2)),
            Background = new SolidColorBrush(Color.FromArgb(0x2E, 0xC9, 0x8C, 0xFF)),
            BorderBrush = new SolidColorBrush(Color.FromArgb(0x40, 0xE4, 0x99, 0xFF)),
            BorderThickness = new Thickness(1),
            Padding = new Thickness(14, 6, 14, 6),
            Cursor = Cursors.Hand,
        };
        var template = new ControlTemplate(typeof(Button));
        var border = new FrameworkElementFactory(typeof(Border));
        border.SetValue(Border.CornerRadiusProperty, new CornerRadius(12));
        border.SetValue(Border.BackgroundProperty, new SolidColorBrush(Color.FromArgb(0x2E, 0xC9, 0x8C, 0xFF)));
        border.SetValue(Border.BorderBrushProperty, new SolidColorBrush(Color.FromArgb(0x40, 0xE4, 0x99, 0xFF)));
        border.SetValue(Border.BorderThicknessProperty, new Thickness(1));
        var presenter = new FrameworkElementFactory(typeof(ContentPresenter));
        presenter.SetValue(ContentPresenter.HorizontalAlignmentProperty, HorizontalAlignment.Center);
        presenter.SetValue(ContentPresenter.VerticalAlignmentProperty, VerticalAlignment.Center);
        border.AppendChild(presenter);
        template.VisualTree = border;
        btn.Template = template;
        return btn;
    }

    /// <summary>粉紫玻璃底：多层渐变近似 CSS radial-gradient 组合。</summary>
    private static System.Windows.Media.Brush MakeGlassBrush()
    {
        var grid = new Grid();
        // 主渐变（155deg 线性近似：左上→右下）
        var main = new LinearGradientBrush
        {
            StartPoint = new Point(0.2, 0),
            EndPoint = new Point(0.9, 1),
            GradientStops =
            {
                new GradientStop((Color)ColorConverter.ConvertFromString("#33262640"), 0),
                new GradientStop((Color)ColorConverter.ConvertFromString("#991b1b2e"), 0.6),
                new GradientStop((Color)ColorConverter.ConvertFromString("#cc2b2135"), 1),
            },
            Opacity = 0.92,
        };
        var bg = new Border { Background = main, CornerRadius = new CornerRadius(24) };
        grid.Children.Add(bg);
        // 顶部高光（radial at 18% 8% 近似）
        var highlight = new RadialGradientBrush
        {
            GradientOrigin = new Point(0.18, 0.08),
            Center = new Point(0.18, 0.08),
            RadiusX = 0.5, RadiusY = 0.5,
            GradientStops =
            {
                new GradientStop(Color.FromArgb(0x30, 0x60, 0x50, 0x70), 0),
                new GradientStop(Color.FromArgb(0x00, 0x60, 0x50, 0x70), 1),
            },
        };
        var hl = new Border { Background = highlight, CornerRadius = new CornerRadius(24) };
        grid.Children.Add(hl);

        var brush = new VisualBrush(grid) { Stretch = Stretch.UniformToFill };
        return brush;
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
        if (sidebar.TryGetProperty("x", out var x) && x.TryGetInt32(out var xi)) _window.Left = xi;
        if (sidebar.TryGetProperty("y", out var y) && y.TryGetInt32(out var yi)) _window.Top = yi;
    }
}

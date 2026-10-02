using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Effects;
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
    private readonly TextBlock _statusLabel = new() { FontSize = 16, FontWeight = FontWeights.Medium, LineHeight = 24, LineStackingStrategy = LineStackingStrategy.BlockLineHeight };
    private readonly TextBlock _feelingLabel = new() { FontSize = 16, FontWeight = FontWeights.Medium, LineHeight = 24, LineStackingStrategy = LineStackingStrategy.BlockLineHeight };
    private readonly System.Windows.Controls.Image _statusIcon = new() { Width = 46, Height = 46, Stretch = Stretch.UniformToFill };
    private readonly System.Windows.Controls.Image _feelingIcon = new() { Width = 46, Height = 46, Stretch = Stretch.UniformToFill };
    /// <summary>状态同步关闭时的占位齿轮（对齐 Electron applyRuntimeDisabled）。</summary>
    private readonly FrameworkElement _statusGear = NativeTheme.VectorGlyph(Glyphs.Gear, 22, NativeTheme.TextMutedBrush);
    private readonly FrameworkElement _feelingGear = NativeTheme.VectorGlyph(Glyphs.Gear, 22, NativeTheme.TextMutedBrush);
    /// <summary>资料区在线胶囊（对齐 .profile__online / pearl-white 覆盖）。</summary>
    private readonly TextBlock _onlineLabel = new() { FontSize = 14, LineHeight = 21, LineStackingStrategy = LineStackingStrategy.BlockLineHeight };
    private readonly Border _onlinePill = new();
    private readonly Border _onlineDot = new();
    private readonly Border _root;

    private bool _pinned;

    /// <summary>窗口投影的透明边距（窗口比内容壳大 2*margin；位置补偿见 ApplyLayout）。</summary>
    private const int WindowShadowMargin = 16;

    private readonly Border? _shadowLayer;
    private RectangleGeometry? _clipGeometry;
    private double _cornerRadius = 24;

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
        grid.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) }); // 主体（滚动）
        _root.Child = grid;

        // ── titlebar（拖拽区；对齐 Electron sidebar：左置顶 → 头像/名字/胶囊 → 最小化/关闭） ──
        var titlebar = new Grid { Background = NativeTheme.SurfaceNavBrush };
        titlebar.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });                          // 置顶
        titlebar.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });    // 标题
        titlebar.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });                          // 最小化
        titlebar.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });                          // 关闭

        // 置顶：本地切换 Topmost（对齐 Electron 状态栏 SIDEBAR_TOGGLE_ALWAYS_ON_TOP
        // 的语义），并同步按钮高亮/提示。旧实现发 togglePin 给宿主，宿主只重新
        // 显示窗口；_pinned 从未赋值 → 置顶永远无效。
        System.Windows.Controls.Button pinBtn = null!;
        void TogglePin()
        {
            _pinned = !_pinned;
            _window.Topmost = _pinned;
            pinBtn.Foreground = new SolidColorBrush(_pinned ? NativeTheme.Pink : NativeTheme.TextDefault);
            pinBtn.ToolTip = _pinned ? "取消置顶" : "置顶";
        }
        pinBtn = NativeTheme.MakeCircleButton(NativeTheme.VectorGlyph(Glyphs.Pin, 16), 28, "置顶", TogglePin);
        pinBtn.Margin = new Thickness(14, 0, 0, 0); // 对齐 titlebar padding-left 14
        Grid.SetColumn(pinBtn, 0);
        titlebar.Children.Add(pinBtn);

        var titleRow = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(8, 0, 6, 0),
        };
        var titleAvatar = MakeTitleAvatar(20);
        if (titleAvatar is not null) titleRow.Children.Add(titleAvatar);
        titleRow.Children.Add(new TextBlock
        {
            Text = "昔涟",
            FontSize = 16,
            FontWeight = FontWeights.Medium,
            LineHeight = 24,
            LineStackingStrategy = LineStackingStrategy.BlockLineHeight,
            Foreground = NativeTheme.TextStrongBrush,
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(8, 0, 0, 0),
        });
        titleRow.Children.Add(new Border
        {
            Background = NativeTheme.SurfaceAppBrush,
            BorderBrush = NativeTheme.BorderSoftBrush,
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(13), // 对齐 .sidebar__hint radius-full（h26 → 13）
            Padding = new Thickness(9, 3, 9, 3),
            Margin = new Thickness(8, 0, 0, 0),
            VerticalAlignment = VerticalAlignment.Center,
            Child = new TextBlock
            {
                Text = "状态面板",
                FontSize = 12,
                LineHeight = 18,
                LineStackingStrategy = LineStackingStrategy.BlockLineHeight,
                Foreground = NativeTheme.TextMutedBrush,
            },
        });
        Grid.SetColumn(titleRow, 1);
        titlebar.Children.Add(titleRow);

        var minBtn = NativeTheme.MakeMinimizeButton(() => _window, 28);
        minBtn.Margin = new Thickness(0, 0, 3, 0); // 与关闭按钮间距 6（对齐 actions gap）
        var closeBtn = NativeTheme.MakeCloseButton(() => _window, 28);
        closeBtn.Margin = new Thickness(3, 0, 12, 0); // 右距 12（对齐 titlebar padding-right）
        Grid.SetColumn(minBtn, 2);
        Grid.SetColumn(closeBtn, 3);
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

        // ── 主体（对齐 Electron sidebar：资料 → 状态/心情卡 → 模型按钮卡 → 设置卡） ──
        var body = new ScrollViewer
        {
            VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
            Padding = new Thickness(14, 14, 14, 16), // 对齐 .sidebar__body padding: 14px 14px 16px
        };
        var bodyPanel = new StackPanel();
        bodyPanel.Children.Add(BuildProfile());
        bodyPanel.Children.Add(MakeDivider());
        bodyPanel.Children.Add(MakeIndicatorCard("状态：", _statusIcon, _statusGear, _statusLabel));
        bodyPanel.Children.Add(MakeIndicatorCard("心情：", _feelingIcon, _feelingGear, _feelingLabel));
        bodyPanel.Children.Add(BuildModelCard());
        bodyPanel.Children.Add(BuildActionCard());
        bodyPanel.Children.Add(MakeDivider());
        body.Content = bodyPanel;
        Grid.SetRow(body, 1);
        grid.Children.Add(body);

        // 窗口投影：内容壳四周留 16px 透明边（窗口整体 +32，位置在 ApplyLayout 补偿）
        _root.Margin = new Thickness(WindowShadowMargin);
        _shadowLayer = NativeTheme.MakeWindowShadowLayer(_cornerRadius);
        var windowShell = new Grid();
        windowShell.Children.Add(_shadowLayer);
        windowShell.Children.Add(_root);
        // 圆角裁剪（壳/标题栏溢出方形角的统一处理；半径可变，几何体复用）
        _clipGeometry = new RectangleGeometry { RadiusX = _cornerRadius, RadiusY = _cornerRadius };
        grid.Clip = _clipGeometry;
        void UpdateClip() => _clipGeometry.Rect = new Rect(0, 0, grid.ActualWidth, grid.ActualHeight);
        grid.SizeChanged += (_, _) => UpdateClip();
        UpdateClip();

        _window = new Window
        {
            Width = 352,
            Height = 792,
            Icon = AppIcons.Image,
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
            // 对齐 Electron applyRuntimeDisabled：两格都显示齿轮 + 「请到设置里开启」
            _statusLabel.Text = "请到设置里开启";
            _feelingLabel.Text = "请到设置里开启";
            _statusIcon.Visibility = Visibility.Collapsed;
            _feelingIcon.Visibility = Visibility.Collapsed;
            _statusGear.Visibility = Visibility.Visible;
            _feelingGear.Visibility = Visibility.Visible;
            return;
        }
        _statusGear.Visibility = Visibility.Collapsed;
        _feelingGear.Visibility = Visibility.Collapsed;
        _statusIcon.Visibility = Visibility.Visible;
        _feelingIcon.Visibility = Visibility.Visible;
        _statusLabel.Text = status ?? "陪伴中";
        _feelingLabel.Text = feeling ?? "平静";
        _statusIcon.Source = LoadStatusIcon(status ?? "陪伴中", "status");
        _feelingIcon.Source = LoadStatusIcon(feeling ?? "平静", "feeling");
    }

    public void ApplyModelConfig(JsonElement config)
    {
        var connected = config.TryGetProperty("connected", out var c) && c.GetBoolean();
        ApplyOnlineState(connected);
    }

    private ImageSource? LoadStatusIcon(string name, string category)
    {
        // 提醒中 → 提醒.png（对齐 STATUS_ICON 映射）
        var file = name == "提醒中" ? "提醒" : name;
        var path = Path.Combine(AppContext.BaseDirectory, "assets", category, file + ".png");
        return File.Exists(path) ? new BitmapImage(new Uri(path)) : null;
    }

    /// <summary>资料区（对齐 .profile）：70px 圆头像 + 名字 + 在线胶囊。</summary>
    private FrameworkElement BuildProfile()
    {
        // 头像用 Border 背景画（CornerRadius 会裁背景；WPF 的 Border 圆角不裁子元素，
        // 放 Image 子元素会露出方角，Electron 侧是 border-radius:full 圆形）
        var avatarSource = NativeTheme.TryLoadAssetImage("icons/cyrene-avatar.png");
        var avatar = new Border
        {
            Width = 70,
            Height = 70,
            CornerRadius = new CornerRadius(35),
            BorderBrush = NativeTheme.Brush(Color.FromArgb(0x75, 0xFF, 0xB6, 0xDC)),
            BorderThickness = new Thickness(2),
            Background = avatarSource is null
                ? NativeTheme.PinkSoftBrush
                : new ImageBrush(avatarSource)
                {
                    Stretch = Stretch.UniformToFill,
                    AlignmentX = AlignmentX.Center,
                    AlignmentY = AlignmentY.Center,
                },
            HorizontalAlignment = HorizontalAlignment.Center,
            Effect = new DropShadowEffect
            {
                Color = NativeTheme.Pink,
                BlurRadius = 14,
                ShadowDepth = 0,
                Opacity = 0.18,
                RenderingBias = RenderingBias.Performance,
            },
        };

        _onlineDot.Width = 7;
        _onlineDot.Height = 7;
        _onlineDot.CornerRadius = new CornerRadius(4);
        _onlineDot.VerticalAlignment = VerticalAlignment.Center;
        _onlineLabel.VerticalAlignment = VerticalAlignment.Center;
        _onlineLabel.Margin = new Thickness(6, 0, 0, 0);
        var pillRow = new StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center };
        pillRow.Children.Add(_onlineDot);
        pillRow.Children.Add(_onlineLabel);
        _onlinePill.CornerRadius = new CornerRadius(14); // 对齐 .profile__online radius-full
        _onlinePill.BorderThickness = new Thickness(1);
        _onlinePill.Padding = new Thickness(10, 3, 10, 3);
        _onlinePill.HorizontalAlignment = HorizontalAlignment.Center;
        _onlinePill.Margin = new Thickness(0, 6, 0, 0);
        _onlinePill.Child = pillRow;
        ApplyOnlineState(false); // 未收到 model config 前按离线显示

        var stack = new StackPanel { Margin = new Thickness(0, 4, 0, 16) }; // 4 上边距 + 6 下内边 + 10 body gap
        stack.Children.Add(avatar);
        stack.Children.Add(new TextBlock
        {
            Text = "昔涟",
            FontSize = 20,
            FontWeight = FontWeights.SemiBold,
            LineHeight = 28,
            LineStackingStrategy = LineStackingStrategy.BlockLineHeight,
            Foreground = NativeTheme.TextStrongBrush,
            HorizontalAlignment = HorizontalAlignment.Center,
            Margin = new Thickness(0, 6, 0, 0),
        });
        stack.Children.Add(_onlinePill);
        return stack;
    }

    /// <summary>状态/心情卡（对齐 .panel-card + .indicator）：48px 图标砖 + 「前缀：标签」。</summary>
    private static Border MakeIndicatorCard(string prefix, Image icon, FrameworkElement fallback, TextBlock label)
    {
        var tileContent = new Grid();
        tileContent.Children.Add(fallback);
        tileContent.Children.Add(icon);
        fallback.Visibility = Visibility.Collapsed;
        var tile = new Border
        {
            Width = 48,
            Height = 48,
            CornerRadius = new CornerRadius(16),
            Background = NativeTheme.Brush(Color.FromRgb(0xFF, 0xF1, 0xF6)),
            BorderBrush = NativeTheme.Brush(Color.FromRgb(0xFF, 0xB1, 0xCB)),
            BorderThickness = new Thickness(1),
            ClipToBounds = true,
            VerticalAlignment = VerticalAlignment.Center,
            Child = tileContent,
        };

        label.Foreground = NativeTheme.TextStrongBrush;
        label.VerticalAlignment = VerticalAlignment.Center;
        var text = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(12, 0, 0, 0), // 对齐 .indicator grid 52px 列 + 8 gap（48 瓦片右侧留 12）
        };
        text.Children.Add(new TextBlock
        {
            Text = prefix,
            FontSize = 14,
            LineHeight = 21,
            LineStackingStrategy = LineStackingStrategy.BlockLineHeight,
            Foreground = NativeTheme.TextMutedBrush,
            VerticalAlignment = VerticalAlignment.Center,
        });
        text.Children.Add(label);

        var row = new Grid();
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        Grid.SetColumn(tile, 0);
        Grid.SetColumn(text, 1);
        row.Children.Add(tile);
        row.Children.Add(text);

        return new Border
        {
            Background = Brushes.White,
            BorderBrush = NativeTheme.BorderSoftBrush,
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(18),
            Padding = new Thickness(12),
            Margin = new Thickness(0, 0, 0, 10),
            Child = row,
            Effect = NativeTheme.CardShadow(),
        };
    }

    /// <summary>模型卡（对齐 .model-card）：打开聊天 / 语音通话 / 切换模型。</summary>
    private FrameworkElement BuildModelCard()
    {
        var stack = new StackPanel();
        var chatBtn = MakeModelButton("打开聊天", Glyphs.Chat, Glyphs.ChatDots, () => RequestRouter.SendCommand(Kind, "openChat"));
        var callBtn = MakeModelButton("语音通话", Glyphs.Phone, null, () => RequestRouter.SendCommand(Kind, "openCall"));
        var musicBtn = MakeModelButton("本地音乐", Glyphs.Music, null, () => RequestRouter.SendCommand(Kind, "openMusic"));
        // 旧版语义（sidebar.ts）：切换模型 = 打开 API 设置页，而不是默认页
        var switchBtn = MakeModelButton("切换模型", Glyphs.Sync, null, () => RequestRouter.SendCommand(Kind, "openSettings", "api"));
        // 对齐 .model-card gap 8 + .model-switch-btn margin-top 2 → 相邻间距 10
        foreach (var btn in new[] { chatBtn, callBtn, musicBtn, switchBtn })
        {
            btn.Margin = new Thickness(0, 2, 0, 8);
            stack.Children.Add(btn);
        }
        switchBtn.Margin = new Thickness(0, 2, 0, 0);

        return new Border
        {
            Background = Brushes.White,
            BorderBrush = NativeTheme.BorderSoftBrush,
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(18),
            Padding = new Thickness(12),
            Margin = new Thickness(0, 0, 0, 10),
            Child = stack,
            Effect = NativeTheme.CardShadow(),
        };
    }

    /// <summary>设置卡（对齐 .action-card）：粉色主按钮。</summary>
    private FrameworkElement BuildActionCard()
    {
        var row = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Center };
        row.Children.Add(NativeTheme.VectorGlyph(Glyphs.Gear, 18));
        row.Children.Add(new TextBlock
        {
            Text = "设置",
            FontSize = 14,
            FontWeight = FontWeights.Medium,
            LineHeight = 21,
            LineStackingStrategy = LineStackingStrategy.BlockLineHeight,
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(8, 0, 0, 0),
        });
        var btn = new Button
        {
            Style = NativeTheme.PrimaryButtonStyle,
            Height = 41, // 对齐 .settings-btn padding 9px 12px + 21 行高 + 边框
            HorizontalAlignment = HorizontalAlignment.Stretch,
            Content = row,
        };
        btn.Click += (_, _) => RequestRouter.SendCommand(Kind, "openSettings");
        return new Border
        {
            Background = Brushes.White,
            BorderBrush = NativeTheme.BorderSoftBrush,
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(18),
            Padding = new Thickness(10),
            Margin = new Thickness(0, 0, 0, 10),
            Child = btn,
            Effect = NativeTheme.CardShadow(),
        };
    }

    /// <summary>模型按钮（对齐 pearl-white .model-switch-btn：粉紫渐变底 + 图标 + 文本）。</summary>
    private static Button MakeModelButton(string text, string glyphData, string? fillData, Action onClick)
    {
        var row = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Center };
        row.Children.Add(NativeTheme.VectorGlyph(glyphData, 15, fillData: fillData));
        row.Children.Add(new TextBlock
        {
            Text = text,
            FontSize = 14,
            FontWeight = FontWeights.Medium,
            LineHeight = 21,
            LineStackingStrategy = LineStackingStrategy.BlockLineHeight,
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(8, 0, 0, 0),
        });

        var style = new Style(typeof(Button));
        style.Setters.Add(new Setter(FrameworkElement.HeightProperty, 41.0)); // 9px 上下内边 + 21 行高 + 2 边框
        style.Setters.Add(new Setter(Control.ForegroundProperty, NativeTheme.TextDefaultBrush));
        style.Setters.Add(new Setter(Control.CursorProperty, Cursors.Hand));
        var template = new ControlTemplate(typeof(Button));
        var border = new FrameworkElementFactory(typeof(Border), "bd");
        border.SetValue(Border.CornerRadiusProperty, new CornerRadius(8));
        border.SetValue(Border.BorderBrushProperty, NativeTheme.BorderSoftBrush);
        border.SetValue(Border.BorderThicknessProperty, new Thickness(1));
        // rgba(236,72,153,0.20) / rgba(168,85,247,0.18) 叠白后的等效渐变
        border.SetValue(Border.BackgroundProperty, new LinearGradientBrush(
            Color.FromRgb(0xFB, 0xD9, 0xEA), Color.FromRgb(0xEF, 0xE0, 0xFE),
            new Point(0, 0), new Point(1, 1)));
        border.SetValue(UIElement.RenderTransformProperty, new TranslateTransform());
        var presenter = new FrameworkElementFactory(typeof(ContentPresenter));
        presenter.SetValue(ContentPresenter.HorizontalAlignmentProperty, HorizontalAlignment.Center);
        presenter.SetValue(ContentPresenter.VerticalAlignmentProperty, VerticalAlignment.Center);
        border.AppendChild(presenter);
        template.VisualTree = border;
        var hover = new Trigger { Property = UIElement.IsMouseOverProperty, Value = true };
        hover.Setters.Add(new Setter(Border.BackgroundProperty, NativeTheme.Brush(Color.FromRgb(0xFB, 0xD9, 0xEA))) { TargetName = "bd" });
        hover.Setters.Add(new Setter(Border.BorderBrushProperty, NativeTheme.Brush(Color.FromRgb(0xFF, 0xE5, 0xF2))) { TargetName = "bd" });
        hover.Setters.Add(new Setter(Control.ForegroundProperty, NativeTheme.TextStrongBrush));
        hover.Setters.Add(new Setter(UIElement.RenderTransformProperty,
            new TranslateTransform(0, -1)) { TargetName = "bd" });
        template.Triggers.Add(hover);
        var pressed = new Trigger { Property = Button.IsPressedProperty, Value = true };
        pressed.Setters.Add(new Setter(UIElement.RenderTransformProperty, new TranslateTransform(0, 0)) { TargetName = "bd" });
        template.Triggers.Add(pressed);
        style.Setters.Add(new Setter(Control.TemplateProperty, template));

        var btn = new Button { Content = row, Style = style };
        btn.Click += (_, _) => onClick();
        return btn;
    }

    /// <summary>分隔线（对齐 .sidebar__divider：透明→浅粉→透明；上下 4px + body gap 10）。</summary>
    private static FrameworkElement MakeDivider() => new System.Windows.Shapes.Rectangle
    {
        Height = 1,
        Margin = new Thickness(2, 4, 2, 14),
        Fill = new LinearGradientBrush(
            [
                new GradientStop(Colors.Transparent, 0),
                new GradientStop(NativeTheme.BorderSoft, 0.5),
                new GradientStop(Colors.Transparent, 1),
            ],
            new Point(0, 0), new Point(1, 0)),
    };

    /// <summary>在线胶囊配色（对齐 pearl-white .profile__online / .is-offline）。</summary>
    private void ApplyOnlineState(bool connected)
    {
        _onlineLabel.Text = connected ? "在线" : "离线";
        if (connected)
        {
            _onlinePill.Background = NativeTheme.Brush(Color.FromArgb(0xB8, 0xDC, 0xFC, 0xE7));
            _onlinePill.BorderBrush = NativeTheme.Brush(Color.FromArgb(0x3D, 0x22, 0xC5, 0x5E));
            _onlineLabel.Foreground = NativeTheme.Brush(Color.FromRgb(0x15, 0x80, 0x3D));
            _onlineDot.Background = new LinearGradientBrush(
                Color.FromRgb(0x4A, 0xDE, 0x80), Color.FromRgb(0x22, 0xC5, 0x5E),
                new Point(0, 0), new Point(1, 1));
        }
        else
        {
            _onlinePill.Background = NativeTheme.SurfaceAppBrush;
            _onlinePill.BorderBrush = NativeTheme.BorderSoftBrush;
            _onlineLabel.Foreground = NativeTheme.TextMutedBrush;
            _onlineDot.Background = NativeTheme.BorderStrongBrush;
        }
    }

    /// <summary>标题栏线稿头像（Electron 用 cyrene-avatar-line.svg；这里用同源路径数据矢量绘制）。</summary>
    private static FrameworkElement MakeTitleAvatar(double size) =>
        NativeTheme.FilledGlyph(Glyphs.AvatarLine, size, NativeTheme.TextStrongBrush, viewBox: 2048);

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

    /// <summary>窗口圆角（宿主 win.radius / spawn 补发）：壳、投影层、裁剪同步。</summary>
    public override void ApplyCornerRadius(double radius)
    {
        radius = Math.Clamp(radius, 0, 40);
        if (Math.Abs(radius - _cornerRadius) < 0.5) return;
        _cornerRadius = radius;
        _root.CornerRadius = new CornerRadius(radius);
        if (_shadowLayer is not null) _shadowLayer.CornerRadius = new CornerRadius(radius);
        if (_clipGeometry is not null)
        {
            _clipGeometry.RadiusX = radius;
            _clipGeometry.RadiusY = radius;
        }
    }

    public override void ShowWindow() => Activate();

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

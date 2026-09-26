using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Shapes;
namespace CyreneNative;

/// <summary>
/// 昔涟·今日日程窗（WPF 透明无边框，pearl-white 浅色壳）。
///
/// 旧实现是 WinForms（不透明深色 + Region 圆角无 AA + 字体混排），
/// 本版与侧栏/设置窗统一：圆角壳 + 窗口投影 + 细滚动条 + 柱状图入场动画。
/// 数据与语义不变：state.tasks 推送（scheduled tasks + token usage），
/// 列表口径对齐 tasks 渲染页 task-filter.ts（启用+未来；今日优先；最多 3 条）。
/// 动作：openSettings(section=tasks) 回发宿主。
/// </summary>
public sealed class TasksWindow : NativeWindow
{
    /// <summary>窗口投影的透明边距（窗口比内容壳大 2*margin；坐标补偿见 ApplyLayout）。</summary>
    private const int WindowShadowMargin = 16;

    private const double BarPlotHeight = 96;

    private readonly Window _window;
    private readonly Border _root;
    private readonly Border? _shadowLayer;
    private readonly TextBlock _countLabel = new();
    private readonly TextBlock _dateLabel = new();
    private readonly TextBlock _tokenLabel = new();
    private readonly StackPanel _taskList = new();
    private readonly Grid _chart = new();

    private RectangleGeometry? _clipGeometry;
    private double _cornerRadius = 24;

    private readonly List<TaskRow> _tasks = new();
    /// <summary>口径内任务总数（旧版 totalCount）：今日优先，否则未来；列表只显示前 3 条。</summary>
    private int _scheduleTotal;
    private readonly List<(string Weekday, int Total, bool IsToday, bool IsFuture)> _week = new();

    private record TaskRow(string Title, string Time);

    public override string Kind => "tasks";
    public override bool IsClosed => _window == null;

    public TasksWindow(JsonElement layout)
    {
        _root = new Border
        {
            CornerRadius = new CornerRadius(_cornerRadius),
            Background = Brushes.White,
            BorderBrush = NativeTheme.BorderSoftBrush,
            BorderThickness = new Thickness(1),
        };
        var grid = new Grid();
        grid.RowDefinitions.Add(new RowDefinition { Height = new GridLength(52) });  // titlebar
        grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });     // 概览
        grid.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) }); // 列表
        grid.RowDefinitions.Add(new RowDefinition { Height = new GridLength(176) }); // 图表
        _root.Child = grid;

        var titlebar = BuildTitleBar();
        Grid.SetRow(titlebar, 0);
        grid.Children.Add(titlebar);

        var overview = BuildOverview();
        Grid.SetRow(overview, 1);
        grid.Children.Add(overview);

        var listScroll = new ScrollViewer
        {
            VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
            Padding = new Thickness(14, 4, 14, 4),
            Content = _taskList,
        };
        Grid.SetRow(listScroll, 2);
        grid.Children.Add(listScroll);

        var chartHost = new Border { Margin = new Thickness(14, 6, 14, 12), Child = _chart };
        Grid.SetRow(chartHost, 3);
        grid.Children.Add(chartHost);

        // 圆角裁剪（半径可变：宿主 win.radius 广播）
        _clipGeometry = new RectangleGeometry { RadiusX = _cornerRadius, RadiusY = _cornerRadius };
        grid.Clip = _clipGeometry;
        void UpdateClip() => _clipGeometry.Rect = new Rect(0, 0, grid.ActualWidth, grid.ActualHeight);
        grid.SizeChanged += (_, _) => UpdateClip();
        UpdateClip();

        // 投影层 + 内容壳（同圆角；阴影画在 16px 透明留白里）
        _root.Margin = new Thickness(WindowShadowMargin);
        _shadowLayer = NativeTheme.MakeWindowShadowLayer(_cornerRadius);
        var shell = new Grid();
        shell.Children.Add(_shadowLayer);
        shell.Children.Add(_root);

        _window = new Window
        {
            Title = "昔涟 · 今日日程",
            Icon = AppIcons.Image,
            Width = 320 + WindowShadowMargin * 2,
            Height = 760 + WindowShadowMargin * 2,
            MinWidth = 300 + WindowShadowMargin * 2,
            MinHeight = 540 + WindowShadowMargin * 2,
            WindowStyle = WindowStyle.None,
            AllowsTransparency = true,
            Background = Brushes.Transparent,
            ShowInTaskbar = false,
            ShowActivated = false,
            Content = shell,
        };
        NativeTheme.Apply(_window);
        _window.Closed += (_, _) => RaiseClosed();

        if (layout.ValueKind == JsonValueKind.Object) ApplyLayout(layout);
    }

    // ── 标题栏 ──

    private Border BuildTitleBar()
    {
        var grid = new Grid();
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

        var title = new TextBlock
        {
            Text = "昔涟 · 今日日程",
            FontSize = 12,
            FontWeight = FontWeights.Medium,
            Foreground = NativeTheme.TextStrongBrush,
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(14, 0, 0, 0),
        };
        Grid.SetColumn(title, 0);
        grid.Children.Add(title);

        // 设置入口：回发 cmd(kind=tasks, action=openSettings, section=tasks)
        var settingsBtn = MakeTitleButton("设置", "⚙", () => RequestRouter.SendCommand("tasks", "openSettings", "tasks"));
        settingsBtn.FontFamily = new FontFamily("Segoe UI Symbol");
        settingsBtn.FontSize = 12.5;
        var minBtn = MakeTitleButton("最小化", "—", () => _window.WindowState = WindowState.Minimized);
        var closeBtn = MakeTitleButton("关闭", "✕", () => _window.Close());
        Grid.SetColumn(settingsBtn, 1);
        Grid.SetColumn(minBtn, 2);
        Grid.SetColumn(closeBtn, 3);
        grid.Children.Add(settingsBtn);
        grid.Children.Add(minBtn);
        grid.Children.Add(closeBtn);

        // 标题栏底边线
        var line = new Border
        {
            Height = 1,
            Background = NativeTheme.BorderSoftBrush,
            VerticalAlignment = VerticalAlignment.Bottom,
        };
        Grid.SetColumnSpan(line, 4);
        grid.Children.Add(line);

        var bar = new Border { Background = NativeTheme.SurfaceNavBrush, Child = grid };
        bar.MouseLeftButtonDown += (_, e) =>
        {
            if (e.ButtonState != System.Windows.Input.MouseButtonState.Pressed) return;
            try { _window.DragMove(); } catch { /* 未按下/系统取消：忽略 */ }
        };
        return bar;
    }

    private static Button MakeTitleButton(string tip, string glyph, Action onClick)
    {
        var btn = new Button { Content = glyph, ToolTip = tip, Style = NativeTheme.WindowButtonStyle };
        btn.Click += (_, _) => onClick();
        return btn;
    }

    // ── 概览 ──

    private Border BuildOverview()
    {
        var grid = new Grid();
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });

        var left = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            VerticalAlignment = VerticalAlignment.Center,
        };
        _countLabel.Text = "0";
        _countLabel.FontSize = 22;
        _countLabel.FontWeight = FontWeights.Bold;
        _countLabel.Foreground = NativeTheme.PinkBrush;
        var unit = new TextBlock
        {
            Text = "个待办日程",
            FontSize = 12,
            Foreground = NativeTheme.TextStrongBrush,
            VerticalAlignment = VerticalAlignment.Bottom,
            Margin = new Thickness(6, 0, 0, 3),
        };
        left.Children.Add(_countLabel);
        left.Children.Add(unit);
        Grid.SetColumn(left, 0);
        grid.Children.Add(left);

        var right = new StackPanel
        {
            HorizontalAlignment = HorizontalAlignment.Right,
            VerticalAlignment = VerticalAlignment.Center,
        };
        _dateLabel.FontSize = 11.5;
        _dateLabel.Foreground = NativeTheme.TextMutedBrush;
        _dateLabel.HorizontalAlignment = HorizontalAlignment.Right;
        _tokenLabel.FontSize = 11.5;
        _tokenLabel.Foreground = NativeTheme.TextMutedBrush;
        _tokenLabel.HorizontalAlignment = HorizontalAlignment.Right;
        _tokenLabel.Margin = new Thickness(0, 3, 0, 0);
        right.Children.Add(_dateLabel);
        right.Children.Add(_tokenLabel);
        Grid.SetColumn(right, 1);
        grid.Children.Add(right);

        return new Border
        {
            Background = NativeTheme.SurfaceNavBrush,
            CornerRadius = new CornerRadius(12),
            Margin = new Thickness(14, 12, 14, 8),
            Padding = new Thickness(14, 10, 14, 10),
            Child = grid,
        };
    }

    // ── 数据（口径与旧 WinForms 版一致） ──

    public void ApplyState(JsonElement tasks, JsonElement usage)
    {
        _tasks.Clear();
        _scheduleTotal = 0;
        // 与旧版 tasks 页 task-filter.ts 同口径：
        //   启用 + nextFireAt 合法 + 未来 → 按触发时间升序；
        //   有今日任务则只取今日，否则取未来；总数 = 口径内数量，列表只显示 3 条。
        if (tasks.ValueKind == JsonValueKind.Array)
        {
            var now = DateTime.Now;
            var upcoming = new List<(DateTime FireAt, string Title, string Kind)>();
            foreach (var t in tasks.EnumerateArray())
            {
                if (t.ValueKind != JsonValueKind.Object) continue;
                // 宿主已按 RendererScheduledTask 投影；enabled = 有效授权状态
                if (!t.TryGetProperty("enabled", out var en) || en.ValueKind != JsonValueKind.True) continue;
                var next = t.TryGetProperty("nextFireAt", out var nf) ? nf.GetString() : null;
                if (string.IsNullOrEmpty(next)
                    || !DateTimeOffset.TryParse(next, System.Globalization.CultureInfo.InvariantCulture,
                        System.Globalization.DateTimeStyles.RoundtripKind, out var fireAt)) continue;
                var local = fireAt.LocalDateTime;
                if (local < now) continue;

                var title = t.TryGetProperty("title", out var ti) ? ti.GetString() : null;
                // 兼容旧快照的 name 键（宿主投影已统一为 title）
                if (string.IsNullOrEmpty(title) && t.TryGetProperty("name", out var nm)) title = nm.GetString();
                var kind = "";
                if (t.TryGetProperty("schedule", out var sc) && sc.ValueKind == JsonValueKind.Object
                    && sc.TryGetProperty("kind", out var sk)) kind = sk.GetString() ?? "";
                upcoming.Add((local, title ?? "", kind));
            }
            upcoming.Sort((a, b) => a.FireAt.CompareTo(b.FireAt));

            var today = upcoming.Where(x => x.FireAt.Date == now.Date).ToList();
            var source = today.Count > 0 ? today : upcoming;
            var mode = today.Count > 0 ? "today" : (upcoming.Count > 0 ? "upcoming" : "empty");
            _scheduleTotal = source.Count;
            foreach (var entry in source.Take(3))
            {
                // 旧版格式：今日任务显示 HH:mm；未来任务/一次性任务显示 MM-dd HH:mm
                var showDate = mode == "upcoming" || entry.Kind == "once";
                _tasks.Add(new TaskRow(entry.Title, entry.FireAt.ToString(showDate ? "MM-dd HH:mm" : "HH:mm")));
            }
            _dateLabel.Text =
                $"{now.Year}年{now.Month}月{now.Day}日 · {new[] { "周日", "周一", "周二", "周三", "周四", "周五", "周六" }[(int)now.DayOfWeek]}";
        }

        // 今日 token 汇总
        var todayText = "";
        if (usage.ValueKind == JsonValueKind.Array && usage.GetArrayLength() > 0)
        {
            var today = usage[0];
            if (today.TryGetProperty("input", out var inp) && inp.TryGetInt32(out var i)
                && today.TryGetProperty("output", out var outp) && outp.TryGetInt32(out var o))
            {
                todayText = $"今日 {FormatTokenShort(i + o)} tokens";
            }
        }
        _tokenLabel.Text = todayText;

        // 7 天柱状图数据
        _week.Clear();
        if (usage.ValueKind == JsonValueKind.Array)
        {
            var byDate = new Dictionary<string, int>();
            foreach (var d in usage.EnumerateArray())
            {
                if (d.TryGetProperty("date", out var dd) && d.TryGetProperty("input", out var di) && d.TryGetProperty("output", out var dou))
                {
                    byDate[dd.GetString() ?? ""] = di.GetInt32() + dou.GetInt32();
                }
            }
            var now = DateTime.Now;
            var weekSunday = now.AddDays(-((int)now.DayOfWeek));
            for (var i = 0; i < 7; i++)
            {
                var day = weekSunday.AddDays(i);
                var key = $"{day.Month:D2}-{day.Day:D2}";
                // 注意：weekSunday 保留了当前时分秒，必须按日期比较，
                // 否则「今天」会被判成未来（柱变虚线 + 今日用量不计入）
                var isFuture = day.Date > now.Date;
                var total = byDate.TryGetValue(key, out var v) && !isFuture ? v : 0;
                _week.Add((new[] { "周日", "周一", "周二", "周三", "周四", "周五", "周六" }[(int)day.DayOfWeek], total, key == $"{now.Month:D2}-{now.Day:D2}", isFuture));
            }
        }

        RebuildTaskList();
        RebuildChart();
    }

    private void RebuildTaskList()
    {
        _taskList.Children.Clear();
        if (_tasks.Count == 0)
        {
            _taskList.Children.Add(new TextBlock
            {
                Text = "暂无已启用定时任务",
                FontSize = 12,
                Foreground = NativeTheme.TextMutedBrush,
                Margin = new Thickness(4, 10, 4, 10),
            });
        }
        else
        {
            foreach (var t in _tasks)
            {
                var row = new Grid();
                row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
                row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
                var name = new TextBlock
                {
                    Text = t.Title,
                    FontSize = 12.5,
                    Foreground = NativeTheme.TextStrongBrush,
                    TextTrimming = TextTrimming.CharacterEllipsis,
                    VerticalAlignment = VerticalAlignment.Center,
                    Margin = new Thickness(0, 0, 10, 0),
                };
                var time = new TextBlock
                {
                    Text = t.Time,
                    FontSize = 12,
                    Foreground = NativeTheme.PinkDarkBrush,
                    VerticalAlignment = VerticalAlignment.Center,
                };
                Grid.SetColumn(name, 0);
                Grid.SetColumn(time, 1);
                row.Children.Add(name);
                row.Children.Add(time);
                _taskList.Children.Add(new Border
                {
                    Background = NativeTheme.SurfaceAppBrush,
                    CornerRadius = new CornerRadius(10),
                    Padding = new Thickness(12, 9, 12, 9),
                    Margin = new Thickness(0, 3, 0, 3),
                    Child = row,
                });
            }
        }
        // 计数 = 口径内总数（旧版 totalCount）：列表最多 3 条，计数不随之截断
        _countLabel.Text = _scheduleTotal.ToString();
    }

    // ── 7 天柱状图（WPF 自绘：渐变柱 + 入场动画 + hover 提示） ──

    private void RebuildChart()
    {
        _chart.Children.Clear();
        _chart.ColumnDefinitions.Clear();
        if (_week.Count < 7) return;

        var maxVal = Math.Max(_week.Where(w => !w.IsFuture).Select(w => w.Total).DefaultIfEmpty(0).Max(), 1);
        for (var i = 0; i < 7; i++)
        {
            var (weekday, total, isToday, isFuture) = _week[i];
            _chart.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });

            var col = new Grid();
            col.RowDefinitions.Add(new RowDefinition { Height = new GridLength(18) });  // 数值
            col.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) }); // 柱区
            col.RowDefinitions.Add(new RowDefinition { Height = new GridLength(22) });  // 星期

            var value = new TextBlock
            {
                Text = !isFuture && total > 0 ? FormatTokenShort(total) : "",
                FontSize = 10,
                Foreground = NativeTheme.TextMutedBrush,
                HorizontalAlignment = HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Bottom,
            };
            Grid.SetRow(value, 0);
            col.Children.Add(value);

            var barArea = new Grid();
            if (isFuture)
            {
                // 未来留空柱（虚线框）
                barArea.Children.Add(new Rectangle
                {
                    Width = 18,
                    Height = 48,
                    Stroke = NativeTheme.BorderStrongBrush,
                    StrokeThickness = 1,
                    StrokeDashArray = new DoubleCollection { 2, 2 },
                    RadiusX = 5,
                    RadiusY = 5,
                    HorizontalAlignment = HorizontalAlignment.Center,
                    VerticalAlignment = VerticalAlignment.Bottom,
                    ToolTip = NativeTheme.MakeTooltip($"{weekday} · 尚未到来"),
                });
            }
            else if (total > 0)
            {
                var target = Math.Max(BarPlotHeight * total / maxVal, 4);
                var bar = new Border
                {
                    Width = 18,
                    Height = 0,
                    CornerRadius = new CornerRadius(5),
                    Background = isToday ? NativeTheme.PinkBrush : NativeTheme.Brush(Color.FromRgb(0xFF, 0xB1, 0xCB)),
                    HorizontalAlignment = HorizontalAlignment.Center,
                    VerticalAlignment = VerticalAlignment.Bottom,
                    ToolTip = NativeTheme.MakeTooltip($"{weekday} · {FormatTokenShort(total)} tokens"),
                    Cursor = System.Windows.Input.Cursors.Hand,
                };
                bar.MouseEnter += (_, _) => bar.Opacity = 0.82;
                bar.MouseLeave += (_, _) => bar.Opacity = 1;
                // 入场动画：从 0 长到目标高度（按列错峰 25ms）
                bar.BeginAnimation(FrameworkElement.HeightProperty, new DoubleAnimation(target, TimeSpan.FromMilliseconds(320))
                {
                    BeginTime = TimeSpan.FromMilliseconds(i * 25),
                    EasingFunction = new QuadraticEase { EasingMode = EasingMode.EaseOut },
                });
                barArea.Children.Add(bar);
            }
            Grid.SetRow(barArea, 1);
            col.Children.Add(barArea);

            var label = new TextBlock
            {
                Text = weekday,
                FontSize = 10.5,
                Foreground = isToday ? NativeTheme.PinkDarkBrush : NativeTheme.TextMutedBrush,
                HorizontalAlignment = HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Bottom,
                Margin = new Thickness(0, 0, 0, 2),
            };
            Grid.SetRow(label, 2);
            col.Children.Add(label);

            Grid.SetColumn(col, i);
            _chart.Children.Add(col);
        }
    }

    private static string FormatTokenShort(int tokens) => tokens >= 1000 ? $"{tokens / 1000.0:F1}k" : tokens.ToString();

    // ── 生命周期 ──

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
        // ShowActivated=false 的窗在后台请求激活时常拿不到前台：短暂置顶抢占后归还
        var pinned = _window.Topmost;
        _window.Topmost = true;
        _window.Topmost = pinned;
    }

    public override void Close() => _window.Dispatcher.Invoke(() => _window.Close());

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

    public override void ApplyLayout(JsonElement layout)
    {
        if (layout.ValueKind != JsonValueKind.Object) return;
        if (!layout.TryGetProperty("tasks", out var tasks)) return;
        // 内容壳比窗口小 2*margin：窗口坐标 = 宿主坐标 - margin，视觉位置不变
        if (tasks.TryGetProperty("x", out var x) && x.TryGetInt32(out var xi))
            _window.Left = xi - WindowShadowMargin;
        if (tasks.TryGetProperty("y", out var y) && y.TryGetInt32(out var yi))
            _window.Top = yi - WindowShadowMargin;
    }
}

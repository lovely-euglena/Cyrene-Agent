using System.Globalization;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Media.Effects;
using System.Windows.Shapes;
namespace CyreneNative;

/// <summary>
/// 昔涟·今日日程窗（WPF 透明无边框，pearl-white 浅色壳）。
///
/// 版式对齐渲染页 tasks（320×760）：
///   标题栏（📋 今日日程 [展示用 · 只读] + 最小化/关闭）
///   → 面板（计数 / 日期胶囊 / Token 用量卡 / 7 天柱状图 + 日均线 / 趋势说明）
///   → 定时任务列表（时间胶囊 + 标题）
///   → 页脚（「任务设置」主按钮 + 分隔线）
///
/// 数据：state.tasks 推送（scheduled tasks + token usage）。
///   usage 兼容两种形状：日报数组 [...] 或 getUsageReport 报告对象 {"days":[...]}。
/// 动作：openSettings(section=tasks) 回发宿主。
/// </summary>
public sealed class TasksWindow : NativeWindow
{
    /// <summary>窗口投影的透明边距（窗口比内容壳大 2*margin；坐标补偿见 ApplyLayout）。</summary>
    private const int WindowShadowMargin = 16;

    /// <summary>柱区可用高度（对齐 Electron CHART_HEIGHT_PX = 76）。</summary>
    private const double BarAreaHeight = 76;
    private const double MiniChartHeight = 112;
    private const double AvgLineTop = 47;
    private const double BarsTop = 18;
    private const double LabelRowHeight = 18;

    private readonly Window _window;
    private readonly Border _root;
    private readonly Border? _shadowLayer;
    private readonly TextBlock _countLabel = new();
    private readonly TextBlock _dateLabel = new();
    private readonly TextBlock _usageNumber = new();
    private readonly TextBlock _cacheLabel = new();
    private readonly TextBlock _avgLabel = new();
    private readonly TextBlock _noteLabel = new();
    private readonly StackPanel _taskList = new();
    private readonly Grid _barsGrid = new();

    private RectangleGeometry? _clipGeometry;
    private double _cornerRadius = 24;

    private readonly List<TaskRow> _tasks = new();
    /// <summary>口径内任务总数（列表只显示前 3 条；计数不截断）。</summary>
    private int _scheduleTotal;
    private readonly List<WeekSlot> _week = new();
    private int _todayTotal;
    private string _cacheText = "";
    private int _weekAvg;
    private int _weekPeak;
    private int _weekPeakIndex = -1;
    private string _weekPeakWeekday = "";

    private record TaskRow(string Title, string Time);
    private record WeekSlot(string Weekday, int Total, bool IsFuture);

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
        grid.RowDefinitions.Add(new RowDefinition { Height = new GridLength(52) });                          // 标题栏
        grid.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });        // 内容（可滚动）
        grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });                              // 页脚
        _root.Child = grid;

        var titlebar = BuildTitleBar();
        Grid.SetRow(titlebar, 0);
        grid.Children.Add(titlebar);

        var content = new ScrollViewer
        {
            VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
            Padding = new Thickness(14, 14, 14, 0),
        };
        var panel = new StackPanel();
        panel.Children.Add(BuildCountRow());
        panel.Children.Add(BuildDatePill());
        panel.Children.Add(BuildUsageCard());
        panel.Children.Add(BuildMiniChart());
        panel.Children.Add(BuildTrendNote());
        panel.Children.Add(BuildTaskSection());
        content.Content = panel;
        Grid.SetRow(content, 1);
        grid.Children.Add(content);

        var footer = BuildFooter();
        Grid.SetRow(footer, 2);
        grid.Children.Add(footer);

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

    // ── 标题栏（📋 今日日程 [展示用 · 只读] + 最小化/关闭） ──

    private Border BuildTitleBar()
    {
        var grid = new Grid();
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

        var titleRow = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(14, 0, 6, 0),
        };
        titleRow.Children.Add(new TextBlock
        {
            Text = "📋",
            FontFamily = new FontFamily("Segoe UI Emoji"),
            FontSize = 15,
            VerticalAlignment = VerticalAlignment.Center,
        });
        titleRow.Children.Add(new TextBlock
        {
            Text = "今日日程",
            FontSize = 16,
            FontWeight = FontWeights.Medium,
            Foreground = NativeTheme.TextStrongBrush,
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(8, 0, 0, 0),
        });
        titleRow.Children.Add(new Border
        {
            Background = NativeTheme.SurfaceAppBrush,
            BorderBrush = NativeTheme.BorderSoftBrush,
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(11),
            Padding = new Thickness(9, 3, 9, 3),
            Margin = new Thickness(8, 0, 0, 0),
            VerticalAlignment = VerticalAlignment.Center,
            Child = new TextBlock { Text = "展示用 · 只读", FontSize = 12, Foreground = NativeTheme.TextMutedBrush },
        });
        Grid.SetColumn(titleRow, 0);
        grid.Children.Add(titleRow);

        var minBtn = NativeTheme.MakeMinimizeButton(() => _window, 28);
        var closeBtn = NativeTheme.MakeCloseButton(() => _window, 28);
        closeBtn.Margin = new Thickness(2, 0, 10, 0);
        Grid.SetColumn(minBtn, 1);
        Grid.SetColumn(closeBtn, 2);
        grid.Children.Add(minBtn);
        grid.Children.Add(closeBtn);

        var line = new Border
        {
            Height = 1,
            Background = NativeTheme.BorderSoftBrush,
            VerticalAlignment = VerticalAlignment.Bottom,
        };
        Grid.SetColumnSpan(line, 3);
        grid.Children.Add(line);

        var bar = new Border { Background = NativeTheme.SurfaceNavBrush, Child = grid };
        bar.MouseLeftButtonDown += (_, e) =>
        {
            if (e.ButtonState != MouseButtonState.Pressed) return;
            try { _window.DragMove(); } catch { /* 未按下/系统取消：忽略 */ }
        };
        return bar;
    }

    // ── 面板：计数 / 日期 / 用量 / 图表 / 说明 / 任务列表 ──

    private FrameworkElement BuildCountRow()
    {
        var row = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 0, 0, 6) };
        _countLabel.Text = "0";
        _countLabel.FontSize = 40;
        _countLabel.FontWeight = FontWeights.ExtraBold;
        _countLabel.Foreground = NativeTheme.TextStrongBrush;
        _countLabel.Effect = new DropShadowEffect
        {
            Color = NativeTheme.Pink,
            BlurRadius = 6,
            ShadowDepth = 0,
            Opacity = 0.35,
            RenderingBias = RenderingBias.Performance,
        };
        row.Children.Add(_countLabel);
        row.Children.Add(new TextBlock
        {
            Text = "个待办日程",
            FontSize = 15,
            FontWeight = FontWeights.Bold,
            Foreground = NativeTheme.PinkDarkBrush,
            VerticalAlignment = VerticalAlignment.Bottom,
            Margin = new Thickness(5, 0, 0, 4),
        });
        return row;
    }

    private FrameworkElement BuildDatePill()
    {
        _dateLabel.FontSize = 12;
        _dateLabel.Foreground = NativeTheme.TextDefaultBrush;
        _dateLabel.VerticalAlignment = VerticalAlignment.Center;
        _dateLabel.Margin = new Thickness(4, 0, 0, 0);
        var row = new StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center };
        row.Children.Add(NativeTheme.VectorGlyph(Glyphs.Calendar, 14, NativeTheme.TextDefaultBrush));
        row.Children.Add(_dateLabel);
        return new Border
        {
            Background = NativeTheme.SurfaceAppBrush,
            BorderBrush = NativeTheme.BorderSoftBrush,
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(11),
            Padding = new Thickness(11, 5, 11, 5),
            HorizontalAlignment = HorizontalAlignment.Left,
            Margin = new Thickness(0, 0, 0, 14),
            Child = row,
        };
    }

    private FrameworkElement BuildUsageCard()
    {
        var inner = new StackPanel { HorizontalAlignment = HorizontalAlignment.Center };

        var labelRow = new StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center };
        labelRow.Children.Add(NativeTheme.VectorGlyph(Glyphs.Card, 15, NativeTheme.TextMutedBrush));
        labelRow.Children.Add(new TextBlock
        {
            Text = "Token 用量",
            FontSize = 12,
            Foreground = NativeTheme.TextMutedBrush,
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(4, 0, 0, 0),
        });
        var labelPill = new Border
        {
            Background = NativeTheme.SurfaceAppBrush,
            BorderBrush = NativeTheme.BorderSoftBrush,
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(11),
            Padding = new Thickness(9, 3, 9, 3),
            VerticalAlignment = VerticalAlignment.Center,
            Child = labelRow,
        };

        _usageNumber.Text = "0";
        _usageNumber.FontSize = 20;
        _usageNumber.FontWeight = FontWeights.ExtraBold;
        _usageNumber.Foreground = NativeTheme.PinkDarkBrush;
        _usageNumber.VerticalAlignment = VerticalAlignment.Center;
        _usageNumber.Margin = new Thickness(6, 0, 0, 0);
        _usageNumber.Effect = new DropShadowEffect
        {
            Color = NativeTheme.Pink,
            BlurRadius = 5,
            ShadowDepth = 0,
            Opacity = 0.30,
            RenderingBias = RenderingBias.Performance,
        };

        var info = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Center };
        info.Children.Add(labelPill);
        info.Children.Add(_usageNumber);
        inner.Children.Add(info);

        _cacheLabel.FontSize = 12;
        _cacheLabel.Foreground = NativeTheme.TextMutedBrush;
        _cacheLabel.HorizontalAlignment = HorizontalAlignment.Center;
        _cacheLabel.Margin = new Thickness(0, 4, 0, 0);
        _cacheLabel.Visibility = Visibility.Collapsed;
        inner.Children.Add(_cacheLabel);

        return new Border
        {
            Background = Brushes.White,
            BorderBrush = NativeTheme.BorderSoftBrush,
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(17),
            Padding = new Thickness(12, 11, 12, 11),
            Margin = new Thickness(0, 0, 0, 16),
            Child = inner,
            Effect = NativeTheme.CardShadow(),
        };
    }

    private FrameworkElement BuildMiniChart()
    {
        var chart = new Grid { Height = MiniChartHeight };

        var avgLine = new Border
        {
            Height = 2,
            Background = NativeTheme.Brush(Color.FromRgb(0xFF, 0xB1, 0xCB)),
            CornerRadius = new CornerRadius(1),
            VerticalAlignment = VerticalAlignment.Top,
            Margin = new Thickness(0, AvgLineTop, 0, 0),
            IsHitTestVisible = false,
        };

        _avgLabel.Text = "日均 0";
        _avgLabel.FontSize = 9;
        _avgLabel.FontWeight = FontWeights.ExtraBold;
        _avgLabel.Foreground = Brushes.White;
        var avgPill = new Border
        {
            Background = new LinearGradientBrush(
                Color.FromRgb(0xFF, 0x6E, 0xC7), Color.FromRgb(0xEC, 0x48, 0x99),
                new Point(0, 0), new Point(1, 1)),
            CornerRadius = new CornerRadius(10),
            Padding = new Thickness(9, 4, 9, 4),
            HorizontalAlignment = HorizontalAlignment.Right,
            VerticalAlignment = VerticalAlignment.Top,
            Margin = new Thickness(0, AvgLineTop - 26, 0, 0),
            Child = _avgLabel,
            IsHitTestVisible = false,
        };

        _barsGrid.Margin = new Thickness(0, BarsTop, 0, 0);
        chart.Children.Add(avgLine);
        chart.Children.Add(_barsGrid);
        chart.Children.Add(avgPill);
        return chart;
    }

    private FrameworkElement BuildTrendNote()
    {
        _noteLabel.Text = "本周 Token 消耗趋势";
        _noteLabel.FontSize = 12;
        _noteLabel.Foreground = NativeTheme.TextMutedBrush;
        _noteLabel.VerticalAlignment = VerticalAlignment.Center;
        var row = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            HorizontalAlignment = HorizontalAlignment.Center,
            Margin = new Thickness(0, 6, 0, 14),
        };
        row.Children.Add(NativeTheme.VectorGlyph(Glyphs.Bars, 18, NativeTheme.TextMutedBrush));
        _noteLabel.Margin = new Thickness(4, 0, 0, 0);
        row.Children.Add(_noteLabel);
        return row;
    }

    private FrameworkElement BuildTaskSection()
    {
        var header = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 0, 0, 10) };
        header.Children.Add(NativeTheme.VectorGlyph(Glyphs.Clock, 18, NativeTheme.TextMutedBrush));
        header.Children.Add(new TextBlock
        {
            Text = "定时任务",
            FontSize = 14,
            FontWeight = FontWeights.Medium,
            Foreground = NativeTheme.TextStrongBrush,
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(4, 0, 0, 0),
        });

        var stack = new StackPanel();
        stack.Children.Add(header);
        stack.Children.Add(_taskList);
        return new Border
        {
            BorderBrush = NativeTheme.BorderSoftBrush,
            BorderThickness = new Thickness(0, 1, 0, 0),
            Padding = new Thickness(0, 13, 0, 0),
            Child = stack,
        };
    }

    private FrameworkElement BuildFooter()
    {
        var gearRow = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Center };
        gearRow.Children.Add(NativeTheme.VectorGlyph(Glyphs.Gear, 18));
        gearRow.Children.Add(new TextBlock
        {
            Text = "任务设置",
            FontSize = 14,
            FontWeight = FontWeights.Medium,
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(8, 0, 0, 0),
        });

        var settingsBtn = new Button
        {
            Style = NativeTheme.PrimaryButtonStyle,
            Height = 38,
            HorizontalAlignment = HorizontalAlignment.Stretch,
            Content = gearRow,
        };
        settingsBtn.Click += (_, _) => RequestRouter.SendCommand("tasks", "openSettings", "tasks");

        var divider = new Rectangle
        {
            Height = 1,
            Margin = new Thickness(0, 10, 0, 0),
            Fill = new LinearGradientBrush(
                [
                    new GradientStop(Colors.Transparent, 0),
                    new GradientStop(NativeTheme.BorderSoft, 0.5),
                    new GradientStop(Colors.Transparent, 1),
                ],
                new Point(0, 0), new Point(1, 0)),
        };

        var stack = new StackPanel();
        stack.Children.Add(settingsBtn);
        stack.Children.Add(divider);
        stack.Children.Add(new Border { Height = 16 }); // 对位 Electron 空版本行占位
        return new Border
        {
            BorderBrush = NativeTheme.BorderSoftBrush,
            BorderThickness = new Thickness(0, 1, 0, 0),
            Padding = new Thickness(14, 12, 14, 12),
            Child = stack,
        };
    }

    // ── 数据（口径与渲染页 task-filter.ts 一致） ──

    /// <summary>
    /// usage 兼容两种形状：日报数组 [...]（旧契约）或 getUsageReport 报告对象
    /// {"days":[...],"models":[...]}（当前宿主推送）。报告形状此前未兼容，
    /// 导致日程窗 token 区块恒为空。
    /// </summary>
    private static JsonElement NormalizeUsageDays(JsonElement usage)
    {
        if (usage.ValueKind == JsonValueKind.Object
            && usage.TryGetProperty("days", out var days)
            && days.ValueKind == JsonValueKind.Array)
        {
            return days;
        }
        return usage;
    }

    public void ApplyState(JsonElement tasks, JsonElement usage)
    {
        _tasks.Clear();
        _scheduleTotal = 0;
        _week.Clear();
        _todayTotal = 0;
        _cacheText = "";
        _weekAvg = 0;
        _weekPeak = 0;
        _weekPeakIndex = -1;
        _weekPeakWeekday = "";

        var now = DateTime.Now;
        ParseTasks(tasks, now);
        ParseUsage(NormalizeUsageDays(usage), now);

        _countLabel.Text = _scheduleTotal.ToString();
        _usageNumber.Text = FormatThousands(_todayTotal);
        _cacheLabel.Text = _cacheText;
        _cacheLabel.Visibility = string.IsNullOrEmpty(_cacheText) ? Visibility.Collapsed : Visibility.Visible;
        _noteLabel.Text = _weekPeak > 0
            ? $"本周 Token 消耗趋势 ｜ 峰值 {FormatTokenShort(_weekPeak)}（{_weekPeakWeekday}）"
            : "本周 Token 消耗趋势";

        RebuildTaskList();
        RebuildChart();
    }

    private void ParseTasks(JsonElement tasks, DateTime now)
    {
        if (tasks.ValueKind != JsonValueKind.Array) return;
        // 启用 + nextFireAt 合法 + 未来 → 按触发时间升序；
        // 有今日任务则只取今日，否则取未来；总数 = 口径内数量，列表只显示 3 条。
        var upcoming = new List<(DateTime FireAt, string Title, string Kind)>();
        foreach (var t in tasks.EnumerateArray())
        {
            if (t.ValueKind != JsonValueKind.Object) continue;
            if (!t.TryGetProperty("enabled", out var en) || en.ValueKind != JsonValueKind.True) continue;
            var next = t.TryGetProperty("nextFireAt", out var nf) ? nf.GetString() : null;
            if (string.IsNullOrEmpty(next)
                || !DateTimeOffset.TryParse(next, CultureInfo.InvariantCulture,
                    DateTimeStyles.RoundtripKind, out var fireAt)) continue;
            var local = fireAt.LocalDateTime;
            if (local < now) continue;

            var title = t.TryGetProperty("title", out var ti) ? ti.GetString() : null;
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
            // 今日任务显示 HH:mm；未来任务/一次性任务显示 MM-dd HH:mm
            var showDate = mode == "upcoming" || entry.Kind == "once";
            _tasks.Add(new TaskRow(entry.Title, entry.FireAt.ToString(showDate ? "MM-dd HH:mm" : "HH:mm")));
        }
        var weekdays = new[] { "周日", "周一", "周二", "周三", "周四", "周五", "周六" };
        _dateLabel.Text = $"{now.Year}年{now.Month}月{now.Day}日 · {weekdays[(int)now.DayOfWeek]}";
    }

    private void ParseUsage(JsonElement usageDays, DateTime now)
    {
        if (usageDays.ValueKind != JsonValueKind.Array) return;

        // 按日期键索引（day 自带 weekday/input/output/hit/miss/cacheUsageRequests）
        var byDate = new Dictionary<string, JsonElement>();
        foreach (var d in usageDays.EnumerateArray())
        {
            if (d.ValueKind != JsonValueKind.Object) continue;
            var key = d.TryGetProperty("date", out var dd) ? dd.GetString() : null;
            if (!string.IsNullOrEmpty(key)) byDate[key] = d;
        }

        // 今日用量 + 缓存命中（仅厂商返回过缓存明细时展示）
        var todayKey = $"{now.Month:D2}-{now.Day:D2}";
        if (byDate.TryGetValue(todayKey, out var today))
        {
            _todayTotal = GetInt(today, "input") + GetInt(today, "output");
            var hit = GetInt(today, "hit");
            var miss = GetInt(today, "miss");
            if (hit + miss > 0 && GetInt(today, "cacheUsageRequests") > 0)
            {
                var rate = (int)Math.Round(hit * 100.0 / (hit + miss));
                _cacheText = $"缓存命中 {rate}% · {FormatTokenShort(hit)} tokens";
            }
        }

        // 本周 7 天（周日起算；未来留空）
        var weekSunday = now.Date.AddDays(-(int)now.DayOfWeek);
        var weekdayNames = new[] { "周日", "周一", "周二", "周三", "周四", "周五", "周六" };
        var pastTotals = new List<int>();
        for (var i = 0; i < 7; i++)
        {
            var day = weekSunday.AddDays(i);
            var key = $"{day.Month:D2}-{day.Day:D2}";
            var isFuture = day > now.Date;
            var total = 0;
            if (!isFuture && byDate.TryGetValue(key, out var data))
            {
                total = GetInt(data, "input") + GetInt(data, "output");
            }
            if (!isFuture)
            {
                pastTotals.Add(total);
                if (_weekPeakIndex < 0 || total > _weekPeak)
                {
                    _weekPeak = total;
                    _weekPeakIndex = i;
                    _weekPeakWeekday = weekdayNames[(int)day.DayOfWeek];
                }
            }
            _week.Add(new WeekSlot(weekdayNames[(int)day.DayOfWeek], total, isFuture));
        }
        _weekAvg = pastTotals.Count > 0 ? (int)Math.Round(pastTotals.Sum() / (double)pastTotals.Count) : 0;
    }

    private static int GetInt(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.TryGetInt32(out var parsed) ? parsed : 0;

    private void RebuildTaskList()
    {
        _taskList.Children.Clear();
        if (_tasks.Count == 0)
        {
            _taskList.Children.Add(new TextBlock
            {
                Text = "暂无已启用定时任务",
                FontSize = 12,
                FontWeight = FontWeights.SemiBold,
                Foreground = NativeTheme.TextMutedBrush,
                HorizontalAlignment = HorizontalAlignment.Center,
                Margin = new Thickness(0, 14, 0, 14),
            });
            return;
        }
        foreach (var t in _tasks)
        {
            var row = new Grid();
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(82) });
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });

            // 时间胶囊（Electron .task-time：10px/800 pink-600 on pink-50）
            var timePill = new Border
            {
                Background = NativeTheme.Brush(Color.FromRgb(0xFF, 0xF1, 0xF6)),
                BorderBrush = NativeTheme.Brush(Color.FromRgb(0xFF, 0xB1, 0xCB)),
                BorderThickness = new Thickness(1),
                CornerRadius = new CornerRadius(10),
                Padding = new Thickness(7, 4, 7, 4),
                HorizontalAlignment = HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center,
                Child = new TextBlock
                {
                    Text = t.Time,
                    FontSize = 10,
                    FontWeight = FontWeights.ExtraBold,
                    Foreground = NativeTheme.PinkDarkBrush,
                    HorizontalAlignment = HorizontalAlignment.Center,
                },
            };
            var desc = new TextBlock
            {
                Text = t.Title,
                FontSize = 12,
                FontWeight = FontWeights.SemiBold,
                Foreground = NativeTheme.TextStrongBrush,
                TextTrimming = TextTrimming.CharacterEllipsis,
                LineHeight = 1.35 * 12,
                VerticalAlignment = VerticalAlignment.Center,
                Margin = new Thickness(9, 0, 0, 0),
            };
            Grid.SetColumn(timePill, 0);
            Grid.SetColumn(desc, 1);
            row.Children.Add(timePill);
            row.Children.Add(desc);

            _taskList.Children.Add(new Border
            {
                Background = Brushes.White,
                BorderBrush = NativeTheme.BorderSoftBrush,
                BorderThickness = new Thickness(1),
                CornerRadius = new CornerRadius(16),
                Padding = new Thickness(10, 8, 10, 8),
                Margin = new Thickness(0, 0, 0, 9),
                Child = row,
                Effect = NativeTheme.CardShadow(),
            });
        }
    }

    // ── 7 天柱状图（Electron chart.css：渐变柱 + 峰值白点 + 入场动画 + hover 提示） ──

    private void RebuildChart()
    {
        _barsGrid.Children.Clear();
        _barsGrid.ColumnDefinitions.Clear();
        if (_week.Count < 7)
        {
            _avgLabel.Text = "日均 0";
            return;
        }

        var maxVal = Math.Max(_week.Where(w => !w.IsFuture).Select(w => w.Total).DefaultIfEmpty(0).Max(), 1);
        for (var i = 0; i < 7; i++)
        {
            var slot = _week[i];
            _barsGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });

            var col = new Grid();
            col.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
            col.RowDefinitions.Add(new RowDefinition { Height = new GridLength(LabelRowHeight) });

            if (!slot.IsFuture)
            {
                if (i == _weekPeakIndex && _weekPeak > 0)
                {
                    // 峰值白点（.chart-bar--peak::after：top 12px / 8×8 / 白底粉描边）
                    col.Children.Add(new Ellipse
                    {
                        Width = 8,
                        Height = 8,
                        Fill = Brushes.White,
                        Stroke = NativeTheme.Brush(Color.FromRgb(0xFF, 0x8C, 0xCC)),
                        StrokeThickness = 1.5,
                        HorizontalAlignment = HorizontalAlignment.Center,
                        VerticalAlignment = VerticalAlignment.Top,
                        Margin = new Thickness(0, 12, 0, 0),
                        IsHitTestVisible = false,
                    });
                }
                var target = Math.Max(6, BarAreaHeight * slot.Total / maxVal);
                var bar = new Border
                {
                    Width = 24,
                    Height = 0,
                    CornerRadius = new CornerRadius(12),
                    Background = new LinearGradientBrush(
                        Color.FromRgb(0xEC, 0x48, 0x99), Color.FromRgb(0xFF, 0x8C, 0xCC),
                        new Point(0.5, 0), new Point(0.5, 1)),
                    HorizontalAlignment = HorizontalAlignment.Center,
                    VerticalAlignment = VerticalAlignment.Bottom,
                    ToolTip = NativeTheme.MakeTooltip($"{slot.Weekday} · {FormatTokenShort(slot.Total)} tokens"),
                    Cursor = Cursors.Hand,
                    // 对齐 .chart-bar__fill 的粉色柔光
                    Effect = new DropShadowEffect
                    {
                        Color = NativeTheme.Pink,
                        BlurRadius = 10,
                        ShadowDepth = 0,
                        Opacity = 0.22,
                        RenderingBias = RenderingBias.Performance,
                    },
                };
                bar.MouseEnter += (_, _) => bar.Opacity = 0.85;
                bar.MouseLeave += (_, _) => bar.Opacity = 1;
                // 入场动画：0 → 目标高度（按列错峰 25ms）
                bar.BeginAnimation(FrameworkElement.HeightProperty, new DoubleAnimation(target, TimeSpan.FromMilliseconds(320))
                {
                    BeginTime = TimeSpan.FromMilliseconds(i * 25),
                    EasingFunction = new QuadraticEase { EasingMode = EasingMode.EaseOut },
                });
                Grid.SetRow(bar, 0);
                col.Children.Add(bar);
            }

            var label = new TextBlock
            {
                Text = slot.Weekday,
                FontSize = 10,
                FontWeight = FontWeights.Bold,
                Foreground = NativeTheme.TextMutedBrush,
                HorizontalAlignment = HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Bottom,
            };
            Grid.SetRow(label, 1);
            col.Children.Add(label);

            Grid.SetColumn(col, i);
            _barsGrid.Children.Add(col);
        }
        _avgLabel.Text = $"日均 {FormatTokenShort(_weekAvg)}";
    }

    private static string FormatTokenShort(int tokens) => tokens >= 1000 ? $"{tokens / 1000.0:F1}K" : tokens.ToString();

    private static string FormatThousands(int value) => value.ToString("N0", CultureInfo.InvariantCulture);

    // ── 生命周期 ──

    public override void ShowWindow() => Activate();

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

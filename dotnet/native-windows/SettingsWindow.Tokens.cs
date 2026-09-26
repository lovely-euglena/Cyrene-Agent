using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Media.Effects;
using System.Windows.Shapes;

namespace CyreneNative;

/// <summary>
/// 设置窗「Token 用量」section（对位 Electron tokens）：
/// 7/14/30 天切换、总量指标、每日柱状图、模型用量列表、重置统计。
/// 数据：state.settings.tokens（native-settings-sections.buildTokensSectionSnapshot）
/// 动作：cmd settings tokens { set-days / clear }
/// </summary>
public sealed partial class SettingsWindow
{
    private FrameworkElement BuildTokensSection()
    {
        var panel = new StackPanel();
        panel.Children.Add(MakePanelHeading(
            NativeTheme.VectorGlyph(Glyphs.Bars, 24, NativeTheme.TextDefaultBrush),
            "Token 用量",
            "查看 API 调用统计与消耗"));
        panel.Children.Add(MakeSectionStatus("tokens"));

        var tokens = GetNode("tokens");
        var activeDays = GetInt(tokens, "days", 7);

        var rangeRow = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 6, 0, 12) };
        foreach (var days in new[] { 7, 14, 30 })
        {
            var value = days;
            rangeRow.Children.Add(MakeRangeButton($"{days}d", value == activeDays, () =>
                RequestRouter.SendSettingsAction("tokens", "set-days", new Dictionary<string, object?> { ["days"] = value })));
        }
        panel.Children.Add(rangeRow);

        // ── 总量指标（口径对齐旧版：请求 N / M、缓存命中 暂无数据/（部分）、命中率格式化） ──
        var totals = GetNode(tokens, "totals");
        var input = GetInt(totals, "input", 0);
        var output = GetInt(totals, "output", 0);
        var hit = GetInt(totals, "hit", 0);
        var miss = GetInt(totals, "miss", 0);
        var requests = GetInt(totals, "requests", 0);
        var attemptedRequests = GetInt(totals, "attemptedRequests", 0);
        var cacheUsageRequests = GetInt(totals, "cacheUsageRequests", 0);

        panel.Children.Add(MakeMetricRow(
            ("📥 输入 Token", input.ToString("N0")),
            ("📤 输出 Token", output.ToString("N0")),
            ("🔢 请求数", attemptedRequests > 0
                ? $"{requests:N0} / {attemptedRequests:N0}"
                : requests.ToString("N0"))));
        panel.Children.Add(MakeMetricRow(
            ("🎯 缓存命中", cacheUsageRequests > 0
                ? $"{hit:N0}{(cacheUsageRequests < requests ? "（部分）" : "")}"
                : "暂无数据"),
            ("缓存命中率", FormatCacheRate(hit, miss, requests, cacheUsageRequests)),
            ("合计", (input + output).ToString("N0"))));

        // ── 每日柱状图 + 趋势折线 ──
        var daily = GetNode(tokens, "daily");
        var values = new List<TokenDayView>();
        if (daily.ValueKind == JsonValueKind.Array)
        {
            foreach (var day in daily.EnumerateArray())
            {
                values.Add(new TokenDayView(
                    GetString(day, "date"),
                    GetString(day, "weekday"),
                    GetInt(day, "input", 0),
                    GetInt(day, "output", 0),
                    GetInt(day, "hit", 0),
                    GetInt(day, "miss", 0),
                    GetInt(day, "cacheCreation", 0),
                    GetInt(day, "requests", 0),
                    GetInt(day, "attemptedRequests", 0),
                    GetInt(day, "cacheUsageRequests", 0)));
            }
        }
        var hasData = values.Any((day) => day.Input > 0 || day.Output > 0 || day.Requests > 0 || day.AttemptedRequests > 0);
        if (!hasData)
        {
            // 空库也保留图表框架（用户期望始终能看到图表区），上方两行提示说明
            panel.Children.Add(MakeHint("暂无用量数据"));
            panel.Children.Add(MakeHint("和昔涟聊天后这里会显示真实的 Token 消耗统计。"));
        }
        if (values.Count > 0)
        {
            panel.Children.Add(MakeModuleHead(
                NativeTheme.VectorGlyph(Glyphs.ChartLine, 16, NativeTheme.TextDefaultBrush),
                "每日消耗柱状图"));
            // 日均（旧版 #token-avg-label）
            var average = (long)Math.Round(values.Sum((day) => (double)day.Input + day.Output) / values.Count);
            panel.Children.Add(new TextBlock
            {
                Text = $"日均 {FormatTokensShort(average)}",
                FontSize = 12,
                Foreground = NativeTheme.TextMutedBrush,
                HorizontalAlignment = HorizontalAlignment.Right,
                Margin = new Thickness(0, 0, 2, 2),
            });
            // 柱状图（对齐 Electron .mini-chart + .token-bar）：
            //   112 高容器（18 顶部 + 76 柱区 + 18 日期区）；每天一列等分整宽；
            //   柱 max-width 24 居中、radius-full、渐变；高度 76*total/max（最低 6）；
            //   >14 天隔天显示；峰值白点叠在柱顶区域（top 12）；仅显示「日」号。
            var max = 1;
            var peakIndex = -1;
            for (var i = 0; i < values.Count; i++)
            {
                var dayTotal = values[i].Input + values[i].Output;
                if (dayTotal > max)
                {
                    max = dayTotal;
                    peakIndex = i;
                }
            }

            var chart = new Grid { Height = 112, Margin = new Thickness(0, 2, 0, 6) };
            var barsGrid = new Grid { Margin = new Thickness(0, 18, 0, 0), ClipToBounds = false };
            var visibleIndex = 0;
            for (var i = 0; i < values.Count; i++)
            {
                if (values.Count > 14 && i % 2 != 0) continue;
                var date = values[i].Date;
                var dayInput = values[i].Input;
                var dayOutput = values[i].Output;
                var total = dayInput + dayOutput;
                barsGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });

                var column = new Grid();
                column.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) }); // 76 柱区
                column.RowDefinitions.Add(new RowDefinition { Height = new GridLength(18) });                  // 日期

                if (i == peakIndex)
                {
                    // .token-bar--peak::after：top 12pt / 8×8 白点 + 粉描边（叠在柱顶上层）
                    var dot = new Ellipse
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
                    };
                    Panel.SetZIndex(dot, 1);
                    Grid.SetRow(dot, 0);
                    column.Children.Add(dot);
                }

                // 目标高度（76 基准，最低 6）；圆角按柱高夹住（等价 CSS border-radius 的
                // 等比收缩）：低柱不再被固定 12 圆角画成椭圆
                var target = Math.Max(6, 76.0 * total / max);
                var bar = new Border
                {
                    MaxWidth = 24,
                    Height = 0,
                    CornerRadius = new CornerRadius(Math.Min(12, target / 2)),
                    Background = TokenBarBrush(),
                    HorizontalAlignment = HorizontalAlignment.Stretch,
                    VerticalAlignment = VerticalAlignment.Bottom,
                    ToolTip = MakeTokenTooltip(values[i]),
                    Cursor = System.Windows.Input.Cursors.Hand,
                    // 对齐 .token-bar__fill 的粉色柔光
                    Effect = new DropShadowEffect
                    {
                        Color = NativeTheme.Pink,
                        BlurRadius = 10,
                        ShadowDepth = 0,
                        Opacity = 0.22,
                        RenderingBias = RenderingBias.Performance,
                    },
                };
                // 入场动画：0 → 目标高度（按列错峰 25ms）
                bar.BeginAnimation(FrameworkElement.HeightProperty, new DoubleAnimation(
                    target, TimeSpan.FromMilliseconds(320))
                {
                    BeginTime = TimeSpan.FromMilliseconds(Math.Min(visibleIndex, 10) * 25),
                    EasingFunction = new QuadraticEase { EasingMode = EasingMode.EaseOut },
                });
                bar.MouseEnter += (_, _) => bar.Opacity = 0.82;
                bar.MouseLeave += (_, _) => bar.Opacity = 1;
                Grid.SetRow(bar, 0);
                column.Children.Add(bar);

                var label = new TextBlock
                {
                    Text = date.Contains('-') ? date.Split('-')[^1] : date, // Electron 只显示日号
                    FontSize = 10,
                    FontWeight = FontWeights.Bold,
                    Foreground = NativeTheme.TextMutedBrush,
                    HorizontalAlignment = HorizontalAlignment.Center,
                    VerticalAlignment = VerticalAlignment.Bottom,
                    Margin = new Thickness(0, 0, 0, 2),
                };
                Grid.SetRow(label, 1);
                column.Children.Add(label);

                Grid.SetColumn(column, visibleIndex);
                barsGrid.Children.Add(column);
                visibleIndex++;
            }
            chart.Children.Add(barsGrid);
            panel.Children.Add(chart);

            // 使用趋势（输入/输出双折线；配色对齐 Electron Chart.js：输入 #3B82F6 / 输出 #FF8CCC）
            if (values.Count > 1)
            {
                panel.Children.Add(MakeModuleHead(
            NativeTheme.VectorGlyph(Glyphs.Trend, 16, NativeTheme.TextDefaultBrush),
            "使用趋势"));
                panel.Children.Add(MakeTrendChart(values));
                panel.Children.Add(MakeChartLegend(("输入", TrendInputBrush), ("输出", TrendOutputBrush)));
            }
        }

        // ── 模型用量（环形图 + 列表） ──
        var models = GetNode(tokens, "models");
        if (models.ValueKind == JsonValueKind.Array && models.GetArrayLength() > 0)
        {
            panel.Children.Add(MakeSubHeader("模型用量"));
            var modelTotals = new List<(string Name, int Total)>();
            foreach (var model in models.EnumerateArray())
            {
                modelTotals.Add((
                    GetString(model, "name", "未归类"),
                    GetInt(model, "input", 0) + GetInt(model, "output", 0)));
            }
            var chartRow = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 2, 0, 6) };
            chartRow.Children.Add(MakeModelDonut(modelTotals));

            var legend = new StackPanel { Orientation = Orientation.Vertical, Margin = new Thickness(18, 4, 0, 0), VerticalAlignment = VerticalAlignment.Center };
            var totalAll = Math.Max(1, modelTotals.Sum((m) => m.Total));
            for (var i = 0; i < modelTotals.Count; i++)
            {
                var (name, total) = modelTotals[i];
                legend.Children.Add(MakeChartLegend(
                    ($"{name} · {FormatTokensShort(total)} ({(double)total * 100 / totalAll:0.0}%)", DonutBrush(i))));
            }
            chartRow.Children.Add(legend);
            panel.Children.Add(chartRow);
        }

        panel.Children.Add(MakeActionButton("重置统计", () =>
        {
            if (MessageBox.Show("确定重置本地 Token 用量统计？该操作不可撤销。", "重置统计",
                    MessageBoxButton.OKCancel, MessageBoxImage.Warning) != MessageBoxResult.OK)
            {
                return;
            }
            RequestRouter.SendSettingsAction("tokens", "clear", null);
        }));
        return panel;
    }

    /// <summary>三列指标行（label 小字 + value 大字）。</summary>
    private static Grid MakeMetricRow(params (string Label, string Value)[] metrics)
    {
        var grid = new Grid { Margin = new Thickness(0, 2, 0, 2) };
        for (var column = 0; column < metrics.Length; column++)
        {
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            var stack = new StackPanel();
            stack.Children.Add(new TextBlock
            {
                Text = metrics[column].Label,
                FontSize = 14,
                Foreground = NativeTheme.TextMutedBrush,
            });
            stack.Children.Add(new TextBlock
            {
                Text = metrics[column].Value,
                FontSize = 18,
                FontWeight = FontWeights.SemiBold,
                Foreground = NativeTheme.TextStrongBrush,
            });
            Grid.SetColumn(stack, column);
            grid.Children.Add(stack);
        }
        return grid;
    }

    private static string FormatTokensShort(long tokens)
        => tokens >= 1_000_000 ? $"{tokens / 1_000_000.0:F1}M" : tokens >= 1000 ? $"{tokens / 1000.0:F1}k" : tokens.ToString();

    // ── 图表绘制（折线 / 环形，对齐旧版 Chart.js 图表语义） ──

    /// <summary>输入/输出双折线趋势图（整宽画布，对齐 Electron Chart.js：填充带 + 悬停点）。</summary>
    private static FrameworkElement MakeTrendChart(List<TokenDayView> values)
    {
        const double chartHeight = 140;
        const double leftPad = 40;
        const double bottomPad = 20;
        // 设置窗定宽：内容区约 830；固定画布宽对齐 Electron 的整宽趋势图
        const double width = 820;
        var slotWidth = Math.Max(12, (width - leftPad - 10) / Math.Max(values.Count, 1));
        var max = 1;
        foreach (var value in values) max = Math.Max(max, Math.Max(value.Input, value.Output));

        var canvas = new Canvas { Width = width, Height = chartHeight + bottomPad, Background = Brushes.Transparent };
        // 横向网格线 + y 轴刻度（max / max/2 / 0）
        for (var i = 0; i <= 2; i++)
        {
            var y = chartHeight * i / 2.0;
            canvas.Children.Add(new Line
            {
                X1 = leftPad,
                Y1 = y,
                X2 = width - 6,
                Y2 = y,
                Stroke = NativeTheme.BorderSoftBrush,
                StrokeThickness = 1,
            });
            var label = new TextBlock
            {
                Text = FormatTokensShort((long)(max * (1 - i / 2.0))),
                FontSize = 9,
                Foreground = NativeTheme.TextMutedBrush,
            };
            Canvas.SetLeft(label, 2);
            Canvas.SetTop(label, Math.Max(0, y - 6)); // 顶部刻度贴边不裁切
            canvas.Children.Add(label);
        }

        Ellipse MakeDot(Brush brush) => new()
        {
            Width = 8,
            Height = 8,
            Fill = brush,
            Stroke = Brushes.White,
            StrokeThickness = 1.5,
            Visibility = Visibility.Collapsed,
            IsHitTestVisible = false,
        };

        double XAt(int index) => leftPad + index * slotWidth + slotWidth / 2.0;
        double YAt(int amount) => chartHeight - chartHeight * ((double)amount / max);

        // 折线与填充带（对齐 Electron fill:true；淡入入场）
        void AddSeries(bool useInput, Brush brush)
        {
            var points = new List<Point>();
            for (var i = 0; i < values.Count; i++)
            {
                var amount = useInput ? values[i].Input : values[i].Output;
                points.Add(new Point(XAt(i), YAt(amount)));
            }
            if (brush is SolidColorBrush solid)
            {
                var fill = new Polygon
                {
                    Fill = new SolidColorBrush(Color.FromArgb(0x26, solid.Color.R, solid.Color.G, solid.Color.B)),
                    Opacity = 0,
                };
                foreach (var point in points) fill.Points.Add(point);
                fill.Points.Add(new Point(XAt(values.Count - 1), chartHeight));
                fill.Points.Add(new Point(XAt(0), chartHeight));
                fill.BeginAnimation(UIElement.OpacityProperty, new DoubleAnimation(1, TimeSpan.FromMilliseconds(360))
                {
                    EasingFunction = new QuadraticEase { EasingMode = EasingMode.EaseOut },
                });
                canvas.Children.Add(fill);
            }
            var polyline = new Polyline
            {
                Stroke = brush,
                StrokeThickness = 2,
                StrokeLineJoin = PenLineJoin.Round,
                Opacity = 0,
            };
            foreach (var point in points) polyline.Points.Add(point);
            polyline.BeginAnimation(UIElement.OpacityProperty, new DoubleAnimation(1, TimeSpan.FromMilliseconds(360))
            {
                EasingFunction = new QuadraticEase { EasingMode = EasingMode.EaseOut },
            });
            canvas.Children.Add(polyline);
        }
        AddSeries(true, TrendInputBrush);
        AddSeries(false, TrendOutputBrush);

        // 数据点（hover 才显示）+ 列命中区（tooltip + 双序列点联动）
        var inputDots = new Ellipse[values.Count];
        var outputDots = new Ellipse[values.Count];
        for (var i = 0; i < values.Count; i++)
        {
            var dotIn = MakeDot(TrendInputBrush);
            var dotOut = MakeDot(TrendOutputBrush);
            Canvas.SetLeft(dotIn, XAt(i) - 4);
            Canvas.SetTop(dotIn, YAt(values[i].Input) - 4);
            Canvas.SetLeft(dotOut, XAt(i) - 4);
            Canvas.SetTop(dotOut, YAt(values[i].Output) - 4);
            inputDots[i] = dotIn;
            outputDots[i] = dotOut;
            canvas.Children.Add(dotIn);
            canvas.Children.Add(dotOut);

            var hit = new Rectangle
            {
                Width = slotWidth,
                Height = chartHeight,
                Fill = Brushes.Transparent,
                Cursor = System.Windows.Input.Cursors.Hand,
                ToolTip = MakeTokenTooltip(values[i]),
            };
            Canvas.SetLeft(hit, XAt(i) - slotWidth / 2);
            Canvas.SetTop(hit, 0);
            var shownIn = dotIn;
            var shownOut = dotOut;
            hit.MouseEnter += (_, _) => { shownIn.Visibility = Visibility.Visible; shownOut.Visibility = Visibility.Visible; };
            hit.MouseLeave += (_, _) => { shownIn.Visibility = Visibility.Collapsed; shownOut.Visibility = Visibility.Collapsed; };
            canvas.Children.Add(hit);
        }

        // x 轴日期（整宽画布下按密度隔位：7 天全显，14 天隔一，30 天隔二）
        for (var i = 0; i < values.Count; i++)
        {
            var step = values.Count > 20 ? 3 : values.Count > 7 ? 2 : 1;
            if (i % step != 0 && i != values.Count - 1) continue;
            var label = new TextBlock { Text = values[i].Date, FontSize = 10, Foreground = NativeTheme.TextMutedBrush };
            Canvas.SetLeft(label, leftPad + i * slotWidth + slotWidth / 2.0 - 12);
            Canvas.SetTop(label, chartHeight + 3);
            canvas.Children.Add(label);
        }

        return canvas;
    }

    /// <summary>模型占比配色（对齐 Electron tokens/panel.ts modelColors）。</summary>
    private static readonly Color[] DonutPalette =
    {
        Color.FromRgb(0xFF, 0x7E, 0xB7),
        Color.FromRgb(0x8B, 0x7C, 0xF6),
        Color.FromRgb(0x4D, 0xB6, 0xAC),
        Color.FromRgb(0xF4, 0xA2, 0x61),
        Color.FromRgb(0x5B, 0x8D, 0xEF),
        Color.FromRgb(0x94, 0xA3, 0xB8),
    };

    /// <summary>趋势图输入序列（Electron #3B82F6）。</summary>
    private static readonly Brush TrendInputBrush = NativeTheme.Brush(Color.FromRgb(0x3B, 0x82, 0xF6));

    /// <summary>趋势图输出序列（Electron #FF8CCC）。</summary>
    private static readonly Brush TrendOutputBrush = NativeTheme.Brush(Color.FromRgb(0xFF, 0x8C, 0xCC));

    /// <summary>每日柱渐变（Electron .token-bar__fill：#FF5B8A → #FF8CCC）。</summary>
    private static Brush TokenBarBrush() => new LinearGradientBrush(
        Color.FromRgb(0xFF, 0x5B, 0x8A), Color.FromRgb(0xFF, 0x8C, 0xCC),
        new Point(0.5, 0), new Point(0.5, 1));

    private static Brush DonutBrush(int index) => NativeTheme.Brush(DonutPalette[index % DonutPalette.Length]);

    /// <summary>模型占比环形图（顶层 6 个扇区 + 其余合并）。</summary>
    private static FrameworkElement MakeModelDonut(List<(string Name, int Total)> models)
    {
        const double size = 132;
        const double thickness = 22;
        var canvas = new Canvas
        {
            Width = size,
            Height = size,
            Opacity = 0,
            RenderTransformOrigin = new Point(0.5, 0.5),
        };
        // 入场：缩放 + 淡入
        var scale = new ScaleTransform(0.92, 0.92);
        canvas.RenderTransform = scale;
        var entrance = new QuadraticEase { EasingMode = EasingMode.EaseOut };
        canvas.BeginAnimation(UIElement.OpacityProperty, new DoubleAnimation(1, TimeSpan.FromMilliseconds(300)) { EasingFunction = entrance });
        scale.BeginAnimation(ScaleTransform.ScaleXProperty, new DoubleAnimation(1, TimeSpan.FromMilliseconds(300)) { EasingFunction = entrance });
        scale.BeginAnimation(ScaleTransform.ScaleYProperty, new DoubleAnimation(1, TimeSpan.FromMilliseconds(300)) { EasingFunction = entrance });
        var total = models.Sum((m) => (long)m.Total);
        if (total <= 0) return canvas;

        // 超过 6 个模型时合并为「其他」，避免扇区过碎
        var slices = new List<(string Name, long Total)>();
        for (var i = 0; i < models.Count; i++)
        {
            if (i < 5) slices.Add((models[i].Name, models[i].Total));
            else if (slices.Count > 5) slices[5] = ("其他", slices[5].Total + models[i].Total);
            else slices.Add(("其他", models[i].Total));
        }

        var center = size / 2;
        var radius = center - thickness / 2 - 1;
        var angle = -90.0;
        Point PointOn(double degrees, double r)
            => new(center + r * Math.Cos(degrees * Math.PI / 180), center + r * Math.Sin(degrees * Math.PI / 180));

        for (var i = 0; i < slices.Count; i++)
        {
            var sweep = 360.0 * slices[i].Total / total;
            if (sweep <= 0) continue;
            // 100%（单模型）扇区：ArcSegment 起点==终点会退化成空路径，直接画整圆
            Geometry sliceGeometry;
            if (sweep >= 359.99)
            {
                sliceGeometry = new EllipseGeometry(new Point(center, center), radius, radius);
            }
            else
            {
                var figure = new PathFigure { StartPoint = PointOn(angle, radius), IsClosed = false };
                figure.Segments.Add(new ArcSegment
                {
                    Point = PointOn(angle + sweep, radius),
                    Size = new Size(radius, radius),
                    IsLargeArc = sweep > 180,
                    SweepDirection = SweepDirection.Clockwise,
                });
                var geometry = new PathGeometry();
                geometry.Figures.Add(figure);
                sliceGeometry = geometry;
            }
            var sliceName = slices[i].Name;
            var sliceShare = (double)slices[i].Total * 100 / total;
            var path = new Path
            {
                Stroke = DonutBrush(i),
                StrokeThickness = thickness,
                Data = sliceGeometry,
                StrokeStartLineCap = PenLineCap.Flat,
                StrokeEndLineCap = PenLineCap.Flat,
                Cursor = System.Windows.Input.Cursors.Hand,
                ToolTip = new ToolTip
                {
                    Content = $"{sliceName} · {FormatTokensShort(slices[i].Total)} ({sliceShare:0.0}%)",
                    Style = NativeTheme.ToolTipStyle,
                },
            };
            // hover：描边加粗 + 微降透明度
            path.MouseEnter += (_, _) => { path.StrokeThickness = thickness + 4; path.Opacity = 0.92; };
            path.MouseLeave += (_, _) => { path.StrokeThickness = thickness; path.Opacity = 1; };
            canvas.Children.Add(path);
            angle += sweep;
        }
        return canvas;
    }

    /// <summary>单日 Token 数据（柱图/tooltip/趋势共用；字段对齐旧版 TokenDayData）。</summary>
    private readonly record struct TokenDayView(
        string Date,
        string Weekday,
        int Input,
        int Output,
        int Hit,
        int Miss,
        int CacheCreation,
        int Requests,
        int AttemptedRequests,
        int CacheUsageRequests);

    /// <summary>缓存命中率（旧版 formatCacheRate：无缓存统计字样 / 已统计 N / M 口径）。</summary>
    private static string FormatCacheRate(int hit, int miss, int requests, int cacheUsageRequests)
    {
        var cacheableInput = Math.Max(0, hit) + Math.Max(0, miss);
        if (cacheUsageRequests <= 0 || cacheableInput <= 0) return "模型未提供缓存统计";
        var rate = Math.Max(0, hit) / (double)cacheableInput * 100;
        return $"{rate:0.0}%（已统计 {cacheUsageRequests} / {requests} 次请求）";
    }

    /// <summary>缓存数值显示（旧版 formatCacheMetric：无数据 /（部分请求未提供））。</summary>
    private static string FormatCacheMetric(int value, TokenDayView day)
    {
        if (day.CacheUsageRequests <= 0) return "暂无数据";
        var suffix = day.CacheUsageRequests < day.Requests ? "（部分请求未提供）" : "";
        return $"{value:N0}{suffix}";
    }

    /// <summary>Token 数据点提示（日期 + 周几 + 输入/输出/缓存/请求 全覆盖，对齐旧版 tooltip）。</summary>
    private static ToolTip MakeTokenTooltip(TokenDayView day)
    {
        var stack = new StackPanel();
        stack.Children.Add(new TextBlock
        {
            Text = day.Weekday.Length > 0 ? $"{day.Date} {day.Weekday}" : day.Date,
            FontSize = 14,
            FontWeight = FontWeights.SemiBold,
            Foreground = NativeTheme.TextStrongBrush,
        });
        void AddRow(string label, string value)
        {
            var row = new Grid { Margin = new Thickness(0, 2, 0, 0) };
            row.ColumnDefinitions.Add(new ColumnDefinition());
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            var left = new TextBlock { Text = label, FontSize = 14, Foreground = NativeTheme.TextMutedBrush };
            var right = new TextBlock { Text = value, FontSize = 14, Foreground = NativeTheme.TextStrongBrush };
            Grid.SetColumn(right, 1);
            row.Children.Add(left);
            row.Children.Add(right);
            stack.Children.Add(row);
        }
        AddRow("📥 输入", day.Input.ToString("N0"));
        AddRow("📤 输出", day.Output.ToString("N0"));
        AddRow("🎯 缓存命中", FormatCacheMetric(day.Hit, day));
        AddRow("❌ 缓存未命中", FormatCacheMetric(day.Miss, day));
        AddRow("📝 缓存创建", day.CacheCreation > 0 ? day.CacheCreation.ToString("N0") : "暂无数据");
        AddRow("🔢 请求", $"{day.Requests:N0} / {day.AttemptedRequests:N0}");
        return new ToolTip { Content = stack, Style = NativeTheme.ToolTipStyle };
    }

    /// <summary>图例：色块 + 文本。</summary>
    private static FrameworkElement MakeChartLegend(params (string Text, Brush Brush)[] items)
    {
        var row = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 2, 0, 2) };
        foreach (var (text, brush) in items)
        {
            row.Children.Add(new Border
            {
                Width = 10,
                Height = 10,
                CornerRadius = new CornerRadius(5),
                Background = brush,
                VerticalAlignment = VerticalAlignment.Center,
                Margin = new Thickness(0, 0, 6, 0),
            });
            row.Children.Add(new TextBlock
            {
                Text = text,
                FontSize = 14,
                Foreground = NativeTheme.TextMutedBrush,
                VerticalAlignment = VerticalAlignment.Center,
                Margin = new Thickness(0, 0, 16, 0),
            });
        }
        return row;
    }
}

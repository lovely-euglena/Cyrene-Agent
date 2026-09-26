using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Animation;
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
        panel.Children.Add(MakeHeader("Token 用量"));
        panel.Children.Add(MakeHint("本地统计的模型请求用量；不代表云端账单。"));
        panel.Children.Add(MakeSectionStatus("tokens"));

        var tokens = GetNode("tokens");
        var activeDays = GetInt(tokens, "days", 7);

        var rangeRow = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 6, 0, 12) };
        foreach (var days in new[] { 7, 14, 30 })
        {
            var value = days;
            rangeRow.Children.Add(MakeButton($"近 {days} 天", () =>
                RequestRouter.SendSettingsAction("tokens", "set-days", new Dictionary<string, object?> { ["days"] = value }),
                primary: value == activeDays, minWidth: 84));
        }
        panel.Children.Add(rangeRow);

        // ── 总量指标 ──
        var totals = GetNode(tokens, "totals");
        var input = GetInt(totals, "input", 0);
        var output = GetInt(totals, "output", 0);
        var hit = GetInt(totals, "hit", 0);
        var miss = GetInt(totals, "miss", 0);
        var requests = GetInt(totals, "requests", 0);
        var hitRate = hit + miss > 0 ? (double)hit / (hit + miss) : 0;

        panel.Children.Add(MakeMetricRow(
            ("输入 Token", FormatTokensShort(input)),
            ("输出 Token", FormatTokensShort(output)),
            ("请求数", requests.ToString())));
        panel.Children.Add(MakeMetricRow(
            ("缓存命中", FormatTokensShort(hit)),
            ("缓存命中率", $"{hitRate * 100:0.0}%"),
            ("合计", FormatTokensShort(input + output))));

        // ── 每日柱状图 + 趋势折线 ──
        var daily = GetNode(tokens, "daily");
        if (daily.ValueKind == JsonValueKind.Array && daily.GetArrayLength() > 0)
        {
            panel.Children.Add(MakeSubHeader("每日消耗"));
            var values = new List<(string Date, int Input, int Output)>();
            foreach (var day in daily.EnumerateArray())
            {
                values.Add((GetString(day, "date"), GetInt(day, "input", 0), GetInt(day, "output", 0)));
            }
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

            var bars = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 2, 0, 4) };
            var barIndex = 0;
            foreach (var (date, dayInput, dayOutput) in values)
            {
                var total = dayInput + dayOutput;
                var column = new StackPanel
                {
                    Orientation = Orientation.Vertical,
                    VerticalAlignment = VerticalAlignment.Bottom,
                    Width = 28,
                    Margin = new Thickness(2, 0, 2, 0),
                };
                if (barIndex == peakIndex && total > 0)
                {
                    // 峰值白点（Electron .token-bar--peak::after）
                    column.Children.Add(new Ellipse
                    {
                        Width = 8,
                        Height = 8,
                        Fill = Brushes.White,
                        Stroke = NativeTheme.Brush(Color.FromRgb(0xFF, 0x8C, 0xCC)),
                        StrokeThickness = 1.5,
                        HorizontalAlignment = HorizontalAlignment.Center,
                        Margin = new Thickness(0, 0, 0, 2),
                    });
                }
                column.Children.Add(new TextBlock
                {
                    Text = FormatTokensShort(total),
                    FontSize = 10,
                    Foreground = NativeTheme.TextMutedBrush,
                    HorizontalAlignment = HorizontalAlignment.Center,
                });
                var bar = new Border
                {
                    Width = 24,
                    Height = 0,
                    CornerRadius = new CornerRadius(12),
                    Background = total > 0 ? TokenBarBrush() : NativeTheme.BorderSoftBrush,
                    HorizontalAlignment = HorizontalAlignment.Center,
                    VerticalAlignment = VerticalAlignment.Bottom,
                    ToolTip = MakeTokenTooltip(date, dayInput, dayOutput),
                };
                if (total > 0)
                {
                    // 入场动画：从 0 长到目标高度（按列错峰 25ms，最多前 10 列错峰）
                    bar.BeginAnimation(FrameworkElement.HeightProperty, new DoubleAnimation(
                        Math.Max(4, 64.0 * total / max), TimeSpan.FromMilliseconds(320))
                    {
                        BeginTime = TimeSpan.FromMilliseconds(Math.Min(barIndex, 10) * 25),
                        EasingFunction = new QuadraticEase { EasingMode = EasingMode.EaseOut },
                    });
                    // hover 高亮（柱图交互）
                    bar.Cursor = System.Windows.Input.Cursors.Hand;
                    bar.MouseEnter += (_, _) => bar.Opacity = 0.82;
                    bar.MouseLeave += (_, _) => bar.Opacity = 1;
                }
                column.Children.Add(bar);
                column.Children.Add(new TextBlock
                {
                    Text = date,
                    FontSize = 10,
                    Foreground = NativeTheme.TextMutedBrush,
                    HorizontalAlignment = HorizontalAlignment.Center,
                    Margin = new Thickness(0, 2, 0, 0),
                });
                bars.Children.Add(column);
                barIndex++;
            }
            panel.Children.Add(new ScrollViewer
            {
                Content = bars,
                HorizontalScrollBarVisibility = ScrollBarVisibility.Auto,
                VerticalScrollBarVisibility = ScrollBarVisibility.Disabled,
                Margin = new Thickness(0, 0, 0, 6),
            });

            // 使用趋势（输入/输出双折线；配色对齐 Electron Chart.js：输入 #3B82F6 / 输出 #FF8CCC）
            if (values.Count > 1)
            {
                panel.Children.Add(MakeSubHeader("使用趋势"));
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

        panel.Children.Add(MakeButton("重置统计", () =>
        {
            if (MessageBox.Show("确定重置本地 Token 用量统计？该操作不可撤销。", "重置统计",
                    MessageBoxButton.OKCancel, MessageBoxImage.Warning) != MessageBoxResult.OK)
            {
                return;
            }
            RequestRouter.SendSettingsAction("tokens", "clear", null);
        }));
        panel.Children.Add(MakeLegacyButton("tokens"));
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

    /// <summary>输入/输出双折线趋势图（固定宽度画布 + 横向滚动）。</summary>
    private static FrameworkElement MakeTrendChart(List<(string Date, int Input, int Output)> values)
    {
        const double chartHeight = 120;
        const double slotWidth = 26;
        const double leftPad = 36;
        const double bottomPad = 20;
        var width = leftPad + values.Count * slotWidth + 8;
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

        // 折线（淡入入场）
        void AddSeries(bool useInput, Brush brush)
        {
            var polyline = new Polyline
            {
                Stroke = brush,
                StrokeThickness = 2,
                StrokeLineJoin = PenLineJoin.Round,
                Opacity = 0,
            };
            for (var i = 0; i < values.Count; i++)
            {
                var amount = useInput ? values[i].Input : values[i].Output;
                polyline.Points.Add(new Point(XAt(i), YAt(amount)));
            }
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
                ToolTip = MakeTokenTooltip(values[i].Date, values[i].Input, values[i].Output),
            };
            Canvas.SetLeft(hit, XAt(i) - slotWidth / 2);
            Canvas.SetTop(hit, 0);
            var shownIn = dotIn;
            var shownOut = dotOut;
            hit.MouseEnter += (_, _) => { shownIn.Visibility = Visibility.Visible; shownOut.Visibility = Visibility.Visible; };
            hit.MouseLeave += (_, _) => { shownIn.Visibility = Visibility.Collapsed; shownOut.Visibility = Visibility.Collapsed; };
            canvas.Children.Add(hit);
        }

        // x 轴日期（slot 较窄：>5 个时段隔位显示；非常密的 14/30 天再放宽到每 3 个）
        for (var i = 0; i < values.Count; i++)
        {
            var step = values.Count > 12 ? 3 : values.Count > 5 ? 2 : 1;
            if (i % step != 0 && i != values.Count - 1) continue;
            var label = new TextBlock { Text = values[i].Date, FontSize = 9, Foreground = NativeTheme.TextMutedBrush };
            Canvas.SetLeft(label, leftPad + i * slotWidth + slotWidth / 2.0 - 12);
            Canvas.SetTop(label, chartHeight + 3);
            canvas.Children.Add(label);
        }

        return new ScrollViewer
        {
            Content = canvas,
            HorizontalScrollBarVisibility = ScrollBarVisibility.Auto,
            VerticalScrollBarVisibility = ScrollBarVisibility.Disabled,
        };
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
            var sliceName = slices[i].Name;
            var sliceShare = (double)slices[i].Total * 100 / total;
            var path = new Path
            {
                Stroke = DonutBrush(i),
                StrokeThickness = thickness,
                Data = geometry,
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

    /// <summary>Token 数据点提示（日期 + 输入/输出/合计，白卡浮层）。</summary>
    private static ToolTip MakeTokenTooltip(string date, int input, int output)
    {
        var stack = new StackPanel();
        stack.Children.Add(new TextBlock
        {
            Text = date,
            FontSize = 14,
            FontWeight = FontWeights.SemiBold,
            Foreground = NativeTheme.TextStrongBrush,
        });
        stack.Children.Add(new TextBlock
        {
            Text = $"输入 {FormatTokensShort(input)} · 输出 {FormatTokensShort(output)}",
            FontSize = 14,
            Foreground = NativeTheme.TextMutedBrush,
            Margin = new Thickness(0, 2, 0, 0),
        });
        stack.Children.Add(new TextBlock
        {
            Text = $"合计 {FormatTokensShort(input + output)}",
            FontSize = 14,
            Foreground = NativeTheme.PinkDarkBrush,
            Margin = new Thickness(0, 2, 0, 0),
        });
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

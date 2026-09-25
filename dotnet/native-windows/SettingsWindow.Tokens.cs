using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
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
            foreach (var v in values) max = Math.Max(max, v.Input + v.Output);

            var bars = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 2, 0, 4) };
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
                column.Children.Add(new TextBlock
                {
                    Text = FormatTokensShort(total),
                    FontSize = 9,
                    Foreground = NativeTheme.TextMutedBrush,
                    HorizontalAlignment = HorizontalAlignment.Center,
                });
                column.Children.Add(new Border
                {
                    Width = 18,
                    Height = Math.Max(total > 0 ? 4 : 0, 64.0 * total / max),
                    CornerRadius = new CornerRadius(3),
                    Background = total > 0 ? NativeTheme.PinkBrush : NativeTheme.BorderSoftBrush,
                    HorizontalAlignment = HorizontalAlignment.Center,
                    VerticalAlignment = VerticalAlignment.Bottom,
                });
                column.Children.Add(new TextBlock
                {
                    Text = date,
                    FontSize = 9,
                    Foreground = NativeTheme.TextMutedBrush,
                    HorizontalAlignment = HorizontalAlignment.Center,
                    Margin = new Thickness(0, 2, 0, 0),
                });
                bars.Children.Add(column);
            }
            panel.Children.Add(new ScrollViewer
            {
                Content = bars,
                HorizontalScrollBarVisibility = ScrollBarVisibility.Auto,
                VerticalScrollBarVisibility = ScrollBarVisibility.Disabled,
                Margin = new Thickness(0, 0, 0, 6),
            });

            // 使用趋势（输入/输出双折线）
            if (values.Count > 1)
            {
                panel.Children.Add(MakeSubHeader("使用趋势"));
                panel.Children.Add(MakeTrendChart(values));
                panel.Children.Add(MakeChartLegend(("输入", NativeTheme.PinkBrush), ("输出", NativeTheme.VioletBrush)));
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
                FontSize = 11.5,
                Foreground = NativeTheme.TextMutedBrush,
            });
            stack.Children.Add(new TextBlock
            {
                Text = metrics[column].Value,
                FontSize = 17,
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
            Canvas.SetTop(label, y - 6);
            canvas.Children.Add(label);
        }

        void AddSeries(bool useInput, Brush brush)
        {
            var polyline = new Polyline { Stroke = brush, StrokeThickness = 2, StrokeLineJoin = PenLineJoin.Round };
            for (var i = 0; i < values.Count; i++)
            {
                var value = values[i];
                var x = leftPad + i * slotWidth + slotWidth / 2.0;
                var amount = useInput ? value.Input : value.Output;
                var y = chartHeight - chartHeight * ((double)amount / max);
                polyline.Points.Add(new Point(x, y));
            }
            canvas.Children.Add(polyline);
        }
        AddSeries(true, NativeTheme.PinkBrush);
        AddSeries(false, NativeTheme.VioletBrush);

        // x 轴日期（密集时隔位显示）
        for (var i = 0; i < values.Count; i++)
        {
            if (values.Count > 10 && i % 3 != 0 && i != values.Count - 1) continue;
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

    private static readonly Color[] DonutPalette =
    {
        Color.FromRgb(0xFF, 0x5B, 0x8A),
        Color.FromRgb(0x9F, 0x7A, 0xEA),
        Color.FromRgb(0x22, 0xD3, 0xEE),
        Color.FromRgb(0xFF, 0xB1, 0x4D),
        Color.FromRgb(0x7D, 0xD3, 0xFC),
        Color.FromRgb(0xA3, 0xE6, 0x35),
    };

    private static Brush DonutBrush(int index) => NativeTheme.Brush(DonutPalette[index % DonutPalette.Length]);

    /// <summary>模型占比环形图（顶层 6 个扇区 + 其余合并）。</summary>
    private static FrameworkElement MakeModelDonut(List<(string Name, int Total)> models)
    {
        const double size = 132;
        const double thickness = 22;
        var canvas = new Canvas { Width = size, Height = size };
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
            canvas.Children.Add(new Path
            {
                Stroke = DonutBrush(i),
                StrokeThickness = thickness,
                Data = geometry,
                StrokeStartLineCap = PenLineCap.Flat,
                StrokeEndLineCap = PenLineCap.Flat,
            });
            angle += sweep;
        }
        return canvas;
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
                FontSize = 11,
                Foreground = NativeTheme.TextMutedBrush,
                VerticalAlignment = VerticalAlignment.Center,
                Margin = new Thickness(0, 0, 16, 0),
            });
        }
        return row;
    }
}

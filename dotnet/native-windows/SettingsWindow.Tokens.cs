using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;

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

        // ── 每日柱状图 ──
        var daily = GetNode(tokens, "daily");
        if (daily.ValueKind == JsonValueKind.Array && daily.GetArrayLength() > 0)
        {
            panel.Children.Add(MakeSubHeader("每日消耗"));
            var values = new List<(string Date, int Total)>();
            foreach (var day in daily.EnumerateArray())
            {
                values.Add((GetString(day, "date"), GetInt(day, "input", 0) + GetInt(day, "output", 0)));
            }
            var max = 1;
            foreach (var (_, total) in values) max = Math.Max(max, total);

            var bars = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 2, 0, 4) };
            foreach (var (date, total) in values)
            {
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
        }

        // ── 模型用量 ──
        var models = GetNode(tokens, "models");
        if (models.ValueKind == JsonValueKind.Array && models.GetArrayLength() > 0)
        {
            panel.Children.Add(MakeSubHeader("模型用量"));
            foreach (var model in models.EnumerateArray())
            {
                var name = GetString(model, "name", "未归类");
                var modelTotal = GetInt(model, "input", 0) + GetInt(model, "output", 0);
                var modelRequests = GetInt(model, "requests", 0);
                panel.Children.Add(MakeHint($"{name} · {FormatTokensShort(modelTotal)} tokens · {modelRequests} 次请求"));
            }
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
}

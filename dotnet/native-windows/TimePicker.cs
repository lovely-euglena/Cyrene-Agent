using System;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;

namespace CyreneNative;

/// <summary>
/// 时间选择器（HH:mm）：小时 / 分钟两个下拉（00-23 / 00-59）。
/// 替代原生任务编辑器里 70px 宽的小文本框（看不清、格式易错）；
/// 值天然合法，Value get/set 与旧字符串接口兼容（非法输入回落 08:00）。
/// </summary>
public sealed class TimePicker : StackPanel
{
    private readonly ComboBox _hour;
    private readonly ComboBox _minute;

    public TimePicker()
    {
        Orientation = Orientation.Horizontal;
        VerticalAlignment = VerticalAlignment.Center;

        _hour = new ComboBox { Width = 82, FontSize = 14, ToolTip = "小时（00-23）" };
        _minute = new ComboBox { Width = 82, FontSize = 14, ToolTip = "分钟（00-59）" };
        for (var hour = 0; hour < 24; hour++) _hour.Items.Add(hour.ToString("00"));
        for (var minute = 0; minute < 60; minute++) _minute.Items.Add(minute.ToString("00"));
        _hour.SelectedIndex = 8;
        _minute.SelectedIndex = 0;

        Children.Add(_hour);
        Children.Add(new TextBlock
        {
            Text = ":",
            FontSize = 16,
            FontWeight = FontWeights.SemiBold,
            Foreground = NativeTheme.TextMutedBrush,
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(6, 0, 6, 0),
        });
        Children.Add(_minute);
    }

    /// <summary>HH:mm；非法输入回落 08:00（与旧版「清空回退 08:00」语义一致）。</summary>
    public string Value
    {
        get => $"{Math.Max(0, _hour.SelectedIndex):00}:{Math.Max(0, _minute.SelectedIndex):00}";
        set
        {
            var parts = (value ?? string.Empty).Split(':');
            var hour = parts.Length > 0 && int.TryParse(parts[0], out var h) && h is >= 0 and <= 23 ? h : 8;
            var minute = parts.Length > 1 && int.TryParse(parts[1], out var m) && m is >= 0 and <= 59 ? m : 0;
            _hour.SelectedIndex = hour;
            _minute.SelectedIndex = minute;
        }
    }
}

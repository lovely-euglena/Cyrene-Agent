using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;

namespace CyreneNative;

/// <summary>
/// 定时任务编辑器（模态）：标题/提示词/启用、计划（每天/每周/仅一次/间隔）、
/// 工具白名单（allow-list）。
///
/// 独立窗口而非内嵌面板：设置窗列表会随宿主快照重建，模态编辑器不受影响。
/// 保存不做本地写入——发 scheduler add/update 动作，宿主写盘并重推快照；
/// 校验失败与宿主错误经 state.settings-notice 显示在设置窗「定时任务」section。
///
/// 插件任务（ownerPluginId 非空）：启用复选框 = 用户授权；工具模式锁定 allow-list。
/// </summary>
public sealed class TaskEditorWindow : Window
{
    private readonly Action<string?, Dictionary<string, object?>> _onSave;
    private readonly string? _editingId;
    private readonly bool _isPluginTask;

    private readonly TextBox _titleBox = new();
    private readonly TextBox _promptBox = new();
    private readonly CheckBox _enabledBox = new();
    private readonly ComboBox _kindCombo = new();
    private readonly StackPanel _onceRow;
    private readonly DatePicker _onceDate = new();
    private readonly TextBox _onceTimeBox = new();
    private readonly StackPanel _timeRow;
    private readonly TextBox _timeBox = new();
    private readonly StackPanel _weeklyRow;
    private readonly ComboBox _dayCombo = new();
    private readonly StackPanel _intervalRow;
    private readonly TextBox _everyBox = new();
    private readonly ComboBox _unitCombo = new();
    private readonly CheckBox _allowListBox = new();
    private readonly StackPanel _toolsPanel = new();
    private readonly ScrollViewer _toolsScroll = new();
    private readonly TextBlock _status = new();

    private static readonly Regex TimePattern = new("^([01]\\d|2[0-3]):[0-5]\\d$", RegexOptions.Compiled);

    public TaskEditorWindow(JsonElement? task, JsonElement tools, Action<string?, Dictionary<string, object?>> onSave)
    {
        _onSave = onSave;
        var hasTask = task.HasValue && task.Value.ValueKind == JsonValueKind.Object;
        var taskValue = hasTask ? task!.Value : default;
        _editingId = hasTask ? GetStringStatic(taskValue, "id") : null;
        if (_editingId is { Length: 0 }) _editingId = null;
        _isPluginTask = hasTask && GetStringStatic(taskValue, "ownerPluginId").Length > 0;

        Title = hasTask ? "编辑定时任务" : "新建定时任务";
        Width = 560;
        Height = 640;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;
        ResizeMode = ResizeMode.NoResize;
        ShowInTaskbar = false;
        // 无边框圆角窗 + 自绘标题栏（与其它原生窗统一圆角）
        WindowStyle = WindowStyle.None;
        AllowsTransparency = true;
        Background = Brushes.Transparent;
        NativeTheme.Apply(this);

        var root = new ScrollViewer { VerticalScrollBarVisibility = ScrollBarVisibility.Auto, Padding = new Thickness(20) };
        var panel = new StackPanel();
        root.Content = panel;

        var shellGrid = new Grid();
        shellGrid.RowDefinitions.Add(new RowDefinition { Height = new GridLength(40) });
        shellGrid.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        var titleBar = NativeTheme.BuildTitleBar(this, Title);
        Grid.SetRow(titleBar, 0);
        shellGrid.Children.Add(titleBar);
        Grid.SetRow(root, 1);
        shellGrid.Children.Add(root);
        NativeTheme.ClipRounded(shellGrid, 12);
        Content = new Border
        {
            CornerRadius = new CornerRadius(12),
            Background = NativeTheme.SurfaceAppBrush,
            BorderBrush = NativeTheme.BorderSoftBrush,
            BorderThickness = new Thickness(1),
            Child = shellGrid,
        };
        panel.Children.Add(Header(hasTask ? "编辑定时任务" : "新建定时任务"));
        panel.Children.Add(Hint("提示词会在触发时作为一次 Agent 运行；工具白名单限制该运行可用的工具。"));

        // 标题 / 提示词 / 启用
        panel.Children.Add(Labeled("标题", _titleBox));
        _titleBox.Text = hasTask ? GetStringStatic(taskValue, "title") : "";
        _promptBox.AcceptsReturn = true;
        _promptBox.Height = 90;
        _promptBox.TextWrapping = TextWrapping.Wrap;
        _promptBox.VerticalScrollBarVisibility = ScrollBarVisibility.Auto;
        _promptBox.Text = hasTask ? GetStringStatic(taskValue, "prompt") : "";
        panel.Children.Add(Labeled("提示词", _promptBox));
        _enabledBox.Content = _isPluginTask ? "启用（用户授权）" : "启用";
        _enabledBox.IsChecked = !hasTask || GetBoolStatic(taskValue, "enabled", true);
        _enabledBox.Margin = new Thickness(0, 6, 0, 6);
        panel.Children.Add(_enabledBox);

        // 计划
        panel.Children.Add(SectionHeader("计划"));
        _kindCombo.Width = 200;
        _kindCombo.Items.Add("每天");
        _kindCombo.Items.Add("每周");
        _kindCombo.Items.Add("仅一次");
        _kindCombo.Items.Add("间隔");
        panel.Children.Add(Row("类型", _kindCombo));

        _onceRow = Row("一次性时间", BuildOnceControls());
        _timeRow = Row("时间（HH:mm）", _timeBox);
        _weeklyRow = Row("星期", BuildDayCombo());
        _intervalRow = Row("间隔", BuildIntervalControls());
        panel.Children.Add(_onceRow);
        panel.Children.Add(_timeRow);
        panel.Children.Add(_weeklyRow);
        panel.Children.Add(_intervalRow);

        // 工具
        panel.Children.Add(SectionHeader("工具"));
        _allowListBox.Content = "仅使用选中工具（allow-list）";
        _allowListBox.Margin = new Thickness(0, 4, 0, 4);
        _allowListBox.IsChecked = _isPluginTask || (hasTask && GetStringStatic(taskValue, "toolMode") == "allow-list");
        if (_isPluginTask)
        {
            _allowListBox.IsEnabled = false; // 插件任务只能走显式白名单
        }
        panel.Children.Add(_allowListBox);
        _toolsPanel.Margin = new Thickness(8, 2, 0, 6);
        _toolsScroll.MaxHeight = 140;
        _toolsScroll.VerticalScrollBarVisibility = ScrollBarVisibility.Auto;
        _toolsScroll.Content = _toolsPanel;
        _toolsScroll.BorderThickness = new Thickness(1);
        _toolsScroll.BorderBrush = new SolidColorBrush(Color.FromRgb(0xE0, 0xE0, 0xEA));
        _toolsScroll.Padding = new Thickness(6);
        panel.Children.Add(_toolsScroll);
        panel.Children.Add(Hint("未选择工具时，任务只能使用模型自身能力（不能调用工具）。"));

        // 初始化选中工具 + 计划字段
        var selectedTools = hasTask ? GetStringArrayStatic(taskValue, "allowedToolIds") : new List<string>();
        BuildToolList(tools, selectedTools);
        InitScheduleFields(hasTask ? GetNodeStatic(taskValue, "schedule") : default);
        UpdateConditionalRows();
        _kindCombo.SelectionChanged += (_, _) => UpdateConditionalRows();
        _allowListBox.Checked += (_, _) => UpdateConditionalRows();
        _allowListBox.Unchecked += (_, _) => UpdateConditionalRows();

        // 底部
        _status.FontSize = 12;
        _status.Foreground = new SolidColorBrush(Color.FromRgb(0xD3, 0x3A, 0x3A));
        _status.Margin = new Thickness(0, 6, 0, 0);
        _status.TextWrapping = TextWrapping.Wrap;
        panel.Children.Add(_status);

        var actions = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right, Margin = new Thickness(0, 8, 0, 0) };
        actions.Children.Add(MakeDialogButton("取消", () => Close(), primary: false));
        actions.Children.Add(MakeDialogButton("保存", Save, primary: true));
        panel.Children.Add(actions);

        _titleBox.Focus();
    }

    private FrameworkElement BuildOnceControls()
    {
        var row = new StackPanel { Orientation = Orientation.Horizontal };
        _onceDate.Width = 150;
        _onceTimeBox.Width = 70;
        _onceTimeBox.Margin = new Thickness(8, 0, 0, 0);
        _onceTimeBox.Text = "08:00";
        row.Children.Add(_onceDate);
        row.Children.Add(_onceTimeBox);
        return row;
    }

    private FrameworkElement BuildDayCombo()
    {
        _dayCombo.Width = 120;
        foreach (var name in new[] { "周日", "周一", "周二", "周三", "周四", "周五", "周六" })
        {
            _dayCombo.Items.Add(name);
        }
        _dayCombo.SelectedIndex = 1;
        return _dayCombo;
    }

    private FrameworkElement BuildIntervalControls()
    {
        var row = new StackPanel { Orientation = Orientation.Horizontal };
        _everyBox.Width = 70;
        _everyBox.Text = "1";
        _unitCombo.Width = 90;
        _unitCombo.Margin = new Thickness(8, 0, 0, 0);
        _unitCombo.Items.Add("分钟");
        _unitCombo.Items.Add("小时");
        _unitCombo.SelectedIndex = 0;
        row.Children.Add(_everyBox);
        row.Children.Add(_unitCombo);
        return row;
    }

    private void BuildToolList(JsonElement tools, List<string> selected)
    {
        _toolsPanel.Children.Clear();
        if (tools.ValueKind != JsonValueKind.Array || tools.GetArrayLength() == 0)
        {
            _toolsPanel.Children.Add(Hint("暂无可选工具"));
            return;
        }
        foreach (var tool in tools.EnumerateArray())
        {
            var id = GetStringStatic(tool, "id");
            if (id.Length == 0) continue;
            var name = GetStringStatic(tool, "name", id);
            var risk = GetStringStatic(tool, "risk", "safe");
            var enabled = GetBoolStatic(tool, "enabled", true);
            var checkbox = new CheckBox
            {
                Content = $"{name} ({id}) · {risk}{(enabled ? "" : " · 已全局禁用")}",
                IsChecked = selected.Contains(id),
                Tag = id,
                FontSize = 12,
                Margin = new Thickness(0, 2, 0, 2),
            };
            _toolsPanel.Children.Add(checkbox);
        }
    }

    private void InitScheduleFields(JsonElement schedule)
    {
        var kind = schedule.ValueKind == JsonValueKind.Object ? GetStringStatic(schedule, "kind", "daily") : "daily";
        _kindCombo.SelectedIndex = kind switch
        {
            "weekly" => 1,
            "once" => 2,
            "interval" => 3,
            _ => 0,
        };
        if (schedule.ValueKind != JsonValueKind.Object) return;

        if (kind == "once")
        {
            if (DateTimeOffset.TryParse(GetStringStatic(schedule, "runAt"), out var runAt))
            {
                var local = runAt.ToLocalTime();
                _onceDate.SelectedDate = local.Date;
                _onceTimeBox.Text = local.ToString("HH:mm");
            }
        }
        if (kind == "daily" || kind == "weekly")
        {
            _timeBox.Text = GetStringStatic(schedule, "timeOfDay", "08:00");
            if (kind == "weekly")
            {
                var day = GetIntStatic(schedule, "dayOfWeek", 1);
                _dayCombo.SelectedIndex = day is >= 0 and <= 6 ? day : 1;
            }
        }
        if (kind == "interval")
        {
            _everyBox.Text = GetIntStatic(schedule, "every", 1).ToString();
            _unitCombo.SelectedIndex = GetStringStatic(schedule, "unit", "minutes") == "hours" ? 1 : 0;
        }
    }

    private void UpdateConditionalRows()
    {
        var kind = _kindCombo.SelectedIndex switch
        {
            1 => "weekly",
            2 => "once",
            3 => "interval",
            _ => "daily",
        };
        _onceRow.Visibility = kind == "once" ? Visibility.Visible : Visibility.Collapsed;
        _timeRow.Visibility = kind is "daily" or "weekly" ? Visibility.Visible : Visibility.Collapsed;
        _weeklyRow.Visibility = kind == "weekly" ? Visibility.Visible : Visibility.Collapsed;
        _intervalRow.Visibility = kind == "interval" ? Visibility.Visible : Visibility.Collapsed;
        var allowList = _allowListBox.IsChecked == true;
        _toolsScroll.Visibility = allowList ? Visibility.Visible : Visibility.Collapsed;
    }

    private void Save()
    {
        var title = _titleBox.Text.Trim();
        var prompt = _promptBox.Text.Trim();
        if (title.Length == 0)
        {
            _status.Text = "标题不能为空";
            return;
        }
        if (prompt.Length == 0)
        {
            _status.Text = "提示词不能为空";
            return;
        }

        var kind = _kindCombo.SelectedIndex switch
        {
            1 => "weekly",
            2 => "once",
            3 => "interval",
            _ => "daily",
        };
        var schedule = new Dictionary<string, object?> { ["kind"] = kind };
        if (kind == "once")
        {
            if (_onceDate.SelectedDate is not DateTime date)
            {
                _status.Text = "请选择一次性运行日期";
                return;
            }
            if (!TimePattern.IsMatch(_onceTimeBox.Text.Trim()))
            {
                _status.Text = "一次性时间格式必须是 HH:mm";
                return;
            }
            var parts = _onceTimeBox.Text.Trim().Split(':');
            var runAt = new DateTimeOffset(new DateTime(date.Year, date.Month, date.Day, int.Parse(parts[0]), int.Parse(parts[1]), 0, DateTimeKind.Local));
            if (runAt <= DateTimeOffset.Now)
            {
                _status.Text = "一次性任务时间必须晚于当前时间";
                return;
            }
            schedule["runAt"] = runAt.ToString("o");
        }
        else if (kind is "daily" or "weekly")
        {
            var timeOfDay = _timeBox.Text.Trim();
            // 清空时回退 08:00（对齐 Electron：空值不报错而是用默认时间）
            if (timeOfDay.Length == 0)
            {
                timeOfDay = "08:00";
                _timeBox.Text = timeOfDay;
            }
            if (!TimePattern.IsMatch(timeOfDay))
            {
                _status.Text = "时间格式必须是 HH:mm";
                return;
            }
            schedule["timeOfDay"] = timeOfDay;
            if (kind == "weekly")
            {
                schedule["dayOfWeek"] = Math.Max(0, _dayCombo.SelectedIndex);
            }
        }
        else
        {
            if (!int.TryParse(_everyBox.Text.Trim(), out var every) || every <= 0)
            {
                _status.Text = "间隔必须是正整数";
                return;
            }
            var unit = _unitCombo.SelectedIndex == 1 ? "hours" : "minutes";
            if (unit == "minutes" && every > 1440)
            {
                _status.Text = "分钟间隔不能超过 1440";
                return;
            }
            if (unit == "hours" && every > 168)
            {
                _status.Text = "小时间隔不能超过 168";
                return;
            }
            schedule["every"] = every;
            schedule["unit"] = unit;
        }

        var allowList = _isPluginTask || _allowListBox.IsChecked == true;
        var selectedTools = new List<string>();
        // 已勾选的工具始终收集：取消 allow-list 再重新勾上时保留原选择
        //（对齐 Electron；旧实现 allowList=false 时清空，重新开启会丢选择）
        foreach (var child in _toolsPanel.Children)
        {
            if (child is CheckBox { IsChecked: true, Tag: string id })
            {
                selectedTools.Add(id);
            }
        }

        var payload = new Dictionary<string, object?>
        {
            ["title"] = title,
            ["prompt"] = prompt,
            [_isPluginTask ? "pluginUserEnabled" : "enabled"] = _enabledBox.IsChecked == true,
            ["schedule"] = schedule,
            ["toolMode"] = allowList ? "allow-list" : "all-enabled",
            ["allowedToolIds"] = selectedTools,
        };
        if (_isPluginTask)
        {
            // 宿主授权转换会剔除 enabled/toolMode；这里显式给出 allow-list 语义与用户授权位
            payload["toolMode"] = "allow-list";
        }

        _onSave(_editingId, payload);
        Close();
    }

    // ── 文案/控件工厂（与设置窗风格一致） ──

    private static TextBlock Header(string text) => new()
    {
        Text = text,
        FontSize = 16,
        FontWeight = FontWeights.SemiBold,
        Foreground = new SolidColorBrush(Color.FromRgb(0x22, 0x22, 0x33)),
        Margin = new Thickness(0, 0, 0, 8),
    };

    private static TextBlock Hint(string text) => new()
    {
        Text = text,
        FontSize = 12,
        Foreground = new SolidColorBrush(Color.FromRgb(0x77, 0x77, 0x88)),
        TextWrapping = TextWrapping.Wrap,
        Margin = new Thickness(0, 2, 0, 6),
    };

    private static TextBlock SectionHeader(string text) => new()
    {
        Text = text,
        FontSize = 13,
        FontWeight = FontWeights.SemiBold,
        Foreground = new SolidColorBrush(Color.FromRgb(0x33, 0x33, 0x44)),
        Margin = new Thickness(0, 12, 0, 4),
    };

    private static StackPanel Row(string label, FrameworkElement control)
    {
        var row = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 4, 0, 4) };
        row.Children.Add(new TextBlock
        {
            Text = label,
            Width = 110,
            FontSize = 12,
            VerticalAlignment = VerticalAlignment.Center,
        });
        row.Children.Add(control);
        return row;
    }

    private static StackPanel Labeled(string label, TextBox box)
    {
        var row = new StackPanel { Margin = new Thickness(0, 6, 0, 0) };
        row.Children.Add(new TextBlock { Text = label, FontSize = 12, Margin = new Thickness(0, 0, 0, 3) });
        box.FontSize = 12;
        box.Padding = new Thickness(6, 4, 6, 4);
        row.Children.Add(box);
        return row;
    }

    private static Button MakeDialogButton(string text, Action onClick, bool primary)
    {
        var button = new Button
        {
            Content = text,
            Height = 30,
            MinWidth = 90,
            FontSize = 12,
            Margin = new Thickness(8, 0, 0, 0),
            Cursor = System.Windows.Input.Cursors.Hand,
            Background = new SolidColorBrush(primary ? Color.FromRgb(0x5B, 0x5B, 0xD6) : Color.FromRgb(0xE8, 0xE8, 0xF0)),
            Foreground = new SolidColorBrush(primary ? Colors.White : Color.FromRgb(0x33, 0x33, 0x44)),
            BorderBrush = new SolidColorBrush(Color.FromRgb(0xC5, 0xC5, 0xD5)),
            BorderThickness = new Thickness(1),
        };
        button.Click += (_, _) => onClick();
        return button;
    }

    // ── JSON 静态读取（编辑器独立于快照生命周期） ──

    private static JsonElement GetNodeStatic(JsonElement node, string key)
        => node.ValueKind == JsonValueKind.Object && node.TryGetProperty(key, out var v) ? v : default;

    private static string GetStringStatic(JsonElement node, string key, string fallback = "")
        => node.ValueKind == JsonValueKind.Object
           && node.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String
            ? v.GetString() ?? fallback
            : fallback;

    private static bool GetBoolStatic(JsonElement node, string key, bool fallback = false)
        => node.ValueKind == JsonValueKind.Object && node.TryGetProperty(key, out var v)
            ? v.ValueKind == JsonValueKind.True ? true : v.ValueKind == JsonValueKind.False ? false : fallback
            : fallback;

    private static int GetIntStatic(JsonElement node, string key, int fallback)
        => node.ValueKind == JsonValueKind.Object
           && node.TryGetProperty(key, out var v)
           && v.ValueKind == JsonValueKind.Number
           && v.TryGetInt32(out var n) ? n : fallback;

    private static List<string> GetStringArrayStatic(JsonElement node, string key)
    {
        var list = new List<string>();
        var array = GetNodeStatic(node, key);
        if (array.ValueKind != JsonValueKind.Array) return list;
        foreach (var item in array.EnumerateArray())
        {
            if (item.ValueKind == JsonValueKind.String)
            {
                var value = item.GetString();
                if (value is { Length: > 0 }) list.Add(value);
            }
        }
        return list;
    }
}
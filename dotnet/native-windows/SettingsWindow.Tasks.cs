using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;

namespace CyreneNative;

/// <summary>
/// 设置窗「定时任务」section（WPF 重写）：
///   列表（标题/启停徽标/计划描述/工具与模式/插件来源）+ 操作
///   （立即运行 / 编辑 / 启用停用 / 历史 / 删除）+「新建任务」（独立编辑器窗口）。
///
/// 数据：state.settings.tasks = { tasks[], tools[], pluginRunning{}, history{taskId,rows}|null }
/// 动作：cmd settings scheduler { add / update / toggle / fire / delete / history }
/// 写操作由宿主动作层广播后自动重推快照（列表随之刷新）。
/// </summary>
public sealed partial class SettingsWindow
{
    /// <summary>当前展开历史的任务 id（点「历史」发起请求，结果随快照回来）</summary>
    private string? _tasksHistoryTaskId;

    private FrameworkElement BuildTasksSection()
    {
        var panel = new StackPanel();
        panel.Children.Add(MakeHeader("定时任务"));
        panel.Children.Add(MakeHint("定时任务的新建/编辑/启停/立即运行/历史；插件任务启用时需确认授权。"));
        panel.Children.Add(MakeSectionStatus("tasks"));

        var tasksNode = GetNode("tasks");
        var tasks = GetNode(tasksNode, "tasks");
        var tools = GetNode(tasksNode, "tools");
        var pluginRunning = GetNode(tasksNode, "pluginRunning");
        var history = GetNode(tasksNode, "history");

        panel.Children.Add(MakeButton("新建任务", () => OpenTaskEditor(null, tools), primary: true));

        if (tasks.ValueKind != JsonValueKind.Array || tasks.GetArrayLength() == 0)
        {
            panel.Children.Add(MakeHint("暂无任务：点「新建任务」创建第一个。"));
            return panel;
        }

        foreach (var task in tasks.EnumerateArray())
        {
            panel.Children.Add(BuildTaskCard(task, tools, pluginRunning, history));
        }
        return panel;
    }

    private Border BuildTaskCard(JsonElement task, JsonElement tools, JsonElement pluginRunning, JsonElement history)
    {
        var card = MakeCard(out var content);

        var id = GetString(task, "id");
        var title = GetString(task, "title", "未命名任务");
        var enabled = GetBool(task, "enabled");
        var ownerPluginId = GetString(task, "ownerPluginId");
        var isPluginTask = ownerPluginId.Length > 0;
        var pluginRunningHere = !isPluginTask
            || (pluginRunning.ValueKind == JsonValueKind.Object
                && pluginRunning.TryGetProperty(ownerPluginId, out var runningEl)
                && runningEl.ValueKind == JsonValueKind.True);

        // 标题行：标题 + 启停徽标（+ 插件停用提示）
        var titleRow = new StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center };
        titleRow.Children.Add(MakeCardTitle(title));
        var badge = new TextBlock
        {
            Text = enabled ? "已启用" : "已停用",
            FontSize = 11,
            Margin = new Thickness(10, 0, 0, 0),
            Foreground = new SolidColorBrush(enabled ? Color.FromRgb(0x1D, 0x9A, 0x54) : Color.FromRgb(0x99, 0x99, 0xAA)),
            VerticalAlignment = VerticalAlignment.Center,
        };
        titleRow.Children.Add(badge);
        content.Children.Add(titleRow);

        // meta：插件来源 / 计划 / 下次运行 / 模式 / 工具
        var parts = new List<string>();
        if (isPluginTask) parts.Add($"由插件 {ownerPluginId} 创建");
        parts.Add(DescribeSchedule(GetNode(task, "schedule")));
        parts.Add($"下次运行：{FormatSchedulerDate(GetString(task, "nextFireAt"))}");
        parts.Add($"模式：{GetString(task, "mode", "work")}");
        var toolMode = GetString(task, "toolMode", "all-enabled");
        var allowed = GetStringArray(task, "allowedToolIds");
        parts.Add($"工具：{(isPluginTask ? (allowed.Count > 0 ? string.Join(", ", allowed) : "无") : (toolMode == "all-enabled" ? "全部已启用工具" : (allowed.Count > 0 ? string.Join(", ", allowed) : "无")))}");
        if (isPluginTask && !pluginRunningHere) parts.Add("等待插件启用");
        content.Children.Add(MakeCardMeta(string.Join(" · ", parts)));

        // 操作行
        var actions = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 4, 0, 0) };
        var fireButton = MakeButton("立即运行", () =>
        {
            RequestRouter.SendSettingsAction("scheduler", "fire", new Dictionary<string, object?> { ["id"] = id });
        }, minWidth: 76);
        WithEnabled(fireButton, pluginRunningHere);
        actions.Children.Add(fireButton);
        actions.Children.Add(MakeButton("编辑", () => OpenTaskEditor(task.Clone(), tools), minWidth: 60));
        actions.Children.Add(MakeButton(enabled ? "停用" : "启用", () =>
        {
            if (!enabled && isPluginTask && !ConfirmPluginTaskEnable(task)) return;
            RequestRouter.SendSettingsAction("scheduler", "toggle", new Dictionary<string, object?> { ["id"] = id, ["enabled"] = !enabled });
        }, minWidth: 60));
        actions.Children.Add(MakeButton("历史", () =>
        {
            _tasksHistoryTaskId = _tasksHistoryTaskId == id ? null : id;
            if (_tasksHistoryTaskId == id)
            {
                RequestRouter.SendSettingsAction("scheduler", "history", new Dictionary<string, object?> { ["id"] = id });
            }
            else
            {
                // 收起：本地重绘不发请求（快照未变，手动刷新该 section）
                RefreshSection("tasks");
            }
        }, minWidth: 60));
        actions.Children.Add(MakeButton("删除", () =>
        {
            if (MessageBox.Show($"确定删除定时任务「{title}」吗？", "删除定时任务", MessageBoxButton.OKCancel, MessageBoxImage.Warning) != MessageBoxResult.OK) return;
            if (_tasksHistoryTaskId == id) _tasksHistoryTaskId = null;
            RequestRouter.SendSettingsAction("scheduler", "delete", new Dictionary<string, object?> { ["id"] = id });
        }, minWidth: 60));
        content.Children.Add(actions);

        // 历史展开（快照历史命中该任务时才渲染）
        if (_tasksHistoryTaskId == id)
        {
            content.Children.Add(BuildTaskHistory(history, id));
        }

        return card;
    }

    private static Button WithEnabled(Button button, bool enabled)
    {
        button.IsEnabled = enabled;
        if (!enabled)
        {
            button.ToolTip = "插件已停用，等待插件启用";
        }
        return button;
    }

    private FrameworkElement BuildTaskHistory(JsonElement history, string taskId)
    {
        var box = new StackPanel { Margin = new Thickness(0, 8, 0, 0) };
        var historyTaskId = history.ValueKind == JsonValueKind.Object ? GetString(history, "taskId") : "";
        if (historyTaskId != taskId)
        {
            box.Children.Add(MakeHint("历史读取中…"));
            return box;
        }
        var rows = GetNode(history, "rows");
        if (rows.ValueKind != JsonValueKind.Array || rows.GetArrayLength() == 0)
        {
            box.Children.Add(MakeHint("暂无运行历史"));
            return box;
        }
        foreach (var row in rows.EnumerateArray())
        {
            var firedAt = FormatSchedulerDate(GetString(row, "firedAt"));
            var status = GetString(row, "status");
            var durationMs = GetDouble(row, "durationMs", 0);
            var duration = durationMs > 0 ? $" {Math.Round(durationMs / 100) / 10}s" : "";
            var summary = GetString(row, "outputPreview");
            if (summary.Length == 0) summary = GetString(row, "errorMessage");
            if (summary.Length == 0) summary = GetString(row, "reason");
            var line = $"{firedAt} {status}{duration}：{Truncate(summary, 160)}";
            box.Children.Add(new TextBlock
            {
                Text = line,
                FontSize = 11,
                Foreground = new SolidColorBrush(Color.FromRgb(0x55, 0x55, 0x66)),
                TextWrapping = TextWrapping.Wrap,
                Margin = new Thickness(0, 1, 0, 1),
            });
        }
        return box;
    }

    /// <summary>插件任务启用确认（与渲染页同口径：执行规格一次性授权）。</summary>
    private bool ConfirmPluginTaskEnable(JsonElement task)
    {
        var prompt = GetString(task, "prompt");
        var preview = prompt.Length > 120 ? prompt[..120] + "…" : prompt;
        var text = string.Join(" · ", new[]
        {
            $"插件：{GetString(task, "ownerPluginId")}",
            $"计划：{DescribeSchedule(GetNode(task, "schedule"))}",
            $"提示词：{preview}",
            $"会话模式：{GetString(task, "mode", "work")}",
            $"工具：{(GetStringArray(task, "allowedToolIds").Count > 0 ? string.Join(", ", GetStringArray(task, "allowedToolIds")) : "无（仅模型自身能力）")}",
        });
        return MessageBox.Show(
            text + "\n\n启用即对该任务执行规格的一次明确授权；插件再改动规格会立即失去授权。",
            "启用插件创建的定时任务",
            MessageBoxButton.OKCancel,
            MessageBoxImage.Question) == MessageBoxResult.OK;
    }

    private void OpenTaskEditor(JsonElement? task, JsonElement tools)
    {
        var editor = new TaskEditorWindow(
            task,
            tools,
            onSave: (editingId, payload) =>
            {
                if (editingId is null)
                {
                    RequestRouter.SendSettingsAction("scheduler", "add", new Dictionary<string, object?> { ["input"] = payload });
                }
                else
                {
                    RequestRouter.SendSettingsAction("scheduler", "update", new Dictionary<string, object?> { ["id"] = editingId, ["patch"] = payload });
                }
            })
        {
            Owner = _window,
        };
        editor.ShowDialog();
    }

    // ── 计划描述 / 时间格式（与渲染页 scheduler/utils.ts 同口径） ──

    private static string DescribeSchedule(JsonElement schedule)
    {
        var kind = GetString(schedule, "kind", "daily");
        if (kind == "once") return "仅一次 " + FormatSchedulerDate(GetString(schedule, "runAt"));
        if (kind == "daily") return "每天 " + GetString(schedule, "timeOfDay", "08:00");
        if (kind == "weekly")
        {
            var names = new[] { "周日", "周一", "周二", "周三", "周四", "周五", "周六" };
            var day = GetInt(schedule, "dayOfWeek", 1);
            if (day < 0 || day > 6) day = 1;
            return $"{names[day]} {GetString(schedule, "timeOfDay", "08:00")}";
        }
        var every = GetInt(schedule, "every", 1);
        var unit = GetString(schedule, "unit", "minutes") == "hours" ? "小时" : "分钟";
        return $"每隔 {every} {unit}";
    }

    /// <summary>ISO 时间/null → 本地可读（渲染页 formatSchedulerDate 同口径）。</summary>
    private static string FormatSchedulerDate(string value)
    {
        if (value.Length == 0) return "未安排";
        if (DateTimeOffset.TryParse(value, out var parsed))
        {
            return parsed.ToLocalTime().ToString("yyyy-MM-dd HH:mm");
        }
        return "时间无效";
    }

    private static List<string> GetStringArray(JsonElement node, string key)
    {
        var list = new List<string>();
        var array = GetNode(node, key);
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

    private static string Truncate(string text, int max)
        => text.Length <= max ? text : text[..max] + "…";

    /// <summary>按 section 立即重建一次（本地状态变化但快照未变时用）。</summary>
    private void RefreshSection(string id)
    {
        if (!_sectionHosts.TryGetValue(id, out var host)) return;
        _sectionSources.Remove(id);
        host.Children.Clear();
        host.Children.Add(BuildNativeSection(id));
    }
}
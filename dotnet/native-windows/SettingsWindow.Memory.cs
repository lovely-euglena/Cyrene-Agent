using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;

namespace CyreneNative;

/// <summary>
/// 设置窗「记忆」section（WPF 重写）：L0 画像 / L1 近况（可编辑保存）、
/// L2 事件片段（搜索+只读）、导入文档（删除）、回顾（只读）、
/// Obsidian Vault（绑定/解绑/导出/同步/自动同步）。
///
/// 数据：state.settings.memory（native-settings-sections.buildMemorySectionSnapshot）
/// 动作：cmd settings memory { save-l0 / save-l1 / delete-doc / vault-* }
/// </summary>
public sealed partial class SettingsWindow
{
    /// <summary>L2 搜索词（本地过滤；section 重建后保留）</summary>
    private string _memoryL2Query = "";

    private FrameworkElement BuildMemorySection()
    {
        var panel = new StackPanel();
        panel.Children.Add(MakeHeader("记忆"));
        panel.Children.Add(MakeHint("L0 画像与 L1 近况可编辑；事件片段与导入知识在下方查看/管理。"));
        panel.Children.Add(MakeSectionStatus("memory"));

        var memory = GetNode("memory");
        var memoryError = GetString(memory, "error");
        if (memoryError.Length > 0)
        {
            panel.Children.Add(new TextBlock
            {
                Text = $"⚠ 记忆读取失败：{memoryError}",
                FontSize = 12,
                Foreground = new SolidColorBrush(Color.FromRgb(0xD3, 0x3A, 0x3A)),
                TextWrapping = TextWrapping.Wrap,
                Margin = new Thickness(0, 4, 0, 4),
            });
        }

        BuildMemoryProfileBlocks(panel, memory);
        BuildMemoryL2Block(panel, memory);
        BuildMemoryImportedDocsBlock(panel, memory);
        BuildMemoryReflectionsBlock(panel, memory);
        BuildMemoryVaultBlock(panel, memory);

        return panel;
    }

    // ── L0 / L1 编辑块 ──

    private void BuildMemoryProfileBlocks(StackPanel panel, JsonElement memory)
    {
        var l0 = GetNode(memory, "l0");
        var l1 = GetNode(memory, "l1");

        panel.Children.Add(MakeSubHeader("画像（L0）"));
        var nameBox = MakeMemoryBox(GetString(l0, "preferredName"), multiline: false);
        var occupationBox = MakeMemoryBox(GetString(l0, "occupation"), multiline: false);
        var interestsBox = MakeMemoryBox(GetString(l0, "longTermInterests"), multiline: true);
        var languageBox = MakeMemoryBox(GetString(l0, "language"), multiline: false);
        var noteBox = MakeMemoryBox(GetString(l0, "permanentNote"), multiline: true);
        panel.Children.Add(LabeledBox("称呼 / 姓名", nameBox));
        panel.Children.Add(LabeledBox("职业 / 身份", occupationBox));
        panel.Children.Add(LabeledBox("长期兴趣", interestsBox));
        panel.Children.Add(LabeledBox("语言", languageBox));
        panel.Children.Add(LabeledBox("长期备注", noteBox));
        panel.Children.Add(MakeButton("保存画像", () =>
        {
            RequestRouter.SendSettingsAction("memory", "save-l0", new Dictionary<string, object?>
            {
                ["fields"] = new Dictionary<string, object?>
                {
                    ["preferredName"] = nameBox.Text.Trim(),
                    ["occupation"] = occupationBox.Text.Trim(),
                    ["longTermInterests"] = interestsBox.Text.Trim(),
                    ["language"] = languageBox.Text.Trim(),
                    ["permanentNote"] = noteBox.Text.Trim(),
                },
            });
        }, primary: true));

        panel.Children.Add(MakeSubHeader("近况（L1）"));
        var goalsBox = MakeMemoryBox(GetString(l1, "recentGoals"), multiline: true);
        var preferencesBox = MakeMemoryBox(GetString(l1, "recentPreferences"), multiline: true);
        var projectBox = MakeMemoryBox(GetString(l1, "currentProject"), multiline: true);
        panel.Children.Add(LabeledBox("近期目标", goalsBox));
        panel.Children.Add(LabeledBox("近期偏好", preferencesBox));
        panel.Children.Add(LabeledBox("当前项目", projectBox));
        panel.Children.Add(MakeButton("保存近况", () =>
        {
            RequestRouter.SendSettingsAction("memory", "save-l1", new Dictionary<string, object?>
            {
                ["fields"] = new Dictionary<string, object?>
                {
                    ["recentGoals"] = goalsBox.Text.Trim(),
                    ["recentPreferences"] = preferencesBox.Text.Trim(),
                    ["currentProject"] = projectBox.Text.Trim(),
                },
            });
        }, primary: true));
    }

    // ── L2 事件片段（本地搜索过滤） ──

    private void BuildMemoryL2Block(StackPanel panel, JsonElement memory)
    {
        panel.Children.Add(MakeSubHeader("事件片段（L2）"));
        var searchRow = new StackPanel { Orientation = Orientation.Horizontal };
        var searchBox = new TextBox
        {
            Width = 260,
            FontSize = 12,
            Padding = new Thickness(6, 4, 6, 4),
            Text = _memoryL2Query,
            VerticalContentAlignment = VerticalAlignment.Center,
            ToolTip = "按内容 / 触发片段 / 状态过滤",
        };
        var total = GetNode(memory, "l2Total");
        var truncated = GetBool(memory, "l2Truncated");
        var totalText = new TextBlock
        {
            FontSize = 11,
            Foreground = new SolidColorBrush(Color.FromRgb(0x99, 0x99, 0xAA)),
            Margin = new Thickness(10, 0, 0, 0),
            VerticalAlignment = VerticalAlignment.Center,
            TextWrapping = TextWrapping.Wrap,
            Text = total.ValueKind == JsonValueKind.Number
                ? (truncated
                    ? $"共 {total.GetInt32()} 条 · 仅显示前 500 条，搜索范围受限"
                    : $"共 {total.GetInt32()} 条")
                : "",
        };
        searchRow.Children.Add(searchBox);
        searchRow.Children.Add(totalText);
        panel.Children.Add(searchRow);

        var listPanel = new StackPanel();
        void RenderL2()
        {
            listPanel.Children.Clear();
            var query = _memoryL2Query.Trim().ToLowerInvariant();
            var items = GetNode(memory, "l2");
            var shown = 0;
            if (items.ValueKind == JsonValueKind.Array)
            {
                foreach (var item in items.EnumerateArray())
                {
                    var content = GetString(item, "content");
                    var trigger = GetString(item, "triggerText");
                    var status = GetString(item, "status");
                    if (query.Length > 0)
                    {
                        var haystack = $"{content} {trigger} {status}".ToLowerInvariant();
                        if (!haystack.Contains(query)) continue;
                    }
                    shown++;
                    var card = MakeCard(out var body);
                    body.Children.Add(MakeCardTitle(content));
                    body.Children.Add(MakeCardMeta(trigger.Length > 0 ? $"触发片段：{trigger}" : "无触发片段"));
                    body.Children.Add(MakeCardMeta(
                        $"状态：{status} · 权重：{GetDouble(item, "weight", 0):0.0} · 创建于：{FormatUnixMs(GetDouble(item, "createdAt", 0))}"));
                    listPanel.Children.Add(card);
                }
            }
            if (shown == 0)
            {
                listPanel.Children.Add(MakeHint(query.Length > 0 ? "没有匹配的事件片段" : "暂无事件片段"));
            }
        }
        searchBox.TextChanged += (_, _) =>
        {
            _memoryL2Query = searchBox.Text;
            RenderL2();
        };
        RenderL2();
        panel.Children.Add(listPanel);
    }

    // ── 导入文档（删除） ──

    private void BuildMemoryImportedDocsBlock(StackPanel panel, JsonElement memory)
    {
        panel.Children.Add(MakeSubHeader("导入知识"));
        var docs = GetNode(memory, "importedDocs");
        if (docs.ValueKind != JsonValueKind.Array || docs.GetArrayLength() == 0)
        {
            panel.Children.Add(MakeHint("暂无导入文档：在聊天窗口上传文件后会自动索引。"));
            return;
        }
        foreach (var doc in docs.EnumerateArray())
        {
            var importId = GetString(doc, "importId");
            var fileName = GetString(doc, "fileName", "未命名文档");
            var chunkCount = GetInt(doc, "chunkCount", 0);
            var lastImportedAt = GetDouble(doc, "lastImportedAt", 0);
            var card = MakeCard(out var body);
            body.Children.Add(MakeCardTitle(fileName));
            body.Children.Add(MakeCardMeta($"已索引 {chunkCount} 个片段 · 最近导入：{FormatUnixMs(lastImportedAt)}"));
            var deleteButton = MakeButton("删除", () =>
            {
                if (MessageBox.Show($"删除导入文档「{fileName}」及其索引片段？此操作不可恢复。", "删除导入文档", MessageBoxButton.OKCancel, MessageBoxImage.Warning) != MessageBoxResult.OK) return;
                RequestRouter.SendSettingsAction("memory", "delete-doc", new Dictionary<string, object?>
                {
                    ["importId"] = importId,
                    ["fileName"] = fileName,
                });
            }, minWidth: 60);
            body.Children.Add(deleteButton);
            panel.Children.Add(card);
        }
    }

    // ── 回顾（只读） ──

    private void BuildMemoryReflectionsBlock(StackPanel panel, JsonElement memory)
    {
        panel.Children.Add(MakeSubHeader("回顾"));
        var reflections = GetNode(memory, "reflections");
        if (reflections.ValueKind != JsonValueKind.Array || reflections.GetArrayLength() == 0)
        {
            panel.Children.Add(MakeHint("暂无回顾。"));
            return;
        }
        foreach (var item in reflections.EnumerateArray())
        {
            var card = MakeCard(out var body);
            body.Children.Add(MakeCardTitle(GetString(item, "title")));
            body.Children.Add(MakeCardMeta(GetString(item, "body")));
            body.Children.Add(MakeCardMeta(GetString(item, "meta")));
            panel.Children.Add(card);
        }
    }

    // ── Obsidian Vault ──

    private void BuildMemoryVaultBlock(StackPanel panel, JsonElement memory)
    {
        panel.Children.Add(MakeSubHeader("Obsidian Vault"));
        var vault = GetNode(memory, "vault");
        var vaultPath = GetString(vault, "vaultPath");
        var lastSyncAt = GetDouble(vault, "lastSyncAt", 0);

        if (vaultPath.Length == 0)
        {
            panel.Children.Add(MakeHint("未绑定 vault：绑定后昔涟的记忆会增量同步为 Markdown；也可只做一次性导出。"));
            var unboundRow = new StackPanel { Orientation = Orientation.Horizontal };
            unboundRow.Children.Add(MakeButton("绑定 vault 文件夹", () =>
            {
                RequestRouter.SendSettingsAction("memory", "vault-bind");
            }, primary: true));
            unboundRow.Children.Add(MakeButton("一键导出", () =>
            {
                RequestRouter.SendSettingsAction("memory", "vault-export");
            }));
            panel.Children.Add(unboundRow);
            return;
        }

        panel.Children.Add(MakeHint($"绑定路径：{vaultPath}"));
        if (lastSyncAt > 0)
        {
            panel.Children.Add(MakeHint($"上次同步：{FormatUnixMs(lastSyncAt)}"));
        }
        var boundRow = new StackPanel { Orientation = Orientation.Horizontal };
        boundRow.Children.Add(MakeButton("立即同步", () =>
        {
            RequestRouter.SendSettingsAction("memory", "vault-sync");
        }, primary: true));
        boundRow.Children.Add(MakeButton("解绑", () =>
        {
            if (MessageBox.Show("解绑后不再自动同步（vault 文件夹里的 md 不会被删除）。确定解绑吗？", "解绑 Obsidian Vault", MessageBoxButton.OKCancel, MessageBoxImage.Question) != MessageBoxResult.OK) return;
            RequestRouter.SendSettingsAction("memory", "vault-unbind");
        }));
        panel.Children.Add(boundRow);

        var autoSync = new CheckBox
        {
            Content = "自动同步（记忆写入后增量同步）",
            FontSize = 12,
            IsChecked = GetBool(vault, "autoSync"),
            Margin = new Thickness(0, 4, 0, 4),
            Cursor = System.Windows.Input.Cursors.Hand,
        };
        autoSync.Checked += (_, _) => RequestRouter.SendSettingsAction("memory", "vault-auto-sync", new Dictionary<string, object?> { ["enabled"] = true });
        autoSync.Unchecked += (_, _) => RequestRouter.SendSettingsAction("memory", "vault-auto-sync", new Dictionary<string, object?> { ["enabled"] = false });
        panel.Children.Add(autoSync);
    }

    // ── 控件工厂 ──

    private static TextBox MakeMemoryBox(string text, bool multiline)
    {
        var box = new TextBox
        {
            Text = text,
            FontSize = 12,
            Padding = new Thickness(6, 4, 6, 4),
            TextWrapping = TextWrapping.Wrap,
            VerticalContentAlignment = multiline ? VerticalAlignment.Top : VerticalAlignment.Center,
            AcceptsReturn = multiline,
            Height = multiline ? 56 : double.NaN,
            VerticalScrollBarVisibility = multiline ? ScrollBarVisibility.Auto : ScrollBarVisibility.Disabled,
        };
        return box;
    }

    private static StackPanel LabeledBox(string label, TextBox box)
    {
        var row = new StackPanel { Margin = new Thickness(0, 4, 0, 0) };
        row.Children.Add(new TextBlock
        {
            Text = label,
            FontSize = 12,
            Foreground = new SolidColorBrush(Color.FromRgb(0x55, 0x55, 0x66)),
            Margin = new Thickness(0, 0, 0, 3),
        });
        row.Children.Add(box);
        return row;
    }
}
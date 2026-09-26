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

    /// <summary>Obsidian 动作内联提示（旧版 vault 卡片 hint；跨 section 重建保留）</summary>
    private string _memoryVaultHint = "";

    private FrameworkElement BuildMemorySection()
    {
        var panel = new StackPanel();
        panel.Children.Add(MakePanelHeading(
            MakeHeadingAvatar(System.IO.Path.Combine("icons", "mimi.png"), tint: false),
            "昔涟记忆",
            "昔涟对你的认知和记忆，你可以查看、编辑和管理。"));
        panel.Children.Add(MakeSectionStatus("memory"));

        var memory = GetNode("memory");

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

        panel.Children.Add(MakeModuleHead(
            NativeTheme.VectorGlyph(Glyphs.MemoryProfile, 18, NativeTheme.TextDefaultBrush),
            "长期画像", "L0", "昔涟一直记得、基本不会变化的信息", "手动修改的内容优先级高于自动推断"));
        var nameBox = MakeMemoryBox(GetString(l0, "preferredName"), multiline: false);
        var occupationBox = MakeMemoryBox(GetString(l0, "occupation"), multiline: false);
        var interestsBox = MakeMemoryBox(GetString(l0, "longTermInterests"), multiline: true);
        var languageBox = MakeMemoryBox(GetString(l0, "language"), multiline: false);
        var noteBox = MakeMemoryBox(GetString(l0, "permanentNote"), multiline: true);
        panel.Children.Add(LabeledBox("称呼 / 姓名", MakeInputHost(nameBox, "未设置")));
        panel.Children.Add(LabeledBox("职业 / 身份", MakeInputHost(occupationBox, "未设置")));
        panel.Children.Add(LabeledBox("长期兴趣", MakeInputHost(interestsBox, "未设置")));
        panel.Children.Add(LabeledBox("语言", MakeInputHost(languageBox, "未设置")));
        panel.Children.Add(LabeledBox("长期备注", MakeInputHost(noteBox, "未设置")));
        panel.Children.Add(MakeMemoryEditRow(
            "save-l0",
            new[] { nameBox, occupationBox, interestsBox, languageBox, noteBox },
            () => new Dictionary<string, object?>
            {
                ["preferredName"] = nameBox.Text.Trim(),
                ["occupation"] = occupationBox.Text.Trim(),
                ["longTermInterests"] = interestsBox.Text.Trim(),
                ["language"] = languageBox.Text.Trim(),
                ["permanentNote"] = noteBox.Text.Trim(),
            },
            () =>
            {
                nameBox.Text = GetString(l0, "preferredName");
                occupationBox.Text = GetString(l0, "occupation");
                interestsBox.Text = GetString(l0, "longTermInterests");
                languageBox.Text = GetString(l0, "language");
                noteBox.Text = GetString(l0, "permanentNote");
            }));

        panel.Children.Add(MakeModuleHead(
            NativeTheme.VectorGlyph(Glyphs.MemoryRecent, 18, NativeTheme.TextDefaultBrush),
            "近况", "L1", "最近的目标、偏好和状态，会随时间变化", "手动修改的内容优先级高于自动推断"));
        var goalsBox = MakeMemoryBox(GetString(l1, "recentGoals"), multiline: true);
        var preferencesBox = MakeMemoryBox(GetString(l1, "recentPreferences"), multiline: true);
        var projectBox = MakeMemoryBox(GetString(l1, "currentProject"), multiline: true);
        panel.Children.Add(LabeledBox("近期目标", MakeInputHost(goalsBox, "未设置")));
        panel.Children.Add(LabeledBox("近期偏好", MakeInputHost(preferencesBox, "未设置")));
        panel.Children.Add(LabeledBox("当前项目", MakeInputHost(projectBox, "未设置")));
        panel.Children.Add(MakeMemoryEditRow(
            "save-l1",
            new[] { goalsBox, preferencesBox, projectBox },
            () => new Dictionary<string, object?>
            {
                ["recentGoals"] = goalsBox.Text.Trim(),
                ["recentPreferences"] = preferencesBox.Text.Trim(),
                ["currentProject"] = projectBox.Text.Trim(),
            },
            () =>
            {
                goalsBox.Text = GetString(l1, "recentGoals");
                preferencesBox.Text = GetString(l1, "recentPreferences");
                projectBox.Text = GetString(l1, "currentProject");
            }));
    }

    /// <summary>
    /// L0/L1 编辑控件组（对齐旧版：默认只读，「编辑」解锁、「保存」等宿主回执，
    /// 失败保留输入并提示；「取消」恢复快照值并回到只读）。
    /// </summary>
    private StackPanel MakeMemoryEditRow(
        string saveVerb,
        TextBox[] boxes,
        Func<Dictionary<string, object?>> collect,
        Action restoreValues)
    {
        var row = new StackPanel { Orientation = Orientation.Horizontal };
        var editing = false;
        var saving = false;
        Button? action = null;
        Button? cancel = null;
        cancel = MakeActionButton("取消", () =>
        {
            restoreValues();
            editing = false;
            Apply();
        });
        cancel.Visibility = Visibility.Collapsed;
        void Apply()
        {
            foreach (var box in boxes) box.IsEnabled = editing;
            if (action is not null)
            {
                action.Content = editing ? "保存" : "编辑";
                action.IsEnabled = !saving;
            }
            cancel.Visibility = editing ? Visibility.Visible : Visibility.Collapsed;
        }
        action = MakeActionButton("编辑", () =>
        {
            if (!editing)
            {
                editing = true;
                Apply();
                return;
            }
            saving = true;
            Apply();
            RequestRouter.SendSettingsAction(
                "memory",
                saveVerb,
                new Dictionary<string, object?> { ["fields"] = collect() },
                (ok, error, _) =>
                {
                    saving = false;
                    if (ok)
                    {
                        editing = false;
                        Apply();
                        return;
                    }
                    Apply();
                    _lastNotices["memory"] = ($"保存失败：{(error is { Length: > 0 } ? error : "请重试")}", "error");
                    RenderNotice("memory");
                });
        }, primary: true);
        row.Children.Add(action);
        row.Children.Add(cancel);
        Apply();
        return row;
    }

    // ── L2 事件片段（本地搜索过滤） ──

    private void BuildMemoryL2Block(StackPanel panel, JsonElement memory)
    {
        panel.Children.Add(MakeModuleHead(
            NativeTheme.VectorGlyph(Glyphs.MemoryEvents, 18, NativeTheme.TextDefaultBrush),
            "事件片段", "L2", "从聊天中提炼的重要事件，可搜索和管理"));
        var searchRow = new StackPanel { Orientation = Orientation.Horizontal };
        var searchBox = new TextBox
        {
            Width = 260,
            FontSize = 14,
            Padding = new Thickness(6, 4, 6, 4),
            Text = _memoryL2Query,
            VerticalContentAlignment = VerticalAlignment.Center,
            ToolTip = "按内容 / 触发片段 / 状态过滤",
        };
        var total = GetNode(memory, "l2Total");
        var truncated = GetBool(memory, "l2Truncated");
        var totalText = new TextBlock
        {
            FontSize = 14,
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
        var memoryError = GetString(memory, "error");
        void RenderL2()
        {
            listPanel.Children.Clear();
            if (memoryError.Length > 0)
            {
                AddMemoryBlockError(listPanel, "片段");
                return;
            }
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
                listPanel.Children.Add(MakeHint(query.Length > 0 ? "换个关键词试试" : "聊天后昔涟会自动提炼重要信息"));
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
        panel.Children.Add(MakeModuleHead(
            NativeTheme.VectorGlyph(Glyphs.BookRag, 22, NativeTheme.TextDefaultBrush),
            "导入知识", description: "用户上传的文档和知识库"));
        var docs = GetNode(memory, "importedDocs");
        if (GetString(memory, "error").Length > 0)
        {
            AddMemoryBlockError(panel, "导入知识");
            return;
        }
        if (docs.ValueKind != JsonValueKind.Array || docs.GetArrayLength() == 0)
        {
            panel.Children.Add(MakeHint("暂无导入文档"));
            panel.Children.Add(MakeHint("在聊天窗口上传文件后会自动索引"));
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
            var deleteButton = MakeActionButton("删除", () =>
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
        panel.Children.Add(MakeModuleHead(
            NativeTheme.VectorGlyph(Glyphs.Reflection, 18, NativeTheme.TextDefaultBrush),
            "回顾", description: "AI 自动生成的阶段性回顾"));
        var reflections = GetNode(memory, "reflections");
        if (GetString(memory, "error").Length > 0)
        {
            AddMemoryBlockError(panel, "回顾");
            return;
        }
        if (reflections.ValueKind != JsonValueKind.Array || reflections.GetArrayLength() == 0)
        {
            panel.Children.Add(MakeHint("暂无回顾"));
            panel.Children.Add(MakeHint("当前项目里回顾还没真正生成落地"));
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
        panel.Children.Add(MakeModuleHead(
            NativeTheme.VectorGlyph(Glyphs.CircleCheck, 18, NativeTheme.TextDefaultBrush),
            "Obsidian Vault 绑定", description: "绑定一个文件夹，把记忆同步成 .md 文件，用 [[双链]] 互连",
            hint: "用 Obsidian 打开绑定的文件夹，即可看到关系图谱"));
        var vault = GetNode(memory, "vault");
        var vaultPath = GetString(vault, "vaultPath");
        var lastSyncAt = GetDouble(vault, "lastSyncAt", 0);

        // 旧版 obsidian-vault-ui：动作进行中按钮禁用 +「绑定中…/同步中…」，
        // 结果写在卡片内 hint（跨 section 重建保留）
        var hintBlock = new TextBlock
        {
            FontSize = 13,
            Foreground = NativeTheme.TextMutedBrush,
            TextWrapping = TextWrapping.Wrap,
            Margin = new Thickness(0, 4, 0, 2),
            Text = _memoryVaultHint,
            Visibility = _memoryVaultHint.Length > 0 ? Visibility.Visible : Visibility.Collapsed,
        };
        void SetVaultHint(string text)
        {
            _memoryVaultHint = text;
            hintBlock.Text = text;
            hintBlock.Visibility = text.Length > 0 ? Visibility.Visible : Visibility.Collapsed;
        }

        int FileCountOf(JsonElement? data) =>
            data is { } payload
            && payload.ValueKind == JsonValueKind.Object
            && payload.TryGetProperty("fileCount", out var countEl)
            && countEl.ValueKind == JsonValueKind.Number
                ? countEl.GetInt32()
                : 0;
        bool CanceledOf(JsonElement? data) =>
            data is { } payload
            && payload.ValueKind == JsonValueKind.Object
            && payload.TryGetProperty("canceled", out var canceledEl)
            && canceledEl.ValueKind == JsonValueKind.True;

        Button MakeVaultButton(
            string label,
            string busyText,
            string verb,
            Func<bool, string?, int, bool, string> resultText,
            bool primary = false)
        {
            Button? button = null;
            button = MakeActionButton(label, () =>
            {
                if (button is null || !button.IsEnabled) return;
                button.IsEnabled = false;
                button.Content = busyText;
                SetVaultHint("");
                RequestRouter.SendSettingsAction("memory", verb, null, (ok, error, data) =>
                {
                    if (button is not null)
                    {
                        button.IsEnabled = true;
                        button.Content = label;
                    }
                    var text = resultText(ok, error, FileCountOf(data), CanceledOf(data));
                    if (text.Length > 0) SetVaultHint(text);
                });
            }, primary: primary);
            return button;
        }

        if (vaultPath.Length == 0)
        {
            panel.Children.Add(MakeHint("未绑定 vault：绑定后昔涟的记忆会增量同步为 Markdown；也可只做一次性导出。"));
            var unboundRow = new StackPanel { Orientation = Orientation.Horizontal };
            unboundRow.Children.Add(MakeVaultButton(
                "绑定 vault 文件夹", "绑定中…", "vault-bind",
                (ok, error, fileCount, canceled) => canceled
                    ? ""
                    : ok
                        ? $"已绑定并同步 {fileCount} 个文件"
                        : $"绑定失败：{error}",
                primary: true));
            unboundRow.Children.Add(MakeVaultButton(
                "一键导出", "导出中…", "vault-export",
                (ok, error, fileCount, canceled) => canceled
                    ? ""
                    : ok
                        ? $"已导出 {fileCount} 个文件"
                        : $"导出失败：{error}"));
            panel.Children.Add(unboundRow);
            panel.Children.Add(hintBlock);
            return;
        }

        panel.Children.Add(MakeHint($"绑定路径：{vaultPath}"));
        if (lastSyncAt > 0)
        {
            panel.Children.Add(MakeHint($"上次同步：{FormatUnixMs(lastSyncAt)}"));
        }
        var boundRow = new StackPanel { Orientation = Orientation.Horizontal };
        boundRow.Children.Add(MakeVaultButton(
            "立即同步", "同步中…", "vault-sync",
            (ok, error, fileCount, _) => ok
                ? $"已同步 {fileCount} 个文件 · {DateTime.Now:yyyy/M/d HH:mm:ss}"
                : $"同步失败：{error}",
            primary: true));
        boundRow.Children.Add(MakeVaultButton(
            "解绑", "解绑中…", "vault-unbind",
            (ok, _, _, _) => ok ? "已解绑（vault 文件夹里的 md 不会被删除）" : "解绑失败"));
        panel.Children.Add(boundRow);
        panel.Children.Add(hintBlock);

        var autoSync = new CheckBox
        {
            Content = "自动同步（记忆写入后增量同步）",
            FontSize = 14,
            IsChecked = GetBool(vault, "autoSync"),
            Margin = new Thickness(0, 4, 0, 4),
            Cursor = System.Windows.Input.Cursors.Hand,
        };
        autoSync.Checked += (_, _) =>
        {
            SetVaultHint("已开启自动同步");
            RequestRouter.SendSettingsAction("memory", "vault-auto-sync", new Dictionary<string, object?> { ["enabled"] = true });
        };
        autoSync.Unchecked += (_, _) =>
        {
            SetVaultHint("已关闭自动同步");
            RequestRouter.SendSettingsAction("memory", "vault-auto-sync", new Dictionary<string, object?> { ["enabled"] = false });
        };
        panel.Children.Add(autoSync);
    }

    // ── 控件工厂 ──

    /// <summary>块级读取失败空态（旧版记忆面板：各块分别显示「xx读取失败/请查看终端日志」）。</summary>
    private static void AddMemoryBlockError(StackPanel panel, string what)
    {
        panel.Children.Add(MakeHint($"{what}读取失败"));
        panel.Children.Add(MakeHint("请查看终端日志"));
    }

    private static TextBox MakeMemoryBox(string text, bool multiline)
    {
        var box = new TextBox
        {
            Text = text,
            FontSize = 14,
            Padding = new Thickness(6, 4, 6, 4),
            TextWrapping = TextWrapping.Wrap,
            VerticalContentAlignment = multiline ? VerticalAlignment.Top : VerticalAlignment.Center,
            AcceptsReturn = multiline,
            Height = multiline ? 56 : double.NaN,
            VerticalScrollBarVisibility = multiline ? ScrollBarVisibility.Auto : ScrollBarVisibility.Disabled,
        };
        return box;
    }

    private static StackPanel LabeledBox(string label, FrameworkElement control)
    {
        var row = new StackPanel { Margin = new Thickness(0, 4, 0, 0) };
        row.Children.Add(new TextBlock
        {
            Text = label,
            FontSize = 14,
            Foreground = new SolidColorBrush(Color.FromRgb(0x55, 0x55, 0x66)),
            Margin = new Thickness(0, 0, 0, 3),
        });
        row.Children.Add(control);
        return row;
    }
}
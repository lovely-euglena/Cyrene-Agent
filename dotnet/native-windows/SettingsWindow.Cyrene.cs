using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;

namespace CyreneNative;

/// <summary>
/// 设置窗「昔涟设置」section（阶段 1）：状态栏实时更新 + 表情包发送。
/// RAG / 文档导入（Embedding 模型安装、镜像源等）为阶段 2，底部提供旧版入口。
///
/// 数据：state.settings.cyrene（native-settings-sections.buildCyreneSectionSnapshot，
///       与渲染页读同一份 model settings）
/// 动作：cmd settings cyrene { save / open-sticker-manager / add-sticker }
/// </summary>
public sealed partial class SettingsWindow
{
    private FrameworkElement BuildCyreneSection()
    {
        var panel = new StackPanel();
        panel.Children.Add(MakeHeader("昔涟设置"));
        panel.Children.Add(MakeHint("Agent 行为与表情包（对齐 Electron 昔涟设置；RAG / 文档导入暂在旧版页）。"));
        panel.Children.Add(MakeSectionStatus("cyrene"));

        var cyrene = GetNode("cyrene");

        // ── 状态栏实时更新 ──
        panel.Children.Add(MakeSubHeader("状态栏实时更新"));
        var syncNote = MakeHint("LLM 模式每轮会额外调用一次模型，产生额外 Token 用量。");
        syncNote.Visibility = GetString(cyrene, "runtimeSync", "off") == "llm"
            ? Visibility.Visible
            : Visibility.Collapsed;
        panel.Children.Add(MakeDescribedRow("同步方式",
            "控制状态与心情如何同步到状态栏。",
            MakeChoiceGroup(
                new[]
                {
                    ("off", "关闭", true),
                    ("local", "本地关键词", true),
                    ("llm", "LLM 分析", true),
                },
                GetString(cyrene, "runtimeSync", "off"),
                v =>
                {
                    syncNote.Visibility = v == "llm" ? Visibility.Visible : Visibility.Collapsed;
                    SendCyreneSave(new Dictionary<string, object?> { ["runtimeSync"] = v });
                })));
        panel.Children.Add(syncNote);

        // ── 表情包发送 ──
        panel.Children.Add(MakeSubHeader("表情包发送"));
        panel.Children.Add(MakeDescribedToggleRow("允许发送表情包",
            "控制昔涟是否在聊天框里发送表情包。",
            GetBool(cyrene, "stickerEnabled", true),
            v => SendCyreneSave(new Dictionary<string, object?> { ["stickerEnabled"] = v })));
        panel.Children.Add(MakeDescribedRow("表情包显示大小",
            "调整表情包在聊天气泡中的显示尺寸。",
            MakeChoiceGroup(
                new[]
                {
                    ("small", "小图", true),
                    ("standard", "标准", true),
                    ("large", "大图", true),
                },
                GetString(cyrene, "stickerSize", "standard"),
                v => SendCyreneSave(new Dictionary<string, object?> { ["stickerSize"] = v }))));
        panel.Children.Add(MakeDoubleSliderRow("相似度阈值",
            GetDouble(cyrene, "stickerSimilarityThreshold", 0.55), 0.3, 0.9, 0.05, "",
            v => SendCyreneSave(new Dictionary<string, object?>
            {
                ["stickerSimilarityThreshold"] = Math.Round(v, 2),
            }),
            v => v.ToString("0.00")));
        panel.Children.Add(MakeHint("值越低越容易触发表情包，值越高匹配越精准。"));

        var stickerActions = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            VerticalAlignment = VerticalAlignment.Center,
        };
        stickerActions.Children.Add(MakeButton("管理表情包",
            () => RequestRouter.SendSettingsAction("cyrene", "open-sticker-manager"), minWidth: 110));
        stickerActions.Children.Add(MakeButton("＋ 添加表情包",
            OpenStickerAddDialog, minWidth: 120));
        panel.Children.Add(MakeDescribedRow("表情包管理",
            "在管理窗启停内置表情包，或添加自己的表情包（含相近语义，用于语义匹配）。",
            stickerActions));

        // ── RAG（阶段 2 指引） ──
        panel.Children.Add(MakeSubHeader("RAG / 文档导入"));
        panel.Children.Add(MakeHint("Embedding 模型安装说明、缓存管理与下载镜像源暂在旧版设置中操作。"));
        panel.Children.Add(MakeButton("在旧版设置中打开（RAG / 文档导入）",
            () => RequestRouter.SendCommand("settings", "open-legacy", "cyrene"), minWidth: 280));

        return panel;
    }

    private static void SendCyreneSave(Dictionary<string, object?> patch)
        => RequestRouter.SendSettingsAction("cyrene", "save", patch);

    /// <summary>添加表情包弹窗：选图 + 名称/描述/相近语义，经宿主校验后入库并刷新贴图索引。</summary>
    private void OpenStickerAddDialog()
    {
        var dialog = new StickerAddDialog { Owner = _window };
        if (dialog.ShowDialog() != true) return;
        RequestRouter.SendSettingsAction("cyrene", "add-sticker", dialog.BuildPayload());
    }
}

/// <summary>
/// 添加表情包对话框（对位旧版 preferences 的添加表情包弹窗）：
/// 选择图片（png/jpg/jpeg/gif/webp）+ 英文名称 + 描述 + 相近语义（一行一条）。
/// 仅产出 payload，宿主 addUserSticker 负责复制文件/查重/写 manifest。
/// </summary>
internal sealed class StickerAddDialog : Window
{
    private readonly TextBox _fileBox = new()
    {
        Width = 240,
        IsReadOnly = true,
        FontSize = 12,
        Padding = new Thickness(6, 4, 6, 4),
        VerticalContentAlignment = VerticalAlignment.Center,
    };
    private readonly TextBox _idBox = new() { Width = 200, FontSize = 12, Padding = new Thickness(6, 4, 6, 4) };
    private readonly TextBox _descriptionBox = new() { Width = 300, FontSize = 12, Padding = new Thickness(6, 4, 6, 4) };
    private readonly TextBox _phrasesBox = new()
    {
        Width = 300,
        Height = 84,
        FontSize = 12,
        AcceptsReturn = true,
        TextWrapping = TextWrapping.Wrap,
        VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
        Padding = new Thickness(6, 4, 6, 4),
    };
    private readonly TextBlock _status = new()
    {
        FontSize = 12,
        Foreground = new SolidColorBrush(Color.FromRgb(0xD3, 0x3A, 0x3A)),
        Margin = new Thickness(0, 6, 0, 0),
        TextWrapping = TextWrapping.Wrap,
    };
    private string? _pickedPath;

    public StickerAddDialog()
    {
        Title = "添加表情包";
        Width = 520;
        SizeToContent = SizeToContent.Height;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;
        ResizeMode = ResizeMode.NoResize;
        ShowInTaskbar = false;
        WindowStyle = WindowStyle.None;
        AllowsTransparency = true;
        Background = Brushes.Transparent;
        NativeTheme.Apply(this);

        var root = new StackPanel { Margin = new Thickness(20, 14, 20, 16) };
        var shellGrid = new Grid();
        shellGrid.RowDefinitions.Add(new RowDefinition { Height = new GridLength(40) });
        shellGrid.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        var titleBar = NativeTheme.BuildTitleBar(this, Title);
        Grid.SetRow(titleBar, 0);
        shellGrid.Children.Add(titleBar);
        Grid.SetRow(root, 1);
        shellGrid.Children.Add(root);
        NativeTheme.ClipRounded(shellGrid, 12);
        var contentBorder = new Border
        {
            CornerRadius = new CornerRadius(12),
            Background = NativeTheme.SurfaceAppBrush,
            BorderBrush = NativeTheme.BorderSoftBrush,
            BorderThickness = new Thickness(1),
            Margin = new Thickness(16),
            Child = shellGrid,
        };
        var windowShell = new Grid();
        windowShell.Children.Add(NativeTheme.MakeWindowShadowLayer(12));
        windowShell.Children.Add(contentBorder);
        Content = windowShell;

        // 图片文件（宿主只接收路径，文件复制在宿主侧完成）
        var fileRow = new StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center };
        fileRow.Children.Add(_fileBox);
        var pickBtn = new Button
        {
            Content = "选择图片…",
            MinWidth = 92,
            Margin = new Thickness(8, 0, 0, 0),
            Style = NativeTheme.SecondaryButtonStyle,
        };
        pickBtn.Click += (_, _) => PickFile();
        fileRow.Children.Add(pickBtn);
        root.Children.Add(Row("图片文件", "支持 png / jpg / jpeg / gif / webp。", fileRow));

        root.Children.Add(Row("名称（英文）",
            "用于文件命名与引用，只能用英文字母、数字、下划线和连字符。",
            _idBox));
        root.Children.Add(Row("图片描述",
            "描述这张图表达的情绪或动作（用于语义匹配与模型理解）。",
            _descriptionBox));
        root.Children.Add(Row("相近语义",
            "一行一条，比如“开心”“笑死”“太可爱了”。",
            _phrasesBox));

        root.Children.Add(_status);

        var actions = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            HorizontalAlignment = HorizontalAlignment.Right,
            Margin = new Thickness(0, 12, 0, 0),
        };
        actions.Children.Add(DialogButton("取消", () =>
        {
            DialogResult = false;
            Close();
        }));
        actions.Children.Add(DialogButton("添加", Save, primary: true));
        root.Children.Add(actions);
    }

    /// <summary>对话框行：标题 + 说明在左，控件在右（与设置窗同款布局）。</summary>
    private static Border Row(string title, string description, FrameworkElement control)
    {
        var grid = new Grid { Margin = new Thickness(0, 10, 0, 10) };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        var copy = new StackPanel { VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(0, 0, 16, 0) };
        copy.Children.Add(new TextBlock
        {
            Text = title,
            FontSize = 12.5,
            FontWeight = FontWeights.SemiBold,
            Foreground = NativeTheme.TextStrongBrush,
        });
        copy.Children.Add(new TextBlock
        {
            Text = description,
            FontSize = 11.5,
            Foreground = NativeTheme.TextMutedBrush,
            TextWrapping = TextWrapping.Wrap,
            Margin = new Thickness(0, 2, 0, 0),
        });
        Grid.SetColumn(copy, 0);
        grid.Children.Add(copy);
        Grid.SetColumn(control, 1);
        grid.Children.Add(control);
        return new Border { Child = grid, Padding = new Thickness(0, 2, 0, 2) };
    }

    private static Button DialogButton(string text, Action onClick, bool primary = false)
    {
        var button = new Button
        {
            Content = text,
            MinWidth = 84,
            Margin = new Thickness(8, 0, 0, 0),
            Style = primary ? NativeTheme.PrimaryButtonStyle : NativeTheme.SecondaryButtonStyle,
        };
        button.Click += (_, _) => onClick();
        return button;
    }

    private void PickFile()
    {
        var picker = new Microsoft.Win32.OpenFileDialog
        {
            Title = "选择表情包图片",
            Filter = "图片|*.png;*.jpg;*.jpeg;*.gif;*.webp",
        };
        if (picker.ShowDialog(this) != true) return;
        _pickedPath = picker.FileName;
        _fileBox.Text = System.IO.Path.GetFileName(picker.FileName);
        // 旧版同款：名称留空时按文件名（去扩展名/非法字符）预填
        if (_idBox.Text.Trim().Length == 0)
        {
            var baseName = System.IO.Path.GetFileNameWithoutExtension(picker.FileName);
            _idBox.Text = System.Text.RegularExpressions.Regex.Replace(baseName, "[^a-zA-Z0-9_-]", "");
        }
    }

    private void Save()
    {
        if (string.IsNullOrEmpty(_pickedPath))
        {
            _status.Text = "请先选择图片文件。";
            return;
        }
        var id = _idBox.Text.Trim();
        if (id.Length == 0)
        {
            _status.Text = "请填写英文名称。";
            return;
        }
        if (!System.Text.RegularExpressions.Regex.IsMatch(id, "^[a-zA-Z0-9_-]+$"))
        {
            _status.Text = "名称只能用英文字母、数字、下划线和连字符。";
            return;
        }
        if (_descriptionBox.Text.Trim().Length == 0)
        {
            _status.Text = "请填写图片描述。";
            return;
        }
        if (BuildPhrases().Length == 0)
        {
            _status.Text = "请至少写一行相近语义。";
            return;
        }
        DialogResult = true;
        Close();
    }

    private string[] BuildPhrases()
    {
        var phrases = new List<string>();
        foreach (var line in _phrasesBox.Text.Split('\n'))
        {
            var trimmed = line.Trim();
            if (trimmed.Length > 0) phrases.Add(trimmed);
        }
        return phrases.ToArray();
    }

    /// <summary>宿主 add-sticker 动作 payload（复制文件 / 查重 / 写 manifest 全在宿主侧）。</summary>
    public Dictionary<string, object?> BuildPayload()
        => new()
        {
            ["sourcePath"] = _pickedPath ?? "",
            ["id"] = _idBox.Text.Trim(),
            ["description"] = _descriptionBox.Text.Trim(),
            ["phrases"] = BuildPhrases(),
        };
}

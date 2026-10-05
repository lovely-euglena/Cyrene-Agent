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
        panel.Children.Add(MakePanelHeading(
            MakeHeadingAvatar(System.IO.Path.Combine("icons", "cyrene-avatar-line.png"), tint: false),
            "昔涟设置",
            "这里集中管理昔涟的 Agent 行为、状态更新、表情包、记忆和本地检索能力。"));
        var sectionStatus = MakeSectionStatus("cyrene");
        panel.Children.Add(sectionStatus);
        void ShowStatus(string text, string level)
        {
            _lastNotices["cyrene"] = (text, level);
            RenderNotice("cyrene");
        }

        var cyrene = GetNode("cyrene");

        // ── 状态栏实时更新 ──
        panel.Children.Add(BlockMark());
        panel.Children.Add(MakeModuleHead(
            NativeTheme.VectorGlyph(Glyphs.Heart, 22, NativeTheme.TextDefaultBrush),
            "状态栏实时更新"));
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
        panel.Children.Add(BlockMark());
        panel.Children.Add(MakeModuleHead(
            MakeHeadingAvatar(System.IO.Path.Combine("icons", "sticker-picker.png"), tint: false, size: 22),
            "表情包发送"));
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
        stickerActions.Children.Add(MakeActionButton("管理表情包",
            () => RequestRouter.SendSettingsAction("cyrene", "open-sticker-manager"), minWidth: 110));
        stickerActions.Children.Add(MakeActionButton("＋ 添加表情包",
            OpenStickerAddDialog, minWidth: 120));
        panel.Children.Add(MakeDescribedRow("表情包管理",
            "在管理窗启停内置表情包，或添加自己的表情包（含相近语义，用于语义匹配）。",
            stickerActions));

        // ── RAG / 文档导入 ──
        panel.Children.Add(BlockMark());
        panel.Children.Add(MakeModuleHead(
            NativeTheme.VectorGlyph(Glyphs.BookRag, 22, NativeTheme.TextDefaultBrush),
            "RAG / 文档导入"));
        var embeddingModel = GetString(cyrene, "embeddingModel", "bgem3");
        // 快照新字段（四个模型各自安装状态）；旧字段作为兼容回退
        var bgem3Installed = GetBool(cyrene, "embeddingBgem3Installed", GetBool(cyrene, "embeddingInstalled"));
        var e5Installed = GetBool(cyrene, "embeddingE5SmallInstalled");
        var rerankerMode = GetString(cyrene, "rerankerMode", "standard");
        var rerankerStandardInstalled = GetBool(cyrene, "rerankerStandardInstalled", GetBool(cyrene, "rerankerInstalled"));
        var rerankerV2M3Installed = GetBool(cyrene, "rerankerV2M3Installed");

        // Embedding 两张卡：选中态 + 各自安装状态；点击切换走宿主索引迁移
        Border? bgem3Card = null;
        Border? e5Card = null;
        // 点击守卫用可变选中态而非构建期快照局部变量：宿主切换失败的 catch 只发通知、
        // 不推设置快照重建，窗口内快照值不会刷新，过期值会让「切走后再切回初始档位」
        // 被早退守卫吞掉（与 reranker 同一模式）。
        var embeddingSelected = embeddingModel;
        void ApplyEmbeddingSelection(string model)
        {
            if (bgem3Card is not null) ApplyModelCardSelected(bgem3Card, model == "bgem3");
            if (e5Card is not null) ApplyModelCardSelected(e5Card, model == "e5-small");
        }
        bgem3Card = MakeModelCard(
            "BGE-M3",
            "中文效果优秀，支持贴纸语义匹配和场景语气注入（1024 维）。",
            bgem3Installed ? "已下载 · 约 570MB" : "未下载 · 约 570MB",
            embeddingModel == "bgem3",
            () =>
            {
                if (embeddingSelected == "bgem3") return;
                embeddingSelected = "bgem3";
                ApplyEmbeddingSelection("bgem3");
                SendCyreneSave(new Dictionary<string, object?> { ["embeddingModel"] = "bgem3" });
            });
        e5Card = MakeModelCard(
            "Multilingual-E5-Small",
            "体积小、多语言，适合低配设备（384 维固定）。",
            e5Installed ? "已下载 · 约 120MB" : "未下载 · 约 120MB",
            embeddingModel == "e5-small",
            () =>
            {
                if (embeddingSelected == "e5-small") return;
                embeddingSelected = "e5-small";
                ApplyEmbeddingSelection("e5-small");
                SendCyreneSave(new Dictionary<string, object?> { ["embeddingModel"] = "e5-small" });
            });
        panel.Children.Add(MakeModuleHead(
            NativeTheme.VectorGlyph(Glyphs.BookRag, 18, NativeTheme.TextDefaultBrush),
            "Embedding 模型"));
        panel.Children.Add(bgem3Card);
        panel.Children.Add(e5Card);

        // Embedding 维度：仅 bgem3（Cloud 模式）可编辑；e5-small 固定 384
        if (embeddingModel == "e5-small")
        {
            panel.Children.Add(MakeDescribedRow("Embedding 维度",
                "E5-Small 本地维度固定 384，无需填写（仅 Cloud 模式使用）。",
                MakeText("384（固定）", 14, NativeTheme.TextMutedBrush, margin: new Thickness(0, 0, 12, 0))));
        }
        else
        {
            var dimensionsInput = GetInt(cyrene, "embeddingDimensions", 0);
            panel.Children.Add(MakeDescribedRow("Embedding 维度",
                "留空 = 首次请求自动检测；填写 = 严格校验（仅 Cloud 模式）。",
                MakeTextControl(
                    dimensionsInput > 0 ? dimensionsInput.ToString() : "",
                    value =>
                    {
                        if (value.Length == 0)
                        {
                            // null = 清空（回落到自动探测）
                            SendCyreneSave(new Dictionary<string, object?> { ["embeddingDimensions"] = null });
                            ShowStatus("Embedding 维度已清空（首次请求自动探测）", "ok");
                            return;
                        }
                        if (!int.TryParse(value, out var parsed) || parsed <= 0 || parsed > 65536)
                        {
                            ShowStatus("维度需为 1~65536 的整数（留空 = 自动探测）", "error");
                            return;
                        }
                        SendCyreneSave(new Dictionary<string, object?> { ["embeddingDimensions"] = parsed });
                        ShowStatus($"Embedding 维度已保存：{parsed}", "ok");
                    },
                    160, "留空自动探测")));
        }

        // Reranker 三档卡：standard / v2-m3 / none
        Border? rerankerStandardCard = null;
        Border? rerankerV2M3Card = null;
        Border? rerankerNoneCard = null;
        // 点击守卫用可变选中态而非构建期快照局部变量：reranker 保存成功后宿主不推设置快照，
        // 本窗口内快照值不会刷新，过期值会让「切走后再切回初始档位」被早退守卫吞掉。
        var rerankerSelected = rerankerMode;
        void ApplyRerankerSelection(string mode)
        {
            if (rerankerStandardCard is not null) ApplyModelCardSelected(rerankerStandardCard, mode == "standard");
            if (rerankerV2M3Card is not null) ApplyModelCardSelected(rerankerV2M3Card, mode == "v2-m3");
            if (rerankerNoneCard is not null) ApplyModelCardSelected(rerankerNoneCard, mode == "none");
        }
        rerankerStandardCard = MakeModelCard(
            "bge-reranker-base",
            "精准重排，适合长文档和专业检索，约 200ms/对。",
            rerankerStandardInstalled ? "已下载 · 约 279MB" : "未下载 · 可选",
            rerankerMode == "standard",
            () =>
            {
                if (rerankerSelected == "standard") return;
                rerankerSelected = "standard";
                ApplyRerankerSelection("standard");
                SendCyreneSave(new Dictionary<string, object?> { ["rerankerMode"] = "standard" });
            });
        rerankerV2M3Card = MakeModelCard(
            "bge-reranker-v2-m3",
            "多语言重排，效果更强，约 570MB。",
            rerankerV2M3Installed ? "已下载 · 约 570MB" : "未下载 · 可选",
            rerankerMode == "v2-m3",
            () =>
            {
                if (rerankerSelected == "v2-m3") return;
                rerankerSelected = "v2-m3";
                ApplyRerankerSelection("v2-m3");
                SendCyreneSave(new Dictionary<string, object?> { ["rerankerMode"] = "v2-m3" });
            });
        rerankerNoneCard = MakeModelCard(
            "关闭",
            "不进行重排序，检索后直接使用。",
            "无需模型",
            rerankerMode == "none",
            () =>
            {
                if (rerankerSelected == "none") return;
                rerankerSelected = "none";
                ApplyRerankerSelection("none");
                SendCyreneSave(new Dictionary<string, object?> { ["rerankerMode"] = "none" });
            });
        panel.Children.Add(MakeModuleHead(
            NativeTheme.VectorGlyph(Glyphs.Reflection, 18, NativeTheme.TextDefaultBrush),
            "Rerank 重排序"));
        panel.Children.Add(rerankerStandardCard);
        panel.Children.Add(rerankerV2M3Card);
        panel.Children.Add(rerankerNoneCard);

        // 当前模式：按选中模型/档位与安装状态拼装
        var embeddingModeText = embeddingModel == "e5-small"
            ? "Multilingual-E5-Small（384 维）"
            : "BGE-M3（1024 维）";
        var rerankerModeText = rerankerMode switch
        {
            "v2-m3" => rerankerV2M3Installed
                ? "bge-reranker-v2-m3（已安装）"
                : "bge-reranker-v2-m3 未安装，检索时按关闭处理",
            "none" => "关闭（不进行重排序）",
            _ => rerankerStandardInstalled
                ? "bge-reranker-base（已安装）"
                : "bge-reranker-base 未安装，检索时按关闭处理",
        };
        panel.Children.Add(MakeDescribedRow("当前模式",
            "重排序在检索后按 Rerank 模式生效；切换 Embedding 需要索引迁移。",
            new TextBlock
            {
                Text = $"Embedding：{embeddingModeText} · Rerank：{rerankerModeText}",
                FontSize = 14,
                Foreground = NativeTheme.TextDefaultBrush,
                VerticalAlignment = VerticalAlignment.Center,
                TextWrapping = TextWrapping.Wrap,
                MaxWidth = 340,
            }));

        var ragActions = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            VerticalAlignment = VerticalAlignment.Center,
            // 右侧留出滚动条余量，避免最后一个按钮被裁切
            Margin = new Thickness(0, 0, 10, 0),
        };
        ragActions.Children.Add(MakeActionButton("⬇ 下载模型",
            () => RequestRouter.SendSettingsAction("cyrene", "open-model-downloader"), primary: true, minWidth: 104));
        ragActions.Children.Add(MakeActionButton("📖 安装说明",
            OpenModelDocsDialog, minWidth: 104));
        ragActions.Children.Add(MakeActionButton("🔄 刷新状态",
            () => RequestRouter.SendSettingsAction("cyrene", "check-model-update"), minWidth: 104));
        ragActions.Children.Add(MakeActionButton("📂 打开模型目录",
            () => RequestRouter.SendSettingsAction("cyrene", "open-model-dir"), minWidth: 128));
        ragActions.Children.Add(MakeActionButton("删除模型", () => ConfirmDeleteEmbeddingCache(embeddingModel), minWidth: 90));
        panel.Children.Add(MakeDescribedRow("模型操作",
            "点「下载模型」打开下载窗（支持 hf-mirror 与断点续传）；也可按「安装说明」手动放置后点「刷新状态」。",
            ragActions));

        panel.Children.Add(MakeDescribedRow("下载镜像源",
            "模型下载使用的源；手动安装不受影响。",
            MakeChoiceGroup(
                new[] { ("official", "官方源", true), ("hf-mirror", "hf-mirror", true) },
                GetString("ragDownloadMirror", "official"),
                v => SetSetting("ragDownloadMirror", v))));
        panel.Children.Add(MakeHint("模型状态随设置快照刷新；点「下载模型」可一键下载（断点续传）。"));
        CardifySubBlocks(panel);

        return panel;
    }

    /// <summary>
    /// 宿主 rebuild-required 回执：MessageBox 确认迁移方式后带 embeddingModelAction 重发。
    /// requires=rebuild → 是(Y)=重建 / 否(N)=清空 / 取消；requires=clear → 确定=清空 / 取消。
    /// 取消时刷新 section，撤销卡片的乐观选中。
    /// </summary>
    private void HandleCyreneRebuildRequired(JsonElement data)
    {
        var model = GetString(data, "embeddingModel");
        if (model != "bgem3" && model != "e5-small") return;
        var name = model == "e5-small" ? "Multilingual-E5-Small" : "BGE-M3";
        var requires = GetString(data, "requires", "rebuild");
        if (requires == "clear")
        {
            var clear = MessageBox.Show(
                $"切换到 {name} 需要清空旧索引元数据（当前没有可重建的向量数据）。\n\n确定：清空索引并切换\n取消：保持当前模型",
                "嵌入模型切换", MessageBoxButton.OKCancel, MessageBoxImage.Warning, MessageBoxResult.Cancel);
            if (clear == MessageBoxResult.OK)
            {
                SendCyreneSave(new Dictionary<string, object?> { ["embeddingModel"] = model, ["embeddingModelAction"] = "clear" });
            }
            else
            {
                RefreshSection("cyrene");
            }
            return;
        }

        var result = MessageBox.Show(
            $"切换到 {name} 需要迁移旧索引。\n\n" +
            "是(Y)：重建索引（先备份记忆，再全量重新嵌入；保留记忆，可能耗时较长）\n" +
            "否(N)：清空索引（删除旧向量记忆后切换，不可恢复）\n" +
            "取消：保持当前模型",
            "嵌入模型切换", MessageBoxButton.YesNoCancel, MessageBoxImage.Warning, MessageBoxResult.Cancel);
        if (result == MessageBoxResult.Yes)
        {
            SendCyreneSave(new Dictionary<string, object?> { ["embeddingModel"] = model, ["embeddingModelAction"] = "rebuild" });
        }
        else if (result == MessageBoxResult.No)
        {
            SendCyreneSave(new Dictionary<string, object?> { ["embeddingModel"] = model, ["embeddingModelAction"] = "clear" });
        }
        else
        {
            RefreshSection("cyrene");
        }
    }

    /// <summary>模型安装说明弹窗（应用内步骤 + 打开目录/下载站/刷新状态）。</summary>
    private void OpenModelDocsDialog()
    {
        var cyrene = GetNode("cyrene");
        var modelsDir = GetString(cyrene, "modelsDir");
        var mirror = GetString("ragDownloadMirror", "official");
        var dialog = new ModelDocsDialog(
            modelsDir.Length > 0 ? modelsDir : "(点下方「打开模型目录」自动创建)",
            mirror) { Owner = _window };
        dialog.ShowDialog();
    }

    /// <summary>RAG 模型卡片：标题 + 说明 + 状态；selected = 高亮，onClick 为空则只读。</summary>
    private static Border MakeModelCard(
        string title,
        string description,
        string status,
        bool selected,
        Action? onClick)
    {
        var content = new StackPanel();
        content.Children.Add(new TextBlock
        {
            Text = title,
            FontSize = 14,
            FontWeight = FontWeights.SemiBold,
            Foreground = NativeTheme.TextStrongBrush,
        });
        content.Children.Add(new TextBlock
        {
            Text = description,
            FontSize = 14,
            Foreground = NativeTheme.TextMutedBrush,
            TextWrapping = TextWrapping.Wrap,
            Margin = new Thickness(0, 2, 0, 0),
        });
        content.Children.Add(new TextBlock
        {
            Text = status,
            FontSize = 14,
            Foreground = selected ? NativeTheme.PinkBrush : NativeTheme.TextMutedBrush,
            Margin = new Thickness(0, 4, 0, 0),
        });
        var card = new Border
        {
            CornerRadius = new CornerRadius(10),
            Padding = new Thickness(12, 10, 12, 10),
            Margin = new Thickness(0, 6, 0, 6),
            Child = content,
            Cursor = onClick is null ? System.Windows.Input.Cursors.Arrow : System.Windows.Input.Cursors.Hand,
            Tag = selected,
        };
        ApplyModelCardSelected(card, selected);
        if (onClick is not null)
        {
            card.MouseLeftButtonUp += (_, _) => onClick();
        }
        return card;
    }

    /// <summary>切换模型卡片选中态（边框/底色/状态行色）。</summary>
    private static void ApplyModelCardSelected(Border card, bool selected)
    {
        card.Tag = selected;
        card.BorderBrush = selected ? NativeTheme.PinkBrush : NativeTheme.BorderSoftBrush;
        card.BorderThickness = new Thickness(selected ? 2 : 1);
        card.Background = selected
            ? new SolidColorBrush(Color.FromArgb(0x14, 0xFF, 0x5B, 0x8A))
            : Brushes.White;
        if (card.Child is StackPanel content && content.Children.Count >= 3
            && content.Children[2] is TextBlock status)
        {
            status.Foreground = selected ? NativeTheme.PinkBrush : NativeTheme.TextMutedBrush;
        }
    }

    /// <summary>删除选中 embedding 模型（native 侧确认框；宿主只做删除，项目 models 目录 + HF 缓存两处都清）。</summary>
    private void ConfirmDeleteEmbeddingCache(string modelKey)
    {
        var label = modelKey == "e5-small" ? "Multilingual-E5-Small" : "BGE-M3";
        if (MessageBox.Show($"确定删除 {label} 模型？将移除项目 models 目录与 HF 缓存中的模型文件，下次使用需重新安装（见「模型安装说明」）。", "删除模型",
                MessageBoxButton.OKCancel, MessageBoxImage.Warning) != MessageBoxResult.OK)
        {
            return;
        }
        RequestRouter.SendSettingsAction("cyrene", "delete-embedding", new Dictionary<string, object?> { ["model"] = modelKey });
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
        FontSize = 14,
        Padding = new Thickness(6, 4, 6, 4),
        VerticalContentAlignment = VerticalAlignment.Center,
    };
    private readonly TextBox _idBox = new() { Width = 200, FontSize = 14, Padding = new Thickness(6, 4, 6, 4) };
    private readonly TextBox _descriptionBox = new() { Width = 300, FontSize = 14, Padding = new Thickness(6, 4, 6, 4) };
    private readonly TextBox _phrasesBox = new()
    {
        Width = 300,
        Height = 84,
        FontSize = 14,
        AcceptsReturn = true,
        TextWrapping = TextWrapping.Wrap,
        VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
        Padding = new Thickness(6, 4, 6, 4),
    };
    private readonly TextBlock _status = new()
    {
        FontSize = 14,
        Foreground = new SolidColorBrush(Color.FromRgb(0xD3, 0x3A, 0x3A)),
        Margin = new Thickness(0, 6, 0, 0),
        TextWrapping = TextWrapping.Wrap,
    };
    private string? _pickedPath;

    public StickerAddDialog()
    {
        Title = "添加表情包";
        Icon = AppIcons.Image;
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
            FontSize = 14,
            FontWeight = FontWeights.SemiBold,
            Foreground = NativeTheme.TextStrongBrush,
        });
        copy.Children.Add(new TextBlock
        {
            Text = description,
            FontSize = 14,
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

/// <summary>
/// 模型安装说明弹窗（应用内，不依赖外网文档）：
/// 下载源 → 需要的文件 → 放置目录 → 回本页刷新状态；
/// 底部一键「打开模型目录 / 打开下载站 / 刷新状态 / 复制路径」。
/// </summary>
internal sealed class ModelDocsDialog : Window
{
    public ModelDocsDialog(string modelsDir, string mirror)
    {
        var mirrorText = mirror == "hf-mirror"
            ? "hf-mirror（国内镜像；官方源 huggingface.co 在本机网络不可达时用它）"
            : "官方源（huggingface.co；国内网络建议先切到 hf-mirror）";
        Title = "模型安装说明";
        Icon = AppIcons.Image;
        Width = 600;
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

        root.Children.Add(Section(
            "1 · 选择下载源",
            $"当前设置：{mirrorText}。\n下载站按当前镜像源打开；要换源请回设置页改「下载镜像源」后再点这里。"));
        root.Children.Add(Section(
            "2 · 下载模型文件",
            "BGE-M3（约 570MB，必装）：tokenizer.json、config.json、onnx/model_quantized.onnx。\n" +
            "Multilingual-E5-Small（约 120MB，可选）：文件同上，放在 Xenova/multilingual-e5-small/。\n" +
            "bge-reranker-base（约 279MB，可选）与 bge-reranker-v2-m3（约 570MB，可选）：文件同上。\n" +
            "所有文件的相对路径必须保持不变（onnx 文件夹里的模型文件尤其别改名）。"));
        root.Children.Add(Section(
            "3 · 放置到模型目录",
            $"把整个模型文件夹放到：\n{modelsDir}\\Xenova\\bge-m3\\（BGE-M3）\n" +
            $"{modelsDir}\\Xenova\\multilingual-e5-small\\（E5-Small）\n" +
            $"{modelsDir}\\bge-reranker-base\\（重排，可选）\n" +
            $"{modelsDir}\\bge-reranker-v2-m3\\（重排 v2，可选）\n" +
            "每个目录内应直接看到 tokenizer.json 与 onnx\\model_quantized.onnx。"));
        root.Children.Add(Section(
            "4 · 回来刷新状态",
            "点下方「刷新状态」重新体检；模型卡从「未下载」变成「已下载」即安装成功。\n" +
            "「删除模型」会删掉已安装的模型文件（项目 models 目录 + HF 缓存），需按本说明重新安装。"));

        var actions = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            HorizontalAlignment = HorizontalAlignment.Right,
            Margin = new Thickness(0, 12, 0, 0),
        };
        actions.Children.Add(DialogAction("📂 打开模型目录", () =>
            RequestRouter.SendSettingsAction("cyrene", "open-model-dir")));
        actions.Children.Add(DialogAction("🌐 打开下载站", () =>
            RequestRouter.SendSettingsAction("cyrene", "open-model-site")));
        actions.Children.Add(DialogAction("🔄 刷新状态", () =>
        {
            RequestRouter.SendSettingsAction("cyrene", "check-model-update");
            Close();
        }, primary: true));
        actions.Children.Add(DialogAction("关闭", Close));
        root.Children.Add(actions);
    }

    private static StackPanel Section(string title, string body)
    {
        var panel = new StackPanel { Margin = new Thickness(0, 4, 0, 8) };
        panel.Children.Add(new TextBlock
        {
            Text = title,
            FontSize = 14,
            FontWeight = FontWeights.SemiBold,
            Foreground = NativeTheme.TextStrongBrush,
        });
        panel.Children.Add(new TextBlock
        {
            Text = body,
            FontSize = 13,
            Foreground = NativeTheme.TextMutedBrush,
            TextWrapping = TextWrapping.Wrap,
            Margin = new Thickness(0, 3, 0, 0),
        });
        return panel;
    }

    private static Button DialogAction(string text, Action onClick, bool primary = false)
    {
        var button = new Button
        {
            Content = text,
            MinWidth = 96,
            Margin = new Thickness(8, 0, 0, 0),
            Style = primary ? NativeTheme.PrimaryButtonStyle : NativeTheme.SecondaryButtonStyle,
        };
        button.Click += (_, _) => onClick();
        return button;
    }
}

using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;

namespace CyreneNative;

/// <summary>
/// 设置窗「偏好设置」section（对位 Electron preferences）：
/// 截图方式（内置 / Snipaste + 路径）、手机信息分段、自定义风格（采样弹窗 +
/// 打开 Prompt 文件）、主动聊天（含投递目标）、朋友圈动态（含三个子开关与
/// 热闹程度）、聊天上下文增强、CITA（含语义认知方式）。
///
/// 数据：state.settings.preferences（core-bootstrap.getSettingsSnapshot；
///       proactiveDelivery 为渠道可用性，与渲染页 isProactiveDeliveryTargetSelectable 同口径）
/// 动作：settings.set（键白名单在 native-settings-protocol）+ preferences open-prompt
/// 说明：默认模式 / 分段输出 / 语义认知方式在旧版即为禁用占位，这里保持只读。
/// </summary>
public sealed partial class SettingsWindow
{
    private FrameworkElement BuildPreferencesSection()
    {
        var panel = new StackPanel();
        panel.Children.Add(MakeHeader("偏好设置"));
        panel.Children.Add(MakeHint("设置聊天窗口和输出行为的默认偏好（对齐 Electron 偏好设置）。"));
        panel.Children.Add(MakeSectionStatus("preferences"));

        var prefs = GetNode("preferences");

        // ── 只读占位（旧版即禁用控件：默认模式 / 分段输出） ──
        panel.Children.Add(MakeDescribedRow("默认模式",
            "打开聊天窗口时默认使用的模式；窗口内仍可临时切换。",
            MakeChoiceGroup(
                new[] { ("work", "Work", false), ("chat", "Chat", false) },
                GetString(prefs, "defaultChatMode", "chat"), null)));
        panel.Children.Add(MakeDescribedRow("分段输出",
            "控制昔涟回复在聊天气泡中的分段显示；不会改变模型实际回复内容。",
            MakeChoiceGroup(
                new[] { ("all", "所有", false), ("chat", "聊天", false), ("off", "关闭", false) },
                GetString(prefs, "segmentedOutputMode", "off"), null)));

        // ── 截图 ──
        panel.Children.Add(MakeSubHeader("截图"));
        var snipastePathRow = MakeDescribedRow("Snipaste 路径",
            "留空自动检测；也可填写 Snipaste.exe 的完整路径。",
            MakeTextControl(GetString(prefs, "snipastePath"),
                v => SetSetting("snipastePath", v), 260,
                @"自动检测（如 C:\Program Files\Snipaste\Snipaste.exe）"));
        var snipasteActive = GetString(prefs, "screenshotBackend", "builtin") == "snipaste";
        snipastePathRow.Visibility = snipasteActive ? Visibility.Visible : Visibility.Collapsed;
        panel.Children.Add(MakeDescribedRow("截图方式",
            "内置截图组件，或调用系统中安装的 Snipaste（需已启动；路径留空自动检测）。",
            MakeChoiceGroup(
                new[] { ("builtin", "内置", true), ("snipaste", "Snipaste", true) },
                GetString(prefs, "screenshotBackend", "builtin"),
                v =>
                {
                    snipastePathRow.Visibility = v == "snipaste" ? Visibility.Visible : Visibility.Collapsed;
                    SetSetting("screenshotBackend", v);
                })));
        panel.Children.Add(snipastePathRow);

        // ── 消息 ──
        panel.Children.Add(MakeSubHeader("消息"));
        panel.Children.Add(MakeDescribedRow("手机信息分段",
            "连接手机回复会按 。！？； 拆成多条发送；请在关闭工具使用后开启。",
            MakeChoiceGroup(
                new[] { ("off", "关闭", true), ("on", "开启", true) },
                GetString(prefs, "mobileMessageSegmentation", "off"),
                v => SetSetting("mobileMessageSegmentation", v))));

        // ── 自定义风格 ──
        panel.Children.Add(MakeSubHeader("自定义风格"));
        var styleActions = new StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center };
        styleActions.Children.Add(MakeButton("自定义风格采样", OpenCustomStyleDialog, minWidth: 130));
        styleActions.Children.Add(MakeButton("打开 Prompt 文件",
            () => RequestRouter.SendSettingsAction("preferences", "open-prompt"), minWidth: 130));
        panel.Children.Add(MakeDescribedRow("自定义风格",
            "配置聊天窗口“自定义”风格的采样参数，或打开自定义 Prompt 文件。",
            styleActions));

        // ── 主动聊天 ──
        panel.Children.Add(MakeSubHeader("主动聊天"));
        // 渠道可用性：仅运行中的渠道可选（与渲染页 isProactiveDeliveryTargetSelectable 同口径）
        var deliveryAvailability = GetNode(prefs, "proactiveDelivery");
        bool DeliveryEnabled(string target) => target == "local"
            || (deliveryAvailability.ValueKind == JsonValueKind.Object
                && deliveryAvailability.TryGetProperty(target, out var allowed)
                && allowed.ValueKind == JsonValueKind.True);
        var deliveryRow = MakeDescribedRow("主动消息发送到",
            "手机渠道不可用时，本次主动消息会取消，不会改发到本地。",
            MakeChoiceGroup(
                new[]
                {
                    ("local", "仅本地", true),
                    ("wechat", "仅微信", DeliveryEnabled("wechat")),
                    ("feishu", "仅飞书", DeliveryEnabled("feishu")),
                },
                GetString(prefs, "proactiveDeliveryTarget", "local"),
                v => SetSetting("proactiveDeliveryTarget", v)));
        deliveryRow.Visibility = GetString(prefs, "proactiveChatMode", "off") == "on"
            ? Visibility.Visible
            : Visibility.Collapsed;
        panel.Children.Add(MakeDescribedToggleRow("主动聊天",
            "昔涟会在合适的时间主动发起对话；深夜无操作、正常聊天中和连续两次未回复时不会打扰。",
            GetString(prefs, "proactiveChatMode", "off") == "on",
            v =>
            {
                deliveryRow.Visibility = v ? Visibility.Visible : Visibility.Collapsed;
                SetSetting("proactiveChatMode", v ? "on" : "off");
            }));
        panel.Children.Add(deliveryRow);

        // ── 朋友圈动态 ──
        panel.Children.Add(MakeSubHeader("朋友圈动态"));
        var postingRow = MakeDescribedToggleRow("昔涟主动发动态",
            "对话结束后，昔涟会把值得记录的时刻发成动态；每天最多 2 条，间隔至少 6 小时。",
            GetBool(prefs, "cyreneMomentsPostingEnabled"),
            v => SetSetting("cyreneMomentsPostingEnabled", v));
        var reactionsRow = MakeDescribedToggleRow("昔涟互动动态",
            "昔涟会为你的动态点赞、评论，并回复评论区中对她的留言。",
            GetBool(prefs, "cyreneMomentsReactionsEnabled", true),
            v => SetSetting("cyreneMomentsReactionsEnabled", v));
        var characterRow = MakeDescribedToggleRow("角色互动动态",
            "长夜月、万敌等入驻角色会刷到朋友圈，按各自性格点赞、评论和互聊；每日模型调用上限随热闹程度联动。",
            GetBool(prefs, "momentsCharacterReactionsEnabled", true),
            v => SetSetting("momentsCharacterReactionsEnabled", v));
        var livelinessRow = MakeDescribedRow("朋友圈热闹程度",
            "控制每条动态被多少角色刷到：冷清偶尔无人回应，热闹几乎每条都有人冒头。",
            MakeChoiceGroup(
                new[] { ("quiet", "冷清", true), ("natural", "自然", true), ("lively", "热闹", true) },
                GetString(prefs, "momentsLiveliness", "quiet"),
                v => SetSetting("momentsLiveliness", v)));
        var momentsOn = GetBool(prefs, "momentsEnabled", true);
        void ApplyMomentsSubRows(bool visible)
        {
            var visibility = visible ? Visibility.Visible : Visibility.Collapsed;
            postingRow.Visibility = visibility;
            reactionsRow.Visibility = visibility;
            characterRow.Visibility = visibility;
            livelinessRow.Visibility = visibility;
        }
        ApplyMomentsSubRows(momentsOn);
        panel.Children.Add(MakeDescribedToggleRow("朋友圈动态",
            "开启动态功能；关闭后昔涟停止发帖与点赞评论，对话也不再参考动态内容。",
            momentsOn,
            v =>
            {
                ApplyMomentsSubRows(v);
                SetSetting("momentsEnabled", v);
            }));
        panel.Children.Add(postingRow);
        panel.Children.Add(reactionsRow);
        panel.Children.Add(characterRow);
        panel.Children.Add(livelinessRow);

        // ── 上下文 ──
        panel.Children.Add(MakeSubHeader("上下文"));
        panel.Children.Add(MakeDescribedToggleRow("聊天上下文增强",
            "仅在 Chat 模式下使用相关的过去信息和未接话题，让连续交流更自然；每轮最多增加一次异步模型调用。",
            GetBool(prefs, "chatSocialContextEnabled"),
            v => SetSetting("chatSocialContextEnabled", v)));

        // ── CITA ──
        panel.Children.Add(MakeSubHeader("CITA 上下文认知"));
        var engineRow = MakeDescribedRow("语义认知方式",
            "本地语义模型将在后续版本开放。",
            MakeChoiceGroup(
                new[] { ("remote", "在线大模型", true), ("local", "本地语义模型（暂不可用）", false) },
                GetString(prefs, "citaSemanticEngine", "remote"), null));
        engineRow.Visibility = GetBool(prefs, "citaEnabled") ? Visibility.Visible : Visibility.Collapsed;
        panel.Children.Add(MakeDescribedToggleRow("CITA 上下文认知",
            "辅助昔涟理解跨轮状态、指代和省略表达。",
            GetBool(prefs, "citaEnabled"),
            v =>
            {
                engineRow.Visibility = v ? Visibility.Visible : Visibility.Collapsed;
                SetSetting("citaEnabled", v);
            }));
        panel.Children.Add(engineRow);

        return panel;
    }

    /// <summary>自定义风格采样弹窗：保存后写 customStyle（宿主归一化 clamp）。</summary>
    private void OpenCustomStyleDialog()
    {
        var prefs = GetNode("preferences");
        var dialog = new CustomStyleDialog(GetNode(prefs, "customStyle")) { Owner = _window };
        if (dialog.ShowDialog() != true) return;
        SetSetting("customStyle", dialog.BuildConfig());
        _lastNotices["preferences"] = ("自定义风格采样已保存（后续请求生效）", "ok");
        RenderNotice("preferences");
    }
}

/// <summary>
/// 自定义风格采样对话框（对位旧版 custom-style modal）：
/// 多样性（跟随模型 / Temperature / Top-P + 数值）与重复控制（4 档）。
/// 仅产出配置对象，落盘由 SettingsWindow 经 settings.set 交给宿主归一化。
/// </summary>
internal sealed class CustomStyleDialog : Window
{
    private readonly RadioButton _driverDefault = new() { Content = "跟随模型", GroupName = "cs-driver", Margin = new Thickness(0, 0, 16, 0) };
    private readonly RadioButton _driverTemperature = new() { Content = "Temperature", GroupName = "cs-driver", Margin = new Thickness(0, 0, 16, 0) };
    private readonly RadioButton _driverTopP = new() { Content = "Top-P", GroupName = "cs-driver", Margin = new Thickness(0, 0, 16, 0) };
    private readonly TextBlock _valueLabel = new()
    {
        Text = "Temperature",
        FontSize = 12,
        VerticalAlignment = VerticalAlignment.Center,
        Margin = new Thickness(0, 0, 8, 0),
    };
    private readonly TextBox _valueBox = new() { Width = 90, FontSize = 12, Padding = new Thickness(6, 4, 6, 4) };
    private readonly StackPanel _valueRow;
    private readonly Dictionary<string, RadioButton> _repetitionButtons = new();
    private readonly TextBlock _status = new()
    {
        FontSize = 12,
        Foreground = new SolidColorBrush(Color.FromRgb(0xD3, 0x3A, 0x3A)),
        Margin = new Thickness(0, 6, 0, 0),
        TextWrapping = TextWrapping.Wrap,
    };

    public CustomStyleDialog(JsonElement config)
    {
        Title = "自定义风格采样";
        Width = 432;
        SizeToContent = SizeToContent.Height;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;
        ResizeMode = ResizeMode.NoResize;
        ShowInTaskbar = false;
        WindowStyle = WindowStyle.None;
        AllowsTransparency = true;
        Background = Brushes.Transparent;
        NativeTheme.Apply(this);

        var (driver, value, repetition) = ParseConfig(config);

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

        root.Children.Add(new TextBlock
        {
            Text = "多样性控制",
            FontSize = 13,
            FontWeight = FontWeights.SemiBold,
            Foreground = NativeTheme.TextStrongBrush,
            Margin = new Thickness(0, 0, 0, 6),
        });
        var driverRow = new StackPanel { Orientation = Orientation.Horizontal };
        driverRow.Children.Add(_driverDefault);
        driverRow.Children.Add(_driverTemperature);
        driverRow.Children.Add(_driverTopP);
        root.Children.Add(driverRow);

        _valueRow = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 8, 0, 0) };
        _valueRow.Children.Add(_valueLabel);
        _valueRow.Children.Add(_valueBox);
        root.Children.Add(_valueRow);

        root.Children.Add(new TextBlock
        {
            Text = "重复控制",
            FontSize = 13,
            FontWeight = FontWeights.SemiBold,
            Foreground = NativeTheme.TextStrongBrush,
            Margin = new Thickness(0, 16, 0, 6),
        });
        var repetitionPanel = new StackPanel();
        foreach (var (key, text) in new[]
                 {
                     ("model-default", "跟随模型"),
                     ("light", "轻度抑制"),
                     ("medium", "中度抑制"),
                     ("strong", "重度抑制"),
                 })
        {
            var radio = new RadioButton { Content = text, GroupName = "cs-repetition", Margin = new Thickness(0, 2, 0, 2) };
            _repetitionButtons[key] = radio;
            repetitionPanel.Children.Add(radio);
        }
        root.Children.Add(repetitionPanel);

        root.Children.Add(_status);

        // 初始选中
        _driverDefault.IsChecked = driver == "model-default";
        _driverTemperature.IsChecked = driver == "temperature";
        _driverTopP.IsChecked = driver == "top-p";
        _valueBox.Text = driver == "model-default" ? "" : value.ToString("0.##", CultureInfo.InvariantCulture);
        foreach (var (key, radio) in _repetitionButtons) radio.IsChecked = key == repetition;
        UpdateDiversityRow();
        _driverDefault.Checked += (_, _) => UpdateDiversityRow();
        _driverTemperature.Checked += (_, _) => UpdateDiversityRow();
        _driverTopP.Checked += (_, _) => UpdateDiversityRow();

        var actions = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            HorizontalAlignment = HorizontalAlignment.Right,
            Margin = new Thickness(0, 12, 0, 0),
        };
        actions.Children.Add(MakeDialogButton("恢复默认", () =>
        {
            _driverDefault.IsChecked = true;
            foreach (var (key, radio) in _repetitionButtons) radio.IsChecked = key == "model-default";
            _valueBox.Text = "";
            UpdateDiversityRow();
        }));
        actions.Children.Add(MakeDialogButton("取消", () =>
        {
            DialogResult = false;
            Close();
        }));
        actions.Children.Add(MakeDialogButton("保存", Save, primary: true));
        root.Children.Add(actions);
    }

    private static (string Driver, double Value, string Repetition) ParseConfig(JsonElement config)
    {
        var driver = "model-default";
        var value = 0.7;
        var repetition = "model-default";
        if (config.ValueKind == JsonValueKind.Object)
        {
            if (config.TryGetProperty("diversity", out var diversity) && diversity.ValueKind == JsonValueKind.Object)
            {
                if (diversity.TryGetProperty("driver", out var driverEl) && driverEl.ValueKind == JsonValueKind.String)
                {
                    var raw = driverEl.GetString();
                    if (raw == "temperature" || raw == "top-p") driver = raw;
                }
                if (diversity.TryGetProperty("value", out var valueEl)
                    && valueEl.ValueKind == JsonValueKind.Number
                    && valueEl.TryGetDouble(out var parsed))
                {
                    value = parsed;
                }
                else if (driver == "top-p")
                {
                    value = 1;
                }
            }
            if (config.TryGetProperty("repetition", out var repetitionEl) && repetitionEl.ValueKind == JsonValueKind.String)
            {
                var raw = repetitionEl.GetString();
                if (raw is "light" or "medium" or "strong") repetition = raw;
            }
        }
        return (driver, value, repetition);
    }

    private string SelectedDriver
        => _driverTemperature.IsChecked == true ? "temperature"
            : _driverTopP.IsChecked == true ? "top-p"
            : "model-default";

    private void UpdateDiversityRow()
    {
        var driver = SelectedDriver;
        _valueRow.Visibility = driver == "model-default" ? Visibility.Collapsed : Visibility.Visible;
        _valueLabel.Text = driver == "top-p" ? "Top-P" : "Temperature";
    }

    private void Save()
    {
        var driver = SelectedDriver;
        if (driver != "model-default"
            && !double.TryParse(_valueBox.Text.Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out _))
        {
            _status.Text = "请填写有效数值（Temperature 0~2 / Top-P 0~1）。";
            return;
        }
        DialogResult = true;
        Close();
    }

    /// <summary>产出 customStyle 配置（数值范围由宿主 normalizeCustomStyleConfig 兜底 clamp）。</summary>
    public Dictionary<string, object?> BuildConfig()
    {
        var driver = SelectedDriver;
        object diversity = driver == "model-default"
            ? new Dictionary<string, object?> { ["driver"] = "model-default" }
            : new Dictionary<string, object?>
            {
                ["driver"] = driver,
                ["value"] = Math.Round(
                    double.TryParse(_valueBox.Text.Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out var value)
                        ? value
                        : (driver == "top-p" ? 1 : 0.7),
                    2),
            };
        var repetition = "model-default";
        foreach (var (key, radio) in _repetitionButtons)
        {
            if (radio.IsChecked == true) repetition = key;
        }
        return new Dictionary<string, object?> { ["diversity"] = diversity, ["repetition"] = repetition };
    }

    private static Button MakeDialogButton(string text, Action onClick, bool primary = false)
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
}

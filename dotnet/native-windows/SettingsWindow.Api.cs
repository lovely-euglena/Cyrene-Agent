using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Input;
using System.Windows.Media;

namespace CyreneNative;

/// <summary>
/// 设置窗「API 与模型」section（WPF 重写，逐项对齐 Electron settings 页 pearl-white）：
///   - 面板卡（标题砖 48×48 + 标题/副标题）——对齐 .settings-panel / .panel-heading
///   - 已保存档案：标题行（右侧计数）+ 档案卡网格（默认/多模态徽标，点击载入）
///   - 厂商预设：72×75 卡片行（logo 24 + 短名，选中粉底；点击 = 新建草稿）
///   - 自定义端点：云端/本地模式切换卡（仅选中自定义端点时出现）
///   - 档案表单：昵称+官网 / API Key(+提示) / Base URL(+重置+请求地址预览) /
///     协议卡（openai/anthropic/responses）/ 模型名(+候选) / 上下文 / 多模态开关行
///   - 安全提示条、操作行（状态 + 删除档案/测试连接/保存档案）、测试超时(+重置)
///   - 自定义端点覆盖（删 max_token / 强制启用思考 / 强制禁用思考；仅自定义端点显示）
///   - 视觉模型（全局）：标题 + 三框 + 测试按钮（多模态开时隐藏字段，与渲染页一致）
///
/// 数据：state.settings.api（native-settings-sections.buildApiSectionSnapshot）
/// 动作：cmd settings api { save / test / test-vision / set-default-profile / delete-profile }
/// 反馈：state.settings-notice（保存/连接结果就地显示，不重建表单）
///
/// 表单状态保存在 _apiForm（跨 section 重建保留用户未保存输入；仅在首次拿到
/// 快照数据时从 config 初始化；载入档案 / 应用预设会改写它）。
/// </summary>
public sealed partial class SettingsWindow
{
    private sealed class ApiFormState
    {
        public string? ProfileId;
        public string Provider = "";
        public string DisplayName = "";
        public string BaseUrl = "";
        public string Model = "";
        public string ApiKey = "";
        public string Transport = "openai";
        /// <summary>0 = 空（保存时回落 256000，对齐 Electron 清空输入框的新建草稿）。</summary>
        public int ContextWindow = 256000;
        public bool Multimodal = true;
        public string VisionBaseUrl = "";
        public string VisionApiKey = "";
        public string VisionModel = "";
        public int ThinkingOverride;
        public bool DisableMaxToken;
    }

    private ApiFormState? _apiForm;

    // ── 文案（对齐 settings i18n zh-CN） ──

    private const string ApiHeadingHint = "先配置一个模型服务，后面昔涟会用它进行聊天和状态判断。";
    private const string ApiProfileListTitle = "已保存档案";
    private const string ApiProfileListSubtitle = "点击档案载入编辑；在聊天窗口的模型面板里切换使用。";
    private const string ApiProfileEmpty = "还没有档案。选下方厂商预设新建一个，保存后会出现在这里。";
    private const string ApiEditorSubtitle = "昵称用于区分同模型名、不同 API 的配置；上下文窗口与多模态跟随档案，聊天窗口切档案时自动生效。";
    private const string ApiPresetRowLabel = "新建档案 · 选择厂商预设";
    private const string ApiTransportHintDefault = "请按服务商实际提供的接口类型选择（OpenAI 兼容 / Anthropic 兼容 / OpenAI Responses）；程序不会自动识别协议。";
    private const string ApiTransportHintCustom = "请按自定义服务实际提供的接口类型选择；程序不会自动探测。";
    private const string ApiNoteDefault = "选择模型预设后会自动填入 Provider、Base URL 和模型名；你只需要填写对应平台的 API Key。配置只保存在本机 Electron 用户数据目录。";
    private const string ApiNoteCustom = "自定义端点按保守兼容模式运行。保存后请先测试连接；连接成功不代表结构化输出、工具调用或思考模式一定可用。";
    private const string ApiVisionDesc = "档案未开多模态时，用这里的独立视觉模型转述图片；留空则诚实告知看不了。";
    private const string ApiVisionHint = "ⓘ 该模型需支持 OpenAI 兼容的 /chat/completions 接口及 image_url 多模态能力";
    private const string ApiOverridesSubtitle = "仅在当前厂商为自定义端点时生效。";

    // ── section 构建 ──

    private FrameworkElement BuildApiSection()
    {
        var api = GetNode("api");
        var config = GetNode(api, "config");
        var presets = GetNode(api, "presets");
        var profiles = GetNode(api, "profiles");

        // 首次拿到快照数据时初始化表单状态；之后重建保留用户未保存输入
        if (_apiForm is null && config.ValueKind == JsonValueKind.Object)
        {
            _apiForm = new ApiFormState
            {
                Provider = GetString(config, "provider"),
                DisplayName = GetString(config, "displayName"),
                BaseUrl = GetString(config, "baseUrl"),
                Model = GetString(config, "model"),
                ApiKey = GetString(config, "apiKey"),
                Transport = GetString(config, "transport", "openai"),
                ContextWindow = GetInt(config, "contextWindowTokens", 256000),
                Multimodal = GetBool(config, "multimodal", true),
                ThinkingOverride = GetInt(config, "thinkingOverride", 0),
                DisableMaxToken = GetBool(config, "disableMaxToken"),
            };
            var vision = GetNode(config, "vision");
            _apiForm.VisionBaseUrl = GetString(vision, "baseUrl");
            _apiForm.VisionApiKey = GetString(vision, "apiKey");
            _apiForm.VisionModel = GetString(vision, "model");
        }
        var form = _apiForm ?? new ApiFormState();

        // 预设（含隐藏项）：可见项渲染卡片；隐藏项（本地模型）只参与查找
        var allPresets = new List<JsonElement>();
        if (presets.ValueKind == JsonValueKind.Array)
        {
            foreach (var preset in presets.EnumerateArray()) allPresets.Add(preset);
        }
        var visiblePresets = new List<JsonElement>();
        foreach (var preset in allPresets)
        {
            if (GetBool(preset, "hiddenInPresetList")) continue;
            visiblePresets.Add(preset);
        }

        JsonElement? FindPreset(string provider)
        {
            foreach (var preset in allPresets)
            {
                if (GetString(preset, "provider") == provider) return preset;
            }
            return null;
        }

        string ShortNameOf(string provider) => FindPreset(provider) is { } preset ? GetString(preset, "shortName", provider) : provider;

        string? CustomModeOf(string provider)
        {
            if (FindPreset(provider) is not { } preset) return null;
            var mode = GetString(preset, "customEndpointMode");
            return mode.Length > 0 ? mode : null;
        }

        string CustomProviderFor(string mode)
        {
            foreach (var preset in allPresets)
            {
                if (GetString(preset, "customEndpointMode") == mode) return GetString(preset, "provider");
            }
            return form.Provider;
        }

        List<string> ModelsOf(string provider)
        {
            var models = new List<string>();
            if (FindPreset(provider) is not { } preset) return models;
            var node = GetNode(preset, "mainModels");
            if (node.ValueKind != JsonValueKind.Array) return models;
            foreach (var model in node.EnumerateArray())
            {
                if (model.ValueKind == JsonValueKind.String) models.Add(model.GetString() ?? "");
            }
            return models;
        }

        // ── 表单控件 ──
        var displayNameBox = MakeLargeTextBox(form.DisplayName);
        var apiKeyBox = MakeLargePasswordBox(form.ApiKey);
        var baseUrlBox = MakeLargeTextBox(form.BaseUrl);
        var modelBox = MakeLargeTextBox(form.Model);
        var contextBox = MakeLargeTextBox(form.ContextWindow > 0 ? form.ContextWindow.ToString() : "");
        var testTimeoutBox = MakeLargeTextBox(GetInt(config, "testTimeout", 15000).ToString());
        var visionBaseUrlBox = MakeLargeTextBox(form.VisionBaseUrl);
        var visionApiKeyBox = MakeLargePasswordBox(form.VisionApiKey);
        var visionModelBox = MakeLargeTextBox(form.VisionModel);
        var modelCandidates = MakeSuggestionCombo(ModelsOf(form.Provider.Length > 0 ? form.Provider : GetString(config, "provider")), modelBox);
        var multimodalToggle = new CheckBox
        {
            IsChecked = form.Multimodal,
            Style = NativeTheme.SwitchStyle,
            Cursor = Cursors.Hand,
            VerticalAlignment = VerticalAlignment.Center,
        };

        var activeProvider = form.Provider.Length > 0 ? form.Provider : GetString(config, "provider");
        var activeMode = CustomModeOf(activeProvider);

        // ── 状态读写与就地交互 ──
        void CaptureForm()
        {
            form.DisplayName = displayNameBox.Text.Trim();
            form.ApiKey = apiKeyBox.Password.Trim();
            form.BaseUrl = baseUrlBox.Text.Trim();
            form.Model = modelBox.Text.Trim();
            form.ContextWindow = int.TryParse(contextBox.Text.Trim(), out var context) ? Math.Max(4096, context) : 0;
            form.VisionBaseUrl = visionBaseUrlBox.Text.Trim();
            form.VisionApiKey = visionApiKeyBox.Password.Trim();
            form.VisionModel = visionModelBox.Text.Trim();
            _apiForm = form;
        }

        string TransportValue() => form.Transport switch { "anthropic" => "anthropic", "responses" => "responses", _ => "openai" };

        var transportCards = new List<(Border Host, TextBlock Label, string Value)>();

        void SetTransportActive(string value)
        {
            foreach (var (host, label, cardValue) in transportCards)
            {
                var active = cardValue == value;
                host.Background = active ? NativeTheme.Pink50Brush : NativeTheme.CardSoftBgBrush;
                label.Foreground = active ? NativeTheme.Pink600Brush : NativeTheme.TextMutedBrush;
            }
        }

        void SetProvider(string provider)
        {
            form.ProfileId = null;
            form.Provider = provider;
            form.DisplayName = ShortNameOf(provider);
            form.ApiKey = "";
            form.BaseUrl = "";
            form.Model = "";
            form.ContextWindow = 0;
            form.Multimodal = true;
            if (FindPreset(provider) is { } preset)
            {
                form.Transport = GetString(preset, "transport", "openai");
                var anthropicUrl = GetString(preset, "anthropicBaseUrl");
                form.BaseUrl = form.Transport == "anthropic" && anthropicUrl.Length > 0
                    ? anthropicUrl
                    : GetString(preset, "baseUrl");
                var models = ModelsOf(provider);
                if (models.Count > 0) form.Model = models[0];
                var visionBase = GetString(preset, "visionBaseUrl");
                if (visionBase.Length > 0) form.VisionBaseUrl = visionBase;
                var visionModel = GetString(preset, "defaultVisionModel");
                if (visionModel.Length > 0) form.VisionModel = visionModel;
            }
            _apiForm = form;
            RefreshSection("api");
        }

        // 视觉字段显隐：多模态开启时隐藏（对齐 applyMultimodalUI）
        var visionWrap = new StackPanel();
        multimodalToggle.Checked += (_, _) =>
        {
            form.Multimodal = true;
            visionWrap.Visibility = Visibility.Collapsed;
        };
        multimodalToggle.Unchecked += (_, _) =>
        {
            form.Multimodal = false;
            visionWrap.Visibility = Visibility.Visible;
        };
        visionWrap.Visibility = form.Multimodal ? Visibility.Collapsed : Visibility.Visible;

        // ── 面板卡（对齐 .settings-panel） ──
        var content = new StackPanel();
        var card = new Border
        {
            Background = Brushes.White,
            BorderBrush = NativeTheme.BorderSoftBrush,
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(24),
            Padding = new Thickness(20),
            Child = content,
            Effect = NativeTheme.CardShadow(),
        };

        content.Children.Add(MakePanelHeading(
            NativeTheme.VectorGlyph(Glyphs.Key, 24, NativeTheme.PinkBrush),
            "API 设置",
            ApiHeadingHint));

        // ── 已保存档案 ──
        content.Children.Add(BuildProfileList(profiles, form.ProfileId, ShortNameOf, profile =>
        {
            _apiForm = new ApiFormState
            {
                ProfileId = GetString(profile, "id"),
                Provider = GetString(profile, "provider"),
                DisplayName = GetString(profile, "displayName"),
                BaseUrl = GetString(profile, "baseUrl"),
                Model = GetString(profile, "model"),
                ApiKey = GetString(profile, "apiKey"),
                Transport = GetString(profile, "transport", "openai"),
                ContextWindow = GetInt(profile, "contextWindowTokens", 256000),
                Multimodal = profile.TryGetProperty("multimodal", out var mm) && mm.ValueKind != JsonValueKind.Null
                    ? GetBool(profile, "multimodal", true)
                    : form.Multimodal,
                VisionBaseUrl = form.VisionBaseUrl,
                VisionApiKey = form.VisionApiKey,
                VisionModel = form.VisionModel,
                ThinkingOverride = form.ThinkingOverride,
                DisableMaxToken = form.DisableMaxToken,
            };
            RefreshSection("api");
        }));

        // ── 厂商预设卡 ──
        var presetSection = new StackPanel { Margin = new Thickness(0, 0, 0, 0) };
        presetSection.Children.Add(MakeText(ApiPresetRowLabel, 14, NativeTheme.TextDefaultBrush, weight: FontWeights.Medium, lineHeight: 21));
        var presetStrip = new StackPanel { Orientation = Orientation.Horizontal };
        var presetIndex = 0;
        foreach (var preset in visiblePresets)
        {
            var provider = GetString(preset, "provider");
            var shortName = GetString(preset, "shortName", provider);
            var mode = CustomModeOf(provider);
            var active = provider == activeProvider || (mode is not null && mode == activeMode);
            var presetCard = (Border)MakePresetCard(shortName, ProviderAssetOf(shortName), active, provider, () => SetProvider(provider));
            presetCard.Margin = new Thickness(0, 0, presetIndex < visiblePresets.Count - 1 ? 8 : 0, 0);
            presetStrip.Children.Add(presetCard);
            presetIndex++;
        }
        presetSection.Children.Add(new ScrollViewer
        {
            HorizontalScrollBarVisibility = ScrollBarVisibility.Auto,
            VerticalScrollBarVisibility = ScrollBarVisibility.Disabled,
            Margin = new Thickness(0, 7, 0, 0),
            Padding = new Thickness(0, 2, 0, 4),
            Content = presetStrip,
        });
        content.Children.Add(presetSection);

        // ── 自定义端点模式卡（仅自定义端点） ──
        if (activeMode is not null)
        {
            content.Children.Add(BuildCustomEndpointCard(activeMode, mode => SetProvider(CustomProviderFor(mode))));
        }

        // ── 编辑标题 ──
        var editorHeading = new StackPanel { Margin = new Thickness(0, 4, 0, 12) };
        editorHeading.Children.Add(MakeText(form.ProfileId is null ? "新建档案" : "编辑档案", 14, NativeTheme.TextStrongBrush,
            weight: FontWeights.SemiBold, lineHeight: 21));
        editorHeading.Children.Add(MakeText(ApiEditorSubtitle, 11.5, NativeTheme.TextDefaultBrush,
            lineHeight: 17.5, margin: new Thickness(0, 2, 0, 0)));
        content.Children.Add(editorHeading);

        // ── 表单网格（两列；跨列项整行） ──
        var formGrid = MakeFormGrid();
        var formRow = 0;
        void FormRow(FrameworkElement left, FrameworkElement? right = null, bool full = false)
        {
            formGrid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            if (right is null && !full)
            {
                // 半宽（左列）：右列留空
                left.Margin = new Thickness(0, 0, 7, 14);
                Grid.SetRow(left, formRow);
                Grid.SetColumn(left, 0);
                formGrid.Children.Add(left);
            }
            else if (right is null)
            {
                left.Margin = new Thickness(0, 0, 0, 14);
                Grid.SetRow(left, formRow);
                Grid.SetColumn(left, 0);
                Grid.SetColumnSpan(left, 2);
                formGrid.Children.Add(left);
            }
            else
            {
                left.Margin = new Thickness(0, 0, 7, 14);
                right.Margin = new Thickness(7, 0, 0, 14);
                Grid.SetRow(left, formRow);
                Grid.SetColumn(left, 0);
                Grid.SetRow(right, formRow);
                Grid.SetColumn(right, 1);
                formGrid.Children.Add(left);
                formGrid.Children.Add(right);
            }
            formRow++;
        }

        // 昵称 + 官网链接（官网缺失时隐藏链接）
        var nicknameRow = new Grid();
        nicknameRow.ColumnDefinitions.Add(new ColumnDefinition());
        nicknameRow.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        var nicknameHost = MakeInputHost(displayNameBox, "给模型起个名字");
        Grid.SetColumn(nicknameHost, 0);
        nicknameRow.Children.Add(nicknameHost);
        var websiteUrl = FindPreset(activeProvider) is { } websitePreset ? GetString(websitePreset, "websiteUrl") : "";
        if (websiteUrl.Length > 0)
        {
            var link = MakeWebsiteLink(websiteUrl, $"前往 {ShortNameOf(activeProvider)} 官网");
            link.Margin = new Thickness(8, 0, 0, 0);
            Grid.SetColumn(link, 1);
            nicknameRow.Children.Add(link);
        }
        FormRow(MakeField("昵称", nicknameRow),
            MakeFieldOf(activeMode == "local" ? "API Key（可选）" : "API Key",
                MakeInputHost(apiKeyBox, activeMode == "local" ? "无需鉴权时留空" : "sk-..."),
                MakeFieldHint(activeMode == "local"
                    ? "本地服务无需鉴权时可留空；如网关要求令牌，请在此填写"
                    : activeMode == "cloud"
                        ? "填写自定义服务或第三方代理提供的 API Key"
                        : "填写对应平台创建的 API Key")));

        // Base URL + 重置按钮 + 请求地址预览
        var endpointPreview = MakeFieldHint("");
        void UpdateEndpointPreview() => endpointPreview.Text = ResolveEndpointHint(baseUrlBox.Text.Trim(), TransportValue());
        baseUrlBox.TextChanged += (_, _) => UpdateEndpointPreview();
        var baseUrlReset = MakeMiniButton("↻", activeMode is null ? "重置为厂商默认 URL" : "清空自定义 Base URL", () =>
        {
            if (activeMode is not null)
            {
                baseUrlBox.Text = "";
            }
            else if (FindPreset(form.Provider) is { } preset)
            {
                var anthropicUrl = GetString(preset, "anthropicBaseUrl");
                baseUrlBox.Text = form.Transport == "anthropic" && anthropicUrl.Length > 0
                    ? anthropicUrl
                    : GetString(preset, "baseUrl");
            }
        });
        FormRow(MakeFieldOf("Base URL", MakeInputWithButton(baseUrlBox, baseUrlReset, activeMode switch
        {
            "cloud" => "https://your-provider.example/v1",
            "local" => "http://127.0.0.1:11434/v1",
            _ => "https://api.deepseek.com",
        }), endpointPreview), null, full: true);

        // 协议卡
        var transportGrid = MakeThreeColumnGrid();
        foreach (var (value, text, asset) in new[]
                 {
                     ("openai", "chat/completion", "openai"),
                     ("anthropic", "anthropic", "claude"),
                     ("responses", "Responses", "openai"),
                 })
        {
            var (host, label) = MakeTransportCard(text, asset, value == TransportValue());
            host.MouseLeftButtonUp += (_, _) =>
            {
                if (TransportValue() == value) return;
                form.Transport = value;
                // 协议切换：Base URL 仍是预设已知值时同步切换（与渲染页一致）
                if (FindPreset(form.Provider) is { } preset)
                {
                    var currentUrl = baseUrlBox.Text.Trim().TrimEnd('/');
                    var openAiUrl = GetString(preset, "baseUrl").TrimEnd('/');
                    var anthropicUrl = GetString(preset, "anthropicBaseUrl").TrimEnd('/');
                    if (currentUrl == openAiUrl || (anthropicUrl.Length > 0 && currentUrl == anthropicUrl))
                    {
                        baseUrlBox.Text = value == "anthropic" && anthropicUrl.Length > 0 ? anthropicUrl : openAiUrl;
                    }
                }
                SetTransportActive(value);
                UpdateEndpointPreview();
            };
            transportCards.Add((host, label, value));
            var column = (transportCards.Count - 1) * 2;
            Grid.SetColumn(host, column);
            transportGrid.Children.Add(host);
        }
        var transportField = new StackPanel();
        transportField.Children.Add(MakeFieldLabel("API 协议"));
        transportGrid.Margin = new Thickness(0, 7, 0, 0);
        transportField.Children.Add(transportGrid);
        transportField.Children.Add(MakeText(activeMode is null ? ApiTransportHintDefault : ApiTransportHintCustom,
            12, NativeTheme.TextMutedBrush, lineHeight: 18, margin: new Thickness(0, 7, 0, 0)));
        FormRow(transportField, null, full: true);

        // 模型名 + 常用模型候选
        var modelRow = new Grid();
        modelRow.ColumnDefinitions.Add(new ColumnDefinition());
        modelRow.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        var modelHost = MakeInputHost(modelBox, activeMode is null ? "选厂商后自动填入，可手填覆盖" : "填写服务实际提供的模型 ID");
        Grid.SetColumn(modelHost, 0);
        modelRow.Children.Add(modelHost);
        modelCandidates.Margin = new Thickness(8, 0, 0, 0);
        Grid.SetColumn(modelCandidates, 1);
        modelRow.Children.Add(modelCandidates);
        FormRow(MakeField("模型名", modelRow), null, full: true);

        FormRow(MakeFieldOf("上下文窗口（Token）", MakeInputHost(contextBox, "256000"),
            MakeFieldHint("按档案保存；留空按 256000。")));
        FormRow(BuildSettingRow("多模态（能直发图片）", "开启后图片直发该模型；关闭则走下方视觉模型转述。跟随档案生效。", multimodalToggle), null, full: true);
        UpdateEndpointPreview();
        content.Children.Add(formGrid);

        // ── 安全提示条 ──
        content.Children.Add(MakeNoteBar(activeMode is null ? ApiNoteDefault : ApiNoteCustom));

        // ── 操作行（状态 + 删除/测试/保存） ──
        var actions = new Grid();
        actions.ColumnDefinitions.Add(new ColumnDefinition());
        actions.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        var status = MakeSectionStatus("api");
        status.Margin = new Thickness(0, 0, 12, 0);
        status.VerticalAlignment = VerticalAlignment.Center;
        Grid.SetColumn(status, 0);
        actions.Children.Add(status);
        var actionButtons = new StackPanel { Orientation = Orientation.Horizontal };
        if (form.ProfileId is not null)
        {
            actionButtons.Children.Add(MakePillButton("删除档案", () =>
            {
                var title = form.DisplayName.Length > 0 ? form.DisplayName : form.Provider;
                if (MessageBox.Show($"删除档案「{title}」？（不影响已保存的模型服务配置）", "删除档案",
                        MessageBoxButton.OKCancel, MessageBoxImage.Warning) != MessageBoxResult.OK) return;
                RequestRouter.SendSettingsAction("api", "delete-profile",
                    new Dictionary<string, object?> { ["id"] = form.ProfileId });
            }, new Thickness(0, 0, 12, 0)));
        }
        actionButtons.Children.Add(MakePillButton("测试连接", () =>
        {
            CaptureForm();
            RequestRouter.SendSettingsAction("api", "test", new Dictionary<string, object?>
            {
                ["config"] = new Dictionary<string, object?>
                {
                    ["provider"] = form.Provider,
                    ["baseUrl"] = form.BaseUrl,
                    ["model"] = form.Model,
                    ["apiKey"] = form.ApiKey,
                    ["transport"] = TransportValue(),
                },
            });
        }, new Thickness(0, 0, 12, 0)));
        actionButtons.Children.Add(MakePillButton("保存档案", () =>
        {
            CaptureForm();
            form.Transport = TransportValue();
            form.Multimodal = multimodalToggle.IsChecked == true;
            var provider = form.Provider;
            if (provider.Length == 0 && visiblePresets.Count > 0) provider = GetString(visiblePresets[0], "provider");
            RequestRouter.SendSettingsAction("api", "save", new Dictionary<string, object?>
            {
                ["config"] = new Dictionary<string, object?>
                {
                    ["profileId"] = form.ProfileId,
                    ["provider"] = provider,
                    ["displayName"] = form.DisplayName,
                    ["baseUrl"] = form.BaseUrl,
                    ["model"] = form.Model,
                    ["apiKey"] = form.ApiKey,
                    ["transport"] = form.Transport,
                    ["contextWindowTokens"] = form.ContextWindow > 0 ? Math.Max(4096, form.ContextWindow) : 256000,
                    ["testTimeout"] = int.TryParse(testTimeoutBox.Text.Trim(), out var testTimeout)
                        ? Math.Max(1000, testTimeout)
                        : 15000,
                    ["multimodal"] = form.Multimodal,
                    ["thinkingOverride"] = form.ThinkingOverride,
                    ["disableMaxToken"] = form.DisableMaxToken,
                    ["vision"] = new Dictionary<string, object?>
                    {
                        ["baseUrl"] = form.VisionBaseUrl,
                        ["apiKey"] = form.VisionApiKey,
                        ["model"] = form.VisionModel,
                    },
                },
            });
        }, new Thickness(0)));
        Grid.SetColumn(actionButtons, 1);
        actions.Children.Add(actionButtons);
        content.Children.Add(actions);

        // ── 分隔线 + 测试超时 ──
        content.Children.Add(MakeDivider(new Thickness(0, 16, 0, 20)));
        var timeoutRow = new Grid();
        timeoutRow.ColumnDefinitions.Add(new ColumnDefinition());
        timeoutRow.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        var timeoutHost = MakeInputHost(testTimeoutBox, "单位ms（1s=1000ms）");
        Grid.SetColumn(timeoutHost, 0);
        timeoutRow.Children.Add(timeoutHost);
        var timeoutReset = MakeMiniButton("↻", "重置为默认（15s）", () => testTimeoutBox.Text = "15000");
        timeoutReset.Margin = new Thickness(8, 0, 0, 0);
        Grid.SetColumn(timeoutReset, 1);
        timeoutRow.Children.Add(timeoutReset);
        content.Children.Add(MakeField("测试超时（ms，1s=1000ms）", timeoutRow));

        // ── 自定义端点覆盖（仅自定义端点） ──
        if (activeMode is not null)
        {
            content.Children.Add(MakeDivider(new Thickness(0, 16, 0, 20)));
            var overridesHeading = new StackPanel { Margin = new Thickness(0, 0, 0, 14) };
            overridesHeading.Children.Add(MakeText("自定义端点覆盖选项", 20, NativeTheme.TextStrongBrush,
                weight: FontWeights.SemiBold, lineHeight: 28));
            overridesHeading.Children.Add(MakeText(ApiOverridesSubtitle, 14, NativeTheme.TextMutedBrush,
                lineHeight: 22.5, margin: new Thickness(0, 4, 0, 0)));
            content.Children.Add(overridesHeading);

            var enableThinking = new CheckBox
            {
                IsChecked = form.ThinkingOverride == 1,
                Style = NativeTheme.SwitchStyle,
                Cursor = Cursors.Hand,
                VerticalAlignment = VerticalAlignment.Center,
            };
            var disableThinking = new CheckBox
            {
                IsChecked = form.ThinkingOverride == -1,
                Style = NativeTheme.SwitchStyle,
                Cursor = Cursors.Hand,
                VerticalAlignment = VerticalAlignment.Center,
            };
            var disableMaxToken = new CheckBox
            {
                IsChecked = form.DisableMaxToken,
                Style = NativeTheme.SwitchStyle,
                Cursor = Cursors.Hand,
                VerticalAlignment = VerticalAlignment.Center,
            };
            enableThinking.Checked += (_, _) =>
            {
                if (disableThinking.IsChecked == true) disableThinking.IsChecked = false;
                form.ThinkingOverride = 1;
            };
            enableThinking.Unchecked += (_, _) =>
            {
                if (disableThinking.IsChecked != true) form.ThinkingOverride = 0;
            };
            disableThinking.Checked += (_, _) =>
            {
                if (enableThinking.IsChecked == true) enableThinking.IsChecked = false;
                form.ThinkingOverride = -1;
            };
            disableThinking.Unchecked += (_, _) =>
            {
                if (enableThinking.IsChecked != true) form.ThinkingOverride = 0;
            };
            disableMaxToken.Checked += (_, _) => form.DisableMaxToken = true;
            disableMaxToken.Unchecked += (_, _) => form.DisableMaxToken = false;

            var overrideList = new StackPanel();
            overrideList.Children.Add(BuildSettingRow("删除 max_token 限制", "删除所有请求的 max_token 限制，适用于本地模型。", disableMaxToken));
            overrideList.Children.Add(BuildSettingRow("强制启用模型思考", "强制模型进入思考模式。", enableThinking, topMargin: 10));
            overrideList.Children.Add(BuildSettingRow("强制禁用模型思考", "强制模型不输出思考过程。", disableThinking, topMargin: 10));
            content.Children.Add(overrideList);
        }

        // ── 视觉模型（全局） ──
        content.Children.Add(MakeDivider(new Thickness(0, 20, 0, 16)));
        var visionHeading = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 0, 0, 16) };
        var visionIcon = NativeTheme.VectorGlyph(Glyphs.ImageStroke, 24, NativeTheme.TextMutedBrush, fillData: Glyphs.ImageFrame);
        visionIcon.VerticalAlignment = VerticalAlignment.Center;
        visionIcon.Margin = new Thickness(0, 0, 12, 0);
        visionHeading.Children.Add(visionIcon);
        var visionCopy = new StackPanel { VerticalAlignment = VerticalAlignment.Center };
        visionCopy.Children.Add(MakeText("视觉模型（全局）", 16, NativeTheme.TextStrongBrush, weight: FontWeights.Bold, lineHeight: 24));
        visionCopy.Children.Add(MakeText(ApiVisionDesc, 12, NativeTheme.TextMutedBrush, lineHeight: 18, margin: new Thickness(0, 4, 0, 0)));
        visionHeading.Children.Add(visionCopy);
        content.Children.Add(visionHeading);

        var visionGrid = MakeFormGrid();
        visionGrid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        visionGrid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        var visionBaseField = MakeField("Base URL", MakeInputHost(visionBaseUrlBox, "https://api.openai.com/v1"));
        visionBaseField.Margin = new Thickness(0, 0, 0, 14);
        Grid.SetRow(visionBaseField, 0);
        Grid.SetColumn(visionBaseField, 0);
        Grid.SetColumnSpan(visionBaseField, 2);
        visionGrid.Children.Add(visionBaseField);
        var visionKeyField = MakeField("API Key", MakeInputHost(visionApiKeyBox, "sk-..."));
        visionKeyField.Margin = new Thickness(0, 0, 7, 0);
        Grid.SetRow(visionKeyField, 1);
        Grid.SetColumn(visionKeyField, 0);
        visionGrid.Children.Add(visionKeyField);
        var visionModelField = MakeField("视觉型号", MakeInputHost(visionModelBox, "gpt-4o / glm-5v-turbo / qwen-vl-max"));
        visionModelField.Margin = new Thickness(7, 0, 0, 0);
        Grid.SetRow(visionModelField, 1);
        Grid.SetColumn(visionModelField, 1);
        visionGrid.Children.Add(visionModelField);
        visionWrap.Children.Add(visionGrid);
        visionWrap.Children.Add(MakeText(ApiVisionHint, 11, NativeTheme.TextMutedBrush, lineHeight: 16.5, margin: new Thickness(0, 8, 0, 12)));
        visionWrap.Children.Add(MakePillButton("测试视觉模型", () =>
        {
            RequestRouter.SendSettingsAction("api", "test-vision", new Dictionary<string, object?>
            {
                ["config"] = new Dictionary<string, object?>
                {
                    ["baseUrl"] = visionBaseUrlBox.Text.Trim(),
                    ["apiKey"] = visionApiKeyBox.Password.Trim(),
                    ["model"] = visionModelBox.Text.Trim(),
                },
            });
        }, new Thickness(0)));
        content.Children.Add(visionWrap);

        return card;
    }

    // ── 控件工厂（对齐设置页 CSS 尺寸） ──

    private static TextBlock MakeText(string text, double size, Brush brush, FontWeight? weight = null,
        double lineHeight = 0, Thickness margin = default)
    {
        var block = new TextBlock
        {
            Text = text,
            FontSize = size,
            Foreground = brush,
            TextWrapping = TextWrapping.Wrap,
        };
        if (weight is { } w) block.FontWeight = w;
        if (lineHeight > 0)
        {
            block.LineHeight = lineHeight;
            block.LineStackingStrategy = LineStackingStrategy.BlockLineHeight;
        }
        if (margin != default) block.Margin = margin;
        return block;
    }

    private static TextBlock MakeFieldLabel(string text) =>
        MakeText(text, 14, NativeTheme.TextDefaultBrush, weight: FontWeights.Medium, lineHeight: 21);

    private static TextBlock MakeFieldHint(string text) =>
        MakeText(text, 12, NativeTheme.TextMutedBrush, lineHeight: 18);

    /// <summary>字段（标签 21 + 间距 7 + 控件）。</summary>
    private static StackPanel MakeField(string label, FrameworkElement control) => MakeFieldOf(label, control, null);

    private static StackPanel MakeFieldOf(string label, FrameworkElement control, TextBlock? hint)
    {
        var field = new StackPanel();
        field.Children.Add(MakeFieldLabel(label));
        control.Margin = new Thickness(0, 7, 0, 0);
        field.Children.Add(control);
        if (hint is not null)
        {
            hint.Margin = new Thickness(0, 7, 0, 0);
            field.Children.Add(hint);
        }
        return field;
    }

    private static TextBox MakeLargeTextBox(string text) => new()
    {
        Text = text,
        Style = NativeTheme.InputLargeStyle,
    };

    private static PasswordBox MakeLargePasswordBox(string password) => new()
    {
        Password = password,
        Style = NativeTheme.PasswordLargeStyle,
    };

    /// <summary>输入框 + 占位提示（WPF 无原生 placeholder，用覆盖层实现）。</summary>
    private static Grid MakeInputHost(TextBox box, string placeholder)
    {
        var host = new Grid();
        host.Children.Add(box);
        var hint = MakeText(placeholder, 16, NativeTheme.TextMutedBrush, margin: new Thickness(13, 0, 0, 0));
        hint.TextWrapping = TextWrapping.NoWrap;
        hint.TextTrimming = TextTrimming.CharacterEllipsis;
        hint.VerticalAlignment = VerticalAlignment.Center;
        hint.IsHitTestVisible = false;
        hint.Visibility = box.Text.Length == 0 ? Visibility.Visible : Visibility.Collapsed;
        box.TextChanged += (_, _) => hint.Visibility = box.Text.Length == 0 ? Visibility.Visible : Visibility.Collapsed;
        host.Children.Add(hint);
        return host;
    }

    /// <summary>密码框 + 占位提示。</summary>
    private static Grid MakeInputHost(PasswordBox box, string placeholder)
    {
        var host = new Grid();
        host.Children.Add(box);
        var hint = MakeText(placeholder, 16, NativeTheme.TextMutedBrush, margin: new Thickness(13, 0, 0, 0));
        hint.TextWrapping = TextWrapping.NoWrap;
        hint.VerticalAlignment = VerticalAlignment.Center;
        hint.IsHitTestVisible = false;
        hint.Visibility = box.Password.Length == 0 ? Visibility.Visible : Visibility.Collapsed;
        box.PasswordChanged += (_, _) => hint.Visibility = box.Password.Length == 0 ? Visibility.Visible : Visibility.Collapsed;
        host.Children.Add(hint);
        return host;
    }

    /// <summary>输入框 + 右侧小按钮（Base URL / 测试超时行）。</summary>
    private static Grid MakeInputWithButton(TextBox box, FrameworkElement button, string placeholder = "https://api.deepseek.com")
    {
        var host = new Grid();
        host.ColumnDefinitions.Add(new ColumnDefinition());
        host.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        var inputHost = MakeInputHost(box, placeholder);
        Grid.SetColumn(inputHost, 0);
        host.Children.Add(inputHost);
        button.Margin = new Thickness(8, 0, 0, 0);
        Grid.SetColumn(button, 1);
        host.Children.Add(button);
        return host;
    }

    /// <summary>36×48 重置钮（pearl-white .base-url-reset）。</summary>
    private static Border MakeMiniButton(string glyph, string tip, Action onClick)
    {
        var host = new Border
        {
            Width = 36,
            Height = 48,
            CornerRadius = new CornerRadius(12),
            Background = NativeTheme.ButtonSoftBgBrush,
            BorderBrush = NativeTheme.BorderSoftBrush,
            BorderThickness = new Thickness(1),
            Cursor = Cursors.Hand,
            ToolTip = tip,
            Child = new TextBlock
            {
                Text = glyph,
                FontSize = 16,
                Foreground = NativeTheme.TextMutedBrush,
                HorizontalAlignment = HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center,
            },
        };
        host.MouseEnter += (_, _) =>
        {
            host.BorderBrush = NativeTheme.Pink200Brush;
            ((TextBlock)host.Child).Foreground = NativeTheme.Pink600Brush;
        };
        host.MouseLeave += (_, _) =>
        {
            host.BorderBrush = NativeTheme.BorderSoftBrush;
            ((TextBlock)host.Child).Foreground = NativeTheme.TextMutedBrush;
        };
        host.MouseLeftButtonUp += (_, _) => onClick();
        return host;
    }

    /// <summary>胶囊主按钮（pearl-white .save-btn：粉底白字 + 全圆角）。</summary>
    private static Button MakePillButton(string text, Action onClick, Thickness margin)
    {
        var button = new Button
        {
            Content = text,
            Style = NativeTheme.PillPrimaryStyle,
            Margin = margin,
            HorizontalAlignment = HorizontalAlignment.Left,
        };
        button.Click += (_, _) => onClick();
        return button;
    }

    /// <summary>官网链接（.preset-website-link：48 高、浅底描边、↗ 前缀）。</summary>
    private static Border MakeWebsiteLink(string url, string tip)
    {
        var host = new Border
        {
            Height = 48,
            CornerRadius = new CornerRadius(14),
            Background = NativeTheme.ButtonSoftBgBrush,
            BorderBrush = NativeTheme.BorderSoftBrush,
            BorderThickness = new Thickness(1),
            Padding = new Thickness(12, 0, 12, 0),
            Cursor = Cursors.Hand,
            ToolTip = tip,
            Child = MakeText("↗ 官网", 12, NativeTheme.TextDefaultBrush, weight: FontWeights.SemiBold, lineHeight: 18),
        };
        ((TextBlock)host.Child).VerticalAlignment = VerticalAlignment.Center;
        host.MouseEnter += (_, _) =>
        {
            host.BorderBrush = NativeTheme.Pink200Brush;
            ((TextBlock)host.Child).Foreground = NativeTheme.Pink600Brush;
        };
        host.MouseLeave += (_, _) =>
        {
            host.BorderBrush = NativeTheme.BorderSoftBrush;
            ((TextBlock)host.Child).Foreground = NativeTheme.TextDefaultBrush;
        };
        host.MouseLeftButtonUp += (_, _) =>
        {
            try
            {
                Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
            }
            catch
            {
                // 打不开浏览器时静默（不影响设置表单）
            }
        };
        return host;
    }

    /// <summary>模型候选下拉：选中即写回文本框（Electron datalist 的原生替代）。</summary>
    private static ComboBox MakeSuggestionCombo(List<string> items, TextBox target)
    {
        var combo = new ComboBox
        {
            Width = 190,
            Height = 48,
            FontSize = 14,
            VerticalAlignment = VerticalAlignment.Center,
            ToolTip = "常用模型（选择后填入模型名）",
        };
        foreach (var item in items) combo.Items.Add(item);
        combo.SelectionChanged += (_, _) =>
        {
            if (combo.SelectedItem is string candidate && candidate.Length > 0) target.Text = candidate;
        };
        if (items.Count == 0) combo.Visibility = Visibility.Collapsed;
        return combo;
    }

    /// <summary>两列表单网格（列间距 14，由各字段 margin 提供）。</summary>
    private static Grid MakeFormGrid()    {
        var grid = new Grid();
        grid.ColumnDefinitions.Add(new ColumnDefinition());
        grid.ColumnDefinitions.Add(new ColumnDefinition());
        return grid;
    }

    private static Grid MakeThreeColumnGrid()
    {
        var grid = new Grid();
        grid.ColumnDefinitions.Add(new ColumnDefinition());
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(8) });
        grid.ColumnDefinitions.Add(new ColumnDefinition());
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(8) });
        grid.ColumnDefinitions.Add(new ColumnDefinition());
        return grid;
    }

    /// <summary>section 分隔线（.api-section-divider）。</summary>
    private static Border MakeDivider(Thickness margin) => new()
    {
        BorderBrush = NativeTheme.NoteBorderBrush,
        BorderThickness = new Thickness(0, 1, 0, 0),
        Margin = margin,
    };

    /// <summary>面板标题（48×48 图标砖 + 标题 20 + 副标题 14；.panel-heading）。</summary>
    private static FrameworkElement MakePanelHeading(FrameworkElement icon, string title, string subtitle)
    {
        var row = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 0, 0, 18) };
        var tile = new Border
        {
            Width = 48,
            Height = 48,
            CornerRadius = new CornerRadius(16),
            Background = NativeTheme.Pink50Brush,
            BorderBrush = NativeTheme.Pink200Brush,
            BorderThickness = new Thickness(1),
            Child = icon,
            VerticalAlignment = VerticalAlignment.Top,
            Margin = new Thickness(0, 0, 14, 0),
        };
        row.Children.Add(tile);
        var copy = new StackPanel { VerticalAlignment = VerticalAlignment.Top };
        copy.Children.Add(MakeText(title, 20, NativeTheme.TextStrongBrush, weight: FontWeights.SemiBold, lineHeight: 28));
        copy.Children.Add(MakeText(subtitle, 14, NativeTheme.TextMutedBrush, lineHeight: 22.4, margin: new Thickness(0, 4, 0, 0)));
        row.Children.Add(copy);
        return row;
    }

    /// <summary>提示条（.api-note：锁图标 + 说明文字，16 圆角浅描边）。</summary>
    private static FrameworkElement MakeNoteBar(string text)
    {
        var inner = new Grid();
        inner.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        inner.ColumnDefinitions.Add(new ColumnDefinition());
        var icon = NativeTheme.VectorGlyph(Glyphs.Lock, 22, NativeTheme.TextMutedBrush);
        icon.VerticalAlignment = VerticalAlignment.Top;
        icon.Margin = new Thickness(0, 0, 10, 0);
        Grid.SetColumn(icon, 0);
        inner.Children.Add(icon);
        var copy = MakeText(text, 14, NativeTheme.TextMutedBrush, lineHeight: 22.4);
        Grid.SetColumn(copy, 1);
        inner.Children.Add(copy);
        var bar = new Border
        {
            CornerRadius = new CornerRadius(16),
            Background = Brushes.White,
            BorderBrush = NativeTheme.NoteBorderBrush,
            BorderThickness = new Thickness(1),
            Padding = new Thickness(13, 12, 13, 12),
            Child = inner,
            Margin = new Thickness(0, 16, 0, 18),
        };
        return bar;
    }

    /// <summary>设置行（.setting-row：标题 + 说明在左，控件在右，白卡 18 圆角）。</summary>
    private static FrameworkElement BuildSettingRow(string title, string description, FrameworkElement control, double topMargin = 0)
    {
        var grid = new Grid();
        grid.ColumnDefinitions.Add(new ColumnDefinition());
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        var copy = new StackPanel { VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(0, 0, 16, 0) };
        copy.Children.Add(MakeText(title, 14, NativeTheme.TextStrongBrush, weight: FontWeights.Medium, lineHeight: 21));
        copy.Children.Add(MakeText(description, 14, NativeTheme.TextMutedBrush, lineHeight: 21, margin: new Thickness(0, 4, 0, 0)));
        Grid.SetColumn(copy, 0);
        grid.Children.Add(copy);
        Grid.SetColumn(control, 1);
        grid.Children.Add(control);
        return new Border
        {
            Child = grid,
            Padding = new Thickness(12, 10, 12, 10),
            CornerRadius = new CornerRadius(18),
            Background = Brushes.White,
            BorderBrush = NativeTheme.BorderSoftBrush,
            BorderThickness = new Thickness(1),
            Effect = NativeTheme.CardShadow(),
            Margin = new Thickness(0, topMargin, 0, 0),
        };
    }

    /// <summary>已保存档案区（标题 + 计数 + 三列档案卡；空态虚线框）。</summary>
    private static FrameworkElement BuildProfileList(JsonElement profiles, string? editingId,
        Func<string, string> shortNameOf, Action<JsonElement> onLoad)
    {
        var section = new StackPanel { Margin = new Thickness(0, 0, 0, 16) };
        var count = profiles.ValueKind == JsonValueKind.Array ? profiles.GetArrayLength() : 0;

        var heading = new Grid { Margin = new Thickness(0, 0, 0, 10) };
        heading.ColumnDefinitions.Add(new ColumnDefinition());
        heading.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        var copy = new StackPanel();
        copy.Children.Add(MakeText(ApiProfileListTitle, 14, NativeTheme.TextStrongBrush, weight: FontWeights.SemiBold, lineHeight: 21));
        copy.Children.Add(MakeText(ApiProfileListSubtitle, 11.5, NativeTheme.TextDefaultBrush, lineHeight: 17.5, margin: new Thickness(0, 2, 0, 0)));
        Grid.SetColumn(copy, 0);
        heading.Children.Add(copy);
        var countText = MakeText(count > 0 ? $"{count} 个档案" : "", 11, NativeTheme.TextDefaultBrush, lineHeight: 16.5);
        countText.VerticalAlignment = VerticalAlignment.Top;
        countText.Margin = new Thickness(0, 4, 0, 0);
        Grid.SetColumn(countText, 1);
        heading.Children.Add(countText);
        section.Children.Add(heading);

        if (count == 0)
        {
            section.Children.Add(MakeProfileEmpty());
            return section;
        }

        var grid = new UniformGrid { Columns = 3 };
        foreach (var profile in profiles.EnumerateArray())
        {
            var id = GetString(profile, "id");
            var name = GetString(profile, "displayName");
            if (name.Length == 0) name = GetString(profile, "provider");
            var meta = new List<string> { shortNameOf(GetString(profile, "provider")), GetString(profile, "model") };
            var contextTokens = GetInt(profile, "contextWindowTokens", 0);
            if (contextTokens > 0) meta.Add($"{Math.Round(contextTokens / 1000.0)}k");

            var body = new StackPanel();
            var nameText = MakeText(name, 13, NativeTheme.TextStrongBrush, weight: FontWeights.SemiBold, lineHeight: 19);
            nameText.TextWrapping = TextWrapping.NoWrap;
            nameText.TextTrimming = TextTrimming.CharacterEllipsis;
            body.Children.Add(nameText);
            var metaText = MakeText(string.Join(" · ", meta), 11, NativeTheme.TextDefaultBrush,
                lineHeight: 16, margin: new Thickness(0, 5, 0, 0));
            metaText.TextWrapping = TextWrapping.NoWrap;
            metaText.TextTrimming = TextTrimming.CharacterEllipsis;
            body.Children.Add(metaText);

            var badges = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 5, 0, 0) };
            if (GetBool(profile, "isDefault")) badges.Children.Add(MakeBadge("默认", vision: false));
            if (GetBool(profile, "multimodal")) badges.Children.Add(MakeBadge("多模态", vision: true));
            if (badges.Children.Count > 0) body.Children.Add(badges);

            var active = id == editingId;
            var card = new Border
            {
                CornerRadius = new CornerRadius(14),
                Padding = new Thickness(14, 12, 14, 12),
                Background = active ? new SolidColorBrush(NativeTheme.ProfileActiveBg) : Brushes.White,
                BorderBrush = active ? new SolidColorBrush(NativeTheme.ProfileActiveBorder) : new SolidColorBrush(NativeTheme.ProfileIdleBorder),
                BorderThickness = new Thickness(1),
                Cursor = Cursors.Hand,
                Child = body,
                Margin = new Thickness(0, 0, 10, 10),
            };
            var profileCopy = profile.Clone();
            card.MouseLeftButtonUp += (_, _) => onLoad(profileCopy);
            grid.Children.Add(card);
        }
        section.Children.Add(grid);
        return section;
    }

    private static FrameworkElement MakeProfileEmpty()
    {
        var grid = new Grid();
        grid.Children.Add(new System.Windows.Shapes.Rectangle
        {
            Stroke = NativeTheme.Pink200Brush,
            StrokeThickness = 1,
            StrokeDashArray = new DoubleCollection { 4, 3 },
            RadiusX = 14,
            RadiusY = 14,
            Fill = Brushes.Transparent,
        });
        grid.Children.Add(MakeText(ApiProfileEmpty, 12, NativeTheme.TextDefaultBrush, lineHeight: 18,
            margin: new Thickness(16, 18, 16, 18)));
        return grid;
    }

    /// <summary>徽标胶囊（.profile-card__badge：10px/600，粉底或蓝底）。</summary>
    private static Border MakeBadge(string text, bool vision) => new()
    {
        CornerRadius = new CornerRadius(9),
        Background = vision ? NativeTheme.BadgeVisionBrush : NativeTheme.BadgePinkBrush,
        Padding = new Thickness(7, 1, 7, 1),
        Margin = new Thickness(0, 0, 6, 0),
        Child = MakeText(text, 10, NativeTheme.TextStrongBrush, weight: FontWeights.SemiBold, lineHeight: 15),
    };

    /// <summary>厂商预设卡（.preset-card：72×75、logo 28/24、短名 14/500）。</summary>
    private static FrameworkElement MakePresetCard(string shortName, string? asset, bool active, string provider, Action onClick)
    {
        var logo = MakeProviderLogo(shortName, asset, 28, 24);
        var label = MakeText(shortName, 14, active ? NativeTheme.Pink600Brush : NativeTheme.TextMutedBrush,
            weight: FontWeights.Medium, lineHeight: 21, margin: new Thickness(0, 4, 0, 0));
        label.Width = 60;
        label.TextAlignment = TextAlignment.Center;
        label.TextWrapping = TextWrapping.NoWrap;
        label.TextTrimming = TextTrimming.CharacterEllipsis;

        var stack = new StackPanel { VerticalAlignment = VerticalAlignment.Center, HorizontalAlignment = HorizontalAlignment.Center };
        stack.Children.Add(logo);
        stack.Children.Add(label);
        var host = new Border
        {
            Width = 72,
            Height = 75,
            CornerRadius = new CornerRadius(14),
            Padding = new Thickness(6, 10, 6, 10),
            Background = active ? NativeTheme.Pink50Brush : NativeTheme.CardSoftBgBrush,
            BorderBrush = NativeTheme.Pink200Brush,
            BorderThickness = new Thickness(1),
            Cursor = Cursors.Hand,
            Child = stack,
            ToolTip = provider,
        };
        host.MouseEnter += (_, _) => label.Foreground = NativeTheme.Pink600Brush;
        host.MouseLeave += (_, _) =>
        {
            if (!active) label.Foreground = NativeTheme.TextMutedBrush;
        };
        host.MouseLeftButtonUp += (_, _) => onClick();
        return host;
    }

    /// <summary>协议卡（.transport-cards .preset-card：整行图标 + 名称居中）。</summary>
    private static (Border Host, TextBlock Label) MakeTransportCard(string text, string asset, bool active)
    {
        var row = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            HorizontalAlignment = HorizontalAlignment.Center,
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(6, 8, 6, 8),
        };
        row.Children.Add(MakeProviderLogo(text, asset, 20, 18));
        var label = MakeText(text, 14, active ? NativeTheme.Pink600Brush : NativeTheme.TextMutedBrush,
            weight: FontWeights.Medium, lineHeight: 21, margin: new Thickness(8, 0, 0, 0));
        label.TextWrapping = TextWrapping.NoWrap;
        row.Children.Add(label);
        var host = new Border
        {
            CornerRadius = new CornerRadius(14),
            Background = active ? NativeTheme.Pink50Brush : NativeTheme.CardSoftBgBrush,
            BorderBrush = NativeTheme.Pink200Brush,
            BorderThickness = new Thickness(1),
            Cursor = Cursors.Hand,
            Child = row,
        };
        return (host, label);
    }

    /// <summary>厂商 logo（assets/providers/*.png；缺失时首字母占位，对齐渲染页回退）。</summary>
    private static FrameworkElement MakeProviderLogo(string shortName, string? asset, double boxSize, double imageSize)
    {
        var host = new Grid { Width = boxSize, Height = boxSize };
        var source = asset is null ? null : NativeTheme.TryLoadAssetImage(System.IO.Path.Combine("providers", asset + ".png"));
        if (source is not null)
        {
            host.Children.Add(new Image
            {
                Source = source,
                Width = imageSize,
                Height = imageSize,
                Stretch = Stretch.Uniform,
                HorizontalAlignment = HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center,
            });
        }
        else
        {
            host.Children.Add(new Border
            {
                CornerRadius = new CornerRadius(boxSize / 2),
                Background = NativeTheme.Pink50Brush,
                Child = MakeText(shortName.Length > 0 ? shortName[0].ToString() : "?", boxSize * 0.5,
                    NativeTheme.TextMutedBrush, weight: FontWeights.SemiBold, lineHeight: boxSize * 0.66),
            });
        }
        return host;
    }

    /// <summary>短名 → 本地 logo 资源（pearl-white 下 Kimi 用浅色变体）。</summary>
    private static string? ProviderAssetOf(string shortName) => shortName switch
    {
        "MiniMax" => "minimax",
        "DeepSeek" => "deepseek",
        "豆包" => "volcengine",
        "GLM" => "glm",
        "Kimi" => "kimi",
        "Qwen" => "qwen",
        "ChatGPT" => "openai",
        "Claude" => "claude",
        "MiMo" => "xiaomimimo",
        "自定义" => "custom-endpoint",
        "本地模型" => "custom-endpoint",
        _ => null,
    };

    /// <summary>自定义端点模式卡（.custom-endpoint-controls：标题 + 高级徽标 + 说明 + 云端/本地切换）。</summary>
    private static FrameworkElement BuildCustomEndpointCard(string mode, Action<string> onSwitchMode)
    {
        var card = new Border
        {
            CornerRadius = new CornerRadius(17),
            Padding = new Thickness(15, 14, 15, 14),
            BorderBrush = NativeTheme.Pink200Brush,
            BorderThickness = new Thickness(1),
            Margin = new Thickness(0, 10, 0, 16),
            Background = new LinearGradientBrush(
                (Color)ColorConverter.ConvertFromString("#FFF7FB"),
                Colors.White,
                new Point(0, 0), new Point(1, 1)),
        };

        var grid = new Grid();
        grid.ColumnDefinitions.Add(new ColumnDefinition());
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

        var copy = new StackPanel { VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(0, 0, 16, 0) };
        var titleRow = new StackPanel { Orientation = Orientation.Horizontal };
        titleRow.Children.Add(MakeText("自定义端点", 14, NativeTheme.TextStrongBrush, weight: FontWeights.Medium, lineHeight: 21));
        titleRow.Children.Add(new Border
        {
            CornerRadius = new CornerRadius(9),
            Background = NativeTheme.Pink50Brush,
            BorderBrush = NativeTheme.Pink200Brush,
            BorderThickness = new Thickness(1),
            Padding = new Thickness(7, 2, 7, 2),
            Margin = new Thickness(8, 0, 0, 0),
            VerticalAlignment = VerticalAlignment.Center,
            Child = MakeText("高级", 12, NativeTheme.Pink600Brush, lineHeight: 18),
        });
        copy.Children.Add(titleRow);
        copy.Children.Add(MakeText(mode == "local"
                ? "填写本机模型服务地址并明确选择接口协议；不扫描端口，也不探测模型能力。"
                : "接入兼容 OpenAI 或 Anthropic 协议的云端服务，能力由服务提供方决定。",
            12, NativeTheme.TextMutedBrush, lineHeight: 18.6, margin: new Thickness(0, 5, 0, 0)));
        Grid.SetColumn(copy, 0);
        grid.Children.Add(copy);

        // 云端/本地切换（pearl-white .custom-endpoint-mode）
        var modeRow = new StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center };
        var modeButtons = new List<(Border Host, TextBlock Label, string Value)>();
        void SetModeActive(string value)
        {
            foreach (var (host, label, buttonValue) in modeButtons)
            {
                var active = buttonValue == value;
                host.Background = active ? NativeTheme.PinkBrush : Brushes.White;
                host.BorderBrush = active ? NativeTheme.PinkBrush : NativeTheme.Pink200Brush;
                label.Foreground = active ? Brushes.White : NativeTheme.TextMutedBrush;
            }
        }
        foreach (var (value, text) in new[] { ("cloud", "云端服务"), ("local", "本地服务") })
        {
            var label = MakeText(text, 14, NativeTheme.TextMutedBrush, weight: FontWeights.Medium, lineHeight: 21);
            var button = new Border
            {
                CornerRadius = new CornerRadius(18),
                Padding = new Thickness(11, 7, 11, 7),
                Margin = new Thickness(3),
                BorderThickness = new Thickness(1),
                Cursor = Cursors.Hand,
                Child = label,
            };
            button.MouseLeftButtonUp += (_, _) =>
            {
                if (value == mode) return;
                onSwitchMode(value);
            };
            modeButtons.Add((button, label, value));
            modeRow.Children.Add(button);
        }
        var modeHost = new Border
        {
            CornerRadius = new CornerRadius(20),
            Background = Brushes.White,
            BorderBrush = NativeTheme.Pink200Brush,
            BorderThickness = new Thickness(1),
            Padding = new Thickness(0),
            Child = modeRow,
            VerticalAlignment = VerticalAlignment.Center,
        };
        SetModeActive(mode);
        Grid.SetColumn(modeHost, 1);
        grid.Children.Add(modeHost);

        card.Child = grid;
        return card;
    }

    // ── 大输入框（api-advanced / 运行设置 section 复用旧签名） ──

    private static TextBox MakeApiTextBox(string text, double width = 260) => new()
    {
        Text = text,
        Width = width,
        FontSize = 14,
        Padding = new Thickness(6, 4, 6, 4),
        VerticalContentAlignment = VerticalAlignment.Center,
    };

    private static PasswordBox MakeApiPasswordBox(string password, double width = 260) => new()
    {
        Password = password,
        Width = width,
        FontSize = 14,
        Padding = new Thickness(6, 4, 6, 4),
        VerticalContentAlignment = VerticalAlignment.Center,
    };

    // ── Base URL 请求地址预览（与 src/shared/api-endpoint.ts 同一实现） ──

    private static string ResolveEndpointHint(string baseUrl, string transport)
    {
        var defaultSuffix = transport switch
        {
            "anthropic" => "/v1/messages",
            "responses" => "/responses",
            _ => "/chat/completions",
        };
        if (baseUrl.Length == 0) return $"程序会按所选协议自动追加请求路径（默认 {defaultSuffix}）。";

        var trimmed = baseUrl.Trim().TrimEnd('/');
        string url;
        string? appended;
        if (transport == "anthropic")
        {
            if (trimmed.EndsWith("/messages", StringComparison.Ordinal)) { url = trimmed; appended = null; }
            else if (trimmed.EndsWith("/v1", StringComparison.Ordinal)) { url = trimmed + "/messages"; appended = "/messages"; }
            else { url = trimmed + "/v1/messages"; appended = "/v1/messages"; }
        }
        else if (transport == "responses")
        {
            if (trimmed.EndsWith("/responses", StringComparison.Ordinal)) { url = trimmed; appended = null; }
            else { url = trimmed + "/responses"; appended = "/responses"; }
        }
        else
        {
            if (trimmed.EndsWith("/chat/completions", StringComparison.Ordinal)) { url = trimmed; appended = null; }
            else { url = trimmed + "/chat/completions"; appended = "/chat/completions"; }
        }
        return appended is null
            ? $"已填写完整接口地址，不再追加后缀；最终请求地址：{url}"
            : $"程序会自动追加 {appended}；最终请求地址：{url}";
    }
}

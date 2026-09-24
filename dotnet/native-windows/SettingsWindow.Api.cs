using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;

namespace CyreneNative;

/// <summary>
/// 设置窗「API 与模型」section（WPF 重写）：已保存档案（载入/设默认/删除）、
/// 厂商预设、档案表单（昵称/API Key/Base URL/协议/模型/上下文/多模态）、
/// 全局视觉模型、自定义端点覆盖（思考强制开/关、max_token 限制）、
/// 保存档案 / 测试连接。
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
        public int ContextWindow = 256000;
        public bool Multimodal = true;
        public string VisionBaseUrl = "";
        public string VisionApiKey = "";
        public string VisionModel = "";
        public int ThinkingOverride;
        public bool DisableMaxToken;
    }

    private ApiFormState? _apiForm;

    private FrameworkElement BuildApiSection()
    {
        var panel = new StackPanel();
        panel.Children.Add(MakeHeader("API 与模型"));
        panel.Children.Add(MakeHint("先配置一个模型服务；保存后的档案可在聊天窗口的模型面板切换。"));
        panel.Children.Add(MakeSectionStatus("api"));

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

        // ── 表单控件（先建控件，后面按版面顺序挂载） ──
        var displayNameBox = MakeApiTextBox(form.DisplayName);
        var apiKeyBox = MakeApiTextBox(form.ApiKey);
        var baseUrlBox = MakeApiTextBox(form.BaseUrl);
        var modelCombo = new ComboBox
        {
            Width = 260,
            FontSize = 12,
            IsEditable = true,
            Text = form.Model,
        };
        var contextBox = MakeApiTextBox(form.ContextWindow.ToString());
        contextBox.Width = 120;
        var transportCombo = new ComboBox { Width = 220, FontSize = 12 };
        transportCombo.Items.Add("chat/completion（OpenAI 兼容）");
        transportCombo.Items.Add("anthropic");
        transportCombo.Items.Add("Responses");
        transportCombo.SelectedIndex = form.Transport switch { "anthropic" => 1, "responses" => 2, _ => 0 };
        var multimodalBox = new CheckBox
        {
            Content = "多模态（能直发图片）",
            FontSize = 12,
            IsChecked = form.Multimodal,
        };
        var presetCombo = new ComboBox { Width = 280, FontSize = 12 };
        var visiblePresets = new List<JsonElement>();
        if (presets.ValueKind == JsonValueKind.Array)
        {
            foreach (var preset in presets.EnumerateArray())
            {
                if (GetBool(preset, "hiddenInPresetList")) continue;
                visiblePresets.Add(preset);
                presetCombo.Items.Add(GetString(preset, "provider"));
            }
        }
        if (presetCombo.Items.Count > 0) presetCombo.SelectedIndex = 0;

        void FillModelCandidates(string provider)
        {
            modelCombo.Items.Clear();
            foreach (var preset in visiblePresets)
            {
                if (GetString(preset, "provider") != provider) continue;
                var models = GetNode(preset, "mainModels");
                if (models.ValueKind != JsonValueKind.Array) break;
                foreach (var model in models.EnumerateArray())
                {
                    if (model.ValueKind == JsonValueKind.String) modelCombo.Items.Add(model.GetString());
                }
                break;
            }
        }

        JsonElement? FindPreset(string provider)
        {
            foreach (var preset in visiblePresets)
            {
                if (GetString(preset, "provider") == provider) return preset;
            }
            return null;
        }

        // 协议切换：Base URL 仍是预设已知值时同步切换（与渲染页一致）
        transportCombo.SelectionChanged += (_, _) =>
        {
            var preset = FindPreset(form.Provider);
            if (preset is not { } p) return;
            var currentUrl = baseUrlBox.Text.Trim().TrimEnd('/');
            var openAiUrl = GetString(p, "baseUrl").TrimEnd('/');
            var anthropicUrl = GetString(p, "anthropicBaseUrl").TrimEnd('/');
            var isAnthropic = transportCombo.SelectedIndex == 1;
            if (currentUrl == openAiUrl || (anthropicUrl.Length > 0 && currentUrl == anthropicUrl))
            {
                baseUrlBox.Text = isAnthropic && anthropicUrl.Length > 0 ? anthropicUrl : openAiUrl;
            }
        };

        // ── 已保存档案 ──
        panel.Children.Add(MakeSubHeader("已保存档案"));
        if (profiles.ValueKind != JsonValueKind.Array || profiles.GetArrayLength() == 0)
        {
            panel.Children.Add(MakeHint("暂无档案：在下方选择厂商预设并保存。"));
        }
        else
        {
            foreach (var profile in profiles.EnumerateArray())
            {
                var card = MakeCard(out var body);
                var isDefault = GetBool(profile, "isDefault");
                var title = GetString(profile, "displayName");
                if (title.Length == 0) title = GetString(profile, "provider");
                body.Children.Add(MakeCardTitle(isDefault ? $"{title}（默认）" : title));
                body.Children.Add(MakeCardMeta($"{GetString(profile, "provider")} · {GetString(profile, "model")} · {GetString(profile, "baseUrl")}"));
                var actions = new StackPanel { Orientation = Orientation.Horizontal };
                var profileCopy = profile.Clone();
                actions.Children.Add(MakeButton("载入到表单", () =>
                {
                    _apiForm = new ApiFormState
                    {
                        ProfileId = GetString(profileCopy, "id"),
                        Provider = GetString(profileCopy, "provider"),
                        DisplayName = GetString(profileCopy, "displayName"),
                        BaseUrl = GetString(profileCopy, "baseUrl"),
                        Model = GetString(profileCopy, "model"),
                        ApiKey = GetString(profileCopy, "apiKey"),
                        Transport = GetString(profileCopy, "transport", "openai"),
                        ContextWindow = GetInt(profileCopy, "contextWindowTokens", 256000),
                        Multimodal = profileCopy.TryGetProperty("multimodal", out var mm) && mm.ValueKind != JsonValueKind.Null
                            ? GetBool(profileCopy, "multimodal", true)
                            : form.Multimodal,
                        VisionBaseUrl = form.VisionBaseUrl,
                        VisionApiKey = form.VisionApiKey,
                        VisionModel = form.VisionModel,
                        ThinkingOverride = form.ThinkingOverride,
                        DisableMaxToken = form.DisableMaxToken,
                    };
                    RefreshSection("api");
                }, minWidth: 84));
                if (!isDefault)
                {
                    var id = GetString(profile, "id");
                    actions.Children.Add(MakeButton("设为默认", () =>
                    {
                        RequestRouter.SendSettingsAction("api", "set-default-profile", new Dictionary<string, object?> { ["id"] = id });
                    }, minWidth: 76));
                }
                var deleteId = GetString(profile, "id");
                actions.Children.Add(MakeButton("删除", () =>
                {
                    if (MessageBox.Show($"删除档案「{title}」？（不影响已保存的模型服务配置）", "删除档案", MessageBoxButton.OKCancel, MessageBoxImage.Warning) != MessageBoxResult.OK) return;
                    RequestRouter.SendSettingsAction("api", "delete-profile", new Dictionary<string, object?> { ["id"] = deleteId });
                }, minWidth: 60));
                body.Children.Add(actions);
                panel.Children.Add(card);
            }
        }

        // ── 新建/编辑档案 ──
        panel.Children.Add(MakeSubHeader(form.ProfileId is null ? "新建档案" : "编辑档案"));
        var presetRow = new StackPanel { Orientation = Orientation.Horizontal };
        presetRow.Children.Add(new TextBlock
        {
            Text = "厂商预设",
            Width = 90,
            FontSize = 12,
            VerticalAlignment = VerticalAlignment.Center,
        });
        presetRow.Children.Add(presetCombo);
        presetRow.Children.Add(MakeButton("应用预设", () =>
        {
            var index = presetCombo.SelectedIndex;
            if (index < 0 || index >= visiblePresets.Count) return;
            var preset = visiblePresets[index];
            form.ProfileId = null;
            form.Provider = GetString(preset, "provider");
            form.DisplayName = GetString(preset, "shortName", form.Provider);
            form.Transport = GetString(preset, "transport", "openai");
            var anthropicUrl = GetString(preset, "anthropicBaseUrl");
            form.BaseUrl = form.Transport == "anthropic" && anthropicUrl.Length > 0
                ? anthropicUrl
                : GetString(preset, "baseUrl");
            var models = GetNode(preset, "mainModels");
            form.Model = models.ValueKind == JsonValueKind.Array && models.GetArrayLength() > 0
                ? models[0].GetString() ?? ""
                : form.Model;
            var visionBase = GetString(preset, "visionBaseUrl");
            if (visionBase.Length > 0) form.VisionBaseUrl = visionBase;
            var defaultVisionModel = GetString(preset, "defaultVisionModel");
            if (defaultVisionModel.Length > 0 && form.VisionModel.Length == 0) form.VisionModel = defaultVisionModel;
            _apiForm = form;
            RefreshSection("api");
        }, minWidth: 84));
        panel.Children.Add(presetRow);

        // 表单字段
        panel.Children.Add(MakeLabeledApi("昵称（可留空）", displayNameBox));
        panel.Children.Add(MakeLabeledApi("API Key", apiKeyBox));
        panel.Children.Add(MakeLabeledApi("Base URL", baseUrlBox));
        panel.Children.Add(MakeLabeledApi("API 协议", transportCombo));
        panel.Children.Add(MakeLabeledApi("模型名", modelCombo));
        panel.Children.Add(MakeLabeledApi("上下文窗口（Token）", contextBox));
        panel.Children.Add(multimodalBox);

        // ── 视觉模型（全局） ──
        panel.Children.Add(MakeSubHeader("视觉模型（全局）"));
        panel.Children.Add(MakeHint("档案未开多模态时，用这里的独立视觉模型转述图片；留空则诚实告知看不了。"));
        var visionBaseUrlBox = MakeApiTextBox(form.VisionBaseUrl);
        var visionApiKeyBox = MakeApiTextBox(form.VisionApiKey);
        var visionModelBox = MakeApiTextBox(form.VisionModel);
        panel.Children.Add(MakeLabeledApi("Base URL", visionBaseUrlBox));
        panel.Children.Add(MakeLabeledApi("API Key", visionApiKeyBox));
        panel.Children.Add(MakeLabeledApi("视觉型号", visionModelBox));
        panel.Children.Add(MakeButton("测试视觉模型", () =>
        {
            RequestRouter.SendSettingsAction("api", "test-vision", new Dictionary<string, object?>
            {
                ["config"] = new Dictionary<string, object?>
                {
                    ["baseUrl"] = visionBaseUrlBox.Text.Trim(),
                    ["apiKey"] = visionApiKeyBox.Text.Trim(),
                    ["model"] = visionModelBox.Text.Trim(),
                },
            });
        }));

        // ── 自定义端点覆盖 ──
        panel.Children.Add(MakeSubHeader("自定义端点覆盖"));
        panel.Children.Add(MakeHint("仅当前厂商为自定义端点/本地模型时需要；随档案保存为全局覆盖。"));
        var thinkingCombo = new ComboBox { Width = 220, FontSize = 12 };
        thinkingCombo.Items.Add("不干预思考");
        thinkingCombo.Items.Add("强制启用思考");
        thinkingCombo.Items.Add("强制禁用思考");
        thinkingCombo.SelectedIndex = form.ThinkingOverride switch { 1 => 1, -1 => 2, _ => 0 };
        panel.Children.Add(MakeLabeledApi("思考模式", thinkingCombo));
        var disableMaxTokenBox = new CheckBox
        {
            Content = "删除 max_token 限制（本地模型常用）",
            FontSize = 12,
            IsChecked = form.DisableMaxToken,
            Margin = new Thickness(0, 4, 0, 4),
        };
        panel.Children.Add(disableMaxTokenBox);

        // ── 操作 ──
        var saveRow = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 10, 0, 0) };
        saveRow.Children.Add(MakeButton("保存档案", () =>
        {
            form.DisplayName = displayNameBox.Text.Trim();
            form.ApiKey = apiKeyBox.Text.Trim();
            form.BaseUrl = baseUrlBox.Text.Trim();
            form.Model = (modelCombo.Text ?? "").Trim();
            form.Transport = transportCombo.SelectedIndex switch { 1 => "anthropic", 2 => "responses", _ => "openai" };
            form.ContextWindow = int.TryParse(contextBox.Text.Trim(), out var context) ? Math.Max(4096, context) : 256000;
            form.Multimodal = multimodalBox.IsChecked == true;
            form.VisionBaseUrl = visionBaseUrlBox.Text.Trim();
            form.VisionApiKey = visionApiKeyBox.Text.Trim();
            form.VisionModel = visionModelBox.Text.Trim();
            form.ThinkingOverride = thinkingCombo.SelectedIndex switch { 1 => 1, 2 => -1, _ => 0 };
            form.DisableMaxToken = disableMaxTokenBox.IsChecked == true;
            _apiForm = form;

            var provider = form.Provider;
            if (provider.Length == 0)
            {
                var index = presetCombo.SelectedIndex;
                if (index >= 0 && index < visiblePresets.Count) provider = GetString(visiblePresets[index], "provider");
            }

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
                    ["contextWindowTokens"] = form.ContextWindow,
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
        }, primary: true));
        saveRow.Children.Add(MakeButton("测试连接", () =>
        {
            RequestRouter.SendSettingsAction("api", "test", new Dictionary<string, object?>
            {
                ["config"] = new Dictionary<string, object?>
                {
                    ["provider"] = form.Provider,
                    ["baseUrl"] = baseUrlBox.Text.Trim(),
                    ["model"] = (modelCombo.Text ?? "").Trim(),
                    ["apiKey"] = apiKeyBox.Text.Trim(),
                    ["transport"] = transportCombo.SelectedIndex switch { 1 => "anthropic", 2 => "responses", _ => "openai" },
                },
            });
        }));
        panel.Children.Add(saveRow);
        panel.Children.Add(MakeHint("提示：测试连接使用当前表单值；保存后档案列表会刷新。"));

        // 模型候选随当前 provider 填充
        FillModelCandidates(form.Provider.Length > 0 ? form.Provider : GetString(config, "provider"));
        return panel;
    }

    private static TextBox MakeApiTextBox(string text, double width = 260)
    {
        return new TextBox
        {
            Text = text,
            Width = width,
            FontSize = 12,
            Padding = new Thickness(6, 4, 6, 4),
            VerticalContentAlignment = VerticalAlignment.Center,
        };
    }

    private static StackPanel MakeLabeledApi(string label, FrameworkElement control)
    {
        var row = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 4, 0, 4) };
        row.Children.Add(new TextBlock
        {
            Text = label,
            Width = 140,
            FontSize = 12,
            VerticalAlignment = VerticalAlignment.Center,
        });
        row.Children.Add(control);
        return row;
    }
}
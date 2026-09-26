using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using Microsoft.Win32;

namespace CyreneNative;

/// <summary>
/// 设置窗「语音合成 TTS」section（对位 Electron tts 面板）：
/// 播放交互（自动朗读 / 切分 / 语速音量）、引擎选择（关闭 / MiniMax / 小米 MiMo /
/// Mossland / GPT-SoVITS / 自定义云端）、各引擎配置（手动保存按钮）、测试发音
/// （宿主合成 → 临时文件 → MediaPlayer 播放）、MiniMax 音色快速复刻、
/// Mossland 音色克隆与音色列表。
///
/// 数据：state.settings.tts（native-settings-sections.buildTtsSectionSnapshot）
/// 动作：cmd settings tts { save / test / clone-minimax / clone-mossland / list-mossland-voices }
/// 说明：文本字段与旧页一致，只有点 Provider 的「保存配置」才落盘；开关 / 滑杆 /
/// 下拉 / 引擎选择即时保存（滑杆 250ms 防抖）。
/// </summary>
public sealed partial class SettingsWindow
{
    /// <summary>导航 tts 图标的几何（48 视框；与 SettingsNavIcons 同一份旧页 SVG）。</summary>
    private const string TtsHeadingGlyph =
        "M9 23C9 31.2843 15.7157 38 24 38C32.2843 38 39 31.2843 39 23 M24 38V44 "
        + "M24 4 H24 A7 7 0 0 1 31 11 V24 A7 7 0 0 1 24 31 H24 A7 7 0 0 1 17 24 V11 A7 7 0 0 1 24 4 Z";

    private MediaPlayer? _ttsPreviewPlayer;
    private string? _ttsPreviewFile;

    private FrameworkElement BuildTtsSection()
    {
        var panel = new StackPanel();
        panel.Children.Add(MakePanelHeading(
            NativeTheme.VectorGlyph(TtsHeadingGlyph, 24, NativeTheme.TextDefaultBrush),
            "TTS 设置",
            "语音合成与朗读偏好"));
        panel.Children.Add(MakeSectionStatus("tts"));

        var tts = GetNode("tts");

        // ── 播放交互 ──
        var playbackCard = MakeToolCard("🔊", "播放交互", "自动朗读、切分方式与语速音量。", null, out var playbackBody);

        playbackBody.Children.Add(MakeDescribedToggleRow(
            "自动朗读回复", "昔涟每次回复后自动语音朗读。",
            GetBool(tts, "autoRead"), v => SaveTtsField("ttsAutoRead", v)));

        var splitModeHost = new StackPanel();
        splitModeHost.Children.Add(MakeChoiceGroup(
            new[] { ("sentence", "一句一切", true), ("paragraph", "一段一切", true) },
            GetString(tts, "earlyReadSplitMode", "sentence"),
            v => SaveTtsField("ttsEarlyReadSplitMode", v)));
        var splitEnabled = GetBool(tts, "earlyReadSplitEnabled", true);
        splitModeHost.IsEnabled = splitEnabled;
        var splitToggle = new CheckBox
        {
            IsChecked = splitEnabled,
            Style = NativeTheme.SwitchStyle,
            Cursor = Cursors.Hand,
            VerticalAlignment = VerticalAlignment.Center,
        };
        splitToggle.Checked += (_, _) =>
        {
            splitModeHost.IsEnabled = true;
            SaveTtsField("ttsEarlyReadSplitEnabled", true);
        };
        splitToggle.Unchecked += (_, _) =>
        {
            splitModeHost.IsEnabled = false;
            SaveTtsField("ttsEarlyReadSplitEnabled", false);
        };
        playbackBody.Children.Add(MakeDescribedRow(
            "自动朗读文本切分", "回复生成时按片段提前朗读；关闭则收完整条回复再朗读。", splitToggle));
        playbackBody.Children.Add(MakeDescribedRow(
            "切分模式", "逐句朗读，或按空行段落整段朗读。", splitModeHost));

        var speedValue = GetDouble(tts, "speed", 1);
        var volumeValue = GetDouble(tts, "volume", 1);
        playbackBody.Children.Add(MakeDoubleSliderRow(
            "语速", speedValue, 0.5, 2, 0.1, "x",
            v => { speedValue = Math.Round(v, 1); SaveTtsField("ttsSpeed", speedValue); },
            v => $"{v:0.0}x"));
        playbackBody.Children.Add(MakeDoubleSliderRow(
            "音量", volumeValue, 0, 1, 0.1, "",
            v => { volumeValue = Math.Round(v, 1); SaveTtsField("ttsVolume", volumeValue); },
            v => $"{Math.Round(v * 100)}%"));
        panel.Children.Add(playbackCard);

        // ── 引擎选择 + 配置（本地切换可见性，不重建 section；与旧页 hidden div 语义一致） ──
        var engineCard = MakeToolCard("🎙️", "引擎选择", "选中哪个引擎就展开对应配置。", null, out var engineBody);
        var engineRow = new WrapPanel();

        string engine = GetString(tts, "engine", "off");
        var configs = new Dictionary<string, FrameworkElement>
        {
            ["minimax"] = BuildTtsMinimaxConfig(tts),
            ["mimo"] = BuildTtsMimoConfig(tts),
            ["mossland"] = BuildTtsMosslandConfig(tts),
            ["gptsovits"] = BuildTtsGptsovitsConfig(tts),
            ["custom-cloud"] = BuildTtsCustomCloudConfig(tts, () => speedValue, () => volumeValue),
        };
        var engineButtons = new Dictionary<string, Button>();

        void SelectEngine(string value)
        {
            engine = value;
            foreach (var (key, button) in engineButtons)
            {
                button.Style = key == value ? NativeTheme.PrimaryButtonStyle : NativeTheme.SecondaryButtonStyle;
            }
            foreach (var (key, config) in configs)
            {
                config.Visibility = key == value ? Visibility.Visible : Visibility.Collapsed;
            }
            SaveTtsField("ttsEngine", value);
        }

        foreach (var (value, label) in new[]
        {
            ("off", "关闭"),
            ("minimax", "MiniMax"),
            ("mimo", "小米 MiMo"),
            ("mossland", "Mossland"),
            ("gptsovits", "GPT-SoVITS"),
            ("custom-cloud", "自定义云端"),
        })
        {
            var button = new Button
            {
                Content = label,
                MinWidth = 104,
                Margin = new Thickness(0, 0, 8, 8),
                Style = value == engine ? NativeTheme.PrimaryButtonStyle : NativeTheme.SecondaryButtonStyle,
            };
            var captured = value;
            button.Click += (_, _) => { if (captured != engine) SelectEngine(captured); };
            engineButtons[captured] = button;
            engineRow.Children.Add(button);
        }
        engineBody.Children.Add(engineRow);
        panel.Children.Add(engineCard);

        foreach (var (key, config) in configs)
        {
            config.Visibility = key == engine ? Visibility.Visible : Visibility.Collapsed;
            panel.Children.Add(config);
        }

        panel.Children.Add(MakeHint(
            "💡 MiniMax 需在控制台训练音色并填写音色 ID；GPT-SoVITS 需自行启动本地服务并提供参考音频；"
            + "自定义云端会 POST 固定 JSON 到你的 Endpoint；小米 MiMo 用昔涟参考音频走 voiceclone 非流式 wav 合成；"
            + "Mossland 通过 multipart 上传克隆音频并返回 voice_id。"));
        return panel;
    }

    // ── 各引擎配置 ──

    private FrameworkElement BuildTtsMinimaxConfig(JsonElement tts)
    {
        var card = MakeCard(out var body);
        body.Children.Add(MakeSubHeader("MiniMax 配置"));
        body.Children.Add(MakeHint("训练好的音色 ID 可直接填写，或在下方「音色快速复刻」中训练。"));

        var keyBox = MakeTtsPasswordBox(GetString(tts, "minimaxKey"));
        var voiceBox = MakeTtsTextBox(GetString(tts, "minimaxVoiceId"));
        var model = GetString(tts, "minimaxModel", "speech-2.8-turbo");
        var vocalEnhance = GetBool(tts, "minimaxVocalEnhance", true);
        var suppressVoiceDirty = false;

        var (saveRow, _, _, markDirty) = MakeTtsSaveRow(() => new Dictionary<string, object?>
        {
            ["ttsMinimaxKey"] = keyBox.Password.Trim(),
            ["ttsMinimaxVoiceId"] = voiceBox.Text.Trim(),
        });
        keyBox.PasswordChanged += (_, _) => markDirty();
        voiceBox.TextChanged += (_, _) => { if (!suppressVoiceDirty) markDirty(); };

        body.Children.Add(MakeTtsField("API Key", keyBox, "MiniMax 平台 → 账户管理 → API Key。"));
        body.Children.Add(MakeTtsField("音色 ID", voiceBox, "训练好的音色 ID（或下方复刻后自动填入）。"));
        body.Children.Add(MakeTtsField("合成模型", MakeTtsSelect(
            new[]
            {
                ("speech-2.8-turbo", "speech-2.8-turbo（极速 ¥2.0/万字符）"),
                ("speech-2.8-hd", "speech-2.8-hd（高保真 ¥3.5/万字符）"),
            },
            model,
            v => { model = v; SaveTtsField("ttsMinimaxModel", v); })));
        body.Children.Add(MakeDescribedToggleRow(
            "流式播放", "边合成边播，首字延迟低（默认开）。关掉 = 收完再播。",
            GetBool(tts, "streaming", true), v => SaveTtsField("ttsStreaming", v)));
        body.Children.Add(MakeDescribedToggleRow(
            "语音增强", "自动插入笑声、换气、叹息等 MiniMax 语气词标签，让语音更自然。",
            vocalEnhance, v => { vocalEnhance = v; SaveTtsField("ttsMinimaxVocalEnhance", v); }));

        body.Children.Add(MakeTtsTestRow(() => new Dictionary<string, object?>
        {
            ["engine"] = "minimax",
            ["apiKey"] = keyBox.Password.Trim(),
            ["voiceId"] = voiceBox.Text.Trim(),
            ["model"] = model,
            ["vocalEnhance"] = vocalEnhance,
        }));
        body.Children.Add(saveRow);
        body.Children.Add(BuildTtsMinimaxCloneBlock(
            getApiKey: () => keyBox.Password.Trim(),
            fillVoiceId: id =>
            {
                suppressVoiceDirty = true;
                voiceBox.Text = id;
                suppressVoiceDirty = false;
                // 旧页同款：复刻成功后立刻写入设置，无需再点保存
                SaveTtsField("ttsMinimaxVoiceId", id);
            }));
        return card;
    }

    private FrameworkElement BuildTtsGptsovitsConfig(JsonElement tts)
    {
        var card = MakeCard(out var body);
        body.Children.Add(MakeSubHeader("GPT-SoVITS 配置"));
        body.Children.Add(MakeHint("需自行启动本地 GPT-SoVITS 服务；参考音频与文本用于音色参考。"));

        var urlBox = MakeTtsTextBox(GetString(tts, "gptsovitsBaseUrl"), width: 320);
        var refAudioBox = MakeTtsTextBox(GetString(tts, "gptsovitsRefAudioPath"), width: 240);
        refAudioBox.IsReadOnly = true;
        var promptTextBox = MakeTtsTextBox(GetString(tts, "gptsovitsPromptText"), width: 320);
        var format = GetString(tts, "gptsovitsFormat", "wav");
        var timeout = GetInt(tts, "gptsovitsTimeoutMs", 180_000);

        var (saveRow, _, _, markDirty) = MakeTtsSaveRow(() => new Dictionary<string, object?>
        {
            ["ttsGptsovitsBaseUrl"] = urlBox.Text.Trim(),
            ["ttsGptsovitsRefAudioPath"] = refAudioBox.Text.Trim(),
            ["ttsGptsovitsPromptText"] = promptTextBox.Text.Trim(),
            ["ttsGptsovitsTimeoutMs"] = timeout,
        });
        urlBox.TextChanged += (_, _) => markDirty();
        promptTextBox.TextChanged += (_, _) => markDirty();

        var pickRow = MakeTtsFileRow(refAudioBox, "选择参考音频", path =>
        {
            // 旧页：点选后立即保存参考音频路径
            SaveTtsField("ttsGptsovitsRefAudioPath", path);
        });
        body.Children.Add(MakeTtsField("API 地址（baseUrl）", urlBox, "如 http://localhost:9880。"));
        body.Children.Add(MakeTtsField("参考音频路径", pickRow, "选择一段参考音频文件（wav/mp3/m4a）。"));
        body.Children.Add(MakeTtsField("参考音频对应的文本", promptTextBox, "例：你好，我是昔涟。"));
        body.Children.Add(MakeTtsField("输出格式", MakeTtsSelect(
            new[] { ("wav", "wav（推荐，gptsovits 默认）"), ("mp3", "mp3（需服务端支持）") },
            format,
            v => { format = v; SaveTtsField("ttsGptsovitsFormat", v); })));

        var timeoutBox = MakeTtsTextBox(timeout.ToString(), width: 140);
        void CommitTimeout()
        {
            if (!int.TryParse(timeoutBox.Text.Trim(), out var value))
            {
                timeoutBox.Text = timeout.ToString();
                return;
            }
            timeout = Math.Min(3_600_000, Math.Max(10_000, value));
            timeoutBox.Text = timeout.ToString();
            markDirty();
        }
        timeoutBox.LostFocus += (_, _) => CommitTimeout();
        timeoutBox.KeyDown += (_, e) => { if (e.Key == Key.Enter) CommitTimeout(); };
        body.Children.Add(MakeTtsField("合成超时（毫秒）", timeoutBox, "本地推理长文本可能较慢，默认 180000。"));

        body.Children.Add(MakeTtsTestRow(() => new Dictionary<string, object?>
        {
            ["engine"] = "gptsovits",
            ["baseUrl"] = urlBox.Text.Trim(),
            ["refAudioPath"] = refAudioBox.Text.Trim(),
            ["promptText"] = promptTextBox.Text.Trim(),
            ["format"] = format,
        }));
        body.Children.Add(saveRow);
        return card;
    }

    private FrameworkElement BuildTtsCustomCloudConfig(JsonElement tts, Func<double> getSpeed, Func<double> getVolume)
    {
        var card = MakeCard(out var body);
        body.Children.Add(MakeSubHeader("自定义云端配置"));
        body.Children.Add(MakeHint("会 POST 固定 JSON 到你的 Endpoint（详见文档）；API Key 为空则不发送 Authorization。"));

        var urlBox = MakeTtsTextBox(GetString(tts, "customCloudEndpointUrl"), width: 320);
        var keyBox = MakeTtsPasswordBox(GetString(tts, "customCloudApiKey"), width: 320);
        var voiceBox = MakeTtsTextBox(GetString(tts, "customCloudVoiceId"), width: 320);
        var format = GetString(tts, "customCloudFormat", "mp3");
        var timeout = GetInt(tts, "customCloudTimeoutMs", 30_000);

        var (saveRow, _, _, markDirty) = MakeTtsSaveRow(() => new Dictionary<string, object?>
        {
            ["ttsCustomCloudEndpointUrl"] = urlBox.Text.Trim(),
            ["ttsCustomCloudApiKey"] = keyBox.Password.Trim(),
            ["ttsCustomCloudVoiceId"] = voiceBox.Text.Trim(),
            ["ttsCustomCloudTimeoutMs"] = timeout,
        });
        urlBox.TextChanged += (_, _) => markDirty();
        keyBox.PasswordChanged += (_, _) => markDirty();
        voiceBox.TextChanged += (_, _) => markDirty();

        body.Children.Add(MakeTtsField("Endpoint URL", urlBox, "如 https://example.com/tts。"));
        body.Children.Add(MakeTtsField("API Key", keyBox, "可选；为空则不发送 Authorization。"));
        body.Children.Add(MakeTtsField("音色 ID", voiceBox, "传给你的云端网关，如 cyrene-voice。"));
        body.Children.Add(MakeTtsField("输出格式", MakeTtsSelect(
            new[] { ("mp3", "mp3"), ("wav", "wav") },
            format,
            v => { format = v; SaveTtsField("ttsCustomCloudFormat", v); })));

        var timeoutBox = MakeTtsTextBox(timeout.ToString(), width: 140);
        void CommitTimeout()
        {
            if (!int.TryParse(timeoutBox.Text.Trim(), out var value) || value <= 0)
            {
                timeoutBox.Text = timeout.ToString();
                return;
            }
            timeout = Math.Min(120_000, Math.Max(1_000, value));
            timeoutBox.Text = timeout.ToString();
            markDirty();
        }
        timeoutBox.LostFocus += (_, _) => CommitTimeout();
        timeoutBox.KeyDown += (_, e) => { if (e.Key == Key.Enter) CommitTimeout(); };
        body.Children.Add(MakeTtsField("超时（毫秒）", timeoutBox, "默认 30000。"));

        body.Children.Add(MakeTtsTestRow(() => new Dictionary<string, object?>
        {
            ["engine"] = "custom-cloud",
            ["endpointUrl"] = urlBox.Text.Trim(),
            ["apiKey"] = keyBox.Password.Trim(),
            ["voiceId"] = voiceBox.Text.Trim(),
            ["format"] = format,
            ["timeoutMs"] = timeout,
            ["speed"] = getSpeed(),
            ["volume"] = getVolume(),
        }));
        body.Children.Add(saveRow);
        return card;
    }

    private FrameworkElement BuildTtsMimoConfig(JsonElement tts)
    {
        var card = MakeCard(out var body);
        body.Children.Add(MakeSubHeader("小米 MiMo 配置"));
        body.Children.Add(MakeHint("当前使用昔涟参考音频走 voiceclone 非流式 wav 合成。"));

        var keyBox = MakeTtsPasswordBox(GetString(tts, "mimoKey"));
        var voiceBox = MakeTtsTextBox(GetString(tts, "mimoVoiceAudioPath"), width: 240);
        voiceBox.IsReadOnly = true;
        var styleBox = MakeTtsTextBox(GetString(tts, "mimoStylePrompt"), width: 320);

        var (saveRow, _, _, markDirty) = MakeTtsSaveRow(() => new Dictionary<string, object?>
        {
            ["ttsMimoKey"] = keyBox.Password.Trim(),
            ["ttsMimoVoiceAudioPath"] = voiceBox.Text.Trim(),
            ["ttsMimoStylePrompt"] = styleBox.Text.Trim(),
        });
        keyBox.PasswordChanged += (_, _) => markDirty();
        styleBox.TextChanged += (_, _) => markDirty();

        var pickRow = MakeTtsFileRow(voiceBox, "选择克隆音频", path =>
        {
            // 旧页：点选后立即保存克隆音频路径
            SaveTtsField("ttsMimoVoiceAudioPath", path);
        });
        body.Children.Add(MakeTtsField("API Key", keyBox, "小米 MiMo 平台 API Key。"));
        body.Children.Add(MakeTtsField("昔涟克隆音频", pickRow, "选择昔涟参考音频（mp3/wav/m4a）。"));
        body.Children.Add(MakeTtsField("风格提示", styleBox, "例：温柔、自然、略带亲近感。"));

        body.Children.Add(MakeTtsTestRow(() => new Dictionary<string, object?>
        {
            ["engine"] = "mimo",
            ["apiKey"] = keyBox.Password.Trim(),
            ["voiceAudioPath"] = voiceBox.Text.Trim(),
            ["stylePrompt"] = styleBox.Text.Trim(),
        }));
        body.Children.Add(saveRow);
        return card;
    }

    private FrameworkElement BuildTtsMosslandConfig(JsonElement tts)
    {
        var card = MakeCard(out var body);
        body.Children.Add(MakeSubHeader("Mossland 配置"));
        body.Children.Add(MakeHint("基于 Mossland 云端 TTS（api.mosi.cn）。Bearer 鉴权；支持克隆与音色列表。"));

        var keyBox = MakeTtsPasswordBox(GetString(tts, "mosslandKey"));
        var model = GetString(tts, "mosslandModel", "moss-tts-1.5-flash");
        var voiceBox = MakeTtsTextBox(GetString(tts, "mosslandVoiceId"), width: 320);
        var testTextBox = MakeTtsTextBox(GetString(tts, "mosslandTestText"), width: 320);
        var format = GetString(tts, "mosslandFormat", "mp3");

        var (saveRow, _, _, markDirty) = MakeTtsSaveRow(() => new Dictionary<string, object?>
        {
            ["ttsMosslandKey"] = keyBox.Password.Trim(),
            ["ttsMosslandVoiceId"] = voiceBox.Text.Trim(),
            ["ttsMosslandModel"] = model,
            ["ttsMosslandTestText"] = testTextBox.Text.Trim(),
            ["ttsMosslandFormat"] = format,
        });
        keyBox.PasswordChanged += (_, _) => markDirty();
        voiceBox.TextChanged += (_, _) => markDirty();
        testTextBox.TextChanged += (_, _) => markDirty();

        body.Children.Add(MakeTtsField("API Key", keyBox, "MOSI API 平台 → API 密钥（与 ASR 共用同一把 Key）。"));
        body.Children.Add(MakeTtsField("合成模型", MakeTtsSelect(
            new[]
            {
                ("moss-tts-1.5-flash", "MOSS-TTS 1.5 Flash"),
                ("moss-tts-1.0-pro", "MOSS-TTS 1.0 Pro"),
            },
            model,
            v => markDirty())));
        body.Children.Add(MakeTtsField("音色 ID", voiceBox, "从下方克隆获得，或手动粘贴 voice_id（UUID 格式）。"));
        body.Children.Add(MakeTtsField("试听文本", testTextBox, "点「测试发音」合成的文本。"));
        body.Children.Add(MakeTtsField("试听格式", MakeTtsSelect(
            new[] { ("mp3", "mp3"), ("wav", "wav") },
            format,
            v => markDirty())));

        body.Children.Add(MakeTtsTestRow(() => new Dictionary<string, object?>
        {
            ["engine"] = "mossland",
            ["apiKey"] = keyBox.Password.Trim(),
            ["voiceId"] = voiceBox.Text.Trim(),
            ["text"] = testTextBox.Text.Trim(),
            ["model"] = model,
            ["format"] = format,
        }));
        body.Children.Add(saveRow);
        body.Children.Add(BuildTtsMosslandCloneBlock(
            getApiKey: () => keyBox.Password.Trim(),
            fillVoiceId: id =>
            {
                voiceBox.Text = id;
                markDirty();
            },
            promptSave: () => SaveTtsField("ttsMosslandVoiceId", voiceBox.Text.Trim())));
        body.Children.Add(BuildTtsMosslandVoiceListBlock(
            getApiKey: () => keyBox.Password.Trim(),
            fillVoiceId: id =>
            {
                voiceBox.Text = id;
                markDirty();
            }));
        return card;
    }

    // ── MiniMax 音色快速复刻 ──

    private FrameworkElement BuildTtsMinimaxCloneBlock(Func<string> getApiKey, Action<string> fillVoiceId)
    {
        var section = new StackPanel { Margin = new Thickness(0, 16, 0, 0) };
        var titleRow = new StackPanel { Orientation = Orientation.Horizontal };
        titleRow.Children.Add(new TextBlock
        {
            Text = "音色快速复刻",
            FontSize = 14,
            FontWeight = FontWeights.SemiBold,
            Foreground = NativeTheme.TextStrongBrush,
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(0, 0, 10, 0),
        });
        var infoButton = new Button
        {
            Content = "ⓘ 复刻须知",
            Style = NativeTheme.GhostPillSmallStyle,
            VerticalAlignment = VerticalAlignment.Center,
        };
        infoButton.Click += (_, _) =>
        {
            var dialog = new VoiceSpecDialog("MiniMax 音色快速复刻 · 完整规格", MiniMaxCloneSpecText) { Owner = _window };
            dialog.ShowDialog();
        };
        titleRow.Children.Add(infoButton);
        section.Children.Add(titleRow);
        section.Children.Add(MakeHint("上传昔涟配音（mp3/m4a/wav，10 秒 ~ 5 分钟，≤20MB），训练专属音色。"));
        section.Children.Add(MakeHint("⚠️ 每次复刻收费 ¥9.9；复刻成功后 7 天内无调用将被系统自动删除。"));

        var fileBox = MakeTtsTextBox("", width: 240);
        fileBox.IsReadOnly = true;
        var promptFileBox = MakeTtsTextBox("", width: 240);
        promptFileBox.IsReadOnly = true;
        var promptTextBox = MakeTtsTextBox("", width: 240);
        var cloneTextBox = MakeTtsTextBox("你好，我是昔涟，很高兴见到你。", width: 240);
        var voiceIdBox = MakeTtsTextBox(CreateUniqueMiniMaxVoiceId(), width: 240);

        var fileRow = MakeTtsFileRow(fileBox, "选择配音文件");
        var promptFileRow = MakeTtsFileRow(promptFileBox, "选择示例音频（可选）");
        section.Children.Add(MakeTtsField("配音文件", fileRow));
        section.Children.Add(MakeTtsField("示例音频（可选）", promptFileRow, "提供示例音频可显著增强相似度（≤8 秒）。"));
        section.Children.Add(MakeTtsField("示例文本（可选）", promptTextBox, "示例音频对应的文字。"));
        section.Children.Add(MakeTtsField("复刻文本", cloneTextBox));
        section.Children.Add(MakeTtsField("音色命名", voiceIdBox));

        var status = MakeVoiceStatusText();
        var startButton = new Button { Content = "🚀 开始复刻", Style = NativeTheme.GhostPillStyle, MinWidth = 130 };
        startButton.Click += (_, _) =>
        {
            var apiKey = getApiKey();
            if (apiKey.Length == 0) { SetVoiceStatus(status, "请先填写 MiniMax API Key", "error"); return; }
            var filePath = fileBox.Text.Trim();
            if (filePath.Length == 0) { SetVoiceStatus(status, "请选择配音文件", "error"); return; }
            var cloneText = cloneTextBox.Text.Trim();
            if (cloneText.Length == 0) { SetVoiceStatus(status, "请填写复刻文本", "error"); return; }
            var voiceId = voiceIdBox.Text.Trim();
            if (voiceId.Length == 0) { SetVoiceStatus(status, "请填写音色命名", "error"); return; }

            startButton.IsEnabled = false;
            SetVoiceStatus(status, "正在上传配音文件…", "loading");
            RequestRouter.SendSettingsAction("tts", "clone-minimax", new Dictionary<string, object?>
            {
                ["apiKey"] = apiKey,
                ["filePath"] = filePath,
                ["promptFilePath"] = promptFileBox.Text.Trim(),
                ["promptText"] = promptTextBox.Text.Trim(),
                ["text"] = cloneText,
                ["voiceId"] = voiceId,
            }, (ok, error, data) =>
            {
                startButton.IsEnabled = true;
                if (!ok)
                {
                    SetVoiceStatus(status, "❌ " + (error is { Length: > 0 } ? error : "复刻失败"), "error");
                    // 旧页同款：失败可能是「服务端已创建但响应丢失」，重试同 ID 会报重复 → 换新 ID
                    voiceIdBox.Text = CreateUniqueMiniMaxVoiceId();
                    return;
                }
                var newVoiceId = data.HasValue ? GetString(data.Value, "voiceId") : "";
                if (newVoiceId.Length == 0)
                {
                    SetVoiceStatus(status, "❌ 宿主未返回音色 ID", "error");
                    return;
                }
                fillVoiceId(newVoiceId);
                SetVoiceStatus(status, $"✅ 复刻成功！音色 ID「{newVoiceId}」已自动填入。", "ok");
                var demoPath = data.HasValue ? GetString(data.Value, "demoFilePath") : "";
                if (demoPath.Length > 0) PlayTtsPreview(demoPath);
            }, TimeSpan.FromMinutes(5));
        };
        var actions = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 8, 0, 0) };
        actions.Children.Add(startButton);
        actions.Children.Add(status);
        section.Children.Add(actions);
        return section;
    }

    // ── Mossland 音色克隆 + 音色列表 ──

    private FrameworkElement BuildTtsMosslandCloneBlock(Func<string> getApiKey, Action<string> fillVoiceId, Action promptSave)
    {
        var section = new StackPanel { Margin = new Thickness(0, 16, 0, 0) };
        section.Children.Add(MakeSubHeaderInline("音色克隆"));
        section.Children.Add(MakeHint("上传一段清晰的单人参考音频，Mossland 会通过 multipart/form-data 创建 voice_id。"));
        section.Children.Add(MakeHint("voice_id 由 Mossland 后端返回；点「使用此音色」后记得点上方「保存配置」。"));

        var fileBox = MakeTtsTextBox("", width: 240);
        fileBox.IsReadOnly = true;
        var nameBox = MakeTtsTextBox("", width: 240);
        var descBox = MakeTtsTextBox("", width: 240);
        section.Children.Add(MakeTtsField("参考音频", MakeTtsFileRow(fileBox, "选择参考音频")));
        section.Children.Add(MakeTtsField("音色名称（可选）", nameBox));
        section.Children.Add(MakeTtsField("音色描述（可选）", descBox));

        var status = MakeVoiceStatusText();
        var startButton = new Button { Content = "上传克隆", Style = NativeTheme.GhostPillStyle, MinWidth = 110 };
        startButton.Click += (_, _) =>
        {
            var apiKey = getApiKey();
            if (apiKey.Length == 0) { SetVoiceStatus(status, "请先填写 Mossland API Key", "error"); return; }
            var filePath = fileBox.Text.Trim();
            if (filePath.Length == 0) { SetVoiceStatus(status, "请选择参考音频", "error"); return; }

            startButton.IsEnabled = false;
            SetVoiceStatus(status, "正在上传并创建音色…", "loading");
            RequestRouter.SendSettingsAction("tts", "clone-mossland", new Dictionary<string, object?>
            {
                ["apiKey"] = apiKey,
                ["filePath"] = filePath,
                ["name"] = nameBox.Text.Trim(),
                ["description"] = descBox.Text.Trim(),
            }, (ok, error, data) =>
            {
                startButton.IsEnabled = true;
                if (!ok)
                {
                    SetVoiceStatus(status, "❌ " + (error is { Length: > 0 } ? error : "克隆失败"), "error");
                    return;
                }
                var voiceId = data.HasValue ? GetString(data.Value, "voiceId") : "";
                if (voiceId.Length == 0)
                {
                    SetVoiceStatus(status, "❌ 宿主未返回 voice_id", "error");
                    return;
                }
                fillVoiceId(voiceId);
                promptSave();
                SetVoiceStatus(status, $"✅ 克隆成功！voice_id「{voiceId}」已填入音色 ID 并保存。", "ok");
            }, TimeSpan.FromMinutes(5));
        };
        var actions = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 8, 0, 0) };
        actions.Children.Add(startButton);
        actions.Children.Add(status);
        section.Children.Add(actions);
        return section;
    }

    private FrameworkElement BuildTtsMosslandVoiceListBlock(Func<string> getApiKey, Action<string> fillVoiceId)
    {
        var section = new StackPanel { Margin = new Thickness(0, 16, 0, 0) };
        section.Children.Add(MakeSubHeaderInline("我的 Mossland 音色"));
        section.Children.Add(MakeHint("从 Mossland 服务端拉取账号下已创建的 voice 列表，可一键填入上方「音色 ID」。"));

        var status = MakeVoiceStatusText();
        var list = new StackPanel { Margin = new Thickness(0, 6, 0, 0) };
        var fetchButton = new Button { Content = "拉取音色列表", Style = NativeTheme.GhostPillStyle, MinWidth = 120 };
        fetchButton.Click += (_, _) =>
        {
            var apiKey = getApiKey();
            if (apiKey.Length == 0) { SetVoiceStatus(status, "请先填写 Mossland API Key", "error"); return; }

            fetchButton.IsEnabled = false;
            SetVoiceStatus(status, "正在拉取音色列表…", "loading");
            list.Children.Clear();
            RequestRouter.SendSettingsAction("tts", "list-mossland-voices", new Dictionary<string, object?>
            {
                ["apiKey"] = apiKey,
                ["limit"] = 150,
            }, (ok, error, data) =>
            {
                fetchButton.IsEnabled = true;
                if (!ok)
                {
                    SetVoiceStatus(status, "❌ " + (error is { Length: > 0 } ? error : "拉取失败"), "error");
                    return;
                }
                var voices = data.HasValue && data.Value.TryGetProperty("voices", out var voicesEl)
                    && voicesEl.ValueKind == JsonValueKind.Array ? voicesEl : default;
                var count = voices.ValueKind == JsonValueKind.Array ? voices.GetArrayLength() : 0;
                if (count == 0)
                {
                    SetVoiceStatus(status, "账号下还没有已克隆的音色，请先到上方「音色克隆」创建一个。", "error");
                    return;
                }
                var hasMore = data.HasValue && GetBool(data.Value, "hasMore");
                foreach (var voice in voices.EnumerateArray())
                {
                    list.Children.Add(MakeMosslandVoiceRow(
                        GetString(voice, "id"), GetString(voice, "name"), fillVoiceId));
                }
                SetVoiceStatus(status, $"✅ 拉到 {count} 个音色。点击右侧「使用」可填入音色 ID 框。"
                    + (hasMore ? "仍有更多音色，可稍后继续分页拉取。" : ""), "ok");
            }, TimeSpan.FromMinutes(2));
        };
        var actions = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 8, 0, 0) };
        actions.Children.Add(fetchButton);
        actions.Children.Add(status);
        section.Children.Add(actions);
        section.Children.Add(list);
        return section;
    }

    /// <summary>音色列表行：名称/ID + 「使用」（把 voice_id 填进上方音色 ID 输入框）。</summary>
    private static FrameworkElement MakeMosslandVoiceRow(string id, string name, Action<string> fillVoiceId)
    {
        var grid = new Grid { Margin = new Thickness(0, 4, 0, 0) };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        var copy = new StackPanel();
        copy.Children.Add(new TextBlock
        {
            Text = name.Length > 0 ? name : id,
            FontSize = 13,
            Foreground = NativeTheme.TextStrongBrush,
        });
        copy.Children.Add(new TextBlock
        {
            Text = id,
            FontSize = 12,
            Foreground = NativeTheme.TextMutedBrush,
            TextWrapping = TextWrapping.Wrap,
        });
        Grid.SetColumn(copy, 0);
        grid.Children.Add(copy);
        var useButton = new Button { Content = "使用", Style = NativeTheme.GhostPillSmallStyle, VerticalAlignment = VerticalAlignment.Center };
        useButton.Click += (_, _) => fillVoiceId(id);
        Grid.SetColumn(useButton, 1);
        grid.Children.Add(useButton);
        return grid;
    }

    // ── 试听播放 ──

    private void PlayTtsPreview(string filePath)
    {
        try
        {
            var player = EnsureTtsPreviewPlayer();
            player.Stop();
            player.Close();
            CleanupTtsPreviewFile();
            _ttsPreviewFile = filePath;
            player.Open(new Uri(filePath));
            player.Play();
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("[tts] 试听播放失败: " + ex.Message);
        }
    }

    private MediaPlayer EnsureTtsPreviewPlayer()
    {
        if (_ttsPreviewPlayer is not null) return _ttsPreviewPlayer;
        var player = new MediaPlayer();
        player.MediaEnded += (_, _) => CleanupTtsPreviewFile();
        player.MediaFailed += (_, _) => CleanupTtsPreviewFile();
        _ttsPreviewPlayer = player;
        return player;
    }

    private void CleanupTtsPreviewFile()
    {
        var file = _ttsPreviewFile;
        _ttsPreviewFile = null;
        if (file is null) return;
        try { System.IO.File.Delete(file); } catch { /* 临时文件清理失败不影响使用 */ }
    }

    /// <summary>窗口关闭时停止试听并清理临时文件（SettingsWindow 的 Closed 回调调用）。</summary>
    private void DisposeTtsPreview()
    {
        try
        {
            _ttsPreviewPlayer?.Stop();
            _ttsPreviewPlayer?.Close();
        }
        catch { /* 关闭阶段忽略 */ }
        CleanupTtsPreviewFile();
    }

    // ── TTS 控件工厂（其余 section 不依赖，放本文件） ──

    private static void SaveTtsField(string field, object? value) =>
        RequestRouter.SendSettingsAction("tts", "save", new Dictionary<string, object?> { [field] = value });

    /// <summary>字段：标签在上、控件在下（旧页 .tts-field）。</summary>
    private static Border MakeTtsField(string label, FrameworkElement control, string? hint = null)
    {
        var stack = new StackPanel();
        stack.Children.Add(new TextBlock
        {
            Text = label,
            FontSize = 13,
            Foreground = NativeTheme.TextDefaultBrush,
            Margin = new Thickness(0, 0, 0, 4),
        });
        stack.Children.Add(control);
        if (!string.IsNullOrEmpty(hint))
        {
            var hintText = MakeHint(hint);
            hintText.FontSize = 12.5;
            stack.Children.Add(hintText);
        }
        return new Border { Child = stack, Margin = new Thickness(0, 6, 0, 0) };
    }

    private static TextBox MakeTtsTextBox(string initial, double width = 300) => new()
    {
        Text = initial,
        Width = width,
        FontSize = 14,
        Padding = new Thickness(6, 4, 6, 4),
        VerticalContentAlignment = VerticalAlignment.Center,
        HorizontalAlignment = HorizontalAlignment.Left,
    };

    private static PasswordBox MakeTtsPasswordBox(string initial, double width = 300) => new()
    {
        Password = initial,
        Width = width,
        FontSize = 14,
        Padding = new Thickness(6, 4, 6, 4),
        VerticalContentAlignment = VerticalAlignment.Center,
        HorizontalAlignment = HorizontalAlignment.Left,
    };

    private static ComboBox MakeTtsSelect(
        (string Value, string Label)[] options,
        string current,
        Action<string>? onChange,
        double width = 320)
    {
        var combo = new ComboBox { Width = width, Height = 34, FontSize = 13, HorizontalAlignment = HorizontalAlignment.Left };
        var selectedIndex = 0;
        for (var index = 0; index < options.Length; index++)
        {
            var (value, label) = options[index];
            combo.Items.Add(new ComboBoxItem { Content = label, Tag = value });
            if (value == current) selectedIndex = index;
        }
        combo.SelectedIndex = combo.Items.Count > 0 ? selectedIndex : -1;
        var currentValue = current;
        combo.SelectionChanged += (_, _) =>
        {
            if (combo.SelectedItem is not ComboBoxItem item || item.Tag is not string value || value == currentValue) return;
            currentValue = value;
            onChange?.Invoke(value);
        };
        return combo;
    }

    /// <summary>只读输入框 + 「选择」按钮（点选后回填；可选 onPicked 立即保存）。</summary>
    private StackPanel MakeTtsFileRow(TextBox box, string pickLabel, Action<string>? onPicked = null)
    {
        var row = new StackPanel { Orientation = Orientation.Horizontal };
        row.Children.Add(box);
        var pickButton = new Button
        {
            Content = pickLabel,
            Style = NativeTheme.GhostPillStyle,
            Margin = new Thickness(8, 0, 0, 0),
            VerticalAlignment = VerticalAlignment.Center,
        };
        pickButton.Click += (_, _) =>
        {
            var dialog = new OpenFileDialog
            {
                Title = "选择音频文件",
                Filter = "音频文件|*.mp3;*.m4a;*.wav|所有文件|*.*",
            };
            if (dialog.ShowDialog(_window) != true) return;
            box.Text = dialog.FileName;
            onPicked?.Invoke(dialog.FileName);
        };
        row.Children.Add(pickButton);
        return row;
    }

    /// <summary>
    /// Provider「保存配置」行：输入改动只标脏并显示按钮；点击收集字段整体保存
    /// （与旧页 saveTtsProvider 同语义，避免每个输入框都发 IPC 打断输入法）。
    /// </summary>
    private static (StackPanel Row, Button Button, TextBlock Status, Action MarkDirty) MakeTtsSaveRow(
        Func<Dictionary<string, object?>> collect)
    {
        var status = new TextBlock
        {
            FontSize = 12.5,
            Foreground = NativeTheme.TextMutedBrush,
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(0, 0, 10, 0),
        };
        var button = new Button
        {
            Content = "保存配置",
            Style = NativeTheme.PillPrimaryStyle,
            MinWidth = 96,
            Visibility = Visibility.Collapsed,
        };
        void MarkDirty()
        {
            status.Text = "有未保存的更改";
            status.Foreground = NativeTheme.TextMutedBrush;
            button.Visibility = Visibility.Visible;
        }
        button.Click += (_, _) =>
        {
            var payload = collect();
            if (payload.Count == 0)
            {
                status.Text = "没有可保存的更改";
                return;
            }
            button.IsEnabled = false;
            status.Text = "保存中…";
            RequestRouter.SendSettingsAction("tts", "save", payload, (ok, error, _) =>
            {
                button.IsEnabled = true;
                if (ok)
                {
                    status.Text = "已保存";
                    status.Foreground = new SolidColorBrush(Color.FromRgb(0x1D, 0x9A, 0x54));
                    button.Visibility = Visibility.Collapsed;
                }
                else
                {
                    status.Text = "保存失败：" + (error is { Length: > 0 } ? error : "未知错误");
                    status.Foreground = new SolidColorBrush(Color.FromRgb(0xD3, 0x3A, 0x3A));
                }
            });
        };
        var row = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            HorizontalAlignment = HorizontalAlignment.Right,
            Margin = new Thickness(0, 8, 0, 0),
        };
        row.Children.Add(status);
        row.Children.Add(button);
        return (row, button, status, MarkDirty);
    }

    /// <summary>「测试发音」行：宿主合成（长超时）→ 返回临时文件 → MediaPlayer 播放。</summary>
    private StackPanel MakeTtsTestRow(Func<Dictionary<string, object?>> collect)
    {
        var status = MakeVoiceStatusText();
        var button = new Button
        {
            Content = "🔊 测试发音",
            Style = NativeTheme.GhostPillStyle,
            MinWidth = 130,
            VerticalAlignment = VerticalAlignment.Center,
        };
        button.Click += (_, _) =>
        {
            button.IsEnabled = false;
            var original = button.Content;
            button.Content = "合成中…";
            SetVoiceStatus(status, "正在合成…", "loading");
            RequestRouter.SendSettingsAction("tts", "test", collect(), (ok, error, data) =>
            {
                button.IsEnabled = true;
                button.Content = original;
                if (!ok)
                {
                    SetVoiceStatus(status, "❌ " + (error is { Length: > 0 } ? error : "合成失败"), "error");
                    return;
                }
                var filePath = data.HasValue ? GetString(data.Value, "filePath") : "";
                if (filePath.Length == 0)
                {
                    SetVoiceStatus(status, "❌ 宿主未返回音频文件", "error");
                    return;
                }
                PlayTtsPreview(filePath);
                SetVoiceStatus(status, "✅ 合成成功（正在播放）", "ok");
            }, TimeSpan.FromMinutes(4));
        };
        var row = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 10, 0, 0) };
        row.Children.Add(button);
        row.Children.Add(status);
        return row;
    }

    private static TextBlock MakeVoiceStatusText() => new()
    {
        FontSize = 12.5,
        Foreground = NativeTheme.TextMutedBrush,
        VerticalAlignment = VerticalAlignment.Center,
        Margin = new Thickness(10, 0, 0, 0),
        TextWrapping = TextWrapping.Wrap,
    };

    private static void SetVoiceStatus(TextBlock status, string text, string level)
    {
        status.Text = text;
        status.Foreground = new SolidColorBrush(level switch
        {
            "ok" => Color.FromRgb(0x1D, 0x9A, 0x54),
            "error" => Color.FromRgb(0xD3, 0x3A, 0x3A),
            _ => NativeTheme.TextMuted,
        });
    }

    /// <summary>子模块标题（不带图标/说明，仅 14/600 加粗行）。</summary>
    private static TextBlock MakeSubHeaderInline(string text) => new()
    {
        Text = text,
        FontSize = 14,
        FontWeight = FontWeights.SemiBold,
        Foreground = NativeTheme.TextStrongBrush,
        Margin = new Thickness(0, 12, 0, 4),
    };

    /** 旧页 createUniqueMiniMaxVoiceId 同格式：cyrene-voice-YYYYMMDD-HHMMSS-（base36 6 位，UTC）。 */
    private static string CreateUniqueMiniMaxVoiceId()
    {
        var now = DateTime.UtcNow;
        var suffix = Base36((long)(Random.Shared.NextDouble() * Math.Pow(36, 6))).PadLeft(6, '0');
        return $"cyrene-voice-{now:yyyyMMdd}-{now:HHmmss}-{suffix}";
    }

    private static string Base36(long value)
    {
        const string digits = "0123456789abcdefghijklmnopqrstuvwxyz";
        if (value <= 0) return "0";
        var builder = new System.Text.StringBuilder();
        while (value > 0)
        {
            builder.Insert(0, digits[(int)(value % 36)]);
            value /= 36;
        }
        return builder.ToString();
    }

    /// <summary>MiniMax 复刻须知（旧版富文本 modal 的纯文本等价）。</summary>
    private const string MiniMaxCloneSpecText =
        "费用\n每次成功发起复刻将收取 ¥9.9。试听（text + model）按字符数另计 T2A 费用，与平台其他 T2A 接口同价。\n\n"
        + "过期规则\n复刻得到的音色若 7 天内无任何调用，将被系统自动删除。如需长期保留，不定期点一下「测试发音」即可续命。\n\n"
        + "配音文件 file_id（必填）\n格式：mp3 / m4a / wav；时长：10 秒 ~ 5 分钟；大小：≤ 20 MB。\n\n"
        + "自定义 voice_id（必填）\n长度 8 ~ 256 个字符；首字符须为英文字母；允许数字、字母、-、_；末位不可为 - 或 _；不得与已有 voice_id 重复。\n\n"
        + "示例音频 clone_prompt（可选，强烈推荐）\n格式：mp3 / m4a / wav；时长 < 8 秒；大小 ≤ 20 MB；须填写对应的示例文本（句末需有标点）。\n\n"
        + "复刻文本 text（试听用）\n模型会用克隆后的音色朗读这段文本并返回试听音频链接，便于人工核对相似度。";
}

/// <summary>通用「语音须知」弹窗：标题栏 + 纯文本正文 + 知道了。</summary>
internal sealed class VoiceSpecDialog : Window
{
    public VoiceSpecDialog(string title, string body)
    {
        Title = title;
        Width = 560;
        MaxHeight = 620;
        SizeToContent = SizeToContent.Height;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;
        ResizeMode = ResizeMode.NoResize;
        ShowInTaskbar = false;
        WindowStyle = WindowStyle.None;
        AllowsTransparency = true;
        Background = Brushes.Transparent;
        NativeTheme.Apply(this);

        var root = new StackPanel { Margin = new Thickness(20, 14, 20, 16) };
        root.Children.Add(NativeTheme.BuildTitleBar(this, title));
        var scroll = new ScrollViewer
        {
            MaxHeight = 460,
            VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
            Margin = new Thickness(0, 8, 0, 0),
        };
        scroll.Content = new TextBlock
        {
            Text = body,
            FontSize = 13.5,
            Foreground = NativeTheme.TextDefaultBrush,
            TextWrapping = TextWrapping.Wrap,
            LineHeight = 21,
        };
        root.Children.Add(scroll);
        var actions = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            HorizontalAlignment = HorizontalAlignment.Right,
            Margin = new Thickness(0, 14, 0, 0),
        };
        var close = new Button { Content = "知道了", MinWidth = 96, Style = NativeTheme.PrimaryButtonStyle };
        close.Click += (_, _) => Close();
        actions.Children.Add(close);
        root.Children.Add(actions);
        Content = root;
    }
}

using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;

namespace CyreneNative;

/// <summary>
/// 设置窗「语音识别 ASR」section（对位 Electron asr 面板）：
/// 识别引擎（关闭 / 阿里云 / Mossland / 本地占位）、阿里云凭据与识别语言、
/// Mossland API Key（与 TTS 共用）、通话设置（VAD 静默 / 音量阈值 / 显示转写）。
///
/// 数据：state.settings.asr（native-settings-sections.buildAsrSectionSnapshot）
/// 动作：cmd settings asr { save }
/// 说明：与旧页一致，文本字段失焦 / 回车提交（旧页 800ms 防抖），
/// 开关 / 下拉 / 滑杆即时保存；引擎切换只切本地可见性，不重建 section。
/// </summary>
public sealed partial class SettingsWindow
{
    /// <summary>导航 asr 图标的几何（48 视框；与 SettingsNavIcons 同一份旧页 SVG）。</summary>
    private const string AsrHeadingGlyph =
        "M36 32V32C40.4183 32 44 28.4183 44 24C44 19.5817 40.4183 16 36 16 "
        + "M12 16C7.58172 16 4 19.5817 4 24C4 28.4183 7.58172 32 12 32V32 "
        + "M12 32V31.5V29V24V16C12 9.37258 17.3726 4 24 4C30.6274 4 36 9.37258 36 16V32C36 38.6274 30.6274 44 24 44";

    private FrameworkElement BuildAsrSection()
    {
        var panel = new StackPanel();
        panel.Children.Add(MakePanelHeading(
            NativeTheme.VectorGlyph(AsrHeadingGlyph, 24, NativeTheme.TextDefaultBrush),
            "ASR 设置",
            "语音识别与通话配置"));
        panel.Children.Add(MakeSectionStatus("asr"));

        var asr = GetNode("asr");
        var engine = GetString(asr, "engine", "off");

        // ── 语音识别引擎 ──
        var engineCard = MakeToolCard("🎧", "语音识别引擎", "通话与语音输入使用的识别服务商。", null, out var engineBody);
        var aliyunConfig = BuildAsrAliyunConfig(asr);
        var mosslandConfig = BuildAsrMosslandConfig(asr);

        void SelectEngine(string value)
        {
            aliyunConfig.Visibility = value == "aliyun" ? Visibility.Visible : Visibility.Collapsed;
            mosslandConfig.Visibility = value == "mossland" ? Visibility.Visible : Visibility.Collapsed;
            SaveAsrField("asrEngine", value);
        }

        engineBody.Children.Add(MakeChoiceGroup(
            new[]
            {
                ("off", "关闭", true),
                ("aliyun", "阿里云（实时）", true),
                ("mossland", "Mossland（轮次转写）", true),
                ("local", "本地（敬请期待）", false),
            },
            engine,
            SelectEngine));
        engineBody.Children.Add(MakeHint("阿里云支持实时中间结果；Mossland 会在每轮说话结束后返回完整文本。"));
        panel.Children.Add(engineCard);

        aliyunConfig.Visibility = engine == "aliyun" ? Visibility.Visible : Visibility.Collapsed;
        mosslandConfig.Visibility = engine == "mossland" ? Visibility.Visible : Visibility.Collapsed;
        panel.Children.Add(aliyunConfig);
        panel.Children.Add(mosslandConfig);

        // ── 通话设置 ──
        var callCard = MakeToolCard("📞", "通话设置", "语音通话的断句与字幕显示。", null, out var callBody);

        var vadSilence = GetInt(asr, "vadSilenceMs", 1000);
        var silenceBox = MakeTtsTextBox(vadSilence.ToString(), width: 140);
        void CommitSilence()
        {
            if (!int.TryParse(silenceBox.Text.Trim(), out var value))
            {
                silenceBox.Text = vadSilence.ToString();
                return;
            }
            vadSilence = Math.Min(60_000, Math.Max(100, value));
            silenceBox.Text = vadSilence.ToString();
            SaveAsrField("asrVadSilenceMs", vadSilence);
        }
        silenceBox.LostFocus += (_, _) => CommitSilence();
        silenceBox.KeyDown += (_, e) => { if (e.Key == Key.Enter) CommitSilence(); };
        callBody.Children.Add(MakeTtsField("VAD 静默阈值（毫秒）", silenceBox,
            "用户说话后停顿多久判定为说完。想词慢填大一点（如 3000），反应快填小一点（如 800）。默认 1000ms。"));

        var threshold = GetDouble(asr, "vadThreshold", 0.01);
        callBody.Children.Add(MakeDoubleSliderRow(
            "VAD 音量阈值", threshold, 0.001, 0.5, 0.001, "",
            v =>
            {
                var rounded = Math.Round(v, 3);
                SaveAsrField("asrVadThreshold", rounded);
            },
            v => $"{v:0.###}"));
        callBody.Children.Add(MakeHint("麦克风音量低或环境安静时调小（如 0.005），环境吵时调大。默认 0.01。"));

        callBody.Children.Add(MakeDescribedToggleRow(
            "通话中显示文字转写", "开启后通话窗口显示实时识别文字和昔涟回复文字。",
            GetBool(asr, "showTranscript"), v => SaveAsrField("asrShowTranscript", v)));
        panel.Children.Add(callCard);

        return panel;
    }

    // ── 阿里云配置（engine=aliyun 时显示） ──

    private FrameworkElement BuildAsrAliyunConfig(JsonElement asr)
    {
        var card = MakeCard(out var body);
        body.Children.Add(MakeSubHeader("阿里云配置"));
        body.Children.Add(MakeHint("阿里云 → 智能语音交互控制台 → 创建项目获取 AppKey；AccessKey 在 RAM 访问控制台获取。Token 自动获取。"));
        card.Margin = new Thickness(0, 6, 0, 6);

        body.Children.Add(MakeTtsField("App Key",
            MakeAsrCommitBox(GetString(asr, "aliyunAppKey"), v => SaveAsrField("asrAliyunAppKey", v)),
            "智能语音交互控制台 → 项目设置 → AppKey。"));
        body.Children.Add(MakeTtsField("AccessKey ID",
            MakeAsrCommitBox(GetString(asr, "aliyunAccessKeyId"), v => SaveAsrField("asrAliyunAccessKeyId", v)),
            "RAM 访问控制 → AccessKey 管理。"));
        body.Children.Add(MakeTtsField("AccessKey Secret",
            MakeAsrSecretBox(GetString(asr, "aliyunAccessKeySecret"), v => SaveAsrField("asrAliyunAccessKeySecret", v)),
            "创建 AccessKey 时显示的 Secret。"));

        var language = GetString(asr, "language", "zh");
        body.Children.Add(MakeTtsField("识别语言", MakeChoiceGroup(
            new[] { ("zh", "中文", true), ("en", "英文", true) },
            language,
            v => SaveAsrField("asrLanguage", v))));
        return card;
    }

    // ── Mossland 配置（engine=mossland 时显示） ──

    private FrameworkElement BuildAsrMosslandConfig(JsonElement asr)
    {
        var card = MakeCard(out var body);
        body.Children.Add(MakeSubHeader("Mossland 配置"));
        card.Margin = new Thickness(0, 6, 0, 6);

        body.Children.Add(MakeTtsField("API Key",
            MakeAsrSecretBox(GetString(asr, "mosslandKey"), v => SaveAsrField("ttsMosslandKey", v)),
            "与 Mossland TTS 共用同一 API Key。音频在 VAD 判定本轮结束后上传到 moss-transcribe，不提供实时中间字幕。"));
        return card;
    }

    // ── ASR 控件（提交即保存；密码框失焦/回车提交） ──

    private static TextBox MakeAsrCommitBox(string initial, Action<string> onCommit)
    {
        var box = MakeTtsTextBox(initial, width: 320);
        var committed = initial;
        void Commit()
        {
            var text = box.Text.Trim();
            if (text == committed) return;
            committed = text;
            onCommit(text);
        }
        box.LostFocus += (_, _) => Commit();
        box.KeyDown += (_, e) => { if (e.Key == Key.Enter) Commit(); };
        return box;
    }

    private static PasswordBox MakeAsrSecretBox(string initial, Action<string> onCommit)
    {
        var box = MakeTtsPasswordBox(initial, width: 320);
        var committed = initial;
        void Commit()
        {
            var text = box.Password.Trim();
            if (text == committed) return;
            committed = text;
            onCommit(text);
        }
        box.LostFocus += (_, _) => Commit();
        box.KeyDown += (_, e) => { if (e.Key == Key.Enter) Commit(); };
        return box;
    }

    private void SaveAsrField(string field, object? value) =>
        RequestRouter.SendSettingsAction("asr", "save", new Dictionary<string, object?> { [field] = value },
            (ok, error, _) =>
            {
                if (ok) return;
                // 逐字段静默保存：失败把错误写进 section 状态行（旧页仅 console.warn，用户不可见）
                _lastNotices["asr"] = ($"保存失败：{(error is { Length: > 0 } ? error : "未知错误")}", "error");
                RenderNotice("asr");
            });
}

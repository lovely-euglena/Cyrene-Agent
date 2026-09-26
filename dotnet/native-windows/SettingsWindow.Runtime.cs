using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;

namespace CyreneNative;

/// <summary>
/// 设置窗「高级设置」section（对位 Electron api-advanced）：
/// 模型请求超时（秒，可空 = 默认）、询问等待时间（秒）、工具并发数。
/// 数据：state.settings.runtime；动作：cmd settings runtime {"verb":"save"}
/// </summary>
public sealed partial class SettingsWindow
{
    private FrameworkElement BuildRuntimeSection()
    {
        var panel = new StackPanel();
        panel.Children.Add(MakeHeader("运行设置"));
        panel.Children.Add(MakeHint("控制模型请求、询问用户等待时间与 Harness 工具执行方式。"));
        panel.Children.Add(MakeSectionStatus("runtime"));

        var runtime = GetNode("runtime");
        var modelTimeout = GetNode(runtime, "modelRequestTimeoutSec");
        var choiceMs = GetInt(runtime, "userChoiceTimeout", 60000);
        var parallel = GetInt(runtime, "maxParallelToolCalls", 4);

        var modelTimeoutBox = MakeApiTextBox(modelTimeout.ValueKind == JsonValueKind.Number
            ? modelTimeout.GetInt32().ToString()
            : "");
        modelTimeoutBox.Width = 120;
        panel.Children.Add(MakeRow("模型请求超时（秒）",
            MakeResetInputRow(modelTimeoutBox, "60", "重置为默认（60 秒）")));
        panel.Children.Add(MakeHint("留空 = 默认 60 秒；用于非流式请求（10–600）。"));

        var choiceBox = MakeApiTextBox(Math.Max(1, choiceMs / 1000).ToString());
        choiceBox.Width = 120;
        panel.Children.Add(MakeRow("询问等待时间（秒）",
            MakeResetInputRow(choiceBox, "60", "重置为默认（60 秒）")));
        panel.Children.Add(MakeHint("模型向你提问后等待回答的时长（默认 60 秒）。"));

        var parallelBox = MakeApiTextBox(parallel.ToString());
        parallelBox.Width = 120;
        panel.Children.Add(MakeRow("工具并发数", parallelBox));
        panel.Children.Add(MakeHint("1–8，1 = 串行；保存后从下一个任务生效。"));

        panel.Children.Add(MakeActionButton("保存设置", () =>
        {
            int? modelTimeoutSec = int.TryParse(modelTimeoutBox.Text.Trim(), out var mt)
                ? Math.Clamp(mt, 10, 600)
                : null;
            var choiceSec = int.TryParse(choiceBox.Text.Trim(), out var cs) ? Math.Clamp(cs, 1, 3600) : 60;
            var parallelValue = int.TryParse(parallelBox.Text.Trim(), out var pc) ? Math.Clamp(pc, 1, 8) : 4;
            RequestRouter.SendSettingsAction("runtime", "save", new Dictionary<string, object?>
            {
                ["modelRequestTimeoutSec"] = modelTimeoutSec,
                ["userChoiceTimeout"] = choiceSec,
                ["maxParallelToolCalls"] = parallelValue,
            });
        }, primary: true));

        return panel;
    }

    /// <summary>数字输入 +「重置为默认」（旧版 .timeout-reset ↻ 按钮）。</summary>
    private FrameworkElement MakeResetInputRow(TextBox box, string defaultValue, string tip)
    {
        var row = new StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center };
        row.Children.Add(box);
        row.Children.Add(MakeMiniButton("↻", tip, () => box.Text = defaultValue));
        return row;
    }
}

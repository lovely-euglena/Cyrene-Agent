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
        panel.Children.Add(MakeHeader("高级设置"));
        panel.Children.Add(MakeHint("运行期参数；保存后从下一个请求/任务生效。"));
        panel.Children.Add(MakeSectionStatus("runtime"));

        var runtime = GetNode("runtime");
        var modelTimeout = GetNode(runtime, "modelRequestTimeoutSec");
        var choiceMs = GetInt(runtime, "userChoiceTimeout", 60000);
        var parallel = GetInt(runtime, "maxParallelToolCalls", 4);

        var modelTimeoutBox = MakeApiTextBox(modelTimeout.ValueKind == JsonValueKind.Number
            ? modelTimeout.GetInt32().ToString()
            : "");
        modelTimeoutBox.Width = 120;
        panel.Children.Add(MakeRow("模型请求超时（秒）", modelTimeoutBox));
        panel.Children.Add(MakeHint("留空 = 默认 60 秒；用于非流式请求（10–600）。"));

        var choiceBox = MakeApiTextBox(Math.Max(1, choiceMs / 1000).ToString());
        choiceBox.Width = 120;
        panel.Children.Add(MakeRow("询问等待时间（秒）", choiceBox));
        panel.Children.Add(MakeHint("模型向你提问后等待回答的时长（默认 60 秒）。"));

        var parallelBox = MakeApiTextBox(parallel.ToString());
        parallelBox.Width = 120;
        panel.Children.Add(MakeRow("工具并发数", parallelBox));
        panel.Children.Add(MakeHint("1–8，1 = 串行；保存后从下一个任务生效。"));

        panel.Children.Add(MakeButton("保存设置", () =>
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

        panel.Children.Add(MakeLegacyButton("api-advanced"));
        return panel;
    }
}

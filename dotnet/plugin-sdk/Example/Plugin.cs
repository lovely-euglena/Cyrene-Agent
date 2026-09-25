using System.Text.Json;
using Cyrene.PluginSdk;

namespace HelloDotnet;

/// <summary>最小 dotnet 插件示例：echo 工具。文档与协议自测共用。</summary>
public sealed class HelloPlugin : CyrenePluginBase
{
    [CyreneTool("echo", "回声", "把输入原样返回（演示工具）",
        Schema = """{"type":"object","properties":{"text":{"type":"string","description":"要回声的文本"}},"required":["text"]}""")]
    public object Echo(JsonElement args)
    {
        var text = args.TryGetProperty("text", out var t) ? t.GetString() : "";
        Log($"echo: {text}");
        return new { echoed = text, plugin = "hello-dotnet", at = DateTimeOffset.UtcNow };
    }

    /// <summary>async Task&lt;T&gt; 返回值回归用例：旧 SDK 只 await Task&lt;object?&gt;/Task&lt;JsonElement&gt;，
    /// 这个工具会静默不回帧（宿主 invoke 永久 pending）。</summary>
    [CyreneTool("echo_async", "异步回声", "Task<string> 路径演示：await 后返回字符串",
        Schema = """{"type":"object","properties":{"text":{"type":"string","description":"要回声的文本"}},"required":["text"]}""")]
    public async Task<string> EchoAsync(JsonElement args)
    {
        var text = args.TryGetProperty("text", out var t) ? t.GetString() : "";
        await Task.Delay(10);
        return $"async echoed: {text}";
    }
}

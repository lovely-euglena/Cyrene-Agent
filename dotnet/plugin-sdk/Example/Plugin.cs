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
}

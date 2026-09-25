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

    /// <summary>取消回归用例：长等待期间响应宿主 cancel 帧（声明 CancellationToken 参数）。</summary>
    [CyreneTool("echo_slow", "慢回声", "等待 ms 毫秒后回声；用于验证宿主取消/超时能中止在途调用",
        Schema = """{"type":"object","properties":{"ms":{"type":"integer","description":"等待毫秒数"},"text":{"type":"string","description":"回声文本"}},"required":["ms"]}""")]
    public async Task<string> EchoSlow(JsonElement args, CancellationToken ct)
    {
        var ms = args.TryGetProperty("ms", out var m) && m.TryGetInt32(out var v) ? v : 1000;
        var text = args.TryGetProperty("text", out var t) ? t.GetString() : "";
        await Task.Delay(ms, ct);
        return $"slow echoed: {text}";
    }
}

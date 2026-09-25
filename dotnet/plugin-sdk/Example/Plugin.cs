using System.Text.Json;
using Cyrene.PluginSdk;

namespace HelloDotnet;

/// <summary>
/// 最小 dotnet 插件示例，同时是文档与协议自测的回归夹具：
/// 同步 object / async Task&lt;T&gt; / 取消 / IPC / 提示词 Provider / 事件 / 私有存储 /
/// 宿主服务（deps）/ 命名类型序列化约定。
/// </summary>
public sealed class HelloPlugin : CyrenePluginBase
{
    protected override Task OnStartupAsync(CancellationToken ct)
    {
        // 插件私有 IPC：面板/渲染端经 plugin:hello-dotnet:ping 调用
        RegisterIpc("ping", (args, _) => Task.FromResult<object?>(new { pong = true, argCount = args.Length }));

        // 每轮对话注入的动态上下文（宿主 2s 超时、16k 截断）
        RegisterPromptProvider(new PromptProvider
        {
            Id = "demo",
            Sources = ["conversation"],
            Provide = (input, _) => Task.FromResult($"[hello-dotnet] demo context for {input.Mode}"),
        });

        // 订阅宿主事件；收到后回发短事件，冒烟脚本据此断言投递链路
        Events.On("host:turn:finished", (_, _) =>
        {
            Log("收到 host:turn:finished");
            return Events.EmitAsync("turn_seen");
        });

        return Task.CompletedTask;
    }

    /// <summary>open 能力回归：宿主点击「打开」时调用（示例没有窗口，只记日志）。</summary>
    protected override Task OnOpenAsync(CancellationToken ct)
    {
        Log("open 被调用");
        return Task.CompletedTask;
    }

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

    /// <summary>插件 → 宿主事件回归用例（宿主侧由冒烟脚本应答）。</summary>
    [CyreneTool("emit_event", "发布事件", "向宿主发布插件事件（协议自测）",
        Schema = """{"type":"object","properties":{"event":{"type":"string","description":"事件短名"}},"required":["event"]}""")]
    public async Task<string> EmitEvent(JsonElement args)
    {
        var name = args.TryGetProperty("event", out var e) ? e.GetString() : null;
        await EmitEventAsync(string.IsNullOrEmpty(name) ? "test" : name, new { from = "hello-dotnet" });
        return "emitted";
    }

    /// <summary>私有存储回归用例：与 Node 轨同一文件格式（&lt;DataDir&gt;/&lt;key&gt;.json）。</summary>
    [CyreneTool("kv_set", "写存储", "写入插件私有 KV（协议自测）",
        Schema = """{"type":"object","properties":{"key":{"type":"string"},"value":{}},"required":["key","value"]}""")]
    public object KvSet(JsonElement args)
    {
        var key = args.TryGetProperty("key", out var k) ? k.GetString() ?? "k" : "k";
        var value = args.TryGetProperty("value", out var v) ? v : default;
        Storage.Set(key, value);
        return new { ok = true, key };
    }

    /// <summary>私有存储回归用例：不存在时回 null。</summary>
    [CyreneTool("kv_get", "读存储", "读取插件私有 KV（协议自测）",
        Schema = """{"type":"object","properties":{"key":{"type":"string"}},"required":["key"]}""")]
    public object? KvGet(JsonElement args)
    {
        var key = args.TryGetProperty("key", out var k) ? k.GetString() ?? "k" : "k";
        return Storage.Get<object?>(key);
    }

    /// <summary>宿主服务（deps）回归用例：一次调用串起全部已声明服务，冒烟脚本按方法应答。</summary>
    [CyreneTool("deps_probe", "依赖探针", "调用宿主服务并汇总结果（协议自测）")]
    public async Task<object> DepsProbe(JsonElement args, CancellationToken ct)
    {
        var hasChannel = await Deps.Channels.HasAsync("feishu", ct);
        await Deps.Secrets.SetAsync("probe", "v1", ct);
        var secret = await Deps.Secrets.GetAsync("probe", ct);
        var binding = await Deps.Workspace.GetBindingAsync("conv-1", ct);
        var conversations = await Deps.Conversations.ListAsync(new ConversationListInput { Limit = 1 }, ct);
        var tasks = await Deps.Scheduler.ListTasksAsync(ct);
        var llm = await Deps.Llm.GenerateTextAsync(
            new[] { new LlmMessage { Role = "user", Content = "hi" } },
            new LlmGenerateOptions { MaxTokens = 16, Purpose = "probe" },
            ct);
        return new
        {
            hasChannel,
            secret,
            bindingRoot = binding?.Root,
            conversations = conversations.Items.Count,
            tasks = tasks.Count,
            llm,
        };
    }

    /// <summary>错误码回归用例：宿主回 ok:false + code 时应抛 <see cref="PluginHostException"/>。</summary>
    [CyreneTool("deps_error_probe", "依赖错误探针", "验证宿主错误码透传（协议自测）")]
    public async Task<object> DepsErrorProbe(JsonElement args, CancellationToken ct)
    {
        try
        {
            await Deps.Secrets.DeleteAsync("boom", ct);
            return new { code = "none" };
        }
        catch (PluginHostException ex)
        {
            return new { code = ex.Code };
        }
    }

    /// <summary>序列化约定回归用例：命名类型返回值按 camelCase 字段回传（与 Node 轨 JSON 风格一致）。</summary>
    [CyreneTool("shape_probe", "形状探针", "验证命名类型结果 camelCase 序列化（协议自测）")]
    public object ShapeProbe(JsonElement args) => new ShapeProbeResult { OkValue = true, CountValue = 3 };

    private sealed class ShapeProbeResult
    {
        public bool OkValue { get; init; }
        public int CountValue { get; init; }
    }
}

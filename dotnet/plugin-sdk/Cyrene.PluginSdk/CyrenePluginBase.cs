using System.Reflection;
using System.Text;
using System.Text.Json;

namespace Cyrene.PluginSdk;

/// <summary>
/// Cyrene .NET 插件基类（双轨制第二轨）。
///
/// 子类用 <see cref="CyreneToolAttribute"/> 标注工具方法，在 Main 里调用
/// <see cref="Run"/> 即完成宿主接入。协议（与宿主 dotnet-adapter.ts 对应）：
///
///   宿主 → 插件（stdin，每行一个 JSON）：
///     {"op":"init","apiVersion":1,"manifest":{...},"dataDir":"..."}
///     {"op":"invoke","callId":"c1","tool":"短id","args":{...}}
///     {"op":"shutdown"}
///
///   插件 → 宿主（stdout，每行一个 JSON）：
///     {"op":"ready","tools":[{id,name,description,inputSchema}]}
///     {"op":"result","callId":"c1","ok":true,"data":...}
///     {"op":"result","callId":"c1","ok":false,"error":"..."}
///     {"op":"log","level":"info","message":"..."}
///
/// 注意：stdout 被协议独占——诊断输出必须用 <see cref="Log"/>（走 log 帧）
/// 或 stderr（自由文本，宿主只打日志不解析）。
/// </summary>
public abstract class CyrenePluginBase
{
    private record ToolEntry(string Id, string Name, string Description, JsonElement Schema, MethodInfo Method)
    {
        public bool IsStatic => Method.IsStatic;
    }

    private readonly Dictionary<string, ToolEntry> _tools = new();
    private string _dataDir = "";
    private string _pluginId = "plugin";

    /// <summary>宿主分配的插件私有数据目录（init 后有效；持久化写这里）。</summary>
    protected string DataDir => _dataDir;

    /// <summary>本插件 id（manifest.id，init 后有效）。</summary>
    protected string PluginId => _pluginId;

    /// <summary>诊断日志（走协议 log 帧，宿主统一打 [plugin:id] 前缀）。</summary>
    protected void Log(string message, string level = "info")
        => WriteLine(new { op = "log", level, message });

    /// <summary>插件启动完成前的钩子（init 之后、ready 之前）——子类可重写做初始化。</summary>
    protected virtual Task OnStartupAsync(CancellationToken ct) => Task.CompletedTask;

    /// <summary>shutdown 时钩子——子类可重写做清理（5s 内返回，超时被强杀）。</summary>
    protected virtual Task OnShutdownAsync(CancellationToken ct) => Task.CompletedTask;

    // ── 协议主循环 ──

    /// <summary>插件入口：Main 里调用，阻塞至宿主关停。</summary>
    public static void Run(CyrenePluginBase plugin) => plugin.RunAsync().GetAwaiter().GetResult();

    private async Task RunAsync()
    {
        CollectTools();
        Console.OutputEncoding = Encoding.UTF8;

        using var cts = new CancellationTokenSource();
        Console.CancelKeyPress += (_, e) => { e.Cancel = true; cts.Cancel(); };

        using var stdin = Console.OpenStandardInput();
        using var reader = new StreamReader(stdin, Encoding.UTF8);
        using var stdoutLock = new SemaphoreSlim(1, 1);

        string? line;
        while (!cts.IsCancellationRequested && (line = await reader.ReadLineAsync(cts.Token)) is not null)
        {
            if (string.IsNullOrWhiteSpace(line)) continue;
            JsonDocument doc;
            try { doc = JsonDocument.Parse(line); }
            catch (JsonException) { continue; } // 非 JSON 行：忽略（宿主保证不发生）

            var op = doc.RootElement.TryGetProperty("op", out var opEl) ? opEl.GetString() : null;
            switch (op)
            {
                case "init":
                    await HandleInitAsync(doc.RootElement, cts.Token);
                    break;
                case "invoke":
                    // 并行调用：不阻塞读循环（长任务不影响后续 invoke）
                    _ = HandleInvokeAsync(doc.RootElement, cts.Token);
                    break;
                case "shutdown":
                    await OnShutdownAsync(cts.Token);
                    return;
            }
        }
    }

    private async Task HandleInitAsync(JsonElement frame, CancellationToken ct)
    {
        if (frame.TryGetProperty("manifest", out var mf) && mf.ValueKind == JsonValueKind.Object)
        {
            if (mf.TryGetProperty("id", out var idEl)) _pluginId = idEl.GetString() ?? "plugin";
        }
        if (frame.TryGetProperty("dataDir", out var dd) && dd.ValueKind == JsonValueKind.String)
        {
            _dataDir = dd.GetString() ?? "";
            if (!string.IsNullOrEmpty(_dataDir)) Directory.CreateDirectory(_dataDir);
        }
        await OnStartupAsync(ct);
        WriteLine(new
        {
            op = "ready",
            tools = _tools.Values.Select(t => new
            {
                id = t.Id, name = t.Name, description = t.Description, inputSchema = t.Schema,
            }),
        });
    }

    private async Task HandleInvokeAsync(JsonElement frame, CancellationToken ct)
    {
        var callId = frame.TryGetProperty("callId", out var c) ? c.GetString() ?? "" : "";
        var toolId = frame.TryGetProperty("tool", out var t) ? t.GetString() ?? "" : "";
        var args = frame.TryGetProperty("args", out var a) && a.ValueKind == JsonValueKind.Object ? a : default;

        try
        {
            if (!_tools.TryGetValue(toolId, out var entry))
            {
                WriteLine(new { op = "result", callId, ok = false, error = $"未知工具: {toolId}" });
                return;
            }
            var result = InvokeTool(entry, args);
            var value = result switch
            {
                Task<JsonElement> je => await je,
                Task<object?> to => await to,
                _ => result,
            };
            WriteLine(new { op = "result", callId, ok = true, data = value });
        }
        catch (Exception ex)
        {
            WriteLine(new { op = "result", callId, ok = false, error = ex.Message });
        }
    }

    private object? InvokeTool(ToolEntry entry, JsonElement args)
    {
        var parameters = entry.Method.GetParameters();
        object?[] invocation =
        [
            parameters.Length > 0 && args.ValueKind == JsonValueKind.Object ? args : (object?)JsonDocument.Parse("{}").RootElement,
        ];
        return entry.Method.Invoke(entry.IsStatic ? null : this, invocation);
    }

    private void CollectTools()
    {
        foreach (var method in GetType().GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static))
        {
            var attr = method.GetCustomAttribute<CyreneToolAttribute>();
            if (attr is null) continue;
            JsonElement schema;
            try { schema = JsonDocument.Parse(attr.Schema).RootElement.Clone(); }
            catch (JsonException)
            {
                schema = JsonDocument.Parse("""{"type":"object","properties":{}}""").RootElement.Clone();
            }
            _tools[attr.Id] = new ToolEntry(attr.Id, attr.Name, attr.Description, schema, method);
        }
    }

    private void WriteLine(object frame)
    {
        try { Console.Out.WriteLine(JsonSerializer.Serialize(frame)); Console.Out.Flush(); }
        catch { /* stdout 关闭：进程即将退出 */ }
    }
}

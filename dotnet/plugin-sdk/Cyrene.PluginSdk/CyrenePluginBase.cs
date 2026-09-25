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
///     {"op":"ready","tools":[{id,name,description,inputSchema,risk?}]}
///     {"op":"result","callId":"c1","ok":true,"data":...}
///     {"op":"result","callId":"c1","ok":false,"error":"..."}
///     {"op":"log","level":"info","message":"..."}
///     {"op":"error","code":"...","message":"...","fatal":true}   // 致命（如版本不符）→ 退出
///
/// 注意：stdout 被协议独占——诊断输出必须用 <see cref="Log"/>（走 log 帧）
/// 或 stderr（自由文本，宿主只打日志不解析）。
/// </summary>
public abstract class CyrenePluginBase
{
    /// <summary>SDK 支持的协议主版本（与宿主 dotnet-adapter.ts 的 PROTOCOL_API_VERSION 对齐）。
    /// init 帧的 apiVersion 不符时回 error 帧并退出，避免大版本不匹配被静默接受。</summary>
    public const int ApiVersion = 1;

    private record ToolEntry(string Id, string Name, string Description, JsonElement Schema, MethodInfo Method, string? Risk)
    {
        public bool IsStatic => Method.IsStatic;
    }

    /// <summary>无参数工具调用的占位实参（避免每次调用解析 JSON）。</summary>
    private static readonly JsonElement EmptyArgs = JsonDocument.Parse("{}").RootElement.Clone();

    private static readonly JsonElement EmptyObjectSchema =
        JsonDocument.Parse("""{"type":"object","properties":{}}""").RootElement.Clone();

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
                    // 返回 false = 致命错误（如协议版本不符）：回错误帧后退出
                    if (!await HandleInitAsync(doc.RootElement, cts.Token)) return;
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

    private async Task<bool> HandleInitAsync(JsonElement frame, CancellationToken ct)
    {
        var hostApi = frame.TryGetProperty("apiVersion", out var av) && av.ValueKind == JsonValueKind.Number
            ? av.GetInt32()
            : 0;
        if (hostApi != ApiVersion)
        {
            var message = $"协议版本不匹配：宿主 apiVersion={hostApi}，插件 SDK 支持 {ApiVersion}";
            Warn(message);
            WriteLine(new { op = "error", code = "api_version_mismatch", message, fatal = true });
            return false;
        }
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
                id = t.Id, name = t.Name, description = t.Description, inputSchema = t.Schema, risk = t.Risk,
            }),
        });
        return true;
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
            var value = await AwaitResultAsync(result);
            WriteLine(new { op = "result", callId, ok = true, data = value });
        }
        catch (Exception ex)
        {
            // 失败细节进 stderr（宿主打日志），协议帧只带 message
            Warn($"工具 {toolId} 执行失败: {ex}");
            WriteLine(new { op = "result", callId, ok = false, error = ex.Message });
        }
    }

    /// <summary>
    /// 归一化工具返回值：Task / Task&lt;T&gt; 一律 await 后取结果，同步返回值原样返回。
    /// 旧实现只匹配 Task&lt;JsonElement&gt; / Task&lt;object?&gt;（泛型不变，Task&lt;string&gt;
    /// 等落到默认分支），把未 await 的 async 状态机 Task 拿去序列化 → 序列化异常被
    /// WriteLine 吞掉 → 宿主 invoke 永久 pending。
    /// </summary>
    private static async Task<object?> AwaitResultAsync(object? result)
    {
        if (result is not Task task) return result;
        await task.ConfigureAwait(false);
        var type = task.GetType();
        // Task<T>：取 Result；非泛型 Task（无返回值）：null
        return type.IsGenericType ? type.GetProperty("Result")?.GetValue(task) : null;
    }

    private object? InvokeTool(ToolEntry entry, JsonElement args)
    {
        var parameters = entry.Method.GetParameters();
        // 签名已在 CollectTools 保证：0 参数或单个 JsonElement 参数
        object?[] invocation = parameters.Length == 0
            ? []
            : [args.ValueKind == JsonValueKind.Object ? args : EmptyArgs];
        return entry.Method.Invoke(entry.IsStatic ? null : this, invocation);
    }

    private void CollectTools()
    {
        foreach (var method in GetType().GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static))
        {
            var attr = method.GetCustomAttribute<CyreneToolAttribute>();
            if (attr is null) continue;
            if (string.IsNullOrWhiteSpace(attr.Id))
            {
                Warn($"忽略 {method.Name}：[CyreneTool] 缺少 id");
                continue;
            }
            // 签名白名单：0 参数，或单个 JsonElement 参数。不合法在 init 时即报出，
            // 不再等到调用时抛 TargetParameterCountException / 参数转换异常。
            var parameters = method.GetParameters();
            var validSignature = parameters.Length == 0
                || (parameters.Length == 1 && parameters[0].ParameterType == typeof(JsonElement));
            if (!validSignature)
            {
                Warn($"忽略工具 {attr.Id}（{method.Name}）：签名必须是无参或单个 JsonElement 参数");
                continue;
            }
            JsonElement schema;
            try { schema = JsonDocument.Parse(attr.Schema).RootElement.Clone(); }
            catch (JsonException ex)
            {
                Warn($"工具 {attr.Id} 的 Schema 不是合法 JSON，已回退为空对象: {ex.Message}");
                schema = EmptyObjectSchema;
            }
            if (_tools.ContainsKey(attr.Id))
            {
                Warn($"工具 id 重复：{attr.Id}（{method.Name} 将覆盖先前声明）");
            }
            _tools[attr.Id] = new ToolEntry(attr.Id, attr.Name, attr.Description, schema, method, attr.Risk);
        }
    }

    /// <summary>SDK 内部诊断：有返回值走 stderr（stdout 被协议独占），宿主收集为日志。</summary>
    private static void Warn(string message) => Console.Error.WriteLine($"[cyrene-plugin] {message}");

    private void WriteLine(object frame)
    {
        string json;
        try { json = JsonSerializer.Serialize(frame); }
        catch (Exception ex)
        {
            // 序列化失败必须显式暴露：吞掉后调用方只看到宿主 invoke 永久 pending
            Warn($"帧序列化失败（{frame.GetType().Name}）: {ex.Message}");
            return;
        }
        try { Console.Out.WriteLine(json); Console.Out.Flush(); }
        catch { /* stdout 关闭：进程即将退出 */ }
    }
}

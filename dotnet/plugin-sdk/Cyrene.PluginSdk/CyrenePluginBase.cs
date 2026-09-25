using System.Collections.Concurrent;
using System.Reflection;
using System.Runtime.ExceptionServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace Cyrene.PluginSdk;

/// <summary>
/// Cyrene .NET 插件基类（双轨制第二轨）。
///
/// 子类用 <see cref="CyreneToolAttribute"/> 标注工具方法，在 Main 里调用
/// <see cref="Run"/> 即完成宿主接入。协议（与宿主 dotnet-adapter.ts 对应）：
///
///   v1（工具轨，宿主 → 插件）：
///     {"op":"init","apiVersion":1,"protocolVersion":2,"manifest":{...},"dataDir":"..."}
///     {"op":"invoke","callId":"c1","tool":"短id","args":{...}}
///     {"op":"cancel","id":"c1","reason":"abort|timeout"}   // 取消在途调用（工具可声明 CancellationToken 接收）
///     {"op":"shutdown"}
///   插件 → 宿主：
///     {"op":"ready","protocolVersion":2,"tools":[...],"ipc":[...],"events":[...],
///      "promptProviders":[...],"capabilities":{"open":false}}
///     {"op":"result","callId":"c1","ok":true,"data":...}
///     {"op":"result","callId":"c1","ok":false,"error":"..."}
///     {"op":"log","level":"info|warn|error","message":"..."}
///     {"op":"error","code":"...","message":"...","fatal":true}   // 致命（如版本不符）→ 退出
///
///   v2 桥（init 的 protocolVersion>=2 时启用；旧宿主缺少该字段则相关 API 抛 NotSupported）：
///     宿主 → 插件：{"op":"call","id":"h1","method":"ipc.dispatch|prompt.provide|plugin.open","params":{...}}
///                  插件回 {"op":"reply","id":"h1","ok":true,"data":...}
///     plugin → 宿主：{"op":"call","id":"p1","method":"events.emit|ipc.register|ipc.unregister|prompt.register|prompt.unregister|events.subscribe|events.unsubscribe","params":{...}}
///     宿主 → 插件通知：{"op":"notify","method":"event.deliver","params":{...}}
///     plugin → 宿主还可调用宿主服务（manifest.deps 声明后可用）：
///       deps.channels.has / deps.llm.generateText /
///       deps.secrets.get|set|delete / deps.conversations.list|getMessages /
///       deps.workspace.getBinding /
///       deps.scheduler.createTask|listTasks|updateTask|deleteTask|getHistory
///
/// 注意：stdout 被协议独占——诊断输出必须用 <see cref="Log"/>（走 log 帧）
/// 或 stderr（自由文本，宿主只打日志不解析）。
/// 所有宿主调用（含事件处理、IPC 处理、提示词 Provider）都在线程池上执行，不阻塞读循环。
/// </summary>
public abstract class CyrenePluginBase
{
    /// <summary>SDK 支持的 manifest/协议主版本（与宿主 dotnet-adapter.ts 的 PROTOCOL_API_VERSION 对齐）。</summary>
    public const int ApiVersion = 1;

    /// <summary>SDK 支持的桥协议版本（IPC/事件/提示词/open/deps）；宿主 init 携带 protocolVersion 完成协商。</summary>
    public const int ProtocolVersion = 2;

    /// <summary>
    /// SDK 内部 JSON 约定：Web 默认（camelCase + 大小写不敏感）+ 忽略 null 字段，
    /// 与宿主 JSON 行协议 / Node API 的命名风格保持一致。
    /// </summary>
    internal static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private static readonly Regex IpcChannelRegex = new("^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$", RegexOptions.Compiled);
    private static readonly Regex ProviderIdRegex = new("^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$", RegexOptions.Compiled);
    private static readonly string[] ValidPromptModes = ["chat", "work", "learn", "code"];
    private static readonly string[] ValidPromptSources = ["conversation", "scheduler", "moments-post", "plugin-agent"];

    private record ToolEntry(string Id, string Name, string Description, JsonElement Schema, MethodInfo Method, string? Risk)
    {
        public bool IsStatic => Method.IsStatic;
    }

    /// <summary>无参数工具调用的占位实参（避免每次调用解析 JSON）。</summary>
    private static readonly JsonElement EmptyArgs = JsonDocument.Parse("{}").RootElement.Clone();

    private static readonly JsonElement EmptyObjectSchema =
        JsonDocument.Parse("""{"type":"object","properties":{}}""").RootElement.Clone();

    private readonly Dictionary<string, ToolEntry> _tools = new();
    /// <summary>在途调用（工具 invoke + 宿主 call）→ 独立取消令牌（cancel 帧映射到这里）。</summary>
    private readonly ConcurrentDictionary<string, CancellationTokenSource> _inflight = new();
    /// <summary>插件 → 宿主 call 的在途应答（reply 帧映射回来）。</summary>
    private readonly ConcurrentDictionary<string, TaskCompletionSource<JsonElement?>> _hostPending = new();
    private readonly Dictionary<string, Func<JsonElement[], CancellationToken, Task<object?>>> _ipcHandlers = new();
    private readonly Dictionary<string, PromptProvider> _promptProviders = new();
    private readonly Dictionary<string, Func<JsonElement, CancellationToken, Task>> _eventSubscriptions = new();
    private string _dataDir = "";
    private string _pluginId = "plugin";
    private bool _hostSupportsV2;
    private bool _readySent;
    private int _hostCallSeq;
    /** manifest.deps 声明的能力；deps.* 调用前校验，未声明直接抛 NotSupported */
    private readonly HashSet<string> _declaredDeps = new(StringComparer.Ordinal);

    /// <summary>基类构造：初始化 Storage / Events / Deps 门面（插件子类无需显式调用）。</summary>
    protected CyrenePluginBase()
    {
        Storage = new PluginStorage(this);
        Events = new PluginEvents(this);
        Deps = new PluginDeps(this);
    }

    /// <summary>宿主分配的插件私有数据目录（init 后有效；持久化写这里）。</summary>
    protected string DataDir => _dataDir;

    /// <summary>本插件 id（manifest.id，init 后有效）。</summary>
    protected string PluginId => _pluginId;

    /// <summary>供 PluginStorage 访问数据目录（不给插件子类直接调用）。</summary>
    internal string ResolveDataDir() => _dataDir;

    /// <summary>插件私有 KV 存储（与 Node 轨同一格式：<c>&lt;DataDir&gt;/&lt;key&gt;.json</c>，原子写）。</summary>
    protected PluginStorage Storage { get; }

    /// <summary>事件：订阅宿主事件（<c>host:*</c>）并向宿主发布插件事件。</summary>
    protected PluginEvents Events { get; }

    /// <summary>宿主服务集合（manifest.deps 声明后可用；未声明调用方法会抛 NotSupportedException）。</summary>
    protected PluginDeps Deps { get; }

    /// <summary>诊断日志（走协议 log 帧，宿主统一打 [plugin:id] 前缀）。</summary>
    protected void Log(string message, string level = "info")
        => WriteLine(new { op = "log", level, message });

    /// <summary>插件启动完成前的钩子（init 之后、ready 之前）——子类在这里注册工具之外的桥能力（IPC/事件/提示词）。</summary>
    protected virtual Task OnStartupAsync(CancellationToken ct) => Task.CompletedTask;

    /// <summary>shutdown 时钩子——子类可重写做清理（5s 内返回，超时被强杀）。</summary>
    protected virtual Task OnShutdownAsync(CancellationToken ct) => Task.CompletedTask;

    /// <summary>
    /// open 钩子：宿主点击插件卡片「打开」时调用（管理窗里 open 能力由 ready 声明）。
    /// 子类重写即视为支持 open，可用于显示自有 WPF 窗口；窗口随本进程退出自动关闭。
    /// </summary>
    protected virtual Task OnOpenAsync(CancellationToken ct) => Task.CompletedTask;

    /// <summary>
    /// 注册插件私有 IPC channel（面板/渲染端经 <c>plugin:&lt;id&gt;:&lt;channel&gt;</c> 调用）。
    /// handler 收到参数数组与取消令牌；返回值序列化为 JSON 回传，抛异常自动转错误。
    /// 在 OnStartupAsync 里调用；ready 之后调用会动态补登记。
    /// </summary>
    protected void RegisterIpc(string channel, Func<JsonElement[], CancellationToken, Task<object?>> handler)
    {
        RequireV2("IPC");
        if (string.IsNullOrWhiteSpace(channel) || !IpcChannelRegex.IsMatch(channel))
        {
            throw new ArgumentException($"非法 IPC channel: {channel}", nameof(channel));
        }
        ArgumentNullException.ThrowIfNull(handler);
        _ipcHandlers[channel] = handler;
        MaybeSendDynamic("ipc.register", new { channel });
    }

    /// <summary>注销 IPC channel（未注册时静默忽略）。</summary>
    protected void UnregisterIpc(string channel)
    {
        if (_ipcHandlers.Remove(channel)) MaybeSendDynamic("ipc.unregister", new { channel });
    }

    /// <summary>
    /// 注册每轮对话的提示词 Provider（宿主 2s 超时、单条 16k/总量 32k 截断，与 Node 轨一致）。
    /// 在 OnStartupAsync 里调用；ready 之后调用会动态补登记。
    /// </summary>
    protected void RegisterPromptProvider(PromptProvider provider)
    {
        RequireV2("提示词 Provider");
        ArgumentNullException.ThrowIfNull(provider);
        if (string.IsNullOrWhiteSpace(provider.Id) || !ProviderIdRegex.IsMatch(provider.Id))
        {
            throw new ArgumentException($"非法提示词 Provider id: {provider.Id}", nameof(provider));
        }
        if (provider.Provide is null) throw new ArgumentException("提示词 Provider 必须提供 Provide 委托", nameof(provider));
        ValidateEnumList(provider.Modes, ValidPromptModes, "modes");
        ValidateEnumList(provider.Sources, ValidPromptSources, "sources");
        if (_promptProviders.ContainsKey(provider.Id))
        {
            throw new InvalidOperationException($"提示词 Provider 已注册: {provider.Id}");
        }
        _promptProviders[provider.Id] = provider;
        MaybeSendDynamic("prompt.register", new
        {
            provider = new { id = provider.Id, modes = provider.Modes, sources = provider.Sources },
        });
    }

    /// <summary>注销提示词 Provider（未注册时静默忽略）。</summary>
    protected void UnregisterPromptProvider(string providerId)
    {
        if (_promptProviders.Remove(providerId))
        {
            MaybeSendDynamic("prompt.unregister", new { providerId });
        }
    }

    /// <summary>向宿主发布插件事件（框架自动补成 <c>plugin:&lt;id&gt;:&lt;event&gt;</c>，不能伪造宿主事件）。</summary>
    protected Task EmitEventAsync(string @event, object? payload = null) => EmitEventCoreAsync(@event, payload);

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
                    // 在读循环内同步登记取消令牌（避免 cancel 帧早于登记而丢失），
                    // 任务体切线程池执行：同步长任务不再阻塞读循环（否则连 cancel 都读不到）
                    StartInvoke(doc.RootElement, cts.Token);
                    break;
                case "call":
                    // 宿主 → 插件请求（IPC/提示词/open）：同样登记后切线程池
                    StartHostCall(doc.RootElement, cts.Token);
                    break;
                case "reply":
                    HandleHostReply(doc.RootElement);
                    break;
                case "notify":
                    HandleNotify(doc.RootElement);
                    break;
                case "cancel":
                    // 宿主取消/超时：尽力中止对应在途调用（工具可声明 CancellationToken 参数接收）
                    HandleCancel(doc.RootElement);
                    break;
                case "shutdown":
                    CancelAllInflight();
                    FailPendingHostCalls("插件关停");
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
        // 桥协议协商：旧宿主不带 protocolVersion → 仅 v1 工具能力
        var hostProtocol = frame.TryGetProperty("protocolVersion", out var pv) && pv.ValueKind == JsonValueKind.Number
            ? pv.GetInt32()
            : 1;
        _hostSupportsV2 = hostProtocol >= ProtocolVersion;

        if (frame.TryGetProperty("manifest", out var mf) && mf.ValueKind == JsonValueKind.Object)
        {
            if (mf.TryGetProperty("id", out var idEl)) _pluginId = idEl.GetString() ?? "plugin";
            // manifest.deps → 本地白名单：调用未声明的依赖时明确失败
            _declaredDeps.Clear();
            if (mf.TryGetProperty("deps", out var depsEl) && depsEl.ValueKind == JsonValueKind.Array)
            {
                foreach (var dep in depsEl.EnumerateArray())
                {
                    if (dep.ValueKind == JsonValueKind.String)
                    {
                        var name = dep.GetString();
                        if (!string.IsNullOrEmpty(name)) _declaredDeps.Add(name);
                    }
                }
            }
        }
        if (frame.TryGetProperty("dataDir", out var dd) && dd.ValueKind == JsonValueKind.String)
        {
            _dataDir = dd.GetString() ?? "";
            if (!string.IsNullOrEmpty(_dataDir)) Directory.CreateDirectory(_dataDir);
        }

        try
        {
            await OnStartupAsync(ct);
        }
        catch (Exception ex)
        {
            // 初始化失败（含旧宿主的 NotSupported）：回致命错误帧，避免半初始化继续跑
            Warn($"OnStartupAsync 失败: {ex}");
            WriteLine(new { op = "error", code = "startup_failed", message = ex.Message, fatal = true });
            return false;
        }

        var written = TryWriteLine(new
        {
            op = "ready",
            protocolVersion = ProtocolVersion,
            tools = _tools.Values.Select(t => new
            {
                id = t.Id, name = t.Name, description = t.Description, inputSchema = t.Schema, risk = t.Risk,
            }),
            ipc = _ipcHandlers.Keys.ToArray(),
            events = _eventSubscriptions.Keys.ToArray(),
            promptProviders = _promptProviders.Values
                .Select(p => new { id = p.Id, modes = p.Modes, sources = p.Sources })
                .ToArray(),
            capabilities = new { open = IsOpenOverridden() },
        }, out _);
        _readySent = written;
        return written;
    }

    /// <summary>登记在途调用并切线程池执行，保证读循环只做协议解析。</summary>
    private void StartInvoke(JsonElement frame, CancellationToken hostToken)
    {
        var callId = frame.TryGetProperty("callId", out var c) ? c.GetString() ?? "" : "";
        var callCts = CancellationTokenSource.CreateLinkedTokenSource(hostToken);
        if (callId.Length > 0) _inflight[callId] = callCts;
        _ = Task.Run(() => HandleInvokeAsync(frame, callId, callCts));
    }

    private async Task HandleInvokeAsync(JsonElement frame, string callId, CancellationTokenSource callCts)
    {
        var toolId = frame.TryGetProperty("tool", out var t) ? t.GetString() ?? "" : "";
        var args = frame.TryGetProperty("args", out var a) && a.ValueKind == JsonValueKind.Object ? a : default;
        var ct = callCts.Token;

        try
        {
            if (!_tools.TryGetValue(toolId, out var entry))
            {
                TryWriteLine(new { op = "result", callId, ok = false, error = $"未知工具: {toolId}" }, out _);
                return;
            }
            var result = InvokeTool(entry, args, ct);
            var value = await AwaitResultAsync(result);
            // 结果序列化失败必须回错误帧：只写 stderr 会让宿主一直等到兜底超时
            if (!TryWriteLine(new { op = "result", callId, ok = true, data = value }, out var writeError))
            {
                TryWriteLine(new { op = "result", callId, ok = false, error = $"结果序列化失败: {writeError}" }, out _);
            }
        }
        catch (OperationCanceledException)
        {
            Warn($"工具 {toolId} 调用已取消");
            TryWriteLine(new { op = "result", callId, ok = false, error = "调用已取消" }, out _);
        }
        catch (Exception ex)
        {
            // 失败细节进 stderr（宿主打日志），协议帧只带 message
            Warn($"工具 {toolId} 执行失败: {ex}");
            TryWriteLine(new { op = "result", callId, ok = false, error = ex.Message }, out _);
        }
        finally
        {
            if (callId.Length > 0) _inflight.TryRemove(callId, out _);
            callCts.Dispose();
        }
    }

    // ── v2：宿主 → 插件 call ──

    private void StartHostCall(JsonElement frame, CancellationToken hostToken)
    {
        var id = frame.TryGetProperty("id", out var idEl) ? idEl.GetString() ?? "" : "";
        var callCts = CancellationTokenSource.CreateLinkedTokenSource(hostToken);
        if (id.Length > 0) _inflight[id] = callCts;
        _ = Task.Run(() => HandleHostCallAsync(frame, id, callCts));
    }

    private async Task HandleHostCallAsync(JsonElement frame, string id, CancellationTokenSource callCts)
    {
        var method = frame.TryGetProperty("method", out var m) ? m.GetString() ?? "" : "";
        var p = frame.TryGetProperty("params", out var pe) ? pe : default;
        var ct = callCts.Token;

        try
        {
            object? data = method switch
            {
                "ipc.dispatch" => await DispatchIpcAsync(p, ct).ConfigureAwait(false),
                "prompt.provide" => await ProvidePromptAsync(p, ct).ConfigureAwait(false),
                "plugin.open" => await HandleOpenAsync(ct).ConfigureAwait(false),
                _ => throw new InvalidOperationException($"未知宿主调用: {method}"),
            };
            if (!TryWriteLine(new { op = "reply", id, ok = true, data }, out var writeError))
            {
                TryWriteLine(new { op = "reply", id, ok = false, error = $"结果序列化失败: {writeError}" }, out _);
            }
        }
        catch (OperationCanceledException)
        {
            TryWriteLine(new { op = "reply", id, ok = false, error = "调用已取消" }, out _);
        }
        catch (Exception ex)
        {
            Warn($"处理宿主调用 {method} 失败: {ex}");
            TryWriteLine(new { op = "reply", id, ok = false, error = ex.Message }, out _);
        }
        finally
        {
            if (id.Length > 0) _inflight.TryRemove(id, out _);
            callCts.Dispose();
        }
    }

    private async Task<object?> DispatchIpcAsync(JsonElement p, CancellationToken ct)
    {
        var channel = p.TryGetProperty("channel", out var ch) && ch.ValueKind == JsonValueKind.String
            ? ch.GetString() ?? ""
            : "";
        if (!_ipcHandlers.TryGetValue(channel, out var handler))
        {
            throw new InvalidOperationException($"未注册的 IPC channel: {channel}");
        }
        var args = p.TryGetProperty("args", out var argsEl) && argsEl.ValueKind == JsonValueKind.Array
            ? argsEl.EnumerateArray().ToArray()
            : [];
        return await handler(args, ct).ConfigureAwait(false);
    }

    private async Task<object?> ProvidePromptAsync(JsonElement p, CancellationToken ct)
    {
        var providerId = p.TryGetProperty("providerId", out var pid) && pid.ValueKind == JsonValueKind.String
            ? pid.GetString() ?? ""
            : "";
        if (!_promptProviders.TryGetValue(providerId, out var provider))
        {
            throw new InvalidOperationException($"未注册的提示词 Provider: {providerId}");
        }
        var input = PromptBuildInput.FromJson(p.TryGetProperty("input", out var inputEl) ? inputEl : default);
        return await provider.Provide(input, ct).ConfigureAwait(false);
    }

    private async Task<object?> HandleOpenAsync(CancellationToken ct)
    {
        await OnOpenAsync(ct).ConfigureAwait(false);
        return null;
    }

    // ── v2：插件 → 宿主 call ──

    internal async Task<JsonElement?> CallHostAsync(string method, object? parameters, CancellationToken ct)
    {
        RequireV2($"宿主调用 {method}");
        var id = $"p{Interlocked.Increment(ref _hostCallSeq)}";
        var tcs = new TaskCompletionSource<JsonElement?>(TaskCreationOptions.RunContinuationsAsynchronously);
        if (!_hostPending.TryAdd(id, tcs)) throw new InvalidOperationException($"宿主调用 id 冲突: {id}");
        try
        {
            if (!TryWriteLine(new { op = "call", id, method, @params = parameters }, out var writeError))
            {
                throw new InvalidOperationException($"发送宿主调用失败: {writeError}");
            }
            using var registration = ct.Register(() => tcs.TrySetCanceled(ct));
            return await tcs.Task.ConfigureAwait(false);
        }
        finally
        {
            _hostPending.TryRemove(id, out _);
        }
    }

    private void HandleHostReply(JsonElement frame)
    {
        var id = frame.TryGetProperty("id", out var idEl) && idEl.ValueKind == JsonValueKind.String
            ? idEl.GetString()
            : null;
        if (string.IsNullOrEmpty(id) || !_hostPending.TryRemove(id, out var tcs)) return;
        if (frame.TryGetProperty("ok", out var ok) && ok.ValueKind == JsonValueKind.True)
        {
            tcs.TrySetResult(frame.TryGetProperty("data", out var data) ? data.Clone() : null);
            return;
        }
        var message = frame.TryGetProperty("error", out var err) && err.ValueKind == JsonValueKind.String
            ? err.GetString() ?? "宿主调用失败"
            : "宿主调用失败";
        var code = frame.TryGetProperty("code", out var codeEl) && codeEl.ValueKind == JsonValueKind.String
            ? codeEl.GetString()
            : null;
        tcs.TrySetException(string.IsNullOrEmpty(code)
            ? new InvalidOperationException(message)
            : new PluginHostException(code, message));
    }

    private void FailPendingHostCalls(string reason)
    {
        foreach (var entry in _hostPending)
        {
            entry.Value.TrySetException(new InvalidOperationException(reason));
        }
    }

    private void HandleNotify(JsonElement frame)
    {
        var method = frame.TryGetProperty("method", out var m) ? m.GetString() : null;
        if (method != "event.deliver") return;
        var p = frame.TryGetProperty("params", out var pe) ? pe : default;
        var eventName = p.TryGetProperty("event", out var e) && e.ValueKind == JsonValueKind.String
            ? e.GetString()
            : null;
        if (string.IsNullOrEmpty(eventName) || !_eventSubscriptions.TryGetValue(eventName, out var handler)) return;
        var payload = p.TryGetProperty("payload", out var pl) ? pl.Clone() : default;
        _ = Task.Run(async () =>
        {
            try
            {
                await handler(payload, CancellationToken.None).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                Warn($"事件 {eventName} 处理失败: {ex.Message}");
            }
        });
    }

    // ── 注册/注销（PluginEvents 转发） ──

    internal void SubscribeEvent(string @event, Func<JsonElement, CancellationToken, Task> handler)
    {
        RequireV2("事件订阅");
        if (string.IsNullOrWhiteSpace(@event)) throw new ArgumentException("事件名不能为空", nameof(@event));
        ArgumentNullException.ThrowIfNull(handler);
        _eventSubscriptions[@event] = handler;
        MaybeSendDynamic("events.subscribe", new { @event });
    }

    internal void UnsubscribeEvent(string @event)
    {
        if (_eventSubscriptions.Remove(@event))
        {
            MaybeSendDynamic("events.unsubscribe", new { @event });
        }
    }

    internal async Task EmitEventCoreAsync(string @event, object? payload)
    {
        RequireV2("事件发布");
        if (string.IsNullOrWhiteSpace(@event)) throw new ArgumentException("事件名不能为空", nameof(@event));
        await CallHostAsync("events.emit", new { @event, payload }, CancellationToken.None).ConfigureAwait(false);
    }

    private void MaybeSendDynamic(string method, object? parameters)
    {
        // ready 之前只登记本地，声明随 ready 一次性下发；ready 之后动态补登记
        if (!_readySent || !_hostSupportsV2) return;
        _ = SendDynamicAsync(method, parameters);
    }

    private async Task SendDynamicAsync(string method, object? parameters)
    {
        try
        {
            await CallHostAsync(method, parameters, CancellationToken.None).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            Warn($"宿主调用 {method} 失败: {ex.Message}");
        }
    }

    private void RequireV2(string feature)
    {
        if (!_hostSupportsV2)
        {
            throw new NotSupportedException(
                $"宿主协议版本过低，不支持{feature}（需要 Cyrene v2.0+；或改用 Node 插件轨）");
        }
    }

    /// <summary>deps 能力校验：未在 manifest.deps 声明时明确失败（与 Node 轨“未注入即不可用”一致）。</summary>
    internal void RequireDep(string name)
    {
        RequireV2($"deps.{name}");
        if (!_declaredDeps.Contains(name))
        {
            throw new NotSupportedException($"manifest.deps 未声明能力: {name}");
        }
    }

    private static void ValidateEnumList(string[]? values, string[] allowed, string label)
    {
        if (values is null) return;
        if (values.Length == 0) throw new ArgumentException($"{label} 不能为空数组", label);
        foreach (var value in values)
        {
            if (!allowed.Contains(value))
            {
                throw new ArgumentException($"{label} 含未知值: {value}", label);
            }
        }
    }

    /// <summary>cancel/超时：取消对应在途调用（不存在则忽略）。</summary>
    private void HandleCancel(JsonElement frame)
    {
        var id = frame.TryGetProperty("id", out var idEl) && idEl.ValueKind == JsonValueKind.String
            ? idEl.GetString()
            : null;
        if (string.IsNullOrEmpty(id)) return;
        if (_inflight.TryGetValue(id, out var cts))
        {
            try { cts.Cancel(); }
            catch (ObjectDisposedException) { /* 调用刚好结束并释放 */ }
        }
    }

    /// <summary>关停前取消全部在途调用，让声明了 CancellationToken 的工具尽快退出。</summary>
    private void CancelAllInflight()
    {
        foreach (var cts in _inflight.Values)
        {
            try { cts.Cancel(); }
            catch (ObjectDisposedException) { /* 同上 */ }
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

    private object? InvokeTool(ToolEntry entry, JsonElement args, CancellationToken ct)
    {
        var parameters = entry.Method.GetParameters();
        // 签名已在 CollectTools 保证：0 参 / (JsonElement) / (JsonElement, CancellationToken)
        object?[] invocation = parameters.Length switch
        {
            0 => [],
            1 => [ObjectArgs(args)],
            _ => [ObjectArgs(args), ct],
        };
        try
        {
            return entry.Method.Invoke(entry.IsStatic ? null : this, invocation);
        }
        catch (TargetInvocationException tie) when (tie.InnerException is not null)
        {
            // 反射会包装同步异常；解包保留原始类型与堆栈，错误信息才能原样回传宿主
            ExceptionDispatchInfo.Capture(tie.InnerException).Throw();
            throw; // 不可达：上面必定抛出
        }
    }

    private static JsonElement ObjectArgs(JsonElement args)
        => args.ValueKind == JsonValueKind.Object ? args : EmptyArgs;

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
            // 签名白名单：0 参数 / (JsonElement) / (JsonElement, CancellationToken)。
            // 不合法在 init 时即报出，不再等到调用时抛 TargetParameterCountException / 参数转换异常。
            var parameters = method.GetParameters();
            var validSignature = parameters.Length == 0
                || (parameters.Length == 1 && parameters[0].ParameterType == typeof(JsonElement))
                || (parameters.Length == 2
                    && parameters[0].ParameterType == typeof(JsonElement)
                    && parameters[1].ParameterType == typeof(CancellationToken));
            if (!validSignature)
            {
                Warn($"忽略工具 {attr.Id}（{method.Name}）：签名必须是 () / (JsonElement) / (JsonElement, CancellationToken)");
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

    /// <summary>子类是否重写了 OnOpenAsync（是则 ready 声明 capabilities.open）。</summary>
    private bool IsOpenOverridden()
    {
        var method = GetType().GetMethod(
            nameof(OnOpenAsync),
            BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public);
        return method is not null && method.DeclaringType != typeof(CyrenePluginBase);
    }

    /// <summary>SDK 内部诊断：有返回值走 stderr（stdout 被协议独占），宿主收集为日志。</summary>
    private static void Warn(string message) => Console.Error.WriteLine($"[cyrene-plugin] {message}");

    private void WriteLine(object frame) => TryWriteLine(frame, out _);

    /// <summary>
    /// 写协议帧。返回 false 表示序列化失败或 stdout 写失败——调用方据此回错误帧，
    /// 避免「结果不可序列化 → 静默不回帧 → 宿主等到兜底超时」。
    /// </summary>
    private bool TryWriteLine(object frame, out string? error)
    {
        string json;
        try { json = JsonSerializer.Serialize(frame, JsonOptions); }
        catch (Exception ex)
        {
            // 序列化失败必须显式暴露：吞掉后调用方只看到宿主 invoke 永久 pending
            error = ex.Message;
            Warn($"帧序列化失败（{frame.GetType().Name}）: {ex.Message}");
            return false;
        }
        try
        {
            Console.Out.WriteLine(json);
            Console.Out.Flush();
            error = null;
            return true;
        }
        catch
        {
            error = "stdout 已关闭";
            return false;
        }
    }
}

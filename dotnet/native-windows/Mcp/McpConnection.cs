using System.IO;
using System.Net.Http;
using System.Diagnostics;
using System.Text;
using System.Text.Json;

namespace CyreneNative.Mcp;

/// <summary>
/// 单个 MCP server 的连接实现：MCP 协议握手、工具发现、调用转发、
/// 断线重连（指数退避）、调用超时、Windows 进程树清理。
///
/// MCP 协议核心（对 MCP 规范的最小实现，stdio + SSE 两种 transport）：
///   initialize → notifications/initialized → tools/list → tools/call
/// 消息格式：JSON-RPC 2.0；stdio 为换行分隔 JSON，SSE 为
///   GET <url> 建流（endpoint event 给 POST 回发地址）+ POST 请求。
/// </summary>
internal sealed class McpConnection : IDisposable
{
    private readonly string _serverId;
    private readonly string _transport;          // "stdio" | "sse"
    private readonly string? _command;
    private readonly string[] _args = [];
    private readonly Dictionary<string, string?> _env = new();
    private readonly string? _url;
    private readonly int _callTimeoutMs;
    private readonly McpConnectionManager _owner;

    private Process? _proc;
    private StreamWriter? _procStdin;
    private readonly SemaphoreSlim _rpcLock = new(1, 1);
    private long _nextId = 1;
    private readonly Dictionary<long, TaskCompletionSource<JsonElement>> _pending = new();
    private CancellationTokenSource? _readerCts;
    private int _disposed;
    private Task? _watchTask;

    // SSE 模式状态
    private HttpClient? _http;
    private string? _postEndpoint;
    private CancellationTokenSource? _sseCts;

    public McpConnection(string serverId, JsonElement config, McpConnectionManager owner)
    {
        _serverId = serverId;
        _owner = owner;
        _transport = config.TryGetProperty("transport", out var t) ? t.GetString() ?? "stdio" : "stdio";
        _command = config.TryGetProperty("command", out var c) ? c.GetString() : null;
        if (config.TryGetProperty("args", out var a) && a.ValueKind == JsonValueKind.Array)
            _args = a.EnumerateArray().Select(x => x.GetString() ?? "").ToArray();
        if (config.TryGetProperty("env", out var e) && e.ValueKind == JsonValueKind.Object)
            foreach (var p in e.EnumerateObject()) _env[p.Name] = p.Value.GetString();
        _url = config.TryGetProperty("url", out var u) ? u.GetString() : null;
        _callTimeoutMs = config.TryGetProperty("callTimeoutMs", out var ct) && ct.TryGetInt32(out var ms) && ms > 0
            ? ms : 60_000;
    }

    // ── 生命周期 ──

    public async Task<bool> ConnectAsync()
    {
        try
        {
            await ConnectOnceAsync();
            var tools = await RpcAsync("tools/list", new { }, 30_000);
            _owner.SendTools(_serverId, tools.GetProperty("tools").Clone());
            _owner.SendState(_serverId, "connected");
            _owner.Log("info", $"MCP 已连接: {_serverId}");
            return true;
        }
        catch (Exception ex)
        {
            _owner.SendState(_serverId, "disconnected", ex.Message);
            _owner.Log("error", $"MCP 连接失败 {_serverId}: {ex.Message}");
            return false;
        }
    }

    /// <summary>监视连接：stdio 看进程退出，SSE 看流断开；断则重连。</summary>
    public async Task WatchAsync()
    {
        var backoff = 1_000;
        while (!_owner.Stopping && _disposed == 0)
        {
            var broke = await WaitForBreakAsync();
            if (!broke || _owner.Stopping || _disposed == 0 && false) { }
            if (!broke || _owner.Stopping || Volatile.Read(ref _disposed) != 0) break;
            _owner.SendState(_serverId, "reconnecting");
            _owner.Log("warn", $"MCP 断线，重连中: {_serverId}");
            TeardownTransport();
            var ok = false;
            while (!ok && !_owner.Stopping && Volatile.Read(ref _disposed) == 0)
            {
                try { await Task.Delay(backoff); backoff = Math.Min(backoff * 2, 60_000); }
                catch { break; }
                try { await ConnectOnceAsync(); ok = true; }
                catch (Exception ex) { _owner.Log("warn", $"重连失败 {_serverId}: {ex.Message}"); }
            }
            if (ok)
            {
                backoff = 1_000;
                try
                {
                    var tools = await RpcAsync("tools/list", new { }, 30_000);
                    _owner.SendTools(_serverId, tools.GetProperty("tools").Clone());
                    _owner.SendState(_serverId, "connected");
                    _owner.Log("info", $"MCP 重连成功: {_serverId}");
                }
                catch (Exception ex)
                {
                    _owner.Log("warn", $"重连后工具发现失败 {_serverId}: {ex.Message}");
                    continue; // 下轮继续按断线处理
                }
            }
        }
    }

    private async Task<bool> WaitForBreakAsync()
    {
        if (_transport == "stdio")
        {
            var proc = _proc;
            if (proc is null) return true;
            try { await proc.WaitForExitAsync(_readerCts?.Token ?? CancellationToken.None); }
            catch (OperationCanceledException) { }
            return true;
        }
        try
        {
            var tcs = new TaskCompletionSource<bool>();
            _sseCts = CancellationTokenSource.CreateLinkedTokenSource(_readerCts?.Token ?? CancellationToken.None);
            _sseCts.Token.Register(() => tcs.TrySetResult(true));
            await tcs.Task;  // SSE 读完（服务器关闭）由 reader 循环 set
            return true;
        }
        catch { return true; }
    }

    // ── 单次连接建立 ──

    private async Task ConnectOnceAsync()
    {
        if (_transport == "stdio")
        {
            if (_command is null) throw new InvalidOperationException("stdio transport requires command");
            var psi = new ProcessStartInfo(_command)
            {
                UseShellExecute = false,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
                StandardOutputEncoding = Encoding.UTF8,
            };
            foreach (var a in _args) psi.ArgumentList.Add(a);
            foreach (var kv in _env) psi.Environment[kv.Key] = kv.Value ?? "";
            _proc = Process.Start(psi) ?? throw new InvalidOperationException($"无法启动 {_command}");
            AttachJob(_proc);
            _procStdin = _proc.StandardInput;
            _procStdin.AutoFlush = true;
            _proc.ErrorDataReceived += (_, e) => { if (!string.IsNullOrWhiteSpace(e.Data)) _owner.Log("warn", $"[{_serverId}] {e.Data}"); };
            _proc.BeginErrorReadLine();
            _readerCts = new CancellationTokenSource();
            _ = Task.Run(() => ReadStdioLoopAsync(_proc, _readerCts.Token));
        }
        else
        {
            if (_url is null) throw new InvalidOperationException("sse transport requires url");
            _http = new HttpClient { Timeout = TimeSpan.FromMilliseconds(Math.Max(_callTimeoutMs, 60_000)) };
            _postEndpoint = null;
            _sseCts = new CancellationTokenSource();
            _ = Task.Run(() => ReadSseLoopAsync(_url, _sseCts.Token));
            // 等 endpoint event（由 ReadSseLoop 收到后写入 _postEndpoint）
            var sw = Stopwatch.StartNew();
            while (_postEndpoint is null && sw.ElapsedMilliseconds < 15_000 && !_sseCts.IsCancellationRequested)
                await Task.Delay(50);
            if (_postEndpoint is null) throw new TimeoutException("SSE endpoint 协商超时");
        }

        // MCP 握手
        var init = await RpcAsync("initialize", new
        {
            protocolVersion = "2024-11-05",
            capabilities = new { },
            clientInfo = new { name = "cyrene-native-mcp", version = "1.0.0" },
        }, 30_000);
        Notify("notifications/initialized");
    }

    private async Task ReadStdioLoopAsync(Process proc, CancellationToken ct)
    {
        try
        {
            using var reader = proc.StandardOutput;
            string? line;
            while (!ct.IsCancellationRequested && (line = await reader.ReadLineAsync(ct)) is not null)
            {
                if (string.IsNullOrWhiteSpace(line)) continue;
                try
                {
                    using var doc = JsonDocument.Parse(line);
                    HandleRpcMessage(doc.RootElement);
                }
                catch (JsonException) { /* server 杂音 */ }
            }
        }
        catch { /* 进程退出 */ }
    }

    private async Task ReadSseLoopAsync(string url, CancellationToken ct)
    {
        try
        {
            using var resp = await _http!.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, ct);
            resp.EnsureSuccessStatusCode();
            using var stream = await resp.Content.ReadAsStreamAsync(ct);
            using var reader = new StreamReader(stream, Encoding.UTF8);
            var eventName = "message";
            string? line;
            while (!ct.IsCancellationRequested && (line = await reader.ReadLineAsync(ct)) is not null)
            {
                if (line.StartsWith("event:"))
                {
                    eventName = line["event:".Length..].Trim();
                }
                else if (line.StartsWith("data:"))
                {
                    var data = line["data:".Length..].Trim();
                    if (eventName == "endpoint")
                    {
                        _postEndpoint = data;
                        eventName = "message";
                    }
                    else if (eventName == "message" && data.Length > 0)
                    {
                        try
                        {
                            using var doc = JsonDocument.Parse(data);
                            HandleRpcMessage(doc.RootElement);
                        }
                        catch (JsonException) { }
                        eventName = "message";
                    }
                }
                else if (line.Length == 0)
                {
                    // event 结束
                }
            }
        }
        catch { /* 断流 */ }
    }

    private void HandleRpcMessage(JsonElement msg)
    {
        // 响应：匹配 id → 完成 pending
        if (msg.TryGetProperty("id", out var idEl) && idEl.ValueKind == JsonValueKind.Number)
        {
            var id = idEl.GetInt64();
            TaskCompletionSource<JsonElement>? tcs;
            lock (_pending) _pending.Remove(id, out tcs);
            if (tcs is not null)
            {
                if (msg.TryGetProperty("error", out var err))
                    tcs.TrySetException(new InvalidOperationException(err.ToString()));
                else
                    tcs.TrySetResult(msg.GetProperty("result").Clone());
            }
            return;
        }
        // 通知（notifications/tools/list_changed 等）：重新发现工具表
        var method = msg.TryGetProperty("method", out var m) ? m.GetString() : null;
        if (method == "notifications/tools/list_changed")
        {
            _ = Task.Run(async () =>
            {
                try
                {
                    var tools = await RpcAsync("tools/list", new { }, 30_000);
                    _owner.SendTools(_serverId, tools.GetProperty("tools").Clone());
                    _owner.Log("info", $"MCP 工具表已刷新: {_serverId}");
                }
                catch (Exception ex) { _owner.Log("warn", $"list_changed 刷新失败 {_serverId}: {ex.Message}"); }
            });
        }
    }

    // ── RPC 基础设施 ──

    private async Task<JsonElement> RpcAsync(string method, object @params, int timeoutMs)
    {
        var id = Interlocked.Increment(ref _nextId);
        var tcs = new TaskCompletionSource<JsonElement>(TaskCreationOptions.RunContinuationsAsynchronously);
        lock (_pending) _pending[id] = tcs;
        var payload = JsonSerializer.Serialize(new { jsonrpc = "2.0", id, method, @params });
        await SendRawAsync(payload);

        var done = await Task.WhenAny(tcs.Task, Task.Delay(timeoutMs));
        if (done != tcs.Task)
        {
            lock (_pending) _pending.Remove(id);
            throw new TimeoutException($"{method} 超时（{timeoutMs}ms）");
        }
        return await tcs.Task;
    }

    private void Notify(string method)
    {
        var payload = JsonSerializer.Serialize(new { jsonrpc = "2.0", method });
        _ = SendRawAsync(payload);
    }

    private async Task SendRawAsync(string payload)
    {
        if (_transport == "stdio")
        {
            var w = _procStdin;
            if (w is null) throw new InvalidOperationException("stdio 未连接");
            await _rpcLock.WaitAsync();
            try { await w.WriteLineAsync(payload); }
            finally { _rpcLock.Release(); }
        }
        else
        {
            var ep = _postEndpoint ?? throw new InvalidOperationException("SSE endpoint 未协商");
            var content = new StringContent(payload, Encoding.UTF8, "application/json");
            using var resp = await _http!.PostAsync(ep, content);
            if (!resp.IsSuccessStatusCode)
                throw new InvalidOperationException($"SSE POST 失败: {(int)resp.StatusCode}");
        }
    }

    public async Task<JsonElement> CallToolAsync(string tool, JsonElement args)
    {
        var result = await RpcAsync("tools/call", new { name = tool, arguments = args }, _callTimeoutMs);
        // MCP 工具结果：{ content: [...], isError? }——整体透传给 TS 侧解析
        return result;
    }

    private void TeardownTransport()
    {
        try { _readerCts?.Cancel(); } catch { }
        try { _proc?.Kill(entireProcessTree: true); } catch { }
        try { _proc?.Dispose(); } catch { }
        _proc = null; _procStdin = null;
        try { _sseCts?.Cancel(); } catch { }
        _sseCts = null; _http = null; _postEndpoint = null;
        lock (_pending)
        {
            foreach (var kv in _pending) kv.Value.TrySetException(new InvalidOperationException("连接已断开"));
            _pending.Clear();
        }
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0) return;
        TeardownTransport();
    }

    /// <summary>Windows Job Object：host 退出时级联清理 MCP server 进程树。</summary>
    private static void AttachJob(Process proc)
    {
        try
        {
            var job = NativeMethods.CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) return;
            var info = new NativeMethods.JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            info.BasicLimitInformation.LimitFlags = NativeMethods.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            NativeMethods.SetInformationJobObject(job,
                NativeMethods.JobObjectExtendedLimitInformation, ref info,
                (uint)System.Runtime.InteropServices.Marshal.SizeOf<NativeMethods.JOBOBJECT_EXTENDED_LIMIT_INFORMATION>());
            NativeMethods.AssignProcessToJobObject(job, proc.Handle);
            // 句柄不关：job 随本进程退出销毁 → 全子进程被杀
            _jobs.Add(job);
        }
        catch { /* 非 Windows / 权限不足：跳过（进程随 stdin EOF 自行退出） */ }
    }
    private static readonly List<IntPtr> _jobs = new();
}

internal static partial class NativeMethods
{
    [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
    internal static extern IntPtr CreateJobObject(IntPtr a, string? name);

    [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
    internal static extern bool SetInformationJobObject(IntPtr job, int infoClass,
        ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, uint size);

    [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
    internal static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    internal const int JobObjectExtendedLimitInformation = 9;
    internal const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;

    [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
    internal struct IO_COUNTERS
    {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }

    [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
    internal struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public uint MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit, Affinity, PriorityClass, SchedulingClass;
    }

    [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
    internal struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }
}

using System.IO;
using System.Diagnostics;
using System.Text;
using System.Text.Json;

namespace CyreneNative.Mcp;

/// <summary>
/// MCP 桥协议宿主（cyrene-native --mcp-host）。
///
/// 把「连接 MCP server、工具发现、调用转发、断线重连」全部收进本进程，
/// Electron 主进程只面对一个稳定的 stdio JSON 行协议——MCP server 崩溃/
/// npx 卡死/网络抖动不再冲击主进程稳定性。
///
/// 桥协议（宿主 Electron ↔ 本进程，每行一个 JSON）：
///   Electron → host:
///     {"op":"connect","serverId":"...","config":{transport,command,args,env,url,callTimeoutMs}}
///     {"op":"disconnect","serverId":"..."}
///     {"op":"call","callId":"c1","serverId":"...","tool":"name","args":{}}
///     {"op":"shutdown"}
///   host → Electron:
///     {"op":"ready"}
///     {"op":"tools","serverId":"...","tools":[{name,description,inputSchema,annotations}]}
///     {"op":"state","serverId":"...","state":"connected|reconnecting|disconnected","error":"..."}
///     {"op":"result","callId":"c1","ok":true,"data":...}
///     {"op":"result","callId":"c1","ok":false,"error":"..."}
///     {"op":"log","level":"info|warn|error","message":"..."}
///
/// 与 TS 侧 McpDotnetAdapter 配套（src/main/orchestrator/mcp-dotnet-adapter.ts）。
/// </summary>
public static class McpHost
{
    public static int Run()
    {
        var manager = new McpConnectionManager(
            Console.OpenStandardInput(),
            Console.OpenStandardOutput());
        return manager.RunLoop();
    }
}

internal sealed class McpConnectionManager
{
    private readonly Stream _stdin;
    private readonly Stream _stdout;
    private readonly Dictionary<string, McpConnection> _connections = new();
    private readonly SemaphoreSlim _ioLock = new(1, 1);
    private volatile bool _stopping;

    public McpConnectionManager(Stream stdin, Stream stdout)
    {
        _stdin = stdin;
        _stdout = stdout;
    }

    public int RunLoop()
    {
        WriteFrame(new { op = "ready" });
        using var reader = new StreamReader(_stdin, Encoding.UTF8);
        string? line;
        while ((line = reader.ReadLine()) is not null)
        {
            if (string.IsNullOrWhiteSpace(line)) continue;
            try
            {
                using var doc = JsonDocument.Parse(line);
                var root = doc.RootElement;
                var op = root.TryGetProperty("op", out var o) ? o.GetString() : null;
                switch (op)
                {
                    case "connect":
                        HandleConnect(root);
                        break;
                    case "disconnect":
                        HandleDisconnect(root);
                        break;
                    case "call":
                        HandleCall(root);
                        break;
                    case "shutdown":
                        _stopping = true;
                        foreach (var c in _connections.Values.ToList()) c.Dispose();
                        return 0;
                }
            }
            catch (JsonException)
            {
                // 非 JSON 行：忽略
            }
            catch (Exception ex)
            {
                Log("error", $"帧处理异常: {ex.Message}");
            }
        }
        // stdin EOF：宿主已退出，清理全部子进程
        _stopping = true;
        foreach (var c in _connections.Values.ToList()) c.Dispose();
        return 0;
    }

    private async void HandleConnect(JsonElement root)
    {
        var serverId = root.GetProperty("serverId").GetString()!;
        try
        {
            var config = root.GetProperty("config");
            var conn = new McpConnection(serverId, config, this);
            lock (_connections) _connections[serverId] = conn;
            var ok = await conn.ConnectAsync();
            if (ok) _ = conn.WatchAsync();
        }
        catch (Exception ex)
        {
            SendState(serverId, "disconnected", ex.Message);
        }
    }

    private async void HandleDisconnect(JsonElement root)
    {
        var serverId = root.GetProperty("serverId").GetString()!;
        McpConnection? conn;
        lock (_connections) _connections.Remove(serverId, out conn);
        if (conn is not null) await Task.Run(conn.Dispose);
    }

    private async void HandleCall(JsonElement root)
    {
        var callId = root.GetProperty("callId").GetString()!;
        var serverId = root.GetProperty("serverId").GetString()!;
        var tool = root.GetProperty("tool").GetString()!;
        var args = root.TryGetProperty("args", out var a) && a.ValueKind == JsonValueKind.Object
            ? a.Clone() : JsonDocument.Parse("{}").RootElement;
        McpConnection? conn;
        lock (_connections) _connections.TryGetValue(serverId, out conn);
        if (conn is null)
        {
            WriteResult(callId, false, $"MCP server 未连接: {serverId}");
            return;
        }
        try
        {
            var result = await conn.CallToolAsync(tool, args);
            WriteResult(callId, true, result);
        }
        catch (Exception ex)
        {
            WriteResult(callId, false, ex.Message);
        }
    }

    // ── 对 McpConnection 的回调出口 ──
    internal void SendTools(string serverId, JsonElement tools) =>
        WriteFrame(new { op = "tools", serverId, tools });

    internal void SendState(string serverId, string state, string? error = null) =>
        WriteFrame(error is null
            ? new { op = "state", serverId, state }
            : new { op = "state", serverId, state, error });

    internal void Log(string level, string message) =>
        WriteFrame(new { op = "log", level, message });

    internal bool Stopping => _stopping;

    private void WriteResult(string callId, bool ok, object payload) =>
        WriteFrame(ok
            ? new { op = "result", callId, ok, data = payload }
            : new { op = "result", callId, ok, error = payload });

    private void WriteFrame(object frame)
    {
        try
        {
            var bytes = JsonSerializer.SerializeToUtf8Bytes(frame);
            _ioLock.Wait();
            try
            {
                _stdout.Write(bytes, 0, bytes.Length);
                _stdout.WriteByte((byte)'\n');
                _stdout.Flush();
            }
            finally { _ioLock.Release(); }
        }
        catch
        {
            // stdout 关闭：宿主已退出
        }
    }
}

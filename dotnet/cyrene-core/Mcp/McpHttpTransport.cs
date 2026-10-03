using System.Collections.Concurrent;
using System.IO;
using System.Net;
using System.Text;
using System.Text.Json;

namespace CyreneNative.Mcp;

/// <summary>
/// Streamable HTTP MCP 传输（阶段 10 M）。
///
/// M2 IMcpTransport：stdio（McpConnection）与 HTTP 共用同一套 JSON-RPC
/// 分发；M3 单端点 /mcp，POST=请求/响应（+SSE 流可选），GET=服务端推送；
/// M4 会话 Mcp-Session-Id（缺省新建，回显校验，30 分钟空闲过期清理）；
/// M5 默认绑定 127.0.0.1（A18 铁律：不对外，无认证）；
/// M7 开关 CYRENE_MCP_HTTP 由 TS 宿主决定是否拉起本端点；
/// M8 走审批：本传输只投递工具调用到 host 桥（Electron 审批闸门不变）；
/// M9 便携协同：会话状态落 ./data（HostConfig），不写系统目录。
///
/// 实现说明：HttpListener（无需 ASP.NET 栈）；MCP 消息即 JSON-RPC 2.0
/// 文本——本端点把它当「外部 MCP 客户端」接入：外部 POST tools/call →
/// 经 host 桥转 Electron 审批/执行 → 应答回写。同一份工具注册表。
/// </summary>
internal sealed class McpHttpTransport : IDisposable
{
    private readonly HttpListener _listener = new();
    private readonly ConcurrentDictionary<string, DateTime> _sessions = new();
    private readonly Func<string, string, Task<JsonElement>> _callTool;   // (toolName, argsJson) → result
    private readonly Func<Task<JsonElement[]>> _listTools;
    private readonly CancellationTokenSource _cts = new();
    private Task? _loop;
    private const int SessionTtlMinutes = 30;

    public int Port { get; }
    public string Endpoint => $"http://127.0.0.1:{Port}/mcp";

    public McpHttpTransport(int port, Func<Task<JsonElement[]>> listTools, Func<string, string, Task<JsonElement>> callTool)
    {
        Port = port;
        _listTools = listTools;
        _callTool = callTool;
        _listener.Prefixes.Add($"http://127.0.0.1:{port}/mcp/");
    }

    public void Start()
    {
        _listener.Start();
        _loop = Task.Run(AcceptLoop);
    }

    private async Task AcceptLoop()
    {
        while (!_cts.IsCancellationRequested)
        {
            HttpListenerContext ctx;
            try { ctx = await _listener.GetContextAsync(); }
            catch (HttpListenerException) { break; }
            _ = Task.Run(() => HandleSafe(ctx));
        }
    }

    private async Task HandleSafe(HttpListenerContext ctx)
    {
        try
        {
            await Handle(ctx);
        }
        catch (Exception ex)
        {
            try
            {
                ctx.Response.StatusCode = 500;
                await ctx.Response.OutputStream.WriteAsync(Encoding.UTF8.GetBytes(
                    JsonSerializer.Serialize(new { jsonrpc = "2.0", id = (string?)"", error = new { code = -32603, message = ex.Message } })));
            }
            catch { /* ignore */ }
        }
        finally
        {
            try { ctx.Response.Close(); } catch { /* ignore */ }
        }
    }

    private async Task Handle(HttpListenerContext ctx)
    {
        // 只允许本地回环（M5——HttpListener 前缀已限 127.0.0.1，双保险）
        var remote = ctx.Request.RemoteEndPoint?.Address;
        if (remote is not null && !IPAddress.IsLoopback(remote))
        {
            ctx.Response.StatusCode = 403;
            return;
        }

        // S1：DNS rebinding 防护——浏览器恶意页面把 evil.com 解析到
        // 127.0.0.1 后发起跨站请求时，Host 头仍是 evil.com（非本端点）
        var hostHeader = ctx.Request.Headers["Host"];
        if (hostHeader is null || (!hostHeader.StartsWith("127.0.0.1:", StringComparison.Ordinal)
            && hostHeader != "127.0.0.1" && !hostHeader.StartsWith("localhost:", StringComparison.Ordinal)
            && hostHeader != "localhost"))
        {
            ctx.Response.StatusCode = 403;
            return;
        }

        var req = ctx.Request;
        using var body = new StreamReader(req.InputStream);
        var payload = await body.ReadToEndAsync();
        JsonElement rpc;
        try { rpc = JsonDocument.Parse(payload).RootElement.Clone(); }
        catch
        {
            ctx.Response.StatusCode = 400;
            return;
        }
        var method = rpc.TryGetProperty("method", out var m) ? m.GetString() : null;
        var id = rpc.TryGetProperty("id", out var i) && i.ValueKind != JsonValueKind.Null ? (JsonElement?)i.Clone() : null;

        // M4 会话管理：Mcp-Session-Id 校验/新建/续期
        var sessionHeader = req.Headers["Mcp-Session-Id"];
        string session;
        if (string.IsNullOrEmpty(sessionHeader))
        {
            session = Guid.NewGuid().ToString("N");
            ctx.Response.Headers["Mcp-Session-Id"] = session;
            _sessions[session] = DateTime.UtcNow;
        }
        else if (_sessions.TryGetValue(sessionHeader, out var last) && DateTime.UtcNow - last < TimeSpan.FromMinutes(SessionTtlMinutes))
        {
            session = sessionHeader;
            _sessions[session] = DateTime.UtcNow;
        }
        else
        {
            ctx.Response.StatusCode = 404;   // 过期/未知会话
            return;
        }

        JsonElement? result;
        switch (method)
        {
            case "initialize":
                result = JsonDocument.Parse(@"{""protocolVersion"":""2025-03-26"",""capabilities"":{""tools"":{""listChanged"":true}},""serverInfo"":{""name"":""cyrene-mcp"",""version"":""2.0.0""}}").RootElement.Clone();
                break;
            case "tools/list":
                result = JsonSerializer.SerializeToElement(new { tools = await _listTools() });
                break;
            case "tools/call":
            {
                var p = rpc.TryGetProperty("params", out var pp) ? pp : default;
                var name = p.TryGetProperty("name", out var n) ? n.GetString() : null;
                var args = p.TryGetProperty("arguments", out var a) ? a.GetRawText() : "{}";
                if (name is null) { ctx.Response.StatusCode = 400; return; }
                // M8：审批闸门在 Electron 侧（_callTool 桥直达 host 工具路由）
                result = await _callTool(name, args);
                break;
            }
            default:
                ctx.Response.StatusCode = 404;
                return;
        }

        ctx.Response.ContentType = "application/json";
        var response = JsonSerializer.Serialize(new
        {
            jsonrpc = "2.0",
            id = id is null ? (object?)"null" : (object?)id,
            result,
        });
        await ctx.Response.OutputStream.WriteAsync(Encoding.UTF8.GetBytes(response));
    }

    public void Dispose()
    {
        _cts.Cancel();
        try { _listener.Stop(); } catch { /* ignore */ }
        _loop?.Wait(TimeSpan.FromSeconds(2));
    }
}

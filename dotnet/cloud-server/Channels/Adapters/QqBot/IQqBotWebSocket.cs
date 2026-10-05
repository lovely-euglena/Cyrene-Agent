using System.Net.WebSockets;
using System.Text;

namespace CyreneCloud.Channels.Adapters.QqBot;

/// <summary>
/// QQ 网关 WebSocket 的最小抽象（生产 = <see cref="ClientWebSocketTransport"/>；
/// selftest 注入 fake 网关，无真实网络）。只暴露本客户端用到的四条语义。
/// </summary>
public interface IQqBotWebSocket : IAsyncDisposable
{
    bool IsOpen { get; }

    Task SendTextAsync(string payload, CancellationToken cancellationToken);

    /// <summary>读取一条完整文本帧；连接关闭/中止时返回 null（接收循环据此进入重连）。</summary>
    Task<string?> ReceiveTextAsync(CancellationToken cancellationToken);

    Task CloseAsync(int code, string reason, CancellationToken cancellationToken);

    void Abort();
}

/// <summary><see cref="ClientWebSocket"/> 的薄封装（分帧聚合为整条文本消息）。</summary>
internal sealed class ClientWebSocketTransport : IQqBotWebSocket
{
    private readonly ClientWebSocket _socket;

    public ClientWebSocketTransport(ClientWebSocket socket) => _socket = socket;

    public bool IsOpen => _socket.State == WebSocketState.Open;

    public async Task SendTextAsync(string payload, CancellationToken cancellationToken)
    {
        var bytes = Encoding.UTF8.GetBytes(payload);
        await _socket.SendAsync(bytes, WebSocketMessageType.Text, endOfMessage: true, cancellationToken);
    }

    public async Task<string?> ReceiveTextAsync(CancellationToken cancellationToken)
    {
        var buffer = new byte[16 * 1024];
        using var message = new MemoryStream();
        while (true)
        {
            var result = await _socket.ReceiveAsync(buffer, cancellationToken);
            if (result.MessageType == WebSocketMessageType.Close) return null;
            message.Write(buffer, 0, result.Count);
            if (result.EndOfMessage) return Encoding.UTF8.GetString(message.ToArray());
        }
    }

    public async Task CloseAsync(int code, string reason, CancellationToken cancellationToken)
    {
        if (_socket.State is WebSocketState.Open or WebSocketState.CloseReceived)
        {
            await _socket.CloseAsync((WebSocketCloseStatus)code, reason, cancellationToken);
        }
    }

    public void Abort()
    {
        try
        {
            _socket.Abort();
        }
        catch
        {
            // 已断开/已释放：忽略
        }
    }

    public ValueTask DisposeAsync()
    {
        _socket.Dispose();
        return ValueTask.CompletedTask;
    }
}

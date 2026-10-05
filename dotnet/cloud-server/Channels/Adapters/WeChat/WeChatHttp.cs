using System.Net;
using System.Text;

namespace CyreneCloud.Channels.Adapters.WeChat;

/// <summary>
/// 微信渠道 HTTP 辅助（§3.5 内存预算：连接池复用、响应体上限流式读取）。
/// 超时统一由调用方 CTS 控制（长轮询 40s / 普通请求 30s），HttpClient 自身不设超时。
/// </summary>
internal static class WeChatHttp
{
    public static HttpClient CreateClient()
    {
        var handler = new SocketsHttpHandler
        {
            PooledConnectionLifetime = TimeSpan.FromMinutes(5),
            AutomaticDecompression = DecompressionMethods.All,
        };
        return new HttpClient(handler) { Timeout = Timeout.InfiniteTimeSpan };
    }

    /// <summary>流式读取文本响应，超过 maxBytes 抛错（超限断开重来，不落内存）。</summary>
    public static async Task<string> ReadLimitedStringAsync(
        HttpContent content, int maxBytes, CancellationToken cancellationToken)
    {
        var bytes = await ReadLimitedBytesAsync(content, maxBytes, cancellationToken);
        return Encoding.UTF8.GetString(bytes);
    }

    /// <summary>流式读取字节响应，超过 maxBytes 抛 <see cref="WeChatMediaTooLargeException"/>。</summary>
    public static async Task<byte[]> ReadLimitedBytesAsync(
        HttpContent content, long maxBytes, CancellationToken cancellationToken)
    {
        await using var stream = await content.ReadAsStreamAsync(cancellationToken);
        using var buffer = new MemoryStream();
        var chunk = new byte[16 * 1024];
        while (true)
        {
            var read = await stream.ReadAsync(chunk, cancellationToken);
            if (read == 0) break;
            if (buffer.Length + read > maxBytes)
            {
                throw new WeChatMediaTooLargeException(maxBytes);
            }
            buffer.Write(chunk, 0, read);
        }
        return buffer.ToArray();
    }
}

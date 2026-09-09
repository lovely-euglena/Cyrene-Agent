using System.IO;
using System.IO.Pipelines;
using System.Text.Json;

namespace CyreneNative;

/// <summary>
/// 宿主（Electron 主进程）↔ cyrene-native 的 stdio 帧协议。
/// 与 cyrene-embed sidecar 同一套帧格式（4B 小端长度 + JSON），
/// 命令空间扩展到窗口生命周期：
///
/// 宿主 → native：
///   {"id":1,"op":"win.spawn","kind":"splash|sidebar|tasks","layout":{...}}
///   {"id":2,"op":"win.close","kind":"sidebar"}
///   {"id":3,"op":"win.layout","layout":{...}}          // 布局联动（pet 窗移动）
///   {"id":4,"op":"win.show","kind":"splash"}           // ready-to-show 后显窗
///   {"id":5,"op":"state.runtime","state":{...}}        // sidebar 数据推送
///   {"id":6,"op":"state.model","config":{...}}
///   {"id":7,"op":"state.tasks","tasks":[...],"usage":[...]}
///   {"id":8,"op":"splash.close"}
///
/// native → 宿主：
///   {"id":0,"op":"ready"}
///   {"id":r,"ok":true}                                  // 请求确认
///   {"id":r,"ok":false,"error":"..."}
///   {"op":"event","name":"win.closed","kind":"sidebar"} // 窗口事件（无 id，通知）
///   {"op":"event","name":"win.shown","kind":"splash"}   // splash 首帧（对齐 onShown）
///   {"op":"event","name":"cmd","kind":"sidebar","action":"openSettings","section":"..."}
///                       // 用户点击：openChat/openSettings/openCall/togglePin/
///                       //           minimize/close（窗口自处理）/modelSwitch
/// </summary>
public sealed class HostProtocol : IDisposable
{
    private readonly Stream _stdin;
    private readonly Stream _stdout;
    private readonly Thread _readerThread;
    private readonly CancellationTokenSource _cts = new();
    private readonly Func<int, JsonElement, Task> _onRequest;
    private readonly Action<JsonElement> _onEvent;

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public HostProtocol(Stream stdin, Stream stdout, Func<int, JsonElement, Task> onRequest, Action<JsonElement> onEvent)
    {
        _stdin = stdin;
        _stdout = stdout;
        _onRequest = onRequest;
        _onEvent = onEvent;
        _readerThread = new Thread(ReadLoop) { IsBackground = true, Name = "host-protocol" };
        _readerThread.Start();
    }

    /// <summary>
    /// 发送 ready 握手帧（{"id":0,"op":"ready"}）。必须在读线程启动后、
    /// 宿主首个请求前调用——宿主侧 launch() 会阻塞等待此帧（15s 超时
    /// 后整体回收进程）。语义：协议层就绪（进程活着、帧收发可用），
    /// 不代表 WPF 就绪（窗口创建在首个 win.spawn 时才发生）。
    /// </summary>
    public void NotifyReady() => WriteFrame(new { id = 0, op = "ready" });

    public event Action<Exception>? ProtocolError;

    private void ReadLoop()
    {
        try
        {
            while (!_cts.IsCancellationRequested)
            {
                var frame = ReadFrame(_stdin);
                if (frame is null) break; // stdin EOF：宿主退出
                var element = JsonSerializer.Deserialize<JsonElement>(frame, Json);
                if (element.ValueKind == JsonValueKind.Object &&
                    element.TryGetProperty("op", out var op) &&
                    op.GetString() == "event")
                {
                    _onEvent(element);
                }
                else
                {
                    // 请求帧：id 必有
                    if (element.TryGetProperty("id", out var idEl) && idEl.TryGetInt32(out var id))
                    {
                        _ = HandleRequest(id, element);
                    }
                }
            }
        }
        catch (Exception ex)
        {
            ProtocolError?.Invoke(ex);
        }
    }

    private async Task HandleRequest(int id, JsonElement element)
    {
        try
        {
            await _onRequest(id, element);
        }
        catch (Exception ex)
        {
            ReplyError(id, ex.Message);
        }
    }

    /// <summary>回复请求确认（ok）。</summary>
    public void ReplyOk(int id) => WriteFrame(new { id, ok = true });

    /// <summary>回复请求失败。</summary>
    public void ReplyError(int id, string error) => WriteFrame(new { id, ok = false, error });

    /// <summary>向宿主发通知事件。</summary>
    public void SendEvent(object payload) => WriteFrame(payload);

    private void WriteFrame(object payload)
    {
        try
        {
            var json = JsonSerializer.Serialize(payload, Json);
            var bytes = System.Text.Encoding.UTF8.GetBytes(json);
            var prefix = BitConverter.GetBytes((int)bytes.Length);
            lock (_stdout)
            {
                _stdout.Write(prefix, 0, 4);
                _stdout.Write(bytes, 0, bytes.Length);
                _stdout.Flush();
            }
        }
        catch (Exception ex)
        {
            ProtocolError?.Invoke(ex);
        }
    }

    private static string? ReadFrame(Stream stdin)
    {
        var prefix = new byte[4];
        if (!ReadExact(stdin, prefix, 4)) return null;
        var length = BitConverter.ToInt32(prefix, 0);
        if (length is < 0 or > 16 * 1024 * 1024) throw new IOException($"frame length out of range: {length}");
        var payload = new byte[length];
        if (!ReadExact(stdin, payload, length)) return null;
        return System.Text.Encoding.UTF8.GetString(payload);
    }

    private static bool ReadExact(Stream stream, byte[] buffer, int count)
    {
        var read = 0;
        while (read < count)
        {
            var n = stream.Read(buffer, read, count - read);
            if (n <= 0) return false;
            read += n;
        }
        return true;
    }

    public void Dispose()
    {
        _cts.Cancel();
        try { _stdin.Close(); } catch { }
    }
}

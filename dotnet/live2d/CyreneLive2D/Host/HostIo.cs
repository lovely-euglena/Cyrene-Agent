// JSON 行协议 IO（与七 host 同构：tool-host / voice-host 帧约定）。
//
// 帧格式（每行一个 UTF-8 JSON 对象，\n 结尾）：
//   → {"op":"load","callId":"c1",...}
//   ← {"op":"ready"}
//   ← {"op":"result","callId":"c1","ok":true,"data":{...}}
//   ← {"op":"result","callId":"c1","ok":false,"error":"...","errorCode":"E_..."}
//   ← {"op":"event","name":"hit",...}
//   ← {"op":"log","level":"info","message":"..."}
//
// stdout 协议独占；诊断走 stderr。NaN/±Infinity 序列化为 null（对齐 JSON.stringify，
// 与 ToolHost.SafeDoubleJsonConverter 同策）。

using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace CyreneLive2D.Host;

public sealed class HostIo : IDisposable
{
    private readonly Stream _stdout;
    private readonly SemaphoreSlim _writeLock = new(1, 1);
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        Converters = { new SafeDoubleJsonConverter() },
    };

    public HostIo(Stream stdout)
    {
        _stdout = stdout;
    }

    public static JsonSerializerOptions Options => Json;

    /// <summary>发送一帧（线程安全）。</summary>
    public void Send(object frame)
    {
        var json = JsonSerializer.Serialize(frame, Json);
        var bytes = Encoding.UTF8.GetBytes(json + "\n");
        _writeLock.Wait();
        try
        {
            _stdout.Write(bytes, 0, bytes.Length);
            _stdout.Flush();
        }
        catch (IOException) { /* 宿主已退出 */ }
        catch (ObjectDisposedException) { }
        finally
        {
            _writeLock.Release();
        }
    }

    public void SendResult(string callId, object? data = null)
        => Send(new { op = Live2DOps.Result, callId, ok = true, data });

    public void SendError(string callId, string error, string errorCode)
        => Send(new { op = Live2DOps.Result, callId, ok = false, error, errorCode });

    public void SendEvent(string name, object? payload = null)
        => Send(new { op = "event", name, payload });

    public void Log(string level, string message)
        => Send(new { op = "log", level, message });

    public void Dispose() => _writeLock.Dispose();

    /// <summary>NaN/±Infinity → null（System.Text.Json 默认抛异常，JS 侧 JSON.stringify 得 null）。</summary>
    private sealed class SafeDoubleJsonConverter : JsonConverter<double>
    {
        public override double Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
            => reader.TokenType == JsonTokenType.Null ? 0 : reader.GetDouble();

        public override void Write(Utf8JsonWriter writer, double value, JsonSerializerOptions options)
        {
            if (double.IsNaN(value) || double.IsInfinity(value)) writer.WriteNullValue();
            else writer.WriteNumberValue(value);
        }
    }
}

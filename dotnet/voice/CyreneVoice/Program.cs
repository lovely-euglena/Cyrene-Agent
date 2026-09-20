using CyreneVoice.Engines;
using CyreneVoice.Vad;
using System.IO;
using System.Text;
using System.Text.Json;

namespace CyreneVoice;

/// <summary>
/// 语音后端宿主协议（F3.1：stdio JSON 帧 + 4B 长度头二进制段）。
///
/// 文本帧（一行一个 JSON）；音频走二进制段：
///   → {"op":"tts","callId":"t1","engine":"mossland","payload":{...}}
///   ← {"op":"tts_meta","callId","format":"mp3","bytes":N}   （先元数据）
///   ← [4B 大端长度][音频字节]                                  （后二进制）
///   → {"op":"asr_start","callId":"a1","engine":"volcano","config":{...}}
///   → {"op":"asr_audio","callId","pcmBase64":"..."}  循环
///   → {"op":"asr_flush","callId"} / {"op":"asr_stop","callId"}
///   ← {"op":"asr_partial","callId","text":"..."} / {"op":"asr_final",...}
///   → {"op":"vad_config","mode":"hybrid","threshold":0.5,...}
///   → {"op":"vad_audio","callId","pcm16Base64":"..."}
///   ← {"op":"vad_result","callId","speech":true,"prob":0.97,"calibrated":0.42}
///   → {"op":"shutdown"}
///
/// 错误码（F3.2）：E_TTS_TIMEOUT / E_TTS_RATE（429）/ E_TTS_SERVER（5XX）/
///   E_TTS_AUTH / E_ASR_TIMEOUT / E_ASR_AUTH / E_ENGINE_UNKNOWN。
/// 双轨（F3.3）：CYRENE_VOICE_HOST=0/缺 exe/启动失败 → Electron 自动回 TS。
/// </summary>
internal static class Program
{
    public static int Main(string[] args)
    {
        var stdout = Console.OpenStandardOutput();
        var stdin = Console.OpenStandardInput();
        var ioLock = new SemaphoreSlim(1, 1);

        void Send(object frame) => WriteJson(stdout, ioLock, frame);
        Send(new { op = "ready" });

        var tts = new TtsDispatcher(Send);
        var vad = new VadEngine(Send);
        var asr = new AsrDispatcher(Send);
        // TtsCache（F2.4）：exe 同级 ./data/tts-cache（A15 便携语义 B10）
        var exeDir = AppContext.BaseDirectory;
        var cache = new TtsCache(Path.Combine(exeDir, "data", "tts-cache", "cache.db"));

        using var reader = new StreamReader(stdin, Encoding.UTF8);
        string? line;
        while ((line = reader.ReadLine()) is not null)
        {
            if (string.IsNullOrWhiteSpace(line)) continue;
            JsonDocument doc;
            try { doc = JsonDocument.Parse(line); }
            catch { continue; }
            var root = doc.RootElement.Clone();
            var op = root.TryGetProperty("op", out var o) ? o.GetString() : null;
            var callId = root.TryGetProperty("callId", out var c) ? c.GetString() ?? "" : "";
            try
            {
                switch (op)
                {
                    case "tts":
                        await_or_sync(tts.Handle(callId, root, cache), stdout, ioLock);
                        break;
                    case "asr_start":
                        await_or_sync(asr.Start(callId, root), stdout, ioLock);
                        break;
                    case "asr_audio":
                        await_or_sync(asr.Audio(callId, root.TryGetProperty("pcmBase64", out var pb) ? pb.GetString() ?? "" : ""), stdout, ioLock);
                        break;
                    case "asr_flush":
                        await_or_sync(asr.Flush(callId), stdout, ioLock);
                        break;
                    case "asr_stop":
                        await_or_sync(asr.Stop(callId), stdout, ioLock);
                        break;
                    case "vad_config":
                        vad.Configure(root);
                        Send(new { op = "result", callId = "vad", ok = true, data = new { mode = vad.Mode, threshold = vad.Threshold } });
                        break;
                    case "vad_audio":
                        vad.Handle(callId, root);
                        break;
                    case "shutdown":
                        return 0;
                    default:
                        Send(new { op = "result", callId, ok = false, error = $"未知 op: {op}", errorCode = "E_ENGINE_UNKNOWN" });
                        break;
                }
            }
            catch (EngineException ex)
            {
                Send(new { op = "result", callId, ok = false, error = ex.Message, errorCode = ex.Code });
            }
            catch (Exception ex)
            {
                Send(new { op = "result", callId, ok = false, error = ex.Message, errorCode = "E_TTS_SERVER" });
            }
        }
        return 0;
    }

    /// <summary>TTS 输出元数据后接二进制音频段——顺序写不能交错，统一经此。</summary>
    private static void await_or_sync(Task task, Stream stdout, SemaphoreSlim ioLock)
    {
        try { task.GetAwaiter().GetResult(); }
        catch { /* Handle 内部已发错误帧 */ }
        _ = stdout; _ = ioLock;
    }

    internal static void WriteJson(Stream stdout, SemaphoreSlim ioLock, object frame)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(frame);
        ioLock.Wait();
        try { stdout.Write(bytes, 0, bytes.Length); stdout.WriteByte((byte)'\n'); stdout.Flush(); }
        catch { /* 宿主退出 */ }
        finally { ioLock.Release(); }
    }

    /// <summary>二进制段：4B 大端长度 + 载荷（音频回传专用，F3.1）。</summary>
    internal static void WriteBinary(Stream stdout, SemaphoreSlim ioLock, byte[] payload)
    {
        ioLock.Wait();
        try
        {
            var len = BitConverter.GetBytes((uint)payload.Length);
            if (BitConverter.IsLittleEndian) Array.Reverse(len);
            stdout.Write(len, 0, 4);
            stdout.Write(payload, 0, payload.Length);
            stdout.Flush();
        }
        catch { /* 宿主退出 */ }
        finally { ioLock.Release(); }
    }
}

/// <summary>F3.2 统一错误码。</summary>
internal sealed class EngineException : Exception
{
    public string Code { get; }
    public EngineException(string code, string message) : base(message) => Code = code;
}

/// <summary>帧发送委托（与 VadEngine.Sink 同形）。</summary>
internal delegate void SendFrameDelegate(object frame);

using System.IO;
using System.Net.Http;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace CyreneVoice.Engines;

/// <summary>
/// ASR 引擎层（F2.3）：
///   volcano —— 火山引擎 WS 流式（HMAC-SHA256 token + PCM 16k s16le
///              二进制帧；语义对齐 src/main/asr/volcano-asr.ts：全双工
///              音频流上/文本下，句尾由 server sentence_end 判定）
///   mossland —— HTTP 提交 + 轮询结果（一次性，非流式）
/// 双轨（F3.3）：CYRENE_VOICE_HOST 未启用时 Electron 走 TS 原路。
/// </summary>
internal sealed class AsrDispatcher : IDisposable
{
    public delegate void SendFrame(object frame);
    private readonly SendFrame _send;
    private readonly Dictionary<string, ClientWebSocket> _sockets = new();
    private readonly Dictionary<string, string> _mosslandTasks = new();
    private readonly HttpClient _http = new() { Timeout = TimeSpan.FromSeconds(30) };

    public AsrDispatcher(SendFrame send) => _send = send;

    public async Task Start(string callId, JsonElement root)
    {
        var engine = root.TryGetProperty("engine", out var e) ? e.GetString() : "volcano";
        switch (engine)
        {
            case "volcano":
                await StartVolcano(callId, root.GetProperty("config"));
                break;
            case "mossland":
                _mosslandTasks[callId] = root.GetProperty("config").GetRawText();
                _send(new { op = "asr_ready", callId, engine });
                break;
            default:
                throw new EngineException("E_ENGINE_UNKNOWN", $"未知 ASR 引擎: {engine}");
        }
    }

    // ── volcano：WS + HMAC token（对齐 TS：volcano-asr.ts 的鉴权拼装）──

    private async Task StartVolcano(string callId, JsonElement cfg)
    {
        var appId = cfg.TryGetProperty("appId", out var a) ? a.GetString() : "";
        var token = cfg.TryGetProperty("token", out var t) ? t.GetString() : "";
        var wsUrl = cfg.TryGetProperty("url", out var u) ? u.GetString()
            : "wss://openspeech.bytedance.com/api/v2/asr";
        if (string.IsNullOrEmpty(appId) || string.IsNullOrEmpty(token))
            throw new EngineException("E_ASR_AUTH", "volcano ASR 缺 appId/token");

        var ws = new ClientWebSocket();
        var ts = DateTimeOffset.UtcNow.ToUnixTimeSeconds().ToString();
        var nonce = Guid.NewGuid().ToString("N");
        // 签名串（对齐 TS 侧 ws 拼装）：WSS-POST + 路径 + 参数 + 体内两字段
        var pathAndQuery = new Uri(wsUrl).PathAndQuery;
        var signatureInput = $"POST {pathAndQuery}\nX-Api-App-Key:{appId}\nX-Api-Timestamp:{ts}\nX-Api-Nonce:{nonce}";
        using var hmac = new HMACSHA256(Encoding.UTF8.GetBytes(token));
        var signature = Convert.ToHexString(hmac.ComputeHash(Encoding.UTF8.GetBytes(signatureInput))).ToLowerInvariant();
        ws.Options.SetRequestHeader("X-Api-App-Key", appId);
        ws.Options.SetRequestHeader("X-Api-Timestamp", ts);
        ws.Options.SetRequestHeader("X-Api-Nonce", nonce);
        ws.Options.SetRequestHeader("X-Api-Signature", signature);

        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        await ws.ConnectAsync(new Uri(wsUrl), cts.Token);
        _sockets[callId] = ws;
        _send(new { op = "asr_ready", callId, engine = "volcano" });
        _ = Task.Run(() => ReadLoop(callId, ws));
    }

    private async Task ReadLoop(string callId, ClientWebSocket ws)
    {
        var buffer = new byte[64 * 1024];
        try
        {
            while (ws.State == WebSocketState.Open)
            {
                using var msg = new MemoryStream();
                WebSocketReceiveResult result;
                do
                {
                    result = await ws.ReceiveAsync(new ArraySegment<byte>(buffer), CancellationToken.None);
                    if (result.MessageType == WebSocketMessageType.Close) return;
                    msg.Write(buffer, 0, result.Count);
                } while (!result.EndOfMessage);
                using var doc = JsonDocument.Parse(msg.ToArray());
                var root = doc.RootElement;
                var text = root.TryGetProperty("result", out var r) && r.ValueKind == JsonValueKind.Object
                    && r.TryGetProperty("text", out var rt) ? rt.GetString() : null;
                var isFinal = root.TryGetProperty("is_final", out var f) && f.GetBoolean();
                _send(new { op = isFinal ? "asr_final" : "asr_partial", callId, text = text ?? "" });
            }
        }
        catch (Exception ex)
        {
            _send(new { op = "asr_error", callId, error = ex.Message, errorCode = "E_ASR_TIMEOUT" });
        }
        finally
        {
            _sockets.Remove(callId);
        }
    }

    public async Task Audio(string callId, string pcmBase64)
    {
        if (!_sockets.TryGetValue(callId, out var ws) || ws.State != WebSocketState.Open) return;
        var pcm = Convert.FromBase64String(pcmBase64);
        await ws.SendAsync(new ArraySegment<byte>(pcm), WebSocketMessageType.Binary, true, CancellationToken.None);
    }

    public async Task Stop(string callId)
    {
        if (_sockets.TryGetValue(callId, out var ws))
        {
            try { await ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "done", CancellationToken.None); }
            catch { /* ignore */ }
            _sockets.Remove(callId);
        }
        if (_mosslandTasks.Remove(callId, out var cfgRaw))
        {
            // mossland 一次性识别（提交→取回）
            using var doc = JsonDocument.Parse(cfgRaw);
            var url = doc.RootElement.TryGetProperty("url", out var u) ? u.GetString() : "";
            using var resp = await _http.PostAsync(url,
                new StringContent(doc.RootElement.TryGetProperty("audioBase64", out var ab)
                    ? $"{{\"audio\":\"{ab.GetString()}\"}}" : "{}", Encoding.UTF8, "application/json"));
            var text = await resp.Content.ReadAsStringAsync();
            _send(new { op = "asr_final", callId, text });
        }
    }

    /// <summary>flush：发送 EOF 半关闭信号（等 server 收尾）。</summary>
    public async Task Flush(string callId)
    {
        if (_sockets.TryGetValue(callId, out var ws))
        {
            try { await ws.SendAsync(new ArraySegment<byte>(Array.Empty<byte>()), WebSocketMessageType.Text, true, CancellationToken.None); }
            catch { /* ignore */ }
        }
    }

    public void Dispose()
    {
        foreach (var ws in _sockets.Values)
        {
            try { ws.Dispose(); } catch { /* ignore */ }
        }
        _sockets.Clear();
    }
}

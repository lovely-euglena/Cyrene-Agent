using System.Net.Http;
using System.Text;
using System.Text.Json;

namespace CyreneVoice.Engines;

/// <summary>
/// TTS 引擎层（F2.2）：5 引擎 + 统一重试/超时/错误码。
/// 状态：mossland / mimo / custom-cloud / gptsovits 四引擎 HTTP 完整实现；
/// minimax（WS 流式+音色克隆）为骨架（接口/重试/错误码就位，WS 帧循环
/// 待接协议细节——诚实标注，Windows 冒烟后补）。
/// gptsovits 的 refAudioPath 由本侧读文件（A14：TS 不传 buffer）。
/// </summary>
internal sealed class TtsDispatcher
{
    public delegate void SendFrame(object frame);
    private readonly SendFrame _send;
    private readonly HttpClient _http = new() { Timeout = TimeSpan.FromSeconds(15) };

    public TtsDispatcher(SendFrame send) => _send = send;

    public async Task Handle(string callId, JsonElement root)
    {
        var engine = root.TryGetProperty("engine", out var e) ? e.GetString() : null;
        var payload = root.TryGetProperty("payload", out var p) ? p : (JsonElement?)null;
        const int retries = 2;
        for (var attempt = 0; ; attempt++)
        {
            try
            {
                var (audio, format) = engine switch
                {
                    "mossland" => await PostJson(engine, payload, "/api/tts"),
                    "mimo" => await PostJson(engine, payload, "/v1/tts"),
                    "custom-cloud" => await PostJson(engine, payload, null),
                    "gptsovits" => await GptSoVits(payload),
                    "minimax" => await MinimaxSkeleton(payload),
                    _ => throw new EngineException("E_ENGINE_UNKNOWN", $"未知 TTS 引擎: {engine}"),
                };
                _send(new { op = "tts_meta", callId, format, bytes = audio.Length });
                _send(new { op = "tts_audio_b64", callId, audioBase64 = Convert.ToBase64String(audio) });
                return;
            }
            catch (EngineException ex) when (attempt < retries && ex.Code is "E_TTS_TIMEOUT" or "E_TTS_SERVER")
            {
                await Task.Delay(300 * (attempt + 1));   // 线性退避重试
            }
        }
    }

    private async Task<(byte[] audio, string format)> PostJson(string engine, JsonElement? payload, string? path)
    {
        try
        {
            var url = payload?.TryGetProperty("endpoint", out var ep) == true ? ep.GetString()
                ?? throw new EngineException("E_TTS_AUTH", "endpoint 未配置")
                : throw new EngineException("E_TTS_AUTH", "endpoint 未配置");
            if (path is not null && !url.EndsWith(path)) url += path;
            using var req = new HttpRequestMessage(HttpMethod.Post, url);
            if (payload?.TryGetProperty("apiKey", out var ak) == true)
                req.Headers.TryAddWithoutValidation("Authorization", $"Bearer {ak.GetString()}");
            req.Content = new StringContent(
                JsonSerializer.Serialize(payload?.Clone() ?? (object)new { }),
                Encoding.UTF8, "application/json");
            using var resp = await _http.SendAsync(req);
            if (resp.StatusCode == System.Net.HttpStatusCode.Unauthorized ||
                resp.StatusCode == System.Net.HttpStatusCode.Forbidden)
                throw new EngineException("E_TTS_AUTH", $"鉴权失败: {(int)resp.StatusCode}");
            if ((int)resp.StatusCode == 429)
                throw new EngineException("E_TTS_RATE", "429 限流");
            if (!resp.IsSuccessStatusCode)
                throw new EngineException("E_TTS_SERVER", $"5XX/其它: {(int)resp.StatusCode}");
            var audio = await resp.Content.ReadAsByteArrayAsync();
            return (audio, "mp3");
        }
        catch (HttpRequestException ex)
        {
            throw new EngineException("E_TTS_TIMEOUT", ex.Message);
        }
        catch (TaskCanceledException)
        {
            throw new EngineException("E_TTS_TIMEOUT", "请求超时（15s）");
        }
    }

    /// <summary>A14：refAudioPath 在本侧读文件，TS 只传路径。</summary>
    private async Task<(byte[] audio, string format)> GptSoVits(JsonElement? payload)
    {
        var p = payload ?? throw new EngineException("E_TTS_AUTH", "payload 缺失");
        var url = p.TryGetProperty("endpoint", out var ep) ? ep.GetString() ?? "" : "";
        var text = p.TryGetProperty("text", out var t) ? t.GetString() ?? "" : "";
        var refPath = p.TryGetProperty("refAudioPath", out var rp) ? rp.GetString() : null;
        var form = new MultipartFormDataContent
        {
            { new StringContent(text), "text" },
        };
        if (refPath is not null && File.Exists(refPath))
            form.Add(new ByteArrayContent(await File.ReadAllBytesAsync(refPath)), "ref_audio", Path.GetFileName(refPath));
        using var resp = await _http.PostAsync(url, form);
        if (!resp.IsSuccessStatusCode)
            throw new EngineException("E_TTS_SERVER", $"gptsovits: {(int)resp.StatusCode}");
        return (await resp.Content.ReadAsByteArrayAsync(), "wav");
    }

    /// <summary>minimax WS 流式骨架（接口/错误码/重试就位；WS 帧循环待接）。</summary>
    private Task<(byte[] audio, string format)> MinimaxSkeleton(JsonElement? payload)
        => throw new EngineException("E_TTS_SERVER", "minimax WS 流式引擎骨架就位，协议循环待接（见 TtsDispatcher 注释）");
}

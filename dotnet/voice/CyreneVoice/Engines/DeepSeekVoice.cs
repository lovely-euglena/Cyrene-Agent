using System.IO;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

namespace CyreneVoice.Engines;

/// <summary>
/// DeepSeek 语音引擎（全家桶应用 API /v1/tools/*；语义对齐
/// src/main/asr/deepseek-voice-engine.ts——TS 轨为真源，本层为双轨镜像）。
/// - TTS：POST /v1/tools/tts，JSON {text, voice_id, format:"pcm", filter_markdown}，
///   返回裸 PCM 字节流（24kHz/mono/16-bit LE）；首帧即 200。
/// - ASR：POST /v1/tools/asr，multipart 上传 WAV（mono 16-bit PCM），
///   ≤120s / ≤8MiB，一次返回 {text}——缓冲式会话（无流式接口）。
/// 鉴权均 Authorization: Bearer。
/// </summary>
internal static class DeepSeekVoice
{
    public const int TtsSampleRate = 24_000;
    public const long AsrMaxBytes = 8 * 1024 * 1024;   // 8 MiB（官方限额）
    public const int AsrMaxDurationMs = 120_000;        // 120s（官方限额）

    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(15) };

    /// <summary>TTS：收集完整 PCM 字节流后返回（格式 "pcm" 直传宿主）。</summary>
    public static async Task<(byte[] audio, string format)> SynthesizeTts(string apiKey, string text, string voiceId, string? baseUrl)
    {
        var url = $"{NormalizeBase(baseUrl)}/tts";
        using var req = new HttpRequestMessage(HttpMethod.Post, url);
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", apiKey);
        req.Content = new StringContent(JsonSerializer.Serialize(new
        {
            text,
            voice_id = voiceId,
            format = "pcm",
            filter_markdown = true,
        }), Encoding.UTF8, "application/json");
        using var resp = await Http.SendAsync(req);
        if ((int)resp.StatusCode == 429)
            throw new EngineException("E_TTS_RATE", "DeepSeek TTS 429 限流");
        if (resp.StatusCode == System.Net.HttpStatusCode.Unauthorized ||
            resp.StatusCode == System.Net.HttpStatusCode.Forbidden)
            throw new EngineException("E_TTS_AUTH", $"DeepSeek TTS 鉴权失败: {(int)resp.StatusCode}");
        if (!resp.IsSuccessStatusCode)
            throw new EngineException("E_TTS_SERVER", $"DeepSeek TTS: {(int)resp.StatusCode}");
        using var ms = new MemoryStream();
        await resp.Content.CopyToAsync(ms);
        return (ms.ToArray(), "pcm");
    }

    /// <summary>ASR：整段 WAV multipart 上传（一次性接口；失败原样抛 HTTP 错误）。</summary>
    public static async Task<string> TranscribeWav(string apiKey, byte[] wav, string? baseUrl)
    {
        var url = $"{NormalizeBase(baseUrl)}/asr";
        using var req = new HttpRequestMessage(HttpMethod.Post, url);
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", apiKey);
        var form = new MultipartFormDataContent
        {
            { new ByteArrayContent(wav), "file", "recording.wav" },
        };
        form[0].Headers.ContentType = new MediaTypeHeaderValue("audio/wav");
        req.Content = form;
        using var resp = await Http.SendAsync(req);
        if (!resp.IsSuccessStatusCode)
            throw new EngineException("E_ASR_SERVER", $"DeepSeek ASR: {(int)resp.StatusCode}");
        var raw = await resp.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(raw);
        if (!doc.RootElement.TryGetProperty("text", out var t) || t.ValueKind != JsonValueKind.String)
            throw new EngineException("E_ASR_SERVER", "DeepSeek ASR 响应缺 text 字段");
        return t.GetString() ?? "";
    }

    /// <summary>16kHz/16bit/mono PCM → WAV（44 字节标准头；语义对齐 TS encodePcm16MonoWav）。</summary>
    public static byte[] EncodePcm16MonoWav(byte[] pcm, int sampleRate = 16_000)
    {
        using var ms = new MemoryStream(44 + pcm.Length);
        var bw = new BinaryWriter(ms);
        bw.Write("RIFF"u8);
        bw.Write(36 + pcm.Length);
        bw.Write("WAVE"u8);
        bw.Write("fmt "u8);
        bw.Write(16);
        bw.Write((short)1);                          // PCM
        bw.Write((short)1);                          // mono
        bw.Write(sampleRate);
        bw.Write(sampleRate * 2);                    // byte rate
        bw.Write((short)2);                          // block align
        bw.Write((short)16);                         // bits per sample
        bw.Write("data"u8);
        bw.Write(pcm.Length);
        bw.Write(pcm);
        bw.Flush();
        return ms.ToArray();
    }

    private static string NormalizeBase(string? baseUrl)
        => (string.IsNullOrEmpty(baseUrl)
            ? "https://api.deepseek.com/v1/tools"
            : baseUrl.TrimEnd('/'));
}

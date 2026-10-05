namespace CyreneCloud.Channels.Adapters.WeChat;

/// <summary>
/// SILK 语音编解码抽象（设计 §4.2 决策矩阵；实现属阶段 7）。
/// 入站：SILK → PCM16LE；出站：PCM16LE → SILK + 时长/采样率/encode_type。
/// </summary>
public interface ISilkCodec
{
    /// <summary>编解码是否可用；false 时适配器走文本降级（§4.1 V1）。</summary>
    bool IsAvailable { get; }

    Task<byte[]> DecodeAsync(byte[] silk, int sampleRate, CancellationToken cancellationToken = default);

    Task<SilkVoiceEncoding> EncodeAsync(byte[] pcm16Le, int sampleRate, CancellationToken cancellationToken = default);
}

/// <summary>出站语音编码结果（voice_item 字段来源）。</summary>
public sealed record SilkVoiceEncoding(byte[] Data, int DurationMs, int SampleRate, int EncodeType);

/// <summary>
/// 阶段 7 之前的占位实现：不可用，调用即抛（适配器不调用，仅防御）。
/// 降级文案与桌面 ASR 未配置同口径（§4.1）：入站语音回「还没有配置语音识别」，
/// 出站语音跳过并标注状态 voice:false。
/// </summary>
public sealed class SilkUnavailableCodec : ISilkCodec
{
    public const string UnavailableMessage = "SILK 语音编解码未启用（阶段 7 落地）";

    public bool IsAvailable => false;

    public Task<byte[]> DecodeAsync(byte[] silk, int sampleRate, CancellationToken cancellationToken = default) =>
        throw new SilkUnavailableException(UnavailableMessage);

    public Task<SilkVoiceEncoding> EncodeAsync(byte[] pcm16Le, int sampleRate, CancellationToken cancellationToken = default) =>
        throw new SilkUnavailableException(UnavailableMessage);
}

public sealed class SilkUnavailableException : Exception
{
    public SilkUnavailableException(string message) : base(message) { }
}

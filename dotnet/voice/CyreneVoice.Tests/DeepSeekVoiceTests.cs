using System.Text;
using CyreneVoice.Engines;
using Xunit;

namespace CyreneVoice.Tests;

public class DeepSeekVoiceTests
{
    [Fact]
    public void EncodePcm16MonoWav_WritesValidHeader()
    {
        var pcm = new byte[] { 0x34, 0x12, 0x78, 0x56 };
        var wav = DeepSeekVoice.EncodePcm16MonoWav(pcm, 16_000);

        Assert.Equal("RIFF", Encoding.ASCII.GetString(wav, 0, 4));
        Assert.Equal(40u, BitConverter.ToUInt32(wav, 4));
        Assert.Equal("WAVE", Encoding.ASCII.GetString(wav, 8, 4));
        Assert.Equal("fmt ", Encoding.ASCII.GetString(wav, 12, 4));
        Assert.Equal(1, BitConverter.ToUInt16(wav, 20));         // PCM
        Assert.Equal(1, BitConverter.ToUInt16(wav, 22));         // mono
        Assert.Equal(16_000u, BitConverter.ToUInt32(wav, 24));
        Assert.Equal(32_000u, BitConverter.ToUInt32(wav, 28));   // byte rate
        Assert.Equal(2, BitConverter.ToUInt16(wav, 32));
        Assert.Equal(16, BitConverter.ToUInt16(wav, 34));
        Assert.Equal("data", Encoding.ASCII.GetString(wav, 36, 4));
        Assert.Equal(4u, BitConverter.ToUInt32(wav, 40));
        Assert.Equal(pcm, wav[44..]);
    }

    [Fact]
    public void Constants_MatchOfficialLimits()
    {
        Assert.Equal(24_000, DeepSeekVoice.TtsSampleRate);
        Assert.Equal(8 * 1024 * 1024, DeepSeekVoice.AsrMaxBytes);
        Assert.Equal(120_000, DeepSeekVoice.AsrMaxDurationMs);
    }
}

// 静态类成员可测性：InternalVisibleTo 已由 csproj 同 assembly 隐式（同进程引用）；
// EngineException/分发分支的协议级测试（mossland 同款）在实机冒烟补。

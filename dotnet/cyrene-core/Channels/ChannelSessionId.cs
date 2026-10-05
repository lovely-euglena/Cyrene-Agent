using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace CyreneNative.Channels;

/// <summary>
/// 渠道会话/事件 id 派生（docs/design/2026-10-05-server-channel.md §2.4/§2.5）。
///
/// 与 TS `src/main/channels/normalizers/ids.ts` 逐字一致（UTF-8 输入、小写 hex），
/// fixtures/channels 的 derived-ids 用例双端锁定：
///   sessionId        = "channel:" + channel + ":" + sha256hex(channel + ":" + chatId)[0..16]
///   turnSource       = messageId（非空）否则 `${at.getTime()}:${text}`，换行压成单行空格
///   userEventId      = "ch-" + channel + "-" + sha256hex(channel + ":" + chatId + ":" + turnSource)[0..32]
///   assistantEventId = "gen-" + sha256hex(sessionId + ":" + anchorEventId)[0..32]
///   proactiveEventId = "proactive-" + sha256hex(sessionId + ":" + intentId)[0..32]
/// </summary>
public static class ChannelSessionId
{
    private static readonly Regex LineBreakRegex = new("[\r\n]+", RegexOptions.Compiled);

    public static string Sha256Hex(string value) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();

    /// <summary>事件/turn id 的公共来源：messageId 优先，缺省 at:text；换行压成单行空格。</summary>
    public static string TurnSource(string? messageId, DateTimeOffset at, string text)
    {
        var source = string.IsNullOrEmpty(messageId) ? $"{at.ToUnixTimeMilliseconds()}:{text}" : messageId;
        return LineBreakRegex.Replace(source, " ");
    }

    public static string MakeSessionId(string channel, string chatId) =>
        $"channel:{channel}:{Sha256Hex($"{channel}:{chatId}")[..16]}";

    public static string MakeChannelTurnId(IncomingMessage message, string role) =>
        $"{message.Channel}:{message.ChatId}:{TurnSource(message.MessageId, message.At, message.Text)}:{role}";

    public static string MakeChannelUserEventId(IncomingMessage message) =>
        $"ch-{message.Channel}-{Sha256Hex($"{message.Channel}:{message.ChatId}:{TurnSource(message.MessageId, message.At, message.Text)}")[..32]}";

    public static string MakeAssistantEventId(string sessionId, string anchorEventId) =>
        $"gen-{Sha256Hex($"{sessionId}:{anchorEventId}")[..32]}";

    public static string MakeProactiveEventId(string sessionId, string intentId) =>
        $"proactive-{Sha256Hex($"{sessionId}:{intentId}")[..32]}";

    /// <summary>UTC 毫秒 ISO 字符串（同步协议 ts 格式）。</summary>
    public static string UtcNowIso(DateTimeOffset now) =>
        now.UtcDateTime.ToString(IsoUtcMillisecondsConverter.Format, CultureInfo.InvariantCulture);
}

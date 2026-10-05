using System.Text.Json;
using System.Text.Json.Nodes;
using CyreneNative.Channels.Normalizers;

namespace CyreneNative.Channels;

/// <summary>fixtures/channels 单个用例（格式见 fixtures/channels/README.md）。</summary>
public sealed record ChannelContractCase(
    string File,
    string Name,
    string Kind,
    string Channel,
    JsonElement Input,
    JsonElement Expect);

/// <summary>用例执行结果（Ok=false 时 Detail 为差异或异常信息）。</summary>
public sealed record ChannelContractRunResult(bool Ok, JsonElement? Actual, string Detail);

/// <summary>
/// fixtures/channels 的读取与规范化比较（供 smoke-host --selftest channel-contract）。
/// 与 TS 侧 runner（src/main/channels/contract-fixtures.test.ts）共用同一套向量，结果逐字段一致。
/// </summary>
public static class ChannelContractFixture
{
    public static ChannelContractCase Load(string file)
    {
        using var document = JsonDocument.Parse(File.ReadAllText(file));
        var root = document.RootElement;
        return new ChannelContractCase(
            Path.GetFileName(file),
            root.TryGetProperty("name", out var name) ? name.GetString() ?? "" : "",
            root.GetProperty("kind").GetString() ?? "",
            root.GetProperty("channel").GetString() ?? "",
            root.GetProperty("input").Clone(),
            root.GetProperty("expect").Clone());
    }

    public static List<ChannelContractCase> LoadDirectory(string directory)
    {
        var cases = new List<ChannelContractCase>();
        if (!Directory.Exists(directory)) return cases;
        var files = Directory.GetFiles(directory, "*.json");
        Array.Sort(files, StringComparer.Ordinal);
        foreach (var file in files) cases.Add(Load(file));
        return cases;
    }

    /// <summary>执行单个用例并比较 expect（异常 → Ok=false + 异常信息）。</summary>
    public static ChannelContractRunResult Run(ChannelContractCase item)
    {
        try
        {
            var actual = RunCore(item);
            var diff = DeepCompare(actual, item.Expect);
            return diff is null
                ? new ChannelContractRunResult(true, actual, "")
                : new ChannelContractRunResult(false, actual, diff);
        }
        catch (Exception ex)
        {
            return new ChannelContractRunResult(false, null, $"{ex.GetType().Name}: {ex.Message}");
        }
    }

    private static JsonElement RunCore(ChannelContractCase item) => item.Kind switch
    {
        "inbound" => RunInbound(item),
        "outbound" => RunOutbound(item),
        "derived-ids" => RunDerivedIds(item),
        "text-split" => RunTextSplit(item),
        "capability" => JsonSerializer.SerializeToElement(ChannelCapabilities.For(item.Channel), ChannelJson.Options),
        _ => throw new InvalidOperationException($"未知 kind: {item.Kind}"),
    };

    private static JsonElement RunInbound(ChannelContractCase item)
    {
        var input = item.Input;
        var raw = input.GetProperty("raw");
        var now = input.TryGetProperty("now", out var nowElement)
            ? ReadAt(nowElement)
            : DateTimeOffset.UnixEpoch;

        object? message;
        object? media;
        switch (item.Channel)
        {
            case ChannelIds.WeChat:
            {
                var normalized = WeChatNormalizer.NormalizeInbound(raw, now);
                message = normalized?.Message;
                media = normalized?.Media ?? new List<WeChatInboundMedia>();
                break;
            }
            case ChannelIds.Feishu:
            {
                var normalized = FeishuNormalizer.NormalizeInbound(raw, now);
                message = normalized?.Message;
                media = normalized?.Media ?? new List<FeishuInboundMedia>();
                break;
            }
            case ChannelIds.QqBot:
            {
                var eventType = raw.TryGetProperty("type", out var typeElement) ? typeElement.GetString() ?? "" : "";
                var data = raw.TryGetProperty("data", out var dataElement) ? dataElement : default;
                message = QqBotNormalizer.NormalizeInbound(eventType, data, now);
                media = new List<object>();
                break;
            }
            default:
                throw new InvalidOperationException($"未知渠道: {item.Channel}");
        }

        // 显式 null 必须保留（expect 有该键）；嵌套对象用 ChannelJson.Options 预序列化（缺省键缺省）。
        var output = new JsonObject
        {
            ["message"] = message is null ? null : JsonSerializer.SerializeToNode(message, ChannelJson.Options),
            ["media"] = JsonSerializer.SerializeToNode(media, ChannelJson.Options),
        };
        return JsonSerializer.SerializeToElement(output, ChannelJson.Compact);
    }

    private static JsonElement RunOutbound(ChannelContractCase item)
    {
        var input = item.Input;
        var message = input.GetProperty("message").Deserialize<OutgoingMessage>(ChannelJson.Options)
            ?? throw new InvalidOperationException("message 反序列化失败");
        switch (item.Channel)
        {
            case ChannelIds.WeChat:
            {
                var context = new WeChatSendContext
                {
                    ContextToken = GetString(input, "contextToken") ?? "",
                    ClientId = GetString(input, "clientId") ?? "",
                    Uploads = TryDeserialize<Dictionary<string, WeChatCdnMedia>>(input, "uploads"),
                    Voices = TryDeserialize<Dictionary<string, WeChatVoiceUpload>>(input, "voices"),
                };
                return JsonSerializer.SerializeToElement(WeChatNormalizer.BuildSendRequests(message, context), ChannelJson.Options);
            }
            case ChannelIds.Feishu:
            {
                var context = new FeishuSendContext
                {
                    ReceiveIdType = GetString(input, "receiveIdType"),
                    Uploads = TryDeserialize<Dictionary<string, FeishuUploadResult>>(input, "uploads"),
                    Durations = TryDeserialize<Dictionary<string, double>>(input, "durations"),
                };
                return JsonSerializer.SerializeToElement(FeishuNormalizer.BuildSendRequests(message, context), ChannelJson.Options);
            }
            case ChannelIds.QqBot:
            {
                var messageId = GetString(input, "messageId") ?? "";
                var msgSeqUsed = input.TryGetProperty("msgSeqUsed", out var usedElement) ? usedElement.GetInt32() : 0;
                int? seqLimit = input.TryGetProperty("seqLimit", out var limitElement) ? limitElement.GetInt32() : null;
                return JsonSerializer.SerializeToElement(
                    QqBotNormalizer.BuildPassiveReplies(message, messageId, msgSeqUsed, seqLimit), ChannelJson.Options);
            }
            default:
                throw new InvalidOperationException($"未知渠道: {item.Channel}");
        }
    }

    private static JsonElement RunDerivedIds(ChannelContractCase item)
    {
        var input = item.Input;
        var channel = GetString(input, "channel") ?? "";
        var chatId = GetString(input, "chatId") ?? "";
        var message = new IncomingMessage
        {
            Channel = channel,
            SenderId = "",
            ChatId = chatId,
            MessageId = GetString(input, "messageId"),
            Text = GetString(input, "text") ?? "",
            At = ReadAt(input.GetProperty("at")),
        };
        var anchorEventId = GetString(input, "anchorEventId") ?? "";
        var intentId = GetString(input, "intentId") ?? "";
        var sessionId = ChannelSessionId.MakeSessionId(channel, chatId);
        var result = new
        {
            SessionId = sessionId,
            UserTurnId = ChannelSessionId.MakeChannelTurnId(message, "user"),
            AssistantTurnId = ChannelSessionId.MakeChannelTurnId(message, "assistant"),
            UserEventId = ChannelSessionId.MakeChannelUserEventId(message),
            AssistantEventId = ChannelSessionId.MakeAssistantEventId(sessionId, anchorEventId),
            ProactiveEventId = ChannelSessionId.MakeProactiveEventId(sessionId, intentId),
        };
        return JsonSerializer.SerializeToElement(result, ChannelJson.Options);
    }

    private static JsonElement RunTextSplit(ChannelContractCase item)
    {
        var input = item.Input;
        var text = GetString(input, "text") ?? "";
        var limit = input.TryGetProperty("limit", out var limitElement) ? limitElement.GetInt32() : (int?)null;
        var parts = item.Channel == ChannelIds.QqBot
            ? ChannelTextSplitting.SplitQqText(text, limit ?? ChannelTextSplitting.QqTextChunkCodepoints)
            : ChannelTextSplitting.SplitBySentenceBreaks(text, limit ?? ChannelTextSplitting.MaxMessageSegments);
        return JsonSerializer.SerializeToElement(new { Parts = parts }, ChannelJson.Options);
    }

    private static DateTimeOffset ReadAt(JsonElement element) =>
        element.Deserialize<DateTimeOffset>(ChannelJson.Options);

    private static string? GetString(JsonElement parent, string name) =>
        parent.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    private static T? TryDeserialize<T>(JsonElement parent, string name) where T : class =>
        parent.TryGetProperty(name, out var value) && value.ValueKind != JsonValueKind.Null
            ? value.Deserialize<T>(ChannelJson.Options)
            : null;

    /// <summary>逐字段 deep-equal：对象键集合精确一致（缺省键必须缺省）、数组有序、数字按值。</summary>
    public static string? DeepCompare(JsonElement actual, JsonElement expected, string path = "$")
    {
        if (actual.ValueKind != expected.ValueKind)
        {
            return $"{path}: 类型不一致 got={actual.ValueKind} want={expected.ValueKind}";
        }
        switch (expected.ValueKind)
        {
            case JsonValueKind.Object:
            {
                foreach (var property in expected.EnumerateObject())
                {
                    if (!actual.TryGetProperty(property.Name, out var actualValue))
                    {
                        return $"{path}.{property.Name}: 实际缺省（expect 有该键）";
                    }
                    var diff = DeepCompare(actualValue, property.Value, $"{path}.{property.Name}");
                    if (diff is not null) return diff;
                }
                foreach (var property in actual.EnumerateObject())
                {
                    if (!expected.TryGetProperty(property.Name, out _))
                    {
                        return $"{path}.{property.Name}: 实际多余（expect 无该键）";
                    }
                }
                return null;
            }
            case JsonValueKind.Array:
            {
                var actualItems = actual.EnumerateArray().ToArray();
                var expectedItems = expected.EnumerateArray().ToArray();
                if (actualItems.Length != expectedItems.Length)
                {
                    return $"{path}: 数组长度不一致 got={actualItems.Length} want={expectedItems.Length}";
                }
                for (var i = 0; i < expectedItems.Length; i++)
                {
                    var diff = DeepCompare(actualItems[i], expectedItems[i], $"{path}[{i}]");
                    if (diff is not null) return diff;
                }
                return null;
            }
            case JsonValueKind.Number:
            {
                if (actual.TryGetDouble(out var actualNumber) && expected.TryGetDouble(out var expectedNumber))
                {
                    return actualNumber == expectedNumber
                        ? null
                        : $"{path}: 数字不一致 got={actualNumber} want={expectedNumber}";
                }
                return actual.GetRawText() == expected.GetRawText()
                    ? null
                    : $"{path}: 数字不一致 got={actual.GetRawText()} want={expected.GetRawText()}";
            }
            case JsonValueKind.String:
            {
                var actualText = actual.GetString();
                var expectedText = expected.GetString();
                return string.Equals(actualText, expectedText, StringComparison.Ordinal)
                    ? null
                    : $"{path}: 字符串不一致 got={Truncate(actualText)} want={Truncate(expectedText)}";
            }
            // 布尔必须显式比较（P1-5）：此前落入 default 视为相等，capability 8 开关、
            // 微信媒体 analyzable 等字段的 C# 单侧漂移无法被 CI 发现。
            case JsonValueKind.True:
            case JsonValueKind.False:
            {
                return actual.GetBoolean() == expected.GetBoolean()
                    ? null
                    : $"{path}: 布尔不一致 got={actual.GetRawText()} want={expected.GetRawText()}";
            }
            default:
                return null;
        }
    }

    /// <summary>
    /// runner 自检（P1-5 回归探针）：人为构造布尔字段漂移，DeepCompare 必须报差异；
    /// 同时验证相等布尔不误报。返回 null = 通过，否则为失败说明。
    /// </summary>
    public static string? BooleanCompareSelfCheck()
    {
        using var expectedDocument = JsonDocument.Parse("""{"flag":false,"same":true}""");
        using var driftDocument = JsonDocument.Parse("""{"flag":true,"same":true}""");
        var drift = DeepCompare(driftDocument.RootElement, expectedDocument.RootElement);
        if (drift is null)
        {
            return "布尔字段漂移未被 DeepCompare 捕获（P1-5 回归）";
        }
        using var equalDocument = JsonDocument.Parse("""{"flag":false,"same":true}""");
        var equal = DeepCompare(equalDocument.RootElement, expectedDocument.RootElement);
        return equal is null ? null : $"相等布尔被误报为差异: {equal}";
    }

    private static string Truncate(string? value) =>
        value is null ? "null" : value.Length <= 120 ? value : value[..120] + "…";
}

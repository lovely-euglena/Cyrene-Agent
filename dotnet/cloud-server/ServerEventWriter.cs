using System.Text.Json;
using CyreneNative.Channels;
using CyreneNative.Sync;

namespace CyreneCloud.Storage;

/// <summary>
/// 服务端事件写者（docs/design/2026-10-05-server-channel.md §2.4 决策 R4）。
///
/// 统一分配 (lamport, seq) + eventId 幂等预检 + 写库：<see cref="SemaphoreSlim"/> 把
/// 「水位读取 + 预检 + 写入」串行化，避免 DialogLoop（push 生成）与渠道写者并发时
/// GetSessionWatermarkAsync + PushBatchAsync 的非原子组合。所有服务端事件 deviceId="server"。
/// </summary>
public sealed class ServerEventWriter
{
    public const string ServerDeviceId = "server";

    private readonly EventStore _store;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly TimeProvider _clock;

    public ServerEventWriter(EventStore store, TimeProvider? clock = null)
    {
        _store = store;
        _clock = clock ?? TimeProvider.System;
    }

    /// <summary>写单个事件：幂等（eventId 已存在 → Duplicate）、原子分配 (lamport, seq)。</summary>
    public async Task<ServerWriteResult> AppendAsync(ServerEventDraft draft, CancellationToken cancellationToken = default)
    {
        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            if (await _store.ContainsAsync(draft.EventId, cancellationToken).ConfigureAwait(false))
            {
                return ServerWriteResult.Duplicate(draft.EventId);
            }
            var (maxLamport, maxSeq) = await _store
                .GetSessionWatermarkAsync(draft.SessionId, ServerDeviceId, cancellationToken)
                .ConfigureAwait(false);
            var syncEvent = new SyncEventV0
            {
                EventId = draft.EventId,
                SessionId = draft.SessionId,
                Type = draft.Type,
                Lamport = maxLamport + 1,
                DeviceId = ServerDeviceId,
                Seq = maxSeq + 1,
                Ts = ChannelSessionId.UtcNowIso(_clock.GetUtcNow()),
                Payload = draft.Payload,
            };
            var outcome = await _store.PushBatchAsync([syncEvent], null, cancellationToken).ConfigureAwait(false);
            if (outcome.Errors.Count > 0)
            {
                return ServerWriteResult.Failed(draft.EventId, outcome.Errors);
            }
            return ServerWriteResult.Written(syncEvent);
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>
    /// 渠道用户消息 → `message.append`（role=user，turnId，presentation.channelSource；§2.4）。
    /// eventId = ch-&lt;channel&gt;-&lt;sha256(channel:chatId:messageId|at:text)[..32]&gt;。
    /// </summary>
    public Task<ServerWriteResult> WriteChannelUserMessageAsync(
        string sessionId, IncomingMessage message, CancellationToken cancellationToken = default)
    {
        var payload = JsonSerializer.SerializeToElement(new
        {
            role = "user",
            text = message.Text,
            turnId = ChannelSessionId.MakeChannelTurnId(message, "user"),
            presentation = new
            {
                patchRevision = 1,
                patch = new
                {
                    content = message.Text,
                    channelSource = new
                    {
                        channel = message.Channel,
                        chatType = message.ChatType ?? ChannelChatTypes.Private,
                        senderName = message.SenderName,
                    },
                },
            },
        }, ChannelJson.Options);
        var draft = new ServerEventDraft(
            sessionId, "message.append", ChannelSessionId.MakeChannelUserEventId(message), payload);
        return AppendAsync(draft, cancellationToken);
    }

    /// <summary>
    /// 生成回复写回（DialogLoop / 渠道共用）：eventId 由 DialogEngine 预计算；
    /// `withPresentation=true` 时附 `presentation={patchRevision:1,patch:{content}}`（渠道路径，§2.4），
    /// DialogLoop push 路径保持现状不带 presentation。
    /// </summary>
    public Task<ServerWriteResult> WriteAssistantMessageAsync(
        string sessionId, string eventId, string turnId, string text, bool withPresentation,
        CancellationToken cancellationToken = default)
    {
        JsonElement payload;
        if (withPresentation)
        {
            payload = JsonSerializer.SerializeToElement(new
            {
                role = "assistant",
                text,
                turnId,
                presentation = new
                {
                    patchRevision = 1,
                    patch = new { content = text },
                },
            }, ChannelJson.Options);
        }
        else
        {
            payload = JsonSerializer.SerializeToElement(new
            {
                role = "assistant",
                text,
                turnId,
            }, ChannelJson.Options);
        }
        return AppendAsync(new ServerEventDraft(sessionId, "message.append", eventId, payload), cancellationToken);
    }

    /// <summary>渠道助手回复（带 presentation，§2.4）。</summary>
    public Task<ServerWriteResult> WriteChannelAssistantMessageAsync(
        string sessionId, string eventId, string turnId, string text, CancellationToken cancellationToken = default) =>
        WriteAssistantMessageAsync(sessionId, eventId, turnId, text, withPresentation: true, cancellationToken);

    /// <summary>主动消息 → `message.append`（role=assistant，无 turnId；§2.4）。</summary>
    public Task<ServerWriteResult> WriteProactiveMessageAsync(
        string sessionId, string intentId, string text, CancellationToken cancellationToken = default)
    {
        var payload = JsonSerializer.SerializeToElement(new
        {
            role = "assistant",
            text,
        }, ChannelJson.Options);
        var draft = new ServerEventDraft(
            sessionId, "message.append", ChannelSessionId.MakeProactiveEventId(sessionId, intentId), payload);
        return AppendAsync(draft, cancellationToken);
    }
}

/// <summary>待写入事件（eventId 与 payload 由调用方按幂等规则构造）。</summary>
public sealed record ServerEventDraft(string SessionId, string Type, string EventId, JsonElement Payload);

public enum ServerWriteStatus
{
    Written,
    Duplicate,
    Failed,
}

/// <summary>写库结果：Duplicate = eventId 已存在（幂等跳过）；Failed = 链/序号校验拒绝。</summary>
public sealed record ServerWriteResult(
    ServerWriteStatus Status, string EventId, SyncEventV0? Event, List<SyncReadError> Errors)
{
    public bool IsWritten => Status == ServerWriteStatus.Written;
    public bool IsDuplicate => Status == ServerWriteStatus.Duplicate;

    public static ServerWriteResult Written(SyncEventV0 syncEvent) =>
        new(ServerWriteStatus.Written, syncEvent.EventId, syncEvent, []);

    public static ServerWriteResult Duplicate(string eventId) =>
        new(ServerWriteStatus.Duplicate, eventId, null, []);

    public static ServerWriteResult Failed(string eventId, List<SyncReadError> errors) =>
        new(ServerWriteStatus.Failed, eventId, null, errors);
}

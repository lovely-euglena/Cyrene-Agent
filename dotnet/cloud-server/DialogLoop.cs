using System.Collections.Concurrent;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;
using CyreneCloud.Storage;
using CyreneNative.Sync;

namespace CyreneCloud.Dialog;

/// <summary>
/// 服务端文本对话闭环（IKJK2M）：push 后异步触发 → 重放事件取活动分支 → 模型生成 → 幂等写回 assistant 事件。
/// Q2 拍板：Phase 1 用最小聊天环（不引 LoopHost/Agents；工具链留后续批次）。
///
/// - 幂等：assistant eventId = "gen-" + sha256(sessionId:锚点事件id)[..32]；写回走 EventStore 幂等索引，
///   重试/重复触发都不会产生重复消息（预检已存在即跳过，避免重复调用模型）；
/// - 重放（对齐 CTA / 协议 v0）：turn_rewind(keep_user) 裁掉锚点之后的尾；replace_user 裁掉锚点及其后并以
///   replacementUser 文本重建该轮；tombstone 移除目标轮；
/// - 失败重试：模型调用 2 次退避；仍失败只记日志，等待下一次事件触发（无副作用残留）；
/// - 日志只含 sessionId / 模型名 / token 用量，不含消息正文与密钥。
/// </summary>
public sealed class DialogLoop : BackgroundService
{
    private const string ServerDeviceId = "server";

    private readonly EventStore _store;
    private readonly ModelClient _model;
    private readonly ILogger<DialogLoop> _logger;
    private readonly string? _systemPrompt;
    private readonly int _contextChars;
    private readonly Channel<string> _queue = Channel.CreateUnbounded<string>();
    private readonly ConcurrentDictionary<string, byte> _queued = new();

    public DialogLoop(EventStore store, ModelClient model, ILogger<DialogLoop> logger, string? systemPrompt, int contextChars)
    {
        _store = store;
        _model = model;
        _logger = logger;
        _systemPrompt = systemPrompt;
        _contextChars = contextChars;
    }

    /// <summary>push 成功后投递「有新用户消息/回退」的会话（去重；模型未启用时静默忽略）。</summary>
    public void Publish(IEnumerable<string> sessionIds)
    {
        if (!_model.Enabled) return;
        foreach (var sessionId in sessionIds)
        {
            if (_queued.TryAdd(sessionId, 0))
            {
                _queue.Writer.TryWrite(sessionId);
            }
        }
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            await foreach (var sessionId in _queue.Reader.ReadAllAsync(stoppingToken))
            {
                _queued.TryRemove(sessionId, out _);
                try
                {
                    await ProcessSessionAsync(sessionId, stoppingToken);
                }
                catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
                {
                    throw;
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "生成失败 session={Session}", sessionId);
                }
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
            // 正常停机
        }
    }

    private sealed record BranchMessage(string Role, string Text, string TurnId, string AnchorEventId);

    private async Task ProcessSessionAsync(string sessionId, CancellationToken cancellationToken)
    {
        var events = await LoadSessionAsync(sessionId, cancellationToken);
        if (events.Count == 0) return;

        var branch = Replay(events);
        if (branch.Count == 0 || branch[^1].Role != "user") return;
        var pending = branch[^1];
        if (string.IsNullOrWhiteSpace(pending.Text)) return;

        var assistantEventId = "gen-" + Sha256Hex($"{sessionId}:{pending.AnchorEventId}")[..32];
        if (_store.Contains(assistantEventId)) return;

        var context = branch.Select(item => new ModelClient.ChatMessage(item.Role, item.Text)).ToList();
        if (!string.IsNullOrEmpty(_systemPrompt))
        {
            context.Insert(0, new ModelClient.ChatMessage("system", _systemPrompt));
        }
        TrimContext(context);

        var completion = await CompleteWithRetryAsync(context, cancellationToken);
        if (completion is null || string.IsNullOrWhiteSpace(completion.Text)) return;

        var lamport = events.Max(item => item.Lamport) + 1;
        var seq = events.Where(item => item.DeviceId == ServerDeviceId)
                        .Select(item => item.Seq)
                        .DefaultIfEmpty(0)
                        .Max() + 1;
        var generated = new SyncEventV0
        {
            EventId = assistantEventId,
            SessionId = sessionId,
            Type = "message.append",
            Lamport = lamport,
            DeviceId = ServerDeviceId,
            Seq = seq,
            Ts = DateTime.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture),
            Payload = JsonSerializer.SerializeToElement(new
            {
                role = "assistant",
                text = completion.Text,
                turnId = pending.TurnId,
            }),
        };
        var outcome = await _store.PushBatchAsync([generated], null, cancellationToken);
        if (outcome.Errors.Count > 0)
        {
            _logger.LogWarning("生成写回被拒 session={Session} event={Event} errors={Errors}",
                sessionId, assistantEventId, string.Join(",", outcome.Errors.Select(item => item.Code)));
        }
    }

    private async Task<List<SyncEventV0>> LoadSessionAsync(string sessionId, CancellationToken cancellationToken)
    {
        var all = new List<SyncEventV0>();
        long cursor = 0;
        while (true)
        {
            var page = await _store.FetchAsync(cursor, 1000, sessionId, cancellationToken);
            all.AddRange(page.Events);
            cursor = page.Cursor;
            if (!page.HasMore) break;
        }
        return all
            .OrderBy(item => item.Lamport)
            .ThenBy(item => item.DeviceId, StringComparer.Ordinal)
            .ThenBy(item => item.Seq)
            .ToList();
    }

    /// <summary>重放事件 → 活动分支消息流（编辑/重生成/删除语义见类注释）。</summary>
    private static List<BranchMessage> Replay(IReadOnlyList<SyncEventV0> events)
    {
        var messages = new List<BranchMessage>();
        var turnIndex = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var syncEvent in events)
        {
            switch (syncEvent.Type)
            {
                case "message.append":
                {
                    var payload = syncEvent.Payload;
                    var role = payload.GetProperty("role").GetString()!;
                    var text = payload.GetProperty("text").GetString()!;
                    var turnId = payload.TryGetProperty("turnId", out var turn) && turn.ValueKind == JsonValueKind.String
                        ? turn.GetString()!
                        : "";
                    if (role == "user" && turnId.Length > 0)
                    {
                        turnIndex[turnId] = messages.Count;
                    }
                    messages.Add(new BranchMessage(role, text, turnId, syncEvent.EventId));
                    break;
                }
                case "turn_rewind":
                {
                    var payload = syncEvent.Payload;
                    var anchor = payload.GetProperty("anchorUserTurnId").GetString()!;
                    var disposition = payload.GetProperty("disposition").GetString()!;
                    if (!turnIndex.TryGetValue(anchor, out var index)) break;
                    if (disposition == "keep_user")
                    {
                        // 重新生成：保留锚点 user，裁掉其后全部（旧 assistant 尾）
                        messages.RemoveRange(index + 1, messages.Count - index - 1);
                        messages[index] = messages[index] with { AnchorEventId = syncEvent.EventId };
                    }
                    else
                    {
                        // 编辑：连锚点 user 一起换成 replacementUser（revision+1），其后全部裁掉
                        messages.RemoveRange(index, messages.Count - index);
                        var replacement = payload.GetProperty("replacementUser").GetProperty("text").GetString()!;
                        messages.Add(new BranchMessage("user", replacement, anchor, syncEvent.EventId));
                    }
                    Reindex(messages, turnIndex);
                    break;
                }
                case "tombstone":
                {
                    var target = syncEvent.Payload.GetProperty("targetUserTurnId").GetString()!;
                    if (!turnIndex.TryGetValue(target, out var index)) break;
                    var end = index + 1;
                    while (end < messages.Count && messages[end].Role == "assistant")
                    {
                        end++;
                    }
                    messages.RemoveRange(index, end - index);
                    Reindex(messages, turnIndex);
                    break;
                }
            }
        }
        return messages;
    }

    private static void Reindex(List<BranchMessage> messages, Dictionary<string, int> turnIndex)
    {
        turnIndex.Clear();
        for (var i = 0; i < messages.Count; i++)
        {
            if (messages[i].Role == "user" && messages[i].TurnId.Length > 0)
            {
                turnIndex[messages[i].TurnId] = i;
            }
        }
    }

    private async Task<ModelClient.Completion?> CompleteWithRetryAsync(
        List<ModelClient.ChatMessage> context, CancellationToken cancellationToken)
    {
        for (var attempt = 1; attempt <= 2; attempt++)
        {
            try
            {
                var completion = await _model.CompleteAsync(context, cancellationToken);
                _logger.LogInformation(
                    "生成成功 model={Model} prompt_tokens={Prompt} completion_tokens={Completion} messages={Messages}",
                    _model.ModelName, completion.PromptTokens, completion.CompletionTokens, context.Count);
                return completion;
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "模型调用失败（第 {Attempt} 次）model={Model}", attempt, _model.ModelName);
                if (attempt < 2)
                {
                    await Task.Delay(TimeSpan.FromSeconds(attempt), cancellationToken);
                }
            }
        }
        return null;
    }

    /// <summary>按字符预算从最旧开始丢（保留最后一条待回复 user）。</summary>
    private void TrimContext(List<ModelClient.ChatMessage> context)
    {
        var total = context.Sum(item => item.Content.Length);
        var drop = 0;
        while (total > _contextChars && drop < context.Count - 1)
        {
            total -= context[drop].Content.Length;
            drop++;
        }
        if (drop > 0)
        {
            context.RemoveRange(0, drop);
        }
    }

    private static string Sha256Hex(string value) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();
}

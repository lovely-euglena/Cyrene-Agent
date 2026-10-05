using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using CyreneCloud.Storage;
using CyreneNative.Sync;

namespace CyreneCloud.Dialog;

/// <summary>
/// 服务端生成核心（§2.4 决策 R3，从 DialogLoop 抽出）：重放活动分支 → 模型生成 →
/// 返回回复文本与幂等 id，不写库、不投递。
///
/// - 幂等：assistant eventId = "gen-" + sha256(sessionId:锚点事件id)[..32]；已存在直接返回 null
///   （避免重复调用模型）；
/// - 重放（对齐 CTA / 协议 v0）：turn_rewind(keep_user) 裁掉锚点之后的尾；replace_user 裁掉锚点
///   及其后并以 replacementUser 文本重建该轮；tombstone 移除目标轮；
/// - 失败重试：模型调用 2 次退避；仍失败返回 null（调用方决定是否记录，无副作用残留）；
/// - 日志只含 sessionId / 模型名 / token 用量，不含消息正文与密钥。
/// </summary>
public interface IDialogEngine
{
    Task<GeneratedReply?> GenerateAsync(string sessionId, CancellationToken cancellationToken = default);
}

/// <summary>生成结果：文本 + 锚点事件 id + 幂等事件 id + turnId（写回/投递由调用方负责）。</summary>
public sealed record GeneratedReply(string Text, string AnchorEventId, string EventId, string TurnId);

public sealed class DialogEngine : IDialogEngine
{
    private const int MaxAttempts = 2;
    private static readonly TimeSpan RetryBaseDelay = TimeSpan.FromSeconds(1);

    private readonly EventStore _store;
    private readonly ModelClient _model;
    private readonly ILogger<DialogEngine> _logger;
    private readonly string? _systemPrompt;
    private readonly int _contextChars;

    public DialogEngine(
        EventStore store,
        ModelClient model,
        ILogger<DialogEngine> logger,
        string? systemPrompt,
        int contextChars)
    {
        _store = store;
        _model = model;
        _logger = logger;
        _systemPrompt = systemPrompt;
        _contextChars = contextChars;
    }

    public async Task<GeneratedReply?> GenerateAsync(string sessionId, CancellationToken cancellationToken = default)
    {
        var events = await LoadSessionAsync(sessionId, cancellationToken);
        if (events.Count == 0) return null;

        var branch = Replay(events);
        if (branch.Count == 0 || branch[^1].Role != "user") return null;
        var pending = branch[^1];
        if (string.IsNullOrWhiteSpace(pending.Text)) return null;

        var assistantEventId = "gen-" + Sha256Hex($"{sessionId}:{pending.AnchorEventId}")[..32];
        if (await _store.ContainsAsync(assistantEventId, cancellationToken)) return null;

        var context = branch.Select(item => new ModelClient.ChatMessage(item.Role, item.Text)).ToList();
        if (!string.IsNullOrEmpty(_systemPrompt))
        {
            context.Insert(0, new ModelClient.ChatMessage("system", _systemPrompt));
        }
        TrimContext(context);

        var completion = await CompleteWithRetryAsync(context, cancellationToken);
        if (completion is null || string.IsNullOrWhiteSpace(completion.Text)) return null;
        return new GeneratedReply(completion.Text, pending.AnchorEventId, assistantEventId, pending.TurnId);
    }

    private sealed record BranchMessage(string Role, string Text, string TurnId, string AnchorEventId);

    private async Task<List<SyncEventV0>> LoadSessionAsync(string sessionId, CancellationToken cancellationToken)
    {
        // TODO(Phase 2)：长会话窗口化重放——只加载最近 N 条事件即可构建上下文（水位/seq 已改 DB 聚合，窗口化安全）
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
        for (var attempt = 1; attempt <= MaxAttempts; attempt++)
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
            catch (HttpRequestException ex) when (ex.StatusCode is HttpStatusCode.Unauthorized
                or HttpStatusCode.Forbidden or HttpStatusCode.NotFound)
            {
                // 确定性配置错误（密钥/模型/地址）：重试无意义，等待人工修正
                _logger.LogError(ex, "模型配置不可用（不重试）status={Status} model={Model}",
                    (int?)ex.StatusCode, _model.ModelName);
                return null;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "模型调用失败（第 {Attempt}/{Max} 次）model={Model}",
                    attempt, MaxAttempts, _model.ModelName);
                if (attempt < MaxAttempts)
                {
                    await Task.Delay(RetryBaseDelay * attempt, cancellationToken);
                }
            }
        }
        return null;
    }

    /// <summary>按字符预算从最旧开始丢（保留 system prompt 与最后一条待回复 user）。</summary>
    private void TrimContext(List<ModelClient.ChatMessage> context)
    {
        // system prompt（若在头部）不可裁剪：只丢最旧的历史消息
        var startIndex = context.Count > 0 && context[0].Role == "system" ? 1 : 0;
        var total = context.Sum(item => item.Content.Length);
        var drop = startIndex;
        var maxDrop = context.Count - 1; // 至少保留最后一条待回复 user
        while (total > _contextChars && drop < maxDrop)
        {
            total -= context[drop].Content.Length;
            drop++;
        }
        if (drop > startIndex)
        {
            context.RemoveRange(startIndex, drop - startIndex);
        }
    }

    private static string Sha256Hex(string value) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();
}

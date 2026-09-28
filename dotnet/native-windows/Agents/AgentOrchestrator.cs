using System.Collections.Concurrent;
using System.IO;
using System.Text;
using System.Text.Json;

namespace CyreneNative.Agents;

/// <summary>
/// agent-orchestrator 协议操作名与帧名（跨语言契约）。
/// TS 侧对应 src/main/orchestrator/agent-orchestration/protocol.ts；
/// 契约测试（agent-orchestration-contract.test.ts）扫描本文件字面量锁定两侧一致。
/// </summary>
internal static class OrchestratorOps
{
    // Electron → host 请求
    public const string GroupCreate = "group.create";
    public const string GroupDestroy = "group.destroy";
    public const string GroupList = "group.list";
    public const string TurnStart = "turn.start";
    public const string TurnCancel = "turn.cancel";
    public const string MailboxList = "mailbox.list";
    public const string Shutdown = "shutdown";

    // host → Electron 帧
    public const string Ready = "ready";
    public const string Step = "step";
    public const string StepCancel = "step.cancel";
    public const string TurnResult = "turn.result";
    public const string Event = "event";
    public const string Log = "log";

    // Electron → host 通知帧
    public const string StepResult = "step_result";

    // 生命周期事件名（op="event" 的 name）
    public const string GroupRunning = "group.running";
    public const string GroupIdle = "group.idle";
}

/// <summary>机制上限（与 TS protocol.ts ORCHESTRATOR_LIMITS 同名同值）。</summary>
internal static class OrchestratorLimits
{
    public const int MaxGroups = 16;
    public const int MaxSessionsPerGroup = 8;
    public const int MailboxDepth = 128;
    /** 256 * 1024（写成字面量：跨语言契约测试按整数提取，不解析表达式）。 */
    public const int MaxMessageChars = 262144;
    public const int DefaultStepTimeoutMs = 600_000;
    public const int MaxQueuedTurnsPerGroup = 8;
}

/// <summary>
/// 多 Agent 编排宿主（cyrene-native --agent-orchestrator，Plan B）。
///
/// 切分原则（docs/design/2026-09-26-agent-orchestration-plan-b.md）：
/// - 本进程只做机制：组/会话生命周期、邮箱投递、pipeline 推进、取消、上限；
///   不做策略，也不碰模型与工具——每个 step 都是回传 Electron，
///   由 HarnessSessionWorker 复用 CyreneHarness 跑完整循环。
/// - 密钥/供应商适配/工具执行/权限审批永远留在 Electron 主进程。
///
/// 协议（stdio JSON 行；请求 id 应答 + 通知帧）：
///   → {"id":n,"op":"group.create","groupId","members":[...],"pipeline":[...]}
///   → {"id":n,"op":"turn.start","callId","groupId","message"}
///   → {"id":n,"op":"turn.cancel","callId"}
///   → {"id":n,"op":"group.list"} / {"id":n,"op":"mailbox.list","sessionId"}
///   → {"op":"step_result","stepId","callId","sessionId","ok","status",...}
///   ← {"op":"ready"}
///   ← {"op":"step","callId","stepId","sessionId","message","mailbox":[...],"config":{...}}
///   ← {"op":"step.cancel","callId","stepId","sessionId"}
///   ← {"op":"turn.result","callId","groupId","ok","status","finalAnswer","steps":[...]}
///   ← {"op":"event","name":"group.running|group.idle","groupId"}
///   ← {"op":"log","level","message"}
///
/// 语义不变量：
/// - 同一会话任意时刻至多一个在途 step（本宿主不会并发下发；worker 也会拒绝）；
/// - 同一 group 的 turn 串行：排队 FIFO，前一条终态后才启动下一条；
/// - 上游每一步的 finalAnswer 只经邮箱投递给下一步（不拼进 prompt 文本）；
/// - step 超时 = 下发 step.cancel + 立即以 timeout 收口；迟到 step_result 被忽略；
/// - group.destroy 取消在途与排队 turn，且不再启动排队项。
/// </summary>
internal sealed class AgentOrchestrator
{
    public enum MemberState { Idle, Stepping, Failed }
    public enum GroupState { Idle, Running }

    public sealed class MailboxMessage
    {
        public string? FromSessionId { get; init; }
        public required string Text { get; init; }
    }

    public sealed class Member
    {
        public required string SessionId { get; init; }
        public string? Role { get; init; }
        public string? SystemPrompt { get; init; }
        public string[]? ToolWhitelist { get; init; }
        public string? ConversationId { get; init; }
        public MemberState State { get; set; } = MemberState.Idle;
        public int StepCount { get; set; }
        public Queue<MailboxMessage> Mailbox { get; } = new();
    }

    public sealed class Group
    {
        public required string GroupId { get; init; }
        public required Dictionary<string, Member> Members { get; init; }
        public required string[] Pipeline { get; init; }
        public int StepTimeoutMs { get; init; } = OrchestratorLimits.DefaultStepTimeoutMs;
        public GroupState State { get; set; } = GroupState.Idle;
        public Queue<TurnRequest> QueuedTurns { get; } = new();
        public TurnRequest? ActiveTurn { get; set; }
        public string? ActiveTurnCallId => ActiveTurn?.CallId;
        public bool Destroyed { get; set; }
    }

    public sealed class TurnRequest
    {
        public required string CallId { get; init; }
        public required string Message { get; init; }
        public int StepIndex { get; set; }
        public List<object> Steps { get; } = new();
        public bool CancelRequested { get; set; }
        public string? CurrentStepId { get; set; }
        public string? CurrentSessionId { get; set; }
    }

    public sealed class PendingStep
    {
        public required string StepId { get; init; }
        public required TurnRequest Turn { get; init; }
        public required Member Member { get; init; }
        public required TaskCompletionSource<StepOutcome> Completion { get; init; }
        public CancellationTokenSource TimeoutCts { get; } = new();
    }

    public readonly record struct StepOutcome(bool Ok, string Status, string? FinalAnswer, string? Error);

    private readonly ConcurrentDictionary<string, Group> _groups = new();
    private readonly ConcurrentDictionary<string, PendingStep> _pendingSteps = new();
    /** callId → groupId（含排队中的 turn），用于 turn.cancel 定位。 */
    private readonly ConcurrentDictionary<string, string> _turnGroupIndex = new();
    private readonly object _gate = new();
    private readonly SemaphoreSlim _ioLock = new(1, 1);
    private readonly Stream _stdout;

    private AgentOrchestrator(Stream stdout)
    {
        _stdout = stdout;
    }

    // ── 进程入口（协议循环）────────────────────────────────────

    public static int RunProtocolLoop()
    {
        var stdout = Console.OpenStandardOutput();
        var host = new AgentOrchestrator(stdout);
        host.Send(new { op = OrchestratorOps.Ready });

        using var stdin = Console.OpenStandardInput();
        using var reader = new StreamReader(stdin, Encoding.UTF8);
        string? line;
        while ((line = reader.ReadLine()) is not null)
        {
            if (string.IsNullOrWhiteSpace(line)) continue;
            JsonElement root;
            try { root = JsonDocument.Parse(line).RootElement.Clone(); }
            catch { continue; }
            var op = OptionalString(root, "op");
            // 通知帧与请求帧分开：step_result 是 worker 对下发 step 的回注，不走 id 应答。
            if (op == OrchestratorOps.StepResult) { host.OnStepResult(root); continue; }
            if (op == OrchestratorOps.Shutdown) return 0;
            host.HandleRequest(root, op);
        }
        return 0;
    }

    private void HandleRequest(JsonElement root, string? op)
    {
        var id = root.TryGetProperty("id", out var idEl) && idEl.TryGetInt32(out var parsedId) ? parsedId : -1;
        try
        {
            object? data = op switch
            {
                OrchestratorOps.GroupCreate => CreateGroup(root),
                OrchestratorOps.GroupDestroy => DestroyGroup(root),
                OrchestratorOps.GroupList => ListGroups(),
                OrchestratorOps.TurnStart => StartTurn(root),
                OrchestratorOps.TurnCancel => CancelTurn(root),
                OrchestratorOps.MailboxList => ListMailbox(root),
                _ => throw new InvalidOperationException($"未知 op: {op}"),
            };
            if (id >= 0) Send(new { id, ok = true, data });
        }
        catch (Exception ex)
        {
            if (id >= 0) Send(new { id, ok = false, error = ex.Message });
            else Send(new { op = OrchestratorOps.Log, level = "error", message = ex.Message });
        }
    }

    // ── 组生命周期 ───────────────────────────────────────────

    private object CreateGroup(JsonElement root)
    {
        var groupId = RequiredString(root, "groupId");
        var pipeline = RequiredStringArray(root, "pipeline");
        if (pipeline.Length == 0) throw new InvalidOperationException("pipeline 不能为空");
        if (!root.TryGetProperty("members", out var membersRoot) || membersRoot.ValueKind != JsonValueKind.Array)
            throw new InvalidOperationException("缺少必填字段: members");

        var members = new Dictionary<string, Member>();
        foreach (var item in membersRoot.EnumerateArray())
        {
            var sessionId = RequiredString(item, "sessionId");
            if (members.ContainsKey(sessionId)) throw new InvalidOperationException($"成员重复: {sessionId}");
            members[sessionId] = new Member
            {
                SessionId = sessionId,
                Role = OptionalString(item, "role"),
                SystemPrompt = OptionalString(item, "systemPrompt"),
                ToolWhitelist = OptionalStringArray(item, "toolWhitelist"),
                ConversationId = OptionalString(item, "conversationId"),
            };
        }
        if (members.Count == 0) throw new InvalidOperationException("members 不能为空");
        if (members.Count > OrchestratorLimits.MaxSessionsPerGroup)
            throw new InvalidOperationException($"成员数超过上限 {OrchestratorLimits.MaxSessionsPerGroup}");
        foreach (var sessionId in pipeline)
        {
            if (!members.ContainsKey(sessionId)) throw new InvalidOperationException($"pipeline 含未知成员: {sessionId}");
        }

        var stepTimeoutMs = root.TryGetProperty("stepTimeoutMs", out var timeoutEl)
            && timeoutEl.TryGetInt32(out var timeout) && timeout > 0
            ? timeout
            : OrchestratorLimits.DefaultStepTimeoutMs;
        var group = new Group { GroupId = groupId, Members = members, Pipeline = pipeline, StepTimeoutMs = stepTimeoutMs };
        lock (_gate)
        {
            if (_groups.Count >= OrchestratorLimits.MaxGroups)
                throw new InvalidOperationException($"组数超过上限 {OrchestratorLimits.MaxGroups}");
            if (!_groups.TryAdd(groupId, group)) throw new InvalidOperationException($"group 已存在: {groupId}");
        }
        return new { groupId, sessions = members.Keys.ToArray(), pipeline, stepTimeoutMs };
    }

    private object DestroyGroup(JsonElement root)
    {
        var groupId = RequiredString(root, "groupId");
        Group group;
        List<TurnRequest> queued = new();
        lock (_gate)
        {
            if (!_groups.TryRemove(groupId, out group!)) throw new InvalidOperationException($"group 不存在: {groupId}");
            group.Destroyed = true;
            while (group.QueuedTurns.Count > 0) queued.Add(group.QueuedTurns.Dequeue());
        }

        // 排队中的 turn：从未启动，直接以 cancelled 收口。
        foreach (var turn in queued)
        {
            CompleteTurn(group, turn, "cancelled", null, "group 已销毁", startNext: false);
        }

        // 在途 turn：请求取消；其终态由 RunTurnAsync 统一收口（避免双重 turn.result）。
        if (group.ActiveTurn is { } active)
        {
            active.CancelRequested = true;
            if (active.CurrentStepId is { } stepId)
            {
                Send(new
                {
                    op = OrchestratorOps.StepCancel,
                    callId = active.CallId,
                    stepId,
                    sessionId = active.CurrentSessionId,
                });
                if (_pendingSteps.TryRemove(stepId, out var pending))
                {
                    pending.Completion.TrySetResult(new StepOutcome(false, "cancelled", null, "group 已销毁"));
                }
            }
        }
        return new { groupId };
    }

    private object ListGroups()
    {
        var groups = _groups.Values.Select(group =>
        {
            lock (_gate)
            {
                return new
                {
                    groupId = group.GroupId,
                    state = group.State == GroupState.Running ? "running" : "idle",
                    activeTurnCallId = group.ActiveTurnCallId,
                    queuedTurns = group.QueuedTurns.Count,
                    pipeline = group.Pipeline,
                    members = group.Members.Values.Select(member => new
                    {
                        sessionId = member.SessionId,
                        role = member.Role,
                        state = member.State.ToString().ToLowerInvariant(),
                        stepCount = member.StepCount,
                        mailboxDepth = member.Mailbox.Count,
                    }).ToArray(),
                };
            }
        }).ToArray();
        return new { groups };
    }

    private object ListMailbox(JsonElement root)
    {
        var sessionId = RequiredString(root, "sessionId");
        foreach (var group in _groups.Values)
        {
            if (!group.Members.TryGetValue(sessionId, out var member)) continue;
            lock (_gate)
            {
                return new
                {
                    sessionId,
                    groupId = group.GroupId,
                    items = member.Mailbox
                        .Select(item => new { fromSessionId = item.FromSessionId, text = item.Text })
                        .ToArray(),
                };
            }
        }
        throw new InvalidOperationException($"会话不存在: {sessionId}");
    }

    // ── turn 生命周期 ────────────────────────────────────────

    private object StartTurn(JsonElement root)
    {
        var callId = RequiredString(root, "callId");
        var groupId = RequiredString(root, "groupId");
        var message = RequiredString(root, "message");
        if (message.Length > OrchestratorLimits.MaxMessageChars)
            throw new InvalidOperationException($"消息超过上限 {OrchestratorLimits.MaxMessageChars} 字符");
        if (!_groups.TryGetValue(groupId, out var group)) throw new InvalidOperationException($"group 不存在: {groupId}");

        var turn = new TurnRequest { CallId = callId, Message = message };
        bool startNow;
        lock (_gate)
        {
            if (_turnGroupIndex.ContainsKey(callId)) throw new InvalidOperationException($"callId 重复: {callId}");
            if (group.QueuedTurns.Count >= OrchestratorLimits.MaxQueuedTurnsPerGroup)
                throw new InvalidOperationException($"排队 turn 超过上限 {OrchestratorLimits.MaxQueuedTurnsPerGroup}");
            _turnGroupIndex[callId] = groupId;
            if (group.State == GroupState.Idle)
            {
                group.State = GroupState.Running;
                startNow = true;
            }
            else
            {
                group.QueuedTurns.Enqueue(turn);
                startNow = false;
            }
        }
        if (startNow) StartTurn(group, turn, announce: true);
        return new { callId, groupId, queued = !startNow };
    }

    private void StartTurn(Group group, TurnRequest turn, bool announce)
    {
        group.ActiveTurn = turn;
        if (announce)
        {
            Send(new { op = OrchestratorOps.Event, name = OrchestratorOps.GroupRunning, groupId = group.GroupId, callId = turn.CallId });
        }
        _ = Task.Run(() => RunTurnAsync(group, turn));
    }

    /// <summary>pipeline 顺序推进；每步结果只在上游成功后经邮箱投递给下一步。</summary>
    private async Task RunTurnAsync(Group group, TurnRequest turn)
    {
        var status = "success";
        string? finalAnswer = null;
        string? error = null;
        try
        {
            while (true)
            {
                if (turn.CancelRequested)
                {
                    status = "cancelled";
                    error = "已取消";
                    break;
                }
                if (turn.StepIndex >= group.Pipeline.Length)
                {
                    status = "failed";
                    error = "pipeline 越界";
                    break;
                }

                var sessionId = group.Pipeline[turn.StepIndex];
                var member = group.Members[sessionId];
                List<MailboxMessage> mailbox;
                lock (_gate)
                {
                    mailbox = member.Mailbox.ToList();
                    member.Mailbox.Clear();
                    member.State = MemberState.Stepping;
                }

                var stepId = $"{turn.CallId}-s{turn.StepIndex + 1}";
                var outcome = await DispatchStepAsync(group, turn, member, sessionId, stepId, mailbox);
                lock (_gate)
                {
                    member.State = outcome.Ok ? MemberState.Idle : MemberState.Failed;
                    member.StepCount++;
                    turn.Steps.Add(new { sessionId, ok = outcome.Ok, status = outcome.Status, finalAnswer = outcome.FinalAnswer });
                }

                if (turn.CancelRequested || outcome.Status == "cancelled")
                {
                    status = "cancelled";
                    error = outcome.Error ?? "已取消";
                    break;
                }
                if (!outcome.Ok)
                {
                    status = outcome.Status == "timeout" ? "timeout" : "failed";
                    error = outcome.Error;
                    break;
                }

                turn.StepIndex++;
                if (turn.StepIndex >= group.Pipeline.Length)
                {
                    finalAnswer = outcome.FinalAnswer;
                    break;
                }

                var nextSessionId = group.Pipeline[turn.StepIndex];
                var overflow = false;
                lock (_gate)
                {
                    var next = group.Members[nextSessionId];
                    if (next.Mailbox.Count >= OrchestratorLimits.MailboxDepth) overflow = true;
                    else next.Mailbox.Enqueue(new MailboxMessage { FromSessionId = sessionId, Text = outcome.FinalAnswer ?? "" });
                }
                if (overflow)
                {
                    status = "failed";
                    error = $"邮箱溢出: {nextSessionId}";
                    break;
                }
            }
        }
        catch (Exception ex)
        {
            status = "failed";
            error = ex.Message;
        }

        CompleteTurn(group, turn, status, finalAnswer, error, startNext: !group.Destroyed);
    }

    private async Task<StepOutcome> DispatchStepAsync(
        Group group,
        TurnRequest turn,
        Member member,
        string sessionId,
        string stepId,
        List<MailboxMessage> mailbox)
    {
        var completion = new TaskCompletionSource<StepOutcome>(TaskCreationOptions.RunContinuationsAsynchronously);
        var pending = new PendingStep
        {
            StepId = stepId,
            Turn = turn,
            Member = member,
            Completion = completion,
        };
        _pendingSteps[stepId] = pending;
        lock (_gate)
        {
            turn.CurrentStepId = stepId;
            turn.CurrentSessionId = sessionId;
        }

        Send(new
        {
            op = OrchestratorOps.Step,
            callId = turn.CallId,
            stepId,
            groupId = group.GroupId,
            sessionId,
            index = turn.StepIndex,
            role = member.Role,
            message = turn.Message,
            mailbox = mailbox.Select(item => new { fromSessionId = item.FromSessionId, text = item.Text }).ToArray(),
            config = new
            {
                systemPrompt = member.SystemPrompt,
                toolWhitelist = member.ToolWhitelist,
                conversationId = member.ConversationId,
                stepTimeoutMs = group.StepTimeoutMs,
            },
        });

        var timeoutTask = Task.Delay(group.StepTimeoutMs, pending.TimeoutCts.Token);
        var finished = await Task.WhenAny(completion.Task, timeoutTask);
        if (ReferenceEquals(finished, timeoutTask) && !completion.Task.IsCompleted)
        {
            pending.TimeoutCts.Cancel();
            _pendingSteps.TryRemove(stepId, out _);
            Send(new { op = OrchestratorOps.StepCancel, callId = turn.CallId, stepId, sessionId });
            return new StepOutcome(false, "timeout", null, $"step 超时（{group.StepTimeoutMs}ms），已请求取消");
        }
        pending.TimeoutCts.Cancel();
        _pendingSteps.TryRemove(stepId, out _);
        return await completion.Task;
    }

    private void OnStepResult(JsonElement root)
    {
        var stepId = OptionalString(root, "stepId");
        if (stepId is null) return;
        // 超时/销毁后的迟到结果：pending 已摘除，直接忽略（at-most-once 语义）。
        if (!_pendingSteps.TryRemove(stepId, out var pending)) return;
        pending.TimeoutCts.Cancel();
        var ok = root.TryGetProperty("ok", out var okEl) && okEl.ValueKind == JsonValueKind.True;
        var status = OptionalString(root, "status") ?? (ok ? "success" : "failed");
        pending.Completion.TrySetResult(new StepOutcome(ok, status, OptionalString(root, "finalAnswer"), OptionalString(root, "error")));
    }

    private object CancelTurn(JsonElement root)
    {
        var callId = RequiredString(root, "callId");
        if (!_turnGroupIndex.TryGetValue(callId, out var groupId) || !_groups.TryGetValue(groupId, out var group))
            throw new InvalidOperationException($"turn 不存在: {callId}");

        if (group.ActiveTurn?.CallId != callId)
        {
            // 排队中：直接出队并以 cancelled 收口
            TurnRequest? removed = null;
            lock (_gate)
            {
                var kept = new List<TurnRequest>();
                while (group.QueuedTurns.Count > 0)
                {
                    var queued = group.QueuedTurns.Dequeue();
                    if (queued.CallId == callId) removed = queued;
                    else kept.Add(queued);
                }
                foreach (var item in kept) group.QueuedTurns.Enqueue(item);
            }
            if (removed is null) throw new InvalidOperationException($"turn 不存在: {callId}");
            CompleteTurn(group, removed, "cancelled", null, "排队中取消", startNext: false);
            return new { callId, cancelled = "queued" };
        }

        // 在途：标记 + 请求取消当前 step；终态由 RunTurnAsync 统一收口
        var active = group.ActiveTurn;
        active.CancelRequested = true;
        if (active.CurrentStepId is { } stepId)
        {
            Send(new { op = OrchestratorOps.StepCancel, callId, stepId, sessionId = active.CurrentSessionId });
        }
        return new { callId, cancelled = "requested" };
    }

    /// <summary>turn 终态唯一出口：注销 callId → 回 turn.result → 启动排队项或回到 idle。</summary>
    private void CompleteTurn(Group group, TurnRequest turn, string status, string? finalAnswer, string? error, bool startNext)
    {
        TurnRequest? next = null;
        lock (_gate)
        {
            _turnGroupIndex.TryRemove(turn.CallId, out _);
            if (group.ActiveTurn?.CallId == turn.CallId) group.ActiveTurn = null;
            if (startNext && group.QueuedTurns.Count > 0) next = group.QueuedTurns.Dequeue();
            if (next is null) group.State = GroupState.Idle;
        }

        Send(new
        {
            op = OrchestratorOps.TurnResult,
            callId = turn.CallId,
            groupId = group.GroupId,
            ok = status == "success",
            status,
            finalAnswer,
            error,
            steps = turn.Steps.ToArray(),
        });

        if (next is not null) StartTurn(group, next, announce: false);
        else if (!group.Destroyed)
        {
            Send(new { op = OrchestratorOps.Event, name = OrchestratorOps.GroupIdle, groupId = group.GroupId });
        }
    }

    // ── 基础设施 ─────────────────────────────────────────────

    private void Send(object frame)
    {
        try
        {
            var bytes = JsonSerializer.SerializeToUtf8Bytes(frame, JsonOptions);
            _ioLock.Wait();
            try
            {
                _stdout.Write(bytes, 0, bytes.Length);
                _stdout.WriteByte((byte)'\n');
                _stdout.Flush();
            }
            finally { _ioLock.Release(); }
        }
        catch
        {
            // stdout 关闭：宿主已退出，进程即将自然结束
        }
    }

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    private static string RequiredString(JsonElement element, string name)
    {
        if (!element.TryGetProperty(name, out var value) || value.ValueKind != JsonValueKind.String || string.IsNullOrEmpty(value.GetString()))
            throw new InvalidOperationException($"缺少必填字段: {name}");
        return value.GetString()!;
    }

    private static string? OptionalString(JsonElement element, string name)
        => element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;

    private static string[] RequiredStringArray(JsonElement element, string name)
    {
        if (!element.TryGetProperty(name, out var value) || value.ValueKind != JsonValueKind.Array)
            throw new InvalidOperationException($"缺少必填字段: {name}");
        return value.EnumerateArray().Select(item => item.GetString() ?? "").Where(text => text.Length > 0).ToArray();
    }

    private static string[]? OptionalStringArray(JsonElement element, string name)
    {
        if (!element.TryGetProperty(name, out var value) || value.ValueKind != JsonValueKind.Array) return null;
        return value.EnumerateArray().Select(item => item.GetString() ?? "").Where(text => text.Length > 0).ToArray();
    }
}

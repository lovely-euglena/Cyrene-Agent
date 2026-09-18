using System.Collections.Concurrent;
using System.IO;
using System.Text;
using System.Text.Json;

namespace CyreneNative.Agents;

using CyreneNative.Tools;

/// <summary>
/// 多 Agent 会话宿主骨架（cyrene-native --agent-host）。
///
/// 底层架构（v1 骨架，LLM 回调闭环后续接）：
///
///   Electron（API keys/流式 UI/权限审批）
///        ↕ agent-host 协议（stdio JSON 行）
///   ┌─ AgentSessionHost ─────────────────────────┐
///   │  session "s1"  session "s2"  session "s3"  │  ← 会话级隔离
///   │   ├ state      ├ state        ├ state       │    （独立上下文/工具白名单）
///   │   ├ inbox      ├ inbox        ├ inbox      │
///   │   └ step loop  └ step loop    └ step loop  │
///   └────────────────────────────────────────────┘
///
/// 关键设计：LLM 推理不在本进程——step 产生 llm_request 帧回传 Electron
/// （模型密钥/供应商适配/流式渲染留在主进程），应答经 llm_response 回注，
/// host 只负责会话生命周期、状态机、上下文管理与多 Agent 编排。
/// 这样密钥永不落 .NET 进程，权限审批闸门保持在 Electron 侧。
///
/// 协议：
///   → {"op":"create","sessionId":"s1","config":{...}}
///   → {"op":"destroy","sessionId":"s1"}
///   → {"op":"step","callId":"c1","sessionId":"s1","message":"..."}
///   → {"op":"llm_response","callId":"c1","content":"..."}   ← Electron 回注
///   → {"op":"list"}
///   → {"op":"shutdown"}
///   ← {"op":"ready"}
///   ← {"op":"sessions","sessions":[...]}
///   ← {"op":"llm_request","callId":"c1","sessionId":"s1","messages":[...],"meta":{...}}
///   ← {"op":"result","callId":"c1","ok":true,"data":{...}}
///   ← {"op":"event","sessionId":"s1","type":"state_changed",...}
/// </summary>
internal sealed class AgentSessionHost
{
    public enum SessionState { Idle, Thinking, WaitingLlm, WaitingTool, Done, Failed }

    public sealed class Session
    {
        public required string Id { get; init; }
        public required JsonElement Config { get; init; }
        public SessionState State { get; set; } = SessionState.Idle;
        public List<object> History { get; } = [];
        public DateTimeOffset CreatedAt { get; } = DateTimeOffset.UtcNow;
        public int TurnCount { get; set; }
    }

    private readonly ConcurrentDictionary<string, Session> _sessions = new();

    public int Count => _sessions.Count;

    public Session Create(string sessionId, JsonElement config)
    {
        if (_sessions.ContainsKey(sessionId))
            throw new InvalidOperationException($"会话已存在: {sessionId}");
        var s = new Session { Id = sessionId, Config = config.Clone() };
        _sessions[sessionId] = s;
        return s;
    }

    public bool Destroy(string sessionId) => _sessions.TryRemove(sessionId, out _);

    public Session? Get(string sessionId) => _sessions.TryGetValue(sessionId, out var s) ? s : null;

    public IReadOnlyCollection<Session> List() => _sessions.Values.ToArray();

    /// <summary>单会话最大轮数（防失控循环——无终止条件时的硬闸）。</summary>
    public const int MaxTurns = 64;

    /// <summary>
    /// 单步推进（P1 闭环版）：用户消息 → WaitingLlm → llm_request。
    /// llm_response 回注后：若 content 含 tool_calls 字段则追加 assistant
    /// 消息并再次发 llm_request（多轮工具闭环，工具实际执行在 Electron
    /// 审批后经 tool_result 帧回注）；纯文本则落史返回 idle。
    /// 终止判定：turn 上限 / content.done=true / 纯文本。
    /// </summary>
    public (object llmRequest, Func<JsonElement, string> onAssistant) BeginStep(string sessionId, string message)
    {
        var s = Get(sessionId) ?? throw new InvalidOperationException($"会话不存在: {sessionId}");
        if (s.State == SessionState.Thinking) throw new InvalidOperationException($"会话 {sessionId} 正在推进中");
        s.TurnCount++;
        if (s.TurnCount > MaxTurns) throw new InvalidOperationException($"会话 {sessionId} 超过最大轮数 {MaxTurns}");
        s.State = SessionState.WaitingLlm;
        s.History.Add(new { role = "user", content = message });
        return (BuildLlmRequest(s), MakeContinuation(s));
    }

    /// <summary>回注 tool_result（工具已执行）后继续下一轮 llm_request。</summary>
    public (object llmRequest, Func<JsonElement, string> onAssistant) ContinueWithToolResult(string sessionId, JsonElement toolResult)
    {
        var s = Get(sessionId) ?? throw new InvalidOperationException($"会话不存在: {sessionId}");
        if (s.State != SessionState.WaitingTool) throw new InvalidOperationException($"会话 {sessionId} 不在等工具结果状态");
        s.TurnCount++;
        if (s.TurnCount > MaxTurns)
        {
            s.State = SessionState.Failed;
            throw new InvalidOperationException($"会话 {sessionId} 超过最大轮数 {MaxTurns}");
        }
        s.History.Add(new { role = "tool", content = toolResult.Clone() });
        s.State = SessionState.WaitingLlm;
        return (BuildLlmRequest(s), MakeContinuation(s));
    }

    public void MarkFailed(string sessionId, string reason)
    {
        if (Get(sessionId) is { } s)
        {
            s.State = SessionState.Failed;
            s.History.Add(new { role = "system", content = $"[error] {reason}" });
        }
    }

    private static object BuildLlmRequest(Session s) => new
    {
        sessionId = s.Id,
        turn = s.TurnCount,
        messages = s.History,
        config = s.Config,
    };

    /// <summary>构造 llm_response 的续跑闭包：tool_calls→工具环；纯文本→idle。</summary>
    private Func<JsonElement, string> MakeContinuation(Session s) => (content) =>
    {
        // content 形状（Electron 回注）：
        //   纯文本：{"text": "..."}
        //   带工具：{"text": "...", "toolCalls": [{"id","name","arguments"}]}
        string? text = content.ValueKind == JsonValueKind.Object && content.TryGetProperty("text", out var t)
            ? t.GetString() : null;
        var hasToolCalls = content.ValueKind == JsonValueKind.Object
            && content.TryGetProperty("toolCalls", out var tc)
            && tc.ValueKind == JsonValueKind.Array
            && tc.GetArrayLength() > 0;
        if (hasToolCalls)
        {
            s.History.Add(new { role = "assistant", content = content.Clone() });
            s.State = SessionState.WaitingTool;
            return "waiting_tool";   // Electron 执行工具后 tool_result 回注继续
        }
        s.History.Add(new { role = "assistant", content = text ?? "" });
        s.State = SessionState.Done;
        return "done";
    };

    // ── 进程入口（协议循环）──

    public static int RunProtocolLoop()
    {
        var stdout = Console.OpenStandardOutput();
        var ioLock = new SemaphoreSlim(1, 1);
        var host = new AgentSessionHost();
        var pending = new ConcurrentDictionary<string, Func<JsonElement, string>>();

        void Send(object frame) => ToolHost.WriteFrame(stdout, ioLock, frame);
        Send(new { op = "ready" });

        using var stdin = Console.OpenStandardInput();
        using var reader = new StreamReader(stdin, Encoding.UTF8);
        string? line;
        while ((line = reader.ReadLine()) is not null)
        {
            if (string.IsNullOrWhiteSpace(line)) continue;
            JsonElement root;
            try { root = JsonDocument.Parse(line).RootElement.Clone(); }
            catch { continue; }
            var op = root.TryGetProperty("op", out var o) ? o.GetString() : null;
            try
            {
                switch (op)
                {
                    case "create":
                    {
                        var id = root.GetProperty("sessionId").GetString()!;
                        var cfg = root.TryGetProperty("config", out var c) ? c.Clone() : JsonDocument.Parse("{}").RootElement;
                        host.Create(id, cfg);
                        Send(new { op = "event", sessionId = id, type = "created" });
                        break;
                    }
                    case "destroy":
                    {
                        var id = root.GetProperty("sessionId").GetString()!;
                        if (host.Destroy(id)) Send(new { op = "event", sessionId = id, type = "destroyed" });
                        break;
                    }
                    case "list":
                        Send(new
                        {
                            op = "sessions",
                            sessions = host.List().Select(s => new
                            {
                                id = s.Id,
                                state = s.State.ToString().ToLowerInvariant(),
                                turns = s.TurnCount,
                                createdAt = s.CreatedAt,
                            }),
                        });
                        break;
                    case "step":
                    {
                        var callId = root.GetProperty("callId").GetString()!;
                        var id = root.GetProperty("sessionId").GetString()!;
                        var message = root.TryGetProperty("message", out var m) ? m.GetString() : "";
                        var (req, onAssistant) = host.BeginStep(id, message ?? "");
                        pending[callId] = onAssistant;
                        Send(new { op = "llm_request", callId, session = req });
                        break;
                    }
                    case "llm_response":
                    {
                        var callId = root.GetProperty("callId").GetString()!;
                        if (pending.TryRemove(callId, out var onComplete))
                        {
                            var ok = root.TryGetProperty("ok", out var okEl) && (okEl.ValueKind != JsonValueKind.False && okEl.ValueKind != JsonValueKind.Number || (okEl.ValueKind == JsonValueKind.Number && okEl.GetDouble() != 0));
                            if (ok && root.TryGetProperty("content", out var content))
                            {
                                var outcome = onComplete(content);
                                if (outcome == "waiting_tool")
                                {
                                    // 会话进入 WaitingTool：result 换成 tool_request，
                                    // Electron 执行（含审批）后 tool_result 帧回注继续
                                    var sid = root.TryGetProperty("sessionId", out var sidEl) ? sidEl.GetString() : null;
                                    var sess = sid is null ? null : host.Get(sid);
                                    var lastEntry = sess?.History.Count > 0 ? sess.History[^1] : null;
                                    Send(new
                                    {
                                        op = "tool_request",
                                        callId,
                                        sessionId = sid,
                                        assistantMessage = lastEntry,
                                    });
                                }
                                else
                                {
                                    Send(new { op = "result", callId, ok = true, data = new { state = outcome } });
                                }
                            }
                            else
                            {
                                var err = root.TryGetProperty("error", out var e) ? e.GetString() : "llm 失败";
                                var sid = root.TryGetProperty("sessionId", out var sidEl) ? sidEl.GetString() : null;
                                if (sid is not null) host.MarkFailed(sid, err ?? "llm 失败");
                                Send(new { op = "result", callId, ok = false, error = err });
                            }
                        }
                        break;
                    }
                    case "tool_result":
                    {
                        // Electron 完成工具执行（含审批）后回注结果，续跑会话
                        var callId = root.GetProperty("callId").GetString()!;
                        var sid = root.GetProperty("sessionId").GetString()!;
                        var result = root.GetProperty("result");
                        if (pending.TryRemove(callId, out _))
                        {
                            var (req, onAssistant) = host.ContinueWithToolResult(sid, result);
                            // 续跑复用同一 callId：下一轮 llm_response/tool_request 都对它
                            pending[callId] = onAssistant;
                            Send(new { op = "llm_request", callId, session = req });
                        }
                        else
                        {
                            Send(new { op = "result", callId, ok = false, error = "tool_result 对应的调用不存在或已完成" });
                        }
                        break;
                    }
                    case "shutdown":
                        return 0;
                }
            }
            catch (Exception ex)
            {
                Send(new { op = "log", level = "error", message = ex.Message });
            }
        }
        return 0;
    }
}

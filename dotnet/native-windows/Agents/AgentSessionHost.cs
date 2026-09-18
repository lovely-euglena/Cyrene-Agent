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
    public enum SessionState { Idle, Thinking, WaitingLlm, Done, Failed }

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

    /// <summary>
    /// 单步推进：骨架版只做状态机切换（Idle→WaitingLlm）+ 历史 append +
    /// 产生 llm_request 载荷。完整 loop（工具调用/终止判定/多轮）在
    /// llm_response 回注后由 ContinueSession 实现（后续提交）。
    /// </summary>
    public (object llmRequest, Action<JsonElement> onComplete) BeginStep(string sessionId, string message)
    {
        var s = Get(sessionId) ?? throw new InvalidOperationException($"会话不存在: {sessionId}");
        s.State = SessionState.WaitingLlm;
        s.TurnCount++;
        s.History.Add(new { role = "user", content = message });
        var request = new
        {
            sessionId,
            turn = s.TurnCount,
            messages = s.History,
            config = s.Config,
        };
        Action<JsonElement> onComplete = (content) =>
        {
            s.History.Add(new { role = "assistant", content = content.Clone() });
            s.State = SessionState.Idle;
        };
        return (request, onComplete);
    }

    // ── 进程入口（协议循环）──

    public static int RunProtocolLoop()
    {
        var stdout = Console.OpenStandardOutput();
        var ioLock = new SemaphoreSlim(1, 1);
        var host = new AgentSessionHost();
        var pending = new ConcurrentDictionary<string, Action<JsonElement>>();

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
                        var (req, onComplete) = host.BeginStep(id, message ?? "");
                        pending[callId] = onComplete;
                        Send(new { op = "llm_request", callId, session = req });
                        break;
                    }
                    case "llm_response":
                    {
                        var callId = root.GetProperty("callId").GetString()!;
                        if (pending.TryRemove(callId, out var onComplete))
                        {
                            onComplete(root.GetProperty("content"));
                            Send(new { op = "result", callId, ok = true, data = new { state = "idle" } });
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

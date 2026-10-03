using System.IO;
using System.Text;
using System.Text.Json;

namespace CyreneNative.LoopHostNs;

/// <summary>
/// 对话循环宿主（--loop-host，阶段 8 K——骨架）。
///
/// K 阶段铁律：这是全链路风险最高的一步（🔴），P0 骨架只做状态机与
/// 帧协议形状，不上生产；逐 token 一致性（K4）必须在 Windows 实机
/// 冒烟通过后才允许 CYRENE_LOOP_HOST=1 生效。
///
/// 状态机（对齐 TS chat-loop.ts 的轮次结构）：
///   Idle → Preparing（组装上下文）→ Streaming（llm_request 回调，
///   delta 逐帧转发）→ ToolPhase（tool_request/approval/tool_result）
///   → Streaming… → Terminal（终止判定：finish_reason / 轮上限 /
///   用户 abort）→ Idle
///
/// 协议（stdio JSON 行）：
///   → {"op":"start","callId","sessionId","messages":[...],"tools":[ids]}
///   → {"op":"llm_response","callId","content":{"text","toolCalls"}}
///   → {"op":"tool_result","callId","results":[{id,output}]}
///   → {"op":"abort","callId"} / {"op":"shutdown"}
///   ← {"op":"llm_request","callId","messages":[...],"tools":[ids],"stream":true}
///   ← {"op":"delta","callId","text":"…"}（llm_request 附 streaming: true 时，
///     Electron 把 SSE delta 原样按帧转发——逐 token 透传 K4 的基础）
///   ← {"op":"tool_request","callId","calls":[{id,name,arguments}]}
///   ← {"op":"finished","callId","finishReason"}
/// 密钥/SSE 解析/审批全留 Electron（K3；B1/B2 铁律）。
/// </summary>
internal sealed class LoopHost
{
    private enum LoopState { Idle, Preparing, Streaming, ToolPhase, Terminal }

    private const int MaxRounds = 32;

    private sealed class Session
    {
        public LoopState State = LoopState.Idle;
        public int Rounds;
        public List<object> Messages = [];
    }

    private readonly Dictionary<string, Session> _sessions = new();

    public object Start(string callId, JsonElement messages, JsonElement? toolIds)
    {
        var s = new Session();
        _sessions[callId] = s;
        s.State = LoopState.Preparing;
        foreach (var m in messages.EnumerateArray()) s.Messages.Add(m.Clone());
        s.State = LoopState.Streaming;
        return BuildLlmRequest(callId, s, toolIds);
    }

    private static object BuildLlmRequest(string callId, Session s, JsonElement? toolIds) => new
    {
        op = "llm_request",
        callId,
        messages = s.Messages,
        tools = toolIds,
        stream = true,
        round = s.Rounds,
    };

    /// <summary>llm_response 回注：纯文本→finished；toolCalls→tool_request。</summary>
    public object OnLlmResponse(string callId, JsonElement content)
    {
        if (!_sessions.TryGetValue(callId, out var s)) throw new InvalidOperationException($"循环不存在: {callId}");
        if (s.State != LoopState.Streaming) throw new InvalidOperationException($"状态非 Streaming: {s.State}");
        var hasToolCalls = content.TryGetProperty("toolCalls", out var tc)
            && tc.ValueKind == JsonValueKind.Array && tc.GetArrayLength() > 0;
        s.Rounds++;
        if (hasToolCalls)
        {
            if (s.Rounds >= MaxRounds) return Finish(callId, s, "max_rounds");
            s.Messages.Add(new { role = "assistant", content = content.Clone() });
            s.State = LoopState.ToolPhase;
            return new { op = "tool_request", callId, calls = tc.Clone() };
        }
        s.Messages.Add(new { role = "assistant", content = content.TryGetProperty("text", out var t) ? t.Clone() : (object)"" });
        return Finish(callId, s, "stop");
    }

    public object OnToolResult(string callId, JsonElement results)
    {
        if (!_sessions.TryGetValue(callId, out var s)) throw new InvalidOperationException($"循环不存在: {callId}");
        if (s.State != LoopState.ToolPhase) throw new InvalidOperationException($"状态非 ToolPhase: {s.State}");
        s.Messages.Add(new { role = "tool", content = results.Clone() });
        s.State = LoopState.Streaming;
        return BuildLlmRequest(callId, s, null);
    }

    public object Abort(string callId)
    {
        if (_sessions.TryGetValue(callId, out var s)) return Finish(callId, s, "aborted");
        return new { op = "finished", callId, finishReason = "unknown" };
    }

    private object Finish(string callId, Session s, string reason)
    {
        s.State = LoopState.Terminal;
        _sessions.Remove(callId);
        return new { op = "finished", callId, finishReason = reason };
    }

    public static int RunProtocolLoop()
    {
        var host = new LoopHost();
        var stdout = Console.OpenStandardOutput();
        var ioLock = new SemaphoreSlim(1, 1);
        void Send(object frame) => Tools.ToolHost.WriteFrame(stdout, ioLock, frame);
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
            var callId = root.TryGetProperty("callId", out var c) ? c.GetString() ?? "" : "";
            try
            {
                switch (op)
                {
                    case "start":
                        Send(host.Start(callId, root.GetProperty("messages"),
                            root.TryGetProperty("tools", out var tools) && tools.ValueKind == JsonValueKind.Array ? tools.Clone() : null));
                        break;
                    case "llm_response":
                        Send(host.OnLlmResponse(callId, root.GetProperty("content")));
                        break;
                    case "tool_result":
                        Send(host.OnToolResult(callId, root.GetProperty("results")));
                        break;
                    case "abort":
                        Send(host.Abort(callId));
                        break;
                    case "shutdown":
                        return 0;
                }
            }
            catch (Exception ex)
            {
                Send(new { op = "finished", callId, finishReason = "error", error = ex.Message, errorCode = "E_LOOP" });
            }
        }
        return 0;
    }
}

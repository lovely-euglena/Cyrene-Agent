using System.Collections.Concurrent;
using System.Text.Json;

namespace CyreneNative.Agents;

/// <summary>
/// 多 Agent 编排（阶段 7 J）：Mailbox + 白名单 + Sequential/Supervisor。
///
/// J3 工具白名单：会话 create 时声明 allowedTools；ExecuteTool 前强制
/// 校验，白名单外直接拒（越权保护）——这是安全边界，不是提示词约束。
/// J4 编排：orchestrate 协议两种模式——
///   sequential：主 session 产出任务 → 依序派给 worker → 汇总
///   supervisor：supervisor 常驻，worker 结果回 mailbox，supervisor
///               消费并决定下一步（派工/终止）
/// J5 orchestrate 帧在 AgentSessionHost 主协议上叠加：
///   → {"op":"orchestrate","callId","mode":"sequential|supervisor",
///      "plan":"<任务描述>","workers":[{"id","role","systemPrompt",
///      "allowedTools":[...]}],"maxSteps":N}
///   ← {"op":"orch_progress","callId","step":N,"total":M,"detail":"..."}
///   ← {"op":"llm_request","callId","sessionId",...}（各 session 的推理
///     请求——Electron 统一代理，带 session 角色标签）
///   ← {"op":"result","callId","ok":true,"data":{"final":"...","steps":[...]}}
/// 铁律 B1/B2 继承：所有 LLM 走回调，工具执行回 Electron 审批。
/// </summary>
internal sealed class Orchestrator
{
    // ── J2 Mailbox：会话间消息投递（单 host 内直投；跨进程留接口） ──
    internal sealed class Mailbox
    {
        private readonly ConcurrentDictionary<string, ConcurrentQueue<JsonElement>> _boxes = new();

        public void Post(string sessionId, JsonElement message)
            => _boxes.GetOrAdd(sessionId, _ => new ConcurrentQueue<JsonElement>()).Enqueue(message);

        public List<JsonElement> Drain(string sessionId)
        {
            var outbox = new List<JsonElement>();
            if (_boxes.TryGetValue(sessionId, out var q))
                while (q.TryDequeue(out var m)) outbox.Add(m);
            return outbox;
        }
    }

    internal sealed record WorkerSpec(string Id, string Role, string? SystemPrompt, List<string> AllowedTools);

    internal sealed class Orchestration
    {
        public required string CallId;
        public required string Mode;
        public required string Plan;
        public required List<WorkerSpec> Workers;
        public int MaxSteps = 16;
        public int Step;
        public List<object> Trace = new();
    }

    public Mailbox Boxes { get; } = new();
    private readonly ConcurrentDictionary<string, Orchestration> _runs = new();
    private readonly AgentSessionHost _host;

    public Orchestrator(AgentSessionHost host) => _host = host;

    /// <summary>orchestrate 入口：建齐 sessions，产出第一步的 llm_request。</summary>
    public object Start(string callId, JsonElement root)
    {
        var mode = root.GetProperty("mode").GetString() ?? "sequential";
        var plan = root.GetProperty("plan").GetString() ?? "";
        var maxSteps = root.TryGetProperty("maxSteps", out var ms) && ms.ValueKind == JsonValueKind.Number
            ? ms.GetInt32() : 16;
        var workers = new List<WorkerSpec>();
        if (root.TryGetProperty("workers", out var ws) && ws.ValueKind == JsonValueKind.Array)
        {
            foreach (var w in ws.EnumerateArray())
            {
                workers.Add(new WorkerSpec(
                    w.GetProperty("id").GetString() ?? Guid.NewGuid().ToString(),
                    w.GetProperty("role").GetString() ?? "worker",
                    w.TryGetProperty("systemPrompt", out var sp) ? sp.GetString() : null,
                    w.TryGetProperty("allowedTools", out var at) && at.ValueKind == JsonValueKind.Array
                        ? at.EnumerateArray().Select(x => x.GetString() ?? "").Where(x => x.Length > 0).ToList()
                        : []));
            }
        }
        var run = new Orchestration { CallId = callId, Mode = mode, Plan = plan, Workers = workers, MaxSteps = maxSteps };
        _runs[callId] = run;

        // sequential：planner = 第一个 worker（或隐式 planner 角色）先拿到 plan
        // supervisor：workers[0] 为 supervisor，其余为 executor
        var first = mode == "supervisor" && workers.Count > 0 ? workers[0] : workers.FirstOrDefault();
        if (first is null) throw new InvalidOperationException("orchestrate 需要至少一个 worker");
        foreach (var w in workers)
        {
            _host.Create($"{callId}:{w.Id}", JsonDocument.Parse(
                $$"""{"role":"{{w.Role}}","allowedTools":{{JsonSerializer.Serialize(w.AllowedTools)}},"orchestration":"{{callId}}"}""").RootElement);
        }
        var firstPrompt = first.Role == "supervisor"
            ? $"你是编排主管。任务：{plan}\n请拆解并指定下一步（回复 JSON：{{\"task\":\"...\",\"worker\":\"id\"}} 或 {{\"final\":\"...\"}}）"
            : $"任务：{plan}\n请执行并输出结果。";
        var (req, _) = _host.BeginStep($"{callId}:{first.Id}", firstPrompt);
        run.Step = 1;
        return new { op = "llm_request", callId, sessionId = $"{callId}:{first.Id}", orchestration = new { mode, step = 1, maxSteps }, session = req };
    }

    /// <summary>orchestrate 会话的 llm_response 回注：推进状态机。</summary>
    public object OnLlmResponse(string callId, string sessionId, JsonElement content)
    {
        if (!_runs.TryGetValue(callId, out var run)) throw new InvalidOperationException("编排不存在");
        if (++run.Step > run.MaxSteps)
        {
            _runs.TryRemove(callId, out _);
            return new { op = "result", callId, ok = true, data = new { final = "(达到步数上限)", steps = run.Trace } };
        }
        run.Trace.Add(new { step = run.Step - 1, sessionId, content });

        // supervisor 模式：supervisor 输出 {"task","worker"} → 派工；{"final"} → 终止
        if (run.Mode == "supervisor" && sessionId.EndsWith(":s0") == false && run.Workers.Count > 0)
        {
            var text = content.TryGetProperty("text", out var t) ? t.GetString() : null;
            if (text is not null && text.Contains("\"final\""))
            {
                _runs.TryRemove(callId, out _);
                return new { op = "result", callId, ok = true, data = new { final = text, steps = run.Trace } };
            }
        }
        // 通用：把该步输出投给下一 worker（sequential 依序；supervisor 回 supervisor）
        var idx = Array.FindIndex(run.Workers.ToArray(), w => sessionId == $"{callId}:{w.Id}");
        WorkerSpec? next = run.Mode == "sequential"
            ? run.Workers.ElementAtOrDefault(idx + 1)
            : run.Workers.FirstOrDefault(); // supervisor 循环
        if (next is null)
        {
            _runs.TryRemove(callId, out _);
            return new { op = "result", callId, ok = true, data = new { final = "顺序编排完成", steps = run.Trace } };
        }
        var ctx = content.TryGetProperty("text", out var tt) ? tt.GetString() : "";
        var (req, _) = _host.BeginStep($"{callId}:{next.Id}",
            $"上一步输出：\n{ctx}\n\n请继续。");
        Boxes.Post($"{callId}:{next.Id}", content);
        return new { op = "llm_request", callId, sessionId = $"{callId}:{next.Id}", orchestration = new { mode = run.Mode, step = run.Step, maxSteps = run.MaxSteps }, session = req };
    }

    /// <summary>J3 白名单强制校验：宿主在转发 tool_request 前必查。</summary>
    public static bool ToolAllowed(AgentSessionHost host, string sessionId, string toolId)
    {
        var s = host.Get(sessionId);
        var allowed = s?.Config.TryGetProperty("allowedTools", out var at) == true
            && at.ValueKind == JsonValueKind.Array
            ? at.EnumerateArray().Select(x => x.GetString() ?? "").ToHashSet()
            : null;
        if (allowed is null || allowed.Count == 0) return false; // 未声明=拒绝（closed）
        return allowed.Contains(toolId) || allowed.Contains("*");
    }
}

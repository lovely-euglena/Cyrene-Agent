using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using CyreneNative.Llm;
using CyreneNative.Secrets;

namespace CyreneSmoke;

/// <summary>
/// llm 作业库自测（H1）：lane 隔离 / 事件序 / 长轮询幂等 / cursor 补读 / low 满载拒绝。
/// 纯内存逻辑（无网络）——Linux CI 可跑。
/// </summary>
public static class LlmJobsSelfTest
{
    private static int _failures;

    private static void Check(bool ok, string name)
    {
        if (!ok) { _failures++; Console.WriteLine($"[FAIL] {name}"); }
        else Console.WriteLine($"[PASS] {name}");
    }

    private sealed class TestSecrets : ISecretProvider
    {
        public bool IsAvailable => true;
        public string? Get(string name) => name == "k" ? "sk-test" : null;
        public void Put(string name, string value) { }
        public bool Delete(string name) => true;
        public IReadOnlyList<SecretEntryInfo> List() => Array.Empty<SecretEntryInfo>();
    }

    private static LlmJob MakeJob(string lane, string body = "{}") => new(
        lane, "http://127.0.0.1:1/noop", "POST", body,
        authVaultKey: null, authStyle: "bearer",
        headers: new Dictionary<string, string>(), protocol: "openai",
        timeoutMs: 10_000, maxRetries: 0, idleTimeoutMs: 5_000);

    public static int Run()
    {
        // ── 1. low 满载拒绝（>32 排队）──
        using (var service = new LlmJobService(new TestSecrets()))
        {
            var rejected = false;
            for (var i = 0; i < LlmJobStore.LowQueueCap + 5; i++)
            {
                // 紧密循环连投：pump 出队需线程调度，赶不上入队节奏 → 超出 32 容量必拒绝
                var j = MakeJob(LlmContracts.LaneLow);
                if (service.Store.Submit(j) == null) { rejected = true; break; }
            }
            Check(rejected, "low 满载 Submit 返回 null");
        }

        // ── 2. 事件序 + cursor 补读 + 幂等（直接操纵 job）──
        var job = MakeJob(LlmContracts.LaneInteractive);
        job.Append(new LlmEvent { Type = LlmContracts.EvDelta, Text = "你" });
        job.Append(new LlmEvent { Type = LlmContracts.EvDelta, Text = "好" });
        job.Append(new LlmEvent { Type = LlmContracts.EvDone });
        Check(job.EventCount == 3, "事件计数");

        var batch1 = job.Poll(0, 2, 0);
        Check(batch1.Count == 2 && batch1[0].Text == "你" && batch1[1].Text == "好", "cursor=0 前 2 条");
        var batch1again = job.Poll(0, 2, 0);
        Check(batch1again.Count == 2 && batch1again[0].Text == "你", "cursor 幂等（重复 poll 不丢不重）");
        var batch2 = job.Poll(2, 2, 0);
        Check(batch2.Count == 1 && batch2[0].Type == LlmContracts.EvDone, "断点续读补齐");
        var batchEmpty = job.Poll(3, 2, 20);
        Check(batchEmpty.Count == 0, "cursor 到底返回空");

        // ── 3. lane 并发槽位数 ──
        Check(LlmJobStore.LaneSlotOf(LlmContracts.LaneInteractive) == 4, "interactive=4 并发");
        Check(LlmJobStore.LaneSlotOf(LlmContracts.LaneNormal) == 2, "normal=2 并发");
        Check(LlmJobStore.LaneSlotOf(LlmContracts.LaneLow) == 1, "low=1 串行");

        // ── 4. 400 TPS 量级追写 + 轮询不丢不重（内存压测）──
        var hz = MakeJob(LlmContracts.LaneInteractive);
        for (var i = 0; i < 400; i++) hz.Append(new LlmEvent { Type = LlmContracts.EvDelta, Text = "x" });
        hz.Append(new LlmEvent { Type = LlmContracts.EvDone });
        var got = new StringBuilder();
        var cursor = 0;
        while (cursor < hz.EventCount)
        {
            var b = hz.Poll(cursor, 100, 0);
            if (b.Count == 0) break;
            foreach (var e in b) if (e.Type == LlmContracts.EvDelta) got.Append(e.Text);
            cursor += b.Count;
        }
        Check(got.Length == 400 && got.ToString() == new string('x', 400), "400 事件聚合无损");

        Console.WriteLine(_failures == 0 ? "SELFTEST llm-jobs: PASS" : $"SELFTEST llm-jobs: {_failures} FAILURES");
        return _failures == 0 ? 0 : 1;
    }
}

/// <summary>
/// llm 流式执行器自测（H2+H4）：本地 HttpListener mock SSE 服务器，
/// 全真链路（HttpClient → SSE 解析 → 归一事件 → 鉴权注入 → 重试）。
/// </summary>
public static class LlmStreamSelfTest
{
    private static int _failures;

    private static void Check(bool ok, string name)
    {
        if (!ok) { _failures++; Console.WriteLine($"[FAIL] {name}"); }
        else Console.WriteLine($"[PASS] {name}");
    }

    private sealed class FileSecrets : ISecretProvider
    {
        public bool IsAvailable => true;
        public string? Get(string name) => name == "k" ? "sk-file-test" : null;
        public void Put(string name, string value) { }
        public bool Delete(string name) => true;
        public IReadOnlyList<SecretEntryInfo> List() => Array.Empty<SecretEntryInfo>();
    }

    /// <summary>本地 mock OpenAI SSE 服务器（无外部依赖）。</summary>
    private sealed class MockSseServer : IDisposable
    {
        public string LastAuth = "";
        public int RequestCount;
        private readonly HttpListener _listener = new();
        private readonly string _prefix;

        public MockSseServer(Func<int, string> scriptFor)
        {
            _prefix = "http://127.0.0.1:0/";
            _listener.Prefixes.Add(_prefix);
            // HttpListener 不支持 :0——改用固定高端口探测
            var port = FreePort();
            _prefix = $"http://127.0.0.1:{port}/";
            _listener.Prefixes.Clear();
            _listener.Prefixes.Add(_prefix);
            _listener.Start();
            _ = Task.Run(async () =>
            {
                while (_listener.IsListening)
                {
                    HttpListenerContext ctx;
                    try { ctx = await _listener.GetContextAsync().ConfigureAwait(false); }
                    catch { break; }
                    var n = Interlocked.Increment(ref RequestCount) - 1;
                    try
                    {
                        LastAuth = ctx.Request.Headers["Authorization"] ?? ctx.Request.Headers["x-api-key"] ?? "";
                        var script = scriptFor(n);
                        var body = Encoding.UTF8.GetBytes(script);
                        ctx.Response.ContentType = "text/event-stream";
                        ctx.Response.ContentLength64 = body.Length;
                        // 400 TPS：按 2.5ms/char 模拟高吞吐——写成整块 + 小延时（CI 稳定性优先）
                        await ctx.Response.OutputStream.WriteAsync(body).ConfigureAwait(false);
                        await ctx.Response.OutputStream.FlushAsync().ConfigureAwait(false);
                        Thread.Sleep(30);
                        ctx.Response.Close();
                    }
                    catch { try { ctx.Response.Close(); } catch { } }
                }
            });
            Port = port;
        }

        public int Port { get; }
        public string Url => _prefix + "chat/completions";

        private static int FreePort()
        {
            var l = new System.Net.Sockets.TcpListener(IPAddress.Loopback, 0);
            l.Start();
            var p = ((IPEndPoint)l.LocalEndpoint).Port;
            l.Stop();
            return p;
        }

        public void Dispose() { try { _listener.Stop(); } catch { } }
    }

    private static string Sse(params string[] payloads)
    {
        var sb = new StringBuilder();
        foreach (var p in payloads)
        {
            sb.Append("data: ");
            sb.Append(p.Replace('\n', ' '));
            sb.Append("\n\n");
        }
        sb.Append("data: [DONE]\n\n");
        return sb.ToString();
    }

    private static string Chunk(string? content = null, string? reasoning = null, string? finish = null, object? usage = null)
    {
        var delta = new Dictionary<string, object>();
        if (content != null) delta["content"] = content;
        if (reasoning != null) delta["reasoning_content"] = reasoning;
        var choice = new Dictionary<string, object> { ["index"] = 0, ["delta"] = delta };
        if (finish != null) choice["finish_reason"] = finish;
        var obj = new Dictionary<string, object> { ["choices"] = new object[] { choice } };
        if (usage != null) obj["usage"] = usage;
        return JsonSerializer.Serialize(obj);
    }

    private static async Task<(List<LlmEvent>, LlmJob)> PollUntilDone(LlmJobService service, string jobId)
    {
        var all = new List<LlmEvent>();
        var cursor = 0;
        LlmJob? job = null;
        for (var i = 0; i < 3_000; i++)
        {
            job = service.Store.Find(jobId);
            if (job == null) throw new InvalidOperationException("job missing");
            var batch = job.Poll(cursor, 500, 25);
            cursor += batch.Count;
            all.AddRange(batch);
            if (job.IsTerminal && cursor >= job.EventCount) break;
        }
        return (all, job!);
    }

    public static async Task<int> RunAsync()
    {
        // ── 1. 正常流：文本 + 思考 + finish + usage + done；鉴权注入 bearer ──
        using (var server = new MockSseServer(_ => Sse(
            Chunk(reasoning: "思考"),
            Chunk(content: "你好"),
            Chunk(content: "！"),
            Chunk(finish: "stop", usage: new { prompt_tokens = 10, completion_tokens = 3 }))))
        using (var service = new LlmJobService(new FileSecrets()))
        {
            var frame = JsonDocument.Parse($@"{{
                ""lane"": ""interactive"", ""endpoint"": ""{server.Url}"", ""method"": ""POST"",
                ""auth"": {{ ""vaultKey"": ""k"", ""style"": ""bearer"" }},
                ""headers"": {{ ""Content-Type"": ""application/json"" }},
                ""body"": ""{{}}"", ""protocol"": ""openai"", ""timeoutMs"": 15000, ""maxRetries"": 1, ""idleTimeoutMs"": 5000
            }}").RootElement;
            var job = service.Submit(frame) ?? throw new InvalidOperationException("submit failed");
            var (events, _) = await PollUntilDone(service, job.Id).ConfigureAwait(false);

            Check(server.LastAuth == "Bearer sk-file-test", "bearer 鉴权注入");
            Check(events.Count > 0 && events[0].Type == LlmContracts.EvReasoningDelta && events[0].Text == "思考", "思考增量在首");
            var text = string.Concat(JoinText(events));
            Check(text == "你好！", "文本聚合一致");
            Check(Has(events, LlmContracts.EvFinish, e => e.Reason == "stop"), "finish 事件");
            Check(Has(events, LlmContracts.EvUsage, e => e.InputTokens == 10 && e.OutputTokens == 3), "usage 记账");
            Check(events[^1].Type == LlmContracts.EvDone, "done 收尾");
            Check(job.State == LlmJobState.Done, "终态 Done");
            Check(job.Metrics.TtftMs.HasValue && job.Metrics.QueueWaitMs.HasValue, "指标齐全（TTFT/queue wait）");
        }

        // ── 2. 重试：首次 429 → retry 事件 → 二次成功（首个增量前重发）──
        using (var server = new MockSseServer(n => n == 0
                ? throw new IOException("stub") // 不会走到：429 分支见下
                : Sse(Chunk(content: "ok"), Chunk(finish: "stop"))))
        using (var service = new LlmJobService(new FileSecrets()))
        {
            // MockSseServer 用脚本函数抛异常不优雅——429 分支直接写 status 的脚本由 n==0 决定
            var (events, job) = (default(List<LlmEvent>), default(LlmJob));
            var (ev2, j2) = await Run429ThenSuccess(service, server).ConfigureAwait(false);
            events = ev2; job = j2;
            Check(Has(events, LlmContracts.EvRetry, e => e.Attempt >= 1), "429 后 retry 事件");
            var text = string.Concat(JoinText(events));
            Check(text == "ok", "重试后成功收文");
            Check(job.Metrics.Retries >= 1, "retry 计数");
        }

        // ── 3. raw 风格鉴权（x-api-key）──
        using (var server = new MockSseServer(_ => Sse(Chunk(content: "r"), Chunk(finish: "stop"))))
        using (var service = new LlmJobService(new FileSecrets()))
        {
            var frame = JsonDocument.Parse($@"{{
                ""lane"": ""low"", ""endpoint"": ""{server.Url}"",
                ""auth"": {{ ""vaultKey"": ""k"", ""style"": ""raw"", ""headerName"": ""x-api-key"" }},
                ""body"": ""{{}}"", ""maxRetries"": 0
            }}").RootElement;
            var j = service.Submit(frame)!;
            await PollUntilDone(service, j.Id).ConfigureAwait(false);
            Check(server.LastAuth == "sk-file-test", "raw 风格注入 x-api-key");
        }

        Console.WriteLine(_failures == 0 ? "SELFTEST llm-stream: PASS" : $"SELFTEST llm-stream: {_failures} FAILURES");
        return _failures == 0 ? 0 : 1;
    }

    private static async Task<(List<LlmEvent>, LlmJob)> Run429ThenSuccess(LlmJobService service, MockSseServer server)
    {
        // 手写 429 服务器（Retry-After 头 + 短退避）
        var l = new System.Net.Sockets.TcpListener(IPAddress.Loopback, 0);
        l.Start();
        var port = ((IPEndPoint)l.LocalEndpoint).Port;
        _ = Task.Run(async () =>
        {
            while (true)
            {
                var client = await l.AcceptTcpClientAsync().ConfigureAwait(false);
                _ = Task.Run(() =>
                {
                    try
                    {
                        using var s = client.GetStream();
                        var n = Interlocked.Increment(ref RequestCount) - 1;
                        var body = n == 0
                            ? "{\"error\":{\"message\":\"rate limited\"}}"
                            : Sse(Chunk(content: "ok"), Chunk(finish: "stop"));
                        var head = n == 0
                            ? "HTTP/1.1 429 Too Many Requests\r\nRetry-After: 1\r\nContent-Type: application/json\r\nContent-Length: " + Encoding.UTF8.GetByteCount(body) + "\r\nConnection: close\r\n\r\n"
                            : "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n";
                        var headBytes = Encoding.UTF8.GetBytes(head);
                        s.Write(headBytes, 0, headBytes.Length);
                        var bodyBytes = Encoding.UTF8.GetBytes(body);
                        s.Write(bodyBytes, 0, bodyBytes.Length);
                        s.Flush();
                    }
                    catch { }
                    finally { client.Close(); }
                });
            }
        });
        Thread.Sleep(50); // listener 就绪

        var endpoint = $"http://127.0.0.1:{port}/chat/completions";
        var frame = JsonDocument.Parse($@"{{
            ""lane"": ""interactive"", ""endpoint"": ""{endpoint}"",
            ""auth"": {{ ""vaultKey"": ""k"", ""style"": ""bearer"" }},
            ""body"": ""{{}}"", ""maxRetries"": 2, ""idleTimeoutMs"": 5000
        }}").RootElement;
        var job = service.Submit(frame)!;
        var (events, j) = await PollUntilDone(service, job.Id).ConfigureAwait(false);
        l.Stop();
        return (events, j);
    }

    private static int RequestCount;

    private static IEnumerable<string> JoinText(List<LlmEvent> events)
    {
        foreach (var e in events)
            if (e.Type == LlmContracts.EvDelta && e.Text != null)
                yield return e.Text;
    }

    private static bool Has(List<LlmEvent> events, string type, Func<LlmEvent, bool> pred)
    {
        foreach (var e in events) if (e.Type == type && pred(e)) return true;
        return false;
    }
}

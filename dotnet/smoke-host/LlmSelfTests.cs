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
/// llm 作业库自测（H1）：lane 隔离 / 事件序 / 长轮询幂等 / cursor 补读 / low 满载拒绝 /
/// ring drop-oldest+truncated（复审 P0-2）/ TTL 回收（P0-4）。
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

        // ── 3. lane 并发槽位数（静态声明）──
        Check(LlmJobStore.LaneSlotOf(LlmContracts.LaneInteractive) == 4, "interactive=4 声明");
        Check(LlmJobStore.LaneSlotOf(LlmContracts.LaneNormal) == 2, "normal=2 声明");
        Check(LlmJobStore.LaneSlotOf(LlmContracts.LaneLow) == 1, "low=1 声明");

        // ── 4. 400 TPS 量级追写 + 轮询不丢不重（内存压测）──
        var hz = MakeJob(LlmContracts.LaneInteractive);
        for (var i = 0; i < 400; i++) hz.Append(new LlmEvent { Type = LlmContracts.EvDelta, Text = "x" });
        hz.Append(new LlmEvent { Type = LlmContracts.EvDone }, isTerminal: true);
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

        // ── 5. ring drop-oldest + truncated（复审 P0-2：满时不死锁、cursor 越丢弃段可续、终态必达）──
        var ring = MakeJob(LlmContracts.LaneInteractive);
        for (var i = 0; i < LlmJob.RingCapacity + 100; i++)
            ring.Append(new LlmEvent { Type = LlmContracts.EvDelta, Text = "y" });
        ring.Append(new LlmEvent { Type = LlmContracts.EvDone }, isTerminal: true);
        Check(ring.EventCount - ring.DroppedEvents <= LlmJob.RingCapacity, "ring 活跃事件不破上限");
        Check(ring.DroppedEvents > 0, "溢出丢弃计数");
        // cursor=0（已丢段）→ 从 base 起读：不挂、不重、可读到终态
        var fromZero = ring.Poll(0, int.MaxValue, 0);
        Check(fromZero.Count > 0 && fromZero[^1].Type == LlmContracts.EvDone, "drop-oldest 后 cursor 续读至终态");
        Check(ring.Poll(0, 1, 0).Count > 0, "cursor 幂等保持（不挂）");

        // ── 6. 未确认量语义（P0-2 核心：poll 消费推进 → PendingCount 下降）──
        var unconf = MakeJob(LlmContracts.LaneInteractive);
        for (var i = 0; i < 100; i++) unconf.Append(new LlmEvent { Type = LlmContracts.EvDelta, Text = "z" });
        Check(unconf.PendingCount == 100, "未确认=全部");
        unconf.Poll(0, 40, 0);
        Check(unconf.PendingCount == 60, "poll 消费推进未确认量下降");

        // ── 7. TTL 回收（P0-4：SweepExpired 接线 + Cts 清理可达）──
        using (var store = new LlmJobStore()) // 裸 store：onDequeued=null，作业不被执行干扰终态
        {
            var j = store.Submit(MakeJob(LlmContracts.LaneInteractive))!;
            j.State = LlmJobState.Done;
            j.FinishedAt = DateTimeOffset.UtcNow.AddMilliseconds(-10);
            store.SweepExpired(TimeSpan.FromMilliseconds(1));
            Check(store.Find(j.Id) == null, "TTL 过期回收");
        }

        Console.WriteLine(_failures == 0 ? "SELFTEST llm-jobs: PASS" : $"SELFTEST llm-jobs: {_failures} FAILURES");
        return _failures == 0 ? 0 : 1;
    }
}

/// <summary>
/// llm 流式执行器自测（H2+H4）：本地 mock SSE 全真链路 + 复审 P0 用例——
/// 真实并发隔离（P0-3）/ 网络断连重试（P0-9）/ wire error 终态（P1-7）/
/// 超水位暂停恢复（P0-2）/ timeoutMs 总兜底（P1-5）。
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

    /// <summary>本地 mock OpenAI SSE 服务器（记录并发峰值；脚本按请求序号分流）。</summary>
    private sealed class MockSseServer : IDisposable
    {
        public int PeakConcurrent;
        private int _concurrent;
        private readonly HttpListener _listener = new();
        private readonly string _prefix;
        private readonly Func<HttpListenerContext, int, Task> _handler;

        public int RequestCount;
        private volatile string _lastAuth = "";
        private readonly Dictionary<string, string> _lastRawHeaders = new();

        public string LastAuth() => _lastAuth;
        public string LastRaw(string header)
            => _lastRawHeaders.TryGetValue(header, out var v) ? v : "";

        public MockSseServer(Func<HttpListenerContext, int, Task> handler)
        {
            _handler = handler;
            var port = FreePort();
            _prefix = $"http://127.0.0.1:{port}/";
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
                    _lastAuth = ctx.Request.Headers["Authorization"] ?? "";
                    foreach (var h in new[] { "x-api-key", "api-key" })
                        if (ctx.Request.Headers[h] is { } v) _lastRawHeaders[h] = v;
                    var cur = Interlocked.Increment(ref _concurrent);
                    // 峰值并发记录（P0-3：真实并发验证）
                    var snap = Volatile.Read(ref _concurrent);
                    var seen = Volatile.Read(ref PeakConcurrent);
                    while (snap > seen && Interlocked.CompareExchange(ref PeakConcurrent, snap, seen) != seen)
                        seen = Volatile.Read(ref PeakConcurrent);
                    _ = Task.Run(async () =>
                    {
                        try { await _handler(ctx, n).ConfigureAwait(false); }
                        catch { try { ctx.Response.Close(); } catch { } }
                        finally { Interlocked.Decrement(ref _concurrent); }
                    });
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

    private static async Task WriteSseAsync(HttpListenerResponse resp, params string[] payloads)
    {
        resp.ContentType = "text/event-stream";
        var body = Sse(payloads);
        var bytes = Encoding.UTF8.GetBytes(body);
        resp.ContentLength64 = bytes.Length;
        await resp.OutputStream.WriteAsync(bytes).ConfigureAwait(false);
        await resp.OutputStream.FlushAsync().ConfigureAwait(false);
        resp.Close();
    }

    /// <summary>分块写但不关连接（慢流用例：模拟持续输出）；收尾后调用方手动 Close。</summary>
    private static async Task WriteSseChunkAsync(HttpListenerResponse resp, params string[] payloads)
    {
        resp.ContentType = "text/event-stream";
        resp.SendChunked = true;
        var bytes = Encoding.UTF8.GetBytes(Sse(false, payloads));
        await resp.OutputStream.WriteAsync(bytes).ConfigureAwait(false);
        await resp.OutputStream.FlushAsync().ConfigureAwait(false);
    }

    private static string Sse(params string[] payloads) => Sse(true, payloads);

    private static string Sse(bool withDone, params string[] payloads)
    {
        var sb = new StringBuilder();
        foreach (var p in payloads)
        {
            sb.Append("data: ");
            sb.Append(p.Replace('\n', ' '));
            sb.Append("\n\n");
        }
        if (withDone) sb.Append("data: [DONE]\n\n");
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

    private static async Task<(List<LlmEvent>, LlmJob)> PollUntilDone(LlmJobService service, string jobId, int maxLoops = 3_000)
    {
        var all = new List<LlmEvent>();
        var cursor = 0;
        LlmJob? job = null;
        for (var i = 0; i < maxLoops; i++)
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

    private static LlmJob SubmitInteractive(LlmJobService service, string endpoint, int maxRetries = 1, int timeoutMs = 15000)
    {
        var frame = JsonDocument.Parse($@"{{
            ""lane"": ""interactive"", ""endpoint"": ""{endpoint}"", ""method"": ""POST"",
            ""auth"": {{ ""vaultKey"": ""k"", ""style"": ""bearer"" }},
            ""headers"": {{ ""Content-Type"": ""application/json"" }},
            ""body"": ""{{}}"", ""protocol"": ""openai"", ""timeoutMs"": {timeoutMs}, ""maxRetries"": {maxRetries}, ""idleTimeoutMs"": 5000
        }}").RootElement;
        var job = service.TrySubmit(frame, out var err);
        if (job == null) throw new InvalidOperationException("submit failed: " + err);
        return job;
    }

    public static async Task<int> RunAsync()
    {
        // ── 1. 正常流：文本 + 思考 + finish + usage + done；鉴权注入 bearer ──
        using (var server = new MockSseServer(async (ctx, n) =>
            await WriteSseAsync(ctx.Response,
                Chunk(reasoning: "思考"),
                Chunk(content: "你好"),
                Chunk(content: "！"),
                Chunk(finish: "stop", usage: new { prompt_tokens = 10, completion_tokens = 3 })).ConfigureAwait(false)))
        using (var service = new LlmJobService(new FileSecrets()))
        {
            var job = SubmitInteractive(service, server.Url);
            var (events, _) = await PollUntilDone(service, job.Id).ConfigureAwait(false);

            Check(server.LastAuth() == "Bearer sk-file-test", "bearer 鉴权注入");
            Check(events.Count > 0 && events[0].Type == LlmContracts.EvReasoningDelta && events[0].Text == "思考", "思考增量在首");
            var text = string.Concat(JoinText(events));
            Check(text == "你好！", "文本聚合一致");
            Check(Has(events, LlmContracts.EvFinish, e => e.Reason == "stop"), "finish 事件");
            Check(Has(events, LlmContracts.EvUsage, e => e.InputTokens == 10 && e.OutputTokens == 3), "usage 记账");
            Check(events[^1].Type == LlmContracts.EvDone, "done 收尾");
            Check(job.State == LlmJobState.Done, "终态 Done");
            Check(job.Metrics.TtftMs.HasValue && job.Metrics.QueueWaitMs.HasValue, "指标齐全（TTFT/queue wait）");
        }

        // ── 2. 重试：首次 429（Retry-After）→ retry 事件 → 二次成功 ──
        {
            var n429 = 0;
            using var server = new MockSseServer(async (ctx, n) =>
            {
                if (n == 0)
                {
                    n429++;
                    ctx.Response.StatusCode = 429;
                    ctx.Response.Headers["Retry-After"] = "1";
                    var body = Encoding.UTF8.GetBytes("{\"error\":{\"message\":\"rate limited\"}}");
                    ctx.Response.ContentLength64 = body.Length;
                    await ctx.Response.OutputStream.WriteAsync(body).ConfigureAwait(false);
                    ctx.Response.Close();
                    return;
                }
                await WriteSseAsync(ctx.Response, Chunk(content: "ok"), Chunk(finish: "stop")).ConfigureAwait(false);
            });
            using var service = new LlmJobService(new FileSecrets());
            var job = SubmitInteractive(service, server.Url, maxRetries: 2);
            var (events, j) = await PollUntilDone(service, job.Id).ConfigureAwait(false);
            Check(Has(events, LlmContracts.EvRetry, e => e.Attempt >= 1), "429 后 retry 事件");
            Check(string.Concat(JoinText(events)) == "ok", "重试后成功收文");
            Check(j.Metrics.Retries >= 1, "retry 计数");
        }

        // ── 3. raw 风格鉴权（自定义 headerName 透传，复审 P1-4：Azure api-key 风格）──
        using (var server = new MockSseServer(async (ctx, n) =>
            await WriteSseAsync(ctx.Response, Chunk(content: "r"), Chunk(finish: "stop")).ConfigureAwait(false)))
        using (var service = new LlmJobService(new FileSecrets()))
        {
            var frame = JsonDocument.Parse($@"{{
                ""lane"": ""low"", ""endpoint"": ""{server.Url}"",
                ""auth"": {{ ""vaultKey"": ""k"", ""style"": ""raw"", ""headerName"": ""api-key"" }},
                ""body"": ""{{}}"", ""maxRetries"": 0
            }}").RootElement;
            var j = service.TrySubmit(frame, out _)!;
            await PollUntilDone(service, j.Id).ConfigureAwait(false);
            Check(server.LastRaw("api-key") == "sk-file-test", "raw 风格 + 自定义 headerName（api-key）");
        }

        // ── 4. 网络断连重试（复审 P0-9：首连接 RST → HttpRequestException(status=0) → retry → 成功）──
        {
            // TcpListener 原生实现：HttpListener.Abort 在 loopback 上是干净关闭（EOF≠异常），
            // 必须用 SO_LINGER(1,0) 硬复位产生真实 RST
            var tcp = new System.Net.Sockets.TcpListener(IPAddress.Loopback, 0);
            tcp.Start();
            var tcpPort = ((IPEndPoint)tcp.LocalEndpoint).Port;
            var tcpCts = new CancellationTokenSource();
            _ = Task.Run(async () =>
            {
                var n = 0;
                while (!tcpCts.IsCancellationRequested)
                {
                    System.Net.Sockets.TcpClient client;
                    try { client = await tcp.AcceptTcpClientAsync(tcpCts.Token).ConfigureAwait(false); }
                    catch { break; }
                    var idx = n++;
                    _ = Task.Run(async () =>
                    {
                        try
                        {
                            using (client)
                            {
                                var stream = client.GetStream();
                                var buf = new byte[8192];
                                var total = 0;
                                while (total < buf.Length)
                                {
                                    var len = await stream.ReadAsync(buf.AsMemory(total, buf.Length - total)).ConfigureAwait(false);
                                    if (len <= 0) return;
                                    total += len;
                                    if (Encoding.UTF8.GetString(buf, 0, total).Contains("\r\n\r\n")) break;
                                }
                                if (idx == 0)
                                {
                                    client.LingerState = new System.Net.Sockets.LingerOption(true, 0); // RST
                                    client.Close();
                                    return;
                                }
                                var body = Sse(Chunk(content: "部分完整"), Chunk(finish: "stop"));
                                var resp = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: "
                                    + Encoding.UTF8.GetByteCount(body) + "\r\nConnection: close\r\n\r\n" + body;
                                await stream.WriteAsync(Encoding.UTF8.GetBytes(resp)).ConfigureAwait(false);
                                await stream.FlushAsync().ConfigureAwait(false);
                            }
                        }
                        catch { try { client.Close(); } catch { } }
                    });
                }
            });
            var tcpUrl = $"http://127.0.0.1:{tcpPort}/chat/completions";
            try
            {
                using var service = new LlmJobService(new FileSecrets());
                var job = SubmitInteractive(service, tcpUrl, maxRetries: 2);
                var (events, j) = await PollUntilDone(service, job.Id).ConfigureAwait(false);
                Check(Has(events, LlmContracts.EvRetry, e => e.Attempt >= 1), "网络断连后 retry 事件（P0-9）");
                Check(j.State == LlmJobState.Done, "断连重试后 Done");
                Check(string.Concat(JoinText(events)) == "部分完整", "断连重试收文正确");
            }
            finally
            {
                tcpCts.Cancel();
                tcp.Stop();
            }
        }

        // ── 5. wire error 终态（复审 P1-7：HTTP 200 内嵌 error → Error 收口、无 done）──
        using (var server = new MockSseServer(async (ctx, n) =>
            await WriteSseAsync(ctx.Response, "{\"error\":{\"message\":\"quota exceeded\"}}").ConfigureAwait(false)))
        using (var service = new LlmJobService(new FileSecrets()))
        {
            var job = SubmitInteractive(service, server.Url, maxRetries: 0);
            var (events, j) = await PollUntilDone(service, job.Id).ConfigureAwait(false);
            Check(j.State == LlmJobState.Error, "wire error → 终态 Error");
            Check(Has(events, LlmContracts.EvError, e => e.Code == LlmContracts.ErrHttpPrefix + 200), "wire error 事件码");
            Check(!Has(events, LlmContracts.EvDone, _ => true), "wire error 不补 done");
        }

        // ── 6. 超水位暂停恢复（复审 P0-2：慢流 4000 事件不 poll → 暂停上游 → 恢复 poll → 无丢弃收口）──
        {
            var chunkOnce = false;
            using var server = new MockSseServer(async (ctx, n) =>
            {
                // 一次性吐 4000 个 delta（>HighWater 3276）+ finish/done，再慢慢关
                var sb = new StringBuilder();
                for (var i = 0; i < 4000; i++) sb.Append("data: " + Chunk(content: "x") + "\n\n");
                sb.Append("data: " + Chunk(finish: "stop") + "\n\n");
                sb.Append("data: [DONE]\n\n");
                var bytes = Encoding.UTF8.GetBytes(sb.ToString());
                ctx.Response.ContentType = "text/event-stream";
                ctx.Response.ContentLength64 = bytes.Length;
                await ctx.Response.OutputStream.WriteAsync(bytes).ConfigureAwait(false);
                await ctx.Response.OutputStream.FlushAsync().ConfigureAwait(false);
                chunkOnce = true;
                await Task.Delay(50).ConfigureAwait(false);
                ctx.Response.Close();
            });
            using var service = new LlmJobService(new FileSecrets());
            var job = SubmitInteractive(service, server.Url, maxRetries: 0, timeoutMs: 60000);
            // 关键：前 300ms 完全不 poll（制造未确认量 > HighWater）→ 上游暂停 → 恢复 poll 后收口
            await Task.Delay(300).ConfigureAwait(false);
            var (events, j) = await PollUntilDone(service, job.Id, maxLoops: 5000).ConfigureAwait(false);
            Check(j.State == LlmJobState.Done, "超水位暂停后恢复收口（P0-2）");
            Check(j.DroppedEvents == 0, "暂停语义下无事件丢弃");
            var text = string.Concat(JoinText(events));
            Check(text == new string('x', 4000), "4000 事件无损");
        }

        // ── 7. timeoutMs 总时长兜底（复审 P1-5：慢流 + 超短 timeout → REQUEST_TIMEOUT 终态）──
        {
            using var server = new MockSseServer(async (ctx, n) =>
            {
                await WriteSseChunkAsync(ctx.Response, Chunk(content: "开头")).ConfigureAwait(false);
                await Task.Delay(3000).ConfigureAwait(false); // 慢流：超过 timeoutMs=400
                await WriteSseChunkAsync(ctx.Response, Chunk(finish: "stop")).ConfigureAwait(false);
                ctx.Response.Close();
            });
            using var service = new LlmJobService(new FileSecrets());
            var job = SubmitInteractive(service, server.Url, maxRetries: 0, timeoutMs: 400);
            var (events, j) = await PollUntilDone(service, job.Id).ConfigureAwait(false);
            Check(j.State == LlmJobState.Error, "总超时 → 终态 Error");
            Check(Has(events, LlmContracts.EvError, e => e.Code == LlmContracts.ErrRequestTimeout), "REQUEST_TIMEOUT 错误码（P1-5）");
        }

        // ── 8. 真实并发隔离（复审 P0-3：low 串行峰值=1、interactive 峰值=4）──
        {
            var delayMs = 120;
            Func<HttpListenerContext, int, Task> slow = async (ctx, n) =>
            {
                await Task.Delay(delayMs).ConfigureAwait(false);
                await WriteSseAsync(ctx.Response, Chunk(content: "s"), Chunk(finish: "stop")).ConfigureAwait(false);
            };
            using var lowServer = new MockSseServer(slow);
            using (var service = new LlmJobService(new FileSecrets()))
            {
                var jobs = new List<LlmJob>();
                for (var i = 0; i < 6; i++) jobs.Add(SubmitLow(service, lowServer.Url));
                foreach (var j in jobs) await PollUntilDone(service, j.Id).ConfigureAwait(false);
                Check(Volatile.Read(ref lowServer.PeakConcurrent) == 1, $"low 串行（峰值并发=1，实测 {Volatile.Read(ref lowServer.PeakConcurrent)}）");
            }
            using var itServer = new MockSseServer(slow);
            using (var service = new LlmJobService(new FileSecrets()))
            {
                var jobs = new List<LlmJob>();
                for (var i = 0; i < 8; i++) jobs.Add(SubmitInteractive(service, itServer.Url, maxRetries: 0));
                foreach (var j in jobs) await PollUntilDone(service, j.Id).ConfigureAwait(false);
                var peak = Volatile.Read(ref itServer.PeakConcurrent);
                Check(peak >= 2 && peak <= 4, $"interactive 并发 ∈ [2,4]（实测 {peak}）");
            }
        }

        Console.WriteLine(_failures == 0 ? "SELFTEST llm-stream: PASS" : $"SELFTEST llm-stream: {_failures} FAILURES");
        return _failures == 0 ? 0 : 1;
    }

    private static LlmJob SubmitLow(LlmJobService service, string endpoint)
    {
        var frame = JsonDocument.Parse($@"{{
            ""lane"": ""low"", ""endpoint"": ""{endpoint}"",
            ""auth"": {{ ""vaultKey"": ""k"", ""style"": ""bearer"" }},
            ""body"": ""{{}}"", ""maxRetries"": 0, ""timeoutMs"": 20000
        }}").RootElement;
        var job = service.TrySubmit(frame, out _)!;
        return job;
    }

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

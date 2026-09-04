using System.Text.Json;
using CyreneEmbedSidecar;

// 用法：
//   verify <modelDir> <dump.json>   数值一致性验证：tokenIds 对账 + 向量余弦
//   bench  <modelDir> [textCount]   性能基准（自生成混合长短文本）
//   serve  <modelDir>               stdio 帧协议服务（Electron spawn）
//
// modelDir 指向 Xenova/bge-m3 布局（tokenizer.json + onnx/model_quantized.onnx）

var command = args.Length > 0 ? args[0] : "serve";
var modelDir = args.Length > 1 ? args[1]
    : Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", "models", "Xenova", "bge-m3"));

switch (command)
{
    case "verify":
        Verify.Run(modelDir, args.Length > 2 ? args[2] : "scripts/diagnostics/embedding-verify-data.json");
        return 0;
    case "bench":
        Bench.Run(modelDir, args.Length > 2 ? int.Parse(args[2]) : 48);
        return 0;
    case "serve":
        Server.Run(modelDir);
        return 0;
    default:
        Console.Error.WriteLine($"unknown command: {command}");
        return 2;
}

internal static class Verify
{
    public static void Run(string modelDir, string dumpPath)
    {
        using var doc = JsonDocument.Parse(File.ReadAllText(dumpPath));
        var root = doc.RootElement;
        var texts = root.GetProperty("texts").EnumerateArray().Select(t => t.GetString()!).ToArray();
        var expectedIds = root.GetProperty("tokenIds").EnumerateArray()
            .Select(a => a.EnumerateArray().Select(v => v.GetInt32()).ToArray()).ToArray();
        var expectedVectors = root.GetProperty("vectors").EnumerateArray()
            .Select(a => a.EnumerateArray().Select(v => (float)v.GetDouble()).ToArray()).ToArray();

        Console.WriteLine($"[verify] model dir: {modelDir}");

        // 1) tokenIds 对账（HfUnigramTokenizer 的直接产物，秒级）
        var tokenizer = HfUnigramTokenizer.FromTokenizerJson(Path.Combine(modelDir, "tokenizer.json"));
        int tokenMatches = 0, tokenTotal = 0;
        for (var i = 0; i < texts.Length; i++)
        {
            tokenTotal += expectedIds[i].Length;
            var actual = tokenizer.EncodeToIds(texts[i]);
            if (actual.SequenceEqual(expectedIds[i]))
            {
                tokenMatches += actual.Length;
            }
            else
            {
                var diffPos = DiffPosition(actual, expectedIds[i]);
                Console.WriteLine($"[verify] tokenIds mismatch #{i}: actual len={actual.Length}, expected len={expectedIds[i].Length}, first diff at {diffPos}");
                Console.WriteLine($"         actual:   {Show(actual, diffPos)}");
                Console.WriteLine($"         expected: {Show(expectedIds[i], diffPos)}");
            }
        }
        Console.WriteLine($"[verify] tokenizer: {tokenMatches}/{tokenTotal} tokens exact match");

        // 2) 向量一致性（需加载 ONNX session）
        var loadStart = System.Diagnostics.Stopwatch.GetTimestamp();
        using var engine = EmbeddingEngine.Load(modelDir);
        Console.WriteLine($"[verify] engine loaded in {System.Diagnostics.Stopwatch.GetElapsedTime(loadStart).TotalMilliseconds:F0}ms, dims={engine.Dimensions}");

        // 2a) 逐条推理（无 padding）：dump 数据来自 JS 逐条推理，先隔离
        //     batch padding 对 int8 动态量化 scale 的影响
        var seqVectors = new float[texts.Length][];
        for (var i = 0; i < texts.Length; i++) seqVectors[i] = engine.Embed(new[] { texts[i] })[0];
        ReportConsistency("sequential", seqVectors, expectedVectors, out var worstSeq);

        // 2b) 多文本入口（内部逐条）：生产路径
        var vectors = engine.Embed(texts);
        ReportConsistency("multi-text", vectors, expectedVectors, out var worstBatch);

        var pass = worstSeq > 0.9995 && worstBatch > 0.9995;
        Console.WriteLine($"[verify] {(pass ? "PASS" : "FAIL")} (threshold cosine > 0.9995)");
        if (!pass) Environment.Exit(1);
    }

    private static void ReportConsistency(string label, float[][] actual, float[][] expected, out double worstCos)
    {
        worstCos = 1.0;
        var maxAbs = 0.0;
        for (var i = 0; i < actual.Length; i++)
        {
            worstCos = Math.Min(worstCos, Cosine(actual[i], expected[i]));
            for (var k = 0; k < actual[i].Length; k++)
            {
                maxAbs = Math.Max(maxAbs, Math.Abs(actual[i][k] - expected[i][k]));
            }
        }
        Console.WriteLine($"[verify] vectors({label}): worst cosine={worstCos:F8}, max |diff|={maxAbs:E2}");
    }

    private static int DiffPosition(int[] a, int[] b)
    {
        var n = Math.Min(a.Length, b.Length);
        for (var i = 0; i < n; i++) if (a[i] != b[i]) return i;
        return n;
    }

    private static string Show(int[] ids, int pos)
    {
        var start = Math.Max(0, pos - 4);
        var end = Math.Min(ids.Length, pos + 6);
        var parts = Enumerable.Range(start, end - start).Select(i => $"{i}:{ids[i]}{(i == pos ? "*" : "")}");
        return string.Join(" ", parts);
    }

    private static double Cosine(float[] a, float[] b)
    {
        double dot = 0, na = 0, nb = 0;
        for (var i = 0; i < a.Length; i++)
        {
            dot += a[i] * b[i];
            na += a[i] * a[i];
            nb += b[i] * b[i];
        }
        return dot / (Math.Sqrt(na) * Math.Sqrt(nb) + 1e-12);
    }
}

internal static class Bench
{
    public static void Run(string modelDir, int textCount)
    {
        var shortTexts = new[]
        {
            "昔涟趴在桌边看着你工作，尾巴轻轻晃了一下",
            "The user is focused on coding, typing fast",
            "雨天，窗户上有水珠",
            "用户刚刚夸奖了昔涟",
            "深夜了，昔涟提醒你早点休息",
        };
        var longTexts = new[]
        {
            "昔涟注意到你连续工作了很久，轻轻地给你递上一杯热茶，然后把音量调小了一些，不想打扰你的思路。",
            "RAG 检索链路包含三个阶段：文档摄入时先分块并生成 embedding 写入向量库；检索时把查询文本转成向量做近邻搜索；最后可选地用 cross-encoder 对候选重排。分块策略决定了检索粒度，过大的块稀释语义，过小的块丢失上下文。",
        };
        var texts = new List<string>(textCount);
        var rng = new Random(42);
        for (var i = 0; i < textCount; i++)
        {
            texts.Add(rng.Next(3) == 0 ? longTexts[i % longTexts.Length] : shortTexts[i % shortTexts.Length]);
        }

        Console.WriteLine($"[bench] model dir: {modelDir}");
        var loadStart = System.Diagnostics.Stopwatch.GetTimestamp();
        using var engine = EmbeddingEngine.Load(modelDir);
        Console.WriteLine($"[bench] engine loaded in {System.Diagnostics.Stopwatch.GetElapsedTime(loadStart).TotalMilliseconds:F0}ms, dims={engine.Dimensions}");

        // 逐条
        var sw = System.Diagnostics.Stopwatch.StartNew();
        foreach (var text in texts) engine.Embed(new[] { text });
        sw.Stop();
        Console.WriteLine($"[bench] sequential: {texts.Count} texts in {sw.ElapsedMilliseconds}ms ({sw.ElapsedMilliseconds * 1.0 / texts.Count:F1}ms/text)");

        // 生产路径（多文本入口，内部逐条，与 sequential 数值一致）
        sw.Restart();
        var _ = engine.Embed(texts);
        sw.Stop();
        Console.WriteLine($"[bench] embed(N):   {texts.Count} texts in {sw.ElapsedMilliseconds}ms ({sw.ElapsedMilliseconds * 1.0 / texts.Count:F1}ms/text)");
        Console.WriteLine($"[bench] 对比基线 JS WASM：逐条 749.0ms/text（同机 48 条混合文本）");
    }
}

internal static class Server
{
    /// <summary>
    /// stdio 帧协议（二进制安全，供 Electron 主进程 spawn）：
    ///
    ///   请求帧： [4B 小端 JSON 头长度][UTF-8 JSON 头]
    ///     头：{"id":1,"op":"embed","texts":["a","b"]}
    ///   响应帧：[4B 小端 JSON 头长度][UTF-8 JSON 头][二进制 float32 小端]
    ///     成功头：{"id":1,"ok":true,"count":2,"dim":1024}
    ///     二进制段长度 = count × dim × 4（由头推导，不另设长度字段）
    ///     错误头：  {"id":1,"ok":false,"error":"..."}（无二进制段）
    ///
    ///   就绪通知（模型加载完成后发一帧，id=0）：
    ///     {"id":0,"op":"ready","modelKey":"bgem3","dim":1024}
    ///
    /// stderr 只用于诊断日志（进程崩溃前的输出不受帧协议污染）。
    /// </summary>
    public static void Run(string modelDir)
    {
        Console.Error.WriteLine($"[serve] model dir: {modelDir}");
        var engine = EmbeddingEngine.Load(modelDir);

        // 预热：隐藏首次推理的 MLAS kernel lazy-init（实测 ~130ms），
        // 代价是 ready 延迟同等毫秒数，换首个真实请求无毛刺
        var warmupStart = System.Diagnostics.Stopwatch.GetTimestamp();
        engine.Embed(new[] { "warmup" });
        Console.Error.WriteLine($"[serve] warmup in {System.Diagnostics.Stopwatch.GetElapsedTime(warmupStart).TotalMilliseconds:F0}ms");

        WriteFrame(new
        {
            id = 0,
            op = "ready",
            modelKey = engine.ModelKey,
            dim = engine.Dimensions,
            idleExitSec = IdleExitSeconds,
        });

        RunAsync(engine, Console.OpenStandardInput(), Console.OpenStandardOutput()).GetAwaiter().GetResult();
    }

    /// <summary>
    /// 空闲自动退出（秒）。桌宠 24/7 场景 embedding 调用是间歇性的
    /// （记忆写入 / 场景识别 / 贴纸索引），而 sidecar 常驻内存
    /// ~776MB（int8 权重 570MB + 运行时/arena，且空闲不回落——
    /// 实测 idle 10s RSS 无变化）。空闲 N 分钟自杀把「常驻 776MB」
    /// 变成「峰值 776MB」：下次调用由宿主侧懒重启（模型加载 ~2.5s）。
    /// CYRENE_EMBED_IDLE_EXIT_SEC 覆盖；0 = 永不退出。
    /// </summary>
    private static int IdleExitSeconds { get; } = ReadPositiveIntEnv("CYRENE_EMBED_IDLE_EXIT_SEC") ?? 600;

    private static int? ReadPositiveIntEnv(string name)
    {
        var raw = Environment.GetEnvironmentVariable(name);
        return int.TryParse(raw, out var v) && v >= 0 ? v : null;
    }

    private static async Task RunAsync(EmbeddingEngine engine, Stream stdin, Stream stdout)
    {
        // ⚠️ Console.OpenStandardInput() 的 ReadAsync 是 sync-over-async：
        // 线程真阻塞在 pipe read(2) 上，CancellationToken 无法中断（实测
        // 空闲超时永远不触发）。改用专用读线程同步读 + Channel 解耦：
        // channel 的 ReadAsync 超时才是真正可取消的。
        var channel = System.Threading.Channels.Channel.CreateUnbounded<string>(
            new System.Threading.Channels.UnboundedChannelOptions { SingleReader = true });

        var readerThread = new Thread(() =>
        {
            try
            {
                while (true)
                {
                    var frame = ReadFrameSync(stdin);
                    if (frame is null || !channel.Writer.TryWrite(frame))
                    {
                        channel.Writer.TryComplete();
                        return;
                    }
                }
            }
            catch (Exception ex)
            {
                channel.Writer.TryComplete(ex);
            }
        })
        { IsBackground = true, Name = "sidecar-stdin" };
        readerThread.Start();

        while (true)
        {
            // 读帧（带空闲超时）：超时 = 宿主不再需要本进程，礼貌退出；
            // ChannelClosedException = stdin EOF（读线程发现管道关闭）
            string? headerJson;
            try
            {
                if (IdleExitSeconds > 0)
                {
                    using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(IdleExitSeconds));
                    headerJson = await channel.Reader.ReadAsync(timeout.Token);
                }
                else
                {
                    headerJson = await channel.Reader.ReadAsync();
                }
            }
            catch (OperationCanceledException)
            {
                Console.Error.WriteLine($"[serve] idle {IdleExitSeconds}s, exiting (RSS reclaimed; host lazily respawns)");
                return;
            }
            catch (System.Threading.Channels.ChannelClosedException)
            {
                Console.Error.WriteLine("[serve] stdin EOF, exiting");
                return;
            }
            if (headerJson is null) return;

            RequestHeader? request;
            try
            {
                request = System.Text.Json.JsonSerializer.Deserialize<RequestHeader>(headerJson, JsonOptions);
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[serve] bad request: {ex.Message}");
                continue;
            }
            if (request is null) continue;
            if (request.Op != "embed")
            {
                WriteFrame(new ResponseHeader { Id = request.Id, Ok = false, Error = $"unsupported op: {request.Op}" });
                continue;
            }

            try
            {
                var vectors = engine.Embed(request.Texts ?? Array.Empty<string>());
                WriteResponse(stdout, request.Id, vectors, engine.Dimensions);
            }
            catch (Exception ex)
            {
                WriteFrame(new ResponseHeader { Id = request.Id, Ok = false, Error = ex.Message });
                Console.Error.WriteLine($"[serve] embed failed: {ex}");
            }
        }
    }

    /// <summary>
    /// 响应分段写出：长度前缀 + JSON 头 + 每个向量的 float 数据逐段 Write。
    /// 省去一次性拼接 byte[] 的整段拷贝（n 条 × dim×4B，大批量时省一倍
    /// 峰值分配）。Stream.Write(ReadOnlySpan) 直接消费 engine 堆上的
    /// float[]（无 Memory 包装/转换）；pipe 写入走用户态缓冲，一次 Flush。
    /// </summary>
    private static void WriteResponse(Stream stdout, int id, float[][] vectors, int dim)
    {
        var header = new ResponseHeader { Id = id, Ok = true, Count = vectors.Length, Dim = dim };
        var headerJsonOut = System.Text.Json.JsonSerializer.Serialize(header, JsonOptions);
        var headerBytes = System.Text.Encoding.UTF8.GetBytes(headerJsonOut);

        var prefix = BitConverter.GetBytes((int)headerBytes.Length);
        stdout.Write(prefix);
        stdout.Write(headerBytes);
        // float[] 的二进制布局即小端 float32，与协议一致，直接按段写出
        foreach (var v in vectors)
        {
            stdout.Write(System.Runtime.InteropServices.MemoryMarshal.AsBytes(v.AsSpan()));
        }
        stdout.Flush();
    }

    /// <summary>协议 JSON 统一 camelCase（与 JS 侧约定一致）。</summary>
    private static readonly System.Text.Json.JsonSerializerOptions JsonOptions = new(System.Text.Json.JsonSerializerDefaults.Web);

    private sealed class RequestHeader
    {
        public int Id { get; set; }
        public string Op { get; set; } = "embed";
        public string[]? Texts { get; set; }
    }

    private sealed class ResponseHeader
    {
        public int Id { get; set; }
        public bool Ok { get; set; }
        public int Count { get; set; }
        public int Dim { get; set; }
        public string? Error { get; set; }
    }

    /// <summary>读一帧：4B 小端长度 + JSON 头。EOF 返回 null。专用读线程内同步调用。</summary>
    private static string? ReadFrameSync(Stream stdin)
    {
        var prefix = new byte[4];
        if (!ReadExact(stdin, prefix, 4)) return null;
        var length = BitConverter.ToInt32(prefix, 0);
        if (length is < 0 or > 64 * 1024 * 1024)
        {
            throw new IOException($"frame length out of range: {length}");
        }
        var payload = new byte[length];
        if (!ReadExact(stdin, payload, length)) return null;
        return System.Text.Encoding.UTF8.GetString(payload);
    }

    private static bool ReadExact(Stream stream, byte[] buffer, int count)
    {
        var read = 0;
        while (read < count)
        {
            var n = stream.Read(buffer, read, count - read);
            if (n <= 0) return false;
            read += n;
        }
        return true;
    }

    private static void WriteFrame(object header)
    {
        var json = System.Text.Json.JsonSerializer.Serialize(header, JsonOptions);
        var bytes = System.Text.Encoding.UTF8.GetBytes(json);
        var stdout = Console.OpenStandardOutput();
        var prefix = BitConverter.GetBytes((int)bytes.Length);
        stdout.Write(prefix, 0, 4);
        stdout.Write(bytes, 0, bytes.Length);
        stdout.Flush();
    }
}

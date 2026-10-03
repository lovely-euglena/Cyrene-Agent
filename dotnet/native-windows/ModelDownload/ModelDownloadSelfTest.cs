using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;

namespace CyreneNative.ModelDownload;

/// <summary>
/// `cyrene-native --selftest model-download` 自检：用内存假网络覆盖下载器核心行为——
/// 全量下载 / 跳过已装 / 断点续传 / Range 失效重下 / 必装缺失报错 / 可选缺失跳过 /
/// 镜像切换 / 取消 / IsInstalled 口径。任一项失败退出码 1。
/// </summary>
public static class ModelDownloadSelfTest
{
    public static int Run()
    {
        var pass = 0;
        var fail = 0;
        var tempRoot = Directory.CreateTempSubdirectory("cyrene-model-download-selftest-").FullName;

        void Check(string name, bool ok)
        {
            if (ok)
            {
                pass++;
                Console.WriteLine($"[PASS] {name}");
            }
            else
            {
                fail++;
                Console.WriteLine($"[FAIL] {name}");
            }
        }

        // 测试规格：与真实清单同构，minBytes 缩到可用小文件覆盖。
        var spec = new ModelSpec("bgem3", "Xenova/bge-m3", "Xenova/bge-m3", new[]
        {
            new ModelFileSpec("onnx/model_quantized.onnx", 4, true),
            new ModelFileSpec("tokenizer.json", 4, true),
            new ModelFileSpec("config.json", 2, true),
            new ModelFileSpec("sentencepiece.bpe.model", 2, false),
        });
        const string officialBase = "https://huggingface.co/Xenova/bge-m3/resolve/main/";

        try
        {
            // ── 1) 全量下载 ──
            var root1 = Path.Combine(tempRoot, "case1");
            var progress = new List<ModelDownloadProgress>();
            using (var downloader = new ModelDownloader(new FakeHandler(req =>
            {
                var rel = RelOf(req, officialBase);
                return rel is null ? NotFound() : FileResponse(req, ContentFor(rel));
            })))
            {
                var result = downloader.DownloadAsync(spec, root1, "official", p => progress.Add(p)).GetAwaiter().GetResult();
                Check("全量下载：目录落点正确", result.Dir == Path.Combine(root1, "Xenova", "bge-m3"));
                Check("全量下载：文件就绪、内容正确、无 .part 残留", spec.Files.All(f =>
                {
                    var path = Path.Combine(result.Dir, f.Rel.Replace('/', Path.DirectorySeparatorChar));
                    return File.Exists(path)
                        && !File.Exists(path + ".part")
                        && File.ReadAllBytes(path).AsSpan().SequenceEqual(ContentFor(f.Rel));
                }));
                Check("全量下载：skipped 为空", result.Skipped.Count == 0);
                Check("全量下载：终帧 done / 100%", progress.Count > 0
                    && progress[progress.Count - 1].Phase == ModelDownloadPhase.Done
                    && progress[progress.Count - 1].Percent == 100
                    && progress[progress.Count - 1].TotalFiles == spec.Files.Count);
            }

            // ── 2) 已完整文件跳过下载 ──
            var root2 = Path.Combine(tempRoot, "case2");
            var preDir = Path.Combine(root2, "Xenova", "bge-m3", "onnx");
            Directory.CreateDirectory(preDir);
            File.WriteAllBytes(Path.Combine(preDir, "model_quantized.onnx"), ContentFor("onnx/model_quantized.onnx"));
            var handler2 = new FakeHandler(req =>
            {
                var rel = RelOf(req, officialBase);
                return rel is null ? NotFound() : FileResponse(req, ContentFor(rel));
            });
            using (var downloader = new ModelDownloader(handler2))
            {
                downloader.DownloadAsync(spec, root2, "official").GetAwaiter().GetResult();
            }
            Check("已完整文件跳过（无任何请求）", handler2.Calls.All(c => !c.Url.EndsWith("onnx/model_quantized.onnx")));

            // ── 3) 断点续传（.part + Range） ──
            var root3 = Path.Combine(tempRoot, "case3");
            var onnxDir = Path.Combine(root3, "Xenova", "bge-m3", "onnx");
            Directory.CreateDirectory(onnxDir);
            var onnxFull = ContentFor("onnx/model_quantized.onnx");
            File.WriteAllBytes(Path.Combine(onnxDir, "model_quantized.onnx.part"), onnxFull[..7]);
            var handler3 = new FakeHandler(req =>
            {
                var rel = RelOf(req, officialBase);
                return rel is null ? NotFound() : FileResponse(req, ContentFor(rel));
            });
            using (var downloader = new ModelDownloader(handler3))
            {
                downloader.DownloadAsync(spec, root3, "official").GetAwaiter().GetResult();
            }
            Check("断点续传：携带 Range 且最终内容正确", handler3.Calls.Any(c => c.Range == "bytes=7-")
                && File.ReadAllBytes(Path.Combine(onnxDir, "model_quantized.onnx")).AsSpan().SequenceEqual(onnxFull));

            // ── 4) 服务器忽略 Range（200 全量）→ 重下不拼接 ──
            var root4 = Path.Combine(tempRoot, "case4");
            var tokDir = Path.Combine(root4, "Xenova", "bge-m3");
            Directory.CreateDirectory(tokDir);
            var tokFull = ContentFor("tokenizer.json");
            File.WriteAllBytes(Path.Combine(tokDir, "tokenizer.json.part"), tokFull[..5]);
            var handler4 = new FakeHandler(req =>
            {
                var rel = RelOf(req, officialBase);
                return rel is null ? NotFound() : FileResponse(req, ContentFor(rel), ignoreRange: true);
            });
            using (var downloader = new ModelDownloader(handler4))
            {
                downloader.DownloadAsync(spec, root4, "official").GetAwaiter().GetResult();
            }
            Check("服务器忽略 Range：重下不拼接", File.ReadAllBytes(Path.Combine(tokDir, "tokenizer.json")).AsSpan().SequenceEqual(tokFull));

            // ── 5) 必装文件缺失 → 报错且不产出 ──
            var root5 = Path.Combine(tempRoot, "case5");
            var handler5 = new FakeHandler(req =>
            {
                var rel = RelOf(req, officialBase);
                if (rel == "config.json") return NotFound();
                return rel is null ? NotFound() : FileResponse(req, ContentFor(rel));
            });
            var threwRequired = false;
            try
            {
                using var downloader = new ModelDownloader(handler5);
                downloader.DownloadAsync(spec, root5, "official").GetAwaiter().GetResult();
            }
            catch (ModelDownloadException)
            {
                threwRequired = true;
            }
            Check("必装缺失：抛 ModelDownloadException", threwRequired);
            Check("必装缺失：不产出目标文件", !File.Exists(Path.Combine(root5, "Xenova", "bge-m3", "config.json")));

            // ── 6) 可选文件缺失 → 跳过不报错 ──
            var root6 = Path.Combine(tempRoot, "case6");
            var handler6 = new FakeHandler(req =>
            {
                var rel = RelOf(req, officialBase);
                if (rel == "sentencepiece.bpe.model") return NotFound();
                return rel is null ? NotFound() : FileResponse(req, ContentFor(rel));
            });
            ModelDownloadResult result6;
            using (var downloader = new ModelDownloader(handler6))
            {
                result6 = downloader.DownloadAsync(spec, root6, "official").GetAwaiter().GetResult();
            }
            Check("可选缺失：记入 skipped 且不报错", result6.Skipped.Contains("sentencepiece.bpe.model")
                && File.Exists(Path.Combine(root6, "Xenova", "bge-m3", "tokenizer.json")));

            // ── 7) 镜像切换命中 hf-mirror ──
            var root7 = Path.Combine(tempRoot, "case7");
            const string mirrorBase = "https://hf-mirror.com/Xenova/bge-m3/resolve/main/";
            var handler7 = new FakeHandler(req =>
            {
                var rel = RelOf(req, mirrorBase);
                return rel is null ? NotFound() : FileResponse(req, ContentFor(rel));
            });
            using (var downloader = new ModelDownloader(handler7))
            {
                downloader.DownloadAsync(spec, root7, "hf-mirror").GetAwaiter().GetResult();
            }
            Check("镜像切换：请求全部命中 hf-mirror", handler7.Calls.Count > 0
                && handler7.Calls.All(c => c.Url.StartsWith("https://hf-mirror.com", StringComparison.Ordinal)));

            // ── 8) 取消 → OperationCanceledException ──
            var root8 = Path.Combine(tempRoot, "case8");
            using var cts = new CancellationTokenSource();
            cts.Cancel();
            var cancelled = false;
            try
            {
                using var downloader = new ModelDownloader();
                downloader.DownloadAsync(spec, root8, "official", null, cts.Token).GetAwaiter().GetResult();
            }
            catch (OperationCanceledException)
            {
                cancelled = true;
            }
            Check("取消：抛 OperationCanceledException", cancelled);

            // ── 9) IsInstalled 口径 ──
            Check("IsInstalled：完整安装为 true", ModelDownloader.IsInstalled(root1, spec));
            File.Delete(Path.Combine(root1, "Xenova", "bge-m3", "config.json"));
            Check("IsInstalled：缺必装文件为 false", !ModelDownloader.IsInstalled(root1, spec));
        }
        finally
        {
            try
            {
                Directory.Delete(tempRoot, recursive: true);
            }
            catch
            {
                // 清理失败不影响自检结论
            }
        }

        Console.WriteLine($"[selftest model-download] {pass} passed, {fail} failed");
        return fail == 0 ? 0 : 1;
    }

    private static string? RelOf(HttpRequestMessage request, string baseUrl)
    {
        var url = request.RequestUri!.ToString();
        return url.StartsWith(baseUrl, StringComparison.Ordinal) ? url[baseUrl.Length..] : null;
    }

    private static byte[] ContentFor(string rel) => Encoding.UTF8.GetBytes($"payload-of-{rel}-0123456789");

    private static HttpResponseMessage NotFound() =>
        new(HttpStatusCode.NotFound) { Content = new ByteArrayContent(Array.Empty<byte>()) };

    private static HttpResponseMessage FileResponse(HttpRequestMessage request, byte[] full, bool ignoreRange = false)
    {
        if (request.Method == HttpMethod.Head)
        {
            var head = new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(Array.Empty<byte>()) };
            head.Content.Headers.ContentLength = full.Length;
            return head;
        }

        var range = request.Headers.Range;
        if (range is not null && !ignoreRange)
        {
            var from = range.Ranges.First().From ?? 0;
            var slice = full[(int)from..];
            var partial = new HttpResponseMessage(HttpStatusCode.PartialContent) { Content = new ByteArrayContent(slice) };
            partial.Content.Headers.ContentRange = new ContentRangeHeaderValue(from, full.Length - 1, full.Length);
            return partial;
        }

        return new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(full) };
    }

    /// <summary>内存假网络：按 URL 供数，支持 HEAD/Range/404 与忽略 Range 两种服务器行为。</summary>
    private sealed class FakeHandler : HttpMessageHandler
    {
        private readonly Func<HttpRequestMessage, HttpResponseMessage> _responder;

        public List<(string Url, string Method, string? Range)> Calls { get; } = new();

        public FakeHandler(Func<HttpRequestMessage, HttpResponseMessage> responder) => _responder = responder;

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Calls.Add((request.RequestUri!.ToString(), request.Method.Method, request.Headers.Range?.ToString()));
            cancellationToken.ThrowIfCancellationRequested();
            return Task.FromResult(_responder(request));
        }
    }
}

using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;

namespace CyreneNative.ModelDownload;

/// <summary>下载阶段（窗口进度区与之一一对应）。</summary>
public enum ModelDownloadPhase
{
    Planning,
    Downloading,
    Done,
}

/// <summary>进度载荷；Percent 为 null 表示总大小未知（服务器未给长度）。</summary>
public sealed record ModelDownloadProgress(
    string Kind,
    ModelDownloadPhase Phase,
    string File,
    int CompletedFiles,
    int TotalFiles,
    long ReceivedBytes,
    long? TotalBytes,
    int? Percent);

/// <summary>下载失败（必装文件）时抛出；File 为出错文件相对路径（可空）。</summary>
public sealed class ModelDownloadException(string message, string? file = null) : Exception(message)
{
    public string? File { get; } = file;
}

/// <summary>单个模型文件规格（MinBytes 与安装脚本同口径）。</summary>
public sealed record ModelFileSpec(string Rel, long MinBytes, bool Required);

/// <summary>模型规格：Repo 为 HF 仓库；SubDir 为模型目录内子路径（/ 分隔）。</summary>
public sealed record ModelSpec(string Kind, string Repo, string SubDir, IReadOnlyList<ModelFileSpec> Files);

/// <summary>
/// 内置模型清单（与 scripts/install-bge-m3.ps1、scripts/install-bge-reranker.ps1、
/// TS 侧 rag/model-status.ts 的探测约定一致）。
/// </summary>
public static class ModelDownloadSpecs
{
    private static ModelFileSpec[] CommonFiles() =>
    [
        new("onnx/model_quantized.onnx", 50L * 1024 * 1024, true),
        new("tokenizer.json", 1024 * 1024, true),
        new("config.json", 10, true),
        new("tokenizer_config.json", 10, false),
        new("special_tokens_map.json", 10, false),
        new("sentencepiece.bpe.model", 1024 * 1024, false),
    ];

    public static readonly ModelSpec BgeM3 = new("bgem3", "Xenova/bge-m3", "Xenova/bge-m3", CommonFiles());

    public static readonly ModelSpec Reranker = new("reranker", "Xenova/bge-reranker-base", "bge-reranker-base", CommonFiles());

    public static ModelSpec? Resolve(string kind) => kind switch
    {
        "bgem3" => BgeM3,
        "reranker" => Reranker,
        _ => null,
    };

    /// <summary>镜像白名单归一化：除 hf-mirror 外一律官方源。</summary>
    public static string NormalizeMirror(string? mirror) => mirror == "hf-mirror" ? "hf-mirror" : "official";

    public static string MirrorHost(string mirror) => NormalizeMirror(mirror) == "hf-mirror"
        ? "https://hf-mirror.com"
        : "https://huggingface.co";
}

/// <summary>下载结果：Files 为已就绪文件（含本就完整的），Skipped 为可选文件缺失清单。</summary>
public sealed record ModelDownloadResult(string Kind, string Dir, IReadOnlyList<string> Files, IReadOnlyList<string> Skipped);

/// <summary>
/// RAG 模型一键下载器：把 BGE-M3 / bge-reranker-base 直接装到「项目模型目录」。
///
/// - 落点 = &lt;模型目录&gt;/Xenova/bge-m3 或 &lt;模型目录&gt;/bge-reranker-base（运行链路唯一认的位置）；
/// - 必装三件套缺失即失败；附属文件失败仅跳过（与安装脚本同口径）；
/// - 断点续传（.part + HTTP Range）、可取消（CancellationToken；已下载部分保留）；
/// - 先 HEAD（失败退 Range: 0-0）探测大小，用于整体进度估算。
/// </summary>
public sealed class ModelDownloader : IDisposable
{
    private const int ProgressIntervalMs = 250;
    private const int BufferSize = 81920;

    private readonly HttpClient _http;

    /// <summary>handler 为空时使用默认网络栈；自检注入假 handler 走离线数据。</summary>
    public ModelDownloader(HttpMessageHandler? handler = null)
    {
        _http = new HttpClient(handler ?? new HttpClientHandler())
        {
            Timeout = Timeout.InfiniteTimeSpan,
        };
    }

    public void Dispose() => _http.Dispose();

    /// <summary>模型目录绝对路径（SubDir 以 / 分隔，落盘转平台分隔符）。</summary>
    public static string ModelDir(string modelsDir, ModelSpec spec) =>
        Path.Combine(modelsDir, spec.SubDir.Replace('/', Path.DirectorySeparatorChar));

    /// <summary>全部必装文件存在且 ≥ MinBytes 才算已安装（与 TS 侧同口径）。</summary>
    public static bool IsInstalled(string modelsDir, ModelSpec spec)
    {
        var dir = ModelDir(modelsDir, spec);
        foreach (var file in spec.Files)
        {
            if (!file.Required) continue;
            var path = Path.Combine(dir, file.Rel.Replace('/', Path.DirectorySeparatorChar));
            var info = new FileInfo(path);
            if (!info.Exists || info.Length < file.MinBytes) return false;
        }
        return true;
    }

    public async Task<ModelDownloadResult> DownloadAsync(
        ModelSpec spec,
        string modelsDir,
        string mirror,
        Action<ModelDownloadProgress>? onProgress = null,
        CancellationToken ct = default)
    {
        ct.ThrowIfCancellationRequested();
        var baseUrl = $"{ModelDownloadSpecs.MirrorHost(mirror)}/{spec.Repo}/resolve/main/";
        var dir = ModelDir(modelsDir, spec);
        Directory.CreateDirectory(dir);

        var tasks = new List<DownloadTask>();
        var skipped = new List<string>();
        long lastEmit = 0;

        void Emit(ModelDownloadPhase phase, DownloadTask? current, bool force = false)
        {
            if (onProgress is null) return;
            var now = Environment.TickCount64;
            if (!force && now - lastEmit < ProgressIntervalMs) return;
            lastEmit = now;

            var completed = 0;
            long received = 0;
            long expectedTotal = 0;
            var allKnown = true;
            foreach (var task in tasks)
            {
                received += task.Received;
                if (task.Finished)
                {
                    completed += 1;
                    expectedTotal += task.Received;
                }
                else if (task.Expected is { } size)
                {
                    expectedTotal += size;
                }
                else
                {
                    allKnown = false;
                }
            }

            var percent = allKnown && expectedTotal > 0
                ? (int)Math.Min(100, received * 100 / expectedTotal)
                : (int?)null;
            onProgress(new ModelDownloadProgress(
                spec.Kind,
                phase,
                phase == ModelDownloadPhase.Downloading ? current?.File.Rel ?? "" : "",
                completed,
                tasks.Count,
                received,
                allKnown ? expectedTotal : null,
                percent));
        }

        Emit(ModelDownloadPhase.Planning, null, force: true);

        // ── 规划：本地完整 → 跳过；否则探测远端大小与可达性 ──
        foreach (var file in spec.Files)
        {
            ct.ThrowIfCancellationRequested();
            var dest = Path.Combine(dir, file.Rel.Replace('/', Path.DirectorySeparatorChar));
            var info = new FileInfo(dest);
            if (info.Exists && info.Length >= file.MinBytes)
            {
                tasks.Add(new DownloadTask
                {
                    File = file,
                    Url = baseUrl + file.Rel,
                    Dest = dest,
                    Expected = info.Length,
                    Received = info.Length,
                    Finished = true,
                });
                continue;
            }

            var url = baseUrl + file.Rel;
            var probe = await ProbeAsync(url, ct);
            if (!probe.Reachable && probe.Status is 404 or 403)
            {
                if (file.Required)
                {
                    throw new ModelDownloadException(
                        $"{file.Rel} 在镜像上不存在（HTTP {probe.Status}；请切换镜像源）",
                        file.Rel);
                }
                skipped.Add(file.Rel);
                continue;
            }

            var part = dest + ".part";
            var partSize = File.Exists(part) ? new FileInfo(part).Length : 0;
            tasks.Add(new DownloadTask
            {
                File = file,
                Url = url,
                Dest = dest,
                Expected = probe.Size,
                Received = partSize > 0 ? partSize : 0,
            });
        }

        Emit(ModelDownloadPhase.Planning, null, force: true);

        // ── 下载：顺序执行（大文件在前） ──
        foreach (var task in tasks.Where(t => !t.Finished))
        {
            ct.ThrowIfCancellationRequested();
            Emit(ModelDownloadPhase.Downloading, task, force: true);
            try
            {
                var size = await DownloadFileAsync(task, ct, received =>
                {
                    task.Received = received;
                    Emit(ModelDownloadPhase.Downloading, task);
                });
                task.Received = size;
                task.Finished = true;
            }
            catch (OperationCanceledException)
            {
                Emit(ModelDownloadPhase.Downloading, task, force: true);
                throw;
            }
            catch (Exception ex)
            {
                if (task.File.Required)
                {
                    throw new ModelDownloadException(
                        $"{ex.Message}（已下载部分保留，可稍后重试续传）",
                        task.File.Rel);
                }
                skipped.Add(task.File.Rel);
                try { File.Delete(task.Part); } catch { /* 清理失败不影响结论 */ }
            }
            Emit(ModelDownloadPhase.Downloading, task, force: true);
        }

        Emit(ModelDownloadPhase.Done, null, force: true);
        return new ModelDownloadResult(
            spec.Kind,
            dir,
            tasks.Select(t => t.File.Rel).ToList(),
            skipped);
    }

    private sealed class DownloadTask
    {
        public required ModelFileSpec File { get; init; }
        public required string Url { get; init; }
        public required string Dest { get; init; }
        public string Part => Dest + ".part";
        public long? Expected { get; set; }
        public long Received { get; set; }
        public bool Finished { get; set; }
    }

    private readonly record struct ProbeResult(bool Reachable, long? Size, int? Status);

    /// <summary>HEAD 探测文件大小；不支持/失败时退回 Range: 0-0 的 GET。</summary>
    private async Task<ProbeResult> ProbeAsync(string url, CancellationToken ct)
    {
        try
        {
            using var head = new HttpRequestMessage(HttpMethod.Head, url);
            using var resp = await _http.SendAsync(head, HttpCompletionOption.ResponseHeadersRead, ct);
            if (resp.IsSuccessStatusCode)
            {
                var size = resp.Content.Headers.ContentLength;
                return new ProbeResult(true, size is > 0 ? size : null, (int)resp.StatusCode);
            }
            if (resp.StatusCode is HttpStatusCode.NotFound or HttpStatusCode.Forbidden)
            {
                return new ProbeResult(false, null, (int)resp.StatusCode);
            }
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch
        {
            // 网络异常 → 继续尝试 Range 探测
        }

        try
        {
            using var ranged = new HttpRequestMessage(HttpMethod.Get, url);
            ranged.Headers.Range = new RangeHeaderValue(0, 0);
            using var resp = await _http.SendAsync(ranged, HttpCompletionOption.ResponseHeadersRead, ct);
            if (resp.StatusCode == HttpStatusCode.PartialContent)
            {
                var total = resp.Content.Headers.ContentRange?.Length;
                return new ProbeResult(true, total is > 0 ? total : null, 206);
            }
            if (resp.IsSuccessStatusCode)
            {
                var size = resp.Content.Headers.ContentLength;
                return new ProbeResult(true, size is > 0 ? size : null, (int)resp.StatusCode);
            }
            return new ProbeResult(false, null, (int)resp.StatusCode);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch
        {
            return new ProbeResult(false, null, null);
        }
    }

    /// <summary>下载单文件（.part 续传；完成后覆盖改名）。</summary>
    private async Task<long> DownloadFileAsync(DownloadTask task, CancellationToken ct, Action<long> onReceived)
    {
        var part = task.Part;
        // 子目录（如 onnx/）可能不存在：先建父目录再开写
        var parent = Path.GetDirectoryName(part);
        if (!string.IsNullOrEmpty(parent)) Directory.CreateDirectory(parent);
        var start = File.Exists(part) ? new FileInfo(part).Length : 0;
        try
        {
            await DownloadAttemptAsync(task.Url, part, start, ct, onReceived);
        }
        catch (Exception ex) when (start > 0 && ex is not OperationCanceledException)
        {
            // 续传起点失效（416 等）：清残片从头再来一次（保留取消语义）
            try { File.Delete(part); } catch { /* 清理失败则覆盖写 */ }
            await DownloadAttemptAsync(task.Url, part, 0, ct, onReceived);
        }

        var size = File.Exists(part) ? new FileInfo(part).Length : 0;
        if (size < task.File.MinBytes)
        {
            throw new ModelDownloadException($"{task.File.Rel} 下载不完整（{size} < {task.File.MinBytes} 字节）", task.File.Rel);
        }
        File.Move(part, task.Dest, overwrite: true);
        return size;
    }

    private async Task DownloadAttemptAsync(string url, string part, long start, CancellationToken ct, Action<long> onReceived)
    {
        // 目标子目录（如 onnx/）可能尚不存在：写 .part 前确保父目录就绪
        var partDir = Path.GetDirectoryName(part);
        if (!string.IsNullOrEmpty(partDir)) Directory.CreateDirectory(partDir);

        using var request = new HttpRequestMessage(HttpMethod.Get, url);
        if (start > 0) request.Headers.Range = new RangeHeaderValue(start, null);
        using var response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
        if (!response.IsSuccessStatusCode)
        {
            throw new ModelDownloadException($"下载失败：HTTP {(int)response.StatusCode}（可尝试切换镜像源）");
        }

        var append = start > 0 && response.StatusCode == HttpStatusCode.PartialContent;
        var received = append ? start : 0;
        await using var stream = await response.Content.ReadAsStreamAsync(ct);
        await using var file = new FileStream(
            part,
            append ? FileMode.Append : FileMode.Create,
            FileAccess.Write,
            FileShare.None,
            BufferSize,
            useAsync: true);
        var buffer = new byte[BufferSize];
        while (true)
        {
            ct.ThrowIfCancellationRequested();
            var read = await stream.ReadAsync(buffer.AsMemory(0, buffer.Length), ct);
            if (read <= 0) break;
            await file.WriteAsync(buffer.AsMemory(0, read), ct);
            received += read;
            onReceived(received);
        }
        await file.FlushAsync(ct);
    }
}

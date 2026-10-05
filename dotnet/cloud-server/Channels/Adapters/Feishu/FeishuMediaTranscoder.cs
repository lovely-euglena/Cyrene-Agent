using System.Buffers.Binary;
using System.Diagnostics;

namespace CyreneCloud.Channels.Adapters.Feishu;

/// <summary>转码失败（不可用/超时/ffmpeg 非零退出/输出非法）；调用方据此降级文本。</summary>
public sealed class FeishuTranscodeException : Exception
{
    public string ErrorCode { get; }

    public FeishuTranscodeException(string errorCode, string message) : base(message)
    {
        ErrorCode = errorCode;
    }
}

/// <summary>进程执行结果（退出码 + stderr 截断）。</summary>
public sealed record FeishuProcessResult(int ExitCode, string StandardError);

/// <summary>进程执行器注入点（单测用 mock 替代真实 ffmpeg；生产用 <see cref="FeishuMediaTranscoder.RunProcessAsync"/>）。</summary>
public delegate Task<FeishuProcessResult> FeishuProcessRunner(
    string executable, IReadOnlyList<string> arguments, TimeSpan timeout, CancellationToken cancellationToken);

/// <summary>
/// 飞书音频转码（§6.3）：出站语音要求 Ogg Opus（单声道 48k），用镜像内 ffmpeg 转码。
///
/// 约束：并发 1（<see cref="SemaphoreSlim"/>）、30s 超时、输出校验 OggS 魔数、失败清理临时文件。
/// ffmpeg 路径解析：CLOUD_CHANNEL_FEISHU_FFMPEG → FFMPEG_PATH → PATH 中的 `ffmpeg`。
/// 不可用时抛 <see cref="FeishuTranscodeException"/>，适配器降级为文本提示（CLOUD_CHANNEL_FEISHU_AUDIO=0 同口径）。
/// </summary>
public sealed class FeishuMediaTranscoder
{
    public const string ExecutableEnv = "CLOUD_CHANNEL_FEISHU_FFMPEG";
    public const string ErrorUnavailable = "E_FEISHU_TRANSCODE_UNAVAILABLE";
    public const string ErrorFailed = "E_FEISHU_TRANSCODE_FAILED";
    public const string ErrorTimeout = "E_FEISHU_TRANSCODE_TIMEOUT";
    public const string ErrorOutput = "E_FEISHU_TRANSCODE_OUTPUT";

    public static readonly TimeSpan DefaultTimeout = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan ProbeTimeout = TimeSpan.FromSeconds(10);

    private readonly string? _executable;
    private readonly TimeSpan _timeout;
    private readonly FeishuProcessRunner _runner;
    private readonly ILogger<FeishuMediaTranscoder>? _logger;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private bool? _available;

    public FeishuMediaTranscoder(
        string? executablePath = null,
        TimeSpan? timeout = null,
        FeishuProcessRunner? runner = null,
        ILogger<FeishuMediaTranscoder>? logger = null)
    {
        _executable = string.IsNullOrWhiteSpace(executablePath) ? ResolveExecutable() : executablePath.Trim();
        _timeout = timeout ?? DefaultTimeout;
        _runner = runner ?? RunProcessAsync;
        _logger = logger;
    }

    public string? ExecutablePath => _executable;

    /// <summary>解析 ffmpeg 可执行路径（未配置时返回 PATH 上的 `ffmpeg`，是否存在由探针判定）。</summary>
    public static string? ResolveExecutable()
    {
        var configured = Environment.GetEnvironmentVariable(ExecutableEnv);
        if (!string.IsNullOrWhiteSpace(configured)) return configured.Trim();
        var generic = Environment.GetEnvironmentVariable("FFMPEG_PATH");
        if (!string.IsNullOrWhiteSpace(generic)) return generic.Trim();
        return "ffmpeg";
    }

    /// <summary>可用性探针（`ffmpeg -version` 退出码 0）；结果缓存，进程内只探一次。</summary>
    public async Task<bool> IsAvailableAsync(CancellationToken cancellationToken = default)
    {
        if (_available is bool cached) return cached;
        if (string.IsNullOrEmpty(_executable))
        {
            _available = false;
            return false;
        }
        try
        {
            var result = await _runner(
                _executable, ["-hide_banner", "-version"], ProbeTimeout, cancellationToken).ConfigureAwait(false);
            _available = result.ExitCode == 0;
        }
        catch (Exception ex)
        {
            _logger?.LogInformation("ffmpeg 探针失败（按不可用处理）: {Message}", ex.Message);
            _available = false;
        }
        return _available.Value;
    }

    /// <summary>
    /// 转码为 Ogg Opus：`-vn -ac 1 -ar 48000 -c:a libopus`，输出到 <paramref name="outputDir"/>。
    /// 成功返回输出文件路径（调用方负责上传后清理）；失败抛异常且不残留输出文件。
    /// </summary>
    public async Task<string> TranscodeToOggOpusAsync(
        string inputPath, string outputDir, CancellationToken cancellationToken = default)
    {
        if (!await IsAvailableAsync(cancellationToken).ConfigureAwait(false))
        {
            throw new FeishuTranscodeException(ErrorUnavailable, "ffmpeg 不可用，无法转码为飞书 Ogg Opus");
        }
        if (!File.Exists(inputPath))
        {
            throw new FeishuTranscodeException(ErrorFailed, $"输入音频不存在: {Path.GetFileName(inputPath)}");
        }

        Directory.CreateDirectory(outputDir);
        var outputPath = Path.Combine(
            outputDir, $"{Path.GetFileNameWithoutExtension(inputPath)}-{Guid.NewGuid():N}.ogg");

        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            var arguments = new[]
            {
                "-hide_banner", "-loglevel", "error", "-y",
                "-i", inputPath,
                "-vn", "-ac", "1", "-ar", "48000", "-c:a", "libopus", "-b:a", "32k",
                outputPath,
            };
            var result = await _runner(_executable!, arguments, _timeout, cancellationToken).ConfigureAwait(false);
            if (result.ExitCode != 0)
            {
                throw new FeishuTranscodeException(
                    ErrorFailed, $"ffmpeg exit={result.ExitCode}: {Truncate(result.StandardError, 200)}");
            }
            if (!File.Exists(outputPath) || !IsOggOpusFile(outputPath))
            {
                throw new FeishuTranscodeException(ErrorOutput, "ffmpeg 输出不是有效的 Ogg Opus 文件");
            }
            return outputPath;
        }
        catch
        {
            TryDelete(outputPath);
            throw;
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>Ogg 魔数校验（前 4 字节 "OggS"）。</summary>
    public static bool IsOggOpusFile(string path)
    {
        try
        {
            using var stream = File.OpenRead(path);
            Span<byte> header = stackalloc byte[4];
            return stream.Read(header) == 4
                && header[0] == (byte)'O' && header[1] == (byte)'g'
                && header[2] == (byte)'g' && header[3] == (byte)'S';
        }
        catch (IOException)
        {
            return false;
        }
    }

    /// <summary>
    /// 读取 Ogg Opus 时长（毫秒，与桌面 SDK parseOpusDuration 同口径：从文件尾部找最后一个
    /// OggS 页，granule_position（48kHz 采样数）/ 48）。上传 opus 时飞书要求显式 duration。
    /// 无法解析返回 null（调用方按缺省处理）。
    /// </summary>
    public static long? TryReadOggOpusDurationMs(string path)
    {
        try
        {
            var buffer = File.ReadAllBytes(path);
            if (buffer.Length < 27) return null;
            for (var i = buffer.Length - 27; i >= 0; i--)
            {
                if (buffer[i] != (byte)'O' || buffer[i + 1] != (byte)'g'
                    || buffer[i + 2] != (byte)'g' || buffer[i + 3] != (byte)'S')
                {
                    continue;
                }
                var granule = BinaryPrimitives.ReadInt64LittleEndian(buffer.AsSpan(i + 6));
                if (granule < 0) return null;
                // JS Math.round 为四舍五入（非 banker's rounding）
                return (long)Math.Floor((double)granule / 48 + 0.5);
            }
            return null;
        }
        catch (IOException)
        {
            return null;
        }
        catch (UnauthorizedAccessException)
        {
            return null;
        }
    }

    /// <summary>
    /// 真实进程执行（生产默认）：stderr/stdout 排空防死锁；超时 kill 进程树。
    /// 超时/启动失败包成 <see cref="FeishuTranscodeException"/>，便于调用方统一降级。
    /// </summary>
    public static async Task<FeishuProcessResult> RunProcessAsync(
        string executable, IReadOnlyList<string> arguments, TimeSpan timeout, CancellationToken cancellationToken)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = executable,
            RedirectStandardError = true,
            RedirectStandardOutput = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        foreach (var argument in arguments) startInfo.ArgumentList.Add(argument);

        using var process = new Process { StartInfo = startInfo };
        try
        {
            if (!process.Start())
            {
                throw new FeishuTranscodeException(ErrorUnavailable, "ffmpeg 进程启动失败");
            }
        }
        catch (FeishuTranscodeException)
        {
            throw;
        }
        catch (Exception ex)
        {
            throw new FeishuTranscodeException(ErrorUnavailable, $"ffmpeg 不可用: {ex.Message}");
        }

        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        linked.CancelAfter(timeout);
        var stderrTask = process.StandardError.ReadToEndAsync();
        var stdoutTask = process.StandardOutput.ReadToEndAsync();
        try
        {
            await process.WaitForExitAsync(linked.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            try
            {
                process.Kill(entireProcessTree: true);
            }
            catch
            {
                // 进程可能已退出
            }
            if (cancellationToken.IsCancellationRequested) throw;
            throw new FeishuTranscodeException(
                ErrorTimeout, $"ffmpeg 超时（{timeout.TotalSeconds:0}s）");
        }

        string stderr;
        try
        {
            stderr = (await stderrTask.ConfigureAwait(false)).Trim();
        }
        catch
        {
            stderr = "";
        }
        try
        {
            await stdoutTask.ConfigureAwait(false);
        }
        catch
        {
            // stdout 内容不参与判定
        }
        return new FeishuProcessResult(process.ExitCode, Truncate(stderr, 4000));
    }

    private static string Truncate(string value, int max) =>
        value.Length <= max ? value : value[..max] + "…";

    private static void TryDelete(string path)
    {
        try
        {
            if (File.Exists(path)) File.Delete(path);
        }
        catch
        {
            // best-effort 清理
        }
    }
}

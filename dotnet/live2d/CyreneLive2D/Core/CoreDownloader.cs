// Cubism Core 运行时下载器（T0）。
//
// License 合规：Core 二进制不随仓分发（任务书硬约束）。首次 load 缺 Core 时
// 从 Live2D 官方源下载 SDK zip → SHA256 校验 → 仅提取 windows/x86_64 Core DLL
// 落盘 {dataDir}/live2d-core/Live2DCubismCore.dll（CoreLibrary 解析位 2）。
// zip 用后即删（26MB，不留存）。
//
// 模式与 ModelDownloader 同例：.part 续传 + 原子改名 + 可取消 + 进度回调 +
// 可注入 HttpMessageHandler（自测离线）。SDK 版本升级时同步换 URL/SHA256/条目。

using System.IO.Compression;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Security.Cryptography;

namespace CyreneLive2D.Core;

/// <summary>下载阶段：downloading / verifying / extracting / done。</summary>
public sealed record CoreDownloadProgress(string Phase, long ReceivedBytes, long? TotalBytes, int? Percent);

/// <summary>Core 下载失败（网络/校验/解包）。宿主据此回 E_CORE_DOWNLOAD。</summary>
public sealed class CoreDownloadException(string message) : Exception(message);

public static class CoreDownloader
{
    public const string SdkUrl = "https://cubism.live2d.com/sdk-native/bin/CubismSdkForNative-5-r.5.zip";
    public const string SdkSha256 = "7FF3A4BBC19C0A8728965AA522AB77EB11B252916453E68A8A78D3B71188BB12";
    public const string DllZipEntry = "CubismSdkForNative-5-r.5/Core/dll/windows/x86_64/Live2DCubismCore.dll";

    private const int BufferSize = 81920;
    private const int ProgressIntervalMs = 250;

    public static string InstallDir(string dataDir) => Path.Combine(dataDir, "live2d-core");
    public static string InstallPath(string dataDir) => Path.Combine(InstallDir(dataDir), CoreLibrary.DllFileName);
    public static bool IsInstalled(string dataDir) => File.Exists(InstallPath(dataDir));

    /// <summary>
    /// 下载并安装 Core DLL；已安装直接返回路径。失败抛 <see cref="CoreDownloadException"/>
    /// （取消抛 OperationCanceledException）。
    /// </summary>
    public static async Task<string> DownloadAsync(
        string dataDir,
        Action<CoreDownloadProgress>? onProgress = null,
        CancellationToken ct = default,
        HttpMessageHandler? handler = null)
    {
        var dest = InstallPath(dataDir);
        if (File.Exists(dest)) return dest;

        var dir = InstallDir(dataDir);
        Directory.CreateDirectory(dir);
        var zipPath = Path.Combine(dir, "CubismSdkForNative-5-r.5.zip");
        var part = zipPath + ".part";

        using var http = new HttpClient(handler ?? new HttpClientHandler())
        {
            Timeout = Timeout.InfiniteTimeSpan,
        };

        long lastEmit = 0;
        void Emit(string phase, long received, long? total, bool force = false)
        {
            if (onProgress is null) return;
            var now = Environment.TickCount64;
            if (!force && now - lastEmit < ProgressIntervalMs) return;
            lastEmit = now;
            int? percent = total is > 0 ? (int)Math.Min(100, received * 100 / total.Value) : null;
            onProgress(new CoreDownloadProgress(phase, received, total, percent));
        }

        // ── 下载（.part 续传；起点失效清残片重来一次） ──
        var start = File.Exists(part) ? new FileInfo(part).Length : 0;
        long received = start;
        long? total = null;
        Emit("downloading", received, null, force: true);
        try
        {
            (received, total) = await DownloadAttemptAsync(http, part, start, ct, r => Emit("downloading", r, total));
        }
        catch (Exception ex) when (start > 0 && ex is not OperationCanceledException)
        {
            try { File.Delete(part); } catch { /* 清理失败则覆盖写 */ }
            (received, total) = await DownloadAttemptAsync(http, part, 0, ct, r => Emit("downloading", r, total));
        }
        Emit("downloading", received, total, force: true);

        // ── SHA256 校验（不匹配即删，防损坏/投毒落盘） ──
        Emit("verifying", received, total, force: true);
        var hash = await Sha256FileAsync(part, ct);
        if (!string.Equals(hash, SdkSha256, StringComparison.OrdinalIgnoreCase))
        {
            try { File.Delete(part); } catch { /* 尽力清理 */ }
            throw new CoreDownloadException(
                $"SDK zip SHA256 不匹配（期望 {SdkSha256}，实际 {hash}）——下载损坏或官方源已更新，请重试或检查版本 pin。");
        }
        File.Move(part, zipPath, overwrite: true);

        // ── 仅提取 Core DLL（.part + 原子改名），zip 用后即删 ──
        Emit("extracting", received, total, force: true);
        try
        {
            ExtractCoreDll(zipPath, dest);
        }
        finally
        {
            try { File.Delete(zipPath); } catch { /* 清理失败不影响结论 */ }
        }

        Emit("done", received, total, force: true);
        return dest;
    }

    /// <summary>从 SDK zip 提取 Core DLL 到 dest（.part + 原子改名）。自测可离线调用。</summary>
    internal static void ExtractCoreDll(string zipPath, string dest)
    {
        using var zip = ZipFile.OpenRead(zipPath);
        var entry = zip.GetEntry(DllZipEntry)
            ?? throw new CoreDownloadException($"zip 内未找到 Core DLL 条目: {DllZipEntry}");
        var parent = Path.GetDirectoryName(dest);
        if (!string.IsNullOrEmpty(parent)) Directory.CreateDirectory(parent);
        var dllPart = dest + ".part";
        using (var src = entry.Open())
        using (var dst = new FileStream(dllPart, FileMode.Create, FileAccess.Write, FileShare.None, BufferSize))
        {
            src.CopyTo(dst, BufferSize);
        }
        File.Move(dllPart, dest, overwrite: true);
    }

    /// <summary>流式 SHA256（小写十六进制）。自测可离线调用。</summary>
    internal static async Task<string> Sha256FileAsync(string path, CancellationToken ct)
    {
        await using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, BufferSize, useAsync: true);
        using var sha = SHA256.Create();
        var hash = await sha.ComputeHashAsync(stream, ct);
        return Convert.ToHexString(hash);
    }

    private static async Task<(long received, long? total)> DownloadAttemptAsync(
        HttpClient http, string part, long start, CancellationToken ct, Action<long> onReceived)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, SdkUrl);
        if (start > 0) request.Headers.Range = new RangeHeaderValue(start, null);
        using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
        if (!response.IsSuccessStatusCode)
        {
            throw new CoreDownloadException($"Core SDK 下载失败：HTTP {(int)response.StatusCode}（{SdkUrl}）");
        }

        var append = start > 0 && response.StatusCode == HttpStatusCode.PartialContent;
        var received = append ? start : 0;
        long? total = append
            ? response.Content.Headers.ContentRange?.Length
            : response.Content.Headers.ContentLength;

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
        return (received, total);
    }
}
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Text.Json;

namespace CyreneNative;

/// <summary>
/// mpv 子进程控制（named-pipe JSON IPC，随包 resources/bin/mpv/mpv.exe）：
///   - 启动：--no-video --idle=yes --force-window=no --input-ipc-server=\\.\pipe\...
///   - 命令：loadfile / set_property pause|volume / seek / stop；
///   - 事件：observe_property（time-pos/duration/pause/eof-reached/volume）+ end-file；
///   - 退出：quit/kill（entireProcessTree），应用退出时由 MusicService.Dispose 兜底。
/// 事件在 IPC 读线程上触发，订阅方自行 marshal 到 UI 线程。
/// </summary>
public sealed class MpvController : IDisposable
{
    private readonly object _lock = new();
    private Process? _process;
    private NamedPipeClientStream? _pipe;
    private StreamWriter? _writer;
    private volatile bool _disposed;

    public event Action<double?>? PositionChanged;
    public event Action<double?>? DurationChanged;
    public event Action<bool>? PauseChanged;
    public event Action<bool>? EndReachedChanged;
    public event Action<int>? VolumeChanged;
    /// <summary>end-file 事件：reason = eof / stop / error / quit。</summary>
    public event Action<string>? EndFile;

    public bool IsRunning
    {
        get
        {
            lock (_lock) return _process is { HasExited: false };
        }
    }

    /// <summary>启动 mpv 并连接 IPC；失败返回 false（调用方回退为 idle 状态）。</summary>
    public bool Start(string exePath, int volume, string? audioDevice = null)
    {
        Stop();
        _disposed = false;

        var pipeName = $"cyrene-music-{Environment.ProcessId}-{Guid.NewGuid():N}";
        var psi = new ProcessStartInfo
        {
            FileName = exePath,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };
        foreach (var argument in new[]
                 {
                     "--no-video",
                     "--idle=yes",
                     "--force-window=no",
                     "--no-terminal",
                     "--gapless-audio=yes",
                     $"--volume={Math.Clamp(volume, 0, 100)}",
                     $@"--input-ipc-server=\\.\pipe\{pipeName}",
                 })
        {
            psi.ArgumentList.Add(argument);
        }
        if (!string.IsNullOrWhiteSpace(audioDevice) && audioDevice != "auto")
        {
            psi.ArgumentList.Add($"--audio-device={audioDevice}");
        }

        Process process;
        try
        {
            process = Process.Start(psi)!;
        }
        catch
        {
            return false;
        }
        // 管道不读空会阻塞子进程：后台排空 stdout/stderr
        _ = Task.Run(() => { try { process.StandardOutput.ReadToEnd(); } catch { } });
        _ = Task.Run(() => { try { process.StandardError.ReadToEnd(); } catch { } });

        NamedPipeClientStream? pipe = null;
        for (var attempt = 0; attempt < 50 && !process.HasExited; attempt++)
        {
            try
            {
                // 必须 Asynchronous：同一管道上同步读会阻塞写（.NET PipeStream 同步路径串行化）
                var candidate = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
                candidate.Connect(100);
                pipe = candidate;
                break;
            }
            catch
            {
                Thread.Sleep(100);
            }
        }
        if (pipe is null)
        {
            TryKill(process);
            return false;
        }

        lock (_lock)
        {
            _process = process;
            _pipe = pipe;
            _writer = new StreamWriter(pipe, new UTF8Encoding(false)) { AutoFlush = true };
        }
        var readThread = new Thread(() => ReadLoop(pipe)) { IsBackground = true, Name = "music-mpv-ipc" };
        readThread.Start();

        Observe(1, "time-pos");
        Observe(2, "duration");
        Observe(3, "pause");
        Observe(4, "eof-reached");
        Observe(5, "volume");
        return true;
    }

    public void Load(string path)
    {
        Send("loadfile", path, "replace");
    }

    public void SetPause(bool paused)
    {
        Send("set_property", "pause", paused);
    }

    public void SeekAbsolute(double seconds)
    {
        Send("seek", Math.Max(0, seconds), "absolute");
    }

    public void SetVolume(int volume)
    {
        Send("set_property", "volume", Math.Clamp(volume, 0, 100));
    }

    /// <summary>
    /// 运行时切换音频输出设备（mpv 收到后调度音频输出重init，无需重启进程）。
    /// 传入设备名须来自 <c>--audio-device=help</c> / <c>audio-device-list</c>。
    /// </summary>
    public void SetAudioDevice(string device)
    {
        Send("set_property", "audio-device", device);
    }

    public void StopPlayback()
    {
        Send("stop");
    }

    private void Observe(int id, string name)
    {
        Send("observe_property", id, name);
    }

    private void Send(params object[] command)
    {
        string json;
        try
        {
            json = JsonSerializer.Serialize(new { command });
        }
        catch
        {
            return;
        }
        lock (_lock)
        {
            try
            {
                _writer?.WriteLine(json);
            }
            catch
            {
                // 管道已断：由 Stop/Dispose 收尾
            }
        }
    }

    private void ReadLoop(NamedPipeClientStream pipe)
    {
        try
        {
            using var reader = new StreamReader(pipe, Encoding.UTF8);
            while (!_disposed)
            {
                var line = reader.ReadLineAsync().GetAwaiter().GetResult();
                if (line is null) break;
                if (line.Length == 0 || line[0] != '{') continue;
                try
                {
                    using var document = JsonDocument.Parse(line);
                    HandleMessage(document.RootElement);
                }
                catch
                {
                    // 非法 JSON 行忽略
                }
            }
        }
        catch
        {
            // 管道断开：进程退出路径
        }
    }

    private void HandleMessage(JsonElement root)
    {
        if (!root.TryGetProperty("event", out var eventElement)) return;
        switch (eventElement.GetString())
        {
            case "property-change":
            {
                var name = root.TryGetProperty("name", out var nameElement) ? nameElement.GetString() : null;
                var hasData = root.TryGetProperty("data", out var data) &&
                              data.ValueKind is not (JsonValueKind.Null or JsonValueKind.Undefined);
                switch (name)
                {
                    case "time-pos":
                        PositionChanged?.Invoke(hasData && data.TryGetDouble(out var position) ? position : null);
                        break;
                    case "duration":
                        DurationChanged?.Invoke(hasData && data.TryGetDouble(out var duration) ? duration : null);
                        break;
                    case "pause":
                        PauseChanged?.Invoke(hasData && data.ValueKind == JsonValueKind.True);
                        break;
                    case "eof-reached":
                        EndReachedChanged?.Invoke(hasData && data.ValueKind == JsonValueKind.True);
                        break;
                    case "volume":
                        VolumeChanged?.Invoke(hasData && data.TryGetDouble(out var volume) ? (int)Math.Round(volume) : 0);
                        break;
                }
                break;
            }
            case "end-file":
            {
                var reason = root.TryGetProperty("reason", out var reasonElement) ? reasonElement.GetString() ?? "" : "";
                EndFile?.Invoke(reason);
                break;
            }
        }
    }

    /// <summary>结束 mpv（quit → kill 兜底），可重复调用。</summary>
    public void Stop()
    {
        Process? process;
        NamedPipeClientStream? pipe;
        StreamWriter? writer;
        lock (_lock)
        {
            process = _process;
            pipe = _pipe;
            writer = _writer;
            _process = null;
            _pipe = null;
            _writer = null;
        }
        try
        {
            writer?.WriteLine("{\"command\":[\"quit\"]}");
        }
        catch
        {
            // 已断开
        }
        try
        {
            pipe?.Dispose();
        }
        catch
        {
            // 已释放
        }
        if (process is not null)
        {
            try
            {
                if (!process.WaitForExit(800)) TryKill(process);
                process.WaitForExit(1500);
            }
            catch
            {
                TryKill(process);
            }
            try
            {
                process.Dispose();
            }
            catch
            {
                // 已释放
            }
        }
    }

    private static void TryKill(Process process)
    {
        try
        {
            if (!process.HasExited) process.Kill(entireProcessTree: true);
        }
        catch
        {
            // 已退出
        }
    }

    public void Dispose()
    {
        _disposed = true;
        Stop();
    }
}

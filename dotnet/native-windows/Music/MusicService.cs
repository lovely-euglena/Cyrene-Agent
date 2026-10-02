using System.IO;
using System.Text.Json;

namespace CyreneNative.Music;

/// <summary>
/// 本地音乐服务（进程内单例，窗口无关）：
///   - 曲库：MusicLibrary（SQLite，增量扫描）；
///   - 播放：MpvController（named-pipe IPC）；
///   - 歌词：LrcParser（侧车 .lrc，P1；内嵌歌词 P2）；
///   - 状态：播放列表/当前曲目/进度/音量/模式，窗口订阅事件刷新，
///     Agent 通过 RequestRouter 的 music.* 请求读写。
///
/// 线程：请求来自协议线程，UI 事件在 mpv IPC 读线程触发；订阅方自行 marshal。
/// </summary>
public sealed class MusicService : IDisposable
{
    public static MusicService Shared { get; } = new();

    public sealed record TrackDto(
        string Path,
        string Folder,
        string Title,
        string Artist,
        string Album,
        string Ext,
        long Size);

    public sealed record NowPlayingState(
        string Status,
        string? Path,
        string Title,
        string Artist,
        string Album,
        double PositionSec,
        double DurationSec,
        bool Paused,
        int Volume,
        string Mode,
        int QueueIndex,
        int QueueCount,
        bool HasLyrics,
        string LyricLine,
        string? LyricTranslation);

    private readonly object _lock = new();
    private MusicLibrary? _library;
    private MpvController? _mpv;
    private string _mpvPath = "";
    private string _dbPath = "";
    private List<string> _folders = new();
    private List<MusicLibrary.MusicTrack> _queue = new();
    private int _queueIndex = -1;
    private LrcParser.LrcDocument? _lyrics;
    private long _positionMs;
    private long _durationMs;
    private bool _paused = true;
    private int _volume = 80;
    private string _mode = "list";
    private string _status = "idle";
    private bool _scanning;
    private bool _disposed;

    public event Action? StateChanged;
    public event Action<double>? PositionTick;
    public event Action<string>? Notice;
    public event Action? LibraryChanged;

    public List<string> Folders
    {
        get { lock (_lock) return _folders.ToList(); }
    }

    public bool IsScanning
    {
        get { lock (_lock) return _scanning; }
    }

    // ── 配置 ──

    public object ApplyConfig(JsonElement config)
    {
        var dbPath = GetString(config, "dbPath");
        var mpvPath = GetString(config, "mpvPath");
        var folders = GetStringArray(config, "folders");
        var volume = GetInt(config, "volume", 0);

        var foldersChanged = false;
        lock (_lock)
        {
            if (!string.IsNullOrWhiteSpace(dbPath) && dbPath != _dbPath)
            {
                _dbPath = dbPath;
                _library = null;
            }
            if (!string.IsNullOrWhiteSpace(mpvPath)) _mpvPath = mpvPath;
            if (volume is > 0 and <= 100) _volume = volume;
            if (!folders.SequenceEqual(_folders, StringComparer.OrdinalIgnoreCase))
            {
                _folders = folders;
                foldersChanged = true;
            }
        }
        EnsureLibrary();
        if (foldersChanged) Rescan();
        return new { folders = ListFolders(), scanning = IsScanning };
    }

    private void EnsureLibrary()
    {
        lock (_lock)
        {
            if (_library is not null) return;
            var dbPath = string.IsNullOrWhiteSpace(_dbPath)
                ? Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                    "cyrene", "music", "music-library.db")
                : _dbPath;
            _library = new MusicLibrary(dbPath);
        }
    }

    // ── 查询 ──

    public object Query(JsonElement payload)
    {
        EnsureLibrary();
        var search = GetString(payload, "search");
        var folder = GetString(payload, "folder");
        var limit = GetInt(payload, "limit", 300);
        var tracks = _library!.Query(search, folder, limit).Select(ToDto).ToList();
        return new { tracks, total = _library.Count(), folders = ListFolders(), scanning = IsScanning };
    }

    public object ListFolders()
    {
        EnsureLibrary();
        return _library!.ListFolders().Select(entry => new { path = entry.Path, trackCount = entry.TrackCount }).ToList();
    }

    /// <summary>窗口直连：按条件取曲目 DTO。</summary>
    public List<TrackDto> SearchTracks(string search, string folder, int limit = 300)
    {
        EnsureLibrary();
        return _library!.Query(search, folder, limit).Select(ToDto).ToList();
    }

    public int TotalTracks()
    {
        EnsureLibrary();
        return _library!.Count();
    }

    public List<MusicLibrary.FolderEntry> FolderEntries()
    {
        EnsureLibrary();
        return _library!.ListFolders();
    }

    public NowPlayingState NowPlaying()
    {
        lock (_lock)
        {
            MusicLibrary.MusicTrack? track = _queueIndex >= 0 && _queueIndex < _queue.Count ? _queue[_queueIndex] : null;
            var lineIndex = _lyrics is not null ? LrcParser.FindLineIndex(_lyrics.Lines, _lyrics.OffsetMs, _positionMs) : -1;
            var line = lineIndex >= 0 && lineIndex < (_lyrics?.Lines.Count ?? 0) ? _lyrics!.Lines[lineIndex] : null;
            return new NowPlayingState(
                _status,
                track?.Path,
                track?.Title ?? "",
                track?.Artist ?? "",
                track?.Album ?? "",
                _positionMs / 1000.0,
                _durationMs / 1000.0,
                _paused,
                _volume,
                _mode,
                _queueIndex,
                _queue.Count,
                _lyrics is { Lines.Count: > 0 },
                line?.Text ?? "",
                line?.Translation);
        }
    }

    private static TrackDto ToDto(MusicLibrary.MusicTrack track) =>
        new(track.Path, track.Folder, track.Title, track.Artist, track.Album, track.Ext, track.Size);

    // ── 播放 ──

    public object Play(JsonElement payload)
    {
        EnsureLibrary();
        var paths = GetStringArray(payload, "paths");
        var path = GetString(payload, "path");
        var search = GetString(payload, "search");
        var folder = GetString(payload, "folder");

        List<MusicLibrary.MusicTrack> queue;
        if (paths.Count > 0)
        {
            queue = paths.Select(ResolveTrack).Where(track => track is not null).Cast<MusicLibrary.MusicTrack>().ToList();
        }
        else if (!string.IsNullOrWhiteSpace(path))
        {
            var track = ResolveTrack(path);
            queue = track is null ? new List<MusicLibrary.MusicTrack>() : new List<MusicLibrary.MusicTrack> { track };
        }
        else
        {
            queue = _library!.Query(search, folder, 500);
        }
        if (queue.Count == 0) return new { ok = false, error = "曲库中没有匹配的曲目" };

        var index = 0;
        if (!string.IsNullOrWhiteSpace(path))
        {
            var found = queue.FindIndex(track => string.Equals(track.Path, path, StringComparison.OrdinalIgnoreCase));
            if (found >= 0) index = found;
        }
        lock (_lock)
        {
            _queue = queue;
        }
        PlayIndex(index);
        return new { ok = true, nowPlaying = NowPlaying() };
    }

    private MusicLibrary.MusicTrack? ResolveTrack(string path)
    {
        if (string.IsNullOrWhiteSpace(path)) return null;
        var known = _library!.GetTrack(path);
        if (known is not null) return known;
        try
        {
            if (!File.Exists(path)) return null;
            var (title, artist) = MusicLibrary.DeriveNames(path);
            var info = new FileInfo(path);
            return new MusicLibrary.MusicTrack(
                path,
                Path.GetDirectoryName(path) ?? "",
                title,
                artist,
                Path.GetFileName(Path.GetDirectoryName(path) ?? "") ?? "",
                Path.GetExtension(path).ToLowerInvariant(),
                info.Length,
                info.LastWriteTimeUtc.Ticks);
        }
        catch
        {
            return null;
        }
    }

    private void PlayIndex(int index)
    {
        MusicLibrary.MusicTrack track;
        lock (_lock)
        {
            if (index < 0 || index >= _queue.Count) return;
            _queueIndex = index;
            track = _queue[index];
            _positionMs = 0;
            _durationMs = 0;
            _paused = false;
            _status = "loading";
            _lyrics = LrcParser.ParseSidecar(track.Path);
        }

        if (!EnsureMpv())
        {
            lock (_lock) _status = "idle";
            Notice?.Invoke("mpv 启动失败，无法播放");
            StateChanged?.Invoke();
            return;
        }
        _mpv!.Load(track.Path);
        _mpv.SetPause(false);
        StateChanged?.Invoke();
    }

    private bool EnsureMpv()
    {
        lock (_lock)
        {
            if (_mpv is { IsRunning: true }) return true;
        }
        var exe = ResolveMpvPath();
        if (exe is null) return false;
        var controller = new MpvController();
        controller.PositionChanged += seconds =>
        {
            lock (_lock)
            {
                _positionMs = seconds is null ? 0 : (long)(seconds.Value * 1000);
                // 只有新曲目加载中才由进度事件推进为播放中；停止后的残留事件不得复活
                if (_status == "loading") _status = "playing";
            }
            if (seconds is not null) PositionTick?.Invoke(seconds.Value);
        };
        controller.DurationChanged += seconds =>
        {
            lock (_lock) _durationMs = seconds is null ? 0 : (long)(seconds.Value * 1000);
            StateChanged?.Invoke();
        };
        controller.PauseChanged += paused =>
        {
            lock (_lock)
            {
                _paused = paused;
                if (_status is "playing" or "paused") _status = paused ? "paused" : "playing";
            }
            StateChanged?.Invoke();
        };
        controller.VolumeChanged += volume =>
        {
            lock (_lock) _volume = volume;
            StateChanged?.Invoke();
        };
        controller.EndFile += reason =>
        {
            if (reason == "eof") Advance(auto: true);
            else if (reason is "stop" or "quit")
            {
                lock (_lock) _status = "idle";
                StateChanged?.Invoke();
            }
        };

        var volume = _volume;
        if (!controller.Start(exe, volume))
        {
            controller.Dispose();
            return false;
        }
        lock (_lock)
        {
            _mpv = controller;
        }
        return true;
    }

    private string? ResolveMpvPath()
    {
        lock (_lock)
        {
            if (!string.IsNullOrWhiteSpace(_mpvPath) && File.Exists(_mpvPath)) return _mpvPath;
        }
        // 打包态：resources/native-windows → resources/bin/mpv/mpv.exe
        var packaged = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "bin", "mpv", "mpv.exe"));
        if (File.Exists(packaged)) return packaged;
        // 开发态：dotnet/native-windows/bin/<cfg>/net10.0-windows → <repo>/resources/bin/mpv/mpv.exe
        var dev = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", "resources", "bin", "mpv", "mpv.exe"));
        if (File.Exists(dev)) return dev;
        return null;
    }

    // ── 控制 ──

    public object Control(string action, JsonElement payload)
    {
        switch (action)
        {
            case "toggle":
            {
                bool paused;
                lock (_lock) paused = _paused;
                SetPause(!paused);
                break;
            }
            case "pause":
                SetPause(true);
                break;
            case "resume":
                SetPause(false);
                break;
            case "next":
                Advance(auto: false);
                break;
            case "prev":
                Prev();
                break;
            case "seek":
            {
                var seconds = GetDouble(payload, "seconds", -1);
                if (seconds < 0) seconds = GetDouble(payload, "positionMs", 0) / 1000.0;
                lock (_lock)
                {
                    _positionMs = (long)(Math.Max(0, seconds) * 1000);
                }
                _mpv?.SeekAbsolute(Math.Max(0, seconds));
                StateChanged?.Invoke();
                break;
            }
            case "volume":
            {
                var volume = Math.Clamp(GetInt(payload, "volume", _volume), 0, 100);
                lock (_lock) _volume = volume;
                _mpv?.SetVolume(volume);
                StateChanged?.Invoke();
                break;
            }
            case "mode":
            {
                var mode = GetString(payload, "mode");
                if (mode is "list" or "single" or "shuffle")
                {
                    lock (_lock) _mode = mode;
                    StateChanged?.Invoke();
                }
                break;
            }
            case "stop":
            {
                _mpv?.StopPlayback();
                lock (_lock) _status = "idle";
                StateChanged?.Invoke();
                break;
            }
            default:
                return new { ok = false, error = $"未知控制动作 {action}" };
        }
        return new { ok = true, nowPlaying = NowPlaying() };
    }

    private void SetPause(bool paused)
    {
        lock (_lock)
        {
            _paused = paused;
            if (_status is "playing" or "paused") _status = paused ? "paused" : "playing";
        }
        _mpv?.SetPause(paused);
        StateChanged?.Invoke();
    }

    private void Advance(bool auto)
    {
        int index;
        string mode;
        lock (_lock)
        {
            mode = _mode;
            if (_queue.Count == 0) return;
            if (mode == "single" && auto)
            {
                index = _queueIndex;
            }
            else if (mode == "shuffle")
            {
                index = _queue.Count <= 1 ? _queueIndex : NextRandom(_queueIndex, _queue.Count);
            }
            else
            {
                index = _queueIndex + 1;
                if (index >= _queue.Count)
                {
                    if (auto)
                    {
                        lock (_lock) _status = "idle";
                        StateChanged?.Invoke();
                        return;
                    }
                    index = 0;
                }
            }
        }
        PlayIndex(index);
    }

    private int NextRandom(int current, int count)
    {
        if (count <= 1) return current;
        int next;
        do
        {
            next = Random.Shared.Next(count);
        } while (next == current);
        return next;
    }

    private void Prev()
    {
        int index;
        lock (_lock)
        {
            if (_queue.Count == 0) return;
            index = _queueIndex - 1;
            if (index < 0) index = _queue.Count - 1;
        }
        PlayIndex(index);
    }

    // ── 文件夹管理 ──

    public object FolderAction(string action, JsonElement payload) =>
        FolderActionWith(action, GetString(payload, "path"));

    public object AddFolder(string path) => FolderActionWith("add", path);

    public object RemoveFolder(string path) => FolderActionWith("remove", path);

    private object FolderActionWith(string action, string path)
    {
        lock (_lock)
        {
            switch (action)
            {
                case "add":
                    if (string.IsNullOrWhiteSpace(path) || !Directory.Exists(path)) return new { ok = false, error = "目录不存在" };
                    var normalized = Path.GetFullPath(path);
                    if (!_folders.Contains(normalized, StringComparer.OrdinalIgnoreCase)) _folders.Add(normalized);
                    break;
                case "remove":
                    _folders.RemoveAll(folder => string.Equals(folder, path, StringComparison.OrdinalIgnoreCase));
                    break;
                case "list":
                    break;
                default:
                    return new { ok = false, error = $"未知文件夹动作 {action}" };
            }
        }
        var folders = Folders;
        RequestRouter.SendCommand("music", "folders-changed", null, new Dictionary<string, object?> { ["folders"] = folders });
        Rescan();
        return new { ok = true, folders = ListFolders() };
    }

    public object Rescan()
    {
        EnsureLibrary();
        lock (_lock)
        {
            if (_scanning) return new { ok = true, scanning = true };
            _scanning = true;
        }
        var folders = Folders;
        Task.Run(() =>
        {
            try
            {
                _library!.Scan(folders, () => _disposed);
            }
            catch (Exception ex)
            {
                Notice?.Invoke($"扫描失败：{ex.Message}");
            }
            finally
            {
                lock (_lock) _scanning = false;
            }
            LibraryChanged?.Invoke();
            StateChanged?.Invoke();
        });
        return new { ok = true, scanning = true };
    }

    // ── JSON 辅助 ──

    // ── 窗口直连便捷入口（避免窗口侧构造 JsonElement） ──

    public object Toggle() => Control("toggle", default);
    public object NextTrack() => Control("next", default);
    public object PrevTrack() => Control("prev", default);
    public object SeekSeconds(double seconds) => Control("seek", JsonPayload("seconds", seconds));
    public object SetVolumeLevel(int volume) => Control("volume", JsonPayload("volume", volume));
    public object SetMode(string mode) => Control("mode", JsonPayload("mode", mode));
    public object PlayTrack(string path) => Play(JsonPayload("path", path));
    public object StopPlaybackAction() => Control("stop", default);

    private static JsonElement JsonPayload(string name, object value) =>
        JsonSerializer.SerializeToElement(new Dictionary<string, object> { [name] = value });

    private static string GetString(JsonElement element, string name)
    {
        if (element.ValueKind != JsonValueKind.Object) return "";
        if (!element.TryGetProperty(name, out var value) || value.ValueKind != JsonValueKind.String) return "";
        return value.GetString() ?? "";
    }

    private static List<string> GetStringArray(JsonElement element, string name)
    {
        if (element.ValueKind != JsonValueKind.Object) return new List<string>();
        if (!element.TryGetProperty(name, out var value) || value.ValueKind != JsonValueKind.Array) return new List<string>();
        return value.EnumerateArray()
            .Where(item => item.ValueKind == JsonValueKind.String)
            .Select(item => item.GetString() ?? "")
            .Where(item => item.Length > 0)
            .ToList();
    }

    private static int GetInt(JsonElement element, string name, int fallback)
    {
        if (element.ValueKind != JsonValueKind.Object) return fallback;
        if (!element.TryGetProperty(name, out var value)) return fallback;
        return value.ValueKind switch
        {
            JsonValueKind.Number when value.TryGetInt32(out var number) => number,
            _ => fallback,
        };
    }

    private static double GetDouble(JsonElement element, string name, double fallback)
    {
        if (element.ValueKind != JsonValueKind.Object) return fallback;
        if (!element.TryGetProperty(name, out var value)) return fallback;
        return value.ValueKind == JsonValueKind.Number && value.TryGetDouble(out var number) ? number : fallback;
    }

    public void Dispose()
    {
        _disposed = true;
        lock (_lock)
        {
            _mpv?.Dispose();
            _mpv = null;
        }
    }
}

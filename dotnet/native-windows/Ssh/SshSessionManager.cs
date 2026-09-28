using System.Diagnostics;
using System.Text;
using Renci.SshNet;

namespace CyreneNative.Ssh;

internal sealed class SshExecResult
{
    public int? ExitCode { get; set; }
    public string Stdout { get; set; } = "";
    public string Stderr { get; set; } = "";
    public bool Truncated { get; set; }
    public bool TimedOut { get; set; }
    public long DurationMs { get; set; }
}

internal sealed class SshSessionInfo
{
    public string ProfileId { get; set; } = "";
    public string State { get; set; } = "idle";
    public long LastUsedAt { get; set; }
}

/// <summary>
/// SSH 会话托管：连接在 --ssh-host 进程内长期持有（keepalive + 懒重连），
/// 跨多次工具调用复用；每个档案一个会话，命令串行化执行。
///
/// 命令语义：exec 通道非交互执行（无 PTY）；可选 cwd 以 `cd -- '...' &amp;&amp; cmd`
/// 前缀注入。超时用 CancelAsync 尽力取消，远端进程是否真的退出无法保证——
/// 结果里如实返回 timedOut=true（宿主按未知副作用处理）。
/// </summary>
internal sealed class SshSessionManager
{
    private const int MaxCaptureBytes = 2 * 1024 * 1024;

    private readonly SshProfileStore _store;
    private readonly Dictionary<string, Session> _sessions = new();
    private readonly object _gate = new();

    private sealed class Session
    {
        public required string ProfileId { get; init; }
        public SshClient? Client { get; set; }
        /// <summary>idle | connecting | ready | error | closed</summary>
        public string State { get; set; } = "idle";
        public long LastUsedAt { get; set; } = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        public readonly SemaphoreSlim Gate = new(1, 1);
    }

    public SshSessionManager(SshProfileStore store)
    {
        _store = store;
    }

    public List<SshSessionInfo> List()
    {
        lock (_gate)
        {
            return _sessions.Values
                .Select(s => new SshSessionInfo { ProfileId = s.ProfileId, State = s.State, LastUsedAt = s.LastUsedAt })
                .ToList();
        }
    }

    public async Task OpenAsync(string profileId)
    {
        var session = GetOrCreate(profileId);
        await session.Gate.WaitAsync().ConfigureAwait(false);
        try
        {
            EnsureConnected(session, profileId);
        }
        finally
        {
            session.Gate.Release();
        }
    }

    public void Close(string profileId)
    {
        Session? session;
        lock (_gate)
        {
            _sessions.TryGetValue(profileId, out session);
        }
        if (session is null) return;
        session.Gate.Wait();
        try
        {
            try { session.Client?.Disconnect(); } catch { /* 已断开 */ }
            session.Client?.Dispose();
            session.Client = null;
            session.State = "closed";
        }
        finally
        {
            session.Gate.Release();
        }
    }

    public void CloseAll()
    {
        List<string> ids;
        lock (_gate)
        {
            ids = _sessions.Keys.ToList();
        }
        foreach (var id in ids) Close(id);
    }

    public async Task<SshExecResult> ExecAsync(string profileId, string command, string? cwd, int timeoutMs)
    {
        if (string.IsNullOrWhiteSpace(command))
            throw new InvalidOperationException("command 不能为空");

        var session = GetOrCreate(profileId);
        var result = new SshExecResult();
        var stopwatch = Stopwatch.StartNew();

        await session.Gate.WaitAsync().ConfigureAwait(false);
        try
        {
            EnsureConnected(session, profileId);
            var client = session.Client ?? throw new InvalidOperationException("SSH_CONNECT_FAILED: 会话未建立");
            var fullCommand = BuildCommand(command, cwd);

            using var cmd = client.CreateCommand(fullCommand);
            var async = cmd.BeginExecute();
            var effectiveTimeout = Math.Max(1000, timeoutMs);
            var completed = async.AsyncWaitHandle.WaitOne(effectiveTimeout);
            if (!completed)
            {
                result.TimedOut = true;
                try { cmd.CancelAsync(); } catch { /* 尽力取消 */ }
            }
            else
            {
                try
                {
                    cmd.EndExecute(async);
                }
                catch (Exception ex)
                {
                    result.Stderr = ex.Message;
                }
                result.Stdout = Clip(cmd.Result ?? "", out var stdoutClipped);
                result.Stderr = Clip((result.Stderr.Length > 0 ? result.Stderr + "\n" : "") + (cmd.Error ?? ""), out var stderrClipped);
                result.Truncated = stdoutClipped || stderrClipped;
                result.ExitCode = cmd.ExitStatus;
            }

            session.LastUsedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            return result;
        }
        finally
        {
            stopwatch.Stop();
            result.DurationMs = stopwatch.ElapsedMilliseconds;
            session.Gate.Release();
        }
    }

    // ── 连接 ────────────────────────────────────────────────

    private Session GetOrCreate(string profileId)
    {
        lock (_gate)
        {
            if (_sessions.TryGetValue(profileId, out var existing)) return existing;
            var created = new Session { ProfileId = profileId };
            _sessions[profileId] = created;
            return created;
        }
    }

    private void EnsureConnected(Session session, string profileId)
    {
        if (session.Client?.IsConnected == true)
        {
            session.State = "ready";
            return;
        }

        var profile = _store.Get(profileId)
            ?? throw new InvalidOperationException($"SSH_PROFILE_NOT_FOUND: {profileId}");

        session.State = "connecting";
        try
        {
            session.Client?.Dispose();
            session.Client = CreateClient(profile);
            session.Client.Connect();
            session.State = "ready";
            session.LastUsedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        }
        catch (Exception ex)
        {
            session.State = "error";
            try { session.Client?.Dispose(); } catch { /* ignore */ }
            session.Client = null;
            throw new InvalidOperationException($"SSH_CONNECT_FAILED: {ex.Message}", ex);
        }
    }

    private static SshClient CreateClient(SshProfile profile)
    {
        var methods = new List<AuthenticationMethod>();
        if (profile.AuthType == "privateKey" && !string.IsNullOrWhiteSpace(profile.PrivateKeyPath))
        {
            var key = string.IsNullOrEmpty(profile.Passphrase)
                ? new PrivateKeyFile(profile.PrivateKeyPath)
                : new PrivateKeyFile(profile.PrivateKeyPath, profile.Passphrase);
            methods.Add(new PrivateKeyAuthenticationMethod(profile.Username, key));
        }
        else
        {
            methods.Add(new PasswordAuthenticationMethod(profile.Username, profile.Password ?? ""));
        }

        var connectionInfo = new ConnectionInfo(profile.Host, profile.Port, profile.Username, methods.ToArray())
        {
            Timeout = TimeSpan.FromSeconds(20),
        };
        return new SshClient(connectionInfo)
        {
            KeepAliveInterval = TimeSpan.FromSeconds(15),
        };
    }

    private static string BuildCommand(string command, string? cwd)
    {
        if (string.IsNullOrWhiteSpace(cwd)) return command;
        var escaped = cwd.Replace("'", "'\\''");
        return $"cd -- '{escaped}' && {command}";
    }

    private static string Clip(string text, out bool clipped)
    {
        if (Encoding.UTF8.GetByteCount(text) <= MaxCaptureBytes)
        {
            clipped = false;
            return text;
        }
        clipped = true;
        var bytes = Encoding.UTF8.GetBytes(text);
        return Encoding.UTF8.GetString(bytes, 0, MaxCaptureBytes) + "\n[输出超限，已截断]";
    }
}

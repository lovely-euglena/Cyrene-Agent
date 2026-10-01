namespace CyreneNative.Storage;

/// <summary>
/// 云存储会话托管：连接在 --storage-host 进程内长期持有（keepalive/懒重连），
/// 每个档案一个会话、操作串行化（FTP/SFTP 客户端非线程安全；长传输会占住该档案队列）。
/// 空闲 10 分钟自动断连，下次调用懒重连。
/// </summary>
internal sealed class StorageSessionManager : IDisposable
{
    private const long IdleCloseMs = 10 * 60 * 1000;

    private readonly StorageProfileStore _store;
    private readonly Dictionary<string, Session> _sessions = new();
    private readonly object _gate = new();
    private readonly Timer _reaper;

    private sealed class Session
    {
        public required string ProfileId { get; init; }
        public IStorageProvider? Provider { get; set; }
        /// <summary>idle | connecting | ready | error | closed</summary>
        public string State { get; set; } = "idle";
        public long LastUsedAt { get; set; } = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        public readonly SemaphoreSlim Gate = new(1, 1);
    }

    public StorageSessionManager(StorageProfileStore store)
    {
        _store = store;
        _reaper = new Timer(_ => ReapIdle(), null, 60_000, 60_000);
    }

    public List<object> ListSessions()
    {
        lock (_gate)
        {
            return _sessions.Values
                .Select(s => (object)new { profileId = s.ProfileId, state = s.State, lastUsedAt = s.LastUsedAt })
                .ToList();
        }
    }

    /// <summary>
    /// 在指定档案的串行区内执行 action（必要时建立/复用连接）。
    /// timeoutMs 是排队等待上限，不是操作执行上限（长传输由调用方超时放弃等待）。
    /// </summary>
    public T Run<T>(string profileId, Func<IStorageProvider, T> action, int timeoutMs = 120_000)
    {
        _ = _store.GetOrThrow(profileId); // 档案不存在提前报错
        var session = GetOrCreate(profileId);
        if (!session.Gate.Wait(Math.Max(1_000, timeoutMs)))
            throw new StorageException("STORAGE_TIMEOUT", "该档案上一个操作尚未完成（队列等待超时）", true);

        try
        {
            var provider = EnsureProvider(session, profileId);
            try
            {
                return action(provider);
            }
            catch (StorageException sex)
            {
                if (sex.ConnectionLost) ResetProvider(session);
                throw;
            }
            catch (Exception ex)
            {
                var mapped = StorageErrors.Map(ex);
                if (mapped.ConnectionLost) ResetProvider(session);
                throw mapped;
            }
        }
        finally
        {
            session.LastUsedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            session.Gate.Release();
        }
    }

    public void Close(string? profileId)
    {
        if (!string.IsNullOrEmpty(profileId))
        {
            Session? session;
            lock (_gate) _sessions.TryGetValue(profileId, out session);
            if (session is not null) CloseSession(session);
            return;
        }

        List<Session> all;
        lock (_gate) all = _sessions.Values.ToList();
        foreach (var session in all) CloseSession(session);
    }

    public void CloseAll() => Close(null);

    public void Dispose()
    {
        _reaper.Dispose();
        CloseAll();
    }

    // ── 内部 ───────────────────────────────────────────────

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

    private IStorageProvider EnsureProvider(Session session, string profileId)
    {
        if (session.Provider is { IsConnected: true })
        {
            session.State = "ready";
            return session.Provider;
        }

        session.Provider?.Dispose();
        session.Provider = null;
        session.State = "connecting";
        var provider = StorageProviderFactory.Create(_store.GetOrThrow(profileId));
        try
        {
            provider.Connect();
        }
        catch (Exception ex)
        {
            try { provider.Dispose(); } catch { /* 已断开 */ }
            session.State = "error";
            throw StorageErrors.Map(ex);
        }
        session.Provider = provider;
        session.State = "ready";
        return provider;
    }

    /// <summary>调用方持有 session.Gate 时使用（不能走 CloseSession 的信号量路径）。</summary>
    private static void ResetProvider(Session session)
    {
        try { session.Provider?.Dispose(); } catch { /* 已断开 */ }
        session.Provider = null;
        session.State = "error";
    }

    private void CloseSession(Session session)
    {
        // 在途操作不让 Close 阻塞：3s 拿不到信号量就跳过（该操作归还时自会更新状态）
        if (!session.Gate.Wait(3_000)) return;
        try
        {
            try { session.Provider?.Dispose(); } catch { /* 已断开 */ }
            session.Provider = null;
            session.State = "idle";
        }
        finally
        {
            session.Gate.Release();
        }
    }

    private void ReapIdle()
    {
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        List<Session> idle;
        lock (_gate)
        {
            idle = _sessions.Values.Where(s => now - s.LastUsedAt > IdleCloseMs).ToList();
        }
        foreach (var session in idle) CloseSession(session);
    }
}

using System.Security.Cryptography;
using System.Text;
using CyreneNative.Channels;

namespace CyreneCloud.Channels;

/// <summary>
/// 渠道归属权状态机（docs/design/2026-10-05-server-channel.md §5.1）。
///
/// 唯一权威 = <c>channels.db.channel_ownership</c>（每渠道一行）；本服务是服务端唯一写者，
/// 内存缓存只作读取加速与门闩判定（<see cref="IChannelOwnershipGate"/>）。
/// 默认规则：服务端 24/7 持有；桌面显式 claim 后租约持有（TTL 默认 180s）；
/// 租约到期由 <see cref="SweepExpiredAsync"/> / 心跳路径自动收回并重启适配器；
/// 多设备先到先得（Q8）——有效租约期间第二台设备的 claim 一律 denied。
///
/// 适配器生命周期：claim 前先停服务端适配器（drain ≤5s，R2）；release 宽限 5s 后恢复（§5.3）；
/// 租约过期立即收回并启动（§5.1 R3）。服务端进程重启时调用 <see cref="InitializeAsync"/>：
/// owner=server 的渠道直接恢复；owner=desktop 且租约未过期的渠道保持 paused（等桌面心跳，§5.5）。
/// </summary>
public sealed class ChannelOwnershipService : IChannelOwnershipGate
{
    public const string OwnerServer = "server";
    public const string OwnerDesktop = "desktop";

    /// <summary>claim 交接 drain 上限（R2：先停适配器再授予，≤5s）。</summary>
    public static readonly TimeSpan DefaultHandoffDrainTimeout = TimeSpan.FromSeconds(5);

    /// <summary>release 后恢复服务端适配器的宽限（§5.3：宽限 5s 后恢复）。</summary>
    public static readonly TimeSpan DefaultReleaseGrace = TimeSpan.FromSeconds(5);

    private readonly ChannelStore _store;
    private readonly ChannelManager _manager;
    private readonly TimeProvider _clock;
    private readonly ILogger<ChannelOwnershipService> _logger;
    private readonly SemaphoreSlim _mutex = new(1, 1);
    private readonly object _statesLock = new();
    private readonly Dictionary<string, OwnershipState> _states = new(StringComparer.Ordinal);
    private readonly CancellationTokenSource _shutdown = new();
    private readonly object _pendingStartsLock = new();
    private readonly List<Task> _pendingStarts = new();
    private readonly object _graceLock = new();
    private readonly Dictionary<string, DateTimeOffset> _graceDeadlines = new(StringComparer.Ordinal);
    // R3 P2-6.3：owner=server 自愈启动的日志节流——持续失败只在状态变化（首次失败/恢复）时记录，
    // 不改变 5s 重试节奏（每轮仍尝试启动）。
    private readonly object _startLogLock = new();
    private readonly HashSet<string> _startFailureLogged = new(StringComparer.Ordinal);

    public ChannelOwnershipService(
        ChannelStore store,
        ChannelManager manager,
        ILogger<ChannelOwnershipService> logger,
        string serverId,
        TimeSpan? leaseTtl = null,
        TimeSpan? releaseGrace = null,
        TimeProvider? clock = null,
        TimeSpan? handoffDrainTimeout = null)
    {
        _store = store;
        _manager = manager;
        _logger = logger;
        ServerId = serverId;
        LeaseTtl = leaseTtl ?? TimeSpan.FromSeconds(180);
        ReleaseGrace = releaseGrace ?? DefaultReleaseGrace;
        HandoffDrainTimeout = handoffDrainTimeout ?? DefaultHandoffDrainTimeout;
        _clock = clock ?? TimeProvider.System;
        // R3 P2-3：把归属判定安装为 ChannelManager 的启动门闩——扫码确认后的直接重启等入口
        // 也必须服从「唯一调度」（桌面持有期间不得拉起服务端适配器）。
        _manager.SetStartGate(CanProcess);
    }

    /// <summary>稳定服务端指纹（机器名 + 数据目录；桌面据此识别服务端进程重启）。</summary>
    public static string ComputeServerId(string dataDir)
    {
        var fingerprint = $"{Environment.MachineName}|{Path.GetFullPath(dataDir)}";
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(fingerprint)))[..16].ToLowerInvariant();
    }

    public string ServerId { get; }
    public TimeSpan LeaseTtl { get; }
    public TimeSpan ReleaseGrace { get; }
    public TimeSpan HandoffDrainTimeout { get; }

    // ── 启动与状态 ───────────────────────────────────────────────────────────

    /// <summary>
    /// 启动时装载归属状态（§5.5 进程重启语义）：返回应启动适配器的服务端持有渠道。
    /// owner=desktop 且租约未过期的渠道保持 paused（不启动、等桌面心跳）。
    /// </summary>
    public async Task<IReadOnlyList<string>> InitializeAsync(
        IReadOnlyCollection<string> channels, CancellationToken cancellationToken = default)
    {
        await _mutex.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            var records = await _store.ListOwnershipAsync(cancellationToken).ConfigureAwait(false);
            var byChannel = new Dictionary<string, OwnershipRecord>(StringComparer.Ordinal);
            foreach (var record in records) byChannel[record.Channel] = record;

            var now = _clock.GetUtcNow();
            var serverOwned = new List<string>();
            foreach (var channel in channels)
            {
                if (byChannel.TryGetValue(channel, out var record) && IsDesktopLeaseValid(record, now))
                {
                    // 持久化表未存 TTL（契约冻结）：重启恢复后心跳回落服务端默认 TTL
                    var held = new OwnershipState(
                        OwnerDesktop, record.Holder, ParseLease(record.LeaseExpiresAt), now);
                    SetState(channel, held);
                    _logger.LogInformation(
                        "渠道归属恢复：桌面租约未过期保持 paused event=restore channel={Channel} holder={Holder}",
                        channel, record.Holder);
                    continue;
                }
                var state = new OwnershipState(OwnerServer, null, null, now);
                await PersistAsync(channel, state, cancellationToken).ConfigureAwait(false);
                SetState(channel, state);
                serverOwned.Add(channel);
            }
            return serverOwned;
        }
        finally
        {
            _mutex.Release();
        }
    }

    /// <summary>
    /// 归属快照（控制面 GET /v1/channels/ownership）。
    /// leaseTtlSeconds 契约冻结为「服务端默认 TTL」；桌面 claim 传入 per-request TTL 时，
    /// 心跳续期按该渠道实际 TTL 计算（见 <see cref="HeartbeatAsync"/>），快照不再重复该口径。
    /// </summary>
    public OwnershipSnapshot GetSnapshot()
    {
        Dictionary<string, OwnershipChannelView> channels;
        lock (_statesLock)
        {
            channels = _states.ToDictionary(
                pair => pair.Key,
                pair => new OwnershipChannelView(
                    pair.Value.Owner,
                    pair.Value.Holder,
                    pair.Value.LeaseExpiresAt is { } lease ? ChannelSessionId.UtcNowIso(lease) : null),
                StringComparer.Ordinal);
        }
        return new OwnershipSnapshot(ServerId, (int)LeaseTtl.TotalSeconds, channels);
    }

    /// <summary>渠道当前归属（未知渠道按服务端默认持有处理）。</summary>
    public OwnershipState GetState(string channel)
    {
        lock (_statesLock)
        {
            return _states.TryGetValue(channel, out var state)
                ? state
                : new OwnershipState(OwnerServer, null, null, _clock.GetUtcNow());
        }
    }

    // ── claim / heartbeat / release（§5.2）───────────────────────────────────

    /// <summary>
    /// 桌面认领（R2）：有效租约归当前 holder 时续约；归其它 holder 时 denied（Q8 先到先得）；
    /// 服务端持有或租约过期时先停适配器（drain ≤5s）再授予。
    /// </summary>
    public async Task<OwnershipClaimResult> ClaimAsync(
        IReadOnlyCollection<string> channels, string holder, int? ttlSeconds,
        CancellationToken cancellationToken = default)
    {
        var ttl = ClampTtl(ttlSeconds);
        await _mutex.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            var now = _clock.GetUtcNow();
            var granted = new List<string>();
            var denied = new List<string>();
            DateTimeOffset? lastLease = null;
            foreach (var channel in channels)
            {
                var state = GetState(channel);
                if (state.Owner == OwnerDesktop && state.LeaseExpiresAt > now)
                {
                    if (state.Holder == holder)
                    {
                        var renewed = new OwnershipState(OwnerDesktop, holder, now + ttl, now, ttl);
                        await PersistAsync(channel, renewed, cancellationToken).ConfigureAwait(false);
                        SetState(channel, renewed);
                        granted.Add(channel);
                        lastLease = renewed.LeaseExpiresAt;
                        _logger.LogInformation("渠道归属续约 event=claim channel={Channel} holder={Holder}", channel, holder);
                    }
                    else
                    {
                        // Q8：先到先得；第二台设备保持被动
                        denied.Add(channel);
                    }
                    continue;
                }

                cancellationToken.ThrowIfCancellationRequested();
                await StopForHandoffAsync(channel, cancellationToken).ConfigureAwait(false);
                var claimed = new OwnershipState(OwnerDesktop, holder, now + ttl, now, ttl);
                try
                {
                    await PersistAsync(channel, claimed, cancellationToken).ConfigureAwait(false);
                }
                catch
                {
                    // 持久化失败/请求中止：适配器已停但归属仍为 server——补偿重启，避免渠道悬挂离线
                    // （补偿不随请求取消；后续 sweep 自愈兜底）
                    _logger.LogWarning(
                        "渠道归属交接持久化失败，补偿重启服务端适配器 channel={Channel} holder={Holder}",
                        channel, holder);
                    await StartOwnedAsync(channel, CancellationToken.None).ConfigureAwait(false);
                    throw;
                }
                SetState(channel, claimed);
                granted.Add(channel);
                lastLease = claimed.LeaseExpiresAt;
                _logger.LogInformation(
                    "渠道归属交接 event=claim channel={Channel} holder={Holder} leaseExpiresAt={Lease}",
                    channel, holder, claimed.LeaseExpiresAt);
            }
            return new OwnershipClaimResult(granted, denied, lastLease);
        }
        finally
        {
            _mutex.Release();
        }
    }

    /// <summary>桌面心跳：holder 匹配且租约有效 → renewed（续期）；否则 lost（租约过期时立即收回）。</summary>
    public async Task<OwnershipHeartbeatResult> HeartbeatAsync(
        IReadOnlyCollection<string> channels, string holder, CancellationToken cancellationToken = default)
    {
        await _mutex.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            var now = _clock.GetUtcNow();
            var renewed = new List<string>();
            var lost = new List<string>();
            foreach (var channel in channels)
            {
                var state = GetState(channel);
                if (state.Owner != OwnerDesktop || state.Holder != holder)
                {
                    lost.Add(channel);
                    continue;
                }
                if (state.LeaseExpiresAt > now)
                {
                    // P2-8：续期沿用该渠道 claim 时的实际 TTL（per-request），无记录（重启恢复）时回落默认
                    var next = state with { LeaseExpiresAt = now + (state.LeaseTtl ?? LeaseTtl), UpdatedAt = now };
                    await PersistAsync(channel, next, cancellationToken).ConfigureAwait(false);
                    SetState(channel, next);
                    renewed.Add(channel);
                }
                else
                {
                    // 心跳迟到于租约：立即收回（不等 sweep），返回 lost 让桌面停本机适配器
                    await ReclaimAsync(channel, "expire", cancellationToken).ConfigureAwait(false);
                    lost.Add(channel);
                }
            }
            return new OwnershipHeartbeatResult(renewed, lost);
        }
        finally
        {
            _mutex.Release();
        }
    }

    /// <summary>桌面交回（§5.3）：holder 匹配时置回服务端；宽限后恢复适配器。</summary>
    public async Task<OwnershipReleaseResult> ReleaseAsync(
        IReadOnlyCollection<string> channels, string holder, CancellationToken cancellationToken = default)
    {
        await _mutex.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            var released = new List<string>();
            foreach (var channel in channels)
            {
                var state = GetState(channel);
                if (state.Owner != OwnerDesktop || state.Holder != holder) continue;
                var now = _clock.GetUtcNow();
                var serverState = new OwnershipState(OwnerServer, null, null, now);
                await PersistAsync(channel, serverState, cancellationToken).ConfigureAwait(false);
                SetState(channel, serverState);
                released.Add(channel);
                _logger.LogInformation("渠道归属交回 event=release channel={Channel} holder={Holder}", channel, holder);
                if (ReleaseGrace <= TimeSpan.Zero)
                {
                    await StartOwnedAsync(channel, cancellationToken).ConfigureAwait(false);
                }
                else
                {
                    ScheduleServerStart(channel);
                }
            }
            return new OwnershipReleaseResult(released);
        }
        finally
        {
            _mutex.Release();
        }
    }

    // ── 租约过期回收（R3）与门闩 ─────────────────────────────────────────────

    /// <summary>
    /// 周期扫描（ChannelHostedService 每 5s 调用）：回收过期桌面租约并启动适配器；
    /// owner=server 但适配器未运行（交接补偿失败/启动失败悬挂）时自愈补启动。
    /// 返回被收回（reclaimed）的渠道。
    /// </summary>
    public async Task<IReadOnlyList<string>> SweepExpiredAsync(CancellationToken cancellationToken = default)
    {
        await _mutex.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            var now = _clock.GetUtcNow();
            var reclaimed = new List<string>();
            foreach (var channel in ListStateChannels())
            {
                var state = GetState(channel);
                if (state.Owner == OwnerDesktop)
                {
                    if (state.LeaseExpiresAt <= now)
                    {
                        await ReclaimAsync(channel, "expire", cancellationToken).ConfigureAwait(false);
                        reclaimed.Add(channel);
                    }
                    continue;
                }
                // owner=server 自愈：适配器应运行而未运行（claim 补偿失败/启动失败）→ 补启动；
                // release 宽限期内跳过（P1-2b）：宽限 5s 是给桌面停本机适配器的窗口，
                // 若 sweep 立即补启动会与桌面同启、抵消「先停后授」。
                if (!_manager.IsRunning(channel) && !IsWithinGrace(channel, now))
                {
                    await StartOwnedAsync(channel, cancellationToken).ConfigureAwait(false);
                }
            }
            return reclaimed;
        }
        finally
        {
            _mutex.Release();
        }
    }

    /// <summary>
    /// 入站归属门闩（§2.5/§5.6）：仅服务端持有（或租约已失效）时允许处理；
    /// owner=desktop 期间服务端直接丢弃，防交接窗口误处理。
    /// </summary>
    public ValueTask<bool> CanProcessAsync(string channel, CancellationToken cancellationToken = default) =>
        ValueTask.FromResult(CanProcess(channel));

    private bool CanProcess(string channel)
    {
        var state = GetState(channel);
        if (state.Owner == OwnerServer) return true;
        // 租约已过期但 sweep 尚未跑：语义上已回归服务端（适配器启动由 sweep 完成）
        return state.LeaseExpiresAt is { } lease && lease <= _clock.GetUtcNow();
    }

    // ── 内部：状态与适配器生命周期 ───────────────────────────────────────────

    private async Task ReclaimAsync(string channel, string eventName, CancellationToken cancellationToken)
    {
        var now = _clock.GetUtcNow();
        var state = new OwnershipState(OwnerServer, null, null, now);
        await PersistAsync(channel, state, cancellationToken).ConfigureAwait(false);
        SetState(channel, state);
        _logger.LogInformation("渠道归属收回 event={Event} channel={Channel}", eventName, channel);
        await StartOwnedAsync(channel, cancellationToken).ConfigureAwait(false);
    }

    private async Task StartOwnedAsync(string channel, CancellationToken cancellationToken)
    {
        if (!CanProcess(channel)) return; // 收回与重新 claim 竞态：已被桌面重新持有
        await _manager.StartAsync(channel, cancellationToken).ConfigureAwait(false);
        if (_manager.IsRunning(channel))
        {
            bool recovered;
            lock (_startLogLock) recovered = _startFailureLogged.Remove(channel);
            _logger.LogInformation(
                recovered
                    ? "渠道归属恢复服务端 event=start-recovered channel={Channel}"
                    : "渠道归属恢复服务端 event=start channel={Channel}",
                channel);
            return;
        }
        // R3 P2-6.3：启动未成功——首次记 warning，持续失败降 Debug；重试节奏（5s sweep）不变
        bool firstFailure;
        lock (_startLogLock) firstFailure = _startFailureLogged.Add(channel);
        if (firstFailure)
        {
            _logger.LogWarning(
                "渠道归属恢复服务端启动未成功，按托管扫描节奏持续重试（后续失败日志按状态变化节流）channel={Channel}",
                channel);
        }
        else
        {
            _logger.LogDebug("渠道归属恢复服务端启动仍未成功（日志已节流）channel={Channel}", channel);
        }
    }

    /// <summary>
    /// 按归属启动服务端持有渠道（托管服务启动/自愈入口）：owner=desktop 时跳过。
    /// 与 claim 共用互斥：并发 claim 后不会再把服务端适配器拉起（R2 门闩复查）。
    /// </summary>
    public async Task StartServerOwnedAsync(string channel, CancellationToken cancellationToken = default)
    {
        await _mutex.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            await StartOwnedAsync(channel, cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            _mutex.Release();
        }
    }

    /// <summary>
    /// 安排 release 宽限后恢复：登记宽限截止（sweep 自愈据此跳过，P1-2b），
    /// 到期走 <see cref="StartServerOwnedAsync"/>（持 _mutex + 复查归属，P1-2a）——
    /// 与 claim 串行，claim 已授予时不会再把服务端适配器拉起。
    /// </summary>
    private void ScheduleServerStart(string channel)
    {
        var deadline = _clock.GetUtcNow() + ReleaseGrace;
        lock (_graceLock) _graceDeadlines[channel] = deadline;
        Task task = Task.Run(async () =>
        {
            try
            {
                await Task.Delay(ReleaseGrace, _shutdown.Token).ConfigureAwait(false);
                await StartServerOwnedAsync(channel, _shutdown.Token).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                // 停机：放弃宽限启动（适配器由托管服务 StopAllAsync 统一停止）
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "渠道 release 宽限恢复失败 channel={Channel}", channel);
            }
            finally
            {
                ClearGraceDeadline(channel, deadline);
            }
        });
        lock (_pendingStartsLock) _pendingStarts.Add(task);
        _ = task.ContinueWith(
            completed => { lock (_pendingStartsLock) _pendingStarts.Remove(completed); },
            CancellationToken.None, TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
    }

    private bool IsWithinGrace(string channel, DateTimeOffset now)
    {
        lock (_graceLock)
        {
            return _graceDeadlines.TryGetValue(channel, out var deadline) && now < deadline;
        }
    }

    private void ClearGraceDeadline(string channel, DateTimeOffset deadline)
    {
        lock (_graceLock)
        {
            // 只清理自己登记的截止时间：期间若再次 release，保留新宽限
            if (_graceDeadlines.TryGetValue(channel, out var current) && current == deadline)
            {
                _graceDeadlines.Remove(channel);
            }
        }
    }

    /// <summary>
    /// 停机收尾（ChannelHostedService.StopAsync 调用）：取消 release 宽限启动并等待在途任务结束，
    /// 避免宽限任务在 StopAllAsync 之后把适配器重新拉起。
    /// </summary>
    public async Task CancelPendingStartsAsync()
    {
        _shutdown.Cancel();
        Task[] pending;
        lock (_pendingStartsLock) pending = _pendingStarts.ToArray();
        if (pending.Length == 0) return;
        try
        {
            await Task.WhenAll(pending).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "release 宽限启动收尾异常");
        }
    }

    private async Task StopForHandoffAsync(string channel, CancellationToken cancellationToken)
    {
        using var drain = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        var stopTask = _manager.StopAsync(channel, drain.Token);
        var timeoutTask = Task.Delay(HandoffDrainTimeout, cancellationToken);
        // drain 为协作式：适配器不响应取消时不能无限持有 mutex，超时即继续授予
        if (await Task.WhenAny(stopTask, timeoutTask).ConfigureAwait(false) != stopTask)
        {
            drain.Cancel();
            if (cancellationToken.IsCancellationRequested)
            {
                _logger.LogDebug("渠道交接请求中止，放弃等待 drain channel={Channel}", channel);
            }
            else
            {
                _logger.LogWarning(
                    "渠道交接 drain 超时（{Timeout}s），继续授予 channel={Channel}",
                    HandoffDrainTimeout.TotalSeconds, channel);
            }
            return;
        }
        await stopTask.ConfigureAwait(false);
    }

    private TimeSpan ClampTtl(int? ttlSeconds)
    {
        if (ttlSeconds is not { } requested) return LeaseTtl;
        return TimeSpan.FromSeconds(Math.Clamp(requested, 30, 86400));
    }

    private static bool IsDesktopLeaseValid(OwnershipRecord record, DateTimeOffset now) =>
        record.Owner == OwnerDesktop && ParseLease(record.LeaseExpiresAt) is { } lease && lease > now;

    private static DateTimeOffset? ParseLease(string? value) =>
        DateTimeOffset.TryParse(value, null, System.Globalization.DateTimeStyles.AssumeUniversal, out var lease)
            ? lease
            : null;

    private async Task PersistAsync(string channel, OwnershipState state, CancellationToken cancellationToken)
    {
        await _store.UpsertOwnershipAsync(
            channel, state.Owner, state.Holder, state.LeaseExpiresAt, cancellationToken).ConfigureAwait(false);
    }

    private void SetState(string channel, OwnershipState state)
    {
        lock (_statesLock) _states[channel] = state;
    }

    private string[] ListStateChannels()
    {
        lock (_statesLock) return _states.Keys.ToArray();
    }
}

/// <summary>内部归属状态（LeaseExpiresAt 已解析；LeaseTtl = claim 时实际 TTL，null = 服务端默认）。</summary>
public sealed record OwnershipState(
    string Owner, string? Holder, DateTimeOffset? LeaseExpiresAt, DateTimeOffset UpdatedAt,
    TimeSpan? LeaseTtl = null);

/// <summary>控制面快照（leaseExpiresAt 为同步协议 ISO 毫秒字符串）。</summary>
public sealed record OwnershipSnapshot(
    string ServerId, int LeaseTtlSeconds, IReadOnlyDictionary<string, OwnershipChannelView> Channels);

public sealed record OwnershipChannelView(string Owner, string? Holder, string? LeaseExpiresAt);

public sealed record OwnershipClaimResult(
    IReadOnlyList<string> Granted, IReadOnlyList<string> Denied, DateTimeOffset? LeaseExpiresAt);

public sealed record OwnershipHeartbeatResult(IReadOnlyList<string> Renewed, IReadOnlyList<string> Lost);

public sealed record OwnershipReleaseResult(IReadOnlyList<string> Released);

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
    public static readonly TimeSpan HandoffDrainTimeout = TimeSpan.FromSeconds(5);

    /// <summary>release 后恢复服务端适配器的宽限（§5.3：宽限 5s 后恢复）。</summary>
    public static readonly TimeSpan DefaultReleaseGrace = TimeSpan.FromSeconds(5);

    private readonly ChannelStore _store;
    private readonly ChannelManager _manager;
    private readonly TimeProvider _clock;
    private readonly ILogger<ChannelOwnershipService> _logger;
    private readonly SemaphoreSlim _mutex = new(1, 1);
    private readonly object _statesLock = new();
    private readonly Dictionary<string, OwnershipState> _states = new(StringComparer.Ordinal);

    public ChannelOwnershipService(
        ChannelStore store,
        ChannelManager manager,
        ILogger<ChannelOwnershipService> logger,
        string serverId,
        TimeSpan? leaseTtl = null,
        TimeSpan? releaseGrace = null,
        TimeProvider? clock = null)
    {
        _store = store;
        _manager = manager;
        _logger = logger;
        ServerId = serverId;
        LeaseTtl = leaseTtl ?? TimeSpan.FromSeconds(180);
        ReleaseGrace = releaseGrace ?? DefaultReleaseGrace;
        _clock = clock ?? TimeProvider.System;
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

    /// <summary>归属快照（控制面 GET /v1/channels/ownership）。</summary>
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
                        var renewed = new OwnershipState(OwnerDesktop, holder, now + ttl, now);
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

                await StopForHandoffAsync(channel, cancellationToken).ConfigureAwait(false);
                var claimed = new OwnershipState(OwnerDesktop, holder, now + ttl, now);
                await PersistAsync(channel, claimed, cancellationToken).ConfigureAwait(false);
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
                    var next = state with { LeaseExpiresAt = now + LeaseTtl, UpdatedAt = now };
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

    /// <summary>过期租约批量收回（ChannelHostedService 周期调用）；返回被收回的渠道。</summary>
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
                if (state.Owner == OwnerDesktop && state.LeaseExpiresAt <= now)
                {
                    await ReclaimAsync(channel, "expire", cancellationToken).ConfigureAwait(false);
                    reclaimed.Add(channel);
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
        _logger.LogInformation("渠道归属恢复服务端 event=start channel={Channel}", channel);
    }

    private void ScheduleServerStart(string channel)
    {
        _ = Task.Run(async () =>
        {
            try
            {
                await Task.Delay(ReleaseGrace).ConfigureAwait(false);
                await StartOwnedAsync(channel, CancellationToken.None).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "渠道 release 宽限恢复失败 channel={Channel}", channel);
            }
        });
    }

    private async Task StopForHandoffAsync(string channel, CancellationToken cancellationToken)
    {
        using var drain = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        drain.CancelAfter(HandoffDrainTimeout);
        try
        {
            await _manager.StopAsync(channel, drain.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            // drain 超时：继续授予（适配器 StopAsync 自行保证不阻塞进程退出）
            _logger.LogWarning("渠道交接 drain 超时 channel={Channel}", channel);
        }
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

/// <summary>内部归属状态（LeaseExpiresAt 已解析）。</summary>
public sealed record OwnershipState(
    string Owner, string? Holder, DateTimeOffset? LeaseExpiresAt, DateTimeOffset UpdatedAt);

/// <summary>控制面快照（leaseExpiresAt 为同步协议 ISO 毫秒字符串）。</summary>
public sealed record OwnershipSnapshot(
    string ServerId, int LeaseTtlSeconds, IReadOnlyDictionary<string, OwnershipChannelView> Channels);

public sealed record OwnershipChannelView(string Owner, string? Holder, string? LeaseExpiresAt);

public sealed record OwnershipClaimResult(
    IReadOnlyList<string> Granted, IReadOnlyList<string> Denied, DateTimeOffset? LeaseExpiresAt);

public sealed record OwnershipHeartbeatResult(IReadOnlyList<string> Renewed, IReadOnlyList<string> Lost);

public sealed record OwnershipReleaseResult(IReadOnlyList<string> Released);

using CyreneNative.Channels;

namespace CyreneCloud.Channels;

/// <summary>
/// 渠道注册表 + 生命周期管理（TS `src/main/channels/manager.ts` 的镜像）。
///
/// 只做「哪个渠道注册了、启停状态」；不感知平台协议、sessionId 与 cap 降级。
/// 入站：adapters.OnMessage → 注入的 dispatcher 回调；出站：dispatcher → adapter.SendAsync。
/// 单实例守卫：同一渠道重复 Start 是幂等的（阶段 4 归属切换依赖该语义）。
/// </summary>
public sealed class ChannelManager
{
    private readonly object _sync = new();
    private readonly Dictionary<string, IChannelAdapter> _adapters = new(StringComparer.Ordinal);
    private readonly HashSet<string> _started = new(StringComparer.Ordinal);
    private readonly HashSet<string> _starting = new(StringComparer.Ordinal);
    private readonly HashSet<string> _stopRequested = new(StringComparer.Ordinal);
    // P2-1：按渠道串行「启动/停止」适配器调用——drain 超时后旧 StopAsync 可能仍在途，
    // 没有互斥时 sweep/宽限启动会与旧 StopAsync 并发（启动→停止交错）。
    private readonly Dictionary<string, SemaphoreSlim> _lifecycle = new(StringComparer.Ordinal);
    private readonly ILogger<ChannelManager> _logger;

    private Func<IncomingMessage, CancellationToken, Task<OutgoingMessage?>>? _dispatcher;

    public ChannelManager(ILogger<ChannelManager> logger)
    {
        _logger = logger;
    }

    public bool Has(string id)
    {
        lock (_sync) return _adapters.ContainsKey(id);
    }

    /// <summary>注册适配器（必须在 StartAll 之前；重复 id 一律拒绝）。</summary>
    public void Register(IChannelAdapter adapter)
    {
        lock (_sync)
        {
            if (!_adapters.TryAdd(adapter.Id, adapter))
            {
                throw new InvalidOperationException($"渠道 {adapter.Id} 已注册，禁止覆盖现有实例");
            }
            if (_dispatcher is not null) adapter.OnMessage = MakeHandler(adapter.Id);
        }
    }

    /// <summary>注销适配器：先从注册表移除（后续 Start 立即失败），再串行停止在途实例。</summary>
    public async Task<bool> UnregisterAsync(string id, CancellationToken cancellationToken = default)
    {
        IChannelAdapter? adapter;
        SemaphoreSlim gate;
        lock (_sync)
        {
            if (!_adapters.Remove(id, out adapter)) return false;
            _started.Remove(id);
            gate = LifecycleLockLocked(id);
        }
        await gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            try
            {
                await adapter.StopAsync(cancellationToken).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "渠道停止失败 channel={Channel}", id);
            }
            lock (_sync)
            {
                // 在途 Start 可能在移除后完成并回写 _started：注销收尾再清一次
                _started.Remove(id);
                _starting.Remove(id);
                _stopRequested.Remove(id);
            }
        }
        finally
        {
            gate.Release();
        }
        return true;
    }

    /// <summary>设置 dispatcher 入口；已注册适配器立即注入 handler。</summary>
    public void SetDispatcher(Func<IncomingMessage, CancellationToken, Task<OutgoingMessage?>> dispatcher)
    {
        lock (_sync)
        {
            _dispatcher = dispatcher;
            foreach (var adapter in _adapters.Values)
            {
                adapter.OnMessage = MakeHandler(adapter.Id);
            }
        }
    }

    /// <summary>启动单个适配器（幂等：已启动/启动中直接返回；与 StopAsync 按渠道串行）。</summary>
    public async Task StartAsync(string id, CancellationToken cancellationToken = default)
    {
        IChannelAdapter? adapter;
        lock (_sync)
        {
            if (!_adapters.TryGetValue(id, out adapter) || _started.Contains(id) || _starting.Contains(id)) return;
        }
        var gate = LifecycleLock(id);
        await gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            lock (_sync)
            {
                // 等锁期间状态可能已变（如旧 StopAsync 完成）：仍按幂等处理
                if (!_adapters.TryGetValue(id, out adapter) || _started.Contains(id) || !_starting.Add(id)) return;
                if (_dispatcher is not null) adapter.OnMessage = MakeHandler(id);
            }
            var stopAfterStart = false;
            try
            {
                await adapter.StartAsync(cancellationToken).ConfigureAwait(false);
                lock (_sync)
                {
                    _starting.Remove(id);
                    _started.Add(id);
                    // 启动期间收到停止请求（归属交接/停机）：登记补停，不让 StopAsync 空操作
                    stopAfterStart = _stopRequested.Remove(id);
                }
                _logger.LogInformation("渠道已启动 channel={Channel} name={Name}", id, adapter.DisplayName);
            }
            catch (Exception ex)
            {
                lock (_sync)
                {
                    _starting.Remove(id);
                    _stopRequested.Remove(id);
                }
                _logger.LogError(ex, "渠道启动失败 channel={Channel}", id);
            }
            if (stopAfterStart)
            {
                // 启动完成即补停（仍在生命周期锁内），保证「先停适配器 → 再授予」语义（R2）
                await StopCoreAsync(id, CancellationToken.None).ConfigureAwait(false);
            }
        }
        finally
        {
            gate.Release();
        }
    }

    /// <summary>停止单个适配器（幂等；启动中的适配器登记补停，不空操作；与 StartAsync 按渠道串行）。</summary>
    public async Task StopAsync(string id, CancellationToken cancellationToken = default)
    {
        SemaphoreSlim gate;
        lock (_sync)
        {
            if (!_adapters.ContainsKey(id)) return;
            if (!_started.Contains(id))
            {
                // 启动在途：登记补停，由启动完成方在生命周期锁内补停（本调用可立即返回）
                if (_starting.Contains(id)) _stopRequested.Add(id);
                return;
            }
            gate = LifecycleLockLocked(id);
        }
        await gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            await StopCoreAsync(id, cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            gate.Release();
        }
    }

    /// <summary>执行停止（调用方须已持有该渠道生命周期锁）。</summary>
    private async Task StopCoreAsync(string id, CancellationToken cancellationToken)
    {
        IChannelAdapter? adapter;
        lock (_sync)
        {
            if (!_adapters.TryGetValue(id, out adapter)) return;
            if (!_started.Remove(id))
            {
                if (_starting.Contains(id)) _stopRequested.Add(id);
                return;
            }
        }
        try
        {
            await adapter.StopAsync(cancellationToken).ConfigureAwait(false);
            _logger.LogInformation("渠道已停止 channel={Channel}", id);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "渠道停止失败 channel={Channel}", id);
        }
    }

    private SemaphoreSlim LifecycleLock(string id)
    {
        lock (_sync) return LifecycleLockLocked(id);
    }

    private SemaphoreSlim LifecycleLockLocked(string id)
    {
        if (!_lifecycle.TryGetValue(id, out var gate))
        {
            gate = new SemaphoreSlim(1, 1);
            _lifecycle[id] = gate;
        }
        return gate;
    }

    /// <summary>启动所有已注册适配器（失败跳过，不影响其它渠道）。</summary>
    public async Task StartAllAsync(CancellationToken cancellationToken = default)
    {
        string[] ids;
        lock (_sync) ids = _adapters.Keys.ToArray();
        foreach (var id in ids)
        {
            await StartAsync(id, cancellationToken);
        }
    }

    public async Task StopAllAsync(CancellationToken cancellationToken = default)
    {
        string[] ids;
        // 遍历全部适配器（含启动中）：StopAsync 对启动中的实例登记补停，停机不留残余
        lock (_sync) ids = _adapters.Keys.ToArray();
        foreach (var id in ids)
        {
            await StopAsync(id, cancellationToken);
        }
    }

    /// <summary>适配器是否运行中或启动中（归属 sweep 自愈判定用）。</summary>
    public bool IsRunning(string id)
    {
        lock (_sync) return _started.Contains(id) || _starting.Contains(id);
    }

    public IChannelAdapter? GetAdapter(string id)
    {
        lock (_sync) return _adapters.TryGetValue(id, out var adapter) ? adapter : null;
    }

    public IReadOnlyList<string> ListChannels()
    {
        lock (_sync) return _adapters.Keys.ToArray();
    }

    /// <summary>状态快照（状态端点/UI 用）。</summary>
    public Dictionary<string, ChannelStatus> GetAllStatus()
    {
        IChannelAdapter[] adapters;
        lock (_sync) adapters = _adapters.Values.ToArray();
        var status = new Dictionary<string, ChannelStatus>(StringComparer.Ordinal);
        foreach (var adapter in adapters)
        {
            try
            {
                status[adapter.Id] = adapter.GetStatus();
            }
            catch (Exception ex)
            {
                status[adapter.Id] = new ChannelStatus
                {
                    Enabled = false,
                    Phase = ChannelPhases.Error,
                    Message = ex.Message,
                };
            }
        }
        return status;
    }

    private Func<IncomingMessage, CancellationToken, Task<OutgoingMessage?>> MakeHandler(string channel) =>
        async (message, cancellationToken) =>
        {
            var dispatcher = _dispatcher;
            if (dispatcher is null)
            {
                _logger.LogWarning("收到入站消息但 dispatcher 未注册 channel={Channel}", channel);
                return null;
            }
            try
            {
                return await dispatcher(message, cancellationToken);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                return null;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "dispatcher 处理失败 channel={Channel}", channel);
                return null;
            }
        };
}

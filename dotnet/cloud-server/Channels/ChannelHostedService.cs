using CyreneCloud.Dialog;

namespace CyreneCloud.Channels;

/// <summary>
/// 渠道托管服务（§2.3/§5.1）：BackgroundService，与 DialogLoop 同模式。
///
/// 启动顺序：ChannelStore（DI 构造）→ 按 <see cref="ChannelAdapterCatalog"/> 注册已配置渠道
/// → ChannelOwnershipService.InitializeAsync（服务端默认持有；桌面未过期租约保持 paused）
/// → 仅启动服务端持有的渠道（失败记 error，不影响其它渠道与同步 API）。
/// 运行期：每 5s 扫描过期租约（R3 自动收回并启动），每小时清理去重表。
/// R6：服务端生成未启用（无 CLOUD_LLM_API_KEY）时不启动适配器（状态 config_missing）。
/// 渠道异常不得使服务端进程退出（适配器自行捕获；托管层兜底 catch）。
/// </summary>
public sealed class ChannelHostedService : BackgroundService
{
    private static readonly TimeSpan SeenCleanupInterval = TimeSpan.FromHours(1);
    private static readonly TimeSpan SeenTtl = TimeSpan.FromDays(30);
    private static readonly TimeSpan LeaseSweepInterval = TimeSpan.FromSeconds(5);

    private readonly ChannelOptions _options;
    private readonly ChannelManager _manager;
    private readonly ChannelDispatcher _dispatcher;
    private readonly ChannelStore _store;
    private readonly ChannelOwnershipService _ownership;
    private readonly ModelClient _model;
    private readonly IEnumerable<IChannelAdapterRegistration> _registrations;
    private readonly IServiceProvider _services;
    private readonly ILogger<ChannelHostedService> _logger;

    public ChannelHostedService(
        ChannelOptions options,
        ChannelManager manager,
        ChannelDispatcher dispatcher,
        ChannelStore store,
        ChannelOwnershipService ownership,
        ModelClient model,
        IEnumerable<IChannelAdapterRegistration> registrations,
        IServiceProvider services,
        ILogger<ChannelHostedService> logger)
    {
        _options = options;
        _manager = manager;
        _dispatcher = dispatcher;
        _store = store;
        _ownership = ownership;
        _model = model;
        _registrations = registrations;
        _services = services;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!_options.ChannelsEnabled)
        {
            _logger.LogInformation("渠道层未启用（CLOUD_CHANNELS 为空）");
            return;
        }
        if (!_model.Enabled)
        {
            // §2.4 R6：没有生成能力的渠道聊天是坏体验——显式不可用，不拉取消息
            _logger.LogWarning("渠道层已配置但服务端生成未启用（CLOUD_LLM_API_KEY 为空），托管状态 config_missing");
            return;
        }

        foreach (var registration in _registrations)
        {
            if (!_options.IsChannelEnabled(registration.ChannelId)) continue;
            try
            {
                if (!registration.IsConfigured(_options))
                {
                    _logger.LogWarning("渠道配置缺失，跳过托管 channel={Channel}", registration.ChannelId);
                    continue;
                }
                _manager.Register(registration.Create(_services));
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "渠道适配器注册失败 channel={Channel}", registration.ChannelId);
            }
        }

        _manager.SetDispatcher((message, cancellationToken) =>
            _dispatcher.HandleIncomingAsync(message, cancellationToken));

        // 归属初始化（§5.5）：服务端默认持有；owner=desktop 且租约未过期的渠道保持 paused。
        // 归属服务异常时 fail-open 启动全部已注册渠道（与阶段 2 行为一致），不影响进程。
        IReadOnlyList<string> serverOwned;
        try
        {
            serverOwned = await _ownership.InitializeAsync(_manager.ListChannels(), stoppingToken);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "渠道归属初始化失败，回退启动全部已注册渠道");
            serverOwned = _manager.ListChannels();
        }
        foreach (var id in serverOwned)
        {
            await _manager.StartAsync(id, stoppingToken);
        }

        var nextSeenCleanup = DateTimeOffset.UtcNow + SeenCleanupInterval;
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await Task.Delay(LeaseSweepInterval, stoppingToken);
            }
            catch (OperationCanceledException)
            {
                break;
            }
            try
            {
                var reclaimed = await _ownership.SweepExpiredAsync(stoppingToken);
                foreach (var id in reclaimed)
                {
                    _logger.LogInformation("渠道租约过期已收回 event=expire channel={Channel}", id);
                }
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "渠道租约扫描失败");
            }
            if (DateTimeOffset.UtcNow < nextSeenCleanup) continue;
            nextSeenCleanup = DateTimeOffset.UtcNow + SeenCleanupInterval;
            try
            {
                var removed = await _store.CleanupSeenAsync(SeenTtl, stoppingToken);
                if (removed > 0) _logger.LogInformation("渠道去重表清理 removed={Removed}", removed);
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "渠道去重表清理失败");
            }
        }
    }

    public override async Task StopAsync(CancellationToken cancellationToken)
    {
        await _manager.StopAllAsync(CancellationToken.None);
        await base.StopAsync(cancellationToken);
    }
}

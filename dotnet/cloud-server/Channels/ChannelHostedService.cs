using CyreneCloud.Dialog;

namespace CyreneCloud.Channels;

/// <summary>
/// 渠道托管服务（§2.3）：BackgroundService，与 DialogLoop 同模式。
///
/// 启动顺序：ChannelStore（DI 构造）→ 按 <see cref="ChannelAdapterCatalog"/> 注册已配置渠道
/// → ChannelHostedService 按配置逐个 StartAsync（失败记 error，不影响其它渠道与同步 API）。
/// 阶段 4 的归属判定经 ChannelDispatcher 门闩与后续 Start/Stop 钩子接入；本批启动全部已配置渠道。
/// R6：服务端生成未启用（无 CLOUD_LLM_API_KEY）时不启动适配器（状态 config_missing）。
/// 渠道异常不得使服务端进程退出（适配器自行捕获；托管层兜底 catch）。
/// </summary>
public sealed class ChannelHostedService : BackgroundService
{
    private static readonly TimeSpan SeenCleanupInterval = TimeSpan.FromHours(1);
    private static readonly TimeSpan SeenTtl = TimeSpan.FromDays(30);

    private readonly ChannelOptions _options;
    private readonly ChannelManager _manager;
    private readonly ChannelDispatcher _dispatcher;
    private readonly ChannelStore _store;
    private readonly ModelClient _model;
    private readonly IEnumerable<IChannelAdapterRegistration> _registrations;
    private readonly IServiceProvider _services;
    private readonly ILogger<ChannelHostedService> _logger;

    public ChannelHostedService(
        ChannelOptions options,
        ChannelManager manager,
        ChannelDispatcher dispatcher,
        ChannelStore store,
        ModelClient model,
        IEnumerable<IChannelAdapterRegistration> registrations,
        IServiceProvider services,
        ILogger<ChannelHostedService> logger)
    {
        _options = options;
        _manager = manager;
        _dispatcher = dispatcher;
        _store = store;
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
        await _manager.StartAllAsync(stoppingToken);

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await Task.Delay(SeenCleanupInterval, stoppingToken);
            }
            catch (OperationCanceledException)
            {
                break;
            }
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

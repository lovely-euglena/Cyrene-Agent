using System.Collections.Concurrent;
using System.Threading.Channels;
using CyreneCloud.Storage;

namespace CyreneCloud.Dialog;

/// <summary>
/// 服务端文本对话闭环（IKJK2M）：push 后异步触发 → <see cref="IDialogEngine"/> 生成 →
/// <see cref="ServerEventWriter"/> 幂等写回 assistant 事件（§2.4 决策 R3/R4）。
///
/// - 队列/重试/写回留在本类；重放与模型调用在 DialogEngine（渠道生成共用）；
/// - 幂等：assistant eventId = "gen-" + sha256(sessionId:锚点事件id)[..32]（引擎预检 + 写者幂等索引）；
/// - 失败重试：模型调用 2 次退避（引擎内）；仍失败只记日志，等待下一次事件触发（无副作用残留）；
/// - 日志只含 sessionId / 模型名 / token 用量，不含消息正文与密钥。
/// </summary>
public sealed class DialogLoop : BackgroundService
{
    private const int QueueCapacity = 10_000;

    private readonly IDialogEngine _engine;
    private readonly ServerEventWriter _writer;
    private readonly ILogger<DialogLoop> _logger;
    private readonly ModelClient _model;

    // 有界队列（Phase 1 内存预算 512MB）：满载时拒绝新入队并告警——不阻塞 push，
    // 撤销去重标记后由后续事件再次触发（不静默丢弃）。
    private readonly Channel<string> _queue = Channel.CreateBounded<string>(
        new BoundedChannelOptions(QueueCapacity)
        {
            SingleReader = true,
            FullMode = BoundedChannelFullMode.Wait, // TryWrite 满载返回 false，不阻塞
        });
    private readonly ConcurrentDictionary<string, byte> _queued = new();

    public DialogLoop(IDialogEngine engine, ServerEventWriter writer, ModelClient model, ILogger<DialogLoop> logger)
    {
        _engine = engine;
        _writer = writer;
        _model = model;
        _logger = logger;
    }

    /// <summary>push 成功后投递「有新用户消息/回退」的会话（去重；模型未启用时静默忽略）。</summary>
    public void Publish(IEnumerable<string> sessionIds)
    {
        if (!_model.Enabled) return;
        foreach (var sessionId in sessionIds)
        {
            if (!_queued.TryAdd(sessionId, 0)) continue;
            if (!_queue.Writer.TryWrite(sessionId))
            {
                // 队列满载：撤销去重标记并告警（后续事件可再次触发，避免静默丢弃）
                _queued.TryRemove(sessionId, out _);
                _logger.LogWarning("对话队列已满（{Capacity}），跳过本次触发 session={Session}",
                    QueueCapacity, sessionId);
            }
        }
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            await foreach (var sessionId in _queue.Reader.ReadAllAsync(stoppingToken))
            {
                _queued.TryRemove(sessionId, out _);
                try
                {
                    await ProcessSessionAsync(sessionId, stoppingToken);
                }
                catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
                {
                    throw;
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "生成失败 session={Session}", sessionId);
                }
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
            // 正常停机
        }
    }

    private async Task ProcessSessionAsync(string sessionId, CancellationToken cancellationToken)
    {
        var reply = await _engine.GenerateAsync(sessionId, cancellationToken);
        if (reply is null) return;
        var outcome = await _writer.WriteAssistantMessageAsync(
            sessionId, reply.EventId, reply.TurnId, reply.Text, withPresentation: false, cancellationToken);
        if (outcome.Status == ServerWriteStatus.Failed)
        {
            _logger.LogWarning("生成写回被拒 session={Session} event={Event} errors={Errors}",
                sessionId, reply.EventId, string.Join(",", outcome.Errors.Select(item => item.Code)));
        }
    }
}

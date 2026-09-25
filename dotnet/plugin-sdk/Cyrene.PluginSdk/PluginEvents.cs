using System.Text.Json;

namespace Cyrene.PluginSdk;

/// <summary>
/// 事件入口（<see cref="CyrenePluginBase.Events"/>）。
/// 订阅的宿主事件会随 ready 声明给宿主，宿主以 <c>event.deliver</c> 通知投递；
/// 同一个事件名只保留最后注册的 handler（Node 轨支持多监听器，.NET 轨首版收窄为单监听）。
/// </summary>
public sealed class PluginEvents
{
    private readonly CyrenePluginBase _plugin;

    internal PluginEvents(CyrenePluginBase plugin) => _plugin = plugin;

    /// <summary>
    /// 订阅宿主事件（<c>host:*</c>）。payload 以 JSON 原样传入；
    /// handler 在线程池执行，异常只写 stderr 不影响宿主。
    /// </summary>
    public void On(string @event, Func<JsonElement, CancellationToken, Task> handler)
        => _plugin.SubscribeEvent(@event, handler);

    /// <summary>退订事件（未订阅时静默忽略）。</summary>
    public void Off(string @event) => _plugin.UnsubscribeEvent(@event);

    /// <summary>
    /// 向宿主发布插件事件（框架自动补成 <c>plugin:&lt;id&gt;:&lt;event&gt;</c>；
    /// 返回的 Task 在宿主事件总线派发完成后完成）。
    /// </summary>
    public Task EmitAsync(string @event, object? payload = null)
        => _plugin.EmitEventCoreAsync(@event, payload);
}

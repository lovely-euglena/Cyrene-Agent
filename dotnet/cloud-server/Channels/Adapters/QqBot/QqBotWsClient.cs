using System.Net.WebSockets;
using System.Text.Json;
using CyreneNative.Channels;

namespace CyreneCloud.Channels.Adapters.QqBot;

/// <summary>
/// <see cref="QqBotWsClient"/> 选项。SocketFactory / 退避 / 心跳下限 / 时钟均可注入，
/// selftest 用 fake 网关 + 短间隔；生产用默认值（退避 1s→60s、心跳按服务端指定）。
/// </summary>
public sealed class QqBotWsClientOptions
{
    /// <summary>网关地址（GET /gateway 返回的 wss URL）。</summary>
    public required string GatewayUrl { get; init; }

    /// <summary>返回有效 access_token（刷新由 <see cref="QqBotApiClient"/> 负责）。</summary>
    public required Func<CancellationToken, Task<string>> GetAccessToken { get; init; }

    /// <summary>WebSocket 连接工厂（缺省 = <see cref="ClientWebSocket"/>）。</summary>
    public Func<Uri, CancellationToken, Task<IQqBotWebSocket>>? SocketFactory { get; init; }

    /// <summary>事件订阅 intents（缺省 1&lt;&lt;25 = 单聊 + 群 @/群全量）。</summary>
    public int Intents { get; init; } = QqBotWsClient.IntentGroupAndC2C;

    public TimeSpan InitialBackoff { get; init; } = TimeSpan.FromSeconds(1);
    public TimeSpan MaxBackoff { get; init; } = TimeSpan.FromSeconds(60);

    /// <summary>op9 Invalid Session 后重新 Identify 的延迟（TS 侧固定 3s）。</summary>
    public TimeSpan InvalidSessionDelay { get; init; } = TimeSpan.FromSeconds(3);

    /// <summary>心跳间隔下限（TS 侧 Math.max(1000, heartbeat_interval)；selftest 调小）。</summary>
    public int MinHeartbeatIntervalMs { get; init; } = 1_000;

    /// <summary>
    /// P2-5：单项发送限时（缺省 10s）。发送挂起（网络黑洞 / TCP 重传期）时释放发送门并强制断开
    /// 触发重连，避免心跳/Identify/Resume 排队等锁导致自愈停摆；≤0 关闭限时（不推荐）。
    /// </summary>
    public TimeSpan SendTimeout { get; init; } = TimeSpan.FromSeconds(10);

    public TimeProvider TimeProvider { get; init; } = TimeProvider.System;

    /// <summary>Dispatch 事件（READY/RESUMED 由客户端内部消费，不转发）。</summary>
    public Action<string, JsonElement>? OnDispatch { get; init; }

    /// <summary>连接状态变化（true = 已通过鉴权收到 READY/RESUMED）。</summary>
    public Action<bool>? OnReadyChange { get; init; }

    public Action<Exception>? OnError { get; init; }
}

/// <summary>
/// QQ 官方机器人 WebSocket 网关客户端（TS `qqbot-ws-client.ts` 的 C# 移植）。
///
/// 协议（官方 opcode 约定）：
///   op 10 Hello      —— 连上后第一条，d.heartbeat_interval(ms) 指定心跳周期
///   op 2  Identify   —— 客户端鉴权 {token: "QQBot &lt;access_token&gt;", intents, shard, properties}
///   op 0  Dispatch   —— 服务端事件推送 {t: 事件名, s: 序号, d: 事件体}
///   op 1  Heartbeat  —— 客户端心跳，d = 最近收到的 s
///   op 11 Heartbeat ACK
///   op 7  Reconnect  —— 服务端要求重连（优先 Resume）
///   op 6  Resume     —— 断线恢复 {token, session_id, seq}
///   op 9  Invalid Session —— identify/resume 参数错，d=false 时必须重新 Identify
///
/// 稳定性：心跳连续两个周期无 ACK → 中止连接触发重连；断线退避 1s→60s；
/// 有 session_id+seq 时走 Resume，否则重新 Identify；Stop 打断所有在途等待。
/// </summary>
public sealed class QqBotWsClient
{
    /// <summary>GROUP_AND_C2C_EVENT = 1&lt;&lt;25（覆盖 C2C/群 @/群全量消息）。</summary>
    public const int IntentGroupAndC2C = 1 << 25;

    private readonly QqBotWsClientOptions _options;
    private readonly object _sync = new();
    /// <summary>P2-3(b)：WS 同一时刻只允许一个未完成 Send；Identify/Resume/心跳共用此队列串行化。</summary>
    private readonly SemaphoreSlim _sendGate = new(1, 1);

    private CancellationTokenSource? _cts;
    private CancellationTokenSource? _heartbeatCts;
    private IQqBotWebSocket? _socket;
    private Task? _receiveTask;
    private Task? _heartbeatTask;
    private Task? _reconnectTask;
    private Task? _identifyTask;
    private bool _stopped = true;
    private bool _reconnectScheduled;
    private bool _ready;
    private long _seq;
    private string _sessionId = "";
    private TimeSpan _backoff;
    private volatile bool _heartbeatAcked = true;
    private Exception? _lastError;

    public QqBotWsClient(QqBotWsClientOptions options)
    {
        _options = options;
        _backoff = options.InitialBackoff;
    }

    public bool IsReady
    {
        get
        {
            lock (_sync) return _ready;
        }
    }

    public Exception? LastError
    {
        get
        {
            lock (_sync) return _lastError;
        }
    }

    /// <summary>READY 事件里的机器人昵称（状态展示用）。</summary>
    public string BotNickname { get; private set; } = "";

    public async Task StartAsync(CancellationToken cancellationToken = default)
    {
        lock (_sync)
        {
            if (!_stopped) return;
            _stopped = false;
            _cts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            _backoff = _options.InitialBackoff;
        }
        await ConnectAsync(resume: false);
    }

    public async Task StopAsync(CancellationToken cancellationToken = default)
    {
        CancellationTokenSource? cts;
        IQqBotWebSocket? socket;
        Task?[] pending;
        lock (_sync)
        {
            _stopped = true;
            cts = _cts;
            _cts = null;
            socket = _socket;
            _socket = null;
            pending = [_receiveTask, _heartbeatTask, _reconnectTask, _identifyTask];
            _reconnectScheduled = false;
        }
        StopHeartbeat();
        try
        {
            cts?.Cancel();
        }
        catch (ObjectDisposedException)
        {
            // 已释放：忽略
        }
        if (socket is not null)
        {
            try
            {
                await socket.CloseAsync(1000, "client shutdown", CancellationToken.None);
            }
            catch
            {
                // 已断开时 close 会抛错，忽略
            }
        }
        foreach (var task in pending)
        {
            if (task is null) continue;
            try
            {
                await task.WaitAsync(TimeSpan.FromSeconds(2), cancellationToken);
            }
            catch
            {
                // 已取消/超时：不阻塞停止流程
            }
        }
        if (socket is not null)
        {
            try
            {
                await socket.DisposeAsync();
            }
            catch
            {
                // 忽略
            }
        }
        cts?.Dispose();
        SetReady(false);
    }

    public async ValueTask DisposeAsync() => await StopAsync(CancellationToken.None);

    private async Task ConnectAsync(bool resume)
    {
        CancellationToken cancellationToken;
        lock (_sync)
        {
            if (_stopped || _cts is null) return;
            cancellationToken = _cts.Token;
        }
        if (cancellationToken.IsCancellationRequested) return;

        string accessToken;
        try
        {
            accessToken = await _options.GetAccessToken(cancellationToken);
        }
        catch (OperationCanceledException)
        {
            return;
        }
        catch (Exception ex)
        {
            HandleError(ex);
            ScheduleReconnect();
            return;
        }

        IQqBotWebSocket socket;
        try
        {
            var factory = _options.SocketFactory ?? DefaultSocketFactoryAsync;
            socket = await factory(new Uri(_options.GatewayUrl), cancellationToken);
        }
        catch (OperationCanceledException)
        {
            return;
        }
        catch (Exception ex)
        {
            HandleError(ex);
            ScheduleReconnect();
            return;
        }

        lock (_sync)
        {
            if (_stopped || cancellationToken.IsCancellationRequested)
            {
                _ = socket.DisposeAsync();
                return;
            }
            _socket = socket;
            _heartbeatAcked = true;
            _receiveTask = Task.Run(() => ReceiveLoopAsync(socket, accessToken, resume, cancellationToken));
        }
    }

    private async Task ReceiveLoopAsync(
        IQqBotWebSocket socket, string accessToken, bool resume, CancellationToken cancellationToken)
    {
        try
        {
            while (!cancellationToken.IsCancellationRequested)
            {
                var raw = await socket.ReceiveTextAsync(cancellationToken);
                if (raw is null) break;
                JsonDocument document;
                try
                {
                    document = JsonDocument.Parse(raw);
                }
                catch (JsonException ex)
                {
                    HandleError(ex);
                    continue;
                }
                using (document)
                {
                    await HandlePayloadAsync(document.RootElement, accessToken, resume);
                }
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            // 正常停止
        }
        catch (Exception ex)
        {
            HandleError(ex);
        }
        finally
        {
            StopHeartbeat();
            SetReady(false);
            lock (_sync)
            {
                if (ReferenceEquals(_socket, socket)) _socket = null;
            }
            if (!cancellationToken.IsCancellationRequested) ScheduleReconnect();
        }
    }

    private async Task HandlePayloadAsync(JsonElement payload, string accessToken, bool resume)
    {
        if (!payload.TryGetProperty("op", out var opElement) || opElement.ValueKind != JsonValueKind.Number) return;
        switch (opElement.GetInt32())
        {
            case 10:
            {
                // Hello：按服务端指定周期发心跳，然后鉴权（可 Resume 时优先 Resume）
                var intervalMs = 30_000;
                if (payload.TryGetProperty("d", out var helloData) && helloData.ValueKind == JsonValueKind.Object
                    && helloData.TryGetProperty("heartbeat_interval", out var heartbeat)
                    && heartbeat.ValueKind == JsonValueKind.Number
                    && heartbeat.TryGetDouble(out var value))
                {
                    intervalMs = (int)value;
                }
                StartHeartbeat(intervalMs);
                var (sessionId, seq) = SnapshotSession();
                if (resume && sessionId.Length > 0 && seq > 0)
                {
                    await SendPayloadAsync(new
                    {
                        op = 6,
                        d = new { token = $"QQBot {accessToken}", session_id = sessionId, seq },
                    });
                }
                else
                {
                    await SendIdentifyAsync(accessToken);
                }
                break;
            }
            case 0:
            {
                // Dispatch：记录序号 + 抛事件（READY/RESUMED 内部消费）
                if (payload.TryGetProperty("s", out var seqElement) && seqElement.ValueKind == JsonValueKind.Number)
                {
                    lock (_sync) _seq = seqElement.GetInt64();
                }
                var type = payload.TryGetProperty("t", out var typeElement) && typeElement.ValueKind == JsonValueKind.String
                    ? typeElement.GetString() ?? ""
                    : "";
                var data = payload.TryGetProperty("d", out var dataElement) ? dataElement : default;
                if (type == "READY")
                {
                    var sessionId = data.ValueKind == JsonValueKind.Object
                        ? ChannelJsonValue.StringOrEmpty(data, "session_id")
                        : "";
                    lock (_sync)
                    {
                        _sessionId = sessionId;
                        _backoff = _options.InitialBackoff;
                    }
                    if (data.ValueKind == JsonValueKind.Object
                        && data.TryGetProperty("user", out var user) && user.ValueKind == JsonValueKind.Object)
                    {
                        BotNickname = ChannelJsonValue.OptionalString(user, "username") ?? "";
                    }
                    SetReady(true);
                }
                else if (type == "RESUMED")
                {
                    lock (_sync) _backoff = _options.InitialBackoff;
                    SetReady(true);
                }
                else
                {
                    _options.OnDispatch?.Invoke(type, data);
                }
                break;
            }
            case 11:
                // Heartbeat ACK
                _heartbeatAcked = true;
                break;
            case 7:
                // 服务端要求重连：关闭当前连接 → 接收循环结束 → 退避后优先 Resume
                _ = CloseSocketAsync(4000, "server requested reconnect");
                break;
            case 9:
            {
                // Invalid Session：丢弃旧 session，延迟后重新 Identify
                lock (_sync)
                {
                    _sessionId = "";
                    _seq = 0;
                }
                ScheduleIdentify(accessToken);
                break;
            }
        }
    }

    private Task SendIdentifyAsync(string accessToken) => SendPayloadAsync(new
    {
        op = 2,
        d = new
        {
            token = $"QQBot {accessToken}",
            intents = _options.Intents,
            shard = new[] { 0, 1 },
            properties = new Dictionary<string, string>
            {
                ["$os"] = OperatingSystem.IsWindows() ? "windows" : OperatingSystem.IsLinux() ? "linux" : "macos",
                ["$browser"] = "cyrene",
                ["$device"] = "cyrene",
            },
        },
    });

    /// <summary>
    /// P2-3(b)：发送串行化并 await（WS 不允许并发的未完成 Send；心跳/Identify/Resume 共用队列），
    /// 失败经 <see cref="SendRawAsync"/> → HandleError 可观察，不再 fire-and-forget 丢失。
    /// </summary>
    private async Task SendPayloadAsync(object payload)
    {
        var json = JsonSerializer.Serialize(payload);
        CancellationToken cancellationToken;
        lock (_sync) cancellationToken = _cts?.Token ?? CancellationToken.None;
        try
        {
            await _sendGate.WaitAsync(cancellationToken);
        }
        catch (OperationCanceledException)
        {
            return; // 停止中：放弃发送
        }
        try
        {
            IQqBotWebSocket? socket;
            lock (_sync) socket = _socket;
            if (socket is null || !socket.IsOpen) return;
            await SendRawAsync(socket, json, cancellationToken);
        }
        finally
        {
            _sendGate.Release();
        }
    }

    private async Task SendRawAsync(IQqBotWebSocket socket, string json, CancellationToken cancellationToken)
    {
        // P2-5：单项发送限时——发送挂起时不能无限占用发送门（否则心跳循环停在
        // await SendPayloadAsync，走不到「连续两周期无 ACK → AbortSocket」判定，
        // Identify/Resume 也全部排队）。停止取消（外部 token）与发送超时（linked CTS）区分：
        // 前者静默放弃；后者视连接不可信，强制断开触发重连自愈。
        var timeout = _options.SendTimeout;
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        if (timeout > TimeSpan.Zero) linked.CancelAfter(timeout);
        try
        {
            await socket.SendTextAsync(json, linked.Token);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            // 停止中：忽略
        }
        catch (OperationCanceledException) when (timeout > TimeSpan.Zero && linked.IsCancellationRequested)
        {
            HandleError(new TimeoutException($"QQ Bot 发送超时（{timeout.TotalSeconds:0}s），重连"));
            AbortSocket();
        }
        catch (Exception ex)
        {
            HandleError(ex);
        }
    }

    private void StartHeartbeat(int intervalMs)
    {
        StopHeartbeat();
        CancellationTokenSource heartbeatCts;
        lock (_sync)
        {
            _heartbeatAcked = true;
            if (_cts is null || _stopped) return;
            heartbeatCts = CancellationTokenSource.CreateLinkedTokenSource(_cts.Token);
            _heartbeatCts = heartbeatCts;
        }
        var interval = TimeSpan.FromMilliseconds(Math.Max(_options.MinHeartbeatIntervalMs, intervalMs));
        var cancellationToken = heartbeatCts.Token;
        _heartbeatTask = Task.Run(async () =>
        {
            try
            {
                while (!cancellationToken.IsCancellationRequested)
                {
                    await Task.Delay(interval, _options.TimeProvider, cancellationToken);
                    if (!_heartbeatAcked)
                    {
                        // 连续两个周期没 ACK：连接假死，强制断开触发重连
                        HandleError(new InvalidOperationException("QQ Bot 心跳超时，重连"));
                        AbortSocket();
                        return;
                    }
                    _heartbeatAcked = false;
                    long seq;
                    lock (_sync) seq = _seq;
                    await SendPayloadAsync(new { op = 1, d = seq > 0 ? (object)seq : null });
                }
            }
            catch (OperationCanceledException)
            {
                // 正常停止
            }
            catch (Exception ex)
            {
                HandleError(ex);
            }
        });
    }

    private void StopHeartbeat()
    {
        CancellationTokenSource? heartbeatCts;
        lock (_sync)
        {
            heartbeatCts = _heartbeatCts;
            _heartbeatCts = null;
        }
        if (heartbeatCts is null) return;
        try
        {
            heartbeatCts.Cancel();
        }
        catch (ObjectDisposedException)
        {
            // 已释放：忽略
        }
    }

    private void AbortSocket()
    {
        IQqBotWebSocket? socket;
        lock (_sync) socket = _socket;
        socket?.Abort();
    }

    private async Task CloseSocketAsync(int code, string reason)
    {
        IQqBotWebSocket? socket;
        lock (_sync) socket = _socket;
        if (socket is null) return;
        try
        {
            await socket.CloseAsync(code, reason, CancellationToken.None);
        }
        catch
        {
            // 已断开：忽略
        }
    }

    private void ScheduleReconnect()
    {
        CancellationToken cancellationToken;
        TimeSpan delay;
        bool canResume;
        lock (_sync)
        {
            if (_stopped || _reconnectScheduled || _cts is null) return;
            _reconnectScheduled = true;
            cancellationToken = _cts.Token;
            delay = _backoff;
            _backoff = TimeSpan.FromTicks(Math.Min(_backoff.Ticks * 2, _options.MaxBackoff.Ticks));
            canResume = _sessionId.Length > 0 && _seq > 0;
        }
        _reconnectTask = Task.Run(async () =>
        {
            try
            {
                await Task.Delay(delay, _options.TimeProvider, cancellationToken);
            }
            catch (OperationCanceledException)
            {
                return;
            }
            lock (_sync)
            {
                _reconnectScheduled = false;
                if (_stopped) return;
            }
            await ConnectAsync(canResume);
        });
    }

    private void ScheduleIdentify(string accessToken)
    {
        CancellationToken cancellationToken;
        lock (_sync)
        {
            if (_stopped || _cts is null) return;
            cancellationToken = _cts.Token;
        }
        _identifyTask = Task.Run(async () =>
        {
            try
            {
                await Task.Delay(_options.InvalidSessionDelay, _options.TimeProvider, cancellationToken);
            }
            catch (OperationCanceledException)
            {
                return;
            }
            lock (_sync)
            {
                if (_stopped) return;
            }
            await SendIdentifyAsync(accessToken);
        });
    }

    private (string SessionId, long Seq) SnapshotSession()
    {
        lock (_sync) return (_sessionId, _seq);
    }

    private void SetReady(bool ready)
    {
        bool changed;
        lock (_sync)
        {
            changed = _ready != ready;
            _ready = ready;
        }
        if (changed) _options.OnReadyChange?.Invoke(ready);
    }

    private void HandleError(Exception error)
    {
        lock (_sync) _lastError = error;
        _options.OnError?.Invoke(error);
    }

    private static async Task<IQqBotWebSocket> DefaultSocketFactoryAsync(Uri uri, CancellationToken cancellationToken)
    {
        var socket = new ClientWebSocket();
        try
        {
            await socket.ConnectAsync(uri, cancellationToken);
            return new ClientWebSocketTransport(socket);
        }
        catch
        {
            socket.Dispose();
            throw;
        }
    }
}

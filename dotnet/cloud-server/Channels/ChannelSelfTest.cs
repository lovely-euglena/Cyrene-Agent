using System.Text.Json;
using CyreneCloud.Channels.Adapters.WeChat;
using CyreneCloud.Channels.Adapters.Feishu;
using CyreneCloud.Dialog;
using CyreneCloud.Storage;
using CyreneNative.Channels;
using System.Net;
using System.Text;
using System.Threading.Channels;
using CyreneCloud.Channels.Adapters.QqBot;
using CyreneNative.Channels.Normalizers;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Logging.Abstractions;

namespace CyreneCloud.Channels;

/// <summary>
/// 渠道自测（裸跑：cyrene-cloud-server channel-selftest framework|wechat|feishu|qqbot|ownership|all；--selftest framework 同义）。
///
/// framework = 阶段 2 框架批（设计 §8.2/§8.3）：ChannelOptions 解析、ChannelStore（去重/收件人/回执/
/// 凭据加解密/归属表原语）、ChannelManager（注册/单实例守卫/状态）、ServerEventWriter
/// （lamport/seq 原子分配、幂等、presentation 形态）、ChannelDispatcher 端到端（写事件/生成/
/// 投递/回执/门闩）与 ChannelDeliveryService 重试。
/// wechat = 阶段 3 微信 iLink 试点（mock iLink HTTP：文本/图片收发、CDN、重连、QR 状态机）；
/// feishu = 阶段 5 飞书 webhook（加密/签名向量 + 回放 + 转码两态）；qqbot = 阶段 6 被动回复；
/// ownership = 阶段 4 归属批（状态机/租约过期/交拍时序/进程重启接管、
/// ChannelProactiveService intentId 幂等与投递失败回执）。
/// </summary>
internal static class ChannelSelfTest
{
    /// <summary>本次进程已执行的检查项计数（RunAllAsync 汇总输出口径）。</summary>
    internal static int CheckCount;

    public static int Run(string suite)
    {
        try
        {
            return suite switch
            {
                "framework" => RunFrameworkAsync().GetAwaiter().GetResult(),
                "wechat" => WeChatSelfTest.RunAsync().GetAwaiter().GetResult(),
                "feishu" => FeishuSelfTest.RunAsync().GetAwaiter().GetResult(),
                "qqbot" => RunQqBotAsync().GetAwaiter().GetResult(),
                "ownership" => RunOwnershipAsync().GetAwaiter().GetResult(),
                "all" => RunAllAsync().GetAwaiter().GetResult(),
                _ => Unknown(suite),
            };
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[FAIL] channel-selftest 异常: {ex}");
            Console.WriteLine($"SELFTEST channel {suite}: 1 FAILURES");
            return 1;
        }
    }

    private static async Task<int> RunAllAsync()
    {
        var failures = await RunFrameworkAsync();
        failures += WeChatSelfTest.RunAsync().GetAwaiter().GetResult();
        failures += FeishuSelfTest.RunAsync().GetAwaiter().GetResult();
        failures += await RunQqBotAsync();
        failures += await RunOwnershipAsync();
        Console.WriteLine(failures == 0
            ? $"SELFTEST channel all: ALL PASS（{CheckCount} checks）"
            : $"SELFTEST channel all: {failures} FAILURES（{CheckCount} checks）");
        return failures;
    }

    private delegate void CheckFn(string name, bool ok, string detail = "");

    private static int Unknown(string suite)
    {
        Console.WriteLine($"未知渠道自测子集: {suite}（可用: framework | wechat | feishu | qqbot | ownership | all）");
        return 2;
    }

    private static async Task<int> RunFrameworkAsync()
    {
        var failures = 0;
        void Check(string name, bool ok, string detail = "")
        {
            CheckCount++;
            if (ok)
            {
                Console.WriteLine($"[PASS] {name}");
            }
            else
            {
                failures++;
                Console.WriteLine($"[FAIL] {name} — {detail}");
            }
        }

        CheckOptions(Check);
        await CheckStoreAsync(Check);
        await CheckManagerAsync(Check);
        await CheckServerEventWriterAsync(Check);
        await CheckDispatcherAsync(Check);
        await CheckDeliveryRetryAsync(Check);

        Console.WriteLine(failures == 0
            ? "SELFTEST channel framework: ALL PASS"
            : $"SELFTEST channel framework: {failures} FAILURES");
        return failures;
    }

    // ── 1. ChannelOptions ────────────────────────────────────────────────────

    private static void CheckOptions(CheckFn check)
    {
        var keys = new[]
        {
            "CLOUD_CHANNELS", "CLOUD_CHANNEL_OWNERSHIP_TTL_SECONDS", "CLOUD_CHANNEL_FAILOVER_GRACE_SECONDS",
            "CLOUD_CHANNEL_WECHAT_MEDIA_MAX_MB", "CLOUD_CHANNEL_QQBOT_ALLOW_ANY_PRIVATE",
            "CLOUD_CHANNEL_FEISHU_AUDIO", "CLOUD_CHANNEL_QQBOT_ALLOWED_OPENIDS",
        };
        var saved = keys.ToDictionary(key => key, Environment.GetEnvironmentVariable);
        try
        {
            foreach (var key in keys) Environment.SetEnvironmentVariable(key, null);
            var defaults = ChannelOptions.FromEnvironment();
            check("options: 默认关闭 + 冻结默认值",
                !defaults.ChannelsEnabled
                && defaults.OwnershipTtlSeconds == 180 && defaults.FailoverGraceSeconds == 300
                && defaults.WeChatMediaMaxMb == 20 && defaults.MediaDirMb == 256 && defaults.FeishuAudio,
                JsonSerializer.Serialize(defaults));

            Environment.SetEnvironmentVariable("CLOUD_CHANNELS", "WeChat,feishu, unknown");
            Environment.SetEnvironmentVariable("CLOUD_CHANNEL_OWNERSHIP_TTL_SECONDS", "90");
            Environment.SetEnvironmentVariable("CLOUD_CHANNEL_FAILOVER_GRACE_SECONDS", "120");
            Environment.SetEnvironmentVariable("CLOUD_CHANNEL_WECHAT_MEDIA_MAX_MB", "10");
            Environment.SetEnvironmentVariable("CLOUD_CHANNEL_QQBOT_ALLOW_ANY_PRIVATE", "1");
            Environment.SetEnvironmentVariable("CLOUD_CHANNEL_FEISHU_AUDIO", "0");
            Environment.SetEnvironmentVariable("CLOUD_CHANNEL_QQBOT_ALLOWED_OPENIDS", "A,B");
            var options = ChannelOptions.FromEnvironment();
            check("options: CLOUD_CHANNELS 解析（小写/去重）",
                options.EnabledChannels.SequenceEqual(["wechat", "feishu", "unknown"]),
                string.Join(",", options.EnabledChannels));
            check("options: TTL/媒体上限/布尔解析",
                options.OwnershipTtlSeconds == 90 && options.FailoverGraceSeconds == 120
                && options.WeChatMediaMaxMb == 10 && options.QqBotAllowAnyPrivate && !options.FeishuAudio);
            check("options: 白名单解析", options.QqBotAllowedOpenIds.SequenceEqual(["A", "B"]));
            check("options: IsChannelEnabled 大小写不敏感",
                options.IsChannelEnabled("WECHAT") && options.IsChannelEnabled("feishu") && !options.IsChannelEnabled("qqbot"));
        }
        finally
        {
            foreach (var (key, value) in saved) Environment.SetEnvironmentVariable(key, value);
        }
    }

    // ── 2. ChannelStore ──────────────────────────────────────────────────────

    private static async Task CheckStoreAsync(CheckFn check)
    {
        var dir = NewTempDir("store");
        try
        {
            var dbPath = Path.Combine(dir, "channels.db");
            var protector = ChannelCredentialProtector.Create("master-token", dir);
            var store = new ChannelStore(dbPath, protector);

            var first = await store.MarkSeenAsync("wechat", "m1");
            var second = await store.MarkSeenAsync("wechat", "m1");
            check("store: seen 首次 true / 重复 false", first && !second, $"first={first} second={second}");
            await store.CleanupSeenAsync(TimeSpan.Zero);
            check("store: TTL 清理后可重新标记", await store.MarkSeenAsync("wechat", "m1"));

            await store.RememberRecipientAsync("wechat", "u1", null);
            await store.RememberRecipientAsync("wechat", "u2", "thread-1");
            var recent = await store.GetRecentRecipientAsync("wechat");
            check("store: 最近收件人（含 thread）",
                recent is { TargetId: "u2", ThreadId: "thread-1" }, JsonSerializer.Serialize(recent));

            await store.RecordReceiptAsync("wechat", "s1", "gen-x", ChannelStore.StatusFailed, "E_SEND_TEST");
            var receipts = await store.ListReceiptsAsync("wechat");
            check("store: 回执写入/读取",
                receipts.Count == 1 && receipts[0].Status == "failed" && receipts[0].ErrorCode == "E_SEND_TEST",
                JsonSerializer.Serialize(receipts));

            await store.SaveCredentialAsync("wechat", "{\"botToken\":\"secret\"}");
            check("store: 凭据 AES-GCM 往返",
                await store.LoadCredentialAsync("wechat") == "{\"botToken\":\"secret\"}");
            check("store: 凭据保护姿态 aes-gcm",
                await store.CredentialProtectionAsync("wechat") == ChannelCredentialProtector.AesGcmScheme);
            var noProtector = new ChannelStore(dbPath);
            check("store: 密文在无保护器时读不到", await noProtector.LoadCredentialAsync("wechat") is null);

            var plainStore = new ChannelStore(Path.Combine(dir, "plain.db"));
            await plainStore.SaveCredentialAsync("feishu", "plain-value");
            check("store: 无保护器降级 plain 明文",
                await plainStore.LoadCredentialAsync("feishu") == "plain-value"
                && await plainStore.CredentialProtectionAsync("feishu") == ChannelCredentialProtector.PlainScheme);

            await store.UpsertOwnershipAsync("wechat", "server", null, null);
            var ownership = await store.ListOwnershipAsync();
            check("store: 归属表读写原语（状态机属阶段 4）",
                ownership.Count == 1 && ownership[0] is { Channel: "wechat", Owner: "server" });
        }
        finally
        {
            CleanupTempDir(dir);
        }
    }

    // ── 3. ChannelManager ────────────────────────────────────────────────────

    private static async Task CheckManagerAsync(CheckFn check)
    {
        var manager = new ChannelManager(NullLogger<ChannelManager>.Instance);
        var adapter = new FakeAdapter(ChannelIds.WeChat);
        manager.Register(adapter);
        var duplicateRejected = false;
        try
        {
            manager.Register(new FakeAdapter(ChannelIds.WeChat));
        }
        catch (InvalidOperationException)
        {
            duplicateRejected = true;
        }
        check("manager: 重复注册拒绝", duplicateRejected);
        check("manager: 注册表可见", manager.Has("wechat") && manager.ListChannels().Count == 1);

        manager.SetDispatcher((message, _) => Task.FromResult<OutgoingMessage?>(new OutgoingMessage
        {
            Channel = message.Channel,
            TargetId = message.ChatId,
            Parts = [new OutgoingPart { Kind = OutgoingPartKinds.Text, Text = "ok" }],
        }));
        check("manager: handler 注入", adapter.OnMessage is not null);

        await manager.StartAsync("wechat");
        await manager.StartAsync("wechat");
        check("manager: 单实例守卫（重复 Start 幂等）", adapter.StartCount == 1, $"starts={adapter.StartCount}");
        var status = manager.GetAllStatus();
        check("manager: 状态快照", status.TryGetValue("wechat", out var adapterStatus)
            && adapterStatus.Phase == ChannelPhases.Running);

        var handlerResult = adapter.OnMessage is null
            ? null
            : await adapter.OnMessage(new IncomingMessage
            {
                Channel = "wechat", SenderId = "u1", ChatId = "u1", Text = "hi",
                At = DateTimeOffset.FromUnixTimeMilliseconds(1787889600000),
            }, CancellationToken.None);
        check("manager: dispatcher 回调可路由", handlerResult?.Parts[0].Text == "ok");

        await manager.StopAsync("wechat");
        check("manager: 停止", adapter.StopCount == 1, $"stops={adapter.StopCount}");
        await manager.StopAsync("wechat");
        check("manager: 重复 Stop 幂等", adapter.StopCount == 1);

        // P2-2②：启动中的适配器不能空操作——登记补停，启动完成后立即停
        var starting = new FakeAdapter(ChannelIds.Feishu);
        manager.Register(starting);
        var startEntered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var startGate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        starting.StartImpl = () => { startEntered.TrySetResult(); return startGate.Task; };
        var startTask = manager.StartAsync(ChannelIds.Feishu);
        await startEntered.Task;
        var stopTask = manager.StopAsync(ChannelIds.Feishu);
        check("manager: StopAsync 对启动中适配器登记补停（不空操作）",
            manager.IsRunning(ChannelIds.Feishu) && starting.StopCount == 0);
        startGate.TrySetResult();
        await startTask;
        await stopTask;
        check("manager: 启动完成后补停 + IsRunning=false",
            starting.StopCount == 1 && !manager.IsRunning(ChannelIds.Feishu), $"stops={starting.StopCount}");
    }

    // ── 4. ServerEventWriter ─────────────────────────────────────────────────

    private static async Task CheckServerEventWriterAsync(CheckFn check)
    {
        var dir = NewTempDir("events");
        try
        {
            var eventStore = new EventStore(Path.Combine(dir, "events.db"));
            var writer = new ServerEventWriter(eventStore);
            var incoming = new IncomingMessage
            {
                Channel = ChannelIds.WeChat,
                SenderId = "u1",
                ChatId = "u1",
                MessageId = "m1",
                SenderName = "小昔",
                Text = "你好",
                At = DateTimeOffset.FromUnixTimeMilliseconds(1787889600000),
            };
            var sessionId = ChannelSessionId.MakeSessionId("wechat", "u1");

            var userWrite = await writer.WriteChannelUserMessageAsync(sessionId, incoming);
            check("writer: user 事件写入 + 派生 id",
                userWrite.IsWritten && userWrite.Event!.EventId == ChannelSessionId.MakeChannelUserEventId(incoming),
                userWrite.Event?.EventId ?? "null");
            check("writer: deviceId/lamport/seq 起点",
                userWrite.Event is { DeviceId: ServerEventWriter.ServerDeviceId, Lamport: 1, Seq: 1 });
            var payload = userWrite.Event!.Payload;
            check("writer: user presentation.channelSource",
                payload.GetProperty("role").GetString() == "user"
                && payload.GetProperty("turnId").GetString() == ChannelSessionId.MakeChannelTurnId(incoming, "user")
                && payload.GetProperty("presentation").GetProperty("patchRevision").GetInt32() == 1
                && payload.GetProperty("presentation").GetProperty("patch").GetProperty("content").GetString() == "你好"
                && payload.GetProperty("presentation").GetProperty("patch").GetProperty("channelSource")
                    .GetProperty("channel").GetString() == "wechat"
                && payload.GetProperty("presentation").GetProperty("patch").GetProperty("channelSource")
                    .GetProperty("senderName").GetString() == "小昔",
                payload.GetRawText());

            var duplicate = await writer.WriteChannelUserMessageAsync(sessionId, incoming);
            check("writer: 幂等（重复 eventId → Duplicate）", duplicate.IsDuplicate);

            var anchorEventId = userWrite.Event.EventId;
            var reply = new GeneratedReply(
                "回复", anchorEventId,
                ChannelSessionId.MakeAssistantEventId(sessionId, anchorEventId),
                ChannelSessionId.MakeChannelTurnId(incoming, "user"));
            var assistantWrite = await writer.WriteChannelAssistantMessageAsync(
                sessionId, reply.EventId, reply.TurnId, reply.Text);
            check("writer: assistant 事件（presentation content）",
                assistantWrite.IsWritten && assistantWrite.Event is { Lamport: 2, Seq: 2 }
                && assistantWrite.Event.Payload.GetProperty("presentation").GetProperty("patch")
                    .GetProperty("content").GetString() == "回复",
                assistantWrite.Event?.Payload.GetRawText() ?? "null");

            var proactive = await writer.WriteProactiveMessageAsync(sessionId, "intent-1", "主动");
            check("writer: proactive 事件 id 派生",
                proactive.IsWritten
                && proactive.Event!.EventId == ChannelSessionId.MakeProactiveEventId(sessionId, "intent-1")
                && !proactive.Event.Payload.TryGetProperty("turnId", out _));

            // 并发写：SemaphoreSlim 串行化「水位读取 + 预检 + 写入」——lamport/seq 必须无重复
            var tasks = Enumerable.Range(0, 20).Select(index => writer.WriteChannelUserMessageAsync(
                sessionId, new IncomingMessage
                {
                    Channel = ChannelIds.WeChat, SenderId = "u1", ChatId = "u1",
                    MessageId = $"c{index}", Text = $"t{index}",
                    At = DateTimeOffset.FromUnixTimeMilliseconds(1787889600000),
                })).ToArray();
            var results = await Task.WhenAll(tasks);
            var lamports = results.Select(result => result.Event!.Lamport).OrderBy(value => value).ToArray();
            check("writer: 并发 lamport 原子分配（4..23 无重复）",
                results.All(result => result.IsWritten)
                && lamports.SequenceEqual(Enumerable.Range(4, 20).Select(value => (long)value)),
                string.Join(",", lamports));
        }
        finally
        {
            CleanupTempDir(dir);
        }
    }

    // ── 5. ChannelDispatcher 端到端 ──────────────────────────────────────────

    private static async Task CheckDispatcherAsync(CheckFn check)
    {
        var dir = NewTempDir("dispatcher");
        try
        {
            var eventStore = new EventStore(Path.Combine(dir, "events.db"));
            var writer = new ServerEventWriter(eventStore);
            var store = new ChannelStore(Path.Combine(dir, "channels.db"));
            var manager = new ChannelManager(NullLogger<ChannelManager>.Instance);
            var adapter = new FakeAdapter(ChannelIds.WeChat);
            manager.Register(adapter);
            var delivery = new ChannelDeliveryService(
                manager, NullLogger<ChannelDeliveryService>.Instance, TimeSpan.Zero);
            var engine = new FakeDialogEngine();
            var dispatcher = new ChannelDispatcher(
                store, writer, engine, delivery, NullLogger<ChannelDispatcher>.Instance);

            var incoming = new IncomingMessage
            {
                Channel = ChannelIds.WeChat, SenderId = "u1", ChatId = "u1", MessageId = "m1",
                SenderName = "小昔", Text = "你好",
                At = DateTimeOffset.FromUnixTimeMilliseconds(1787889600000),
            };
            var outgoing = await dispatcher.HandleIncomingAsync(incoming);
            check("dispatcher: 端到端投递（文本回复）",
                outgoing is not null && adapter.SendCount == 1 && outgoing.TargetId == "u1"
                && outgoing.Parts[0].Kind == OutgoingPartKinds.Text && outgoing.Parts[0].Text == "回复"
                && outgoing.ReplyContext?.MessageId == "m1",
                JsonSerializer.Serialize(outgoing, ChannelJson.Options));
            var events = (await eventStore.FetchAsync(0, 10, null)).Events;
            check("dispatcher: 事件流 user+assistant（含 channelSource）",
                events.Count == 2
                && events[0].EventId == ChannelSessionId.MakeChannelUserEventId(incoming)
                && events[1].Payload.GetProperty("role").GetString() == "assistant",
                string.Join(",", events.Select(item => item.EventId)));
            var receipts = await store.ListReceiptsAsync("wechat");
            check("dispatcher: delivered 回执",
                receipts.Count == 1 && receipts[0].Status == ChannelStore.StatusDelivered,
                JsonSerializer.Serialize(receipts));

            var duplicateOut = await dispatcher.HandleIncomingAsync(incoming);
            check("dispatcher: seen 去重（不重复生成/投递）",
                duplicateOut is null && adapter.SendCount == 1 && engine.Calls == 1);

            adapter.SendImpl = _ => ChannelSendResult.Failure("E_SEND_TEST");
            var failedIncoming = new IncomingMessage
            {
                Channel = ChannelIds.WeChat, SenderId = "u1", ChatId = "u1", MessageId = "m2",
                Text = "再试", At = DateTimeOffset.FromUnixTimeMilliseconds(1787889600001),
            };
            var failedOut = await dispatcher.HandleIncomingAsync(failedIncoming);
            var failedReceipts = await store.ListReceiptsAsync("wechat");
            check("dispatcher: 投递失败重试 + failed 回执",
                failedOut is null && adapter.SendCount == 3
                && failedReceipts.Any(item => item.Status == ChannelStore.StatusFailed && item.ErrorCode == "E_SEND_TEST"),
                JsonSerializer.Serialize(failedReceipts));

            // 归属门闩（阶段 4 接入点）：deny → 不写事件、不投递
            var gateStore = new ChannelStore(Path.Combine(dir, "gate.db"));
            var gateDispatcher = new ChannelDispatcher(
                gateStore, writer, new FakeDialogEngine(), delivery,
                NullLogger<ChannelDispatcher>.Instance, new DenyGate());
            var deniedOut = await gateDispatcher.HandleIncomingAsync(new IncomingMessage
            {
                Channel = ChannelIds.WeChat, SenderId = "u9", ChatId = "u9", MessageId = "gate-1",
                Text = "被门闩拦下", At = DateTimeOffset.FromUnixTimeMilliseconds(1787889600002),
            });
            check("dispatcher: 归属门闩 deny 不处理",
                deniedOut is null && (await gateStore.ListReceiptsAsync("wechat")).Count == 0);
        }
        finally
        {
            CleanupTempDir(dir);
        }
    }

    // ── 6. ChannelDeliveryService 重试 ───────────────────────────────────────

    private static async Task CheckDeliveryRetryAsync(CheckFn check)
    {
        var manager = new ChannelManager(NullLogger<ChannelManager>.Instance);
        var adapter = new FakeAdapter(ChannelIds.WeChat);
        manager.Register(adapter);
        var delivery = new ChannelDeliveryService(
            manager, NullLogger<ChannelDeliveryService>.Instance, TimeSpan.Zero);
        var message = new OutgoingMessage
        {
            Channel = ChannelIds.WeChat, TargetId = "u1",
            Parts = [new OutgoingPart { Kind = OutgoingPartKinds.Text, Text = "hi" }],
        };

        var attempts = 0;
        adapter.SendImpl = _ => ++attempts == 1 ? ChannelSendResult.Failure("flaky") : ChannelSendResult.Success;
        var retried = await delivery.SendAsync(message);
        check("delivery: 失败重试 1 次成功", retried.Ok && attempts == 2, $"attempts={attempts}");

        attempts = 0;
        adapter.SendImpl = _ =>
        {
            attempts++;
            return ChannelSendResult.Failure("E_SEND_TEST");
        };
        var failed = await delivery.SendAsync(message);
        check("delivery: 两次失败返回 failed（不无限重发）",
            !failed.Ok && failed.Error == "E_SEND_TEST" && attempts == 2, $"attempts={attempts}");

        var missing = await delivery.SendAsync(new OutgoingMessage
        {
            Channel = ChannelIds.Feishu, TargetId = "oc_1",
            Parts = [new OutgoingPart { Kind = OutgoingPartKinds.Text, Text = "hi" }],
        });
        check("delivery: adapter_not_found", !missing.Ok && missing.Error == "adapter_not_found");
    }

    // ── 7. ChannelOwnershipService 状态机（§5.1/§5.2/Q8）──────────────────────

    private static async Task<int> RunOwnershipAsync()
    {
        var failures = 0;
        void Check(string name, bool ok, string detail = "")
        {
            CheckCount++;
            if (ok)
            {
                Console.WriteLine($"[PASS] {name}");
            }
            else
            {
                failures++;
                Console.WriteLine($"[FAIL] {name} — {detail}");
            }
        }

        await CheckOwnershipStateMachineAsync(Check);
        await CheckOwnershipExpiryAsync(Check);
        await CheckOwnershipHandoffAsync(Check);
        await CheckOwnershipRestartAsync(Check);
        await CheckOwnershipHandoffSafetyAsync(Check);
        await CheckOwnershipStopSafetyAsync(Check);
        await CheckProactiveIdempotencyAsync(Check);

        Console.WriteLine(failures == 0
            ? "SELFTEST channel ownership: ALL PASS"
            : $"SELFTEST channel ownership: {failures} FAILURES");
        return failures;
    }

    private static async Task CheckOwnershipStateMachineAsync(CheckFn check)
    {
        var dir = NewTempDir("ownership-sm");
        try
        {
            var store = new ChannelStore(Path.Combine(dir, "channels.db"));
            var manager = new ChannelManager(NullLogger<ChannelManager>.Instance);
            var adapter = new FakeAdapter(ChannelIds.WeChat);
            manager.Register(adapter);
            var clock = new ManualTimeProvider();
            var ownership = new ChannelOwnershipService(
                store, manager, NullLogger<ChannelOwnershipService>.Instance,
                "test-server", TimeSpan.FromSeconds(180), TimeSpan.Zero, clock);

            var serverOwned = await ownership.InitializeAsync([ChannelIds.WeChat]);
            check("ownership: 初始化服务端默认持有",
                serverOwned.SequenceEqual([ChannelIds.WeChat])
                && await ownership.CanProcessAsync(ChannelIds.WeChat),
                string.Join(",", serverOwned));
            await manager.StartAsync(ChannelIds.WeChat);
            check("ownership: 服务端持有渠道启动适配器", adapter.StartCount == 1);

            var claim = await ownership.ClaimAsync([ChannelIds.WeChat], "device-a", null);
            check("ownership: claim 授予 + 先停服务端适配器（R2）",
                claim.Granted.SequenceEqual([ChannelIds.WeChat]) && claim.Denied.Count == 0
                && claim.LeaseExpiresAt is not null && adapter.StopCount == 1
                && !await ownership.CanProcessAsync(ChannelIds.WeChat),
                JsonSerializer.Serialize(claim));
            var snapshot = ownership.GetSnapshot();
            check("ownership: 快照 serverId/TTL/owner/holder/lease",
                snapshot.ServerId == "test-server" && snapshot.LeaseTtlSeconds == 180
                && snapshot.Channels[ChannelIds.WeChat] is { Owner: "desktop", Holder: "device-a" }
                && snapshot.Channels[ChannelIds.WeChat].LeaseExpiresAt is not null,
                JsonSerializer.Serialize(snapshot));

            var second = await ownership.ClaimAsync([ChannelIds.WeChat], "device-b", null);
            check("ownership: 多设备先到先得（Q8 第二台 denied，不打扰持有者）",
                second.Granted.Count == 0 && second.Denied.SequenceEqual([ChannelIds.WeChat])
                && adapter.StopCount == 1,
                JsonSerializer.Serialize(second));

            clock.Now += TimeSpan.FromSeconds(10);
            var renew = await ownership.ClaimAsync([ChannelIds.WeChat], "device-a", 300);
            check("ownership: 同 holder 重 claim = 续约（不重复停适配器）",
                renew.Granted.SequenceEqual([ChannelIds.WeChat]) && adapter.StopCount == 1,
                JsonSerializer.Serialize(renew));

            var foreignHeartbeat = await ownership.HeartbeatAsync([ChannelIds.WeChat], "device-b");
            check("ownership: 非 holder 心跳 lost",
                foreignHeartbeat.Lost.SequenceEqual([ChannelIds.WeChat]) && foreignHeartbeat.Renewed.Count == 0);
            clock.Now += TimeSpan.FromSeconds(10);
            var heartbeat = await ownership.HeartbeatAsync([ChannelIds.WeChat], "device-a");
            check("ownership: holder 心跳 renewed", heartbeat.Renewed.SequenceEqual([ChannelIds.WeChat]));

            var foreignRelease = await ownership.ReleaseAsync([ChannelIds.WeChat], "device-b");
            check("ownership: 非 holder release 无效", foreignRelease.Released.Count == 0);
            var release = await ownership.ReleaseAsync([ChannelIds.WeChat], "device-a");
            check("ownership: release 交回服务端（宽限 0 立即启动）",
                release.Released.SequenceEqual([ChannelIds.WeChat]) && adapter.StartCount == 2
                && await ownership.CanProcessAsync(ChannelIds.WeChat),
                $"starts={adapter.StartCount} released={JsonSerializer.Serialize(release)}");
        }
        finally
        {
            CleanupTempDir(dir);
        }
    }

    // ── 8. 租约过期收回（R3/§5.7）───────────────────────────────────────────

    private static async Task CheckOwnershipExpiryAsync(CheckFn check)
    {
        var dir = NewTempDir("ownership-expire");
        try
        {
            var store = new ChannelStore(Path.Combine(dir, "channels.db"));
            var manager = new ChannelManager(NullLogger<ChannelManager>.Instance);
            var adapter = new FakeAdapter(ChannelIds.WeChat);
            manager.Register(adapter);
            var clock = new ManualTimeProvider();
            var ownership = new ChannelOwnershipService(
                store, manager, NullLogger<ChannelOwnershipService>.Instance,
                "test-server", TimeSpan.FromSeconds(60), TimeSpan.Zero, clock);
            await ownership.InitializeAsync([ChannelIds.WeChat]);
            await manager.StartAsync(ChannelIds.WeChat);
            await ownership.ClaimAsync([ChannelIds.WeChat], "device-a", null);
            check("ownership: 租约有效期内门闩关闭", !await ownership.CanProcessAsync(ChannelIds.WeChat));

            clock.Now += TimeSpan.FromSeconds(61);
            check("ownership: 过期后门闩语义放行（sweep 前）",
                await ownership.CanProcessAsync(ChannelIds.WeChat));
            var reclaimed = await ownership.SweepExpiredAsync();
            check("ownership: sweep 收回 + 启动适配器 + owner=server",
                reclaimed.SequenceEqual([ChannelIds.WeChat]) && adapter.StartCount == 2
                && ownership.GetState(ChannelIds.WeChat).Owner == "server",
                $"starts={adapter.StartCount}");

            var claimAgain = await ownership.ClaimAsync([ChannelIds.WeChat], "device-a", null);
            clock.Now += TimeSpan.FromSeconds(61);
            var late = await ownership.HeartbeatAsync([ChannelIds.WeChat], "device-a");
            check("ownership: 心跳迟到于租约 → lost + 立即收回",
                claimAgain.Granted.Count == 1 && late.Lost.SequenceEqual([ChannelIds.WeChat])
                && ownership.GetState(ChannelIds.WeChat).Owner == "server" && adapter.StartCount == 3,
                $"starts={adapter.StartCount}");
        }
        finally
        {
            CleanupTempDir(dir);
        }
    }

    // ── 9. 交拍时序 + dispatcher 门闩（§5.3/§5.6）────────────────────────────

    private static async Task CheckOwnershipHandoffAsync(CheckFn check)
    {
        var dir = NewTempDir("ownership-handoff");
        try
        {
            var eventStore = new EventStore(Path.Combine(dir, "events.db"));
            var writer = new ServerEventWriter(eventStore);
            var store = new ChannelStore(Path.Combine(dir, "channels.db"));
            var manager = new ChannelManager(NullLogger<ChannelManager>.Instance);
            var adapter = new FakeAdapter(ChannelIds.WeChat);
            manager.Register(adapter);
            var clock = new ManualTimeProvider();
            var ownership = new ChannelOwnershipService(
                store, manager, NullLogger<ChannelOwnershipService>.Instance,
                "test-server", TimeSpan.FromSeconds(180), TimeSpan.Zero, clock);
            await ownership.InitializeAsync([ChannelIds.WeChat]);
            await manager.StartAsync(ChannelIds.WeChat);
            var delivery = new ChannelDeliveryService(
                manager, NullLogger<ChannelDeliveryService>.Instance, TimeSpan.Zero);
            var dispatcher = new ChannelDispatcher(
                store, writer, new FakeDialogEngine(), delivery,
                NullLogger<ChannelDispatcher>.Instance, ownership);

            var first = await dispatcher.HandleIncomingAsync(NewIncoming("m1", "云端"));
            check("ownership: 服务端持有时入站正常处理",
                first is not null && adapter.SendCount == 1, first?.Parts[0].Text ?? "null");

            await ownership.ClaimAsync([ChannelIds.WeChat], "device-a", null);
            var denied = await dispatcher.HandleIncomingAsync(NewIncoming("m2", "桌面接管窗口"));
            var eventsAfterDeny = (await eventStore.FetchAsync(0, 10, null)).Events;
            check("ownership: owner=desktop 门闩拒绝入站（不生成/不投递）",
                denied is null && adapter.SendCount == 1 && eventsAfterDeny.Count == 2
                && await ownership.CanProcessAsync(ChannelIds.WeChat) == false,
                $"events={eventsAfterDeny.Count} sends={adapter.SendCount}");

            clock.Now += TimeSpan.FromSeconds(181);
            await ownership.SweepExpiredAsync();
            var third = await dispatcher.HandleIncomingAsync(NewIncoming("m3", "收回后"));
            check("ownership: 租约过期收回后恢复入站处理",
                third is not null && adapter.SendCount == 2,
                $"sends={adapter.SendCount}");
        }
        finally
        {
            CleanupTempDir(dir);
        }
    }

    // ── 10. 服务端进程重启接管（§5.5）────────────────────────────────────────

    private static async Task CheckOwnershipRestartAsync(CheckFn check)
    {
        var dir = NewTempDir("ownership-restart");
        try
        {
            var dbPath = Path.Combine(dir, "channels.db");
            var store = new ChannelStore(dbPath);
            var clock = new ManualTimeProvider();
            var manager1 = new ChannelManager(NullLogger<ChannelManager>.Instance);
            manager1.Register(new FakeAdapter(ChannelIds.WeChat));
            var ownership1 = new ChannelOwnershipService(
                store, manager1, NullLogger<ChannelOwnershipService>.Instance,
                "test-server", TimeSpan.FromSeconds(180), TimeSpan.Zero, clock);
            await ownership1.InitializeAsync([ChannelIds.WeChat]);
            await manager1.StartAsync(ChannelIds.WeChat);
            await ownership1.ClaimAsync([ChannelIds.WeChat], "device-a", null);

            // 模拟服务端进程重启：新 manager/服务实例读同一 channels.db
            var manager2 = new ChannelManager(NullLogger<ChannelManager>.Instance);
            var adapter2 = new FakeAdapter(ChannelIds.WeChat);
            manager2.Register(adapter2);
            var ownership2 = new ChannelOwnershipService(
                store, manager2, NullLogger<ChannelOwnershipService>.Instance,
                "test-server", TimeSpan.FromSeconds(180), TimeSpan.Zero, clock);
            var serverOwned = await ownership2.InitializeAsync([ChannelIds.WeChat]);
            check("ownership: 重启后桌面租约未过期保持 paused（等心跳）",
                serverOwned.Count == 0 && adapter2.StartCount == 0
                && !await ownership2.CanProcessAsync(ChannelIds.WeChat),
                $"starts={adapter2.StartCount}");

            var renewed = await ownership2.HeartbeatAsync([ChannelIds.WeChat], "device-a");
            check("ownership: 重启后桌面心跳续约（同一 deviceId）",
                renewed.Renewed.SequenceEqual([ChannelIds.WeChat]));

            clock.Now += TimeSpan.FromSeconds(181);
            var reclaimed = await ownership2.SweepExpiredAsync();
            check("ownership: 重启后租约过期收回并启动",
                reclaimed.SequenceEqual([ChannelIds.WeChat]) && adapter2.StartCount == 1
                && await ownership2.CanProcessAsync(ChannelIds.WeChat),
                $"starts={adapter2.StartCount}");
        }
        finally
        {
            CleanupTempDir(dir);
        }
    }

    // ── 11. 交接失败补偿与 sweep 自愈（P1-3）────────────────────────────────

    private static async Task CheckOwnershipHandoffSafetyAsync(CheckFn check)
    {
        // P1-3①：停适配器后请求中止 → 补偿重启，不留「owner=server 但适配器已停」悬挂
        var dir = NewTempDir("ownership-cancel");
        try
        {
            var store = new ChannelStore(Path.Combine(dir, "channels.db"));
            var manager = new ChannelManager(NullLogger<ChannelManager>.Instance);
            var adapter = new FakeAdapter(ChannelIds.WeChat);
            manager.Register(adapter);
            var ownership = new ChannelOwnershipService(
                store, manager, NullLogger<ChannelOwnershipService>.Instance,
                "test-server", TimeSpan.FromSeconds(180), TimeSpan.Zero);
            await ownership.InitializeAsync([ChannelIds.WeChat]);
            await manager.StartAsync(ChannelIds.WeChat);
            using var cts = new CancellationTokenSource();
            adapter.StopImpl = _ => { cts.Cancel(); return Task.CompletedTask; };
            var cancelled = false;
            try
            {
                await ownership.ClaimAsync([ChannelIds.WeChat], "device-a", null, cts.Token);
            }
            catch (OperationCanceledException)
            {
                cancelled = true;
            }
            var persisted = (await store.ListOwnershipAsync()).Single();
            check("ownership: claim 中止 → 补偿重启（DB/内存均保持 owner=server）",
                cancelled && adapter.StopCount == 1 && adapter.StartCount == 2
                && persisted.Owner == "server" && manager.IsRunning(ChannelIds.WeChat)
                && await ownership.CanProcessAsync(ChannelIds.WeChat),
                $"cancelled={cancelled} starts={adapter.StartCount} stops={adapter.StopCount} owner={persisted.Owner}");
        }
        finally
        {
            CleanupTempDir(dir);
        }

        // P1-3②：持久化失败（SQLite 打开失败）→ 补偿重启
        dir = NewTempDir("ownership-persist-fail");
        try
        {
            var dbPath = Path.Combine(dir, "channels.db");
            var store = new ChannelStore(dbPath);
            var manager = new ChannelManager(NullLogger<ChannelManager>.Instance);
            var adapter = new FakeAdapter(ChannelIds.WeChat);
            manager.Register(adapter);
            var ownership = new ChannelOwnershipService(
                store, manager, NullLogger<ChannelOwnershipService>.Instance,
                "test-server", TimeSpan.FromSeconds(180), TimeSpan.Zero);
            await ownership.InitializeAsync([ChannelIds.WeChat]);
            await manager.StartAsync(ChannelIds.WeChat);
            // 模拟持久化失败：清连接池后把 DB 文件替换为同名目录（Open 必然失败）
            SqliteConnection.ClearAllPools();
            File.Delete(dbPath);
            Directory.CreateDirectory(dbPath);
            var failed = false;
            try
            {
                await ownership.ClaimAsync([ChannelIds.WeChat], "device-a", null);
            }
            catch (SqliteException)
            {
                failed = true;
            }
            check("ownership: claim 持久化失败 → 补偿重启（不留悬挂）",
                failed && adapter.StopCount == 1 && adapter.StartCount == 2
                && ownership.GetState(ChannelIds.WeChat).Owner == "server"
                && manager.IsRunning(ChannelIds.WeChat),
                $"failed={failed} starts={adapter.StartCount} stops={adapter.StopCount}");
        }
        finally
        {
            CleanupTempDir(dir);
        }

        // P1-3③：sweep 自愈 owner=server 但适配器未运行
        dir = NewTempDir("ownership-heal");
        try
        {
            var store = new ChannelStore(Path.Combine(dir, "channels.db"));
            var manager = new ChannelManager(NullLogger<ChannelManager>.Instance);
            var adapter = new FakeAdapter(ChannelIds.WeChat);
            manager.Register(adapter);
            var ownership = new ChannelOwnershipService(
                store, manager, NullLogger<ChannelOwnershipService>.Instance,
                "test-server", TimeSpan.FromSeconds(180), TimeSpan.Zero);
            await ownership.InitializeAsync([ChannelIds.WeChat]);
            // 故意不启动适配器：模拟启动失败/补偿未覆盖的悬挂
            var reclaimed = await ownership.SweepExpiredAsync();
            check("ownership: sweep 自愈 owner=server 未运行 → 补启动",
                reclaimed.Count == 0 && adapter.StartCount == 1 && manager.IsRunning(ChannelIds.WeChat),
                $"reclaimed={reclaimed.Count} starts={adapter.StartCount}");
        }
        finally
        {
            CleanupTempDir(dir);
        }
    }

    // ── 12. 交棒边界：门闩复查 / drain 超时 / 宽限随停机取消（P2-2）──────────

    private static async Task CheckOwnershipStopSafetyAsync(CheckFn check)
    {
        // P2-2①：桌面持有后按归属启动必须跳过（并发 claim 复查门闩）
        var dir = NewTempDir("ownership-start-latch");
        try
        {
            var store = new ChannelStore(Path.Combine(dir, "channels.db"));
            var manager = new ChannelManager(NullLogger<ChannelManager>.Instance);
            var adapter = new FakeAdapter(ChannelIds.WeChat);
            manager.Register(adapter);
            var ownership = new ChannelOwnershipService(
                store, manager, NullLogger<ChannelOwnershipService>.Instance,
                "test-server", TimeSpan.FromSeconds(180), TimeSpan.Zero);
            await ownership.InitializeAsync([ChannelIds.WeChat]);
            await manager.StartAsync(ChannelIds.WeChat);
            await ownership.ClaimAsync([ChannelIds.WeChat], "device-a", null);
            await ownership.StartServerOwnedAsync(ChannelIds.WeChat);
            check("ownership: 桌面持有后 StartServerOwnedAsync 跳过（R2 复查）",
                adapter.StartCount == 1 && !manager.IsRunning(ChannelIds.WeChat),
                $"starts={adapter.StartCount}");
        }
        finally
        {
            CleanupTempDir(dir);
        }

        // P2-2③：适配器不响应 drain 取消时 claim 不无限等待（超时继续授予）
        dir = NewTempDir("ownership-drain");
        try
        {
            var store = new ChannelStore(Path.Combine(dir, "channels.db"));
            var manager = new ChannelManager(NullLogger<ChannelManager>.Instance);
            var adapter = new FakeAdapter(ChannelIds.WeChat);
            manager.Register(adapter);
            var ownership = new ChannelOwnershipService(
                store, manager, NullLogger<ChannelOwnershipService>.Instance,
                "test-server", TimeSpan.FromSeconds(180), TimeSpan.Zero,
                handoffDrainTimeout: TimeSpan.FromMilliseconds(50));
            await ownership.InitializeAsync([ChannelIds.WeChat]);
            await manager.StartAsync(ChannelIds.WeChat);
            adapter.StopImpl = _ => new TaskCompletionSource().Task; // 永不完成且无视取消
            var claim = await ownership.ClaimAsync([ChannelIds.WeChat], "device-a", null);
            check("ownership: drain 超时后继续授予（不无限持有 mutex）",
                claim.Granted.SequenceEqual([ChannelIds.WeChat])
                && ownership.GetState(ChannelIds.WeChat).Owner == "desktop"
                && ownership.GetState(ChannelIds.WeChat).Holder == "device-a",
                JsonSerializer.Serialize(claim));
        }
        finally
        {
            CleanupTempDir(dir);
        }

        // P2-2④：停机取消 release 宽限启动
        dir = NewTempDir("ownership-release-grace");
        try
        {
            var store = new ChannelStore(Path.Combine(dir, "channels.db"));
            var manager = new ChannelManager(NullLogger<ChannelManager>.Instance);
            var adapter = new FakeAdapter(ChannelIds.WeChat);
            manager.Register(adapter);
            var ownership = new ChannelOwnershipService(
                store, manager, NullLogger<ChannelOwnershipService>.Instance,
                "test-server", TimeSpan.FromSeconds(180), TimeSpan.FromSeconds(5));
            await ownership.InitializeAsync([ChannelIds.WeChat]);
            await manager.StartAsync(ChannelIds.WeChat);
            await ownership.ClaimAsync([ChannelIds.WeChat], "device-a", null);
            await ownership.ReleaseAsync([ChannelIds.WeChat], "device-a");
            await ownership.CancelPendingStartsAsync();
            await Task.Delay(100);
            check("ownership: 停机取消 release 宽限启动（适配器不被拉起）",
                adapter.StartCount == 1 && !manager.IsRunning(ChannelIds.WeChat)
                && ownership.GetState(ChannelIds.WeChat).Owner == "server",
                $"starts={adapter.StartCount}");
        }
        finally
        {
            CleanupTempDir(dir);
        }
    }

    // ── 13. 主动消息 intentId 幂等与失败回执（§5.4）─────────────────────────

    private static async Task CheckProactiveIdempotencyAsync(CheckFn check)
    {
        var dir = NewTempDir("ownership-proactive");
        try
        {
            var eventStore = new EventStore(Path.Combine(dir, "events.db"));
            var writer = new ServerEventWriter(eventStore);
            var store = new ChannelStore(Path.Combine(dir, "channels.db"));
            var manager = new ChannelManager(NullLogger<ChannelManager>.Instance);
            var wechat = new FakeAdapter(ChannelIds.WeChat);
            var feishu = new FakeAdapter(ChannelIds.Feishu);
            var qqbot = new FakeAdapter(ChannelIds.QqBot);
            manager.Register(wechat);
            manager.Register(feishu);
            manager.Register(qqbot);
            var clock = new ManualTimeProvider();
            var ownership = new ChannelOwnershipService(
                store, manager, NullLogger<ChannelOwnershipService>.Instance,
                "test-server", TimeSpan.FromSeconds(180), TimeSpan.Zero, clock);
            await ownership.InitializeAsync([ChannelIds.WeChat, ChannelIds.Feishu, ChannelIds.QqBot]);
            await manager.StartAsync(ChannelIds.WeChat);
            await manager.StartAsync(ChannelIds.Feishu);
            var delivery = new ChannelDeliveryService(
                manager, NullLogger<ChannelDeliveryService>.Instance, TimeSpan.Zero);
            var proactive = new ChannelProactiveService(
                store, writer, delivery, ownership, NullLogger<ChannelProactiveService>.Instance);

            await store.RememberRecipientAsync(ChannelIds.WeChat, "u1", null);
            var first = await proactive.DeliverAsync(ChannelIds.WeChat, null, "intent-1", "主动一");
            var expectedEventId = ChannelSessionId.MakeProactiveEventId(
                ChannelSessionId.MakeSessionId(ChannelIds.WeChat, "u1"), "intent-1");
            check("proactive: 投递写事件 + 派生事件 id + delivered 回执",
                first.Status == ProactiveDeliveryStatus.Delivered && first.EventId == expectedEventId
                && first.Delivered && wechat.SendCount == 1
                && (await store.ListReceiptsAsync(ChannelIds.WeChat))[0].Status == ChannelStore.StatusDelivered,
                JsonSerializer.Serialize(first));

            var duplicate = await proactive.DeliverAsync(ChannelIds.WeChat, null, "intent-1", "主动一");
            check("proactive: intentId 幂等 duplicate 不重发",
                duplicate.Status == ProactiveDeliveryStatus.Duplicate && duplicate.Duplicate
                && wechat.SendCount == 1 && (await eventStore.FetchAsync(0, 10, null)).Events.Count == 1,
                JsonSerializer.Serialize(duplicate));

            var missing = await proactive.DeliverAsync(ChannelIds.Feishu, null, "intent-2", "主动二");
            check("proactive: 无收件人 E_CHANNEL_RECIPIENT_MISSING",
                missing.Status == ProactiveDeliveryStatus.RecipientMissing && feishu.SendCount == 0);

            wechat.SendImpl = _ => ChannelSendResult.Failure("E_SEND_TEST");
            var failed = await proactive.DeliverAsync(ChannelIds.WeChat, null, "intent-3", "主动三");
            var receipts = await store.ListReceiptsAsync(ChannelIds.WeChat);
            check("proactive: 投递失败 delivered=false + failed 回执",
                failed.Status == ProactiveDeliveryStatus.FailedDelivery && !failed.Delivered
                && failed.Error == "E_SEND_TEST"
                && receipts.Any(item => item.Status == ChannelStore.StatusFailed && item.ErrorCode == "E_SEND_TEST"),
                JsonSerializer.Serialize(failed));

            await ownership.ClaimAsync([ChannelIds.WeChat], "device-a", null);
            var owned = await proactive.DeliverAsync(ChannelIds.WeChat, null, "intent-4", "主动四");
            check("proactive: owner=desktop 时服务端拒发 E_CHANNEL_OWNED_BY_OTHER",
                owned.Status == ProactiveDeliveryStatus.OwnedByOther && owned.Error == "E_CHANNEL_OWNED_BY_OTHER");

            await store.RememberRecipientAsync(ChannelIds.QqBot, "u9", null);
            var unsupported = await proactive.DeliverAsync(ChannelIds.QqBot, null, "intent-5", "主动五");
            var eventsAfterUnsupported = (await eventStore.FetchAsync(0, 20, null)).Events;
            check("proactive: proactive:false 渠道前置拒绝（不写事件/不投递）",
                unsupported.Status == ProactiveDeliveryStatus.Unsupported
                && unsupported.Error == ChannelErrorCodes.Unsupported
                && qqbot.SendCount == 0 && eventsAfterUnsupported.Count == 2,
                JsonSerializer.Serialize(unsupported));
        }
        finally
        {
            CleanupTempDir(dir);
        }
    }

    private static IncomingMessage NewIncoming(string messageId, string text) => new()
    {
        Channel = ChannelIds.WeChat,
        SenderId = "u1",
        ChatId = "u1",
        MessageId = messageId,
        SenderName = "小昔",
        Text = text,
        At = DateTimeOffset.FromUnixTimeMilliseconds(1787889600000),
    };

    // ── 测试替身与临时目录 ───────────────────────────────────────────────────

    private sealed class FakeAdapter : IChannelAdapter
    {
        public FakeAdapter(string id)
        {
            Id = id;
        }

        public string Id { get; }
        public string DisplayName => $"fake-{Id}";
        public ChannelCapability Capability => ChannelCapabilities.For(Id);
        public Func<IncomingMessage, CancellationToken, Task<OutgoingMessage?>>? OnMessage { get; set; }
        public int StartCount { get; private set; }
        public int StopCount { get; private set; }
        public int SendCount { get; private set; }
        public Func<OutgoingMessage, ChannelSendResult> SendImpl { get; set; } = _ => ChannelSendResult.Success;
        public Func<Task>? StartImpl { get; set; }
        public Func<CancellationToken, Task>? StopImpl { get; set; }

        public Task StartAsync(CancellationToken cancellationToken = default)
        {
            StartCount++;
            return StartImpl?.Invoke() ?? Task.CompletedTask;
        }

        public Task StopAsync(CancellationToken cancellationToken = default)
        {
            StopCount++;
            return StopImpl?.Invoke(cancellationToken) ?? Task.CompletedTask;
        }

        public Task<ChannelSendResult> SendAsync(OutgoingMessage message, CancellationToken cancellationToken = default)
        {
            SendCount++;
            return Task.FromResult(SendImpl(message));
        }

        public ChannelStatus GetStatus() => new() { Enabled = true, Phase = ChannelPhases.Running };
    }

    private sealed class FakeDialogEngine : IDialogEngine
    {
        public int Calls { get; private set; }

        public Task<GeneratedReply?> GenerateAsync(string sessionId, CancellationToken cancellationToken = default)
        {
            Calls++;
            var anchorEventId = $"anchor-{Calls}";
            return Task.FromResult<GeneratedReply?>(new GeneratedReply(
                "回复", anchorEventId,
                ChannelSessionId.MakeAssistantEventId(sessionId, anchorEventId),
                $"turn-{Calls}"));
        }
    }

    private sealed class DenyGate : IChannelOwnershipGate
    {
        public ValueTask<bool> CanProcessAsync(string channel, CancellationToken cancellationToken = default) =>
            ValueTask.FromResult(false);
    }

    /// <summary>可手动推进的时钟（租约过期/心跳测试确定性）。</summary>
    private sealed class ManualTimeProvider : TimeProvider
    {
        public DateTimeOffset Now { get; set; } = DateTimeOffset.FromUnixTimeMilliseconds(1787889600000);

        public override DateTimeOffset GetUtcNow() => Now;
    }

    private static string NewTempDir(string label) =>
        Directory.CreateDirectory(Path.Combine(Path.GetTempPath(), $"cyrene-channel-selftest-{label}-{Guid.NewGuid():N}")).FullName;

    private static void CleanupTempDir(string dir)
    {
        try
        {
            SqliteConnection.ClearAllPools();
            Directory.Delete(dir, recursive: true);
        }
        catch
        {
            // Windows 下连接池可能短暂持有文件；临时目录残留不影响结果
        }
    }

    // ── 7. QQ 官方 bot（阶段 6，设计 §7 / §8.3）────────────────────────────────

    private static async Task<int> RunQqBotAsync()
    {
        var failures = 0;
        void Check(string name, bool ok, string detail = "")
        {
            CheckCount++;
            if (ok)
            {
                Console.WriteLine($"[PASS] {name}");
            }
            else
            {
                failures++;
                Console.WriteLine($"[FAIL] {name} — {detail}");
            }
        }

        CheckQqBotRegistration(Check);
        await CheckQqBotApiClientAsync(Check);
        await CheckQqBotWsProtocolAsync(Check);
        await CheckQqBotAdapterAsync(Check);

        Console.WriteLine(failures == 0
            ? "SELFTEST channel qqbot: ALL PASS"
            : $"SELFTEST channel qqbot: {failures} FAILURES");
        return failures;
    }

    private static void CheckQqBotRegistration(CheckFn check)
    {
        var registration = new QqBotAdapterRegistration();
        check("qqbot: 注册项（ChannelId + 仅被动回复 proactive:false）",
            registration.ChannelId == "qqbot" && !registration.SupportsProactive);
        check("qqbot: 凭据缺失 → 未配置", !registration.IsConfigured(new ChannelOptions()));
        check("qqbot: AppID/AppSecret 齐备 → 已配置",
            registration.IsConfigured(new ChannelOptions { QqBotAppId = "102", QqBotAppSecret = "s" }));

        var capability = ChannelCapabilities.For(ChannelIds.QqBot);
        check("qqbot: capability 冻结表（仅文本 / maxTextLength 0）",
            capability is
            {
                Text: true, Image: false, Audio: false, File: false, Video: false,
                Markdown: false, Card: false, Sticker: false, MaxTextLength: 0,
            });
        check("qqbot: §7.3 主动通知文案", QqBotAdapter.ProactiveNotice.Contains("主动通知"));
        check("qqbot: URL 策略（识别 + 占位替换）",
            QqBotUrlPolicy.ContainsUrl("看 https://a.example/x 哦")
            && !QqBotUrlPolicy.ContainsUrl("没有链接")
            && QqBotUrlPolicy.StripUrls("看 https://a.example/x 哦") == "看 [链接] 哦");
    }

    private static async Task CheckQqBotApiClientAsync(CheckFn check)
    {
        var handler = new FakeQqBotHttpHandler();
        var time = new MutableTimeProvider();
        var tokenCalls = 0;
        handler.Responder = (request, _) =>
        {
            var path = request.RequestUri!.AbsolutePath;
            if (path.EndsWith("/getAppAccessToken", StringComparison.Ordinal))
            {
                tokenCalls++;
                return Task.FromResult(JsonResponse($"{{\"access_token\":\"tok-{tokenCalls}\",\"expires_in\":7200}}"));
            }
            if (path == "/gateway") return Task.FromResult(JsonResponse("{\"url\":\"wss://fake-gateway\"}"));
            return Task.FromResult(JsonResponse("{}"));
        };
        using var api = new QqBotApiClient(
            "102146862", "secret", new HttpClient(handler),
            apiBase: "https://api.test",
            tokenUrl: "https://bots.test/app/getAppAccessToken",
            timeProvider: time);

        var token = await api.GetAccessTokenAsync();
        var tokenRequest = handler.Requests.First(item => item.Path.EndsWith("/getAppAccessToken", StringComparison.Ordinal));
        check("qqbot api: token 请求体（appId/clientSecret）",
            token == "tok-1" && tokenRequest.Body.Contains("102146862") && tokenRequest.Body.Contains("secret"),
            tokenRequest.Body);
        check("qqbot api: token 缓存复用（不重复请求）",
            await api.GetAccessTokenAsync() == "tok-1" && tokenCalls == 1, $"calls={tokenCalls}");

        var gateway = await api.GetGatewayUrlAsync();
        var gatewayRequest = handler.Requests.First(item => item.Path == "/gateway");
        check("qqbot api: GET /gateway + Authorization QQBot <token>",
            gateway == "wss://fake-gateway" && gatewayRequest.Authorization == "QQBot tok-1",
            $"{gateway} {gatewayRequest.Authorization}");

        // 过期前 5 分钟刷新
        time.Advance(TimeSpan.FromSeconds(7200 - 300 + 1));
        check("qqbot api: 过期前刷新", await api.GetAccessTokenAsync() == "tok-2" && tokenCalls == 2, $"calls={tokenCalls}");

        // 并发去重：5 个并发调用共享同一次刷新
        var refreshStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseRefresh = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        handler.Responder = async (request, _) =>
        {
            if (request.RequestUri!.AbsolutePath.EndsWith("/getAppAccessToken", StringComparison.Ordinal))
            {
                var current = Interlocked.Increment(ref tokenCalls);
                refreshStarted.TrySetResult();
                await releaseRefresh.Task;
                return JsonResponse($"{{\"access_token\":\"tok-{current}\",\"expires_in\":7200}}");
            }
            return JsonResponse("{}");
        };
        time.Advance(TimeSpan.FromHours(3));
        var concurrent = Enumerable.Range(0, 5).Select(_ => api.GetAccessTokenAsync()).ToArray();
        await refreshStarted.Task;
        releaseRefresh.TrySetResult();
        var tokens = await Task.WhenAll(concurrent);
        check("qqbot api: 并发刷新去重（5 并发 1 次刷新）",
            tokens.All(item => item == tokens[0]) && tokenCalls == 3, $"calls={tokenCalls} tokens={string.Join(",", tokens)}");

        // 被动回复请求体（私聊路径）
        await api.SendTextAsync(
            new QqBotSendTarget { OpenId = "OPENUSER1", ChatType = ChannelChatTypes.Private },
            new QqBotReplyRequest { MsgType = 0, Content = "你好", MsgId = "m1", MsgSeq = 1 });
        var sendRequest = handler.MessageRequests().Last();
        using (var bodyDocument = JsonDocument.Parse(sendRequest.Body))
        {
            var root = bodyDocument.RootElement;
            check("qqbot api: 被动回复请求体（msg_type/msg_id/msg_seq）",
                sendRequest.Method == "POST" && sendRequest.Path == "/v2/users/OPENUSER1/messages"
                && sendRequest.Authorization == $"QQBot {tokens[0]}"
                && root.GetProperty("msg_type").GetInt32() == 0
                && root.GetProperty("content").GetString() == "你好"
                && root.GetProperty("msg_id").GetString() == "m1"
                && root.GetProperty("msg_seq").GetInt32() == 1,
                sendRequest.Body);
        }

        // 群路径
        await api.SendTextAsync(
            new QqBotSendTarget { OpenId = "G1", ChatType = ChannelChatTypes.Group },
            new QqBotReplyRequest { MsgType = 0, Content = "群回复", MsgId = "g1", MsgSeq = 2 });
        check("qqbot api: 群路径 /v2/groups/{group_openid}/messages",
            handler.MessageRequests().Last().Path == "/v2/groups/G1/messages");

        // 错误映射（status/code/人话；不带凭据）
        handler.Responder = (request, _) => Task.FromResult(
            request.RequestUri!.AbsolutePath.Contains("/messages", StringComparison.Ordinal)
                ? JsonResponse("{\"code\":11244,\"message\":\"msg contains url\"}", HttpStatusCode.BadRequest)
                : JsonResponse("{}"));
        QqBotApiException? apiError = null;
        try
        {
            await api.SendTextAsync(
                new QqBotSendTarget { OpenId = "U", ChatType = ChannelChatTypes.Private },
                new QqBotReplyRequest { MsgType = 0, Content = "https://x", MsgId = "m", MsgSeq = 2 });
        }
        catch (QqBotApiException ex)
        {
            apiError = ex;
        }
        check("qqbot api: 错误映射（status/code/上游消息）",
            apiError is { Status: 400, Code: "11244" } && apiError.Message.Contains("msg contains url"),
            apiError?.Message ?? "no exception");
    }

    private static async Task CheckQqBotWsProtocolAsync(CheckFn check)
    {
        var gateway = new FakeQqBotGateway();
        var dispatches = new List<(string Type, JsonElement Data)>();
        var errors = new List<Exception>();
        await using var client = new QqBotWsClient(new QqBotWsClientOptions
        {
            GatewayUrl = "wss://fake",
            GetAccessToken = _ => Task.FromResult("fake-token"),
            SocketFactory = gateway.Factory,
            InitialBackoff = TimeSpan.FromMilliseconds(30),
            MaxBackoff = TimeSpan.FromMilliseconds(60),
            InvalidSessionDelay = TimeSpan.FromMilliseconds(30),
            MinHeartbeatIntervalMs = 20,
            OnDispatch = (type, data) => dispatches.Add((type, data.Clone())),
            OnReadyChange = _ => { },
            OnError = error => { lock (errors) errors.Add(error); },
        });
        await client.StartAsync();
        check("qqbot ws: 建立连接", await WaitUntilAsync(() => gateway.Sockets.Count == 1));
        var socket = gateway.Latest!;

        // Hello → Identify（token/intents/shard）
        socket.Push(new { op = 10, d = new { heartbeat_interval = 50 } });
        check("qqbot ws: Hello → Identify", await WaitUntilAsync(() => socket.SentOps(2).Count == 1));
        var identify = socket.SentOps(2)[0];
        check("qqbot ws: Identify 字段（token/intents/shard）",
            identify.GetProperty("d").GetProperty("token").GetString() == "QQBot fake-token"
            && identify.GetProperty("d").GetProperty("intents").GetInt32() == 1 << 25
            && identify.GetProperty("d").GetProperty("shard")[0].GetInt32() == 0
            && identify.GetProperty("d").GetProperty("shard")[1].GetInt32() == 1,
            identify.GetRawText());

        // READY → ready + 昵称；Dispatch 转发
        socket.Push(new { op = 0, t = "READY", s = 5, d = new { session_id = "sess-1", user = new { username = "小昔" } } });
        check("qqbot ws: READY → ready + 昵称",
            await WaitUntilAsync(() => client.IsReady && client.BotNickname == "小昔"),
            $"ready={client.IsReady} nickname={client.BotNickname}");
        socket.Push(new { op = 0, t = "C2C_MESSAGE_CREATE", s = 6, d = new { id = "m1", content = "hi" } });
        check("qqbot ws: Dispatch 事件转发（READY 不外抛）",
            await WaitUntilAsync(() => dispatches.Count == 1) && dispatches[0].Type == "C2C_MESSAGE_CREATE");

        // 心跳携带最近 seq；ACK 后可继续
        check("qqbot ws: 心跳携带最近 seq", await WaitUntilAsync(() => socket.SentOps(1).Count >= 1)
            && socket.SentOps(1)[0].GetProperty("d").GetInt32() == 6,
            string.Join(",", socket.SentOps(1).Select(item => item.GetRawText())));
        socket.Push(new { op = 11, d = (object?)null });

        // 停止 ACK → 心跳超时 abort → 退避重连 → Resume（session_id + seq）
        check("qqbot ws: 心跳无 ACK → abort 触发重连", await WaitUntilAsync(() => socket.Aborted));
        check("qqbot ws: 断线后重连（第 2 个 socket）", await WaitUntilAsync(() => gateway.Sockets.Count == 2));
        var second = gateway.Sockets[1];
        second.Push(new { op = 10, d = new { heartbeat_interval = 60_000 } });
        check("qqbot ws: Resume 携带 session_id/seq",
            await WaitUntilAsync(() => second.SentOps(6).Count == 1)
            && second.SentOps(6)[0].GetProperty("d").GetProperty("session_id").GetString() == "sess-1"
            && second.SentOps(6)[0].GetProperty("d").GetProperty("seq").GetInt64() == 6,
            second.SentOps(6).Count > 0 ? second.SentOps(6)[0].GetRawText() : "no resume");
        second.Push(new { op = 0, t = "RESUMED", s = 7, d = new { } });
        check("qqbot ws: RESUMED → ready", await WaitUntilAsync(() => client.IsReady));

        // op7 服务端要求重连 → 关闭 → 新连接 Resume
        second.Push(new { op = 7 });
        check("qqbot ws: op7 → 关闭并重连",
            await WaitUntilAsync(() => second.Closed) && await WaitUntilAsync(() => gateway.Sockets.Count == 3));
        var third = gateway.Sockets[2];
        third.Push(new { op = 10, d = new { heartbeat_interval = 60_000 } });
        check("qqbot ws: op7 后 Resume",
            await WaitUntilAsync(() => third.SentOps(6).Count == 1)
            && third.SentOps(6)[0].GetProperty("d").GetProperty("session_id").GetString() == "sess-1");

        // op9 Invalid Session → 丢弃 session，延迟后重新 Identify
        third.Push(new { op = 9, d = false });
        check("qqbot ws: op9 → 重新 Identify（丢弃 session）",
            await WaitUntilAsync(() => third.SentOps(2).Count == 1));

        await client.StopAsync();
        check("qqbot ws: Stop 打断在途（socket 关闭 + ready=false）",
            !client.IsReady && gateway.Sockets.All(item => item.Closed || item.Aborted));
        check("qqbot ws: 错误仅为预期的心跳超时（无未处理异常）",
            errors.All(item => item.Message.Contains("心跳超时")),
            string.Join(";", errors.Select(item => item.Message)));
    }

    private static async Task CheckQqBotAdapterAsync(CheckFn check)
    {
        var options = new ChannelOptions
        {
            QqBotAppId = "102146862",
            QqBotAppSecret = "secret",
            QqBotAllowedOpenIds = ["OPENUSER0000000000000000000001"],
        };

        // 白名单 / 群忽略 / 被动回复 msg_seq / 限频 / 去重 / 无引用拒绝
        await using (var harness = new QqBotHarness(options))
        {
            await harness.StartAsync();
            var status = harness.Adapter.GetStatus();
            check("qqbot adapter: 启动 → running + status detail（proactive:false + 文案）",
                status.Phase == ChannelPhases.Running
                && status.Detail?.GetProperty("proactive").GetBoolean() == false
                && status.Detail?.GetProperty("notice").GetString() == QqBotAdapter.ProactiveNotice,
                status.Detail?.GetRawText() ?? "null");

            harness.PushMessage(C2c("stranger-msg", "STRANGER000000000000000000001", "你好"));
            await Task.Delay(100);
            check("qqbot adapter: 白名单拒绝 + status detail 引导",
                harness.Received.Count == 0
                && harness.Adapter.GetStatus().Detail?.GetProperty("lastRejectedOpenid").GetString()
                    == "STRANGER000000000000000000001");

            harness.PushMessage(GroupAt("group-msg", "OPENUSER0000000000000000000002", "OPENGROUP1", "在吗"), "GROUP_AT_MESSAGE_CREATE");
            await Task.Delay(100);
            check("qqbot adapter: 群消息忽略（§1.3 仅私聊）",
                harness.Received.Count == 0
                && harness.Adapter.GetStatus().Detail?.GetProperty("ignoredGroupEvents").GetInt64() == 1);

            harness.PushMessage(C2c("ROBOT1.0_c2c_msg_001", "OPENUSER0000000000000000000001", "你好"));
            check("qqbot adapter: 入站归一化（复用 core Normalizer）",
                await WaitUntilAsync(() => harness.Received.Count == 1));
            var incoming = harness.Received[0];
            check("qqbot adapter: IncomingMessage 字段",
                incoming is
                {
                    Channel: "qqbot", ChatType: "private", MessageId: "ROBOT1.0_c2c_msg_001",
                    SenderId: "OPENUSER0000000000000000000001",
                    ChatId: "OPENUSER0000000000000000000001", Text: "你好",
                },
                JsonSerializer.Serialize(incoming, ChannelJson.Options));

            var outgoing = new OutgoingMessage
            {
                Channel = ChannelIds.QqBot,
                ChatType = ChannelChatTypes.Private,
                TargetId = "OPENUSER0000000000000000000001",
                ReplyContext = new OutgoingReplyContext { MessageId = "ROBOT1.0_c2c_msg_001" },
                Parts = [new OutgoingPart { Kind = OutgoingPartKinds.Text, Text = "第一段。第二段。" }],
            };
            var first = await harness.Adapter.SendAsync(outgoing);
            check("qqbot adapter: 被动回复（msg_id 关联 + msg_seq 1）",
                first.Ok
                && RequestField(harness.Handler.MessageRequests().Last(), "msg_id") == "ROBOT1.0_c2c_msg_001"
                && RequestInt(harness.Handler.MessageRequests().Last(), "msg_seq") == 1,
                harness.Handler.MessageRequests().Last().Body);

            var second = await harness.Adapter.SendAsync(outgoing);
            check("qqbot adapter: msg_seq 递增（2）",
                second.Ok && RequestInt(harness.Handler.MessageRequests().Last(), "msg_seq") == 2);

            var third = await harness.Adapter.SendAsync(outgoing);
            var fourth = await harness.Adapter.SendAsync(outgoing);
            var fifth = await harness.Adapter.SendAsync(outgoing);
            check("qqbot adapter: 单聊 4 条上限（第 5 次拒绝，不重试）",
                third.Ok && fourth.Ok && !fifth.Ok && fifth.Error!.Contains("上限")
                && harness.Handler.MessageRequests().Count == 4
                && harness.Handler.MessageRequests().Select(item => RequestInt(item, "msg_seq")).SequenceEqual([1, 2, 3, 4]),
                $"count={harness.Handler.MessageRequests().Count} error={fifth.Error}");

            harness.PushMessage(C2c("ROBOT1.0_c2c_msg_001", "OPENUSER0000000000000000000001", "你好"));
            await Task.Delay(100);
            check("qqbot adapter: message_id 去重（10 分钟 TTL）", harness.Received.Count == 1);

            var proactive = await harness.Adapter.SendAsync(new OutgoingMessage
            {
                Channel = ChannelIds.QqBot,
                TargetId = "NOBODY",
                Parts = [new OutgoingPart { Kind = OutgoingPartKinds.Text, Text = "主动消息" }],
            });
            check("qqbot adapter: 拒绝无引用主动发送（proactive:false）",
                !proactive.Ok && proactive.Error!.Contains("被动回复"), proactive.Error);
        }

        // P1（QQ 部分）：附件-only 消息（图片/语音）拦截回文案，不派发空文本（Q7）
        await using (var harness = new QqBotHarness(options))
        {
            await harness.StartAsync();
            harness.PushMessage(C2cWithAttachment("attach-img", "OPENUSER0000000000000000000001", "image/png"));
            harness.PushMessage(C2cWithAttachment("attach-voice", "OPENUSER0000000000000000000001", "voice"));
            check("qqbot adapter: 附件-only 拦截文案（不派发空文本）",
                await WaitUntilAsync(() => harness.Handler.MessageRequests().Count == 2)
                && harness.Received.Count == 0
                && harness.Handler.MessageRequests().All(item =>
                    RequestField(item, "content") == QqBotAdapter.AttachmentNotice),
                $"requests={harness.Handler.MessageRequests().Count} received={harness.Received.Count}");
        }

        // P2（QQ 部分）：并发发送 msg_seq 不重复（锁内规划/预占）
        await using (var harness = new QqBotHarness(options))
        {
            await harness.StartAsync();
            harness.PushMessage(C2c("concurrent-msg", "OPENUSER0000000000000000000001", "在吗"));
            await WaitUntilAsync(() => harness.Received.Count == 1);
            var concurrentOutgoing = new OutgoingMessage
            {
                Channel = ChannelIds.QqBot,
                ChatType = ChannelChatTypes.Private,
                TargetId = "OPENUSER0000000000000000000001",
                ReplyContext = new OutgoingReplyContext { MessageId = "concurrent-msg" },
                Parts = [new OutgoingPart { Kind = OutgoingPartKinds.Text, Text = "并发" }],
            };
            var results = await Task.WhenAll(
                Task.Run(() => harness.Adapter.SendAsync(concurrentOutgoing)),
                Task.Run(() => harness.Adapter.SendAsync(concurrentOutgoing)));
            var seqs = harness.Handler.MessageRequests()
                .Select(item => RequestInt(item, "msg_seq")).OrderBy(value => value).ToArray();
            check("qqbot adapter: 并发发送 msg_seq 不重复（锁内预占）",
                results.All(item => item.Ok) && seqs.SequenceEqual([1, 2]),
                $"seqs={string.Join(",", seqs)}");
        }

        // 窗口过期（虚拟时钟 +61 分钟）
        await using (var harness = new QqBotHarness(options))
        {
            await harness.StartAsync();
            harness.PushMessage(C2c("window-msg", "OPENUSER0000000000000000000001", "在吗"));
            await WaitUntilAsync(() => harness.Received.Count == 1);
            harness.Time.Advance(TimeSpan.FromMinutes(61));
            var expired = await harness.Adapter.SendAsync(new OutgoingMessage
            {
                Channel = ChannelIds.QqBot,
                ChatType = ChannelChatTypes.Private,
                TargetId = "OPENUSER0000000000000000000001",
                ReplyContext = new OutgoingReplyContext { MessageId = "window-msg" },
                Parts = [new OutgoingPart { Kind = OutgoingPartKinds.Text, Text = "回复" }],
            });
            check("qqbot adapter: 60 分钟窗口过期拒绝",
                !expired.Ok && expired.Error!.Contains("窗口") && harness.Handler.MessageRequests().Count == 0,
                expired.Error);
        }

        // URL 失败：默认保持内容诚实 → 失败并提示链接
        await using (var harness = new QqBotHarness(options, handler =>
        {
            handler.Responder = (request, body) =>
            {
                var path = request.RequestUri!.AbsolutePath;
                if (path == "/gateway") return Task.FromResult(JsonResponse("{\"url\":\"wss://fake-gateway\"}"));
                if (path.EndsWith("/getAppAccessToken", StringComparison.Ordinal))
                    return Task.FromResult(JsonResponse("{\"access_token\":\"tok\",\"expires_in\":7200}"));
                if (path.Contains("/messages", StringComparison.Ordinal) && body.Contains("http"))
                    return Task.FromResult(JsonResponse("{\"code\":11244,\"message\":\"msg contains url\"}", HttpStatusCode.BadRequest));
                return Task.FromResult(JsonResponse("{}"));
            };
        }))
        {
            await harness.StartAsync();
            harness.PushMessage(C2c("url-msg", "OPENUSER0000000000000000000001", "在吗"));
            await WaitUntilAsync(() => harness.Received.Count == 1);
            var failed = await harness.Adapter.SendAsync(new OutgoingMessage
            {
                Channel = ChannelIds.QqBot,
                ChatType = ChannelChatTypes.Private,
                TargetId = "OPENUSER0000000000000000000001",
                ReplyContext = new OutgoingReplyContext { MessageId = "url-msg" },
                Parts = [new OutgoingPart { Kind = OutgoingPartKinds.Text, Text = "看 https://example.com/a 哦" }],
            });
            check("qqbot adapter: URL 发送失败 → 明确错误（含链接提示）",
                !failed.Ok && failed.Error!.Contains("链接"), failed.Error);
        }

        // URL 失败处理：STRIP_URLS=1 → 占位替换后发送成功
        var stripOptions = new ChannelOptions
        {
            QqBotAppId = "102146862",
            QqBotAppSecret = "secret",
            QqBotStripUrls = true,
            QqBotAllowedOpenIds = ["OPENUSER0000000000000000000001"],
        };
        await using (var harness = new QqBotHarness(stripOptions))
        {
            await harness.StartAsync();
            harness.PushMessage(C2c("strip-msg", "OPENUSER0000000000000000000001", "在吗"));
            await WaitUntilAsync(() => harness.Received.Count == 1);
            var stripped = await harness.Adapter.SendAsync(new OutgoingMessage
            {
                Channel = ChannelIds.QqBot,
                ChatType = ChannelChatTypes.Private,
                TargetId = "OPENUSER0000000000000000000001",
                ReplyContext = new OutgoingReplyContext { MessageId = "strip-msg" },
                Parts = [new OutgoingPart { Kind = OutgoingPartKinds.Text, Text = "看 https://example.com/a 哦" }],
            });
            var request = harness.Handler.MessageRequests().Last();
            check("qqbot adapter: STRIP_URLS=1 → 占位替换后发送成功",
                stripped.Ok && RequestField(request, "content") == "看 [链接] 哦", request.Body);
        }

        // allowAnyPrivate 放行陌生 openid
        var anyOptions = new ChannelOptions
        {
            QqBotAppId = "102146862",
            QqBotAppSecret = "secret",
            QqBotAllowAnyPrivate = true,
        };
        await using (var harness = new QqBotHarness(anyOptions))
        {
            await harness.StartAsync();
            harness.PushMessage(C2c("any-msg", "STRANGER000000000000000000001", "你好"));
            check("qqbot adapter: allowAnyPrivate 放行", await WaitUntilAsync(() => harness.Received.Count == 1));
        }
    }

    private static object C2c(string id, string openId, string content) => new
    {
        id,
        author = new { user_openid = openId },
        content,
        timestamp = "2026-08-28T12:00:00+08:00",
    };

    /// <summary>附件-only 入站（content 为空；content_type=image/png 或 voice）。</summary>
    private static object C2cWithAttachment(string id, string openId, string contentType) => new
    {
        id,
        author = new { user_openid = openId },
        content = "",
        attachments = new[]
        {
            new { content_type = contentType, url = "https://example.com/a.png", filename = "a.png" },
        },
        timestamp = "2026-08-28T12:00:00+08:00",
    };

    private static object GroupAt(string id, string memberOpenId, string groupOpenId, string content) => new
    {
        id,
        author = new { member_openid = memberOpenId },
        group_openid = groupOpenId,
        content,
        timestamp = "2026-08-28T12:00:00+08:00",
    };

    private static async Task<bool> WaitUntilAsync(Func<bool> condition, int timeoutMs = 5_000)
    {
        var deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        while (DateTime.UtcNow < deadline)
        {
            if (condition()) return true;
            await Task.Delay(10);
        }
        return condition();
    }

    private static HttpResponseMessage JsonResponse(string json, HttpStatusCode status = HttpStatusCode.OK) =>
        new(status) { Content = new StringContent(json, Encoding.UTF8, "application/json") };

    private static string? RequestField(RecordedQqBotRequest request, string name)
    {
        using var document = JsonDocument.Parse(request.Body);
        return document.RootElement.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;
    }

    private static int RequestInt(RecordedQqBotRequest request, string name)
    {
        using var document = JsonDocument.Parse(request.Body);
        return document.RootElement.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Number
            ? value.GetInt32()
            : -1;
    }

    private sealed record RecordedQqBotRequest(string Method, string Path, string? Authorization, string Body);

    private sealed class FakeQqBotHttpHandler : HttpMessageHandler
    {
        private readonly object _sync = new();

        public List<RecordedQqBotRequest> Requests { get; } = [];

        public Func<HttpRequestMessage, string, Task<HttpResponseMessage>>? Responder { get; set; }

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var body = request.Content is null
                ? ""
                : await request.Content.ReadAsStringAsync(cancellationToken);
            lock (_sync)
            {
                Requests.Add(new RecordedQqBotRequest(
                    request.Method.Method,
                    request.RequestUri!.AbsolutePath,
                    request.Headers.TryGetValues("Authorization", out var values) ? values.FirstOrDefault() : null,
                    body));
            }
            var responder = Responder;
            return responder is null ? JsonResponse("{}") : await responder(request, body);
        }

        public List<RecordedQqBotRequest> MessageRequests()
        {
            lock (_sync)
            {
                return Requests.Where(item => item.Path.Contains("/messages", StringComparison.Ordinal)).ToList();
            }
        }
    }

    private sealed class FakeQqBotSocket : IQqBotWebSocket
    {
        private readonly Channel<string?> _incoming = Channel.CreateUnbounded<string?>();
        private readonly object _sync = new();
        private readonly List<JsonElement> _sent = [];

        public bool Closed { get; private set; }
        public bool Aborted { get; private set; }

        public bool IsOpen
        {
            get
            {
                lock (_sync) return !Closed && !Aborted;
            }
        }

        public Task SendTextAsync(string payload, CancellationToken cancellationToken)
        {
            var element = JsonDocument.Parse(payload).RootElement.Clone();
            lock (_sync) _sent.Add(element);
            return Task.CompletedTask;
        }

        public async Task<string?> ReceiveTextAsync(CancellationToken cancellationToken)
        {
            try
            {
                return await _incoming.Reader.ReadAsync(cancellationToken);
            }
            catch (OperationCanceledException)
            {
                return null;
            }
            catch (ChannelClosedException)
            {
                return null;
            }
        }

        public Task CloseAsync(int code, string reason, CancellationToken cancellationToken)
        {
            lock (_sync)
            {
                if (Closed || Aborted) return Task.CompletedTask;
                Closed = true;
            }
            _incoming.Writer.TryWrite(null);
            return Task.CompletedTask;
        }

        public void Abort()
        {
            lock (_sync)
            {
                if (Closed || Aborted) return;
                Aborted = true;
            }
            _incoming.Writer.TryWrite(null);
        }

        public ValueTask DisposeAsync()
        {
            _incoming.Writer.TryComplete();
            return ValueTask.CompletedTask;
        }

        /// <summary>模拟服务端下发一条消息。</summary>
        public void Push(object payload) => _incoming.Writer.TryWrite(JsonSerializer.Serialize(payload));

        public List<JsonElement> SentOps(int op)
        {
            lock (_sync)
            {
                return _sent
                    .Where(item => item.TryGetProperty("op", out var value) && value.GetInt32() == op)
                    .ToList();
            }
        }
    }

    private sealed class FakeQqBotGateway
    {
        public List<FakeQqBotSocket> Sockets { get; } = [];

        public FakeQqBotSocket? Latest => Sockets.Count > 0 ? Sockets[^1] : null;

        public Func<Uri, CancellationToken, Task<IQqBotWebSocket>> Factory => (_, _) =>
        {
            var socket = new FakeQqBotSocket();
            lock (Sockets) Sockets.Add(socket);
            return Task.FromResult<IQqBotWebSocket>(socket);
        };
    }

    private sealed class MutableTimeProvider : TimeProvider
    {
        private DateTimeOffset _now = DateTimeOffset.FromUnixTimeMilliseconds(1787889600000);

        public override DateTimeOffset GetUtcNow() => _now;

        // 定时器（心跳/退避）仍走真实时钟：selftest 只推进业务时间（窗口/刷新/TTL）
        public override ITimer CreateTimer(
            TimerCallback callback, object? state, TimeSpan dueTime, TimeSpan period) =>
            TimeProvider.System.CreateTimer(callback, state, dueTime, period);

        public void Advance(TimeSpan delta) => _now += delta;
    }

    private sealed class QqBotHarness : IAsyncDisposable
    {
        private readonly ChannelOptions _options;
        private readonly Action<FakeQqBotHttpHandler>? _configure;

        public FakeQqBotGateway Gateway { get; } = new();
        public FakeQqBotHttpHandler Handler { get; } = new();
        public MutableTimeProvider Time { get; } = new();
        public List<IncomingMessage> Received { get; } = [];
        public QqBotAdapter Adapter { get; private set; } = null!;

        public QqBotHarness(ChannelOptions options, Action<FakeQqBotHttpHandler>? configure = null)
        {
            _options = options;
            _configure = configure;
        }

        public async Task StartAsync()
        {
            Handler.Responder = (request, _) => Task.FromResult(request.RequestUri!.AbsolutePath switch
            {
                "/gateway" => JsonResponse("{\"url\":\"wss://fake-gateway\"}"),
                _ when request.RequestUri.AbsolutePath.EndsWith("/getAppAccessToken", StringComparison.Ordinal) =>
                    JsonResponse("{\"access_token\":\"tok\",\"expires_in\":7200}"),
                _ => JsonResponse("{}"),
            });
            _configure?.Invoke(Handler);
            var api = new QqBotApiClient(
                _options.QqBotAppId ?? "app",
                _options.QqBotAppSecret ?? "secret",
                new HttpClient(Handler),
                apiBase: "https://api.test",
                tokenUrl: "https://bots.test/app/getAppAccessToken",
                timeProvider: Time);
            Adapter = new QqBotAdapter(
                _options,
                NullLogger<QqBotAdapter>.Instance,
                api,
                wsOptions => new QqBotWsClient(new QqBotWsClientOptions
                {
                    GatewayUrl = wsOptions.GatewayUrl,
                    GetAccessToken = wsOptions.GetAccessToken,
                    OnDispatch = wsOptions.OnDispatch,
                    OnReadyChange = wsOptions.OnReadyChange,
                    OnError = wsOptions.OnError,
                    SocketFactory = Gateway.Factory,
                    InitialBackoff = TimeSpan.FromMilliseconds(30),
                    MaxBackoff = TimeSpan.FromMilliseconds(60),
                    MinHeartbeatIntervalMs = 20,
                    TimeProvider = Time,
                }),
                Time);
            Adapter.OnMessage = (message, _) =>
            {
                lock (Received) Received.Add(message);
                return Task.FromResult<OutgoingMessage?>(null);
            };
            await Adapter.StartAsync();
            if (!await WaitUntilAsync(() => Gateway.Sockets.Count == 1))
            {
                throw new InvalidOperationException("fake QQ 网关未连接");
            }
            var socket = Gateway.Latest!;
            socket.Push(new { op = 10, d = new { heartbeat_interval = 30_000 } });
            socket.Push(new { op = 0, t = "READY", s = 1, d = new { session_id = "sess-1" } });
            if (!await WaitUntilAsync(() => Adapter.GetStatus().Phase == ChannelPhases.Running))
            {
                throw new InvalidOperationException("QQ Bot 适配器未进入 running");
            }
        }

        public void PushMessage(object data, string type = "C2C_MESSAGE_CREATE") =>
            Gateway.Latest!.Push(new { op = 0, t = type, s = 2, d = data });

        public async ValueTask DisposeAsync() => await Adapter.StopAsync();
    }

}

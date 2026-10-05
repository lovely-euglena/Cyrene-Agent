using System.Text.Json;
using CyreneCloud.Channels.Adapters.Feishu;
using CyreneCloud.Dialog;
using CyreneCloud.Storage;
using CyreneNative.Channels;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Logging.Abstractions;

namespace CyreneCloud.Channels;

/// <summary>
/// 渠道框架自测（裸跑：cyrene-cloud-server channel-selftest framework；--selftest framework 同义）。
///
/// 覆盖阶段 2 框架批（设计 §8.2/§8.3）：ChannelOptions 解析、ChannelStore（去重/收件人/回执/
/// 凭据加解密/归属表原语）、ChannelManager（注册/单实例守卫/状态）、ServerEventWriter
/// （lamport/seq 原子分配、幂等、presentation 形态）、ChannelDispatcher 端到端（写事件/生成/
/// 投递/回执/门闩）与 ChannelDeliveryService 重试。阶段 3-6 追加 wechat/feishu/qqbot 子集。
/// </summary>
internal static class ChannelSelfTest
{
    public static int Run(string suite)
    {
        try
        {
            return suite switch
            {
                "framework" => RunFrameworkAsync().GetAwaiter().GetResult(),
                "feishu" => FeishuSelfTest.RunAsync().GetAwaiter().GetResult(),
                "all" => RunAll(),
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

    private static int RunAll()
    {
        var failures = RunFrameworkAsync().GetAwaiter().GetResult();
        failures += FeishuSelfTest.RunAsync().GetAwaiter().GetResult();
        Console.WriteLine(failures == 0
            ? "SELFTEST channel all: ALL PASS"
            : $"SELFTEST channel all: {failures} FAILURES");
        return failures;
    }

    private delegate void CheckFn(string name, bool ok, string detail = "");

    private static int Unknown(string suite)
    {
        Console.WriteLine($"未知渠道自测子集: {suite}（可用: framework | feishu | all）");
        return 2;
    }

    private static async Task<int> RunFrameworkAsync()
    {
        var failures = 0;
        void Check(string name, bool ok, string detail = "")
        {
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
            Channel = ChannelIds.Feishu, TargetId = "ou_1",
            Parts = [new OutgoingPart { Kind = OutgoingPartKinds.Text, Text = "hi" }],
        });
        check("delivery: adapter_not_found", !missing.Ok && missing.Error == "adapter_not_found");
    }

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

        public Task StartAsync(CancellationToken cancellationToken = default)
        {
            StartCount++;
            return Task.CompletedTask;
        }

        public Task StopAsync(CancellationToken cancellationToken = default)
        {
            StopCount++;
            return Task.CompletedTask;
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
}

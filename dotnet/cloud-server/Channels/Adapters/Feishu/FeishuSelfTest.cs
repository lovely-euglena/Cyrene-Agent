using System.Buffers.Binary;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using CyreneCloud.Dialog;
using CyreneCloud.Storage;
using CyreneNative.Channels;
using CyreneNative.Channels.Normalizers;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Logging.Abstractions;

namespace CyreneCloud.Channels.Adapters.Feishu;

/// <summary>
/// 飞书渠道自测（裸跑：cyrene-cloud-server channel-selftest feishu）：
///
/// 1. 加密/签名：官方文档解密向量（P37w+… + "test key" → hello world）+ 官方算法冻结签名向量
///    + Verification Token/时间戳/解密失败路径；
/// 2. webhook 回放：fixtures/channels/feishu-webhook/*.json（challenge 明文/加密、文本/图片/群忽略/
///    重试去重/坏签名/过期时间戳/明文事件），Node 独立实现生成的跨实现向量；
/// 3. 去重表：message_id + event_id 双键；
/// 4. 媒体转码两态：ffmpeg 不可用（降级路径）与 mock 可用（OggS 输出）；本机有 ffmpeg 时加测真实转码；
/// 5. REST 客户端：token 缓存/并发去重、发送、上传（file_type=opus）、下载/超限、错误码透传；
/// 6. 适配器：文本/图片/音频两态发送、降级文本、状态 detail；dispatcher→adapter（oc_ 目标）集成。
/// </summary>
internal static class FeishuSelfTest
{
    private const string FixtureToken = "cyrene-test-token";
    private const string FixtureEncryptKey = "cyrene-test-encrypt-key";

    /// <summary>飞书开放平台「步骤三：接收事件」官方解密示例密文（Encrypt Key = "test key"）。</summary>
    private const string OfficialEncryptSample = "P37w+VZImNgPEO1RBhJ6RtKl7n6zymIbEG1pReEzghk=";

    /// <summary>官方算法冻结签名向量（Node crypto 独立实现生成，输入见 CheckCryptoAsync）。</summary>
    private const string OfficialSignatureVector = "e4e4027ca83bfab6b33641d3d40cdb6013b97475be076a9277313c1588709447";

    public static async Task<int> RunAsync()
    {
        var failures = 0;
        void Check(string name, bool ok, string detail = "")
        {
            ChannelSelfTest.CheckCount++;
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

        await CheckCryptoAsync(Check);
        await CheckWebhookFixturesAsync(Check);
        await CheckDedupeAsync(Check);
        await CheckTranscoderAsync(Check);
        await CheckApiClientAsync(Check);
        await CheckAdapterAsync(Check);
        await CheckDispatcherIntegrationAsync(Check);

        Console.WriteLine(failures == 0
            ? "SELFTEST channel feishu: ALL PASS"
            : $"SELFTEST channel feishu: {failures} FAILURES");
        return failures;
    }

    // ── 1. 加密/签名 ─────────────────────────────────────────────────────────

    private static Task CheckCryptoAsync(Action<string, bool, string> check)
    {
        var clock = new FixedTimeProvider(DateTimeOffset.Parse("2026-10-05T08:00:00.000Z"));
        var crypto = new FeishuEventCrypto(FixtureToken, FixtureEncryptKey, clock);
        // 官方向量使用文档中的 Encrypt Key（"test key"），与 fixtures 密钥分离
        var officialCrypto = new FeishuEventCrypto(FixtureToken, "test key", clock);

        var official = officialCrypto.Decrypt(OfficialEncryptSample);
        check("crypto: 官方文档解密向量（test key → hello world）", official == "hello world", official ?? "null");

        var body = Encoding.UTF8.GetBytes("{\"encrypt\":\"" + OfficialEncryptSample + "\"}");
        var signature = officialCrypto.ComputeSignature("1595482113", "feishu-nonce", body);
        check("crypto: 官方算法签名冻结向量", signature == OfficialSignatureVector, signature ?? "null");
        check("crypto: 签名校验（大小写不敏感）",
            officialCrypto.VerifySignature("1595482113", "feishu-nonce", body, signature!.ToUpperInvariant()), "");
        check("crypto: 签名校验（篡改拒绝）",
            !officialCrypto.VerifySignature("1595482113", "feishu-nonce", body, new string('0', 64))
            && !officialCrypto.VerifySignature("1595482113", "feishu-nonce", body, null), "");

        check("crypto: Verification Token 定长比较",
            crypto.VerifyToken(FixtureToken)
            && !crypto.VerifyToken("wrong-token")
            && !crypto.VerifyToken(null)
            && !crypto.VerifyToken(""), "");

        // 2026-10-05T08:00:00Z = 1791187200；窗口 ±300s
        check("crypto: 时间戳新鲜度 ±5 分钟（含边界）",
            crypto.IsTimestampFresh("1791187200")
            && crypto.IsTimestampFresh("1791186900")
            && crypto.IsTimestampFresh("1791187500")
            && !crypto.IsTimestampFresh("1791186899")
            && !crypto.IsTimestampFresh("1791187501")
            && !crypto.IsTimestampFresh("not-a-number")
            && !crypto.IsTimestampFresh(null), "");
        check("crypto: 越界时间戳（15 位数字）判不新鲜、不抛异常",
            !crypto.IsTimestampFresh("999999999999999")
            && !crypto.IsTimestampFresh("-999999999999999"), "");

        var stale = crypto.Verify("1791186600", "nonce", "x", body);
        check("crypto: 过期时间戳拒绝", !stale.Ok && stale.Error == FeishuEventCrypto.ErrorTimestamp, stale.Error ?? "");

        var overflow = crypto.Verify("999999999999999", "nonce", null, body);
        check("crypto: 越界时间戳走 401（E_FEISHU_TIMESTAMP，不抛 500）",
            !overflow.Ok && overflow.Error == FeishuEventCrypto.ErrorTimestamp, overflow.Error ?? "exception");

        var badSignature = crypto.Verify("1791187200", "nonce", new string('a', 64), body);
        check("crypto: 坏签名拒绝", !badSignature.Ok && badSignature.Error == FeishuEventCrypto.ErrorSignature, badSignature.Error ?? "");

        var noKey = new FeishuEventCrypto(FixtureToken, null, clock);
        var encryptedNoKey = noKey.Verify("1791187200", "nonce", null,
            Encoding.UTF8.GetBytes("{\"encrypt\":\"" + OfficialEncryptSample + "\"}"));
        check("crypto: 无 Encrypt Key 遇加密体拒绝",
            !encryptedNoKey.Ok && encryptedNoKey.Error == FeishuEventCrypto.ErrorEncryptKeyMissing, encryptedNoKey.Error ?? "");

        var wrongKey = new FeishuEventCrypto(FixtureToken, "other key", clock);
        check("crypto: 错误 Encrypt Key 解密失败（null）", wrongKey.Decrypt(OfficialEncryptSample) is null, "");

        var plain = crypto.Verify("1791187200", "nonce", crypto.ComputeSignature(
            "1791187200", "nonce", Encoding.UTF8.GetBytes("{\"type\":\"url_verification\",\"challenge\":\"c1\",\"token\":\"t\"}")),
            Encoding.UTF8.GetBytes("{\"type\":\"url_verification\",\"challenge\":\"c1\",\"token\":\"t\"}"));
        check("crypto: 完整校验通过（明文 body）", plain.Ok && plain.Plaintext!.Contains("\"challenge\":\"c1\""), plain.Error ?? "");
        return Task.CompletedTask;
    }

    // ── 2. webhook 回放 fixtures ─────────────────────────────────────────────

    private static async Task CheckWebhookFixturesAsync(Action<string, bool, string> check)
    {
        var dir = ResolveFixtureDir("feishu-webhook");
        if (dir is null)
        {
            check("webhook: fixtures/channels/feishu-webhook 存在", false, "未找到目录（cwd 应为仓库根）");
            return;
        }
        var files = Directory.GetFiles(dir, "*.json").OrderBy(Path.GetFileName, StringComparer.Ordinal).ToArray();
        check("webhook: fixtures 非空", files.Length > 0, $"files={files.Length}");

        foreach (var file in files)
        {
            using var document = JsonDocument.Parse(File.ReadAllText(file));
            var root = document.RootElement;
            var name = root.TryGetProperty("name", out var nameElement) ? nameElement.GetString() ?? "" : "";
            var config = root.GetProperty("config");
            var clock = new FixedTimeProvider(DateTimeOffset.Parse(config.GetProperty("now").GetString()!));
            var crypto = new FeishuEventCrypto(
                OptionalString(config, "verificationToken"), OptionalString(config, "encryptKey"), clock);

            var tempDir = NewTempDir("feishu-webhook");
            try
            {
                var store = new ChannelStore(Path.Combine(tempDir, "channels.db"));
                var handler = new FakeFeishuHandler();
                using var api = new FeishuApiClient("cli_test_app", "secret_test", handler);
                var adapter = new FeishuAdapter(
                    new ChannelOptions
                    {
                        FeishuAppId = "cli_test_app",
                        FeishuAppSecret = "secret_test",
                        FeishuVerificationToken = FixtureToken,
                    },
                    store,
                    api,
                    new FeishuMediaTranscoder("__missing_ffmpeg__", runner: UnavailableRunner),
                    Path.Combine(tempDir, "media"),
                    NullLogger<FeishuAdapter>.Instance);
                var handled = new List<IncomingMessage>();
                adapter.OnMessage = (message, _) =>
                {
                    handled.Add(message);
                    return Task.FromResult<OutgoingMessage?>(null);
                };
                var manager = new ChannelManager(NullLogger<ChannelManager>.Instance);
                manager.Register(adapter);
                var processor = new FeishuWebhookProcessor(
                    crypto, store, manager, NullLogger<FeishuWebhookProcessor>.Instance);

                var requests = root.GetProperty("requests").EnumerateArray().ToArray();
                var expects = root.GetProperty("expect").EnumerateArray().ToArray();
                for (var index = 0; index < requests.Length; index++)
                {
                    var request = requests[index];
                    var outcome = await processor.HandleAsync(
                        new FeishuWebhookRequest(
                            OptionalString(request, "timestamp"),
                            OptionalString(request, "nonce"),
                            OptionalString(request, "signature"),
                            Encoding.UTF8.GetBytes(request.GetProperty("body").GetString()!)),
                        processInline: true);
                    var label = $"webhook: {Path.GetFileNameWithoutExtension(file)}[{index}]（{name}）";
                    var expected = expects[Math.Min(index, expects.Length - 1)];
                    var expectedStatus = expected.GetProperty("status").GetInt32();
                    var ok = outcome.StatusCode == expectedStatus;
                    var detail = ok ? "" : $"status got={outcome.StatusCode} want={expectedStatus} body={outcome.Body.GetRawText()}";
                    if (ok && expected.TryGetProperty("body", out var expectedBody))
                    {
                        ok = MatchSubset(outcome.Body, expectedBody, out detail);
                    }
                    check(label, ok, detail);
                }
            }
            finally
            {
                CleanupTempDir(tempDir);
            }
        }

        // 仅 Encrypt Key（无 Verification Token）配置：签名/解密通过即放行（注册门槛仍要求 token 齐备）
        var keyOnlyCrypto = new FeishuEventCrypto(
            null, FixtureEncryptKey, new FixedTimeProvider(DateTimeOffset.Parse("2026-10-05T08:00:00.000Z")));
        var keyOnlyProcessor = new FeishuWebhookProcessor(
            keyOnlyCrypto, null, null, NullLogger<FeishuWebhookProcessor>.Instance);
        var encryptedChallengeFile = Path.Combine(dir, "challenge-encrypted.json");
        if (File.Exists(encryptedChallengeFile))
        {
            using var document = JsonDocument.Parse(File.ReadAllText(encryptedChallengeFile));
            var request = document.RootElement.GetProperty("requests")[0];
            var outcome = await keyOnlyProcessor.HandleAsync(
                new FeishuWebhookRequest(
                    OptionalString(request, "timestamp"),
                    OptionalString(request, "nonce"),
                    OptionalString(request, "signature"),
                    Encoding.UTF8.GetBytes(request.GetProperty("body").GetString()!)),
                processInline: true);
            check("webhook: 仅 Encrypt Key（无 token）签名通过即放行",
                outcome.StatusCode == 200
                && outcome.Body.GetProperty("challenge").GetString() == "cyrene-challenge-2",
                outcome.Body.GetRawText());
        }
    }

    // ── 3. 去重表 ────────────────────────────────────────────────────────────

    private static async Task CheckDedupeAsync(Action<string, bool, string> check)
    {
        var dir = NewTempDir("feishu-dedupe");
        try
        {
            var store = new ChannelStore(Path.Combine(dir, "channels.db"));
            using var document = JsonDocument.Parse(
                """{"header":{"event_id":"evt-1"},"event":{"message":{"message_id":"om-1"}}}""");
            var envelope = document.RootElement;
            var (messageKey, eventKey) = FeishuEventDedupe.Keys(envelope);
            check("dedupe: 双键提取", messageKey == "msg:om-1" && eventKey == "evt:evt-1", $"{messageKey},{eventKey}");
            check("dedupe: 首次新事件", await FeishuEventDedupe.MarkSeenAsync(store, envelope), "");
            check("dedupe: 二次重复", !await FeishuEventDedupe.MarkSeenAsync(store, envelope), "");

            using var document2 = JsonDocument.Parse(
                """{"header":{"event_id":"evt-2"},"event":{"message":{"message_id":"om-1"}}}""");
            check("dedupe: message_id 键独立生效（不同 event_id 仍重复）",
                !await FeishuEventDedupe.MarkSeenAsync(store, document2.RootElement), "");
        }
        finally
        {
            CleanupTempDir(dir);
        }
    }

    // ── 4. 媒体转码两态 ──────────────────────────────────────────────────────

    private static async Task CheckTranscoderAsync(Action<string, bool, string> check)
    {
        var dir = NewTempDir("feishu-transcode");
        try
        {
            var input = Path.Combine(dir, "input.mp3");
            File.WriteAllBytes(input, [0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);

            // 态 A：不可用 → 探针 false + 转码抛 E_FEISHU_TRANSCODE_UNAVAILABLE
            var unavailable = new FeishuMediaTranscoder("__missing_ffmpeg__", runner: UnavailableRunner);
            check("transcoder: 不可用探针", !await unavailable.IsAvailableAsync(), "");
            try
            {
                await unavailable.TranscodeToOggOpusAsync(input, dir);
                check("transcoder: 不可用转码拒绝", false, "未抛异常");
            }
            catch (FeishuTranscodeException ex)
            {
                check("transcoder: 不可用转码拒绝",
                    ex.ErrorCode == FeishuMediaTranscoder.ErrorUnavailable, ex.ErrorCode);
            }

            // 态 B：mock 可用 → 输出 OggS（无 ffmpeg 环境下的可用态）
            var mock = new FeishuMediaTranscoder("mock-ffmpeg", runner: MockFfmpegRunner);
            check("transcoder: mock 探针可用", await mock.IsAvailableAsync(), "");
            var output = await mock.TranscodeToOggOpusAsync(input, dir);
            check("transcoder: mock 转码输出 OggS",
                File.Exists(output) && FeishuMediaTranscoder.IsOggOpusFile(output), output);

            // Ogg granule_position → duration（上传 opus 显式 duration；与桌面 SDK parseOpusDuration 同口径）
            var ogg = new byte[64];
            Encoding.ASCII.GetBytes("OggS").CopyTo(ogg, 0);
            ogg[4] = 0;
            ogg[5] = 2;
            BinaryPrimitives.WriteInt64LittleEndian(ogg.AsSpan(6), 48000L);
            var oggPath = Path.Combine(dir, "duration.ogg");
            File.WriteAllBytes(oggPath, ogg);
            check("transcoder: Ogg granule → duration（48000/48=1000ms）",
                FeishuMediaTranscoder.TryReadOggOpusDurationMs(oggPath) == 1000,
                FeishuMediaTranscoder.TryReadOggOpusDurationMs(oggPath)?.ToString() ?? "null");
            var notOggPath = Path.Combine(dir, "not-ogg.bin");
            File.WriteAllBytes(notOggPath, new byte[64]);
            check("transcoder: 非 Ogg 文件 duration=null",
                FeishuMediaTranscoder.TryReadOggOpusDurationMs(notOggPath) is null, "");

            // 真实 ffmpeg（本机/镜像安装时）：1s 静音 WAV → Ogg Opus 实测
            var real = new FeishuMediaTranscoder();
            if (await real.IsAvailableAsync())
            {
                var wav = Path.Combine(dir, "silence.wav");
                WriteSilentWav(wav, 1.0);
                var realOutput = await real.TranscodeToOggOpusAsync(wav, dir);
                check("transcoder: 真机 ffmpeg 转码 Ogg Opus",
                    File.Exists(realOutput) && FeishuMediaTranscoder.IsOggOpusFile(realOutput), realOutput);
            }
            else
            {
                Console.WriteLine("[INFO] 本机无 ffmpeg：转码可用态为 mock（真机路径由镜像内 ffmpeg 覆盖）");
            }
        }
        finally
        {
            CleanupTempDir(dir);
        }
    }

    // ── 5. REST 客户端 ───────────────────────────────────────────────────────

    private static async Task CheckApiClientAsync(Action<string, bool, string> check)
    {
        var dir = NewTempDir("feishu-api");
        try
        {
            var handler = new FakeFeishuHandler();
            using var client = new FeishuApiClient("cli_test_app", "secret_test", handler);

            // token：5 个并发只取一次（信号量去重）
            var tokens = await Task.WhenAll(Enumerable.Range(0, 5).Select(_ => client.GetTenantAccessTokenAsync()));
            check("api: token 并发去重 + 缓存",
                tokens.All(item => item == "t-1") && handler.TokenCalls == 1, $"calls={handler.TokenCalls}");

            var messageId = await client.SendMessageAsync("open_id", new FeishuSendRequest
            {
                ReceiveId = "ou_user_1",
                MsgType = "text",
                Content = "{\"text\":\"hi\"}",
            });
            check("api: im/v1/messages 发送（receive_id_type 查询 + message_id）",
                messageId == "om_sent_1"
                && handler.Messages.Count == 1
                && handler.Messages[0].Query.Contains("receive_id_type=open_id"),
                handler.Messages.FirstOrDefault().Query ?? "none");

            var png = Path.Combine(dir, "pic.png");
            File.WriteAllBytes(png, [0x89, 0x50, 0x4E, 0x47]);
            var imageKey = await client.UploadImageAsync(png);
            check("api: 图片上传 image_key", imageKey == "img_key_1" && handler.ImageUploads == 1, imageKey);

            var fileKey = await client.UploadFileAsync(png, "voice.ogg", "opus", durationMs: 1200);
            check("api: 文件上传（file_type=opus + file_name）",
                fileKey == "file_key_1"
                && handler.FileUploads.Count == 1
                && handler.FileUploads[0].FileType == "opus"
                && handler.FileUploads[0].FileName == "voice.ogg",
                JsonSerializer.Serialize(handler.FileUploads));

            var dest = Path.Combine(dir, "dl.png");
            var size = await client.DownloadResourceAsync("om_1", "img_key_fixture_1", "image", dest, 1024 * 1024);
            check("api: 资源下载落盘（type=image）",
                size > 0 && File.Exists(dest) && handler.ResourceQueries.Contains("?type=image"),
                $"size={size} queries={string.Join(",", handler.ResourceQueries)}");

            handler.ResourceBytes = new byte[4096];
            var tooLargeDest = Path.Combine(dir, "too-large.bin");
            try
            {
                await client.DownloadResourceAsync("om_1", "big_key", "file", tooLargeDest, 1024);
                check("api: 超限拒绝（E_FEISHU_MEDIA_TOO_LARGE）", false, "未抛异常");
            }
            catch (FeishuApiException ex)
            {
                check("api: 超限拒绝（E_FEISHU_MEDIA_TOO_LARGE）",
                    ex.ErrorCode == "E_FEISHU_MEDIA_TOO_LARGE" && !File.Exists(tooLargeDest), ex.ErrorCode);
            }

            handler.SendError = true;
            try
            {
                await client.SendMessageAsync("open_id", new FeishuSendRequest
                {
                    ReceiveId = "ou_user_1", MsgType = "text", Content = "{}",
                });
                check("api: 飞书错误码透传", false, "未抛异常");
            }
            catch (FeishuApiException ex)
            {
                check("api: 飞书错误码透传（E_FEISHU_99991663）",
                    ex.ErrorCode == "E_FEISHU_99991663" && ex.ApiCode == 99991663, ex.ErrorCode);
            }

            handler.SendError = false;
            handler.ForceHttpStatus = 500;
            try
            {
                await client.SendMessageAsync("open_id", new FeishuSendRequest
                {
                    ReceiveId = "ou_user_1", MsgType = "text", Content = "{}",
                });
                check("api: HTTP 失败映射", false, "未抛异常");
            }
            catch (FeishuApiException ex)
            {
                check("api: HTTP 失败映射（E_FEISHU_HTTP_500）",
                    ex.ErrorCode == "E_FEISHU_HTTP_500", ex.ErrorCode);
            }
        }
        finally
        {
            CleanupTempDir(dir);
        }
    }

    // ── 6. 适配器 ────────────────────────────────────────────────────────────

    private static async Task CheckAdapterAsync(Action<string, bool, string> check)
    {
        var dir = NewTempDir("feishu-adapter");
        try
        {
            // 文本发送 + 状态
            var textHandler = new FakeFeishuHandler();
            using (var textApi = new FeishuApiClient("cli_test_app", "secret_test", textHandler))
            {
                var adapter = BuildAdapter(dir, textApi);
                await adapter.StartAsync();
                var status = adapter.GetStatus();
                check("adapter: 启动状态 running + detail(owner/webhook)",
                    status.Enabled && status.Phase == ChannelPhases.Running
                    && status.Detail!.Value.GetProperty("owner").GetString() == "server"
                    && status.Detail.Value.GetProperty("webhook").GetString() == "ready",
                    JsonSerializer.Serialize(status, ChannelJson.Options));

                var textResult = await adapter.SendAsync(new OutgoingMessage
                {
                    Channel = ChannelIds.Feishu,
                    TargetId = "oc_user_1",
                    Parts = [new OutgoingPart { Kind = OutgoingPartKinds.Text, Text = "你好，昔涟" }],
                });
                var textMessage = textHandler.Messages.FirstOrDefault();
                check("adapter: 文本发送（msg_type=text + content + receive_id_type=chat_id）",
                    textResult.Ok && textHandler.Messages.Count == 1
                    && textMessage.Query.Contains("receive_id_type=chat_id", StringComparison.Ordinal)
                    && MessageField(textMessage.Body, "receive_id") == "oc_user_1"
                    && MessageField(textMessage.Body, "msg_type") == "text"
                    && MessageContent(textMessage.Body).Contains("你好，昔涟", StringComparison.Ordinal),
                    $"{textMessage.Query} {textMessage.Body}");

                var imagePath = Path.Combine(dir, "pic.png");
                File.WriteAllBytes(imagePath, [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A]);
                var imageResult = await adapter.SendAsync(new OutgoingMessage
                {
                    Channel = ChannelIds.Feishu,
                    TargetId = "oc_user_1",
                    Parts = [new OutgoingPart { Kind = OutgoingPartKinds.Image, FilePath = imagePath }],
                });
                var imageMessage = textHandler.Messages.LastOrDefault();
                check("adapter: 图片发送（上传 image_key → msg_type=image）",
                    imageResult.Ok && textHandler.ImageUploads == 1
                    && MessageField(imageMessage.Body, "receive_id") == "oc_user_1"
                    && MessageField(imageMessage.Body, "msg_type") == "image"
                    && MessageContent(imageMessage.Body).Contains("img_key_1", StringComparison.Ordinal),
                    imageMessage.Body ?? "none");

                var missing = await adapter.SendAsync(new OutgoingMessage
                {
                    Channel = ChannelIds.Feishu,
                    TargetId = "oc_user_1",
                    Parts = [new OutgoingPart { Kind = OutgoingPartKinds.Image, Url = "https://example.com/x.png" }],
                });
                check("adapter: 缺上传结果 → 失败（缺图片上传结果）",
                    !missing.Ok && (missing.Error?.Contains("缺少图片上传结果", StringComparison.Ordinal) ?? false),
                    missing.Error ?? "none");
                check("adapter: 失败后状态 lastErrorCode 可见",
                    adapter.GetStatus().Detail!.Value.GetProperty("lastErrorCode").GetString() == "E_FEISHU_SEND_PLAN", "");
            }

            var audioPath = Path.Combine(dir, "voice.mp3");
            File.WriteAllBytes(audioPath, [0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);

            // 态 A：ffmpeg 不可用 → 文本降级
            var unavailableHandler = new FakeFeishuHandler();
            using (var unavailableApi = new FeishuApiClient("cli_test_app", "secret_test", unavailableHandler))
            {
                var adapter = BuildAdapter(
                    dir, unavailableApi, new FeishuMediaTranscoder("__missing_ffmpeg__", runner: UnavailableRunner));
                var result = await adapter.SendAsync(AudioMessage(audioPath));
                var sent = unavailableHandler.Messages.FirstOrDefault();
                check("adapter: 音频两态 A（ffmpeg 不可用 → 文本降级、不调上传）",
                    result.Ok && unavailableHandler.FileUploads.Count == 0
                    && MessageField(sent.Body, "msg_type") == "text"
                    && MessageContent(sent.Body).Contains(FeishuAdapter.AudioFallbackText, StringComparison.Ordinal),
                    sent.Body ?? "none");
            }

            // 态 B：mock 转码可用 → file_type=opus + msg_type=audio
            var mockHandler = new FakeFeishuHandler();
            using (var mockApi = new FeishuApiClient("cli_test_app", "secret_test", mockHandler))
            {
                var adapter = BuildAdapter(
                    dir, mockApi, new FeishuMediaTranscoder("mock-ffmpeg", runner: MockFfmpegRunner));
                var result = await adapter.SendAsync(AudioMessage(audioPath));
                var sent = mockHandler.Messages.FirstOrDefault();
                check("adapter: 音频两态 B（mock 转码 → opus 上传 + msg_type=audio）",
                    result.Ok && mockHandler.FileUploads.Count == 1
                    && mockHandler.FileUploads[0].FileType == "opus"
                    && mockHandler.FileUploads[0].FileName == "voice.ogg"
                    && MessageField(sent.Body, "receive_id") == "oc_user_1"
                    && MessageField(sent.Body, "msg_type") == "audio"
                    && MessageContent(sent.Body).Contains("file_key_1", StringComparison.Ordinal),
                    $"{JsonSerializer.Serialize(mockHandler.FileUploads)} {sent.Body ?? "none"}");
                check("adapter: 转码后 VoiceAvailable=true", adapter.VoiceAvailable, "");
            }

            // 语音开关关闭（CLOUD_CHANNEL_FEISHU_AUDIO=0）→ 文本降级
            var disabledHandler = new FakeFeishuHandler();
            using (var disabledApi = new FeishuApiClient("cli_test_app", "secret_test", disabledHandler))
            {
                var adapter = BuildAdapter(
                    dir, disabledApi, new FeishuMediaTranscoder("mock-ffmpeg", runner: MockFfmpegRunner),
                    new ChannelOptions
                    {
                        FeishuAppId = "cli_test_app",
                        FeishuAppSecret = "secret_test",
                        FeishuVerificationToken = FixtureToken,
                        FeishuAudio = false,
                    });
                var result = await adapter.SendAsync(AudioMessage(audioPath));
                var sent = disabledHandler.Messages.FirstOrDefault();
                check("adapter: CLOUD_CHANNEL_FEISHU_AUDIO=0 → 文本降级",
                    result.Ok && disabledHandler.FileUploads.Count == 0
                    && MessageField(sent.Body, "msg_type") == "text"
                    && MessageContent(sent.Body).Contains(FeishuAdapter.AudioFallbackText, StringComparison.Ordinal),
                    sent.Body ?? "none");
            }
        }
        finally
        {
            CleanupTempDir(dir);
        }
    }

    // ── 7. dispatcher → adapter（oc_ 目标）集成 ───────────────────────────────

    /// <summary>
    /// 真实链路（§6.4）：webhook 事件 → 适配器归一化/去重 → dispatcher 生成回复 →
    /// 适配器出站。锁定私聊目标为 chatId（oc_）时 receive_id_type=chat_id——
    /// 桌面 SDK 按 oc_ 前缀自动识别，自研 REST 客户端没有识别，必须由计划显式对齐。
    /// </summary>
    private static async Task CheckDispatcherIntegrationAsync(Action<string, bool, string> check)
    {
        var dir = NewTempDir("feishu-dispatcher");
        try
        {
            var store = new ChannelStore(Path.Combine(dir, "channels.db"));
            var eventStore = new EventStore(Path.Combine(dir, "events.db"));
            var writer = new ServerEventWriter(eventStore);
            var handler = new FakeFeishuHandler();
            using var api = new FeishuApiClient("cli_test_app", "secret_test", handler);
            var adapter = new FeishuAdapter(
                new ChannelOptions
                {
                    FeishuAppId = "cli_test_app",
                    FeishuAppSecret = "secret_test",
                    FeishuVerificationToken = FixtureToken,
                },
                store,
                api,
                new FeishuMediaTranscoder("__missing_ffmpeg__", runner: UnavailableRunner),
                Path.Combine(dir, "media"),
                NullLogger<FeishuAdapter>.Instance);
            var manager = new ChannelManager(NullLogger<ChannelManager>.Instance);
            manager.Register(adapter);
            var delivery = new ChannelDeliveryService(
                manager, NullLogger<ChannelDeliveryService>.Instance, TimeSpan.Zero);
            var dispatcher = new ChannelDispatcher(
                store, writer, new FakeDialogEngine(), delivery, NullLogger<ChannelDispatcher>.Instance);
            adapter.OnMessage = dispatcher.HandleIncomingAsync;

            using var document = JsonDocument.Parse(
                """
                {"header":{"event_id":"evt-dispatch-1","event_type":"im.message.receive_v1","create_time":"1787889600000"},
                 "event":{"sender":{"sender_id":{"open_id":"ou_user_1"}},
                 "message":{"message_id":"om_dispatch_1","chat_id":"oc_chat_1","chat_type":"p2p","message_type":"text","content":"{\"text\":\"你好\"}","timestamp":1787889600000}}}
                """);
            var result = await adapter.HandleEventAsync(document.RootElement);
            var sent = handler.Messages.FirstOrDefault();
            check("dispatcher→adapter: 私聊 oc_ 目标 receive_id_type=chat_id",
                result.Outgoing is not null && result.Outgoing.TargetId == "oc_chat_1"
                && handler.Messages.Count == 1
                && sent.Query.Contains("receive_id_type=chat_id", StringComparison.Ordinal)
                && MessageField(sent.Body, "receive_id") == "oc_chat_1"
                && MessageContent(sent.Body).Contains("飞书回复", StringComparison.Ordinal),
                $"{sent.Query} {sent.Body}");
            var receipts = await store.ListReceiptsAsync(ChannelIds.Feishu);
            check("dispatcher→adapter: delivered 回执",
                receipts.Count == 1 && receipts[0].Status == ChannelStore.StatusDelivered,
                JsonSerializer.Serialize(receipts));
        }
        finally
        {
            CleanupTempDir(dir);
        }
    }

    // ── 测试替身 ─────────────────────────────────────────────────────────────

    private static FeishuAdapter BuildAdapter(
        string tempDir, FeishuApiClient api, FeishuMediaTranscoder? transcoder = null, ChannelOptions? options = null)
    {
        var effective = options ?? new ChannelOptions
        {
            FeishuAppId = "cli_test_app",
            FeishuAppSecret = "secret_test",
            FeishuVerificationToken = FixtureToken,
        };
        return new FeishuAdapter(
            effective,
            new ChannelStore(Path.Combine(tempDir, $"channels-{Guid.NewGuid():N}.db")),
            api,
            transcoder ?? new FeishuMediaTranscoder("__missing_ffmpeg__", runner: UnavailableRunner),
            Path.Combine(tempDir, "media"),
            NullLogger<FeishuAdapter>.Instance);
    }

    private static OutgoingMessage AudioMessage(string filePath) => new()
    {
        Channel = ChannelIds.Feishu,
        TargetId = "oc_user_1",
        Parts = [new OutgoingPart { Kind = OutgoingPartKinds.Audio, FilePath = filePath, Mime = "audio/mpeg" }],
    };

    private static Task<FeishuProcessResult> UnavailableRunner(
        string executable, IReadOnlyList<string> arguments, TimeSpan timeout, CancellationToken cancellationToken) =>
        throw new FeishuTranscodeException(FeishuMediaTranscoder.ErrorUnavailable, "mock: ffmpeg 不存在");

    /// <summary>mock ffmpeg：-version 返回 0；转码时把 OggS 头写到输出路径（末参数）。</summary>
    private static Task<FeishuProcessResult> MockFfmpegRunner(
        string executable, IReadOnlyList<string> arguments, TimeSpan timeout, CancellationToken cancellationToken)
    {
        if (arguments.Contains("-version")) return Task.FromResult(new FeishuProcessResult(0, ""));
        var output = arguments[^1];
        File.WriteAllBytes(output, Encoding.ASCII.GetBytes("OggS\x00\x02mock-opus-payload"));
        return Task.FromResult(new FeishuProcessResult(0, ""));
    }

    private sealed class FakeFeishuHandler : HttpMessageHandler
    {
        public int TokenCalls;
        public List<(string Query, string Body)> Messages { get; } = [];
        public int ImageUploads;
        public List<(string FileType, string FileName)> FileUploads { get; } = [];
        public List<string> ResourceQueries { get; } = [];
        public byte[] ResourceBytes { get; set; } = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
        public bool SendError;
        public int? ForceHttpStatus;

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var uri = request.RequestUri!;
            var path = uri.AbsolutePath;
            if (path.EndsWith("/auth/v3/tenant_access_token/internal", StringComparison.Ordinal))
            {
                Interlocked.Increment(ref TokenCalls);
                await Task.Delay(5, cancellationToken);
                return Json("""{"code":0,"msg":"ok","tenant_access_token":"t-1","expire":7200}""");
            }
            if (path.EndsWith("/im/v1/messages", StringComparison.Ordinal))
            {
                var body = await request.Content!.ReadAsStringAsync(cancellationToken);
                Messages.Add((uri.Query, body));
                if (ForceHttpStatus is int status)
                {
                    return new HttpResponseMessage((HttpStatusCode)status)
                    {
                        Content = new StringContent("""{"code":123,"msg":"http error"}""", Encoding.UTF8, "application/json"),
                    };
                }
                return SendError
                    ? Json("""{"code":99991663,"msg":"tenant token invalid"}""")
                    : Json("""{"code":0,"msg":"success","data":{"message_id":"om_sent_1"}}""");
            }
            if (path.EndsWith("/im/v1/images", StringComparison.Ordinal))
            {
                ImageUploads++;
                return Json("""{"code":0,"msg":"success","data":{"image_key":"img_key_1"}}""");
            }
            if (path.EndsWith("/im/v1/files", StringComparison.Ordinal))
            {
                var fileType = "";
                var fileName = "";
                if (request.Content is MultipartFormDataContent form)
                {
                    foreach (var part in form)
                    {
                        var name = part.Headers.ContentDisposition?.Name?.Trim('"');
                        if (name == "file_type") fileType = await part.ReadAsStringAsync(cancellationToken);
                        else if (name == "file_name") fileName = await part.ReadAsStringAsync(cancellationToken);
                    }
                }
                FileUploads.Add((fileType, fileName));
                return Json("""{"code":0,"msg":"success","data":{"file_key":"file_key_1"}}""");
            }
            if (path.Contains("/resources/", StringComparison.Ordinal))
            {
                ResourceQueries.Add(uri.Query);
                return new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(ResourceBytes) };
            }
            return new HttpResponseMessage(HttpStatusCode.NotFound)
            {
                Content = new StringContent("{}", Encoding.UTF8, "application/json"),
            };
        }

        private static HttpResponseMessage Json(string body) =>
            new(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
    }

    private sealed class FixedTimeProvider : TimeProvider
    {
        private readonly DateTimeOffset _now;

        public FixedTimeProvider(DateTimeOffset now)
        {
            _now = now;
        }

        public override DateTimeOffset GetUtcNow() => _now;
    }

    /// <summary>固定回复的 DialogEngine（dispatcher 集成链路用）。</summary>
    private sealed class FakeDialogEngine : IDialogEngine
    {
        public Task<GeneratedReply?> GenerateAsync(string sessionId, CancellationToken cancellationToken = default)
        {
            const string anchor = "anchor-feishu-1";
            return Task.FromResult<GeneratedReply?>(new GeneratedReply(
                "飞书回复", anchor,
                ChannelSessionId.MakeAssistantEventId(sessionId, anchor),
                "turn-feishu-1"));
        }
    }

    // ── 辅助 ─────────────────────────────────────────────────────────────────

    private static string MessageField(string? body, string field)
    {
        if (body is null) return "";
        using var document = JsonDocument.Parse(body);
        return document.RootElement.TryGetProperty(field, out var value) ? value.GetString() ?? "" : "";
    }

    private static string MessageContent(string? body)
    {
        if (body is null) return "";
        using var document = JsonDocument.Parse(body);
        return document.RootElement.TryGetProperty("content", out var value) ? value.GetString() ?? "" : "";
    }

    private static string? OptionalString(JsonElement parent, string name) =>
        parent.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    /// <summary>expect 子集匹配（textContains 为子串断言；其余键存在即须相等）。</summary>
    private static bool MatchSubset(JsonElement actual, JsonElement expected, out string detail)
    {
        foreach (var property in expected.EnumerateObject())
        {
            if (property.Name == "textContains")
            {
                var text = actual.TryGetProperty("text", out var textElement) && textElement.ValueKind == JsonValueKind.String
                    ? textElement.GetString() ?? ""
                    : "";
                if (!text.Contains(property.Value.GetString() ?? "", StringComparison.Ordinal))
                {
                    detail = $"text 不含 {property.Value.GetString()}";
                    return false;
                }
                continue;
            }
            if (!actual.TryGetProperty(property.Name, out var actualValue))
            {
                detail = $"缺键 {property.Name}";
                return false;
            }
            if (actualValue.GetRawText() != property.Value.GetRawText())
            {
                detail = $"{property.Name} got={actualValue.GetRawText()} want={property.Value.GetRawText()}";
                return false;
            }
        }
        detail = "";
        return true;
    }

    private static string? ResolveFixtureDir(string name)
    {
        var candidates = new List<string>
        {
            Path.Combine(Directory.GetCurrentDirectory(), "fixtures", "channels", name),
        };
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        for (var depth = 0; depth < 8 && dir is not null; depth++, dir = dir.Parent)
        {
            candidates.Add(Path.Combine(dir.FullName, "fixtures", "channels", name));
        }
        return candidates.FirstOrDefault(Directory.Exists);
    }

    /// <summary>1 秒 16kHz 单声道 16bit 静音 WAV（真机 ffmpeg 转码输入）。</summary>
    private static void WriteSilentWav(string path, double seconds)
    {
        const int sampleRate = 16000;
        var sampleCount = (int)(sampleRate * seconds);
        var dataSize = sampleCount * 2;
        using var stream = File.Create(path);
        using var writer = new BinaryWriter(stream, Encoding.ASCII, leaveOpen: false);
        writer.Write(Encoding.ASCII.GetBytes("RIFF"));
        writer.Write(36 + dataSize);
        writer.Write(Encoding.ASCII.GetBytes("WAVE"));
        writer.Write(Encoding.ASCII.GetBytes("fmt "));
        writer.Write(16);
        writer.Write((short)1);
        writer.Write((short)1);
        writer.Write(sampleRate);
        writer.Write(sampleRate * 2);
        writer.Write((short)2);
        writer.Write((short)16);
        writer.Write(Encoding.ASCII.GetBytes("data"));
        writer.Write(dataSize);
        writer.Write(new byte[dataSize]);
    }

    private static string NewTempDir(string label) =>
        Directory.CreateDirectory(
            Path.Combine(Path.GetTempPath(), $"cyrene-channel-selftest-{label}-{Guid.NewGuid():N}")).FullName;

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

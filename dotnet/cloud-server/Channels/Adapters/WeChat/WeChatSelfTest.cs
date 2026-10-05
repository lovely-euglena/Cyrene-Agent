using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using CyreneCloud.Storage;
using CyreneNative.Channels;
using CyreneNative.Channels.Normalizers;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

namespace CyreneCloud.Channels.Adapters.WeChat;

/// <summary>
/// 微信 iLink 试点自测（设计 §8.3）：mock iLink HTTP（getupdates/sendmessage/getuploadurl/CDN/
/// get_bot_qrcode/get_qrcode_status）覆盖 文本收发 / 图片上下行 / CDN 加解密 / 大小上限拒绝 /
/// 断线重连退避 / Stop 打断在途 / ret=-14 / QR 状态机与凭据落库 / SILK 占位降级。
/// 无网络、无真机（真机扫码豁免见设计 §1.3）。
/// </summary>
internal static class WeChatSelfTest
{
    public static async Task<int> RunAsync()
    {
        var failures = 0;
        void Check(string name, bool ok, string? detail = "")
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

        await CheckProtocolClientAsync(Check);
        await CheckCdnAsync(Check);
        await CheckAdapterTextAsync(Check);
        await CheckAdapterStartRaceAsync(Check);
        await CheckAdapterMediaAsync(Check);
        await CheckReconnectAsync(Check);
        await CheckQrLoginAsync(Check);
        CheckRegistration(Check);

        Console.WriteLine(failures == 0
            ? "SELFTEST channel wechat: ALL PASS"
            : $"SELFTEST channel wechat: {failures} FAILURES");
        return failures;
    }

    private delegate void CheckFn(string name, bool ok, string? detail = "");

    // ── 1. 协议客户端（getupdates/sendmessage/getuploadurl/ret 语义/请求头）────────

    private static async Task CheckProtocolClientAsync(CheckFn check)
    {
        var handler = new MockILinkHandler();
        handler.GetUpdates.Enqueue(new MockResponse("""
            {"msgs":[
              {"message_id":1001,"from_user_id":"wx-user-1","to_user_id":"bot-1","message_type":1,
               "context_token":"ctx-1","create_time_ms":1787889600000,
               "item_list":[{"type":1,"text_item":{"text":"你好"}},{"type":1,"text_item":{"text":"呀"}}]},
              {"message_id":1002,"from_user_id":"bot-1","to_user_id":"wx-user-1","message_type":2,
               "context_token":"","item_list":[{"type":1,"text_item":{"text":"bot echo"}}]}
            ],"get_updates_buf":"buf-2"}
            """));
        using var http = NewHttp(handler);
        var client = NewClient(http);

        var updates = await client.GetUpdatesAsync("buf-1");
        check("协议: getupdates 游标回传 + message_type 过滤 + 多 text_item 拼接",
            updates.Buf == "buf-2" && updates.Messages.Count == 1
            && updates.Messages[0] is { FromUserId: "wx-user-1", ContextToken: "ctx-1", Content: "你好呀" },
            JsonSerializer.Serialize(updates.Messages.Select(item => item.Content)));

        var getUpdatesRequest = handler.Requests.First(request => request.Path == "/ilink/bot/getupdates");
        check("协议: 请求头 AuthorizationType/Authorization/X-WECHAT-UIN",
            getUpdatesRequest.AuthType == "ilink_bot_token" && getUpdatesRequest.Auth == "Bearer bot-token-1"
            && getUpdatesRequest.Uin == "dGVzdC11aW4=",
            JsonSerializer.Serialize(getUpdatesRequest));
        check("协议: getupdates body（get_updates_buf + base_info.channel_version）",
            getUpdatesRequest.Body is not null
            && getUpdatesRequest.Body.Contains("\"get_updates_buf\":\"buf-1\"")
            && getUpdatesRequest.Body.Contains("\"channel_version\":\"2.0.0\""),
            getUpdatesRequest.Body);

        // ret 显式非 0 → 错误；ret=-14 → 会话过期；ret 缺省视为成功
        handler.GetUpdates.Enqueue(new MockResponse("""{"ret":-1,"errmsg":"boom"}"""));
        var explicitError = false;
        try
        {
            await client.GetUpdatesAsync("");
        }
        catch (ILinkProtocolException)
        {
            explicitError = true;
        }
        check("协议: getupdates 显式非 0 ret 报错", explicitError);

        handler.GetUpdates.Enqueue(new MockResponse("""{"ret":-14}"""));
        var expired = false;
        try
        {
            await client.GetUpdatesAsync("");
        }
        catch (ILinkSessionExpiredException)
        {
            expired = true;
        }
        check("协议: getupdates ret=-14 → 会话过期", expired);

        handler.GetUpdates.Enqueue(new MockResponse("""{"msgs":[]}"""));
        var empty = await client.GetUpdatesAsync("");
        check("协议: getupdates 无 ret/无 buf 视为成功", empty.Messages.Count == 0 && empty.Buf == "");

        // sendmessage
        var sent = await client.SendTextAsync("wx-user-1", "回复", "ctx-1");
        check("协议: sendmessage 成功（ret 缺省）", sent.Ok, sent.Error);
        handler.SendMessageResponse = """{"ret":-2,"errmsg":"nope"}""";
        var rejected = await client.SendTextAsync("wx-user-1", "回复", "ctx-1");
        check("协议: sendmessage 非 0 ret 归一失败", !rejected.Ok && rejected.Error == "nope", rejected.Error);
        handler.SendMessageResponse = """{"ret":-14}""";
        var sendExpired = false;
        try
        {
            await client.SendTextAsync("wx-user-1", "回复", "ctx-1");
        }
        catch (ILinkSessionExpiredException)
        {
            sendExpired = true;
        }
        check("协议: sendmessage ret=-14 抛会话过期", sendExpired);

        // getuploadurl
        var upload = await client.GetUploadUrlAsync(new ILinkGetUploadUrlRequest
        {
            FileKey = "fk-1",
            MediaType = WeChatMediaTypes.Image,
            ToUserId = "wx-user-1",
            RawSize = 5,
            RawFileMd5 = "5d41402abc4b2a76b9719d911017c592",
            FileSize = 16,
            NoNeedThumb = true,
            AesKey = "00112233445566778899aabbccddeeff",
        });
        check("协议: getuploadurl 字段解析", upload.UploadFullUrl == "https://mock.cdn.test/c2c/upload/full", upload.UploadFullUrl);
        handler.UploadUrlResponse = """{"ret":-1,"errmsg":"upload denied"}""";
        var uploadError = false;
        try
        {
            await client.GetUploadUrlAsync(new ILinkGetUploadUrlRequest
            {
                FileKey = "fk-1", MediaType = 1, ToUserId = "u", RawSize = 1,
                RawFileMd5 = "x", FileSize = 1,
            });
        }
        catch (ILinkProtocolException)
        {
            uploadError = true;
        }
        check("协议: getuploadurl 非 0 ret 报错", uploadError);

        // Dispose：注入的 HttpClient 归调用方所有，客户端 Dispose 幂等且不释放注入连接
        handler.SendMessageResponse = """{"ret":0}""";
        client.Dispose();
        client.Dispose();
        var afterDispose = await client.SendTextAsync("wx-user-1", "dispose 后仍可用", "ctx-1");
        check("协议: Dispose 仅释放自建 HttpClient（注入连接保留 + 幂等）", afterDispose.Ok, afterDispose.Error);

        // P2-8：ILinkLoginClient（QR 轮询）同样的 Dispose 所有权口径——注入连接保留 + 幂等
        var loginHandler = new MockILinkHandler();
        using var loginHttp = NewHttp(loginHandler);
        var loginClient = new ILinkLoginClient(loginHttp, "https://mock.ilink.test", () => "dGVzdC11aW4=");
        loginClient.Dispose();
        loginClient.Dispose();
        var qr = await loginClient.FetchQrCodeAsync();
        check("协议: LoginClient Dispose 仅释放自建 HttpClient（注入连接保留 + 幂等）",
            qr.Qrcode == "qr-ticket-1" && qr.QrcodeImgContent == "https://liteapp.weixin.qq.com/q/mock",
            JsonSerializer.Serialize(qr));
    }

    // ── 2. CDN（AES 密钥格式/加解密/上传/下载/超限）────────────────────────────

    private static async Task CheckCdnAsync(CheckFn check)
    {
        var keyHex = "00112233445566778899aabbccddeeff";
        var key = Convert.FromHexString(keyHex);
        var keyBase64Hex = Convert.ToBase64String(Encoding.UTF8.GetBytes(keyHex));
        check("CDN: aes_key hex/base64/双层 hex 三种格式",
            WeChatCdnClient.DecodeAesKey(keyHex).SequenceEqual(key)
            && WeChatCdnClient.DecodeAesKey(keyBase64Hex).SequenceEqual(key)
            && WeChatCdnClient.DecodeAesKey(Convert.ToBase64String(key)).SequenceEqual(key));

        var plain = Encoding.UTF8.GetBytes("hello image");
        var encrypted = WeChatCdnClient.EncryptEcb(plain, key);
        check("CDN: AES-128-ECB 加解密往返",
            encrypted.Length == 16 && WeChatCdnClient.DecryptEcb(encrypted, key).SequenceEqual(plain));

        var handler = new MockILinkHandler { DownloadBody = encrypted };
        using var http = NewHttp(handler);
        var cdn = new WeChatCdnClient(http);
        var downloaded = await cdn.DownloadAsync(new WeChatCdnMedia
        {
            EncryptQueryParam = "download-param",
            AesKey = keyBase64Hex,
            EncryptType = 1,
        }, 10 * 1024 * 1024);
        check("CDN: 下载 URL + 解密（base64 双层 hex 密钥）",
            downloaded.SequenceEqual(plain)
            && handler.Requests.Any(request => request.Path == "/c2c/download"),
            Convert.ToBase64String(downloaded));

        var rawDownload = await cdn.DownloadAsync(new WeChatCdnMedia
        {
            EncryptQueryParam = "download-param",
            AesKey = keyHex,
            EncryptType = 0,
        }, 10 * 1024 * 1024);
        check("CDN: encrypt_type=0 不解密", rawDownload.SequenceEqual(encrypted));

        handler.DownloadBody = new byte[11 * 1024 * 1024];
        var tooLarge = false;
        try
        {
            await cdn.DownloadAsync(new WeChatCdnMedia
            {
                EncryptQueryParam = "download-param",
                AesKey = keyHex,
                EncryptType = 1,
            }, 10 * 1024 * 1024);
        }
        catch (WeChatMediaTooLargeException)
        {
            tooLarge = true;
        }
        check("CDN: 下载超限（>10MB）拒绝", tooLarge);

        // 上传：确定性 aesKey/fileKey，断言 getuploadurl 字段与加密 body
        var uploadHandler = new MockILinkHandler();
        using var uploadHttp = NewHttp(uploadHandler);
        var uploadClient = NewClient(uploadHttp);
        var uploadCdn = new WeChatCdnClient(uploadHttp);
        var uploadData = Encoding.UTF8.GetBytes("hello");
        var uploadResult = await uploadCdn.UploadAsync(
            uploadClient, "wx-user-1", uploadData, WeChatMediaTypes.Image, default, key, "file-key-1");
        var uploadRequest = uploadHandler.UploadRequests.Single();
        check("CDN: 上传 getuploadurl 字段（md5/size/aeskey/no_need_thumb）",
            uploadRequest.GetProperty("filekey").GetString() == "file-key-1"
            && uploadRequest.GetProperty("media_type").GetInt32() == 1
            && uploadRequest.GetProperty("to_user_id").GetString() == "wx-user-1"
            && uploadRequest.GetProperty("rawsize").GetInt64() == 5
            && uploadRequest.GetProperty("rawfilemd5").GetString() == "5d41402abc4b2a76b9719d911017c592"
            && uploadRequest.GetProperty("filesize").GetInt64() == 16
            && uploadRequest.GetProperty("no_need_thumb").GetBoolean()
            && uploadRequest.GetProperty("aeskey").GetString() == keyHex,
            uploadRequest.GetRawText());
        check("CDN: 上传 body 加密 + x-encrypted-param 回填",
            uploadHandler.UploadBodies.Count == 1
            && WeChatCdnClient.DecryptEcb(uploadHandler.UploadBodies[0], key).SequenceEqual(uploadData)
            && uploadResult.EncryptQueryParam == "encrypted-param"
            && uploadResult.EncryptType == 1
            && uploadResult.AesKey == WeChatCdnClient.EncodeAesKeyBase64(key),
            JsonSerializer.Serialize(uploadResult));

        uploadHandler.UploadEncryptedParam = null;
        var missingHeader = false;
        try
        {
            await uploadCdn.UploadAsync(uploadClient, "wx-user-1", uploadData, WeChatMediaTypes.Image, default, key, "fk-2");
        }
        catch (WeChatCdnException)
        {
            missingHeader = true;
        }
        check("CDN: 缺 x-encrypted-param 报错", missingHeader);

        // 传输挂起 → linked CTS 超时打断（不无限期阻塞长轮询；测试注入 50ms）
        var hangHandler = new MockILinkHandler
        {
            Override = async (request, cancellationToken) =>
            {
                if (request.RequestUri!.AbsolutePath == "/c2c/download")
                {
                    await Task.Delay(Timeout.Infinite, cancellationToken);
                }
                return MockILinkHandler.Json("{}");
            },
        };
        using var hangHttp = NewHttp(hangHandler);
        var hangCdn = new WeChatCdnClient(hangHttp, transferTimeout: TimeSpan.FromMilliseconds(50));
        var downloadTimeout = false;
        try
        {
            await hangCdn.DownloadAsync(new WeChatCdnMedia
            {
                EncryptQueryParam = "download-param",
                AesKey = keyHex,
                EncryptType = 1,
            }, 10 * 1024 * 1024);
        }
        catch (WeChatCdnException ex)
        {
            downloadTimeout = ex.Message.Contains("超时");
        }
        check("CDN: 下载挂起 50ms 超时打断", downloadTimeout);

        var hangUploadHandler = new MockILinkHandler
        {
            Override = async (request, cancellationToken) =>
            {
                if (request.RequestUri!.AbsolutePath.StartsWith("/c2c/upload", StringComparison.Ordinal))
                {
                    await Task.Delay(Timeout.Infinite, cancellationToken);
                }
                return MockILinkHandler.Json("""{"upload_full_url":"https://mock.cdn.test/c2c/upload/full"}""");
            },
        };
        using var hangUploadHttp = NewHttp(hangUploadHandler);
        var hangUploadCdn = new WeChatCdnClient(hangUploadHttp, transferTimeout: TimeSpan.FromMilliseconds(50));
        var hangUploadClient = NewClient(hangUploadHttp);
        var uploadTimeout = false;
        try
        {
            await hangUploadCdn.UploadAsync(
                hangUploadClient, "wx-user-1", uploadData, WeChatMediaTypes.Image, default, key, "fk-timeout");
        }
        catch (WeChatCdnException ex)
        {
            uploadTimeout = ex.Message.Contains("超时");
        }
        check("CDN: 上传挂起 50ms 超时打断", uploadTimeout);
    }

    // ── 3. 适配器：文本收发 / contextToken 回传 / 事件占位 ───────────────────────

    private static async Task CheckAdapterTextAsync(CheckFn check)
    {
        var dir = NewTempDir("wechat-text");
        try
        {
            var (options, store, media, handler, http) = await NewEnvironmentAsync(dir);
            handler.GetUpdates.Enqueue(new MockResponse("""
                {"msgs":[{"message_id":2001,"from_user_id":"wx-user-1","to_user_id":"bot-1","message_type":1,
                 "context_token":"ctx-2001","create_time_ms":1787889600000,
                 "item_list":[{"type":1,"text_item":{"text":"你好"}}]}],"get_updates_buf":"buf-1"}
                """));
            var adapter = NewAdapter(options, store, media, handler, http);
            var received = new TaskCompletionSource<IncomingMessage>(TaskCreationOptions.RunContinuationsAsynchronously);
            adapter.OnMessage = (message, _) =>
            {
                received.TrySetResult(message);
                return Task.FromResult<OutgoingMessage?>(null);
            };

            await adapter.StartAsync();
            var status = adapter.GetStatus();
            check("适配器: 启动 running + botId + voice:false",
                status.Phase == ChannelPhases.Running
                && status.Detail?.GetProperty("botId").GetString() == "bot-1"
                && status.Detail?.GetProperty("voice").GetBoolean() == false,
                JsonSerializer.Serialize(status));

            var incoming = await WaitAsync(received.Task, TimeSpan.FromSeconds(5));
            check("适配器: 文本入站归一化（sender/chat/messageId/at）",
                incoming is { Text: "你好", SenderId: "wx-user-1", ChatId: "wx-user-1", MessageId: "2001" }
                && incoming.At == DateTimeOffset.FromUnixTimeMilliseconds(1787889600000),
                JsonSerializer.Serialize(incoming, ChannelJson.Options));
            check("适配器: get_updates_buf 轮转（下一轮带 buf-1）",
                await WaitUntilAsync(() => handler.GetUpdatesBufs.Contains("buf-1"), TimeSpan.FromSeconds(3)),
                string.Join(",", handler.GetUpdatesBufs));

            var sent = await adapter.SendAsync(new OutgoingMessage
            {
                Channel = ChannelIds.WeChat,
                TargetId = "wx-user-1",
                ReplyContext = new OutgoingReplyContext { MessageId = "2001" },
                Parts = [new OutgoingPart { Kind = OutgoingPartKinds.Text, Text = " 回复 " }],
            });
            var body = handler.SentMessages.Single();
            var message = body.GetProperty("msg");
            var clientId = message.GetProperty("client_id").GetString() ?? "";
            check("适配器: 出站文本 contextToken 原样回传 + sendmessage 字段",
                sent.Ok
                && message.GetProperty("from_user_id").GetString() == ""
                && message.GetProperty("to_user_id").GetString() == "wx-user-1"
                && message.GetProperty("message_type").GetInt32() == 2
                && message.GetProperty("message_state").GetInt32() == 2
                && message.GetProperty("context_token").GetString() == "ctx-2001"
                && message.GetProperty("item_list")[0].GetProperty("text_item").GetProperty("text").GetString() == "回复"
                && body.GetProperty("base_info").GetProperty("channel_version").GetString() == "2.0.0",
                body.GetRawText());
            check("适配器: client_id 为 UUID", Guid.TryParse(clientId, out _), clientId);

            // 超 maxTextLength（2048）→ 按桌面 splitTextBySentenceBreaks 分片（§2.5）
            var beforeSplit = handler.SentMessages.Count;
            var longText = string.Concat(Enumerable.Repeat("这是一句话。", 500));
            var splitResult = await adapter.SendAsync(new OutgoingMessage
            {
                Channel = ChannelIds.WeChat,
                TargetId = "wx-user-1",
                Parts = [new OutgoingPart { Kind = OutgoingPartKinds.Text, Text = longText }],
            });
            var splitMessages = handler.SentMessages.Skip(beforeSplit).ToList();
            var splitText = string.Concat(splitMessages.Select(item => item
                .GetProperty("msg").GetProperty("item_list")[0].GetProperty("text_item").GetProperty("text").GetString()));
            check("适配器: 超长文本按句分片发送",
                splitResult.Ok && longText.Length > 2048 && splitMessages.Count == 10 && splitText == longText,
                $"count={splitMessages.Count}");

            var missingContext = await adapter.SendAsync(new OutgoingMessage
            {
                Channel = ChannelIds.WeChat,
                TargetId = "wx-unknown",
                Parts = [new OutgoingPart { Kind = OutgoingPartKinds.Text, Text = "hi" }],
            });
            check("适配器: 缺 context_token 拒绝回复",
                !missingContext.Ok && missingContext.Error?.Contains("context_token") == true, missingContext.Error);

            // P2-8：_replyContextByTarget 有界（cap=3，超限按最久未更新 LRU 淘汰）
            adapter.ReplyContextLimit = 3;
            var dispatchClient = NewClient(http);
            for (var i = 0; i < 6; i++)
            {
                var sender = $"wx-cap-{i}";
                await adapter.DispatchInboundAsync(dispatchClient, new WeixinMessage
                {
                    MsgId = $"cap-{i}",
                    FromUserId = sender,
                    ToUserId = "bot-1",
                    MsgType = 1,
                    Content = "hi",
                    Items = default,
                    ContextToken = $"ctx-cap-{i}",
                    Raw = JsonSerializer.SerializeToElement(new
                    {
                        message_id = $"cap-{i}",
                        from_user_id = sender,
                        to_user_id = "bot-1",
                        message_type = 1,
                        context_token = $"ctx-cap-{i}",
                        item_list = new[] { new { type = 1, text_item = new { text = "hi" } } },
                    }),
                }, CancellationToken.None);
            }
            check("适配器: replyContext 上限淘汰（cap=3，有界）", adapter.ReplyContextCount == 3,
                $"count={adapter.ReplyContextCount}");
            var evicted = await adapter.SendAsync(new OutgoingMessage
            {
                Channel = ChannelIds.WeChat,
                TargetId = "wx-cap-0",
                Parts = [new OutgoingPart { Kind = OutgoingPartKinds.Text, Text = "hi" }],
            });
            var retained = await adapter.SendAsync(new OutgoingMessage
            {
                Channel = ChannelIds.WeChat,
                TargetId = "wx-cap-5",
                Parts = [new OutgoingPart { Kind = OutgoingPartKinds.Text, Text = "hi" }],
            });
            check("适配器: LRU 淘汰最久未更新，最新 target 仍可回复",
                !evicted.Ok && evicted.Error?.Contains("context_token") == true && retained.Ok,
                $"evicted={evicted.Error} retained={retained.Ok}");

            await adapter.StopAsync();
            check("适配器: Stop 后 offline", adapter.GetStatus().Phase == ChannelPhases.Offline);
        }
        finally
        {
            CleanupTempDir(dir);
        }
    }

    // ── 3b. 并发 Start 竞态：后到客户端走丢弃路径并释放（P2-8）────────────────────

    private static async Task CheckAdapterStartRaceAsync(CheckFn check)
    {
        var dir = NewTempDir("wechat-start-race");
        try
        {
            var (options, store, media, handler, http) = await NewEnvironmentAsync(dir, suffix: "race");
            var clients = new List<TrackingProtocolClient>();
            using var barrier = new Barrier(2);
            var adapter = new ILinkBotAdapter(
                options,
                store,
                media,
                new WeChatCdnClient(http),
                new SilkUnavailableCodec(),
                NullLogger<ILinkBotAdapter>.Instance,
                credentials =>
                {
                    var client = new TrackingProtocolClient(credentials, http);
                    lock (clients) clients.Add(client);
                    // 两路并发 Start 都进入工厂后再放行：强制后到者命中「_client 已存在」丢弃路径
                    barrier.SignalAndWait(TimeSpan.FromSeconds(5));
                    return client;
                },
                TimeSpan.FromMilliseconds(10));
            adapter.OnMessage = (_, _) => Task.FromResult<OutgoingMessage?>(null);

            // Task.Run 强制两路真并发：否则第一次 Start 可能同步跑完，第二次直接命中幂等分支
            await Task.WhenAll(
                Task.Run(() => adapter.StartAsync()),
                Task.Run(() => adapter.StartAsync()));
            var discarded = clients.Count(client => client.Disposed);
            check("适配器: 并发 Start 竞态仅一路生效，另一路客户端被释放（P2-8）",
                clients.Count == 2 && discarded == 1 && adapter.GetStatus().Phase == ChannelPhases.Running,
                $"clients={clients.Count} disposed={discarded} phase={adapter.GetStatus().Phase}");
            await adapter.StopAsync();
        }
        finally
        {
            CleanupTempDir(dir);
        }
    }

    // ── 4. 适配器：图片上下行 / 文件 / 超限 / 语音降级 ────────────────────────────

    private static async Task CheckAdapterMediaAsync(CheckFn check)
    {
        var dir = NewTempDir("wechat-media");
        try
        {
            var (options, store, media, handler, http) = await NewEnvironmentAsync(dir);
            var keyHex = "00112233445566778899aabbccddeeff";
            var key = Convert.FromHexString(keyHex);
            var keyBase64Hex = Convert.ToBase64String(Encoding.UTF8.GetBytes(keyHex));
            var imageBytes = Encoding.UTF8.GetBytes("fake-image-bytes");
            handler.DownloadBody = WeChatCdnClient.EncryptEcb(imageBytes, key);
            handler.GetUpdates.Enqueue(new MockResponse($$$$"""
                {"msgs":[{"message_id":3001,"from_user_id":"wx-user-1","to_user_id":"bot-1","message_type":1,
                 "context_token":"ctx-3001","create_time_ms":1787889600000,
                 "item_list":[{"type":2,"image_item":{"file_name":"pic.png","media":
                   {"encrypt_query_param":"download-param","aes_key":"{{{{keyBase64Hex}}}}","encrypt_type":1}}}]}],
                 "get_updates_buf":"buf-img"}
                """));
            var adapter = NewAdapter(options, store, media, handler, http);
            var received = new TaskCompletionSource<IncomingMessage>(TaskCreationOptions.RunContinuationsAsynchronously);
            adapter.OnMessage = (message, _) =>
            {
                received.TrySetResult(message);
                return Task.FromResult<OutgoingMessage?>(null);
            };
            await adapter.StartAsync();

            var incoming = await WaitAsync(received.Task, TimeSpan.FromSeconds(5));
            var attachment = incoming.Attachments?.Single();
            check("适配器: 图片入站下载落盘 + 附件字段 + [图片] 占位",
                incoming.Text == "[图片]"
                && attachment is { Kind: ChannelAttachmentKinds.Image, Mime: "image/png", Caption: "pic.png" }
                && attachment.FilePath is not null && File.Exists(attachment.FilePath)
                && File.ReadAllBytes(attachment.FilePath).SequenceEqual(imageBytes)
                && Path.GetFileName(attachment.FilePath).StartsWith("wechat-3001-")
                && Path.GetFileName(attachment.FilePath).EndsWith(".png"),
                JsonSerializer.Serialize(incoming, ChannelJson.Options));

            // 可分析文件（PDF）
            var fileBytes = Encoding.UTF8.GetBytes("%PDF-1.4 fake");
            handler.DownloadBody = WeChatCdnClient.EncryptEcb(fileBytes, key);
            var fileReceived = new TaskCompletionSource<IncomingMessage>(TaskCreationOptions.RunContinuationsAsynchronously);
            adapter.OnMessage = (message, _) =>
            {
                fileReceived.TrySetResult(message);
                return Task.FromResult<OutgoingMessage?>(null);
            };
            handler.GetUpdates.Enqueue(new MockResponse($$$$"""
                {"msgs":[{"message_id":3002,"from_user_id":"wx-user-1","to_user_id":"bot-1","message_type":1,
                 "context_token":"ctx-3002","create_time_ms":1787889600001,
                 "item_list":[{"type":4,"file_item":{"file_name":"report.pdf","media":
                   {"encrypt_query_param":"download-param","aes_key":"{{{{keyHex}}}}","encrypt_type":1}}}]}],
                 "get_updates_buf":"buf-file"}
                """));
            var fileIncoming = await WaitAsync(fileReceived.Task, TimeSpan.FromSeconds(5));
            var fileAttachment = fileIncoming.Attachments?.Single();
            check("适配器: 可分析文件入站 + [文件: name] 占位",
                fileIncoming.Text == "[文件: report.pdf]"
                && fileAttachment is { Kind: ChannelAttachmentKinds.File, Mime: "application/pdf" }
                && fileAttachment.FilePath is not null && File.Exists(fileAttachment.FilePath),
                JsonSerializer.Serialize(fileIncoming, ChannelJson.Options));

            // 超限图片（>10MB）→ 拒绝文案，不派发
            handler.DownloadBody = new byte[11 * 1024 * 1024];
            var oversizedDispatched = false;
            adapter.OnMessage = (_, _) =>
            {
                oversizedDispatched = true;
                return Task.FromResult<OutgoingMessage?>(null);
            };
            var sentBefore = handler.SentMessages.Count;
            handler.GetUpdates.Enqueue(new MockResponse($$$$"""
                {"msgs":[{"message_id":3003,"from_user_id":"wx-user-1","to_user_id":"bot-1","message_type":1,
                 "context_token":"ctx-3003","create_time_ms":1787889600002,
                 "item_list":[{"type":2,"image_item":{"file_name":"huge.png","media":
                   {"encrypt_query_param":"download-param","aes_key":"{{{{keyHex}}}}","encrypt_type":1}}}]}],
                 "get_updates_buf":"buf-huge"}
                """));
            check("适配器: 图片超限（>10MB）拒绝并回文案",
                await WaitUntilAsync(() => handler.SentMessages.Count > sentBefore, TimeSpan.FromSeconds(5))
                && handler.SentMessages[^1].GetProperty("msg").GetProperty("item_list")[0]
                    .GetProperty("text_item").GetProperty("text").GetString()!.Contains("太大")
                && !oversizedDispatched,
                handler.SentMessages.Count > sentBefore
                    ? handler.SentMessages[^1].GetRawText()
                    : "no intercept message");

            // 语音（SILK/ASR 阶段 7）→ 桌面同口径文案，不派发
            var voiceDispatched = false;
            adapter.OnMessage = (_, _) =>
            {
                voiceDispatched = true;
                return Task.FromResult<OutgoingMessage?>(null);
            };
            var voiceSentBefore = handler.SentMessages.Count;
            handler.GetUpdates.Enqueue(new MockResponse($$$$"""
                {"msgs":[{"message_id":3004,"from_user_id":"wx-user-1","to_user_id":"bot-1","message_type":1,
                 "context_token":"ctx-3004","create_time_ms":1787889600003,
                 "item_list":[{"type":3,"voice_item":{"sample_rate":16000,"media":
                   {"encrypt_query_param":"download-param","aes_key":"{{{{keyHex}}}}","encrypt_type":1}}}]}],
                 "get_updates_buf":"buf-voice"}
                """));
            check("适配器: 语音入站回「还没有配置语音识别」且不派发",
                await WaitUntilAsync(() => handler.SentMessages.Count > voiceSentBefore, TimeSpan.FromSeconds(5))
                && handler.SentMessages[^1].GetProperty("msg").GetProperty("item_list")[0]
                    .GetProperty("text_item").GetProperty("text").GetString()!.Contains("还没有配置语音识别")
                && !voiceDispatched);

            // 视频 / 不可分析文件 → 文案提示，不派发
            var unsupportedDispatched = false;
            adapter.OnMessage = (_, _) =>
            {
                unsupportedDispatched = true;
                return Task.FromResult<OutgoingMessage?>(null);
            };
            var unsupportedSentBefore = handler.SentMessages.Count;
            handler.GetUpdates.Enqueue(new MockResponse($$$$"""
                {"msgs":[{"message_id":3005,"from_user_id":"wx-user-1","to_user_id":"bot-1","message_type":1,
                 "context_token":"ctx-3005","create_time_ms":1787889600004,
                 "item_list":[{"type":4,"file_item":{"file_name":"archive.zip","media":
                   {"encrypt_query_param":"download-param","aes_key":"{{{{keyHex}}}}","encrypt_type":1}}}]}],
                 "get_updates_buf":"buf-zip"}
                """));
            check("适配器: 不可分析文件回文案且不落盘",
                await WaitUntilAsync(() => handler.SentMessages.Count > unsupportedSentBefore, TimeSpan.FromSeconds(5))
                && handler.SentMessages[^1].GetProperty("msg").GetProperty("item_list")[0]
                    .GetProperty("text_item").GetProperty("text").GetString()!.Contains("分析不了")
                && !unsupportedDispatched);

            // 出站图片：上传 → image_item
            adapter.OnMessage = (_, _) => Task.FromResult<OutgoingMessage?>(null);
            var outImage = Path.Combine(dir, "out-image.bin");
            var outImageBytes = Encoding.UTF8.GetBytes("out-image-bytes");
            await File.WriteAllBytesAsync(outImage, outImageBytes);
            var imageResult = await adapter.SendAsync(new OutgoingMessage
            {
                Channel = ChannelIds.WeChat,
                TargetId = "wx-user-1",
                Parts = [new OutgoingPart { Kind = OutgoingPartKinds.Image, FilePath = outImage }],
            });
            var imageItem = handler.SentMessages[^1].GetProperty("msg").GetProperty("item_list")[0];
            check("适配器: 出站图片上传 CDN → image_item",
                imageResult.Ok
                && imageItem.GetProperty("type").GetInt32() == 2
                && imageItem.GetProperty("image_item").GetProperty("media").GetProperty("encrypt_query_param").GetString()
                    == "encrypted-param",
                handler.SentMessages[^1].GetRawText());

            // 出站文件：file_item.file_name 取 basename
            var outFile = Path.Combine(dir, "report.pdf");
            await File.WriteAllBytesAsync(outFile, Encoding.UTF8.GetBytes("pdf-out"));
            var fileResult = await adapter.SendAsync(new OutgoingMessage
            {
                Channel = ChannelIds.WeChat,
                TargetId = "wx-user-1",
                Parts = [new OutgoingPart { Kind = OutgoingPartKinds.File, FilePath = outFile, Name = "报告.pdf" }],
            });
            var fileItem = handler.SentMessages[^1].GetProperty("msg").GetProperty("item_list")[0];
            check("适配器: 出站文件 file_item",
                fileResult.Ok
                && fileItem.GetProperty("type").GetInt32() == 4
                && fileItem.GetProperty("file_item").GetProperty("file_name").GetString() == "报告.pdf",
                handler.SentMessages[^1].GetRawText());

            // 出站语音：SILK 不可用 → 单独失败；与文本混合时文本成功兜底
            var audioOnly = await adapter.SendAsync(new OutgoingMessage
            {
                Channel = ChannelIds.WeChat,
                TargetId = "wx-user-1",
                Parts = [new OutgoingPart { Kind = OutgoingPartKinds.Audio, FilePath = outFile, Mime = "audio/wav" }],
            });
            check("适配器: 出站语音 SILK 不可用降级失败",
                !audioOnly.Ok && audioOnly.Error?.Contains("语音编码不可用") == true, audioOnly.Error);
            var mixed = await adapter.SendAsync(new OutgoingMessage
            {
                Channel = ChannelIds.WeChat,
                TargetId = "wx-user-1",
                Parts =
                [
                    new OutgoingPart { Kind = OutgoingPartKinds.Text, Text = "文字兜底" },
                    new OutgoingPart { Kind = OutgoingPartKinds.Audio, FilePath = outFile, Mime = "audio/wav" },
                ],
            });
            check("适配器: 语音失败不影响文本成功", mixed.Ok);

            check("适配器: 媒体目录隔离（<dataDir>/media/wechat）",
                media.DirectoryPath.StartsWith(Path.Combine(dir, "media", "wechat"), StringComparison.OrdinalIgnoreCase));

            await adapter.StopAsync();
        }
        finally
        {
            CleanupTempDir(dir);
        }
    }

    // ── 5. 断线重连 / 退避 / Stop 打断 / ret=-14 ────────────────────────────────

    private static async Task CheckReconnectAsync(CheckFn check)
    {
        var dir = NewTempDir("wechat-reconnect");
        try
        {
            // 网络错误退避后恢复
            var (options, store, media, handler, http) = await NewEnvironmentAsync(dir);
            handler.GetUpdates.Enqueue(new MockResponse("", Error: "network down 1"));
            handler.GetUpdates.Enqueue(new MockResponse("", Error: "network down 2"));
            handler.GetUpdates.Enqueue(new MockResponse("""
                {"msgs":[{"message_id":4001,"from_user_id":"wx-user-1","to_user_id":"bot-1","message_type":1,
                 "context_token":"ctx-4001","create_time_ms":1787889600000,
                 "item_list":[{"type":1,"text_item":{"text":"恢复了"}}]}],"get_updates_buf":"buf-ok"}
                """));
            var adapter = NewAdapter(options, store, media, handler, http, reconnectBackoff: TimeSpan.FromMilliseconds(10));
            var received = new TaskCompletionSource<IncomingMessage>(TaskCreationOptions.RunContinuationsAsynchronously);
            adapter.OnMessage = (message, _) =>
            {
                received.TrySetResult(message);
                return Task.FromResult<OutgoingMessage?>(null);
            };
            await adapter.StartAsync();
            var recovered = await WaitAsync(received.Task, TimeSpan.FromSeconds(5));
            check("重连: 连续网络错误退避后恢复并重置状态",
                recovered.Text == "恢复了" && adapter.GetStatus().Phase == ChannelPhases.Running,
                adapter.GetStatus().Message);
            await adapter.StopAsync();

            // 连续 5 次失败 → error 状态但保持重试
            var (options2, store2, media2, handler2, http2) = await NewEnvironmentAsync(dir, suffix: "fail");
            var alwaysFail = true;
            var failCalls = 0;
            handler2.Override = (_, _) =>
            {
                Interlocked.Increment(ref failCalls);
                return alwaysFail
                    ? throw new HttpRequestException("down")
                    : Task.FromResult(MockILinkHandler.Json("""{"msgs":[]}"""));
            };
            var adapter2 = NewAdapter(options2, store2, media2, handler2, http2, reconnectBackoff: TimeSpan.FromMilliseconds(10));
            await adapter2.StartAsync();
            check("重连: 连续失败 5 次状态 error 且继续重试",
                await WaitUntilAsync(() => adapter2.GetStatus().Phase == ChannelPhases.Error, TimeSpan.FromSeconds(5))
                && adapter2.GetStatus().Message?.Contains("正在重试") == true
                && failCalls >= 5,
                $"calls={failCalls} status={adapter2.GetStatus().Phase}");
            alwaysFail = false;
            check("重连: 恢复成功后状态回到 running",
                await WaitUntilAsync(() => adapter2.GetStatus().Phase == ChannelPhases.Running, TimeSpan.FromSeconds(5)),
                adapter2.GetStatus().Phase);
            await adapter2.StopAsync();

            // Stop 打断在途长轮询（不等 40s 自然返回）
            var (options3, store3, media3, handler3, http3) = await NewEnvironmentAsync(dir, suffix: "stop");
            var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            handler3.Override = async (_, cancellationToken) =>
            {
                entered.TrySetResult();
                await Task.Delay(Timeout.Infinite, cancellationToken);
                throw new OperationCanceledException();
            };
            var adapter3 = NewAdapter(options3, store3, media3, handler3, http3, reconnectBackoff: TimeSpan.FromMilliseconds(10));
            await adapter3.StartAsync();
            await WaitAsync(entered.Task, TimeSpan.FromSeconds(3));
            var stopwatch = Stopwatch.StartNew();
            await adapter3.StopAsync();
            stopwatch.Stop();
            check("重连: Stop 打断在途请求（<2s）且状态 offline",
                stopwatch.ElapsedMilliseconds < 2000 && adapter3.GetStatus().Phase == ChannelPhases.Offline,
                $"{stopwatch.ElapsedMilliseconds}ms");

            // ret=-14：状态 error + 不重试
            var (options4, store4, media4, handler4, http4) = await NewEnvironmentAsync(dir, suffix: "expired");
            var expiredCalls = 0;
            handler4.Override = (_, _) =>
            {
                Interlocked.Increment(ref expiredCalls);
                return Task.FromResult(MockILinkHandler.Json("""{"ret":-14}"""));
            };
            var adapter4 = NewAdapter(options4, store4, media4, handler4, http4, reconnectBackoff: TimeSpan.FromMilliseconds(10));
            await adapter4.StartAsync();
            check("重连: ret=-14 状态 error + 会话过期文案",
                await WaitUntilAsync(() => adapter4.GetStatus().Phase == ChannelPhases.Error, TimeSpan.FromSeconds(5))
                && adapter4.GetStatus().Message?.Contains("会话已过期") == true,
                adapter4.GetStatus().Message);
            var callsAfterExpired = expiredCalls;
            await Task.Delay(150);
            check("重连: 会话过期不重试（调用数不增长）", expiredCalls == callsAfterExpired,
                $"{callsAfterExpired} -> {expiredCalls}");
            await adapter4.StopAsync();
        }
        finally
        {
            CleanupTempDir(dir);
        }
    }

    // ── 6. QR 登录状态机 / PNG / 凭据落库 / 覆盖作废 / 过期 / 登出 ───────────────

    private static async Task CheckQrLoginAsync(CheckFn check)
    {
        var dir = NewTempDir("wechat-qr");
        try
        {
            var options = new ChannelOptions { EnabledChannels = [ChannelIds.WeChat], DataDir = dir };
            var protector = ChannelCredentialProtector.Create("test-master-token", dir);
            var store = new ChannelStore(Path.Combine(dir, "channels.db"), protector);
            var manager = new ChannelManager(NullLogger<ChannelManager>.Instance);
            var fake = new FakeAdapter(ChannelIds.WeChat);
            manager.Register(fake);
            await manager.StartAsync(ChannelIds.WeChat);

            var handler = new MockILinkHandler();
            handler.QrStatuses.Enqueue("""{"status":"init"}""");
            handler.QrStatuses.Enqueue("""{"status":"scanned"}""");
            handler.QrStatuses.Enqueue("""
                {"status":"confirmed","bot_token":"tok-9","ilink_bot_id":"bot-9",
                 "baseurl":"https://ilinkai.weixin.qq.com","ilink_user_id":"u-9"}
                """);
            // 首轮状态调用先挂起：断言初始 pending 后再放行，避免与后台轮询竞态
            var firstGate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            handler.QrGate = firstGate;
            using var http = NewHttp(handler);
            var login = new WeChatQrLogin(
                options, store, manager, NullLogger<WeChatQrLogin>.Instance,
                () => new ILinkLoginClient(http, "https://mock.ilink.test", () => "dGVzdC11aW4="),
                TimeSpan.FromMilliseconds(10));

            var started = await login.StartAsync();
            var png = started.PngBase64 is null ? [] : Convert.FromBase64String(started.PngBase64);
            check("QR: start 返回 loginId/expiresAt/PNG",
                started.Ok && !string.IsNullOrEmpty(started.LoginId)
                && started.ExpiresAt > DateTimeOffset.UtcNow
                && png.Length > 100
                && png[0] == 0x89 && png[1] == 0x50 && png[2] == 0x4E && png[3] == 0x47,
                $"pngBytes={png.Length}");
            check("QR: 初始状态 pending", login.GetStatus(started.LoginId!).Status == "pending");
            handler.QrGate = null;
            firstGate.SetResult();

            check("QR: 轮询 confirmed + botId",
                await WaitUntilAsync(() => login.GetStatus(started.LoginId!).Status == "confirmed", TimeSpan.FromSeconds(5))
                && login.GetStatus(started.LoginId!).BotId == "bot-9",
                JsonSerializer.Serialize(login.GetStatus(started.LoginId!)));
            var rawCredential = await store.LoadCredentialAsync(ChannelIds.WeChat);
            var protection = await store.CredentialProtectionAsync(ChannelIds.WeChat);
            var withoutProtector = new ChannelStore(Path.Combine(dir, "channels.db"));
            var cipherUnreadable = await withoutProtector.LoadCredentialAsync(ChannelIds.WeChat) is null;
            check("QR: confirmed 凭据加密落库（aes-gcm 密文 + botToken/botId 往返）",
                rawCredential is not null && rawCredential.Contains("tok-9") && rawCredential.Contains("bot-9")
                && protection == ChannelCredentialProtector.AesGcmScheme && cipherUnreadable);
            check("QR: confirmed 后自动重启适配器（stop+start）",
                await WaitUntilAsync(() => fake.StopCount == 1 && fake.StartCount == 2, TimeSpan.FromSeconds(5)),
                $"starts={fake.StartCount} stops={fake.StopCount}");

            // 重复 start 覆盖旧 loginId（旧二维码作废）
            handler.QrGate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            handler.QrStatuses.Enqueue("""{"status":"scanned"}""");
            var second = await login.StartAsync();
            check("QR: 重复 start 旧 loginId 作废",
                second.Ok && login.GetStatus(started.LoginId!).Status == "error");
            handler.QrStatuses.Enqueue("""{"status":"expired"}""");
            handler.QrGate.SetResult();
            check("QR: 新 loginId 轮询到 expired 文案",
                await WaitUntilAsync(() => login.GetStatus(second.LoginId!).Status == "expired", TimeSpan.FromSeconds(5))
                && login.GetStatus(second.LoginId!).Error?.Contains("过期") == true,
                JsonSerializer.Serialize(login.GetStatus(second.LoginId!)));

            // 上游取码失败 → 人话错误
            handler.QrCodeResponse = """{"error":"upstream down"}""";
            var failed = await login.StartAsync();
            check("QR: 上游取码失败返回人话错误",
                !failed.Ok && failed.Error?.Contains("获取二维码失败") == true, failed.Error);
            handler.QrCodeResponse = null;

            // ticket 是登录会话凭据：轮询失败异常只带 path
            var ticket = "ticket-secret-abcdef";
            handler.Override = (_, _) => Task.FromResult(new HttpResponseMessage(HttpStatusCode.InternalServerError)
            {
                Content = new StringContent("boom"),
            });
            var probe = new ILinkLoginClient(http, "https://mock.ilink.test", () => "dGVzdC11aW4=");
            string? pollError = null;
            try
            {
                await probe.PollQrStatusAsync(ticket);
            }
            catch (ILinkProtocolException ex)
            {
                pollError = ex.Message;
            }
            finally
            {
                probe.Dispose();
            }
            handler.Override = null;
            check("QR: 轮询失败异常只带 path（ticket 不进日志）",
                pollError is not null && !pollError.Contains(ticket)
                && pollError.Contains("/ilink/bot/get_qrcode_status"), pollError);

            // 登出：删凭据 + 停适配器（幂等）
            await login.LogoutAsync();
            await login.LogoutAsync();
            check("QR: logout 删凭据 + 停适配器（幂等）",
                await store.LoadCredentialAsync(ChannelIds.WeChat) is null && fake.StopCount == 2,
                $"stops={fake.StopCount}");
        }
        finally
        {
            CleanupTempDir(dir);
        }
    }

    // ── 7. 注册表接入 ──────────────────────────────────────────────────────────

    private static void CheckRegistration(CheckFn check)
    {
        var registration = new WeChatAdapterRegistration();
        check("注册: channel=wechat + SupportsProactive",
            registration.ChannelId == ChannelIds.WeChat && registration.SupportsProactive);
        check("注册: IsConfigured 跟随 CLOUD_CHANNELS",
            registration.IsConfigured(new ChannelOptions { EnabledChannels = [ChannelIds.WeChat] })
            && !registration.IsConfigured(new ChannelOptions()));
        check("注册: ChannelAdapterCatalog 已接入 wechat",
            ChannelAdapterCatalog.All.Any(item => item.ChannelId == ChannelIds.WeChat));

        var dir = NewTempDir("wechat-registration");
        try
        {
            var services = new ServiceCollection();
            services.AddSingleton(new ChannelOptions { EnabledChannels = [ChannelIds.WeChat], DataDir = dir });
            services.AddSingleton(new ChannelStore(Path.Combine(dir, "channels.db")));
            services.AddSingleton(new WeChatMediaStore(dir));
            services.AddSingleton(new WeChatCdnClient(new HttpClient()));
            services.AddSingleton<ISilkCodec>(new SilkUnavailableCodec());
            services.AddLogging();
            using var provider = services.BuildServiceProvider();
            var adapter = registration.Create(provider);
            check("注册: Create 返回微信适配器（capability 冻结值）",
                adapter.Id == ChannelIds.WeChat && adapter.DisplayName == "微信"
                && adapter.Capability is { Text: true, Image: true, Audio: false, File: true, MaxTextLength: 2048 },
                adapter.DisplayName);
        }
        finally
        {
            CleanupTempDir(dir);
        }
    }

    // ── 环境/替身 ─────────────────────────────────────────────────────────────

    private static async Task<(ChannelOptions Options, ChannelStore Store, WeChatMediaStore Media,
        MockILinkHandler Handler, HttpClient Http)> NewEnvironmentAsync(string dir, string suffix = "main")
    {
        var options = new ChannelOptions
        {
            EnabledChannels = [ChannelIds.WeChat],
            DataDir = dir,
            WeChatMediaMaxMb = 20,
        };
        var store = new ChannelStore(Path.Combine(dir, $"channels-{suffix}.db"));
        var credentials = new ILinkCredentials
        {
            BotToken = "bot-token-1",
            IlinkBotId = "bot-1",
            BaseUrl = "https://mock.ilink.test",
            IlinkUserId = "bot-user-1",
        };
        await store.SaveCredentialAsync(ChannelIds.WeChat, JsonSerializer.Serialize(credentials, ChannelJson.Options));
        var handler = new MockILinkHandler();
        var http = NewHttp(handler);
        var media = new WeChatMediaStore(dir, options.MediaDirMb);
        return (options, store, media, handler, http);
    }

    private static HttpClient NewHttp(MockILinkHandler handler) =>
        new(handler) { Timeout = Timeout.InfiniteTimeSpan };

    private static ILinkProtocolClient NewClient(HttpClient http) => new(
        new ILinkCredentials
        {
            BotToken = "bot-token-1",
            IlinkBotId = "bot-1",
            BaseUrl = "https://mock.ilink.test",
            IlinkUserId = "bot-user-1",
        },
        http,
        () => "dGVzdC11aW4=");

    private static ILinkBotAdapter NewAdapter(
        ChannelOptions options,
        ChannelStore store,
        WeChatMediaStore media,
        MockILinkHandler handler,
        HttpClient http,
        ISilkCodec? silk = null,
        TimeSpan? reconnectBackoff = null) => new(
        options,
        store,
        media,
        new WeChatCdnClient(http),
        silk ?? new SilkUnavailableCodec(),
        NullLogger<ILinkBotAdapter>.Instance,
        _ => NewClient(http),
        reconnectBackoff ?? TimeSpan.FromMilliseconds(10));

    private static async Task<bool> WaitUntilAsync(Func<bool> condition, TimeSpan timeout)
    {
        var deadline = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < deadline)
        {
            if (condition()) return true;
            await Task.Delay(10);
        }
        return condition();
    }

    private static async Task<T> WaitAsync<T>(Task<T> task, TimeSpan timeout) => await task.WaitAsync(timeout);

    private static async Task WaitAsync(Task task, TimeSpan timeout) => await task.WaitAsync(timeout);

    private static string NewTempDir(string label) => Directory.CreateDirectory(Path.Combine(
        Path.GetTempPath(), $"cyrene-wechat-selftest-{label}-{Guid.NewGuid():N}")).FullName;

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

    private sealed class FakeAdapter(string id) : IChannelAdapter
    {
        public string Id { get; } = id;
        public string DisplayName => $"fake-{Id}";
        public ChannelCapability Capability => ChannelCapabilities.For(Id);
        public Func<IncomingMessage, CancellationToken, Task<OutgoingMessage?>>? OnMessage { get; set; }
        public int StartCount { get; private set; }
        public int StopCount { get; private set; }

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

        public Task<ChannelSendResult> SendAsync(OutgoingMessage message, CancellationToken cancellationToken = default) =>
            Task.FromResult(ChannelSendResult.Success);

        public ChannelStatus GetStatus() => new() { Enabled = true, Phase = ChannelPhases.Running };
    }

    /// <summary>selftest：观测并发 Start 竞态丢弃路径是否调用 Dispose（P2-8）。</summary>
    private sealed class TrackingProtocolClient : ILinkProtocolClient
    {
        public TrackingProtocolClient(ILinkCredentials credentials, HttpClient http) : base(credentials, http)
        {
        }

        public bool Disposed { get; private set; }

        public override void Dispose()
        {
            if (Disposed) return;
            Disposed = true;
            base.Dispose();
        }
    }

    // ── mock iLink HTTP ───────────────────────────────────────────────────────

    private sealed record MockResponse(string Body, string? Error = null, int DelayMs = 0);

    private sealed record RequestSnapshot(string Path, string? AuthType, string? Auth, string? Uin, string? Body);

    private sealed class MockILinkHandler : HttpMessageHandler
    {
        public ConcurrentQueue<MockResponse> GetUpdates { get; } = new();
        public List<string> GetUpdatesBufs { get; } = [];
        public List<JsonElement> SentMessages { get; } = [];
        public List<JsonElement> UploadRequests { get; } = [];
        public List<byte[]> UploadBodies { get; } = [];
        public List<RequestSnapshot> Requests { get; } = [];
        public byte[]? DownloadBody { get; set; }
        public string? UploadEncryptedParam { get; set; } = "encrypted-param";
        public string UploadUrlResponse { get; set; } = """{"upload_full_url":"https://mock.cdn.test/c2c/upload/full"}""";
        public string SendMessageResponse { get; set; } = """{"ret":0}""";
        public string QrCode { get; set; } = "qr-ticket-1";
        public string QrImgContent { get; set; } = "https://liteapp.weixin.qq.com/q/mock";
        public string? QrCodeResponse { get; set; }
        public Queue<string> QrStatuses { get; } = new();
        public TaskCompletionSource? QrGate { get; set; }
        public Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>>? Override { get; set; }
        public int GetUpdatesCalls;

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var path = request.RequestUri?.AbsolutePath ?? "";
            if (path.StartsWith("/c2c/upload", StringComparison.Ordinal))
            {
                path = "/c2c/upload"; // upload_full_url 可带子路径（桌面测试用 /upload/full）
            }
            var body = request.Content is null
                ? null
                : await request.Content.ReadAsStringAsync(cancellationToken);
            Requests.Add(new RequestSnapshot(
                path,
                request.Headers.TryGetValues("AuthorizationType", out var authType) ? authType.FirstOrDefault() : null,
                request.Headers.TryGetValues("Authorization", out var auth) ? auth.FirstOrDefault() : null,
                request.Headers.TryGetValues("X-WECHAT-UIN", out var uin) ? uin.FirstOrDefault() : null,
                body));

            if (Override is not null)
            {
                return await Override(request, cancellationToken);
            }

            switch (path)
            {
                case "/ilink/bot/getupdates":
                {
                    Interlocked.Increment(ref GetUpdatesCalls);
                    if (body is not null)
                    {
                        using var document = JsonDocument.Parse(body);
                        GetUpdatesBufs.Add(document.RootElement.GetProperty("get_updates_buf").GetString() ?? "");
                    }
                    if (GetUpdates.TryDequeue(out var response))
                    {
                        if (response.Error is not null) throw new HttpRequestException(response.Error);
                        if (response.DelayMs > 0) await Task.Delay(response.DelayMs, cancellationToken);
                        return Json(response.Body);
                    }
                    // 队列为空：模拟长轮询空转（避免测试忙循环）
                    await Task.Delay(50, cancellationToken);
                    return Json("""{"msgs":[],"get_updates_buf":""}""");
                }
                case "/ilink/bot/sendmessage":
                {
                    using var document = JsonDocument.Parse(body ?? "{}");
                    SentMessages.Add(document.RootElement.Clone());
                    return Json(SendMessageResponse);
                }
                case "/ilink/bot/getuploadurl":
                {
                    using var document = JsonDocument.Parse(body ?? "{}");
                    UploadRequests.Add(document.RootElement.Clone());
                    return Json(UploadUrlResponse);
                }
                case "/c2c/upload":
                {
                    UploadBodies.Add(request.Content is null
                        ? []
                        : await request.Content.ReadAsByteArrayAsync(cancellationToken));
                    var response = new HttpResponseMessage(HttpStatusCode.OK);
                    if (UploadEncryptedParam is not null)
                    {
                        response.Headers.TryAddWithoutValidation("x-encrypted-param", UploadEncryptedParam);
                    }
                    return response;
                }
                case "/c2c/download":
                {
                    if (DownloadBody is null) return new HttpResponseMessage(HttpStatusCode.NotFound);
                    return new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(DownloadBody) };
                }
                case "/ilink/bot/get_bot_qrcode":
                {
                    if (QrCodeResponse is not null) return Json(QrCodeResponse);
                    return Json($$$$"""{"qrcode":"{{{{QrCode}}}}","qrcode_img_content":"{{{{QrImgContent}}}}"}""");
                }
                case "/ilink/bot/get_qrcode_status":
                {
                    var status = QrStatuses.Count > 0 ? QrStatuses.Dequeue() : """{"status":"expired"}""";
                    if (QrGate is not null) await QrGate.Task.WaitAsync(cancellationToken);
                    return Json(status);
                }
                default:
                    return new HttpResponseMessage(HttpStatusCode.NotFound)
                    {
                        Content = new StringContent($"unhandled {path}"),
                    };
            }
        }

        public static HttpResponseMessage Json(string body) => new(HttpStatusCode.OK)
        {
            Content = new StringContent(body, Encoding.UTF8, "application/json"),
        };
    }
}

using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading.RateLimiting;
using CyreneCloud.Auth;
using CyreneCloud.Channels;
using CyreneCloud.Channels.Adapters.WeChat;
using CyreneCloud.Channels.Adapters.Feishu;
using CyreneCloud.Dialog;
using CyreneCloud.Storage;
using CyreneNative.Channels;
using CyreneNative.Sync;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.Extensions.FileProviders;

// ── cyrene-cloud-server：事件库 + /v1/sync + 配对/设备令牌（IKJK2J / IKJK2K） ──
// 契约：docs/specs/2026-10-04-sync-protocol-v0.md（事件信封/读取语义）
// 鉴权（IKJK2K）：/v1/* 需 Bearer——device token（配对签发，库内只存哈希）或 CLOUD_TOKEN（主控：引导/运维）。
//   首次引导：CLI `pair-code` 或主控令牌调 POST /v1/pair/code；POST /v1/pair 兑换公开（一次性配对码）。
// 默认仅绑 127.0.0.1；对外 TLS 由 Caddy 终结（deploy/Caddyfile.example）。

var dataDir = Environment.GetEnvironmentVariable("CYRENE_CLOUD_DATA")
    ?? Path.Combine(AppContext.BaseDirectory, "data");
var dbPath = Path.Combine(dataDir, "events.db");
var pairTtl = TimeSpan.FromSeconds(ReadIntEnv("CLOUD_PAIR_TTL_SECONDS", 300));
// PWA 静态产物目录（IKJK2L）；能力声明（IKJN78）与静态托管共用同一判断
var webRoot = Path.Combine(AppContext.BaseDirectory, "wwwroot");
var hasWebRoot = Directory.Exists(webRoot);
// Linux：进程 umask 0077——任何新建文件（含 SQLite -wal/-shm）不以宽松权限落盘
StorageHardening.EnforceProcessUmask();

// 裸跑运维子命令（不进 Web 管线）：pair-code / devices / revoke <deviceId>
if (args.Length > 0 && args[0] is "pair-code" or "devices" or "revoke")
{
    Environment.ExitCode = RunCli(args);
    return;
}

// 裸跑渠道自测（不进 Web 管线）：channel-selftest [all|framework|wechat|feishu|qqbot|ownership]；
// --selftest <suite> 为通用别名（同义；未知子集退出码 2 并打印可用清单，不会误落回真服务启动）。
if (args.Length > 0 && args[0] == "channel-selftest")
{
    Environment.ExitCode = ChannelSelfTest.Run(args.Length > 1 ? args[1] : "all");
    return;
}
if (args.Length > 0 && args[0] == "--selftest")
{
    Environment.ExitCode = ChannelSelfTest.Run(args.Length > 1 ? args[1] : "all");
    return;
}

var builder = WebApplication.CreateBuilder(args);
builder.Services.ConfigureHttpJsonOptions(options =>
{
    options.SerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase;
    options.SerializerOptions.DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull;
});

// 默认仅绑 127.0.0.1；--urls / ASPNETCORE_URLS 由 CreateBuilder 统一接入配置
var urls = builder.Configuration["urls"] ?? "http://127.0.0.1:7789";
builder.WebHost.UseUrls(urls);
// push 请求体硬上限（超出 → 413 E_SYNC_BATCH_TOO_LARGE；handler 另有 Content-Length 快检）
builder.WebHost.ConfigureKestrel(options => options.Limits.MaxRequestBodySize = CloudApi.MaxPushBodyBytes);

builder.Services.AddSingleton(new EventStore(dbPath));
builder.Services.AddSingleton(new AuthStore(dbPath, pairTtl));

// 服务端文本生成（IKJK2M）：CLOUD_LLM_API_KEY 非空即启用；密钥只在服务端、日志不落
var modelClient = new ModelClient(
    Environment.GetEnvironmentVariable("CLOUD_LLM_API_KEY"),
    Environment.GetEnvironmentVariable("CLOUD_LLM_MODEL") ?? "gpt-4o-mini",
    Environment.GetEnvironmentVariable("CLOUD_LLM_BASE_URL"),
    ReadIntEnv("CLOUD_LLM_TIMEOUT_SECONDS", 60),
    ReadIntEnv("CLOUD_LLM_MAX_TOKENS", 1024));
var dialogSystemPrompt = Environment.GetEnvironmentVariable("CLOUD_LLM_SYSTEM_PROMPT");
var dialogContextChars = ReadIntEnv("CLOUD_LLM_CONTEXT_CHARS", 24000);
builder.Services.AddSingleton(modelClient);
// 生成核心（DialogEngine）与事件写者（ServerEventWriter）抽出（§2.4 R3/R4）：
// DialogLoop 只留队列/重试/写回；渠道路径复用同一生成与写库语义。
builder.Services.AddSingleton(sp => new ServerEventWriter(sp.GetRequiredService<EventStore>()));
builder.Services.AddSingleton(sp => new DialogEngine(
    sp.GetRequiredService<EventStore>(),
    modelClient,
    sp.GetRequiredService<ILogger<DialogEngine>>(),
    dialogSystemPrompt,
    dialogContextChars));
builder.Services.AddSingleton<IDialogEngine>(sp => sp.GetRequiredService<DialogEngine>());
builder.Services.AddSingleton(sp => new DialogLoop(
    sp.GetRequiredService<IDialogEngine>(),
    sp.GetRequiredService<ServerEventWriter>(),
    modelClient,
    sp.GetRequiredService<ILogger<DialogLoop>>()));
builder.Services.AddHostedService(sp => sp.GetRequiredService<DialogLoop>());

var masterToken = Environment.GetEnvironmentVariable("CLOUD_TOKEN");
// 主控令牌字节预转换（鉴权热路径不重复分配；比较后临时数组清零）
var masterTokenBytes = string.IsNullOrEmpty(masterToken) ? null : Encoding.UTF8.GetBytes(masterToken);

// ── 服务端渠道层（Phase 2 渠道批，§2.3/§2.4）──
// CLOUD_CHANNELS 为空 = 渠道层整体关闭（不注册存储/托管，零内存占用）；
// capabilities.channels 仍声明（hosted=[]），老客户端宽容解析。
var channelOptions = ChannelOptions.FromEnvironment(dataDir);
builder.Services.AddSingleton(channelOptions);
if (channelOptions.ChannelsEnabled)
{
    var channelsDbPath = Path.Combine(dataDir, "channels.db");
    builder.Services.AddSingleton(new ChannelStore(
        channelsDbPath, ChannelCredentialProtector.Create(masterToken, dataDir)));
    builder.Services.AddSingleton<ChannelManager>();
    builder.Services.AddSingleton(sp => new ChannelOwnershipService(
        sp.GetRequiredService<ChannelStore>(),
        sp.GetRequiredService<ChannelManager>(),
        sp.GetRequiredService<ILogger<ChannelOwnershipService>>(),
        ChannelOwnershipService.ComputeServerId(dataDir),
        TimeSpan.FromSeconds(channelOptions.OwnershipTtlSeconds)));
    builder.Services.AddSingleton(sp => new ChannelDeliveryService(
        sp.GetRequiredService<ChannelManager>(),
        sp.GetRequiredService<ILogger<ChannelDeliveryService>>()));
    builder.Services.AddSingleton(sp => new ChannelProactiveService(
        sp.GetRequiredService<ChannelStore>(),
        sp.GetRequiredService<ServerEventWriter>(),
        sp.GetRequiredService<ChannelDeliveryService>(),
        sp.GetRequiredService<ChannelOwnershipService>(),
        sp.GetRequiredService<ILogger<ChannelProactiveService>>()));
    builder.Services.AddSingleton(sp => new ChannelDispatcher(
        sp.GetRequiredService<ChannelStore>(),
        sp.GetRequiredService<ServerEventWriter>(),
        sp.GetRequiredService<IDialogEngine>(),
        sp.GetRequiredService<ChannelDeliveryService>(),
        sp.GetRequiredService<ILogger<ChannelDispatcher>>(),
        sp.GetRequiredService<ChannelOwnershipService>()));
    // 飞书 webhook 处理器（阶段 5）：公开路由的校验/解密/去重/路由逻辑；适配器由托管服务注册
    builder.Services.AddSingleton(sp => new FeishuEventCrypto(
        channelOptions.FeishuVerificationToken, channelOptions.FeishuEncryptKey));
    builder.Services.AddSingleton(sp => new FeishuWebhookProcessor(
        sp.GetRequiredService<FeishuEventCrypto>(),
        sp.GetRequiredService<ChannelStore>(),
        sp.GetRequiredService<ChannelManager>(),
        sp.GetRequiredService<ILogger<FeishuWebhookProcessor>>()));
    // 适配器注册表（阶段 3-6 在 ChannelAdapterCatalog 追加；已含 wechat/qqbot/feishu）
    foreach (var registration in ChannelAdapterCatalog.All)
    {
        builder.Services.AddSingleton<IChannelAdapterRegistration>(registration);
    }
    // 微信 iLink 专属运行时（媒体缓存/CDN/协议；SILK 阶段 7 占位）+ 扫码登录服务（§3.4）
    if (channelOptions.IsChannelEnabled(ChannelIds.WeChat))
    {
        builder.Services.AddSingleton(new WeChatMediaStore(channelOptions.DataDir, channelOptions.MediaDirMb));
        builder.Services.AddSingleton(new WeChatCdnClient(
            WeChatHttp.CreateClient(), channelOptions.WeChatCdnBaseUrl));
        builder.Services.AddSingleton<ISilkCodec, SilkUnavailableCodec>();
        builder.Services.AddSingleton(sp => new WeChatQrLogin(
            channelOptions,
            sp.GetRequiredService<ChannelStore>(),
            sp.GetRequiredService<ChannelManager>(),
            sp.GetRequiredService<ILogger<WeChatQrLogin>>()));
    }
    builder.Services.AddHostedService<ChannelHostedService>();
}

// capabilities.channels（§2.6）：hosted = 已配置且生成可用的渠道（R6：无生成则空）。
// 阶段 3-6 适配器注册后自动点亮；ownership/proactive 供桌面降级 UI。
var channelRegistrations = ChannelAdapterCatalog.All;
var hostedChannels = modelClient.Enabled
    ? channelRegistrations
        .Where(item => channelOptions.IsChannelEnabled(item.ChannelId) && item.IsConfigured(channelOptions))
        .Select(item => item.ChannelId)
        .ToArray()
    : [];
var proactiveChannels = modelClient.Enabled
    ? channelRegistrations
        .Where(item => channelOptions.IsChannelEnabled(item.ChannelId) && item.IsConfigured(channelOptions) && item.SupportsProactive)
        .Select(item => item.ChannelId)
        .ToArray()
    : [];
var allowedHosts = (Environment.GetEnvironmentVariable("CLOUD_ALLOWED_HOSTS") ?? "")
    .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
    .ToHashSet(StringComparer.OrdinalIgnoreCase);
var syncPerMinute = ReadIntEnv("CLOUD_RATE_SYNC_PER_MIN", 300);
var pairPerMinute = ReadIntEnv("CLOUD_RATE_PAIR_PER_MIN", 10);

builder.Services.AddRateLimiter(options =>
{
    options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
    options.OnRejected = async (context, cancellationToken) =>
    {
        await context.HttpContext.Response.WriteAsJsonAsync(new { code = CloudApi.RateLimited }, cancellationToken);
    };
    options.AddPolicy("sync", context => RateLimitPartition.GetFixedWindowLimiter(
        PartitionKey("sync", context),
        _ => new FixedWindowRateLimiterOptions { PermitLimit = syncPerMinute, Window = TimeSpan.FromMinutes(1) }));
    options.AddPolicy("pair", context => RateLimitPartition.GetFixedWindowLimiter(
        PartitionKey("pair", context),
        _ => new FixedWindowRateLimiterOptions { PermitLimit = pairPerMinute, Window = TimeSpan.FromMinutes(1) }));
});

var app = builder.Build();
var authStore = app.Services.GetRequiredService<AuthStore>();
app.Logger.LogInformation("dialog loop enabled={Enabled} model={Model}", modelClient.Enabled, modelClient.ModelName);

// Caddy 同机反代：只信任回环来源的 X-Forwarded-*（KnownProxies 默认空集合=不信任任何来源，
// 必须显式列出回环，否则 XFF 失效 → 限流分区坍缩为同一 IP、远程 healthz 误豁免）
var forwardedOptions = new ForwardedHeadersOptions
{
    ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto,
};
forwardedOptions.KnownProxies.Add(System.Net.IPAddress.Loopback);
forwardedOptions.KnownProxies.Add(System.Net.IPAddress.IPv6Loopback);
app.UseForwardedHeaders(forwardedOptions);

if (allowedHosts.Count > 0)
{
    app.Use(async (context, next) =>
    {
        var host = context.Request.Host.Host;
        if (allowedHosts.Contains(host) || IsLoopbackHost(host))
        {
            await next();
            return;
        }
        context.Response.StatusCode = StatusCodes.Status421MisdirectedRequest;
        await context.Response.WriteAsJsonAsync(new { code = CloudApi.HostNotAllowed });
    });
}

// ── PWA 静态托管（IKJK2L）──
// wwwroot 存在即启用（构建：src/pwa → dotnet/cloud-server/wwwroot；Docker 构建阶段产出）。
// 缓存策略：assets/ 下为带哈希产物（长缓存）；index.html / sw.js / manifest / 图标不缓存，
// 保证升级即时生效；HTML 附 CSP（纯同源、无内联脚本/样式）。
if (hasWebRoot)
{
    var fileProvider = new PhysicalFileProvider(webRoot);
    app.UseDefaultFiles(new DefaultFilesOptions { FileProvider = fileProvider });
    app.UseStaticFiles(new StaticFileOptions
    {
        FileProvider = fileProvider,
        OnPrepareResponse = context =>
        {
            var headers = context.Context.Response.Headers;
            var hashed = context.Context.Request.Path.StartsWithSegments("/assets");
            headers.CacheControl = hashed ? "public, max-age=31536000, immutable" : "no-cache";
            headers["X-Content-Type-Options"] = "nosniff";
            if (context.File.Name.EndsWith(".html", StringComparison.OrdinalIgnoreCase))
            {
                headers["Content-Security-Policy"] =
                    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
                    "connect-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; " +
                    "object-src 'none'; frame-ancestors 'none'";
            }
        },
    });
}

app.UseRateLimiter();

// 鉴权：/v1/* = device token 或主控令牌；POST /v1/pair（兑换）公开；healthz 回环豁免（远程需令牌）
app.Use(async (context, next) =>
{
    var path = context.Request.Path;
    var isHealthz = path.Equals("/healthz", StringComparison.OrdinalIgnoreCase);
    var isPairRedeem = HttpMethods.IsPost(context.Request.Method)
        && path.Equals("/v1/pair", StringComparison.OrdinalIgnoreCase);
    // 能力声明公开只读（客户端在配对前就需要它来降级 UI；不含敏感信息）
    var isCapabilities = HttpMethods.IsGet(context.Request.Method)
        && path.Equals("/v1/capabilities", StringComparison.OrdinalIgnoreCase);
    // 飞书 webhook 公开路由（§6.2）：自带 Verification Token/签名/时间戳校验
    var isFeishuWebhook = HttpMethods.IsPost(context.Request.Method)
        && (path.Equals(FeishuWebhookEndpoint.WebhookPath, StringComparison.OrdinalIgnoreCase)
            || path.Equals(FeishuWebhookEndpoint.AliasPath, StringComparison.OrdinalIgnoreCase));
    if (isPairRedeem || isCapabilities || isFeishuWebhook
        || (!path.StartsWithSegments("/v1") && !isHealthz))
    {
        await next();
        return;
    }

    // healthz：本机探针（回环）放行；远程访问需令牌（避免经反代外泄事件规模/设备数）
    var isLoopback = context.Connection.RemoteIpAddress is { } address && System.Net.IPAddress.IsLoopback(address);
    if (!(isHealthz && isLoopback))
    {
        var token = ExtractBearer(context);
        string? principal = null;
        if (!string.IsNullOrEmpty(token))
        {
            if (masterTokenBytes is not null && TokenEquals(masterTokenBytes, token))
            {
                principal = "master";
            }
            else if (authStore.TryAuthenticate(token, out var deviceId, out _))
            {
                principal = deviceId;
            }
        }

        if (principal is null)
        {
            context.Response.StatusCode = StatusCodes.Status401Unauthorized;
            await context.Response.WriteAsJsonAsync(new { code = CloudApi.Unauthorized });
            return;
        }

        context.Items["principal"] = principal;
    }

    await next();
});

app.MapGet("/healthz", (EventStore store, AuthStore auth) =>
{
    using var process = Process.GetCurrentProcess();
    return Results.Json(new
    {
        status = "ok",
        rssMB = Math.Round(process.WorkingSet64 / 1024.0 / 1024.0, 1),
        cursor = store.CurrentCursor(), // O(1)：替代全表 COUNT(*)
        devices = auth.CountActiveDevices(), // O(1)：COUNT 聚合，不物化整表
    });
});

// GET /v1/capabilities：形态能力声明（公开只读；PWA/桌面客户端据此降级 UI 与交互；IKJN78）
// 四形态（完整/CF/PHP/Git）以本声明区分能力边界，见 docs/design/2026-10-04-cloud-server-forms.md
app.MapGet("/v1/capabilities", () => Results.Json(new
{
    impl = "dotnet-vps",
    protocol = "v0",
    sync = true,
    clone = true,
    cursor = "server",
    generation = modelClient.Enabled ? "realtime" : "none",
    pairing = "device-token",
    pwa = hasWebRoot,
    maxBatchBytes = CloudApi.MaxPushBodyBytes,
    // §2.6 渠道能力声明：hosted 为空 = 服务端无渠道托管（桌面按本机运行处理）
    channels = new
    {
        hosted = hostedChannels,
        ownership = "lease",
        proactive = proactiveChannels,
        voice = false,
        mediaMaxMB = channelOptions.WeChatMediaMaxMb,
    },
}));

// 飞书 webhook（公开路由，§6.2）：渠道层启用且飞书在 CLOUD_CHANNELS 内才挂载；
// 校验/解密/去重逻辑见 FeishuWebhookProcessor，事件处理立即 200 + 后台执行。
if (channelOptions.ChannelsEnabled && channelOptions.IsChannelEnabled(ChannelIds.Feishu))
{
    FeishuWebhookEndpoint.Map(app);
}

// ── 配对与设备（IKJK2K） ──

// 渠道控制面（§5.2）：/v1/channels/ownership|status|{id}/proactive（复用 Bearer 鉴权 + sync 限流桶）。
// CLOUD_CHANNELS 为空时渠道层关闭，端点不挂载（客户端据 capabilities.channels.hosted=[] 降级）。
if (channelOptions.ChannelsEnabled)
{
    app.MapChannelApi();
}

// POST /v1/pair/code：已配对设备（或主控令牌）签发一次性配对码（TTL 默认 5 分钟）
app.MapPost("/v1/pair/code", (HttpContext context, AuthStore auth) =>
{
    var createdBy = context.Items["principal"]?.ToString() ?? "unknown";
    var (code, expiresAt) = auth.CreatePairCode(createdBy);
    return Results.Json(new { code, expiresAt });
}).RequireRateLimiting("pair");

// POST /v1/pair：新设备用配对码兑换 device token（token 仅此一次回显）
app.MapPost("/v1/pair", (AuthStore auth, PairRedeemRequest request) =>
{
    var outcome = auth.Redeem(request.Code, request.DeviceName);
    if (!outcome.Ok)
    {
        return Results.BadRequest(new { code = outcome.Error });
    }
    return Results.Json(new { deviceId = outcome.DeviceId, name = outcome.Name, token = outcome.Token });
}).RequireRateLimiting("pair");

// GET /v1/devices：设备清单仅主控（device token → 403，防越权枚举）
app.MapGet("/v1/devices", (HttpContext context, AuthStore auth) =>
    IsMaster(context)
        ? Results.Json(new { devices = auth.ListDevices() })
        : Results.Json(new { code = CloudApi.Forbidden }, statusCode: StatusCodes.Status403Forbidden))
    .RequireRateLimiting("sync");

// POST /v1/devices/{id}/revoke：master 任意；device 仅自身（越权 → 403）
app.MapPost("/v1/devices/{deviceId}/revoke", (HttpContext context, AuthStore auth, string deviceId) =>
{
    if (!CanManageDevice(context, deviceId))
    {
        return Results.Json(new { code = CloudApi.Forbidden }, statusCode: StatusCodes.Status403Forbidden);
    }
    if (!auth.Revoke(deviceId))
    {
        return Results.NotFound(new { code = CloudApi.DeviceNotFound });
    }
    return Results.Json(new { deviceId, revoked = true });
}).RequireRateLimiting("sync");

// POST /v1/devices/{id}/rotate：master 任意；device 仅自身（越权 → 403，防明文 token 被窃取）
app.MapPost("/v1/devices/{deviceId}/rotate", (HttpContext context, AuthStore auth, string deviceId) =>
{
    if (!CanManageDevice(context, deviceId))
    {
        return Results.Json(new { code = CloudApi.Forbidden }, statusCode: StatusCodes.Status403Forbidden);
    }
    var (ok, token) = auth.Rotate(deviceId);
    if (!ok)
    {
        return Results.NotFound(new { code = CloudApi.DeviceNotFound });
    }
    return Results.Json(new { deviceId, token });
}).RequireRateLimiting("sync");

// ── 同步（IKJK2J） ──

var sync = app.MapGroup("/v1/sync").RequireRateLimiting("sync");

// POST /v1/sync/push：body = JSONL 事件批（协议 v0 读取语义）→ 整批校验（含链/序号）→
// 幂等插入（event_id 首见生效）→ 原子提交；任一错误整批回滚（400）。
sync.MapPost("/push", async (HttpContext context, EventStore store, DialogLoop dialog) =>
{
    if (context.Request.ContentLength is > CloudApi.MaxPushBodyBytes)
    {
        return Results.Json(new { code = CloudApi.BatchTooLarge }, statusCode: StatusCodes.Status413PayloadTooLarge);
    }
    string text;
    try
    {
        using var reader = new StreamReader(context.Request.Body, Encoding.UTF8);
        text = await reader.ReadToEndAsync(context.RequestAborted);
    }
    catch (BadHttpRequestException ex) when (ex.StatusCode == StatusCodes.Status413PayloadTooLarge)
    {
        // chunked（无 Content-Length）到读取时才触顶：与前置快检统一为 413 + 错误码
        return Results.Json(new { code = CloudApi.BatchTooLarge }, statusCode: StatusCodes.Status413PayloadTooLarge);
    }
    var batch = SyncProtocolV0.ReadBatch(text);
    if (batch.TruncatedTail || batch.Errors.Count > 0)
    {
        return Results.BadRequest(new
        {
            code = CloudApi.BatchInvalid,
            truncatedTail = batch.TruncatedTail,
            errors = batch.Errors,
        });
    }
    var outcome = await store.PushBatchAsync(batch.Events, batch.LineByEventId, context.RequestAborted);
    if (outcome.Errors.Count > 0)
    {
        return Results.BadRequest(new { code = CloudApi.BatchRejected, errors = outcome.Errors });
    }
    if (outcome.Accepted > 0)
    {
        // 仅「user 新消息 / 回退」触发服务端生成（过滤其他设备同步的 assistant，避免无效全量重放；
        // 幂等由 DialogLoop 事件 id 保证）
        dialog.Publish(batch.Events
            .Where(item => item.Type switch
            {
                "turn_rewind" => true,
                "message.append" => item.Payload.ValueKind == JsonValueKind.Object
                    && item.Payload.TryGetProperty("role", out var role)
                    && role.ValueKind == JsonValueKind.String
                    && role.GetString() == "user",
                _ => false,
            })
            .Select(item => item.SessionId)
            .Distinct());
    }
    return Results.Json(new
    {
        accepted = outcome.Accepted,
        duplicates = outcome.Duplicates,
        cursor = outcome.Cursor.ToString(),
    });
});

// GET /v1/sync/fetch?since=&limit=&sessionId=：插入序增量（cursor 不透明，客户端原样回传）。
sync.MapGet("/fetch", async (HttpContext context, EventStore store, string? since, int? limit, string? sessionId) =>
{
    if (!long.TryParse(since ?? "0", out var sinceId) || sinceId < 0)
    {
        return Results.BadRequest(new { code = CloudApi.Cursor });
    }
    var outcome = await store.FetchAsync(sinceId, Math.Clamp(limit ?? 200, 1, 1000), sessionId, context.RequestAborted);
    return Results.Json(new
    {
        events = outcome.Events,
        cursor = outcome.Cursor.ToString(),
        hasMore = outcome.HasMore,
    });
});

// GET /v1/sync/clone?sessionId=：全量 JSONL 流（每行一个协议 v0 事件）；
// 游标在 X-Sync-Cursor 响应头（新设备 clone 后从该游标 fetch 增量）。
sync.MapGet("/clone", async (HttpContext context, EventStore store, string? sessionId) =>
{
    context.Response.ContentType = "application/x-ndjson; charset=utf-8";
    // 先取快照上界再流式读：流内容严格 ⊆ id<=cursor（并发 push 的事件留给后续 fetch，不重不漏）
    var cursor = store.CurrentCursor();
    context.Response.Headers["X-Sync-Cursor"] = cursor.ToString();
    var options = new JsonSerializerOptions { DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull };
    var newline = "\n"u8.ToArray();
    var written = 0;
    try
    {
        foreach (var syncEvent in store.StreamAll(sessionId, cursor))
        {
            await JsonSerializer.SerializeAsync(context.Response.Body, syncEvent, options, context.RequestAborted);
            await context.Response.Body.WriteAsync(newline, context.RequestAborted);
            written++;
        }
    }
    catch (OperationCanceledException)
    {
        // 客户端断开：正常终止流；warning 留痕便于排查「半截 clone」（X-Sync-Cursor 已发出，可续 fetch）
        app.Logger.LogWarning("clone 流被取消 sessionId={SessionId} cursor={Cursor} written={Written}",
            sessionId, cursor, written);
    }
    catch (IOException)
    {
        // 连接中断（写失败）：同上
        app.Logger.LogWarning("clone 写中断 sessionId={SessionId} cursor={Cursor} written={Written}",
            sessionId, cursor, written);
    }
});

// ── 微信 iLink 扫码登录（§3.4；阶段 3）──
// 控制面：桌面设置页调 start 拿 PNG 显示 → 3s 轮询 status → confirmed 后凭据已加密落库并自动重启适配器。
// 渠道未启用/未配置 wechat 时返回 E_CHANNEL_NOT_HOSTED（API 面稳定，老客户端宽容处理）。

app.MapPost("/v1/channels/wechat/login/start", async (HttpContext context) =>
{
    var login = context.RequestServices.GetService<WeChatQrLogin>();
    if (login is null)
    {
        return Results.BadRequest(new { code = CloudApi.ChannelNotHosted });
    }
    var result = await login.StartAsync(context.RequestAborted);
    if (!result.Ok)
    {
        return Results.Json(new { code = CloudApi.ChannelLogin, error = result.Error },
            statusCode: StatusCodes.Status502BadGateway);
    }
    return Results.Json(new
    {
        loginId = result.LoginId,
        pngBase64 = result.PngBase64,
        expiresAt = result.ExpiresAt,
    });
}).RequireRateLimiting("sync");

app.MapGet("/v1/channels/wechat/login/status", (HttpContext context, string? loginId) =>
{
    var login = context.RequestServices.GetService<WeChatQrLogin>();
    if (login is null)
    {
        return Results.BadRequest(new { code = CloudApi.ChannelNotHosted });
    }
    if (string.IsNullOrEmpty(loginId))
    {
        return Results.BadRequest(new { code = CloudApi.ChannelLogin, error = "缺少 loginId" });
    }
    var status = login.GetStatus(loginId);
    return Results.Json(new { status = status.Status, botId = status.BotId, error = status.Error });
}).RequireRateLimiting("sync");

app.MapPost("/v1/channels/wechat/logout", async (HttpContext context) =>
{
    var login = context.RequestServices.GetService<WeChatQrLogin>();
    if (login is null)
    {
        return Results.BadRequest(new { code = CloudApi.ChannelNotHosted });
    }
    await login.LogoutAsync(context.RequestAborted);
    return Results.Json(new { ok = true });
}).RequireRateLimiting("sync");

app.Run();

// ── 顶层辅助 ──

static string? ExtractBearer(HttpContext context)
{
    const string scheme = "Bearer ";
    var raw = context.Request.Headers.Authorization.ToString();
    return raw.StartsWith(scheme, StringComparison.OrdinalIgnoreCase) && raw.Length > scheme.Length
        ? raw[scheme.Length..].Trim()
        : null;
}

static bool IsMaster(HttpContext context) =>
    context.Items["principal"]?.ToString() == "master";

// 设备管理权限：master 可管理全部；device 仅能操作自身（rotate/revoke 自己）
static bool CanManageDevice(HttpContext context, string deviceId)
{
    var principal = context.Items["principal"]?.ToString();
    return principal == "master"
        || (principal is not null && string.Equals(principal, deviceId, StringComparison.Ordinal));
}

// 定长比较（防时序侧信道）；临时字节数组用后即清零，主控令牌字节启动时预转换缓存
static bool TokenEquals(ReadOnlySpan<byte> expected, string actual)
{
    var actualBytes = Encoding.UTF8.GetBytes(actual);
    try
    {
        return CryptographicOperations.FixedTimeEquals(expected, actualBytes);
    }
    finally
    {
        CryptographicOperations.ZeroMemory(actualBytes);
    }
}

static int ReadIntEnv(string name, int fallback) =>
    int.TryParse(Environment.GetEnvironmentVariable(name), out var value) && value > 0 ? value : fallback;

static bool IsLoopbackHost(string host) =>
    host.Equals("localhost", StringComparison.OrdinalIgnoreCase)
    || (System.Net.IPAddress.TryParse(host, out var ip) && System.Net.IPAddress.IsLoopback(ip));

// 限流分区键：优先按 token 哈希（不落明文），否则按客户端 IP
static string PartitionKey(string prefix, HttpContext context)
{
    var token = ExtractBearer(context);
    if (!string.IsNullOrEmpty(token))
    {
        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token)))[..16];
        return $"{prefix}:t:{hash}";
    }
    return $"{prefix}:i:{context.Connection.RemoteIpAddress?.ToString() ?? "unknown"}";
}

// 裸跑运维子命令（本地 shell 使用；容器：docker compose exec cloud-server dotnet cyrene-cloud-server.dll <cmd>）
int RunCli(string[] cliArgs)
{
    try { Console.OutputEncoding = Encoding.UTF8; } catch { /* 控制台编码只影响显示 */ }
    var auth = new AuthStore(dbPath, pairTtl);
    switch (cliArgs[0])
    {
        case "pair-code":
        {
            var (code, expiresAt) = auth.CreatePairCode("cli");
            Console.WriteLine($"配对码: {code}");
            Console.WriteLine($"有效期至 {expiresAt}（单次使用；在新设备上兑换 device token）");
            return 0;
        }
        case "devices":
        {
            var devices = auth.ListDevices();
            if (devices.Count == 0)
            {
                Console.WriteLine("（暂无已配对设备）");
                return 0;
            }
            foreach (var device in devices)
            {
                Console.WriteLine($"{device.DeviceId}  [{(device.Revoked ? "已撤销" : "有效")}]  {device.Name}  " +
                                  $"created={device.CreatedAt}  lastSeen={device.LastSeenAt ?? "-"}");
            }
            return 0;
        }
        case "revoke" when cliArgs.Length >= 2:
        {
            var revoked = auth.Revoke(cliArgs[1]);
            Console.WriteLine(revoked ? $"已撤销设备 {cliArgs[1]}" : $"未找到设备 {cliArgs[1]}");
            return revoked ? 0 : 1;
        }
        default:
            Console.Error.WriteLine("用法: cyrene-cloud-server pair-code | devices | revoke <deviceId>");
            return 2;
    }
}

/// <summary>HTTP 层的错误码与请求约束（集中定义，避免裸字面量）。</summary>
internal static class CloudApi
{
    /// <summary>push 请求体上限（10MB）；超出 → 413 E_SYNC_BATCH_TOO_LARGE（客户端应切小批重推）。</summary>
    public const long MaxPushBodyBytes = 10 * 1024 * 1024;

    public const string Unauthorized = "E_UNAUTHORIZED";
    public const string Forbidden = "E_FORBIDDEN";
    public const string RateLimited = "E_RATE_LIMITED";
    public const string HostNotAllowed = "E_HOST_NOT_ALLOWED";
    public const string PairCode = "E_PAIR_CODE";
    public const string DeviceNotFound = "E_DEVICE_NOT_FOUND";
    public const string BatchInvalid = "E_SYNC_BATCH_INVALID";
    public const string BatchTooLarge = "E_SYNC_BATCH_TOO_LARGE";
    public const string BatchRejected = "E_SYNC_BATCH_REJECTED";
    public const string Cursor = "E_SYNC_CURSOR";

    // 渠道控制面（阶段 3 微信；错误码冻结见设计 §5.2）
    public const string ChannelNotHosted = "E_CHANNEL_NOT_HOSTED";
    public const string ChannelLogin = "E_CHANNEL_LOGIN";
}

/// <summary>POST /v1/pair 请求体。</summary>
public sealed record PairRedeemRequest(string? Code, string? DeviceName);

using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading.RateLimiting;
using CyreneCloud.Auth;
using CyreneCloud.Storage;
using CyreneNative.Sync;
using Microsoft.AspNetCore.HttpOverrides;

// ── cyrene-cloud-server：事件库 + /v1/sync + 配对/设备令牌（IKJK2J / IKJK2K） ──
// 契约：docs/specs/2026-10-04-sync-protocol-v0.md（事件信封/读取语义）
// 鉴权（IKJK2K）：/v1/* 需 Bearer——device token（配对签发，库内只存哈希）或 CLOUD_TOKEN（主控：引导/运维）。
//   首次引导：CLI `pair-code` 或主控令牌调 POST /v1/pair/code；POST /v1/pair 兑换公开（一次性配对码）。
// 默认仅绑 127.0.0.1；对外 TLS 由 Caddy 终结（deploy/Caddyfile.example）。

var dataDir = Environment.GetEnvironmentVariable("CYRENE_CLOUD_DATA")
    ?? Path.Combine(AppContext.BaseDirectory, "data");
var dbPath = Path.Combine(dataDir, "events.db");
var pairTtl = TimeSpan.FromSeconds(ReadIntEnv("CLOUD_PAIR_TTL_SECONDS", 300));
// Linux：进程 umask 0077——任何新建文件（含 SQLite -wal/-shm）不以宽松权限落盘
StorageHardening.EnforceProcessUmask();

// 裸跑运维子命令（不进 Web 管线）：pair-code / devices / revoke <deviceId>
if (args.Length > 0 && args[0] is "pair-code" or "devices" or "revoke")
{
    Environment.ExitCode = RunCli(args);
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

var masterToken = Environment.GetEnvironmentVariable("CLOUD_TOKEN");
// 主控令牌字节预转换（鉴权热路径不重复分配；比较后临时数组清零）
var masterTokenBytes = string.IsNullOrEmpty(masterToken) ? null : Encoding.UTF8.GetBytes(masterToken);
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

app.UseRateLimiter();

// 鉴权：/v1/* = device token 或主控令牌；POST /v1/pair（兑换）公开；healthz 回环豁免（远程需令牌）
app.Use(async (context, next) =>
{
    var path = context.Request.Path;
    var isHealthz = path.Equals("/healthz", StringComparison.OrdinalIgnoreCase);
    var isPairRedeem = HttpMethods.IsPost(context.Request.Method)
        && path.Equals("/v1/pair", StringComparison.OrdinalIgnoreCase);
    if (isPairRedeem || (!path.StartsWithSegments("/v1") && !isHealthz))
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

// ── 配对与设备（IKJK2K） ──

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
sync.MapPost("/push", async (HttpContext context, EventStore store) =>
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
}

/// <summary>POST /v1/pair 请求体。</summary>
public sealed record PairRedeemRequest(string? Code, string? DeviceName);

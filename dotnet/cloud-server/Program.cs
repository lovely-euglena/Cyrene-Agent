using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using CyreneCloud.Storage;
using CyreneNative.Sync;

// ── cyrene-cloud-server：事件库 + /v1/sync push / fetch / clone（IKJK2J） ──
// 契约：docs/specs/2026-10-04-sync-protocol-v0.md（事件信封/读取语义）
// 游标：服务端插入序 id（字符串十进制）；客户端按 (lamport, deviceId, seq) 重排收敛。
// 默认仅绑 127.0.0.1（本地开发）；对外暴露与 TLS/设备令牌由 IKJK2K 接管。
// CLOUD_TOKEN 非空时 /v1/* 需 Authorization: Bearer <token>（K 之前的最小门闩）。

var builder = WebApplication.CreateBuilder(args);
builder.Services.ConfigureHttpJsonOptions(options =>
{
    options.SerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase;
    options.SerializerOptions.DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull;
});

var urls = builder.Configuration["urls"]
    ?? Environment.GetEnvironmentVariable("ASPNETCORE_URLS")
    ?? "http://127.0.0.1:7789";
builder.WebHost.UseUrls(urls);
// push 请求体硬上限（超出 → 413 E_SYNC_BATCH_TOO_LARGE；handler 另有 Content-Length 快检）
builder.WebHost.ConfigureKestrel(options => options.Limits.MaxRequestBodySize = SyncHttp.MaxPushBodyBytes);

var dataDir = Environment.GetEnvironmentVariable("CYRENE_CLOUD_DATA")
    ?? Path.Combine(AppContext.BaseDirectory, "data");
builder.Services.AddSingleton(new EventStore(Path.Combine(dataDir, "events.db")));

var app = builder.Build();

var bearer = Environment.GetEnvironmentVariable("CLOUD_TOKEN");
if (!string.IsNullOrEmpty(bearer))
{
    var expected = Encoding.UTF8.GetBytes("Bearer " + bearer);
    app.Use(async (context, next) =>
    {
        if (!context.Request.Path.StartsWithSegments("/v1"))
        {
            await next();
            return;
        }
        var provided = Encoding.UTF8.GetBytes(context.Request.Headers.Authorization.ToString());
        if (!CryptographicOperations.FixedTimeEquals(provided, expected))
        {
            context.Response.StatusCode = StatusCodes.Status401Unauthorized;
            await context.Response.WriteAsJsonAsync(new { code = SyncHttp.Unauthorized });
            return;
        }
        await next();
    });
}

app.MapGet("/healthz", (EventStore store) =>
{
    using var process = Process.GetCurrentProcess();
    return Results.Json(new
    {
        status = "ok",
        rssMB = Math.Round(process.WorkingSet64 / 1024.0 / 1024.0, 1),
        events = store.Count(),
    });
});

var sync = app.MapGroup("/v1/sync");

// POST /v1/sync/push：body = JSONL 事件批（协议 v0 读取语义）→ 整批校验（含链/序号）→
// 幂等插入（event_id 首见生效）→ 原子提交；任一错误整批回滚（400）。
sync.MapPost("/push", async (HttpContext context, EventStore store) =>
{
    if (context.Request.ContentLength is > SyncHttp.MaxPushBodyBytes)
    {
        return Results.Json(new { code = SyncHttp.BatchTooLarge }, statusCode: StatusCodes.Status413PayloadTooLarge);
    }
    using var reader = new StreamReader(context.Request.Body, Encoding.UTF8);
    var text = await reader.ReadToEndAsync(context.RequestAborted);
    var batch = SyncProtocolV0.ReadBatch(text);
    if (batch.TruncatedTail || batch.Errors.Count > 0)
    {
        return Results.BadRequest(new
        {
            code = SyncHttp.BatchInvalid,
            truncatedTail = batch.TruncatedTail,
            errors = batch.Errors,
        });
    }
    var outcome = await store.PushBatchAsync(batch.Events, context.RequestAborted);
    if (outcome.Errors.Count > 0)
    {
        return Results.BadRequest(new { code = SyncHttp.BatchRejected, errors = outcome.Errors });
    }
    return Results.Json(new
    {
        accepted = outcome.Accepted,
        duplicates = outcome.Duplicates,
        cursor = outcome.Cursor.ToString(),
    });
});

// GET /v1/sync/fetch?since=&limit=&sessionId=：插入序增量（cursor 不透明，客户端原样回传）。
sync.MapGet("/fetch", (EventStore store, string? since, int? limit, string? sessionId) =>
{
    if (!long.TryParse(since ?? "0", out var sinceId) || sinceId < 0)
    {
        return Results.BadRequest(new { code = SyncHttp.Cursor });
    }
    var outcome = store.Fetch(sinceId, Math.Clamp(limit ?? 200, 1, 1000), sessionId);
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
    try
    {
        foreach (var syncEvent in store.StreamAll(sessionId, cursor))
        {
            await JsonSerializer.SerializeAsync(context.Response.Body, syncEvent, options, context.RequestAborted);
            await context.Response.Body.WriteAsync(newline, context.RequestAborted);
        }
    }
    catch (OperationCanceledException)
    {
        // 客户端断开：正常终止流（X-Sync-Cursor 已发出，客户端可凭已收数据续 fetch）
    }
    catch (IOException)
    {
        // 连接中断（写失败）：同上
    }
});

app.Run();

/// <summary>同步 HTTP 层的错误码与请求约束（集中定义，避免裸字面量）。</summary>
internal static class SyncHttp
{
    /// <summary>push 请求体上限（10MB）；超出 → 413 E_SYNC_BATCH_TOO_LARGE（客户端应切小批重推）。</summary>
    public const long MaxPushBodyBytes = 10 * 1024 * 1024;

    public const string Unauthorized = "E_UNAUTHORIZED";
    public const string BatchInvalid = "E_SYNC_BATCH_INVALID";
    public const string BatchTooLarge = "E_SYNC_BATCH_TOO_LARGE";
    public const string BatchRejected = "E_SYNC_BATCH_REJECTED";
    public const string Cursor = "E_SYNC_CURSOR";
}

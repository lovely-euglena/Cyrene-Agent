using CyreneCloud.Storage;
using Microsoft.AspNetCore.Http;

namespace CyreneCloud.Webhook;

/// <summary>
/// Webhook 入站公开路由（IKKIZR）：<c>POST /v1/webhook/{endpointId}</c>。
///
/// 该路由加入鉴权中间件豁免名单（与飞书 webhook 同级，Program.cs）；自带 HMAC 签名 +
/// 时间戳新鲜度校验（见 WebhookInboundProcessor）；限流复用 sync 桶；事件经
/// ServerEventWriter 入流（deviceId="server"，幂等 eventId）。
///
/// 响应：200 {accepted, duplicate, eventId} / 401（验签失败）/ 404（未知 endpoint）/ 413（超限）。
///
/// 注意：处理函数显式返回 Task 并直接写响应——返回 Task&lt;IResult&gt; 经方法组转换会命中
/// MapPost(pattern, RequestDelegate) 重载导致返回值被丢弃（同飞书端点实测教训）。
/// </summary>
public static class WebhookInboundEndpoint
{
    /// <summary>路由前缀（无尾斜杠；StartsWithSegments 按 segment 对齐，不误匹配 /v1/webhookfoo）。</summary>
    public const string PathPrefix = "/v1/webhook";

    private const string CodeTooLarge = "E_WEBHOOK_BODY_TOO_LARGE";

    public static void Map(WebApplication app)
    {
        app.MapPost("/v1/webhook/{endpointId}", async (HttpContext context, string endpointId) =>
            {
                var processor = context.RequestServices.GetRequiredService<WebhookInboundProcessor>();
                var endpoint = processor.Options.Find(endpointId);
                if (endpoint is null)
                {
                    await WriteJsonAsync(context, StatusCodes.Status404NotFound, new { code = CloudApi.WebhookEndpointNotFound });
                    return;
                }

                var rawBody = await ReadCappedAsync(context, processor.Options.BodyMaxBytes);
                if (rawBody is null)
                {
                    await WriteJsonAsync(context, StatusCodes.Status413PayloadTooLarge, new { code = CodeTooLarge });
                    return;
                }

                var outcome = processor.Verify(
                    endpoint,
                    context.Request.Headers[WebhookInboundProcessor.TimestampHeader].ToString(),
                    context.Request.Headers[WebhookInboundProcessor.SignatureHeader].ToString(),
                    rawBody);
                if (outcome != WebhookInboundProcessor.VerifyOutcome.Ok)
                {
                    await WriteJsonAsync(context, StatusCodes.Status401Unauthorized, new { code = CloudApi.WebhookSignatureInvalid });
                    return;
                }

                var writer = context.RequestServices.GetRequiredService<ServerEventWriter>();
                var draft = processor.BuildEvent(endpoint, rawBody, DateTimeOffset.UtcNow);
                var result = await writer.AppendAsync(draft, context.RequestAborted);
                if (result.Status == ServerWriteStatus.Failed)
                {
                    await WriteJsonAsync(context, StatusCodes.Status500InternalServerError, new { code = CloudApi.WebhookWriteFailed });
                    return;
                }

                context.Response.StatusCode = StatusCodes.Status200OK;
                await context.Response.WriteAsJsonAsync(new
                {
                    accepted = result.IsWritten,
                    duplicate = result.IsDuplicate,
                    eventId = result.EventId,
                }, context.RequestAborted);
            })
            .RequireRateLimiting("sync");
    }

    /// <summary>带上限的分块读取：无 Content-Length 的 chunked 请求超限即拒，防内存放大（对齐飞书端点）。</summary>
    private static async Task<byte[]?> ReadCappedAsync(HttpContext context, long maxBytes)
    {
        try
        {
            using var buffer = new MemoryStream();
            var chunk = new byte[81920];
            int read;
            while ((read = await context.Request.Body.ReadAsync(chunk.AsMemory(), context.RequestAborted)) > 0)
            {
                if (buffer.Length + read > maxBytes) return null;
                await buffer.WriteAsync(chunk.AsMemory(0, read), context.RequestAborted);
            }
            return buffer.ToArray();
        }
        catch (BadHttpRequestException)
        {
            return null;
        }
    }

    private static Task WriteJsonAsync(HttpContext context, int statusCode, object body)
    {
        context.Response.StatusCode = statusCode;
        return context.Response.WriteAsJsonAsync(body, context.RequestAborted);
    }
}

using CyreneNative.Channels;
using Microsoft.AspNetCore.Http;

namespace CyreneCloud.Channels.Adapters.Feishu;

/// <summary>
/// 飞书 webhook 公开路由接线（§6.2）：
/// <c>POST /v1/channels/feishu/webhook</c>（设计文档同义别名 <c>/events</c>）。
///
/// 该路由加入鉴权中间件豁免名单（与 /v1/pair 同级，Program.cs）；自带
/// Verification Token + 签名 + 时间戳新鲜度校验；Host 白名单由全局 CLOUD_ALLOWED_HOSTS
/// 中间件覆盖；限流复用 sync 桶（按 token 哈希/IP 分区）。
///
/// 注意：处理函数显式返回 <see cref="Task"/> 并直接写响应，而不是返回 <c>Task&lt;IResult&gt;</c>——
/// 后者经方法组转换会命中 <c>MapPost(pattern, RequestDelegate)</c> 重载（Task&lt;IResult&gt; → Task
/// 存在隐式引用转换），返回值被丢弃导致空 200（HTTP 集成抽查实测）。
/// </summary>
public static class FeishuWebhookEndpoint
{
    public const string WebhookPath = "/v1/channels/feishu/webhook";
    public const string AliasPath = "/v1/channels/feishu/events";

    /// <summary>webhook 请求体上限（事件体远小于此；超限直接 413）。</summary>
    public const long MaxBodyBytes = 1024 * 1024;

    public static void Map(WebApplication app)
    {
        app.MapPost(WebhookPath, HandleAsync).RequireRateLimiting("sync");
        app.MapPost(AliasPath, HandleAsync).RequireRateLimiting("sync");
    }

    public static async Task HandleAsync(HttpContext context)
    {
        if (context.Request.ContentLength is > MaxBodyBytes)
        {
            await WriteJsonAsync(context, StatusCodes.Status413PayloadTooLarge, new { code = "E_FEISHU_BODY_TOO_LARGE" });
            return;
        }
        byte[] rawBody;
        try
        {
            using var buffer = new MemoryStream();
            await context.Request.Body.CopyToAsync(buffer, context.RequestAborted);
            if (buffer.Length > MaxBodyBytes)
            {
                await WriteJsonAsync(context, StatusCodes.Status413PayloadTooLarge, new { code = "E_FEISHU_BODY_TOO_LARGE" });
                return;
            }
            rawBody = buffer.ToArray();
        }
        catch (BadHttpRequestException)
        {
            // chunked（无 Content-Length）到读取时才触顶
            await WriteJsonAsync(context, StatusCodes.Status413PayloadTooLarge, new { code = "E_FEISHU_BODY_TOO_LARGE" });
            return;
        }

        var processor = context.RequestServices.GetRequiredService<FeishuWebhookProcessor>();
        var outcome = await processor.HandleAsync(
            new FeishuWebhookRequest(
                Header(context, "X-Lark-Request-Timestamp"),
                Header(context, "X-Lark-Request-Nonce"),
                Header(context, "X-Lark-Signature"),
                rawBody),
            processInline: false,
            context.RequestAborted);
        context.Response.StatusCode = outcome.StatusCode;
        await context.Response.WriteAsJsonAsync(outcome.Body, ChannelJson.Options, context.RequestAborted);
    }

    private static Task WriteJsonAsync(HttpContext context, int statusCode, object body)
    {
        context.Response.StatusCode = statusCode;
        return context.Response.WriteAsJsonAsync(body, ChannelJson.Options, context.RequestAborted);
    }

    private static string? Header(HttpContext context, string name)
    {
        var value = context.Request.Headers[name].ToString();
        return string.IsNullOrEmpty(value) ? null : value;
    }
}

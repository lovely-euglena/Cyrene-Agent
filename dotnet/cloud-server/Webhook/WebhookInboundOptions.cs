using System.Text.Json;

namespace CyreneCloud.Webhook;

/// <summary>
/// Webhook 入站端点配置（IKKIZR 批次 1：静态 env 声明；动态注册管理 API 属后续批次）。
///
/// <c>CLOUD_WEBHOOK_ENDPOINTS</c>：JSON 数组，<c>[{"id":"ci","secret":"&lt;≥16字符&gt;","source":"github-actions"}]</c>；
/// - id：endpoint 标识（路由段 <c>/v1/webhook/{id}</c>；[a-zA-Z0-9_-] 1..64，需唯一）；
/// - secret：HMAC-SHA256 密钥（≥16 字符；请求头校验见 WebhookInboundProcessor）；
/// - source：可选来源标签，随事件 payload 透传（不参与校验）。
/// 空缺省 = 入站 webhook 整体关闭（不挂路由，capabilities 不声明）。
/// </summary>
public sealed class WebhookInboundOptions
{
    /// <summary>请求体字节上限（CLOUD_WEBHOOK_BODY_MAX_BYTES，默认 256KB）。</summary>
    public long BodyMaxBytes { get; init; } = 256 * 1024;

    /// <summary>签名时间戳容差秒（CLOUD_WEBHOOK_TOLERANCE_SECONDS，默认 ±300s）。</summary>
    public int TimestampToleranceSeconds { get; init; } = 300;

    public IReadOnlyList<WebhookEndpoint> Endpoints { get; init; } = [];

    public static WebhookInboundOptions FromEnvironment()
    {
        var raw = Environment.GetEnvironmentVariable("CLOUD_WEBHOOK_ENDPOINTS");
        var endpoints = new List<WebhookEndpoint>();
        if (!string.IsNullOrWhiteSpace(raw))
        {
            using var document = JsonDocument.Parse(raw);
            foreach (var element in document.RootElement.EnumerateArray())
            {
                var id = element.TryGetProperty("id", out var idElement) ? idElement.GetString() : null;
                var secret = element.TryGetProperty("secret", out var secretElement) ? secretElement.GetString() : null;
                var source = element.TryGetProperty("source", out var sourceElement) ? sourceElement.GetString() : null;
                endpoints.Add(new WebhookEndpoint(id ?? "", secret ?? "", string.IsNullOrWhiteSpace(source) ? null : source));
            }
        }
        return new WebhookInboundOptions
        {
            BodyMaxBytes = ReadPositiveLong("CLOUD_WEBHOOK_BODY_MAX_BYTES", 256 * 1024),
            TimestampToleranceSeconds = (int)ReadPositiveLong("CLOUD_WEBHOOK_TOLERANCE_SECONDS", 300),
            Endpoints = endpoints,
        };
    }

    /// <summary>配置完整性检查：id 合法且唯一、secret 长度达标；不合法项直接拒绝启动（fail-fast）。</summary>
    public IReadOnlyList<string> Validate()
    {
        var errors = new List<string>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        for (var i = 0; i < Endpoints.Count; i++)
        {
            var endpoint = Endpoints[i];
            if (endpoint.Id.Length is < 1 or > 64 || !endpoint.Id.All(IsIdChar))
            {
                errors.Add($"endpoints[{i}].id 非法（要求 [a-zA-Z0-9_-] 1..64）：{endpoint.Id}");
                continue;
            }
            if (!seen.Add(endpoint.Id))
            {
                errors.Add($"endpoints[{i}].id 重复：{endpoint.Id}");
            }
            if (endpoint.Secret.Length < 16)
            {
                errors.Add($"endpoints[{i}].secret 过短（≥16 字符）");
            }
        }
        return errors;
    }

    public WebhookEndpoint? Find(string endpointId) =>
        Endpoints.FirstOrDefault(item => item.Id == endpointId);

    private static bool IsIdChar(char c) =>
        char.IsAsciiLetterOrDigit(c) || c is '_' or '-';

    private static long ReadPositiveLong(string name, long fallback) =>
        long.TryParse(Environment.GetEnvironmentVariable(name), out var value) && value > 0 ? value : fallback;
}

/// <summary>单个入站端点。</summary>
public sealed record WebhookEndpoint(string Id, string Secret, string? Source);

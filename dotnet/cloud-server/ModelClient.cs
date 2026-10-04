using System.Text.Json;

namespace CyreneCloud.Dialog;

/// <summary>
/// OpenAI 兼容 Chat Completions 最小客户端（IKJK2M）。密钥只在服务端（env → 内存），
/// 不落库、不写日志（调用方只记录模型名与 token 用量）。
/// </summary>
public sealed class ModelClient
{
    public sealed record ChatMessage(string Role, string Content);

    public sealed record Completion(string Text, int? PromptTokens, int? CompletionTokens);

    private readonly HttpClient _http;
    private readonly int _maxTokens;

    /// <summary>CLOUD_LLM_API_KEY 与 CLOUD_LLM_MODEL 均非空时启用服务端生成。</summary>
    public bool Enabled { get; }

    public string ModelName { get; }

    public ModelClient(string? apiKey, string? model, string? baseUrl, int timeoutSeconds, int maxTokens)
    {
        ModelName = string.IsNullOrEmpty(model) ? "unset" : model;
        Enabled = !string.IsNullOrEmpty(apiKey) && !string.IsNullOrEmpty(model);
        _maxTokens = maxTokens;
        var normalized = string.IsNullOrEmpty(baseUrl) ? "https://api.openai.com/v1/" : baseUrl.TrimEnd('/') + "/";
        _http = new HttpClient
        {
            BaseAddress = new Uri(normalized),
            Timeout = TimeSpan.FromSeconds(timeoutSeconds),
        };
        if (!string.IsNullOrEmpty(apiKey))
        {
            _http.DefaultRequestHeaders.Authorization =
                new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", apiKey);
        }
    }

    public async Task<Completion> CompleteAsync(IReadOnlyList<ChatMessage> messages, CancellationToken cancellationToken)
    {
        var payload = new
        {
            model = ModelName,
            messages = messages.Select(item => new { role = item.Role, content = item.Content }).ToArray(),
            max_tokens = _maxTokens,
        };
        // 显式字节体（Content-Length 确定）：避免 chunked，兼容严格反代/自建服务端
        var json = JsonSerializer.SerializeToUtf8Bytes(payload);
        using var body = new ByteArrayContent(json);
        body.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue("application/json");
        using var response = await _http.PostAsync("chat/completions", body, cancellationToken);
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var document = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);
        var root = document.RootElement;

        var text = "";
        if (root.TryGetProperty("choices", out var choices) && choices.GetArrayLength() > 0
            && choices[0].TryGetProperty("message", out var message)
            && message.ValueKind == JsonValueKind.Object
            && message.TryGetProperty("content", out var content) && content.ValueKind == JsonValueKind.String)
        {
            text = content.GetString() ?? "";
        }

        int? promptTokens = null;
        int? completionTokens = null;
        if (root.TryGetProperty("usage", out var usage))
        {
            if (usage.TryGetProperty("prompt_tokens", out var prompt) && prompt.ValueKind == JsonValueKind.Number)
            {
                promptTokens = prompt.GetInt32();
            }
            if (usage.TryGetProperty("completion_tokens", out var completion) && completion.ValueKind == JsonValueKind.Number)
            {
                completionTokens = completion.GetInt32();
            }
        }
        return new Completion(text, promptTokens, completionTokens);
    }
}

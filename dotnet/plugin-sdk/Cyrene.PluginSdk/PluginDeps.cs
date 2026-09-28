using System.Text.Json;

namespace Cyrene.PluginSdk;

/// <summary>
/// 宿主服务集合（<see cref="CyrenePluginBase.Deps"/>），对应 manifest 的 <c>deps</c> 声明。
/// <list type="bullet">
/// <item>未在 manifest.deps 声明就调用具体方法会抛 <see cref="NotSupportedException"/>（与 Node 轨“未注入即不可用”一致）；</item>
/// <item>宿主侧错误以 <see cref="PluginHostException"/> 抛出，<c>Code</c> 与 Node 轨 E_* 错误码一致。</item>
/// </list>
/// </summary>
public sealed class PluginDeps
{
    /// <summary>渠道发现（deps: channels）。</summary>
    public PluginChannelsService Channels { get; }

    /// <summary>宿主模型服务（deps: llm）。</summary>
    public PluginLlmService Llm { get; }

    /// <summary>宿主安全存储（deps: secrets）。</summary>
    public PluginSecretsService Secrets { get; }

    /// <summary>只读会话（deps: conversations）。</summary>
    public PluginConversationsService Conversations { get; }

    /// <summary>只读工作区绑定（deps: workspace）。</summary>
    public PluginWorkspaceService Workspace { get; }

    /// <summary>插件定时任务（deps: scheduler）。</summary>
    public PluginSchedulerService Scheduler { get; }

    internal PluginDeps(CyrenePluginBase plugin)
    {
        Channels = new PluginChannelsService(plugin);
        Llm = new PluginLlmService(plugin);
        Secrets = new PluginSecretsService(plugin);
        Conversations = new PluginConversationsService(plugin);
        Workspace = new PluginWorkspaceService(plugin);
        Scheduler = new PluginSchedulerService(plugin);
    }
}

/// <summary>内部工具：deps reply 数据的反序列化收口（null → default / 空列表）。</summary>
internal static class DepResult
{
    internal static T? To<T>(JsonElement? data) where T : class
        => data is null || data.Value.ValueKind == JsonValueKind.Null
            ? null
            : data.Value.Deserialize<T>(CyrenePluginBase.JsonOptions);

    internal static List<T> ToList<T>(JsonElement? data)
        => data is null || data.Value.ValueKind == JsonValueKind.Null
            ? []
            : data.Value.Deserialize<List<T>>(CyrenePluginBase.JsonOptions) ?? [];

    internal static string? ToStringOrNull(JsonElement? data)
        => data is null || data.Value.ValueKind == JsonValueKind.Null ? null : data.Value.GetString();

    internal static bool ToBool(JsonElement? data) => data is { ValueKind: JsonValueKind.True };
}

// ── channels（只读发现） ──

/// <summary>渠道发现服务：只读查询宿主是否已注册某渠道。</summary>
public sealed class PluginChannelsService
{
    private readonly CyrenePluginBase _plugin;
    internal PluginChannelsService(CyrenePluginBase plugin) => _plugin = plugin;

    /// <summary>宿主是否已注册该渠道（id 形如 feishu / telegram）。</summary>
    public async Task<bool> HasAsync(string channelId, CancellationToken ct = default)
    {
        _plugin.RequireDep("channels");
        if (string.IsNullOrEmpty(channelId)) throw new ArgumentException("channelId 不能为空", nameof(channelId));
        var data = await _plugin.CallHostAsync("deps.channels.has", new { channelId }, ct).ConfigureAwait(false);
        return DepResult.ToBool(data);
    }
}

// ── llm（宿主模型服务） ──

/// <summary>一条 LLM 消息（role: system / user / assistant）。</summary>
public sealed class LlmMessage
{
    /// <summary>角色：system / user / assistant。</summary>
    public required string Role { get; init; }

    /// <summary>消息正文。</summary>
    public required string Content { get; init; }
}

/// <summary>generateText 选项；缺省走宿主默认（约 1024 token / 120s 超时上限）。</summary>
public sealed class LlmGenerateOptions
{
    /// <summary>1-8192，缺省 1024。</summary>
    public int? MaxTokens { get; init; }

    /// <summary>1000-300000 ms；缺省为宿主聊天超时（上限 120s）。</summary>
    public int? TimeoutMs { get; init; }

    /// <summary>用量归因标签（宿主会补 plugin:&lt;id&gt;: 前缀）。</summary>
    public string? Purpose { get; init; }
}

/// <summary>宿主模型服务：复用 Cyrene 已配置的模型（排队/限流/重试/用量统计全走宿主）。</summary>
public sealed class PluginLlmService
{
    private readonly CyrenePluginBase _plugin;
    internal PluginLlmService(CyrenePluginBase plugin) => _plugin = plugin;

    /// <summary>带上下文生成一段文本并返回结果。</summary>
    public async Task<string> GenerateTextAsync(
        IReadOnlyList<LlmMessage> messages,
        LlmGenerateOptions? options = null,
        CancellationToken ct = default)
    {
        _plugin.RequireDep("llm");
        ArgumentNullException.ThrowIfNull(messages);
        if (messages.Count == 0) throw new ArgumentException("messages 不能为空", nameof(messages));
        var payload = new
        {
            messages = messages.Select(m => new { role = m.Role, content = m.Content }).ToArray(),
            options = options is null
                ? null
                : new { maxTokens = options.MaxTokens, timeoutMs = options.TimeoutMs, purpose = options.Purpose },
        };
        var data = await _plugin.CallHostAsync("deps.llm.generateText", payload, ct).ConfigureAwait(false);
        return DepResult.ToStringOrNull(data) ?? "";
    }
}

// ── secrets（宿主安全存储） ──

/// <summary>插件私有密钥服务：Key 在插件命名空间内隔离，密文由宿主安全存储保管。</summary>
public sealed class PluginSecretsService
{
    private readonly CyrenePluginBase _plugin;
    internal PluginSecretsService(CyrenePluginBase plugin) => _plugin = plugin;

    /// <summary>读取密钥；不存在返回 null。</summary>
    public async Task<string?> GetAsync(string key, CancellationToken ct = default)
    {
        _plugin.RequireDep("secrets");
        AssertKey(key);
        var data = await _plugin.CallHostAsync("deps.secrets.get", new { key }, ct).ConfigureAwait(false);
        return DepResult.ToStringOrNull(data);
    }

    /// <summary>写入密钥（覆盖）；系统安全存储不可用时抛 E_STORAGE_UNAVAILABLE。</summary>
    public async Task SetAsync(string key, string value, CancellationToken ct = default)
    {
        _plugin.RequireDep("secrets");
        AssertKey(key);
        ArgumentNullException.ThrowIfNull(value);
        await _plugin.CallHostAsync("deps.secrets.set", new { key, value }, ct).ConfigureAwait(false);
    }

    /// <summary>删除密钥；不存在的 key 返回 false（幂等）。</summary>
    public async Task<bool> DeleteAsync(string key, CancellationToken ct = default)
    {
        _plugin.RequireDep("secrets");
        AssertKey(key);
        var data = await _plugin.CallHostAsync("deps.secrets.delete", new { key }, ct).ConfigureAwait(false);
        return DepResult.ToBool(data);
    }

    private static void AssertKey(string key)
    {
        if (string.IsNullOrEmpty(key)) throw new ArgumentException("密钥 key 不能为空", nameof(key));
    }
}

// ── conversations（只读会话） ──

/// <summary>会话摘要（列表项）。</summary>
public sealed class ConversationSummary
{
    /// <summary>会话 id。</summary>
    public string Id { get; init; } = "";
    /// <summary>会话标题。</summary>
    public string Title { get; init; } = "";
    /// <summary>会话模式：chat / work / learn / code。</summary>
    public string Mode { get; init; } = "";
    /// <summary>创建时间（ISO 8601）。</summary>
    public string CreatedAt { get; init; } = "";
    /// <summary>最后更新时间（ISO 8601）。</summary>
    public string UpdatedAt { get; init; } = "";
}

/// <summary>会话消息（只含 user/assistant 两种角色与纯文本）。</summary>
public sealed class ConversationMessage
{
    /// <summary>消息 id。</summary>
    public string Id { get; init; } = "";
    /// <summary>角色：user / assistant。</summary>
    public string Role { get; init; } = "";
    /// <summary>纯文本内容。</summary>
    public string Text { get; init; } = "";
    /// <summary>时间（ISO 8601）。</summary>
    public string At { get; init; } = "";
}

/// <summary>会话列表输入。</summary>
public sealed class ConversationListInput
{
    /// <summary>分页游标（上一页返回的 nextCursor）。</summary>
    public string? Cursor { get; init; }
    /// <summary>每页条数。</summary>
    public int? Limit { get; init; }
}

/// <summary>会话分页结果。</summary>
public sealed class ConversationPage
{
    /// <summary>本页会话。</summary>
    public List<ConversationSummary> Items { get; init; } = [];
    /// <summary>下一页游标；null 表示没有更多。</summary>
    public string? NextCursor { get; init; }
}

/// <summary>消息分页输入。</summary>
public sealed class MessagePageInput
{
    /// <summary>会话 id。</summary>
    public required string ConversationId { get; init; }
    /// <summary>分页游标。</summary>
    public string? Cursor { get; init; }
    /// <summary>每页条数。</summary>
    public int? Limit { get; init; }
    /// <summary>包含式起点；与 ThroughMessageId 一起冻结读取范围。</summary>
    public string? FromMessageId { get; init; }
    /// <summary>包含式终点；分页过程中不得越过该消息。</summary>
    public string? ThroughMessageId { get; init; }
}

/// <summary>本次分页实际冻结的包含式边界。</summary>
public sealed class MessageRange
{
    /// <summary>包含式起点。</summary>
    public string? FromMessageId { get; init; }
    /// <summary>包含式终点。</summary>
    public string? ThroughMessageId { get; init; }
}

/// <summary>消息分页结果。</summary>
public sealed class MessagePage
{
    /// <summary>本页消息。</summary>
    public List<ConversationMessage> Items { get; init; } = [];
    /// <summary>下一页游标；null 表示没有更多。</summary>
    public string? NextCursor { get; init; }
    /// <summary>本次分页冻结的范围边界。</summary>
    public MessageRange? Range { get; init; }
}

/// <summary>
/// 只读会话服务。长期记忆插件的标准用法：把桌面轮次结束事件中的
/// inputMessageId / finalMessageId 作为 FromMessageId / ThroughMessageId，
/// 冻结读取范围后翻页不会混入后续轮次的消息。
/// </summary>
public sealed class PluginConversationsService
{
    private readonly CyrenePluginBase _plugin;
    internal PluginConversationsService(CyrenePluginBase plugin) => _plugin = plugin;

    /// <summary>列出会话（按更新时间倒序，游标分页）。</summary>
    public async Task<ConversationPage> ListAsync(ConversationListInput? input = null, CancellationToken ct = default)
    {
        _plugin.RequireDep("conversations");
        object parameters = input is null
            ? new { }
            : new { input = new { cursor = input.Cursor, limit = input.Limit } };
        var data = await _plugin.CallHostAsync("deps.conversations.list", parameters, ct).ConfigureAwait(false);
        return DepResult.To<ConversationPage>(data) ?? new ConversationPage();
    }

    /// <summary>按冻结边界读取某会话的消息页。</summary>
    public async Task<MessagePage> GetMessagesAsync(MessagePageInput input, CancellationToken ct = default)
    {
        _plugin.RequireDep("conversations");
        ArgumentNullException.ThrowIfNull(input);
        if (string.IsNullOrEmpty(input.ConversationId)) throw new ArgumentException("ConversationId 不能为空", nameof(input));
        var payload = new
        {
            input = new
            {
                conversationId = input.ConversationId,
                cursor = input.Cursor,
                limit = input.Limit,
                fromMessageId = input.FromMessageId,
                throughMessageId = input.ThroughMessageId,
            },
        };
        var data = await _plugin.CallHostAsync("deps.conversations.getMessages", payload, ct).ConfigureAwait(false);
        return DepResult.To<MessagePage>(data) ?? new MessagePage();
    }
}

// ── workspace（只读工作区绑定） ──

/// <summary>会话工作区绑定。</summary>
public sealed class WorkspaceBinding
{
    /// <summary>会话 id。</summary>
    public string ConversationId { get; init; } = "";
    /// <summary>工作区根目录。</summary>
    public string Root { get; init; } = "";
    /// <summary>展示名。</summary>
    public string DisplayName { get; init; } = "";
}

/// <summary>受控的工作区只读访问：不提供绑定/解绑/选择目录能力。</summary>
public sealed class PluginWorkspaceService
{
    private readonly CyrenePluginBase _plugin;
    internal PluginWorkspaceService(CyrenePluginBase plugin) => _plugin = plugin;

    /// <summary>读取会话已绑定的工作区；未绑定返回 null。</summary>
    public async Task<WorkspaceBinding?> GetBindingAsync(string conversationId, CancellationToken ct = default)
    {
        _plugin.RequireDep("workspace");
        if (string.IsNullOrEmpty(conversationId)) throw new ArgumentException("conversationId 不能为空", nameof(conversationId));
        var data = await _plugin.CallHostAsync("deps.workspace.getBinding", new { conversationId }, ct).ConfigureAwait(false);
        return DepResult.To<WorkspaceBinding>(data);
    }
}

// ── scheduler（插件定时任务） ──

/// <summary>调度计划；用静态工厂构造（once / daily / weekly / interval）。</summary>
public sealed class ScheduleConfig
{
    /// <summary>计划类型：once / daily / weekly / interval。</summary>
    public required string Kind { get; init; }
    /// <summary>once：执行时间（ISO 8601）。</summary>
    public string? RunAt { get; init; }
    /// <summary>daily/weekly：执行时刻（HH:mm）。</summary>
    public string? TimeOfDay { get; init; }
    /// <summary>weekly：星期（0=周日）。</summary>
    public int? DayOfWeek { get; init; }
    /// <summary>interval：间隔数量。</summary>
    public int? Every { get; init; }
    /// <summary>interval：间隔单位 minutes / hours。</summary>
    public string? Unit { get; init; }

    /// <summary>一次性任务。</summary>
    public static ScheduleConfig Once(string runAt) => new() { Kind = "once", RunAt = runAt };
    /// <summary>每日任务。</summary>
    public static ScheduleConfig Daily(string timeOfDay) => new() { Kind = "daily", TimeOfDay = timeOfDay };
    /// <summary>每周任务（0=周日）。</summary>
    public static ScheduleConfig Weekly(int dayOfWeek, string timeOfDay) => new() { Kind = "weekly", DayOfWeek = dayOfWeek, TimeOfDay = timeOfDay };
    /// <summary>固定间隔任务。</summary>
    public static ScheduleConfig Interval(int every, string unit) => new() { Kind = "interval", Every = every, Unit = unit };
}

/// <summary>创建定时任务的完整执行规格；规格变化会撤销用户已有授权。</summary>
public sealed class ScheduledTaskInput
{
    /// <summary>任务标题（展示用，不影响授权）。</summary>
    public required string Title { get; init; }
    /// <summary>调度计划。</summary>
    public required ScheduleConfig Schedule { get; init; }
    /// <summary>任务提示词。</summary>
    public required string Prompt { get; init; }
    /// <summary>chat / work / learn / code。</summary>
    public required string Mode { get; init; }
    /// <summary>显式工具白名单；插件任务不允许 all-enabled 模式。</summary>
    public required string[] AllowedToolIds { get; init; }
}

/// <summary>任务局部更新；执行规格字段（Schedule/Prompt/Mode/AllowedToolIds）变化会撤销授权。</summary>
public sealed class ScheduledTaskPatch
{
    /// <summary>新标题（不影响授权）。</summary>
    public string? Title { get; init; }
    /// <summary>新计划。</summary>
    public ScheduleConfig? Schedule { get; init; }
    /// <summary>新提示词。</summary>
    public string? Prompt { get; init; }
    /// <summary>新模式。</summary>
    public string? Mode { get; init; }
    /// <summary>新工具白名单。</summary>
    public string[]? AllowedToolIds { get; init; }
}

/// <summary>已创建的计划任务。</summary>
public sealed class ScheduledTask
{
    /// <summary>任务 id。</summary>
    public string Id { get; init; } = "";
    /// <summary>标题。</summary>
    public string Title { get; init; } = "";
    /// <summary>当前计划。</summary>
    public ScheduleConfig? Schedule { get; init; }
    /// <summary>提示词。</summary>
    public string Prompt { get; init; } = "";
    /// <summary>会话模式。</summary>
    public string Mode { get; init; } = "";
    /// <summary>工具白名单。</summary>
    public string[] AllowedToolIds { get; init; } = [];
    /// <summary>有效启用状态；创建后必须由用户在宿主界面确认，插件不能写入。</summary>
    public bool Enabled { get; init; }
    /// <summary>下次触发时间（ISO 8601）；未启用为 null。</summary>
    public string? NextFireAt { get; init; }
    /// <summary>上次触发时间。</summary>
    public string? LastFiredAt { get; init; }
    /// <summary>创建时间。</summary>
    public string CreatedAt { get; init; } = "";
    /// <summary>更新时间。</summary>
    public string UpdatedAt { get; init; } = "";
}

/// <summary>任务执行历史摘要（不含完整模型输出）。</summary>
public sealed class ScheduledTaskHistory
{
    /// <summary>历史记录 id。</summary>
    public string Id { get; init; } = "";
    /// <summary>所属任务 id。</summary>
    public string TaskId { get; init; } = "";
    /// <summary>终态状态。</summary>
    public string Status { get; init; } = "";
    /// <summary>开始时间。</summary>
    public string StartedAt { get; init; } = "";
    /// <summary>结束时间。</summary>
    public string? FinishedAt { get; init; }
    /// <summary>结果摘要。</summary>
    public string? Summary { get; init; }
}

/// <summary>插件调度服务：只能查看和修改自己创建的任务；创建即为停用，需用户授权。</summary>
public sealed class PluginSchedulerService
{
    private readonly CyrenePluginBase _plugin;
    internal PluginSchedulerService(CyrenePluginBase plugin) => _plugin = plugin;

    /// <summary>创建任务（初始为停用，等待用户授权）。</summary>
    public async Task<ScheduledTask> CreateTaskAsync(ScheduledTaskInput input, CancellationToken ct = default)
    {
        _plugin.RequireDep("scheduler");
        ArgumentNullException.ThrowIfNull(input);
        var data = await _plugin.CallHostAsync("deps.scheduler.createTask", new { input }, ct).ConfigureAwait(false);
        return DepResult.To<ScheduledTask>(data) ?? throw new InvalidOperationException("宿主未返回任务");
    }

    /// <summary>列出本插件创建的全部任务。</summary>
    public async Task<IReadOnlyList<ScheduledTask>> ListTasksAsync(CancellationToken ct = default)
    {
        _plugin.RequireDep("scheduler");
        var data = await _plugin.CallHostAsync("deps.scheduler.listTasks", new { }, ct).ConfigureAwait(false);
        return DepResult.ToList<ScheduledTask>(data);
    }

    /// <summary>更新任务（规格变化会撤销授权并回到停用）。</summary>
    public async Task<ScheduledTask> UpdateTaskAsync(string taskId, ScheduledTaskPatch patch, CancellationToken ct = default)
    {
        _plugin.RequireDep("scheduler");
        if (string.IsNullOrEmpty(taskId)) throw new ArgumentException("taskId 不能为空", nameof(taskId));
        ArgumentNullException.ThrowIfNull(patch);
        var data = await _plugin.CallHostAsync("deps.scheduler.updateTask", new { taskId, patch }, ct).ConfigureAwait(false);
        return DepResult.To<ScheduledTask>(data) ?? throw new InvalidOperationException("宿主未返回任务");
    }

    /// <summary>删除任务。</summary>
    public async Task<bool> DeleteTaskAsync(string taskId, CancellationToken ct = default)
    {
        _plugin.RequireDep("scheduler");
        if (string.IsNullOrEmpty(taskId)) throw new ArgumentException("taskId 不能为空", nameof(taskId));
        var data = await _plugin.CallHostAsync("deps.scheduler.deleteTask", new { taskId }, ct).ConfigureAwait(false);
        return DepResult.ToBool(data);
    }

    /// <summary>读取任务执行历史（缺省宿主上限 10 条）。</summary>
    public async Task<IReadOnlyList<ScheduledTaskHistory>> GetHistoryAsync(
        string taskId,
        int? limit = null,
        CancellationToken ct = default)
    {
        _plugin.RequireDep("scheduler");
        if (string.IsNullOrEmpty(taskId)) throw new ArgumentException("taskId 不能为空", nameof(taskId));
        var data = await _plugin.CallHostAsync("deps.scheduler.getHistory", new { taskId, limit }, ct).ConfigureAwait(false);
        return DepResult.ToList<ScheduledTaskHistory>(data);
    }
}

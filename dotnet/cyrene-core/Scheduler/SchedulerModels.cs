using System.Globalization;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace CyreneNative.Scheduler;

/// <summary>
/// 定时任务调度核心（cyrene-core）——类型 / DTO / 共享 JSON 工具。
///
/// 契约权威：src/main/scheduler/types.ts（字段名与语义一一对应；ISO 时间在 DTO
/// 中保持字符串以保真）。序列化口径：JsonSerializerDefaults.Web（camelCase），
/// ScheduleConfig 输出与 TS 同形 JSON（如 daily={kind,timeOfDay}、
/// interval={kind,every,unit}）。可选字段用 WhenWritingNull 省略（对应 TS
/// undefined 不落盘），nextFireAt 例外——必须显式写 null（TS 文件格式如此）。
/// 本文件同时承载设计文档中的 SchedulerJson 职责（受交付文件清单约束）。
/// </summary>
public static class SchedulerJson
{
    /// <summary>共享序列化选项（Web defaults = camelCase + 大小写不敏感读取）。
    /// Encoder 关闭非 ASCII 转义：中文标题/原因与 TS JSON.stringify 输出一致
    ///（复审 P2-2；仓库既有模式见 WebSearchTool/ExpenseTools）。</summary>
    public static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web)
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    /// <summary>TS `new Date(0).toISOString()`：旧任务缺失 createdAt/updatedAt 的兜底。</summary>
    public const string EpochIso = "1970-01-01T00:00:00.000Z";

    /// <summary>与 JS Date#toISOString() 同形：yyyy-MM-ddTHH:mm:ss.fffZ（UTC）。</summary>
    public static string ToIsoString(DateTimeOffset value)
        => value.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);

    public static string? ToIsoStringOrNull(DateTimeOffset? value)
        => value is { } v ? ToIsoString(v) : null;

    /// <summary>
    /// 解析 ISO 时间（对齐 `new Date(value)` 的常用输入：带 Z/偏移或本地墙钟）。
    /// 失败返回 false（TS 侧为 Invalid Date / NaN）。
    /// </summary>
    public static bool TryParseIso(string? value, out DateTimeOffset result)
    {
        result = default;
        if (string.IsNullOrEmpty(value)) return false;
        return DateTimeOffset.TryParse(
            value,
            CultureInfo.InvariantCulture,
            DateTimeStyles.AllowWhiteSpaces,
            out result);
    }
}

/// <summary>调度类型（types.ts 的 ScheduleKind 字符串联合）。</summary>
[JsonConverter(typeof(ScheduleKindJsonConverter))]
public enum ScheduleKind
{
    Once,
    Daily,
    Weekdays,
    Weekly,
    Monthly,
    Yearly,
    Interval,
}

/// <summary>严格读写：未知 kind 在加载时抛 JsonException → 该任务被丢弃（同 TS validateSchedule 拒绝）。</summary>
public sealed class ScheduleKindJsonConverter : JsonConverter<ScheduleKind>
{
    public override ScheduleKind Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        if (reader.TokenType != JsonTokenType.String)
            throw new JsonException("调度类型必须是字符串");
        return reader.GetString() switch
        {
            "once" => ScheduleKind.Once,
            "daily" => ScheduleKind.Daily,
            "weekdays" => ScheduleKind.Weekdays,
            "weekly" => ScheduleKind.Weekly,
            "monthly" => ScheduleKind.Monthly,
            "yearly" => ScheduleKind.Yearly,
            "interval" => ScheduleKind.Interval,
            var other => throw new JsonException($"未知调度类型: {other}"),
        };
    }

    public override void Write(Utf8JsonWriter writer, ScheduleKind value, JsonSerializerOptions options)
        => writer.WriteStringValue(value switch
        {
            ScheduleKind.Once => "once",
            ScheduleKind.Daily => "daily",
            ScheduleKind.Weekdays => "weekdays",
            ScheduleKind.Weekly => "weekly",
            ScheduleKind.Monthly => "monthly",
            ScheduleKind.Yearly => "yearly",
            ScheduleKind.Interval => "interval",
            _ => throw new JsonException("未知调度类型"),
        });
}

/// <summary>interval 的单位（types.ts 的 "minutes" | "hours"）。</summary>
[JsonConverter(typeof(IntervalUnitJsonConverter))]
public enum IntervalUnit
{
    Minutes,
    Hours,
}

public sealed class IntervalUnitJsonConverter : JsonConverter<IntervalUnit>
{
    public override IntervalUnit Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        if (reader.TokenType != JsonTokenType.String)
            throw new JsonException("间隔单位必须是字符串");
        return reader.GetString() switch
        {
            "minutes" => IntervalUnit.Minutes,
            "hours" => IntervalUnit.Hours,
            var other => throw new JsonException($"间隔单位无效: {other}"),
        };
    }

    public override void Write(Utf8JsonWriter writer, IntervalUnit value, JsonSerializerOptions options)
        => writer.WriteStringValue(value == IntervalUnit.Minutes ? "minutes" : "hours");
}

/// <summary>
/// 工具模式（types.ts 的 "all-enabled" | "allow-list"）。
/// 读取宽松：非 "allow-list" 一律归一为 all-enabled（同 TS normalizeToolMode）。
/// </summary>
[JsonConverter(typeof(SchedulerToolModeJsonConverter))]
public enum SchedulerToolMode
{
    AllEnabled,
    AllowList,
}

public sealed class SchedulerToolModeJsonConverter : JsonConverter<SchedulerToolMode>
{
    public override SchedulerToolMode Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
        => reader.TokenType == JsonTokenType.String && reader.GetString() == "allow-list"
            ? SchedulerToolMode.AllowList
            : SchedulerToolMode.AllEnabled;

    public override void Write(Utf8JsonWriter writer, SchedulerToolMode value, JsonSerializerOptions options)
        => writer.WriteStringValue(value == SchedulerToolMode.AllowList ? "allow-list" : "all-enabled");
}

/// <summary>会话模式常量（types.ts 经 plugins/api 引用的 PluginPromptMode 字符串联合）。</summary>
public static class PluginPromptModes
{
    public const string Chat = "chat";
    public const string Work = "work";
    public const string Learn = "learn";
    public const string Code = "code";

    /// <summary>对齐 TS normalizeMode：未知 / 缺失返回 null。</summary>
    public static string? Normalize(string? value)
        => value is Chat or Work or Learn or Code ? value : null;
}

/// <summary>历史条目状态常量（types.ts 的 status 字符串联合）。</summary>
public static class ScheduledTaskHistoryStatus
{
    public const string Running = "running";
    public const string Success = "success";
    public const string Failed = "failed";
    public const string Skipped = "skipped";
}

/// <summary>
/// 排期配置：单类承载 TS 的判别联合；未用字段为 null 且不落盘，
/// 因此 daily 输出 {kind,timeOfDay}、interval 输出 {kind,every,unit}。
/// </summary>
public sealed class ScheduleConfig
{
    [JsonPropertyOrder(0)]
    public ScheduleKind Kind { get; set; }

    [JsonPropertyOrder(1)]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? RunAt { get; set; }

    [JsonPropertyOrder(3)]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? TimeOfDay { get; set; }

    [JsonPropertyOrder(2)]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? DayOfWeek { get; set; }

    [JsonPropertyOrder(2)]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? DayOfMonth { get; set; }

    [JsonPropertyOrder(1)]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? Month { get; set; }

    [JsonPropertyOrder(1)]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? Every { get; set; }

    [JsonPropertyOrder(2)]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public IntervalUnit? Unit { get; set; }

    public static ScheduleConfig Once(string runAt) => new() { Kind = ScheduleKind.Once, RunAt = runAt };
    public static ScheduleConfig Daily(string timeOfDay) => new() { Kind = ScheduleKind.Daily, TimeOfDay = timeOfDay };
    public static ScheduleConfig Weekdays(string timeOfDay) => new() { Kind = ScheduleKind.Weekdays, TimeOfDay = timeOfDay };
    public static ScheduleConfig Weekly(int dayOfWeek, string timeOfDay) => new() { Kind = ScheduleKind.Weekly, DayOfWeek = dayOfWeek, TimeOfDay = timeOfDay };
    public static ScheduleConfig Monthly(int dayOfMonth, string timeOfDay) => new() { Kind = ScheduleKind.Monthly, DayOfMonth = dayOfMonth, TimeOfDay = timeOfDay };
    public static ScheduleConfig Yearly(int month, int dayOfMonth, string timeOfDay) => new() { Kind = ScheduleKind.Yearly, Month = month, DayOfMonth = dayOfMonth, TimeOfDay = timeOfDay };
    public static ScheduleConfig Interval(int every, IntervalUnit unit) => new() { Kind = ScheduleKind.Interval, Every = every, Unit = unit };
}

/// <summary>用户任务冻结的会话工作区（shared/chat-types.ts 的 ConversationWorkspaceBinding）。</summary>
public sealed class WorkspaceBinding
{
    public string WorkspaceRoot { get; set; } = "";
    public string DisplayName { get; set; } = "";
    /// <summary>绑定时刻（Unix 毫秒，TS number）。</summary>
    public double BoundAt { get; set; }
}

/// <summary>ScheduledTask（types.ts）：字段名 / 语义一一对应。</summary>
public sealed class ScheduledTask
{
    public string Id { get; set; } = "";
    public string Title { get; set; } = "";
    public string Prompt { get; set; } = "";
    public bool Enabled { get; set; }
    public ScheduleConfig Schedule { get; set; } = new();
    /// <summary>ISO 字符串；显式 null 必须落盘（TS 文件格式）。</summary>
    public string? NextFireAt { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? RunCount { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? MaxRuns { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? EndAt { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? LastFiredAt { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public WorkspaceBinding? WorkspaceBinding { get; set; }

    public SchedulerToolMode ToolMode { get; set; } = SchedulerToolMode.AllEnabled;
    public List<string> AllowedToolIds { get; set; } = new();
    public string CreatedAt { get; set; } = "";
    public string UpdatedAt { get; set; } = "";

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? OwnerPluginId { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public bool? PluginUserEnabled { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Mode { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? ApprovalFingerprint { get; set; }

    public ScheduledTask Clone() => new()
    {
        Id = Id,
        Title = Title,
        Prompt = Prompt,
        Enabled = Enabled,
        Schedule = Schedule,
        NextFireAt = NextFireAt,
        RunCount = RunCount,
        MaxRuns = MaxRuns,
        EndAt = EndAt,
        LastFiredAt = LastFiredAt,
        WorkspaceBinding = WorkspaceBinding,
        ToolMode = ToolMode,
        AllowedToolIds = new List<string>(AllowedToolIds),
        CreatedAt = CreatedAt,
        UpdatedAt = UpdatedAt,
        OwnerPluginId = OwnerPluginId,
        PluginUserEnabled = PluginUserEnabled,
        Mode = Mode,
        ApprovalFingerprint = ApprovalFingerprint,
    };
}

/// <summary>NewScheduledTaskInput（types.ts）。</summary>
public sealed class NewScheduledTaskInput
{
    public string? Title { get; set; }
    public string? Prompt { get; set; }
    public bool? Enabled { get; set; }
    public ScheduleConfig? Schedule { get; set; }
    public int? MaxRuns { get; set; }
    public string? EndAt { get; set; }
    public SchedulerToolMode? ToolMode { get; set; }
    public List<string>? AllowedToolIds { get; set; }
    public WorkspaceBinding? WorkspaceBinding { get; set; }
    public string? OwnerPluginId { get; set; }
    public bool? PluginUserEnabled { get; set; }
    public string? Mode { get; set; }
    public string? ApprovalFingerprint { get; set; }
}

/// <summary>
/// ScheduledTaskPatch（types.ts 的 Partial&lt;Pick&lt;…&gt;&gt;）。
/// null = 未提供；需要「显式清空」语义的字段（nextFireAt / maxRuns / endAt /
/// workspaceBinding）额外记录是否出现（HasXxx），对齐 TS 的 undefined vs null 区分。
/// </summary>
public sealed class ScheduledTaskPatch
{
    public string? Title { get; set; }
    public string? Prompt { get; set; }
    public bool? Enabled { get; set; }
    public ScheduleConfig? Schedule { get; set; }
    public string? LastFiredAt { get; set; }
    public SchedulerToolMode? ToolMode { get; set; }
    public List<string>? AllowedToolIds { get; set; }
    public bool? PluginUserEnabled { get; set; }
    public string? ApprovalFingerprint { get; set; }
    public string? Mode { get; set; }

    private string? _nextFireAt;
    public string? NextFireAt
    {
        get => _nextFireAt;
        set { _nextFireAt = value; HasNextFireAt = true; }
    }

    [JsonIgnore]
    public bool HasNextFireAt { get; private set; }

    private int? _maxRuns;
    public int? MaxRuns
    {
        get => _maxRuns;
        set { _maxRuns = value; HasMaxRuns = true; }
    }

    [JsonIgnore]
    public bool HasMaxRuns { get; private set; }

    private string? _endAt;
    public string? EndAt
    {
        get => _endAt;
        set { _endAt = value; HasEndAt = true; }
    }

    [JsonIgnore]
    public bool HasEndAt { get; private set; }

    private WorkspaceBinding? _workspaceBinding;
    public WorkspaceBinding? WorkspaceBinding
    {
        get => _workspaceBinding;
        set { _workspaceBinding = value; HasWorkspaceBinding = true; }
    }

    [JsonIgnore]
    public bool HasWorkspaceBinding { get; private set; }
}

/// <summary>ScheduledTaskHistoryEntry（types.ts）。</summary>
public sealed class ScheduledTaskHistoryEntry
{
    public string Id { get; set; } = "";
    public string TaskId { get; set; } = "";
    public string TaskTitle { get; set; } = "";
    public string FiredAt { get; set; } = "";

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? FinishedAt { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public double? DurationMs { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Status { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Reason { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? OutputPreview { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? ErrorMessage { get; set; }

    public List<string> EffectiveToolIds { get; set; } = new();

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? SessionId { get; set; }
}

/// <summary>ScheduledRunResult（types.ts）。</summary>
public sealed class SchedulerRunResult
{
    public bool Ok { get; set; }
    public string HistoryId { get; set; } = "";
    public string? Reply { get; set; }
    public string? Error { get; set; }
    public List<string> EffectiveToolIds { get; set; } = new();
}

/// <summary>FireNow 结果（TS `{ok, reason?}`）。</summary>
public readonly record struct FireNowResult(bool Ok, string? Reason = null);

/// <summary>校验失败（对齐 TS 抛 Error；消息与 TS 逐字一致，便于对照测试）。</summary>
public sealed class SchedulerValidationException : Exception
{
    public SchedulerValidationException(string message) : base(message) { }
}

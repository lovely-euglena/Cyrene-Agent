using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace CyreneNative.Tools;

/// <summary>
/// 通用 double 序列化保护：NaN / ±Infinity 按 TS JSON.stringify 语义写成 null。
///
/// 背景（Bug，agent-loop 冒烟 P3）：calculator 对 sqrt(-1) 返回 double.NaN，
/// System.Text.Json 默认拒绝序列化 → JsonException 被 WriteFrame 静默吞掉 →
/// result 帧根本不发 → 调用方挂到超时。TS 侧 JSON.stringify(NaN) 得到 null，
/// 两侧语义对齐 + 消除序列化崩溃。
/// </summary>
internal sealed class SafeDoubleJsonConverter : JsonConverter<double>
{
    public override double Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
        => reader.TryGetDouble(out var value) ? value : double.NaN;

    public override void Write(Utf8JsonWriter writer, double value, JsonSerializerOptions options)
    {
        if (double.IsNaN(value) || double.IsInfinity(value)) writer.WriteNullValue();
        else writer.WriteNumberValue(value);
    }
}

/// <summary>
/// 内置工具宿主（cyrene-native --tool-host）。
///
/// 把计算密集/系统交互型内置工具从 Electron 主进程下沉到 .NET：
///   - calculator：递归下降求值器（与 TS 版同语义，白名单函数表，零动态执行）
///   - now：时区感知时间
///   - clipboard：WPF 剪贴板（STA marshal）
///   - sysinfo：系统信息快照（CPU/内存/OS/运行时长）
///
/// 协议（宿主 Electron ↔ 本进程，stdio JSON 行）：
///   → {"op":"list"}                          ← {"op":"tools","tools":[{id,...}]}
///   → {"op":"call","callId":"c1","tool":"calculator","args":{...},"timeoutMs":5000}
///   → {"op":"shutdown"}
///   ← {"op":"ready"}
///   ← {"op":"result","callId":"c1","ok":true,"data":...}
///   ← {"op":"result","callId":"c1","ok":false,"error":"..."}
///   ← {"op":"log","level":"info","message":"..."}
///
/// 容错：逐调用超时由宿主侧控制（超时即重启本进程——工具全部纯函数
/// 化无状态，重启零成本）；stdout 协议独占，诊断走 log 帧/stderr。
/// </summary>
/// <summary>B5 错误码契约：宿主可据此决定回退/重试语义。</summary>
internal sealed class ToolHostException : Exception
{
    public string Code { get; }
    public ToolHostException(string code, string message) : base(message) => Code = code;
}

/// <summary>
/// ToolHost 运行时配置（config 帧注入，TS NativeToolHost.setRuntimeSettings）。
///   timezone：now/时间格式化用（默认 Asia/Shanghai）
///   dateLocale：日期展示用 locale（默认 zh-CN）
///   dataDir：本地数据根（expenses.json 等；null = 宿主侧落盘工具不可用）
/// </summary>
internal static class ToolHostConfig
{
    internal static string Timezone { get; set; } = "Asia/Shanghai";
    internal static string DateLocale { get; set; } = "zh-CN";
    internal static string? DataDir { get; set; }
}

internal static class ToolHost
{
    /// <summary>args 缺失时的空对象（避免 Undefined JsonElement 在工具内探属性崩溃）。</summary>
    private static readonly JsonElement EmptyArgs = JsonDocument.Parse("{}").RootElement.Clone();

    /// <summary>协议帧序列化：NaN/±Infinity → null（见 <see cref="SafeDoubleJsonConverter"/>）。</summary>
    private static readonly JsonSerializerOptions SafeJsonOptions = new()
    {
        Converters = { new SafeDoubleJsonConverter() },
    };

    public static int Run()
    {
        var stdout = Console.OpenStandardOutput();
        var ioLock = new SemaphoreSlim(1, 1);
        WriteFrame(stdout, ioLock, new { op = "ready" });

        using var cts = new CancellationTokenSource();
        Console.CancelKeyPress += (_, e) => { e.Cancel = true; cts.Cancel(); };

        using var stdin = Console.OpenStandardInput();
        using var reader = new StreamReader(stdin, Encoding.UTF8);
        string? line;
        while (!cts.IsCancellationRequested && (line = reader.ReadLine()) is not null)
        {
            if (string.IsNullOrWhiteSpace(line)) continue;
            JsonDocument doc;
            try { doc = JsonDocument.Parse(line); }
            catch
            {
                WriteFrame(stdout, ioLock, new { op = "log", level = "warn", message = "非 JSON 行已忽略" });
                continue;
            }
            var root = doc.RootElement.Clone();
            doc.Dispose();
            // 同步顺序处理（Bug 修复：原 Task.Run fire-and-forget 在 stdin EOF
            // 时进程先退，在途帧丢失——批量帧+立即关闭必复现；顺序性也是
            // 帧协议 B5 的硬约束。工具执行最重为 fs 读取（10MB 上限），可接受）
            try { Handle(root, stdout, ioLock); }
            catch (Exception ex)
            {
                WriteFrame(stdout, ioLock, new { op = "log", level = "error", message = ex.Message });
            }
        }
        return 0;
    }

    private static void Handle(JsonElement root, Stream stdout, SemaphoreSlim ioLock)
    {
        var op = root.TryGetProperty("op", out var o) ? o.GetString() : null;
        switch (op)
        {
            case "list":
                WriteFrame(stdout, ioLock, new
                {
                    op = "tools",
                    tools = new object[]
                    {
                        new { id = "calculator", name = "计算器", description = "数学表达式求值（优先级/幂/函数/常量，无 eval）" },
                        new { id = "now", name = "当前时间", description = "时区感知的当前时间（epoch/iso/default）" },
                        new { id = "clipboard", name = "剪贴板", description = "读写系统剪贴板文本" },
                        new { id = "sysinfo", name = "系统信息", description = "系统信息快照（CPU/内存/OS/进程运行时长）" },
                        // fs 三件自 2026-10-03 起由宿主包装器接线（nativeFirst），
                        // list 广告与真实可调用面保持一致
                        new { id = "fs_read_file", name = "读取文件(.NET)", description = "带行号/真实总行数/翻页的文本读取（10MB 上限）" },
                        new { id = "fs_write_file", name = "写入文件(.NET)", description = "覆盖/追加写 + ToolFileChange 证据输出（append/createDirs）" },
                        new { id = "fs_list_dir", name = "列出目录(.NET)", description = "目录列举（隐藏项开关/图片标注/200 项截断）" },
                        new { id = "exchange_rate", name = "汇率查询(.NET)", description = "frankfurter.app 免 key 汇率 + 30 分钟 TTL 缓存" },
                        new { id = "record_expense", name = "记账(.NET)", description = "本地 JSON 记账（dataDir 注入）" },
                        new { id = "query_expense", name = "查账(.NET)", description = "记账查询/汇总（时区与 locale 随 config 帧）" },
                        new { id = "search_text", name = "文本搜索(.NET)", description = "工作区文本/正则搜索（忽略目录、上下文、上限对齐 TS）" },
                        new { id = "str_replace", name = "精确替换(.NET)", description = "三层匹配（精确/EOL/空白归一化）+ evidence；__dryRun 预检两段式" },
                        new { id = "apply_patch", name = "编辑文件(.NET)", description = "Codex 补丁格式批量编辑（预检事务 + 保留 EOL + evidence；__dryRun 两段式）" },
                        new { id = "git_status", name = "Git 状态(.NET)", description = "分支/变更/同步状态（simple-git 同构解析；root/命令注入）" },
                        new { id = "git_init", name = "Git 初始化(.NET)", description = "初始化仓库（仅用户明确要求时）" },
                        new { id = "git_commit", name = "Git 提交(.NET)", description = "paths 暂存 + 提交（身份注入；core.abbrev=40 完整 hash）" },
                        new { id = "git_switch_branch", name = "Git 分支(.NET)", description = "切换 / 创建并切换分支" },
                        new { id = "git_push", name = "Git 推送(.NET)", description = "非强制推送；缺 upstream 自动建立跟踪（系统凭据链）" },
                        new { id = "git_revert", name = "Git 回退(.NET)", description = "生成 revert 提交（不重写历史）" },
                        new { id = "git_diff", name = "Git 差异(.NET)", description = "工作区/暂存/ref diff + changes 证据（unified patch 解析）" },
                        new { id = "git_log", name = "Git 历史(.NET)", description = "hash/日期/作者/信息（ref / path / maxCount）" },
                        new { id = "download_file", name = "下载文件(.NET)", description = "URL 二进制落盘（沙箱/黑名单/64MiB/空闲超时；root 注入）" },
                    },
                });
                break;
            case "config":
            {
                // 运行时配置（时区/日期 locale/数据根）：可多次下发，立即生效
                if (root.TryGetProperty("timezone", out var tz) && tz.ValueKind == JsonValueKind.String
                    && !string.IsNullOrWhiteSpace(tz.GetString()))
                    ToolHostConfig.Timezone = tz.GetString()!;
                if (root.TryGetProperty("dateLocale", out var dl) && dl.ValueKind == JsonValueKind.String
                    && !string.IsNullOrWhiteSpace(dl.GetString()))
                    ToolHostConfig.DateLocale = dl.GetString()!;
                if (root.TryGetProperty("dataDir", out var dd) && dd.ValueKind == JsonValueKind.String)
                    ToolHostConfig.DataDir = dd.GetString();
                break;
            }
            case "call":
            {
                var callId = root.TryGetProperty("callId", out var c) ? c.GetString() : "";
                var tool = root.TryGetProperty("tool", out var t) ? t.GetString() : "";
                var args = root.TryGetProperty("args", out var a) && a.ValueKind == JsonValueKind.Object
                    ? a.Clone() : (JsonElement?)null;
                try
                {
                    var data = tool switch
                    {
                        "calculator" => Calculator.Evaluate(args),
                        "now" => NowTool.Execute(args),
                        "clipboard" => ClipboardTool.Execute(args),
                        "sysinfo" => SysInfo.Execute(),
                        // args 缺失时传空对象而非 Undefined JsonElement——
                        // 否则 fs 工具里 TryGetProperty 直接抛
                        // InvalidOperationException（.NET 内部英文串），
                        // 模型拿到的是不可读错误（冒烟 P2）
                        "fs_read_file" => FsTools.ReadFile(args ?? EmptyArgs),
                        "fs_write_file" => FsTools.WriteFile(args ?? EmptyArgs),
                        "fs_list_dir" => FsTools.ListDir(args ?? EmptyArgs),
                        "exchange_rate" => ExchangeRateTool.Execute(args ?? EmptyArgs),
                        "record_expense" => ExpenseTools.Record(args ?? EmptyArgs),
                        "query_expense" => ExpenseTools.Query(args ?? EmptyArgs),
                        "search_text" => SearchTools.Search(args ?? EmptyArgs),
                        "str_replace" => StrReplaceTool.Execute(args ?? EmptyArgs),
                        "apply_patch" => ApplyPatchTool.Execute(args ?? EmptyArgs),
                        "git_status" => GitTools.Status(args ?? EmptyArgs),
                        "git_init" => GitTools.Init(args ?? EmptyArgs),
                        "git_commit" => GitTools.Commit(args ?? EmptyArgs),
                        "git_switch_branch" => GitTools.SwitchBranch(args ?? EmptyArgs),
                        "git_push" => GitTools.Push(args ?? EmptyArgs),
                        "git_revert" => GitTools.Revert(args ?? EmptyArgs),
                        "git_diff" => GitTools.Diff(args ?? EmptyArgs),
                        "git_log" => GitTools.Log(args ?? EmptyArgs),
                        "download_file" => DownloadFileTool.Execute(args ?? EmptyArgs),
                        _ => throw new ToolHostException("E_UNKNOWN_TOOL", $"未知工具: {tool}"),
                    };
                    WriteFrame(stdout, ioLock, new { op = "result", callId, ok = true, data });
                }
                catch (ToolHostException ex)
                {
                    WriteFrame(stdout, ioLock, new { op = "result", callId, ok = false, error = ex.Message, errorCode = ex.Code });
                }
                catch (Exception ex)
                {
                    WriteFrame(stdout, ioLock, new { op = "result", callId, ok = false, error = ex.Message, errorCode = "E_TOOL_FAILED" });
                }
                break;
            }
            case "shutdown":
                Environment.Exit(0);
                break;
        }
    }

    internal static void WriteFrame(Stream stdout, SemaphoreSlim ioLock, object frame)
    {
        byte[] bytes;
        try
        {
            bytes = JsonSerializer.SerializeToUtf8Bytes(frame, SafeJsonOptions);
        }
        catch (Exception ex)
        {
            // 序列化失败：绝不静默丢帧——丢 result 帧会让调用方挂到超时
            // （NaN 已由 SafeJsonOptions 拦下，这里兜底其余非法值）。
            try
            {
                bytes = Encoding.UTF8.GetBytes(
                    "{\"op\":\"log\",\"level\":\"error\",\"message\":"
                    + JsonSerializer.Serialize("帧序列化失败: " + ex.Message) + "}");
            }
            catch
            {
                return;
            }
        }
        try
        {
            ioLock.Wait();
            try
            {
                stdout.Write(bytes, 0, bytes.Length);
                stdout.WriteByte((byte)'\n');
                stdout.Flush();
            }
            finally { ioLock.Release(); }
        }
        catch
        {
            // stdout 关闭：宿主已退出
        }
    }
}

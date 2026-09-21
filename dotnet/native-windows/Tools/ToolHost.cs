using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.Json;

namespace CyreneNative.Tools;

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

internal static class ToolHost
{
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
            // 帧协议 B5 的硬约束。工具执行最重为 git spawn（秒级），可接受）
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
                    },
                });
                break;
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
                        "fs_read_file" => FsTools.ReadFile(args.GetValueOrDefault()),
                        "fs_write_file" => FsTools.WriteFile(args.GetValueOrDefault()),
                        "fs_list_dir" => FsTools.ListDir(args.GetValueOrDefault()),
                        "git" => GitTools.Run(args.GetValueOrDefault()).GetAwaiter().GetResult(),
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
        try
        {
            var bytes = JsonSerializer.SerializeToUtf8Bytes(frame);
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

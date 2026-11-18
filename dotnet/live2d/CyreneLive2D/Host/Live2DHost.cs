// JSON 行协议宿主循环（默认形态）——单线程消息泵。
//
// 结构：stdin 读取线程 → ConcurrentQueue；主线程每轮：
//   排空协议 op → 窗口帧泵（消息分发/光标轮询/tick/render/present）→ 睡眠。
// stdin EOF 且队列排空 → 退出（随宿主消亡，防孤儿进程）。
// 窗口/渲染相关 op 在引擎未加载时回 E_NOT_LOADED；窗口创建失败回 E_WINDOW。
//
// stdout 经复制句柄输出（OpenRobustStdout）：Live2D Core DLL 加载会关闭原始
// stdout 句柄，复制一份保证 load 之后协议帧仍可写出。

using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text;
using System.Text.Json;
using CyreneLive2D.Core;
using CyreneLive2D.Window;

namespace CyreneLive2D.Host;

public static class Live2DHost
{
    public static int Run(string[] args)
    {
        string? dataDir = null;
        for (var i = 0; i < args.Length; i++)
        {
            if (args[i] == "--data-dir" && i + 1 < args.Length) dataDir = args[++i];
        }
        dataDir ??= Environment.GetEnvironmentVariable("CYRENE_DATA_DIR");

        var stdout = OpenRobustStdout();
        var stdin = Console.OpenStandardInput();
        using var io = new HostIo(stdout);
        using var engine = new PetEngine(io, dataDir);
        using var windowHost = new PetWindowHost(engine, io);
        engine.WindowControl = windowHost;

        io.Send(new { op = Live2DOps.Ready });

        // stdin 读取线程（阻塞 ReadLine 不占用消息泵）
        var queue = new ConcurrentQueue<string>();
        var eof = new ManualResetEventSlim(false);
        var readerThread = new Thread(() =>
        {
            try
            {
                using var reader = new StreamReader(stdin, Encoding.UTF8);
                string? line;
                while ((line = reader.ReadLine()) != null) queue.Enqueue(line);
            }
            catch (IOException) { /* 宿主关闭管道 */ }
            catch (ObjectDisposedException) { }
            catch (Exception ex) { Console.Error.WriteLine($"[live2d] stdin reader fatal: {ex}"); }
            finally { eof.Set(); }
        })
        { IsBackground = true, Name = "live2d-stdin" };
        readerThread.Start();

        // 提升定时器精度（Sleep(1)≈1ms），保证 60fps 帧节拍平滑
        Win32.timeBeginPeriod(1);
        var sw = Stopwatch.StartNew();
        // 表情回正/空闲帧率计时用真实时间（web 轨 setInterval 不受 ticker 暂停影响）
        engine.RealTimeMsProvider = () => sw.Elapsed.TotalMilliseconds;
        try
        {
            while (true)
            {
                while (queue.TryDequeue(out var line))
                {
                    if (string.IsNullOrWhiteSpace(line)) continue;
                    JsonElement frame;
                    try
                    {
                        frame = JsonSerializer.Deserialize<JsonElement>(line, HostIo.Options);
                    }
                    catch (JsonException)
                    {
                        io.Log("warn", "畸形帧（非 JSON），已忽略");
                        continue;
                    }
                    if (frame.ValueKind != JsonValueKind.Object) continue;
                    if (!frame.TryGetProperty("op", out var opEl)) continue;
                    var op = opEl.GetString() ?? "";
                    var callId = frame.TryGetProperty("callId", out var idEl) ? idEl.GetString() ?? "" : "";

                    if (op == Live2DOps.Shutdown)
                    {
                        if (callId.Length > 0) io.SendResult(callId);
                        return 0;
                    }

                    try
                    {
                        engine.Handle(op, callId, frame);
                    }
                    catch (CoreNotAvailableException ex)
                    {
                        io.SendError(callId, ex.Message, Live2DErrors.CoreMissing);
                    }
                    catch (Exception ex)
                    {
                        io.SendError(callId, ex.Message, Live2DErrors.Internal);
                    }
                }

                if (eof.IsSet && queue.IsEmpty) return 0; // stdin EOF：宿主退出

                windowHost.Pump(sw.Elapsed.TotalMilliseconds);
                Thread.Sleep(windowHost.IsRendering ? 1 : 10);
            }
        }
        finally
        {
            Win32.timeEndPeriod(1);
        }
    }

    /// <summary>
    /// 复制 stdout 句柄构建协议输出流。Live2D Core DLL 加载时会关闭/替换原始
    /// stdout 句柄（其静态 CRT 初始化所致），直接用 Console.OpenStandardOutput()
    /// 会在 load 之后写帧失败。复制一份独立句柄即可免疫（stderr 不受影响）。
    /// </summary>
    private static Stream OpenRobustStdout()
    {
        IntPtr original = Win32.GetStdHandle(Win32.STD_OUTPUT_HANDLE);
        if (original != IntPtr.Zero && original != new IntPtr(-1) &&
            Win32.DuplicateHandle(Win32.GetCurrentProcess(), original, Win32.GetCurrentProcess(),
                out IntPtr dup, 0, false, Win32.DUPLICATE_SAME_ACCESS))
        {
            return new FileStream(new Microsoft.Win32.SafeHandles.SafeFileHandle(dup, true), FileAccess.Write);
        }
        return Console.OpenStandardOutput();
    }
}
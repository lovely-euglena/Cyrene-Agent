// JSON 行协议宿主循环（默认形态）。stdin EOF → 退出（随宿主消亡，防孤儿进程）。
// 请求分发到 PetEngine；窗口/渲染相关 op 在引擎未加载时回 E_NOT_LOADED。

using System.Text.Json;
using CyreneLive2D.Core;

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

        var stdout = Console.OpenStandardOutput();
        var stdin = Console.OpenStandardInput();
        using var io = new HostIo(stdout);
        using var engine = new PetEngine(io, dataDir);

        io.Send(new { op = Live2DOps.Ready });

        using var reader = new StreamReader(stdin, System.Text.Encoding.UTF8);
        string? line;
        while ((line = reader.ReadLine()) != null)
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

        return 0; // stdin EOF：宿主退出
    }
}

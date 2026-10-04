using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using System.Threading;
using CyreneNative.Secrets;

namespace CyreneNative.Llm;

/// <summary>
/// llm 托管宿主（--llm-host，H1）。
///
/// 作业式厂商服务：TS `llm.submit` 提交（wire 请求 TS 塑形、去鉴权），本宿主
/// 注入鉴权 → 发送 → 流式解析 → 事件缓冲；TS 按 cursor 轮询取归一化 token 事件。
/// 协议契约见 LlmContracts（TS 镜像 src/main/dotnet-backend/llm-host-protocol.ts，
/// 一致性由 llm-contract.test.ts 扫描锁定）。
///
/// 读帧线程纪律（StorageHost 先例）：逐行读 stdin；每个带 callId 的 op 丢
/// Task.Run 执行（长轮询 waitMs 挂起绝不堵读帧）；stdin EOF → 等 inflight
/// 排空（上限 15s）→ 退出。
/// </summary>
public static class LlmHost
{
    private static readonly object IoLock = new();
    private static TextWriter _stdout = null!;
    private static int _inflight;

    public static int Run(string[] args, ISecretProvider secrets)
    {
        _stdout = Console.Out;
        var service = new LlmJobService(secrets);

        WriteFrame(new { op = LlmContracts.OpReady });
        using var cts = new CancellationTokenSource();
        Console.CancelKeyPress += (_, e) => { e.Cancel = true; cts.Cancel(); };

        string? line;
        while ((line = Console.ReadLine()) != null)
        {
            if (cts.IsCancellationRequested) break;
            line = line.Trim();
            if (line.Length == 0) continue;

            JsonElement frame;
            try { frame = JsonDocument.Parse(line).RootElement.Clone(); }
            catch (JsonException) { continue; } // 半行/乱码：丢弃，协议不断

            var op = frame.TryGetProperty("op", out var opEl) && opEl.ValueKind == JsonValueKind.String
                ? opEl.GetString() : null;

            if (op == LlmContracts.OpShutdown) break;
            if (op == null) continue;

            Interlocked.Increment(ref _inflight);
            ThreadPool.QueueUserWorkItem(_ =>
            {
                try { Dispatch(service, op, frame); }
                catch (Exception ex)
                {
                    var callId = frame.TryGetProperty("callId", out var c) && c.ValueKind == JsonValueKind.String ? c.GetString() : null;
                    if (callId != null)
                        WriteFrame(new { op = LlmContracts.OpResult, callId, ok = false, code = LlmContracts.ErrBadRequest, message = Trunc(ex.Message) });
                }
                finally { Interlocked.Decrement(ref _inflight); }
            });
        }

        // EOF 排空：等 inflight 收敛（StorageHost.DrainInflight 先例）
        DrainInflight(TimeSpan.FromSeconds(15));
        service.Dispose();
        return 0;
    }

    private static void Dispatch(LlmJobService service, string op, JsonElement frame)
    {
        var callId = frame.TryGetProperty("callId", out var c) && c.ValueKind == JsonValueKind.String ? c.GetString() : null;
        switch (op)
        {
            case LlmContracts.OpSubmit:
            {
                var job = service.Submit(frame);
                if (job == null)
                {
                    if (callId != null)
                        WriteFrame(new { op = LlmContracts.OpResult, callId, ok = false, code = LlmContracts.ErrLaneFull, message = "low lane queue is full" });
                    return;
                }
                if (callId != null)
                    WriteFrame(new { op = LlmContracts.OpResult, callId, ok = true, data = new { jobId = job.Id } });
                return;
            }
            case LlmContracts.OpPoll:
            {
                var jobId = frame.TryGetProperty("jobId", out var j) && j.ValueKind == JsonValueKind.String ? j.GetString() : null;
                var job = service.Store.Find(jobId);
                if (job == null)
                {
                    if (callId != null)
                        WriteFrame(new { op = LlmContracts.OpResult, callId, ok = false, code = LlmContracts.ErrJobMissing, message = "job not found or expired" });
                    return;
                }
                var cursor = frame.TryGetProperty("cursor", out var cu) && cu.TryGetInt32(out var cv) ? Math.Max(0, cv) : 0;
                var maxEvents = frame.TryGetProperty("maxEvents", out var me) && me.TryGetInt32(out var mv) ? Math.Clamp(mv, 1, 500) : 200;
                var waitMs = frame.TryGetProperty("waitMs", out var w) && w.TryGetInt32(out var wv) ? Math.Clamp(wv, 0, 10_000) : 0;
                var events = job.Poll(cursor, maxEvents, waitMs);
                // done 之后 final=true（TS 据此停止轮询）；error/cancelled 终态同样 final
                var final = job.IsTerminal && cursor + events.Count >= job.EventCount;
                if (callId != null)
                    WriteFrame(new { op = LlmContracts.OpResult, callId, ok = true, data = new { jobId = job.Id, cursor = cursor + events.Count, nextCursor = cursor + events.Count, final, events } });
                return;
            }
            case LlmContracts.OpCancel:
            {
                var jobId = frame.TryGetProperty("jobId", out var j2) && j2.ValueKind == JsonValueKind.String ? j2.GetString() : null;
                var ok = service.Store.Cancel(jobId ?? "");
                if (callId != null)
                    WriteFrame(new { op = LlmContracts.OpResult, callId, ok, message = ok ? null : "job not found" });
                return;
            }
            case LlmContracts.OpStatus:
            {
                var (jobs, running, queued) = service.Store.Snapshot();
                if (callId != null)
                    WriteFrame(new { op = LlmContracts.OpResult, callId, ok = true, data = new { jobs, running, queued, secrets = service.SecretsAvailable } });
                return;
            }
            default:
                if (callId != null)
                    WriteFrame(new { op = LlmContracts.OpResult, callId, ok = false, code = LlmContracts.ErrBadRequest, message = $"unknown op: {op}" });
                return;
        }
    }

    private static string Trunc(string s) => s.Length <= 300 ? s : s[..300];

    private static void DrainInflight(TimeSpan timeout)
    {
        var deadline = DateTime.UtcNow + timeout;
        while (Volatile.Read(ref _inflight) > 0 && DateTime.UtcNow < deadline)
            Thread.Sleep(20);
    }

    private static void WriteFrame(object frame)
    {
        var json = JsonSerializer.Serialize(frame, new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
        });
        lock (IoLock)
        {
            _stdout.Write(json + "\n");
            _stdout.Flush();
        }
    }
}

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
/// Task.Run 执行（长轮询 waitMs 挂起绝不堵读帧）；stdin EOF → 等 inflight 排空
/// → service.Dispose（join pump 线程 = 排作业）→ 退出。
/// TTL 清理（P0-4）：Timer 每 30s 调 SweepExpired，终态作业 5min 后回收。
/// 错误帧（P0-5）：对齐仓库约定 {ok:false, error, errorCode, retryable}。
/// </summary>
public static class LlmHost
{
    private static readonly object IoLock = new();
    private static TextWriter _stdout = null!;
    private static int _inflight;

    public static int Run(string[] args, ISecretProvider secrets)
    {
        _stdout = Console.Out;
        using var service = new LlmJobService(secrets);

        WriteFrame(new { op = LlmContracts.OpReady });
        using var cts = new CancellationTokenSource();
        Console.CancelKeyPress += (_, e) => { e.Cancel = true; cts.Cancel(); };
        using var sweep = new Timer(_ =>
        {
            try { service.Store.SweepExpired(); }
            catch { /* 清理失败下轮再试 */ }
        }, null, TimeSpan.FromSeconds(30), TimeSpan.FromSeconds(30));

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
                        WriteFrame(new { op = LlmContracts.OpResult, callId, ok = false, error = Trunc(ex.Message), errorCode = LlmContracts.ErrBadRequest, retryable = false });
                }
                finally { Interlocked.Decrement(ref _inflight); }
            });
        }

        // EOF 排空：等 inflight 收敛（StorageHost.DrainInflight 先例）→ Dispose 等待各 pump
        // 收口在跑作业（join ≤2s/线程；不再接新作业）
        DrainInflight(TimeSpan.FromSeconds(15));
        return 0;
    }

    /// <summary>统一错误帧（P0-5：对齐 StorageHost 约定 error/errorCode/retryable）。</summary>
    private static void WriteError(string? callId, string errorCode, string message, bool retryable = false)
    {
        if (callId != null)
            WriteFrame(new { op = LlmContracts.OpResult, callId, ok = false, error = Trunc(message), errorCode, retryable });
    }

    private static void Dispatch(LlmJobService service, string op, JsonElement frame)
    {
        var callId = frame.TryGetProperty("callId", out var c) && c.ValueKind == JsonValueKind.String ? c.GetString() : null;
        switch (op)
        {
            case LlmContracts.OpSubmit:
            {
                var job = service.TrySubmit(frame, out var error);
                if (error != null)
                {
                    // 非法帧 vs lane 满载分报（复审 P1-7：不再把 bad request 误报成 LANE_FULL）
                    if (error == LlmContracts.ErrLaneFull)
                        WriteError(callId, LlmContracts.ErrLaneFull, "low lane queue is full", retryable: true);
                    else
                        WriteError(callId, LlmContracts.ErrBadRequest, error);
                    return;
                }
                if (callId != null)
                    WriteFrame(new { op = LlmContracts.OpResult, callId, ok = true, data = new { jobId = job!.Id } });
                return;
            }
            case LlmContracts.OpPoll:
            {
                var jobId = frame.TryGetProperty("jobId", out var j) && j.ValueKind == JsonValueKind.String ? j.GetString() : null;
                var job = service.Store.Find(jobId);
                if (job == null)
                {
                    WriteError(callId, LlmContracts.ErrJobMissing, "job not found or expired（终态作业 TTL 5min 后回收）");
                    return;
                }
                var cursor = frame.TryGetProperty("cursor", out var cu) && cu.TryGetInt32(out var cv) ? Math.Max(0, cv) : 0;
                var maxEvents = frame.TryGetProperty("maxEvents", out var me) && me.TryGetInt32(out var mv) ? Math.Clamp(mv, 1, 500) : 200;
                var waitMs = frame.TryGetProperty("waitMs", out var w) && w.TryGetInt32(out var wv) ? Math.Clamp(wv, 0, 10_000) : 0;
                var slice = job.Poll(cursor, maxEvents, waitMs);
                // 复审 P2-1①：nextCursor 用 Poll clamp 后的有效位点（cursor 落在丢弃段时
                // 不能按 cursor+events.Count 自算，否则同批事件重复投递）
                var nextCursor = slice.NextCursor;
                var dropped = job.DroppedEvents;
                // done 之后 final=true（TS 据此停止轮询）；error/cancelled 终态同样 final
                var final = job.IsTerminal && nextCursor >= job.EventCount;
                if (callId != null)
                    WriteFrame(new
                    {
                        op = LlmContracts.OpResult,
                        callId,
                        ok = true,
                        // truncated：ring 曾 drop-oldest（丢弃段不可恢复）——TS 侧告警增量缺口
                        data = new { jobId = job.Id, cursor = nextCursor, nextCursor, final, dropped, truncated = dropped > 0, events = slice.Events },
                    });
                return;
            }
            case LlmContracts.OpCancel:
            {
                var jobId = frame.TryGetProperty("jobId", out var j2) && j2.ValueKind == JsonValueKind.String ? j2.GetString() : null;
                var ok = service.Store.Cancel(jobId ?? "");
                // 复审 P2-6：失败帧走 WriteError（error/errorCode/retryable 三件套齐全）
                if (ok)
                {
                    if (callId != null) WriteFrame(new { op = LlmContracts.OpResult, callId, ok = true });
                }
                else WriteError(callId, LlmContracts.ErrJobMissing, "job not found");
                return;
            }
            case LlmContracts.OpStatus:
            {
                var (jobs, running, queued) = service.Store.Snapshot();
                if (callId != null)
                    WriteFrame(new
                    {
                        op = LlmContracts.OpResult,
                        callId,
                        ok = true,
                        data = new { jobs, running, queued, secrets = service.SecretsAvailable, metrics = service.RecentMetrics() },
                    });
                return;
            }
            default:
                WriteError(callId, LlmContracts.ErrBadRequest, $"unknown op: {op}");
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
            // 复审 P2-6：status.metrics[].state 输出枚举名（与 PublishMetrics 出口一致）
            Converters = { new System.Text.Json.Serialization.JsonStringEnumConverter() },
        });
        lock (IoLock)
        {
            _stdout.Write(json + "\n");
            _stdout.Flush();
        }
    }
}

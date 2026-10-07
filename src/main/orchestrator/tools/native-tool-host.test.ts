/**
 * NativeToolHost.call 客户端层测试。
 *
 * 背景（PR #1 审查/复审阻断项）：dual-track-diff 直接 spawn smoke-host 通信，
 * 绕过了 NativeToolHost 的调用超时层；默认 5s 会误杀长任务
 * （download_file / exchange_rate），且单线程宿主 + 独立看门狗存在
 * 队头阻塞误杀。因此这里直接驱动客户端校验：
 *  - 显式 timeoutMs 生效：到期 kill host 并 reject
 *  - 结果帧在窗口内返回：清除定时器、不误杀
 *  - 缺省仍为 5s：短工具的默认保护不被长任务参数污染
 *  - 串行闸门：前一调用未 settle 时，后一调用不写入 stdin
 *  - 取消：在途杀 host 以 AbortError 拒绝；排队直接摘除不触达 host
 *  - 超时轻量隔离（#IKJLP2）：abandonOnTimeout 调用超时不杀 host，等迟到
 *    结果帧排空后再派发排队调用；兜底窗口到期才杀 host（排队 sentinel 回退）
 */

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  resolveNativeWindowsExe: vi.fn(() => "C:\\fake\\cyrene-native.exe"),
}));

vi.mock("child_process", () => ({ spawn: mocks.spawn }));
vi.mock("../../child-processes", () => ({ trackChildProcess: vi.fn() }));
vi.mock("../../windows/native-windows-host", () => ({
  resolveNativeWindowsExe: mocks.resolveNativeWindowsExe,
}));

import { NativeToolHost, NativeCallNotDispatchedError, nativeFirst, nativeToolHost, withNativeFirst } from "./native-tool-host";
import type { ToolDefinition } from "./registry/tool-registry";
import { ToolExecutionError } from "./registry/tool-execution-error";
import { resetDotnetConfigCache } from "../../dotnet-backend/config";
import { dispatchToolCall } from "../harness/tool-dispatcher";
import type { AgentState } from "../harness/types";

class FakeChild extends EventEmitter {
  pid = 5150;
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = { writable: true, write: vi.fn(() => true) };
  kill = vi.fn();
}

function startHost(): { host: NativeToolHost; child: FakeChild } {
  const child = new FakeChild();
  mocks.spawn.mockReturnValue(child);
  const host = new NativeToolHost();
  return { host, child };
}

/** 触发握手 ready 帧（start() 等待的就绪信号）。 */
function ready(child: FakeChild): void {
  child.stdout.write('{"op":"ready"}\n');
}

describe("NativeToolHost.call 看门狗", () => {
  beforeEach(() => {
    mocks.spawn.mockReset();
    mocks.resolveNativeWindowsExe.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("自定义 timeoutMs 到期：kill host 并 reject", async () => {
    vi.useFakeTimers();
    const { host, child } = startHost();

    const pending = host.call("download_file", { url: "https://example.com/a.bin" }, 50);
    const rejection = pending.catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(0);
    ready(child);
    await vi.advanceTimersByTimeAsync(0);

    let settled = false;
    void rejection.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(49);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const error = await rejection;
    expect(error).toBeInstanceOf(Error);
    expect(String(error.message)).toContain("超时");
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("超时 kill 后：日志列出连带拒绝的在途/排队调用，exit 时全部 reject", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { host, child } = startHost();

    const first = host.call("download_file", { url: "https://example.com/a.bin" }, 50);
    const second = host.call("search_text", { query: "x" });
    const firstErr = first.catch((error: Error) => error);
    const secondErr = second.catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(0);
    ready(child);
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(50);
    await expect(firstErr).resolves.toBeInstanceOf(Error);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[ToolHost]"),
      expect.stringContaining("连带拒绝 1 个在途/排队调用"),
    );

    // 真实 kill 后进程退出：排队的第二调用被连带拒绝
    child.emit("exit", 1, null);
    await expect(secondErr).resolves.toBeInstanceOf(Error);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[ToolHost]"),
      expect.stringContaining("host 退出：连带拒绝 1 个在途/排队调用"),
    );

    warnSpy.mockRestore();
    vi.useRealTimers();
  });

  it("host 退出：排队未派发调用带 E_TOOL_NOT_DISPATCHED sentinel，在途调用保持普通失败", async () => {
    vi.useFakeTimers();
    const { host, child } = startHost();

    const inFlight = host.call("send_email", {}, 10_000);
    const queued = host.call("send_email", {}, 10_000);
    const inFlightErr = inFlight.catch((error: Error) => error);
    const queuedErr = queued.catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(0);
    ready(child);
    await vi.advanceTimersByTimeAsync(0);

    child.emit("exit", 1, null);

    const inFlightError = await inFlightErr;
    const queuedError = await queuedErr;
    // 在途调用：call 帧已下发，状态可能未知（普通 Error，不能按确定未执行处理）
    expect(inFlightError).toBeInstanceOf(Error);
    expect(inFlightError).not.toBeInstanceOf(NativeCallNotDispatchedError);
    // 排队调用：call 帧从未写入 stdin，确定未派发 → 独立 sentinel
    expect(queuedError).toBeInstanceOf(NativeCallNotDispatchedError);
    expect((queuedError as { code?: string }).code).toBe("E_TOOL_NOT_DISPATCHED");
    vi.useRealTimers();
  });

  it("错误帧 errorCode 透传到 Error.code（B5 错误码契约）", async () => {
    vi.useFakeTimers();
    const { host, child } = startHost();

    const pending = host.call("send_email", {}, 10_000);
    const outcome = pending.catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(0);
    ready(child);
    await vi.advanceTimersByTimeAsync(0);

    child.stdout.write(`${JSON.stringify({
      op: "result", callId: "t1", ok: false, error: "发送失败（未进入发送阶段）：认证失败", errorCode: "E_EMAIL_PRECONDITION",
    })}\n`);
    const error = await outcome;
    expect(error.message).toContain("未进入发送阶段");
    expect((error as { code?: string }).code).toBe("E_EMAIL_PRECONDITION");
    vi.useRealTimers();
  });

  it("串行闸门：前一调用未 settle 时，后一调用不写入 stdin（看门狗从派发起算）", async () => {
    vi.useFakeTimers();
    const { host, child } = startHost();

    const first = host.call("download_file", { url: "https://example.com/a.bin" }, 10_000);
    const second = host.call("search_text", { query: "x" });
    const secondResult = second.catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(0);
    ready(child);
    await vi.advanceTimersByTimeAsync(0);

    const writtenTools = (): string[] =>
      child.stdin.write.mock.calls
        .map(([line]) => String(line))
        .filter((line) => line.includes('"op":"call"'))
        .map((line) => (JSON.parse(line) as { tool: string }).tool);

    expect(writtenTools()).toEqual(["download_file"]);

    child.stdout.write(`${JSON.stringify({ op: "result", callId: "t1", ok: true, data: "ok1" })}\n`);
    await vi.advanceTimersByTimeAsync(0);
    expect(writtenTools()).toEqual(["download_file", "search_text"]);

    child.stdout.write(`${JSON.stringify({ op: "result", callId: "t2", ok: true, data: "ok2" })}\n`);
    await vi.advanceTimersByTimeAsync(0);
    await expect(first).resolves.toBe("ok1");
    await expect(secondResult).resolves.toBe("ok2");
  });

  it("在途取消：杀 host 中止，以 AbortError 拒绝", async () => {
    vi.useFakeTimers();
    const { host, child } = startHost();
    const controller = new AbortController();

    const pending = host.call("download_file", { url: "x" }, 10_000, controller.signal);
    const outcome = pending.catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(0);
    ready(child);
    await vi.advanceTimersByTimeAsync(0);

    controller.abort();
    const error = await outcome;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("AbortError");
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("排队取消：直接摘除、不触达 host、不杀进程", async () => {
    vi.useFakeTimers();
    const { host, child } = startHost();
    const controller = new AbortController();

    const first = host.call("download_file", { url: "x" }, 10_000);
    const second = host.call("search_text", { query: "x" }, undefined, controller.signal);
    const secondOutcome = second.catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(0);
    ready(child);
    await vi.advanceTimersByTimeAsync(0);

    controller.abort();
    const error = await secondOutcome;
    expect((error as Error).name).toBe("AbortError");
    expect(child.kill).not.toHaveBeenCalled();

    child.stdout.write(`${JSON.stringify({ op: "result", callId: "t1", ok: true, data: "ok1" })}\n`);
    await vi.advanceTimersByTimeAsync(0);
    await expect(first).resolves.toBe("ok1");
  });

  it("结果帧在窗口内返回：清除定时器，不误杀 host", async () => {
    vi.useFakeTimers();
    const { host, child } = startHost();

    const pending = host.call("download_file", {}, 50);
    await vi.advanceTimersByTimeAsync(0);
    ready(child);
    await vi.advanceTimersByTimeAsync(0);

    child.stdout.write(`${JSON.stringify({ op: "result", callId: "t1", ok: true, data: "saved" })}\n`);
    await expect(pending).resolves.toBe("saved");

    await vi.advanceTimersByTimeAsync(100);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("缺省超时仍为 5s：默认保护不被长任务参数污染", async () => {
    vi.useFakeTimers();
    const { host, child } = startHost();

    const pending = host.call("search_text", { query: "x" });
    const rejection = pending.catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(0);
    ready(child);
    await vi.advanceTimersByTimeAsync(0);

    let settled = false;
    void rejection.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(4_999);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(rejection).resolves.toBeInstanceOf(Error);
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("call 帧序列化：内部参数只出现在 meta，args 无 `__` 键（IKJLP4 验收口径）", async () => {
    vi.useFakeTimers();
    const { host, child } = startHost();

    const pending = host.call("search_text", { query: "x" }, 10_000, undefined, { workspaceRoot: "C:\\ws" });
    await vi.advanceTimersByTimeAsync(0);
    ready(child);
    await vi.advanceTimersByTimeAsync(0);

    const callFrame = child.stdin.write.mock.calls
      .map(([line]) => JSON.parse(String(line)) as {
        op: string; tool?: string; args?: Record<string, unknown>; meta?: Record<string, unknown>;
      })
      .find((frame) => frame.op === "call");
    expect(callFrame).toMatchObject({ tool: "search_text", args: { query: "x" }, meta: { workspaceRoot: "C:\\ws" } });
    expect(Object.keys(callFrame?.args ?? {}).some((key) => key.startsWith("__"))).toBe(false);

    child.stdout.write(`${JSON.stringify({ op: "result", callId: "t1", ok: true, data: "ok" })}\n`);
    await vi.advanceTimersByTimeAsync(0);
    await expect(pending).resolves.toBe("ok");
    vi.useRealTimers();
  });

  it("无内部参数的调用帧不含 meta 键（帧形状保持向后一致）", async () => {
    vi.useFakeTimers();
    const { host, child } = startHost();

    const pending = host.call("calculator", { expression: "1+1" }, 10_000);
    await vi.advanceTimersByTimeAsync(0);
    ready(child);
    await vi.advanceTimersByTimeAsync(0);

    const callFrame = child.stdin.write.mock.calls
      .map(([line]) => JSON.parse(String(line)) as { op: string; meta?: unknown })
      .find((frame) => frame.op === "call");
    expect(callFrame).toBeTruthy();
    expect(callFrame).not.toHaveProperty("meta");

    child.stdout.write(`${JSON.stringify({ op: "result", callId: "t1", ok: true, data: "2" })}\n`);
    await vi.advanceTimersByTimeAsync(0);
    await expect(pending).resolves.toBe("2");
    vi.useRealTimers();
  });
});

// ── 超时轻量隔离（#IKJLP2）─────────────────────────────────

describe("超时轻量隔离（abandonOnTimeout）", () => {
  beforeEach(() => {
    mocks.spawn.mockReset();
    mocks.resolveNativeWindowsExe.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("超时不杀 host：排队调用等迟到结果帧排空后正常派发（无连带拒绝）", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { host, child } = startHost();

    const first = host.call("search_text", { query: "x" }, 50, undefined, undefined, undefined, true);
    const second = host.call("read_file", { path: "C:\\a.txt" });
    const firstErr = first.catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(0);
    ready(child);
    await vi.advanceTimersByTimeAsync(0);

    // 看门狗到期：轻量隔离——当次拒绝、host 保留、排队调用不被连带拒绝
    await vi.advanceTimersByTimeAsync(50);
    const error = await firstErr;
    expect(error).toBeInstanceOf(Error);
    expect(String(error.message)).toContain("超时");
    expect(child.kill).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[ToolHost]"),
      expect.stringContaining("轻量隔离"),
    );

    const writtenTools = (): string[] =>
      child.stdin.write.mock.calls
        .map(([line]) => String(line))
        .filter((line) => line.includes('"op":"call"'))
        .map((line) => (JSON.parse(line) as { tool: string }).tool);
    expect(writtenTools()).toEqual(["search_text"]); // 排空完成前不派发后续调用

    // 迟到结果帧到达：丢弃结果、排空完成、继续派发排队调用
    child.stdout.write(`${JSON.stringify({ op: "result", callId: "t1", ok: true, data: "late" })}\n`);
    await vi.advanceTimersByTimeAsync(0);
    expect(writtenTools()).toEqual(["search_text", "read_file"]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[ToolHost]"),
      expect.stringContaining("结果帧到达（丢弃）"),
    );
    expect(vi.getTimerCount()).toBe(1); // 兜底计时器已清除（仅剩 read_file 看门狗）

    child.stdout.write(`${JSON.stringify({ op: "result", callId: "t2", ok: true, data: "ok2" })}\n`);
    await expect(second).resolves.toBe("ok2");
    expect(child.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0); // 排空完成路径无计时器遗留

    warnSpy.mockRestore();
    vi.useRealTimers();
  });

  it("排空兜底：窗口到期仍无结果 → 杀 host 收敛，排队调用按 sentinel 安全回退", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { host, child } = startHost();

    const first = host.call("search_text", { query: "x" }, 50, undefined, undefined, undefined, true);
    const second = host.call("read_file", { path: "C:\\a.txt" });
    const firstErr = first.catch((error: Error) => error);
    const secondErr = second.catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(0);
    ready(child);
    await vi.advanceTimersByTimeAsync(0);

    // 看门狗到期：当次拒绝、不杀 host（排空兜底 = max(50ms, 5s) = 5s）
    await vi.advanceTimersByTimeAsync(50);
    await expect(firstErr).resolves.toBeInstanceOf(Error);
    expect(child.kill).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(4_999);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[ToolHost]"),
      expect.stringContaining("排空超时"),
    );

    // 真实 kill 后进程退出：排队调用以「确定未派发」sentinel 安全回退
    child.emit("exit", 1, null);
    const secondError = await secondErr;
    expect(secondError).toBeInstanceOf(NativeCallNotDispatchedError);
    expect((secondError as { code?: string }).code).toBe("E_TOOL_NOT_DISPATCHED");

    warnSpy.mockRestore();
    vi.useRealTimers();
  });

  it("排空期间 host 自行退出：兜底计时器清除，排队调用 sentinel 回退、不误杀", async () => {
    vi.useFakeTimers();
    const { host, child } = startHost();

    const first = host.call("search_text", { query: "x" }, 50, undefined, undefined, undefined, true);
    const second = host.call("read_file", { path: "C:\\a.txt" });
    const firstErr = first.catch((error: Error) => error);
    const secondErr = second.catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(0);
    ready(child);
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(50);
    await expect(firstErr).resolves.toBeInstanceOf(Error);

    // host 崩溃退出：排空标记随之清除，排队调用确定性回退
    child.emit("exit", 1, null);
    await expect(secondErr).resolves.toBeInstanceOf(NativeCallNotDispatchedError);
    expect(vi.getTimerCount()).toBe(0); // 兜底计时器已随退出清除（直接断言，不依赖兜底守卫）

    // 排空兜底计时器已清除：远超窗口也不会再触发 kill
    await vi.advanceTimersByTimeAsync(10_000);
    expect(child.kill).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it("排空窗口内取消：当次已结算不再杀 host，排队调用按既有逻辑摘除", async () => {
    vi.useFakeTimers();
    const { host, child } = startHost();
    const controller = new AbortController();

    const first = host.call("search_text", { query: "x" }, 50, undefined, undefined, undefined, true);
    const second = host.call("read_file", { path: "C:\\a.txt" }, undefined, controller.signal);
    const firstErr = first.catch((error: Error) => error);
    const secondErr = second.catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(0);
    ready(child);
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(50); // 进入排空窗口（当次已结算）
    await expect(firstErr).resolves.toBeInstanceOf(Error);

    // 排队调用取消：摘除 + AbortError；不触达 host、不杀进程（父运行取消不影响已放弃的只读调用）
    controller.abort();
    await expect(secondErr).resolves.toMatchObject({ name: "AbortError" });
    expect(child.kill).not.toHaveBeenCalled();

    // 迟到结果到达、排空完成；队列已空 → 无新帧、无杀进程、无计时器遗留
    child.stdout.write(`${JSON.stringify({ op: "result", callId: "t1", ok: true, data: "late" })}\n`);
    await vi.advanceTimersByTimeAsync(0);
    expect(child.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    vi.useRealTimers();
  });

  it("被放弃调用自身的取消信号：排空窗口内 abort 不杀 host、无二次结算", async () => {
    vi.useFakeTimers();
    const { host, child } = startHost();
    const controller = new AbortController();

    const first = host.call("search_text", { query: "x" }, 50, controller.signal, undefined, undefined, true);
    const firstErr = first.catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(0);
    ready(child);
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(50); // 超时：当次结算为「超时」，abort 监听随结算移除
    const error = await firstErr;
    expect(String(error.message)).toContain("超时");
    expect((error as Error).name).not.toBe("AbortError");

    // 排空窗口内 abort：已结算调用不再响应（若监听未移除，会经 onAbort 误杀 host——旧语义的连带场景）
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(child.kill).not.toHaveBeenCalled();

    // 迟到结果仍能完成排空
    child.stdout.write(`${JSON.stringify({ op: "result", callId: "t1", ok: true, data: "late" })}\n`);
    await vi.advanceTimersByTimeAsync(0);
    expect(child.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    vi.useRealTimers();
  });
});

// ── 启动失败清理与失败缓存（IKJSNB）────────────────────────

describe("启动失败清理与失败缓存（IKJSNB）", () => {
  beforeEach(() => {
    mocks.spawn.mockReset();
    mocks.resolveNativeWindowsExe.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("ready 超时：kill 子进程 + 清理 waiter；迟到 ready 不误唤醒下一次启动", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { host, child } = startHost();

    const first = host.ensureStarted();
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(first).resolves.toBe(false);
    expect(child.kill).toHaveBeenCalledTimes(1); // 超时失败必须杀子进程（不留孤儿）
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[ToolHost]"),
      expect.stringContaining("启动失败"),
      expect.stringContaining("启动超时"),
    );

    // 失败缓存窗口内（30s）：不再 spawn，直接 false（call 静默回退 TS）
    await expect(host.ensureStarted()).resolves.toBe(false);
    await expect(host.call("search_text", { query: "x" })).resolves.toBeNull();
    expect(mocks.spawn).toHaveBeenCalledTimes(1);

    // 窗口过后：允许重试 spawn（自愈）
    await vi.advanceTimersByTimeAsync(30_000);
    const second = new FakeChild();
    mocks.spawn.mockReturnValue(second);
    const retry = host.ensureStarted();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.spawn).toHaveBeenCalledTimes(2);

    // 旧实例迟到 ready：不得唤醒新实例的启动 waiter（否则新实例就绪前即返回 true）
    child.stdout.write('{"op":"ready"}\n');
    await vi.advanceTimersByTimeAsync(0);
    let settled = false;
    void retry.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);

    ready(second);
    await expect(retry).resolves.toBe(true);
    warnSpy.mockRestore();
  });

  it("启动即退出：失败缓存窗口内不重复 spawn，窗口后允许重试", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { host, child } = startHost();

    const first = host.ensureStarted();
    await vi.advanceTimersByTimeAsync(0);
    child.emit("exit", 1, null);
    await expect(first).resolves.toBe(false);
    // 启动失败收尾必须杀已 spawn 的子进程（不留孤儿；复审 P2-6 断言补强）
    expect(child.kill).toHaveBeenCalledTimes(1);

    await expect(host.ensureStarted()).resolves.toBe(false);
    expect(mocks.spawn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);
    const second = new FakeChild();
    mocks.spawn.mockReturnValue(second);
    const retry = host.ensureStarted();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
    ready(second);
    await expect(retry).resolves.toBe(true);
    warnSpy.mockRestore();
  });

  it("spawn 同步异常：返回 false 并进入失败缓存（不反复 spawn）", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.spawn.mockImplementation(() => { throw new Error("spawn EINVAL"); });
    const host = new NativeToolHost();

    await expect(host.ensureStarted()).resolves.toBe(false);
    await expect(host.ensureStarted()).resolves.toBe(false);
    expect(mocks.spawn).toHaveBeenCalledTimes(1);

    // 窗口过后允许重试（仍失败则重新计窗）
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(host.ensureStarted()).resolves.toBe(false);
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
    warnSpy.mockRestore();
  });

  it("spawn 异步错误：按启动失败收尾（kill + 失败缓存），不干等 3s 超时", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { host, child } = startHost();

    const first = host.ensureStarted();
    await vi.advanceTimersByTimeAsync(0);
    child.emit("error", new Error("spawn ENOENT"));

    await expect(first).resolves.toBe(false);
    expect(child.kill).toHaveBeenCalledTimes(1); // 失败收尾必须杀子进程
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[ToolHost]"),
      expect.stringContaining("host 进程错误"),
      "spawn ENOENT",
    );

    // 失败缓存生效：窗口内不重复 spawn
    await expect(host.ensureStarted()).resolves.toBe(false);
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it("成功启动清缓存：运行期崩溃后立即允许监督重启（不被旧失败缓存拖住）", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { host } = startHost();

    // 首次启动超时失败
    const first = host.ensureStarted();
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(first).resolves.toBe(false);

    // 窗口后重试成功
    await vi.advanceTimersByTimeAsync(30_000);
    const second = new FakeChild();
    mocks.spawn.mockReturnValue(second);
    const retry = host.ensureStarted();
    await vi.advanceTimersByTimeAsync(0);
    ready(second);
    await expect(retry).resolves.toBe(true);

    // 运行期崩溃：缓存已清，下次 ensureStarted 立即拉起（进程监督语义不退化）
    second.emit("exit", 1, null);
    const third = new FakeChild();
    mocks.spawn.mockReturnValue(third);
    const restart = host.ensureStarted();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.spawn).toHaveBeenCalledTimes(3);
    ready(third);
    await expect(restart).resolves.toBe(true);
    warnSpy.mockRestore();
  });
});

// ── 信任边界（P0，docs/pr-review-rules.md §2.3）────────────

describe("nativeFirst 信任边界（__ 内部参数）", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("模型 args 携带 __ 键：下发宿主前被剥离，fallback 不触发", async () => {
    const call = vi.spyOn(nativeToolHost, "call").mockResolvedValue("ok");
    const fallback = vi.fn(() => "ts");

    const out = await nativeFirst(
      "fetch_url",
      { url: "https://github.com/o/r", __githubApiBase: "https://evil.example" },
      fallback,
    );

    expect(out).toBe("ok");
    expect(call).toHaveBeenCalledWith(
      "fetch_url",
      { url: "https://github.com/o/r" },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    );
    expect(fallback).not.toHaveBeenCalled();
  });

  it("meta 可信注入：模型伪造的 __ 键被剥离，内部参数只走 meta 通道（不混入 args）", async () => {
    const call = vi.spyOn(nativeToolHost, "call").mockResolvedValue("ok");

    await nativeFirst(
      "search_text",
      { query: "x", __cyreneWorkspaceRoot: "C:\\evil" },
      () => "ts",
      { meta: { workspaceRoot: "C:\\trusted" } },
    );

    expect(call).toHaveBeenCalledWith(
      "search_text",
      { query: "x" },
      undefined,
      undefined,
      { workspaceRoot: "C:\\trusted" },
      undefined,
      undefined,
    );
  });

  it("fallbackOnError=false：native 在途失败不重跑副作用，结构化上抛 effectState=unknown", async () => {
    vi.spyOn(nativeToolHost, "call").mockRejectedValue(new Error("native 工具 send_email 超时"));
    const fallback = vi.fn(() => "已发送");

    const failure = await nativeFirst("send_email", { to: ["a@b.com"] }, fallback, { fallbackOnError: false })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ToolExecutionError);
    expect(failure).toMatchObject({
      code: "E_TOOL_EFFECT_UNKNOWN",
      effectState: "unknown",
      retryable: false,
    });
    expect((failure as Error).message).toContain("状态未知");
    expect((failure as Error).message).toContain("超时");
    expect(fallback).not.toHaveBeenCalled();
  });

  it("fallbackOnError=false：排队未派发 sentinel 确定未执行 → 安全回退 TS", async () => {
    vi.spyOn(nativeToolHost, "call").mockRejectedValue(new NativeCallNotDispatchedError());
    const fallback = vi.fn(() => "已发送");

    const out = await nativeFirst("send_email", { to: ["a@b.com"] }, fallback, { fallbackOnError: false });

    expect(out).toBe("已发送");
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it("fallbackOnError=false：safeFallbackCodes（E_EMAIL_PRECONDITION 确定未进入发送）→ 安全回退 TS", async () => {
    vi.spyOn(nativeToolHost, "call").mockRejectedValue(Object.assign(
      new Error("发送失败（未进入发送阶段）：认证失败"),
      { code: "E_EMAIL_PRECONDITION" },
    ));
    const fallback = vi.fn(() => "已发送");

    const out = await nativeFirst("send_email", { to: ["a@b.com"] }, fallback, {
      fallbackOnError: false,
      safeFallbackCodes: ["E_EMAIL_PRECONDITION"],
    });

    expect(out).toBe("已发送");
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it("fallbackOnError=false：宿主不可用（call 返回 null）仍安全回退 TS", async () => {
    vi.spyOn(nativeToolHost, "call").mockResolvedValue(null);
    const fallback = vi.fn(() => "已发送");

    const out = await nativeFirst("send_email", { to: ["a@b.com"] }, fallback, { fallbackOnError: false });

    expect(out).toBe("已发送");
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it("CYRENE_TOOL_HOST=0：零触达宿主，直接回退 TS", async () => {
    const prev = process.env.CYRENE_TOOL_HOST;
    process.env.CYRENE_TOOL_HOST = "0";
    resetDotnetConfigCache();
    try {
      const call = vi.spyOn(nativeToolHost, "call");
      const fallback = vi.fn(() => "ts");

      const out = await nativeFirst("fetch_url", { url: "https://example.com" }, fallback);

      expect(out).toBe("ts");
      expect(call).not.toHaveBeenCalled();
      expect(fallback).toHaveBeenCalledTimes(1);
    } finally {
      if (prev === undefined) delete process.env.CYRENE_TOOL_HOST;
      else process.env.CYRENE_TOOL_HOST = prev;
      resetDotnetConfigCache();
    }
  });
});

describe("withNativeFirst 信任边界（__ 内部参数）", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prepare 收到剥离 __ 后的模型 args；写入 meta 的可信参数随帧下发（不混入 args）", async () => {
    const call = vi.spyOn(nativeToolHost, "call").mockResolvedValue("ok");
    const seen: Record<string, unknown>[] = [];
    const base: ToolDefinition = {
      id: "fake_tool",
      name: "fake",
      description: "fake",
      enabled: true,
      risk: "safe",
      modes: ["code"],
      effectKind: "read",
      inputSchema: { type: "object" },
      execute: async () => "ts",
    };
    const wrapped = withNativeFirst(base, "fake_tool", (args, _ctx, meta) => {
      seen.push(args);
      meta.workspaceRoot = "C:\\trusted";
      return { ...args, mode: "native" };
    });

    const out = await wrapped.execute({ pattern: "x", __evil: "1" }, undefined);

    expect(out).toBe("ok");
    expect(seen).toEqual([{ pattern: "x" }]);
    expect(call).toHaveBeenCalledWith(
      "fake_tool",
      { pattern: "x", mode: "native" },
      undefined,
      undefined,
      { workspaceRoot: "C:\\trusted" },
      undefined,
      false,
    );
  });

  it("prepare 未写 meta：调用帧 meta 为 undefined（不产生空 meta 对象）", async () => {
    const call = vi.spyOn(nativeToolHost, "call").mockResolvedValue("ok");
    const base: ToolDefinition = {
      id: "fake_tool",
      name: "fake",
      description: "fake",
      enabled: true,
      risk: "safe",
      modes: ["code"],
      effectKind: "read",
      inputSchema: { type: "object" },
      execute: async () => "ts",
    };
    const wrapped = withNativeFirst(base, "fake_tool", (args) => args);

    await wrapped.execute({ pattern: "x" }, undefined);

    expect(call).toHaveBeenCalledWith("fake_tool", { pattern: "x" }, undefined, undefined, undefined, undefined, false);
  });

  it("prepare 返回 null：TS 回退收到已剥离 __ 的 args（P2-6④ 口径一致）", async () => {
    const call = vi.spyOn(nativeToolHost, "call");
    const seen: Record<string, unknown>[] = [];
    const base: ToolDefinition = {
      id: "fake_tool",
      name: "fake",
      description: "fake",
      enabled: true,
      risk: "safe",
      modes: ["code"],
      effectKind: "read",
      inputSchema: { type: "object" },
      execute: async (args) => {
        seen.push(args);
        return "ts";
      },
    };
    const wrapped = withNativeFirst(base, "fake_tool", () => null);

    const out = await wrapped.execute({ pattern: "x", __evil: "1" }, undefined);

    expect(out).toBe("ts");
    expect(call).not.toHaveBeenCalled();
    expect(seen).toEqual([{ pattern: "x" }]);
  });
});

// ── 不确定副作用入账（P2-1）────────────────────────────────

describe("不确定副作用入账（P2-1）", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fallbackOnError=false 的在途失败：outcome=unknown 且同 fingerprint 重放被拦截", async () => {
    vi.spyOn(nativeToolHost, "call").mockRejectedValue(new Error("native 工具 send_email 超时"));
    const state: AgentState = { todoItems: [], uncertainEffects: [] };
    const sendTool: ToolDefinition = {
      id: "send_email",
      name: "发送邮件",
      description: "send",
      enabled: true,
      inputSchema: { type: "object" },
      effectKind: "external_side_effect",
      execute: () => nativeFirst(
        "send_email",
        { to: ["a@b.com"] },
        () => "已发送",
        { fallbackOnError: false },
      ),
    };
    const context = {
      state,
      tools: [sendTool],
      toolContext: { userQuery: "", runId: "run-1" },
    };
    const call = (id: string) => ({
      id,
      name: "send_email",
      arguments: JSON.stringify({ to: ["a@b.com"] }),
    });

    const first = await dispatchToolCall(call("call-1"), context);
    expect(first.outcome).toBe("unknown");
    expect(state.uncertainEffects).toHaveLength(1);
    expect(state.uncertainEffects[0].fingerprint).toBeTruthy();

    // 同 fingerprint 重放：被 uncertainEffects 拦截，不重复投递
    const replay = await dispatchToolCall(call("call-1"), context);
    expect(replay.outcome).toBe("not_executed");
    expect(replay.message).toContain(state.uncertainEffects[0].id);
  });
});

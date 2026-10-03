/**
 * NativeToolHost.call 客户端层看门狗测试。
 *
 * 背景（PR #1 审查阻断项）：dual-track-diff 直接 spawn smoke-host 通信，
 * 绕过了 NativeToolHost 的调用超时层；默认 5s 会误杀长任务
 * （download_file / exchange_rate），因此这里直接驱动客户端校验：
 *  - 显式 timeoutMs 生效：到期 kill host 并 reject
 *  - 结果帧在窗口内返回：清除定时器、不误杀
 *  - 缺省仍为 5s：短工具的默认保护不被长任务参数污染
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

import { NativeToolHost } from "./native-tool-host";

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

  it("超时 kill 后：日志列出连带拒绝的在途调用，exit 时全部 reject", async () => {
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
      expect.stringContaining("连带拒绝 1 个在途调用"),
    );

    // 真实 kill 后进程退出：在途的第二调用被连带拒绝
    child.emit("exit", 1, null);
    await expect(secondErr).resolves.toBeInstanceOf(Error);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[ToolHost]"),
      expect.stringContaining("host 退出：连带拒绝 1 个在途调用"),
    );

    warnSpy.mockRestore();
    vi.useRealTimers();
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
});

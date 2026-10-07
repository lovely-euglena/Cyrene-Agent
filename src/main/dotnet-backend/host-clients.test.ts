/**
 * LineHostClient 进程/监听器生命周期测试（IKJSNF）。
 *
 * 覆盖：
 *  - 启动不可用（stdout 不可读）→ kill 已 spawn 的子进程，不留孤儿
 *  - killAndReset 后旧 child 迟到 exit/error：不清掉新 child 引用（无幽灵双 host）
 *  - SIGTERM 无响应 → KILL_ESCALATE_MS 后 SIGKILL；exit 到达则取消兜底
 *  - addEventListener/removeEventListener 成对（移除后不再收帧）
 */

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  resolveNativeWindowsExe: vi.fn(() => "C:\\fake\\cyrene-native.exe"),
}));

vi.mock("child_process", () => ({ spawn: mocks.spawn }));
vi.mock("../windows/native-windows-host", () => ({
  resolveNativeWindowsExe: mocks.resolveNativeWindowsExe,
}));

import { LineHostClient } from "./host-clients";

class FakeChild extends EventEmitter {
  pid = 4242;
  stdout: PassThrough | null = new PassThrough();
  stderr = new PassThrough();
  stdin = { writable: true, write: vi.fn(() => true) };
  kill = vi.fn();
}

/** 启动客户端并模拟 spawn 事件（ready 握手在 ensureStarted 里只等 spawn）。 */
async function boot(client: LineHostClient, child: FakeChild): Promise<void> {
  const started = client.ensureStarted();
  child.emit("spawn");
  await expect(started).resolves.toBe(true);
}

describe("LineHostClient 生命周期（IKJSNF）", () => {
  beforeEach(() => {
    mocks.spawn.mockReset();
    mocks.resolveNativeWindowsExe.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("启动不可用（stdout 不可读）：kill 已 spawn 的子进程，不留孤儿", async () => {
    const child = new FakeChild();
    child.stdout = null;
    mocks.spawn.mockReturnValue(child);
    const client = new LineHostClient("--tool-host", 1_000);

    await expect(client.ensureStarted()).resolves.toBe(false);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(client.isAlive()).toBe(false);

    // starting 已清：下一次 ensureStarted 重新 spawn（失败 promise 不被永久缓存）
    const second = new FakeChild();
    mocks.spawn.mockReturnValue(second);
    await boot(client, second);
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
  });

  it("超时 kill 后旧 child 迟到 exit/error：不清掉新 child 引用（无幽灵双 host）", async () => {
    vi.useFakeTimers();
    const child1 = new FakeChild();
    const child2 = new FakeChild();
    mocks.spawn.mockReturnValueOnce(child1).mockReturnValueOnce(child2);
    const client = new LineHostClient("--tool-host", 1_000);
    await boot(client, child1);

    // 调用超时 → killAndReset（SIGTERM，先摘引用）
    const firstErr = client.call("slow_op", {}).catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(firstErr).resolves.toBeInstanceOf(Error);
    expect(child1.kill).toHaveBeenCalledTimes(1);

    // 旧 child 未及 exit 就拉起新实例
    await boot(client, child2);
    expect(client.isAlive()).toBe(true);

    // 新调用在途：旧 child 迟到 exit/error 不得清引用、也不得连带拒绝新调用
    const second = client.call("op2", {});
    const callFrame = JSON.parse(String(child2.stdin.write.mock.calls[0][0])) as { callId: string };
    child1.emit("exit", 1, null);
    child1.emit("error", new Error("late error"));
    await vi.advanceTimersByTimeAsync(0);
    expect(client.isAlive()).toBe(true);

    child2.stdout!.write(`${JSON.stringify({ op: "result", callId: callFrame.callId, ok: true, data: "ok2" })}\n`);
    await vi.advanceTimersByTimeAsync(0);
    await expect(second).resolves.toBe("ok2");
  });

  it("killAndReset：其余在途调用立即结算，不等各自超时（复审 P2-2）", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    mocks.spawn.mockReturnValue(child);
    const client = new LineHostClient("--tool-host", 1_000);
    await boot(client, child);

    const first = client.call("slow_op", {}).catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(500);
    const second = client.call("other_op", {}).catch((e: Error) => e);

    // t=1000：first 超时 → killAndReset；second（本应在 t=1500 才超时）必须立即结算
    await vi.advanceTimersByTimeAsync(500);
    expect(String((await first).message)).toContain("超时");
    expect(String((await second).message)).toBe("host 已重置");
    expect(child.kill).toHaveBeenCalledTimes(1);

    // 无二次结算 / 无残留定时器：推进到 second 原超时点，不再有额外 kill 或未处理拒绝
    await vi.advanceTimersByTimeAsync(1_000);
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("SIGTERM 后 5s 无 exit：SIGKILL 强杀兜底（与 shutdown 对齐）", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    mocks.spawn.mockReturnValue(child);
    const client = new LineHostClient("--tool-host", 1_000);
    await boot(client, child);

    const rejection = client.call("slow_op", {}).catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(1_000); // 超时 → SIGTERM
    await expect(rejection).resolves.toBeInstanceOf(Error);
    expect(child.kill.mock.calls).toEqual([[]]);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(child.kill).toHaveBeenCalledTimes(1); // 窗口内不提前强杀
    await vi.advanceTimersByTimeAsync(1);
    expect(child.kill.mock.calls[1]).toEqual(["SIGKILL"]);
  });

  it("exit 到达：取消强杀兜底计时器（不再补 SIGKILL）", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    mocks.spawn.mockReturnValue(child);
    const client = new LineHostClient("--tool-host", 1_000);
    await boot(client, child);

    const rejection = client.call("slow_op", {}).catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(rejection).resolves.toBeInstanceOf(Error);

    child.emit("exit", 0, null); // 进程真实退出 → 兜底取消
    await vi.advanceTimersByTimeAsync(5_000);
    expect(child.kill).toHaveBeenCalledTimes(1); // 仅 SIGTERM，无 SIGKILL
  });

  it("连续两次 killAndReset：上一 child 未 exit 时其补杀不被取消（复审二轮 P2-4）", async () => {
    vi.useFakeTimers();
    const child1 = new FakeChild();
    const child2 = new FakeChild();
    mocks.spawn.mockReturnValueOnce(child1).mockReturnValueOnce(child2);
    const client = new LineHostClient("--tool-host", 1_000);
    await boot(client, child1);

    // t=1000：child1 调用超时 → killAndReset（SIGTERM；child1 未及 exit）
    const first = client.call("slow_op", {}).catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(first).resolves.toBeInstanceOf(Error);
    expect(child1.kill.mock.calls).toEqual([[]]);

    // 旧 child 未 exit 即拉起新实例；新实例再次超时重置（单槽实现会连带取消 child1 的补杀）
    await boot(client, child2);
    const second = client.call("slow_op2", {}).catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(1_000); // t=2000
    await expect(second).resolves.toBeInstanceOf(Error);
    expect(child2.kill.mock.calls).toEqual([[]]);

    // child1 的 5s 兜底按自己的时钟照常触发（t=6000）；child2 尚未到点
    await vi.advanceTimersByTimeAsync(4_000);
    expect(child1.kill.mock.calls[1]).toEqual(["SIGKILL"]);
    expect(child2.kill).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_001); // t=7001：child2 兜底到点
    expect(child2.kill.mock.calls[1]).toEqual(["SIGKILL"]);
  });

  it("addEventListener/removeEventListener 成对：移除后不再收帧", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    mocks.spawn.mockReturnValue(child);
    const client = new LineHostClient("--tool-host", 1_000);
    await boot(client, child);

    const removed = vi.fn();
    const kept = vi.fn();
    client.addEventListener(removed);
    client.addEventListener(kept);
    client.removeEventListener(removed);
    client.removeEventListener(removed); // 幂等：未订阅/重复移除 no-op

    child.stdout!.write('{"op":"log","message":"x"}\n');
    await vi.advanceTimersByTimeAsync(0);
    expect(removed).not.toHaveBeenCalled();
    expect(kept).toHaveBeenCalledTimes(1);
    expect(kept.mock.calls[0][0]).toMatchObject({ op: "log", message: "x" });
  });

  it("派发中移除自身：本轮其余订阅者仍收到帧（快照派发）", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    mocks.spawn.mockReturnValue(child);
    const client = new LineHostClient("--tool-host", 1_000);
    await boot(client, child);

    const first = vi.fn(() => client.removeEventListener(first));
    const second = vi.fn();
    client.addEventListener(first);
    client.addEventListener(second);

    child.stdout!.write('{"op":"vad_result","speech":true}\n');
    await vi.advanceTimersByTimeAsync(0);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    child.stdout!.write('{"op":"vad_result","speech":false}\n');
    await vi.advanceTimersByTimeAsync(0);
    expect(first).toHaveBeenCalledTimes(1); // 已移除
    expect(second).toHaveBeenCalledTimes(2);
  });
});

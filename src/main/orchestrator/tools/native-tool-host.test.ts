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

import { NativeToolHost, nativeFirst, nativeToolHost, withNativeFirst } from "./native-tool-host";
import type { ToolDefinition } from "./registry/tool-registry";
import { resetDotnetConfigCache } from "../../dotnet-backend/config";

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
    );
    expect(fallback).not.toHaveBeenCalled();
  });

  it("internalArgs 可信注入：模型伪造的同名 __ 键被覆盖", async () => {
    const call = vi.spyOn(nativeToolHost, "call").mockResolvedValue("ok");

    await nativeFirst(
      "search_text",
      { query: "x", __cyreneWorkspaceRoot: "C:\\evil" },
      () => "ts",
      { internalArgs: { __cyreneWorkspaceRoot: "C:\\trusted" } },
    );

    expect(call).toHaveBeenCalledWith(
      "search_text",
      { query: "x", __cyreneWorkspaceRoot: "C:\\trusted" },
      undefined,
      undefined,
      undefined,
    );
  });

  it("fallbackOnError=false：native 失败不重跑副作用，返回不确定态提示", async () => {
    vi.spyOn(nativeToolHost, "call").mockRejectedValue(new Error("native 工具 send_email 超时"));
    const fallback = vi.fn(() => "已发送");

    const out = await nativeFirst("send_email", { to: ["a@b.com"] }, fallback, { fallbackOnError: false });

    expect(out).toContain("状态未知");
    expect(out).toContain("超时");
    expect(fallback).not.toHaveBeenCalled();
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

  it("prepare 收到剥离 __ 后的模型 args；prepare 注入的可信参数保留", async () => {
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
    const wrapped = withNativeFirst(base, "fake_tool", (args) => {
      seen.push(args);
      return { ...args, __trusted: "1" };
    });

    const out = await wrapped.execute({ pattern: "x", __evil: "1" }, undefined);

    expect(out).toBe("ok");
    expect(seen).toEqual([{ pattern: "x" }]);
    expect(call).toHaveBeenCalledWith(
      "fake_tool",
      { pattern: "x", __trusted: "1" },
      undefined,
      undefined,
    );
  });
});

/**
 * DotnetPluginAdapter 协议测试（mock 子进程——不真 spawn）。
 *
 * 覆盖：ready 握手与工具注册（含 dataDir/risk 透传）、invoke 应答路由、
 * 进程意外退出的在途失败与状态上报、下次调用自愈重启、shutdown 优雅关停、
 * 协议外 stdout 行容错。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";
import path from "node:path";

vi.mock("node:child_process", () => {
  const spawn = vi.fn();
  return { spawn };
});

import { spawn as mockSpawn } from "node:child_process";
import { DotnetPluginAdapter } from "./dotnet-adapter";
import type { PluginRecord } from "./types";

interface FakeChild {
  child: ChildProcess;
  emitLine(line: string): void;
  /** 直接投递原始 stdout 字节（不加换行，用于模拟跨 chunk 分帧） */
  emitRaw(data: Buffer | string): void;
  /** 触发进程退出（on("exit") 与 once("exit") 两类监听都触发） */
  emitExit(code?: number | null): void;
  written: string[];
}

function makeFakeChild(): FakeChild {
  const dataHandlers: Array<(buf: Buffer) => void> = [];
  const exitHandlers: Array<(code: number | null) => void> = [];
  const onceExitCbs: Array<() => void> = [];
  const written: string[] = [];
  const child = {
    stdin: { write: vi.fn((data: string) => { written.push(data); return true; }), writable: true },
    stdout: {
      setEncoding: vi.fn(),
      on: vi.fn((_event: string, cb: (buf: Buffer) => void) => { dataHandlers.push(cb); }),
    },
    stderr: { setEncoding: vi.fn(), on: vi.fn() },
    once: vi.fn((event: string, cb: () => void) => { if (event === "exit") { onceExitCbs.push(cb); } return child; }),
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      if (event === "exit") exitHandlers.push(cb as (code: number | null) => void);
      return child;
    }),
    kill: vi.fn(),
    pid: 4321,
    connected: true,
  } as unknown as ChildProcess;
  return {
    child,
    written,
    emitExit: (code: number | null = 1) => {
      for (const cb of exitHandlers.splice(0)) cb(code);
      for (const cb of onceExitCbs.splice(0)) cb();
    },
    emitLine: (line: string) => {
      for (const cb of dataHandlers) cb(Buffer.from(`${line}\n`));
    },
    emitRaw: (data: Buffer | string) => {
      const buf = typeof data === "string" ? Buffer.from(data) : data;
      for (const cb of dataHandlers) cb(buf);
    },
  };
}

function makeRecord(): PluginRecord {
  return {
    dir: "/plugins/my-plugin",
    fingerprint: "f1",
    manifest: {
      apiVersion: 1,
      id: "my-plugin",
      name: "测试插件",
      version: "0.1.0",
      description: "",
      author: "",
      entry: "MyPlugin.exe",
      runtime: "dotnet",
      defaultEnabled: true,
    },
  } as unknown as PluginRecord;
}

function makeCtx(registered: unknown[] = []): { ctx: never; registered: unknown[] } {
  const ctx = {
    registerTool: (tool: unknown) => registered.push(tool),
    onDispose: vi.fn(),
    signal: new AbortController().signal,
    storage: { rootDir: () => "/data/my-plugin" },
  } as never;
  return { ctx, registered };
}

describe("DotnetPluginAdapter", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("register: init 帧带 storage.rootDir()，握手后按 ready.tools 注册（含 risk 透传）", async () => {
    const fake = makeFakeChild();
    mockSpawn.mockReturnValueOnce(fake.child);
    const adapter = new DotnetPluginAdapter(makeRecord());
    const { ctx, registered } = makeCtx();

    const pending = adapter.register(ctx);
    const initFrame = JSON.parse(fake.written[0]);
    expect(initFrame.op).toBe("init");
    expect(initFrame.dataDir).toBe("/data/my-plugin");
    expect(mockSpawn).toHaveBeenCalledWith(
      // 平台无关：适配器用 path.join 拼 exe 路径
      path.join("/plugins/my-plugin", "MyPlugin.exe"),
      [],
      expect.objectContaining({ stdio: ["pipe", "pipe", "pipe"] }),
    );

    fake.emitLine(JSON.stringify({
      op: "ready",
      tools: [
        { id: "greet", name: "问候", description: "d", inputSchema: { type: "object", properties: {} }, risk: "fs-write" },
        { id: "poke", name: "戳", description: "d", inputSchema: { type: "object", properties: {} }, risk: "not-a-risk" },
      ],
    }));
    await pending;

    expect(registered).toHaveLength(2);
    const [greet, poke] = registered as Array<{ id: string; risk?: string }>;
    expect(greet.id).toBe("my-plugin_greet");
    expect(greet.risk).toBe("fs-write");
    expect(poke.id).toBe("my-plugin_poke");
    expect(poke.risk).toBeUndefined();
  });

  it("invoke: result 帧路由回调用方（对象序列化为字符串）", async () => {
    const fake = makeFakeChild();
    mockSpawn.mockReturnValueOnce(fake.child);
    const adapter = new DotnetPluginAdapter(makeRecord());
    const { ctx } = makeCtx();
    const pendingRegister = adapter.register(ctx);
    fake.emitLine(JSON.stringify({ op: "ready", tools: [] }));
    await pendingRegister;

    const call = adapter.invokeToolForTest("greet", { name: "昔涟" });
    const last = JSON.parse(fake.written[fake.written.length - 1]);
    expect(last.op).toBe("invoke");
    expect(last.tool).toBe("greet");
    expect(last.args).toEqual({ name: "昔涟" });

    fake.emitLine(JSON.stringify({ op: "result", callId: last.callId, ok: true, data: { message: "你好" } }));
    await expect(call).resolves.toBe(JSON.stringify({ message: "你好" }));
  });

  it("意外退出：在途调用失败 + 上报 onUnexpectedExit；重启无进程时下次调用报重启失败", async () => {
    const fake = makeFakeChild();
    mockSpawn.mockReturnValueOnce(fake.child);
    const onUnexpectedExit = vi.fn();
    const adapter = new DotnetPluginAdapter(makeRecord(), { onUnexpectedExit });
    const { ctx } = makeCtx();
    const pendingRegister = adapter.register(ctx);
    fake.emitLine(JSON.stringify({ op: "ready", tools: [] }));
    await pendingRegister;

    const call = adapter.invokeToolForTest("greet", {});
    fake.emitExit(1);
    await expect(call).rejects.toThrow("退出");
    expect(onUnexpectedExit).toHaveBeenCalledWith("my-plugin", expect.stringContaining("进程退出"));
    // 没有可用的第二次 spawn mock：自愈重启失败
    await expect(adapter.invokeToolForTest("greet", {})).rejects.toThrow(/自动重启失败/);
  });

  it("自愈重启：意外退出后下次调用重启进程并恢复（上报 onRestarted）", async () => {
    const first = makeFakeChild();
    const second = makeFakeChild();
    mockSpawn.mockReturnValueOnce(first.child).mockReturnValueOnce(second.child);
    const onRestarted = vi.fn();
    const adapter = new DotnetPluginAdapter(makeRecord(), { onRestarted });
    const { ctx } = makeCtx();
    const pendingRegister = adapter.register(ctx);
    first.emitLine(JSON.stringify({ op: "ready", tools: [] }));
    await pendingRegister;

    first.emitExit(1);
    const call = adapter.invokeToolForTest("greet", { ok: true });
    // 重启握手：新进程 init 后回 ready
    expect(mockSpawn).toHaveBeenCalledTimes(2);
    const initFrame = JSON.parse(second.written[0]);
    expect(initFrame.op).toBe("init");
    second.emitLine(JSON.stringify({ op: "ready", tools: [] }));

    await new Promise((resolve) => setTimeout(resolve, 0));
    const invokeFrame = JSON.parse(second.written[second.written.length - 1]);
    expect(invokeFrame.op).toBe("invoke");
    second.emitLine(JSON.stringify({ op: "result", callId: invokeFrame.callId, ok: true, data: "pong" }));
    await expect(call).resolves.toBe("pong");
    expect(onRestarted).toHaveBeenCalledWith("my-plugin");
  });

  it("unregister: 发送 shutdown 帧；正常关停不触发 onUnexpectedExit", async () => {
    const fake = makeFakeChild();
    mockSpawn.mockReturnValueOnce(fake.child);
    const onUnexpectedExit = vi.fn();
    const adapter = new DotnetPluginAdapter(makeRecord(), { onUnexpectedExit });
    const { ctx } = makeCtx();
    const pendingRegister = adapter.register(ctx);
    fake.emitLine(JSON.stringify({ op: "ready", tools: [] }));
    await pendingRegister;

    const unregisterDone = adapter.unregister?.();
    fake.emitExit(0);
    await unregisterDone;
    const last = JSON.parse(fake.written[fake.written.length - 1]);
    expect(last.op).toBe("shutdown");
    expect(onUnexpectedExit).not.toHaveBeenCalled();
    // 关停后的调用直接拒绝（不再自愈重启）
    await expect(adapter.invokeToolForTest("greet", {})).rejects.toThrow("未运行");
  });

  it("协议外 stdout 行被安全忽略，log 帧不打断流程", async () => {
    const fake = makeFakeChild();
    mockSpawn.mockReturnValueOnce(fake.child);
    const adapter = new DotnetPluginAdapter(makeRecord());
    const { ctx } = makeCtx();
    const pendingRegister = adapter.register(ctx);
    fake.emitLine("dotnet runtime noise line");
    fake.emitLine(JSON.stringify({ op: "log", level: "info", message: "hi" }));
    fake.emitLine(JSON.stringify({ op: "ready", tools: [] }));
    await expect(pendingRegister).resolves.toBeUndefined();
  });

  it("跨 chunk 分帧：整行被拆开、多字节字符被拆到两个 chunk，仍能解析", async () => {
    const fake = makeFakeChild();
    mockSpawn.mockReturnValueOnce(fake.child);
    const adapter = new DotnetPluginAdapter(makeRecord());
    const { ctx } = makeCtx();
    const pendingRegister = adapter.register(ctx);

    // ready 帧切成两半投递（含中文多字节字符跨 chunk）
    const ready = Buffer.from(`${JSON.stringify({ op: "ready", tools: [] })}\n`);
    const cut = Math.floor(ready.length / 2);
    fake.emitRaw(ready.subarray(0, cut));
    fake.emitRaw(ready.subarray(cut));
    await expect(pendingRegister).resolves.toBeUndefined();

    // 200KB 级别的大结果：按 7 字节切片投递，验证缓冲拼接
    const call = adapter.invokeToolForTest("big", {});
    const invokeFrame = JSON.parse(fake.written[fake.written.length - 1]);
    const payload = "汉".repeat(70_000); // 210KB UTF-8
    const resultBuf = Buffer.from(`${JSON.stringify({ op: "result", callId: invokeFrame.callId, ok: true, data: payload })}\n`);
    for (let offset = 0; offset < resultBuf.length; offset += 7) {
      fake.emitRaw(resultBuf.subarray(offset, offset + 7));
    }
    await expect(call).resolves.toBe(payload);
  });

  it("SDK error 帧：拒绝握手、不按意外退出上报、不重启", async () => {
    const fake = makeFakeChild();
    mockSpawn.mockReturnValueOnce(fake.child);
    const onUnexpectedExit = vi.fn();
    const adapter = new DotnetPluginAdapter(makeRecord(), { onUnexpectedExit });
    const { ctx } = makeCtx();
    const pending = adapter.register(ctx);
    fake.emitLine(JSON.stringify({
      op: "error",
      code: "api_version_mismatch",
      message: "协议版本不匹配：宿主 apiVersion=99",
      fatal: true,
    }));
    await expect(pending).rejects.toThrow(/协议版本不匹配/);
    expect(fake.child.kill).toHaveBeenCalled();
    fake.emitExit(0);
    expect(onUnexpectedExit).not.toHaveBeenCalled();
  });

  it("invoke 兜底超时：超时后调用方收到错误，而不是永久 pending", async () => {
    vi.useFakeTimers();
    try {
      const fake = makeFakeChild();
      mockSpawn.mockReturnValueOnce(fake.child);
      const adapter = new DotnetPluginAdapter(makeRecord());
      const { ctx } = makeCtx();
      const pendingRegister = adapter.register(ctx);
      fake.emitLine(JSON.stringify({ op: "ready", tools: [] }));
      await vi.advanceTimersByTimeAsync(0);
      await pendingRegister;

      const call = adapter.invokeToolForTest("slow", {});
      void call.catch(() => { /* 防 unhandled rejection */ });
      const invokeFrame = JSON.parse(fake.written[fake.written.length - 1]);
      await vi.advanceTimersByTimeAsync(300_001);
      await expect(call).rejects.toThrow(/调用超时/);
      // 超时要尽力通知插件停止计算（cancel 帧），而不是只放弃等待
      const cancelFrame = JSON.parse(fake.written[fake.written.length - 1]);
      expect(cancelFrame).toMatchObject({ op: "cancel", id: invokeFrame.callId, reason: "timeout" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("工具取消信号：abort 后调用立即失败", async () => {
    const fake = makeFakeChild();
    mockSpawn.mockReturnValueOnce(fake.child);
    const adapter = new DotnetPluginAdapter(makeRecord());
    const { ctx } = makeCtx();
    const pendingRegister = adapter.register(ctx);
    fake.emitLine(JSON.stringify({ op: "ready", tools: [] }));
    await pendingRegister;

    const controller = new AbortController();
    const call = adapter.invokeToolForTest("greet", {}, controller.signal);
    const invokeFrame = JSON.parse(fake.written[fake.written.length - 1]);
    controller.abort();
    await expect(call).rejects.toThrow(/已取消/);
    // abort 要向插件发 cancel 帧（尽力中止计算），老 SDK 会忽略未知 op
    const cancelFrame = JSON.parse(fake.written[fake.written.length - 1]);
    expect(cancelFrame).toMatchObject({ op: "cancel", id: invokeFrame.callId, reason: "abort" });
  });
});
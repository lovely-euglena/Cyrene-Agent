/**
 * DotnetPluginAdapter 协议测试（mock 子进程——不真 spawn）。
 *
 * 覆盖：ready 握手与工具注册、invoke 应答路由、插件退出时在途调用失败、
 * shutdown 优雅关停、协议外 stdout 行容错。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";

vi.mock("node:child_process", () => {
  const spawn = vi.fn();
  return { spawn };
});

import { spawn as mockSpawn } from "node:child_process";
import { DotnetPluginAdapter } from "./dotnet-adapter";
import type { PluginRecord } from "./types";

function makeFakeChild(): {
  child: ChildProcess;
  emitLine(line: string): void;
  emitExit(): void;
  written: string[];
} {
  const handlers: Array<(buf: Buffer) => void> = [];
  const exitCbs: Array<() => void> = [];
  const written: string[] = [];
  const child = {
    stdin: { write: vi.fn((data: string) => { written.push(data); return true; }), writable: true },
    stdout: {
      setEncoding: vi.fn(),
      on: vi.fn((_event: string, cb: (buf: Buffer) => void) => { handlers.push(cb); }),
    },
    stderr: { setEncoding: vi.fn(), on: vi.fn() },
    once: vi.fn((event: string, cb: () => void) => { if (event === "exit") { exitCbs.push(cb); } return child; }),
    on: vi.fn(),
    kill: vi.fn(),
    pid: 4321,
    connected: true,
  } as unknown as ChildProcess;
  return {
    child,
    written,
    emitExit: () => { for (const cb of exitCbs.splice(0)) cb(); },
    emitLine: (line: string) => {
      for (const cb of handlers) cb(Buffer.from(`${line}\n`));
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

describe("DotnetPluginAdapter", () => {
  const restore = () => { vi.clearAllMocks(); };

  afterEach(restore);

  it("register: 握手后按 ready.tools 注册并 spawn 参数正确", async () => {
    const fake = makeFakeChild();
    mockSpawn.mockReturnValueOnce(fake.child);
    const adapter = new DotnetPluginAdapter(makeRecord());
    const registered: unknown[] = [];
    const ctx = {
      registerTool: (tool: unknown) => registered.push(tool),
      onDispose: vi.fn(),
      signal: new AbortController().signal,
    } as never;

    const pending = adapter.register(ctx);
    expect(fake.written[0]).toContain('"op":"init"');
    expect(mockSpawn).toHaveBeenCalledWith(
      "/plugins/my-plugin/MyPlugin.exe",
      [],
      expect.objectContaining({ stdio: ["pipe", "pipe", "pipe"] }),
    );

    fake.emitLine(JSON.stringify({
      op: "ready",
      tools: [{ id: "greet", name: "问候", description: "d", inputSchema: { type: "object", properties: {} } }],
    }));
    await pending;

    expect(registered).toHaveLength(1);
    expect((registered[0] as { id: string }).id).toBe("my-plugin_greet");
  });

  it("invoke: result 帧路由回调用方（对象序列化为字符串）", async () => {
    const fake = makeFakeChild();
    mockSpawn.mockReturnValueOnce(fake.child);
    const adapter = new DotnetPluginAdapter(makeRecord());
    const ctx = { registerTool: vi.fn(), onDispose: vi.fn(), signal: new AbortController().signal } as never;
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

  it("插件进程退出：在途调用失败 + 后续调用直接拒绝", async () => {
    const fake = makeFakeChild();
    mockSpawn.mockReturnValueOnce(fake.child);
    const adapter = new DotnetPluginAdapter(makeRecord());
    const ctx = { registerTool: vi.fn(), onDispose: vi.fn(), signal: new AbortController().signal } as never;
    const pendingRegister = adapter.register(ctx);
    fake.emitLine(JSON.stringify({ op: "ready", tools: [] }));
    await pendingRegister;

    const call = adapter.invokeToolForTest("greet", {});
    // 触发 exit 回调（on("exit") 注册的第一个 handler）
    const onExit = (fake.child.on as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => c[0] === "exit",
    );
    (onExit?.[1] as (code: number | null) => void)?.(1);
    await expect(call).rejects.toThrow("退出");
    await expect(adapter.invokeToolForTest("greet", {})).rejects.toThrow("未运行");
  });

  it("unregister: 发送 shutdown 帧并卸载", async () => {
    const fake = makeFakeChild();
    mockSpawn.mockReturnValueOnce(fake.child);
    const adapter = new DotnetPluginAdapter(makeRecord());
    const ctx = { registerTool: vi.fn(), onDispose: vi.fn(), signal: new AbortController().signal } as never;
    const pendingRegister = adapter.register(ctx);
    fake.emitLine(JSON.stringify({ op: "ready", tools: [] }));
    await pendingRegister;

    const unregisterDone = adapter.unregister?.();
    fake.emitExit();
    await unregisterDone;
    const last = JSON.parse(fake.written[fake.written.length - 1]);
    expect(last.op).toBe("shutdown");
  });

  it("协议外 stdout 行被安全忽略，log 帧不打断流程", async () => {
    const fake = makeFakeChild();
    mockSpawn.mockReturnValueOnce(fake.child);
    const adapter = new DotnetPluginAdapter(makeRecord());
    const ctx = { registerTool: vi.fn(), onDispose: vi.fn(), signal: new AbortController().signal } as never;
    const pendingRegister = adapter.register(ctx);
    fake.emitLine("dotnet runtime noise line");
    fake.emitLine(JSON.stringify({ op: "log", level: "info", message: "hi" }));
    fake.emitLine(JSON.stringify({ op: "ready", tools: [] }));
    await expect(pendingRegister).resolves.toBeUndefined();
  });
});

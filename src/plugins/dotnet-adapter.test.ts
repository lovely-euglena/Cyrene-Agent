/**
 * DotnetPluginAdapter 协议测试（mock 子进程——不真 spawn）。
 *
 * 覆盖：ready 握手与工具注册（含 dataDir/risk 透传）、invoke 应答路由、
 * 进程意外退出的在途失败与状态上报、下次调用自愈重启、shutdown 优雅关停、
 * 协议外 stdout 行容错、跨 chunk 分帧、invoke 超时/取消、SDK error 帧，
 * 以及 v2 桥（IPC / 事件 / 提示词 / open + generation 护栏）。
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

interface FakePromptProvider {
  id: string;
  modes?: string[];
  sources?: string[];
  provide(input: Record<string, unknown>): unknown;
}

interface FakeCtx {
  ctx: never;
  registered: unknown[];
  ipc: Map<string, (...args: unknown[]) => unknown>;
  prompts: FakePromptProvider[];
  subscriptions: Map<string, (payload: unknown) => void | Promise<void>>;
  emitted: Array<{ event: string; payload: unknown }>;
  unregisteredIpc: string[];
  unregisteredPrompts: string[];
  /** manifest.deps 对应的宿主服务（测试按需填充） */
  deps: Record<string, unknown>;
}

function makeCtx(): FakeCtx {
  const registered: unknown[] = [];
  const ipc = new Map<string, (...args: unknown[]) => unknown>();
  const prompts: FakePromptProvider[] = [];
  const subscriptions = new Map<string, (payload: unknown) => void | Promise<void>>();
  const emitted: Array<{ event: string; payload: unknown }> = [];
  const unregisteredIpc: string[] = [];
  const unregisteredPrompts: string[] = [];
  const deps: Record<string, unknown> = {};
  const ctx = {
    registerTool: (tool: unknown) => registered.push(tool),
    registerIpc: (channel: string, handler: (...args: unknown[]) => unknown) => {
      if (ipc.has(channel)) throw new Error(`插件 IPC channel 已注册: ${channel}`);
      ipc.set(channel, handler);
    },
    unregisterIpc: (channel: string) => {
      if (!ipc.delete(channel)) throw new Error(`不能注销不属于当前插件的 IPC channel: ${channel}`);
      unregisteredIpc.push(channel);
    },
    registerPromptProvider: (provider: FakePromptProvider) => prompts.push(provider),
    unregisterPromptProvider: (id: string) => {
      const index = prompts.findIndex((p) => p.id === id);
      if (index < 0) throw new Error(`不能注销不属于当前插件的提示词 Provider: ${id}`);
      prompts.splice(index, 1);
      unregisteredPrompts.push(id);
    },
    events: {
      on: (event: string, listener: (payload: unknown) => void | Promise<void>) => {
        subscriptions.set(event, listener);
        return () => {
          subscriptions.delete(event);
        };
      },
      emit: async (event: string, payload: unknown) => {
        emitted.push({ event, payload });
      },
    },
    onDispose: vi.fn(),
    signal: new AbortController().signal,
    storage: { rootDir: () => "/data/my-plugin" },
    deps,
  };
  return {
    ctx: ctx as never,
    registered,
    ipc,
    prompts,
    subscriptions,
    emitted,
    unregisteredIpc,
    unregisteredPrompts,
    deps,
  };
}

/** ready v2 帧（带声明）；v1 用 readyFrameV1 */
function readyFrameV2(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    op: "ready",
    protocolVersion: 2,
    tools: [],
    ipc: [],
    events: [],
    promptProviders: [],
    capabilities: {},
    ...extra,
  });
}

function lastFrame(fake: FakeChild): Record<string, unknown> {
  return JSON.parse(fake.written[fake.written.length - 1]);
}

/** 等待 async 派发（handlePluginCall 等）完成 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** 模拟插件 → 宿主 call，等 reply 帧落盘后返回 */
async function pluginCall(
  fake: FakeChild,
  id: string,
  method: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  fake.emitLine(JSON.stringify({ op: "call", id, method, params }));
  await flush();
  return lastFrame(fake);
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
    expect(initFrame.protocolVersion).toBe(2);
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

    await flush();
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

  it("v2 ready：IPC / 事件 / 提示词 / open 声明注册进 ctx，且 host→plugin 往返正确", async () => {
    const fake = makeFakeChild();
    mockSpawn.mockReturnValueOnce(fake.child);
    const adapter = new DotnetPluginAdapter(makeRecord());
    const { ctx, ipc, prompts, subscriptions, unregisteredIpc, unregisteredPrompts } = makeCtx();
    const pendingRegister = adapter.register(ctx);
    fake.emitLine(readyFrameV2({
      ipc: ["settings"],
      events: ["host:turn:finished"],
      promptProviders: [{ id: "ctx", modes: ["code"], sources: ["conversation"] }],
      capabilities: { open: true },
    }));
    await pendingRegister;

    expect([...ipc.keys()]).toEqual(["settings"]);
    expect([...subscriptions.keys()]).toEqual(["host:turn:finished"]);
    expect(prompts.map((p) => p.id)).toEqual(["ctx"]);
    expect(typeof adapter.open).toBe("function");

    // IPC 派发：宿主 → 插件 call，插件 reply 回值
    const ipcCall = ipc.get("settings")!(1, "a");
    const dispatchFrame = lastFrame(fake);
    expect(dispatchFrame).toMatchObject({
      op: "call",
      method: "ipc.dispatch",
      params: { channel: "settings", args: [1, "a"] },
    });
    fake.emitLine(JSON.stringify({ op: "reply", id: dispatchFrame.id, ok: true, data: { saved: true } }));
    await expect(ipcCall).resolves.toEqual({ saved: true });

    // 提示词 Provider：input 不携带不可序列化的 signal
    const providerCall = prompts[0].provide({
      source: "conversation",
      mode: "code",
      userText: "hi",
      signal: new AbortController().signal,
    });
    const promptFrame = lastFrame(fake);
    expect(promptFrame).toMatchObject({ op: "call", method: "prompt.provide", params: { providerId: "ctx" } });
    expect((promptFrame.params as Record<string, unknown>).input).not.toHaveProperty("signal");
    fake.emitLine(JSON.stringify({ op: "reply", id: promptFrame.id, ok: true, data: "ctx-block" }));
    await expect(providerCall).resolves.toBe("ctx-block");

    // 宿主事件投递：插件声明的订阅 → notify event.deliver
    subscriptions.get("host:turn:finished")!({ mode: "chat" });
    expect(lastFrame(fake)).toMatchObject({
      op: "notify",
      method: "event.deliver",
      params: { event: "host:turn:finished", payload: { mode: "chat" } },
    });

    // open 能力：call plugin.open 并等 reply
    const openCall = adapter.open!();
    const openFrame = lastFrame(fake);
    expect(openFrame).toMatchObject({ op: "call", method: "plugin.open" });
    fake.emitLine(JSON.stringify({ op: "reply", id: openFrame.id, ok: true, data: null }));
    await expect(openCall).resolves.toBeUndefined();

    // 意外退出 → 本代 v2 注册全部撤销，open 随之失效
    fake.emitExit(1);
    expect([...ipc.keys()]).toEqual([]);
    expect([...subscriptions.keys()]).toEqual([]);
    expect(unregisteredIpc).toEqual(["settings"]);
    expect(prompts).toHaveLength(0);
    expect(unregisteredPrompts).toEqual(["ctx"]);
    expect(adapter.open).toBeUndefined();
  });

  it("插件 → 宿主：events.emit 路由到 ctx.events.emit；未知方法回 ok:false", async () => {
    const fake = makeFakeChild();
    mockSpawn.mockReturnValueOnce(fake.child);
    const adapter = new DotnetPluginAdapter(makeRecord());
    const { ctx, emitted } = makeCtx();
    const pendingRegister = adapter.register(ctx);
    fake.emitLine(readyFrameV2());
    await pendingRegister;

    fake.emitLine(JSON.stringify({
      op: "call",
      id: "p1",
      method: "events.emit",
      params: { event: "weather:updated", payload: { temp: 20 } },
    }));
    await flush();
    expect(emitted).toEqual([{ event: "weather:updated", payload: { temp: 20 } }]);
    expect(lastFrame(fake)).toMatchObject({ op: "reply", id: "p1", ok: true });

    fake.emitLine(JSON.stringify({ op: "call", id: "p2", method: "no.such.method", params: {} }));
    await flush();
    expect(lastFrame(fake)).toMatchObject({ op: "reply", id: "p2", ok: false });
    expect(lastFrame(fake).error).toContain("未知宿主方法");
  });

  it("generation 护栏：重启后按新 ready 重建 v2 注册", async () => {
    const first = makeFakeChild();
    const second = makeFakeChild();
    mockSpawn.mockReturnValueOnce(first.child).mockReturnValueOnce(second.child);
    const adapter = new DotnetPluginAdapter(makeRecord());
    const fakeCtx = makeCtx();
    const pendingRegister = adapter.register(fakeCtx.ctx);
    first.emitLine(readyFrameV2({ ipc: ["settings"], promptProviders: [{ id: "ctx" }] }));
    await pendingRegister;

    expect([...fakeCtx.ipc.keys()]).toEqual(["settings"]);
    first.emitExit(1);
    expect([...fakeCtx.ipc.keys()]).toEqual([]);

    const call = adapter.invokeToolForTest("greet", {});
    second.emitLine(readyFrameV2({ ipc: ["settings"], promptProviders: [{ id: "ctx" }] }));
    await flush();
    expect([...fakeCtx.ipc.keys()]).toEqual(["settings"]);
    expect(fakeCtx.prompts.map((p) => p.id)).toEqual(["ctx"]);

    const invokeFrame = JSON.parse(second.written[second.written.length - 1]);
    second.emitLine(JSON.stringify({ op: "result", callId: invokeFrame.callId, ok: true, data: "ok" }));
    await expect(call).resolves.toBe("ok");
  });

  it("v1 ready（无 protocolVersion）：不注册 v2 能力，open 保持不可用", async () => {
    const fake = makeFakeChild();
    mockSpawn.mockReturnValueOnce(fake.child);
    const adapter = new DotnetPluginAdapter(makeRecord());
    const { ctx, ipc, prompts } = makeCtx();
    const pendingRegister = adapter.register(ctx);
    fake.emitLine(JSON.stringify({
      op: "ready",
      tools: [],
      // 旧宿主/旧 SDK 不会带这些字段；即便带了也不应生效
      ipc: ["settings"],
      promptProviders: [{ id: "ctx" }],
      capabilities: { open: true },
    }));
    await pendingRegister;

    expect(ipc.size).toBe(0);
    expect(prompts).toHaveLength(0);
    expect(adapter.open).toBeUndefined();
  });

  it("deps.* 直通：llm / secrets / channels 路由到 ctx.deps 并回值", async () => {
    const fake = makeFakeChild();
    mockSpawn.mockReturnValueOnce(fake.child);
    const adapter = new DotnetPluginAdapter(makeRecord());
    const fakeCtx = makeCtx();
    const seen: unknown[] = [];
    fakeCtx.deps.channels = { has: (id: string) => id === "feishu" };
    fakeCtx.deps.secrets = {
      get: async (key: string) => {
        seen.push(["get", key]);
        return key === "k1" ? "v1" : undefined;
      },
      set: async (key: string, value: string) => {
        seen.push(["set", key, value]);
      },
      delete: async () => true,
    };
    fakeCtx.deps.llm = {
      generateText: async (messages: unknown, options: unknown) => {
        seen.push(["llm", messages, options]);
        return "llm-out";
      },
    };
    const pendingRegister = adapter.register(fakeCtx.ctx);
    fake.emitLine(readyFrameV2());
    await pendingRegister;

    const has = await pluginCall(fake, "d1", "deps.channels.has", { channelId: "feishu" });
    expect(has).toMatchObject({ op: "reply", id: "d1", ok: true, data: true });

    const got = await pluginCall(fake, "d2", "deps.secrets.get", { key: "k1" });
    expect(got).toMatchObject({ ok: true, data: "v1" });

    const set = await pluginCall(fake, "d3", "deps.secrets.set", { key: "k2", value: "v2" });
    expect(set).toMatchObject({ ok: true, data: null });

    const llm = await pluginCall(fake, "d4", "deps.llm.generateText", {
      messages: [{ role: "user", content: "hi" }],
      options: { maxTokens: 8, purpose: "probe" },
    });
    expect(llm).toMatchObject({ ok: true, data: "llm-out" });

    expect(seen).toEqual([
      ["get", "k1"],
      ["set", "k2", "v2"],
      ["llm", [{ role: "user", content: "hi" }], { maxTokens: 8, purpose: "probe" }],
    ]);
  });

  it("deps 缺失 → E_CAPABILITY_UNAVAILABLE；宿主错误 code 透传；非法参数不冒充宿主错误", async () => {
    const fake = makeFakeChild();
    mockSpawn.mockReturnValueOnce(fake.child);
    const adapter = new DotnetPluginAdapter(makeRecord());
    const fakeCtx = makeCtx();
    fakeCtx.deps.secrets = {
      get: async () => {
        const error = new Error("系统安全存储不可用") as Error & { code: string };
        error.code = "E_STORAGE_UNAVAILABLE";
        throw error;
      },
    };
    const pendingRegister = adapter.register(fakeCtx.ctx);
    fake.emitLine(readyFrameV2());
    await pendingRegister;

    // 未声明 llm：宿主明确回能力不可用，而不是挂起
    const missing = await pluginCall(fake, "d5", "deps.llm.generateText", {
      messages: [{ role: "user", content: "hi" }],
    });
    expect(missing).toMatchObject({ ok: false, code: "E_CAPABILITY_UNAVAILABLE" });

    // 声明后参数校验错误是普通 Error，不带 code（插件可按 message 排查）
    fakeCtx.deps.llm = { generateText: async () => "unused" };
    const bad = await pluginCall(fake, "d7", "deps.llm.generateText", {
      messages: [{ role: "tool", content: "x" }],
    });
    expect(bad.ok).toBe(false);
    expect(bad.code).toBeUndefined();

    // 宿主服务抛出的 PluginHostError：code 原样透传
    const hostErr = await pluginCall(fake, "d6", "deps.secrets.get", { key: "k1" });
    expect(hostErr).toMatchObject({ ok: false, code: "E_STORAGE_UNAVAILABLE", error: "系统安全存储不可用" });

    const unknown = await pluginCall(fake, "d8", "deps.no.such", {});
    expect(unknown.ok).toBe(false);
    expect(unknown.code).toBeUndefined();
  });

  it("deps.llm 选项白名单化（signal 不外传）；scheduler limit 原样交给宿主校验", async () => {
    const fake = makeFakeChild();
    mockSpawn.mockReturnValueOnce(fake.child);
    const adapter = new DotnetPluginAdapter(makeRecord());
    const fakeCtx = makeCtx();
    const seen: unknown[] = [];
    fakeCtx.deps.llm = {
      generateText: async (_messages: unknown, options: unknown) => {
        seen.push(["llm", options]);
        return "ok";
      },
    };
    fakeCtx.deps.scheduler = {
      getHistory: async (taskId: string, limit?: number) => {
        seen.push(["history", taskId, limit]);
        return [];
      },
    };
    const pendingRegister = adapter.register(fakeCtx.ctx);
    fake.emitLine(readyFrameV2());
    await pendingRegister;

    // signal 是进程内对象：必须被丢弃而不是透传；未知字段（temperature）静默降级
    const llm = await pluginCall(fake, "e1", "deps.llm.generateText", {
      messages: [{ role: "user", content: "hi" }],
      options: { maxTokens: 4, signal: { aborted: false }, temperature: 9 },
    });
    expect(llm).toMatchObject({ ok: true, data: "ok" });

    // 非整数 limit 不做本地截断：宿主按 Node 语义回 E_INVALID_ARGUMENT
    const history = await pluginCall(fake, "e2", "deps.scheduler.getHistory", { taskId: "t1", limit: 1.5 });
    expect(history).toMatchObject({ ok: true, data: [] });

    expect(seen).toEqual([
      ["llm", { maxTokens: 4 }],
      ["history", "t1", 1.5],
    ]);
  });
});

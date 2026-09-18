/**
 * AgentProcessManager 帧路由测试（mock 子进程，不真 spawn——
 * cyrene-native 是 net10.0-windows 目标，Linux 构建机不可运行）。
 *
 * 覆盖：llm_request → vendors 代理 → llm_response 回注的成功/失败
 * 路径、tool_request 分发与 tool_result 回注、host 退出时 step 立即
 * 失败、双轨开关未启用时的 API 行为。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("../windows/native-windows-host", () => ({
  resolveNativeWindowsExe: vi.fn(() => "/fake/cyrene-native.exe"),
}));
vi.mock("./vendors", () => ({
  getAdapterForConfig: vi.fn(() => ({ transport: "openai" })),
}));
vi.mock("./vendors/sdk-stream/runtime", () => ({
  streamChatWithSdk: vi.fn(async () => ({ text: "回声模型输出", toolCalls: [] })),
}));

import { spawn as mockSpawn } from "node:child_process";
import { AgentProcessManager } from "./agent-process-manager";
import { streamChatWithSdk } from "./vendors/sdk-stream/runtime";

function makeFakeChild() {
  const lineHandlers: Array<(buf: Buffer) => void> = [];
  const exitHandlers: Array<() => void> = [];
  const written: string[] = [];
  const child = {
    stdin: { write: vi.fn((d: string) => { written.push(d); return true; }), writable: true },
    stdout: {
      setEncoding: vi.fn(),
      on: vi.fn((_e: string, cb: (b: Buffer) => void) => { if (_e === "data") lineHandlers.push(cb); }),
      resume: vi.fn(),
      end: vi.fn(),
      destroy: vi.fn(),
      readable: true,
      isPaused: vi.fn(() => false),
      pause: vi.fn(),
    },
    stderr: { setEncoding: vi.fn(), on: vi.fn() },
    once: vi.fn((_e: string, cb: () => void) => { if (_e === "exit") exitHandlers.push(cb); if (_e === "spawn") cb(); return child; }),
    on: vi.fn((_e: string, cb: () => void) => { if (_e === "exit") exitHandlers.push(cb); return child; }),
    kill: vi.fn(),
  } as unknown as ChildProcess;
  return {
    child,
    emitLine: (line: string) => { for (const cb of lineHandlers) cb(Buffer.from(`${line}\n`)); },
    emitExit: () => { for (const cb of exitHandlers.splice(0)) cb(); },
    written,
  };
}

const VENDOR = { provider: "test", baseUrl: "http://x", model: "m", apiKey: "k" } as never;

afterEach(() => { vi.clearAllMocks(); });

describe("AgentProcessManager", () => {
  it("未启用（CYRENE_AGENT_HOST≠1）时 step 直接失败可回退", async () => {
    delete process.env.CYRENE_AGENT_HOST;
    const mgr = new AgentProcessManager();
    const r = await mgr.step("s1", "hi", VENDOR);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("未启用");
  });

  it("llm_request → 代理 → llm_response 成功路径", async () => {
    process.env.CYRENE_AGENT_HOST = "1";
    const fake = makeFakeChild();
    (mockSpawn as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(fake.child);
    const mgr = new AgentProcessManager();
    const stepDone = mgr.step("s1", "你好", VENDOR);
    // step 发出后 host 会回 ready + llm_request——注入 llm_request 帧
    await new Promise((r) => setTimeout(r, 20));
    const stepFrame = fake.written.map((w) => JSON.parse(w)).find((f) => f.op === "step");
    expect(stepFrame).toBeTruthy();
    fake.emitLine(JSON.stringify({
      op: "llm_request", callId: stepFrame.callId,
      session: { sessionId: "s1", turn: 1, messages: [{ role: "user", content: "你好" }] },
    }));
    await new Promise((r) => setTimeout(r, 30));
    // vendors 代理被调、llm_response 已回注
    expect(streamChatWithSdk).toHaveBeenCalled();
    const resp = fake.written.map((w) => JSON.parse(w)).find((f) => f.op === "llm_response");
    expect(resp.ok).toBe(true);
    expect(resp.content.text).toBe("回声模型输出");
    // host 回 result → step resolve
    fake.emitLine(JSON.stringify({ op: "result", callId: stepFrame.callId, ok: true, data: { state: "done" } }));
    const r = await stepDone;
    expect(r.ok).toBe(true);
    expect(r.state).toBe("done");
  });

  it("vendors 代理失败 → llm_response ok:false 回注", async () => {
    process.env.CYRENE_AGENT_HOST = "1";
    const fake = makeFakeChild();
    (mockSpawn as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(fake.child);
    (streamChatWithSdk as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("供应商 503"));
    const mgr = new AgentProcessManager();
    const stepDone = mgr.step("s1", "x", VENDOR);
    await new Promise((r) => setTimeout(r, 20));
    const stepFrame = fake.written.map((w) => JSON.parse(w)).find((f) => f.op === "step");
    fake.emitLine(JSON.stringify({
      op: "llm_request", callId: stepFrame.callId,
      session: { sessionId: "s1", turn: 1, messages: [{ role: "user", content: "x" }] },
    }));
    await new Promise((r) => setTimeout(r, 30));
    const resp = fake.written.map((w) => JSON.parse(w)).find((f) => f.op === "llm_response");
    expect(resp.ok).toBe(false);
    expect(resp.error).toContain("503");
    fake.emitLine(JSON.stringify({ op: "result", callId: stepFrame.callId, ok: false, error: "llm 失败" }));
    const r = await stepDone;
    expect(r.ok).toBe(false);
  });

  it("host 退出 → 在途 step 立即失败", async () => {
    process.env.CYRENE_AGENT_HOST = "1";
    const fake = makeFakeChild();
    (mockSpawn as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(fake.child);
    const mgr = new AgentProcessManager();
    const stepDone = mgr.step("s1", "x", VENDOR);
    await new Promise((r) => setTimeout(r, 20));
    fake.emitExit();
    const r = await stepDone;
    expect(r.ok).toBe(false);
    expect(r.error).toContain("退出");
  });

  it("tool_request 分发到执行器 + tool_result 回注", async () => {
    process.env.CYRENE_AGENT_HOST = "1";
    const fake = makeFakeChild();
    (mockSpawn as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(fake.child);
    const mgr = new AgentProcessManager();
    const calls: Array<[string, string]> = [];
    mgr.setToolExecutor((callId, sessionId) => {
      calls.push([callId, sessionId]);
      mgr.resolveToolCall(callId, sessionId, { output: "ok" });
    });
    const stepDone = mgr.step("s1", "x", VENDOR);
    await new Promise((r) => setTimeout(r, 20));
    const stepFrame = fake.written.map((w) => JSON.parse(w)).find((f) => f.op === "step");
    fake.emitLine(JSON.stringify({ op: "tool_request", callId: stepFrame.callId, sessionId: "s1", assistantMessage: { role: "assistant" } }));
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toBe("s1");
    const tr = fake.written.map((w) => JSON.parse(w)).find((f) => f.op === "tool_result");
    expect(tr.result.output).toBe("ok");
    fake.emitLine(JSON.stringify({ op: "result", callId: stepFrame.callId, ok: true, data: { state: "done" } }));
    const r = await stepDone;
    expect(r.ok).toBe(true);
  });
});

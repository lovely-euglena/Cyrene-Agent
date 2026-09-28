/**
 * AgentOrchestratorClient 帧路由测试（mock 子进程，不真 spawn——
 * cyrene-native 是 net10.0-windows 目标，Linux 构建机不可运行）。
 *
 * 覆盖：ready 握手、group.create 请求应答、runTurn 的
 * step → worker → step_result → turn.result 全链路、step.cancel 取消、
 * host 退出兜底与未启用回退。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("../../windows/native-windows-host", () => ({
  resolveNativeWindowsExe: vi.fn(() => "/fake/cyrene-native.exe"),
}));
vi.mock("../../child-processes", () => ({ trackChildProcess: vi.fn() }));
vi.mock("../../config", () => ({
  resolveDotnetConfig: vi.fn(() => ({ agentHost: true, agentOrchestrator: true })),
}));

import { spawn as mockSpawn } from "node:child_process";
import { AgentOrchestratorClient } from "./agent-orchestrator-client";
import { HarnessSessionWorker } from "./harness-session-worker";
import type { HarnessResult } from "../harness";
import type { OrchestratorStepFrame } from "./protocol";

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
    once: vi.fn(() => child),
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

function makeResult(overrides: Partial<HarnessResult> = {}): HarnessResult {
  return {
    finalAnswer: "答案",
    finalState: { todoItems: [], uncertainEffects: [] },
    terminated: false,
    rounds: 1,
    ...overrides,
  };
}

function makeStepFrame(step: Partial<OrchestratorStepFrame> = {}): string {
  return JSON.stringify({
    op: "step",
    callId: "t1",
    stepId: "t1-s1",
    groupId: "g1",
    sessionId: "s1",
    index: 0,
    message: "你好",
    mailbox: [],
    config: {},
    ...step,
  });
}

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const framesOf = (written: string[]) => written.map((line) => JSON.parse(line) as Record<string, unknown>);

afterEach(() => {
  vi.clearAllMocks();
});

describe("AgentOrchestratorClient", () => {
  it("未启用（isEnabled=false）→ API 返回未启用且不 spawn", async () => {
    const client = new AgentOrchestratorClient({
      isEnabled: () => false,
      logger: () => undefined,
    });
    const turn = await client.runTurn("g1", "hi");
    expect(turn.ok).toBe(false);
    expect(turn.error).toContain("未启用");
    const group = await client.createGroup({ groupId: "g1", members: [{ sessionId: "s1" }], pipeline: ["s1"] });
    expect(group.ok).toBe(false);
    expect(await client.listGroups()).toEqual([]);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("ready 握手后 group.create 请求应答解析", async () => {
    const fake = makeFakeChild();
    (mockSpawn as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(fake.child);
    const client = new AgentOrchestratorClient({ logger: () => undefined });
    const groupDone = client.createGroup({
      groupId: "g1",
      members: [{ sessionId: "s1", role: "planner" }],
      pipeline: ["s1"],
    });
    await tick();
    fake.emitLine(JSON.stringify({ op: "ready" }));
    await tick();
    const frame = framesOf(fake.written).find((f) => f.op === "group.create");
    expect(frame).toBeTruthy();
    expect(frame?.groupId).toBe("g1");
    fake.emitLine(JSON.stringify({ id: frame?.id, ok: true, data: { groupId: "g1" } }));
    expect(await groupDone).toEqual({ ok: true });
  });

  it("runTurn：turn.start 应答 → step 交 worker → step_result 回注 → turn.result 解析", async () => {
    const fake = makeFakeChild();
    (mockSpawn as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(fake.child);
    const worker = new HarnessSessionWorker({
      runStep: async () => ({ result: makeResult({ finalAnswer: "规划完成" }) }),
    });
    const client = new AgentOrchestratorClient({ worker, logger: () => undefined });

    const turnDone = client.runTurn("g1", "做个任务");
    await tick();
    fake.emitLine(JSON.stringify({ op: "ready" }));
    await tick();
    const start = framesOf(fake.written).find((f) => f.op === "turn.start");
    expect(start?.message).toBe("做个任务");
    fake.emitLine(JSON.stringify({ id: start?.id, ok: true, data: { callId: start?.callId } }));
    await tick();
    // host 下发 step → worker 执行 → step_result 回注
    fake.emitLine(makeStepFrame({ callId: String(start?.callId) }));
    await tick(20);
    const stepResult = framesOf(fake.written).find((f) => f.op === "step_result");
    expect(stepResult).toBeTruthy();
    expect(stepResult?.status).toBe("success");
    expect(stepResult?.finalAnswer).toBe("规划完成");
    // host 收口 turn
    fake.emitLine(JSON.stringify({
      op: "turn.result",
      callId: start?.callId,
      groupId: "g1",
      ok: true,
      status: "success",
      finalAnswer: "最终答复",
      steps: [{ sessionId: "s1", ok: true, status: "success" }],
    }));
    const result = await turnDone;
    expect(result.ok).toBe(true);
    expect(result.finalAnswer).toBe("最终答复");
    expect(result.steps).toHaveLength(1);
  });

  it("step.cancel → worker 中止在途 step，step_result 回注 cancelled", async () => {
    const fake = makeFakeChild();
    (mockSpawn as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(fake.child);
    const worker = new HarnessSessionWorker({
      runStep: (request) => new Promise((resolve) => {
        request.signal.addEventListener("abort", () => {
          resolve({ result: makeResult({ terminateReason: "cancelled", finalAnswer: "" }) });
        });
      }),
    });
    const client = new AgentOrchestratorClient({ worker, logger: () => undefined });
    const turnDone = client.runTurn("g1", "hi");
    await tick();
    fake.emitLine(JSON.stringify({ op: "ready" }));
    await tick();
    const start = framesOf(fake.written).find((f) => f.op === "turn.start");
    fake.emitLine(JSON.stringify({ id: start?.id, ok: true, data: {} }));
    await tick();
    fake.emitLine(makeStepFrame({ callId: String(start?.callId) }));
    await tick();
    fake.emitLine(JSON.stringify({ op: "step.cancel", callId: start?.callId, stepId: "t1-s1", sessionId: "s1" }));
    await tick(20);
    const stepResult = framesOf(fake.written).find((f) => f.op === "step_result");
    expect(stepResult?.status).toBe("cancelled");
    fake.emitLine(JSON.stringify({ op: "turn.result", callId: start?.callId, groupId: "g1", ok: false, status: "cancelled", error: "已取消", steps: [] }));
    const result = await turnDone;
    expect(result.status).toBe("cancelled");
  });

  it("host 退出 → 在途 turn 立即失败，请求 promise reject", async () => {
    const fake = makeFakeChild();
    (mockSpawn as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(fake.child);
    const client = new AgentOrchestratorClient({ logger: () => undefined });
    const turnDone = client.runTurn("g1", "hi");
    await tick();
    fake.emitLine(JSON.stringify({ op: "ready" }));
    await tick();
    fake.emitExit();
    const result = await turnDone;
    expect(result.ok).toBe(false);
    expect(result.error).toContain("退出");
  });

  it("ready 超时回收后可重试：旧进程退出不锁死 exited、不干扰新进程", async () => {
    vi.useFakeTimers();
    try {
      const first = makeFakeChild();
      const second = makeFakeChild();
      (mockSpawn as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(first.child).mockReturnValueOnce(second.child);
      const client = new AgentOrchestratorClient({ logger: () => undefined });

      const firstStart = client.ensureStarted();
      await vi.advanceTimersByTimeAsync(10_050);
      expect(await firstStart).toBe(false);
      expect(first.child.kill).toHaveBeenCalledTimes(1);

      // 被回收进程随后退出：不应把客户端锁成永久未启用
      first.emitExit();

      const secondStart = client.ensureStarted();
      await vi.advanceTimersByTimeAsync(0);
      second.emitLine(JSON.stringify({ op: "ready" }));
      expect(await secondStart).toBe(true);
      expect(mockSpawn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

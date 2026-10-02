/**
 * TaskOrchestratorRunner 测试：开关/端口语义、seed 透传、终态映射、
 * 回退规则（仅首个 step 前故障回退）与清理，fake 端口不起进程。
 */
import { describe, expect, it, vi } from "vitest";
import {
  createTaskOrchestratorRunner,
  ORCHESTRATOR_STEP_TIMEOUT_GRACE_MS,
  ORCHESTRATOR_UNBOUNDED_STEP_TIMEOUT_MS,
  resolveHostStepTimeoutMs,
  TaskStepEnvironmentRegistry,
  type TaskOrchestrationInput,
  type TaskOrchestratorClientPort,
  type TaskOrchestratorWorkerPort,
} from "./task-orchestrator-runner";
import type { AgentOrchestratorTurnResult } from "./agent-orchestrator-client";
import type { HarnessStepEnvironment } from "./step-runner";
import type { OrchestratorStepFrame } from "./protocol";

const ENV: HarnessStepEnvironment = {
  vendorConfig: { provider: "test", baseUrl: "http://x", model: "m", apiKey: "k" } as never,
  tools: [] as never,
  promptLayers: { stablePrefix: "PERSONA" },
};

function makeStepFrame(sessionId: string): OrchestratorStepFrame {
  return {
    op: "step",
    callId: "t1",
    stepId: "t1-s1",
    groupId: "g1",
    sessionId,
    index: 0,
    message: "算一下 6*7",
    mailbox: [],
    config: {},
  };
}

function makeInput(overrides: Partial<TaskOrchestrationInput> = {}): TaskOrchestrationInput {
  return {
    taskId: "task-1",
    sessionId: "task-1:child-1",
    groupId: "task-1:child-1",
    role: "general",
    message: "算一下 6*7",
    seed: { messages: [{ role: "user", content: "旧上下文" }] },
    stepTimeoutMs: 60_000,
    resolveEnvironment: () => ENV,
    ...overrides,
  };
}

function makeTurnResult(overrides: Partial<AgentOrchestratorTurnResult> = {}): AgentOrchestratorTurnResult {
  return {
    ok: true,
    status: "success",
    finalAnswer: "42",
    steps: [{ sessionId: "task-1:child-1", ok: true, status: "success" }],
    ...overrides,
  };
}

function makePorts(overrides: {
  turnResult?: AgentOrchestratorTurnResult;
  turnError?: Error;
  ensureStarted?: boolean;
  createGroup?: { ok: boolean; error?: string };
  enabled?: boolean;
} = {}) {
  const seedSession = vi.fn();
  const destroySession = vi.fn(() => true);
  const abortAll = vi.fn(() => 0);
  const getTranscript = vi.fn<() => { state?: { todoItems: unknown[]; uncertainEffects: unknown[] } } | undefined>(() => undefined);
  const worker: TaskOrchestratorWorkerPort = { seedSession, destroySession, abortAll, getTranscript };
  const enabled = vi.fn(() => overrides.enabled ?? true);
  const ensureStarted = vi.fn(async () => overrides.ensureStarted ?? true);
  const createGroup = vi.fn(async () => overrides.createGroup ?? { ok: true });
  const runTurn = vi.fn(async () => {
    if (overrides.turnError) throw overrides.turnError;
    return overrides.turnResult ?? makeTurnResult();
  });
  const destroyGroup = vi.fn(async () => ({ ok: true }));
  const client: TaskOrchestratorClientPort = { enabled, ensureStarted, createGroup, runTurn, destroyGroup };
  return { client, worker, seedSession, destroySession, abortAll, getTranscript, enabled, ensureStarted, createGroup, runTurn, destroyGroup };
}

describe("resolveHostStepTimeoutMs", () => {
  it("有限 profile → +宽限；0/负数（不限时）→ 近 int.Max 兜底", () => {
    expect(resolveHostStepTimeoutMs(120_000)).toBe(120_000 + ORCHESTRATOR_STEP_TIMEOUT_GRACE_MS);
    expect(resolveHostStepTimeoutMs(0)).toBe(ORCHESTRATOR_UNBOUNDED_STEP_TIMEOUT_MS);
    expect(resolveHostStepTimeoutMs(-5)).toBe(ORCHESTRATOR_UNBOUNDED_STEP_TIMEOUT_MS);
  });
});

describe("TaskStepEnvironmentRegistry", () => {
  it("注册/解析/事件路由/注销；未注册解析抛错", () => {
    const registry = new TaskStepEnvironmentRegistry();
    const onEvent = vi.fn();
    registry.register("s1", { resolveEnvironment: () => ENV, onEvent });
    expect(() => registry.register("s1", { resolveEnvironment: () => ENV })).toThrow("已注册");

    const step = makeStepFrame("s1");
    expect(registry.hasStepStarted("s1")).toBe(false);
    expect(registry.resolve(step, { signal: AbortSignal.abort() })).toBe(ENV);
    expect(registry.hasStepStarted("s1")).toBe(true);

    registry.emit({ type: "round_start", roundId: "r0" }, step);
    expect(onEvent).toHaveBeenCalledTimes(1);

    expect(() => registry.resolve(makeStepFrame("missing"), { signal: AbortSignal.abort() }))
      .toThrow("未注册");
    expect(registry.unregister("s1")).toBe(true);
    expect(registry.size).toBe(0);
  });
});

describe("createTaskOrchestratorRunner", () => {
  it("taskOrchestrator 关闭 → used:false，不触碰 client/worker", async () => {
    const ports = makePorts();
    const runner = createTaskOrchestratorRunner({ ...ports, isEnabled: () => false });

    const outcome = await runner.run(makeInput());

    expect(outcome).toEqual({ used: false, reason: "taskOrchestrator 开关未启用" });
    expect(ports.enabled).not.toHaveBeenCalled();
    expect(ports.ensureStarted).not.toHaveBeenCalled();
  });

  it("agent-orchestrator 未启用 → used:false", async () => {
    const ports = makePorts({ enabled: false });
    const runner = createTaskOrchestratorRunner({ ...ports, isEnabled: () => true });

    const outcome = await runner.run(makeInput());

    expect(outcome).toEqual({ used: false, reason: "agent-orchestrator 未启用（开关或 native exe 缺失）" });
    expect(ports.ensureStarted).not.toHaveBeenCalled();
  });

  it("成功：seed → group.create（单成员流水线）→ runTurn → 终态映射与清理", async () => {
    const ports = makePorts();
    const runner = createTaskOrchestratorRunner({ ...ports, isEnabled: () => true });
    const input = makeInput();

    const outcome = await runner.run(input);

    expect(outcome).toEqual({ used: true, status: "success", finalAnswer: "42", steps: 1 });
    expect(ports.seedSession).toHaveBeenCalledWith(input.sessionId, input.seed);
    expect(ports.createGroup).toHaveBeenCalledWith({
      groupId: input.groupId,
      members: [{ sessionId: input.sessionId, role: "general" }],
      pipeline: [input.sessionId],
      stepTimeoutMs: 60_000,
    });
    expect(ports.runTurn).toHaveBeenCalledWith(input.groupId, input.message, {});
    expect(ports.destroyGroup).toHaveBeenCalledWith(input.groupId);
    expect(ports.destroySession).toHaveBeenCalledWith(input.sessionId);
    expect(runner.registry.size).toBe(0);
  });

  it("环境与事件按 sessionId 路由（runTurn 期间模拟 worker 解析）", async () => {
    const registry = new TaskStepEnvironmentRegistry();
    const ports = makePorts();
    const onEvent = vi.fn();
    const resolved: HarnessStepEnvironment[] = [];
    ports.runTurn.mockImplementation(async () => {
      const step = makeStepFrame("task-1:child-1");
      const env = registry.resolve(step, { signal: AbortSignal.abort() });
      resolved.push(env);
      registry.emit({ type: "round_start", roundId: "r0" }, step);
      return makeTurnResult();
    });
    const runner = createTaskOrchestratorRunner({ ...ports, registry, isEnabled: () => true });

    const outcome = await runner.run(makeInput({ onEvent, resolveEnvironment: () => ENV }));

    expect(outcome.used).toBe(true);
    expect(resolved).toEqual([ENV]);
    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it("终态 AgentState 透传（finalState），供任务结算写 todoItems", async () => {
    const ports = makePorts();
    ports.getTranscript.mockReturnValue({
      state: { todoItems: [{ id: "report", content: "整理结果", status: "completed" }], uncertainEffects: [] },
    });
    const runner = createTaskOrchestratorRunner({ ...ports, isEnabled: () => true });

    const outcome = await runner.run(makeInput());

    expect(outcome).toEqual({
      used: true,
      status: "success",
      finalAnswer: "42",
      steps: 1,
      finalState: { todoItems: [{ id: "report", content: "整理结果", status: "completed" }], uncertainEffects: [] },
    });
  });

  it("首个 step 前 turn 失败 → used:false（允许回退），仍清理组与会话", async () => {
    const ports = makePorts({ turnResult: makeTurnResult({ ok: false, status: "failed", error: "host 退出", steps: [] }) });
    const runner = createTaskOrchestratorRunner({ ...ports, isEnabled: () => true });

    const outcome = await runner.run(makeInput());

    expect(outcome).toEqual({ used: false, reason: "host 退出" });
    expect(ports.destroyGroup).toHaveBeenCalledTimes(1);
    expect(ports.destroySession).toHaveBeenCalledTimes(1);
    expect(runner.registry.size).toBe(0);
  });

  it("已执行过 step 后失败 → used:true failed，绝不回退", async () => {
    const registry = new TaskStepEnvironmentRegistry();
    const failedTurn = makeTurnResult({
      ok: false,
      status: "failed",
      finalAnswer: "",
      error: "工具崩了",
      steps: [{ sessionId: "s", ok: false, status: "failed" }],
    });
    const ports = makePorts({ turnResult: failedTurn });
    ports.runTurn.mockImplementation(async () => {
      registry.markStepStarted("task-1:child-1");
      return failedTurn;
    });
    const runner = createTaskOrchestratorRunner({ ...ports, registry, isEnabled: () => true });

    const outcome = await runner.run(makeInput());

    expect(outcome).toEqual({ used: true, status: "failed", finalAnswer: "", error: "工具崩了", steps: 1 });
    expect(ports.destroyGroup).toHaveBeenCalledTimes(1);
    expect(ports.destroySession).toHaveBeenCalledTimes(1);
  });

  it("抛错且 step 未开始 → used:false；抛错且 step 已开始 → used:true failed", async () => {
    const before = makePorts({ turnError: new Error("管道断裂") });
    const runnerBefore = createTaskOrchestratorRunner({ ...before, isEnabled: () => true });
    expect(await runnerBefore.run(makeInput())).toEqual({ used: false, reason: "管道断裂" });

    const registry = new TaskStepEnvironmentRegistry();
    const after = makePorts();
    after.runTurn.mockImplementation(async () => {
      registry.markStepStarted("task-1:child-1");
      throw new Error("管道断裂");
    });
    const runnerAfter = createTaskOrchestratorRunner({ ...after, registry, isEnabled: () => true });
    expect(await runnerAfter.run(makeInput())).toEqual({ used: true, status: "failed", error: "管道断裂", steps: 0 });
  });

  it("取消/超时映射：cancelled → used:true cancelled；timeout → used:true timeout", async () => {
    const cancelledPorts = makePorts({ turnResult: makeTurnResult({ ok: false, status: "cancelled", finalAnswer: "", error: "已取消" }) });
    const cancelledRunner = createTaskOrchestratorRunner({ ...cancelledPorts, isEnabled: () => true });
    expect(await cancelledRunner.run(makeInput()))
      .toEqual({ used: true, status: "cancelled", finalAnswer: "", error: "已取消", steps: 1 });

    const timeoutPorts = makePorts({ turnResult: makeTurnResult({ ok: false, status: "timeout", finalAnswer: "", error: "step 超时" }) });
    const timeoutRunner = createTaskOrchestratorRunner({ ...timeoutPorts, isEnabled: () => true });
    expect(await timeoutRunner.run(makeInput()))
      .toEqual({ used: true, status: "timeout", finalAnswer: "", error: "step 超时", steps: 1 });
  });

  it("预取消信号 → used:true cancelled，不启动 host", async () => {
    const ports = makePorts();
    const runner = createTaskOrchestratorRunner({ ...ports, isEnabled: () => true });

    const outcome = await runner.run(makeInput({ signal: AbortSignal.abort() }));

    expect(outcome).toEqual({ used: true, status: "cancelled", error: "已取消", steps: 0 });
    expect(ports.ensureStarted).not.toHaveBeenCalled();
  });

  it("ensureStarted=false / group.create 失败 → used:false，不进入 turn", async () => {
    const startPorts = makePorts({ ensureStarted: false });
    const startRunner = createTaskOrchestratorRunner({ ...startPorts, isEnabled: () => true });
    expect(await startRunner.run(makeInput())).toEqual({ used: false, reason: "agent-orchestrator 启动失败" });
    expect(startPorts.createGroup).not.toHaveBeenCalled();

    const groupPorts = makePorts({ createGroup: { ok: false, error: "组已达上限" } });
    const groupRunner = createTaskOrchestratorRunner({ ...groupPorts, isEnabled: () => true });
    expect(await groupRunner.run(makeInput())).toEqual({ used: false, reason: "组已达上限" });
    expect(groupPorts.runTurn).not.toHaveBeenCalled();
    expect(groupPorts.destroyGroup).not.toHaveBeenCalled();
    expect(groupPorts.destroySession).toHaveBeenCalledTimes(1);
  });

  it("取消信号透传给 runTurn", async () => {
    const ports = makePorts();
    const runner = createTaskOrchestratorRunner({ ...ports, isEnabled: () => true });
    const controller = new AbortController();

    await runner.run(makeInput({ signal: controller.signal }));

    expect(ports.runTurn).toHaveBeenCalledWith("task-1:child-1", "算一下 6*7", { signal: controller.signal });
  });
});

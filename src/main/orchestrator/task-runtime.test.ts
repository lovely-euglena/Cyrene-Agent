import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskSessionStore } from "../tasks/task-session-store";
import { buildChildPromptLayers, createTaskExecutor } from "./task-runtime";
import type { TaskOrchestrationInput, TaskOrchestrationOutcome } from "./agent-orchestration/task-orchestrator-runner";
import { ORCHESTRATOR_UNBOUNDED_STEP_TIMEOUT_MS } from "./agent-orchestration/protocol";
import type { ToolDefinition } from "./tools/registry/tool-registry";
import { TaskCharacterLeasePool } from "../tasks/task-character-pool";
import type { TaskDelegationPresentation } from "../../shared/task-session";

const roots: string[] = [];

function createStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-task-runtime-"));
  roots.push(root);
  return new TaskSessionStore(root, {
    createId: () => "task-1",
    createChildRunId: () => "child-run-1",
  });
}

function tool(id: string): ToolDefinition {
  return { id, name: id, description: id, enabled: true, inputSchema: { type: "object", properties: {} }, execute: async () => "ok" };
}

const parent = {
  parentConversationId: "conversation-1",
  parentRunId: "parent-run-1",
  mode: "code" as const,
  systemPrompt: "parent persona must not be copied",
  vendorConfig: { provider: "fake", model: "fake" } as never,
  tools: [tool("read_file"), tool("task"), tool("ask_user")],
  resolvedWorkspaceRoot: "E:\\project",
  checkPermission: vi.fn(async () => true),
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("TaskRuntime", () => {
  it("keeps the child role stable and workspace metadata session-scoped", () => {
    const layers = buildChildPromptLayers(parent, "SUBAGENT_PROFILE");
    expect(layers.stablePrefix.startsWith("SUBAGENT_PROFILE\n")).toBe(true);
    expect(layers.sessionPrefix).toContain("E:\\project");
    expect(layers.sessionPrefix).toContain("会话模式：code");
  });

  it("creates an isolated child Harness run and persists its final result", async () => {
    const store = createStore();
    const runHarness = vi.fn(async (input: any) => ({
      finalAnswer: "检查完成。",
      finalState: { todoItems: [], uncertainEffects: [] },
      terminated: false,
      rounds: 1,
      terminal: { status: "success" as const, externalEffectsMayContinue: false },
    }));
    const execute = createTaskExecutor({ parent, store, runHarness });

    const result = await execute({
      description: "检查取消链路",
      prompt: "检查取消传播并报告证据。",
      subagentType: "general",
      companionId: "风堇",
    });

    expect(result).toEqual({ taskId: "task-1", status: "completed", text: "检查完成。" });
    expect(runHarness).toHaveBeenCalledWith(expect.objectContaining({
      messages: [{ role: "user", content: "检查取消传播并报告证据。" }],
      tools: [expect.objectContaining({ id: "read_file" })],
      config: expect.not.objectContaining({ maxRounds: expect.anything() }),
      toolContext: expect.objectContaining({
        runId: "child-run-1",
        resolvedWorkspaceRoot: "E:\\project",
      }),
    }));
    expect(store.get("task-1")).toMatchObject({ status: "completed", resultText: "检查完成。" });
  });

  it("inherits a mobile parent's non-interactive Harness policy", async () => {
    const store = createStore();
    const runHarness = vi.fn(async () => ({
      finalAnswer: "完成。",
      finalState: { todoItems: [], uncertainEffects: [] },
      terminated: false,
      rounds: 1,
      terminal: { status: "success" as const, externalEffectsMayContinue: false },
    }));
    const execute = createTaskExecutor({
      parent: { ...parent, includeInteractiveTools: false, permissionMode: "allow_all" },
      store,
      runHarness,
    });

    await execute({
      description: "检查文件",
      prompt: "检查文件。",
      subagentType: "general",
      companionId: "风堇",
    });

    expect(runHarness).toHaveBeenCalledWith(expect.objectContaining({
      includeInteractiveTools: false,
      toolContext: expect.objectContaining({ permissionMode: "allow_all" }),
    }));
  });

  it("rejects a resume request whose task belongs to another parent conversation", async () => {
    const store = createStore();
    const foreign = store.create({
      parentConversationId: "other-conversation",
      parentRunId: "other-run",
      description: "已有任务",
      prompt: "先前内容",
      subagentType: "general",
      mode: "code",
    });
    const execute = createTaskExecutor({ parent, store, runHarness: vi.fn() as never });

    await expect(execute({
      description: "继续已有任务",
      prompt: "继续。",
      subagentType: "general",
      companionId: "风堇",
      taskId: foreign.id,
    })).rejects.toThrow("TASK_PARENT_MISMATCH");
  });

  it("restores the private Todo notebook when resuming the same task", async () => {
    const store = createStore();
    const task = store.create({
      parentConversationId: "conversation-1",
      parentRunId: "parent-run-0",
      description: "检查取消链路",
      prompt: "检查取消传播。",
      subagentType: "general",
      mode: "code",
      resolvedWorkspaceRoot: "E:\\project",
    });
    store.checkpoint(task.id, {
      status: "completed",
      todoItems: [{ id: "inspect", content: "检查取消链路", status: "in_progress" }],
    });
    const runHarness = vi.fn(async () => ({
      finalAnswer: "继续完成。",
      finalState: { todoItems: [], uncertainEffects: [] },
      terminated: false,
      rounds: 1,
      terminal: { status: "success" as const, externalEffectsMayContinue: false },
    }));
    const execute = createTaskExecutor({ parent, store, runHarness });

    await execute({
      description: "继续检查取消链路",
      prompt: "继续。",
      subagentType: "general",
      companionId: "风堇",
      taskId: task.id,
    });

    expect(runHarness).toHaveBeenCalledWith(expect.objectContaining({
      initialState: {
        todoItems: [{ id: "inspect", content: "检查取消链路", status: "in_progress" }],
        uncertainEffects: [],
      },
    }));
  });

  it("persists the final Todo notebook even when no intermediate checkpoint arrives", async () => {
    const store = createStore();
    const runHarness = vi.fn(async () => ({
      finalAnswer: "检查完成。",
      finalState: {
        todoItems: [{ id: "report", content: "整理检查结果", status: "completed" as const }],
        uncertainEffects: [],
      },
      terminated: false,
      rounds: 1,
      terminal: { status: "success" as const, externalEffectsMayContinue: false },
    }));
    const execute = createTaskExecutor({ parent, store, runHarness });

    const result = await execute({
      description: "检查取消链路",
      prompt: "检查取消传播并报告证据。",
      subagentType: "general",
      companionId: "风堇",
    });

    expect(store.get(result.taskId)?.todoItems).toEqual([
      { id: "report", content: "整理检查结果", status: "completed" },
    ]);
  });

  it("emits a sanitized running/terminal lifecycle and releases the nickname", async () => {
    const store = createStore();
    const characterPool = new TaskCharacterLeasePool();
    const lifecycle: TaskDelegationPresentation[] = [];
    const runHarness = vi.fn(async () => ({
      finalAnswer: "检查完成。", finalState: { todoItems: [], uncertainEffects: [] },
      terminated: false, rounds: 1, terminal: { status: "success" as const, externalEffectsMayContinue: false },
    }));
    const execute = createTaskExecutor({ parent, store, runHarness, characterPool, onLifecycle: (event) => lifecycle.push(event) });

    await execute({ description: "检查取消链路", prompt: "这是不能出现在父事件里的私密指令", subagentType: "general", companionId: "风堇" });
    const next = characterPool.acquire("conversation-1", "风堇");

    expect(lifecycle).toEqual([
      { invocationId: "child-run-1", taskId: "task-1", description: "检查取消链路", nickname: "风堇", assetFileName: "风堇.png", status: "running" },
      { invocationId: "child-run-1", taskId: "task-1", description: "检查取消链路", nickname: "风堇", assetFileName: "风堇.png", status: "completed" },
    ]);
    expect(JSON.stringify(lifecycle)).not.toContain("私密指令");
    expect(next.nickname).toBe("风堇");
  });

  it.each([
    { terminal: { status: "runtime_error" as const, externalEffectsMayContinue: true }, expected: "failed" },
    { terminal: { status: "cancelled" as const, externalEffectsMayContinue: true }, expected: "cancelled" },
  ])("releases the nickname after $expected settlement", async ({ terminal, expected }) => {
    const store = createStore();
    const characterPool = new TaskCharacterLeasePool();
    const lifecycle: Array<{ status: string }> = [];
    const execute = createTaskExecutor({
      parent, store, characterPool, onLifecycle: (event) => lifecycle.push(event),
      runHarness: vi.fn(async () => ({ finalAnswer: "", finalState: { todoItems: [], uncertainEffects: [] }, terminated: true, rounds: 1, terminal })),
    });

    await execute({ description: "检查异常结算", prompt: "执行", subagentType: "general", companionId: "风堇" });

    expect(lifecycle.at(-1)?.status).toBe(expected);
    expect(characterPool.acquire("conversation-1", "风堇").nickname).toBe("风堇");
  });
});

describe("TaskRuntime 编排接口（runOrchestrated 注入）", () => {
  const orchestratedSuccess: TaskOrchestrationOutcome = {
    used: true,
    status: "success",
    finalAnswer: "编排完成",
    steps: 1,
    finalState: { todoItems: [{ id: "report", content: "整理结果", status: "completed" }], uncertainEffects: [] },
  };

  it("编排可用 → 不走直跑 Harness；终态/checkpoint/lifecycle 用编排结果", async () => {
    const store = createStore();
    const runHarness = vi.fn();
    const onLifecycle = vi.fn();
    const runOrchestrated = vi.fn(
      async (_input: TaskOrchestrationInput): Promise<TaskOrchestrationOutcome> => orchestratedSuccess,
    );
    const execute = createTaskExecutor({ parent, store, runHarness: runHarness as never, runOrchestrated, onLifecycle });

    const result = await execute({
      description: "检查编排",
      prompt: "算一下 6*7。",
      subagentType: "general",
      companionId: "风堇",
    });

    expect(result).toEqual({ taskId: "task-1", status: "completed", text: "编排完成" });
    expect(runHarness).not.toHaveBeenCalled();
    expect(store.get("task-1")).toMatchObject({
      status: "completed",
      resultText: "编排完成",
      todoItems: [{ id: "report", content: "整理结果", status: "completed" }],
    });
    expect(onLifecycle).toHaveBeenLastCalledWith(expect.objectContaining({ status: "completed" }));

    const input = runOrchestrated.mock.calls[0][0];
    expect(input.taskId).toBe("task-1");
    expect(input.sessionId).toBe("task-1:child-run-1");
    expect(input.groupId).toBe("task-1:child-run-1");
    expect(input.role).toBe("general");
    expect(input.message).toBe("算一下 6*7。");
    expect(input.seed).toEqual({ messages: [] });
    expect(input.stepTimeoutMs).toBe(ORCHESTRATOR_UNBOUNDED_STEP_TIMEOUT_MS);

    // 环境装配：只读工具子集、childRunId、本 step 信号进 toolContext
    const controller = new AbortController();
    const env = input.resolveEnvironment({ signal: controller.signal });
    expect(env.tools.map((tool) => tool.id)).toEqual(["read_file"]);
    expect(env.systemPrompt).toBe(env.promptLayers.stablePrefix);
    expect(env.toolContext).toMatchObject({ runId: "child-run-1", resolvedWorkspaceRoot: "E:\\project" });
    expect(env.toolContext?.signal).toBe(controller.signal);
  });

  it("编排 used:false → 告警后回退直跑 Harness", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const store = createStore();
    const runHarness = vi.fn(async () => ({
      finalAnswer: "直跑完成。",
      finalState: { todoItems: [], uncertainEffects: [] },
      terminated: false,
      rounds: 1,
      terminal: { status: "success" as const, externalEffectsMayContinue: false },
    }));
    const runOrchestrated = vi.fn(
      async (_input: TaskOrchestrationInput): Promise<TaskOrchestrationOutcome> => ({ used: false, reason: "native exe 缺失" }),
    );
    const execute = createTaskExecutor({ parent, store, runHarness, runOrchestrated });

    const result = await execute({ description: "回退", prompt: "执行。", subagentType: "general", companionId: "风堇" });

    expect(result).toEqual({ taskId: "task-1", status: "completed", text: "直跑完成。" });
    expect(runHarness).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("native exe 缺失"));
  });

  it("编排 used:true failed → 不回退，按 TASK_RUNTIME_ERROR 结算", async () => {
    const store = createStore();
    const runHarness = vi.fn();
    const runOrchestrated = vi.fn(
      async (_input: TaskOrchestrationInput): Promise<TaskOrchestrationOutcome> => ({
        used: true,
        status: "failed",
        finalAnswer: "",
        error: "工具崩了",
        steps: 1,
      }),
    );
    const execute = createTaskExecutor({ parent, store, runHarness: runHarness as never, runOrchestrated });

    const result = await execute({ description: "失败", prompt: "执行。", subagentType: "general", companionId: "风堇" });

    expect(result).toEqual({ taskId: "task-1", status: "failed", text: "" });
    expect(runHarness).not.toHaveBeenCalled();
    expect(store.get("task-1")).toMatchObject({
      status: "failed",
      error: { code: "TASK_RUNTIME_ERROR", message: "工具崩了" },
    });
  });

  it("resume：seed 为旧历史（不含本轮 prompt），state 带旧 todo", async () => {
    const store = createStore();
    const task = store.create({
      parentConversationId: "conversation-1",
      parentRunId: "parent-run-0",
      description: "最初任务",
      prompt: "最初任务",
      subagentType: "general",
      companionId: "风堇",
      mode: "code",
    });
    store.checkpoint(task.id, {
      status: "completed",
      todoItems: [{ id: "legacy", content: "旧待办", status: "pending" }],
    });
    const runOrchestrated = vi.fn(
      async (_input: TaskOrchestrationInput): Promise<TaskOrchestrationOutcome> => orchestratedSuccess,
    );
    const execute = createTaskExecutor({ parent, store, runHarness: vi.fn() as never, runOrchestrated });

    await execute({
      description: "继续任务",
      prompt: "继续。",
      subagentType: "general",
      companionId: "风堇",
      taskId: task.id,
    });

    const seed = runOrchestrated.mock.calls[0][0].seed;
    expect(seed.messages).toEqual([{ role: "user", content: "最初任务" }]);
    expect(seed.state?.todoItems).toEqual([{ id: "legacy", content: "旧待办", status: "pending" }]);
    expect(store.get(task.id)?.messages).toEqual([
      { role: "user", content: "最初任务" },
      { role: "user", content: "继续。" },
    ]);
  });
});

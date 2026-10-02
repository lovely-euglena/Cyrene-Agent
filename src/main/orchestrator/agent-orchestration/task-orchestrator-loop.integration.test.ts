/**
 * 端到端循环集成测试：真实 cyrene-native --agent-orchestrator + 真实 TS 循环栈。
 *
 * 栈：TaskOrchestratorRunner（真 client spawn）→ HarnessSessionWorker
 * → createHarnessStepRunner → runCyreneHarness（真实循环；供应商流 mock）。
 * 覆盖：无工具收口、工具调用环、seed 续跑、取消、host step 超时。
 *
 * 条件：Windows + dotnet/native-windows/bin 下存在 cyrene-native.exe；
 * 缺失或非 Windows 自动 skip（Linux 构建机不能运行 net10.0-windows 目标）。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// ── Hoisted mocks（必须先于 SUT import）────────────────────

const { vendorQueue, streamChatWithSdkMock } = vi.hoisted(() => {
  const queue: unknown[] = [];
  const streamChatWithSdk = vi.fn(async (input: unknown) => {
    const next = queue.shift();
    if (next === undefined) throw new Error("vendor mock：没有排队的响应");
    if (typeof next === "function") return (next as (input: unknown) => unknown)(input);
    return next;
  });
  return { vendorQueue: queue, streamChatWithSdkMock: streamChatWithSdk };
});

vi.mock("../vendors", () => ({
  getAdapterForConfig: vi.fn(() => ({ id: "mock" })),
  streamChatWithSdk: streamChatWithSdkMock,
  resolveTransport: vi.fn(() => "openai"),
}));
vi.mock("../../token-usage-store", () => ({ recordUsage: vi.fn(), recordRequest: vi.fn() }));
vi.mock("../../child-processes", () => ({ trackChildProcess: vi.fn() }));
vi.mock("../../config", () => ({
  resolveDotnetConfig: vi.fn(() => ({ agentHost: false, agentOrchestrator: true, taskOrchestrator: true })),
}));
vi.mock("../../windows/native-windows-host", async () => {
  const fsMod = await import("node:fs");
  const pathMod = await import("node:path");
  const { fileURLToPath: toPath } = await import("node:url");
  const root = pathMod.resolve(pathMod.dirname(toPath(import.meta.url)), "../../../..");
  const exe = [
    pathMod.join(root, "dotnet/native-windows/bin/Debug/net10.0-windows/cyrene-native.exe"),
    pathMod.join(root, "dotnet/native-windows/bin/Release/net10.0-windows/cyrene-native.exe"),
  ].find((candidate) => fsMod.existsSync(candidate)) ?? null;
  return { resolveNativeWindowsExe: () => exe };
});

import { createTaskOrchestratorRunner, type TaskOrchestrationInput, type TaskOrchestratorRunner } from "./task-orchestrator-runner";
import type { HarnessStepEnvironment } from "./step-runner";
import type { ChatMessage, ChatResponse, ToolCall } from "../vendors/types";
import type { ToolDefinition } from "../tools/registry/tool-registry";

// ── 运行条件 ─────────────────────────────────────────────

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const EXE = [
  path.join(repoRoot, "dotnet/native-windows/bin/Debug/net10.0-windows/cyrene-native.exe"),
  path.join(repoRoot, "dotnet/native-windows/bin/Release/net10.0-windows/cyrene-native.exe"),
].find((candidate) => fs.existsSync(candidate));
const canRun = process.platform === "win32" && EXE !== undefined;
const describeLoop = canRun ? describe : describe.skip;
if (!canRun) {
  console.warn("[task-orchestrator-loop] 跳过：需要 Windows + 已构建的 cyrene-native.exe");
}

// ── Fixtures ─────────────────────────────────────────────

function assistantResponse(text: string, toolCalls: ToolCall[] = []): ChatResponse {
  return {
    assistantMessage: { role: "assistant", content: text, ...(toolCalls.length ? { toolCalls } : {}) },
    text,
    toolCalls,
    finishReason: toolCalls.length ? "tool_calls" : "stop",
    raw: {},
  };
}

function makeEchoTool(): ToolDefinition {
  return {
    id: "echo",
    name: "echo",
    description: "回显输入（集成测试用）",
    enabled: true,
    inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
    risk: "safe",
    execute: async (args: unknown) => `echo:${(args as { value?: string }).value ?? ""}`,
  } as ToolDefinition;
}

function makeEnvironment(overrides: Partial<HarnessStepEnvironment> = {}): HarnessStepEnvironment {
  return {
    vendorConfig: { provider: "mock", baseUrl: "http://mock.local", model: "mock", apiKey: "test" } as never,
    tools: [makeEchoTool()],
    promptLayers: { stablePrefix: "你是子 Agent", sessionPrefix: "会话模式：code", mode: "code" },
    systemPrompt: "你是子 Agent",
    checkPermission: async () => true,
    ...overrides,
  };
}

let seq = 0;
function makeInput(overrides: Partial<TaskOrchestrationInput> = {}): TaskOrchestrationInput {
  const id = `it-${++seq}-${Date.now().toString(36)}`;
  return {
    taskId: id,
    sessionId: id,
    groupId: id,
    message: "任务",
    seed: { messages: [] },
    stepTimeoutMs: 30_000,
    resolveEnvironment: () => makeEnvironment(),
    ...overrides,
  };
}

/** 取第 n 次 vendor 调用的请求 messages。 */
function vendorRequestMessages(callIndex: number): ChatMessage[] {
  const input = streamChatWithSdkMock.mock.calls[callIndex]?.[0] as
    | { request?: { messages?: ChatMessage[] } }
    | undefined;
  return input?.request?.messages ?? [];
}

function messageText(message: ChatMessage): string {
  return typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "");
}

describeLoop("TaskOrchestratorRunner 端到端循环（真实 cyrene-native）", () => {
  let runner: TaskOrchestratorRunner;

  beforeAll(() => {
    runner = createTaskOrchestratorRunner({ isEnabled: () => true });
  });

  afterAll(async () => {
    await runner?.shutdown();
  });

  it("无工具收口：真实循环经编排返回最终答复", async () => {
    streamChatWithSdkMock.mockClear();
    vendorQueue.push(assistantResponse("6*7=42"));

    const outcome = await runner.run(makeInput({ message: "6*7 等于几？" }));

    expect(outcome.used).toBe(true);
    if (!outcome.used) return;
    expect(outcome.status).toBe("success");
    expect(outcome.finalAnswer).toBe("6*7=42");
    expect(streamChatWithSdkMock).toHaveBeenCalledTimes(1);
  });

  it("工具调用环：模型→工具→再收口，tool 结果回注下一轮", async () => {
    streamChatWithSdkMock.mockClear();
    vendorQueue.push(
      assistantResponse("", [{ id: "call-1", name: "echo", arguments: JSON.stringify({ value: "hi" }) }]),
      assistantResponse("工具结果已收到"),
    );

    const outcome = await runner.run(makeInput({ message: "调用 echo" }));

    expect(outcome.used).toBe(true);
    if (!outcome.used) return;
    expect(outcome.status).toBe("success");
    expect(outcome.finalAnswer).toBe("工具结果已收到");
    expect(streamChatWithSdkMock).toHaveBeenCalledTimes(2);
    const secondRound = vendorRequestMessages(1);
    expect(secondRound.some((message) => message.role === "tool" && messageText(message).includes("echo:hi"))).toBe(true);
  });

  it("seed 续跑：历史上下文进入首轮请求，本轮 prompt 不重复", async () => {
    streamChatWithSdkMock.mockClear();
    vendorQueue.push(assistantResponse("续跑完成"));

    const outcome = await runner.run(makeInput({
      message: "继续",
      seed: {
        messages: [
          { role: "user", content: "旧问题" },
          { role: "assistant", content: "旧回答" },
        ],
        state: { todoItems: [], uncertainEffects: [] },
      },
    }));

    expect(outcome.used).toBe(true);
    if (!outcome.used) return;
    expect(outcome.status).toBe("success");
    const firstRound = vendorRequestMessages(0).map(messageText);
    expect(firstRound).toContain("旧问题");
    expect(firstRound).toContain("旧回答");
    expect(firstRound.filter((text) => text === "继续")).toHaveLength(1);
  });

  it("取消：父信号中止在途 turn，终态 cancelled 且本地会话清空", async () => {
    streamChatWithSdkMock.mockClear();
    let started = false;
    vendorQueue.push((input: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
      started = true;
      input.signal?.addEventListener("abort", () => reject(new Error("aborted by signal")), { once: true });
    }));
    const controller = new AbortController();

    const pending = runner.run(makeInput({ message: "挂起", signal: controller.signal }));
    await vi.waitFor(() => {
      expect(started).toBe(true);
    });
    controller.abort();

    const outcome = await pending;
    expect(outcome.used).toBe(true);
    if (!outcome.used) return;
    expect(outcome.status).toBe("cancelled");
    expect(runner.registry.size).toBe(0);
  });

  it("host step 超时：慢供应商被收口为 timeout", async () => {
    streamChatWithSdkMock.mockClear();
    vendorQueue.push((input: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
      input.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));

    const outcome = await runner.run(makeInput({ message: "慢响应", stepTimeoutMs: 250 }));

    expect(outcome.used).toBe(true);
    if (!outcome.used) return;
    expect(outcome.status).toBe("timeout");
  });
});

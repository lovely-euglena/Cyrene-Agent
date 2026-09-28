/**
 * step-runner 测试：环境解析 → HarnessInput 装配语义、onCheckpoint 终态捕获、
 * 默认 systemPrompt 回退与信号/事件透传（mock runCyreneHarness，不调供应商）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../harness", () => ({ runCyreneHarness: vi.fn() }));

afterEach(() => {
  vi.clearAllMocks();
});

import { runCyreneHarness } from "../harness";
import type { AgentState, HarnessInput, HarnessResult } from "../harness";
import { createHarnessStepRunner } from "./step-runner";
import type { OrchestratorStepFrame } from "./protocol";

const VENDOR = { provider: "test", baseUrl: "http://x", model: "m", apiKey: "k" } as never;

function makeResult(): HarnessResult {
  return {
    finalAnswer: "完成",
    finalState: { todoItems: [], uncertainEffects: [] },
    terminated: false,
    rounds: 1,
  };
}

function makeStep(): OrchestratorStepFrame {
  return {
    op: "step",
    callId: "t1",
    stepId: "st1",
    groupId: "g1",
    sessionId: "s1",
    index: 1,
    role: "executor",
    message: "原请求",
    mailbox: [{ fromSessionId: "planner", text: "计划" }],
    config: { systemPrompt: "角色提示词", conversationId: "c1" },
  };
}

describe("createHarnessStepRunner", () => {
  it("按环境装配 HarnessInput，并用 onCheckpoint 捕获终态 transcript", async () => {
    const inputs: HarnessInput[] = [];
    (runCyreneHarness as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (input: HarnessInput) => {
      inputs.push(input);
      const state: AgentState = { todoItems: [], uncertainEffects: [] };
      input.onCheckpoint?.({
        messages: [...input.messages, { role: "assistant", content: "终态回复" }],
        state,
        toolOutputs: [],
        rounds: 2,
        cache: { cacheEpoch: 1, epochReason: "run_start" },
        at: 1,
      });
      return makeResult();
    });

    const runStep = createHarnessStepRunner(() => ({
      vendorConfig: VENDOR,
      tools: [] as never,
      promptLayers: { stablePrefix: "PERSONA" },
      systemPrompt: "ROLE",
      config: { maxParallelToolCalls: 2 },
    }));
    const signal = new AbortController().signal;
    const emit = vi.fn();
    const out = await runStep({
      step: makeStep(),
      signal,
      messages: [{ role: "user", content: "hi" }],
      emit,
    });

    expect(inputs).toHaveLength(1);
    expect(inputs[0].systemPrompt).toBe("ROLE");
    expect(inputs[0].promptLayers).toEqual({ stablePrefix: "PERSONA" });
    expect(inputs[0].runId).toBe("t1:st1");
    expect(inputs[0].signal).toBe(signal);
    expect(inputs[0].onEvent).toBe(emit);
    expect(inputs[0].config?.maxParallelToolCalls).toBe(2);
    // 终态捕获：messages 含 checkpoint 追加的 assistant，state 来自 checkpoint
    expect(out.messages).toHaveLength(2);
    expect(out.state).toEqual({ todoItems: [], uncertainEffects: [] });
    expect(runCyreneHarness).toHaveBeenCalledTimes(1);
  });

  it("systemPrompt 缺省回退 promptLayers.stablePrefix；无 checkpoint 时回退入参", async () => {
    (runCyreneHarness as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(makeResult());
    const runStep = createHarnessStepRunner(() => ({
      vendorConfig: VENDOR,
      tools: [] as never,
      promptLayers: { stablePrefix: "稳定前缀" },
    }));
    const out = await runStep({
      step: makeStep(),
      signal: new AbortController().signal,
      messages: [{ role: "user", content: "hi" }],
      emit: vi.fn(),
    });
    const input = (runCyreneHarness as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as HarnessInput;
    expect(input.systemPrompt).toBe("稳定前缀");
    expect(out.messages).toHaveLength(1);
    expect(out.state).toEqual(makeResult().finalState);
  });
});

/**
 * HarnessSessionWorker 测试：会话 transcript 续跑、邮箱组装、取消语义、
 * 并发拒绝与失败归一（fake runStep，不起真实 Harness/供应商）。
 */
import { describe, expect, it, vi } from "vitest";
import {
  HarnessSessionWorker,
  composeStepUserContent,
  type SessionStepExecutionRequest,
} from "./harness-session-worker";
import type { HarnessEvent, HarnessResult } from "../harness";
import type { ChatMessage } from "../vendors/types";
import type { OrchestratorStepFrame } from "./protocol";

function makeStep(overrides: Partial<OrchestratorStepFrame> = {}): OrchestratorStepFrame {
  return {
    op: "step",
    callId: "t1",
    stepId: "t1-s1",
    groupId: "g1",
    sessionId: "s1",
    index: 0,
    message: "帮我算个数",
    mailbox: [],
    config: {},
    ...overrides,
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

describe("composeStepUserContent", () => {
  it("无邮箱 → 原始消息", () => {
    expect(composeStepUserContent({ message: "原请求", mailbox: [] })).toBe("原请求");
  });

  it("有邮箱 → 上游消息块 + 原始请求", () => {
    const content = composeStepUserContent({
      message: "原请求",
      mailbox: [{ fromSessionId: "planner", text: "计划：先查资料" }],
    });
    expect(content).toContain("[来自 planner 的消息]");
    expect(content).toContain("计划：先查资料");
    expect(content).toContain("[原始用户请求]\n原请求");
  });
});

describe("HarnessSessionWorker", () => {
  it("跨 step 保持 transcript 与 AgentState", async () => {
    const seen: SessionStepExecutionRequest[] = [];
    const worker = new HarnessSessionWorker({
      runStep: vi.fn(async (request: SessionStepExecutionRequest) => {
        seen.push(request);
        const messages: ChatMessage[] = [
          ...request.messages,
          { role: "assistant", content: `step-${seen.length}` },
        ];
        return {
          result: makeResult({ finalAnswer: `step-${seen.length}` }),
          messages,
          state: {
            todoItems: [],
            uncertainEffects: [],
          },
        };
      }),
    });

    const first = await worker.executeStep(makeStep());
    expect(first.ok).toBe(true);
    expect(first.status).toBe("success");
    expect(first.finalAnswer).toBe("step-1");

    const second = await worker.executeStep(makeStep({
      stepId: "t1-s2",
      sessionId: "s1",
      index: 1,
      mailbox: [{ fromSessionId: "s1", text: "step-1" }],
    }));
    expect(second.ok).toBe(true);
    expect(seen).toHaveLength(2);
    // 第二步入参 = 第一步终态 transcript + 本轮 user 消息
    expect(seen[1].messages).toHaveLength(3);
    expect(seen[1].messages[2].role).toBe("user");
    expect(String(seen[1].messages[2].content)).toContain("[来自 s1 的消息]");
    expect(seen[1].state).toBeDefined();
    expect(worker.getTranscript("s1")?.stepCount).toBe(2);
  });

  it("取消：cancelStep 中止在途 step，即使模型刚好收尾也按 cancelled 上报", async () => {
    let captured: SessionStepExecutionRequest | null = null;
    const worker = new HarnessSessionWorker({
      runStep: (request) => new Promise((resolve) => {
        captured = request;
        request.signal.addEventListener("abort", () => {
          resolve({ result: makeResult({ terminateReason: "cancelled", finalAnswer: "" }) });
        });
      }),
    });

    const pending = worker.executeStep(makeStep());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(worker.cancelStep("t1-s1")).toBe(true);
    const result = await pending;
    expect(result.status).toBe("cancelled");
    expect(result.ok).toBe(false);
    expect(captured?.signal.aborted).toBe(true);
    // 取消不写入会话历史（未提交）
    expect(worker.getTranscript("s1")).toBeUndefined();
  });

  it("取消：runStep 以 abort 错误收场也归一为 cancelled", async () => {
    const worker = new HarnessSessionWorker({
      runStep: (request) => new Promise((_resolve, reject) => {
        request.signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
    });
    const pending = worker.executeStep(makeStep());
    await new Promise((resolve) => setTimeout(resolve, 0));
    worker.cancelStep("t1-s1");
    const result = await pending;
    expect(result.status).toBe("cancelled");
    expect(result.error).toBeUndefined();
  });

  it("同会话并发 step 被拒绝（不进入执行器）", async () => {
    const runStep = vi.fn((request: SessionStepExecutionRequest) => new Promise<never>((_resolve) => {
      // 挂起直到取消：验证并发拒绝发生在执行器之外
      request.signal.addEventListener("abort", () => _resolve({
        result: makeResult({ terminateReason: "cancelled", finalAnswer: "" }),
      }));
    }));
    const worker = new HarnessSessionWorker({ runStep });
    const first = worker.executeStep(makeStep());
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = await worker.executeStep(makeStep({ stepId: "t1-s2" }));
    expect(second.ok).toBe(false);
    expect(second.error).toContain("已有在途 step");
    expect(runStep).toHaveBeenCalledTimes(1);
    worker.cancelStep("t1-s1");
    const firstResult = await first;
    expect(firstResult.status).toBe("cancelled");
  });

  it("失败归一：terminateReason=error → failed；runStep 抛错 → failed 带错误信息", async () => {
    const errorResultWorker = new HarnessSessionWorker({
      runStep: async () => ({ result: makeResult({ terminateReason: "error", finalAnswer: "坏了" }) }),
    });
    const errorResult = await errorResultWorker.executeStep(makeStep());
    expect(errorResult.status).toBe("failed");
    expect(errorResult.error).toContain("error");

    const throwingWorker = new HarnessSessionWorker({
      runStep: async () => { throw new Error("供应商 503"); },
    });
    const thrown = await throwingWorker.executeStep(makeStep());
    expect(thrown.status).toBe("failed");
    expect(thrown.error).toContain("503");
  });

  it("Harness 事件带 step 元数据透传；destroySession 清空会话", async () => {
    const events: Array<{ event: HarnessEvent; stepId: string }> = [];
    const worker = new HarnessSessionWorker({
      runStep: async (request) => {
        request.emit({ type: "round_start", roundId: "round-0" });
        return { result: makeResult() };
      },
      onEvent: (event, step) => events.push({ event, stepId: step.stepId }),
    });
    await worker.executeStep(makeStep());
    expect(events).toHaveLength(1);
    expect(events[0].event.type).toBe("round_start");
    expect(events[0].stepId).toBe("t1-s1");
    expect(worker.destroySession("s1")).toBe(true);
    expect(worker.getTranscript("s1")).toBeUndefined();
  });
});

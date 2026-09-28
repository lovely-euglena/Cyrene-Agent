import { describe, expect, it, vi } from "vitest";

vi.mock("../../../prompts/prompt-loader", () => ({
  loadPromptFile: vi.fn(() => "## 工具使用\n主动调用"),
}));

import {
  buildHarnessPromptLayers,
  buildHarnessSystemPrompt,
  materializeHarnessStartTranscript,
} from "./prompt-builder";

describe("harness prompt builder", () => {
  it("keeps recovery context outside the stable prefix", () => {
    const layers = buildHarnessPromptLayers({
      soulSystemBaseContent: "persona",
      toolSystemContent: "tools",
      recoveryContext: "恢复证据",
      responseContext: "响应引用",
    } as never);

    expect(layers.stablePrefix).not.toContain("RECOVERY_CONTEXT");
    expect(layers.stablePrefix).not.toContain("RESPONSE_CONTEXT");
    expect(layers.runtimeContext).toContain("恢复证据");
    expect(layers.runtimeContext).toContain("响应引用");
  });

  it("does not inject tool usage policy into chat mode", () => {
    const prompt = buildHarnessSystemPrompt({
      soulSystemBaseContent: "persona",
      toolSystemContent: "tools",
      conversationMode: "chat",
    } as never);

    expect(prompt).not.toContain("工具使用");
  });

  it("keeps the stable prefix independent from runtime-only fields", () => {
    const base = {
      soulSystemBaseContent: "persona",
      toolSystemContent: "tools",
      conversationMode: "code",
    };
    const first = buildHarnessPromptLayers({
      ...base,
      runtimeEnvironmentContext: "环境 A",
      planSkillContext: "技能 A",
    } as never);
    const second = buildHarnessPromptLayers({
      ...base,
      runtimeEnvironmentContext: "环境 B",
      planSkillContext: "技能 B",
    } as never);

    expect(first.stablePrefix).toBe(second.stablePrefix);
    expect(first.runtimeContext).not.toBe(second.runtimeContext);
  });

  it("changes the stable prefix when persona content changes", () => {
    const first = buildHarnessPromptLayers({
      soulSystemBaseContent: "persona A",
      toolSystemContent: "tools",
    } as never);
    const second = buildHarnessPromptLayers({
      soulSystemBaseContent: "persona B",
      toolSystemContent: "tools",
    } as never);

    expect(first.stablePrefix).not.toBe(second.stablePrefix);
  });

  it("materializes runtime context as one internal transcript message", () => {
    const messages = materializeHarnessStartTranscript({
      messages: [{ role: "user", content: "继续" }],
      runId: "run-prompt",
      runtimeContext: "[RECOVERY_CONTEXT]\n恢复证据",
      kind: "recovery",
    } as never);

    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({
      role: "user",
      content: "[RECOVERY_CONTEXT]\n恢复证据",
      internal: {
        kind: "recovery",
        revision: 1,
        runId: "run-prompt",
      },
    });
  });
});

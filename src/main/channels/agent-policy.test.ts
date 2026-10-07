import { describe, expect, it } from "vitest";
import type { CyreneRunOptions } from "../orchestrator/cyrene-agent";
import { enforceChannelAgentPolicy, resolveChannelAgentPolicy } from "./agent-policy";

describe("mobile channel agent policy", () => {
  it("routes off through ChatLoop without tools", () => {
    expect(resolveChannelAgentPolicy("off")).toEqual({
      executionMode: "chat",
      exposeTools: false,
      includeInteractiveTools: false,
      permissionMode: "normal",
    });
  });

  it("routes all through CyreneHarness with desktop permission level (#IKJSN9)", () => {
    expect(resolveChannelAgentPolicy("all")).toEqual({
      executionMode: "work",
      exposeTools: true,
      includeInteractiveTools: false,
      // 外部输入不使用 allow_all：沿用桌面端档位（默认 read-only）与沙箱约束
      permissionMode: "normal",
    });
  });

  it("always disables tools for QQ group chats", () => {
    const policy = resolveChannelAgentPolicy("all", { channel: "qq", chatType: "group" });
    expect(policy).toEqual({
      executionMode: "chat",
      exposeTools: false,
      includeInteractiveTools: false,
      permissionMode: "normal",
    });

    const options = {
      tools: [{ id: "shell" }],
      toolSystemContent: "TOOL CATALOG",
      skillLayerContent: "SKILL CATALOG",
      capabilities: {
        mode: "chat",
        tools: [{ id: "shell" }],
        toolIds: new Set(["shell"]),
        skills: [],
        skillIds: new Set<string>(),
      },
    } as unknown as CyreneRunOptions;
    enforceChannelAgentPolicy(options, policy);
    expect(options.tools).toEqual([]);
    expect(options.toolSystemContent).toBe("");
    expect(options.skillLayerContent).toBe("");
    expect(options.capabilities?.tools).toEqual([]);
    expect(options.capabilities?.toolIds.size).toBe(0);
  });
});

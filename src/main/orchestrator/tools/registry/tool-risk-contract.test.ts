// 内置工具风险级契约（closed-world）：
// 所有注册进 toolRegistry 的内置工具都必须显式声明 risk。缺失风险级的工具在
// 权限档位判断中会被当成 "undeclared"（只读档拒绝、每次审批档询问），不得
// 静默变成 "safe" 绕过审批（与 .NET 插件轨的 closed-world 语义对齐）。
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../settings/settings-facade", () => ({
  loadGeneralSettings: () => ({
    weatherEnabled: true,
    travelEnabled: true,
  }),
}));
vi.mock("../../../settings/model-settings", () => ({
  loadModelSettings: () => ({ apiKey: "" }),
}));

import { registerAllTools } from "./tool-registration";
import { toolRegistry } from "./tool-registry";
import { registerObsidianTools } from "../../../learn/obsidian/obsidian-tools";
import { registerPopQuizTool } from "../../pop-quiz";

describe("内置工具风险级契约", () => {
  it("所有内置工具显式声明 risk（缺失即失败）", () => {
    registerAllTools({ codeGitService: {} as never, lspManager: {} as never });
    registerObsidianTools();
    registerPopQuizTool();
    const missing = toolRegistry
      .getAllTools()
      .filter((tool) => tool.risk === undefined)
      .map((tool) => tool.id);
    expect(missing).toEqual([]);
  });
});

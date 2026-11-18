import { describe, expect, it } from "vitest";

import { formatToolErrorForModel, resolveActionHint } from "./tool-error-formatting";
import { ToolExecutionError } from "./tool-execution-error";

describe("tool-error-formatting（issue #139 两面包）", () => {
  it("模型面：结构化文本含 code/category/retryable/原因/修正建议", () => {
    const text = formatToolErrorForModel({
      code: "E_SEARCH_KEY_MISSING",
      category: "config_error",
      message: "搜索源 bocha 的 API key 未配置",
      retryable: false,
      remediation: "当前搜索源缺少 API key，重试不会成功。请提示用户配置。",
    });
    expect(text).toContain("code=E_SEARCH_KEY_MISSING");
    expect(text).toContain("category=config_error");
    expect(text).toContain("retryable=false");
    expect(text).toContain("原因: 搜索源 bocha 的 API key 未配置");
    expect(text).toContain("修正建议: 当前搜索源缺少 API key");
  });

  it("模型面：无 remediation 时落 category 默认建议表", () => {
    const text = formatToolErrorForModel({
      code: "E_X", category: "invalid_arguments", message: "参数错", retryable: false,
    });
    expect(text).toContain("对照工具 schema");
  });

  it("模型面：effectState=unknown 时携带（副作用可能已发生）", () => {
    const text = formatToolErrorForModel({
      code: "E_X", category: "timeout", message: "超时", retryable: true, effectState: "unknown",
    });
    expect(text).toContain("effectState=unknown");
    expect(text).toContain("retryable=true");
  });

  it("用户面：显式 actionHint 优先", () => {
    expect(resolveActionHint("config_error", "去 设置 → 工具 页填写 key。")).toBe("去 设置 → 工具 页填写 key。");
  });

  it("用户面：缺省落 category 默认指引", () => {
    expect(resolveActionHint("config_error")).toContain("设置");
    expect(resolveActionHint("timeout")).toContain("缩小");
  });

  it("ToolExecutionError 构造带两面字段", () => {
    const err = new ToolExecutionError(
      "E_SEARCH_NOT_ENABLED", "联网搜索未启用", "config_error", false, "not_applied",
      "模型面建议", "用户面指引",
    );
    expect(err.remediation).toBe("模型面建议");
    expect(err.actionHint).toBe("用户面指引");
    expect(err.category).toBe("config_error");
    expect(err.name).toBe("ToolExecutionError");
  });
});

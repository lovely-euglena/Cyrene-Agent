// 记忆动作层测试：L0/L1 字段白名单与 trim 口径（IPC 与 native 设置窗共用）。

import { describe, expect, it } from "vitest";
import {
  MEMORY_L0_EDITABLE_KEYS,
  MEMORY_L1_EDITABLE_KEYS,
  sanitizeMemoryL0Patch,
  sanitizeMemoryL1Patch,
} from "./memory-actions";

describe("memory-actions · 字段白名单", () => {
  it("L0：只保留白名单字段并 trim，非法类型丢弃", () => {
    const patch = sanitizeMemoryL0Patch({
      preferredName: "  昔涟  ",
      occupation: "助手",
      permanentNote: "note",
      longTermInterests: 42, // 非字符串 → 丢弃
      language: "中文",
      unknownField: "x", // 不在白名单 → 丢弃
    });
    expect(patch).toEqual({
      preferredName: "昔涟",
      occupation: "助手",
      permanentNote: "note",
      language: "中文",
    });
  });

  it("L1：只保留三个白名单字段", () => {
    const patch = sanitizeMemoryL1Patch({
      recentGoals: " 目标 ",
      recentPreferences: "偏好",
      currentProject: "项目",
      extra: "x",
    });
    expect(patch).toEqual({ recentGoals: "目标", recentPreferences: "偏好", currentProject: "项目" });
    expect(Object.keys(patch)).toHaveLength(MEMORY_L1_EDITABLE_KEYS.length);
  });

  it("非对象输入返回空 patch（防渲染层/协议异常）", () => {
    expect(sanitizeMemoryL0Patch(null)).toEqual({});
    expect(sanitizeMemoryL0Patch("string")).toEqual({});
    expect(sanitizeMemoryL1Patch(undefined)).toEqual({});
    expect(Object.keys(sanitizeMemoryL0Patch({}))).toHaveLength(0);
  });

  it("字段集合锁定（与渲染面板/宿主契约一致）", () => {
    expect([...MEMORY_L0_EDITABLE_KEYS]).toEqual([
      "preferredName",
      "occupation",
      "longTermInterests",
      "language",
      "permanentNote",
    ]);
    expect([...MEMORY_L1_EDITABLE_KEYS]).toEqual(["recentGoals", "recentPreferences", "currentProject"]);
  });
});
import { describe, expect, it } from "vitest";
import { normalizePathDisplay } from "./format";

describe("normalizePathDisplay（#202 路径显示归一化）", () => {
  it("JSON 转义双反斜杠还原为单反斜杠", () => {
    // 输入字符串含字面双反斜杠（如从 settings.json 复制出的转义形态）
    const escaped = String.raw`C:\\Users\\ygwill\\AppData`;
    expect(normalizePathDisplay(escaped)).toBe("C:\\Users\\ygwill\\AppData");
  });

  it("已经正常的路径原样返回（幂等）", () => {
    expect(normalizePathDisplay("/home/ygwill/data")).toBe("/home/ygwill/data");
    const normal = "C:\\Users\\x";
    expect(normalizePathDisplay(normal)).toBe(normal);
    expect(normalizePathDisplay(normalizePathDisplay(normal))).toBe(normal);
  });

  it("空串安全", () => {
    expect(normalizePathDisplay("")).toBe("");
  });

  it("正斜杠混排在 win 平台归一为反斜杠", () => {
    const orig = navigator.platform;
    Object.defineProperty(navigator, "platform", { value: "Win32", configurable: true });
    try {
      expect(normalizePathDisplay("C:/Users/ygwill/AppData")).toBe("C:\\Users\\ygwill\\AppData");
    } finally {
      Object.defineProperty(navigator, "platform", { value: orig, configurable: true });
    }
  });

  it("非 win 平台正斜杠保持不变", () => {
    const orig = navigator.platform;
    Object.defineProperty(navigator, "platform", { value: "Linux x86_64", configurable: true });
    try {
      expect(normalizePathDisplay("C:/Users/ygwill/AppData")).toBe("C:/Users/ygwill/AppData");
    } finally {
      Object.defineProperty(navigator, "platform", { value: orig, configurable: true });
    }
  });
});

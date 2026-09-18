/**
 * 通用三件套（calculator/now/clipboard）测试。
 *
 * calculator：优先级、括号、一元、函数、常量、科学计数法、
 * 除零/语法错的错误语义（防御性——工具入参来自模型）。
 * now/clipboard：行为契约的轻量验证（clipboard 走注入 mock）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  calculatorTool,
  clipboardTool,
  evaluateExpression,
  nowTool,
  setUtilityClipboardConfig,
  setUtilityTimezoneConfig,
} from "./utility-tools";

describe("evaluateExpression（递归下降求值器）", () => {
  it("四则运算优先级与结合性", () => {
    expect(evaluateExpression("1+2*3")).toBe(7);
    expect(evaluateExpression("(1+2)*3")).toBe(9);
    expect(evaluateExpression("2*3+4/2-1")).toBe(7);
    expect(evaluateExpression("10-3-2")).toBe(5);
  });

  it("幂运算右结合、一元负号", () => {
    expect(evaluateExpression("2^3^2")).toBe(512);
    expect(evaluateExpression("-3+5")).toBe(2);
    expect(evaluateExpression("2*-3")).toBe(-6);
  });

  it("白名单函数与常量", () => {
    expect(evaluateExpression("sqrt(16)")).toBe(4);
    expect(evaluateExpression("max(1, 9, 3)")).toBe(9);
    expect(evaluateExpression("round(3.7)")).toBe(4);
    expect(evaluateExpression("2*pi")).toBeCloseTo(6.283185307, 6);
  });

  it("科学计数法与百分号", () => {
    expect(evaluateExpression("1.5e3+5")).toBe(1505);
    expect(evaluateExpression("10%3")).toBe(1);
  });

  it("非法输入必须抛错（不静默不 NaN 污染）", () => {
    expect(() => evaluateExpression("1+")).toThrow();
    expect(() => evaluateExpression(")")).toThrow();
    expect(() => evaluateExpression("1..2")).toThrow();
    expect(() => evaluateExpression("2/(1-1)")).toThrow();
    expect(() => evaluateExpression("")).toThrow();
  });
});

describe("calculator 工具", () => {
  it("成功路径返回算式与结果", async () => {
    const out = await calculatorTool.execute({ expression: "(6/2)*(1+2)" }, {} as never);
    expect(out).toContain("9");
    expect(out).toContain("(6/2)*(1+2)");
  });

  it("语法错返回 failed 语义（E_ 前缀 + 指位）", async () => {
    await expect(calculatorTool.execute({ expression: "1+" }, {} as never))
      .rejects.toThrow(/表达式/);
  });
});

describe("now 工具", () => {
  beforeEach(() => setUtilityTimezoneConfig(() => undefined));

  it("默认返回当前毫秒时间戳（模型可自行换算任何粒度）", async () => {
    const before = Date.now();
    const out = await nowTool.execute({}, {} as never);
    const after = Date.now();
    const json = out.slice(out.indexOf("{"));
    const ts = Number(JSON.parse(json).now);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it("format=iso 附加时区信息", async () => {
    const out = await nowTool.execute({ format: "iso" }, {} as never);
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("clipboard 工具", () => {
  it("read/write 走注入的 Electron clipboard", async () => {
    const store = { text: "旧的剪贴板内容" };
    setUtilityClipboardConfig(() => ({
      readText: () => store.text,
      writeText: (t: string) => { store.text = t; },
    }) as never);
    expect(await clipboardTool.execute({ action: "read" }, {} as never)).toBe("旧的剪贴板内容");
    await clipboardTool.execute({ action: "write", text: "新内容 123" }, {} as never);
    expect(store.text).toBe("新内容 123");
    expect(await clipboardTool.execute({ action: "read" }, {} as never)).toBe("新内容 123");
  });

  it("未注入时给可读错误", async () => {
    setUtilityClipboardConfig(null);
    await expect(clipboardTool.execute({ action: "read" }, {} as never))
      .rejects.toThrow("剪贴板不可用");
  });
});

import { describe, expect, it } from "vitest";
import {
  applyUsageToDay,
  clearUsage,
  type TokenUsageDay,
} from "./token-usage-store";

describe("applyUsageToDay", () => {
  it("tracks cache coverage for a model only when the provider reports cached input", () => {
    const day: TokenUsageDay = {
      input: 0,
      output: 0,
      hit: 0,
      miss: 0,
      cacheCreation: 0,
      requests: 0,
    };

    applyUsageToDay(day, 20, 4, 1, 8, "test-model");
    applyUsageToDay(day, 10, 2, 1, undefined, "test-model");

    expect(day.models?.["test-model"]).toEqual({
      input: 30,
      output: 6,
      hit: 8,
      miss: 12,
      cacheCreation: 0,
      requests: 2,
      cacheUsageRequests: 1,
    });
  });
});

// 审查 !221 P0 回归锁：成本必须同步落入模型桶（getUsageReport 的模型维度
// 聚合只读 day.models[model].costs，漏落即统计页成本卡恒空）
describe("applyUsageToDay costs", () => {
  it("accumulates cost into both the day bucket and the model bucket", () => {
    const day: TokenUsageDay = {
      input: 0, output: 0, hit: 0, miss: 0, cacheCreation: 0, requests: 0,
    };

    applyUsageToDay(day, 100, 50, 1, undefined, "deepseek-chat", undefined, { currency: "CNY", amount: 0.02 });
    applyUsageToDay(day, 80, 30, 1, undefined, "glm-4-plus", undefined, { currency: "CNY", amount: 0.05 });
    applyUsageToDay(day, 10, 5, 1, undefined, "deepseek-chat", undefined, { currency: "CNY", amount: 0.01 });

    expect(day.costs?.CNY).toBeCloseTo(0.08, 6);
    expect(day.models?.["deepseek-chat"]?.costs?.CNY).toBeCloseTo(0.03, 6);
    expect(day.models?.["glm-4-plus"]?.costs?.CNY).toBeCloseTo(0.05, 6);
  });

  it("does not create costs key when cost is absent or non-positive", () => {
    const day: TokenUsageDay = {
      input: 0, output: 0, hit: 0, miss: 0, cacheCreation: 0, requests: 0,
    };

    applyUsageToDay(day, 10, 5, 1, undefined, "m1", undefined, undefined);
    applyUsageToDay(day, 10, 5, 1, undefined, "m1", undefined, { currency: "CNY", amount: 0 });
    expect(day.models?.["m1"]?.costs).toBeUndefined();
    expect(day.costs).toBeUndefined();
  });
});

describe("clearUsage", () => {
  it("removes every stored day and model record", () => {
    const days: Record<string, TokenUsageDay> = {
      "2026-08-16": {
        input: 20,
        output: 4,
        hit: 8,
        miss: 12,
        cacheCreation: 0,
        requests: 1,
        cacheUsageRequests: 1,
        models: {
          "test-model": { input: 20, output: 4, hit: 8, miss: 12, cacheCreation: 0, requests: 1, cacheUsageRequests: 1 },
        },
      },
    };

    clearUsage(days);

    expect(days).toEqual({});
  });
});

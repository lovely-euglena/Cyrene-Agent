import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { computeUsageCost } from "./cost-engine";

// 设置依赖打桩：单价层（手改）与峰谷/节假日由 facade/model-settings 注入
vi.mock("../settings/settings-facade", () => ({
  loadGeneralSettings: vi.fn(() => ({ peakValleyConfig: { enabled: false, rules: [] }, holidayDayTypeOverrides: {} })),
}));
vi.mock("../settings/model-settings", () => ({
  listSavedModelProfiles: () => [],
  loadModelSettings: () => ({}),
}));

import priceList from "../../shared/pricing/data/model-price-list.json";

describe("computeUsageCost（issue #212 请求时刻成本）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-28T10:00:00+08:00")); // 周三 工作日
  });
  afterEach(() => vi.useRealTimers());

  it("内置价目模型：per1M 计费数学（miss/hit/creation/output 四路）", () => {
    const entry = Object.entries(priceList.models)[0];
    expect(entry).toBeTruthy();
    const [name, p] = entry as [string, { inputPrice: number; outputPrice: number; cacheHitInputPrice?: number }];
    const cost = computeUsageCost({ model: name, input: 2_000_000, output: 1_000_000, cachedInput: 1_000_000, cacheCreation: 500_000 });
    expect(cost).toBeDefined();
    const div = 1_000_000;
    const expected = (1_000_000 * p.inputPrice + 1_000_000 * (p.cacheHitInputPrice ?? p.inputPrice)
      + 500_000 * p.inputPrice + 1_000_000 * p.outputPrice) / div;
    expect(cost!.amount).toBeCloseTo(Number(expected.toFixed(6)), 4);
    expect(cost!.currency).toBeTruthy();
    expect(cost!.tierMatched).toBe(false); // 峰谷关 → 平段
  });

  it("未配单价模型 → undefined（统计页显示横杠而非 0）", () => {
    expect(computeUsageCost({ model: "totally-unknown-model-x", input: 100, output: 100 })).toBeUndefined();
  });

  it("全零 usage → undefined", () => {
    expect(computeUsageCost({ model: Object.keys(priceList.models)[0], input: 0, output: 0 })).toBeUndefined();
  });

  it("全命中输入按命中价（有 cacheHitInputPrice 用之，缺失退回原价）", () => {
    const [name, raw] = Object.entries(priceList.models)[0];
    const p = raw as { inputPrice: number; outputPrice: number; cacheHitInputPrice?: number };
    const cost = computeUsageCost({ model: name, input: 1_000_000, output: 0, cachedInput: 1_000_000 });
    expect(cost?.amount).toBeCloseTo(p.cacheHitInputPrice ?? p.inputPrice, 4);
  });
});

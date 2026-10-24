import { describe, expect, it } from "vitest";

import {
  builtinPriceListMeta,
  lookupBuiltinPricing,
  normalizeModelPricing,
} from "./model-pricing";
import priceList from "./data/model-price-list.json";

describe("model-pricing（#209 模型单价）", () => {
  it("内置价目命中 deepseek-flash（2026-10-24 官方页核实：标准/高峰价）", () => {
    const p = lookupBuiltinPricing("deepseek-flash");
    expect(p).toBeDefined();
    expect(p!.currency).toBe("CNY");
    expect(p!.unit).toBe("per1M");
    expect(p!.inputPrice).toBe(2); // 缓存未命中输入，标准价
    expect(p!.outputPrice).toBe(8);
    expect(p!.cacheHitInputPrice).toBe(0.04);
    expect(p!.custom).toBeUndefined(); // 内置层不带 custom 标记
  });

  it("内置价目命中 deepseek-v4-pro", () => {
    const p = lookupBuiltinPricing("deepseek-v4-pro");
    expect(p).toBeDefined();
    expect(p!.inputPrice).toBe(9);
    expect(p!.outputPrice).toBe(27);
    expect(p!.cacheHitInputPrice).toBe(0.3);
  });

  it("未收录模型返回 undefined（统计层显示 —，不猜价格）", () => {
    expect(lookupBuiltinPricing("gpt-whatever")).toBeUndefined();
    expect(lookupBuiltinPricing("")).toBeUndefined();
  });

  it("内置快照带更新日期与来源链接（三层叠加：更新不冲手改）", () => {
    const meta = builtinPriceListMeta();
    expect(meta.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(meta.sourceUrl).toMatch(/^https?:\/\//);
    expect(Object.keys(priceList.models).length).toBeGreaterThan(0);
  });

  it("normalize：合法单价整条通过", () => {
    const p = normalizeModelPricing({
      currency: "cny",
      unit: "per1M",
      inputPrice: 2,
      outputPrice: 8,
      cacheHitInputPrice: 0.04,
    });
    expect(p).toEqual({ currency: "CNY", unit: "per1M", inputPrice: 2, outputPrice: 8, cacheHitInputPrice: 0.04 });
  });

  it("normalize：半填/非法整条丢弃（半吊子价格会算出误导性成本）", () => {
    expect(normalizeModelPricing(undefined)).toBeUndefined();
    expect(normalizeModelPricing("x")).toBeUndefined();
    expect(normalizeModelPricing({ currency: "CNY", unit: "per1M", inputPrice: 0, outputPrice: 8 })).toBeUndefined();
    expect(normalizeModelPricing({ currency: "CNY", unit: "per1M", outputPrice: 8 })).toBeUndefined(); // 缺 inputPrice
    expect(normalizeModelPricing({ currency: "USDT-T", unit: "per1M", inputPrice: 1, outputPrice: 2 })).toBeUndefined();
    expect(normalizeModelPricing({ currency: "CNY", unit: "per-GPT", inputPrice: 1, outputPrice: 2 })).toBeUndefined();
    // 命中价 > 输入价 = 荒谬，整条丢弃
    expect(normalizeModelPricing({ currency: "CNY", unit: "per1M", inputPrice: 2, outputPrice: 8, cacheHitInputPrice: 5 })).toBeUndefined();
  });

  it("normalize：custom 标记透传（版本更新不冲手改）", () => {
    const p = normalizeModelPricing({
      currency: "USD",
      unit: "per1K",
      inputPrice: 0.5,
      outputPrice: 1.5,
      custom: true,
    });
    expect(p!.custom).toBe(true);
  });
});

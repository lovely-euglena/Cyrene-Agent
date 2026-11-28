import { describe, expect, it } from "vitest";

import {
  effectivePricing,
  normalizePeakValleyConfig,
  resolvePeakValley,
  type PeakValleyConfig,
  type PricingBase,
} from "./peak-valley";
import { PEAK_VALLEY_TEMPLATES, findPeakValleyTemplate } from "./peak-valley-templates";

/** 固定 UTC 时刻的构造器；DS 模板时区 Asia/Shanghai（UTC+8）。 */
const at = (utcIso: string) => new Date(utcIso);

const BASE: PricingBase = { currency: "CNY", unit: "per1M", inputPrice: 2, outputPrice: 8, cacheHitInputPrice: 0.04 };

describe("peak-valley 判定器（#211）", () => {
  const config = findPeakValleyTemplate("deepseek")!.build();

  it("normalize：模板配置合法（enabled=false 起步）", () => {
    const n = normalizePeakValleyConfig(config);
    expect(n.rules).toHaveLength(2);
    expect(n.enabled).toBe(false); // 模板默认关闭，用户套用后自行开启
  });

  it("周三上午 10:00 北京时间 = 高峰（×1.0 = 基准原样）", () => {
    // 2026-10-28 是周三；02:00 UTC = 北京 10:00
    const r = resolvePeakValley(at("2026-10-28T02:00:00Z"), { ...config, enabled: true });
    expect(r.matched).toBe(true);
    if (r.matched) {
      expect(r.pricing.mode).toBe("multiplier");
      expect(r.pricing.mode === "multiplier" && r.pricing.multiplier).toBe(1.0);
    }
  });

  it("工作日午休 13:00 = 空闲半价", () => {
    // 05:00 UTC = 北京 13:00（周三）
    const r = resolvePeakValley(at("2026-10-28T05:00:00Z"), { ...config, enabled: true });
    expect(r.matched).toBe(true);
    if (r.matched && r.pricing.mode === "multiplier") expect(r.pricing.multiplier).toBe(0.5);
  });

  it("周六下午 = 全天谷（workday 之外日类型命中谷规则全天段）", () => {
    // 2026-10-24 周六；06:00 UTC = 北京 14:00
    const r = resolvePeakValley(at("2026-10-24T06:00:00Z"), { ...config, enabled: true });
    expect(r.matched).toBe(true);
    if (r.matched && r.pricing.mode === "multiplier") expect(r.pricing.multiplier).toBe(0.5);
  });

  it("调休补班周六全天按谷（TA 2026-10-24 确认的 DS 官方口径）", () => {
    // 2026-10-10 周六 = 补班日（#210 表 adjustedWorkday）；02:00 UTC = 北京 10:00
    // 若误把它当 workday 则会命中高峰规则——正确行为是谷
    const r = resolvePeakValley(at("2026-10-10T02:00:00Z"), { ...config, enabled: true });
    expect(r.matched).toBe(true);
    if (r.matched && r.pricing.mode === "multiplier") expect(r.pricing.multiplier).toBe(0.5);
  });

  it("法定节假日（春节 2026-02-19 周四）全天按谷", () => {
    const r = resolvePeakValley(at("2026-02-19T02:00:00Z"), { ...config, enabled: true });
    expect(r.matched).toBe(true);
    if (r.matched && r.pricing.mode === "multiplier") expect(r.pricing.multiplier).toBe(0.5);
  });

  it("enabled=false 恒平段", () => {
    expect(resolvePeakValley(at("2026-10-28T02:00:00Z"), config)).toEqual({ matched: false });
  });

  it("无效时区规则被跳过，不炸不断链", () => {
    const bad: PeakValleyConfig = {
      enabled: true,
      rules: [{ dayTypes: ["everyday"], intervals: [{ start: "00:00", end: "24:00" }], pricing: { mode: "multiplier", multiplier: 2 }, timezone: "Mars/Olympus" }],
    };
    expect(resolvePeakValley(at("2026-10-28T02:00:00Z"), bad)).toEqual({ matched: false });
  });

  it("特异性优先：节假日规则压过 everyday 规则", () => {
    const cfg: PeakValleyConfig = {
      enabled: true,
      rules: [
        { dayTypes: ["everyday"], intervals: [{ start: "00:00", end: "24:00" }], pricing: { mode: "multiplier", multiplier: 2 }, timezone: "Asia/Shanghai" },
        { dayTypes: ["holiday"], intervals: [{ start: "00:00", end: "24:00" }], pricing: { mode: "multiplier", multiplier: 0.5 }, timezone: "Asia/Shanghai" },
      ],
    };
    // 2026-10-01 国庆（holiday）
    const r = resolvePeakValley(at("2026-10-01T02:00:00Z"), cfg);
    expect(r.matched).toBe(true);
    if (r.matched && r.pricing.mode === "multiplier") expect(r.pricing.multiplier).toBe(0.5);
  });

  it("手动 override 最高优先：把节假日手改成 workday 后命中高峰规则", () => {
    const r = resolvePeakValley(at("2026-10-01T02:00:00Z"), { ...config, enabled: true }, {
      dayTypeOverrides: { "2026-10-01": "workday" },
    });
    expect(r.matched).toBe(true);
    if (r.matched && r.pricing.mode === "multiplier") expect(r.pricing.multiplier).toBe(1.0);
  });

  it("normalize：非法规则整条丢弃（坏时区/坏区间/坏定价）", () => {
    const n = normalizePeakValleyConfig({
      enabled: true,
      rules: [
        { dayTypes: ["workday"], intervals: [{ start: "25:00", end: "26:00" }], pricing: { mode: "multiplier", multiplier: 0.5 }, timezone: "Asia/Shanghai" },
        { dayTypes: ["workday"], intervals: [{ start: "09:00", end: "12:00" }], pricing: { mode: "multiplier", multiplier: -1 }, timezone: "Asia/Shanghai" },
        { dayTypes: [], intervals: [{ start: "09:00", end: "12:00" }], pricing: { mode: "multiplier", multiplier: 0.5 }, timezone: "Asia/Shanghai" },
        { dayTypes: ["workday"], intervals: [{ start: "09:00", end: "12:00" }], pricing: { mode: "absolute", currency: "CNY", unit: "per1M", inputPrice: 1, outputPrice: 4 }, timezone: "Mars/Olympus" },
        { dayTypes: ["workday"], intervals: [{ start: "09:00", end: "12:00" }], pricing: { mode: "absolute", currency: "CNY", unit: "per1M", inputPrice: 1, outputPrice: 4, cacheHitInputPrice: 3 }, timezone: "Asia/Shanghai" },
      ],
    });
    expect(n.rules).toHaveLength(1); // 只有最后一条（合法直价）存活
    expect(n.enabled).toBe(true);
  });

  it("effectivePricing：倍率作用全部类别（含缓存命中价）", () => {
    const out = effectivePricing(BASE, { matched: true, pricing: { mode: "multiplier", multiplier: 0.5 }, ruleIndex: 0 });
    expect(out.inputPrice).toBe(1);
    expect(out.outputPrice).toBe(4);
    expect(out.cacheHitInputPrice).toBe(0.02);
  });

  it("effectivePricing：直价直接生效，平段原样", () => {
    const abs = { mode: "absolute" as const, currency: "CNY", unit: "per1M" as const, inputPrice: 1, outputPrice: 4, cacheHitInputPrice: 0.02 };
    expect(effectivePricing(BASE, { matched: true, pricing: abs, ruleIndex: 0 })).toEqual({
      currency: "CNY", unit: "per1M", inputPrice: 1, outputPrice: 4, cacheHitInputPrice: 0.02, custom: undefined,
    });
    expect(effectivePricing(BASE, { matched: false })).toEqual(BASE);
  });
});

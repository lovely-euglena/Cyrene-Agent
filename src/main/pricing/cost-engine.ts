// pricing/cost-engine —— 成本计算引擎（issue #212，父 #208；依赖 #209 单价 + #211 峰谷 + #210 节假日）。
//
// 核心原则（#212 任务条款）：**请求发生时刻**判定峰/谷/平并落账——不是统计展示时刻回溯。
// 调用点在 chat-loop 的 usage 采样处（recordUsage），随请求记录成本。
//
// 计费语义（DS 官方口径，2026-10-24 官方文档核实存档）：
// - input 含缓存命中的 tokens：命中部分按 cacheHitInputPrice（仅支持厂商有），
//   未命中部分按 inputPrice；
// - cacheCreation（缓存写入）按 inputPrice 计；
// - 无 cacheHitInputPrice 的厂商：命中部分退回 inputPrice（无优惠口径）。
// - 单位换算：per1M ÷1e6，per1K ÷1e3。
// - 币种跟随单价来源，不强转——store.costs 按币种分桶聚合。
// - 未配单价模型 → undefined（统计页显示"—"，非 ¥0）。

import { loadGeneralSettings } from "../settings/settings-facade";
import { listSavedModelProfiles, loadModelSettings } from "../settings/model-settings";
import { lookupBuiltinPricing, type ModelPricing } from "../../shared/pricing/model-pricing";
import { effectivePricing, resolvePeakValley, type PeakValleyConfig, type PricingBase } from "./peak-valley";

/** 单次 usage 采样对应的成本（请求时刻已套用峰谷有效价）。 */
export interface UsageCost {
  currency: string;
  amount: number;
  /** 峰谷规则是否命中（平段 false）。 */
  tierMatched: boolean;
  /** 命中的规则序号（tierMatched 时；调试/统计展示用）。 */
  ruleIndex?: number;
}

/** 三层叠加取单价：用户手改（profile.modelOptions）> 内置快照 > 未收录（undefined）。 */
export function resolveModelPricingAtRuntime(name: string): ModelPricing | undefined {
  for (const profile of listSavedModelProfiles(loadModelSettings())) {
    const pricing = profile.modelOptions?.[name]?.pricing;
    if (pricing) return pricing;
  }
  return lookupBuiltinPricing(name);
}

function unitDivisor(unit: PeakValleyConfig extends never ? never : "per1M" | "per1K"): number {
  return unit === "per1M" ? 1_000_000 : 1_000;
}

/**
 * 请求时刻成本计算：峰谷判定（含节假日 override + 规则时区）→ 有效价 → usage 计费。
 * 未配单价 / 峰谷配置读取失败（运行时不炸）→ undefined。
 */
export function computeUsageCost(input: {
  model: string;
  input: number;
  output: number;
  cachedInput?: number;
  cacheCreation?: number;
  at?: Date;
}): UsageCost | undefined {
  try {
    const base = resolveModelPricingAtRuntime(input.model);
    if (!base) return undefined;

    const general = loadGeneralSettings();
    const peakValley: PeakValleyConfig | undefined = general.peakValleyConfig;
    const resolution = peakValley?.enabled
      ? resolvePeakValley(input.at ?? new Date(), peakValley, {
          dayTypeOverrides: general.holidayDayTypeOverrides,
        })
      : ({ matched: false } as const);
    const price: PricingBase = effectivePricing(base, resolution);

    const div = unitDivisor(price.unit);
    const totalInput = Math.max(0, input.input || 0);
    const hit = Math.min(Math.max(0, input.cachedInput || 0), totalInput);
    const miss = totalInput - hit;
    const hitPrice = price.cacheHitInputPrice ?? price.inputPrice;

    const missCost = (miss * price.inputPrice) / div;
    const hitCost = (hit * hitPrice) / div;
    const creationCost = (Math.max(0, input.cacheCreation || 0) * price.inputPrice) / div;
    const outputCost = (Math.max(0, input.output || 0) * price.outputPrice) / div;

    if (totalInput === 0 && input.output === 0 && (input.cacheCreation || 0) === 0) return undefined;

    return {
      currency: price.currency,
      amount: Number((missCost + hitCost + creationCost + outputCost).toFixed(6)),
      tierMatched: resolution.matched,
      ...(resolution.matched ? { ruleIndex: (resolution as { ruleIndex: number }).ruleIndex } : {}),
    };
  } catch {
    // 成本是旁路：任何设置/规则异常都不打断对话链路
    return undefined;
  }
}

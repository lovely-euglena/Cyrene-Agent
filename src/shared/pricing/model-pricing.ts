// pricing/model-pricing —— 模型单价数据层（issue #209，成本统计 #212 的数据源）。
//
// 数据分层（父 issue #208 三层叠加原则）：
// - 用户手动编辑（最高优先，存在 ProviderProfile.modelOptions[name].pricing，标 custom）
// - 内置价目快照（data/model-price-list.json，随版本更新，含更新日期与来源）
// 内置表未收录的模型由用户自填；两者都缺 = 该模型不计成本（统计页显示"—"）。
//
// 设计决定（#208 评论存档）：计价单位 per 1M / 1K 可标（各家口径不同）；币种不强转；
// 峰谷不在此表表达（峰谷是时段规则，见 #211）。

import priceList from "./data/model-price-list.json";

export type PricingUnit = "per1M" | "per1K";

/** 单模型单价（基准价 = 标准/高峰价；峰谷价由 #211 规则在计算时套用）。 */
export interface ModelPricing {
  /** 币种（ISO 4217 常用码：CNY / USD…），展示跟随单价来源，不做汇率换算。 */
  currency: string;
  /** 计价单位：价格对应每 100 万还是每 1K tokens。 */
  unit: PricingUnit;
  /** 输入价（缓存未命中口径） */
  inputPrice: number;
  /** 输出价 */
  outputPrice: number;
  /** 缓存命中输入价（仅支持前缀缓存的厂商有，如 DeepSeek）。 */
  cacheHitInputPrice?: number;
  /** 用户改过 = true（区别于内置快照；版本更新不冲掉手改）。 */
  custom?: boolean;
}

export interface ModelPriceListSnapshot {
  updatedAt: string;
  sourceUrl: string;
  models: Record<string, Omit<ModelPricing, "custom"> & { source?: string }>;
}

const SNAPSHOT = priceList as ModelPriceListSnapshot;

/** 查内置价目（精确模型名匹配；未收录返回 undefined，调用方显示"—"）。 */
export function lookupBuiltinPricing(model: string): ModelPricing | undefined {
  const hit = SNAPSHOT.models[model];
  if (!hit) return undefined;
  return {
    currency: hit.currency,
    unit: hit.unit,
    inputPrice: hit.inputPrice,
    outputPrice: hit.outputPrice,
    ...(typeof hit.cacheHitInputPrice === "number" ? { cacheHitInputPrice: hit.cacheHitInputPrice } : {}),
  };
}

/** 内置价目快照元信息（设置页"价格数据更新于 xxx"展示用）。 */
export function builtinPriceListMeta(): { updatedAt: string; sourceUrl: string } {
  return { updatedAt: SNAPSHOT.updatedAt, sourceUrl: SNAPSHOT.sourceUrl };
}

const LEGAL_CURRENCIES = /^[A-Za-z]{3}$/;

/**
 * 单价规范化：任何字段不合法整条丢弃（返回 undefined），不做半吊子修复——
 * 半填的价格会算出误导性成本，宁可显示"—"。
 * inputPrice / outputPrice 必须 > 0；cacheHitInputPrice 可省略但填了必须 > 0 且 ≤ inputPrice。
 */
export function normalizeModelPricing(input: unknown): ModelPricing | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const raw = input as Record<string, unknown>;

  const currency = typeof raw.currency === "string" && LEGAL_CURRENCIES.test(raw.currency.trim())
    ? raw.currency.trim().toUpperCase()
    : undefined;
  const unit: PricingUnit | undefined = raw.unit === "per1K" ? "per1K" : raw.unit === "per1M" ? "per1M" : undefined;
  const positive = (v: unknown): number | undefined => {
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const inputPrice = positive(raw.inputPrice);
  const outputPrice = positive(raw.outputPrice);
  if (!currency || !unit || inputPrice === undefined || outputPrice === undefined) return undefined;

  let cacheHitInputPrice: number | undefined;
  if (raw.cacheHitInputPrice !== undefined && raw.cacheHitInputPrice !== null && raw.cacheHitInputPrice !== "") {
    const hit = positive(raw.cacheHitInputPrice);
    if (hit === undefined || hit > inputPrice) return undefined;
    cacheHitInputPrice = hit;
  }

  return {
    currency,
    unit,
    inputPrice,
    outputPrice,
    ...(cacheHitInputPrice !== undefined ? { cacheHitInputPrice } : {}),
    ...(raw.custom === true ? { custom: true } : {}),
  };
}

// pricing/peak-valley —— 峰谷计价规则集与判定器（issue #211，父 #208）。
//
// 建模（#208 评论存档修正版）：峰谷不是一档价格，是「计价类别 × 时段规则」矩阵——
// 规则命中后：倍率模式 = 基准价 × 系数（作用于全部计价类别，含缓存命中价）；
// 直价模式 = 规则内绝对价直接生效（照抄官方价格页错峰列，零心算）。
// 未命中任何规则 = 平段（基准价原样）。
//
// 日类型数据源：resolveDayType（#210，同目录）。判定走规则时区（每条规则自带 IANA 时区），
// 特异性优先：节假日/补班 > 周末 > 工作日 > 每天；同特异性按配置顺序。
//
// 注意：本模块属 main 侧（设置页 UI 落地时类型如需 renderer 共享，随其 PR 下沉 shared）。

import { resolveDayType, type DayType } from "./holidays";

/** 规则生效日类型（"everyday" 恒真，供"所有日子"型规则使用）。 */
export type PeakValleyDayType = DayType | "everyday";

export type PeakValleyUnit = "per1M" | "per1K";

/** 规则定价方式：倍率（统一系数）或直价（按计价类别绝对价）。二选一。 */
export type PeakValleyPricing =
  | { mode: "multiplier"; multiplier: number }
  | { mode: "absolute"; currency: string; unit: PeakValleyUnit; inputPrice: number; outputPrice: number; cacheHitInputPrice?: number };

export interface PeakValleyInterval {
  /** "HH:mm"（规则时区） */
  start: string;
  /** "HH:mm"；"24:00" 视为当日终了 */
  end: string;
}

export interface PeakValleyRule {
  /** 生效日类型，多选（DS 模板示例：["weekend", "holiday", "adjustedWorkday"]） */
  dayTypes: PeakValleyDayType[];
  /** 时段区间列表，支持一天多峰 */
  intervals: PeakValleyInterval[];
  pricing: PeakValleyPricing;
  /** IANA 时区（用户可选，默认预填厂商公告时区，DS = Asia/Shanghai） */
  timezone: string;
}

export interface PeakValleyConfig {
  enabled: boolean;
  /** 判定顺序 = 配置顺序；同特异性多条命中时靠前者胜 */
  rules: PeakValleyRule[];
}

/** 判定结果：平段（未命中）或命中某规则的有效定价。 */
export type PeakValleyResolution =
  | { matched: false }
  | { matched: true; pricing: PeakValleyPricing; ruleIndex: number };

/** 与 ModelPricing 同构的基准价形态（#209；类型在此独立声明，避免本模块依赖 #209 分支文件）。 */
export interface PricingBase {
  currency: string;
  unit: PeakValleyUnit;
  inputPrice: number;
  outputPrice: number;
  cacheHitInputPrice?: number;
  custom?: boolean;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const LEGAL_DAY_TYPES = new Set<PeakValleyDayType>(["workday", "weekend", "holiday", "adjustedWorkday", "everyday"]);
const LEGAL_CURRENCY = /^[A-Za-z]{3}$/;

/** 规则特异性：日类型越具体越优先（everyday 恒低）。取规则内最高特异性。 */
function ruleSpecificity(rule: PeakValleyRule): number {
  let max = 0;
  for (const t of rule.dayTypes) {
    const s = t === "everyday" ? 0 : t === "workday" || t === "weekend" ? 1 : 2; // holiday / adjustedWorkday = 2
    if (s > max) max = s;
  }
  return max;
}

function legalIntervals(input: unknown): PeakValleyInterval[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const out: PeakValleyInterval[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const { start, end } = item as Record<string, unknown>;
    if (typeof start === "string" && HHMM.test(start) && typeof end === "string" && HHMM.test(end) && start < end) {
      out.push({ start, end });
    }
  }
  return out.length > 0 ? out : undefined;
}

/** 直价校验（与 model-pricing 同强度：币种 3 字母 / 正价 / 命中价 ≤ 输入价，非法整条丢）。 */
function legalAbsolute(input: Record<string, unknown>): PeakValleyPricing | undefined {
  const currency = typeof input.currency === "string" && LEGAL_CURRENCY.test(input.currency.trim())
    ? input.currency.trim().toUpperCase() : undefined;
  const unit: PeakValleyUnit | undefined = input.unit === "per1K" ? "per1K" : input.unit === "per1M" ? "per1M" : undefined;
  const positive = (v: unknown): number | undefined => {
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const inputPrice = positive(input.inputPrice);
  const outputPrice = positive(input.outputPrice);
  if (!currency || !unit || inputPrice === undefined || outputPrice === undefined) return undefined;
  let cacheHitInputPrice: number | undefined;
  if (input.cacheHitInputPrice !== undefined && input.cacheHitInputPrice !== null && input.cacheHitInputPrice !== "") {
    const hit = positive(input.cacheHitInputPrice);
    if (hit === undefined || hit > inputPrice) return undefined;
    cacheHitInputPrice = hit;
  }
  return {
    mode: "absolute", currency, unit, inputPrice, outputPrice,
    ...(cacheHitInputPrice !== undefined ? { cacheHitInputPrice } : {}),
  };
}

function legalPricing(input: unknown): PeakValleyPricing | undefined {
  if (!input || typeof input !== "object") return undefined;
  const raw = input as Record<string, unknown>;
  if (raw.mode === "multiplier") {
    const m = typeof raw.multiplier === "number" ? raw.multiplier : Number(raw.multiplier);
    return Number.isFinite(m) && m > 0 && m <= 10 ? { mode: "multiplier", multiplier: m } : undefined;
  }
  if (raw.mode === "absolute") return legalAbsolute(raw);
  return undefined;
}

/** 规则集规范化：非法规则整条丢弃；enabled 仅在有合法规则时为真。供 settings 层洗盘。 */
export function normalizePeakValleyConfig(input: unknown): PeakValleyConfig {
  if (!input || typeof input !== "object") return { enabled: false, rules: [] };
  const raw = input as Record<string, unknown>;
  const rules: PeakValleyRule[] = [];
  if (Array.isArray(raw.rules)) {
    for (const item of raw.rules) {
      if (!item || typeof item !== "object") continue;
      const r = item as Record<string, unknown>;
      const dayTypes = Array.isArray(r.dayTypes)
        ? r.dayTypes.filter((t): t is PeakValleyDayType => typeof t === "string" && LEGAL_DAY_TYPES.has(t as PeakValleyDayType))
        : [];
      const intervals = legalIntervals(r.intervals);
      const pricing = legalPricing(r.pricing);
      const timezone = typeof r.timezone === "string" && r.timezone.trim() ? r.timezone.trim() : undefined;
      if (dayTypes.length === 0 || !intervals || !pricing || !timezone) continue;
      rules.push({ dayTypes, intervals, pricing, timezone });
    }
  }
  return { enabled: raw.enabled === true && rules.length > 0, rules };
}

/** 规则时区下的当地时间部件（无效时区返回 undefined，判定降级平段）。 */
export function zonedParts(date: Date, timeZone: string): { isoDate: string; hhmm: string } | undefined {
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    });
    const parts: Record<string, string> = {};
    for (const p of fmt.formatToParts(date)) parts[p.type] = p.value;
    const hour = parts.hour === "24" ? "00" : parts.hour;
    return { isoDate: `${parts.year}-${parts.month}-${parts.day}`, hhmm: `${hour}:${parts.minute}` };
  } catch {
    return undefined;
  }
}

function hhmmIn(hhmm: string, interval: PeakValleyInterval): boolean {
  const end = interval.end === "24:00" ? "24:00" : interval.end;
  return hhmm >= interval.start && hhmm < end;
}

/**
 * 峰谷判定。
 * - dayTypeResolver 可注入（测试替身）；默认 resolveDayType（内置表）。
 *   手动 override 由调用方拼进 dayTypeOverrides（general-settings.holidayDayTypeOverrides）。
 * - 无效时区：跳过该规则（设置页负责校验时区，运行时不炸、不打断对话链路）。
 * - 命中判定：特异性最高优先，同特异性按配置顺序；同一规则多区间任一命中即算。
 */
export function resolvePeakValley(
  now: Date,
  config: PeakValleyConfig | undefined,
  options?: {
    dayTypeOverrides?: Record<string, DayType>;
    dayTypeResolver?: (isoDate: string, overrides?: Record<string, DayType>) => DayType;
  },
): PeakValleyResolution {
  if (!config?.enabled || config.rules.length === 0) return { matched: false };
  const resolve = options?.dayTypeResolver ?? resolveDayType;
  const overrides = options?.dayTypeOverrides;

  const ordered = config.rules
    .map((rule, index) => ({ rule, index, spec: ruleSpecificity(rule) }))
    .sort((a, b) => b.spec - a.spec || a.index - b.index);

  for (const { rule, index } of ordered) {
    const parts = zonedParts(now, rule.timezone);
    if (!parts) continue;
    const dayType = parts.isoDate in (overrides ?? {})
      ? overrides![parts.isoDate]
      : resolve(parts.isoDate, overrides);
    const dayHit = rule.dayTypes.includes("everyday") || rule.dayTypes.includes(dayType);
    if (!dayHit) continue;
    if (rule.intervals.some((iv) => hhmmIn(parts.hhmm, iv))) {
      return { matched: true, pricing: rule.pricing, ruleIndex: index };
    }
  }
  return { matched: false };
}

/**
 * 命中后的有效单价：
 * - multiplier：三类别（输入/输出/缓存命中）全部 × 系数
 * - absolute：直接用规则价（currency/unit 以规则为准；基准无命中价而规则有 → 采纳规则价）
 * 平段（未命中）= 基准价原样。
 */
export function effectivePricing(base: PricingBase, resolution: PeakValleyResolution): PricingBase {
  if (!resolution.matched) return base;
  if (resolution.pricing.mode === "absolute") {
    return {
      currency: resolution.pricing.currency,
      unit: resolution.pricing.unit,
      inputPrice: resolution.pricing.inputPrice,
      outputPrice: resolution.pricing.outputPrice,
      ...(resolution.pricing.cacheHitInputPrice !== undefined
        ? { cacheHitInputPrice: resolution.pricing.cacheHitInputPrice }
        : base.cacheHitInputPrice !== undefined ? { cacheHitInputPrice: base.cacheHitInputPrice } : {}),
      custom: base.custom,
    };
  }
  const m = resolution.pricing.multiplier;
  return {
    currency: base.currency,
    unit: base.unit,
    inputPrice: base.inputPrice * m,
    outputPrice: base.outputPrice * m,
    ...(base.cacheHitInputPrice !== undefined ? { cacheHitInputPrice: base.cacheHitInputPrice * m } : {}),
    custom: base.custom,
  };
}

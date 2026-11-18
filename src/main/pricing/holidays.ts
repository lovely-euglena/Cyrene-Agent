// pricing/holidays —— 中国法定节假日 / 调休日数据层（峰谷计价的日类型数据源，issue #210）。
//
// 数据分层（父 issue #208 三层叠加原则，本模块实现两层）：
// - 手动 override（最高优先，由设置层传入，独立持久化）
// - 内置年度表（data/holidays-<year>.json，随版本更新，含来源与更新日期）
// 表外日期按自然日历判定（周六日 = weekend，否则 workday）——缺表年份如实降级，不臆造假日。
//
// 判定语义与厂商解耦：本模块只回答"这天是啥"，"勾了哪些类型怎么打折"由峰谷规则层（#211）决定。

import table2026 from "./data/holidays-2026.json";

export type DayType = "workday" | "weekend" | "holiday" | "adjustedWorkday";

export interface YearHolidayTable {
  year: number;
  source: string;
  sourceUrl: string;
  updatedAt: string;
  holidays: string[];
  adjustedWorkdays: string[];
}

/** 内置年度表注册处：新增年份随版本在此追加（后续接在线更新时合并在线源）。 */
const BUILTIN_TABLES: Record<number, YearHolidayTable> = {
  2026: table2026,
};

/** 手动 override 合法化：只保留完整 ISO 日期（YYYY-MM-DD）键 + 合法 DayType 值，其余丢弃不抛错。供 settings 层洗盘。 */
export function normalizeDayTypeOverrides(
  input: unknown,
): Record<string, DayType> {
  const out: Record<string, DayType> = {};
  if (!input || typeof input !== "object") return out;
  const legal = new Set<DayType>(["workday", "weekend", "holiday", "adjustedWorkday"]);
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(key) && typeof value === "string" && legal.has(value as DayType)) {
      out[key] = value as DayType;
    }
  }
  return out;
}

/**
 * 解析某日日类型。
 * 优先级：手动 override > 年度表（holiday / adjustedWorkday）> 自然日历（weekend / workday）。
 * 缺表年份（未内置且未在线更新）如实按自然日历降级——这是"按年表"模型的已知边界。
 * 日期解析统一走 UTC（`T00:00:00Z` + getUTCDay），避免宿主时区把日期偏移一天。
 */
export function resolveDayType(isoDate: string, overrides?: Record<string, DayType>): DayType {
  const manual = overrides ?? {};
  if (isoDate in manual) return manual[isoDate];

  const year = Number(isoDate.slice(0, 4));
  const table = BUILTIN_TABLES[year];
  if (table) {
    if (table.holidays.includes(isoDate)) return "holiday";
    if (table.adjustedWorkdays.includes(isoDate)) return "adjustedWorkday";
  }

  const weekday = new Date(`${isoDate}T00:00:00Z`).getUTCDay();
  return weekday === 0 || weekday === 6 ? "weekend" : "workday";
}

/** 某年是否有内置表（供设置层提示"该年份缺表，按自然日历判定"）。 */
export function hasBuiltinTable(year: number): boolean {
  return year in BUILTIN_TABLES;
}

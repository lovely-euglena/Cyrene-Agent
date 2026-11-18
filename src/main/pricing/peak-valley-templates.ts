// pricing/peak-valley-templates —— 内置峰谷规则模板（随版本更新，数值以官方页为准）。
//
// DeepSeek 口径（官方价格页注释，2026-10-24 核实）：
// "空闲时段价格为高峰时段价格的一半。北京时间周一至周五（不含中国法定节假日）
//  9:00-12:00、14:00-18:00 为高峰时段；其余时段，包括周末及中国法定节假日全天均为空闲时段。"
// TA 2026-10-24 补充：调休补班日全天按谷（官方口径）——所以高峰只勾 workday（普通工作日），
// adjustedWorkday / weekend / holiday 全部落入规则二的全天谷。
//
// 模板产出 PeakValleyConfig（enabled: false 起步，用户在设置页一键套用后自行开启）。

import type { PeakValleyConfig, PeakValleyRule } from "./peak-valley";

export interface PeakValleyTemplate {
  /** 模板标识（provider id 对齐，如 "deepseek"） */
  id: string;
  label: string;
  sourceUrl: string;
  updatedAt: string;
  build: () => PeakValleyConfig;
}

const DS_PEAK_RULE: PeakValleyRule = {
  dayTypes: ["workday"],
  intervals: [{ start: "09:00", end: "12:00" }, { start: "14:00", end: "18:00" }],
  pricing: { mode: "multiplier", multiplier: 1.0 },
  timezone: "Asia/Shanghai",
};

const DS_OFFPEAK_WORKDAY_RULE: PeakValleyRule = {
  // 工作日的非峰段 = 空闲（与峰规则同 spec 1，配置序靠后：峰段请求先命中峰规则）
  dayTypes: ["workday"],
  intervals: [
    { start: "00:00", end: "09:00" }, { start: "12:00", end: "14:00" }, { start: "18:00", end: "24:00" },
  ],
  pricing: { mode: "multiplier", multiplier: 0.5 },
  timezone: "Asia/Shanghai",
};

const DS_OFFPEAK_ALLDAY_RULE: PeakValleyRule = {
  // 周末 + 法定节假日 + 调休补班日 = 全天空闲（spec 2，压过任何 everyday/workday 规则）
  dayTypes: ["weekend", "holiday", "adjustedWorkday"],
  intervals: [{ start: "00:00", end: "24:00" }],
  pricing: { mode: "multiplier", multiplier: 0.5 },
  timezone: "Asia/Shanghai",
};

export const PEAK_VALLEY_TEMPLATES: PeakValleyTemplate[] = [
  {
    id: "deepseek",
    label: "DeepSeek 官方错峰口径（工作日双峰，其余全天半价）",
    sourceUrl: "https://api-docs.deepseek.com/zh-cn/quick_start/pricing/",
    updatedAt: "2026-10-24",
    build: () => ({
      enabled: false,
      rules: [
        // 规则序：峰(workday, spec1) → 工作日非峰谷(workday, spec1) → 全天谷(weekend/holiday/补班, spec2)。
        // 工作日峰段请求先命中峰规则；工作日非峰段落到谷规则 A；周末/节假日/补班命中全天谷。
        DS_PEAK_RULE,
        DS_OFFPEAK_WORKDAY_RULE,
        DS_OFFPEAK_ALLDAY_RULE,
      ],
    }),
  },
];

export function findPeakValleyTemplate(id: string): PeakValleyTemplate | undefined {
  return PEAK_VALLEY_TEMPLATES.find((t) => t.id === id);
}

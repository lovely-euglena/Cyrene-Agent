import { describe, expect, it } from "vitest";

import { hasBuiltinTable, resolveDayType, type YearHolidayTable } from "./holidays";
import table2026 from "./data/holidays-2026.json";

describe("holidays（#210 日类型判定）", () => {
  it("2026 元旦区间全判 holiday", () => {
    expect(resolveDayType("2026-01-01")).toBe("holiday");
    expect(resolveDayType("2026-01-02")).toBe("holiday");
    expect(resolveDayType("2026-01-03")).toBe("holiday");
  });

  it("2026 春节 9 天区间首尾与中段全判 holiday", () => {
    expect(resolveDayType("2026-02-15")).toBe("holiday");
    expect(resolveDayType("2026-02-19")).toBe("holiday");
    expect(resolveDayType("2026-02-23")).toBe("holiday");
  });

  it("调休补班日判 adjustedWorkday——即使落在自然周末（DS 谷价按官方口径命中这些天）", () => {
    // 2026-01-04 是周日、02-14 是周六：自然日历是周末，但表驱动覆盖为补班工作日
    expect(resolveDayType("2026-01-04")).toBe("adjustedWorkday");
    expect(resolveDayType("2026-02-14")).toBe("adjustedWorkday");
    expect(resolveDayType("2026-02-28")).toBe("adjustedWorkday");
    expect(resolveDayType("2026-05-09")).toBe("adjustedWorkday");
    expect(resolveDayType("2026-09-20")).toBe("adjustedWorkday");
    expect(resolveDayType("2026-10-10")).toBe("adjustedWorkday");
  });

  it("表外自然日历：周六日 weekend、工作日 workday", () => {
    expect(resolveDayType("2026-10-24")).toBe("weekend"); // 2026-10-24 周六
    expect(resolveDayType("2026-10-25")).toBe("weekend"); // 周日
    expect(resolveDayType("2026-10-26")).toBe("workday"); // 周一
  });

  it("放假区间内的自然周末仍判 holiday（表驱动优先于自然日历）", () => {
    // 2026-10-03 是周六、10-04 是周日，均落在国庆放假区间内
    expect(resolveDayType("2026-10-03")).toBe("holiday");
    expect(resolveDayType("2026-10-04")).toBe("holiday");
  });

  it("手动 override 最高优先", () => {
    expect(resolveDayType("2026-10-01", { "2026-10-01": "workday" })).toBe("workday");
    expect(resolveDayType("2026-10-26", { "2026-10-26": "holiday" })).toBe("holiday");
  });

  it("override 非法键被丢弃，不影响判定", () => {
    expect(resolveDayType("2026-10-01", { "2026-1-1": "workday" })).toBe("holiday");
  });

  it("缺表年份如实按自然日历降级", () => {
    expect(hasBuiltinTable(2025)).toBe(false);
    // 2025-10-01 是周三：缺 2025 表 → workday（已知边界：缺表年法定假日不识别）
    expect(resolveDayType("2025-10-01")).toBe("workday");
    expect(resolveDayType("2025-10-04")).toBe("weekend"); // 周六
  });

  it("内置表数据完整性：日期格式合法、两组互斥、全部落在对应年内", () => {
    const tables: YearHolidayTable[] = [table2026];
    const iso = /^\d{4}-\d{2}-\d{2}$/;
    for (const t of tables) {
      for (const d of [...t.holidays, ...t.adjustedWorkdays]) {
        expect(d).toMatch(iso);
        expect(d.startsWith(`${t.year}-`)).toBe(true);
      }
      const overlap = t.holidays.filter((d) => t.adjustedWorkdays.includes(d));
      expect(overlap).toEqual([]);
      // 逐日去重
      expect(new Set(t.holidays).size).toBe(t.holidays.length);
      expect(new Set(t.adjustedWorkdays).size).toBe(t.adjustedWorkdays.length);
    }
  });

  it("2026 表覆盖通知全部七节与六个补班日", () => {
    // 国办发明电〔2025〕7号：元旦/春节/清明/劳动/端午/中秋/国庆 + 6 个调休补班日
    expect(table2026.adjustedWorkdays).toHaveLength(6);
    for (const probe of [
      "2026-04-04", // 清明
      "2026-06-19", // 端午
      "2026-09-25", // 中秋
    ]) {
      expect(table2026.holidays).toContain(probe);
    }
    expect(table2026.holidays).toHaveLength(3 + 9 + 3 + 5 + 3 + 3 + 7); // 33 天
  });
});

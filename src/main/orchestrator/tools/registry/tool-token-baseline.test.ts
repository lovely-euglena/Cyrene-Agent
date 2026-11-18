import { describe, expect, it } from "vitest";
import { measureToolTokens } from "./tool-token-metrics";
// 副作用：注册全部内置工具
import "../built-in-tools";

/** #164 工具瘦身②——工具区 token 回归门禁。
 *
 * 规则：当前测量值 ≤ 基线 × 1.05（5% 容差吸收文案微调）。
 * 防抖：阈值/基线调整必须改下面的 BASELINE 常量（git diff 可见，不静默）；
 * 有意增大工具区时同步 `npx tsx scripts/tool-token-baseline.ts --write` 更新 docs。
 * 门禁口径详见 docs/tool-token-baseline.md。
 */
const BASELINE: Record<string, { toolCount: number; catalogTokens: number; schemaTokens: number }> = {
  "chat|default": { toolCount: 9, catalogTokens: 295, schemaTokens: 734 },
  "code|default": { toolCount: 15, catalogTokens: 441, schemaTokens: 1760 },
  "work|default": { toolCount: 17, catalogTokens: 478, schemaTokens: 1918 },
  "chat|all-hosted": { toolCount: 13, catalogTokens: 379, schemaTokens: 1094 },
  "code|all-hosted": { toolCount: 26, catalogTokens: 668, schemaTokens: 2799 },
  "work|all-hosted": { toolCount: 32, catalogTokens: 789, schemaTokens: 3317 },
};

const TOLERANCE = 1.05;

describe("tool token baseline gate（#164）", () => {
  const rows = measureToolTokens();

  it("组合覆盖完整（3 mode × 2 组合）", () => {
    expect(rows).toHaveLength(6);
  });

  it("工具区 tokens 未超基线容差；超限时打印 diff 明细", () => {
    const failures: string[] = [];
    for (const row of rows) {
      const key = `${row.mode}|${row.combo}`;
      const base = BASELINE[key];
      expect(base, `基线缺 ${key}——工具集变了？先更新 BASELINE 与 docs`).toBeTruthy();
      for (const layer of ["catalogTokens", "schemaTokens"] as const) {
        const limit = Math.ceil(base![layer] * TOLERANCE);
        if (row[layer] > limit) {
          failures.push(`${key} ${layer}: ${row[layer]} > 基线 ${base![layer]} × 1.05 = ${limit}（+${row[layer] - base![layer]}）`);
        }
      }
      if (row.toolCount > Math.ceil(base!.toolCount * TOLERANCE)) {
        failures.push(`${key} toolCount: ${row.toolCount} > 基线 ${base!.toolCount}（工具数量异常增长）`);
      }
    }
    if (failures.length > 0) {
      console.error("[tool-token-gate] 超限明细：\n" + failures.join("\n"));
    }
    expect(failures, `工具区 token 超基线容差（×${TOLERANCE}）——瘦身改动应让数字下降；有意增大请更新 BASELINE 常量与 docs 基线表`).toEqual([]);
  });
});

/**
 * 工具区 token 量化（#164 工具瘦身②）——测量核心。
 *
 * 口径（写死并文档化于 docs/tool-token-baseline.md）：
 * - tokens = ceil(chars / 4)（近似；门禁只依赖同口径下的相对变化）
 * - catalog 层 = buildToolCatalog(getEnabledToolsForMode(mode)) 真实系统提示文本
 * - schema 层 = function calling tools 数组的标准结构化 JSON
 *   （tools.map(t => ({ name, description, parameters }))）
 * - 组合：mode ∈ {chat, code, work} × 配置 ∈ {default, all-hosted}
 *   （all-hosted = SSH/云存储/音乐三组托管工具强制可见，等价实机全配置；
 *     需先 import built-in-tools 完成注册）
 */
import { buildToolCatalog } from "./tool-catalog";
import { toolRegistry, setHostedToolAvailabilityForTest } from "./tool-registry";

export const TOKEN_MODES = ["chat", "code", "work"] as const;
export type TokenMode = (typeof TOKEN_MODES)[number];
export type TokenCombo = "default" | "all-hosted";

/** 字符 → 近似 token 数（口径文档化：ceil(chars/4)）。 */
export function approxTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

function schemaChars(tools: readonly ToolDefinitionLike[]): number {
  return JSON.stringify(
    tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
  ).length;
}

type ToolDefinitionLike = { name: string; description?: string; parameters?: unknown };

export interface ToolTokenRow {
  mode: TokenMode;
  combo: TokenCombo;
  toolCount: number;
  catalogTokens: number;
  schemaTokens: number;
}

/** 测量全部 mode × 组合；测后恢复真实可用性状态。 */
export function measureToolTokens(): ToolTokenRow[] {
  const rows: ToolTokenRow[] = [];
  try {
    for (const combo of ["default", "all-hosted"] as const) {
      setHostedToolAvailabilityForTest(combo === "all-hosted" ? { ssh: true, storage: true, music: true } : null);
      for (const mode of TOKEN_MODES) {
        const tools = toolRegistry.getEnabledToolsForMode(mode);
        const catalog = buildToolCatalog(tools);
        rows.push({
          mode,
          combo,
          toolCount: tools.length,
          catalogTokens: approxTokens(catalog.length),
          schemaTokens: approxTokens(schemaChars(tools)),
        });
      }
    }
  } finally {
    setHostedToolAvailabilityForTest(null);
  }
  return rows;
}

/** 与脚本输出同构的 markdown 表（不含表头前缀）。 */
export function formatToolTokenTable(rows: readonly ToolTokenRow[]): string {
  const lines = [
    "| mode | 组合 | 工具数 | catalog tokens | schema tokens | 合计 |",
    "| --- | --- | ---: | ---: | ---: | ---: |",
  ];
  for (const r of rows) {
    lines.push(`| ${r.mode} | ${r.combo} | ${r.toolCount} | ${r.catalogTokens} | ${r.schemaTokens} | ${r.catalogTokens + r.schemaTokens} |`);
  }
  return lines.join("\n");
}

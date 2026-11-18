/**
 * 工具区 token 量化基线测量（#164 工具瘦身②）——CLI 薄壳。
 * 测量核心见 src/main/orchestrator/tools/registry/tool-token-metrics.ts。
 *
 * 用法：npx tsx scripts/tool-token-baseline.ts [--write]
 *   --write：把基线表写入 docs/tool-token-baseline.md（阈值变更同步门禁测试常量）
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { measureToolTokens, formatToolTokenTable } from "../src/main/orchestrator/tools/registry/tool-token-metrics";
import "../src/main/orchestrator/tools/built-in-tools";

const table = formatToolTokenTable(measureToolTokens());
console.log(table);

if (process.argv.includes("--write")) {
  const doc = path.join(import.meta.dirname ?? ".", "..", "docs", "tool-token-baseline.md");
  const header = fs.existsSync(doc)
    ? fs.readFileSync(doc, "utf8").split("\n| mode |")[0]
    : "# 工具区 token 基线（#164）\n\n> 口径：tokens = ceil(chars/4)（近似值，门禁只依赖同口径相对变化）。\n> catalog 层 = buildToolCatalog 真实提示文本；schema 层 = function calling tools 数组结构化 JSON。\n> all-hosted = SSH/云存储/音乐三组托管工具强制可见（等价实机全配置）。MCP 组合待 MCP mock 基建后补。\n\n> 基线表由 `npx tsx scripts/tool-token-baseline.ts --write` 生成；门禁阈值见 tool-token-baseline.test.ts（超限 = 基线 × 1.05）。\n";
  fs.writeFileSync(doc, header + "\n| mode |" + table.split("\n| mode |")[1] + "\n");
  console.log(`\n已写入 ${doc}`);
}

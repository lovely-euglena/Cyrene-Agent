/**
 * 简易命令行解析：支持引号包裹的参数，拆分为 { command, args }。
 * 渲染设置页（自定义 MCP Server 输入）与主进程 native 动作共用。
 */
export function parseCommandLine(input: string): { command: string; args: string[] } {
  const trimmed = input.trim();
  if (!trimmed) return { command: "", args: [] };
  const parts: string[] = [];
  let current = "";
  let inQuote = false;
  let quoteChar = "";
  for (const ch of trimmed) {
    if (inQuote) {
      if (ch === quoteChar) {
        inQuote = false;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      inQuote = true;
      quoteChar = ch;
    } else if (ch === " ") {
      if (current) {
        parts.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current) parts.push(current);
  return { command: parts[0] || "", args: parts.slice(1) };
}

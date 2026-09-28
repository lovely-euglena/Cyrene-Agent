// 通用解析纯函数：字符串 → 数值/命令行
// 从 settings.ts 抽离，无 DOM/状态依赖。

/** 解析正整数；不合法时抛出 th（错误信息字符串）。 */
export function parsePositiveIntOrThrow(input: string, th: any) {
  if (!/^[0-9]+$/.test(input)) {
    throw th;
  }
  if (isNaN(input as any)) {
    throw th;
  }
  const result = parseInt(input);
  if (Number.isNaN(result) || result <= 0) {
    throw th;
  }
  return result;
}

// 命令行解析已迁至 shared（主进程 native 动作复用）；保持旧 import 路径兼容。
export { parseCommandLine } from "../../../shared/parse-command-line";

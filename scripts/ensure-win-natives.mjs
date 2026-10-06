/**
 * Linux 构建机交叉打包 Windows 版前，确保平台变体 native 包在位。
 *
 * 背景：npm install 只装当前平台的 optionalDependencies 变体（Linux 构建
 * 机装 linux-gnu），而 Windows 运行时 require 的是 win32-x64-msvc 变体。
 * 缺失时主进程启动即 MODULE_NOT_FOUND（Node 22+ 报错带 "npm i <pkg>"
 * 提示）。本脚本是单一事实源——新增 native 依赖时在这里登记。
 *
 * 用法：node scripts/ensure-win-natives.mjs   （exit 1 = 有缺失）
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// [主包, win 变体]——版本以主包 optionalDependencies 声明为准
const NATIVES = [
  ["@node-rs/jieba", "@node-rs/jieba-win32-x64-msvc"],
  ["@ast-grep/napi", "@ast-grep/napi-win32-x64-msvc"],
];

const missing = [];
for (const [main, variant] of NATIVES) {
  const variantDir = join(root, "node_modules", ...variant.split("/"));
  if (existsSync(variantDir)) continue;

  // pnpm 隔离布局：变体装在 .pnpm 虚拟仓（node_modules/.pnpm/<scope>+<name>@<ver>/），
  // 顶层 node_modules 只挂直接依赖——补一次虚拟仓检查，避免 pnpm 下误报。
  let ver = null;
  try {
    const pj = JSON.parse(readFileSync(join(root, "node_modules", ...main.split("/"), "package.json"), "utf8"));
    ver = pj.optionalDependencies?.[variant] ?? null;
  } catch {
    /* 主包也缺：让上层 npm install 报 */
  }
  const pnpmDir = join(root, "node_modules", ".pnpm");
  const entryPrefix = `${variant.replace("/", "+")}@`;
  const inPnpm =
    existsSync(pnpmDir) &&
    readdirSync(pnpmDir).some((name) =>
      ver ? name === `${entryPrefix}${ver}` || name.startsWith(`${entryPrefix}${ver}_`) : name.startsWith(entryPrefix),
    );
  if (inPnpm) continue;

  missing.push(`${variant}@${ver ?? "latest"}`);
}

if (missing.length > 0) {
  console.error("[ensure-win-natives] 缺少 win32 变体，打包前先补装：");
  console.error(`  npm install --no-save --no-package-lock --force ${missing.join(" ")}`);
  console.error("  （pnpm 工作区：确认 node_modules/.pnpm 虚拟仓内有对应变体）");
  process.exit(1);
}
console.log("[ensure-win-natives] win32 变体齐全 ✓");

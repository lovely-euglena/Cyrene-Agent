#!/usr/bin/env node
/**
 * 构建 PWA 静态资产到 cloudflare/cloud-server/assets（Workers 静态资产目录）。
 * 复用 src/pwa 的 Vite 构建，仅通过 CYRENE_PWA_OUT_DIR 改写产物目录。
 * 前置：src/pwa 已安装依赖（npm --prefix src/pwa ci）。
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, "..");
const REPO_ROOT = resolve(PACKAGE_ROOT, "..", "..");
const PWA_ROOT = join(REPO_ROOT, "src", "pwa");
const OUT_DIR = join(PACKAGE_ROOT, "assets");

if (!existsSync(join(PWA_ROOT, "node_modules"))) {
  console.error(`缺少 src/pwa 依赖：${PWA_ROOT}\\node_modules\n先运行：npm --prefix src/pwa ci`);
  process.exit(2);
}

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const result = spawnSync(npm, ["run", "build"], {
  cwd: PWA_ROOT,
  stdio: "inherit",
  shell: process.platform === "win32", // Windows：Node 禁止直接 spawn .cmd，需经 shell
  env: { ...process.env, CYRENE_PWA_OUT_DIR: OUT_DIR },
});
if (result.error) {
  console.error(result.error);
  process.exit(1);
}
process.exit(result.status ?? 1);

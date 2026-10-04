#!/usr/bin/env node
/**
 * 构建 PWA 静态资产到 php/cloud-server/public/（IKJN7C）。
 * 复用 src/pwa 的 Vite 构建：先出到临时目录（emptyOutDir 安全），再复制进 public/
 * （保留 index.php / .htaccess 等站点文件）。
 * 前置：src/pwa 已安装依赖（npm --prefix src/pwa ci）。
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, "..");
const REPO_ROOT = resolve(PACKAGE_ROOT, "..", "..");
const PWA_ROOT = join(REPO_ROOT, "src", "pwa");
const PUBLIC_DIR = join(PACKAGE_ROOT, "public");
const STAGE_DIR = mkdtempSync(join(tmpdir(), "cyrene-php-pwa-"));

if (!existsSync(join(PWA_ROOT, "node_modules"))) {
  console.error(`缺少 src/pwa 依赖：${PWA_ROOT}\\node_modules\n先运行：npm --prefix src/pwa ci`);
  process.exit(2);
}

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const result = spawnSync(npm, ["run", "build"], {
  cwd: PWA_ROOT,
  stdio: "inherit",
  shell: process.platform === "win32",
  env: { ...process.env, CYRENE_PWA_OUT_DIR: STAGE_DIR },
});
if (result.error) {
  console.error(result.error);
  process.exit(1);
}
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
cpSync(STAGE_DIR, PUBLIC_DIR, { recursive: true, force: true });
rmSync(STAGE_DIR, { recursive: true, force: true });
console.log(`PWA 资产已就位：${PUBLIC_DIR}`);

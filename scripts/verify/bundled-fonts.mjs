// 构建后校验实际资源与许可，避免源码齐全但安装包漏带文件。
// 用法：node scripts/verify/bundled-fonts.mjs [dist/renderer 或解包后的 renderer 目录]
// 审计 app.asar 时可用 ELECTRON_RUN_AS_NODE=1 的 Electron 执行同一脚本。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const sourceDir = path.join(projectRoot, "src/renderer/public/fonts");
const rendererDir = path.resolve(process.argv[2] ?? process.env.CYRENE_PERF_OUT_DIR ?? path.join(projectRoot, "dist/renderer"));
const manifestBytes = readFileSync(path.join(sourceDir, "manifest.json"));
const manifest = JSON.parse(manifestBytes.toString("utf8"));
const bundledDir = path.join(rendererDir, "fonts");

assert.deepEqual(manifest.files.map((file) => file.file).sort(), [...manifest.fonts.map((font) => font.file), "JetBrainsMono-OFL.txt"].sort());
assert.deepEqual(readFileSync(path.join(bundledDir, "manifest.json")), manifestBytes);
for (const file of manifest.files) {
  const bytes = readFileSync(path.join(bundledDir, file.file));
  assert.equal(bytes.length, file.bytes, `${file.file}: 大小不符`);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256.toLowerCase(), `${file.file}: 校验和不符`);
}

const urls = new Set();
for (const file of readdirSync(path.join(rendererDir, "assets"))) {
  if (!file.endsWith(".css")) continue;
  const cssPath = path.join(rendererDir, "assets", file);
  const css = readFileSync(cssPath, "utf8");
  assert.doesNotMatch(css, /fonts\.(?:googleapis|gstatic)\.com/, `${file}: 仍依赖在线字体`);
  for (const face of css.matchAll(/@font-face\s*\{([^}]+)\}/g)) {
    if (!/font-family:\s*["']?JetBrains Mono/.test(face[1])) continue;
    const url = face[1].match(/url\(["']?([^\s)"']+)/)?.[1];
    assert.ok(url && !/^(?:\/|[a-z]+:)/i.test(url), `${file}: 字体必须使用相对路径`);
    const resolved = fileURLToPath(new URL(url, pathToFileURL(cssPath)));
    assert.equal(path.dirname(resolved), bundledDir, `${file}: 字体路径未指向随包目录`);
    readFileSync(resolved);
    urls.add(path.basename(resolved));
  }
}
assert.deepEqual([...urls].sort(), manifest.fonts.map((font) => font.file).sort());
console.log(JSON.stringify({ fonts: [...urls].sort(), verifiedFiles: manifest.files.map((file) => file.file), fontBytes: manifest.fonts.reduce((sum, font) => sum + font.bytes, 0) }, null, 2));

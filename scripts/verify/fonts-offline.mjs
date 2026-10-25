// 只打开静态字体样张，不加载 Cyrene 页面、主进程或 preload。
// 用法：node scripts/verify/fonts-offline.mjs [renderer 目录] [证据输出目录]
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, unlinkSync, rmdirSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const root = path.resolve(process.argv[2] ?? path.join(projectRoot, "dist/renderer"));
const output = process.argv[3] && path.resolve(process.argv[3]);
const stylesheet = readdirSync(path.join(root, "assets")).find((file) => file.endsWith(".css") && /JetBrains Mono|JetBrains\+Mono/.test(readFileSync(path.join(root, "assets", file), "utf8")));
assert.ok(stylesheet, "未找到代码字体样式");
const html = (href) => `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="${href}"><style>body{margin:32px;background:#fff8fb;color:#222}section{padding:20px;background:white;margin:12px 0}p{font-family:'JetBrains Mono';font-size:24px}h1,small{font-family:system-ui}</style><h1>离线代码字体验证</h1>${[400, 500].map((weight) => `<section><small>JetBrains Mono ${weight}</small><p style="font-weight:${weight}">Cyrene 0123456789 != =&gt; [] {}<br>const font = 'local';</p></section>`).join("")}`;
const server = createServer((request, response) => {
  const pathname = new URL(request.url, "http://localhost").pathname;
  if (pathname === "/fixture.html") {
    response.setHeader("Content-Type", "text/html;charset=utf-8");
    return response.end(html(`/assets/${stylesheet}`));
  }
  const file = path.resolve(root, `.${decodeURIComponent(pathname)}`);
  if (!file.startsWith(root + path.sep)) { response.writeHead(403); return response.end(); }
  try {
    response.setHeader("Content-Type", file.endsWith(".css") ? "text/css" : "font/woff2");
    response.end(readFileSync(file));
  } catch { response.writeHead(404); response.end(); }
});
const temporary = mkdtempSync(path.join(os.tmpdir(), "cyrene-font-specimen-"));
const fixture = path.join(temporary, "fixture.html");
writeFileSync(fixture, html(pathToFileURL(path.join(root, "assets", stylesheet)).href));
let browser;
const results = [];
try {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  browser = await chromium.launch({ channel: "msedge", headless: true });
  for (const [protocol, url] of [["http", `http://127.0.0.1:${server.address().port}/fixture.html`], ["file", pathToFileURL(fixture).href]]) {
    const context = await browser.newContext({ viewport: { width: 1050, height: 550 } });
    const externalRequests = [], fontRequests = [], pageErrors = [];
    await context.route("**/*", (route) => {
      const target = new URL(route.request().url());
      if (target.protocol !== "file:" && target.hostname !== "127.0.0.1") {
        externalRequests.push(target.hostname);
        return route.abort();
      }
      if (target.pathname.endsWith(".woff2")) fontRequests.push(path.basename(target.pathname));
      return route.continue();
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(url);
    const weights = await page.evaluate(async () => {
      const loaded = [];
      for (const weight of [400, 500]) {
        const faces = await document.fonts.load(`${weight} 24px "JetBrains Mono"`, "Cyrene 0123456789 != => [] {}");
        loaded.push({ weight, faces: faces.length, statuses: faces.map((face) => face.status), check: document.fonts.check(`${weight} 24px "JetBrains Mono"`) });
      }
      await document.fonts.ready;
      return loaded;
    });
    if (output) {
      mkdirSync(output, { recursive: true });
      await page.screenshot({ path: path.join(output, `${protocol}-fonts.png`), fullPage: true });
    }
    results.push({ protocol, weights, fontRequests, externalRequests, pageErrors });
    await context.close();
  }
  if (output) writeFileSync(path.join(output, "offline-fonts.json"), JSON.stringify({ browser: browser.version(), stylesheet, results }, null, 2) + "\n");
  console.log(JSON.stringify(results, null, 2));
  for (const result of results) {
    assert.deepEqual(result.externalRequests, [], `${result.protocol}: 仍请求外部字体服务`);
    assert.deepEqual(result.pageErrors, []);
    assert.deepEqual([...new Set(result.fontRequests)].sort(), ["JetBrainsMono-Medium.woff2", "JetBrainsMono-Regular.woff2"]);
    for (const weight of result.weights) {
      assert.equal(weight.faces, 1);
      assert.deepEqual(weight.statuses, ["loaded"]);
      assert.equal(weight.check, true);
    }
  }
} finally {
  await browser?.close();
  server.close();
  unlinkSync(fixture);
  rmdirSync(temporary);
}

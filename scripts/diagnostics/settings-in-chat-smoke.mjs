// 聊天窗内设置页冒烟（E2E）：主进程 inspector 驱动，验证「设置入口默认进聊天窗」链路。
//
// 流程：
//   1) electron . --inspect=<port>（file:// 产物模式，需要先 build:main/preload/renderer）
//      或 --exe <path> 直接跑打包版（release/win-unpacked/Cyrene.exe）
//   2) 监听 browser-window-created，收集渲染端 console error / render-process-gone
//   3) ipcMain.emit("sidebar:open-settings", {}, section) —— 等价状态栏「设置」按钮
//   4) 等聊天窗出现并渲染 settings 视图；逐 section 点击导航并校验关键文案
//   5) 截图到 --out 目录；验证界面字体 apply/reset；报告错误列表；退出应用
//
// 用法：
//   node scripts/diagnostics/settings-in-chat-smoke.mjs
//   node scripts/diagnostics/settings-in-chat-smoke.mjs --exe release/win-unpacked/Cyrene.exe
//   node scripts/diagnostics/settings-in-chat-smoke.mjs --out <dir> --keep-running
//
// 说明：userData 与打包版共用；若应用正在运行会因单实例锁直接退出——先关掉正在运行的 Cyrene。

import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const require = createRequire(import.meta.url);
const electronPath = require("electron");
const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const outDir = resolve(outIndex >= 0 ? (args[outIndex + 1] ?? join(ROOT, ".smoke-out")) : join(ROOT, ".smoke-out"));
const keepRunning = args.includes("--keep-running");
// --exe <path>：对打包版（release/win-unpacked/Cyrene.exe）做同样的 E2E（默认 dev: electron .）
const exeIndex = args.indexOf("--exe");
const packagedExe = exeIndex >= 0 ? resolve(args[exeIndex + 1] ?? "") : null;
const INSPECT_PORT = 9229;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function log(step, message) {
  console.log(`[smoke] ${step}: ${message}`);
}

async function waitFor(fn, { timeoutMs = 60_000, intervalMs = 500, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  throw new Error(`timeout waiting for ${label}${lastError ? ` (${lastError.message})` : ""}`);
}

async function main() {
  if (packagedExe) {
    if (!existsSync(packagedExe)) throw new Error(`打包版不存在：${packagedExe}`);
  } else if (!existsSync(join(ROOT, "dist", "renderer", "react", "index.html"))) {
    throw new Error("缺少 dist/renderer/react —— 先执行 npm run build");
  }
  mkdirSync(outDir, { recursive: true });

  const child = packagedExe
    ? spawn(packagedExe, [`--inspect=${INSPECT_PORT}`], { cwd: dirname(packagedExe), stdio: ["ignore", "pipe", "pipe"] })
    : spawn(electronPath, [`--inspect=${INSPECT_PORT}`, "."], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env } });
  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});
  child.on("exit", (code) => {
    if (code !== 0 && !stopped) console.error(`[smoke] electron exited early: code=${code}`);
  });

  function killTree() {
    if (child.exitCode !== null) return;
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      child.kill("SIGKILL");
    }
  }

  const started = Date.now();
  const fail = async (message) => {
    console.error(`[smoke] FAIL: ${message}`);
    if (!keepRunning) killTree();
    process.exit(1);
  };

  // ── CDP 连接（主进程 inspector） ──
  const target = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${INSPECT_PORT}/json/list`).catch(() => null);
    if (!response?.ok) return null;
    const list = await response.json();
    const main = list.find((item) => item.type === "node" || item.title?.includes("Electron"));
    return main?.webSocketDebuggerUrl ? main : null;
  }, { label: "main inspector target", timeoutMs: 30_000 });

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((done, reject) => {
    ws.addEventListener("open", done, { once: true });
    ws.addEventListener("error", () => reject(new Error("inspector websocket error")), { once: true });
  });

  let messageId = 0;
  const pending = new Map();
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  });
  const call = (method, params) => new Promise((done, reject) => {
    const id = ++messageId;
    pending.set(id, (message) => (message.error ? reject(new Error(JSON.stringify(message.error))) : done(message.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) {
      throw new Error(`eval failed: ${JSON.stringify(result.exceptionDetails).slice(0, 500)}`);
    }
    return result.result?.value;
  };
  await call("Runtime.enable", {});
  log("connect", `inspector ready in ${Date.now() - started}ms`);

  // ── 等待壳就绪（sidebar:open-settings 处理已注册） ──
  await waitFor(
    () => evaluate(`process.mainModule.require("electron").ipcMain.listenerCount("sidebar:open-settings") > 0`),
    { label: "sidebar:open-settings handler", timeoutMs: 60_000 },
  );

  // ── 等核心阶段就绪 ──
  // 真实入口（托盘/状态栏/原生侧栏）经 WindowActivationBroker 排队到 core-ready 才放行；
  // 本脚本直接 emit IPC 会绕过这道门，过早打开聊天窗会导致渲染端 bootstrap 撞上
  // 尚未注册的 chats IPC。桌宠窗在 core 阶段创建（晚于 chats IPC 注册）——用它当门；
  // 桌宠被关闭时退回固定等待。
  const petWindowSeen = await waitFor(
    () => evaluate(`(() => {
      const { BrowserWindow } = process.mainModule.require("electron");
      return BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.webContents.getURL().includes("/renderer/index.html"));
    })()`),
    { label: "core ready (pet window)", timeoutMs: 20_000, intervalMs: 300 },
  ).catch(() => null);
  if (!petWindowSeen) {
    log("core", "pet window not seen; waiting fixed grace period");
    await sleep(6_000);
  } else {
    log("core", "pet window present (core IPC registered)");
  }

  // ── 收集渲染端错误（窗口一创建就挂监听） ──
  await evaluate(`(() => {
    const { app } = process.mainModule.require("electron");
    globalThis.__smokeErrors = [];
    app.on("browser-window-created", (_event, win) => {
      win.webContents.on("console-message", (_e, level, message) => {
        if (level >= 2) globalThis.__smokeErrors.push("[" + win.id + "] " + message);
      });
      win.webContents.on("render-process-gone", () => globalThis.__smokeErrors.push("[" + win.id + "] render-process-gone"));
      win.webContents.on("did-fail-load", (_e, code, desc) => globalThis.__smokeErrors.push("[" + win.id + "] did-fail-load " + code + " " + desc));
    });
    return true;
  })()`);

  // ── 触发：等价状态栏「设置」按钮 → 应默认打开聊天窗内设置页 ──
  await evaluate(`process.mainModule.require("electron").ipcMain.emit("sidebar:open-settings", {}, "general")`);
  log("trigger", "sidebar:open-settings(general) emitted");

  const chatProbe = `(() => {
    const { BrowserWindow } = process.mainModule.require("electron");
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().includes("/react/"));
    return win ? win.id : 0;
  })()`;
  const chatId = await waitFor(() => evaluate(chatProbe), { label: "chat window", timeoutMs: 60_000 });
  log("chat", `chat window id=${chatId}`);
  const windowUrls = await evaluate(`(() => {
    const { BrowserWindow } = process.mainModule.require("electron");
    return BrowserWindow.getAllWindows().map((w) => w.id + " " + (w.isDestroyed() ? "destroyed" : w.webContents.getURL()));
  })()`);
  log("windows", JSON.stringify(windowUrls));

  const chatEval = (expression) => evaluate(`(async () => {
    const { BrowserWindow } = process.mainModule.require("electron");
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().includes("/react/"));
    if (!win) return null;
    return win.webContents.executeJavaScript(${JSON.stringify(expression)});
  })()`);

  try {
    await waitFor(() => chatEval(`!!document.querySelector(".cy-settings-page")`), { label: "settings page", timeoutMs: 60_000 });
  } catch (error) {
    const errors = await evaluate(`globalThis.__smokeErrors ?? []`).catch(() => []);
    console.error("[smoke] settings page timeout; renderer errors:", JSON.stringify(errors));
    throw error;
  }
  const navCount = await chatEval(`document.querySelectorAll(".cy-settings-nav-item").length`);
  log("settings", `settings view open, nav items=${navCount}`);

  // 已迁移的 section → 聊天窗内设置页导航标签（按中文界面断言）
  const sections = [
    { section: "general", expect: ["常规", "数据与存储", "便携模式", "缓存目录", "聊天记录", "Git 提交身份"] },
    { section: "appearance", expect: ["外观", "界面字体", "导入字体", "消息行距", "昔涟回复气泡"] },
    { section: "preferences", expect: ["偏好设置", "截图", "Snipaste"] },
    { section: "cyrene", expect: ["昔涟设置", "模型下载镜像", "打开模型目录", "安装说明", "下载模型"] },
    { section: "models", expect: ["模型设置"] },
    { section: "tools", expect: ["工具配置"] },
  ];

  const problems = [];
  for (const entry of sections) {
    await evaluate(`process.mainModule.require("electron").ipcMain.emit("sidebar:open-settings", {}, ${JSON.stringify(entry.section)})`);
    await sleep(600);
    const text = await chatEval(`document.querySelector(".cy-settings-content")?.innerText ?? ""`);
    const missing = entry.expect.filter((needle) => !text.includes(needle));
    if (missing.length > 0) {
      problems.push(`section ${entry.section} missing: ${missing.join(" / ")}`);
      log("section", `${entry.section} MISSING ${missing.join(" / ")}`);
    } else {
      log("section", `${entry.section} OK`);
    }
    const shot = join(outDir, `settings-${entry.section}.png`);
    await evaluate(`(async () => {
      const fs = process.mainModule.require("fs");
      const { BrowserWindow } = process.mainModule.require("electron");
      const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().includes("/react/"));
      if (!win) return false;
      const image = await win.webContents.capturePage();
      fs.writeFileSync(${JSON.stringify(shot)}, image.toPNG());
      return true;
    })()`);
    // 底部截图：滚动到内容末尾，确认卡片下半部分（数据与存储 / 模型操作等）
    await chatEval(`(() => { const el = document.querySelector(".cy-settings-content"); if (el) el.scrollTop = el.scrollHeight; return true; })()`);
    await sleep(250);
    const shotBottom = join(outDir, `settings-${entry.section}-bottom.png`);
    await evaluate(`(async () => {
      const fs = process.mainModule.require("fs");
      const { BrowserWindow } = process.mainModule.require("electron");
      const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().includes("/react/"));
      if (!win) return false;
      const image = await win.webContents.capturePage();
      fs.writeFileSync(${JSON.stringify(shotBottom)}, image.toPNG());
      return true;
    })()`);
    // 通用页：额外定位「数据与存储」卡片（便携模式 / 缓存目录）截图
    if (entry.section === "general") {
      await chatEval(`(() => {
        const heading = [...document.querySelectorAll(".cy-settings-section")].find((section) => section.textContent.includes("数据与存储"));
        heading?.scrollIntoView({ block: "start" });
        return true;
      })()`);
      await sleep(250);
      const shotStorage = join(outDir, "settings-general-storage.png");
      await evaluate(`(async () => {
        const fs = process.mainModule.require("fs");
        const { BrowserWindow } = process.mainModule.require("electron");
        const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().includes("/react/"));
        if (!win) return false;
        const image = await win.webContents.capturePage();
        fs.writeFileSync(${JSON.stringify(shotStorage)}, image.toPNG());
        return true;
      })()`);
    }
  }

  // 工具配置页：每个工具一张卡，卡片头部可折叠（文件卡恒可折叠，不依赖设置状态）
  const toolFold = await chatEval(`(() => {
    const cards = [...document.querySelectorAll(".cy-settings-tool-card")];
    const button = cards.map((card) => card.querySelector("button.cy-settings-tool-card__toggle")).find(Boolean);
    if (!button) return { cards: cards.length };
    const before = button.getAttribute("aria-expanded");
    button.click();
    const body = document.getElementById(button.getAttribute("aria-controls"));
    return { cards: cards.length, before, after: button.getAttribute("aria-expanded"), bodyHidden: body?.hidden ?? null };
  })()`);
  const toolFoldOk = toolFold?.cards >= 5 && toolFold.before === "true" && toolFold.after === "false" && toolFold.bodyHidden === true;
  log("toolFold", toolFoldOk ? "OK" : `FAILED ${JSON.stringify(toolFold)}`);
  if (!toolFoldOk) problems.push(`tools fold failed: ${JSON.stringify(toolFold)}`);

  // ── 界面字体应用（local-font + @font-face 动态注入）：验完恢复默认 ──
  const fontApplied = await chatEval(`(async () => {
    await window.settings.saveGeneral({ uiFont: { kind: "custom", fileName: "smoke-test-font.ttf", displayName: "Smoke Test" } });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const style = document.getElementById("cyrene-custom-font");
    return {
      dataset: document.documentElement.dataset.uiFont,
      css: style?.textContent ?? "",
      varValue: getComputedStyle(document.documentElement).getPropertyValue("--rb-font-ui"),
    };
  })()`);
  const fontOk = fontApplied?.dataset === "custom"
    && String(fontApplied.css).includes("local-font://smoke-test-font.ttf")
    && String(fontApplied.varValue).includes("Cyrene Custom Font");
  log("uiFont", fontOk ? "apply OK" : `apply FAILED ${JSON.stringify(fontApplied)}`);
  if (!fontOk) problems.push("uiFont apply failed");

  const fontReset = await chatEval(`(async () => {
    await window.settings.resetUiFont();
    await new Promise((resolve) => setTimeout(resolve, 200));
    return {
      dataset: document.documentElement.dataset.uiFont,
      style: Boolean(document.getElementById("cyrene-custom-font")),
    };
  })()`);
  const fontResetOk = fontReset?.dataset === "source-han" && fontReset.style === false;
  log("uiFont", fontResetOk ? "reset OK" : `reset FAILED ${JSON.stringify(fontReset)}`);
  if (!fontResetOk) problems.push("uiFont reset failed");

  const errors = await evaluate(`globalThis.__smokeErrors ?? []`);
  log("errors", `${errors.length}`);
  for (const line of errors.slice(0, 20)) console.log("  " + line);
  log("screens", outDir);

  if (!keepRunning) {
    await evaluate(`process.mainModule.require("electron").app.quit()`);
    await sleep(500);
  }

  if (problems.length > 0 || errors.length > 0) {
    console.error("[smoke] FAIL");
    for (const problem of problems) console.error("  " + problem);
    if (!keepRunning) killTree();
    process.exit(1);
  }
  console.log("[smoke] OK");
  killTree();
  process.exit(0);
}

let stopped = false;
process.on("exit", () => { stopped = true; });

main().catch((error) => {
  console.error("[smoke] crashed:", error);
  process.exit(1);
});

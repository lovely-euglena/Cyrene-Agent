#!/usr/bin/env node
/**
 * web 轨（pixi.js + pixi-live2d-display）确定性截帧（#257 T6 对照的 web 侧取帧器）。
 *
 * 用仓库自带 Electron 起一个与生产桌宠窗同规格的透明窗（400×500，
 * PET_RENDER_MAX_DPR=1 → 物理像素即 CSS 像素），加载 dist/renderer 桌宠页，
 * 模型就绪后冻结 ticker、参数回默认（或 --params 指定）、coreModel.update()
 * 渲一帧 → capturePage 落 PNG。与侧车 --render-test 的静态语义对齐：
 * 双方都不跑行为层（呼吸/眨眼/物理/注视），只比渲染管线。
 *
 * 前置：pnpm run build:renderer（dist/renderer 就位；无需 preload——
 * 桌宠页对 window.cyrene 有桩回退）。
 *
 * 用法（仓库根）：
 *   npx electron scripts/live2d/web-capture.mjs --out web.png
 *        [--params ParamAngleX=15,ParamEyeLOpen=0.5] [--no-freeze] [--wait 500]
 *
 * 退出码：0 成功 / 1 失败 / 2 前置缺失（dist/renderer）。
 */
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "../..");

function getArg(name, dflt = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : dflt;
}

const out = getArg("--out", path.join(require("node:os").tmpdir(), "cyrene-web-capture.png"));
const paramsSpec = getArg("--params");
const freeze = !process.argv.includes("--no-freeze");
const settleMs = Number(getArg("--wait", "500"));

const rendererIndex = path.join(REPO_ROOT, "dist", "renderer", "index.html");
if (!fs.existsSync(rendererIndex)) {
  console.error(`[web-capture] 缺 ${rendererIndex}（先 pnpm run build:renderer）`);
  app.exit(2);
}

/** 页内执行：冻结 + 参数回默认/指定 + 单帧渲染。返回诊断 JSON。 */
function freezeAndRenderScript(paramsSpec, freeze) {
  return `(() => {
    const m = window.__cyrene && window.__cyrene.manager;
    if (!m) return { error: "manager 未就绪" };
    const model = m.getModel();
    if (!model) return { error: "model 未就绪" };
    const cm = model.internalModel.coreModel;
    let paramsReset = 0;
    if (${freeze ? "true" : "false"}) {
      m.pause();
      const n = cm.getParameterCount();
      for (let i = 0; i < n; i++) {
        const d = typeof cm.getParameterDefaultValue === "function" ? cm.getParameterDefaultValue(i) : undefined;
        if (typeof d === "number") { cm.setParameterValueByIndex(i, d); paramsReset++; }
      }
    }
    const spec = ${JSON.stringify(paramsSpec || "")};
    const applied = [];
    if (spec) {
      for (const pair of spec.split(",").filter(Boolean)) {
        const eq = pair.indexOf("=");
        if (eq <= 0) continue;
        const id = pair.slice(0, eq).trim();
        const v = Number(pair.slice(eq + 1));
        cm.setParameterValueById(id, v);
        applied.push(id);
      }
    }
    cm.update();
    m.app.renderer.render(m.app.stage);
    return { frozen: ${freeze ? "true" : "false"}, paramsReset, applied };
  })()`;
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 400,
    height: 500,
    transparent: true,
    frame: false,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  try {
    await win.loadFile(rendererIndex);
    // 等模型就绪（onLoad 挂 window.__cyrene）
    const deadline = Date.now() + 60_000;
    let ready = false;
    while (Date.now() < deadline) {
      ready = await win.webContents.executeJavaScript(
        "Boolean(window.__cyrene && window.__cyrene.manager && window.__cyrene.manager.getModel())",
      );
      if (ready) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!ready) throw new Error("模型加载超时（60s）");

    const diag = await win.webContents.executeJavaScript(freezeAndRenderScript(paramsSpec, freeze));
    if (diag && diag.error) throw new Error(diag.error);
    await new Promise((r) => setTimeout(r, settleMs));
    if (freeze) {
      // 冻结后再渲一帧，确保呈现的是冻结态
      await win.webContents.executeJavaScript(
        "(() => { const m = window.__cyrene.manager; m.app.renderer.render(m.app.stage); return true; })()",
      );
    }
    const image = await win.webContents.capturePage();
    const size = image.getSize();
    fs.writeFileSync(out, image.toPNG());
    console.log(JSON.stringify({ out: path.resolve(out), width: size.width, height: size.height, ...diag }));
    console.error("WEB_CAPTURE_OK");
    app.exit(0);
  } catch (err) {
    console.error(`[web-capture] 失败: ${err.message}`);
    app.exit(1);
  }
});

app.on("window-all-closed", () => app.quit());

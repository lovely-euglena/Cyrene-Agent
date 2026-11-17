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
      // Live2DModel._render 在 deltaTime≠0 时会调 internalModel.update——
      // 行为层（注视/呼吸/物理）写参数→csmUpdateModel→loadParameters 恢复参数值，
      // 造成「参数=默认、顶点=行为态」的隐蔽污染。清零残留 deltaTime 杜绝之。
      model.deltaTime = 0;
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
    // 裸 core update（保留 VertexPositionsDidChange 脏标志）——cm.update() 会
    // resetDynamicFlags，使 pld 跳过蒙版重绘、终帧沿用冻结前的陈旧蒙版 FBO。
    cm._model.update();
    m.app.renderer.render(m.app.stage);
    const cv = document.getElementById("live2d-canvas");
    const r = m.app && m.app.renderer;
    return {
      frozen: ${freeze ? "true" : "false"}, paramsReset, applied,
      renderer: r ? String(r.type ?? r.constructor.name) : null,
      gl: Boolean(r && r.gl),
      canvas: cv ? [cv.width, cv.height, cv.clientWidth, cv.clientHeight] : null,
      stageChildren: m.app && m.app.stage ? m.app.stage.children.length : -1,
      model: { visible: model.visible, alpha: model.worldAlpha, x: model.x, y: model.y, scale: model.scale.x, w: model.width, h: model.height },
      bodyBg: getComputedStyle(document.body).backgroundColor,
      coreVer: (() => { try { const C = window.Live2DCubismCore; return C.Version.csmGetVersion(); } catch (e) { return String(e); } })(),
      params: (() => { const n = cm.getParameterCount(); const ids = cm._model.parameters.ids; const arr = []; for (let i = 0; i < n; i++) arr.push(ids[i] + "=" + cm.getParameterValueByIndex(i)); return arr; })(),
    };
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
  win.webContents.on("console-message", (_e, _level, message) => console.error("[page]", message));
  try {
    await win.loadFile(rendererIndex);
    await win.webContents.executeJavaScript(
      "window.addEventListener('error', (e) => console.error('[pageerr]', e.message, e.error && e.error.stack ? e.error.stack.split('\\n').slice(0, 6).join(' | ') : '')); true",
    );
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
        "(() => { const m = window.__cyrene.manager; m.getModel().deltaTime = 0; m.app.renderer.render(m.app.stage); return true; })()",
      );
    }
    let pngBuf, width, height;
    if (process.argv.includes("--extract")) {
      // 软件 GL（--disable-gpu）下 capturePage 不合成 WebGL 层（得全透明帧）。
      // 改读回 GL framebuffer：render+readPixels 同任务，drawing buffer 有效。
      // pixi context 为 premultipliedAlpha，readPixels 得预乘 RGBA——与侧车
      // 「预乘 BGRA 原样落 PNG」（PngCodec）语义一致，无需 un-premultiply。
      const raw = await win.webContents.executeJavaScript(`(() => {
        const m = window.__cyrene.manager;
        m.getModel().deltaTime = 0;
        const r = m.app.renderer;
        r.render(m.app.stage);
        const gl = r.gl;
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
        const px = new Uint8Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
        let bin = "";
        for (let i = 0; i < px.length; i += 0x8000) bin += String.fromCharCode.apply(null, px.subarray(i, i + 0x8000));
        return { w, h, b64: btoa(bin) };
      })()`);
      const src = Buffer.from(raw.b64, "base64");
      const rgba = new Uint8Array(raw.w * raw.h * 4);
      // GL 原点左下 → 顶行序翻转
      for (let y = 0; y < raw.h; y++) src.copy(rgba, y * raw.w * 4, (raw.h - 1 - y) * raw.w * 4, (raw.h - y) * raw.w * 4);
      const { encodePng } = await import("./pixel-diff.mjs");
      pngBuf = encodePng(raw.w, raw.h, rgba);
      width = raw.w; height = raw.h;
    } else {
      const image = await win.webContents.capturePage();
      const size = image.getSize();
      pngBuf = image.toPNG();
      width = size.width; height = size.height;
    }
    fs.writeFileSync(out, pngBuf);
    console.log(JSON.stringify({ out: path.resolve(out), width, height, ...diag }));
    console.error("WEB_CAPTURE_OK");
    app.exit(0);
  } catch (err) {
    console.error(`[web-capture] 失败: ${err.message}`);
    app.exit(1);
  }
});

app.on("window-all-closed", () => app.quit());

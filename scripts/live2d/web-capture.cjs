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
 *   npx electron scripts/live2d/web-capture.cjs --out web.png
 *        [--params ParamAngleX=15,ParamEyeLOpen=0.5] [--no-freeze] [--wait 500]
 *
 * 动作/表情探针模式（与 sidecar-capture --warmup/--play/--ticks 对齐）：
 *   npx electron scripts/live2d/web-capture.cjs --play=motion:动作#6:Wink~ \
 *        --warmup=60 --ticks=30 --extract --out=web.png
 *   ⚠️ 带值参数必须用等号形态：Chromium 把「空格分隔的含冒号值 + 后续空格
 *   分隔开关」误判为 URL 参数组合，app 加载前即退出 -1（实测）。
 *   t=0 重置（参数回默认/elapsedTime/breath 时钟清零）→ warmup 帧 → playAction
 *   （生产路径）→ 确定性推进 ticks 帧 → readPixels 取帧。pld 动作/表情时间基
 *   = elapsedTime 累积（startMotion 的 performance.now() 参数被忽略，startTime
 *   首次 update 惰性设定）→ 与侧车 _nowMs tick 累积同序。眨眼用晚注册
 *   beforeModelUpdate 钩子强制 eyes=1 中和（侧车首眨 >=2500ms，总虚拟时长
 *   (warmup+ticks)×16.67ms 须 <2500ms 保证双轨同态）。
 *   探针侧两处 web 轨潜在 bug 绕行（不改生产代码，#266 / #267）：
 *   ① motion 文件名含 # 被 file:// XHR 当 URL fragment → resolveURL 补丁编码 %23；
 *   ② manager.playAction 的 motionIndexMap 读 json.Motions（实际在
 *      FileReferences.Motions）恒空 → 直驱 model.motion(group,index)。
 *
 * 退出码：0 成功 / 1 失败 / 2 前置缺失（dist/renderer）。
 */
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "../..");

function getArg(name, dflt = null) {
  const i = process.argv.indexOf(name);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  // 等号形态（--play=motion:组:名）：Chromium 命令行把「空格分隔的含冒号值 +
  // 后续空格分隔开关」误判为 URL 参数组合 → 加载 app 前退出 -1（实测）。
  // 探针一律用等号形态传带值参数（冒号值安全）。
  const eq = process.argv.find((a) => a.startsWith(name + "="));
  return eq ? eq.slice(name.length + 1) : dflt;
}

const out = getArg("--out", path.join(require("node:os").tmpdir(), "cyrene-web-capture.png"));
const paramsSpec = getArg("--params");
const freeze = !process.argv.includes("--no-freeze");
const settleMs = Number(getArg("--wait", "500"));
const playSpec = getArg("--play");
const warmupTicks = Number(getArg("--warmup", "60"));
const driveTicks = Number(getArg("--ticks", "0"));
const driveMode = Boolean(playSpec);

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
      glRenderer: (() => { try { const gl = r.gl; const ext = gl.getExtension("WEBGL_debug_renderer_info"); return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); } catch (e) { return String(e); } })(),
      canvas: cv ? [cv.width, cv.height, cv.clientWidth, cv.clientHeight] : null,
      stageChildren: m.app && m.app.stage ? m.app.stage.children.length : -1,
      model: { visible: model.visible, alpha: model.worldAlpha, x: model.x, y: model.y, scale: model.scale.x, w: model.width, h: model.height },
      bodyBg: getComputedStyle(document.body).backgroundColor,
      coreVer: (() => { try { const C = window.Live2DCubismCore; return C.Version.csmGetVersion(); } catch (e) { return String(e); } })(),
      params: (() => { const n = cm.getParameterCount(); const ids = cm._model.parameters.ids; const arr = []; for (let i = 0; i < n; i++) arr.push(ids[i] + "=" + cm.getParameterValueByIndex(i)); return arr; })(),
    };
  })()`;
}

/** 解析 --play expression:NAME / motion:GROUP:NAME（与 sidecar-capture 同语义）。 */
function parsePlayTarget(spec) {
  const [kind, ...rest] = spec.split(":");
  return kind === "expression"
    ? { kind: "expression", name: rest.join(":") }
    : { kind: "motion", group: rest[0], motionName: rest.slice(1).join(":") };
}

/**
 * 动作/表情探针：t=0 重置 → warmup → playAction（生产路径）→ 确定性推进 → 诊断。
 * 与侧车 load→warmup ticks→play→ticks 逐帧同序（dt=1000/60ms）。
 */
async function driveMotion(win, spec, warmup, ticks) {
  const setup = await win.webContents.executeJavaScript(`(async () => {
    const m = window.__cyrene && window.__cyrene.manager;
    if (!m) return { error: "manager 未就绪" };
    const model = m.getModel();
    if (!model) return { error: "model 未就绪" };
    const cm = model.internalModel.coreModel;
    m.pause();
    // 探针侧 URL 修复（不改生产代码）：motion 文件名含 #（动作#6_*.motion3.json）
    // 被 file:// XHR 解析为 URL fragment → 路径截断 Status 0。web 轨生产同病
    // （潜在 bug，#266）；dotnet 磁盘读取不受影响。编码 # 使双轨可比。
    const settings = model.internalModel.settings;
    if (!settings.__probeResolvePatched) {
      const orig = settings.resolveURL.bind(settings);
      settings.resolveURL = (u) => orig(String(u).replace(/#/g, "%23"));
      settings.__probeResolvePatched = true;
    }
    model.deltaTime = 0;
    model.elapsedTime = 0;
    const breath = model.internalModel.breath;
    if (breath) breath._currentTime = 0;
    // 物理初态归零：加载后自动 ticker 已走数帧，激发了 delay=1 的无阻尼自由
    // 粒子（头发/双腿/秋千），初态相位差会永久保留。重建 physics rig 回静止
    // 初态，与侧车 load 即静止同起点（探针确定性对齐，非引擎差异）。
    // settings.physics 是路径字符串（pld 不保留原始 JSON）→ 重 fetch。
    const phys = model.internalModel.physics;
    if (phys && phys.constructor && typeof phys.constructor.create === "function") {
      const purl = model.internalModel.settings.resolveURL(model.internalModel.settings.physics);
      const pj = await fetch(purl).then((r) => r.json());
      model.internalModel.physics = phys.constructor.create(pj);
    }
    const n = cm.getParameterCount();
    let paramsReset = 0;
    for (let i = 0; i < n; i++) {
      const d = typeof cm.getParameterDefaultValue === "function" ? cm.getParameterDefaultValue(i) : undefined;
      if (typeof d === "number") { cm.setParameterValueByIndex(i, d); paramsReset++; }
    }
    // 晚于 BlinkController 注册 → 帧末覆盖眼参数（中和随机眨眼；侧车虚拟 t<2500ms 恒 eyes=1）
    if (!window.__probeEyesHook) {
      window.__probeEyesHook = () => {
        cm.setParameterValueById("ParamEyeLOpen", 1);
        cm.setParameterValueById("ParamEyeROpen", 1);
        // 中帧参数 stash（全部写入完成、coreModel.update/loadParameters 前）
        const ids = cm._model.parameters.ids;
        const arr = [];
        for (let i = 0; i < cm.getParameterCount(); i++) arr.push(ids[i] + "=" + cm.getParameterValueByIndex(i));
        window.__probeMidParams = arr;
      };
      model.internalModel.on("beforeModelUpdate", window.__probeEyesHook);
    }
    const dt = 1000 / 60;
    for (let i = 0; i < ${warmup}; i++) { model.update(dt); m.app.renderer.render(m.app.stage); }
    return { paramsReset, warmup: ${warmup}, elapsedTime: model.elapsedTime, breathTime: breath ? breath._currentTime : null };
  })()`);
  if (setup && setup.error) throw new Error(setup.error);

  const target = parsePlayTarget(spec);
  const playState = await win.webContents.executeJavaScript(`(async () => {
    const m = window.__cyrene.manager;
    const model = m.getModel();
    const mm = model.internalModel.motionManager;
    const target = ${JSON.stringify(target)};
    let played = false;
    if (target.kind === "motion") {
      // 探针直驱 model.motion(group,index)（pld 生产动作管线：状态机+队列）。
      // 不走 manager.playAction：web 轨 motionIndexMap 读 json.Motions（实际在
      // FileReferences.Motions）恒空 → 动作目标全落 expression 回退、真动作永不
      // 播放（潜在 bug，#267；dotnet 轨解析正确）。索引从 mm.definitions
      // （pld CubismModelSettingsJson 正确解析）取，与 dotnet FindMotionIndex 同序。
      const defs = mm.definitions[target.group] || [];
      const index = defs.findIndex((d) => d && d.Name === target.motionName);
      if (index >= 0) played = await model.motion(target.group, index);
    } else {
      played = await model.expression(target.name);
    }
    return {
      played,
      playing: mm.playing,
      motionQueue: mm.queueManager ? mm.queueManager._motions.length : -1,
      expressionQueue: mm.expressionManager && mm.expressionManager.queueManager ? mm.expressionManager.queueManager._motions.length : -1,
    };
  })()`);
  const queued = target.kind === "expression" ? playState.expressionQueue > 0 : playState.motionQueue > 0;
  if (!queued) throw new Error(`play 未入队: ${spec} ${JSON.stringify(playState)}`);

  const drive = await win.webContents.executeJavaScript(`(() => {
    const m = window.__cyrene.manager;
    const model = m.getModel();
    const dt = 1000 / 60;
    for (let i = 0; i < ${ticks}; i++) { model.update(dt); m.app.renderer.render(m.app.stage); }
    const cm = model.internalModel.coreModel;
    const ids = cm._model.parameters.ids;
    const params = [];
    for (let i = 0; i < cm.getParameterCount(); i++) params.push(ids[i] + "=" + cm.getParameterValueByIndex(i));
    const fc = model.internalModel.focusController;
    return { ticks: ${ticks}, elapsedTime: model.elapsedTime, playing: model.internalModel.motionManager.playing, params, midParams: window.__probeMidParams || null,
      focus: { tx: fc.targetX, ty: fc.targetY, x: fc.x, y: fc.y } };
  })()`);
  return { mode: "drive", play: spec, setup, playState, ...drive };
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

    let diag;
    if (driveMode) {
      diag = await driveMotion(win, playSpec, warmupTicks, driveTicks);
    } else {
      diag = await win.webContents.executeJavaScript(freezeAndRenderScript(paramsSpec, freeze));
      if (diag && diag.error) throw new Error(diag.error);
      await new Promise((r) => setTimeout(r, settleMs));
      if (freeze) {
        // 冻结后再渲一帧，确保呈现的是冻结态
        await win.webContents.executeJavaScript(
          "(() => { const m = window.__cyrene.manager; m.getModel().deltaTime = 0; m.app.renderer.render(m.app.stage); return true; })()",
        );
      }
    }
    let pngBuf, width, height;
    if (process.argv.includes("--extract") || driveMode) {
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

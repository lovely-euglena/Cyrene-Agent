#!/usr/bin/env node
/**
 * #257 动作态双轨探针：不同动作/表情下 web vs dotnet 逐像素对照。
 *
 * T6 静态基准帧口径的增量：双方跑同一动作/表情、同一确定性时间轴——
 *   load → t=0 重置 → warmup 60 帧 → play → 推进 M 帧 → 截帧 → diff。
 *   play 为探针直驱 model.motion/model.expression（绕 manager.playAction——
 *   web 轨 buildMotionIndexMap 恒空 #267 的探针绕行；生产路径不变，见设计稿 §9）。
 *
 * 确定性对齐依据（pld 源码实证，见 web-capture.cjs 头注）：
 *   - pld 动作/表情时间基 = Live2DModel.elapsedTime（dt 累积）；startMotion 的
 *     performance.now() 参数被忽略，startTime 首次 update 惰性设定 → 与侧车
 *     _nowMs tick 累积逐帧同序（dt=1000/60ms）。
 *   - 眨眼：web BlinkController 用 Math.random（跨轨不可复现）→ 晚注册
 *     beforeModelUpdate 钩子强制 eyes=1；侧车首眨间隔 >=2500ms，故总虚拟时长
 *     (warmup+M)×16.67ms 上限 2334ms（M<=80）保证双轨 eyes=1 同态。
 *   - 物理/pose 初态：web 加载后自动 ticker 已走数帧 → warmup 60 帧阻尼衰减
 *     （~0.9^60≈0.002）；呼吸时钟 web 显式清零、侧车从 0 起 → 相位同步。
 *   - 注视：双轨 load 即 focusCenter(instant) → onLoad 怪癖同移植：首帧前
 *     worldTransform 仍单位矩阵 → 窗口中心按画布尺寸归一化得固定偏心目标
 *     (-0.726, 0.688)（非 (1,0)；MapWindowPointAtLoad，见设计稿 §9）。
 *
 * 矩阵：5 个真实 motion3 动作 × 4 时刻（0.25/0.5/1.0/1.33s into motion）
 *       + 4 个代表表情 × 2 时刻（fade 完成 0.5s / 稳态 1.33s）= 28 对。
 *
 * 用法（仓库根）：
 *   $env:CYRENE_CUBISM_CORE_DLL = "<Core r.4 dll>"   # 必需（许可闸门：不程序化下载）
 *   node scripts/live2d/motion-probe.mjs [--only Wink] [--skip-log] [--out-dir <dir>]
 *
 * 每对经 eval-log.mjs --diff 落盘 JSONL（result 取 pixel-diff 退出码、
 * diff_pct 取脚本输出）；汇总写 docs/eval/257-motion-probe-summary.json。
 * 退出码：0 全 pass / 1 有 fail 或截帧失败 / 2 前置缺失。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");
const WARMUP = 60;
const DT_MS = 1000 / 60;

const MATRIX = [
  // 真实 motion3 动作（Meta.Loop 被双轨一致忽略：播一次即止）
  { spec: "motion:动作#6:动作回正", ticks: [15, 30, 60, 80] }, // 0.5s 短动作：含 fade-out/回正
  { spec: "motion:动作#6:Wink~", ticks: [15, 30, 60, 80] }, // 3s
  { spec: "motion:动作#6:我可爱吧~", ticks: [15, 30, 60, 80] }, // 4s
  { spec: "motion:动作#6:笑一笑吧~", ticks: [15, 30, 60, 80] }, // 3s
  { spec: "motion:Tick3:荡秋千（待机）", ticks: [15, 30, 60, 80] }, // 60.333s 秋千早期
  // 代表表情（不同参数域 + fade 0.3/0.5s）
  { spec: "expression:墨镜", ticks: [30, 80] }, // Param4
  { spec: "expression:圈圈眼", ticks: [30, 80] }, // Param2
  { spec: "expression:星星眼", ticks: [30, 80] }, // Param
  { spec: "expression:拽秋千1", ticks: [30, 80] }, // Param32=-0.6
];

function getArg(name, dflt = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : dflt;
}

function resolveElectron() {
  if (process.env.CYRENE_ELECTRON_EXE && fs.existsSync(process.env.CYRENE_ELECTRON_EXE)) {
    return process.env.CYRENE_ELECTRON_EXE;
  }
  // 仅仓库相对查找（跨平台约定）：本仓未装 electron 时 set CYRENE_ELECTRON_EXE 指向任意 Electron 二进制
  const p = path.join(REPO_ROOT, "node_modules", "electron", "dist", "electron.exe");
  return fs.existsSync(p) ? p : null;
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: REPO_ROOT, encoding: "utf8", timeout: 180_000, ...opts });
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: r.error };
}

function lastJsonLine(text) {
  const trimmed = text.trim();
  try { return JSON.parse(trimmed); } catch { /* pixel-diff 输出多行美化 JSON */ }
  const lines = trimmed.split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try { return JSON.parse(lines[i]); } catch { /* 继续向上找 */ }
  }
  return null;
}

function main() {
  const only = getArg("--only");
  const skipLog = process.argv.includes("--skip-log");
  const outDir = getArg("--out-dir", path.join(os.tmpdir(), "cyrene-motion-probe"));
  const summaryPath = getArg("--summary", path.join(REPO_ROOT, "docs", "eval", "257-motion-probe-summary.json"));
  fs.mkdirSync(outDir, { recursive: true });

  const coreDll = process.env.CYRENE_CUBISM_CORE_DLL;
  if (!coreDll || !fs.existsSync(coreDll)) {
    console.error("[probe] 需 env CYRENE_CUBISM_CORE_DLL 指向 Core r.4 DLL（许可闸门：探针不程序化下载）");
    process.exit(2);
  }
  const electron = resolveElectron();
  if (!electron) {
    console.error("[probe] 未找到 electron.exe（env CYRENE_ELECTRON_EXE 或 node_modules/electron）");
    process.exit(2);
  }
  if (!fs.existsSync(path.join(REPO_ROOT, "dist", "renderer", "index.html"))) {
    console.error("[probe] 缺 dist/renderer（先 pnpm run build:renderer）");
    process.exit(2);
  }

  const sidecarScript = path.join(HERE, "sidecar-capture.mjs");
  const webScript = path.join(HERE, "web-capture.cjs");
  const evalLog = path.join(HERE, "eval-log.mjs");
  const modelDir = path.join(REPO_ROOT, "src", "renderer", "public", "models", "cyrene");

  const rows = [];
  let failures = 0;
  for (const entry of MATRIX) {
    if (only && !entry.spec.includes(only)) continue;
    for (const ticks of entry.ticks) {
      const tag = `${entry.spec}@${ticks}`.replace(/[^\w\u4e00-\u9fff@.-]/g, "_");
      const webPng = path.join(outDir, `web-${tag}.png`);
      const dotnetPng = path.join(outDir, `dotnet-${tag}.png`);
      const virtualMs = Math.round((WARMUP + ticks) * DT_MS);
      const row = { spec: entry.spec, warmup: WARMUP, ticks, virtualMs };
      console.error(`\n[probe] === ${entry.spec} warmup=${WARMUP} ticks=${ticks} (virtual ${virtualMs}ms) ===`);

      const sc = run(process.execPath, [
        sidecarScript, "--model-dir", modelDir,
        "--warmup", String(WARMUP), "--play", entry.spec, "--ticks", String(ticks),
        "--out", dotnetPng,
      ], { env: { ...process.env, CYRENE_CUBISM_CORE_DLL: coreDll } });
      // 等号形态：Chromium 对「空格分隔冒号值 + 后续空格开关」误判 URL → 启动即退 -1
      const web = run(electron, [
        webScript, "--no-sandbox", "--disable-gpu", "--enable-unsafe-swiftshader",
        "--force-device-scale-factor=1",
        "--play=" + entry.spec, "--warmup=" + WARMUP, "--ticks=" + ticks,
        "--extract", "--out=" + webPng,
      ]);
      row.sidecarExit = sc.code;
      row.webExit = web.code;
      const scJson = lastJsonLine(sc.stdout);
      const webJson = lastJsonLine(web.stdout);
      if (scJson) row.sidecar = { width: scJson.width, height: scJson.height };
      if (webJson) {
        row.web = {
          width: webJson.width, height: webJson.height,
          elapsedTime: webJson.elapsedTime, playing: webJson.playing,
          playState: webJson.playState,
        };
      }
      if (sc.code !== 0 || web.code !== 0 || !fs.existsSync(webPng) || !fs.existsSync(dotnetPng)) {
        row.result = "capture-fail";
        row.error = (sc.code !== 0 ? `sidecar exit=${sc.code}: ${sc.stderr.slice(-300)} | ` : "")
          + (web.code !== 0 ? `web exit=${web.code}: ${web.stderr.slice(-300)}` : "");
        failures++;
        rows.push(row);
        console.error(`[probe] CAPTURE-FAIL ${row.error}`);
        continue;
      }

      if (skipLog) {
        const pd = run(process.execPath, [path.join(HERE, "pixel-diff.mjs"), webPng, dotnetPng]);
        const pj = lastJsonLine(pd.stdout);
        row.result = pd.code === 0 ? "pass" : "fail";
        row.diff_pct = pj ? pj.diff_pct : null;
      } else {
        const note = `动作态探针 ${entry.spec} warmup=${WARMUP} ticks=${ticks} 虚拟${virtualMs}ms（软件适配器同口径）`;
        // 审核 #1416 P1-4：target = 可直接粘贴执行的完整命令（旧轮次为本地绝对
        // 路径 png 对，不可复现；历史行保留，见 docs/eval/257-live2d.jsonl 口径注记）
        const target = `node scripts/live2d/motion-probe.mjs --only ${JSON.stringify(entry.spec)}`;
        const el = run(process.execPath, [
          evalLog, "--task", "T6", "--action", "diff", "--note", note,
          "--target", target,
          "--diff", webPng, dotnetPng,
        ]);
        const ej = lastJsonLine(el.stdout);
        row.result = ej ? ej.result : (el.code === 0 ? "pass" : "fail");
        row.diff_pct = ej ? ej.diff_pct : null;
      }
      if (row.result !== "pass") failures++;
      rows.push(row);
      console.error(`[probe] ${row.result} diff_pct=${row.diff_pct}`);
    }
  }

  const summary = {
    ts: new Date().toISOString(),
    task: "#257 T6 动作态探针",
    protocol: { warmup: WARMUP, dtMs: DT_MS, blinkNeutralized: true, adapter: "software（web SwiftShader / dotnet WARP）" },
    total: rows.length,
    pass: rows.filter((r) => r.result === "pass").length,
    fail: rows.filter((r) => r.result !== "pass").length,
    maxDiffPct: Math.max(0, ...rows.map((r) => r.diff_pct ?? 0)),
    rows,
  };
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify({ summary: summaryPath, total: summary.total, pass: summary.pass, fail: summary.fail, maxDiffPct: summary.maxDiffPct }, null, 2));
  for (const r of rows) {
    console.log(`${r.result === "pass" ? "PASS" : "FAIL"}  ${String(r.diff_pct ?? "-").padStart(8)}  ${r.spec}  ticks=${r.ticks}`);
  }
  process.exit(failures > 0 ? 1 : 0);
}

main();
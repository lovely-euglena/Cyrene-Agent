#!/usr/bin/env node
/**
 * Live2D sidecar 确定性截帧驱动（#257 T6 对照的 dotnet 侧取帧器）。
 *
 * 走与 Electron 主进程完全相同的 JSON 行协议（load/setBounds/setZoom/
 * setParameter/play/tick/captureFrame/getDiagnostics/shutdown），保证
 * 对照帧与生产路径同管线。web 侧对照帧用 Electron capturePage（400×500，
 * PET_RENDER_MAX_DPR=1）截取后，交 pixel-diff.mjs 计算 diff_pct。
 *
 * 用法：
 *   node scripts/live2d/sidecar-capture.mjs --model-dir <dir> --out frame.png
 *        [--exe <path>] [--data-dir <dir>] [--width 400 --height 500] [--zoom 1]
 *        [--params ParamAngleX=10,ParamEyeLOpen=0.5] [--play expression:墨镜]
 *        [--ticks 60] [--diag-only]
 *
 *   --ticks N     确定性推进 N 帧（每帧 dt=1000/60ms），再截帧
 *   --diag-only   只 load/tick/getDiagnostics（无渲染，无 GPU 环境可跑通协议链路）
 *   --exe         缺省自动找 publish/构建输出（与 live2d-host-client 同序）
 *
 * Core DLL：env CYRENE_CUBISM_CORE_DLL / --data-dir 自动下载 / 模型目录自备。
 * 退出码：0 成功 / 1 协议或渲染失败 / 2 前置缺失（exe/模型）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");
const LOAD_TIMEOUT_MS = 10 * 60_000;
const OP_TIMEOUT_MS = 15_000;

function getArg(argv, name, dflt = null) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt;
}

function resolveExe(explicit) {
  if (explicit) return fs.existsSync(explicit) ? explicit : null;
  const devRoot = path.join(REPO_ROOT, "dotnet", "live2d", "CyreneLive2D", "bin", "Release", "net10.0-windows");
  for (const p of [
    path.join(devRoot, "win-x64", "publish", "cyrene-live2d.exe"),
    path.join(devRoot, "cyrene-live2d.exe"),
  ]) if (fs.existsSync(p)) return p;
  return null;
}

class Driver {
  constructor(exe, dataDir) {
    this.seq = 0;
    this.pending = new Map();
    this.proc = spawn(exe, dataDir ? ["--data-dir", dataDir] : [], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.proc.stderr.on("data", (d) => process.stderr.write(`[sidecar] ${d}`));
    this.ready = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    const timer = setTimeout(() => this.readyReject(new Error("ready 超时（15s）")), 15_000);
    this.ready.then(() => clearTimeout(timer), () => clearTimeout(timer));
    this.rl = readline.createInterface({ input: this.proc.stdout });
    this.rl.on("line", (line) => this.onLine(line));
    this.proc.on("exit", (code) => {
      for (const [, p] of this.pending) p.reject(new Error(`侧车提前退出 code=${code}`));
      this.pending.clear();
      this.readyReject(new Error(`侧车提前退出 code=${code}`));
    });
  }

  onLine(line) {
    let frame;
    try { frame = JSON.parse(line); } catch { return; }
    if (frame.op === "ready") { this.readyResolve(); return; }
    if (frame.op === "event") {
      process.stderr.write(`[sidecar event] ${frame.name} ${JSON.stringify(frame.payload ?? {})}\n`);
      return;
    }
    if (frame.op === "result") {
      const p = this.pending.get(frame.callId);
      if (!p) return;
      this.pending.delete(frame.callId);
      clearTimeout(p.timer);
      if (frame.ok) p.resolve(frame.data ?? {});
      else {
        const err = new Error(frame.error ?? "未知错误");
        err.errorCode = frame.errorCode;
        p.reject(err);
      }
    }
  }

  call(op, args = {}, timeoutMs = OP_TIMEOUT_MS) {
    const callId = `d${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(callId);
        reject(new Error(`${op} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      this.pending.set(callId, { resolve, reject, timer });
      this.proc.stdin.write(JSON.stringify({ op, callId, ...args }) + "\n");
    });
  }

  async shutdown() {
    try { await this.call("shutdown", {}, 5_000); } catch { /* 已退出 */ }
    this.proc.kill();
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const exe = resolveExe(getArg(argv, "--exe"));
  if (!exe) {
    console.error("[capture] 未找到 cyrene-live2d.exe（先 pnpm run build:live2d，或 --exe 指定）");
    process.exit(2);
  }
  const modelDir = getArg(argv, "--model-dir", path.join(REPO_ROOT, "src", "renderer", "public", "models", "cyrene"));
  const manifest = path.join(modelDir, "Cyrene.model3.json");
  if (!fs.existsSync(manifest)) {
    console.error(`[capture] 缺模型清单: ${manifest}`);
    process.exit(2);
  }
  const out = getArg(argv, "--out", path.join(os.tmpdir(), "cyrene-live2d-capture.png"));
  const width = Number(getArg(argv, "--width", "400"));
  const height = Number(getArg(argv, "--height", "500"));
  const zoom = Number(getArg(argv, "--zoom", "1"));
  const ticks = Number(getArg(argv, "--ticks", "0"));
  const diagOnly = argv.includes("--diag-only");
  const paramsSpec = getArg(argv, "--params");
  const playSpec = getArg(argv, "--play");

  const driver = new Driver(exe, getArg(argv, "--data-dir"));
  let exitCode = 0;
  try {
    await driver.ready;
    const loaded = await driver.call("load", { modelPath: manifest }, LOAD_TIMEOUT_MS);
    console.error(`[capture] loaded core=${loaded.coreVersion} params=${loaded.parameters} drawables=${loaded.drawables}`);
    await driver.call("setBounds", { x: 0, y: 0, width, height });
    await driver.call("setZoom", { zoom });

    if (paramsSpec) {
      for (const pair of paramsSpec.split(",").filter(Boolean)) {
        const eq = pair.indexOf("=");
        if (eq <= 0) continue;
        await driver.call("setParameter", { id: pair.slice(0, eq).trim(), value: Number(pair.slice(eq + 1)) });
      }
    }
    if (playSpec) {
      const [kind, ...rest] = playSpec.split(":");
      const target = kind === "expression"
        ? { kind: "expression", name: rest.join(":") }
        : { kind: "motion", group: rest[0], motionName: rest.slice(1).join(":") };
      await driver.call("play", { target });
    }
    for (let i = 0; i < ticks; i++) await driver.call("tick", { dtMs: 1000 / 60 });

    if (diagOnly) {
      const diag = await driver.call("getDiagnostics");
      console.log(JSON.stringify(diag, null, 2));
    } else {
      const frame = await driver.call("captureFrame", { width, height }, 60_000);
      fs.writeFileSync(out, Buffer.from(frame.png, "base64"));
      console.log(JSON.stringify({ out: path.resolve(out), width: frame.width, height: frame.height, ticks }));
    }
    console.error("CAPTURE_OK");
  } catch (err) {
    console.error(`[capture] 失败: ${err.message}${err.errorCode ? ` (${err.errorCode})` : ""}`);
    exitCode = 1;
  } finally {
    await driver.shutdown();
  }
  process.exit(exitCode);
}

main();

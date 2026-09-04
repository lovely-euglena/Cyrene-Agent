// sidecar / worker 内存占用测量：
//   1. spawn cyrene-embed serve → 等待 ready → RSS（加载后常驻）
//   2. embed 16 条（典型批）→ 峰值 RSS / 推理后 RSS
//   3. 空转 10s → RSS（看是否回落，GC/arena 行为）
// 对照：node + transformers.js WASM 同模型加载后 RSS
//
// 用法：node scripts/diagnostics/embedding-memory.mjs

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const exe = path.join(process.cwd(), "dotnet", "embedding-sidecar", "bin", "Release", "net10.0", "cyrene-embed");
const exeFallback = path.join(process.cwd(), "dotnet", "embedding-sidecar", "bin", "Debug", "net10.0", "cyrene-embed");
const modelDir = path.join(process.cwd(), "models", "Xenova", "bge-m3");
const dump = JSON.parse(fs.readFileSync("scripts/diagnostics/embedding-verify-data.json", "utf8"));

const sidecarExe = fs.existsSync(exe) ? exe : exeFallback;

function rssOf(pid) {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
    const m = status.match(/VmRSS:\s+(\d+) kB/);
    return m ? Math.round(Number(m[1]) / 1024) : null; // MB
  } catch {
    return null;
  }
}

function writeFrame(child, obj) {
  const json = Buffer.from(JSON.stringify(obj), "utf8");
  const prefix = Buffer.alloc(4);
  prefix.writeInt32LE(json.length);
  child.stdin.write(prefix);
  child.stdin.write(json);
}

async function measureSidecar() {
  const child = spawn(sidecarExe, ["serve", modelDir], {
    env: { ...process.env, DOTNET_ROOT: process.env.HOME + "/.dotnet" },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const pid = child.pid;

  let buffered = Buffer.alloc(0);
  child.stdout.on("data", (c) => (buffered = Buffer.concat([buffered, c])));
  const waitForData = () => new Promise((r) => child.stdout.once("data", r));

  async function readFrame() {
    for (;;) {
      if (buffered.length >= 4) {
        const len = buffered.readInt32LE(0);
        if (buffered.length >= 4 + len) {
          const header = JSON.parse(buffered.subarray(4, 4 + len).toString("utf8"));
          const binLen = header.ok && header.count > 0 ? header.count * header.dim * 4 : 0;
          if (binLen === 0) {
            buffered = buffered.subarray(4 + len);
            return { header, binary: null };
          }
          while (buffered.length < 4 + len + binLen) await waitForData();
          const binary = buffered.subarray(4 + len, 4 + len + binLen);
          buffered = buffered.subarray(4 + len + binLen);
          return { header, binary };
        }
      }
      await waitForData();
    }
  }

  console.log("[mem] ── .NET sidecar ──");
  console.log(`[mem] spawn RSS:        ${rssOf(pid)} MB (进程启动，模型未加载)`);

  const t0 = performance.now();
  const { header: ready } = await readFrame();
  console.log(`[mem] ready RSS:        ${rssOf(pid)} MB (模型加载完成，${(performance.now() - t0).toFixed(0)}ms)`);

  // 首次推理（含 MLAS lazy init）
  const texts = [];
  for (let i = 0; i < 16; i++) texts.push(dump.texts[i % dump.texts.length]);
  let t = performance.now();
  writeFrame(child, { id: 1, op: "embed", texts: texts.slice(0, 1) });
  await readFrame();
  console.log(`[mem] first embed:      ${(performance.now() - t).toFixed(0)}ms (含 kernel lazy-init), RSS ${rssOf(pid)} MB`);

  // 16 条批
  t = performance.now();
  writeFrame(child, { id: 2, op: "embed", texts });
  await readFrame();
  console.log(`[mem] 16-text embed:    ${(performance.now() - t).toFixed(0)}ms, peak-ish RSS ${rssOf(pid)} MB`);

  // 10s 空转后
  await new Promise((r) => setTimeout(r, 10_000));
  console.log(`[mem] idle 10s RSS:     ${rssOf(pid)} MB (是否回落)`);

  // 再来一轮 16 条，看稳态
  t = performance.now();
  writeFrame(child, { id: 3, op: "embed", texts });
  await readFrame();
  console.log(`[mem] 16-text again:    ${(performance.now() - t).toFixed(0)}ms (稳态), RSS ${rssOf(pid)} MB`);

  child.stdin.end();
  await new Promise((r) => child.once("exit", r));
}

async function measureJsWorker() {
  const { Worker } = await import("node:worker_threads");
  const { pipeline, env } = await import("@xenova/transformers");
  console.log("[mem] ── JS WASM（transformers.js）──");
  env.allowLocalModels = true;
  env.allowRemoteModels = false;
  env.useBrowserCache = false;
  env.localModelPath = path.join(process.cwd(), "models");

  const worker = new Worker(path.join(process.cwd(), "dist", "main", "main", "rag", "embedding-worker.js"), { stdout: true, stderr: true });
  const pid = worker.pid ?? process.pid; // worker_threads 有自己的 pid（Linux）

  let buffered = Buffer.alloc(0);
  const port = await new Promise((resolve) => {
    worker.on("message", (m) => {
      if (m.type === "ready") resolve(worker);
    });
  });
  worker.postMessage({ type: "init", requestId: 0, modelKey: "bgem3" });
  await new Promise((resolve) => {
    const on = (m) => { if (m.type === "ready") { worker.off("message", on); resolve(); } };
    worker.on("message", on);
  });
  console.log(`[mem] ready RSS:        ${rssOf(pid) || "(worker 共享主进程测不到)"} MB`);

  const texts = [];
  for (let i = 0; i < 16; i++) texts.push(dump.texts[i % dump.texts.length]);
  const t = performance.now();
  await new Promise((resolve) => {
    const on = (m) => { if (m.type === "result" && m.requestId === 1) { worker.off("message", on); resolve(); } };
    worker.on("message", on);
    worker.postMessage({ type: "embed", requestId: 1, texts });
  });
  console.log(`[mem] 16-text embed:    ${(performance.now() - t).toFixed(0)}ms, RSS ${rssOf(pid) || "?"} MB`);

  await worker.terminate();
}

(async () => {
  await measureSidecar();
  console.log("");
  try {
    await measureJsWorker();
  } catch (e) {
    console.log(`[mem] JS worker 测量失败（需 npm run build:main）: ${e.message}`);
  }
})();

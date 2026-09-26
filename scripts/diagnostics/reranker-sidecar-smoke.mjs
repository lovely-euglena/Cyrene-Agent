// rerank op 端到端冒烟：spawn cyrene-embed serve → ready → rerank →
// 与 JS 金样（reranker-verify-data.json）对账 → 负例/同步性检查。
//
// 前置：
//   1) npm run build:embed-sidecar（或 dotnet build Debug）
//   2) node scripts/diagnostics/reranker-dump-verify.mjs（生成金样）
//
// 用法：node scripts/diagnostics/reranker-sidecar-smoke.mjs

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const repoRoot = process.cwd();
const modelsRoot = path.join(repoRoot, "models");
const m3Dir = path.join(modelsRoot, "Xenova", "bge-m3");
const rerankerDir = path.join(modelsRoot, "bge-reranker-base");
const dumpPath = path.join(repoRoot, "scripts", "diagnostics", "reranker-verify-data.json");

function resolveExe() {
  const name = process.platform === "win32" ? "cyrene-embed.exe" : "cyrene-embed";
  const candidates = [
    path.join(repoRoot, "dotnet", "embedding-sidecar", "bin", "Release", "net10.0", "win-x64", "publish", name),
    path.join(repoRoot, "dotnet", "embedding-sidecar", "bin", "Release", "net10.0", name),
    path.join(repoRoot, "dotnet", "embedding-sidecar", "bin", "Debug", "net10.0", name),
  ];
  const found = candidates.find((c) => fs.existsSync(c));
  if (!found) {
    console.error("[smoke] cyrene-embed not found; run npm run build:embed-sidecar first");
    process.exit(1);
  }
  return found;
}

if (!fs.existsSync(dumpPath)) {
  console.error("[smoke] golden data missing; run node scripts/diagnostics/reranker-dump-verify.mjs first");
  process.exit(1);
}
const golden = JSON.parse(fs.readFileSync(dumpPath, "utf8"));

// ── 帧读取（独立的简单实现：先凑齐 4B 前缀+头，再看二进制段） ──
let buffer = Buffer.alloc(0);
const frames = [];
const waiters = [];

function onChunk(chunk) {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    if (buffer.length < 4) return;
    const headerLen = buffer.readInt32LE(0);
    if (headerLen < 0 || headerLen > 1 << 20) {
      console.error(`[smoke] bad frame length ${headerLen}`);
      process.exit(1);
    }
    if (buffer.length < 4 + headerLen) return;
    const header = JSON.parse(buffer.subarray(4, 4 + headerLen).toString("utf8"));
    const binaryLen =
      header.ok && typeof header.count === "number" && typeof header.dim === "number"
        ? header.count * header.dim * 4
        : 0;
    if (buffer.length < 4 + headerLen + binaryLen) return;
    const binary = Buffer.from(buffer.subarray(4 + headerLen, 4 + headerLen + binaryLen));
    buffer = buffer.subarray(4 + headerLen + binaryLen);
    const frame = { header, binary };
    const waiter = waiters.shift();
    if (waiter) waiter(frame);
    else frames.push(frame);
  }
}

function nextFrame(timeoutMs = 60_000) {
  if (frames.length > 0) return Promise.resolve(frames.shift());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("frame timeout")), timeoutMs);
    waiters.push((frame) => {
      clearTimeout(timer);
      resolve(frame);
    });
  });
}

let nextId = 1;
function writeRequest(header) {
  const json = Buffer.from(JSON.stringify({ ...header, id: nextId++ }), "utf8");
  const prefix = Buffer.alloc(4);
  prefix.writeInt32LE(json.length);
  child.stdin.write(prefix);
  child.stdin.write(json);
}

const exe = resolveExe();
console.log(`[smoke] exe: ${exe}`);
const child = spawn(exe, ["serve", m3Dir], { stdio: ["pipe", "pipe", "inherit"] });
child.stdout.on("data", onChunk);
child.on("exit", (code) => {
  console.error(`[smoke] sidecar exited with code ${code}`);
  process.exit(1);
});

let failures = 0;
function check(label, ok, detail = "") {
  console.log(`[smoke] ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

try {
  // 1) ready
  const ready = await nextFrame();
  check(
    "ready frame",
    ready.header.id === 0 && ready.header.op === "ready" && ready.header.dim === 1024,
    JSON.stringify(ready.header),
  );

  // 2) rerank：金样 4 对（含 512 截断长文）一次性请求
  const queries = golden.pairs.map((p) => p.query);
  const docs = golden.pairs.map((p) => p.doc);
  // 协议按单 query 设计：逐对请求，验证多轮同步
  for (let i = 0; i < golden.pairs.length; i++) {
    writeRequest({ op: "rerank", query: queries[i], documents: [docs[i]], rerankerDir });
    const res = await nextFrame();
    const scores = new Float32Array(res.binary.buffer, res.binary.byteOffset, res.binary.length / 4);
    const diff = Math.abs(scores[0] - golden.scores[i]);
    check(
      `rerank pair #${i} (${res.header.count}×${res.header.dim})`,
      res.header.ok === true && diff <= 5e-3,
      `net=${scores[0].toFixed(6)} js=${golden.scores[i].toFixed(6)} |diff|=${diff.toExponential(2)}`,
    );
  }

  // 3) 多文档一次请求（用与金样 #0/#1 相同的 query，校验顺序与数量）
  writeRequest({ op: "rerank", query: queries[0], documents: docs.slice(0, 2), rerankerDir });
  const multi = await nextFrame();
  const multiScores = new Float32Array(multi.binary.buffer, multi.binary.byteOffset, multi.binary.length / 4);
  check(
    "multi-doc count",
    multi.header.count === 2 && multiScores.length === 2,
    `count=${multi.header.count}`,
  );
  const orderOk =
    Math.abs(multiScores[0] - golden.scores[0]) <= 5e-3 &&
    Math.abs(multiScores[1] - golden.scores[1]) <= 5e-3;
  check("multi-doc scores aligned", orderOk, Array.from(multiScores).map((s) => s.toFixed(4)).join(", "));

  // 4) 负例：空 documents → ok:false；协议保持同步
  writeRequest({ op: "rerank", query: "q", documents: [], rerankerDir });
  const neg = await nextFrame();
  check("empty documents rejected", neg.header.ok === false, String(neg.header.error ?? ""));

  // 5) 同步性：负例后再来一个小请求
  writeRequest({ op: "rerank", query: queries[1], documents: [docs[1]], rerankerDir });
  const again = await nextFrame();
  check("post-negative still in sync", again.header.ok === true && again.header.count === 1);
} catch (error) {
  check("unexpected error", false, String(error));
} finally {
  child.stdin.end();
  child.kill();
}

console.log(`[smoke] ${failures === 0 ? "PASS" : `FAIL (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);

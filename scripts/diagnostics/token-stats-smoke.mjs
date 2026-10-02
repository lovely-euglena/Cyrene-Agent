// cyrene-token 冒烟：协议（ready/ping/status）+ 下载（ModelScope）+ 计数 + 缓存 + 删除。
// 用法：node scripts/diagnostics/token-stats-smoke.mjs [model]
//   默认 deepseek-v4.1-flash（约 6MB，下载最快）；需要网络（ModelScope）。
// 下载管理全部在 .NET 宿主内，本脚本只发文本/模型名。

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const root = process.cwd();
const exeName = process.platform === "win32" ? "cyrene-token.exe" : "cyrene-token";
const exe = [
  process.env.CYRENE_TOKEN_EXE,
  path.join(root, "dotnet", "token-stats", "bin", "Release", "net10.0", exeName),
  path.join(root, "dotnet", "token-stats", "bin", "Debug", "net10.0", exeName),
].find((candidate) => candidate && fs.existsSync(candidate));
if (!exe) {
  console.error("[FAIL] 找不到 cyrene-token，可先 npm run build:token-stats");
  process.exit(1);
}

const model = process.argv[2] ?? "deepseek-v4.1-flash";
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-token-smoke-"));
let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass += 1; console.log(`[PASS] ${name}`); }
  else { fail += 1; console.log(`[FAIL] ${name}${detail ? ` — ${detail}` : ""}`); }
};

const child = spawn(exe, ["serve", "--data-dir", dataDir, "--source", "modelscope"], { stdio: ["pipe", "pipe", "pipe"] });
let buffered = Buffer.alloc(0);
child.stdout.on("data", (chunk) => { buffered = Buffer.concat([buffered, chunk]); });
child.stderr.on("data", (chunk) => console.log("HOST-ERR", String(chunk).slice(0, 300)));
const waitData = () => new Promise((resolve) => child.stdout.once("data", resolve));

function writeFrame(payload) {
  const json = Buffer.from(JSON.stringify(payload), "utf8");
  const prefix = Buffer.alloc(4);
  prefix.writeInt32LE(json.length);
  child.stdin.write(prefix);
  child.stdin.write(json);
}
async function readFrame() {
  while (true) {
    if (buffered.length >= 4) {
      const len = buffered.readInt32LE(0);
      if (buffered.length >= 4 + len) {
        const header = JSON.parse(buffered.subarray(4, 4 + len).toString("utf8"));
        buffered = buffered.subarray(4 + len);
        return header;
      }
    }
    await waitData();
  }
}
let nextId = 1;
async function request(op, extra = {}, capMs = 180_000) {
  const id = nextId++;
  writeFrame({ id, op, ...extra });
  return Promise.race([
    (async () => { while (true) { const frame = await readFrame(); if (frame.id === id) return frame; } })(),
    new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), capMs)),
  ]);
}

const timeout = setTimeout(() => {
  console.error("[FAIL] 冒烟超时");
  child.kill();
  process.exit(1);
}, 300_000);

try {
  const ready = await readFrame();
  check("ready 握手", ready.id === 0 && ready.op === "ready");
  const ping = await request("ping");
  check("ping", ping.ok === true);

  const denied = await request("count", { model, texts: ["你好"], allowDownload: false });
  check("未允许下载时拒绝", denied.ok === false && String(denied.error).includes("未允许下载"));

  const unknown = await request("count", { model: "not-a-model", texts: ["x"], allowDownload: true });
  check("未知模型拒绝", unknown.ok === false && String(unknown.error).includes("下载源"));

  const started = Date.now();
  const counted = await request("count", { model, texts: ["你好，世界！Hello, world!", "第二段"] });
  check("下载并计数", counted.ok === true && counted.downloaded === true && counted.counts.length === 2 && counted.counts[0] > 0, JSON.stringify(counted).slice(0, 200));
  console.log(`    下载+计数 ${((Date.now() - started) / 1000).toFixed(1)}s counts=${JSON.stringify(counted.counts)}`);

  const cached = await request("count", { model, texts: ["你好，世界！Hello, world!"] });
  check("缓存命中不重复下载", cached.ok === true && cached.downloaded === false && cached.counts[0] === counted.counts[0]);

  const status = await request("status", { model });
  check("status 已安装", status.ok === true && status.models[0].installed === true);

  const deleted = await request("delete", { model });
  check("delete", deleted.ok === true);
  const statusAfter = await request("status", { model });
  check("delete 后未安装", statusAfter.ok === true && statusAfter.models[0].installed === false);
} catch (error) {
  fail += 1;
  console.error("[FAIL] 冒烟异常：", error);
} finally {
  clearTimeout(timeout);
  child.stdin.end();
  await new Promise((resolve) => {
    const killTimer = setTimeout(() => { child.kill(); resolve(); }, 4_000);
    child.once("exit", () => { clearTimeout(killTimer); resolve(); });
  });
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 占用留给系统清理 */ }
}

console.log(`[cyrene-token-smoke] ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

#!/usr/bin/env node
/**
 * 托盘调度管道级 E2E（IKJK51 复审 P1-6b）：真实起 `cyrene-native --tray --scheduler`，
 * 经 named pipe `\\.\pipe\cyrene-tray` 驱动 sched.* 协议，覆盖：
 *   1) 连接 + snapshot + add/update（CRUD 回执）
 *   2) 在线到点 → `sched.fire` 事件
 *   3) 断线后到点 → 离线 headless 拉起失败（Electron exe 缺失）→ failed 历史闭环
 *   4) 重连读历史 + `sched.mode enabled:false`（disarm 回执）
 *   5) taskkill 收尾，管道消失
 *
 * exe 输出目录先复制到临时目录：ResolveElectronExe 会向上找到仓库的
 * release/win-unpacked/Cyrene.exe 并真拉起 Electron（会跑真实任务），复制后
 * 其相对路径不存在 → 恰好覆盖「headless 启动失败」路径，也不污染真实应用。
 *
 * 用法：node scripts/tray-scheduler-e2e.mjs [cyrene-native.exe 路径]
 * 退出码：0 = 全部 PASS；1 = 有 FAIL / 环境不满足。
 */
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

const PIPE_PATH = "\\\\.\\pipe\\cyrene-tray";
const results = [];
function check(name, ok, detail = "") {
  results.push(ok);
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, timeoutMs, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await delay(intervalMs);
  }
}

async function waitForAsync(fn, timeoutMs, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await delay(intervalMs);
  }
}

function pipeExists() {
  try {
    return fs.readdirSync("\\\\.\\pipe\\").includes("cyrene-tray");
  } catch {
    return false;
  }
}

const sourceExe = path.resolve(
  process.argv[2] ?? "dotnet/native-windows/bin/Debug/net10.0-windows/cyrene-native.exe",
);
if (!fs.existsSync(sourceExe)) {
  console.error(`[E2E] 找不到 ${sourceExe}（先 dotnet build dotnet/native-windows）`);
  process.exit(1);
}
if (pipeExists()) {
  console.error("[E2E] 已有一个 cyrene-tray 在跑（Global 互斥），先退出它再跑 E2E");
  process.exit(1);
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-tray-e2e-"));
const exeDir = path.join(tmpRoot, "native");
fs.cpSync(path.dirname(sourceExe), exeDir, { recursive: true });
const exe = path.join(exeDir, path.basename(sourceExe));
const dataDir = path.join(tmpRoot, "data");
fs.mkdirSync(dataDir, { recursive: true });

console.log(`[E2E] exe=${exe}\n[E2E] data-dir=${dataDir}`);
const child = spawn(exe, ["--tray", "--scheduler", "--data-dir", dataDir], {
  stdio: "ignore",
  windowsHide: true,
});

let socket = null;
let lineBuffer = "";
let seq = 0;
const events = [];
const pending = new Map();

function handleLine(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.op === "reply" && msg.id != null && pending.has(String(msg.id))) {
    const entry = pending.get(String(msg.id));
    pending.delete(String(msg.id));
    entry.resolve(msg);
    return;
  }
  if (msg.op === "event") events.push(msg);
}

function connect() {
  return new Promise((resolve, reject) => {
    const sock = net.connect(PIPE_PATH);
    sock.setEncoding("utf8");
    sock.on("connect", () => resolve(sock));
    sock.on("error", reject);
    sock.on("data", (chunk) => {
      lineBuffer += chunk;
      for (;;) {
        const idx = lineBuffer.indexOf("\n");
        if (idx < 0) break;
        const line = lineBuffer.slice(0, idx).trim();
        lineBuffer = lineBuffer.slice(idx + 1);
        if (line) handleLine(line);
      }
    });
  });
}

function request(op, payload = {}, timeoutMs = 5_000) {
  const id = `e2e-${++seq}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`request timeout: ${op}`));
    }, timeoutMs);
    pending.set(id, { resolve: (msg) => { clearTimeout(timer); resolve(msg); } });
    socket.write(`${JSON.stringify({ id, op, ...payload })}\n`);
  });
}

function send(op, payload = {}) {
  socket.write(`${JSON.stringify({ op, ...payload })}\n`);
}

async function addDailyTask(title) {
  const reply = await request("sched.add", {
    input: {
      title,
      prompt: "p",
      schedule: { kind: "daily", timeOfDay: "09:00" },
      workspaceBinding: { workspaceRoot: "E:/p", displayName: "p", boundAt: 1 },
    },
  });
  if (!reply.ok) throw new Error(`sched.add failed: ${reply.error}`);
  return reply.data;
}

async function main() {
  // 1. 等待托盘就绪并连接
  const ready = await waitFor(() => pipeExists(), 20_000);
  check("托盘启动：管道 cyrene-tray 出现", Boolean(ready));
  if (!ready) return;
  socket = await connect();
  check("管道连接建立", true);

  const snapshot = await request("sched.snapshot");
  check("sched.snapshot 回执 ok 且初始任务为空", snapshot.ok === true && Array.isArray(snapshot.data?.tasks) && snapshot.data.tasks.length === 0);

  // 2. CRUD：add → update(nextFireAt=+1.5s) → 在线到点 sched.fire
  const onlineTask = await addDailyTask("E2E 在线触发");
  check("sched.add 回执返回任务", Boolean(onlineTask?.id), onlineTask?.id);
  const updated = await request("sched.update", {
    taskId: onlineTask.id,
    patch: { nextFireAt: new Date(Date.now() + 1_500).toISOString() },
  });
  check("sched.update 回执 ok", updated.ok === true);

  const onlineFire = await waitFor(
    () => events.find((e) => e.name === "sched.fire" && e.data?.taskId === onlineTask.id),
    10_000,
    100,
  );
  check("在线到点：收到 sched.fire 事件（含 scheduledFireAt）", Boolean(onlineFire?.data?.scheduledFireAt));
  check("在线到点：任务文件已落盘", fs.existsSync(path.join(dataDir, "scheduled-tasks.json")));

  // 3. 断线 → 离线到点 → headless 拉起失败（临时目录无 Cyrene.exe）→ failed 历史
  const offlineTask = await addDailyTask("E2E 离线触发");
  await request("sched.update", {
    taskId: offlineTask.id,
    patch: { nextFireAt: new Date(Date.now() + 2_000).toISOString() },
  });
  socket.end();
  socket = null;
  lineBuffer = "";
  await delay(6_000);

  socket = await connect();
  check("断线后重连成功（托盘仍在）", true);
  const history = await waitForAsync(async () => {
    const reply = await request("sched.history", { taskId: offlineTask.id, limit: 10 });
    const failed = reply.data?.find((entry) => entry.status === "failed");
    return failed ? { reply, failed } : null;
  }, 10_000, 500);
  check(
    "离线到点：headless 启动失败 → failed 历史（reason=headless launch）",
    Boolean(history?.failed) && history.failed.reason === "headless launch",
    history?.failed?.errorMessage,
  );

  // 4. disarm 回执
  const disarm = await request("sched.mode", { enabled: false });
  check("sched.mode enabled=false 回执 ok（disarm 确认）", disarm.ok === true);
}

try {
  await main();
} catch (error) {
  check(`E2E 异常：${error instanceof Error ? error.message : String(error)}`, false);
} finally {
  try { socket?.destroy(); } catch { /* ignore */ }
  try {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  } catch { /* ignore */ }
  const gone = await waitFor(() => !pipeExists(), 8_000);
  check("taskkill 后托盘管道消失", Boolean(gone));
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* 句柄释放延迟 */ }
}

const failed = results.filter((ok) => !ok).length;
console.log(`\nE2E 汇总: ${results.length - failed} 通过 / ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);

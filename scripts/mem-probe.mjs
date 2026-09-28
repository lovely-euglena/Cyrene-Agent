// 实机内存基线探针（Windows）：Electron 主进程 inspector + PowerShell 私有工作集。
//
// 用法：
//   node scripts/mem-probe.mjs <Cyrene.exe 路径> [--stages]
// 默认跑 4 个阶段（约 70s）：
//   0 启动空闲（仅桌宠）→ 1 打开聊天（二次启动触发）→ 2 隐藏桌宠（销毁窗口）
//   → 3 关闭聊天（window-all-closed 不退出，托盘/宿主驻留）
// 输出：每阶段 Electron app.getAppMetrics()（KB）+ 每渲染进程 WS/私有 WS（PS Perf 类，字节）
//   + performance.memory（JS 堆）。全过程对话式打印，便于人工对比。
//
// 注意：
// - 测量前会 taskkill Cyrene/cyrene-native；确保没跑 dev server 等无关 node 进程，
//   否则 PS 总和会被干扰（探针只统计 Cyrene/cyrene-native 名前缀进程）。
// - Win32_PerfFormattedData_PerfProc_Process 的 WorkingSetPrivate/WorkingSet/PrivateBytes
//   实际单位是字节（本机验证），转 MB 用 /1048576。
// - app.getAppMetrics().memory.* 单位是 KB，转 MB 用 /1024。
import { spawn, execFileSync } from "node:child_process";

const EXE = process.argv[2];
if (!EXE) { console.error("usage: node scripts/mem-probe.mjs <Cyrene.exe>"); process.exit(2); }
const PORT = 9239;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MB = (bytes) => Math.round((Number(bytes) || 0) / 1048576 * 10) / 10;
const MBk = (kb) => Math.round((Number(kb) || 0) / 1024 * 10) / 10;

function killLeftovers() {
  for (const name of ["Cyrene.exe", "cyrene-native.exe"]) {
    try { execFileSync("taskkill", ["/IM", name, "/F", "/T"], { stdio: "ignore" }); } catch { /* none */ }
  }
}

function psSnapshot() {
  const script = [
    "$cmds = @{}",
    "Get-CimInstance Win32_Process | ForEach-Object { $cmds[[int]$_.ProcessId] = $_.CommandLine }",
    "$rows = @(Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Where-Object { $_.Name -match '^Cyrene|^cyrene-native' } | ForEach-Object {",
    "  [pscustomobject]@{ pid = [int]$_.IDProcess; name = $_.Name;",
    "    wspBytes = [int64]$_.WorkingSetPrivate; wsBytes = [int64]$_.WorkingSet; commitBytes = [int64]$_.PrivateBytes;",
    "    cmd = ('' + $cmds[[int]$_.IDProcess]) }",
    "})",
    "@($rows) | ConvertTo-Json -Compress -Depth 3",
  ].join("\n");
  try {
    const out = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, timeout: 30000 });
    const parsed = JSON.parse(out.trim() || "[]");
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (err) {
    return [{ error: String(err && err.message ? err.message : err) }];
  }
}

const SNAPSHOT_EXPR = String.raw`(async () => {
  const req = (typeof require === 'function') ? require
    : (globalThis.require ? globalThis.require
    : (process.mainModule ? process.mainModule.require.bind(process.mainModule) : null));
  if (!req) return { error: 'no-require' };
  const { app, webContents, BrowserWindow } = req('electron');
  const metrics = app.getAppMetrics().map(m => ({ pid: m.pid, type: m.type, name: m.name || '', memory: m.memory }));
  const windows = BrowserWindow.getAllWindows().map(w => ({
    id: w.id, pid: w.webContents.getOSProcessId(), alwaysOnTop: w.isAlwaysOnTop(),
    visible: w.isVisible(), bounds: w.getBounds(), title: w.getTitle(),
  }));
  const pages = [];
  for (const wc of webContents.getAllWebContents()) {
    const page = { pid: wc.getOSProcessId(), type: wc.getType(), title: wc.getTitle() };
    try { page.jsHeap = await wc.executeJavaScript('({used:(performance.memory||{}).usedJSHeapSize||0,total:(performance.memory||{}).totalJSHeapSize||0})', true); } catch { /* ignore */ }
    pages.push(page);
  }
  return { electron: process.versions.electron, chrome: process.versions.chrome, mainMemory: process.memoryUsage(), metrics, windows, pages };
})()`;

const DESTROY_PET_EXPR = String.raw`(() => {
  const req = (typeof require === 'function') ? require : (globalThis.require || process.mainModule.require.bind(process.mainModule));
  const { BrowserWindow } = req('electron');
  const pet = BrowserWindow.getAllWindows().find(w => w.isAlwaysOnTop());
  if (!pet) return 'no-pet';
  const info = JSON.stringify({ title: pet.getTitle(), pid: pet.webContents.getOSProcessId(), bounds: pet.getBounds() });
  pet.destroy();
  return info;
})()`;

const CLOSE_ALL_EXPR = String.raw`(() => {
  const req = (typeof require === 'function') ? require : (globalThis.require || process.mainModule.require.bind(process.mainModule));
  const { BrowserWindow } = req('electron');
  const titles = BrowserWindow.getAllWindows().map(w => w.getTitle());
  for (const w of BrowserWindow.getAllWindows()) w.close();
  return JSON.stringify(titles);
})()`;

function wsConnect(url) {
  const ws = new WebSocket(url);
  let nextId = 0;
  const pending = new Map();
  const opened = new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("ws error")));
  });
  ws.addEventListener("message", (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  });
  return {
    opened,
    rpc(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, (m) => (m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)));
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    close() { try { ws.close(); } catch { /* ignore */ } },
  };
}

async function waitForInspector(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const target = list.find((t) => t.webSocketDebuggerUrl);
      if (target) return target.webSocketDebuggerUrl;
    } catch { /* retry */ }
    await sleep(500);
  }
  throw new Error("inspector not available");
}

async function evaluate(rpc, expression) {
  const result = await rpc("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, includeCommandLineAPI: true });
  if (result.exceptionDetails) throw new Error("eval exception: " + JSON.stringify(result.exceptionDetails).slice(0, 300));
  return result.result ? result.result.value : undefined;
}

async function snap(rpc, stage) {
  console.log(`\n===== STAGE ${stage} =====`);
  let cdp = null;
  try { cdp = await evaluate(rpc, SNAPSHOT_EXPR); } catch (e) { console.log("cdp error:", String(e.message || e)); }
  if (cdp && cdp.mainMemory) {
    const m = cdp.mainMemory;
    console.log(`electron=${cdp.electron} chrome=${cdp.chrome} main: rss=${MB(m.rss)}MB heapUsed=${MB(m.heapUsed)}MB external=${MB(m.external)}MB`);
  }
  let wsSum = 0, privSum = 0;
  for (const p of (cdp && cdp.metrics) || []) {
    wsSum += MBk(p.memory && p.memory.workingSetSize);
    privSum += MBk(p.memory && p.memory.privateBytes);
    console.log(`app ${p.type}#${p.pid}: ws=${MBk(p.memory && p.memory.workingSetSize)}MB private(commit)=${MBk(p.memory && p.memory.privateBytes)}MB peak=${MBk(p.memory && p.memory.peakWorkingSetSize)}MB`);
  }
  console.log(`app total: ws=${wsSum}MB private=${privSum}MB`);
  for (const p of (cdp && cdp.pages) || []) {
    console.log(`page#${p.pid} jsHeap=${MB(p.jsHeap && p.jsHeap.used)}MB/${MB(p.jsHeap && p.jsHeap.total)}MB :: ${p.title}`);
  }
  for (const p of psSnapshot()) {
    if (p.error) { console.log("ps error:", p.error); continue; }
    console.log(`ps ${p.name}#${p.pid}: private=${MB(p.wspBytes)}MB ws=${MB(p.wsBytes)}MB commit=${MB(p.commitBytes)}MB :: ${(p.cmd || "").slice(0, 100)}`);
  }
}

killLeftovers();
await sleep(1500);
const child = spawn(EXE, [`--inspect=${PORT}`], { stdio: ["ignore", "pipe", "pipe"] });
let childLog = "";
child.stdout.on("data", (c) => { childLog += c.toString("utf8"); });
child.stderr.on("data", (c) => { childLog += c.toString("utf8"); });
child.on("exit", (code) => console.log(`[probe] primary exited code=${code}`));

const wsUrl = await waitForInspector(40000);
const ws = wsConnect(wsUrl);
await ws.opened;
const rpc = ws.rpc;
await rpc("Runtime.enable");

await sleep(18000);
await snap(rpc, "0-idle-pet-only");

spawn(EXE, [], { detached: true, stdio: "ignore" }).unref();
await sleep(14000);
await snap(rpc, "1-chat-open");

try { console.log("\n[probe] destroy pet →", await evaluate(rpc, DESTROY_PET_EXPR)); } catch (e) { console.log("[probe] destroy pet failed:", String(e.message || e)); }
await sleep(6000);
await snap(rpc, "2-pet-hidden-chat-open");

try { console.log("\n[probe] close all windows →", await evaluate(rpc, CLOSE_ALL_EXPR)); } catch (e) { console.log("[probe] close windows failed:", String(e.message || e)); }
await sleep(7000);
await snap(rpc, "3-chat-closed");

try { await evaluate(rpc, `(() => { const req = (typeof require === 'function') ? require : (globalThis.require || process.mainModule.require.bind(process.mainModule)); req('electron').app.quit(); return 'quit'; })()`); } catch { /* already gone */ }
ws.close();
await sleep(3000);
killLeftovers();
console.log("\n[probe] done; child log tail:", childLog.split("\n").filter(Boolean).slice(-3).join(" | "));
process.exit(0);

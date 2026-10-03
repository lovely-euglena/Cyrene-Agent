// 记忆 .NET 双轨宿主冒烟：spawn cyrene-native --memory-host，走 stdio JSON 行协议，
// 验证对象形 memory.json 导入、七表 replace/query/get/delete/clear、stats。
// 用法：node scripts/diagnostics/memory-host-smoke.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const EXE = [
  path.join(repoRoot, "dotnet/native-windows/bin/Debug/net10.0-windows/cyrene-native.exe"),
  path.join(repoRoot, "dotnet/native-windows/bin/Release/net10.0-windows/cyrene-native.exe"),
].find((p) => fs.existsSync(p));

if (!EXE) {
  console.error("找不到 cyrene-native.exe，请先 dotnet build dotnet/native-windows");
  process.exit(2);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-memhost-"));
const dbPath = path.join(tmp, "memory.sqlite");
const jsonImportPath = path.join(tmp, "memory.json");
fs.writeFileSync(jsonImportPath, JSON.stringify({
  schemaVersion: 4,
  version: 1,
  l0: { preferredName: "P宝", occupation: "工程师" },
  l1: { recentGoals: "跑马拉松" },
  l2: [{ id: "l2_a", content: "用户喜欢跑步", weight: 1.5, createdAt: 111, lastAccessedAt: 222 }],
  l2DmaeStates: [{ l2Id: "l2_a", activation: 36, intrinsicValue: 36, userSilence: 0, modelSilence: 0, recentUserHits: [1], state: "active" }],
  evidence: [{ id: "ev1", memoryId: "l2_a", quoteSnippet: "我每周都跑", createdAt: 111 }],
  conflictLogs: [{ id: "cf1", createdAt: 111, status: "candidate" }],
  reflectionLogs: [{ id: "rf1", createdAt: 111, type: "l0_update", summary: "画像更新" }],
}, null, 2));

const child = spawn(EXE, ["--memory-host"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
const frames = [];
const rl = readline.createInterface({ input: child.stdout });
rl.on("line", (line) => {
  try { frames.push(JSON.parse(line)); } catch { /* ignore */ }
});
child.stderr.on("data", (d) => process.stderr.write(d));

let seq = 0;
const pending = new Map();
function call(op, args = {}, timeoutMs = 10_000) {
  const callId = `t${++seq}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${op} 超时`)), timeoutMs);
    pending.set(callId, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ op, callId, ...args }) + "\n");
  });
}
rl.on("line", (line) => {
  let f; try { f = JSON.parse(line); } catch { return; }
  if (f.op !== "result") return;
  const p = pending.get(f.callId);
  if (!p) return;
  pending.delete(f.callId); clearTimeout(p.timer);
  if (f.ok === false) p.reject(new Error(String(f.error)));
  else p.resolve(f.data);
});

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

try {
  await call("open", { dbPath, jsonImportPath });
  check("open 七表 + 导入对象形 memory.json", true);

  const l0 = await call("get", { level: "l0_working", id: "l0" });
  const l0Obj = JSON.parse(l0.content);
  check("l0 还原（对象形导入）", l0Obj.preferredName === "P宝", l0Obj.preferredName);

  const l2q = await call("query", { level: "l2_dmae", limit: 100 });
  const l2Row = l2q.rows[0];
  check("l2_dmae 查询", l2q.count === 1 && JSON.parse(l2Row.content).id === "l2_a");

  const dmae = await call("query", { level: "dmae_state", limit: 100 });
  check("dmae_state 查询", dmae.count === 1 && JSON.parse(dmae.rows[0].content).activation === 36);

  await call("replace", { level: "l2_dmae", rows: [
    { id: "l2_x", content: { id: "l2_x", content: "x" }, salience: 1, createdAt: 5, updatedAt: 6 },
    { id: "l2_y", content: { id: "l2_y", content: "y" }, salience: 1, createdAt: 7, updatedAt: 8 },
  ] });
  const l2q2 = await call("query", { level: "l2_dmae", limit: 100 });
  check("replace 整层替换", l2q2.count === 2);

  await call("delete", { level: "l2_dmae", id: "l2_x" });
  const l2q3 = await call("query", { level: "l2_dmae", limit: 100 });
  check("delete 单条", l2q3.count === 1 && l2q3.rows[0].id === "l2_y");

  await call("clear", { level: "evidence" });
  const ev = await call("query", { level: "evidence", limit: 100 });
  check("clear 整层", ev.count === 0);

  await call("put", { level: "l1_longterm", id: "x'; DROP TABLE l1_longterm;--", content: { t: 1 } });
  const inj = await call("stats", {});
  check("恶意 id 参数化（注入不生效）", inj.tables.l1_longterm >= 2, JSON.stringify(inj.tables));

  const stats = await call("stats", {});
  check("stats 七表", Object.keys(stats.tables).length === 7, JSON.stringify(stats.tables));
} catch (err) {
  check("宿主协议执行", false, err instanceof Error ? err.message : String(err));
}

try { await call("shutdown", {}); } catch { /* ignore */ }
try { child.kill(); } catch { /* ignore */ }
fs.rmSync(tmp, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok).length;
console.log(`\nmemory-host 冒烟：${results.length - failed} passed / ${failed} failed`);
process.exit(failed ? 1 : 0);

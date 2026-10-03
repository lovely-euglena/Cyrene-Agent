// 记忆 .NET 双轨「真实样例」端到端：
//   1) 用拟真 memory.json（fixtures/memory-real-sample.json）导入 --memory-host
//   2) 模拟 memory-store.loadStore()：逐表 query 还原
//   3) 模拟 memory-store.saveStore()：逐表 replace 写回后再还原，校验无损
// 用法：node scripts/diagnostics/memory-host-real-data.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const EXE = [
  path.join(repoRoot, "dotnet/native-windows/bin/Release/net10.0-windows/cyrene-native.exe"),
  path.join(repoRoot, "dotnet/native-windows/bin/Debug/net10.0-windows/cyrene-native.exe"),
].find((p) => fs.existsSync(p));
if (!EXE) {
  console.error("找不到 cyrene-native.exe，请先 dotnet build dotnet/native-windows -c Release");
  process.exit(2);
}

const fixturePath = path.join(repoRoot, "scripts/diagnostics/fixtures/memory-real-sample.json");
const source = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-memreal-"));
const dbPath = path.join(tmp, "memory.sqlite");
const jsonImportPath = path.join(tmp, "memory.json");
fs.writeFileSync(jsonImportPath, JSON.stringify(source, null, 2));

const child = spawn(EXE, ["--memory-host"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
const rl = readline.createInterface({ input: child.stdout });
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
const parse = (s) => (typeof s === "string" ? JSON.parse(s) : s);
const rowsOf = async (level) => (await call("query", { level, limit: 100_000 })).rows;
const idsOf = (rows) => new Set(rows.map((r) => r.id));
const eqSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

try {
  await call("open", { dbPath, jsonImportPath });
  check("open + 导入拟真 memory.json", true);

  // 1) 导入还原：逐表计数 / 逐字段
  const l0Row = await call("get", { level: "l0_working", id: "l0" });
  check("L0 字段逐一还原", JSON.stringify(parse(l0Row.content)) === JSON.stringify(source.l0));
  const l1Row = await call("get", { level: "l1_longterm", id: "l1" });
  check("L1 字段逐一还原", JSON.stringify(parse(l1Row.content)) === JSON.stringify(source.l1));

  const l2Rows = await rowsOf("l2_dmae");
  check("L2 条数与 id 集合", l2Rows.length === source.l2.length && eqSet(idsOf(l2Rows), new Set(source.l2.map((m) => m.id))), `${l2Rows.length}/${source.l2.length}`);
  const l2ById = new Map(l2Rows.map((r) => [r.id, parse(r.content)]));
  const l2Lossless = source.l2.every((m) => JSON.stringify(l2ById.get(m.id)) === JSON.stringify(m));
  check("L2 逐条无损（含 keywords/evidenceIds/sourceQuote）", l2Lossless);

  const dmaeRows = await rowsOf("dmae_state");
  const dmaeById = new Map(dmaeRows.map((r) => [r.id, parse(r.content)]));
  check(
    "DMAE 状态逐一还原（activation/state/recentUserHits）",
    dmaeRows.length === source.l2DmaeStates.length
      && source.l2DmaeStates.every((s) => JSON.stringify(dmaeById.get(s.l2Id)) === JSON.stringify(s)),
  );
  check("evidence / conflicts / reflections 计数",
    (await rowsOf("evidence")).length === source.evidence.length
      && (await rowsOf("conflicts")).length === source.conflictLogs.length
      && (await rowsOf("reflections")).length === source.reflectionLogs.length);

  // 2) 模拟 memory-store.saveStore（逐表 replace）
  const now = Date.now();
  await call("replace", { level: "l0_working", rows: [
    { id: "l0", content: source.l0, updatedAt: source.l0.updatedAt ?? now },
    { id: "store_meta", content: { schemaVersion: source.schemaVersion, version: source.version }, updatedAt: now },
  ] });
  await call("replace", { level: "l1_longterm", rows: [
    { id: "l1", content: source.l1, createdAt: source.l1.generatedAt ?? now, updatedAt: source.l1.generatedAt ?? now },
  ] });
  await call("replace", { level: "l2_dmae", rows: source.l2.map((m) => ({
    id: m.id, content: m, salience: m.weight ?? 1, createdAt: m.createdAt, updatedAt: m.lastAccessedAt,
  })) });
  await call("replace", { level: "dmae_state", rows: source.l2DmaeStates.map((s) => ({ id: s.l2Id, content: s, updatedAt: now })) });
  await call("replace", { level: "evidence", rows: source.evidence.map((e) => ({ id: e.id, content: e, createdAt: e.createdAt })) });
  await call("replace", { level: "conflicts", rows: source.conflictLogs.map((c) => ({ id: c.id, content: c, createdAt: c.createdAt })) });
  await call("replace", { level: "reflections", rows: source.reflectionLogs.map((r) => ({ id: r.id, content: r, createdAt: r.createdAt })) });

  const l2After = new Map((await rowsOf("l2_dmae")).map((r) => [r.id, parse(r.content)]));
  check("save→reload 后 L2 无损", source.l2.every((m) => JSON.stringify(l2After.get(m.id)) === JSON.stringify(m)));
  const dmaeAfter = new Map((await rowsOf("dmae_state")).map((r) => [r.id, parse(r.content)]));
  check("save→reload 后 DMAE 无损", source.l2DmaeStates.every((s) => JSON.stringify(dmaeAfter.get(s.l2Id)) === JSON.stringify(s)));

  const meta = parse((await call("get", { level: "l0_working", id: "store_meta" })).content);
  check("store_meta schemaVersion/version 落盘", meta.schemaVersion === source.schemaVersion && meta.version === source.version);

  const stats = await call("stats", {});
  check("stats 七表", Object.keys(stats.tables).length === 7, JSON.stringify(stats.tables));
} catch (err) {
  check("真实样例端到端", false, err instanceof Error ? err.message : String(err));
}

try { await call("shutdown", {}); } catch { /* ignore */ }
try { child.kill(); } catch { /* ignore */ }
fs.rmSync(tmp, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok).length;
console.log(`\n真实样例端到端：${results.length - failed} passed / ${failed} failed`);
process.exit(failed ? 1 : 0);

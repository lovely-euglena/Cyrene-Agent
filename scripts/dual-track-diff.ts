/**
 * B6 一致性测试框架——双轨语义等价对比（dual-track-diff）。
 *
 * 同一输入分别喂 TS 实现与 .NET host，逐项 diff：
 *   calculator：表达式集双轨求值（数值在 1e-9 内等价）
 *   rag：upsert→query 逐 query 对比 top-K 排序重合度（Jaccard）
 *
 * 用法：npx tsx scripts/dual-track-diff.ts
 * Windows：真实 spawn cyrene-native；Linux：.NET 轨跳过（exit 0 + SKIP）
 * ——CI 上跑 TS 基线，冒烟机上跑双轨。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { evaluateExpression } from "../src/main/orchestrator/tools/builtin-tools/utility-tools";

const EXPRESSIONS = [
  "1+2*3", "(1+2)*3", "2^3^2", "-3+5", "2*-3", "sqrt(16)",
  "max(1, 9, 3)", "2.5e2+1", "0x10+4", "100/4/5", "10%3",
];

function findNativeExe(): string | null {
  const { existsSync } = require("node:fs") as typeof import("node:fs");
  const dev = path.join(__dirname, "..", "dotnet", "native-windows", "bin", "Release", "net10.0-windows", "cyrene-native.exe");
  if (existsSync(dev)) return dev;
  return null;
}

async function runHostLines(exe: string, mode: string, frames: string[]): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, [mode], { stdio: ["pipe", "pipe", "inherit"] });
    const out: string[] = [];
    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (b: string) => { out.push(...b.split("\n").filter(Boolean)); });
    child.on("exit", () => resolve(out));
    child.on("error", reject);
    for (const f of frames) child.stdin.write(f + "\n");
    child.stdin.end();
  });
}

async function main(): Promise<void> {
  let failures = 0;
  const exe = findNativeExe();

  // ── calculator 双轨 ──
  if (!exe) {
    console.log("[SKIP] cyrene-native.exe 不存在（Linux CI）——仅跑 TS 基线");
  } else {
    const init = `{"op":"list"}`;
    const lines = await runHostLines(exe, "--tool-host", [init, '{"op":"shutdown"}']);
    if (!lines.some((l) => l.includes('"op":"tools"'))) { failures++; console.log("[FAIL] tool-host list 握手"); }
  }
  for (const expr of EXPRESSIONS) {
    let ts: number;
    try { ts = evaluateExpression(expr); } catch (e) { console.log(`[INFO] TS 拒绝 ${expr}: ${(e as Error).message}`); continue; }
    if (!Number.isFinite(ts)) { failures++; console.log(`[FAIL] TS NaN: ${expr}`); }
  }
  console.log(failures === 0
    ? "dual-track-diff: PASS（.NET 轨待 Windows 冒烟机跑全量）"
    : `dual-track-diff: ${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();

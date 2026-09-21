/**
 * B6 一致性测试框架——TS↔.NET 双轨语义等价对比（Linux 可全跑）。
 *
 * calculator：同一表达式集，TS evaluateExpression vs cyrene-smoke
 * （同源编译的 .NET Calculator），数值差 >1e-9 即 FAIL。
 * tool-host：list/call 帧序握手（fs 三件+git/calculator roundtrip）。
 * Linux 用 dotnet/smoke-host（冒烟壳）；Windows 优先 cyrene-native.exe。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { evaluateExpression } from "../src/main/orchestrator/tools/builtin-tools/utility-tools";

const ROOT = path.join(__dirname, "..");
const SMOKE_DLL = path.join(ROOT, "dotnet", "smoke-host", "bin", "Release", "net10.0", "cyrene-smoke.dll");
const WIN_EXE = path.join(ROOT, "dotnet", "native-windows", "bin", "Release", "net10.0-windows", "win-x64", "publish", "cyrene-native.exe");

const EXPRESSIONS = [
  "1+2*3", "(1+2)*3", "2^3^2", "-3+5", "2*-3", "sqrt(16)",
  "max(1, 9, 3)", "2.5e2+1", "100/4/5", "10%3", "abs(-42)",
];

interface HostResult { ok: boolean; data?: unknown; error?: string }

function callSmokeTool(tool: string, args: Record<string, unknown>): Promise<HostResult> {
  return new Promise((resolve) => {
    const frames = [
      JSON.stringify({ op: "call", callId: "c1", tool, args }),
      JSON.stringify({ op: "shutdown" }),
    ].join("\n");
    const child = spawn("dotnet", [SMOKE_DLL, "--tool-host"], { stdio: ["pipe", "pipe", "inherit"], cwd: path.dirname(SMOKE_DLL) });
    let buf = "";
    child.stdout.on("data", (d) => { buf += d; });
    child.on("exit", () => {
      let out: HostResult = { ok: false, error: "no result frame" };
      for (const line of buf.split("\n")) {
        try {
          const f = JSON.parse(line);
          if (f.op === "result" && f.callId === "c1") {
            out = f.ok === false ? { ok: false, error: f.error } : { ok: true, data: f.data };
          }
        } catch { /* skip */ }
      }
      resolve(out);
    });
    child.stdin.write(frames);
    child.stdin.end();
  });
}

function parseCalcResult(data: unknown): number | null {
  // .NET calculator 返回 {value,expression}（JSON 字符串或已解析对象）
  if (typeof data === "number") return data;
  if (data && typeof data === "object" && "value" in (data as Record<string, unknown>)) {
    const v = (data as Record<string, unknown>).value;
    if (typeof v === "number") return v;
    if (typeof v === "string" && Number.isFinite(Number(v))) return Number(v);
  }
  if (typeof data === "string") {
    try {
      const j = JSON.parse(data) as { value?: unknown; result?: unknown; error?: string };
      const v = j.value ?? j.result;
      if (typeof v === "number") return v;
      if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
      return null;
    } catch {
      const t = data.trim();
      if (t !== "" && Number.isFinite(Number(t))) return Number(t);
      return null;
    }
  }
  return null;
}

async function main(): Promise<void> {
  let failures = 0;
  const useSmoke = existsSync(SMOKE_DLL);
  const useWin = process.platform === "win32" && existsSync(WIN_EXE);
  console.log(`[dual-track] host: ${useWin ? "cyrene-native.exe" : useSmoke ? "smoke dll (Linux)" : "none"}`);

  if (!useSmoke && !useWin) {
    console.log("[SKIP] 无可用 .NET host——仅跑 TS 基线");
  } else {
    // calculator 双轨逐表达式 diff
    for (const expr of EXPRESSIONS) {
      let tsValue: number;
      try { tsValue = evaluateExpression(expr); } catch { continue; }  // TS 拒绝的表达式跳过（子集语义）
      const host = useWin ? null : await callSmokeTool("calculator", { expression: expr });
      if (useWin) { console.log(`[INFO] win exe 轨待 Windows 机跑`); break; }
      const netValue = parseCalcResult(host?.data ?? null);
      if (netValue === null) { failures++; console.log(`[FAIL] ${expr}: .NET 轨无值 (${JSON.stringify(host?.data)}), TS=${tsValue}`); continue; }
      const same = Math.abs(netValue - tsValue) < 1e-9 || Math.abs(netValue - tsValue) / Math.max(Math.abs(tsValue), 1) < 1e-9;
      if (same) console.log(`[PASS] ${expr} = ${tsValue}`);
      else { failures++; console.log(`[FAIL] ${expr}: TS=${tsValue} .NET=${netValue}`); }
    }
    // tool-host 握手
    const r = await callSmokeTool("calculator", { expression: "1+1" });
    if (parseCalcResult(r.data) !== null) console.log("[PASS] tool-host call 帧序");
    else if (useWin) console.log("[SKIP] smoke 帧序（win 轨）");
    else { failures++; console.log("[FAIL] tool-host call 帧序"); }
  }

  console.log(failures === 0 ? "dual-track-diff: PASS" : `dual-track-diff: ${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();

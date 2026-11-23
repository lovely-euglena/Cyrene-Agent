#!/usr/bin/env node
/**
 * #257 T6 真机回归——数据收集器（qwen-bot PR !262 测试表的机械执行面）。
 *
 * 与 eval-log.mjs 的分工：
 *   - eval-log：单动作 JSONL 落盘（--run/--diff 机械执行）；
 *   - collect-t6：一次 T6 会话的批量采集——环境探测 + 逐测试项执行 + 汇总报告。
 *
 * 用法：
 *   node scripts/live2d/collect-t6.mjs --env gpu1                # 环境标签（写入每条记录）
 *   node scripts/live2d/collect-t6.mjs --items T6-1,T6-2,T6-4    # 只跑子集（默认全表）
 *   node scripts/live2d/collect-t6.mjs --web-only                # 只跑 web 轨（dotnet exe 缺失时）
 *
 * 输出：
 *   - docs/eval/257-t6-<env>-<ts>.jsonl   每测试项一条（兼容 eval-log 的消费格式）
 *   - docs/eval/257-t6-<env>-<ts>.md      单轮 markdown 报告（贴 PR/issue 用）
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");
const EVAL_DIR = path.join(REPO_ROOT, "docs", "eval");

function getArg(argv, name, dflt = null) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
}
const hasArg = (argv, name) => argv.includes(name);

const ENV_TAG = getArg(process.argv, "--env", "unknown");
const WEB_ONLY = hasArg(process.argv, "--web-only");
const itemsFilter = getArg(process.argv, "--items", null);
const wanted = itemsFilter ? new Set(itemsFilter.split(",").map((x) => x.trim())) : null;

// ── T6 测试表（与 docs/eval/257-t6-checklist.md 一一对应）──
// exec: 本机命令；collect: 结果如何进 JSONL；threshold: 判定线
const TEST_TABLE = [
  {
    id: "T6-1", name: "渲染像素一致性（web vs dotnet 同帧对照）",
    collect: "diff",
    threshold: 0.5, // percent
    run: () => ({
      kind: "manual-hook",
      note: "先 node scripts/live2d/sidecar-capture.mjs 取 dotnet 帧，再 node scripts/live2d/web-capture.cjs 取 web 帧，最后 --diff 两帧。此脚本只登记结果，截图动作由测试者按 checklist 执行。",
    }),
  },
  {
    id: "T6-2", name: "动作/口型时序（motion 触发→首帧渲染延迟）",
    collect: "run",
    threshold: null, // 定性：首帧 <200ms、循环无卡顿
    run: () => ({
      cmd: "node",
      args: ["scripts/live2d/motion-probe.mjs"],
    }),
  },
  {
    id: "T6-3", name: "多 DPI 缩放（100%/150%/200% 三档窗口尺寸+命中区）",
    collect: "manual",
    threshold: null,
    run: () => ({ kind: "manual", note: "按 checklist 手工切换 DPI 三档，记录窗口物理尺寸与点击命中区偏差像素值" }),
  },
  {
    id: "T6-4", name: "内存与帧率（空转 10min 采样）",
    collect: "run",
    threshold: null, // 判定：帧率 >=55fps、内存漂移 <30MB
    run: () => ({
      kind: "perf-hook",
      note: "侧车 stderr log（帧泵周期/工作集）由测试者从 exe 日志截取；本脚本登记摘录路径",
    }),
  },
  {
    id: "T6-5", name: "点击穿透与拖拽（分层窗口 WS_EX_TRANSPARENT 三区）",
    collect: "manual",
    threshold: null,
    run: () => ({ kind: "manual", note: "透明区/模型区/边缘带三分区手工点击，记录穿透与否+拖动偏差" }),
  },
  {
    id: "T6-6", name: "DXGI 适配器选择（多适配器机器）",
    collect: "env",
    threshold: null,
    run: () => ({ kind: "probe", note: "stderr 首行 [d3d11] adapter= 记录" }),
  },
];

// ── 环境探测 ──
function probeEnv() {
  const env = {
    envTag: ENV_TAG,
    host: os.hostname(),
    platform: os.platform(),
    release: os.release(),
    gpus: [],
    webOnly: WEB_ONLY,
    probedAt: new Date().toISOString(),
  };
  if (process.platform === "win32") {
    const wmic = spawnSync("wmic", ["path", "win32_VideoController", "get", "name,AdapterRAM", "/format:list"], { encoding: "utf8", timeout: 15000 });
    if (wmic.status === 0) {
      const blocks = wmic.stdout.split(/\r?\n\r?\n/);
      for (const b of blocks) {
        const name = /Name=(.+)/.exec(b)?.[1]?.trim();
        const ram = /AdapterRAM=(\d+)/.exec(b)?.[1];
        if (name) env.gpus.push({ name, adapterRAM: ram ? Number(ram) : null });
      }
    }
    const dpi = spawnSync("reg", ["query", "HKCU\\Control Panel\\Desktop", "/v", "LogPixels"], { encoding: "utf8", timeout: 10000 });
    env.logPixels = /LogPixels\s+REG_DWORD\s+0x(\w+)/.exec(dpi.stdout ?? "")?.[1] ?? null;
  }
  return env;
}

// ── 主流程 ──
const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const base = `257-t6-${ENV_TAG}-${ts}`;
fs.mkdirSync(EVAL_DIR, { recursive: true });
const jsonlPath = path.join(EVAL_DIR, `${base}.jsonl`);
const mdPath = path.join(EVAL_DIR, `${base}.md`);
const jsonl = fs.createWriteStream(jsonlPath, { flags: "a" });
const report = [`# T6 真机回归报告（env=${ENV_TAG}，${new Date().toISOString()}）`, "", "## 环境", "", "```json"];

const env = probeEnv();
report.push(JSON.stringify(env, null, 2), "```", "", "## 结果", "");
jsonl.write(JSON.stringify({ task: "T6", op: "env", result: "pass", data: env, ts: env.probedAt }) + "\n");

const rows = [];
for (const item of TEST_TABLE) {
  if (wanted && !wanted.has(item.id)) continue;
  const row = { task: item.id, name: item.name, collect: item.collect, threshold: item.threshold };
  const started = Date.now();
  if (item.collect === "run" && item.run().cmd) {
    const spec = item.run();
    const r = spawnSync(spec.cmd, spec.args, { encoding: "utf8", timeout: 120000, cwd: REPO_ROOT });
    row.exitCode = r.status;
    row.result = r.status === 0 ? "pass" : "fail";
    row.stdoutTail = (r.stdout ?? "").splitlines?.() ?? String(r.stdout ?? "").slice(-800);
    row.durationMs = Date.now() - started;
  } else {
    const spec = item.run();
    row.kind = spec.kind;
    row.note = spec.note;
    row.result = "pending"; // 等测试者回填（--result 覆盖）
  }
  rows.push(row);
  jsonl.write(JSON.stringify({ task: item.id, op: "collect", ...row, ts: new Date().toISOString() }) + "\n");
  report.push(`### ${item.id} ${item.name}`, "", `- collect: ${row.collect}  result: **${row.result}**${row.threshold != null ? `  (阈值 ${row.threshold})` : ""}`, row.note ? `- 动作: ${row.note}` : "", row.exitCode != null ? `- exitCode: ${row.exitCode} (${row.durationMs}ms)` : "", "");
}

report.push("## 待回填清单", "");
for (const r of rows.filter((x) => x.result === "pending")) {
  report.push(`- [ ] ${r.task} ${r.name}`);
}
report.push("", "回填方式：`node scripts/live2d/eval-log.mjs --task <id> --action read --target <path> --result pass|fail --note \"...\"`（追加进同一 JSONL）");

jsonl.end();
fs.writeFileSync(mdPath, report.join("\n") + "\n");
console.log(`[collect-t6] JSONL → ${jsonlPath}`);
console.log(`[collect-t6] 报告 → ${mdPath}`);

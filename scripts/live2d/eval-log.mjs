#!/usr/bin/env node
/**
 * #257 测评 JSONL 落盘（issue 评论 4 采集原则的机械执行器）。
 *
 * 原则：
 *   - result 以测试退出码为准 → --run 模式 spawnSync 取 exit code；
 *   - diff_pct 必须由脚本产出 → --diff 模式调 pixel-diff.mjs 解析其 stdout JSON；
 *   - 每轮一条，追加写 docs/eval/257-live2d.jsonl（--file 可覆盖）。
 *
 * 用法：
 *   node scripts/live2d/eval-log.mjs --task T5 --action run --note "T5 单测" \
 *        --run "pnpm vitest run src/main/live2d --pool=threads"
 *   node scripts/live2d/eval-log.mjs --task T6 --action diff --note "蒙版对照" \
 *        --diff web.png dotnet.png [--threshold 2]
 *   node scripts/live2d/eval-log.mjs --task T2 --action read --target path --result pass --note "..."
 *        （手工记录仅限非测试动作；测试必须走 --run/--diff）
 *
 * tokens 字段无法在进程侧可靠计量 → 恒 null（报告侧从会话日志补列）。
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");
const DEFAULT_FILE = path.join(REPO_ROOT, "docs", "eval", "257-live2d.jsonl");

function getArg(argv, name, dflt = null) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt;
}

function append(file, entry) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(entry) + "\n");
  console.log(JSON.stringify(entry));
}

function main() {
  const argv = process.argv.slice(2);
  const file = getArg(argv, "--file", DEFAULT_FILE);
  const task = getArg(argv, "--task", "?");
  const note = getArg(argv, "--note", "");
  const ts = new Date().toISOString();

  const runCmd = getArg(argv, "--run");
  const diffArgs = (() => {
    const i = argv.indexOf("--diff");
    return i >= 0 ? argv.slice(i + 1, i + 3) : null;
  })();

  if (runCmd) {
    // result 以退出码为准；stdout/stderr 尾部进 note 便于报告溯源
    const proc = spawnSync(runCmd, { shell: true, cwd: REPO_ROOT, encoding: "utf8", timeout: 30 * 60_000 });
    const tail = (proc.stdout || "").trim().split("\n").slice(-3).join(" | ");
    const entry = {
      ts, task, action: getArg(argv, "--action", "run"),
      target: getArg(argv, "--target", runCmd),
      tokens: null,
      result: proc.status === 0 ? "pass" : "fail",
      diff_pct: null,
      note: [note, `exit=${proc.status}`, tail].filter(Boolean).join(" — "),
    };
    append(file, entry);
    process.exit(proc.status === 0 ? 0 : 1);
  }

  if (diffArgs && diffArgs.length === 2 && !diffArgs[1].startsWith("--")) {
    // diff_pct 取自 pixel-diff.mjs 的 stdout JSON（脚本产出，非自报）
    const extra = [];
    const th = getArg(argv, "--threshold");
    if (th) extra.push("--threshold", th);
    const proc = spawnSync(process.execPath, [path.join(HERE, "pixel-diff.mjs"), ...diffArgs, ...extra], {
      cwd: REPO_ROOT, encoding: "utf8", timeout: 5 * 60_000,
    });
    let report = null;
    try { report = JSON.parse(proc.stdout); } catch { /* 下方按 fail 记录 */ }
    const entry = {
      ts, task, action: "diff",
      target: getArg(argv, "--target", `${diffArgs[0]} vs ${diffArgs[1]}`),
      tokens: null,
      result: proc.status === 0 ? "pass" : "fail",
      diff_pct: report && typeof report.diff_pct === "number" ? report.diff_pct : null,
      note: [note, report ? `exit=${proc.status} pixels=${report.diff_pixels}/${report.total_pixels}` : `exit=${proc.status} 无 JSON 输出`].filter(Boolean).join(" — "),
    };
    append(file, entry);
    process.exit(proc.status === 0 ? 0 : 1);
  }

  // 手工记录（read/edit 等非测试动作）
  const result = getArg(argv, "--result");
  if (!result || !["pass", "fail"].includes(result)) {
    console.error("用法: --run <cmd> | --diff a.png b.png | --result pass|fail（手工记录）");
    process.exit(2);
  }
  const diffPct = getArg(argv, "--diff-pct");
  append(file, {
    ts, task, action: getArg(argv, "--action", "read"),
    target: getArg(argv, "--target", ""),
    tokens: null,
    result,
    diff_pct: diffPct !== null ? Number(diffPct) : null,
    note,
  });
}

main();

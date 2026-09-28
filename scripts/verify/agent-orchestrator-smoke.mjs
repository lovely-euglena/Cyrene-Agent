#!/usr/bin/env node
/**
 * agent-orchestrator 协议冒烟（不依赖 Electron）。
 *
 * 用 stub worker 扮演 TS 侧，验证 .NET 编排器的完整机制：
 *   ready 握手 → group.create → turn.start（三步 pipeline，含邮箱投递）
 *   → step_result 回注 → turn.result
 *   → host 侧 turn.cancel（step.cancel 帧 + cancelled 收口）
 *   → group.list / mailbox.list / group.destroy / shutdown
 *
 * 运行前先构建：
 *   dotnet build dotnet/native-windows/CyreneNative.csproj
 * 运行：
 *   npm run verify:agent-orchestrator
 *   （或直接 node scripts/verify/agent-orchestrator-smoke.mjs）
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const candidates = [
  path.join(repoRoot, "dotnet/native-windows/bin/Debug/net10.0-windows/cyrene-native.exe"),
  path.join(repoRoot, "dotnet/native-windows/bin/Release/net10.0-windows/cyrene-native.exe"),
];
const exe = candidates.find((candidate) => fs.existsSync(candidate));
if (!exe) {
  console.error("[smoke] 未找到 cyrene-native.exe，先执行: dotnet build dotnet/native-windows/CyreneNative.csproj");
  process.exit(2);
}

const child = spawn(exe, ["--agent-orchestrator"], { stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
if (!child.stdin || !child.stdout) {
  console.error("[smoke] 子进程管道不可用");
  process.exit(2);
}

let finished = false;
let nextId = 1;
let holdNextStep = false;
let heldStepWaiter = null;
const pendingRequests = new Map();
const pendingTurns = new Map();
const hostEvents = [];
const stepLog = [];
const cancelledSteps = [];
const failures = [];

function fail(message) {
  failures.push(message);
  console.error(`[smoke] FAIL: ${message}`);
}

function send(frame) {
  child.stdin.write(`${JSON.stringify(frame)}\n`);
}

function request(op, payload) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`请求超时: ${op}`));
    }, 8000);
    pendingRequests.set(id, {
      resolve: (data) => { clearTimeout(timer); resolve(data); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
    send({ id, op, ...payload });
  });
}

function waitTurn(callId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`turn.result 超时: ${callId}`)), 10_000);
    pendingTurns.set(callId, (result) => { clearTimeout(timer); resolve(result); });
  });
}

/** 保留一个 step 不回复，用于验证 host 侧 cancel 链路。 */
function waitHeldStep() {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("held step 超时")), 8000);
    heldStepWaiter = (frame) => { clearTimeout(timer); resolve(frame); };
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** stub worker：planner → 计划；executor → 执行；reviewer → 复核。 */
function stubStepResult(step, options = {}) {
  const index = step.index ?? 0;
  const mailboxText = Array.isArray(step.mailbox) && step.mailbox.length > 0 ? String(step.mailbox[0].text ?? "") : "";
  if (options.cancel) {
    return { op: "step_result", callId: step.callId, stepId: step.stepId, sessionId: step.sessionId, ok: false, status: "cancelled", error: "已取消" };
  }
  const answer = index === 0
    ? "计划：先计算 6*7"
    : index === 1
      ? `执行完成：${mailboxText} → 42`
      : "复核通过：42 正确";
  return { op: "step_result", callId: step.callId, stepId: step.stepId, sessionId: step.sessionId, ok: true, status: "success", finalAnswer: answer, rounds: 1 };
}

let resolveReady;
let rejectReady;
const readyPromise = new Promise((resolve, reject) => {
  resolveReady = resolve;
  rejectReady = reject;
});
const readyTimer = setTimeout(() => rejectReady(new Error("ready 握手超时")), 8000);

readline.createInterface({ input: child.stdout }).on("line", (line) => {
  if (!line.trim()) return;
  let frame;
  try { frame = JSON.parse(line); } catch { return; }

  // 请求应答帧
  if (typeof frame.id === "number" && frame.op === undefined) {
    const pending = pendingRequests.get(frame.id);
    if (!pending) return;
    pendingRequests.delete(frame.id);
    if (frame.ok === true) pending.resolve(frame.data);
    else pending.reject(new Error(String(frame.error ?? "请求失败")));
    return;
  }

  switch (frame.op) {
    case "ready":
      clearTimeout(readyTimer);
      resolveReady();
      break;
    case "step": {
      stepLog.push(frame);
      if (frame.index > 0 && (!Array.isArray(frame.mailbox) || frame.mailbox.length === 0)) {
        fail(`step ${frame.stepId} 缺上游邮箱投递`);
      }
      if (holdNextStep) {
        holdNextStep = false;
        heldStepWaiter?.(frame);
        break;
      }
      send(stubStepResult(frame));
      break;
    }
    case "step.cancel":
      cancelledSteps.push(frame.stepId);
      break;
    case "turn.result": {
      const resolver = pendingTurns.get(frame.callId);
      if (resolver) { pendingTurns.delete(frame.callId); resolver(frame); }
      break;
    }
    case "event":
      hostEvents.push(frame);
      break;
    case "log":
      console.error(`[smoke] host log: ${frame.message}`);
      break;
    default:
      break;
  }
});

child.on("exit", (code) => {
  if (!finished) fail(`host 提前退出 code=${code}`);
});

async function main() {
  await readyPromise;
  console.log("[smoke] ready ✓");

  await request("group.create", {
    groupId: "g1",
    members: [
      { sessionId: "s1", role: "planner" },
      { sessionId: "s2", role: "executor" },
      { sessionId: "s3", role: "reviewer" },
    ],
    pipeline: ["s1", "s2", "s3"],
    stepTimeoutMs: 30_000,
  });
  console.log("[smoke] group.create ✓");

  // ── 正常流水线 ──
  const turn1 = waitTurn("t1");
  await request("turn.start", { callId: "t1", groupId: "g1", message: "6*7 等于几？" });
  const result1 = await turn1;
  if (result1.status !== "success") fail(`turn1 状态=${result1.status}`);
  if (result1.finalAnswer !== "复核通过：42 正确") fail(`turn1 finalAnswer=${result1.finalAnswer}`);
  const t1Steps = stepLog.filter((step) => step.callId === "t1");
  if (t1Steps.length !== 3) fail(`turn1 step 数=${t1Steps.length}`);
  if (t1Steps.map((step) => step.sessionId).join(",") !== "s1,s2,s3") {
    fail(`turn1 会话顺序=${t1Steps.map((step) => step.sessionId).join(",")}`);
  }
  console.log(`[smoke] turn1 pipeline ✓ (final=${result1.finalAnswer})`);

  // ── host 侧取消：step 挂起 → turn.cancel → step.cancel → worker 回 cancelled ──
  const turn2 = waitTurn("t2");
  holdNextStep = true;
  const heldStepPromise = waitHeldStep();
  await request("turn.start", { callId: "t2", groupId: "g1", message: "再算一次" });
  const heldStep = await heldStepPromise;
  await request("turn.cancel", { callId: "t2" });
  // host 应下发 step.cancel；等待帧到达后回注 cancelled 结果
  for (let i = 0; i < 100 && !cancelledSteps.includes(heldStep.stepId); i++) await sleep(10);
  if (!cancelledSteps.includes(heldStep.stepId)) fail("未收到 host 的 step.cancel 帧");
  send(stubStepResult(heldStep, { cancel: true }));
  const result2 = await turn2;
  if (result2.status !== "cancelled") fail(`turn2 状态=${result2.status}`);
  console.log("[smoke] turn.cancel → step.cancel → cancelled ✓");

  // ── 查询与销毁 ──
  const list = await request("group.list", {});
  const group = list.groups?.find((item) => item.groupId === "g1");
  if (!group) fail("group.list 缺 g1");
  if (group.pipeline?.length !== 3) fail("group.pipeline 长度异常");
  console.log(`[smoke] group.list ✓ (state=${group.state}, members=${group.members.length})`);

  const mailbox = await request("mailbox.list", { sessionId: "s2" });
  if (!Array.isArray(mailbox.items)) fail("mailbox.list 异常");
  console.log(`[smoke] mailbox.list ✓ (items=${mailbox.items.length})`);

  await request("group.destroy", { groupId: "g1" });
  console.log("[smoke] group.destroy ✓");

  if (!hostEvents.some((event) => event.name === "group.running")) fail("缺 group.running 事件");

  send({ op: "shutdown" });
  finished = true;
  await new Promise((resolve) => child.once("exit", resolve));

  if (failures.length > 0) {
    console.error(`[smoke] FAILED (${failures.length}):\n  - ${failures.join("\n  - ")}`);
    process.exit(1);
  }
  console.log("[smoke] PASS");
}

main().catch((error) => {
  console.error(`[smoke] 异常: ${error instanceof Error ? error.message : error}`);
  try { child.kill(); } catch { /* ignore */ }
  process.exit(1);
});

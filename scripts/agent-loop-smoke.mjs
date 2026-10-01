#!/usr/bin/env node
/**
 * 纯后端 Agent 循环测试版冒烟（--agent-loop）。
 *
 * 两部分：
 *   A. tool-host 探针（P1-P4）：不经 LLM，直接对 --tool-host 打帧，
 *      暴露宿主既有缺陷（截断标记/缺参/NaN 序列化/坏入参错误契约）。
 *   B. 循环场景（mock LLM + 真实 cyrene-native --agent-loop）：
 *      无工具收口、单/并行工具、工具全失败、坏 JSON、HTTP 500、重试、
 *      轮次上限、空参数、缺 id、null 回答、空 tool_calls、大文件截断、
 *      NaN 序列化、非字符串参数、剪贴板只读守卫、超时、空 choices、用法错误。
 *
 * 运行前: dotnet build dotnet/native-windows/CyreneNative.csproj
 * 运行:   node scripts/agent-loop-smoke.mjs
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const exeCandidates = [
  path.join(repoRoot, "dotnet/native-windows/bin/Debug/net10.0-windows/cyrene-native.exe"),
  path.join(repoRoot, "dotnet/native-windows/bin/Release/net10.0-windows/cyrene-native.exe"),
];
const exe = exeCandidates.find((candidate) => fs.existsSync(candidate));
if (!exe) {
  console.error("[smoke] 未找到 cyrene-native.exe，先执行: dotnet build dotnet/native-windows/CyreneNative.csproj");
  process.exit(2);
}

// ── 测试夹具：600 行大文件（fs_read 默认只读 500 行 → 截断应为 true） ──
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-loop-fixture-"));
const fixtureFile = path.join(fixtureDir, "big.txt");
fs.writeFileSync(
  fixtureFile,
  Array.from({ length: 600 }, (_, i) => `line-${String(i + 1).padStart(4, "0")} ${"x".repeat(90)}`).join("\n"),
  "utf8",
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── mock LLM 服务器 ─────────────────────────────────────────
async function startMock(scenario, env = {}) {
  const proc = spawn(process.execPath, [path.join(repoRoot, "scripts/mock-llm-server.mjs"), "--scenario", scenario], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const port = await new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: proc.stdout });
    const timer = setTimeout(() => reject(new Error(`mock(${scenario}) 启动超时`)), 5000);
    rl.on("line", (line) => {
      try {
        const parsed = JSON.parse(line);
        if (parsed.port) {
          clearTimeout(timer);
          resolve(parsed.port);
        }
      } catch {
        /* 非 JSON 忽略 */
      }
    });
  });
  const stderrLines = [];
  readline.createInterface({ input: proc.stderr }).on("line", (line) => stderrLines.push(line));
  return { proc, port, stderr: () => stderrLines.join("\n"), stop: () => { try { proc.kill(); } catch { /* ignore */ } } };
}

// ── 跑一次 --agent-loop ────────────────────────────────────
async function runLoop(args, { timeoutMs = 20000 } = {}) {
  const started = Date.now();
  const proc = spawn(exe, ["--agent-loop", ...args], { stdio: ["ignore", "pipe", "pipe"] });
  const frames = [];
  const malformed = [];
  let stderr = "";
  readline.createInterface({ input: proc.stdout }).on("line", (line) => {
    if (!line.trim()) return;
    try {
      frames.push(JSON.parse(line));
    } catch {
      malformed.push(line);
    }
  });
  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (chunk) => { stderr += chunk; });
  const exitCode = await new Promise((resolve) => {
    const timer = setTimeout(() => { try { proc.kill(); } catch { /* ignore */ } resolve(-9); }, timeoutMs);
    proc.on("exit", (code) => { clearTimeout(timer); resolve(code); });
  });
  return { frames, malformed, stderr, exitCode, elapsedMs: Date.now() - started };
}

const ops = (ctx, name) => ctx.frames.filter((frame) => frame.op === name);
const first = (ctx, name) => ops(ctx, name)[0];
const last = (ctx, name) => ops(ctx, name).at(-1);

/** 每个场景通用检查：stdout 必须全是合法 JSON 帧。 */
function commonChecks(ctx) {
  const errors = [];
  if (ctx.malformed.length > 0) errors.push(`stdout 混入非 JSON 行 ${ctx.malformed.length} 条: ${ctx.malformed[0].slice(0, 120)}`);
  return errors;
}

// ── B. 循环场景 ─────────────────────────────────────────────
const scenarios = [
  {
    id: "no_tool",
    title: "无工具直接收口（Unicode/多行/特殊字符转义往返）",
    args: (port) => ["--base-url", `http://127.0.0.1:${port}/v1`, "--model", "mock",
      "--prompt", '他说："你好"\n第二行 🎉 <tag> & \\ 反斜杠', "--max-rounds", "4"],
    check(ctx) {
      const errors = commonChecks(ctx);
      if (ctx.exitCode !== 0) errors.push(`exit=${ctx.exitCode}（期望 0）`);
      const fin = last(ctx, "final");
      if (!fin) return errors.concat("缺 final 帧");
      if (fin.status !== "success") errors.push(`status=${fin.status}`);
      if (!String(fin.finalAnswer ?? "").includes('他说："你好"')) errors.push("回声不含原 prompt（转义往返失败）");
      if (fin.finalAnswer?.includes("🎉") !== true) errors.push("emoji 往返失败");
      if (ops(ctx, "round").length !== 1) errors.push(`round 帧=${ops(ctx, "round").length}（期望 1）`);
      if (fin.usage?.totalTokens !== 28) errors.push(`usage.totalTokens=${fin.usage?.totalTokens}（期望 28）`);
      return errors;
    },
  },
  {
    id: "single_tool",
    title: "单工具两轮（calculator → 收口带结果）",
    args: (port) => ["--base-url", `http://127.0.0.1:${port}/v1`, "--model", "mock", "--prompt", "6*7 等于几"],
    check(ctx) {
      const errors = commonChecks(ctx);
      if (ctx.exitCode !== 0) errors.push(`exit=${ctx.exitCode}`);
      const results = ops(ctx, "tool_result");
      if (results.length !== 1) errors.push(`tool_result=${results.length}（期望 1）`);
      else {
        if (!results[0].ok) errors.push(`工具失败: ${results[0].errorCode} ${results[0].preview}`);
        if (results[0].name !== "calculator") errors.push(`tool=${results[0].name}`);
      }
      const fin = last(ctx, "final");
      if (!fin || fin.status !== "success") errors.push(`final=${JSON.stringify(fin)}`);
      else if (!fin.finalAnswer.includes("42")) errors.push(`finalAnswer 不含 42: ${fin.finalAnswer}`);
      // 工具调用在第一轮 assistant 帧（最后一轮是收口、无 toolCalls）
      const assistant = ops(ctx, "assistant")[0];
      if (!assistant || assistant.toolCalls?.length !== 1) errors.push("assistant 帧缺 toolCalls");
      else {
        try {
          const parsed = JSON.parse(assistant.toolCalls[0].arguments);
          if (parsed.expression !== "6*7") errors.push(`arguments=${assistant.toolCalls[0].arguments}`);
        } catch {
          errors.push(`arguments 非法 JSON: ${assistant.toolCalls[0].arguments}`);
        }
      }
      if (fin?.rounds !== 2) errors.push(`rounds=${fin?.rounds}（期望 2）`);
      return errors;
    },
  },
  {
    id: "parallel",
    title: "一轮并行两个工具调用（顺序与逐个回注）",
    args: (port) => ["--base-url", `http://127.0.0.1:${port}/v1`, "--model", "mock", "--prompt", "并行算一下"],
    check(ctx) {
      const errors = commonChecks(ctx);
      if (ctx.exitCode !== 0) errors.push(`exit=${ctx.exitCode}`);
      const starts = ops(ctx, "tool_start");
      const results = ops(ctx, "tool_result");
      if (starts.length !== 2) errors.push(`tool_start=${starts.length}（期望 2）`);
      else if (`${starts[0].name},${starts[1].name}` !== "calculator,now") errors.push(`顺序=${starts.map((s) => s.name).join(",")}`);
      if (results.length !== 2 || results.some((r) => !r.ok)) errors.push(`tool_result=${results.length} ok=${results.map((r) => r.ok).join(",")}`);
      const fin = last(ctx, "final");
      if (!fin || fin.status !== "success" || !fin.finalAnswer.includes("c1,c2")) errors.push(`final=${JSON.stringify(fin)}`);
      return errors;
    },
  },
  {
    id: "tool_error",
    title: "工具全失败（未知工具+缺参）不打断循环",
    args: (port) => ["--base-url", `http://127.0.0.1:${port}/v1`, "--model", "mock", "--prompt", "乱调工具"],
    check(ctx) {
      const errors = commonChecks(ctx);
      if (ctx.exitCode !== 0) errors.push(`exit=${ctx.exitCode}`);
      const results = ops(ctx, "tool_result");
      if (results.length !== 2) errors.push(`tool_result=${results.length}（期望 2）`);
      if (results.some((r) => r.ok)) errors.push("存在 ok=true 的结果（期望全失败）");
      const codes = results.map((r) => r.errorCode).sort();
      if (codes.join(",") !== "E_TOOL_FAILED,E_UNKNOWN_TOOL") errors.push(`errorCode=${codes.join(",")}`);
      const fin = last(ctx, "final");
      if (!fin || fin.status !== "success") errors.push(`final=${JSON.stringify(fin)}`);
      return errors;
    },
  },
  {
    id: "bad_json",
    title: "LLM 响应非法 JSON → E_LLM_PARSE",
    args: (port) => ["--base-url", `http://127.0.0.1:${port}/v1`, "--model", "mock", "--prompt", "x"],
    check(ctx) {
      const errors = commonChecks(ctx);
      if (ctx.exitCode !== 1) errors.push(`exit=${ctx.exitCode}（期望 1）`);
      const fin = last(ctx, "final");
      if (!fin || fin.status !== "llm_error" || fin.code !== "E_LLM_PARSE") errors.push(`final=${JSON.stringify(fin)}`);
      return errors;
    },
  },
  {
    id: "http_500",
    title: "HTTP 500（不重试）→ E_LLM_HTTP",
    args: (port) => ["--base-url", `http://127.0.0.1:${port}/v1`, "--model", "mock", "--prompt", "x"],
    check(ctx) {
      const errors = commonChecks(ctx);
      if (ctx.exitCode !== 1) errors.push(`exit=${ctx.exitCode}`);
      const fin = last(ctx, "final");
      if (!fin || fin.code !== "E_LLM_HTTP" || !String(fin.error).includes("500")) errors.push(`final=${JSON.stringify(fin)}`);
      if (ops(ctx, "llm_request").length !== 1) errors.push(`llm_request=${ops(ctx, "llm_request").length}（retries=0 期望 1）`);
      return errors;
    },
  },
  {
    id: "flaky_500",
    title: "--retries 2：两次 500 后第三次成功",
    args: (port) => ["--base-url", `http://127.0.0.1:${port}/v1`, "--model", "mock", "--prompt", "x", "--retries", "2"],
    check(ctx) {
      const errors = commonChecks(ctx);
      if (ctx.exitCode !== 0) errors.push(`exit=${ctx.exitCode}`);
      const requests = ops(ctx, "llm_request").length;
      if (requests !== 3) errors.push(`llm_request=${requests}（期望 3：2 次失败 + 1 次成功）`);
      const warns = ctx.frames.filter((f) => f.op === "log" && f.level === "warn" && String(f.message).includes("重试"));
      if (warns.length !== 2) errors.push(`重试 warn=${warns.length}（期望 2）`);
      const fin = last(ctx, "final");
      if (!fin || fin.status !== "success" || !fin.finalAnswer.includes("三次后成功")) errors.push(`final=${JSON.stringify(fin)}`);
      return errors;
    },
  },
  {
    id: "max_rounds",
    title: "--max-rounds 3：永不收口 → status=max_rounds/exit 3",
    args: (port) => ["--base-url", `http://127.0.0.1:${port}/v1`, "--model", "mock", "--prompt", "x", "--max-rounds", "3"],
    check(ctx) {
      const errors = commonChecks(ctx);
      if (ctx.exitCode !== 3) errors.push(`exit=${ctx.exitCode}（期望 3）`);
      const fin = last(ctx, "final");
      if (!fin || fin.status !== "max_rounds") errors.push(`final=${JSON.stringify(fin)}`);
      if (fin?.rounds !== 3) errors.push(`rounds=${fin?.rounds}（期望 3）`);
      if (fin?.toolCalls !== 3) errors.push(`toolCalls=${fin?.toolCalls}（期望 3）`);
      return errors;
    },
  },
  {
    id: "empty_args",
    title: "工具 arguments 空串 → 按缺参失败，循环继续",
    args: (port) => ["--base-url", `http://127.0.0.1:${port}/v1`, "--model", "mock", "--prompt", "x"],
    check(ctx) {
      const errors = commonChecks(ctx);
      if (ctx.exitCode !== 0) errors.push(`exit=${ctx.exitCode}`);
      const result = ops(ctx, "tool_result")[0];
      if (!result) errors.push("缺 tool_result");
      else {
        if (result.ok) errors.push("空参数应失败");
        if (!String(result.preview).includes("expression")) errors.push(`错误信息未指向缺参: ${result.preview}`);
      }
      const fin = last(ctx, "final");
      if (!fin || fin.status !== "success" || !fin.finalAnswer.includes("空参数收口")) errors.push(`final=${JSON.stringify(fin)}`);
      return errors;
    },
  },
  {
    id: "missing_id",
    title: "tool_call 缺 id → 合成 id + warn，正常执行",
    args: (port) => ["--base-url", `http://127.0.0.1:${port}/v1`, "--model", "mock", "--prompt", "x"],
    check(ctx) {
      const errors = commonChecks(ctx);
      if (ctx.exitCode !== 0) errors.push(`exit=${ctx.exitCode}`);
      // 缺 id 的 tool_call 在第一轮 assistant 帧（最后一轮是收口）
      const assistant = ops(ctx, "assistant")[0];
      const call = assistant?.toolCalls?.[0];
      if (!call || !call.id) errors.push(`缺合成 id: ${JSON.stringify(call)}`);
      else if (call.synthesizedId !== true) errors.push("synthesizedId 标记缺失");
      const warns = ctx.frames.filter((f) => f.op === "log" && f.level === "warn" && String(f.message).includes("合成"));
      if (warns.length === 0) errors.push("缺合成 id 的 warn 日志");
      const result = ops(ctx, "tool_result")[0];
      if (!result || !result.ok) errors.push(`tool_result=${JSON.stringify(result)}`);
      const fin = last(ctx, "final");
      if (!fin || fin.status !== "success" || !fin.finalAnswer.includes("缺 id 收口")) errors.push(`final=${JSON.stringify(fin)}`);
      return errors;
    },
  },
  {
    id: "null_content",
    title: "content=null 且无 tool_calls → 空回答收口 + warn",
    args: (port) => ["--base-url", `http://127.0.0.1:${port}/v1`, "--model", "mock", "--prompt", "x"],
    check(ctx) {
      const errors = commonChecks(ctx);
      if (ctx.exitCode !== 0) errors.push(`exit=${ctx.exitCode}`);
      const fin = last(ctx, "final");
      if (!fin || fin.status !== "success") errors.push(`final=${JSON.stringify(fin)}`);
      if (fin && fin.finalAnswer !== "") errors.push(`finalAnswer 应为空串，实际=${JSON.stringify(fin.finalAnswer)}`);
      const warns = ctx.frames.filter((f) => f.op === "log" && f.level === "warn" && String(f.message).includes("空回答"));
      if (warns.length === 0) errors.push("缺空回答 warn 日志");
      return errors;
    },
  },
  {
    id: "empty_tool_calls",
    title: "tool_calls=[] 空数组 → 视为最终回答",
    args: (port) => ["--base-url", `http://127.0.0.1:${port}/v1`, "--model", "mock", "--prompt", "x"],
    check(ctx) {
      const errors = commonChecks(ctx);
      if (ctx.exitCode !== 0) errors.push(`exit=${ctx.exitCode}`);
      const fin = last(ctx, "final");
      if (!fin || fin.status !== "success" || !fin.finalAnswer.includes("空数组也算回答")) errors.push(`final=${JSON.stringify(fin)}`);
      if (ops(ctx, "round").length !== 1) errors.push(`round=${ops(ctx, "round").length}（期望 1）`);
      return errors;
    },
  },
  {
    id: "fs_read",
    title: "fs_read_file 大文件（600 行读 500 行）→ 循环侧截断",
    args: (port) => ["--base-url", `http://127.0.0.1:${port}/v1`, "--model", "mock", "--prompt", "读文件"],
    env: { LOOP_TEST_FILE: fixtureFile },
    check(ctx) {
      const errors = commonChecks(ctx);
      if (ctx.exitCode !== 0) errors.push(`exit=${ctx.exitCode}`);
      const result = ops(ctx, "tool_result")[0];
      if (!result) errors.push("缺 tool_result");
      else {
        if (!result.ok) errors.push(`工具失败: ${result.errorCode} ${result.preview}`);
        if (!result.truncated) errors.push(`truncated=${result.truncated}（contentLength=${result.contentLength} 期望循环侧截断）`);
        if (result.contentLength <= 16384) errors.push(`contentLength=${result.contentLength}（应 >16384）`);
      }
      const fin = last(ctx, "final");
      if (!fin || fin.status !== "success") errors.push(`final=${JSON.stringify(fin)}`);
      return errors;
    },
  },
  {
    id: "nan",
    title: "sqrt(-1)=NaN → 序列化为 null（TS JSON.stringify 语义）",
    args: (port) => ["--base-url", `http://127.0.0.1:${port}/v1`, "--model", "mock", "--prompt", "负数开方"],
    check(ctx) {
      const errors = commonChecks(ctx);
      if (ctx.exitCode !== 0) errors.push(`exit=${ctx.exitCode}`);
      const result = ops(ctx, "tool_result")[0];
      if (!result) errors.push("缺 tool_result");
      else if (!result.ok) errors.push(`工具失败（NaN 应正常返回）: ${result.errorCode} ${result.preview}`);
      else if (!String(result.preview).includes('"value":null')) errors.push(`NaN 未序列化成 null: ${result.preview}`);
      const fin = last(ctx, "final");
      if (!fin || fin.status !== "success" || !fin.finalAnswer.includes("NaN 收口")) errors.push(`final=${JSON.stringify(fin)}`);
      return errors;
    },
  },
  {
    id: "number_args",
    title: "expression 传数字 → 人话错误（非 .NET 内部异常串）",
    args: (port) => ["--base-url", `http://127.0.0.1:${port}/v1`, "--model", "mock", "--prompt", "x"],
    check(ctx) {
      const errors = commonChecks(ctx);
      if (ctx.exitCode !== 0) errors.push(`exit=${ctx.exitCode}`);
      const result = ops(ctx, "tool_result")[0];
      if (!result) return errors.concat("缺 tool_result");
      if (result.ok) errors.push("数字 expression 应报错");
      if (/InvalidOperationException|requires an element of type|ValueKind/i.test(String(result.preview))) {
        errors.push(`错误信息是 .NET 内部异常串（对模型不友好）: ${result.preview}`);
      }
      if (!String(result.preview).includes("字符串")) errors.push(`缺人话提示: ${result.preview}`);
      return errors;
    },
  },
  {
    id: "clipboard_write",
    title: "剪贴板写调用 → 只读守卫拦截（E_READONLY_TOOL）",
    args: (port) => ["--base-url", `http://127.0.0.1:${port}/v1`, "--model", "mock", "--prompt", "x"],
    check(ctx) {
      const errors = commonChecks(ctx);
      if (ctx.exitCode !== 0) errors.push(`exit=${ctx.exitCode}`);
      const result = ops(ctx, "tool_result")[0];
      if (!result) errors.push("缺 tool_result");
      else {
        if (result.ok) errors.push("剪贴板写未被拦截！");
        if (result.errorCode !== "E_READONLY_TOOL") errors.push(`errorCode=${result.errorCode}`);
      }
      const fin = last(ctx, "final");
      if (!fin || fin.status !== "success" || !fin.finalAnswer.includes("剪贴板守卫收口")) errors.push(`final=${JSON.stringify(fin)}`);
      return errors;
    },
  },
  {
    id: "slow",
    title: "--timeout-ms 600 vs 2.5s 慢响应 → E_LLM_TIMEOUT（不挂死）",
    args: (port) => ["--base-url", `http://127.0.0.1:${port}/v1`, "--model", "mock", "--prompt", "x", "--timeout-ms", "600"],
    check(ctx) {
      const errors = commonChecks(ctx);
      if (ctx.exitCode !== 1) errors.push(`exit=${ctx.exitCode}（期望 1）`);
      const fin = last(ctx, "final");
      if (!fin || fin.status !== "llm_error" || fin.code !== "E_LLM_TIMEOUT") errors.push(`final=${JSON.stringify(fin)}`);
      if (ctx.elapsedMs > 5000) errors.push(`耗时 ${ctx.elapsedMs}ms（超时后疑似挂死）`);
      return errors;
    },
  },
  {
    id: "empty_choices",
    title: "choices 空数组 → E_LLM_EMPTY",
    args: (port) => ["--base-url", `http://127.0.0.1:${port}/v1`, "--model", "mock", "--prompt", "x"],
    check(ctx) {
      const errors = commonChecks(ctx);
      if (ctx.exitCode !== 1) errors.push(`exit=${ctx.exitCode}`);
      const fin = last(ctx, "final");
      if (!fin || fin.code !== "E_LLM_EMPTY") errors.push(`final=${JSON.stringify(fin)}`);
      return errors;
    },
  },
  {
    id: "usage",
    title: "缺 --base-url → 用法错误 exit 2 + E_USAGE",
    mock: null,
    args: () => ["--model", "mock", "--prompt", "x"],
    check(ctx) {
      const errors = commonChecks(ctx);
      if (ctx.exitCode !== 2) errors.push(`exit=${ctx.exitCode}（期望 2）`);
      const err = first(ctx, "error");
      if (!err || err.code !== "E_USAGE") errors.push(`error 帧=${JSON.stringify(err)}`);
      if (first(ctx, "ready")) errors.push("参数错误时不应发 ready");
      return errors;
    },
  },
];

// ── A. tool-host 探针 ──────────────────────────────────────
async function toolHostProbes() {
  const findings = [];
  const proc = spawn(exe, ["--tool-host"], { stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map();
  const frameTimers = new Map();
  let seq = 0;
  let readyResolve;
  const ready = new Promise((resolve) => { readyResolve = resolve; });
  const malformed = [];

  readline.createInterface({ input: proc.stdout }).on("line", (line) => {
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      malformed.push(line);
      return;
    }
    if (frame.op === "ready") readyResolve();
    if (frame.op === "result" && frame.callId && pending.has(frame.callId)) {
      const resolve = pending.get(frame.callId);
      pending.delete(frame.callId);
      clearTimeout(frameTimers.get(frame.callId));
      resolve(frame);
    }
  });
  async function call(tool, args, timeoutMs = 3000) {
    const callId = `probe-${++seq}`;
    const promise = new Promise((resolve, reject) => {
      pending.set(callId, resolve);
      const timer = setTimeout(() => {
        if (pending.delete(callId)) reject(new Error("3s 内无 result 帧（调用挂起）"));
      }, timeoutMs);
      frameTimers.set(callId, timer);
    });
    const frame = { op: "call", callId, tool };
    if (args !== undefined) frame.args = args;
    proc.stdin.write(JSON.stringify(frame) + "\n");
    return promise;
  }

  function probe(title, fn) {
    return fn()
      .then((result) => {
        const issue = typeof result === "string" ? result : null;
        if (issue) findings.push(`[探针] ${title}: ${issue}`);
        console.log(`${issue ? "✗" : "✓"} 探针 ${title}${issue ? " → " + issue : ""}`);
      })
      .catch((error) => {
        findings.push(`[探针] ${title}: ${error.message}`);
        console.log(`✗ 探针 ${title} → ${error.message}`);
      });
  }

  await ready;

  /** 从 result 帧提取错误码：fs 工具错误嵌在 data JSON 里（ok=true），异常走 errorCode。 */
  function errCodeOf(result) {
    if (result.ok === false) return { code: String(result.errorCode ?? ""), detail: String(result.error ?? "") };
    let parsed = result.data;
    if (typeof parsed === "string") {
      try { parsed = JSON.parse(parsed); } catch { parsed = null; }
    }
    if (parsed && typeof parsed === "object" && (parsed.success === false || parsed.errorCode)) {
      return { code: String(parsed.errorCode ?? ""), detail: String(parsed.error ?? "") };
    }
    return { code: "", detail: typeof result.data === "string" ? result.data : JSON.stringify(result.data) };
  }

  // P1：600 行文件按默认 500 行读 → truncated 标记应为 true
  await probe("P1 fs_read_file 截断标记", async () => {
    const result = await call("fs_read_file", { path: fixtureFile });
    if (!result.ok) return `ok=false ${result.errorCode} ${result.error}`;
    let data;
    try {
      data = JSON.parse(result.data);
    } catch {
      return "data 不是 JSON";
    }
    if (data.truncated !== true) return `truncated=${data.truncated}（${data.totalLines} 行只返回 ${data.endLine} 行，应为 true）`;
    return true;
  });

  // P2：缺 args → 期望 E_FS_PATH 的人话校验错误
  await probe("P2 fs_read_file 缺 args", async () => {
    const result = await call("fs_read_file");
    const { code, detail } = errCodeOf(result);
    if (code !== "E_FS_PATH") return `errorCode=${code || "(无)"} detail=${detail.slice(0, 140)}（期望 E_FS_PATH）`;
    return true;
  });

  // P3：calculator sqrt(-1)=NaN → 必须有 result 帧（TS 语义 value=null）
  await probe("P3 calculator NaN 序列化", async () => {
    const result = await call("calculator", { expression: "sqrt(-1)" });
    if (!result.ok) return `ok=false ${result.errorCode} ${String(result.error).slice(0, 140)}`;
    const data = typeof result.data === "string" ? result.data : JSON.stringify(result.data);
    if (!data.includes("value")) return `data=${data.slice(0, 140)}`;
    if (data.includes("NaN")) return `data 含裸 NaN（非法 JSON）: ${data.slice(0, 140)}`;
    if (!data.includes('"value":null')) return `NaN 未序列化成 null: ${data.slice(0, 140)}`;
    return true;
  });

  // P4：path 传数字 → 期望 E_FS_PATH 人话错误
  await probe("P4 fs_read_file path 非字符串", async () => {
    const result = await call("fs_read_file", { path: 123 });
    const { code, detail } = errCodeOf(result);
    if (code !== "E_FS_PATH") return `errorCode=${code || "(无)"} detail=${detail.slice(0, 140)}（期望 E_FS_PATH）`;
    if (/InvalidOperationException|requires an element of type|current state of the object/i.test(detail)) {
      return `错误信息是 .NET 内部异常串: ${detail.slice(0, 140)}`;
    }
    return true;
  });

  proc.stdin.write(JSON.stringify({ op: "shutdown" }) + "\n");
  await sleep(200);
  try { proc.kill(); } catch { /* ignore */ }
  if (malformed.length > 0) findings.push(`[探针] tool-host stdout 混入非 JSON: ${malformed[0].slice(0, 120)}`);
  return findings;
}

// ── 主流程 ──────────────────────────────────────────────────
async function main() {
  console.log(`exe: ${exe}`);
  console.log("── A. tool-host 探针 ──");
  const probeFindings = await toolHostProbes();

  console.log("\n── B. --agent-loop 循环场景 ──");
  const failures = [];
  for (const scenario of scenarios) {
    let mock = null;
    try {
      if (scenario.mock !== null) {
        mock = await startMock(scenario.id, scenario.env ?? {});
        process.stdout.write(`▶ ${scenario.title} ... `);
      } else {
        process.stdout.write(`▶ ${scenario.title} ... `);
      }
      const ctx = await runLoop(scenario.args(mock?.port ?? 0));
      const errors = scenario.check(ctx) ?? [];
      if (errors.length === 0) {
        console.log("✓ PASS");
      } else {
        console.log(`✗ FAIL`);
        for (const error of errors) console.log(`    - ${error}`);
        if (ctx.stderr.trim()) console.log(`    - stderr: ${ctx.stderr.trim().slice(0, 400).replace(/\n/g, "\n      ")}`);
        const fin = last(ctx, "final");
        if (fin) console.log(`    - final: ${JSON.stringify(fin).slice(0, 400)}`);
        failures.push({ id: scenario.id, errors });
      }
    } catch (error) {
      console.log(`✗ ERROR ${error.message}`);
      failures.push({ id: scenario.id, errors: [error.message] });
    } finally {
      mock?.stop();
    }
  }

  console.log("\n── 汇总 ──");
  const total = scenarios.length;
  const passed = total - failures.length;
  console.log(`循环场景: ${passed}/${total} 通过`);
  for (const finding of probeFindings) console.log(`  ${finding}`);
  if (failures.length > 0) {
    console.log(`失败场景: ${failures.map((f) => f.id).join(", ")}`);
    process.exitCode = 1;
  } else if (probeFindings.length > 0) {
    process.exitCode = 1;
  } else {
    console.log("PASS");
  }

  try { fs.rmSync(fixtureDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

main().catch((error) => {
  console.error("[smoke] 异常:", error);
  process.exit(1);
});

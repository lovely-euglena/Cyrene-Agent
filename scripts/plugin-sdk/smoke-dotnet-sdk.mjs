// .NET 插件 SDK 端到端协议自测：构建 SDK + Example，直接喂协议帧验证三类路径。
//
// 覆盖（对应历史故障）：
//   1. 同步 object 工具（echo）与 async Task<T> 工具（echo_async）都要回 result 帧
//      ——旧 SDK 只 await Task<object?>/Task<JsonElement>，Task<string> 静默不回帧
//   2. 宿主 cancel 帧：声明 CancellationToken 的长任务应被中止并回 ok:false
//      ——旧 SDK 无 cancel 通道，宿主只能单方面放弃等待
//   3. 协议主版本不符：回 error(api_version_mismatch) 帧并退出
//   4. 多字节/大结果分帧由宿主侧 dotnet-adapter 单测覆盖，这里只验证协议语义
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const sdkProj = path.join(repoRoot, "dotnet", "plugin-sdk", "Cyrene.PluginSdk", "Cyrene.PluginSdk.csproj");
const exampleProj = path.join(repoRoot, "dotnet", "plugin-sdk", "Example", "HelloDotnet.csproj");
const exampleExe = path.join(repoRoot, "dotnet", "plugin-sdk", "Example", "bin", "Release", "net10.0", "HelloDotnet.exe");

function fail(message) {
  console.error(`[dotnet-sdk-smoke] FAIL: ${message}`);
  process.exit(1);
}

function build(project) {
  execFileSync("dotnet", ["build", project, "-c", "Release", "--nologo", "-v", "q"], {
    cwd: repoRoot,
    stdio: "inherit",
  });
}

build(sdkProj);
build(exampleProj);
if (!existsSync(exampleExe)) fail(`示例 exe 不存在: ${exampleExe}`);

/** 最小协议会话：按行收帧 + 轮询等待谓词命中。 */
class Session {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.child = spawn(exampleExe, [], { cwd: path.dirname(exampleExe), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.buffer = "";
    this.frames = [];
    this.stderr = "";
    this.exitCode = null;
    this.child.stdout.on("data", (chunk) => this.onData(chunk));
    this.child.stderr.on("data", (chunk) => { this.stderr += String(chunk); });
    this.child.on("exit", (code) => { this.exitCode = code; });
  }

  onData(chunk) {
    this.buffer += String(chunk);
    let index;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      try {
        this.frames.push(JSON.parse(line));
      } catch {
        // 非协议输出：忽略
      }
    }
  }

  send(frame) {
    this.child.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  async waitFor(predicate, timeoutMs, label) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.frames.find(predicate);
      if (hit) return hit;
      if (Date.now() > deadline) {
        fail(`${label} 超时；已收帧=${JSON.stringify(this.frames)} stderr=${this.stderr.slice(0, 500)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  async stop() {
    try { this.send({ op: "shutdown" }); } catch { /* 进程可能已退出 */ }
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (this.exitCode === null) this.child.kill();
  }
}

const dataRoot = mkdtempSync(path.join(tmpdir(), "cyrene-dotnet-sdk-"));
try {
  // ── 1. 握手 + 同步工具 + async Task<T> 工具 ──
  {
    const session = new Session(path.join(dataRoot, "h1"));
    session.send({ op: "init", apiVersion: 1, manifest: { id: "hello-dotnet" }, dataDir: path.join(dataRoot, "h1") });
    const ready = await session.waitFor((f) => f.op === "ready", 20_000, "ready 握手");
    const ids = Array.isArray(ready.tools) ? ready.tools.map((t) => t.id) : [];
    if (!ids.includes("echo") || !ids.includes("echo_async")) {
      fail(`ready.tools 缺少 echo/echo_async: ${JSON.stringify(ids)}`);
    }

    session.send({ op: "invoke", callId: "c1", tool: "echo", args: { text: "hi" } });
    const sync = await session.waitFor((f) => f.op === "result" && f.callId === "c1", 10_000, "echo 结果");
    if (sync.ok !== true || sync.data?.echoed !== "hi") fail(`echo 返回不符: ${JSON.stringify(sync)}`);

    session.send({ op: "invoke", callId: "c2", tool: "echo_async", args: { text: "你好" } });
    const asyncResult = await session.waitFor(
      (f) => f.op === "result" && f.callId === "c2",
      10_000,
      "echo_async 结果（Task<string> 路径）",
    );
    if (asyncResult.ok !== true || asyncResult.data !== "async echoed: 你好") {
      fail(`echo_async 未按预期返回: ${JSON.stringify(asyncResult)}`);
    }
    await session.stop();
    console.log("  · 同步 object / async Task<string> 工具均正常回帧");
  }

  // ── 2. 宿主 cancel 帧：在途调用及时中止（CancellationToken 参数） ──
  {
    const session = new Session(path.join(dataRoot, "h2"));
    session.send({ op: "init", apiVersion: 1, manifest: { id: "hello-dotnet" }, dataDir: path.join(dataRoot, "h2") });
    await session.waitFor((f) => f.op === "ready", 20_000, "ready 握手（cancel 用例）");

    const startedAt = Date.now();
    session.send({ op: "invoke", callId: "c3", tool: "echo_slow", args: { ms: 60_000, text: "x" } });
    await new Promise((resolve) => setTimeout(resolve, 300)); // 等 handler 进入 Task.Delay
    session.send({ op: "cancel", id: "c3", reason: "abort" });
    const cancelled = await session.waitFor(
      (f) => f.op === "result" && f.callId === "c3",
      5_000,
      "取消结果（应在取消后立即回帧）",
    );
    if (cancelled.ok !== false || !String(cancelled.error).includes("取消")) {
      fail(`取消后应回 ok:false/取消: ${JSON.stringify(cancelled)}`);
    }
    if (Date.now() - startedAt > 5_000) fail("取消未及时生效");
    await session.stop();
    console.log("  · cancel 帧中止在途调用（CancellationToken）");
  }

  // ── 3. 协议版本不符：error 帧 + 退出 ──
  {
    const session = new Session(path.join(dataRoot, "h3"));
    session.send({ op: "init", apiVersion: 99, manifest: { id: "hello-dotnet" }, dataDir: path.join(dataRoot, "h3") });
    const frame = await session.waitFor((f) => f.op === "error", 10_000, "api_version_mismatch error 帧");
    if (frame.code !== "api_version_mismatch") fail(`error 帧 code 不符: ${JSON.stringify(frame)}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (session.exitCode === null) {
      session.child.kill();
      fail("版本不符时插件未退出");
    }
    console.log("  · 版本不符回 error 帧并退出");
  }

  console.log("[dotnet-sdk-smoke] PASS");
} finally {
  rmSync(dataRoot, { recursive: true, force: true });
}

// .NET 插件 SDK 端到端协议自测：构建 SDK + Example，直接喂协议帧验证各条路径。
//
// 覆盖（对应历史故障与 P1 桥能力）：
//   1. 同步 object 工具（echo）与 async Task<T> 工具（echo_async）都要回 result 帧
//      ——旧 SDK 只 await Task<object?>/Task<JsonElement>，Task<string> 静默不回帧
//   2. v2 桥：ready 声明（protocolVersion/ipc/promptProviders/capabilities）、
//      host→plugin call（ipc.dispatch / prompt.provide / plugin.open）、
//      plugin→host call（events.emit：工具与事件处理两条路径）、
//      notify event.deliver 投递、私有 KV 跨会话持久化、
//      deps.* 直通（channels/llm/secrets/workspace/conversations/scheduler）、
//      命名类型结果 camelCase 序列化
//   3. 宿主 cancel 帧：声明 CancellationToken 的长任务应被中止并回 ok:false
//   4. 协议主版本不符：回 error(api_version_mismatch) 帧并退出
//   5. 多字节/大结果分帧由宿主侧 dotnet-adapter 单测覆盖，这里只验证协议语义
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

let hostCallSeq = 0;

/** 最小协议会话：按行收帧 + 轮询等待谓词命中；插件→宿主 call 自动回 ok（模拟宿主）。 */
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
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        continue; // 非协议输出：忽略
      }
      this.frames.push(frame);
      // 插件 → 宿主 call：自动应答，避免插件侧 pending
      if (frame.op === "call") {
        const reply = this.autoReply(frame.method);
        const payload = { op: "reply", id: frame.id, ok: reply.ok !== false, data: reply.data ?? null };
        if (reply.error) payload.error = reply.error;
        if (reply.code) payload.code = reply.code;
        this.send(payload);
      }
    }
  }

  /** 宿主服务（deps）假应答：按方法返回可断言的数据/错误码 */
  autoReply(method) {
    switch (method) {
      case "deps.channels.has": return { data: true };
      case "deps.secrets.set": return { data: null };
      case "deps.secrets.get": return { data: "secret-v1" };
      case "deps.secrets.delete": return { ok: false, error: "模拟安全存储不可用", code: "E_STORAGE_UNAVAILABLE" };
      case "deps.workspace.getBinding": return { data: { conversationId: "conv-1", root: "C:/ws", displayName: "ws" } };
      case "deps.conversations.list": return {
        data: {
          items: [{ id: "c1", title: "t", mode: "chat", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }],
          nextCursor: null,
        },
      };
      case "deps.scheduler.listTasks": return { data: [] };
      case "deps.llm.generateText": return { data: "llm-ok" };
      default: return { data: null };
    }
  }

  send(frame) {
    this.child.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  /** 发送 host→plugin call 并等待对应 reply */
  async call(method, params, label, timeoutMs = 10_000) {
    const id = `h${++hostCallSeq}`;
    this.send({ op: "call", id, method, params });
    return this.waitFor((f) => f.op === "reply" && f.id === id, timeoutMs, label);
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

function init(session, apiVersion = 1) {
  // protocolVersion 是 v2 桥协商字段；apiVersion 是 manifest 主版本
  session.send({
    op: "init",
    apiVersion,
    protocolVersion: 2,
    manifest: {
      id: "hello-dotnet",
      deps: ["channels", "llm", "secrets", "conversations", "workspace", "scheduler"],
    },
    dataDir: session.dataDir,
  });
}

const dataRoot = mkdtempSync(path.join(tmpdir(), "cyrene-dotnet-sdk-"));
try {
  // ── 1. 握手 + 工具 + v2 桥（IPC / 提示词 / open / 事件 / 存储） ──
  {
    const session = new Session(path.join(dataRoot, "h1"));
    init(session);
    const ready = await session.waitFor((f) => f.op === "ready", 20_000, "ready 握手");
    const ids = Array.isArray(ready.tools) ? ready.tools.map((t) => t.id) : [];
    if (!ids.includes("echo") || !ids.includes("echo_async") || !ids.includes("echo_slow")) {
      fail(`ready.tools 缺少回声工具: ${JSON.stringify(ids)}`);
    }
    if (ready.protocolVersion !== 2) fail(`ready.protocolVersion 应为 2: ${JSON.stringify(ready.protocolVersion)}`);
    if (!Array.isArray(ready.ipc) || !ready.ipc.includes("ping")) fail(`ready.ipc 缺少 ping: ${JSON.stringify(ready.ipc)}`);
    const providers = Array.isArray(ready.promptProviders) ? ready.promptProviders.map((p) => p.id) : [];
    if (!providers.includes("demo")) fail(`ready.promptProviders 缺少 demo: ${JSON.stringify(providers)}`);
    if (ready.capabilities?.open !== true) fail(`ready.capabilities.open 应为 true: ${JSON.stringify(ready.capabilities)}`);
    console.log("  · ready 声明：protocolVersion/ipc/promptProviders/capabilities 齐全");

    // 同步 / 异步工具
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
    console.log("  · 同步 object / async Task<string> 工具均正常回帧");

    // IPC：host→plugin call → reply
    const ipc = await session.call("ipc.dispatch", { channel: "ping", args: [1, 2] }, "ipc.dispatch 应答");
    if (ipc.ok !== true || ipc.data?.pong !== true || ipc.data?.argCount !== 2) {
      fail(`ipc.dispatch 返回不符: ${JSON.stringify(ipc)}`);
    }
    console.log("  · ipc.dispatch 往返（pong + 参数透传）");

    // 提示词 Provider
    const prompt = await session.call(
      "prompt.provide",
      { providerId: "demo", input: { source: "conversation", mode: "chat", userText: "hi" } },
      "prompt.provide 应答",
    );
    if (prompt.ok !== true || !String(prompt.data).includes("demo context for chat")) {
      fail(`prompt.provide 返回不符: ${JSON.stringify(prompt)}`);
    }
    console.log("  · prompt.provide 往返（Provider 收到的 mode 正确）");

    // open 能力
    const open = await session.call("plugin.open", {}, "plugin.open 应答");
    if (open.ok !== true) fail(`plugin.open 未成功: ${JSON.stringify(open)}`);
    console.log("  · plugin.open 往返（OnOpenAsync 被调用）");

    // 宿主事件投递 → 插件处理器回发 events.emit
    session.send({ op: "notify", method: "event.deliver", params: { event: "host:turn:finished", payload: { runId: "r1" } } });
    await session.waitFor(
      (f) => f.op === "call" && f.method === "events.emit" && f.params?.event === "turn_seen",
      5_000,
      "事件处理器回发 events.emit",
    );
    console.log("  · notify event.deliver → 插件处理器执行并回发事件");

    // 工具内 events.emit
    session.send({ op: "invoke", callId: "c3", tool: "emit_event", args: { event: "smoke:ping" } });
    const emitResult = await session.waitFor((f) => f.op === "result" && f.callId === "c3", 10_000, "emit_event 结果");
    if (emitResult.ok !== true || emitResult.data !== "emitted") fail(`emit_event 返回不符: ${JSON.stringify(emitResult)}`);
    await session.waitFor(
      (f) => f.op === "call" && f.method === "events.emit" && f.params?.event === "smoke:ping",
      5_000,
      "工具路径 events.emit",
    );
    console.log("  · 工具路径 events.emit 往返");

    // 私有存储
    session.send({ op: "invoke", callId: "c4", tool: "kv_set", args: { key: "persist", value: { n: 7 } } });
    await session.waitFor((f) => f.op === "result" && f.callId === "c4", 10_000, "kv_set 结果");
    session.send({ op: "invoke", callId: "c5", tool: "kv_get", args: { key: "persist" } });
    const got = await session.waitFor((f) => f.op === "result" && f.callId === "c5", 10_000, "kv_get 结果");
    if (got.ok !== true || got.data?.n !== 7) fail(`kv_get 返回不符: ${JSON.stringify(got)}`);

    // 宿主服务（deps）直通
    session.send({ op: "invoke", callId: "c9", tool: "deps_probe", args: {} });
    const probe = await session.waitFor((f) => f.op === "result" && f.callId === "c9", 10_000, "deps_probe 结果");
    if (probe.ok !== true
      || probe.data?.hasChannel !== true
      || probe.data?.secret !== "secret-v1"
      || probe.data?.bindingRoot !== "C:/ws"
      || probe.data?.conversations !== 1
      || probe.data?.tasks !== 0
      || probe.data?.llm !== "llm-ok") {
      fail(`deps_probe 返回不符: ${JSON.stringify(probe)}`);
    }
    console.log("  · deps.* 直通（channels/llm/secrets/workspace/conversations/scheduler）");

    // 宿主错误码透传 → PluginHostException.Code
    session.send({ op: "invoke", callId: "c10", tool: "deps_error_probe", args: {} });
    const errProbe = await session.waitFor((f) => f.op === "result" && f.callId === "c10", 10_000, "deps_error_probe 结果");
    if (errProbe.ok !== true || errProbe.data?.code !== "E_STORAGE_UNAVAILABLE") {
      fail(`错误码透传不符: ${JSON.stringify(errProbe)}`);
    }
    console.log("  · 宿主错误码透传（PluginHostException.Code）");

    // 命名类型结果 camelCase 序列化（SDK JsonOptions 约定）
    session.send({ op: "invoke", callId: "c11", tool: "shape_probe", args: {} });
    const shape = await session.waitFor((f) => f.op === "result" && f.callId === "c11", 10_000, "shape_probe 结果");
    if (shape.ok !== true || shape.data?.okValue !== true || shape.data?.countValue !== 3
      || Object.prototype.hasOwnProperty.call(shape.data ?? {}, "OkValue")) {
      fail(`命名类型序列化不符: ${JSON.stringify(shape)}`);
    }
    console.log("  · 命名类型结果 camelCase 序列化");

    await session.stop();
    console.log("  · 私有 KV 写入/读取");
  }

  // ── 2. 存储跨会话持久化（同一 dataDir 新进程） ──
  {
    const session = new Session(path.join(dataRoot, "h1"));
    init(session);
    await session.waitFor((f) => f.op === "ready", 20_000, "ready 握手（持久化用例）");
    session.send({ op: "invoke", callId: "c6", tool: "kv_get", args: { key: "persist" } });
    const got = await session.waitFor((f) => f.op === "result" && f.callId === "c6", 10_000, "kv_get 持久化结果");
    if (got.ok !== true || got.data?.n !== 7) fail(`存储未跨进程持久化: ${JSON.stringify(got)}`);
    await session.stop();
    console.log("  · 私有 KV 跨进程持久化");
  }

  // ── 3. 宿主 cancel 帧：在途调用及时中止（CancellationToken 参数） ──
  {
    const session = new Session(path.join(dataRoot, "h3"));
    init(session);
    await session.waitFor((f) => f.op === "ready", 20_000, "ready 握手（cancel 用例）");

    const startedAt = Date.now();
    session.send({ op: "invoke", callId: "c7", tool: "echo_slow", args: { ms: 60_000, text: "x" } });
    await new Promise((resolve) => setTimeout(resolve, 300)); // 等 handler 进入 Task.Delay
    session.send({ op: "cancel", id: "c7", reason: "abort" });
    const cancelled = await session.waitFor(
      (f) => f.op === "result" && f.callId === "c7",
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

  // ── 4. 协议版本不符：error 帧 + 退出 ──
  {
    const session = new Session(path.join(dataRoot, "h4"));
    init(session, 99);
    const frame = await session.waitFor((f) => f.op === "error", 10_000, "api_version_mismatch error 帧");
    if (frame.code !== "api_version_mismatch") fail(`error 帧 code 不符: ${JSON.stringify(frame)}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (session.exitCode === null) {
      session.child.kill();
      fail("版本不符时插件未退出");
    }
    console.log("  · 版本不符回 error 帧并退出");
  }

  // ── 5. 旧宿主（init 无 protocolVersion）：使用 v2 API 的插件应明确失败 ──
  {
    const session = new Session(path.join(dataRoot, "h5"));
    session.send({
      op: "init",
      apiVersion: 1,
      manifest: { id: "hello-dotnet" },
      dataDir: session.dataDir,
    });
    const frame = await session.waitFor((f) => f.op === "error", 10_000, "旧宿主 startup_failed");
    if (frame.code !== "startup_failed") {
      fail(`旧宿主下应回 startup_failed: ${JSON.stringify(frame)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (session.exitCode === null) {
      session.child.kill();
      fail("旧宿主下插件未退出");
    }
    console.log("  · 旧宿主（无 protocolVersion）下 v2 API 声明明确失败");
  }

  console.log("[dotnet-sdk-smoke] PASS");
} finally {
  rmSync(dataRoot, { recursive: true, force: true });
}

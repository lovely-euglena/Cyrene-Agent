/**
 * .NET 插件进程适配器（双轨制第二轨）。
 *
 * 把「独立 .exe 子进程 + stdio JSON 行协议」的 .NET 插件适配成宿主的
 * CyrenePlugin 接口——PluginManager 的 activate/deactivate/工具注册全部
 * 走现有路径，不感知插件是进程内的还是进程外的。
 *
 * 协议（每行一个 JSON 对象，UTF-8，\n 分帧；双向）：
 *
 *   宿主 → 插件：
 *     {"op":"init","apiVersion":1,"manifest":{...},"dataDir":"<插件私有数据目录>"}
 *     {"op":"invoke","callId":"c1","tool":"<pluginId>__<toolId>","args":{...}}
 *     {"op":"shutdown"}                     // 优雅关停；5s 未退出则 SIGKILL
 *
 *   插件 → 宿主：
 *     {"op":"ready","tools":[{id,name,description,inputSchema}...]}   // init 的应答
 *     {"op":"result","callId":"c1","ok":true,"data":{...}}            // invoke 的应答
 *     {"op":"result","callId":"c1","ok":false,"error":"..."}
 *     {"op":"log","level":"info|warn|error","message":"..."}
 *
 * 生命周期与容错：
 *   - register()：spawn → 等 ready（30s 超时）→ 按 ready.tools 注册进 ctx
 *   - unregister()：shutdown → 等自然退出 → 超时 kill
 *   - 运行中意外退出：工具调用立即失败（有调用在途时）；进程不自动重启
 *     （重启策略交给上层管理器，与 node 插件崩溃语义一致）
 *   - stdout 的非 JSON 行（如 .NET 运行时自身输出）忽略并 warn 一次
 */
import { ChildProcess, spawn } from "node:child_process";
import path from "node:path";
import type { PluginRecord } from "./types";
import type { PluginTool } from "./api";
import type { CyrenePlugin, PluginContext } from "./api";

/** 与 C# Cyrene.PluginSdk 的 PluginBase 握手超时（进程冷启动 + .NET 首次 JIT）。 */
const READY_TIMEOUT_MS = 30_000;
/** 优雅关停后允许的自然退出时间。 */
const SHUTDOWN_TIMEOUT_MS = 5_000;
/** init 协议主版本（与 CURRENT_PLUGIN_API_VERSION 对齐，C# SDK 校验）。 */
/** ready.tools 数量上限——防恶意/失控插件撑爆工具注册表。 */
const MAX_TOOLS_PER_PLUGIN = 64;
/** risk 白名单（permission-policy 的 ToolRiskLevel 域 + unknown 拒绝）。 */
const RISK_ALLOWLIST = new Set(["safe", "fs-read", "fs-write", "shell", "network", "input-control"]);
const PROTOCOL_API_VERSION = 1;

interface RemoteTool {
  id: string;
  name: string;
  description: string;
  inputSchema?: unknown;
}

interface PendingCall {
  resolve: (value: string) => void;
  reject: (error: Error) => void;
}

export class DotnetPluginAdapter implements CyrenePlugin {
  private readonly record: PluginRecord;
  private proc: ChildProcess | null = null;
  private pending = new Map<string, PendingCall>();
  private readyResolvers: Array<{
    resolve: (tools: RemoteTool[]) => void;
    reject: (error: Error) => void;
  }> = [];
  private stderrWarned = 0;
  private exited = false;

  constructor(record: PluginRecord) {
    this.record = record;
  }

  async register(ctx: PluginContext): Promise<void> {
    const exe = path.join(this.record.dir, this.record.manifest.entry);
    const dataDir = path.join(
      // 与 node 插件同目录约定：storageRoot/<pluginId>（ctx 已保证可写）
      (ctx as unknown as { storageRoot?: string }).storageRoot ?? path.dirname(exe),
      this.record.manifest.id,
    );

    await new Promise<void>((resolve, reject) => {
      // .dll 产物经 dotnet 启动（Windows .exe 直接 spawn）；dotnet 用
      // 宿主同款运行时目录，避免 PATH 污染
      const isDll = exe.toLowerCase().endsWith(".dll");
      const argv = isDll ? [exe] : [];
      const bin = isDll ? (process.env.DOTNET_HOST_PATH ?? "dotnet") : exe;
      const child = spawn(bin, argv, {
        cwd: this.record.dir,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      this.proc = child;
      this.exited = false;

      child.on("error", (error) => {
        reject(new Error(`dotnet 插件 ${this.record.manifest.id} 启动失败: ${errorMessage(error)}`));
      });
      child.on("exit", (code, signal) => {
        this.exited = true;
        // 在途调用全部失败
        const message = `dotnet 插件 ${this.record.manifest.id} 进程退出 (code=${code} signal=${signal})`;
        for (const [, call] of this.pending) call.reject(new Error(message));
        this.pending.clear();
        for (const r of this.readyResolvers) r.reject(new Error(message));
        this.readyResolvers = [];
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        if (this.stderrWarned < 3) {
          this.stderrWarned += 1;
          console.warn(`[plugin:${this.record.manifest.id}] stderr:`, String(chunk).trim().slice(0, 400));
        }
      });

      child.stdout?.on("data", (chunk: Buffer) => this.consume(chunk));

      // init 握手
      this.send({
        op: "init",
        apiVersion: PROTOCOL_API_VERSION,
        manifest: this.record.manifest,
        dataDir,
      });

      // ready 应答注册工具
      this.waitReady()
        .then((tools) => {
          for (const tool of tools) {
            // 宿主工具 id 规范：{pluginId}_{短id}（单下划线，同 node 轨）
            const shortId = tool.id;
            // 权限闸门（P2 修复）：risk 必须显式声明且在白名单内——
            // 未声明/unknown 的工具直接拒注册（closed world：宿主对
            // .NET 插件的默认姿态是拒绝，而不是 safe 放行）
            const risk = (tool as { risk?: unknown }).risk as PluginTool["risk"];
            if (typeof risk !== "string" || !RISK_ALLOWLIST.has(risk)) {
              throw new Error(
                `dotnet 插件 ${this.record.manifest.id} 工具 ${shortId} 未声明合法 risk（safe/fs-read/fs-write/shell/network/input-control）——拒注册`,
              );
            }
            ctx.registerTool({
              id: `${this.record.manifest.id}_${shortId}`,
              name: tool.name,
              description: tool.description,
              enabled: true,
              risk,
              // schema 形状与 node 插件一致；缺省给空对象 schema
              inputSchema: (tool.inputSchema as PluginTool["inputSchema"]) ?? { type: "object", properties: {} },
              execute: (input) => this.invokeTool(shortId, input),
            });
          }
          if (tools.length > MAX_TOOLS_PER_PLUGIN) {
            throw new Error(`dotnet 插件 ${this.record.manifest.id} 声明 ${tools.length} 个工具（上限 ${MAX_TOOLS_PER_PLUGIN}）——拒载`);
          }
          console.log(`[plugins] dotnet 插件 ${this.record.manifest.id} 就绪，注册 ${tools.length} 个工具`);
          resolve();
        })
        .catch(reject);

      // 整体握手超时兜底
      setTimeout(() => {
        if (!this.exited && this.readyResolvers.length > 0) {
          for (const r of this.readyResolvers) r.reject(new Error(`dotnet 插件 ${this.record.manifest.id} ready 超时（${READY_TIMEOUT_MS}ms）`));
          this.readyResolvers = [];
          this.kill();
        }
      }, READY_TIMEOUT_MS).unref();
    });
  }

  async unregister(): Promise<void> {
    const child = this.proc;
    if (!child || this.exited) return;
    this.send({ op: "shutdown" });
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.kill();
        resolve();
      }, SHUTDOWN_TIMEOUT_MS);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    // 在途调用以退出事件收尾（exit handler 统一 reject）
  }

  // ── 内部 ──

  /** 测试钩子：直接调用 invoke（生产路径经 ctx.registerTool 的 execute 闭包）。 */
  invokeToolForTest(toolId: string, args: Record<string, unknown>): Promise<string> {
    return this.invokeTool(toolId, args);
  }

  private async invokeTool(toolId: string, args: Record<string, unknown>): Promise<string> {
    // 协议层用短 id（SDK 的 CyreneTool 声明键）；宿主前缀只在注册层拼
    return new Promise<string>((resolve, reject) => {
      if (!this.proc || this.exited) {
        reject(new Error(`dotnet 插件 ${this.record.manifest.id} 未运行`));
        return;
      }
      const callId = `c${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      this.pending.set(callId, { resolve, reject });
      this.send({ op: "invoke", callId, tool: toolId, args });
    });
  }

  private waitReady(): Promise<RemoteTool[]> {
    return new Promise<RemoteTool[]>((resolve, reject) => {
      this.readyResolvers.push({ resolve, reject });
    });
  }

  private consume(chunk: Buffer): void {
    const text = String(chunk);
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        // .NET 运行时自身的非协议输出——忽略
        continue;
      }
      this.handleFrame(frame);
    }
  }

  private handleFrame(frame: Record<string, unknown>): void {
    const op = typeof frame.op === "string" ? frame.op : "";
    if (op === "ready") {
      const tools = Array.isArray(frame.tools) ? (frame.tools as RemoteTool[]) : [];
      const resolvers = this.readyResolvers;
      this.readyResolvers = [];
      for (const r of resolvers) r.resolve(tools);
      return;
    }
    if (op === "result") {
      const callId = typeof frame.callId === "string" ? frame.callId : "";
      const call = this.pending.get(callId);
      if (!call) return;
      this.pending.delete(callId);
      if (frame.ok === true) call.resolve(typeof frame.data === "string" ? frame.data : JSON.stringify(frame.data ?? null));
      else call.reject(new Error(typeof frame.error === "string" ? frame.error : "插件工具调用失败"));
      return;
    }
    if (op === "log") {
      const level = typeof frame.level === "string" ? frame.level : "info";
      const message = typeof frame.message === "string" ? frame.message : "";
      const line = `[plugin:${this.record.manifest.id}] ${message}`;
      if (level === "error") console.error(line);
      else if (level === "warn") console.warn(line);
      else console.log(line);
    }
  }

  private send(frame: Record<string, unknown>): void {
    const child = this.proc;
    if (!child || this.exited || !child.stdin || !child.stdin.writable) return;
    child.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  private kill(): void {
    const child = this.proc;
    if (!child || this.exited) return;
    try {
      child.kill();
    } catch {
      // Windows 下 kill() 即 terminate；失败忽略（exit 事件会兜底）
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

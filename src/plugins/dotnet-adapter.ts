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
 *     {"op":"invoke","callId":"c1","tool":"<短id>","args":{...}}
 *     {"op":"shutdown"}                     // 优雅关停；5s 未退出则 SIGKILL
 *
 *   插件 → 宿主：
 *     {"op":"ready","tools":[{id,name,description,inputSchema,risk?}...]}   // init 的应答
 *     {"op":"result","callId":"c1","ok":true,"data":{...}}            // invoke 的应答
 *     {"op":"result","callId":"c1","ok":false,"error":"..."}
 *     {"op":"log","level":"info|warn|error","message":"..."}
 *
 * 生命周期与容错：
 *   - register()：spawn → 等 ready（30s 超时）→ 按 ready.tools 注册进 ctx
 *   - unregister()：shutdown → 等自然退出 → 超时 kill
 *   - 运行中意外退出：在途调用立即失败 + 上报 hooks.onUnexpectedExit（上层更新状态）；
 *     下次工具调用自动重启一次（自愈），失败则报「重启失败」错误
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
const PROTOCOL_API_VERSION = 1;

interface RemoteTool {
  id: string;
  name: string;
  description: string;
  inputSchema?: unknown;
  /** SDK 声明的风险级（可选）：透传给宿主权限策略；非法值忽略 */
  risk?: unknown;
}

interface PendingCall {
  resolve: (value: string) => void;
  reject: (error: Error) => void;
}

/** 宿主权限策略认可的风险级（与 PluginTool.risk 同集合） */
const REMOTE_RISK_VALUES = ["safe", "fs-read", "fs-write", "shell", "network", "input-control"] as const;
type RemoteRisk = (typeof REMOTE_RISK_VALUES)[number];

function parseRemoteRisk(value: unknown): RemoteRisk | undefined {
  return typeof value === "string" && (REMOTE_RISK_VALUES as readonly string[]).includes(value)
    ? (value as RemoteRisk)
    : undefined;
}

export interface DotnetPluginAdapterHooks {
  /** 进程意外退出（非 shutdown）：上层据此更新插件状态与错误信息 */
  onUnexpectedExit?: (pluginId: string, message: string) => void;
  /** 意外退出后自动重启成功：上层恢复运行状态 */
  onRestarted?: (pluginId: string) => void;
}

export class DotnetPluginAdapter implements CyrenePlugin {
  private readonly record: PluginRecord;
  private readonly hooks: DotnetPluginAdapterHooks;
  private proc: ChildProcess | null = null;
  private pending = new Map<string, PendingCall>();
  private readyResolvers: Array<{
    resolve: (tools: RemoteTool[]) => void;
    reject: (error: Error) => void;
  }> = [];
  private stderrWarned = 0;
  private exited = false;
  /** 正常关停进行中：退出不再上报为「意外退出」 */
  private stopping = false;
  /** 启动/重启单飞 */
  private starting: Promise<RemoteTool[]> | null = null;
  /** init 帧下发的插件私有数据目录（ctx.storage.rootDir()） */
  private dataDir = "";

  constructor(record: PluginRecord, hooks: DotnetPluginAdapterHooks = {}) {
    this.record = record;
    this.hooks = hooks;
  }

  async register(ctx: PluginContext): Promise<void> {
    this.stopping = false;
    // 与 node 插件同一目录约定：storage.rootDir() = userData/plugin-data/<pluginId>
    // （旧实现读 ctx.storageRoot 这个不存在的属性，回退成插件安装目录，数据落错位置）
    this.dataDir = ctx.storage.rootDir();

    const tools = await this.startProcess();
    for (const tool of tools) {
      // 宿主工具 id 规范：{pluginId}_{短id}（单下划线，同 node 轨）
      const shortId = tool.id;
      const risk = parseRemoteRisk(tool.risk);
      ctx.registerTool({
        id: `${this.record.manifest.id}_${shortId}`,
        name: tool.name,
        description: tool.description,
        enabled: true,
        ...(risk ? { risk } : {}),
        // schema 形状与 node 插件一致；缺省给空对象 schema
        inputSchema: (tool.inputSchema as PluginTool["inputSchema"]) ?? { type: "object", properties: {} },
        execute: (input) => this.invokeTool(shortId, input),
      });
    }
    console.log(`[plugins] dotnet 插件 ${this.record.manifest.id} 就绪，注册 ${tools.length} 个工具`);
  }

  /** 启动进程并完成 ready 握手；意外退出后由 invokeTool 调用实现自愈重启 */
  private startProcess(): Promise<RemoteTool[]> {
    if (this.starting) return this.starting;
    this.starting = this.spawnAndHandshake().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private spawnAndHandshake(): Promise<RemoteTool[]> {
    const exe = path.join(this.record.dir, this.record.manifest.entry);

    return new Promise<RemoteTool[]>((resolve, reject) => {
      const child = spawn(exe, [], {
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
        this.proc = null;
        // 在途调用全部失败
        const message = `dotnet 插件 ${this.record.manifest.id} 进程退出 (code=${code} signal=${signal})`;
        for (const [, call] of this.pending) call.reject(new Error(message));
        this.pending.clear();
        for (const r of this.readyResolvers) r.reject(new Error(message));
        this.readyResolvers = [];
        if (!this.stopping) {
          console.warn(`[plugins] ${message}（下次工具调用将尝试自动重启）`);
          this.hooks.onUnexpectedExit?.(this.record.manifest.id, message);
        }
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
        dataDir: this.dataDir,
      });

      // 整体握手超时兜底
      const timeout = setTimeout(() => {
        if (!this.exited && this.readyResolvers.length > 0) {
          for (const r of this.readyResolvers) r.reject(new Error(`dotnet 插件 ${this.record.manifest.id} ready 超时（${READY_TIMEOUT_MS}ms）`));
          this.readyResolvers = [];
          this.kill();
        }
      }, READY_TIMEOUT_MS);
      timeout.unref();

      this.waitReady()
        .then((tools) => {
          clearTimeout(timeout);
          resolve(tools);
        })
        .catch((error) => {
          clearTimeout(timeout);
          reject(error);
        });
    });
  }

  async unregister(): Promise<void> {
    this.stopping = true;
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
    // 意外退出后自愈：下次调用先重启进程再发 invoke（重启失败才报错）
    if (!this.proc || this.exited) {
      if (this.stopping) {
        throw new Error(`dotnet 插件 ${this.record.manifest.id} 未运行`);
      }
      try {
        await this.startProcess();
        this.hooks.onRestarted?.(this.record.manifest.id);
      } catch (error) {
        throw new Error(`dotnet 插件 ${this.record.manifest.id} 进程已退出且自动重启失败: ${errorMessage(error)}`);
      }
    }
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

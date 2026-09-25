/**
 * .NET 插件进程适配器（双轨制第二轨）。
 *
 * 把「独立 .exe 子进程 + stdio JSON 行协议」的 .NET 插件适配成宿主的
 * CyrenePlugin 接口——PluginManager 的 activate/deactivate/工具注册全部
 * 走现有路径，不感知插件是进程内的还是进程外的。
 *
 * 协议（每行一个 JSON 对象，UTF-8，\n 分帧；双向）：
 *
 *   v1（工具轨）：
 *   宿主 → 插件：
 *     {"op":"init","apiVersion":1,"protocolVersion":2,"manifest":{...},"dataDir":"<插件私有数据目录>"}
 *     {"op":"invoke","callId":"c1","tool":"<短id>","args":{...}}
 *     {"op":"cancel","id":"c1","reason":"abort|timeout"}   // 尽力取消在途调用（SDK 映射到 CancellationToken）
 *     {"op":"shutdown"}                     // 优雅关停；5s 未退出则 SIGKILL
 *
 *   插件 → 宿主：
 *     {"op":"ready","tools":[{id,name,description,inputSchema,risk?}...]}   // init 的应答
 *     {"op":"result","callId":"c1","ok":true,"data":{...}}            // invoke 的应答
 *     {"op":"result","callId":"c1","ok":false,"error":"..."}
 *     {"op":"log","level":"info|warn|error","message":"..."}
 *     {"op":"error","code":"...","message":"...","fatal":true}        // 致命错误 → 拒绝握手并停止
 *
 *   v2（P1 桥；宿主 init 携带 protocolVersion:2，插件 ready 回 protocolVersion>=2 后启用）：
 *     通用请求/应答：{"op":"call","id":"h1","method":"ipc.dispatch","params":{...}}
 *                    {"op":"reply","id":"h1","ok":true,"data":...} / {"op":"reply","id":"h1","ok":false,"error":"..."}
 *     通知：        {"op":"notify","method":"event.deliver","params":{...}}
 *     方法：
 *       宿主→插件  ipc.dispatch / prompt.provide / plugin.open
 *       插件→宿主  events.emit / events.subscribe / events.unsubscribe
 *                  ipc.register / ipc.unregister
 *                  prompt.register / prompt.unregister
 *                  deps.channels.has
 *                  deps.llm.generateText
 *                  deps.secrets.get / set / delete
 *                  deps.conversations.list / getMessages
 *                  deps.workspace.getBinding
 *                  deps.scheduler.createTask / listTasks / updateTask / deleteTask / getHistory
 *     ready 声明：protocolVersion / tools / ipc / events / promptProviders / capabilities
 *       {"op":"ready","protocolVersion":2,"tools":[...],"ipc":["settings"],
 *        "events":["host:turn:finished"],
 *        "promptProviders":[{"id":"ctx","modes":["code"],"sources":["conversation"]}],
 *        "capabilities":{"open":true}}
 *
 * 兼容性：旧宿主不带 protocolVersion → 插件按 v1 行为工作；旧插件不声明 protocolVersion
 * → 宿主不下发任何 v2 调用（只按 tools 注册）。
 *
 * 生命周期与容错：
 *   - register()：spawn → 等 ready（30s 超时）→ 注册工具 + v2 声明（IPC/事件/提示词/open）
 *   - unregister()：shutdown → 等自然退出 → 超时 kill
 *   - 运行中意外退出：在途调用立即失败 + 撤销本代 v2 注册 + 上报 hooks.onUnexpectedExit；
 *     下次工具调用自动重启一次（自愈），重启 ready 后重建 v2 注册
 *   - stdout 按行分帧：跨 chunk 缓冲 + UTF-8 StringDecoder（大结果/多字节字符不丢帧）
 *   - invoke 兜底超时（默认 300s，CYRENE_PLUGIN_INVOKE_TIMEOUT_MS 可调）+ 工具上下文
 *     AbortSignal 取消；两者都让调用方及时拿到错误，而不是永久 pending
 *   - 协议版本不符：SDK 回 error 帧并退出，宿主拒绝握手（不视为可自愈的意外退出）
 */
import { ChildProcess, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import path from "node:path";
import { isPluginHostError } from "./api";
import type { PluginRecord } from "./types";
import type {
  CyrenePlugin,
  PluginContext,
  PluginConversationListInput,
  PluginDeps,
  PluginLlmGenerateOptions,
  PluginLlmMessage,
  PluginMessagePageInput,
  PluginPromptProvider,
  PluginScheduledTaskInput,
  PluginScheduledTaskPatch,
  PluginTool,
} from "./api";

/** 与 C# Cyrene.PluginSdk 的 PluginBase 握手超时（进程冷启动 + .NET 首次 JIT）。 */
const READY_TIMEOUT_MS = 30_000;
/** 优雅关停后允许的自然退出时间。 */
const SHUTDOWN_TIMEOUT_MS = 5_000;
/** init 协议主版本（manifest 契约，SDK 侧校验，不符回 error 帧并退出）。 */
const PROTOCOL_API_VERSION = 1;
/** v2 桥协议版本：init 下发给 SDK；SDK 需 >=2 才启用 IPC/事件/提示词/open。 */
const PROTOCOL_VERSION = 2;
/**
 * 单次 invoke 的宿主兜底超时：插件挂死/不回帧时不再永久 pending。
 * 正常调用（含本地推理类长任务）不应命中；可用 CYRENE_PLUGIN_INVOKE_TIMEOUT_MS 调整。
 */
const INVOKE_TIMEOUT_MS = (() => {
  const raw = Number(process.env.CYRENE_PLUGIN_INVOKE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 300_000;
})();
/** host→plugin 调用的兜底超时：面板 IPC / prompt.provide / plugin.open。 */
const IPC_DISPATCH_TIMEOUT_MS = 30_000;
/** 提示词注册表一侧 2s 已超时，这里只做兜底清理（避免 pending 泄漏）。 */
const PROMPT_CALL_TIMEOUT_MS = 5_000;
const OPEN_TIMEOUT_MS = 15_000;
/** stdout 单行协议帧上限（字符）：超过视为异常输出丢弃，避免内存无界增长。 */
const MAX_FRAME_BUFFER_CHARS = 4 * 1024 * 1024;

interface RemoteTool {
  id: string;
  name: string;
  description: string;
  inputSchema?: unknown;
  /** SDK 声明的风险级（可选）：透传给宿主权限策略；非法值忽略 */
  risk?: unknown;
}

interface RemotePromptProvider {
  id: string;
  modes?: string[];
  sources?: string[];
}

interface RemoteReady {
  tools: RemoteTool[];
  /** 插件声明支持的桥协议版本；<2 或缺失视为 v1（仅工具） */
  protocolVersion: number;
  ipc: string[];
  events: string[];
  promptProviders: RemotePromptProvider[];
  capabilities: Record<string, unknown>;
}

interface PendingCall {
  resolve: (value: string) => void;
  reject: (error: Error) => void;
}

interface PendingHostCall {
  resolve: (value: unknown) => void;
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

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseReady(frame: Record<string, unknown>): RemoteReady {
  const protocolVersion = typeof frame.protocolVersion === "number" && Number.isFinite(frame.protocolVersion)
    ? Math.trunc(frame.protocolVersion)
    : 1;
  const promptProviders: RemotePromptProvider[] = [];
  if (Array.isArray(frame.promptProviders)) {
    for (const item of frame.promptProviders) {
      if (!isRecord(item) || typeof item.id !== "string" || !item.id) continue;
      promptProviders.push({
        id: item.id,
        ...(Array.isArray(item.modes) ? { modes: toStringArray(item.modes) } : {}),
        ...(Array.isArray(item.sources) ? { sources: toStringArray(item.sources) } : {}),
      });
    }
  }
  return {
    tools: Array.isArray(frame.tools) ? (frame.tools as RemoteTool[]) : [],
    protocolVersion,
    ipc: toStringArray(frame.ipc),
    events: toStringArray(frame.events),
    promptProviders,
    capabilities: isRecord(frame.capabilities) ? frame.capabilities : {},
  };
}

function parseRemotePrompt(value: unknown): RemotePromptProvider {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id) {
    throw new Error("prompt.register 缺少合法的 provider.id");
  }
  return {
    id: value.id,
    ...(Array.isArray(value.modes) ? { modes: toStringArray(value.modes) } : {}),
    ...(Array.isArray(value.sources) ? { sources: toStringArray(value.sources) } : {}),
  };
}

function requireStringParam(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${label} 必须是非空字符串`);
  return value;
}

function requireObjectParam<T>(value: unknown, label: string): T {
  if (!isRecord(value)) throw new Error(`${label} 需要对象参数`);
  return value as unknown as T;
}

/** deps.llm.generateText 的消息校验：role 白名单 + content 必须是字符串 */
function parseLlmMessages(value: unknown): PluginLlmMessage[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("deps.llm.generateText 需要非空 messages 数组");
  }
  return value.map((item) => {
    if (!isRecord(item) || typeof item.content !== "string") {
      throw new Error("deps.llm.generateText 消息必须是 {role, content}");
    }
    const role = item.role;
    if (role !== "system" && role !== "user" && role !== "assistant") {
      throw new Error(`deps.llm.generateText 非法角色: ${String(role)}`);
    }
    return { role, content: item.content };
  });
}

/**
 * deps.llm.generateText 选项白名单：JSON 桥只接受可序列化字段，
 * signal（Node 轨进程内专用）等未知字段一律丢弃——新 SDK 的选项
 * 在旧宿主上降级为默认值，而不是把非法对象喂给宿主服务。
 */
function parseLlmOptions(value: unknown): PluginLlmGenerateOptions | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error("deps.llm.generateText 的 options 需要对象");
  const options: PluginLlmGenerateOptions = {};
  const maxTokens = value.maxTokens;
  if (maxTokens !== undefined) {
    if (typeof maxTokens !== "number" || !Number.isInteger(maxTokens)) {
      throw new Error("deps.llm.generateText 的 maxTokens 必须是整数");
    }
    options.maxTokens = maxTokens;
  }
  const timeoutMs = value.timeoutMs;
  if (timeoutMs !== undefined) {
    if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs)) {
      throw new Error("deps.llm.generateText 的 timeoutMs 必须是整数");
    }
    options.timeoutMs = timeoutMs;
  }
  const purpose = value.purpose;
  if (purpose !== undefined) {
    if (typeof purpose !== "string") throw new Error("deps.llm.generateText 的 purpose 必须是字符串");
    options.purpose = purpose;
  }
  return Object.keys(options).length > 0 ? options : undefined;
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
  private ctx: PluginContext | null = null;
  private pending = new Map<string, PendingCall>();
  private readyResolvers: Array<{
    resolve: (ready: RemoteReady) => void;
    reject: (error: Error) => void;
  }> = [];
  private stderrWarned = 0;
  private exited = false;
  /** 正常关停进行中：退出不再上报为「意外退出」 */
  private stopping = false;
  /** 启动/重启单飞 */
  private starting: Promise<RemoteReady> | null = null;
  /** init 帧下发的插件私有数据目录（ctx.storage.rootDir()） */
  private dataDir = "";
  /** stdout 分帧缓冲：chunk 边界不保证落在整行上（大结果 / 中文多字节跨 chunk）。 */
  private stdoutCarry = "";
  private stdoutDecoder = new StringDecoder("utf8");
  /** 超长帧告警次数上限：异常插件刷屏时只提示前几次 */
  private oversizedFrameWarned = 0;

  // ── v2 桥状态（每个"进程代"一份，进程退出即撤销） ──
  /** 已登记到 ctx 的插件 IPC channel（短名） */
  private readonly remoteIpc = new Set<string>();
  /** 已登记到 ctx 的提示词 Provider id（短名） */
  private readonly remotePromptProviders = new Set<string>();
  /** 已订阅的宿主事件 → ctx.events.on 返回的退订函数 */
  private readonly remoteEventUnsubs = new Map<string, () => void>();
  /** host→plugin 在途调用（call/reply 配对） */
  private readonly pendingHostCalls = new Map<string, PendingHostCall>();
  private hostCallSeq = 0;
  /** ready 声明的 open 能力（v2）；未声明时保持 undefined（管理窗不显示"打开"） */
  open?: () => Promise<void>;

  constructor(record: PluginRecord, hooks: DotnetPluginAdapterHooks = {}) {
    this.record = record;
    this.hooks = hooks;
  }

  async register(ctx: PluginContext): Promise<void> {
    this.stopping = false;
    this.ctx = ctx;
    // 与 node 插件同一目录约定：storage.rootDir() = userData/plugin-data/<pluginId>
    this.dataDir = ctx.storage.rootDir();

    const ready = await this.startProcess();
    this.registerTools(ctx, ready.tools);
    // v2 声明注册失败 = 激活失败（与 Node 轨 register() 抛错语义一致）
    this.applyReady(ready, true);
    console.log(
      `[plugins] dotnet 插件 ${this.record.manifest.id} 就绪，注册 ${ready.tools.length} 个工具`
      + (ready.protocolVersion >= 2 ? `（协议 v${ready.protocolVersion}）` : ""),
    );
  }

  private registerTools(ctx: PluginContext, tools: RemoteTool[]): void {
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
        // 取消信号来自工具上下文（宿主取消本轮时中止在途调用）
        execute: (input, toolCtx) => this.invokeTool(shortId, input, toolCtx?.signal),
      });
    }
  }

  /**
   * 应用 ready 的 v2 声明：IPC / 事件订阅 / 提示词 Provider / open 能力。
   * 全部走 ctx 的注册方法——命名空间、冲突检测、资源回收与 Node 轨共用同一套。
   */
  private applyReady(ready: RemoteReady, initial: boolean): void {
    const ctx = this.ctx;
    if (!ctx || ready.protocolVersion < 2) return;
    const failures: string[] = [];
    const run = (label: string, fn: () => void): void => {
      try {
        fn();
      } catch (error) {
        failures.push(`${label}: ${errorMessage(error)}`);
      }
    };
    for (const channel of ready.ipc) run(`ipc ${channel}`, () => this.registerIpcChannel(channel));
    for (const event of ready.events) run(`event ${event}`, () => this.subscribeEvent(event));
    for (const provider of ready.promptProviders) run(`prompt ${provider.id}`, () => this.registerRemotePrompt(provider));
    if (ready.capabilities.open === true) {
      this.open = () => this.callPlugin(
        "plugin.open",
        {},
        { timeoutMs: OPEN_TIMEOUT_MS },
      ).then(() => undefined);
    }
    if (failures.length > 0) {
      const message = `dotnet 插件 ${this.record.manifest.id} v2 声明注册失败: ${failures.join("; ")}`;
      if (initial) throw new Error(message);
      console.warn(`[plugins] ${message}`);
    }
  }

  /** 撤销本代全部 v2 注册（进程退出/致命错误时调用；幂等） */
  private teardownGeneration(): void {
    for (const channel of [...this.remoteIpc]) {
      try {
        this.ctx?.unregisterIpc(channel);
      } catch {
        // ctx 可能已随插件停用释放；忽略
      }
    }
    this.remoteIpc.clear();
    for (const [event, off] of [...this.remoteEventUnsubs]) {
      try {
        off();
      } catch {
        // 同上
      }
    }
    this.remoteEventUnsubs.clear();
    for (const providerId of [...this.remotePromptProviders]) {
      try {
        this.ctx?.unregisterPromptProvider(providerId);
      } catch {
        // 同上
      }
    }
    this.remotePromptProviders.clear();
    delete this.open;
    const message = `dotnet 插件 ${this.record.manifest.id} 进程退出，v2 注册已撤销`;
    for (const [, call] of this.pendingHostCalls) call.reject(new Error(message));
    this.pendingHostCalls.clear();
  }

  private registerIpcChannel(channel: string): void {
    const ctx = this.ctx;
    if (!ctx) throw new Error("插件尚未完成注册");
    if (this.remoteIpc.has(channel)) return;
    ctx.registerIpc(channel, (...args: unknown[]) => this.callPlugin(
      "ipc.dispatch",
      { channel, args },
      { timeoutMs: IPC_DISPATCH_TIMEOUT_MS },
    ));
    this.remoteIpc.add(channel);
  }

  private unregisterIpcChannel(channel: string): void {
    if (!this.remoteIpc.delete(channel)) return;
    try {
      this.ctx?.unregisterIpc(channel);
    } catch {
      // 已随 ctx 释放
    }
  }

  private subscribeEvent(event: string): void {
    const ctx = this.ctx;
    if (!ctx) throw new Error("插件尚未完成注册");
    if (this.remoteEventUnsubs.has(event)) return;
    const off = ctx.events.on(event, (payload) => {
      this.sendNotify("event.deliver", { event, payload });
    });
    this.remoteEventUnsubs.set(event, off);
  }

  private unsubscribeEvent(event: string): void {
    const off = this.remoteEventUnsubs.get(event);
    if (!off) return;
    this.remoteEventUnsubs.delete(event);
    try {
      off();
    } catch {
      // 已随 ctx 释放
    }
  }

  private registerRemotePrompt(provider: RemotePromptProvider): void {
    const ctx = this.ctx;
    if (!ctx) throw new Error("插件尚未完成注册");
    if (this.remotePromptProviders.has(provider.id)) {
      throw new Error(`提示词 Provider 已注册: ${provider.id}`);
    }
    ctx.registerPromptProvider({
      id: provider.id,
      ...(provider.modes ? { modes: provider.modes as PluginPromptProvider["modes"] } : {}),
      ...(provider.sources ? { sources: provider.sources as PluginPromptProvider["sources"] } : {}),
      provide: (input) => {
        // signal 不可序列化；取消语义由 callPlugin 的 signal 参数承担
        const { signal, ...data } = input;
        return this.callPlugin(
          "prompt.provide",
          { providerId: provider.id, input: data },
          { timeoutMs: PROMPT_CALL_TIMEOUT_MS, signal },
        ).then((value) => (typeof value === "string" ? value : ""));
      },
    });
    this.remotePromptProviders.add(provider.id);
  }

  private unregisterRemotePrompt(providerId: string): void {
    if (!this.remotePromptProviders.delete(providerId)) return;
    try {
      this.ctx?.unregisterPromptProvider(providerId);
    } catch {
      // 已随 ctx 释放
    }
  }

  /** 启动进程并完成 ready 握手；意外退出后由 invokeTool 调用实现自愈重启 */
  private startProcess(): Promise<RemoteReady> {
    if (this.starting) return this.starting;
    this.starting = this.spawnAndHandshake().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private spawnAndHandshake(): Promise<RemoteReady> {
    const exe = path.join(this.record.dir, this.record.manifest.entry);

    return new Promise<RemoteReady>((resolve, reject) => {
      // 新进程：清空上一进程残留的分帧缓冲与解码器
      this.stdoutCarry = "";
      this.stdoutDecoder = new StringDecoder("utf8");
      const child = spawn(exe, [], {
        cwd: this.record.dir,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      this.proc = child;
      this.exited = false;

      child.on("error", (error) => {
        // spawn 失败（exe 缺失/无权限）：立即置退出态并收口 ready 等待者，
        // 避免后续调用把坏进程当成「运行中」等满 300s 兜底超时
        this.exited = true;
        this.proc = null;
        const failure = new Error(`dotnet 插件 ${this.record.manifest.id} 启动失败: ${errorMessage(error)}`);
        for (const r of this.readyResolvers) r.reject(failure);
        this.readyResolvers = [];
        reject(failure);
      });
      child.on("exit", (code, signal) => {
        this.exited = true;
        this.proc = null;
        this.stdoutCarry = "";
        // 撤销本代 v2 注册（IPC/事件/提示词/open），防止宿主继续调用死进程
        this.teardownGeneration();
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

      // init 握手（v2：protocolVersion 供新 SDK 判断桥能力；旧 SDK 忽略该字段）
      this.send({
        op: "init",
        apiVersion: PROTOCOL_API_VERSION,
        protocolVersion: PROTOCOL_VERSION,
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
        .then((ready) => {
          clearTimeout(timeout);
          resolve(ready);
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
  invokeToolForTest(toolId: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    return this.invokeTool(toolId, args, signal);
  }

  private async invokeTool(
    toolId: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<string> {
    // 意外退出后自愈：下次调用先重启进程再发 invoke（重启失败才报错）
    if (!this.proc || this.exited) {
      if (this.stopping) {
        throw new Error(`dotnet 插件 ${this.record.manifest.id} 未运行`);
      }
      try {
        const ready = await this.startProcess();
        // 重启后重建 v2 注册（IPC/事件/提示词/open）；工具注册沿用首代
        this.applyReady(ready, false);
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
      let timer: NodeJS.Timeout | undefined;
      let settled = false;
      // 统一收口：超时/取消/结果帧三选一，清理定时器与监听后落定
      const finish = (action: () => void) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.pending.delete(callId);
        action();
      };
      const onAbort = () => {
        // 尽力通知插件停止计算（SDK 映射为 CancellationToken）；老 SDK 忽略未知 op
        this.send({ op: "cancel", id: callId, reason: "abort" });
        finish(() => reject(new Error(`dotnet 插件 ${this.record.manifest.id} 工具 ${toolId} 调用已取消`)));
      };

      if (signal?.aborted) {
        finish(() => reject(new Error(`dotnet 插件 ${this.record.manifest.id} 工具 ${toolId} 调用已取消`)));
        return;
      }
      timer = setTimeout(() => {
        this.send({ op: "cancel", id: callId, reason: "timeout" });
        finish(() => reject(new Error(
          `dotnet 插件 ${this.record.manifest.id} 工具 ${toolId} 调用超时（${INVOKE_TIMEOUT_MS}ms）`,
        )));
      }, INVOKE_TIMEOUT_MS);
      if (typeof timer.unref === "function") timer.unref();

      this.pending.set(callId, {
        resolve: (value) => finish(() => resolve(value)),
        reject: (error) => finish(() => reject(error)),
      });
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      this.send({ op: "invoke", callId, tool: toolId, args });
    });
  }

  /**
   * host→plugin 通用调用（v2）：id 配对 + 超时 + AbortSignal 取消。
   * 不做自愈重启——调用方（IPC/提示词/open）在进程退出时已被 teardownGeneration 撤下。
   */
  private callPlugin(
    method: string,
    params: Record<string, unknown>,
    opts: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      if (!this.proc || this.exited) {
        reject(new Error(`dotnet 插件 ${this.record.manifest.id} 未运行`));
        return;
      }
      const id = `h${++this.hostCallSeq}`;
      let timer: NodeJS.Timeout | undefined;
      let settled = false;
      const finish = (action: () => void) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        this.pendingHostCalls.delete(id);
        action();
      };
      const onAbort = () => {
        this.send({ op: "cancel", id });
        finish(() => reject(new Error(`dotnet 插件 ${this.record.manifest.id} 调用 ${method} 已取消`)));
      };

      if (opts.signal?.aborted) {
        finish(() => reject(new Error(`dotnet 插件 ${this.record.manifest.id} 调用 ${method} 已取消`)));
        return;
      }
      timer = setTimeout(() => {
        this.send({ op: "cancel", id });
        finish(() => reject(new Error(
          `dotnet 插件 ${this.record.manifest.id} 调用 ${method} 超时（${opts.timeoutMs}ms）`,
        )));
      }, opts.timeoutMs);
      if (typeof timer.unref === "function") timer.unref();

      this.pendingHostCalls.set(id, {
        resolve: (value) => finish(() => resolve(value)),
        reject: (error) => finish(() => reject(error)),
      });
      if (opts.signal) opts.signal.addEventListener("abort", onAbort, { once: true });
      this.send({ op: "call", id, method, params });
    });
  }

  private waitReady(): Promise<RemoteReady> {
    return new Promise<RemoteReady>((resolve, reject) => {
      this.readyResolvers.push({ resolve, reject });
    });
  }

  private consume(chunk: Buffer): void {
    // chunk 边界不保证是整行：先入缓冲，只处理完整行（大结果 / 多字节字符跨 chunk）
    this.stdoutCarry += this.stdoutDecoder.write(chunk);
    let index: number;
    while ((index = this.stdoutCarry.indexOf("\n")) >= 0) {
      const rawLine = this.stdoutCarry.slice(0, index);
      this.stdoutCarry = this.stdoutCarry.slice(index + 1);
      const line = rawLine.trim();
      if (!line) continue;
      // 完整行也可能超大：解析前先挡掉，避免为垃圾输入分配巨型 JSON
      if (rawLine.length > MAX_FRAME_BUFFER_CHARS) {
        this.warnOversizedFrame();
        continue;
      }
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(line) as Record<string, unknown>;
      } catch {
        // .NET 运行时自身的非协议输出——忽略
        continue;
      }
      this.handleFrame(frame);
    }
    if (this.stdoutCarry.length > MAX_FRAME_BUFFER_CHARS) {
      this.warnOversizedFrame();
      this.stdoutCarry = "";
    }
  }

  /** 超长帧告警（最多 3 次）：正常协议帧不应接近上限，出现即插件侧有 bug */
  private warnOversizedFrame(): void {
    if (this.oversizedFrameWarned >= 3) return;
    this.oversizedFrameWarned += 1;
    console.warn(
      `[plugins] dotnet 插件 ${this.record.manifest.id} stdout 单行超过 ${MAX_FRAME_BUFFER_CHARS} 字符，已丢弃`,
    );
  }

  private handleFrame(frame: Record<string, unknown>): void {
    const op = typeof frame.op === "string" ? frame.op : "";
    if (op === "error") {
      // SDK 侧致命错误（如协议版本不符）：拒绝握手与在途调用；不按「意外退出」自愈重启
      const message = typeof frame.message === "string" ? frame.message : "插件报告致命错误";
      const error = new Error(`dotnet 插件 ${this.record.manifest.id}: ${message}`);
      console.error(`[plugins] ${error.message}`);
      const resolvers = this.readyResolvers;
      this.readyResolvers = [];
      for (const r of resolvers) r.reject(error);
      this.teardownGeneration();
      this.stopping = true;
      for (const [, call] of this.pending) call.reject(error);
      this.pending.clear();
      this.kill();
      return;
    }
    if (op === "ready") {
      const ready = parseReady(frame);
      const resolvers = this.readyResolvers;
      this.readyResolvers = [];
      for (const r of resolvers) r.resolve(ready);
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
    if (op === "reply") {
      const id = typeof frame.id === "string" ? frame.id : "";
      const call = this.pendingHostCalls.get(id);
      if (!call) return;
      this.pendingHostCalls.delete(id);
      if (frame.ok === true) call.resolve(frame.data ?? null);
      else call.reject(new Error(typeof frame.error === "string" ? frame.error : "插件桥调用失败"));
      return;
    }
    if (op === "call") {
      // 插件 → 宿主请求：异步处理，不阻塞读循环
      void this.handlePluginCall(frame);
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

  /** 插件 → 宿主请求的统一入口：路由到 ctx 对应方法并回 reply */
  private async handlePluginCall(frame: Record<string, unknown>): Promise<void> {
    const id = typeof frame.id === "string" ? frame.id : "";
    if (!id) return;
    const method = typeof frame.method === "string" ? frame.method : "";
    const params = isRecord(frame.params) ? frame.params : {};
    try {
      const data = await this.dispatchPluginMethod(method, params);
      this.send({ op: "reply", id, ok: true, data: data ?? null });
    } catch (error) {
      const payload: Record<string, unknown> = { op: "reply", id, ok: false, error: errorMessage(error) };
      // 宿主服务错误带稳定 code（E_*，与 Node 轨一致），插件应依赖 code 分支
      if (isPluginHostError(error)) payload.code = error.code;
      this.send(payload);
    }
  }

  private async dispatchPluginMethod(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const ctx = this.ctx;
    if (!ctx) throw new Error("插件尚未完成注册");
    // 宿主服务（manifest.deps 声明的能力）统一走 deps.* 命名空间
    if (method.startsWith("deps.")) return this.dispatchDepsMethod(method, params);
    switch (method) {
      case "events.emit": {
        const event = requireStringParam(params.event, "events.emit 的 event");
        // ctx 负责命名空间限定（插件只能发 plugin:<id>:*），宿主事件不可伪造
        await ctx.events.emit(event, params.payload);
        return null;
      }
      case "events.subscribe": {
        this.subscribeEvent(requireStringParam(params.event, "events.subscribe 的 event"));
        return null;
      }
      case "events.unsubscribe": {
        this.unsubscribeEvent(requireStringParam(params.event, "events.unsubscribe 的 event"));
        return null;
      }
      case "ipc.register": {
        this.registerIpcChannel(requireStringParam(params.channel, "ipc.register 的 channel"));
        return null;
      }
      case "ipc.unregister": {
        this.unregisterIpcChannel(requireStringParam(params.channel, "ipc.unregister 的 channel"));
        return null;
      }
      case "prompt.register": {
        this.registerRemotePrompt(parseRemotePrompt(params.provider));
        return null;
      }
      case "prompt.unregister": {
        this.unregisterRemotePrompt(requireStringParam(params.providerId, "prompt.unregister 的 providerId"));
        return null;
      }
      default:
        throw new Error(`未知宿主方法: ${method}`);
    }
  }

  /** 取 manifest.deps 声明的宿主服务；未声明/未提供 → E_CAPABILITY_UNAVAILABLE（与 Node 错误码一致） */
  private requireDep<K extends keyof PluginDeps>(name: K): NonNullable<PluginDeps[K]> {
    const service = this.ctx?.deps?.[name];
    if (!service) {
      const error = new Error(`插件未声明或宿主未提供依赖: ${String(name)}`) as Error & { code: string };
      error.code = "E_CAPABILITY_UNAVAILABLE";
      throw error;
    }
    return service as NonNullable<PluginDeps[K]>;
  }

  /**
   * deps.* 方法 → ctx.deps 直通。
   * 这里不做超时包装：各宿主服务自带超时/取消语义（LLM 有 timeoutMs），
   * 处理器在独立任务里执行，不阻塞读循环。
   */
  private async dispatchDepsMethod(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    switch (method) {
      case "deps.channels.has": {
        return this.requireDep("channels").has(requireStringParam(params.channelId, "deps.channels.has 的 channelId"));
      }
      case "deps.llm.generateText": {
        const llm = this.requireDep("llm");
        const messages = parseLlmMessages(params.messages);
        return llm.generateText(messages, parseLlmOptions(params.options));
      }
      case "deps.secrets.get": {
        const value = await this.requireDep("secrets").get(requireStringParam(params.key, "deps.secrets.get 的 key"));
        return value ?? null;
      }
      case "deps.secrets.set": {
        await this.requireDep("secrets").set(
          requireStringParam(params.key, "deps.secrets.set 的 key"),
          requireStringParam(params.value, "deps.secrets.set 的 value"),
        );
        return null;
      }
      case "deps.secrets.delete": {
        return this.requireDep("secrets").delete(requireStringParam(params.key, "deps.secrets.delete 的 key"));
      }
      case "deps.conversations.list": {
        const input = isRecord(params.input) ? (params.input as PluginConversationListInput) : undefined;
        return this.requireDep("conversations").list(input);
      }
      case "deps.conversations.getMessages": {
        return this.requireDep("conversations").getMessages(
          requireObjectParam<PluginMessagePageInput>(params.input, "deps.conversations.getMessages 的 input"),
        );
      }
      case "deps.workspace.getBinding": {
        return this.requireDep("workspace").getBinding(
          requireStringParam(params.conversationId, "deps.workspace.getBinding 的 conversationId"),
        );
      }
      case "deps.scheduler.createTask": {
        return this.requireDep("scheduler").createTask(
          requireObjectParam<PluginScheduledTaskInput>(params.input, "deps.scheduler.createTask 的 input"),
        );
      }
      case "deps.scheduler.listTasks": {
        return this.requireDep("scheduler").listTasks();
      }
      case "deps.scheduler.updateTask": {
        return this.requireDep("scheduler").updateTask(
          requireStringParam(params.taskId, "deps.scheduler.updateTask 的 taskId"),
          requireObjectParam<PluginScheduledTaskPatch>(params.patch, "deps.scheduler.updateTask 的 patch"),
        );
      }
      case "deps.scheduler.deleteTask": {
        return this.requireDep("scheduler").deleteTask(
          requireStringParam(params.taskId, "deps.scheduler.deleteTask 的 taskId"),
        );
      }
      case "deps.scheduler.getHistory": {
        // limit 原样透传：非整数由宿主按 Node 语义回 E_INVALID_ARGUMENT，不做本地截断
        const limit = params.limit === undefined ? undefined : (params.limit as number);
        return this.requireDep("scheduler").getHistory(
          requireStringParam(params.taskId, "deps.scheduler.getHistory 的 taskId"),
          limit,
        );
      }
      default:
        throw new Error(`未知宿主方法: ${method}`);
    }
  }

  private sendNotify(method: string, params: Record<string, unknown>): void {
    this.send({ op: "notify", method, params });
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

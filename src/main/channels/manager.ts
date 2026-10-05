// ChannelManager —— 渠道注册表 + 生命周期管理。
//
// 设计原则：
//   - Manager 只做"哪个渠道注册了、它们的启停状态"。不知道任何平台协议细节。
//   - 入站消息路径：adapters.onMessage → manager.handleIncoming(msg) → dispatcher。
//     实际转发由 dispatcher 负责；manager 只持有 dispatcher 的入口引用。
//   - 出站消息路径：dispatcher 拿到 outgoing 后调 adapter.send(outgoing)。
//   - Manager 不感知 sessionId、不感知 cap 降级、不感知 tool 调用 —— 全部下放。
import type { ChannelAdapter } from "./adapters/base";
import type { ChannelId, ChannelStatus, IncomingMessage, OutgoingMessage } from "./types";
import { setAdapterHandler } from "./adapters/base";
import { logger, LogTag } from "../logger";

const LOG = "[ChannelManager]";

/** dispatcher 给 manager 的回调 —— 拿到入站消息后返回一个 outgoing 消息 */
export type DispatchFn = (msg: IncomingMessage) => Promise<OutgoingMessage | null>;

export class ChannelManager {
  private adapters = new Map<ChannelId, ChannelAdapter>();
  private dispatchFn: DispatchFn | null = null;
  /** 启动后已开启的 adapter（start 成功的才会调 stop） */
  private startedAdapters = new Set<ChannelId>();
  /**
   * 启动门闩（归属第一道防线）：owner=server 时桌面不启动适配器（§5.1 R4）。
   * 缺省 null = 全部放行（保持既有本地行为）；init.ts 按归属控制器注入。
   */
  private startGate: ((id: ChannelId) => boolean) | null = null;

  has(id: ChannelId): boolean {
    return this.adapters.has(id);
  }

  /** 设置启动门闩；传 null 恢复放行。门闩抛错时 fail-open（不影响渠道可用性）。 */
  setStartGate(gate: ((id: ChannelId) => boolean) | null): void {
    this.startGate = gate;
  }

  /** 当前是否允许本机启动该渠道（UI/测试可见）。 */
  allowedToStart(id: ChannelId): boolean {
    if (!this.startGate) return true;
    try {
      return this.startGate(id);
    } catch (err) {
      console.warn(LOG, `启动门闩异常，按放行处理 [${id}]:`, err instanceof Error ? err.message : err);
      return true;
    }
  }

  /** 注册 adapter（必须在 startAll 之前调用；重复 id 一律拒绝） */
  register(adapter: ChannelAdapter): void {
    if (this.adapters.has(adapter.id)) {
      throw new Error(`渠道 ${adapter.id} 已注册，禁止覆盖现有实例`);
    }
    this.adapters.set(adapter.id, adapter);
  }

  /** 设置 dispatcher 入口。注册 adapter 时机不限，dispatcher 注入必须早于 startAll。 */
  setDispatcher(fn: DispatchFn): void {
    this.dispatchFn = fn;
    // 给所有已注册的 adapter 注入 handler
    for (const adapter of this.adapters.values()) {
      setAdapterHandler(adapter, this.makeAdapterHandler(adapter.id));
    }
  }

  /** 启动所有已注册 adapter（失败的跳过、记 log；归属门闩拒绝的跳过） */
  async startAll(): Promise<void> {
    for (const adapter of this.adapters.values()) {
      // 跳过已启动的 adapter（插件注册渠道场景：registerChannelAdapter 已 startOne）
      if (this.startedAdapters.has(adapter.id)) continue;
      if (!this.allowedToStart(adapter.id)) {
        logger.info(LogTag.Channels, `skipped (ownership): ${adapter.id}`);
        continue;
      }
      try {
        // 每次 start 前重新注入 handler（防止 setDispatcher 之前 adapter 已经被外部注入 null）
        if (this.dispatchFn) {
          setAdapterHandler(adapter, this.makeAdapterHandler(adapter.id));
        }
        await adapter.start();
        this.startedAdapters.add(adapter.id);
        logger.info(LogTag.Channels, `started: ${adapter.id} (${adapter.displayName})`);
      } catch (err) {
        console.error(LOG, `渠道启动失败 [${adapter.id}]:`, err instanceof Error ? err.message : err);
      }
    }
  }

  /** 注销 adapter：若已启动先 stop，再移除（运行时禁用插件渠道用） */
  async unregister(id: ChannelId): Promise<boolean> {
    const adapter = this.adapters.get(id);
    if (!adapter) return false;
    if (this.startedAdapters.has(id)) {
      try {
        await adapter.stop();
      } catch (err) {
        console.warn(LOG, `渠道停止失败 [${id}]:`, err instanceof Error ? err.message : err);
      }
      this.startedAdapters.delete(id);
    }
    this.adapters.delete(id);
    logger.info(LogTag.Channels, `unregistered: ${id}`);
    return true;
  }

  /** 启动单个 adapter（运行时启用插件渠道用）；归属门闩拒绝时保持关闭 */
  async startOne(id: ChannelId): Promise<void> {
    const adapter = this.adapters.get(id);
    if (!adapter) return;
    if (this.startedAdapters.has(id)) return;
    if (!this.allowedToStart(id)) {
      logger.info(LogTag.Channels, `skipped (ownership): ${id}`);
      return;
    }
    if (this.dispatchFn) {
      setAdapterHandler(adapter, this.makeAdapterHandler(id));
    }
    try {
      await adapter.start();
      this.startedAdapters.add(id);
      logger.info(LogTag.Channels, `started: ${id} (${adapter.displayName})`);
    } catch (err) {
      // 单渠道失败不抛出：applyPlan/重启等路径不因一个渠道 reject 而中断
      console.error(LOG, `渠道启动失败 [${id}]:`, err instanceof Error ? err.message : err);
    }
  }

  /**
   * 暂停单个 adapter（归属切换用）：已启动则 stop，但保留注册（可再 startOne）。
   * 与 stopAll 的差别只在语义命名与单渠道粒度。
   */
  async pauseOne(id: ChannelId): Promise<void> {
    const adapter = this.adapters.get(id);
    if (!adapter || !this.startedAdapters.has(id)) return;
    try {
      await adapter.stop();
    } catch (err) {
      console.warn(LOG, `渠道暂停失败 [${id}]:`, err instanceof Error ? err.message : err);
    }
    this.startedAdapters.delete(id);
    logger.info(LogTag.Channels, `paused: ${id}`);
  }

  /** 该渠道当前是否已启动（归属状态展示/测试用）。 */
  isStarted(id: ChannelId): boolean {
    return this.startedAdapters.has(id);
  }

  /** 关闭所有已启动的 adapter */
  async stopAll(): Promise<void> {
    for (const id of this.startedAdapters) {
      const adapter = this.adapters.get(id);
      if (!adapter) continue;
      try {
        await adapter.stop();
      } catch (err) {
        console.warn(LOG, `渠道停止失败 [${id}]:`, err instanceof Error ? err.message : err);
      }
    }
    this.startedAdapters.clear();
  }

  getAdapter(channel: ChannelId): ChannelAdapter | undefined {
    return this.adapters.get(channel);
  }

  listChannels(): ChannelId[] {
    return Array.from(this.adapters.keys());
  }

  /** 给 UI 用：所有渠道的实时状态 */
  getAllStatus(): Record<ChannelId, ChannelStatus> {
    const out: Partial<Record<ChannelId, ChannelStatus>> = {};
    for (const [id, adapter] of this.adapters.entries()) {
      out[id] = adapter.getStatus();
    }
    return out as Record<ChannelId, ChannelStatus>;
  }

  private makeAdapterHandler(channel: ChannelId) {
    return async (msg: IncomingMessage): Promise<OutgoingMessage | null> => {
      if (!this.dispatchFn) {
        console.warn(LOG, `收到入站消息但 dispatcher 未注册 [${channel}]`);
        return null;
      }
      try {
        return await this.dispatchFn(msg);
      } catch (err) {
        console.error(LOG, `dispatcher 处理失败 [${channel}]:`, err);
        return null;
      }
    };
  }
}

/** 进程级单例。index.ts 在 app.whenReady() 里实例化一次。 */
export const channelManager = new ChannelManager();

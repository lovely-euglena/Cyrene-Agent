/**
 * 云端同步 · 同步服务（IKJK2I B 簇）。
 *
 * 契约：docs/design/2026-10-06-desktop-cloud-wiring.md §4.2 / §4.3 + 附录 A。
 *
 * 单飞互斥（并发 syncNow 共享同一 promise）；流程：
 *   导出（exporter）→ 存 state → push（pushedCount 起，成功后推进）→
 *   clone（fetchCursor=null）或 fetch 循环（hasMore 至 false）→ 入库去重 → 存 state。
 * 失败保留游标 / 水位，记 lastError，下一轮重试；入库顺序：事件先 append → 后原子写 state。
 * 换址竞态（#IKJSNA 复审 P1-1 / 复审二轮 P1-1 / 复审三轮 P2-2）：saveConfig / pair / unpair 递增 generation
 * 并立即中止在途轮次，旧轮在结算点校验代际，不一致即丢弃（不得用旧服务器游标 / 水位覆盖换址重置）——
 * 结算点覆盖网络返回后 **与入库落盘（appendRemoteEvents 的 fs + fsync 等待）之后** 的游标写回前；
 * stale 丢弃前对已入库事件补发广播，并将已抬升的 lamport 定向落盘（入库等待窗口）；
 * 配置变更后的立即同步经 requestSync 排队，不被单飞互斥吞掉。
 *
 * 依赖全部可注入（store/exporter/state 读写/客户端工厂/时钟/定时器/onRemoteEventsApplied），
 * 默认取真实模块（A 簇签名）；测试注入假实现，不触达真实网络 / 磁盘事件库。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ChatSessionMeta } from "../../shared/chat-types";
import type {
  SyncConfigPublic,
  SyncPairCodeResult,
  SyncPairInput,
  SyncSaveConfigInput,
  SyncStatus,
} from "../../shared/sync-types";
import type { TranscriptEntry } from "../orchestrator/conversation-transcript-types";
import { SyncEventStore } from "./event-store";
import { createSyncExporter, type SyncExporter, type SyncExporterDeps } from "./exporter";
import {
  createSyncHttpClient,
  SyncHttpError,
  SYNC_FETCH_DEFAULT_LIMIT,
  type SyncHttpClient,
  type SyncHttpClientConfig,
} from "./http-client";
import type { SyncEventV0 } from "./sync-protocol";
import { loadSyncSettings, saveSyncSettings, toPublicSyncConfig, type SyncSettings } from "./sync-settings";
import { loadSyncState, saveSyncState, STATE_FILE_NAME, type SyncState } from "./sync-state";

/** 定时同步周期（启用时；timer unref，不阻塞退出）。 */
export const SYNC_INTERVAL_MS = 60_000;

/**
 * baseUrl 比较键：按 URL origin（protocol + host，大小写不敏感）归一化——
 * 路径差异不算换主机（有意保留：同 origin 子路径调整不触发清 token 重配对；
 * 语义与代价见 docs/design/2026-10-06-desktop-cloud-wiring.md §4.4）；
 * 非法 / 空值退化为去空白与尾斜杠比较。
 */
function normalizeBaseUrlKey(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    const parsed = new URL(trimmed);
    return `${parsed.protocol}//${parsed.host}`.toLowerCase();
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
}

export interface SyncRunResult {
  ok: boolean;
  error: { code: string; message: string } | null;
}

export interface SyncServiceDeps {
  userDataPath: string;
  /** 旁路事件库（缺省：SyncEventStore.open(syncDir)）。 */
  store?: SyncEventStore;
  /** 导出器（缺省：createSyncExporter + 真实 chats/orchestrator 依赖）。 */
  exporter?: SyncExporter;
  loadState?: (syncDir: string) => Promise<SyncState>;
  saveState?: (syncDir: string, state: SyncState) => Promise<void>;
  createClient?: (config: SyncHttpClientConfig) => SyncHttpClient;
  now?: () => number;
  setIntervalImpl?: typeof setInterval;
  clearIntervalImpl?: typeof clearInterval;
  /** fetch/clone 拉到新事件（deviceId ≠ 本机）后回调，用于广播 UI 刷新。 */
  onRemoteEventsApplied?: (sessionIds: string[]) => void;
  log?: (message: string) => void;
}

export interface SyncService {
  start(): Promise<void>;
  stop(): Promise<void>;
  syncNow(): Promise<SyncRunResult>;
  getStatus(): Promise<SyncStatus>;
  getConfig(): Promise<SyncConfigPublic>;
  saveConfig(input: SyncSaveConfigInput): Promise<SyncConfigPublic>;
  pair(input: SyncPairInput): Promise<SyncConfigPublic>;
  createPairCode(): Promise<SyncPairCodeResult>;
  unpair(): Promise<SyncConfigPublic>;
  /** 读模型 gating（未启用 → 不做任何合并）。 */
  isEnabled(): boolean;
  /** inbox 中该会话、deviceId ≠ 本机的事件（已去重、规范序）。 */
  getRemoteSessionEvents(sessionId: string): Promise<SyncEventV0[]>;
}

function toRunError(error: unknown): { code: string; message: string } {
  if (error instanceof SyncHttpError) return { code: error.code, message: error.message };
  const message = error instanceof Error ? error.message : String(error);
  return { code: "internal", message: message.slice(0, 300) };
}

class SyncServiceController implements SyncService {
  private readonly deps: SyncServiceDeps;
  private readonly syncDir: string;
  private settings: SyncSettings | null = null;
  private state: SyncState | null = null;
  private store: SyncEventStore | null = null;
  private exporter: SyncExporter | null = null;
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<SyncRunResult> | null = null;
  private abortController: AbortController | null = null;
  private lastSyncAt: string | null = null;
  private lastError: { code: string; message: string } | null = null;
  /** 换址代际（复审 P1-1）：换址 / 解除配对时自增；在途轮次据此丢弃旧服务器结算。 */
  private generation = 0;
  /** 在途轮次结束后的补跑标记（换址时旧轮未结束，syncNow 单飞会吞掉立即补跑）。 */
  private rerunRequested = false;
  /** state 落盘串行链：并发 persist（在途轮次 vs 换址重置）按调用序执行，避免快照交错。 */
  private persistChain: Promise<void> = Promise.resolve();

  constructor(deps: SyncServiceDeps) {
    this.deps = deps;
    this.syncDir = path.join(deps.userDataPath, "sync");
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private log(message: string): void {
    (this.deps.log ?? ((text: string) => console.warn(text)))(message);
  }

  /** 设置读取（进程内缓存；所有写路径都经本服务，缓存不会失真）。 */
  private loadSettings(): SyncSettings {
    if (!this.settings) this.settings = loadSyncSettings();
    return this.settings;
  }

  private async ensureState(): Promise<SyncState> {
    if (!this.state) {
      this.state = await (this.deps.loadState ?? loadSyncState)(this.syncDir);
    }
    return this.state;
  }

  /**
   * 读路径专用状态读取：state 缺失（无 state.json）时返回 null，不创建目录/文件、不生成身份
   * （与「默认关闭零副作用」口径一致）；已有文件时走完整加载（含损坏隔离恢复）。
   * 写路径（syncNow / pair / unpair 等）仍用 ensureState 保证身份落盘。
   */
  private async peekState(): Promise<SyncState | null> {
    if (this.state) return this.state;
    if (!fs.existsSync(path.join(this.syncDir, STATE_FILE_NAME))) return null;
    return await this.ensureState();
  }

  /** createIfMissing=false 且目录不存在时不建库（默认关闭零副作用）。 */
  private async ensureStore(createIfMissing: boolean): Promise<SyncEventStore | null> {
    if (this.store) return this.store;
    if (this.deps.store) {
      this.store = this.deps.store;
      return this.store;
    }
    if (!createIfMissing && !fs.existsSync(this.syncDir)) return null;
    this.store = await SyncEventStore.open({ syncDir: this.syncDir });
    return this.store;
  }

  private async resolveExporterDeps(): Promise<
    Pick<SyncExporterDeps, "listSessions" | "ensureMigrated" | "readAuditEntries">
  > {
    // 动态 import：测试注入 exporter 时不加载 chats/orchestrator（保持单测轻量）
    const [chatsStore, migrationModule, transcriptModule] = await Promise.all([
      import("../chats/chats-store"),
      import("../orchestrator/conversation-session-migration"),
      import("../orchestrator/conversation-transcript-store"),
    ]);
    const migration = migrationModule.createConversationSessionMigration(this.deps.userDataPath);
    const transcriptStore = transcriptModule.getConversationTranscriptStore(this.deps.userDataPath);
    return {
      listSessions: async () => chatsStore.listSessions(),
      ensureMigrated: async (sessionId: string) => {
        await migration.ensureConversationMigrated(sessionId);
      },
      // 必须用 readAuditEntries（审计全量）：read() 只返回热快照，归档段（segments/）
      // 不在其中；直接用会导致已归档会话的历史漏导出（store 注释：Unlike read()…）。
      readAuditEntries: async (sessionId: string): Promise<TranscriptEntry[]> =>
        transcriptStore.readAuditEntries(sessionId),
    };
  }

  private async ensureExporter(state: SyncState, store: SyncEventStore): Promise<SyncExporter> {
    if (this.exporter) return this.exporter;
    if (this.deps.exporter) {
      this.exporter = this.deps.exporter;
      return this.exporter;
    }
    const extra = await this.resolveExporterDeps();
    this.exporter = createSyncExporter({
      userDataPath: this.deps.userDataPath,
      state,
      store,
      listSessions: extra.listSessions,
      ensureMigrated: extra.ensureMigrated,
      readAuditEntries: extra.readAuditEntries,
    });
    return this.exporter;
  }

  private buildClient(config: SyncHttpClientConfig): SyncHttpClient {
    return (this.deps.createClient ?? createSyncHttpClient)(config);
  }

  /** state 落盘（串行化）：快照在轮到本次执行时才序列化，换址重置不会被旧轮快照覆盖。 */
  private persistState(): Promise<void> {
    if (!this.state) return Promise.resolve();
    const run = this.persistChain.then(async () => {
      if (!this.state) return;
      this.state.updatedAt = new Date(this.now()).toISOString();
      await (this.deps.saveState ?? saveSyncState)(this.syncDir, this.state);
    });
    this.persistChain = run.catch(() => { /* 失败向本次调用方传播，链本身继续 */ });
    return run;
  }

  // ── 生命周期 ─────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.running) return;
    if (!this.loadSettings().enabled) return; // 未启用：不挂定时器、不碰网络
    this.running = true;
    this.timer = (this.deps.setIntervalImpl ?? setInterval)(() => {
      void this.syncNow();
    }, SYNC_INTERVAL_MS);
    (this.timer as { unref?: () => void }).unref?.();
    // 启动即拉一轮（不阻塞调用方）；失败由 lastError 记录，下轮重试
    this.requestSync();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.rerunRequested = false; // 停止后不再补跑；重新启用由 start 触发首轮
    if (this.timer) {
      (this.deps.clearIntervalImpl ?? clearInterval)(this.timer);
      this.timer = null;
    }
    // 中止在途请求（主动中止不计入 lastError）；不 await 在途轮次，避免退出被网络阻塞
    this.abortController?.abort();
  }

  // ── 同步轮次（单飞） ──────────────────────────────────────────────────────

  syncNow(): Promise<SyncRunResult> {
    if (this.inFlight) return this.inFlight; // 并发共享同一 promise
    const tracked = this.runSync().finally(() => {
      if (this.inFlight !== tracked) return;
      this.inFlight = null;
      // 换址等配置变更在旧轮在途时请求过补跑：旧轮结算后立即以新配置跑一轮
      if (this.rerunRequested) {
        this.rerunRequested = false;
        void this.syncNow();
      }
    });
    this.inFlight = tracked;
    return tracked;
  }

  /** 配置变更后的立即同步：在途时排队补跑（保持 syncNow 对普通并发调用的单飞语义）。 */
  private requestSync(): void {
    if (this.inFlight) {
      this.rerunRequested = true;
      return;
    }
    void this.syncNow();
  }

  private async runSync(): Promise<SyncRunResult> {
    const settings = this.loadSettings();
    if (!settings.enabled) {
      return { ok: false, error: { code: "disabled", message: "同步未启用" } };
    }
    if (!settings.baseUrl || !settings.token) {
      return { ok: false, error: { code: "invalid_config", message: "同步未配置（缺少服务器地址或 token）" } };
    }

    const controller = new AbortController();
    this.abortController = controller;
    // 换址代际（复审 P1-1）：轮次启动后配置可能被换址重置；所有结算点校验，
    // 不一致即丢弃（旧服务器游标 / 水位不得覆盖重置）。
    const generation = this.generation;
    // 已入库的旧服务器事件（提交到事件库即为事实）：轮次被丢弃时仍要刷新读模型，
    // 否则合并视图要等到下一次读取才看得到这批事件（复审 P2-3②）。
    const appliedSessions = new Set<string>();
    // 入库已发生（appendRemoteEvents 已抬升内存 lamport）后命中 stale：丢弃结算前需定向落盘。
    // 否则换址同时停用同步 / 解配且进程未再同步即退出时，磁盘 state.lamport 会落后于
    // inbox 已见事件（复审三轮 P2-2②；规范序偏移，非数据丢失）。
    let appendedSinceLastPersist = false;
    const stale = async (): Promise<SyncRunResult> => {
      if (appliedSessions.size > 0) {
        this.deps.onRemoteEventsApplied?.(Array.from(appliedSessions));
        appliedSessions.clear();
      }
      if (appendedSinceLastPersist) {
        appendedSinceLastPersist = false;
        try {
          // 定向落盘：state 其余字段已由换址重置持有，persistState 在执行时才序列化共享对象，
          // 不会把旧服务器的游标 / 水位写回（lamport 只取 max，只增不减）；落盘失败不改变 stale 判定。
          await this.persistState();
        } catch (error) {
          this.log(`[Sync] stale 轮 lamport 落盘失败: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return {
        ok: false,
        error: { code: "stale", message: "同步轮次因服务器地址变更被丢弃" },
      };
    };
    try {
      const state = await this.ensureState();
      const store = await this.ensureStore(true);
      if (!store) throw new SyncHttpError("invalid_config", 0, undefined, "事件库不可用");
      const exporter = await this.ensureExporter(state, store);

      // 首次运行即冻结协议身份（deviceId 持久化），失败也不重新生成
      await this.persistState();

      // 1) 导出：追加 outbox → 先持久化 state（append → state 顺序）
      const exported = await exporter.exportPending();
      if (exported.exported > 0 || exported.sessions > 0) await this.persistState();

      // 2) push：pushedCount 起，成功后推进（客户端内部按 ≤5 MiB 分块，幂等重试安全）
      const client = this.buildClient({
        baseUrl: settings.baseUrl,
        token: settings.token,
        signal: controller.signal,
      });
      const pending = store.getLocalEvents().slice(Math.max(0, state.pushedCount));
      if (pending.length > 0) {
        const pushed = await client.push(pending);
        if (generation !== this.generation) return stale();
        const advanced = Math.min(pending.length, pushed.accepted + pushed.duplicates);
        if (advanced > 0) {
          state.pushedCount += advanced;
          await this.persistState();
        }
      }

      // 3) clone（初次）或 fetch 循环（增量）；入库去重 + lamport 水位取 max
      const known = this.collectKnownEventIds(store);
      if (!state.fetchCursor) {
        const cloned = await client.clone();
        if (generation !== this.generation) return stale();
        if (cloned.dropped > 0) {
          this.log(`[Sync] clone 丢弃 ${cloned.dropped} 条坏帧（初始游标 ${cloned.cursor ?? "null"}）`);
        }
        const added = await this.appendRemoteEvents(store, state, cloned.events, known, appliedSessions);
        if (added > 0) appendedSinceLastPersist = true;
        // 复审 P1-1：appendRemoteEvents 内部是 fs + fsync 落库等待——换址重置可能发生在
        // 这段入库等待期间（代际已变），此时写回游标 / persistState 会把旧服务器游标
        // 留在磁盘上，补跑随即拿它向新服务器增量 fetch（静默漏拉）。校验失配即丢弃结算。
        if (generation !== this.generation) return stale();
        state.fetchCursor = cloned.cursor;
        if (added > 0 || cloned.cursor) await this.persistState();
        appendedSinceLastPersist = false; // lamport 已随本次落盘
      } else {
        for (;;) {
          if (generation !== this.generation) return stale();
          const previousCursor = state.fetchCursor;
          const page = await client.fetch(state.fetchCursor, { limit: SYNC_FETCH_DEFAULT_LIMIT });
          if (generation !== this.generation) return stale();
          // 坏帧（协议校验不通过）会被永久跳过且游标照常推进：必须留日志，否则不可观察
          if (page.dropped > 0) {
            this.log(`[Sync] fetch 丢弃 ${page.dropped} 条坏帧（游标 ${previousCursor} → ${page.cursor}）`);
          }
          const added = await this.appendRemoteEvents(store, state, page.events, known, appliedSessions);
          if (added > 0) appendedSinceLastPersist = true;
          // 复审 P1-1：同 clone 分支——入库等待（磁盘 + fsync）在代际校验之后，
          // 写回游标前必须再校验一次，否则旧服务器游标会覆盖换址重置。
          if (generation !== this.generation) return stale();
          state.fetchCursor = page.cursor;
          await this.persistState();
          appendedSinceLastPersist = false; // lamport 已随本次落盘
          // 游标未推进仍声称 hasMore：防服务端异常导致死循环
          if (!page.hasMore || page.cursor === previousCursor) break;
        }
      }

      if (generation !== this.generation) return stale();
      this.lastSyncAt = new Date(this.now()).toISOString();
      this.lastError = null;
      await this.persistState();

      if (appliedSessions.size > 0) {
        this.deps.onRemoteEventsApplied?.(Array.from(appliedSessions));
      }
      return { ok: true, error: null };
    } catch (error) {
      const mapped = toRunError(error);
      // 主动中止（stop / 退出）不算失败，不污染 lastError；
      // 复审 P2-3①：换址后旧轮的非 aborted 错误（401/500、落盘失败）同样不写回——
      // 换址重置刚清零 lastError，旧服务器错误不得再污染面板。
      if (mapped.code !== "aborted" && generation === this.generation) {
        this.lastError = mapped;
        this.log(`[Sync] 同步失败（保留游标/水位，下轮重试）: ${mapped.code} ${mapped.message}`);
      }
      return { ok: false, error: mapped };
    } finally {
      if (this.abortController === controller) this.abortController = null;
    }
  }

  private collectKnownEventIds(store: SyncEventStore): Set<string> {
    const known = new Set(store.getLocalEventIds());
    for (const event of store.getRemoteEvents()) known.add(event.eventId);
    return known;
  }

  /** 入库去重（local + remote 已见 eventId 跳过）；返回新增条数并推进 lamport。 */
  private async appendRemoteEvents(
    store: SyncEventStore,
    state: SyncState,
    events: readonly SyncEventV0[],
    known: Set<string>,
    appliedSessions: Set<string>,
  ): Promise<number> {
    const fresh: SyncEventV0[] = [];
    for (const event of events) {
      if (known.has(event.eventId)) continue;
      known.add(event.eventId);
      fresh.push(event);
    }
    if (fresh.length === 0) return 0;
    await store.appendRemote(fresh);
    for (const event of fresh) {
      state.lamport = Math.max(state.lamport, event.lamport);
      // 自己的事件 fetch 回来已被 known 去重；此处再按 deviceId 兜底，只对远端会话触发刷新
      if (event.deviceId !== state.deviceId) appliedSessions.add(event.sessionId);
    }
    return fresh.length;
  }

  // ── 状态 / 配置 / 配对 ────────────────────────────────────────────────────

  async getStatus(): Promise<SyncStatus> {
    const settings = this.loadSettings();
    let state: SyncState | null = null;
    try {
      state = await this.peekState();
    } catch (error) {
      this.log(`[Sync] 读取状态失败: ${error instanceof Error ? error.message : String(error)}`);
    }
    let store: SyncEventStore | null = null;
    try {
      store = await this.ensureStore(false);
    } catch (error) {
      this.log(`[Sync] 读取事件库失败: ${error instanceof Error ? error.message : String(error)}`);
    }
    const localCount = store ? store.getLocalCount() : 0;
    return {
      enabled: settings.enabled,
      configured: Boolean(settings.baseUrl && settings.token),
      baseUrl: settings.baseUrl,
      hasToken: Boolean(settings.token),
      deviceId: state?.deviceId ?? null,
      serverDeviceId: state?.serverDeviceId ?? null,
      syncing: this.inFlight !== null,
      lastSyncAt: this.lastSyncAt,
      lastError: this.lastError ? { ...this.lastError } : null,
      pendingCount: Math.max(0, localCount - (state?.pushedCount ?? 0)),
      cursor: state?.fetchCursor ?? null,
      localEventCount: localCount,
      remoteEventCount: store ? store.getRemoteCount() : 0,
    };
  }

  async getConfig(): Promise<SyncConfigPublic> {
    const settings = this.loadSettings();
    let state: SyncState | null = null;
    try {
      state = await this.peekState();
    } catch (error) {
      this.log(`[Sync] 读取状态失败: ${error instanceof Error ? error.message : String(error)}`);
    }
    return {
      ...toPublicSyncConfig(settings),
      deviceId: state?.deviceId ?? null,
      serverDeviceId: state?.serverDeviceId ?? null,
    };
  }

  async saveConfig(input: SyncSaveConfigInput): Promise<SyncConfigPublic> {
    const current = this.loadSettings();
    const patch: Partial<SyncSettings> = {};
    if (typeof input.enabled === "boolean") patch.enabled = input.enabled;
    if (typeof input.baseUrl === "string") patch.baseUrl = input.baseUrl.trim();
    if (typeof input.deviceName === "string") patch.deviceName = input.deviceName;
    if (input.clearToken === true) patch.token = "";
    else if (typeof input.token === "string") patch.token = input.token;
    // 换 baseUrl 且未同时提供新 token：清掉既有 token，避免把旧凭据发往新主机；
    // 清后 hasToken=false，UI 提示重新配对（或重新填写令牌）。
    const baseUrlChanged = typeof input.baseUrl === "string"
      && normalizeBaseUrlKey(input.baseUrl) !== normalizeBaseUrlKey(current.baseUrl);
    const hasNewToken = typeof input.token === "string" && input.token.trim().length > 0;
    if (baseUrlChanged && input.clearToken !== true && !hasNewToken) patch.token = "";
    this.settings = saveSyncSettings(patch);

    // #IKJSNA：换址即换服务器——state 中的游标/推送水位/服务器身份属于旧服务器，
    // 一并重置（peekState：state 不存在时不创建、零副作用；重配对时会重新 clone/重推）。
    // 竞态（复审 P1-1）：先递增代际并中止在途轮次，旧轮的任何结算都会被丢弃，
    // 不会用旧服务器游标 / 水位覆盖本次重置；面板内存状态同步清零。
    if (baseUrlChanged) {
      this.generation++;
      this.abortController?.abort();
      this.lastSyncAt = null;
      this.lastError = null;
      const state = await this.peekState();
      if (state) {
        state.fetchCursor = null;
        state.pushedCount = 0;
        state.serverDeviceId = null;
        await this.persistState();
      }
    }

    if (this.settings.enabled) {
      if (this.running) this.requestSync(); // 配置保存后一次
      else await this.start(); // start 内含首轮
    } else {
      await this.stop();
    }
    return this.getConfig();
  }

  async pair(input: SyncPairInput): Promise<SyncConfigPublic> {
    const current = this.loadSettings();
    const baseUrl = (input.baseUrl ?? current.baseUrl).trim().replace(/\/+$/, "");
    const deviceName = (input.deviceName ?? current.deviceName).trim() || "桌面端";
    const code = input.code.trim();
    if (!baseUrl) throw new SyncHttpError("invalid_config", 0, undefined, "缺少服务器地址");
    if (!code) throw new SyncHttpError("invalid_config", 0, undefined, "缺少配对码");

    const state = await this.ensureState();
    const client = this.buildClient({ baseUrl, token: "" });
    const paired = await client.pair(code, deviceName);
    if (!paired.token) throw new SyncHttpError("http", 0, undefined, "服务器未返回 token");

    // #IKJSNA：换服务器（地址变化）时旧游标/推送水位/服务器设备身份全部失效——
    // fetchCursor 是 A 服务器的插入序游标，带到 B 会静默漏拉远端事件；pushedCount
    // 是全局推送水位，不归零则本地历史永不重推到 B。换址时一并重置（重 clone / 重推）。
    const baseUrlChanged = normalizeBaseUrlKey(baseUrl) !== normalizeBaseUrlKey(current.baseUrl);
    this.settings = saveSyncSettings({ baseUrl, deviceName, token: paired.token });
    if (baseUrlChanged) {
      // 竞态（复审 P1-1）：同 saveConfig——代际 + 中止在途，旧轮结算不得覆盖重置
      this.generation++;
      this.abortController?.abort();
      this.lastSyncAt = null;
      this.lastError = null;
      state.fetchCursor = null;
      state.pushedCount = 0;
      state.serverDeviceId = paired.deviceId || null;
    } else {
      // 同址重配对：协议身份与游标/水位继续有效，仅刷新服务器设备身份
      state.serverDeviceId = paired.deviceId || state.serverDeviceId;
    }
    await this.persistState();

    if (this.settings.enabled) {
      if (this.running) this.requestSync();
      else await this.start();
    }
    return this.getConfig();
  }

  async createPairCode(): Promise<SyncPairCodeResult> {
    const settings = this.loadSettings();
    if (!settings.baseUrl || !settings.token) {
      throw new SyncHttpError("invalid_config", 0, undefined, "同步未配对（缺少服务器地址或 token）");
    }
    const client = this.buildClient({ baseUrl: settings.baseUrl, token: settings.token });
    const result = await client.createPairCode();
    if (!result.code) throw new SyncHttpError("http", 0, undefined, "服务器未返回配对码");
    return result;
  }

  async unpair(): Promise<SyncConfigPublic> {
    const state = await this.ensureState();
    // 保留 outbox / state（重新配对后幂等重推、重拉）；只清凭据与游标。
    // 竞态（复审 P1-1 / 复审三轮 P2-2①）：同换址——代际 + 立即 abort 在途轮次
    // （与 saveConfig / pair 同口径；不押后到 stop()，否则持久化窗口内旧轮仍可能向旧服务器再出网一次）。
    this.generation++;
    this.abortController?.abort();
    this.settings = saveSyncSettings({ token: "" });
    state.serverDeviceId = null;
    state.fetchCursor = null;
    this.lastSyncAt = null;
    this.lastError = null;
    await this.persistState();
    await this.stop();
    return this.getConfig();
  }

  isEnabled(): boolean {
    return this.loadSettings().enabled;
  }

  async getRemoteSessionEvents(sessionId: string): Promise<SyncEventV0[]> {
    if (!this.isEnabled()) return [];
    try {
      const state = await this.peekState();
      const store = await this.ensureStore(false);
      if (!store) return [];
      // state 缺失时 deviceId 未知（null）：无身份可过滤，返回 inbox 内该会话全部事件
      return store
        .getRemoteEventsForSession(sessionId)
        .filter((event) => event.deviceId !== state?.deviceId);
    } catch (error) {
      this.log(`[Sync] 读取远端事件失败: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }
}

export function createSyncService(deps: SyncServiceDeps): SyncService {
  return new SyncServiceController(deps);
}

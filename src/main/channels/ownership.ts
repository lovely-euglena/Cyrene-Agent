// channels/ownership —— 桌面归属租约客户端与本地启停决策（设计 §5，IKJK2P）。
//
// 唯一权威是服务端 channels.db.channel_ownership；桌面只持建议缓存，任何动作前以服务端为准（§5.1）。
// 本模块不 import electron / settings-store：配置由调用方注入（init.ts 注入 loadChannelsSettings().remote），
// 便于 vitest 直接测 HTTP 与失败路径（§5.7）。
//
// 失败模式（§5.7）：
//   - 状态轮询失败：连续失败计数 + lastSuccessAt；TTL 内以最后一次成功为准，超 TTL 降级 unknown；
//   - 租约丢失（heartbeat lost）：调用方立即停本机适配器，下一轮重新 claim；
//   - 服务端不可达兜底：仅显式 failover=local 且不可达 ≥ 宽限（默认 300s）才 failover_local；
//     启动时不可达不自动接管（§5.5），用户可显式 requestLocalRun。

import type { ChannelId } from "./types";

export type ChannelsRemoteFailover = "off" | "local";

/** channels.remote 显式配置（Q6：IKJK2I 接线前独立填写，不与同步设置合并）。 */
export interface ChannelsRemoteConfig {
  enabled: boolean;
  baseUrl?: string;
  /** 显式 Bearer token（接线前允许填写；磁盘加密存储）。 */
  token?: string;
  /** 服务端恢复后默认交回（§5.5；false = 维持本机）。 */
  preferServer: boolean;
  failover: ChannelsRemoteFailover;
  failoverGraceSeconds: number;
}

export const DEFAULT_FAILOVER_GRACE_SECONDS = 300;
export const DEFAULT_LEASE_TTL_SECONDS = 180;
export const OWNERSHIP_POLL_INTERVAL_MS = 30_000;
export const OWNERSHIP_HEARTBEAT_INTERVAL_MS = 60_000;
/** 控制面请求超时：网络黑洞时避免 stop/退出流程被无限期阻塞（§5.7）。 */
export const OWNERSHIP_REQUEST_TIMEOUT_MS = 12_000;
/** remote 配置读取缓存：入站门闩每条消息都会 decide()，避免同步读盘 + token 解密。 */
export const OWNERSHIP_CONFIG_CACHE_MS = 5_000;

/** 配置规范化（settings-store 与测试共用；baseUrl 去尾斜杠）。 */
export function normalizeChannelsRemoteConfig(input: unknown): ChannelsRemoteConfig {
  const raw = (input ?? {}) as Partial<ChannelsRemoteConfig>;
  const rawBaseUrl = typeof raw.baseUrl === "string" ? raw.baseUrl.trim().replace(/\/+$/, "") : "";
  const token = typeof raw.token === "string" ? raw.token : "";
  const grace = Number(raw.failoverGraceSeconds);
  return {
    enabled: raw.enabled === true,
    ...(rawBaseUrl ? { baseUrl: rawBaseUrl } : {}),
    ...(token ? { token } : {}),
    preferServer: raw.preferServer !== false,
    failover: raw.failover === "local" ? "local" : "off",
    failoverGraceSeconds: Number.isFinite(grace) && grace > 0
      ? Math.min(3600, Math.max(30, Math.floor(grace)))
      : DEFAULT_FAILOVER_GRACE_SECONDS,
  };
}

export type ChannelOwner = "server" | "desktop";

export interface OwnershipChannelState {
  owner: ChannelOwner;
  holder?: string;
  leaseExpiresAt?: string;
}

export interface OwnershipSnapshot {
  serverId: string;
  leaseTtlSeconds: number;
  channels: Record<string, OwnershipChannelState>;
}

export type LocalChannelPhase = "local" | "paused_remote" | "running_local" | "failover_local" | "unknown";

export interface OwnershipDecision {
  phase: LocalChannelPhase;
  runLocal: boolean;
  serverOwner: boolean;
}

export interface OwnershipDecisionInput {
  remoteEnabled: boolean;
  state: OwnershipChannelState | null;
  /** 最后一次成功轮询的时间（null = 从未成功）。 */
  lastSuccessAt: number | null;
  now: number;
  leaseTtlSeconds: number;
  failover: ChannelsRemoteFailover;
  failoverGraceMs: number;
  serverReachable: boolean;
  /** 本进程是否持有该渠道的租约意图（claim 成功 / 手动本机运行）。 */
  claimedByThisProcess: boolean;
  /** 用户显式「在本机运行」（服务端不可达时允许手动兜底，§5.5）。 */
  manualLocal?: boolean;
}

/**
 * 单渠道本地启停决策（§5.1/§5.5/§5.7）。
 * 保守原则：服务端可达性存疑时不与仍在运行的服务端双主；兜底必须显式开启。
 */
export function decideChannelOwnership(input: OwnershipDecisionInput): OwnershipDecision {
  if (!input.remoteEnabled) return { phase: "local", runLocal: true, serverOwner: false };
  if (input.manualLocal) return { phase: "failover_local", runLocal: true, serverOwner: false };

  const state = input.state;
  const ageMs = input.lastSuccessAt === null ? Number.POSITIVE_INFINITY : input.now - input.lastSuccessAt;
  const snapshotValid = Number.isFinite(ageMs) && ageMs <= input.leaseTtlSeconds * 1000;
  // 启动时不可达（从未成功）不自动接管（§5.5）；运行期不可达才可能触发显式兜底
  const failoverReady = input.failover === "local"
    && input.lastSuccessAt !== null
    && ageMs >= input.failoverGraceMs;

  if (!snapshotValid) {
    if (failoverReady) return { phase: "failover_local", runLocal: true, serverOwner: false };
    return { phase: "unknown", runLocal: false, serverOwner: false };
  }
  if (state?.owner === "server") {
    if (!input.serverReachable && failoverReady) {
      return { phase: "failover_local", runLocal: true, serverOwner: false };
    }
    return { phase: "paused_remote", runLocal: false, serverOwner: true };
  }
  if (state?.owner === "desktop") {
    // 有效租约但非本进程意图 = 另一台设备持有（Q8）：保持被动，不排队
    if (!input.claimedByThisProcess) return { phase: "paused_remote", runLocal: false, serverOwner: false };
    return { phase: "running_local", runLocal: true, serverOwner: false };
  }
  // 快照有效但该渠道不在服务端托管列表：本机照常运行
  return { phase: "local", runLocal: true, serverOwner: false };
}

// ── 客户端 ─────────────────────────────────────────────────────────────────

export interface OwnershipClientOptions {
  loadConfig: () => ChannelsRemoteConfig;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (message: string) => void;
}

export interface OwnershipClaimOutcome {
  granted: ChannelId[];
  denied: ChannelId[];
  leaseExpiresAt?: string;
  error?: string;
}

export interface OwnershipHeartbeatOutcome {
  renewed: ChannelId[];
  lost: ChannelId[];
  error?: string;
}

export interface OwnershipReleaseOutcome {
  released: ChannelId[];
  error?: string;
}

export interface ProactiveForwardInput {
  intentId: string;
  text: string;
  sessionId?: string;
}

export interface ProactiveForwardResult {
  ok: boolean;
  delivered?: boolean;
  duplicate?: boolean;
  error?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ChannelOwnershipClient {
  private snapshot: OwnershipSnapshot | null = null;
  private lastSuccessAt: number | null = null;
  private consecutiveFailures = 0;
  private lastError: string | null = null;
  /** remote 配置 TTL 缓存（配置保存后由调用方 invalidateConfig 立即失效）。 */
  private configCache: { value: ChannelsRemoteConfig; at: number } | null = null;
  /** 在途控制面请求的中止开关（stop/shutdown 调 abortInFlight）。 */
  private abortController = new AbortController();
  /** 本机想持有租约的渠道（claim 成功或手动指定；用于 lost 后下一轮重新 claim）。 */
  private readonly desiredLocal = new Set<ChannelId>();
  /** 用户显式「在本机运行」但服务端不可达时的手动兜底标记。 */
  private readonly forceLocal = new Set<ChannelId>();

  constructor(private readonly options: OwnershipClientOptions) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private log(message: string): void {
    (this.options.log ?? ((text: string) => console.warn(text)))(message);
  }

  /** 读取 remote 配置（TTL 缓存）：高频入站路径不重复同步读盘 + 解密 token。 */
  private config(): ChannelsRemoteConfig {
    const at = this.now();
    if (this.configCache && at - this.configCache.at < OWNERSHIP_CONFIG_CACHE_MS) {
      return this.configCache.value;
    }
    const value = this.options.loadConfig();
    this.configCache = { value, at };
    return value;
  }

  /** 配置变更（settings 保存）后立即失效缓存。 */
  invalidateConfig(): void {
    this.configCache = null;
  }

  /** 服务端恢复后是否优先交回（§5.5，默认 true）。 */
  prefersServer(): boolean {
    return this.config().preferServer !== false;
  }

  /** 中止所有在途控制面请求（stop/shutdown 用）；之后的新请求不受影响。 */
  abortInFlight(): void {
    this.abortController.abort();
    this.abortController = new AbortController();
  }

  getSnapshot(): OwnershipSnapshot | null {
    return this.snapshot;
  }

  getLastSuccessAt(): number | null {
    return this.lastSuccessAt;
  }

  getFailureCount(): number {
    return this.consecutiveFailures;
  }

  getLastError(): string | null {
    return this.lastError;
  }

  get serverReachable(): boolean {
    return this.consecutiveFailures === 0 && this.lastSuccessAt !== null;
  }

  getChannelState(channel: ChannelId): OwnershipChannelState | null {
    return this.snapshot?.channels?.[channel] ?? null;
  }

  wantsLocal(channel: ChannelId): boolean {
    return this.desiredLocal.has(channel);
  }

  wantsManualLocal(channel: ChannelId): boolean {
    return this.forceLocal.has(channel);
  }

  desiredLocalChannels(): ChannelId[] {
    return Array.from(this.desiredLocal);
  }

  markDesiredLocal(channels: ChannelId[]): void {
    for (const channel of channels) this.desiredLocal.add(channel);
  }

  clearDesiredLocal(channels: ChannelId[]): void {
    for (const channel of channels) this.desiredLocal.delete(channel);
  }

  markForceLocal(channels: ChannelId[]): void {
    for (const channel of channels) this.forceLocal.add(channel);
  }

  clearForceLocal(channels: ChannelId[]): void {
    for (const channel of channels) this.forceLocal.delete(channel);
  }

  /** 归属=server 且本机未在服务时，proactive 应转发到服务端（§5.4/§5.5）。 */
  shouldForwardProactive(channel: ChannelId): boolean {
    const config = this.config();
    if (!config.enabled || !config.baseUrl) return false;
    // 兜底/本机运行期间本机已在服务，且服务端可能不可达：不再转发（避免消息丢失）
    if (this.decide(channel).runLocal) return false;
    return this.getChannelState(channel)?.owner === "server";
  }

  decide(channel: ChannelId): OwnershipDecision {
    const config = this.config();
    return decideChannelOwnership({
      remoteEnabled: config.enabled && Boolean(config.baseUrl),
      state: this.getChannelState(channel),
      lastSuccessAt: this.lastSuccessAt,
      now: this.now(),
      leaseTtlSeconds: this.snapshot?.leaseTtlSeconds ?? DEFAULT_LEASE_TTL_SECONDS,
      failover: config.failover,
      failoverGraceMs: (config.failoverGraceSeconds ?? DEFAULT_FAILOVER_GRACE_SECONDS) * 1000,
      serverReachable: this.serverReachable,
      claimedByThisProcess: this.desiredLocal.has(channel),
      manualLocal: this.forceLocal.has(channel),
    });
  }

  // ── HTTP（控制面 §5.2；失败返回 error 字段，不抛）─────────────────────────

  async poll(): Promise<OwnershipSnapshot | null> {
    const config = this.config();
    if (!config.enabled || !config.baseUrl) return null;
    try {
      const response = await this.request(config, "GET", "/v1/channels/ownership");
      if (!response.ok) throw new Error(await this.readError(response));
      const snapshot = (await response.json()) as OwnershipSnapshot;
      this.snapshot = {
        serverId: snapshot.serverId,
        leaseTtlSeconds: snapshot.leaseTtlSeconds || DEFAULT_LEASE_TTL_SECONDS,
        channels: snapshot.channels ?? {},
      };
      this.lastSuccessAt = this.now();
      this.consecutiveFailures = 0;
      this.lastError = null;
      return this.snapshot;
    } catch (error) {
      this.consecutiveFailures += 1;
      this.lastError = errorMessage(error);
      this.log(`归属状态轮询失败（连续 ${this.consecutiveFailures} 次）: ${this.lastError}`);
      return null;
    }
  }

  async claim(channels: ChannelId[], ttlSeconds?: number): Promise<OwnershipClaimOutcome> {
    const config = this.config();
    if (!config.enabled || !config.baseUrl) return { granted: [], denied: [], error: "remote_disabled" };
    try {
      const response = await this.request(config, "POST", "/v1/channels/ownership/claim", {
        channels,
        ...(ttlSeconds ? { ttlSeconds } : {}),
      });
      if (!response.ok) throw new Error(await this.readError(response));
      const body = (await response.json()) as {
        granted?: string[]; denied?: string[]; leaseExpiresAt?: string;
      };
      const granted = (body.granted ?? []) as ChannelId[];
      const denied = (body.denied ?? []) as ChannelId[];
      // granted：租约到手，手动兜底标记可清；denied：他机持有，必须清手动标记
      // 否则 decide() 的 manualLocal 优先分支会继续本机运行，形成残余双主
      for (const channel of granted) {
        this.desiredLocal.add(channel);
        this.forceLocal.delete(channel);
      }
      for (const channel of denied) {
        this.desiredLocal.delete(channel);
        this.forceLocal.delete(channel);
      }
      this.applyLease(granted, body.leaseExpiresAt);
      return { granted, denied, leaseExpiresAt: body.leaseExpiresAt };
    } catch (error) {
      this.log(`归属 claim 失败: ${errorMessage(error)}`);
      return { granted: [], denied: [], error: errorMessage(error) };
    }
  }

  async heartbeat(channels: ChannelId[]): Promise<OwnershipHeartbeatOutcome> {
    const config = this.config();
    if (!config.enabled || !config.baseUrl) return { renewed: [], lost: [], error: "remote_disabled" };
    if (channels.length === 0) return { renewed: [], lost: [] };
    try {
      const response = await this.request(config, "POST", "/v1/channels/ownership/heartbeat", { channels });
      if (!response.ok) throw new Error(await this.readError(response));
      const body = (await response.json()) as { renewed?: string[]; lost?: string[] };
      const renewed = (body.renewed ?? []) as ChannelId[];
      const lost = (body.lost ?? []) as ChannelId[];
      const ttlSeconds = this.snapshot?.leaseTtlSeconds ?? DEFAULT_LEASE_TTL_SECONDS;
      this.applyLease(renewed, new Date(this.now() + ttlSeconds * 1000).toISOString());
      // lost：服务端已收回或他机持有；缓存降级为 server，实际状态等下一轮 poll 校正
      for (const channel of lost) this.setChannelState(channel, { owner: "server" });
      return { renewed, lost };
    } catch (error) {
      this.log(`归属心跳失败: ${errorMessage(error)}`);
      return { renewed: [], lost: [], error: errorMessage(error) };
    }
  }

  async release(channels: ChannelId[]): Promise<OwnershipReleaseOutcome> {
    const config = this.config();
    if (!config.enabled || !config.baseUrl) return { released: [], error: "remote_disabled" };
    if (channels.length === 0) return { released: [] };
    try {
      const response = await this.request(config, "POST", "/v1/channels/ownership/release", { channels });
      if (!response.ok) throw new Error(await this.readError(response));
      const body = (await response.json()) as { released?: string[] };
      const released = (body.released ?? []) as ChannelId[];
      // 无 error 即视为交回完成：服务端对 owner≠desktop（已被 sweep 收回）直接跳过且不报错，
      // 只按 released 清意图会让残留 desiredLocal 在下一轮 reclaim 立即重新占用（P1-1）。
      for (const channel of channels) {
        this.desiredLocal.delete(channel);
        this.forceLocal.delete(channel);
      }
      for (const channel of released) {
        this.setChannelState(channel, { owner: "server" });
      }
      return { released };
    } catch (error) {
      this.log(`归属 release 失败: ${errorMessage(error)}`);
      return { released: [], error: errorMessage(error) };
    }
  }

  /** 转发主动消息（§5.4）：服务端 intentId 幂等；失败不回退本机（避免双发）。 */
  async deliverProactive(channel: ChannelId, input: ProactiveForwardInput): Promise<ProactiveForwardResult> {
    const config = this.config();
    if (!config.enabled || !config.baseUrl) return { ok: false, error: "remote_disabled" };
    try {
      const response = await this.request(
        config, "POST", `/v1/channels/${encodeURIComponent(channel)}/proactive`, {
          intentId: input.intentId,
          text: input.text,
          ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        });
      const body = (await response.json().catch(() => null)) as {
        eventId?: string; delivered?: boolean; duplicate?: boolean; error?: string; code?: string;
      } | null;
      if (!response.ok) return { ok: false, error: body?.code ?? `HTTP ${response.status}` };
      return {
        ok: true,
        delivered: body?.delivered !== false,
        duplicate: body?.duplicate === true,
        ...(body?.error ? { error: body.error } : {}),
      };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }

  private applyLease(channels: ChannelId[], leaseExpiresAt: string | undefined): void {
    if (!leaseExpiresAt) return;
    for (const channel of channels) {
      this.setChannelState(channel, { owner: "desktop", leaseExpiresAt });
    }
  }

  private setChannelState(channel: ChannelId, state: OwnershipChannelState): void {
    if (!this.snapshot) return;
    this.snapshot = { ...this.snapshot, channels: { ...this.snapshot.channels, [channel]: state } };
  }

  private async request(
    config: ChannelsRemoteConfig, method: string, path: string, body?: unknown,
  ): Promise<Response> {
    const base = (config.baseUrl ?? "").replace(/\/+$/, "");
    const headers: Record<string, string> = {};
    if (config.token) headers.Authorization = `Bearer ${config.token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const fetchImpl = this.options.fetchImpl
      ?? ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => fetch(input, init));
    // 超时 + 控制器级 abort：网络黑洞不阻塞 stop/退出流程（§5.7）
    const signal = AbortSignal.any([
      AbortSignal.timeout(OWNERSHIP_REQUEST_TIMEOUT_MS),
      this.abortController.signal,
    ]);
    return await fetchImpl(`${base}${path}`, {
      method,
      headers,
      signal,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }

  private async readError(response: Response): Promise<string> {
    try {
      const body = (await response.json()) as { code?: string };
      return body?.code ?? `HTTP ${response.status}`;
    } catch {
      return `HTTP ${response.status}`;
    }
  }
}

// ── 控制器：轮询 / 心跳 / 启停落地 ─────────────────────────────────────────

export interface OwnershipManagerPort {
  listChannels(): ChannelId[];
  startOne(id: ChannelId): Promise<void>;
  pauseOne(id: ChannelId): Promise<void>;
}

export interface ChannelOwnershipControllerOptions {
  manager: OwnershipManagerPort;
  loadConfig: () => ChannelsRemoteConfig;
  client?: ChannelOwnershipClient;
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  log?: (message: string) => void;
  setIntervalImpl?: typeof setInterval;
  clearIntervalImpl?: typeof clearInterval;
}

export interface ChannelOwnershipStatus {
  phase: LocalChannelPhase;
  owner?: ChannelOwner;
  holder?: string;
  leaseExpiresAt?: string;
  serverReachable: boolean;
  failures: number;
}

export class ChannelOwnershipController {
  readonly client: ChannelOwnershipClient;
  private readonly manager: OwnershipManagerPort;
  private readonly log: (message: string) => void;
  private readonly pollIntervalMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly setIntervalImpl: typeof setInterval;
  private readonly clearIntervalImpl: typeof clearInterval;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  /** 自动兜底（非手动）中的渠道：服务端恢复后按 preferServer 交回或维持本机（§5.5）。 */
  private readonly autoFailover = new Set<ChannelId>();
  private readonly phases = new Map<ChannelId, LocalChannelPhase>();
  /** syncNow 单飞（P2-1）：在途轮次与在途期间登记的一次补跑。 */
  private syncInFlight: Promise<void> | null = null;
  private syncQueued = false;

  constructor(options: ChannelOwnershipControllerOptions) {
    this.manager = options.manager;
    this.client = options.client ?? new ChannelOwnershipClient({
      loadConfig: options.loadConfig,
      ...(options.log ? { log: options.log } : {}),
    });
    this.log = options.log ?? ((message: string) => console.warn(`[ChannelOwnership] ${message}`));
    this.pollIntervalMs = options.pollIntervalMs ?? OWNERSHIP_POLL_INTERVAL_MS;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? OWNERSHIP_HEARTBEAT_INTERVAL_MS;
    this.setIntervalImpl = options.setIntervalImpl ?? setInterval;
    this.clearIntervalImpl = options.clearIntervalImpl ?? clearInterval;
  }

  /** 控制器是否在运行（运行期 remote 开关切换/重启路径判定用）。 */
  get isRunning(): boolean {
    return this.running;
  }

  /** 启动：首次同步 + 30s 轮询 + 60s 心跳（timer unref，不阻塞进程退出）。 */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.syncNow();
    if (!this.running) return; // 首次同步期间被 stop：不得再挂定时器
    this.pollTimer = this.setIntervalImpl(() => { void this.syncNow(); }, this.pollIntervalMs);
    this.heartbeatTimer = this.setIntervalImpl(() => { void this.heartbeatNow(); }, this.heartbeatIntervalMs);
    (this.pollTimer as { unref?: () => void }).unref?.();
    (this.heartbeatTimer as { unref?: () => void }).unref?.();
  }

  /** 停止：清定时器 + 中止在途请求 + 尽力交回本机租约（服务端可立即恢复，不用等 TTL）。 */
  async stop(): Promise<void> {
    this.running = false;
    // 中止在途控制面请求：网络黑洞时 stop/退出流程不被无限期阻塞（§5.7）
    this.client.abortInFlight();
    if (this.pollTimer) {
      this.clearIntervalImpl(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.heartbeatTimer) {
      this.clearIntervalImpl(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.autoFailover.clear();
    const desired = this.client.desiredLocalChannels();
    if (desired.length > 0) await this.client.release(desired);
  }

  /**
   * 一轮同步（P2-1 单飞 + 排队）：定时轮询 / IPC 重启 / 运行期开关 / 启动多源触发时，
   * 已有同步在途则并入当前轮并登记一次补跑，避免并发对同一渠道重复 claim/startOne。
   */
  syncNow(): Promise<void> {
    if (this.syncInFlight) {
      this.syncQueued = true;
      return this.syncInFlight;
    }
    this.syncInFlight = this.drainSync().finally(() => {
      this.syncInFlight = null;
      // 关窗：drain 退出与 finally 之间到达的触发不丢，串行补跑（P2-1）
      if (this.syncQueued && this.running) {
        this.syncQueued = false;
        void this.syncNow();
      }
    });
    return this.syncInFlight;
  }

  private async drainSync(): Promise<void> {
    do {
      this.syncQueued = false;
      await this.runSync();
    } while (this.syncQueued && this.running);
  }

  /** 一轮同步：poll → 同设备租约探测 → 兜底恢复判定 → 意图重 claim → 落地启停。 */
  private async runSync(): Promise<void> {
    if (!this.running) return;
    const snapshot = await this.client.poll();
    if (!this.running) return; // stop 后不得再落地启停
    if (snapshot) {
      // 桌面进程重启：owner=desktop 但本进程无意图 → 心跳探测（holder=deviceId 时 renewed）
      const foreign = (Object.entries(snapshot.channels ?? {}) as Array<[string, OwnershipChannelState]>)
        .filter(([, state]) => state.owner === "desktop")
        .map(([id]) => id as ChannelId)
        .filter((id) => !this.client.wantsLocal(id));
      if (foreign.length > 0) {
        const probe = await this.client.heartbeat(foreign);
        if (probe.renewed.length > 0) this.client.markDesiredLocal(probe.renewed);
      }
      // 兜底恢复（§5.5）：服务端恢复后按 preferServer 交回（默认）或 claim 维持本机（用户偏好）。
      // 手动「本机运行」是用户明确意图，不在此列（由 reclaim 续租维持）。
      if (this.client.serverReachable && this.autoFailover.size > 0) {
        const recovering = Array.from(this.autoFailover).filter((id) => !this.client.wantsManualLocal(id));
        if (recovering.length > 0) {
          if (this.client.prefersServer()) {
            const outcome = await this.client.release(recovering);
            if (!outcome.error) {
              // 不依赖 released 列表：服务端 sweep 已收回时返回空集且无 error，
              // 此处无条件清意图，确保同轮 reclaim 不再把它捡回（P1-1）。
              this.client.clearDesiredLocal(recovering);
              for (const id of recovering) this.autoFailover.delete(id);
            }
          } else {
            const outcome = await this.client.claim(recovering);
            if (!outcome.error) for (const id of recovering) this.autoFailover.delete(id);
          }
          if (!this.running) return;
        }
      }
      // 租约丢失/服务端收回后下一轮重新 claim（§5.7）；
      // claim 内部按 granted/denied 清理 desiredLocal 与 forceLocal
      const reclaim = this.client.desiredLocalChannels()
        .filter((id) => this.client.getChannelState(id)?.owner !== "desktop");
      if (reclaim.length > 0) await this.client.claim(reclaim);
    }
    if (!this.running) return;
    await this.applyPlan();
  }

  /** 一轮心跳：lost 的渠道立即停本机适配器（§5.7），下一轮 sync 重新 claim。 */
  async heartbeatNow(): Promise<void> {
    if (!this.running) return;
    const desired = this.client.desiredLocalChannels();
    if (desired.length === 0) return;
    const outcome = await this.client.heartbeat(desired);
    if (!this.running) return; // stop 后不得再落地启停
    if (outcome.lost.length > 0) {
      this.log(`租约丢失，立即停本机适配器: ${outcome.lost.join(",")}`);
      await this.applyPlan();
    }
  }

  /** 用户显式「在本机运行」：claim 成功或服务端不可达（手动兜底）时启动本机适配器。 */
  async requestLocalRun(channels: ChannelId[]): Promise<OwnershipClaimOutcome> {
    this.client.markForceLocal(channels);
    this.client.markDesiredLocal(channels);
    // 手动意图优先：不再参与「服务端恢复自动交回」
    for (const id of channels) this.autoFailover.delete(id);
    const outcome = await this.client.claim(channels);
    await this.applyPlan();
    return outcome;
  }

  /** 用户切回云端：release + 停本机（服务端宽限后恢复）。 */
  async requestServerRun(channels: ChannelId[]): Promise<OwnershipReleaseOutcome> {
    this.client.clearForceLocal(channels);
    for (const id of channels) this.autoFailover.delete(id);
    const outcome = await this.client.release(channels);
    await this.applyPlan();
    return outcome;
  }

  /** 按当前归属判定落地每个渠道的启停（manager.startOne / pauseOne 均幂等且单渠道容错）。 */
  async applyPlan(): Promise<void> {
    for (const id of this.manager.listChannels()) {
      if (!this.running) return; // stop 后不得再落地启停
      const decision = this.client.decide(id);
      this.phases.set(id, decision.phase);
      // 自动兜底标记（仅服务端托管过的渠道）：服务端恢复后按 preferServer 交回/维持（§5.5）
      if (decision.phase === "failover_local"
        && this.client.getChannelState(id) !== null
        && !this.client.wantsManualLocal(id)) {
        this.autoFailover.add(id);
      } else if (decision.phase === "local") {
        this.autoFailover.delete(id);
      }
      if (decision.runLocal) await this.manager.startOne(id);
      else await this.manager.pauseOne(id);
    }
  }

  shouldRunLocal(id: ChannelId): boolean {
    return this.client.decide(id).runLocal;
  }

  shouldProcess(id: ChannelId): boolean {
    return this.shouldRunLocal(id);
  }

  getPhase(id: ChannelId): LocalChannelPhase {
    return this.phases.get(id) ?? "unknown";
  }

  getStatusDetail(): Record<string, ChannelOwnershipStatus> {
    const detail: Record<string, ChannelOwnershipStatus> = {};
    for (const id of this.manager.listChannels()) {
      const state = this.client.getChannelState(id);
      detail[id] = {
        phase: this.getPhase(id),
        ...(state?.owner ? { owner: state.owner } : {}),
        ...(state?.holder ? { holder: state.holder } : {}),
        ...(state?.leaseExpiresAt ? { leaseExpiresAt: state.leaseExpiresAt } : {}),
        serverReachable: this.client.serverReachable,
        failures: this.client.getFailureCount(),
      };
    }
    return detail;
  }
}

export function createChannelOwnershipController(
  options: ChannelOwnershipControllerOptions,
): ChannelOwnershipController {
  return new ChannelOwnershipController(options);
}

// ── 运行期分流判定（init.ts 调用；抽成纯函数便于覆盖，P1-4）──────────────────

/** syncOwnershipRuntime 的动作：开启控制器 / 停控制器回本地 / 仅刷新配置 / 无动作。 */
export type OwnershipRuntimeAction =
  | "noop"
  | "reload-config"
  | "start-controller"
  | "stop-controller-and-start-all";

export function planOwnershipRuntimeAction(input: {
  /** channels 子系统是否已启动（未启动时开关只落盘，不产生运行时动作）。 */
  started: boolean;
  remoteEnabled: boolean;
  controllerRunning: boolean;
}): OwnershipRuntimeAction {
  if (!input.started) return "noop";
  if (input.remoteEnabled) {
    // 已运行也要 invalidateConfig：保存的 baseUrl/token/preferServer 需立即生效
    return input.controllerRunning ? "reload-config" : "start-controller";
  }
  return input.controllerRunning ? "stop-controller-and-start-all" : "noop";
}

/** CHANNELS_RESTART 的动作：本地 startAll / remote 已运行 syncNow / remote 未运行起控制器。 */
export type ChannelsRestartAction = "start-all" | "sync" | "start-controller";

export function planChannelsRestart(input: {
  remoteEnabled: boolean;
  controllerAvailable: boolean;
  controllerRunning: boolean;
}): ChannelsRestartAction {
  if (!input.remoteEnabled || !input.controllerAvailable) return "start-all";
  return input.controllerRunning ? "sync" : "start-controller";
}

// ── 模块级接线（init.ts 注入；dispatcher.ts 读取门闩）──────────────────────

let activeClient: ChannelOwnershipClient | null = null;

export function setActiveOwnershipClient(client: ChannelOwnershipClient | null): void {
  activeClient = client;
}

export function getActiveOwnershipClient(): ChannelOwnershipClient | null {
  return activeClient;
}

let processGate: ((channel: ChannelId) => boolean) | null = null;

export function setChannelProcessGate(gate: ((channel: ChannelId) => boolean) | null): void {
  processGate = gate;
}

/** dispatcher 第二道防线：无门闩时默认放行（保持既有本地行为）。 */
export function shouldProcessChannel(channel: ChannelId): boolean {
  return processGate ? processGate(channel) : true;
}

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

  /** 归属=server 且远程配置可用时，proactive 应转发到服务端（§5.4）。 */
  shouldForwardProactive(channel: ChannelId): boolean {
    const config = this.options.loadConfig();
    return config.enabled && Boolean(config.baseUrl) && this.getChannelState(channel)?.owner === "server";
  }

  decide(channel: ChannelId): OwnershipDecision {
    const config = this.options.loadConfig();
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
    const config = this.options.loadConfig();
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
    const config = this.options.loadConfig();
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
      for (const channel of granted) this.desiredLocal.add(channel);
      for (const channel of denied) this.desiredLocal.delete(channel);
      this.applyLease(granted, body.leaseExpiresAt);
      return { granted, denied, leaseExpiresAt: body.leaseExpiresAt };
    } catch (error) {
      this.log(`归属 claim 失败: ${errorMessage(error)}`);
      return { granted: [], denied: [], error: errorMessage(error) };
    }
  }

  async heartbeat(channels: ChannelId[]): Promise<OwnershipHeartbeatOutcome> {
    const config = this.options.loadConfig();
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
    const config = this.options.loadConfig();
    if (!config.enabled || !config.baseUrl) return { released: [], error: "remote_disabled" };
    if (channels.length === 0) return { released: [] };
    try {
      const response = await this.request(config, "POST", "/v1/channels/ownership/release", { channels });
      if (!response.ok) throw new Error(await this.readError(response));
      const body = (await response.json()) as { released?: string[] };
      const released = (body.released ?? []) as ChannelId[];
      for (const channel of released) {
        this.desiredLocal.delete(channel);
        this.forceLocal.delete(channel);
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
    const config = this.options.loadConfig();
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
    return await fetchImpl(`${base}${path}`, {
      method,
      headers,
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
  private readonly phases = new Map<ChannelId, LocalChannelPhase>();

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

  /** 启动：首次同步 + 30s 轮询 + 60s 心跳（timer unref，不阻塞进程退出）。 */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.syncNow();
    this.pollTimer = this.setIntervalImpl(() => { void this.syncNow(); }, this.pollIntervalMs);
    this.heartbeatTimer = this.setIntervalImpl(() => { void this.heartbeatNow(); }, this.heartbeatIntervalMs);
    (this.pollTimer as { unref?: () => void }).unref?.();
    (this.heartbeatTimer as { unref?: () => void }).unref?.();
  }

  /** 停止：清定时器 + 尽力交回本机租约（服务端可立即恢复，不用等 TTL）。 */
  async stop(): Promise<void> {
    this.running = false;
    if (this.pollTimer) {
      this.clearIntervalImpl(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.heartbeatTimer) {
      this.clearIntervalImpl(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    const desired = this.client.desiredLocalChannels();
    if (desired.length > 0) await this.client.release(desired);
  }

  /** 一轮同步：poll → 同设备租约探测 → 意图重 claim → 落地启停。 */
  async syncNow(): Promise<void> {
    const snapshot = await this.client.poll();
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
      // 租约丢失/服务端收回后下一轮重新 claim（§5.7）
      const reclaim = this.client.desiredLocalChannels()
        .filter((id) => this.client.getChannelState(id)?.owner !== "desktop");
      if (reclaim.length > 0) {
        const outcome = await this.client.claim(reclaim);
        if (outcome.granted.length > 0) this.client.clearForceLocal(outcome.granted);
      }
    }
    await this.applyPlan();
  }

  /** 一轮心跳：lost 的渠道立即停本机适配器（§5.7），下一轮 sync 重新 claim。 */
  async heartbeatNow(): Promise<void> {
    const desired = this.client.desiredLocalChannels();
    if (desired.length === 0) return;
    const outcome = await this.client.heartbeat(desired);
    if (outcome.lost.length > 0) {
      this.log(`租约丢失，立即停本机适配器: ${outcome.lost.join(",")}`);
      await this.applyPlan();
    }
  }

  /** 用户显式「在本机运行」：claim 成功或服务端不可达（手动兜底）时启动本机适配器。 */
  async requestLocalRun(channels: ChannelId[]): Promise<OwnershipClaimOutcome> {
    this.client.markForceLocal(channels);
    this.client.markDesiredLocal(channels);
    const outcome = await this.client.claim(channels);
    if (outcome.granted.length > 0) this.client.clearForceLocal(outcome.granted);
    if (outcome.denied.length > 0) this.client.clearForceLocal(outcome.denied);
    await this.applyPlan();
    return outcome;
  }

  /** 用户切回云端：release + 停本机（服务端宽限后恢复）。 */
  async requestServerRun(channels: ChannelId[]): Promise<OwnershipReleaseOutcome> {
    this.client.clearForceLocal(channels);
    const outcome = await this.client.release(channels);
    await this.applyPlan();
    return outcome;
  }

  /** 按当前归属判定落地每个渠道的启停（manager.startOne / pauseOne 均幂等）。 */
  async applyPlan(): Promise<void> {
    for (const id of this.manager.listChannels()) {
      const decision = this.client.decide(id);
      this.phases.set(id, decision.phase);
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

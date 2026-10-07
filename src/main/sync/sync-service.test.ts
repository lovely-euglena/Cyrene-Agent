// sync-service 单测（IKJK2I B）：假 store / 假 exporter / 假客户端全流程。
// 覆盖：初次 clone / 增量 fetch / 重复幂等 / 401 失败保留水位 / 单飞 / pair / unpair / 配置启停。
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const mocks = vi.hoisted(() => ({ userDataDir: "" }));

vi.mock("electron", () => ({
  app: {
    getPath: () => mocks.userDataDir,
    getName: () => "cyrene-test",
    isReady: () => false,
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (plain: string) => Buffer.from(plain),
    decryptString: (buf: Buffer) => buf.toString(),
  },
}));

import {
  createSyncHttpClient,
  SyncHttpError,
  type SyncCloneResult,
  type SyncFetchLike,
  type SyncFetchPage,
  type SyncHttpClient,
  type SyncHttpClientConfig,
  type SyncPushResult,
} from "./http-client";
import { createSyncService, SYNC_INTERVAL_MS, type SyncService } from "./sync-service";
import { loadSyncSettings, saveSyncSettings } from "./sync-settings";
import type { SyncEventStore } from "./event-store";
import type { SyncExporter } from "./exporter";
import type { SyncEventV0 } from "./sync-protocol";
import type { SyncState } from "./sync-state";

const BASE = "https://cloud.example.com";

function localEvent(id: string, lamport: number, sessionId = "c1"): SyncEventV0 {
  return {
    eventId: id,
    sessionId,
    type: "message.append",
    lamport,
    deviceId: "desk-local",
    seq: lamport,
    ts: "2026-10-06T00:00:00.000Z",
    payload: { role: "user", text: `local-${id}`, turnId: `turn-${id}` },
  };
}

function remoteEvent(id: string, lamport: number, deviceId = "desk-b", sessionId = "c1"): SyncEventV0 {
  return {
    eventId: id,
    sessionId,
    type: "message.append",
    lamport,
    deviceId,
    seq: lamport,
    ts: "2026-10-06T00:00:01.000Z",
    payload: { role: "assistant", text: `remote-${id}` },
  };
}

class FakeStore {
  local: SyncEventV0[] = [];
  remote: SyncEventV0[] = [];

  getLocalEvents(): SyncEventV0[] { return [...this.local]; }
  getRemoteEvents(): SyncEventV0[] { return [...this.remote]; }
  getAllEvents(): SyncEventV0[] { return [...this.local, ...this.remote]; }
  getLocalEventIds(): Set<string> { return new Set(this.local.map((event) => event.eventId)); }
  getRemoteEventsForSession(sessionId: string): SyncEventV0[] {
    return this.remote.filter((event) => event.sessionId === sessionId);
  }
  async appendLocal(events: SyncEventV0[]): Promise<void> { this.local.push(...events); }
  async appendRemote(events: SyncEventV0[]): Promise<void> { this.remote.push(...events); }
  getLocalCount(): number { return this.local.length; }
  getRemoteCount(): number { return this.remote.length; }
}

/** 可挂起的事件库：appendRemote（真实实现是 fs + fsync 落库）在 gate 上等待，
 *  用于复现「换址发生在入库等待期间」的竞态窗口（复审二轮 P1-1）。 */
class GatedAppendStore extends FakeStore {
  gate: Promise<void> | null = null;
  onAppendEntered: (() => void) | null = null;

  async appendRemote(events: SyncEventV0[]): Promise<void> {
    this.onAppendEntered?.();
    if (this.gate) await this.gate;
    await super.appendRemote(events);
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

function makeState(overrides: Partial<SyncState> = {}): SyncState {
  return {
    schemaVersion: 1,
    deviceId: "desk-local",
    lamport: 0,
    seq: 0,
    fetchCursor: null,
    pushedCount: 0,
    serverDeviceId: null,
    conversations: {},
    updatedAt: "2026-10-06T00:00:00.000Z",
    ...overrides,
  };
}

/** 假导出器：把预置事件追加到 outbox（含时钟推进），与 A 簇语义一致。 */
function makeExporter(store: FakeStore, state: SyncState, queue: SyncEventV0[]): SyncExporter {
  return {
    exportPending: vi.fn(async () => {
      if (queue.length === 0) return { exported: 0, sessions: 0 };
      const events = queue.splice(0, queue.length);
      await store.appendLocal(events);
      for (const event of events) {
        state.lamport = Math.max(state.lamport, event.lamport);
        state.seq = Math.max(state.seq, event.seq);
      }
      return { exported: events.length, sessions: 1 };
    }),
  };
}

interface ClientMocks {
  pair: ReturnType<typeof vi.fn>;
  createPairCode: ReturnType<typeof vi.fn>;
  capabilities: ReturnType<typeof vi.fn>;
  push: ReturnType<typeof vi.fn>;
  fetch: ReturnType<typeof vi.fn>;
  clone: ReturnType<typeof vi.fn>;
}

function makeClient(): ClientMocks {
  return {
    pair: vi.fn(async () => ({ deviceId: "dev_1", name: "我的桌面", token: "tok-1" })),
    createPairCode: vi.fn(async () => ({ code: "AAAA-BBBB", expiresAt: "2026-10-06T12:00:00.000Z" })),
    capabilities: vi.fn(async () => ({})),
    push: vi.fn(async (): Promise<SyncPushResult> => ({ accepted: 0, duplicates: 0, cursor: "" })),
    fetch: vi.fn(async (since: string): Promise<SyncFetchPage> => ({ events: [], cursor: since, hasMore: false, dropped: 0 })),
    clone: vi.fn(async (): Promise<SyncCloneResult> => ({ events: [], cursor: null, dropped: 0 })),
  };
}

interface BuiltService {
  service: SyncService;
  state: SyncState;
  store: FakeStore;
  client: ClientMocks;
  exporter: SyncExporter;
  applied: ReturnType<typeof vi.fn>;
  saved: SyncState[];
  logs: string[];
  clientConfigs: SyncHttpClientConfig[];
  setIntervalImpl: ReturnType<typeof vi.fn>;
  clearIntervalImpl: ReturnType<typeof vi.fn>;
  intervalHandle: { unref: ReturnType<typeof vi.fn> };
}

function buildService(options: {
  store?: FakeStore;
  state?: SyncState;
  exporterQueue?: SyncEventV0[];
  /** true 时不注入 loadState/saveState，走真实 sync-state（读路径零副作用用例）。 */
  realStateIO?: boolean;
  /** 覆盖客户端工厂（如注入真实 http-client + 桩 fetchImpl，验证读体阶段中止归类）。 */
  createClient?: (config: SyncHttpClientConfig) => SyncHttpClient;
} = {}): BuiltService {
  const store = options.store ?? new FakeStore();
  const state = options.state ?? makeState();
  const exporter = makeExporter(store, state, options.exporterQueue ?? []);
  const client = makeClient();
  const applied = vi.fn();
  const saved: SyncState[] = [];
  const logs: string[] = [];
  const clientConfigs: SyncHttpClientConfig[] = [];
  const intervalHandle = { unref: vi.fn() };
  const setIntervalImpl = vi.fn(() => intervalHandle);
  const clearIntervalImpl = vi.fn();
  const service = createSyncService({
    userDataPath: mocks.userDataDir,
    store: store as unknown as SyncEventStore,
    exporter,
    ...(options.realStateIO
      ? {}
      : {
          loadState: async () => state,
          saveState: async (_syncDir: string, next: SyncState) => { saved.push(next); },
        }),
    createClient: (config) => {
      clientConfigs.push(config);
      return options.createClient ? options.createClient(config) : (client as unknown as SyncHttpClient);
    },
    now: () => 1_700_000_000_000,
    onRemoteEventsApplied: applied,
    setIntervalImpl: setIntervalImpl as unknown as typeof setInterval,
    clearIntervalImpl: clearIntervalImpl as unknown as typeof clearInterval,
    log: (message) => { logs.push(message); },
  });
  return { service, state, store, client, exporter, applied, saved, logs, clientConfigs, setIntervalImpl, clearIntervalImpl, intervalHandle };
}

/** 预置合法 state.json（读路径仅在文件存在时读取；内容由注入 loader 决定）。 */
function materializeStateFile(state: SyncState = makeState()): void {
  const syncDir = path.join(mocks.userDataDir, "sync");
  fs.mkdirSync(syncDir, { recursive: true });
  fs.writeFileSync(path.join(syncDir, "state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function settingsPath(): string {
  return path.join(mocks.userDataDir, "sync", "settings.json");
}

describe("sync/sync-service", () => {
  beforeEach(() => {
    mocks.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-sync-service-"));
  });

  it("未启用：syncNow 直接返回 disabled，不碰客户端", async () => {
    const built = buildService();
    const result = await built.service.syncNow();
    expect(result).toMatchObject({ ok: false, error: { code: "disabled" } });
    expect(built.client.push).not.toHaveBeenCalled();
    expect(built.client.clone).not.toHaveBeenCalled();
    expect(built.service.isEnabled()).toBe(false);
  });

  it("初次同步：导出 → push → clone → 入库去重 → 游标/水位推进 + 回调", async () => {
    saveSyncSettings({ enabled: true, baseUrl: BASE, token: "tok-1" });
    const built = buildService({ exporterQueue: [localEvent("loc-1", 1)] });
    built.client.push.mockResolvedValueOnce({ accepted: 1, duplicates: 0, cursor: "5" });
    built.client.clone.mockResolvedValueOnce({
      events: [remoteEvent("rem-1", 3), remoteEvent("srv-1", 4, "server")],
      cursor: "42",
      dropped: 0,
    });

    const result = await built.service.syncNow();

    expect(result).toEqual({ ok: true, error: null });
    expect(built.store.local.map((event) => event.eventId)).toEqual(["loc-1"]);
    expect(built.store.remote.map((event) => event.eventId)).toEqual(["rem-1", "srv-1"]);
    expect(built.state.pushedCount).toBe(1);
    expect(built.state.fetchCursor).toBe("42");
    expect(built.state.lamport).toBe(4);
    expect(built.client.push).toHaveBeenCalledTimes(1);
    expect(built.client.push.mock.calls[0]![0]).toEqual([expect.objectContaining({ eventId: "loc-1" })]);
    expect(built.client.clone).toHaveBeenCalledTimes(1);
    expect(built.client.fetch).not.toHaveBeenCalled();
    expect(built.applied).toHaveBeenCalledWith(["c1"]);
    expect(built.saved.length).toBeGreaterThan(0);

    const status = await built.service.getStatus();
    expect(status).toMatchObject({
      enabled: true,
      configured: true,
      syncing: false,
      pendingCount: 0,
      cursor: "42",
      localEventCount: 1,
      remoteEventCount: 2,
      lastSyncAt: "2023-11-14T22:13:20.000Z",
      lastError: null,
    });
  });

  it("增量：fetch 循环 hasMore 至 false；重复 eventId 幂等跳过；游标逐页推进", async () => {
    saveSyncSettings({ enabled: true, baseUrl: BASE, token: "tok-1" });
    const store = new FakeStore();
    store.local.push(localEvent("loc-1", 1));
    store.remote.push(remoteEvent("rem-0", 2));
    const built = buildService({ store, state: makeState({ fetchCursor: "10", pushedCount: 1, lamport: 2 }) });
    built.client.fetch
      .mockResolvedValueOnce({
        events: [remoteEvent("rem-0", 2), remoteEvent("rem-1", 3)],
        cursor: "20",
        hasMore: true,
        dropped: 0,
      })
      .mockResolvedValueOnce({
        events: [remoteEvent("rem-1", 3), remoteEvent("rem-2", 4)],
        cursor: "30",
        hasMore: false,
        dropped: 0,
      });

    const result = await built.service.syncNow();

    expect(result.ok).toBe(true);
    expect(built.client.push).not.toHaveBeenCalled(); // pushedCount 已到水位
    expect(built.client.clone).not.toHaveBeenCalled();
    expect(built.client.fetch).toHaveBeenCalledTimes(2);
    expect(built.client.fetch.mock.calls[0]![0]).toBe("10");
    expect(built.client.fetch.mock.calls[1]![0]).toBe("20");
    expect(built.store.remote.map((event) => event.eventId)).toEqual(["rem-0", "rem-1", "rem-2"]);
    expect(built.state.fetchCursor).toBe("30");
    expect(built.state.lamport).toBe(4);
    expect(built.applied).toHaveBeenCalledWith(["c1"]);
  });

  it("401 失败：保留 pushedCount 与游标、记 lastError；下一轮重试成功", async () => {
    saveSyncSettings({ enabled: true, baseUrl: BASE, token: "tok-1" });
    const built = buildService({ exporterQueue: [localEvent("loc-1", 1)] });
    built.client.push.mockRejectedValueOnce(new SyncHttpError("unauthorized", 401));

    const first = await built.service.syncNow();
    expect(first).toMatchObject({ ok: false, error: { code: "unauthorized" } });
    expect(built.state.pushedCount).toBe(0);
    expect(built.store.local).toHaveLength(1);
    expect(built.client.clone).not.toHaveBeenCalled();

    let status = await built.service.getStatus();
    expect(status.lastError?.code).toBe("unauthorized");
    expect(status.pendingCount).toBe(1);

    built.client.push.mockResolvedValueOnce({ accepted: 1, duplicates: 0, cursor: "9" });
    const second = await built.service.syncNow();
    expect(second.ok).toBe(true);
    expect(built.state.pushedCount).toBe(1);
    status = await built.service.getStatus();
    expect(status.lastError).toBeNull();
    expect(built.client.push).toHaveBeenCalledTimes(2);
  });

  it("单飞：并发 syncNow 共享同一 promise，仅执行一轮", async () => {
    saveSyncSettings({ enabled: true, baseUrl: BASE, token: "tok-1" });
    const built = buildService({ exporterQueue: [localEvent("loc-1", 1)] });
    let release!: (value: SyncPushResult) => void;
    const pushGate = new Promise<SyncPushResult>((resolve) => { release = resolve; });
    built.client.push.mockImplementationOnce(() => pushGate);

    const first = built.service.syncNow();
    const second = built.service.syncNow();
    expect(first).toBe(second);

    const midStatus = await built.service.getStatus();
    expect(midStatus.syncing).toBe(true);

    release({ accepted: 1, duplicates: 0, cursor: "1" });
    await first;

    expect(built.client.push).toHaveBeenCalledTimes(1);
    expect((await built.service.getStatus()).syncing).toBe(false);
  });

  it("pair：显式空串 baseUrl 不回退当前配置，按缺少服务器地址拒绝（注释语义固定）", async () => {
    saveSyncSettings({ enabled: false, baseUrl: BASE, token: "" });
    const built = buildService();

    await expect(built.service.pair({ baseUrl: "", code: "CODE-1" })).rejects.toMatchObject({
      code: "invalid_config",
      message: "缺少服务器地址",
    });
    expect(built.client.pair).not.toHaveBeenCalled();
  });

  it("pair：POST 后 token 加密落盘 + serverDeviceId 入库 + 公开配置 hasToken", async () => {
    const built = buildService();
    const config = await built.service.pair({
      baseUrl: "https://cloud.example.com/",
      code: "CODE-1",
      deviceName: " 我的桌面 ",
    });

    expect(config).toMatchObject({
      enabled: false,
      baseUrl: BASE,
      deviceName: "我的桌面",
      hasToken: true,
      deviceId: "desk-local",
      serverDeviceId: "dev_1",
    });
    expect(built.client.pair).toHaveBeenCalledWith("CODE-1", "我的桌面");
    expect(loadSyncSettings().token).toBe("tok-1");
    expect(fs.readFileSync(settingsPath(), "utf8")).not.toContain("tok-1");
    expect(built.state.serverDeviceId).toBe("dev_1");
  });

  it("pair：换服务器地址重置 fetchCursor/pushedCount/serverDeviceId（#IKJSNA）", async () => {
    saveSyncSettings({ enabled: false, baseUrl: "https://a.example.com", token: "tok-a" });
    const built = buildService({
      state: makeState({ fetchCursor: "42", pushedCount: 3, serverDeviceId: "dev_a" }),
    });

    await built.service.pair({ baseUrl: "https://b.example.com", code: "CODE-1" });

    expect(built.state.fetchCursor).toBeNull();
    expect(built.state.pushedCount).toBe(0);
    expect(built.state.serverDeviceId).toBe("dev_1");
  });

  it("pair：同址重配对保留游标与推送水位，仅刷新服务器设备身份（#IKJSNA）", async () => {
    saveSyncSettings({ enabled: false, baseUrl: "https://a.example.com", token: "tok-a" });
    const built = buildService({
      state: makeState({ fetchCursor: "42", pushedCount: 3, serverDeviceId: "dev_a" }),
    });

    await built.service.pair({ code: "CODE-1" });

    expect(built.state.fetchCursor).toBe("42");
    expect(built.state.pushedCount).toBe(3);
    expect(built.state.serverDeviceId).toBe("dev_1");
  });

  it("saveConfig：换 baseUrl 重置同步状态（游标/推送水位/服务器身份）（#IKJSNA）", async () => {
    saveSyncSettings({ enabled: false, baseUrl: "https://a.example.com", token: "tok-a" });
    // 已有 state 文件（生产语义：A 服务器同步过）——peekState 按真实存在性判断
    fs.mkdirSync(path.join(mocks.userDataDir, "sync"), { recursive: true });
    fs.writeFileSync(path.join(mocks.userDataDir, "sync", "state.json"), "{}");
    const built = buildService({
      state: makeState({ fetchCursor: "42", pushedCount: 3, serverDeviceId: "dev_a" }),
    });

    await built.service.saveConfig({ baseUrl: "https://b.example.com" });

    expect(built.state.fetchCursor).toBeNull();
    expect(built.state.pushedCount).toBe(0);
    expect(built.state.serverDeviceId).toBeNull();
  });

  it("saveConfig：同址保存不动同步状态（#IKJSNA）", async () => {
    saveSyncSettings({ enabled: false, baseUrl: "https://a.example.com", token: "tok-a" });
    fs.mkdirSync(path.join(mocks.userDataDir, "sync"), { recursive: true });
    fs.writeFileSync(path.join(mocks.userDataDir, "sync", "state.json"), "{}");
    const built = buildService({
      state: makeState({ fetchCursor: "42", pushedCount: 3, serverDeviceId: "dev_a" }),
    });

    await built.service.saveConfig({ enabled: false });

    expect(built.state.fetchCursor).toBe("42");
    expect(built.state.pushedCount).toBe(3);
    expect(built.state.serverDeviceId).toBe("dev_a");
  });

  it("saveConfig：换址发生在轮次在途——旧轮结算被丢弃、补跑用新配置（#IKJSNA 复审 P1-1）", async () => {
    saveSyncSettings({ enabled: true, baseUrl: "https://a.example.com", token: "tok-a" });
    fs.mkdirSync(path.join(mocks.userDataDir, "sync"), { recursive: true });
    fs.writeFileSync(path.join(mocks.userDataDir, "sync", "state.json"), "{}");
    const store = new FakeStore();
    store.local.push(localEvent("loc-1", 1), localEvent("loc-2", 2));
    const built = buildService({
      store,
      state: makeState({ fetchCursor: "42", pushedCount: 0, serverDeviceId: "dev_a" }),
    });

    // 旧轮在 push 网络等待中挂起；换址发生在在途期间
    let resolvePush!: (value: SyncPushResult) => void;
    built.client.push.mockImplementationOnce(() => new Promise<SyncPushResult>((resolve) => { resolvePush = resolve; }));
    const first = built.service.syncNow();
    await vi.waitFor(() => expect(built.client.push).toHaveBeenCalledTimes(1));

    await built.service.saveConfig({ baseUrl: "https://b.example.com", token: "tok-b" });
    expect(built.state.fetchCursor).toBeNull(); // 换址重置已生效
    expect(built.clientConfigs[0]?.signal?.aborted).toBe(true); // 在途轮次已被中止

    // 旧服务器 push 完成：代际失配 → 旧轮结算被丢弃（不得回写 pushedCount / 游标）
    resolvePush({ accepted: 2, duplicates: 0, cursor: "" });
    const firstResult = await first;
    expect(firstResult.ok).toBe(false);
    expect(["stale", "aborted"]).toContain(firstResult.error?.code);

    // 旧轮结算后补跑立即启动（不等 60s 定时）：以新配置再跑一轮
    await vi.waitFor(() => expect(built.client.push).toHaveBeenCalledTimes(2));
    expect(built.clientConfigs.map((config) => config.baseUrl)).toEqual([
      "https://a.example.com",
      "https://b.example.com",
    ]);
    // 补跑 push 返回 accepted 0 → 水位保持换址重置后的 0（未被旧轮 2 条污染）
    expect(built.state.pushedCount).toBe(0);
    expect(built.state.fetchCursor).toBeNull();
    expect(built.state.serverDeviceId).toBeNull();
  });

  it("saveConfig：换址发生在 fetch 入库等待期间——旧轮不写回游标，已入库事件照常广播（复审二轮 P1-1）", async () => {
    saveSyncSettings({ enabled: true, baseUrl: "https://a.example.com", token: "tok-a" });
    const store = new GatedAppendStore();
    const built = buildService({ store, state: makeState({ fetchCursor: "10", serverDeviceId: "dev_a" }) });
    const entered = deferred();
    const gate = deferred();
    store.onAppendEntered = entered.resolve;
    store.gate = gate.promise;
    built.client.fetch.mockResolvedValueOnce({
      events: [remoteEvent("rem-1", 3)],
      cursor: "11",
      hasMore: false,
      dropped: 0,
    });

    const first = built.service.syncNow();
    await entered.promise; // 旧轮挂在入库等待（fs + fsync）上，换址此刻才发生

    await built.service.saveConfig({ baseUrl: "https://b.example.com", token: "tok-b" });
    expect(built.state.fetchCursor).toBeNull(); // 换址重置已生效

    gate.resolve();
    const firstResult = await first;
    expect(firstResult).toMatchObject({ ok: false, error: { code: "stale" } });
    // 已入库的旧服务器事件是事实：stale 丢弃结算但补发广播，合并读模型即时刷新
    expect(built.applied).toHaveBeenCalledWith(["c1"]);
    // 旧服务器游标 "11" 不得写回：补跑走新服务器的初始 clone，而非拿旧游标增量 fetch
    await vi.waitFor(() => expect(built.client.clone).toHaveBeenCalledTimes(1));
    expect(built.client.fetch).toHaveBeenCalledTimes(1);
    expect(built.state.fetchCursor).toBeNull();
    expect(built.state.pushedCount).toBe(0);
    expect(built.state.serverDeviceId).toBeNull();
  });

  it("saveConfig：换址发生在 clone 入库等待期间——旧轮不写回初始游标，补跑重新 clone（复审二轮 P1-1）", async () => {
    saveSyncSettings({ enabled: true, baseUrl: "https://a.example.com", token: "tok-a" });
    const store = new GatedAppendStore();
    const built = buildService({ store, state: makeState({ serverDeviceId: "dev_a" }) });
    const entered = deferred();
    const gate = deferred();
    store.onAppendEntered = entered.resolve;
    store.gate = gate.promise;
    built.client.clone.mockResolvedValueOnce({ events: [remoteEvent("rem-1", 3)], cursor: "42", dropped: 0 });

    const first = built.service.syncNow();
    await entered.promise; // 初始 clone 已返回，挂在入库等待上

    await built.service.saveConfig({ baseUrl: "https://b.example.com", token: "tok-b" });
    expect(built.state.fetchCursor).toBeNull();

    gate.resolve();
    const firstResult = await first;
    expect(firstResult).toMatchObject({ ok: false, error: { code: "stale" } });
    expect(built.applied).toHaveBeenCalledWith(["c1"]);
    // 补跑重新走初始 clone（旧轮写回 "42" 的话会改成对新服务器增量 fetch）
    await vi.waitFor(() => expect(built.client.clone).toHaveBeenCalledTimes(2));
    expect(built.client.fetch).not.toHaveBeenCalled();
    expect(built.state.fetchCursor).toBeNull();
  });

  it("unpair：清 token / serverDeviceId / fetchCursor，保留 outbox", async () => {
    saveSyncSettings({ enabled: true, baseUrl: BASE, token: "tok-1" });
    const store = new FakeStore();
    store.local.push(localEvent("loc-1", 1));
    const built = buildService({ store, state: makeState({ fetchCursor: "7", serverDeviceId: "dev_1" }) });

    const config = await built.service.unpair();

    expect(config.hasToken).toBe(false);
    expect(loadSyncSettings().token).toBe("");
    expect(built.state.serverDeviceId).toBeNull();
    expect(built.state.fetchCursor).toBeNull();
    expect(built.store.local.map((event) => event.eventId)).toEqual(["loc-1"]);
  });

  it("saveConfig：启用挂 60s 定时（unref）并触发一轮；关闭清定时", async () => {
    const built = buildService();
    await built.service.saveConfig({ enabled: true, baseUrl: BASE, token: "tok-1" });

    expect(built.setIntervalImpl).toHaveBeenCalledWith(expect.any(Function), SYNC_INTERVAL_MS);
    expect(built.intervalHandle.unref).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(built.client.clone).toHaveBeenCalled()); // start 内含首轮（初次 clone）
    expect(await built.service.getConfig()).toMatchObject({ enabled: true, hasToken: true });

    await built.service.saveConfig({ enabled: false });
    expect(built.clearIntervalImpl).toHaveBeenCalledTimes(1);
    expect(loadSyncSettings().enabled).toBe(false);
  });

  it("createPairCode：已配对走客户端；未配对抛 invalid_config", async () => {
    saveSyncSettings({ enabled: true, baseUrl: BASE, token: "tok-1" });
    const built = buildService();
    const result = await built.service.createPairCode();
    expect(result).toEqual({ code: "AAAA-BBBB", expiresAt: "2026-10-06T12:00:00.000Z" });
    expect(built.client.createPairCode).toHaveBeenCalledTimes(1);

    await built.service.unpair();
    await expect(built.service.createPairCode()).rejects.toMatchObject({ code: "invalid_config" });
  });

  it("getRemoteSessionEvents：按会话取 inbox 且过滤 deviceId = 本机；未启用返回空", async () => {
    saveSyncSettings({ enabled: true, baseUrl: BASE, token: "tok-1" });
    materializeStateFile(); // 读路径仅在 state.json 存在时读取（零副作用口径）
    const store = new FakeStore();
    store.remote.push(
      remoteEvent("own-1", 5, "desk-local"),
      remoteEvent("other-1", 6, "desk-b"),
      remoteEvent("other-2", 7, "desk-b", "c2"),
    );
    const built = buildService({ store });

    expect((await built.service.getRemoteSessionEvents("c1")).map((event) => event.eventId)).toEqual(["other-1"]);
    expect((await built.service.getRemoteSessionEvents("c2")).map((event) => event.eventId)).toEqual(["other-2"]);

    const disabled = buildService({ store });
    await disabled.service.saveConfig({ enabled: false });
    expect(await disabled.service.getRemoteSessionEvents("c1")).toEqual([]);
  });

  // ── P2-3：读路径零副作用（未启用/state 缺失不落盘）─────────────────────────

  it("读路径零副作用：state 缺失时 getConfig/getStatus 不创建 sync 目录与 state.json（真实 loader）", async () => {
    const built = buildService({ realStateIO: true });

    const config = await built.service.getConfig();
    const status = await built.service.getStatus();

    expect(config.deviceId).toBeNull();
    expect(config.serverDeviceId).toBeNull();
    expect(status.deviceId).toBeNull();
    expect(status.pendingCount).toBe(0);
    expect(fs.existsSync(path.join(mocks.userDataDir, "sync"))).toBe(false);
  });

  it("读路径：已有 state.json 时正常读取且不改写文件", async () => {
    materializeStateFile(makeState({ deviceId: "desk-existing", lamport: 7 }));
    const statePath = path.join(mocks.userDataDir, "sync", "state.json");
    const before = fs.readFileSync(statePath, "utf8");

    const built = buildService({ realStateIO: true });
    const config = await built.service.getConfig();
    const status = await built.service.getStatus();

    expect(config.deviceId).toBe("desk-existing");
    expect(status.deviceId).toBe("desk-existing");
    expect(fs.readFileSync(statePath, "utf8")).toBe(before);
  });

  // ── P2-2①：坏帧 dropped 计数可观察 ────────────────────────────────────────

  it("fetch 坏帧：dropped > 0 记录日志（数量 + 游标页信息）且游标照常推进", async () => {
    saveSyncSettings({ enabled: true, baseUrl: BASE, token: "tok-1" });
    const built = buildService({ state: makeState({ fetchCursor: "10" }) });
    built.client.fetch.mockResolvedValueOnce({
      events: [remoteEvent("rem-1", 2)],
      cursor: "20",
      hasMore: false,
      dropped: 2,
    });

    const result = await built.service.syncNow();

    expect(result.ok).toBe(true);
    expect(built.state.fetchCursor).toBe("20");
    expect(built.logs.some((line) => line.includes("丢弃 2") && line.includes("10") && line.includes("20"))).toBe(true);
  });

  it("clone 坏帧：dropped > 0 记录日志（数量 + 初始游标）", async () => {
    saveSyncSettings({ enabled: true, baseUrl: BASE, token: "tok-1" });
    const built = buildService({ state: makeState({ fetchCursor: null }) });
    built.client.clone.mockResolvedValueOnce({ events: [], cursor: "42", dropped: 3 });

    const result = await built.service.syncNow();

    expect(result.ok).toBe(true);
    expect(built.state.fetchCursor).toBe("42");
    expect(built.logs.some((line) => line.includes("clone 丢弃 3") && line.includes("42"))).toBe(true);
  });

  // ── P2-5：超限事件可观察 ─────────────────────────────────────────────────

  it("oversize_event：lastError 可见且 pushedCount 不推进", async () => {
    saveSyncSettings({ enabled: true, baseUrl: BASE, token: "tok-1" });
    const built = buildService({ exporterQueue: [localEvent("loc-1", 1)] });
    built.client.push.mockRejectedValueOnce(
      new SyncHttpError("oversize_event", 0, undefined, "事件 loc-1 超过单事件上限（10 MiB）"),
    );

    const result = await built.service.syncNow();

    expect(result).toMatchObject({ ok: false, error: { code: "oversize_event" } });
    expect(built.state.pushedCount).toBe(0);
    expect(built.client.clone).not.toHaveBeenCalled();
    expect((await built.service.getStatus()).lastError).toMatchObject({ code: "oversize_event" });
  });

  // ── P2-4：stop 中止路径 / timer 清理 / start 幂等 ────────────────────────

  it("stop：中止在途请求（aborted 不入 lastError），signal 透传给客户端", async () => {
    saveSyncSettings({ enabled: true, baseUrl: BASE, token: "tok-1" });
    const built = buildService({ exporterQueue: [localEvent("loc-1", 1)] });
    let signal: AbortSignal | undefined;
    built.client.push.mockImplementationOnce(() => new Promise<SyncPushResult>((_resolve, reject) => {
      signal = built.clientConfigs.at(-1)?.signal;
      signal?.addEventListener(
        "abort",
        () => reject(new SyncHttpError("aborted", 0, undefined, "请求已取消")),
        { once: true },
      );
    }));

    const running = built.service.syncNow();
    await vi.waitFor(() => expect(built.client.push).toHaveBeenCalled());
    await built.service.stop();

    await expect(running).resolves.toMatchObject({ ok: false, error: { code: "aborted" } });
    expect(signal?.aborted).toBe(true);
    expect((await built.service.getStatus()).lastError).toBeNull();
  });

  it("stop：中止发生于响应体读取阶段（真实客户端流读取挂起）→ aborted 不入 lastError", async () => {
    saveSyncSettings({ enabled: true, baseUrl: BASE, token: "tok-1" });
    let markReadStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => { markReadStarted = resolve; });
    const fetchImpl = vi.fn<SyncFetchLike>(async (_url, init) => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: {
        getReader: () => ({
          read: () => new Promise<never>((_resolve, reject) => {
            markReadStarted();
            init?.signal?.addEventListener(
              "abort",
              () => reject(init.signal?.reason ?? new DOMException("Aborted", "AbortError")),
              { once: true },
            );
          }),
        }),
      },
    }) as unknown as Response);
    const built = buildService({
      createClient: (config) => createSyncHttpClient({ ...config, fetchImpl }),
    });

    const running = built.service.syncNow();
    await readStarted; // 响应头已到、clone 正在读体
    await built.service.stop();

    await expect(running).resolves.toMatchObject({ ok: false, error: { code: "aborted" } });
    expect((await built.service.getStatus()).lastError).toBeNull();
  });

  it("start：重复调用幂等（只挂一次定时器）；stop：清定时器且幂等", async () => {
    saveSyncSettings({ enabled: true, baseUrl: BASE, token: "tok-1" });
    const built = buildService();

    await built.service.start();
    await built.service.start();
    expect(built.setIntervalImpl).toHaveBeenCalledTimes(1);
    expect(built.intervalHandle.unref).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(built.client.clone).toHaveBeenCalled()); // 首轮完成

    await built.service.stop();
    expect(built.clearIntervalImpl).toHaveBeenCalledTimes(1);
    await built.service.stop();
    expect(built.clearIntervalImpl).toHaveBeenCalledTimes(1);
  });

  // ── P2-6：换 baseUrl 清 token ─────────────────────────────────────────────

  it("saveConfig：换 baseUrl 未提供新 token → 清 token（hasToken=false）", async () => {
    saveSyncSettings({ enabled: false, baseUrl: BASE, token: "tok-1" });
    const built = buildService();

    const config = await built.service.saveConfig({ baseUrl: "https://other.example.com" });

    expect(config).toMatchObject({ baseUrl: "https://other.example.com", hasToken: false });
    expect(loadSyncSettings().token).toBe("");
  });

  it("saveConfig：仅尾斜杠差异不算换主机；换 baseUrl 且提供新 token → 用新 token", async () => {
    saveSyncSettings({ enabled: false, baseUrl: BASE, token: "tok-1" });
    const built = buildService();

    const same = await built.service.saveConfig({ baseUrl: `${BASE}/`, deviceName: "桌面" });
    expect(same.hasToken).toBe(true);
    expect(loadSyncSettings().token).toBe("tok-1");

    const rotated = await built.service.saveConfig({ baseUrl: "https://other.example.com", token: "tok-2" });
    expect(rotated.hasToken).toBe(true);
    expect(loadSyncSettings().token).toBe("tok-2");
  });

  it("saveConfig：同 origin 仅路径/大小写差异不算换主机（保留 token）；换 scheme/host 清 token", async () => {
    saveSyncSettings({ enabled: false, baseUrl: "https://cloud.example.com", token: "tok-1" });
    const built = buildService();

    const withPath = await built.service.saveConfig({ baseUrl: "https://cloud.example.com/api/v1" });
    expect(withPath.hasToken).toBe(true);
    expect(loadSyncSettings().token).toBe("tok-1");

    const upperCase = await built.service.saveConfig({ baseUrl: "https://CLOUD.example.com" });
    expect(upperCase.hasToken).toBe(true);
    expect(loadSyncSettings().token).toBe("tok-1");

    const schemeChanged = await built.service.saveConfig({ baseUrl: "http://cloud.example.com" });
    expect(schemeChanged.hasToken).toBe(false);
    expect(loadSyncSettings().token).toBe("");

    await built.service.saveConfig({ baseUrl: "https://cloud.example.com", token: "tok-2" });
    const hostChanged = await built.service.saveConfig({ baseUrl: "https://other.example.com" });
    expect(hostChanged.hasToken).toBe(false);
    expect(loadSyncSettings().token).toBe("");
  });
});

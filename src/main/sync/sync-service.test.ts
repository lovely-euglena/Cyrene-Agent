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

import { SyncHttpError, type SyncCloneResult, type SyncFetchPage, type SyncHttpClient, type SyncPushResult } from "./http-client";
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
  setIntervalImpl: ReturnType<typeof vi.fn>;
  clearIntervalImpl: ReturnType<typeof vi.fn>;
  intervalHandle: { unref: ReturnType<typeof vi.fn> };
}

function buildService(options: {
  store?: FakeStore;
  state?: SyncState;
  exporterQueue?: SyncEventV0[];
} = {}): BuiltService {
  const store = options.store ?? new FakeStore();
  const state = options.state ?? makeState();
  const exporter = makeExporter(store, state, options.exporterQueue ?? []);
  const client = makeClient();
  const applied = vi.fn();
  const saved: SyncState[] = [];
  const intervalHandle = { unref: vi.fn() };
  const setIntervalImpl = vi.fn(() => intervalHandle);
  const clearIntervalImpl = vi.fn();
  const service = createSyncService({
    userDataPath: mocks.userDataDir,
    store: store as unknown as SyncEventStore,
    exporter,
    loadState: async () => state,
    saveState: async (_syncDir, next) => { saved.push(next); },
    createClient: () => client as unknown as SyncHttpClient,
    now: () => 1_700_000_000_000,
    onRemoteEventsApplied: applied,
    setIntervalImpl: setIntervalImpl as unknown as typeof setInterval,
    clearIntervalImpl: clearIntervalImpl as unknown as typeof clearInterval,
    log: () => undefined,
  });
  return { service, state, store, client, exporter, applied, saved, setIntervalImpl, clearIntervalImpl, intervalHandle };
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
});

// sync-ipc 单测（IKJK2I B）：mock ipcMain.handle 捕获（模式照 chats-ipc.test.ts）。
// 覆盖：7 通道注册 / 读取类直接返回 / 动作类 SyncOpResult / SYNC_CHANGED 广播。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC } from "../../shared/ipc-channels";
import type { SyncConfigPublic, SyncStatus } from "../../shared/sync-types";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => unknown>(),
  windows: [] as Array<{ isDestroyed: () => boolean; webContents: { send: ReturnType<typeof vi.fn> } }>,
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: any[]) => unknown) => {
      mocks.handlers.set(channel, handler);
    },
    removeHandler: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
  },
  BrowserWindow: {
    getAllWindows: () => mocks.windows,
  },
}));

// eslint-disable-next-line import/first
import { registerSyncIpc } from "./sync-ipc";
// eslint-disable-next-line import/first
import { SyncHttpError } from "./http-client";
// eslint-disable-next-line import/first
import type { SyncService } from "./sync-service";

const PUBLIC_CONFIG: SyncConfigPublic = {
  enabled: true,
  baseUrl: "https://cloud.example.com",
  deviceName: "我的桌面",
  hasToken: true,
  deviceId: "desk-local",
  serverDeviceId: "dev_1",
};

const STATUS: SyncStatus = {
  enabled: true,
  configured: true,
  baseUrl: "https://cloud.example.com",
  hasToken: true,
  deviceId: "desk-local",
  serverDeviceId: "dev_1",
  syncing: false,
  lastSyncAt: null,
  lastError: null,
  pendingCount: 0,
  cursor: null,
  localEventCount: 0,
  remoteEventCount: 0,
};

function makeService() {
  return {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    syncNow: vi.fn(async () => ({ ok: true, error: null })),
    getStatus: vi.fn(async () => STATUS),
    getConfig: vi.fn(async () => PUBLIC_CONFIG),
    saveConfig: vi.fn(async () => PUBLIC_CONFIG),
    pair: vi.fn(async () => PUBLIC_CONFIG),
    createPairCode: vi.fn(async () => ({ code: "AAAA-BBBB", expiresAt: "2026-10-06T12:00:00.000Z" })),
    unpair: vi.fn(async () => ({ ...PUBLIC_CONFIG, hasToken: false })),
    isEnabled: vi.fn(() => true),
    getRemoteSessionEvents: vi.fn(async () => []),
  };
}

type Handler = (event: unknown, ...args: unknown[]) => unknown;

function register(service = makeService()) {
  registerSyncIpc(
    undefined,
    service as unknown as SyncService,
    { getPublicConfig: async () => PUBLIC_CONFIG },
  );
  const handler = (channel: string): Handler => {
    const found = mocks.handlers.get(channel);
    if (!found) throw new Error(`handler not registered: ${channel}`);
    return found;
  };
  return { service, handler };
}

describe("sync/sync-ipc", () => {
  beforeEach(() => {
    mocks.handlers.clear();
    mocks.windows = [];
  });

  it("注册全部 7 个通道（读取类 + 动作类）", () => {
    register();
    for (const channel of [
      IPC.SYNC_GET_CONFIG,
      IPC.SYNC_SAVE_CONFIG,
      IPC.SYNC_GET_STATUS,
      IPC.SYNC_NOW,
      IPC.SYNC_PAIR,
      IPC.SYNC_PAIR_CODE,
      IPC.SYNC_UNPAIR,
    ]) {
      expect(mocks.handlers.has(channel)).toBe(true);
    }
  });

  it("读取类：SYNC_GET_CONFIG / SYNC_GET_STATUS 直接返回数据（不包 SyncOpResult）", async () => {
    const { handler } = register();
    await expect(handler(IPC.SYNC_GET_CONFIG)({})).resolves.toEqual(PUBLIC_CONFIG);
    await expect(handler(IPC.SYNC_GET_STATUS)({})).resolves.toEqual(STATUS);
  });

  it("SYNC_SAVE_CONFIG：返回 SyncOpResult 并广播 SYNC_CHANGED（跳过已销毁窗口）", async () => {
    const aliveSend = vi.fn();
    const destroyedSend = vi.fn();
    mocks.windows = [
      { isDestroyed: () => false, webContents: { send: aliveSend } },
      { isDestroyed: () => true, webContents: { send: destroyedSend } },
    ];
    const { service, handler } = register();

    const result = await handler(IPC.SYNC_SAVE_CONFIG)({}, { enabled: true, baseUrl: "https://x", token: "tok" });

    expect(result).toEqual({ ok: true, data: PUBLIC_CONFIG });
    expect(service.saveConfig).toHaveBeenCalledWith({ enabled: true, baseUrl: "https://x", token: "tok" });
    expect(aliveSend).toHaveBeenCalledWith(IPC.SYNC_CHANGED, PUBLIC_CONFIG);
    expect(destroyedSend).not.toHaveBeenCalled();
  });

  it("SYNC_SAVE_CONFIG：SyncHttpError 映射为 {ok:false,error:{code,message}}", async () => {
    const { service, handler } = register();
    service.saveConfig.mockRejectedValueOnce(new SyncHttpError("invalid_config", 0, undefined, "缺少服务器地址"));

    const result = await handler(IPC.SYNC_SAVE_CONFIG)({}, {});

    expect(result).toEqual({ ok: false, error: { code: "invalid_config", message: "缺少服务器地址" } });
  });

  it("SYNC_SAVE_CONFIG：baseUrl 校验 scheme 与长度，非法输入不发往 service", async () => {
    const { service, handler } = register();

    for (const baseUrl of ["ftp://cloud.example.com", "not-a-url", "https://", `https://x.com/${"a".repeat(2048)}`]) {
      const result = await handler(IPC.SYNC_SAVE_CONFIG)({}, { baseUrl });
      expect(result, baseUrl).toMatchObject({ ok: false, error: { code: "invalid_config" } });
    }
    expect(service.saveConfig).not.toHaveBeenCalled();

    // 空串允许（清除地址）；合法 http(s) 且 trim 后透传
    await handler(IPC.SYNC_SAVE_CONFIG)({}, { baseUrl: "" });
    await handler(IPC.SYNC_SAVE_CONFIG)({}, { baseUrl: "  https://cloud.example.com/  " });
    expect(service.saveConfig).toHaveBeenNthCalledWith(1, { baseUrl: "" });
    expect(service.saveConfig).toHaveBeenNthCalledWith(2, { baseUrl: "https://cloud.example.com/" });
  });

  it("SYNC_NOW：成功返回状态；失败返回 SyncOpResult.ok=false；终态均广播 SYNC_CHANGED", async () => {
    const aliveSend = vi.fn();
    mocks.windows = [{ isDestroyed: () => false, webContents: { send: aliveSend } }];
    const { service, handler } = register();
    await expect(handler(IPC.SYNC_NOW)({})).resolves.toEqual({ ok: true, data: STATUS });
    expect(aliveSend).toHaveBeenCalledWith(IPC.SYNC_CHANGED, undefined);

    aliveSend.mockClear();
    service.syncNow.mockResolvedValueOnce({ ok: false, error: { code: "network", message: "网络请求失败" } });
    await expect(handler(IPC.SYNC_NOW)({})).resolves.toEqual({
      ok: false,
      error: { code: "network", message: "网络请求失败" },
    });
    expect(aliveSend).toHaveBeenCalledWith(IPC.SYNC_CHANGED, undefined);
  });

  it("SYNC_PAIR：缺配对码直接拒绝；成功广播", async () => {
    const aliveSend = vi.fn();
    mocks.windows = [{ isDestroyed: () => false, webContents: { send: aliveSend } }];
    const { service, handler } = register();

    await expect(handler(IPC.SYNC_PAIR)({}, { baseUrl: "https://x" })).resolves.toEqual({
      ok: false,
      error: { code: "invalid_config", message: "缺少配对码" },
    });
    expect(service.pair).not.toHaveBeenCalled();

    const result = await handler(IPC.SYNC_PAIR)({}, { baseUrl: "https://x", code: "CODE-1", deviceName: "desk" });
    expect(result).toEqual({ ok: true, data: PUBLIC_CONFIG });
    expect(service.pair).toHaveBeenCalledWith({ baseUrl: "https://x", code: "CODE-1", deviceName: "desk" });
    expect(aliveSend).toHaveBeenCalledWith(IPC.SYNC_CHANGED, PUBLIC_CONFIG);
  });

  it("SYNC_PAIR：baseUrl 校验 scheme 与长度（非法被拒不发往 service，空值允许）", async () => {
    const { service, handler } = register();

    for (const baseUrl of ["ftp://cloud.example.com", "not-a-url", `https://x.com/${"a".repeat(2048)}`]) {
      const result = await handler(IPC.SYNC_PAIR)({}, { baseUrl, code: "CODE-1" });
      expect(result, baseUrl).toMatchObject({ ok: false, error: { code: "invalid_config" } });
    }
    expect(service.pair).not.toHaveBeenCalled();

    // 空串允许（由 service 回退当前配置 / 报缺少地址）；合法输入 trim 后透传
    await handler(IPC.SYNC_PAIR)({}, { baseUrl: "", code: "CODE-1" });
    expect(service.pair).toHaveBeenNthCalledWith(1, { code: "CODE-1", baseUrl: "" });

    await handler(IPC.SYNC_PAIR)({}, { baseUrl: "  https://cloud.example.com/  ", code: "CODE-2" });
    expect(service.pair).toHaveBeenNthCalledWith(2, { code: "CODE-2", baseUrl: "https://cloud.example.com/" });
  });

  it("SYNC_PAIR_CODE / SYNC_UNPAIR：动作类返回 SyncOpResult", async () => {
    const aliveSend = vi.fn();
    mocks.windows = [{ isDestroyed: () => false, webContents: { send: aliveSend } }];
    const { service, handler } = register();

    await expect(handler(IPC.SYNC_PAIR_CODE)({})).resolves.toEqual({
      ok: true,
      data: { code: "AAAA-BBBB", expiresAt: "2026-10-06T12:00:00.000Z" },
    });

    const unpairResult = await handler(IPC.SYNC_UNPAIR)({});
    expect(unpairResult).toEqual({ ok: true, data: { ...PUBLIC_CONFIG, hasToken: false } });
    expect(service.unpair).toHaveBeenCalledTimes(1);
    expect(aliveSend).toHaveBeenCalledWith(IPC.SYNC_CHANGED, { ...PUBLIC_CONFIG, hasToken: false });
  });
});

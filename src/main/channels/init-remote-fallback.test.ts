// channels/init remote 回退 sync 配置测试（IKJK2I §7 / PR #26 P1-3）：
//   - channels.remote 显式 baseUrl/token 优先，不被 sync 设置覆盖；
//   - 仅缺 token / 仅缺 baseUrl 时分别回退 sync 设置（单一来源：同步 device token）；
//   - sync 全空时维持 channels 现状（不注入空值；remote 不完整则保持本地行为）；
//   - sync 读取异常（loadSyncSettings 抛错）兜底为显式配置，不阻塞渠道启动。
// 断言路径与生产接线一致：initializeChannels → createChannelOwnershipController 的 loadConfig，
// 经 getActiveOwnershipClient() 的 poll() 观察实际请求的 baseUrl（URL）与 token（Authorization 头）。
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as os from "node:os";

const mocks = vi.hoisted(() => {
  const state = {
    channelsSettings: null as Record<string, unknown> | null,
    syncSettings: { enabled: false, baseUrl: "", deviceName: "", token: "" },
    syncLoadThrows: false,
  };
  const loadSyncSettings = vi.fn(() => {
    if (state.syncLoadThrows) throw new Error("sync settings 读取失败");
    return state.syncSettings;
  });
  return { state, loadSyncSettings };
});

vi.mock("electron", () => ({
  app: {
    getPath: () => os.tmpdir(),
    getAppPath: () => process.cwd(),
    getName: () => "Cyrene",
    isReady: () => false,
    whenReady: async () => undefined,
  },
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
  safeStorage: { isEncryptionAvailable: () => false },
}));

vi.mock("./settings-store", () => ({
  loadChannelsSettings: () => mocks.state.channelsSettings,
  saveChannelsSettings: (patch: Record<string, unknown>) => patch,
}));

// 关键：mock sync 设置读取，回退分支才能真正被触发（P1-3）
vi.mock("../sync/sync-settings", () => ({
  loadSyncSettings: mocks.loadSyncSettings,
}));

vi.mock("./message-log", () => ({
  getRecentLog: vi.fn(() => []),
  clearLog: vi.fn(),
  reloadLogFromDisk: vi.fn(),
}));

vi.mock("./conversation-binding-store", () => ({
  getChannelConversationBindingStore: () => ({
    list: () => ({ externalChats: [], bindings: [] }),
    resolve: () => null,
    flush: () => undefined,
  }),
}));

vi.mock("../chats/chats-store", () => ({
  listSessions: () => [],
  getSession: () => null,
}));

vi.mock("./inbound-server", () => ({
  startInboundServer: vi.fn(async () => ({ port: 6201 })),
  stopInboundServer: vi.fn(async () => undefined),
}));

vi.mock("./adapters/feishu", () => ({
  FeishuAdapter: class {
    id = "feishu";
    displayName = "飞书";
    capability = {};
    onMessage = null;
    start = async () => undefined;
    stop = async () => undefined;
    getStatus = () => ({ enabled: false, phase: "offline" });
    send = async () => ({ ok: true });
  },
}));

vi.mock("./adapters/wechat/ilink-bot-adapter", () => ({
  ILinkBotAdapter: class {
    id = "wechat";
    displayName = "微信";
    capability = {};
    onMessage = null;
    start = async () => undefined;
    stop = async () => undefined;
    getStatus = () => ({ enabled: false, phase: "offline" });
    send = async () => ({ ok: true });
  },
  loadCredentials: vi.fn(async () => null),
}));

vi.mock("./adapters/wechat/ilink-protocol-client", () => ({
  fetchQrCode: vi.fn(),
}));

vi.mock("./adapters/wechat/qr", () => ({
  createQrDataUrl: vi.fn(),
}));

vi.mock("./adapters/qq/napcat-adapter", () => ({
  NapCatAdapter: class {
    id = "qq";
    displayName = "QQ";
    capability = {};
    onMessage = null;
    start = async () => undefined;
    stop = async () => undefined;
    getStatus = () => ({ enabled: false, phase: "offline" });
    send = async () => ({ ok: true });
  },
}));

vi.mock("./adapters/qq/onebot-reverse-ws", () => ({
  resolveQqListenAuthRequirement: () => ({ required: false, reason: "" }),
}));

vi.mock("./adapters/qqbot/qqbot-adapter", () => ({
  QqBotAdapter: class {
    id = "qqbot";
    displayName = "QQ 机器人";
    capability = {};
    onMessage = null;
    start = async () => undefined;
    stop = async () => undefined;
    getStatus = () => ({ enabled: false, phase: "offline" });
    send = async () => ({ ok: true });
  },
}));

// eslint-disable-next-line import/first
import { getActiveOwnershipClient, normalizeChannelsRemoteConfig } from "./ownership";
// eslint-disable-next-line import/first
import { initializeChannels } from "./init";

const EXPLICIT_BASE = "https://channels.example.com";
const EXPLICIT_TOKEN = "channels-token";
const SYNC_BASE = "https://sync.example.com";
const SYNC_TOKEN = "sync-token";
const EMPTY_SYNC = { enabled: false, baseUrl: "", deviceName: "", token: "" };

const fakeIpc = {
  handle: () => undefined,
  removeHandler: () => undefined,
  on: () => undefined,
  dispose: () => undefined,
};

/** 仅保留 remote 字段：本文件只覆盖 resolveChannelsRemoteConfig 的输入。 */
function makeSettings(remote: Record<string, unknown> = {}) {
  return { remote: normalizeChannelsRemoteConfig(remote) };
}

function ownershipClient() {
  const client = getActiveOwnershipClient();
  if (!client) throw new Error("ownership client 未接线（initializeChannels 未执行）");
  return client;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** 拦截 fetch；poll() 成功即可从 URL 与 Authorization 头反推解析后的 remote 配置。 */
function stubFetch() {
  const fetchMock = vi.fn(async (_input: string | URL, _init?: RequestInit) =>
    jsonResponse({ serverId: "s1", leaseTtlSeconds: 180, channels: {} }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function expectRequest(
  fetchMock: ReturnType<typeof stubFetch>,
  expected: { url: string; authorization?: string },
) {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [input, init] = fetchMock.mock.calls[0];
  expect(String(input)).toBe(expected.url);
  const headers = (init?.headers ?? {}) as Record<string, string>;
  if (expected.authorization === undefined) {
    expect(headers.Authorization).toBeUndefined();
  } else {
    expect(headers.Authorization).toBe(expected.authorization);
  }
}

beforeAll(() => {
  mocks.state.channelsSettings = makeSettings();
  initializeChannels({
    ipc: fakeIpc as never,
    handleIncoming: async () => null,
    reloadDispatcherSettings: () => undefined,
  });
});

afterEach(() => {
  mocks.state.syncLoadThrows = false;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("channels/init remote 回退 sync 配置（IKJK2I §7 / P1-3）", () => {
  it("① 显式 baseUrl+token 优先：sync 配置不同也不被覆盖，且不读 sync", async () => {
    const fetchMock = stubFetch();
    mocks.state.channelsSettings = makeSettings({
      enabled: true,
      baseUrl: EXPLICIT_BASE,
      token: EXPLICIT_TOKEN,
    });
    mocks.state.syncSettings = { enabled: true, baseUrl: SYNC_BASE, deviceName: "dev-1", token: SYNC_TOKEN };

    ownershipClient().invalidateConfig();
    await ownershipClient().poll();

    expectRequest(fetchMock, {
      url: `${EXPLICIT_BASE}/v1/channels/ownership`,
      authorization: `Bearer ${EXPLICIT_TOKEN}`,
    });
    // 显式配置齐备时短路，不读 sync（避免不必要的磁盘/解密）
    expect(mocks.loadSyncSettings).not.toHaveBeenCalled();
  });

  it("② 仅缺 token：回退 sync token，baseUrl 仍用显式", async () => {
    const fetchMock = stubFetch();
    mocks.state.channelsSettings = makeSettings({ enabled: true, baseUrl: EXPLICIT_BASE });
    mocks.state.syncSettings = { enabled: true, baseUrl: SYNC_BASE, deviceName: "dev-1", token: SYNC_TOKEN };

    ownershipClient().invalidateConfig();
    await ownershipClient().poll();

    expectRequest(fetchMock, {
      url: `${EXPLICIT_BASE}/v1/channels/ownership`,
      authorization: `Bearer ${SYNC_TOKEN}`,
    });
    expect(mocks.loadSyncSettings).toHaveBeenCalledTimes(1);
  });

  it("② 仅缺 baseUrl：回退 sync baseUrl，token 仍用显式", async () => {
    const fetchMock = stubFetch();
    mocks.state.channelsSettings = makeSettings({ enabled: true, token: EXPLICIT_TOKEN });
    mocks.state.syncSettings = { enabled: true, baseUrl: SYNC_BASE, deviceName: "dev-1", token: SYNC_TOKEN };

    ownershipClient().invalidateConfig();
    await ownershipClient().poll();

    expectRequest(fetchMock, {
      url: `${SYNC_BASE}/v1/channels/ownership`,
      authorization: `Bearer ${EXPLICIT_TOKEN}`,
    });
  });

  it("③ sync 全空维持现状：不注入空值；remote 不完整时保持本地行为", async () => {
    // (a) 显式 baseUrl + sync 全空：仍走显式 baseUrl，且不携带 token（undefined 透传，无空串注入）
    const fetchMock = stubFetch();
    mocks.state.channelsSettings = makeSettings({ enabled: true, baseUrl: EXPLICIT_BASE });
    mocks.state.syncSettings = { ...EMPTY_SYNC };

    ownershipClient().invalidateConfig();
    await ownershipClient().poll();
    expectRequest(fetchMock, { url: `${EXPLICIT_BASE}/v1/channels/ownership` });

    // (b) 显式也缺 baseUrl + sync 全空：remote 不完整 → 不发请求，decision 维持 local（接线前行为）
    const fetchMock2 = stubFetch();
    mocks.state.channelsSettings = makeSettings({ enabled: true });

    ownershipClient().invalidateConfig();
    await expect(ownershipClient().poll()).resolves.toBeNull();
    expect(fetchMock2).not.toHaveBeenCalled();
    expect(ownershipClient().decide("wechat" as never)).toEqual({
      phase: "local",
      runLocal: true,
      serverOwner: false,
    });
  });

  it("④ sync 读取异常：兜底为显式配置，poll 正常完成不抛出", async () => {
    const fetchMock = stubFetch();
    mocks.state.channelsSettings = makeSettings({ enabled: true, baseUrl: EXPLICIT_BASE });
    mocks.state.syncLoadThrows = true;

    ownershipClient().invalidateConfig();
    await expect(ownershipClient().poll()).resolves.toMatchObject({ serverId: "s1" });

    expect(mocks.loadSyncSettings).toHaveBeenCalledTimes(1);
    expectRequest(fetchMock, { url: `${EXPLICIT_BASE}/v1/channels/ownership` });
  });
});

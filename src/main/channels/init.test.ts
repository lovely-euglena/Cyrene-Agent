// channels/init 接线测试（R2）：
//   - P1-3：手动 IPC 直启入口（扫码登录/微信安装/飞书测试连接）必须受归属门闩约束；
//   - P1-4：运行期 remote 开关（本地→remote / remote→关闭）与 CHANNELS_RESTART 分流走控制器。
// 说明：本文件在「运行期分流」用例之后覆写 channelManager 门闩，新增用例请保持该顺序。
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as os from "node:os";

const mocks = vi.hoisted(() => ({
  settingsState: { current: null as Record<string, unknown> | null },
  adapterMethods: {
    feishu: {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      rebuild: vi.fn(async () => undefined),
    },
    wechat: {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      login: vi.fn(async () => ({ ilinkBotId: "bot-1" })),
      logout: vi.fn(async () => undefined),
    },
    qq: {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      testConnection: vi.fn(async () => ({ ok: true })),
    },
    qqbot: {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      testConnection: vi.fn(async () => ({ ok: true })),
    },
  },
  qr: {
    fetchQrCode: vi.fn(async () => ({
      qrcode: "ticket-1",
      qrcode_img_content: "https://liteapp.weixin.qq.com/q/x",
    })),
  },
}));

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
  loadChannelsSettings: () => mocks.settingsState.current,
  saveChannelsSettings: (patch: Record<string, unknown>) => {
    const current = mocks.settingsState.current ?? {};
    mocks.settingsState.current = {
      ...current,
      ...patch,
      remote: { ...(current.remote as object), ...(patch.remote as object | undefined) },
    };
    return mocks.settingsState.current;
  },
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
    start = mocks.adapterMethods.feishu.start;
    stop = mocks.adapterMethods.feishu.stop;
    rebuild = mocks.adapterMethods.feishu.rebuild;
    getStatus = () => ({ enabled: true, phase: "running", message: "已连接" });
    send = async () => ({ ok: true });
  },
}));

vi.mock("./adapters/wechat/ilink-bot-adapter", () => ({
  ILinkBotAdapter: class {
    id = "wechat";
    displayName = "微信";
    capability = {};
    onMessage = null;
    isLoggedIn = false;
    start = mocks.adapterMethods.wechat.start;
    stop = mocks.adapterMethods.wechat.stop;
    login = mocks.adapterMethods.wechat.login;
    logout = mocks.adapterMethods.wechat.logout;
    getStatus = () => ({ enabled: true, phase: "offline" });
    send = async () => ({ ok: true });
  },
  loadCredentials: vi.fn(async () => null),
}));

vi.mock("./adapters/wechat/ilink-protocol-client", () => ({
  fetchQrCode: mocks.qr.fetchQrCode,
}));

vi.mock("./adapters/wechat/qr", () => ({
  createQrDataUrl: vi.fn(async () => "data:image/png;base64,qr"),
}));

vi.mock("./adapters/qq/napcat-adapter", () => ({
  NapCatAdapter: class {
    id = "qq";
    displayName = "QQ";
    capability = {};
    onMessage = null;
    start = mocks.adapterMethods.qq.start;
    stop = mocks.adapterMethods.qq.stop;
    testConnection = mocks.adapterMethods.qq.testConnection;
    getStatus = () => ({ enabled: true, phase: "offline" });
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
    start = mocks.adapterMethods.qqbot.start;
    stop = mocks.adapterMethods.qqbot.stop;
    testConnection = mocks.adapterMethods.qqbot.testConnection;
    getStatus = () => ({ enabled: true, phase: "offline" });
    send = async () => ({ ok: true });
  },
}));

// eslint-disable-next-line import/first
import { IPC } from "../../shared/ipc-channels";
// eslint-disable-next-line import/first
import { normalizeChannelsRemoteConfig } from "./ownership";
// eslint-disable-next-line import/first
import { channelManager } from "./manager";
// eslint-disable-next-line import/first
import { CLOUD_MANAGED_START_ERROR, initializeChannels, startChannels } from "./init";

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown;
const ipcHandlers = new Map<string, IpcHandler>();
const fakeIpc = {
  handle: (channel: string, listener: IpcHandler) => {
    ipcHandlers.set(channel, listener);
  },
  removeHandler: (channel: string) => {
    ipcHandlers.delete(channel);
  },
  on: () => undefined,
  dispose: () => undefined,
};

function makeSettings(remote: Record<string, unknown> = {}) {
  return {
    wechat: { enabled: true },
    feishu: { enabled: true, appId: "cli_app", appSecret: "secret" },
    qq: {
      enabled: true,
      listenMode: "auto",
      port: 6200,
      allowedPrivateUserIds: [],
      allowedGroupIds: [],
      groupRequireMention: true,
      groupReplyStyle: "reply-and-mention",
      groupToolPolicy: "off",
      groupMemoryPolicy: "shared-personal",
    },
    qqbot: { enabled: true, allowAnyPrivate: false, allowedUserOpenids: [], allowedGroupOpenids: [] },
    remote: normalizeChannelsRemoteConfig(remote),
    inboundPort: 0,
    sharedSecret: "",
    rateLimitPerUser: 10,
    rateLimitPerChannel: 100,
    ttsEnabled: true,
    stickerEnabled: true,
    mirrorToDesktop: true,
    toolSandbox: "all",
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const REMOTE_PATCH = {
  enabled: true,
  baseUrl: "https://cloud.example.com",
  token: "device-token",
  preferServer: true,
  failover: "off",
  failoverGraceSeconds: 300,
};

beforeAll(async () => {
  mocks.settingsState.current = makeSettings();
  initializeChannels({
    ipc: fakeIpc as never,
    handleIncoming: async () => null,
    reloadDispatcherSettings: () => undefined,
  });
  await startChannels(); // 本地模式（remote 关闭）→ startAll
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("channels/init 运行期 remote 开关与重启分流（P1-4）", () => {
  it("本地→remote 开启（server 不可达）：控制器接管、门闩关闭、本机渠道全停；remote→关闭恢复 startAll", async () => {
    expect(channelManager.isStarted("wechat" as never)).toBe(true); // 初始本地模式
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }));
    const saveConfig = ipcHandlers.get(IPC.CHANNELS_SAVE_CONFIG)!;

    // 开启：plan=start-controller → 控制器 poll 失败 → decide=unknown → 门闩关闭、全部暂停
    await saveConfig({}, { remote: REMOTE_PATCH });
    for (const id of ["wechat", "feishu", "qq", "qqbot"]) {
      expect(channelManager.isStarted(id as never)).toBe(false);
      expect(channelManager.allowedToStart(id as never)).toBe(false);
    }

    // 关闭：plan=stop-controller-and-start-all → 恢复本机启动
    await saveConfig({}, { remote: { enabled: false } });
    for (const id of ["wechat", "feishu", "qq", "qqbot"]) {
      expect(channelManager.isStarted(id as never)).toBe(true);
      expect(channelManager.allowedToStart(id as never)).toBe(true);
    }
  });

  it("CHANNELS_RESTART：remote 已运行走控制器 syncNow（owner=server 渠道保持停用）", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url).endsWith("/v1/channels/ownership")) {
        return jsonResponse({
          serverId: "s1",
          leaseTtlSeconds: 180,
          channels: { wechat: { owner: "server" } },
        });
      }
      return jsonResponse({ granted: [], denied: [], released: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const saveConfig = ipcHandlers.get(IPC.CHANNELS_SAVE_CONFIG)!;
    await saveConfig({}, { remote: REMOTE_PATCH });
    expect(channelManager.isStarted("wechat" as never)).toBe(false);
    expect(channelManager.isStarted("feishu" as never)).toBe(true);

    // 模拟重启：先全停，再走 CHANNELS_RESTART → 控制器 syncNow 按归属恢复
    await channelManager.stopAll();
    expect(channelManager.isStarted("feishu" as never)).toBe(false);
    fetchMock.mockClear();
    const restarted = await ipcHandlers.get(IPC.CHANNELS_RESTART)!({});
    expect(restarted).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalled(); // 走 syncNow（而非本地 startAll）
    expect(channelManager.isStarted("feishu" as never)).toBe(true);
    expect(channelManager.isStarted("wechat" as never)).toBe(false);
  });

  it("CHANNELS_RESTART：并发重启等待在途同步的补跑落地后再返回（P2-6.6）", async () => {
    // 兜底：单跑本用例时前序 remote 状态可能未建立，先用正常响应确保控制器已启动
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      serverId: "s1", leaseTtlSeconds: 180, channels: { wechat: { owner: "server" } },
    })));
    await ipcHandlers.get(IPC.CHANNELS_SAVE_CONFIG)!({}, { remote: REMOTE_PATCH });

    // 让首个重启的 poll 挂起，制造在途同步
    let releasePoll: (() => void) | null = null;
    let pollCalls = 0;
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url).endsWith("/v1/channels/ownership")) {
        pollCalls += 1;
        if (pollCalls === 1) {
          return await new Promise<Response>((resolve) => {
            releasePoll = () => resolve(jsonResponse({
              serverId: "s1", leaseTtlSeconds: 180, channels: { wechat: { owner: "server" } },
            }));
          });
        }
        return jsonResponse({
          serverId: "s1", leaseTtlSeconds: 180, channels: { wechat: { owner: "server" } },
        });
      }
      return jsonResponse({ granted: [], denied: [], released: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    const restart = ipcHandlers.get(IPC.CHANNELS_RESTART)!;
    const first = restart({}); // 停全渠道后 syncNow 挂起在 poll#1
    await vi.waitFor(() => expect(pollCalls).toBe(1));
    const second = restart({}); // 并发重启：登记补跑并等待链尾
    releasePoll!();
    await second; // 返回时必须已等到补跑轮次落地
    expect(pollCalls).toBe(2);
    expect(channelManager.isStarted("feishu" as never)).toBe(true);
    expect(channelManager.isStarted("wechat" as never)).toBe(false);
    await first;
  });
});

describe("channels/init 手动 IPC 启动门闩（P1-3）", () => {
  it("云端托管（门闩拒绝）：扫码登录/微信安装/飞书测试连接都不直启适配器", async () => {
    channelManager.setStartGate(() => false);
    const install = await ipcHandlers.get(IPC.CHANNELS_WECHAT_INSTALL)!({});
    expect(install).toEqual({ ok: false, error: CLOUD_MANAGED_START_ERROR });

    const login = await ipcHandlers.get(IPC.CHANNELS_WECHAT_LOGIN_START)!({});
    expect(login).toEqual({ ok: false, error: CLOUD_MANAGED_START_ERROR });

    const feishu = await ipcHandlers.get(IPC.CHANNELS_FEISHU_TEST_CONNECTION)!({});
    expect(feishu).toEqual({ ok: false, error: CLOUD_MANAGED_START_ERROR });

    expect(mocks.adapterMethods.wechat.start).not.toHaveBeenCalled();
    expect(mocks.adapterMethods.wechat.stop).not.toHaveBeenCalled();
    expect(mocks.adapterMethods.wechat.login).not.toHaveBeenCalled();
    expect(mocks.adapterMethods.feishu.rebuild).not.toHaveBeenCalled();
  });

  it("门闩放行：三个入口照常直启/重建", async () => {
    channelManager.setStartGate(() => true);
    const install = await ipcHandlers.get(IPC.CHANNELS_WECHAT_INSTALL)!({});
    expect(install).toEqual({ ok: true, phase: "ready" });
    expect(mocks.adapterMethods.wechat.stop).toHaveBeenCalledTimes(1);
    expect(mocks.adapterMethods.wechat.start).toHaveBeenCalledTimes(1);

    const feishu = await ipcHandlers.get(IPC.CHANNELS_FEISHU_TEST_CONNECTION)!({});
    expect(feishu).toEqual({ ok: true, message: "WSS 长连接已建立" });
    expect(mocks.adapterMethods.feishu.rebuild).toHaveBeenCalledTimes(1);

    const login = await ipcHandlers.get(IPC.CHANNELS_WECHAT_LOGIN_START)!({});
    expect(login).toEqual({ ok: true, hint: "请扫描二维码" });
    await vi.waitFor(() => expect(mocks.adapterMethods.wechat.start).toHaveBeenCalledTimes(2));
    expect(mocks.qr.fetchQrCode).toHaveBeenCalledTimes(1);
  });

  it("扫码期间归属切到云端：登录完成也不 stop/start（P1-3 复查）", async () => {
    channelManager.setStartGate(() => true);
    let releaseLogin!: (creds: { ilinkBotId: string }) => void;
    mocks.adapterMethods.wechat.login.mockImplementationOnce(
      () => new Promise((resolve) => { releaseLogin = resolve; }),
    );
    const startsBefore = mocks.adapterMethods.wechat.start.mock.calls.length;
    const stopsBefore = mocks.adapterMethods.wechat.stop.mock.calls.length;

    const login = await ipcHandlers.get(IPC.CHANNELS_WECHAT_LOGIN_START)!({});
    expect(login).toEqual({ ok: true, hint: "请扫描二维码" });

    channelManager.setStartGate(() => false); // 扫码完成前云端接管
    releaseLogin({ ilinkBotId: "bot-2" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(mocks.adapterMethods.wechat.start.mock.calls.length).toBe(startsBefore);
    expect(mocks.adapterMethods.wechat.stop.mock.calls.length).toBe(stopsBefore);
  });
});

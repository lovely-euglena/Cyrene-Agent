// 归属租约客户端 / 决策 / 控制器 / 门闩（设计 §5，IKJK2P）。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelManager } from "./manager";
import type { ChannelAdapter } from "./adapters/base";
import {
  ChannelOwnershipClient,
  createChannelOwnershipController,
  decideChannelOwnership,
  normalizeChannelsRemoteConfig,
  type ChannelsRemoteConfig,
  type OwnershipDecisionInput,
} from "./ownership";

const REMOTE_ON: ChannelsRemoteConfig = normalizeChannelsRemoteConfig({
  enabled: true,
  baseUrl: "https://cloud.example.com/",
  token: "device-token",
  failover: "off",
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function fakeAdapter(id: string): ChannelAdapter {
  let started = false;
  return {
    id: id as never,
    displayName: id,
    capability: {} as never,
    onMessage: null,
    start: async () => { started = true; },
    stop: async () => { started = false; },
    send: async () => ({ ok: true }),
    getStatus: () => ({ enabled: started, phase: started ? "running" : "offline" }),
  };
}

describe("channels/ownership 配置解析", () => {
  it("规范化默认值：关闭、preferServer、failover=off、宽限 300s", () => {
    const config = normalizeChannelsRemoteConfig(null);
    expect(config).toEqual({
      enabled: false,
      preferServer: true,
      failover: "off",
      failoverGraceSeconds: 300,
    });
  });

  it("解析显式配置：baseUrl 去尾斜杠、failover/宽限收敛、token 保留", () => {
    const config = normalizeChannelsRemoteConfig({
      enabled: true,
      baseUrl: " https://cloud.example.com/base/ ",
      token: "tok",
      preferServer: false,
      failover: "local",
      failoverGraceSeconds: 10,
    });
    expect(config).toEqual({
      enabled: true,
      baseUrl: "https://cloud.example.com/base",
      token: "tok",
      preferServer: false,
      failover: "local",
      failoverGraceSeconds: 30,
    });
  });

  it("非法 failover/宽限回落默认", () => {
    const config = normalizeChannelsRemoteConfig({ failover: "queue", failoverGraceSeconds: "abc" });
    expect(config.failover).toBe("off");
    expect(config.failoverGraceSeconds).toBe(300);
  });
});

describe("channels/ownership 决策（§5.1/§5.5/§5.7）", () => {
  const base = {
    remoteEnabled: true,
    state: null as OwnershipDecisionInput["state"],
    lastSuccessAt: 1_000_000,
    now: 1_010_000,
    leaseTtlSeconds: 180,
    failover: "off" as const,
    failoverGraceMs: 300_000,
    serverReachable: true,
    claimedByThisProcess: false,
  };

  it("remote 关闭 → 本机照常（行为零变化）", () => {
    expect(decideChannelOwnership({ ...base, remoteEnabled: false })).toEqual({
      phase: "local", runLocal: true, serverOwner: false,
    });
  });

  it("owner=server → paused_remote，不本机启动", () => {
    expect(decideChannelOwnership({ ...base, state: { owner: "server" } })).toEqual({
      phase: "paused_remote", runLocal: false, serverOwner: true,
    });
  });

  it("owner=desktop 且本进程持有租约 → running_local", () => {
    expect(decideChannelOwnership({
      ...base, state: { owner: "desktop", holder: "me" }, claimedByThisProcess: true,
    })).toEqual({ phase: "running_local", runLocal: true, serverOwner: false });
  });

  it("owner=desktop 但非本进程意图（第二台设备，Q8）→ paused_remote", () => {
    expect(decideChannelOwnership({
      ...base, state: { owner: "desktop", holder: "other" }, claimedByThisProcess: false,
    })).toEqual({ phase: "paused_remote", runLocal: false, serverOwner: false });
  });

  it("快照有效但渠道不在服务端托管列表 → 本机运行", () => {
    expect(decideChannelOwnership({ ...base, state: null })).toEqual({
      phase: "local", runLocal: true, serverOwner: false,
    });
  });

  it("启动时服务端不可达 → unknown，不自动接管（§5.5）", () => {
    expect(decideChannelOwnership({
      ...base,
      lastSuccessAt: null,
      serverReachable: false,
      failover: "local",
      failoverGraceMs: 0,
    })).toEqual({ phase: "unknown", runLocal: false, serverOwner: false });
  });

  it("运行期不可达 < TTL：保留最后一次成功的归属判定", () => {
    expect(decideChannelOwnership({
      ...base,
      state: { owner: "server" },
      lastSuccessAt: 1_000_000,
      now: 1_100_000, // 100s < 180s
      serverReachable: false,
    })).toEqual({ phase: "paused_remote", runLocal: false, serverOwner: true });
  });

  it("运行期不可达超 TTL 但未到宽限 → unknown（仍不接管）", () => {
    expect(decideChannelOwnership({
      ...base,
      state: { owner: "server" },
      lastSuccessAt: 1_000_000,
      now: 1_200_000, // 200s > 180s，< 300s
      serverReachable: false,
      failover: "local",
    })).toEqual({ phase: "unknown", runLocal: false, serverOwner: false });
  });

  it("运行期不可达 ≥ 宽限且 failover=local → failover_local（显式兜底）", () => {
    expect(decideChannelOwnership({
      ...base,
      state: { owner: "server" },
      lastSuccessAt: 1_000_000,
      now: 1_310_000, // 310s ≥ 300s
      serverReachable: false,
      failover: "local",
    })).toEqual({ phase: "failover_local", runLocal: true, serverOwner: false });
  });

  it("failover=off 时即使超宽限也不接管", () => {
    expect(decideChannelOwnership({
      ...base,
      state: { owner: "server" },
      lastSuccessAt: 1_000_000,
      now: 9_999_999,
      serverReachable: false,
      failover: "off",
    })).toEqual({ phase: "unknown", runLocal: false, serverOwner: false });
  });

  it("用户显式本机运行（manualLocal）→ failover_local", () => {
    expect(decideChannelOwnership({
      ...base,
      state: { owner: "server" },
      serverReachable: false,
      manualLocal: true,
    })).toEqual({ phase: "failover_local", runLocal: true, serverOwner: false });
  });
});

describe("channels/ownership 客户端 HTTP（§5.2/§5.7）", () => {
  let now = 1_000_000;

  function makeClient(fetchImpl: typeof fetch, overrides: Partial<ChannelsRemoteConfig> = {}) {
    const config = { ...REMOTE_ON, ...overrides };
    return new ChannelOwnershipClient({
      loadConfig: () => config,
      fetchImpl,
      now: () => now,
      log: () => undefined,
    });
  }

  it("poll 成功：缓存快照 + 携带 Bearer + baseUrl 去尾斜杠", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      serverId: "s1",
      leaseTtlSeconds: 180,
      channels: { wechat: { owner: "server" } },
    })) as unknown as typeof fetch;
    const client = makeClient(fetchImpl);
    const snapshot = await client.poll();
    expect(snapshot?.channels.wechat.owner).toBe("server");
    expect(client.serverReachable).toBe(true);
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0];
    expect(url).toBe("https://cloud.example.com/v1/channels/ownership");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer device-token");
  });

  it("poll 失败：连续失败计数、lastSuccess 不变、超 TTL 前保留状态", async () => {
    let fail = false;
    const fetchImpl = vi.fn(async () => {
      if (fail) throw new Error("ECONNREFUSED");
      return jsonResponse({ serverId: "s1", leaseTtlSeconds: 180, channels: { wechat: { owner: "server" } } });
    }) as unknown as typeof fetch;
    const client = makeClient(fetchImpl);
    await client.poll();
    fail = true;
    now += 60_000;
    expect(await client.poll()).toBeNull();
    expect(await client.poll()).toBeNull();
    expect(client.getFailureCount()).toBe(2);
    expect(client.getLastError()).toContain("ECONNREFUSED");
    expect(client.getChannelState("wechat")?.owner).toBe("server");
    expect(client.decide("wechat").phase).toBe("paused_remote");
  });

  it("claim：granted 记录租约意图、denied 清除；心跳 lost 缓存降级 server", async () => {
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const path = String(url);
      if (path.endsWith("/claim")) {
        return jsonResponse({ granted: ["wechat"], denied: ["feishu"], leaseExpiresAt: "2026-10-05T00:03:00.000Z" });
      }
      if (path.endsWith("/heartbeat")) {
        return jsonResponse({ renewed: ["wechat"], lost: [] });
      }
      return jsonResponse({ serverId: "s1", leaseTtlSeconds: 180, channels: {} });
    }) as unknown as typeof fetch;
    const client = makeClient(fetchImpl);
    await client.poll();
    const claim = await client.claim(["wechat", "feishu"]);
    expect(claim.granted).toEqual(["wechat"]);
    expect(client.wantsLocal("wechat")).toBe(true);
    expect(client.wantsLocal("feishu")).toBe(false);
    expect(client.getChannelState("wechat")).toMatchObject({ owner: "desktop", leaseExpiresAt: "2026-10-05T00:03:00.000Z" });

    const heartbeat = await client.heartbeat(["wechat"]);
    expect(heartbeat.renewed).toEqual(["wechat"]);
    expect(client.getChannelState("wechat")?.leaseExpiresAt).not.toBe("2026-10-05T00:03:00.000Z");
  });

  it("heartbeat lost：owner 缓存降级为 server（桌面须立刻停本机）", async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const path = String(url);
      if (path.endsWith("/claim")) {
        return jsonResponse({ granted: ["wechat"], denied: [], leaseExpiresAt: "2026-10-05T00:03:00.000Z" });
      }
      if (path.endsWith("/heartbeat")) return jsonResponse({ renewed: [], lost: ["wechat"] });
      return jsonResponse({ serverId: "s1", leaseTtlSeconds: 180, channels: {} });
    }) as unknown as typeof fetch;
    const client = makeClient(fetchImpl);
    await client.poll();
    await client.claim(["wechat"]);
    const lost = await client.heartbeat(["wechat"]);
    expect(lost.lost).toEqual(["wechat"]);
    expect(client.getChannelState("wechat")?.owner).toBe("server");
    // 意图保留：下一轮 sync 会重新 claim（§5.7）
    expect(client.wantsLocal("wechat")).toBe(true);
  });

  it("release：清意图 + 缓存置 server", async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const path = String(url);
      if (path.endsWith("/claim")) {
        return jsonResponse({ granted: ["wechat"], denied: [], leaseExpiresAt: "2026-10-05T00:03:00.000Z" });
      }
      if (path.endsWith("/release")) return jsonResponse({ released: ["wechat"] });
      return jsonResponse({ serverId: "s1", leaseTtlSeconds: 180, channels: {} });
    }) as unknown as typeof fetch;
    const client = makeClient(fetchImpl);
    await client.poll();
    await client.claim(["wechat"]);
    const released = await client.release(["wechat"]);
    expect(released.released).toEqual(["wechat"]);
    expect(client.wantsLocal("wechat")).toBe(false);
    expect(client.getChannelState("wechat")?.owner).toBe("server");
  });

  it("deliverProactive：转发 body 带 intentId，duplicate/错误码正确映射", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
      if (calls.length === 1) return jsonResponse({ eventId: "proactive-x", delivered: true });
      if (calls.length === 2) return jsonResponse({ eventId: "proactive-x", delivered: true, duplicate: true });
      return jsonResponse({ code: "E_CHANNEL_RECIPIENT_MISSING" }, 400);
    }) as unknown as typeof fetch;
    const client = makeClient(fetchImpl);
    const first = await client.deliverProactive("wechat", { intentId: "i1", text: "你好" });
    expect(first).toMatchObject({ ok: true, delivered: true, duplicate: false });
    expect(calls[0].url).toBe("https://cloud.example.com/v1/channels/wechat/proactive");
    expect(calls[0].body).toEqual({ intentId: "i1", text: "你好" });
    const duplicate = await client.deliverProactive("wechat", { intentId: "i1", text: "你好" });
    expect(duplicate).toMatchObject({ ok: true, delivered: true, duplicate: true });
    const missing = await client.deliverProactive("feishu", { intentId: "i2", text: "你好" });
    expect(missing).toEqual({ ok: false, error: "E_CHANNEL_RECIPIENT_MISSING" });
  });

  it("shouldForwardProactive 仅 owner=server + 配置可用时为 true", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      serverId: "s1", leaseTtlSeconds: 180, channels: { wechat: { owner: "server" }, feishu: { owner: "desktop" } },
    })) as unknown as typeof fetch;
    const client = makeClient(fetchImpl);
    await client.poll();
    expect(client.shouldForwardProactive("wechat")).toBe(true);
    expect(client.shouldForwardProactive("feishu")).toBe(false);
    const disabled = makeClient(fetchImpl, { enabled: false });
    await disabled.poll();
    expect(disabled.shouldForwardProactive("wechat")).toBe(false);
  });
});

describe("channels/ownership 控制器与门闩（§5.3/§5.6）", () => {
  let now = 1_000_000;
  let ownershipPayload: unknown = { serverId: "s1", leaseTtlSeconds: 180, channels: {} };
  let claimPayload: unknown = { granted: [], denied: [], leaseExpiresAt: undefined };
  let heartbeatPayload: unknown = { renewed: [], lost: [] };
  let releasePayload: unknown = { released: [] };
  let pollFails = false;

  function makeFetch() {
    return vi.fn(async (url: string | URL) => {
      const path = String(url);
      if (path.endsWith("/claim")) return jsonResponse(claimPayload);
      if (path.endsWith("/heartbeat")) return jsonResponse(heartbeatPayload);
      if (path.endsWith("/release")) return jsonResponse(releasePayload);
      if (pollFails) throw new Error("unreachable");
      return jsonResponse(ownershipPayload);
    }) as unknown as typeof fetch;
  }

  function makeController(configOverrides: Partial<ChannelsRemoteConfig> = {}) {
    const manager = new ChannelManager();
    manager.register(fakeAdapter("wechat"));
    manager.register(fakeAdapter("feishu"));
    const config: ChannelsRemoteConfig = { ...REMOTE_ON, ...configOverrides };
    const client = new ChannelOwnershipClient({
      loadConfig: () => config,
      fetchImpl: makeFetch(),
      now: () => now,
      log: () => undefined,
    });
    const controller = createChannelOwnershipController({
      manager,
      loadConfig: () => config,
      client,
      setIntervalImpl: (() => 1) as unknown as typeof setInterval,
      clearIntervalImpl: (() => undefined) as unknown as typeof clearInterval,
      log: () => undefined,
    });
    return { manager, controller };
  }

  beforeEach(() => {
    now = 1_000_000;
    pollFails = false;
    ownershipPayload = { serverId: "s1", leaseTtlSeconds: 180, channels: {} };
    claimPayload = { granted: [], denied: [], leaseExpiresAt: undefined };
    heartbeatPayload = { renewed: [], lost: [] };
    releasePayload = { released: [] };
  });

  it("owner=server 渠道不启动；未托管渠道本机运行", async () => {
    ownershipPayload = { serverId: "s1", leaseTtlSeconds: 180, channels: { wechat: { owner: "server" } } };
    const { manager, controller } = makeController();
    await controller.start();
    expect(manager.isStarted("wechat" as never)).toBe(false);
    expect(manager.isStarted("feishu" as never)).toBe(true);
    expect(controller.getPhase("wechat" as never)).toBe("paused_remote");
    expect(controller.shouldRunLocal("wechat" as never)).toBe(false);
    expect(controller.shouldProcess("wechat" as never)).toBe(false);
  });

  it("requestLocalRun：claim 授予后启动本机；release 后停本机", async () => {
    ownershipPayload = { serverId: "s1", leaseTtlSeconds: 180, channels: { wechat: { owner: "server" } } };
    claimPayload = { granted: ["wechat"], denied: [], leaseExpiresAt: "2026-10-05T00:03:00.000Z" };
    releasePayload = { released: ["wechat"] };
    const { manager, controller } = makeController();
    await controller.start();
    const outcome = await controller.requestLocalRun(["wechat" as never]);
    expect(outcome.granted).toEqual(["wechat"]);
    expect(manager.isStarted("wechat" as never)).toBe(true);
    expect(controller.getPhase("wechat" as never)).toBe("running_local");

    await controller.requestServerRun(["wechat" as never]);
    expect(manager.isStarted("wechat" as never)).toBe(false);
  });

  it("claim denied（第二台设备）：不启动本机（Q8）", async () => {
    ownershipPayload = { serverId: "s1", leaseTtlSeconds: 180, channels: { wechat: { owner: "desktop", holder: "other" } } };
    claimPayload = { granted: [], denied: ["wechat"] };
    const { manager, controller } = makeController();
    await controller.start();
    const outcome = await controller.requestLocalRun(["wechat" as never]);
    expect(outcome.denied).toEqual(["wechat"]);
    expect(manager.isStarted("wechat" as never)).toBe(false);
  });

  it("heartbeat lost：立即停本机适配器（§5.7）", async () => {
    ownershipPayload = { serverId: "s1", leaseTtlSeconds: 180, channels: { wechat: { owner: "server" } } };
    claimPayload = { granted: ["wechat"], denied: [], leaseExpiresAt: "2026-10-05T00:03:00.000Z" };
    heartbeatPayload = { renewed: [], lost: ["wechat"] };
    const { manager, controller } = makeController();
    await controller.start();
    await controller.requestLocalRun(["wechat" as never]);
    expect(manager.isStarted("wechat" as never)).toBe(true);
    await controller.heartbeatNow();
    expect(manager.isStarted("wechat" as never)).toBe(false);
  });

  it("运行期不可达 ≥ 宽限且 failover=local：启动本机兜底", async () => {
    const { manager, controller } = makeController({ failover: "local", failoverGraceSeconds: 300 });
    await controller.start(); // 首次成功（lastSuccessAt = now）
    expect(manager.isStarted("wechat" as never)).toBe(true); // 未托管 → local
    // 模拟服务端托管 + 之后不可达
    ownershipPayload = { serverId: "s1", leaseTtlSeconds: 180, channels: { wechat: { owner: "server" } } };
    await controller.syncNow();
    expect(manager.isStarted("wechat" as never)).toBe(false);

    pollFails = true;
    now += 310_000;
    await controller.syncNow();
    expect(controller.getPhase("wechat" as never)).toBe("failover_local");
    expect(manager.isStarted("wechat" as never)).toBe(true);
  });

  it("failover=off：超宽限也不接管（保持停用）", async () => {
    ownershipPayload = { serverId: "s1", leaseTtlSeconds: 180, channels: { wechat: { owner: "server" } } };
    const { manager, controller } = makeController({ failover: "off" });
    await controller.start();
    pollFails = true;
    now += 999_000;
    await controller.syncNow();
    expect(manager.isStarted("wechat" as never)).toBe(false);
    expect(controller.getPhase("wechat" as never)).toBe("unknown");
  });

  it("启动时不可达：不自动接管；手动 requestLocalRun 兜底启动", async () => {
    pollFails = true;
    claimPayload = { granted: [], denied: [] };
    const { manager, controller } = makeController({ failover: "local" });
    await controller.start();
    expect(manager.isStarted("wechat" as never)).toBe(false);
    expect(controller.getPhase("wechat" as never)).toBe("unknown");

    await controller.requestLocalRun(["wechat" as never]);
    expect(manager.isStarted("wechat" as never)).toBe(true);
    expect(controller.getPhase("wechat" as never)).toBe("failover_local");
  });

  it("manager 启动门闩：startAll/startOne 跳过 owner=server 渠道", async () => {
    const manager = new ChannelManager();
    const adapter = fakeAdapter("wechat");
    manager.register(adapter);
    manager.setStartGate(() => false);
    await manager.startAll();
    await manager.startOne("wechat" as never);
    expect(adapter.getStatus().phase).toBe("offline");
    expect(manager.allowedToStart("wechat" as never)).toBe(false);
    manager.setStartGate(() => true);
    await manager.startOne("wechat" as never);
    expect(manager.isStarted("wechat" as never)).toBe(true);
    await manager.pauseOne("wechat" as never);
    expect(manager.isStarted("wechat" as never)).toBe(false);
  });
});

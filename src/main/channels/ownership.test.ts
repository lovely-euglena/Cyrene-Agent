// 归属租约客户端 / 决策 / 控制器 / 门闩（设计 §5，IKJK2P）。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelManager } from "./manager";
import type { ChannelAdapter } from "./adapters/base";
import {
  ChannelOwnershipClient,
  createChannelOwnershipController,
  decideChannelOwnership,
  normalizeChannelsRemoteConfig,
  OWNERSHIP_CONFIG_CACHE_MS,
  planChannelsRestart,
  planOwnershipRuntimeAction,
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

  it("release 返回空集（服务端已 sweep，owner≠desktop 被跳过）：无 error 即清意图（P1-1）", async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const path = String(url);
      if (path.endsWith("/claim")) {
        return jsonResponse({ granted: ["wechat"], denied: [], leaseExpiresAt: "2026-10-05T00:03:00.000Z" });
      }
      if (path.endsWith("/release")) return jsonResponse({ released: [] });
      return jsonResponse({ serverId: "s1", leaseTtlSeconds: 180, channels: {} });
    }) as unknown as typeof fetch;
    const client = makeClient(fetchImpl);
    await client.poll();
    await client.claim(["wechat"]);
    const outcome = await client.release(["wechat"]);
    expect(outcome.error).toBeUndefined();
    expect(outcome.released).toEqual([]);
    // 残留 desiredLocal 会让下一轮 reclaim 立即重新占用；空集也必须清
    expect(client.wantsLocal("wechat")).toBe(false);
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

  it("failover 兜底期间 shouldForwardProactive=false（不再转发到不可达服务端，P2-8①）", async () => {
    let fail = false;
    const fetchImpl = vi.fn(async () => {
      if (fail) throw new Error("unreachable");
      return jsonResponse({
        serverId: "s1", leaseTtlSeconds: 180, channels: { wechat: { owner: "server" } },
      });
    }) as unknown as typeof fetch;
    const client = makeClient(fetchImpl, { failover: "local", failoverGraceSeconds: 30 });
    await client.poll();
    expect(client.shouldForwardProactive("wechat")).toBe(true);

    fail = true;
    now += 200_000; // 超 TTL 180s 且 ≥ 宽限 30s → failover_local
    await client.poll();
    expect(client.decide("wechat").phase).toBe("failover_local");
    expect(client.shouldForwardProactive("wechat")).toBe(false);
  });

  it("remote 配置读取带 TTL 缓存，invalidateConfig 立即失效（P2-8④）", () => {
    let loads = 0;
    const config = { ...REMOTE_ON };
    const client = new ChannelOwnershipClient({
      loadConfig: () => { loads += 1; return config; },
      fetchImpl: (async () => jsonResponse({})) as unknown as typeof fetch,
      now: () => now,
      log: () => undefined,
    });
    client.decide("wechat");
    client.decide("feishu");
    expect(loads).toBe(1);

    now += OWNERSHIP_CONFIG_CACHE_MS + 1;
    client.decide("wechat");
    expect(loads).toBe(2);

    client.invalidateConfig();
    client.decide("wechat");
    expect(loads).toBe(3);
  });

  it("控制面请求带超时信号；abortInFlight 中止在途请求（P1-5）", async () => {
    let signal: AbortSignal | undefined;
    const fetchImpl = vi.fn((_url: string | URL, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      });
    }) as unknown as typeof fetch;
    const client = makeClient(fetchImpl);
    const pending = client.poll();
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);

    client.abortInFlight();
    await expect(pending).resolves.toBeNull();
    expect(signal?.aborted).toBe(true);
    expect(client.getFailureCount()).toBe(1);
  });
});

describe("channels/ownership 控制器与门闩（§5.3/§5.6）", () => {
  let now = 1_000_000;
  let ownershipPayload: unknown = { serverId: "s1", leaseTtlSeconds: 180, channels: {} };
  let claimPayload: unknown = { granted: [], denied: [], leaseExpiresAt: undefined };
  let heartbeatPayload: unknown = { renewed: [], lost: [] };
  let releasePayload: unknown = { released: [] };
  let pollFails = false;
  let claimFails = false;

  function makeFetch() {
    return vi.fn(async (url: string | URL) => {
      const path = String(url);
      if (path.endsWith("/claim")) {
        if (claimFails) throw new Error("claim unreachable");
        return jsonResponse(claimPayload);
      }
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
    claimFails = false;
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

  it("applyPlan 单渠道启动失败不影响其它渠道（P1-4）", async () => {
    const manager = new ChannelManager();
    const bad = fakeAdapter("wechat");
    bad.start = async () => { throw new Error("start boom"); };
    manager.register(bad);
    manager.register(fakeAdapter("feishu"));
    const config: ChannelsRemoteConfig = { ...REMOTE_ON };
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

    await expect(controller.start()).resolves.toBeUndefined();
    expect(manager.isStarted("feishu" as never)).toBe(true);
    expect(manager.isStarted("wechat" as never)).toBe(false);
  });

  it("stop 中止在途控制面请求且不再落地启停（P1-5）", async () => {
    const manager = new ChannelManager();
    const adapter = fakeAdapter("wechat");
    manager.register(adapter);
    const config: ChannelsRemoteConfig = { ...REMOTE_ON };
    let pollHangs = false;
    let releasePoll: (() => void) | null = null;
    let pollSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith("/v1/channels/ownership") && pollHangs) {
        pollSignal = init?.signal ?? undefined;
        return await new Promise<Response>((resolve) => {
          releasePoll = () => resolve(jsonResponse({ serverId: "s1", leaseTtlSeconds: 180, channels: {} }));
        });
      }
      return jsonResponse({
        serverId: "s1", leaseTtlSeconds: 180, channels: { wechat: { owner: "server" } },
      });
    }) as unknown as typeof fetch;
    const client = new ChannelOwnershipClient({
      loadConfig: () => config,
      fetchImpl,
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

    await controller.start(); // owner=server → 本机不启动
    expect(manager.isStarted("wechat" as never)).toBe(false);

    pollHangs = true;
    const syncing = controller.syncNow(); // 挂起在 poll
    await Promise.resolve();
    await controller.stop();
    expect(pollSignal?.aborted).toBe(true);

    releasePoll?.(); // 黑洞请求晚到：applyPlan 不得再启动渠道
    await syncing;
    expect(manager.isStarted("wechat" as never)).toBe(false);
  });

  it("preferServer=true（默认）：兜底后服务端恢复 → release 并停本机（§5.5）", async () => {
    const { manager, controller } = makeController({ failover: "local", failoverGraceSeconds: 300 });
    await controller.start();
    ownershipPayload = { serverId: "s1", leaseTtlSeconds: 180, channels: { wechat: { owner: "server" } } };
    await controller.syncNow();
    expect(manager.isStarted("wechat" as never)).toBe(false);

    pollFails = true;
    now += 310_000;
    await controller.syncNow();
    expect(controller.getPhase("wechat" as never)).toBe("failover_local");
    expect(manager.isStarted("wechat" as never)).toBe(true);

    const releaseSpy = vi.spyOn(controller.client, "release");
    pollFails = false;
    releasePayload = { released: ["wechat"] };
    await controller.syncNow();
    expect(releaseSpy).toHaveBeenCalledWith(["wechat"]);
    expect(manager.isStarted("wechat" as never)).toBe(false);
    expect(controller.getPhase("wechat" as never)).toBe("paused_remote");
  });

  it("preferServer=true：release 返回空集（服务端已 sweep）仍清意图、同轮不 re-claim（P1-1）", async () => {
    const { manager, controller } = makeController({ failover: "local", failoverGraceSeconds: 300 });
    await controller.start();
    ownershipPayload = { serverId: "s1", leaseTtlSeconds: 180, channels: { wechat: { owner: "server" } } };
    await controller.syncNow();
    expect(manager.isStarted("wechat" as never)).toBe(false);

    pollFails = true;
    now += 310_000;
    await controller.syncNow(); // 自动兜底启动
    expect(controller.getPhase("wechat" as never)).toBe("failover_local");
    expect(manager.isStarted("wechat" as never)).toBe(true);
    // 模拟残留的本机意图（进程重启心跳回租/曾 claim）：旧实现会据此在同轮 re-claim
    controller.client.markDesiredLocal(["wechat" as never]);

    // 服务端恢复：租约已被 sweep 收回（owner=server），release 返回空集且无 error；
    // 若 reclaim 被触发，服务端此刻仍会 grant（重现 P1-1「交回失效」）
    pollFails = false;
    ownershipPayload = { serverId: "s1", leaseTtlSeconds: 180, channels: { wechat: { owner: "server" } } };
    releasePayload = { released: [] };
    claimPayload = { granted: ["wechat"], denied: [], leaseExpiresAt: "2026-10-05T00:10:00.000Z" };
    const claimSpy = vi.spyOn(controller.client, "claim");
    await controller.syncNow();
    expect(manager.isStarted("wechat" as never)).toBe(false);
    expect(controller.getPhase("wechat" as never)).toBe("paused_remote");
    expect(controller.client.wantsLocal("wechat" as never)).toBe(false);
    expect(claimSpy).not.toHaveBeenCalled(); // 同轮 reclaim 不得把它捡回

    await controller.syncNow(); // 下一轮也不得重新占用
    expect(claimSpy).not.toHaveBeenCalled();
    expect(manager.isStarted("wechat" as never)).toBe(false);
  });

  it("preferServer=true：release 失败保留意图重试，成功后才交回（P1-1）", async () => {
    const { manager, controller } = makeController({ failover: "local", failoverGraceSeconds: 300 });
    await controller.start();
    ownershipPayload = { serverId: "s1", leaseTtlSeconds: 180, channels: { wechat: { owner: "server" } } };
    await controller.syncNow();

    pollFails = true;
    now += 310_000;
    await controller.syncNow();
    expect(manager.isStarted("wechat" as never)).toBe(true);
    controller.client.markDesiredLocal(["wechat" as never]);

    // 服务端恢复但 release 请求失败：保留意图与 autoFailover，下一轮重试
    pollFails = false;
    let releaseFails = true;
    const releaseSpy = vi.spyOn(controller.client, "release").mockImplementation(async () => {
      if (releaseFails) return { released: [], error: "release unreachable" };
      return { released: [] };
    });
    ownershipPayload = { serverId: "s1", leaseTtlSeconds: 180, channels: { wechat: { owner: "desktop", holder: "me" } } };
    await controller.syncNow();
    expect(releaseSpy).toHaveBeenCalledTimes(1);
    expect(manager.isStarted("wechat" as never)).toBe(true); // 仍持租约：保持本机
    expect(controller.client.wantsLocal("wechat" as never)).toBe(true);

    releaseFails = false;
    await controller.syncNow();
    expect(releaseSpy).toHaveBeenCalledTimes(2);
    expect(controller.client.wantsLocal("wechat" as never)).toBe(false);
    expect(manager.isStarted("wechat" as never)).toBe(false);
    expect(controller.getPhase("wechat" as never)).toBe("paused_remote");
  });

  it("preferServer=false：兜底后服务端恢复 → claim 维持本机（§5.5）", async () => {
    const { manager, controller } = makeController({
      failover: "local", failoverGraceSeconds: 300, preferServer: false,
    });
    await controller.start();
    ownershipPayload = { serverId: "s1", leaseTtlSeconds: 180, channels: { wechat: { owner: "server" } } };
    await controller.syncNow();
    expect(manager.isStarted("wechat" as never)).toBe(false);

    pollFails = true;
    now += 310_000;
    await controller.syncNow();
    expect(controller.getPhase("wechat" as never)).toBe("failover_local");
    expect(manager.isStarted("wechat" as never)).toBe(true);

    const claimSpy = vi.spyOn(controller.client, "claim");
    pollFails = false;
    claimPayload = { granted: ["wechat"], denied: [], leaseExpiresAt: "2026-10-05T00:10:00.000Z" };
    await controller.syncNow();
    expect(claimSpy).toHaveBeenCalledWith(["wechat"]);
    expect(manager.isStarted("wechat" as never)).toBe(true);
    expect(controller.getPhase("wechat" as never)).toBe("running_local");
    expect(controller.client.wantsLocal("wechat" as never)).toBe(true);
  });

  it("手动兜底（本机运行）在服务端恢复后维持本机，不自动交回（§5.5）", async () => {
    pollFails = true;
    const { manager, controller } = makeController({ failover: "local" });
    await controller.start();
    expect(controller.getPhase("wechat" as never)).toBe("unknown");
    await controller.requestLocalRun(["wechat" as never]); // claim 未授予 → 手动兜底
    expect(manager.isStarted("wechat" as never)).toBe(true);
    expect(controller.getPhase("wechat" as never)).toBe("failover_local");

    const releaseSpy = vi.spyOn(controller.client, "release");
    pollFails = false;
    ownershipPayload = { serverId: "s1", leaseTtlSeconds: 180, channels: { wechat: { owner: "server" } } };
    claimPayload = { granted: ["wechat"], denied: [], leaseExpiresAt: "2026-10-05T00:10:00.000Z" };
    await controller.syncNow();
    expect(releaseSpy).not.toHaveBeenCalled();
    expect(manager.isStarted("wechat" as never)).toBe(true);
    expect(controller.getPhase("wechat" as never)).toBe("running_local");
  });

  it("claim denied 清除手动兜底标记，停止残余本机运行（P2-8②）", async () => {
    pollFails = true;
    claimFails = true;
    const { manager, controller } = makeController({ failover: "local" });
    await controller.start();
    await controller.requestLocalRun(["wechat" as never]); // claim 网络失败 → 手动兜底启动
    expect(manager.isStarted("wechat" as never)).toBe(true);
    expect(controller.client.wantsManualLocal("wechat" as never)).toBe(true);

    pollFails = false;
    claimFails = false;
    ownershipPayload = { serverId: "s1", leaseTtlSeconds: 180, channels: { wechat: { owner: "server" } } };
    claimPayload = { granted: [], denied: ["wechat"] };
    await controller.syncNow();
    expect(controller.client.wantsManualLocal("wechat" as never)).toBe(false);
    expect(controller.client.wantsLocal("wechat" as never)).toBe(false);
    expect(manager.isStarted("wechat" as never)).toBe(false);
    expect(controller.getPhase("wechat" as never)).toBe("paused_remote");
  });

  it("syncNow 单飞：并发触发不产生并发轮次，在途触发合并为一次串行补跑（P2-1）", async () => {
    const manager = new ChannelManager();
    manager.register(fakeAdapter("wechat"));
    const config: ChannelsRemoteConfig = { ...REMOTE_ON };
    let pollCalls = 0;
    let activePolls = 0;
    let maxActivePolls = 0;
    let releaseFirstPoll: (() => void) | null = null;
    const fetchImpl = vi.fn(async (url: string | URL) => {
      if (String(url).endsWith("/v1/channels/ownership")) {
        pollCalls += 1;
        activePolls += 1;
        maxActivePolls = Math.max(maxActivePolls, activePolls);
        if (pollCalls === 1) {
          await new Promise<void>((resolve) => { releaseFirstPoll = resolve; });
        }
        activePolls -= 1;
      }
      return jsonResponse({ serverId: "s1", leaseTtlSeconds: 180, channels: {} });
    }) as unknown as typeof fetch;
    const client = new ChannelOwnershipClient({
      loadConfig: () => config,
      fetchImpl,
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

    const starting = controller.start(); // 首次同步挂起在 poll#1
    expect(pollCalls).toBe(1);
    const second = controller.syncNow(); // 在途触发：登记补跑
    const third = controller.syncNow(); // 再次触发：合并进同一次补跑
    releaseFirstPoll!();
    await starting;
    await second;
    await third;
    expect(maxActivePolls).toBe(1); // 全程无并发轮次
    expect(pollCalls).toBe(2); // 首次 + 合并后的一次串行补跑
  });

  it("server 不可达时 remote 开启（start-controller 分支）：门闩关闭、渠道保持停用（P1-4）", async () => {
    pollFails = true;
    const { manager, controller } = makeController();
    expect(planOwnershipRuntimeAction({
      started: true, remoteEnabled: true, controllerRunning: false,
    })).toBe("start-controller");
    await controller.start();
    expect(manager.isStarted("wechat" as never)).toBe(false);
    expect(manager.isStarted("feishu" as never)).toBe(false);
    expect(controller.shouldRunLocal("wechat" as never)).toBe(false);
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

describe("channels/ownership 运行期分流判定（P1-4）", () => {
  it("syncOwnershipRuntime：本地→remote 开启走 start-controller，remote→关闭走 stop-controller-and-start-all", () => {
    expect(planOwnershipRuntimeAction({
      started: true, remoteEnabled: true, controllerRunning: false,
    })).toBe("start-controller");
    expect(planOwnershipRuntimeAction({
      started: true, remoteEnabled: false, controllerRunning: true,
    })).toBe("stop-controller-and-start-all");
  });

  it("syncOwnershipRuntime：未启动/已在 remote/本就本地不产生多余动作", () => {
    expect(planOwnershipRuntimeAction({
      started: false, remoteEnabled: true, controllerRunning: false,
    })).toBe("noop");
    expect(planOwnershipRuntimeAction({
      started: true, remoteEnabled: true, controllerRunning: true,
    })).toBe("reload-config");
    expect(planOwnershipRuntimeAction({
      started: true, remoteEnabled: false, controllerRunning: false,
    })).toBe("noop");
  });

  it("CHANNELS_RESTART：本地走 start-all；remote 已运行 sync、未运行起控制器、控制器缺失回退本地", () => {
    expect(planChannelsRestart({
      remoteEnabled: false, controllerAvailable: true, controllerRunning: false,
    })).toBe("start-all");
    expect(planChannelsRestart({
      remoteEnabled: true, controllerAvailable: false, controllerRunning: false,
    })).toBe("start-all");
    expect(planChannelsRestart({
      remoteEnabled: true, controllerAvailable: true, controllerRunning: true,
    })).toBe("sync");
    expect(planChannelsRestart({
      remoteEnabled: true, controllerAvailable: true, controllerRunning: false,
    })).toBe("start-controller");
  });
});

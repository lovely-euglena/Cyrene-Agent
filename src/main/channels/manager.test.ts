import { describe, expect, it, vi } from "vitest";
import { ChannelManager } from "./manager";
import type { ChannelAdapter } from "./adapters/base";

function fakeAdapter(id: string): ChannelAdapter {
  let started = false;
  return {
    id: id as never,
    displayName: id,
    capability: {} as never,
    onMessage: null,
    start: async () => {
      started = true;
    },
    stop: async () => {
      started = false;
    },
    send: async () => ({ ok: true }),
    getStatus: () => ({ enabled: started, phase: started ? "running" : "offline" }),
  };
}

/** 可控 deferred：测试在途 start 与 stop 的交错（P2-1）。 */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("ChannelManager", () => {
  it("startOne 启动单个 adapter；unregister 先 stop 再移除", async () => {
    const mgr = new ChannelManager();
    const adapter = fakeAdapter("qq");
    mgr.register(adapter);
    await mgr.startOne("qq" as never);
    expect(mgr.getAdapter("qq" as never)).toBeDefined();
    expect(adapter.getStatus().phase).toBe("running");

    const removed = await mgr.unregister("qq" as never);
    expect(removed).toBe(true);
    expect(mgr.getAdapter("qq" as never)).toBeUndefined();
    expect(adapter.getStatus().phase).toBe("offline");
  });

  it("unregister 不存在的 id 返回 false", async () => {
    const mgr = new ChannelManager();
    expect(await mgr.unregister("nope" as never)).toBe(false);
  });

  it("startAll 跳过已启动的 adapter（避免渠道插件双启动）", async () => {
    const mgr = new ChannelManager();
    let startCount = 0;
    const adapter = fakeAdapter("qq");
    const origStart = adapter.start;
    adapter.start = async () => {
      startCount += 1;
      await origStart();
    };
    mgr.register(adapter);
    await mgr.startOne("qq" as never);
    await mgr.startAll();
    expect(startCount).toBe(1);
  });

  it("拒绝重复 id，避免覆盖已启动 adapter 后留下错误状态", async () => {
    const mgr = new ChannelManager();
    const first = fakeAdapter("feishu");
    const second = fakeAdapter("feishu");
    mgr.register(first);
    await mgr.startOne("feishu" as never);
    expect(() => mgr.register(second)).toThrow(/禁止覆盖/);
    expect(mgr.getAdapter("feishu" as never)).toBe(first);
    expect(second.getStatus().phase).toBe("offline");
  });

  it("startOne 对已启动 adapter 幂等", async () => {
    const mgr = new ChannelManager();
    const adapter = fakeAdapter("qq");
    let starts = 0;
    const original = adapter.start;
    adapter.start = async () => { starts += 1; await original(); };
    mgr.register(adapter);
    await mgr.startOne("qq" as never);
    await mgr.startOne("qq" as never);
    expect(starts).toBe(1);
  });

  it("startOne 单渠道启动失败：不抛出、不标记已启动，其它渠道不受影响（P1-4）", async () => {
    const mgr = new ChannelManager();
    const bad = fakeAdapter("qq");
    bad.start = async () => { throw new Error("start boom"); };
    const good = fakeAdapter("feishu");
    mgr.register(bad);
    mgr.register(good);

    await expect(mgr.startOne("qq" as never)).resolves.toBeUndefined();
    expect(mgr.isStarted("qq" as never)).toBe(false);
    expect(mgr.isStarted("feishu" as never)).toBe(false);

    await mgr.startOne("feishu" as never);
    expect(mgr.isStarted("feishu" as never)).toBe(true);
  });

  it("并发 startOne：同渠道串行复用，只真正 start 一次（P2-1）", async () => {
    const mgr = new ChannelManager();
    let starts = 0;
    const gate = deferred();
    const adapter = fakeAdapter("qq");
    adapter.start = async () => {
      starts += 1;
      await gate.promise;
    };
    mgr.register(adapter);

    const first = mgr.startOne("qq" as never);
    const second = mgr.startOne("qq" as never);
    gate.resolve();
    await Promise.all([first, second]);
    expect(starts).toBe(1);
    expect(mgr.isStarted("qq" as never)).toBe(true);
  });

  it("在途 startOne 与 pauseOne 交错：先收敛启动再停止，不残留已启动标记（P2-1）", async () => {
    const mgr = new ChannelManager();
    let running = false;
    const gate = deferred();
    const adapter = fakeAdapter("qq");
    adapter.start = async () => {
      running = true;
      await gate.promise;
    };
    adapter.stop = async () => {
      running = false;
    };
    mgr.register(adapter);

    const starting = mgr.startOne("qq" as never);
    const pausing = mgr.pauseOne("qq" as never);
    gate.resolve();
    await Promise.all([starting, pausing]);
    expect(running).toBe(false);
    expect(mgr.isStarted("qq" as never)).toBe(false);
  });

  it("在途 startOne 与 stopAll 交错：等启动收敛后停止，不标记已启动（P2-1）", async () => {
    const mgr = new ChannelManager();
    let running = false;
    const gate = deferred();
    const adapter = fakeAdapter("qq");
    adapter.start = async () => {
      running = true;
      await gate.promise;
    };
    adapter.stop = async () => {
      running = false;
    };
    mgr.register(adapter);

    const starting = mgr.startOne("qq" as never);
    const stopping = mgr.stopAll();
    gate.resolve();
    await Promise.all([starting, stopping]);
    expect(running).toBe(false);
    expect(mgr.isStarted("qq" as never)).toBe(false);
  });

  it("pauseOne 后 startOne：按调用顺序收敛为已启动（P2-1）", async () => {
    const mgr = new ChannelManager();
    const adapter = fakeAdapter("qq");
    mgr.register(adapter);
    await Promise.all([mgr.pauseOne("qq" as never), mgr.startOne("qq" as never)]);
    expect(mgr.isStarted("qq" as never)).toBe(true);
  });

  it("已启动 + stop 在途 + 并发 start：start 意图入队不丢失、只补启动一次（P2-4）", async () => {
    const mgr = new ChannelManager();
    let running = false;
    let starts = 0;
    const stopGate = deferred();
    const adapter = fakeAdapter("qq");
    adapter.start = async () => {
      starts += 1;
      running = true;
    };
    adapter.stop = async () => {
      running = false;
      await stopGate.promise; // 慢 disconnect：stop 在途
    };
    mgr.register(adapter);
    await mgr.startOne("qq" as never);
    expect(starts).toBe(1);

    const pausing = mgr.pauseOne("qq" as never);
    const starting = mgr.startOne("qq" as never); // 旧实现此处被外层早退静默丢弃
    stopGate.resolve();
    await Promise.all([pausing, starting]);

    expect(running).toBe(true);
    expect(mgr.isStarted("qq" as never)).toBe(true);
    expect(starts).toBe(2); // 只补启动一次（无重复 start）
  });

  it("unregister 与并发 startOne 的微任务窗口：不留「已启动但未注册」的孤儿实例（P2-6.2）", async () => {
    const mgr = new ChannelManager();
    let running = false;
    const adapter = fakeAdapter("qq");
    adapter.start = async () => {
      running = true;
    };
    adapter.stop = async () => {
      running = false;
    };
    mgr.register(adapter);

    // unregister 先入队，但其摘除发生在后续微任务；此刻 startOne 仍能看到注册表实例并排队
    const removing = mgr.unregister("qq" as never);
    const starting = mgr.startOne("qq" as never);
    await Promise.all([removing, starting]);

    expect(mgr.getAdapter("qq" as never)).toBeUndefined();
    expect(mgr.isStarted("qq" as never)).toBe(false);
    expect(running).toBe(false); // 无孤儿：若启动过必须已被回滚停止
    await mgr.stopAll(); // 此后 stopAll 也应无运行实例可停
    expect(running).toBe(false);
  });

  it("只委托入站处理，不重复发送 dispatcher 返回的消息", async () => {
    const mgr = new ChannelManager();
    const adapter = fakeAdapter("qq");
    const send = vi.spyOn(adapter, "send");
    mgr.register(adapter);
    mgr.setDispatcher(async () => ({
      channel: "qq",
      targetId: "chat-1",
      parts: [{ kind: "text", text: "已由 dispatcher 发送" }],
    }));
    await mgr.startOne("qq" as never);

    await adapter.onMessage?.({
      channel: "qq",
      chatId: "chat-1",
      senderId: "user-1",
      text: "你好",
      at: new Date(0),
    });

    expect(send).not.toHaveBeenCalled();
  });
});

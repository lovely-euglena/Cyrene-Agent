import { describe, expect, it } from "vitest";
import { clearCache, emptyCache, loadCache, saveCache, trimEvents, MAX_CACHED_EVENTS } from "./cache";
import { event } from "./test-helpers";

function validEvent(index: number) {
  return event({
    type: "message.append",
    payload: { role: "user", text: `m${index}`, turnId: `t${index}` },
    eventId: `e${index}`,
    lamport: index,
    seq: index,
  });
}

class LimitedStorage implements Storage {
  private readonly data = new Map<string, string>();
  constructor(private readonly limit: number) {}
  get length(): number {
    return this.data.size;
  }
  clear(): void {
    this.data.clear();
  }
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.data.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
  setItem(key: string, value: string): void {
    if (value.length > this.limit) {
      const error = new Error("quota exceeded");
      error.name = "QuotaExceededError";
      throw error;
    }
    this.data.set(key, value);
  }
}

describe("trimEvents", () => {
  it("超出上限保留最新", () => {
    const events = [1, 2, 3, 4].map(validEvent);
    expect(trimEvents(events, 2).map((item) => item.eventId)).toEqual(["e3", "e4"]);
    expect(trimEvents(events, 10)).toHaveLength(4);
  });
});

describe("save/load 往返", () => {
  it("身份 + 游标 + 事件完整往返", () => {
    const storage = new LimitedStorage(1024 * 1024);
    const cache = {
      token: "tok",
      deviceId: "d1",
      deviceName: "手机",
      cursor: 42,
      events: [validEvent(1), validEvent(2)],
    };
    const saved = saveCache(cache, storage);
    const loaded = loadCache(storage);
    expect(loaded).toEqual(saved);
  });

  it("损坏 JSON / 非法事件被安全处理", () => {
    const storage = new LimitedStorage(1024 * 1024);
    storage.setItem("cyrene.pwa.cache.v1", "{not json");
    expect(loadCache(storage)).toEqual(emptyCache());

    storage.setItem(
      "cyrene.pwa.cache.v1",
      JSON.stringify({ token: "t", deviceId: "d", cursor: 3, events: [{ bogus: true }, validEvent(1)] }),
    );
    const loaded = loadCache(storage);
    expect(loaded.events.map((item) => item.eventId)).toEqual(["e1"]);
  });

  it("容量超限时对半裁剪后重试", () => {
    const events = Array.from({ length: 8 }, (_, index) => validEvent(index + 1));
    const full = JSON.stringify({ token: "t", deviceId: "d", deviceName: null, cursor: 8, events });
    // 限制定在「完整负载装不下、减半后装得下」之间
    const half = JSON.stringify({ token: "t", deviceId: "d", deviceName: null, cursor: 8, events: events.slice(4) });
    const storage = new LimitedStorage(Math.floor((full.length + half.length) / 2));
    const saved = saveCache({ token: "t", deviceId: "d", deviceName: null, cursor: 8, events }, storage);
    expect(saved.events).toHaveLength(4);
    expect(loadCache(storage).events).toHaveLength(4);
  });

  it("容量不足：兜底只存身份+游标（事件清空）", () => {
    const cache = { token: "t", deviceId: "d", deviceName: null, cursor: 1, events: [validEvent(1)] };
    const minimal = JSON.stringify({ ...cache, events: [] });
    const storage = new LimitedStorage(minimal.length + 10); // 最小写装得下、带事件装不下
    const saved = saveCache(cache, storage);
    expect(saved.events).toEqual([]);
    const loaded = loadCache(storage);
    expect(loaded.token).toBe("t");
    expect(loaded.events).toEqual([]);
  });

  it("存储完全不可用：返回内存态且不抛出", () => {
    const storage = new LimitedStorage(0);
    const cache = { token: "t", deviceId: "d", deviceName: null, cursor: 1, events: [validEvent(1)] };
    const saved = saveCache(cache, storage);
    expect(saved.token).toBe("t");
    expect(saved.events).toEqual([]);
    expect(loadCache(storage)).toEqual(emptyCache());
  });
});

describe("clearCache", () => {
  it("清空后回到空缓存", () => {
    const storage = new LimitedStorage(1024 * 1024);
    saveCache({ token: "t", deviceId: "d", deviceName: null, cursor: 1, events: [validEvent(1)] }, storage);
    clearCache(storage);
    expect(loadCache(storage)).toEqual(emptyCache());
  });
});

describe("MAX_CACHED_EVENTS", () => {
  it("默认上限为正整数", () => {
    expect(Number.isSafeInteger(MAX_CACHED_EVENTS)).toBe(true);
    expect(MAX_CACHED_EVENTS).toBeGreaterThan(0);
  });
});

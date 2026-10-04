/**
 * 云端昔涟 PWA · 本地缓存（IKJK2L）。
 *
 * 手机端离线只读缓存：token/设备身份、拉取游标、事件流快照（重放物化视图的原料）。
 * - localStorage 单键 JSON；容量超限（QuotaExceededError）时对半裁剪事件后重试，最后兜底只存身份+游标；
 * - 事件上限 MAX_CACHED_EVENTS（Phase 1 简单裁剪；窗口化/IndexedDB 留 Phase 2）；
 * - 读取时逐条过 validateSyncEvent（旧版本/损坏数据不进入重放）。
 */
import { validateSyncEvent, type SyncEventV0 } from "../../main/sync/sync-protocol";

const STORAGE_KEY = "cyrene.pwa.cache.v1";

/** 本地缓存事件上限（手机 localStorage ~5MB；超出丢最旧）。 */
export const MAX_CACHED_EVENTS = 5000;

export interface PwaCache {
  token: string | null;
  deviceId: string | null;
  deviceName: string | null;
  cursor: number;
  events: SyncEventV0[];
}

export function emptyCache(): PwaCache {
  return { token: null, deviceId: null, deviceName: null, cursor: 0, events: [] };
}

/** 只保留最新 max 条（事件已按规范序存放）。 */
export function trimEvents(events: readonly SyncEventV0[], max: number = MAX_CACHED_EVENTS): SyncEventV0[] {
  return events.length > max ? events.slice(events.length - max) : events.slice();
}

export function loadCache(storage: Storage = localStorage): PwaCache {
  let raw: string | null = null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    return emptyCache();
  }
  if (!raw) return emptyCache();
  try {
    const parsed = JSON.parse(raw) as Partial<PwaCache>;
    const events: SyncEventV0[] = [];
    if (Array.isArray(parsed.events)) {
      for (const item of parsed.events) {
        if (validateSyncEvent(item) === null) events.push(item as SyncEventV0);
      }
    }
    return {
      token: typeof parsed.token === "string" ? parsed.token : null,
      deviceId: typeof parsed.deviceId === "string" ? parsed.deviceId : null,
      deviceName: typeof parsed.deviceName === "string" ? parsed.deviceName : null,
      cursor: typeof parsed.cursor === "number" && Number.isFinite(parsed.cursor) ? parsed.cursor : 0,
      events: trimEvents(events),
    };
  } catch {
    return emptyCache();
  }
}

/**
 * 保存缓存（裁剪 + 容量兜底）；返回实际落盘的内容（调用方以此更新内存状态）。
 * 容量不足时：事件对半裁剪重试 → 仍失败则只存身份+游标（事件清空）。
 */
export function saveCache(cache: PwaCache, storage: Storage = localStorage): PwaCache {
  let events = trimEvents(cache.events);
  for (;;) {
    const attempt: PwaCache = { ...cache, events };
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(attempt));
      return attempt;
    } catch {
      if (events.length === 0) {
        const minimal: PwaCache = { ...cache, events: [] };
        try {
          storage.setItem(STORAGE_KEY, JSON.stringify(minimal));
        } catch {
          // 存储完全不可用（隐私模式等）：放弃持久化，内存态继续
        }
        return minimal;
      }
      // 保留较新一半；ceil 保证长度为 1 时也能推进到 0（floor(1/2)=0 会 slice(0) 原地打转 → 死循环）
      events = events.slice(Math.ceil(events.length / 2));
    }
  }
}

export function clearCache(storage: Storage = localStorage): void {
  try {
    storage.removeItem(STORAGE_KEY);
  } catch {
    // 忽略：存储不可用时无副作用
  }
}

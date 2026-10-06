/**
 * 云端同步 · 旁路事件库（IKJK2I）。
 *
 * outbox = events-local.jsonl（本机导出）；inbox = events-remote.jsonl（fetch/clone 拉取）。
 * 读取经 readSyncBatch（去重 / 规范排序 / 末行截断容错）；append 走 fsync 持久化。
 * 本文件为接口冻结占位：签名不变，实现体由 A 簇落地。
 */

import type { SyncEventV0 } from "./sync-protocol";

export interface SyncEventStoreOptions {
  syncDir: string;
}

export class SyncEventStore {
  static async open(options: SyncEventStoreOptions): Promise<SyncEventStore> {
    void options;
    throw new Error("IKJK2I: event-store 实现见 A 簇（接口冻结占位）");
  }

  getLocalEvents(): SyncEventV0[] {
    throw new Error("IKJK2I: event-store 实现见 A 簇（接口冻结占位）");
  }

  getRemoteEvents(): SyncEventV0[] {
    throw new Error("IKJK2I: event-store 实现见 A 簇（接口冻结占位）");
  }

  getAllEvents(): SyncEventV0[] {
    throw new Error("IKJK2I: event-store 实现见 A 簇（接口冻结占位）");
  }

  getLocalEventIds(): Set<string> {
    throw new Error("IKJK2I: event-store 实现见 A 簇（接口冻结占位）");
  }

  getRemoteEventsForSession(sessionId: string): SyncEventV0[] {
    void sessionId;
    throw new Error("IKJK2I: event-store 实现见 A 簇（接口冻结占位）");
  }

  async appendLocal(events: SyncEventV0[]): Promise<void> {
    void events;
    throw new Error("IKJK2I: event-store 实现见 A 簇（接口冻结占位）");
  }

  async appendRemote(events: SyncEventV0[]): Promise<void> {
    void events;
    throw new Error("IKJK2I: event-store 实现见 A 簇（接口冻结占位）");
  }

  getLocalCount(): number {
    throw new Error("IKJK2I: event-store 实现见 A 簇（接口冻结占位）");
  }

  getRemoteCount(): number {
    throw new Error("IKJK2I: event-store 实现见 A 簇（接口冻结占位）");
  }
}

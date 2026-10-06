/**
 * 云端同步 · 旁路事件库（IKJK2I）。
 *
 * outbox = events-local.jsonl（本机导出）；inbox = events-remote.jsonl（fetch/clone 拉取）。
 * 读取经 readSyncBatch（去重 / 规范排序 / 末行截断容错）；append 串行队列 + append+fsync
 * 持久化（参照 conversation-transcript-store 的 appendDurableLine / syncFile 模式）。
 */

import fs from "node:fs";
import path from "node:path";
import { compareSyncEvents, readSyncBatch, type SyncEventV0 } from "./sync-protocol";

const LOCAL_FILE_NAME = "events-local.jsonl";
const REMOTE_FILE_NAME = "events-remote.jsonl";

export interface SyncEventStoreOptions {
  syncDir: string;
}

export class SyncEventStore {
  private readonly localFile: string;
  private readonly remoteFile: string;
  /** 内存索引：两库各自保持规范序（(lamport, deviceId, seq)）。 */
  private localEvents: SyncEventV0[];
  private remoteEvents: SyncEventV0[];
  private readonly localIds: Set<string>;
  private readonly remoteIds: Set<string>;
  /** 单队列串行化两库 append：文件写入与内存索引更新保持同一顺序。 */
  private queue: Promise<void> = Promise.resolve();

  private constructor(syncDir: string, localEvents: SyncEventV0[], remoteEvents: SyncEventV0[]) {
    this.localFile = path.join(syncDir, LOCAL_FILE_NAME);
    this.remoteFile = path.join(syncDir, REMOTE_FILE_NAME);
    this.localEvents = localEvents;
    this.remoteEvents = remoteEvents;
    this.localIds = new Set(localEvents.map((event) => event.eventId));
    this.remoteIds = new Set(remoteEvents.map((event) => event.eventId));
  }

  static async open(options: SyncEventStoreOptions): Promise<SyncEventStore> {
    await fs.promises.mkdir(options.syncDir, { recursive: true });
    const [localEvents, remoteEvents] = await Promise.all([
      loadEventFile(path.join(options.syncDir, LOCAL_FILE_NAME)),
      loadEventFile(path.join(options.syncDir, REMOTE_FILE_NAME)),
    ]);
    return new SyncEventStore(options.syncDir, localEvents, remoteEvents);
  }

  getLocalEvents(): SyncEventV0[] {
    return [...this.localEvents];
  }

  getRemoteEvents(): SyncEventV0[] {
    return [...this.remoteEvents];
  }

  getAllEvents(): SyncEventV0[] {
    return [...this.localEvents, ...this.remoteEvents].sort(compareSyncEvents);
  }

  getLocalEventIds(): Set<string> {
    return new Set(this.localIds);
  }

  getRemoteEventsForSession(sessionId: string): SyncEventV0[] {
    return this.remoteEvents.filter((event) => event.sessionId === sessionId);
  }

  appendLocal(events: SyncEventV0[]): Promise<void> {
    return this.append("local", events);
  }

  appendRemote(events: SyncEventV0[]): Promise<void> {
    return this.append("remote", events);
  }

  getLocalCount(): number {
    return this.localEvents.length;
  }

  getRemoteCount(): number {
    return this.remoteEvents.length;
  }

  private append(target: "local" | "remote", events: SyncEventV0[]): Promise<void> {
    return this.enqueue(async () => {
      // 跨两库 + 批内去重：eventId 已在 local / remote 即视为已入库（自己的事件 fetch 回来不重复）。
      const fresh = dedupeNewEvents(events, this.localIds, this.remoteIds);
      if (fresh.length === 0) return;
      const file = target === "local" ? this.localFile : this.remoteFile;
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await appendDurableLines(file, fresh);
      // append+fsync 成功后才更新内存索引：失败不留半状态。
      const merged = [...(target === "local" ? this.localEvents : this.remoteEvents), ...fresh];
      merged.sort(compareSyncEvents);
      const ids = target === "local" ? this.localIds : this.remoteIds;
      for (const event of fresh) ids.add(event.eventId);
      if (target === "local") this.localEvents = merged;
      else this.remoteEvents = merged;
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation, operation);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }
}

/** 读取事件文件：ENOENT → 空；半截尾行先修剪到最后一个完整行，避免后续 append 与其粘连。 */
async function loadEventFile(file: string): Promise<SyncEventV0[]> {
  let text: string;
  try {
    text = await fs.promises.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (text.length > 0 && !text.endsWith("\n")) {
    // 崩溃遗留的未终止尾行（半截批）：物理修剪，读侧由 readSyncBatch 语义兜底。
    const lastNewline = text.lastIndexOf("\n");
    text = lastNewline === -1 ? "" : text.slice(0, lastNewline + 1);
    await fs.promises.truncate(file, Buffer.byteLength(text, "utf8"));
  }
  return readSyncBatch(text).events;
}

function dedupeNewEvents(
  events: SyncEventV0[],
  localIds: Set<string>,
  remoteIds: Set<string>,
): SyncEventV0[] {
  const fresh: SyncEventV0[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    if (localIds.has(event.eventId) || remoteIds.has(event.eventId) || seen.has(event.eventId)) continue;
    seen.add(event.eventId);
    fresh.push(event);
  }
  return fresh;
}

async function appendDurableLines(file: string, events: SyncEventV0[]): Promise<void> {
  const text = events.map((event) => `${JSON.stringify(event)}\n`).join("");
  await fs.promises.appendFile(file, text, "utf8");
  await syncFile(file);
}

async function syncFile(file: string): Promise<void> {
  const handle = await fs.promises.open(file, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

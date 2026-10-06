/**
 * 云端同步 · 状态（IKJK2I）。
 *
 * 契约（设计稿附录 A）：{schemaVersion:1, deviceId, lamport, seq, fetchCursor, pushedCount,
 * serverDeviceId, conversations, updatedAt}；load 对缺失 / 损坏做恢复，save 原子写（tmp+rename）。
 */

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readSyncBatch, type SyncEventV0 } from "./sync-protocol";

export interface SyncConversationState {
  /** 已导出到 outbox 的最大 CTA entry seq（快路径水位）。 */
  exportedThroughSeq: number;
  /** session.create 标题修订号（0 = 尚未发出）。 */
  titleRevision: number;
  /** 上次导出的标题（用于检测变更）。 */
  lastTitle: string;
}

export interface SyncState {
  schemaVersion: 1;
  /** 协议身份（desk-*；本地生成，与服务器 deviceId 解耦）。 */
  deviceId: string;
  /** 全局 lamport 水位（已分配 / 已见的最大值）。 */
  lamport: number;
  /** 本机事件全局单调 seq 计数器。 */
  seq: number;
  /** 服务器 fetch 游标（字符串；null = 尚未初次拉取）。 */
  fetchCursor: string | null;
  /** events-local.jsonl 中已成功推送的事件数。 */
  pushedCount: number;
  /** 服务器签发设备（dev_*；配对后可得）。 */
  serverDeviceId: string | null;
  conversations: Record<string, SyncConversationState>;
  updatedAt: string;
}

const STATE_FILE_NAME = "state.json";
const LOCAL_EVENTS_FILE_NAME = "events-local.jsonl";
const REMOTE_EVENTS_FILE_NAME = "events-remote.jsonl";

/** 首次启用生成协议身份 `desk-<12hex>`（与服务器 deviceId 解耦，重配对不改变事件身份）。 */
export function createSyncState(): SyncState {
  return {
    schemaVersion: 1,
    deviceId: `desk-${randomBytes(6).toString("hex")}`,
    lamport: 0,
    seq: 0,
    fetchCursor: null,
    pushedCount: 0,
    serverDeviceId: null,
    conversations: {},
    updatedAt: new Date().toISOString(),
  };
}

/**
 * 读取状态：
 * - 缺失 → 新建（生成设备身份）并落盘，保证身份稳定；
 * - 损坏（JSON / 形状非法）→ 隔离重命名为 `state.json.corrupt-<ts>`，
 *   再按事件库恢复（deviceId 取 outbox 首个事件、lamport 取两库最大值、
 *   seq 取 outbox 最大值、会话水位清空由 eventId 去重兜底；标题修订 / 上次标题
 *   从 outbox 的 `screate:<cid>:r<n>` 推导，避免恢复后首次改名被去重吞并），并落盘。
 */
export async function loadSyncState(syncDir: string): Promise<SyncState> {
  const file = path.join(syncDir, STATE_FILE_NAME);
  let raw: string | undefined;
  try {
    raw = await fs.promises.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (raw !== undefined) {
    const parsed = parseSyncState(raw);
    if (parsed) return parsed;
    await quarantineCorruptState(file);
    const recovered = await recoverStateFromStore(syncDir);
    await saveSyncState(syncDir, recovered);
    return recovered;
  }
  const created = createSyncState();
  await saveSyncState(syncDir, created);
  return created;
}

/** 原子写：先写同目录临时文件再 rename，避免崩溃留下半写状态；updatedAt 刷新为写入时刻。 */
export async function saveSyncState(syncDir: string, state: SyncState): Promise<void> {
  state.updatedAt = new Date().toISOString();
  await fs.promises.mkdir(syncDir, { recursive: true });
  const file = path.join(syncDir, STATE_FILE_NAME);
  // 临时名带 pid + 随机后缀：pair/unpair 与在途轮次并发保存时互不覆盖。
  const tmpFile = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await fs.promises.writeFile(tmpFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await fs.promises.rename(tmpFile, file);
}

/** 形状校验：任何字段非法都视为损坏（fail-closed，走隔离恢复而不是带病使用）。 */
function parseSyncState(raw: string): SyncState | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  if (value.schemaVersion !== 1) return null;
  if (!isValidId(value.deviceId)) return null;
  if (!isNonNegativeSafeInteger(value.lamport) || !isNonNegativeSafeInteger(value.seq)) return null;
  if (!(value.fetchCursor === null || typeof value.fetchCursor === "string")) return null;
  if (!isNonNegativeSafeInteger(value.pushedCount)) return null;
  if (!(value.serverDeviceId === null || typeof value.serverDeviceId === "string")) return null;
  if (!isRecord(value.conversations)) return null;
  for (const conversation of Object.values(value.conversations)) {
    if (!isRecord(conversation)) return null;
    if (!isNonNegativeSafeInteger(conversation.exportedThroughSeq)) return null;
    if (!isNonNegativeSafeInteger(conversation.titleRevision)) return null;
    if (typeof conversation.lastTitle !== "string") return null;
  }
  if (typeof value.updatedAt !== "string") return null;
  return {
    schemaVersion: 1,
    deviceId: value.deviceId,
    lamport: value.lamport,
    seq: value.seq,
    fetchCursor: value.fetchCursor as string | null,
    pushedCount: value.pushedCount,
    serverDeviceId: value.serverDeviceId as string | null,
    conversations: value.conversations as Record<string, SyncConversationState>,
    updatedAt: value.updatedAt,
  };
}

async function quarantineCorruptState(file: string): Promise<void> {
  await fs.promises.rename(file, `${file}.corrupt-${Date.now()}`);
}

/** 损坏恢复：从 outbox / inbox 事件推导协议身份与时钟水位，会话水位清空重扫。 */
async function recoverStateFromStore(syncDir: string): Promise<SyncState> {
  const [local, remote] = await Promise.all([
    readEventFile(path.join(syncDir, LOCAL_EVENTS_FILE_NAME)),
    readEventFile(path.join(syncDir, REMOTE_EVENTS_FILE_NAME)),
  ]);
  const state = createSyncState();
  // deviceId 取 outbox 首个事件（规范序）：保证重入后事件流身份连续。
  if (local.length > 0) state.deviceId = local[0].deviceId;
  // lamport 取 local + remote 最大值、seq 取 outbox 最大值：后续导出时钟不回退。
  state.lamport = Math.max(
    state.lamport,
    local.reduce((max, event) => Math.max(max, event.lamport), 0),
    remote.reduce((max, event) => Math.max(max, event.lamport), 0),
  );
  state.seq = local.reduce((max, event) => Math.max(max, event.seq), 0);
  // 标题修订恢复：conversations 清空后，首个标题变更会被重算为 r1 并被 eventId
  // 去重静默吞并；从 outbox 的 screate:<cid>:r<n> 推导每会话最大修订与对应标题，
  // 保证恢复后的改名能发出 r(n+1)。
  for (const event of local) {
    if (event.type !== "session.create") continue;
    const match = /^screate:(.+):r(\d+)$/.exec(event.eventId);
    if (!match || match[1] !== event.sessionId) continue;
    const revision = Number(match[2]);
    const title = event.payload.title;
    if (!Number.isSafeInteger(revision) || typeof title !== "string") continue;
    const current = state.conversations[event.sessionId];
    if (current && revision < current.titleRevision) continue;
    state.conversations[event.sessionId] = {
      exportedThroughSeq: current?.exportedThroughSeq ?? 0,
      titleRevision: revision,
      lastTitle: title,
    };
  }
  return state;
}

async function readEventFile(file: string): Promise<SyncEventV0[]> {
  let text = "";
  try {
    text = await fs.promises.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return readSyncBatch(text).events;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** 协议 id 规则：非空、≤200 码元、不含控制符（与 sync-protocol 一致）。 */
function isValidId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200 &&
    !/[\u0000-\u001f\u007f]/.test(value);
}

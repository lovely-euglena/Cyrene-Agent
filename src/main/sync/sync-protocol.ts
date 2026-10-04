/**
 * 云端昔涟 · 同步协议 v0：事件读取器与校验器（TS 侧）。
 *
 * 契约权威：docs/specs/2026-10-04-sync-protocol-v0.md +
 * fixtures/sync-protocol/（双端共享测试向量；C# 对照实现
 * dotnet/cyrene-core/Sync/SyncProtocolV0.cs）。
 *
 * 纯函数零 I/O：JSONL 文本 → 规范化事件序列 + 错误清单：
 * - 行级容错：跳过空白行；末条非空行 JSON 不完整 ⇒ 修剪（truncatedTail），
 *   其余坏行记 E_SYNC_BAD_JSON；
 * - 幂等去重：首见 eventId 保留，重复进 droppedDuplicates（按出现序）；
 * - 确定性排序：(lamport, deviceId 序数, seq)；全同键保持输入序（稳定排序）。
 * 校验规则、错误码与上述语义必须与 C# 侧逐字一致，由 fixtures 锁定。
 */

export const SYNC_EVENT_TYPES = ["session.create", "message.append", "turn_rewind", "tombstone"] as const;
export type SyncEventTypeV0 = (typeof SYNC_EVENT_TYPES)[number];

export const SYNC_ERROR_CODES = ["E_SYNC_BAD_JSON", "E_SYNC_ENVELOPE", "E_SYNC_TYPE", "E_SYNC_PAYLOAD"] as const;
export type SyncErrorCode = (typeof SYNC_ERROR_CODES)[number];

/**
 * CTA presentation patch 顶层键白名单（v0 仅校验键集合与 patchRevision，
 * 值形状由 CTA TS 侧写入路径负责；C# 侧同规则）。
 */
export const SYNC_PRESENTATION_PATCH_KEYS = [
  "content", "reasoning", "reasoningBlocks", "processMessages", "agentRounds",
  "taskDelegations", "channelSource", "sticker", "toolExecutions", "runActivity",
  "runSnapshot", "ttsCacheKey", "ttsCacheVersion", "musicCard", "contextUsage", "delta",
] as const;

/** v0 事件（CTA entry 的同步投影；字段级规范见 spec）。 */
export interface SyncEventV0 {
  eventId: string;
  sessionId: string;
  type: SyncEventTypeV0;
  /** 端侧逻辑时钟。 */
  lamport: number;
  deviceId: string;
  /** 端侧单调序号。 */
  seq: number;
  /** ISO 8601 UTC 毫秒精度。 */
  ts: string;
  payload: Record<string, unknown>;
  /** 哈希链预留（Q3 定稿前不校验链式关系；出现则须 64 位小写 hex）。 */
  prevHash?: string;
  hash?: string;
}

export interface SyncReadError {
  /** 0 基物理行号（含被跳过的空白行）。 */
  index: number;
  code: SyncErrorCode;
}

export interface SyncReadResult {
  /** 校验通过的事件，已去重 + 规范排序。 */
  events: SyncEventV0[];
  /** 坏行清单（输入序）。 */
  errors: SyncReadError[];
  /** 因 eventId 重复被丢弃的事件（按出现序，可能重复出现同一 id）。 */
  droppedDuplicates: string[];
  /** 末条非空行 JSON 不完整（半截批，建议从上一游标重拉）。 */
  truncatedTail: boolean;
}

const ENVELOPE_KEYS = ["eventId", "sessionId", "type", "lamport", "deviceId", "seq", "ts", "payload", "prevHash", "hash"];
const ID_RE = /^[^\u0000-\u001f\u007f]{1,200}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const MAX_SAFE = 9007199254740991;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is string {
  return typeof value === "string" && ID_RE.test(value);
}

function isIsoUtc(value: unknown): value is string {
  return typeof value === "string" && ISO_RE.test(value);
}

function isSafeNonNegInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function optionalField(value: Record<string, unknown>, key: string, predicate: (field: unknown) => boolean): boolean {
  return !Object.prototype.hasOwnProperty.call(value, key) || predicate(value[key]);
}

/** 单事件校验：返回 null = 有效；错误码优先级 BAD_JSON > ENVELOPE > TYPE > PAYLOAD。 */
export function validateSyncEvent(value: unknown): SyncErrorCode | null {
  if (!isRecord(value)) return "E_SYNC_ENVELOPE";
  if (!hasOnlyKeys(value, ENVELOPE_KEYS)) return "E_SYNC_ENVELOPE";
  if (!isId(value.eventId) || !isId(value.sessionId) || !isId(value.deviceId)) return "E_SYNC_ENVELOPE";
  if (!isSafeNonNegInt(value.lamport) || !isSafeNonNegInt(value.seq)) return "E_SYNC_ENVELOPE";
  if (!isIsoUtc(value.ts)) return "E_SYNC_ENVELOPE";
  if (typeof value.type !== "string") return "E_SYNC_ENVELOPE";
  if (!optionalField(value, "prevHash", (field) => typeof field === "string" && HEX64_RE.test(field))) return "E_SYNC_ENVELOPE";
  if (!optionalField(value, "hash", (field) => typeof field === "string" && HEX64_RE.test(field))) return "E_SYNC_ENVELOPE";
  if (!(SYNC_EVENT_TYPES as readonly string[]).includes(value.type)) return "E_SYNC_TYPE";
  if (!isRecord(value.payload)) return "E_SYNC_PAYLOAD";
  return validatePayload(value.type as SyncEventTypeV0, value.payload) ? null : "E_SYNC_PAYLOAD";
}

function validatePayload(type: SyncEventTypeV0, payload: Record<string, unknown>): boolean {
  switch (type) {
    case "session.create":
      return hasOnlyKeys(payload, ["title", "createdAt"])
        && typeof payload.title === "string" && payload.title.length <= 200
        && isIsoUtc(payload.createdAt);
    case "message.append": {
      if (!hasOnlyKeys(payload, ["role", "text", "turnId", "presentation"])) return false;
      if (payload.role !== "user" && payload.role !== "assistant") return false;
      if (typeof payload.text !== "string") return false;
      if (payload.role === "user") {
        if (!isId(payload.turnId)) return false;
      } else if (!optionalField(payload, "turnId", isId)) {
        return false;
      }
      return optionalField(payload, "presentation", isPresentationPatch);
    }
    case "turn_rewind": {
      if (!hasOnlyKeys(payload, ["anchorUserTurnId", "disposition", "reason", "replacementUser", "revision"])) return false;
      if (!isId(payload.anchorUserTurnId)) return false;
      if (payload.disposition !== "keep_user" && payload.disposition !== "replace_user") return false;
      if (payload.reason !== "edit" && payload.reason !== "regenerate") return false;
      if (payload.disposition === "replace_user") {
        return isReplacementUser(payload.replacementUser)
          && typeof payload.revision === "number" && Number.isSafeInteger(payload.revision) && payload.revision >= 1;
      }
      return !Object.prototype.hasOwnProperty.call(payload, "replacementUser")
        && !Object.prototype.hasOwnProperty.call(payload, "revision");
    }
    case "tombstone":
      return hasOnlyKeys(payload, ["targetUserTurnId", "reason"])
        && isId(payload.targetUserTurnId)
        && payload.reason === "pending_withdrawn";
  }
}

function isReplacementUser(value: unknown): boolean {
  return isRecord(value) && hasOnlyKeys(value, ["text"]) && typeof value.text === "string";
}

function isPresentationPatch(value: unknown): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, ["patchRevision", "patch"])) return false;
  if (typeof value.patchRevision !== "number" || !Number.isSafeInteger(value.patchRevision) || value.patchRevision < 1) return false;
  if (!isRecord(value.patch)) return false;
  const keys = Object.keys(value.patch);
  if (keys.length === 0) return false;
  return keys.every((key) => (SYNC_PRESENTATION_PATCH_KEYS as readonly string[]).includes(key));
}

/** JSONL 批读取：容错 → 校验 → 去重 → 规范排序。 */
export function readSyncBatch(text: string): SyncReadResult {
  const result: SyncReadResult = { events: [], errors: [], droppedDuplicates: [], truncatedTail: false };
  const normalized = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = normalized.split("\n");
  let lastNonEmpty = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().length > 0) lastNonEmpty = i;
  }
  const seen = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      if (i === lastNonEmpty) result.truncatedTail = true;
      else result.errors.push({ index: i, code: "E_SYNC_BAD_JSON" });
      continue;
    }
    const code = validateSyncEvent(value);
    if (code !== null) {
      result.errors.push({ index: i, code });
      continue;
    }
    const event = toEvent(value as Record<string, unknown>);
    if (seen.has(event.eventId)) {
      result.droppedDuplicates.push(event.eventId);
      continue;
    }
    seen.add(event.eventId);
    result.events.push(event);
  }
  result.events.sort((a, b) =>
    a.lamport - b.lamport
    || ordinalCompare(a.deviceId, b.deviceId)
    || a.seq - b.seq);
  return result;
}

/** UTF-16 码元序（与 C# StringComparer.Ordinal 对齐；JS `<` 即码元序）。 */
function ordinalCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function toEvent(value: Record<string, unknown>): SyncEventV0 {
  const event: SyncEventV0 = {
    eventId: value.eventId as string,
    sessionId: value.sessionId as string,
    type: value.type as SyncEventTypeV0,
    lamport: value.lamport as number,
    deviceId: value.deviceId as string,
    seq: value.seq as number,
    ts: value.ts as string,
    payload: value.payload as Record<string, unknown>,
  };
  if (typeof value.prevHash === "string") event.prevHash = value.prevHash;
  if (typeof value.hash === "string") event.hash = value.hash;
  return event;
}

/** 供自检与调试点：常量边界与规范一致性的最小断言（fixtures 为主契约）。 */
export const SYNC_V0_LIMITS = { maxIdLength: 200, maxSafeInteger: MAX_SAFE } as const;

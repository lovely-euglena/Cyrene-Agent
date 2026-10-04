/** PWA 单测事件构造助手（非测试文件；仅供 *.test.ts 使用）。 */
import type { SyncEventV0 } from "../../main/sync/sync-protocol";

let counter = 0;

export function resetIds(): void {
  counter = 0;
}

export interface EventDraft {
  type: SyncEventV0["type"];
  payload: Record<string, unknown>;
  eventId?: string;
  sessionId?: string;
  lamport?: number;
  deviceId?: string;
  seq?: number;
  ts?: string;
}

export function event(draft: EventDraft): SyncEventV0 {
  counter++;
  return {
    eventId: draft.eventId ?? `e${counter}`,
    sessionId: draft.sessionId ?? "s1",
    type: draft.type,
    lamport: draft.lamport ?? counter,
    deviceId: draft.deviceId ?? "dev-a",
    seq: draft.seq ?? counter,
    ts: draft.ts ?? `2026-10-04T00:00:${String(counter % 60).padStart(2, "0")}.000Z`,
    payload: draft.payload,
  };
}

export function userMessage(text: string, turnId: string, overrides: Partial<EventDraft> = {}): SyncEventV0 {
  return event({ type: "message.append", payload: { role: "user", text, turnId }, ...overrides });
}

export function assistantMessage(text: string, turnId?: string, overrides: Partial<EventDraft> = {}): SyncEventV0 {
  const payload: Record<string, unknown> = { role: "assistant", text };
  if (turnId !== undefined) payload.turnId = turnId;
  return event({ type: "message.append", payload, ...overrides });
}

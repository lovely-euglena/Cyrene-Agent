/**
 * 云端昔涟 PWA · 端侧事件构造（IKJK2L）。
 *
 * 手机发出的消息按协议 v0 构造 message.append(role=user)：
 * - lamport = 已知事件全局最大 + 1；seq = 本设备已用最大 + 1（与服务端生成同一水位口径）；
 * - turnId 必填（rewind 锚点）；eventId 幂等（重试不会产生重复消息）；
 * - 构造后立刻过 validateSyncEvent（fail-fast，避免把坏事件推给服务端）。
 */
import { validateSyncEvent, type SyncEventV0 } from "../../main/sync/sync-protocol";

export interface ClockState {
  /** 已知事件的最大 lamport（全设备）。 */
  maxLamport: number;
  /** 本设备已用的最大 seq。 */
  maxSeq: number;
}

/** 从已知事件计算端侧时钟水位。 */
export function computeClock(events: readonly SyncEventV0[], deviceId: string): ClockState {
  let maxLamport = 0;
  let maxSeq = 0;
  for (const event of events) {
    if (event.lamport > maxLamport) maxLamport = event.lamport;
    if (event.deviceId === deviceId && event.seq > maxSeq) maxSeq = event.seq;
  }
  return { maxLamport, maxSeq };
}

export interface UserMessageDraft {
  sessionId: string;
  text: string;
  deviceId: string;
  clock: ClockState;
  now?: Date;
  /** 测试注入用；默认 crypto.randomUUID。 */
  idFactory?: () => string;
}

/** 构造一条 message.append(role=user) 事件（协议 v0 校验通过才返回）。 */
export function createUserMessageEvent(draft: UserMessageDraft): SyncEventV0 {
  const id = draft.idFactory ?? (() => globalThis.crypto.randomUUID());
  const event: SyncEventV0 = {
    eventId: `pwa-${id()}`,
    sessionId: draft.sessionId,
    type: "message.append",
    lamport: draft.clock.maxLamport + 1,
    deviceId: draft.deviceId,
    seq: draft.clock.maxSeq + 1,
    ts: (draft.now ?? new Date()).toISOString(),
    payload: { role: "user", text: draft.text, turnId: `turn-${id()}` },
  };
  const code = validateSyncEvent(event);
  if (code !== null) {
    throw new Error(`事件未通过协议 v0 校验：${code}`);
  }
  return event;
}

/**
 * 云端昔涟 PWA · 事件规范排序与幂等合并（IKJK2L）。
 *
 * 与协议 v0 读取语义（docs/specs/2026-10-04-sync-protocol-v0.md §3）一致：
 * 排序键 (lamport, deviceId 序数比较, seq)；eventId 幂等（首见生效）。
 * 手机端拉到的增量事件按此合并进本地缓存后再重放，保证与桌面/服务端同一收敛序。
 */
import type { SyncEventV0 } from "../../main/sync/sync-protocol";

/** UTF-16 码元序（与 C# StringComparer.Ordinal 对齐；JS `<` 即码元序）。 */
export function ordinalCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 协议 v0 规范排序：(lamport, deviceId 序数, seq)；全同键保持输入序（Array#sort 稳定）。原地排序并返回。 */
export function canonicalSort(events: SyncEventV0[]): SyncEventV0[] {
  return events.sort(
    (a, b) => a.lamport - b.lamport || ordinalCompare(a.deviceId, b.deviceId) || a.seq - b.seq,
  );
}

/** 幂等合并（eventId 首见保留）+ 规范排序；不修改入参，返回新数组。 */
export function mergeEvents(existing: readonly SyncEventV0[], incoming: readonly SyncEventV0[]): SyncEventV0[] {
  const seen = new Set(existing.map((event) => event.eventId));
  const merged = existing.slice();
  for (const event of incoming) {
    if (seen.has(event.eventId)) continue;
    seen.add(event.eventId);
    merged.push(event);
  }
  return canonicalSort(merged);
}

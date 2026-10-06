/**
 * 记忆与心情事件物化器（IKJK2O；纯函数零 I/O）。
 *
 * 输入假定 = `readSyncBatch` 的输出事件序列：已通过载荷校验、已去重、
 * 已按规范序 (lamport, deviceId 序数, seq) 排序（设计稿
 * docs/design/2026-10-06-memory-mood-events.md §2 / D5；C# 侧镜像
 * dotnet/cyrene-core/Sync/MemoryMoodMaterializer.cs）。
 *
 * 折叠规则（设计稿 §2）：
 * - memory.write op=upsert：`memories[memoryId]` 后写覆盖（按输入序）；
 * - memory.write op=delete：sticky 墓碑——移除条目并记住删除，其后同 id
 *   upsert 忽略（不复活；PMRS 重新添加会生成新 id）；
 * - mood.shift：后写覆盖；
 * - 其它类型：no-op。
 *
 * 确定性：状态 = f(去重 + 规范排序后的集合)，与到达顺序无关；重复物化幂等。
 */
import type { SyncEventV0 } from "./sync-protocol";

export interface MaterializedMemory {
  content: string;
  weight: number;
  pinned: boolean;
}

export interface MaterializedMemoryMood {
  /** 被删除 / 未出现的条目不出现在结果中。 */
  memories: Record<string, MaterializedMemory>;
  /** 无 mood.shift 事件时为 null。 */
  mood: { feeling: string } | null;
}

export function materializeMemoryMood(events: SyncEventV0[]): MaterializedMemoryMood {
  const memories: Record<string, MaterializedMemory> = {};
  /** sticky 墓碑：memoryId 一经删除，后续 upsert 一律忽略。 */
  const tombstones = new Set<string>();
  let mood: { feeling: string } | null = null;

  for (const event of events) {
    switch (event.type) {
      case "memory.write": {
        // 载荷已由 readSyncBatch 校验，此处按契约形状直接读取。
        const payload = event.payload as {
          memoryId?: unknown;
          op?: unknown;
          content?: unknown;
          weight?: unknown;
          pinned?: unknown;
        };
        const memoryId = payload.memoryId as string;
        if (payload.op === "delete") {
          tombstones.add(memoryId);
          delete memories[memoryId];
        } else if (payload.op === "upsert" && !tombstones.has(memoryId)) {
          memories[memoryId] = {
            content: payload.content as string,
            weight: payload.weight as number,
            pinned: payload.pinned === true,
          };
        }
        break;
      }
      case "mood.shift":
        mood = { feeling: (event.payload as { feeling?: unknown }).feeling as string };
        break;
      default:
        break;
    }
  }
  return { memories, mood };
}

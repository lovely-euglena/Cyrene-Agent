import * as fs from "node:fs"
import * as path from "node:path"
import { memoryHostClient, type MemoryHostRow } from "../dotnet-backend/host-clients"
import type {
  ConflictLog,
  L0Profile,
  L1Profile,
  L2DmaeState,
  L2Memory,
  MemoryEvidence,
  MemoryStore,
  ReflectionLog,
} from "./memory-types"
import { resolveMemoryPath } from "./memory-store-io"

interface MemoryHostQueryResult {
  level: string
  count: number
  rows: MemoryHostRow[]
}

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || !raw.trim()) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

/**
 * 记忆系统 .NET 双轨后端（`CYRENE_MEMORY_HOST=1`）。
 *
 * - 进程内单例：首次使用时 spawn `--memory-host` 并 open(`memory.sqlite`, 首次导入 `memory.json`)。
 * - 任一步失败（开关关 / exe 缺失 / 超时 / 崩溃）→ 本进程内禁用，调用方自动回退 TS（memory.json）。
 * - 行模型：id/key + content JSON + 时间戳；各表映射见 `dotnet/native-windows/MemoryStore/MemoryHost.cs`。
 *   l0_working←L0(+store_meta) / l1_longterm←L1 / l2_dmae←L2 / dmae_state←L2DmaeState /
 *   evidence←evidence / conflicts←conflictLogs / reflections←reflectionLogs。
 */
class MemoryHostBackend {
  private opened = false
  private failed = false
  private opening: Promise<boolean> | null = null

  /** 开关开启且本进程尚未判定失败。 */
  isEnabled(): boolean {
    return !this.failed && memoryHostClient.enabled()
  }

  /** 是否已真正切到 .NET（诊断/测试用）。 */
  isActive(): boolean {
    return this.opened && !this.failed
  }

  private dbPath(): string | null {
    const memoryFile = resolveMemoryPath()
    if (!memoryFile) return null
    return path.join(path.dirname(memoryFile), "memory.sqlite")
  }

  async ensureOpen(): Promise<boolean> {
    if (this.opened) return true
    if (this.failed) return false
    if (this.opening) return this.opening
    this.opening = (async () => {
      try {
        const dbPath = this.dbPath()
        if (!dbPath) {
          this.failed = true
          return false
        }
        if (!(await memoryHostClient.ensureStarted())) {
          this.failed = true
          return false
        }
        const memoryFile = resolveMemoryPath()
        // 仅在 SQLite 首次创建时导入旧 memory.json，避免每次启动用旧快照覆盖 host 真值。
        const importPath = fs.existsSync(dbPath) ? undefined : memoryFile ?? undefined
        await memoryHostClient.open(dbPath, importPath)
        this.opened = true
        return true
      } catch (err) {
        this.disable(err)
        return false
      } finally {
        this.opening = null
      }
    })()
    return this.opening
  }

  disable(err?: unknown): void {
    this.failed = true
    this.opened = false
    if (err) {
      console.warn(
        "[MemoryHost] .NET 记忆后端不可用，回退 memory.json：",
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  private async getRow(level: string, id: string): Promise<MemoryHostRow | null> {
    return (await memoryHostClient.get(level, id)) as MemoryHostRow | null
  }

  private async queryRows<T>(level: string): Promise<T[]> {
    const res = (await memoryHostClient.query(level, 100_000)) as MemoryHostQueryResult | undefined
    const rows = res?.rows ?? []
    const out: T[] = []
    for (const row of rows) {
      const parsed = parseJson<T | null>(row.content, null)
      if (parsed !== null) out.push(parsed)
    }
    return out
  }

  /** 读取整库（含 meta）；host 不可用返回 null（由调用方回退 TS）。 */
  async loadStore(): Promise<Partial<MemoryStore> | null> {
    if (!(await this.ensureOpen())) return null
    try {
      const meta = parseJson<{ schemaVersion?: number; version?: number }>(
        (await this.getRow("l0_working", "store_meta"))?.content,
        {},
      )
      const l0Row = await this.getRow("l0_working", "l0")
      const l1Row = await this.getRow("l1_longterm", "l1")
      const [l2, l2DmaeStates, evidence, conflictLogs, reflectionLogs] = await Promise.all([
        this.queryRows<L2Memory>("l2_dmae"),
        this.queryRows<L2DmaeState>("dmae_state"),
        this.queryRows<MemoryEvidence>("evidence"),
        this.queryRows<ConflictLog>("conflicts"),
        this.queryRows<ReflectionLog>("reflections"),
      ])
      return {
        schemaVersion: meta.schemaVersion,
        version: meta.version,
        l0: parseJson<L0Profile | undefined>(l0Row?.content, undefined),
        l1: parseJson<L1Profile | undefined>(l1Row?.content, undefined),
        l2,
        l2DmaeStates,
        evidence,
        conflictLogs,
        reflectionLogs,
      } as Partial<MemoryStore>
    } catch (err) {
      this.disable(err)
      return null
    }
  }

  /** 整库写回（各表 replace：clear + 批量）。host 不可用/失败返回 false。 */
  async saveStore(store: MemoryStore): Promise<boolean> {
    if (!(await this.ensureOpen())) return false
    try {
      const now = Date.now()
      await memoryHostClient.replace("l0_working", [
        { id: "l0", content: store.l0, updatedAt: store.l0?.updatedAt ?? now },
        {
          id: "store_meta",
          content: { schemaVersion: store.schemaVersion, version: store.version },
          updatedAt: now,
        },
      ])
      await memoryHostClient.replace("l1_longterm", [
        {
          id: "l1",
          content: store.l1,
          createdAt: store.l1?.generatedAt ?? now,
          updatedAt: store.l1?.generatedAt ?? now,
        },
      ])
      await memoryHostClient.replace(
        "l2_dmae",
        store.l2.map((m) => ({
          id: m.id,
          content: m,
          salience: typeof m.weight === "number" ? m.weight : 1,
          createdAt: m.createdAt,
          updatedAt: m.lastAccessedAt,
        })),
      )
      await memoryHostClient.replace(
        "dmae_state",
        (store.l2DmaeStates ?? []).map((s) => ({ id: s.l2Id, content: s, updatedAt: now })),
      )
      await memoryHostClient.replace(
        "evidence",
        (store.evidence ?? []).map((e) => ({ id: e.id, content: e, createdAt: e.createdAt })),
      )
      await memoryHostClient.replace(
        "conflicts",
        (store.conflictLogs ?? []).map((c) => ({ id: c.id, content: c, createdAt: c.createdAt })),
      )
      await memoryHostClient.replace(
        "reflections",
        (store.reflectionLogs ?? []).map((r) => ({ id: r.id, content: r, createdAt: r.createdAt })),
      )
      return true
    } catch (err) {
      this.disable(err)
      return false
    }
  }

  async shutdown(): Promise<void> {
    if (!this.opened) return
    try {
      await memoryHostClient.shutdown()
    } catch {
      /* ignore */
    }
    this.opened = false
  }

  /** 测试用：重置进程内状态（不 kill 进程，交给客户端自身）。 */
  resetForTests(): void {
    this.opened = false
    this.failed = false
    this.opening = null
  }
}

export const memoryHostBackend = new MemoryHostBackend()

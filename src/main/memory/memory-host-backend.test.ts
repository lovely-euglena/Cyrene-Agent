import { beforeEach, describe, expect, it, vi } from "vitest"

const host = vi.hoisted(() => ({
  enabled: vi.fn(() => true),
  ensureStarted: vi.fn(async () => true),
  open: vi.fn(async () => ({ opened: true })),
  get: vi.fn(async (_level: string, _id?: string) => null as unknown),
  query: vi.fn(async (level: string) => ({ level, count: 0, rows: [] as unknown[] })),
  replace: vi.fn(async (_level: string, _rows: unknown[]) => ({ count: 0 })),
  shutdown: vi.fn(async () => {}),
}))

vi.mock("../dotnet-backend/host-clients", () => ({ memoryHostClient: host }))
vi.mock("./memory-store-io", () => ({
  resolveMemoryPath: () => "/tmp/cyrene-host-test/memory.json",
}))

import { memoryHostBackend } from "./memory-host-backend"
import type { MemoryStore } from "./memory-types"

describe("memoryHostBackend", () => {
  beforeEach(() => {
    memoryHostBackend.resetForTests()
    host.enabled.mockReset().mockReturnValue(true)
    host.ensureStarted.mockReset().mockResolvedValue(true)
    host.open.mockReset().mockResolvedValue({ opened: true })
    host.get.mockReset().mockResolvedValue(null)
    host.query.mockReset().mockImplementation(async (level: string) => ({ level, count: 0, rows: [] }))
    host.replace.mockReset().mockResolvedValue({ count: 0 })
    host.shutdown.mockReset().mockResolvedValue(undefined)
  })

  it("开关关闭时不启用", () => {
    host.enabled.mockReturnValue(false)
    expect(memoryHostBackend.isEnabled()).toBe(false)
    expect(memoryHostBackend.isActive()).toBe(false)
  })

  it("首次 open 导入 memory.json；loadStore 还原各层", async () => {
    host.get.mockImplementation(async (level: string, id?: string) => {
      if (level === "l0_working" && id === "store_meta") {
        return { id, content: JSON.stringify({ schemaVersion: 1, version: 1 }) }
      }
      if (level === "l0_working" && id === "l0") {
        return { id, content: JSON.stringify({ preferredName: "P宝" }) }
      }
      if (level === "l1_longterm" && id === "l1") {
        return { id, content: JSON.stringify({ recentGoals: "跑马" }) }
      }
      return null
    })
    host.query.mockImplementation(async (level: string) => (
      level === "l2_dmae"
        ? { level, count: 1, rows: [{ id: "l2_a", content: JSON.stringify({ id: "l2_a", content: "喜欢跑步" }) }] }
        : { level, count: 0, rows: [] }
    ))

    const loaded = await memoryHostBackend.loadStore()
    expect(host.ensureStarted).toHaveBeenCalledTimes(1)
    expect(host.open).toHaveBeenCalledWith(
      expect.stringContaining("memory.sqlite"),
      "/tmp/cyrene-host-test/memory.json",
    )
    expect(loaded?.l0?.preferredName).toBe("P宝")
    expect(loaded?.l1?.recentGoals).toBe("跑马")
    expect(loaded?.l2?.[0].id).toBe("l2_a")
    expect(loaded?.schemaVersion).toBe(1)
    expect(memoryHostBackend.isActive()).toBe(true)
  })

  it("saveStore 对七张表做 replace（按行模型）", async () => {
    const store = {
      schemaVersion: 4,
      version: 1,
      l0: { preferredName: "P" },
      l1: { recentGoals: "g" },
      l2: [{ id: "l2_a", content: "c", weight: 1, createdAt: 1, lastAccessedAt: 2 }],
      l2DmaeStates: [{ l2Id: "l2_a", activation: 1 }],
      evidence: [{ id: "e1", createdAt: 1 }],
      conflictLogs: [{ id: "c1", createdAt: 1 }],
      reflectionLogs: [{ id: "r1", createdAt: 1 }],
    } as unknown as MemoryStore

    const ok = await memoryHostBackend.saveStore(store)
    expect(ok).toBe(true)
    expect(host.replace.mock.calls.map((call) => call[0])).toEqual([
      "l0_working",
      "l1_longterm",
      "l2_dmae",
      "dmae_state",
      "evidence",
      "conflicts",
      "reflections",
    ])
    const l2Call = host.replace.mock.calls.find((call) => call[0] === "l2_dmae")
    expect(l2Call?.[1]).toEqual([
      expect.objectContaining({ id: "l2_a", content: expect.objectContaining({ id: "l2_a" }) }),
    ])
  })

  it("host 启动失败 → loadStore 返回 null 并禁用（回退 TS）", async () => {
    host.ensureStarted.mockResolvedValue(false)
    expect(await memoryHostBackend.loadStore()).toBeNull()
    expect(memoryHostBackend.isEnabled()).toBe(false)
    expect(memoryHostBackend.isActive()).toBe(false)
  })
})

import fs from "node:fs"
import path from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { L2DmaeState, L2Memory } from "./memory-types"

// 真实样例：一个完整用户画像 + 8 条 L2（见 scripts/diagnostics/fixtures/memory-real-sample.json）
interface MemorySample {
  l2: L2Memory[]
  l2DmaeStates: L2DmaeState[]
}
const sample: MemorySample = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "scripts/diagnostics/fixtures/memory-real-sample.json"), "utf8"),
)

const store = vi.hoisted(() => ({ states: new Map<string, L2DmaeState>() }))

vi.mock("./memory-store", () => ({
  memoryStore: {
    getAllL2DmaeStates: vi.fn(async () => Array.from(store.states.values())),
    getL2DmaeState: vi.fn(async (l2Id: string) => store.states.get(l2Id)),
    initL2DmaeStateIfMissing: vi.fn(async (l2Id: string) => {
      const existing = store.states.get(l2Id)
      if (existing) return existing
      const fresh: L2DmaeState = {
        l2Id, activation: 0, intrinsicValue: 0, userSilence: 0, modelSilence: 0, recentUserHits: [], state: "archived",
      }
      store.states.set(l2Id, fresh)
      return fresh
    }),
    updateL2DmaeState: vi.fn(async (l2Id: string, patch: Partial<L2DmaeState>) => {
      const current = store.states.get(l2Id) ?? {
        l2Id, activation: 0, intrinsicValue: 0, userSilence: 0, modelSilence: 0, recentUserHits: [], state: "archived",
      }
      const merged = { ...current, ...patch, l2Id }
      store.states.set(l2Id, merged)
      return merged
    }),
  },
}))

import { L2DmaeManager } from "./l2-dmae-manager"

/** 模拟向量召回：按关键词重叠度取 top-K（真实链路里由 retriever 提供）。 */
function recallTopK(userText: string, l2: L2Memory[], k = 4): string[] {
  return l2
    .map((m) => ({ id: m.id, score: (m.keywords ?? []).filter((kw) => userText.includes(kw)).length }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((s) => s.id)
}

function activationOf(id: string): number {
  return store.states.get(id)?.activation ?? 0
}

describe("L2 工作记忆 · 拟真画像端到端", () => {
  beforeEach(() => {
    store.states.clear()
    // 从样例的 l2DmaeStates 播种初始生命周期（模拟已在运行的记忆库）
    for (const s of sample.l2DmaeStates) store.states.set(s.l2Id, { ...s })
  })

  async function runTurn(mgr: L2DmaeManager, userText: string, modelText: string, turn: number): Promise<string[]> {
    const recalled = recallTopK(userText, sample.l2, 4)
    await mgr.updateActivation(sample.l2, userText, modelText, recalled, turn)
    const injected = await mgr.getActiveL2ForPrompt(sample.l2, 4)
    return injected.map((m) => m.id)
  }

  it("聊到半马训练 → 跑步记忆进入工作记忆注入", async () => {
    const mgr = new L2DmaeManager()
    const injected = await runTurn(mgr, "这周跑了三次，周末拉了个长距离，半马应该稳了", "训练量很扎实。", 1)
    expect(injected).toContain("l2_run_halfmarathon")
  })

  it("聊到手冲咖啡 → 咖啡偏好进入注入；长置顶记忆始终在列", async () => {
    const mgr = new L2DmaeManager()
    const injected = await runTurn(mgr, "早上先手冲一杯浅烘再去上班", "浅烘的果酸最清醒。", 2)
    expect(injected).toContain("l2_coffee")
    expect(injected).toContain("l2_cat_doudou") // isPinned 常驻
  })

  it("话题偏离后未命中条目持续衰减；重新聊到已归档科幻话题会被唤醒重新注入", async () => {
    const mgr = new L2DmaeManager()
    await runTurn(mgr, "这周跑了三次，半马训练还行", "保持节奏。", 1)
    const runAfterRecall = activationOf("l2_run_halfmarathon")
    const scifiBefore = activationOf("l2_scifi")
    expect(scifiBefore).toBe(0) // 样例里科幻已是 archived

    // 连续 4 轮无关话题 → 衰减
    for (let i = 0; i < 4; i++) {
      await runTurn(mgr, ["今天工作好忙", "午饭吃什么", "嗯", "哦"][i], "了解。", 2 + i)
    }
    expect(activationOf("l2_run_halfmarathon")).toBeLessThan(runAfterRecall)

    // 重新聊到科幻（命中 l2_scifi 关键词）→ 归档唤醒并进入注入
    const injected = await runTurn(mgr, "最近在补《沙丘》，三体之后好久没这么入迷了", "沙丘的世界观很宏大。", 10)
    expect(activationOf("l2_scifi")).toBeGreaterThan(0)
    expect(injected).toContain("l2_scifi")
  })
})

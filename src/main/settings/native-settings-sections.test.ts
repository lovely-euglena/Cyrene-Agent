// native section 快照构建器测试：投影口径（API 配置/档案、记忆 L0/L1/L2、定时任务）。

import { describe, expect, it } from "vitest";
import {
  buildApiSectionSnapshot,
  buildCyreneSectionSnapshot,
  buildMemorySectionSnapshot,
  buildSchedulerSectionSnapshot,
  type NativeMemoryData,
} from "./native-settings-sections";
import type { ModelSettings } from "./model-settings";
import type { SavedModelProfile } from "./model-catalog";

function modelSettings(overrides: Partial<ModelSettings> = {}): ModelSettings {
  return {
    mode: "manual",
    provider: "MiniMax（稀宇科技）",
    displayName: "主力",
    baseUrl: "https://api.minimaxi.com/anthropic",
    model: "MiniMax-M3",
    apiKey: "sk-x",
    explicitTransport: "anthropic",
    perProvider: {},
    modelProfiles: [],
    defaultModelProfileId: "p1",
    runtimeSync: "off",
    stickerEnabled: true,
    stickerSize: "standard",
    stickerSimilarityThreshold: 0.55,
    chatRequestTimeoutSec: 300,
    citaRepairBudgetSec: 8,
    rerankerMode: "standard",
    embeddingModel: "bgem3",
    multimodal: true,
    contextWindowTokens: 256000,
    ...overrides,
  } as ModelSettings;
}

function profile(overrides: Partial<SavedModelProfile> = {}): SavedModelProfile {
  return {
    id: "p1",
    provider: "DeepSeek（深度求索）",
    displayName: "备选",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-flash",
    apiKey: "sk-y",
    explicitTransport: "openai",
    ...overrides,
  } as SavedModelProfile;
}

describe("buildApiSectionSnapshot", () => {
  it("配置投影：协议归一、思考/多模态/视觉/自定义端点标记", () => {
    const snapshot = buildApiSectionSnapshot(
      modelSettings({
        explicitTransport: "auto" as never,
        thinkingOverride: -1,
        multimodal: false,
        vision: { baseUrl: "https://v", apiKey: "k", model: "vl" },
        provider: "自定义云端（OpenAI 兼容）",
      }),
      [],
    );
    expect(snapshot.config.transport).toBe("openai"); // auto → openai
    expect(snapshot.config.thinkingOverride).toBe(-1);
    expect(snapshot.config.multimodal).toBe(false);
    expect(snapshot.config.vision).toEqual({ baseUrl: "https://v", apiKey: "k", model: "vl" });
    expect(snapshot.config.customEndpoint).toBe(true); // 不在预设清单
  });

  it("档案投影：isDefault 命中 defaultModelProfileId，transport 归一", () => {
    const snapshot = buildApiSectionSnapshot(
      modelSettings({ explicitTransport: "anthropic", defaultModelProfileId: "p2" }),
      [profile({ id: "p1" }), profile({ id: "p2", explicitTransport: "responses" as never })],
    );
    expect(snapshot.profiles.map((p) => [p.id, p.isDefault])).toEqual([["p1", false], ["p2", true]]);
    expect(snapshot.profiles[1].transport).toBe("responses");
    expect(snapshot.defaultProfileId).toBe("p2");
  });

  it("预设全量输出（含隐藏项标记），隐藏项由前端决定是否展示", () => {
    const snapshot = buildApiSectionSnapshot(modelSettings(), []);
    expect(snapshot.presets.length).toBeGreaterThan(8);
    const local = snapshot.presets.find((p) => p.customEndpointMode === "local");
    expect(local?.hiddenInPresetList).toBe(true);
    expect(snapshot.presets.every((p) => Array.isArray(p.mainModels))).toBe(true);
  });
});

describe("buildMemorySectionSnapshot", () => {
  const data: NativeMemoryData = {
    l0: { preferredName: "昔涟", occupation: "助手", bogusNumber: 42 },
    l1: { recentGoals: "目标" },
    l2: [
      { content: "c1", triggerText: "t1", status: "active", weight: 2.5, createdAt: 100 },
      { content: "c2", status: "archived" },
      "bad-entry",
    ],
    importedDocs: [{ importId: "i1", fileName: "doc.md", chunkCount: 3, lastImportedAt: 123 }],
    reflections: [{ id: "r1", title: "片段压缩", body: "b", meta: "m" }],
  };

  it("L0/L1 只输出字符串字段；L2 投影并跳过非法项", () => {
    const snapshot = buildMemorySectionSnapshot(data, { vaultPath: "", autoSync: false, lastSyncAt: 0 });
    expect(snapshot.l0).toEqual({ preferredName: "昔涟", occupation: "助手" });
    expect(snapshot.l1).toEqual({ recentGoals: "目标" });
    expect(snapshot.l2).toHaveLength(2);
    expect(snapshot.l2[1]).toEqual({ content: "c2", triggerText: "", status: "archived", weight: 0, createdAt: 0 });
    expect(snapshot.l2Total).toBe(3);
  });

  it("文档/回顾/vault 原样透传", () => {
    const snapshot = buildMemorySectionSnapshot(data, { vaultPath: "D:/vault", autoSync: true, lastSyncAt: 9 });
    expect(snapshot.importedDocs[0].fileName).toBe("doc.md");
    expect(snapshot.reflections[0].title).toBe("片段压缩");
    expect(snapshot.vault).toEqual({ vaultPath: "D:/vault", autoSync: true, lastSyncAt: 9 });
  });
});

describe("buildSchedulerSectionSnapshot", () => {
  it("任务/工具/插件状态/历史原样组装", () => {
    const snapshot = buildSchedulerSectionSnapshot(
      [{ id: "t1" } as never],
      [{ id: "tool", name: "工具", description: "", enabled: true, risk: "safe" }],
      { "plugin-a": true },
      { taskId: "t1", rows: [{ status: "success" }] },
    );
    expect(snapshot.tasks).toHaveLength(1);
    expect(snapshot.tools[0].id).toBe("tool");
    expect(snapshot.pluginRunning["plugin-a"]).toBe(true);
    expect(snapshot.history?.taskId).toBe("t1");
  });
});

describe("buildCyreneSectionSnapshot", () => {
  it("状态栏 / 表情包投影：阈值 clamp 到 0.3~0.9，非法档位回落默认", () => {
    const snapshot = buildCyreneSectionSnapshot(modelSettings({
      runtimeSync: "llm",
      stickerEnabled: false,
      stickerSize: "large",
      stickerSimilarityThreshold: 0.2,
    }));
    expect(snapshot).toMatchObject({
      runtimeSync: "llm",
      stickerEnabled: false,
      stickerSize: "large",
      stickerSimilarityThreshold: 0.3,
    });

    expect(buildCyreneSectionSnapshot(modelSettings({
      runtimeSync: "bogus" as never,
      stickerSize: "huge" as never,
      stickerSimilarityThreshold: Number.NaN,
    }))).toMatchObject({
      runtimeSync: "off",
      stickerEnabled: true,
      stickerSize: "standard",
      stickerSimilarityThreshold: 0.55,
    });
  });

  it("RAG 投影：embedding 模型/维度与 reranker 模式 + 安装状态（缺省未安装）", () => {
    const snapshot = buildCyreneSectionSnapshot(
      modelSettings({ embeddingDimensions: 1024, rerankerMode: "none" }),
      { embedding: { bgem3: true }, reranker: { standard: false } },
    );
    expect(snapshot).toMatchObject({
      embeddingModel: "bgem3",
      embeddingDimensions: 1024,
      rerankerMode: "none",
      embeddingInstalled: true,
      rerankerInstalled: false,
    });

    const auto = buildCyreneSectionSnapshot(modelSettings({ embeddingDimensions: undefined }));
    expect(auto.embeddingDimensions).toBeNull();
    expect(auto.embeddingInstalled).toBe(false);
    expect(auto.rerankerInstalled).toBe(false);
  });
});
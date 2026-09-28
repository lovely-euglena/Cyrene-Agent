// native section 快照构建器测试：投影口径（API 配置/档案、记忆 L0/L1/L2、定时任务）。

import { describe, expect, it } from "vitest";
import {
  buildApiSectionSnapshot,
  buildAsrSectionSnapshot,
  buildCyreneSectionSnapshot,
  buildMemorySectionSnapshot,
  buildSchedulerSectionSnapshot,
  buildTokensSectionSnapshot,
  buildTtsSectionSnapshot,
  buildPluginsSectionSnapshot,
  type AsrSettingsView,
  type NativeMemoryData,
  type TtsSettingsView,
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

describe("buildPluginsSectionSnapshot", () => {
  const base = {
    weatherEnabled: true,
    weatherSource: "open-meteo" as const,
    amapKey: "amap-key",
    travelEnabled: false,
    playwrightMcpEnabled: true,
    searchEngine: "bocha" as const,
    searchBochaKey: "bk",
    searchTavilyKey: "",
    searchMinimaxKey: "",
    searchAnySearchKey: "",
    emailEnabled: true,
    emailSmtpHost: "smtp.qq.com",
    emailSmtpPort: 465,
    emailSmtpSecure: true,
    emailSmtpUser: "u",
    emailSmtpPass: "p",
    emailFromName: "昔涟",
    emailImapHost: "imap.qq.com",
    emailImapPort: 993,
    emailImapSecure: true,
  };

  it("投影内置工具配置与权限档位；非法枚举回落、空档位回落只读", () => {
    const snapshot = buildPluginsSectionSnapshot({ ...base }, "full");
    expect(snapshot).toMatchObject({
      weatherEnabled: true,
      weatherSource: "open-meteo",
      amapKey: "amap-key",
      travelEnabled: false,
      playwrightMcpEnabled: true,
      searchEngine: "bocha",
      emailEnabled: true,
      emailSmtpPort: 465,
      emailImapHost: "imap.qq.com",
      emailImapPort: 993,
      emailImapSecure: true,
      permissionLevel: "full",
    });

    const fallback = buildPluginsSectionSnapshot(
      { ...base, weatherSource: "bogus" as never, searchEngine: "google" as never },
      "",
    );
    expect(fallback.weatherSource).toBe("open-meteo");
    expect(fallback.searchEngine).toBe("off");
    expect(fallback.permissionLevel).toBe("read-only");
  });
});

describe("buildTokensSectionSnapshot", () => {  it("投影缓存口径字段（weekday/cacheCreation/attempted/cacheUsage）与汇总", () => {
    const snapshot = buildTokensSectionSnapshot(
      {
        days: [
          {
            date: "06-15",
            weekday: "周日",
            input: 100,
            output: 50,
            hit: 30,
            miss: 10,
            cacheCreation: 5,
            requests: 3,
            attemptedRequests: 4,
            cacheUsageRequests: 2,
          },
          {
            date: "06-16",
            weekday: "周一",
            input: 200,
            output: 80,
            hit: 40,
            miss: 20,
            cacheCreation: 0,
            requests: 5,
            attemptedRequests: 5,
            cacheUsageRequests: 5,
          },
        ],
        models: [{ model: "m", input: 300, output: 130, requests: 8 }],
      },
      7,
    );
    expect(snapshot.daily[0]).toMatchObject({
      weekday: "周日",
      cacheCreation: 5,
      attemptedRequests: 4,
      cacheUsageRequests: 2,
    });
    expect(snapshot.totals).toEqual({
      input: 300,
      output: 130,
      hit: 70,
      miss: 30,
      requests: 8,
      attemptedRequests: 9,
      cacheUsageRequests: 7,
    });
    expect(snapshot.models[0]).toEqual({ name: "m", input: 300, output: 130, requests: 8 });
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
      "D:/cyrene/models",
    );
    expect(snapshot).toMatchObject({
      embeddingModel: "bgem3",
      embeddingDimensions: 1024,
      rerankerMode: "none",
      embeddingInstalled: true,
      rerankerInstalled: false,
      modelsDir: "D:/cyrene/models",
    });

    const auto = buildCyreneSectionSnapshot(modelSettings({ embeddingDimensions: undefined }));
    expect(auto.embeddingDimensions).toBeNull();
    expect(auto.embeddingInstalled).toBe(false);
    expect(auto.rerankerInstalled).toBe(false);
    expect(auto.modelsDir).toBe("");
  });
});

describe("buildTtsSectionSnapshot", () => {
  const base: TtsSettingsView = {
    ttsEngine: "off",
    ttsAutoRead: true,
    ttsEarlyReadSplitEnabled: true,
    ttsEarlyReadSplitMode: "sentence",
    ttsSpeed: 1,
    ttsVolume: 1,
    ttsMinimaxKey: "mini-key",
    ttsMinimaxVoiceId: "voice-id",
    ttsMinimaxModel: "speech-2.8-turbo",
    ttsStreaming: true,
    ttsMinimaxVocalEnhance: true,
    ttsGptsovitsBaseUrl: "",
    ttsGptsovitsRefAudioPath: "",
    ttsGptsovitsPromptText: "",
    ttsGptsovitsFormat: "wav",
    ttsGptsovitsTimeoutMs: 180_000,
    ttsCustomCloudEndpointUrl: "",
    ttsCustomCloudApiKey: "",
    ttsCustomCloudVoiceId: "",
    ttsCustomCloudFormat: "mp3",
    ttsCustomCloudTimeoutMs: 30_000,
    ttsMimoKey: "",
    ttsMimoVoiceAudioPath: "",
    ttsMimoStylePrompt: "",
    ttsMosslandKey: "",
    ttsMosslandVoiceId: "",
    ttsMosslandModel: "",
    ttsMosslandTestText: "",
    ttsMosslandFormat: "mp3",
  };

  it("旧页默认回填：空串回落（baseUrl / 风格提示 / 试听文本 / Mossland 模型），布尔缺省按开", () => {
    const snapshot = buildTtsSectionSnapshot({ ...base });
    expect(snapshot).toMatchObject({
      engine: "off",
      autoRead: true,
      earlyReadSplitEnabled: true,
      earlyReadSplitMode: "sentence",
      speed: 1,
      volume: 1,
      minimaxKey: "mini-key",
      minimaxModel: "speech-2.8-turbo",
      streaming: true,
      minimaxVocalEnhance: true,
      gptsovitsBaseUrl: "http://localhost:9880",
      gptsovitsFormat: "wav",
      gptsovitsTimeoutMs: 180_000,
      customCloudFormat: "mp3",
      customCloudTimeoutMs: 30_000,
      mimoStylePrompt: "温柔、自然、略带亲近感，像在轻声陪用户聊天。",
      mosslandModel: "moss-tts-1.5-flash",
      mosslandTestText: "你好，我是昔涟，很高兴见到你。",
      mosslandFormat: "mp3",
    });
  });

  it("非法枚举回落 + 越界数值 clamp（历史值 moss-tts 回落默认模型）", () => {
    const snapshot = buildTtsSectionSnapshot({
      ...base,
      ttsEngine: "bogus" as never,
      ttsEarlyReadSplitMode: "word" as never,
      ttsMinimaxModel: "speech-3.0" as never,
      ttsGptsovitsFormat: "ogg" as never,
      ttsMosslandFormat: "flac" as never,
      ttsMosslandModel: "moss-tts",
      ttsSpeed: 9,
      ttsVolume: -1,
      ttsGptsovitsTimeoutMs: 100,
      ttsCustomCloudTimeoutMs: 999_999,
    });
    expect(snapshot.engine).toBe("off");
    expect(snapshot.earlyReadSplitMode).toBe("sentence");
    expect(snapshot.minimaxModel).toBe("speech-2.8-turbo");
    expect(snapshot.gptsovitsFormat).toBe("wav");
    expect(snapshot.mosslandFormat).toBe("mp3");
    expect(snapshot.mosslandModel).toBe("moss-tts-1.5-flash");
    expect(snapshot.speed).toBe(2);
    expect(snapshot.volume).toBe(0);
    expect(snapshot.gptsovitsTimeoutMs).toBe(10_000);
    expect(snapshot.customCloudTimeoutMs).toBe(120_000);
  });
});

describe("buildAsrSectionSnapshot", () => {
  const base: AsrSettingsView = {
    asrEngine: "off",
    asrAliyunAppKey: "",
    asrAliyunAccessKeyId: "",
    asrAliyunAccessKeySecret: "",
    ttsMosslandKey: "moss-key",
    asrLanguage: "zh",
    asrVadSilenceMs: 1000,
    asrVadThreshold: 0.01,
    asrShowTranscript: false,
  };

  it("投影引擎 / 凭据 / VAD / 转写开关（mossland key 与 TTS 共用）", () => {
    const snapshot = buildAsrSectionSnapshot({
      ...base,
      asrEngine: "aliyun",
      asrAliyunAppKey: "app",
      asrAliyunAccessKeyId: "id",
      asrAliyunAccessKeySecret: "secret",
      asrLanguage: "en",
      asrVadSilenceMs: 3000,
      asrVadThreshold: 0.02,
      asrShowTranscript: true,
    });
    expect(snapshot).toEqual({
      engine: "aliyun",
      aliyunAppKey: "app",
      aliyunAccessKeyId: "id",
      aliyunAccessKeySecret: "secret",
      mosslandKey: "moss-key",
      language: "en",
      vadSilenceMs: 3000,
      vadThreshold: 0.02,
      showTranscript: true,
      localPlugins: [],
    });
  });

  it("本地引擎 + 运行中的语音输入插件名透出（快照副本，防外部数组污染）", () => {
    const plugins = ["本地语音输入"];
    const snapshot = buildAsrSectionSnapshot({ ...base, asrEngine: "local" }, plugins);
    expect(snapshot.engine).toBe("local");
    expect(snapshot.localPlugins).toEqual(["本地语音输入"]);
    plugins.push("later"); // 传入数组后续变化不影响快照
    expect(snapshot.localPlugins).toEqual(["本地语音输入"]);
  });

  it("非法引擎 / 语言回落；VAD 越界 clamp", () => {
    const snapshot = buildAsrSectionSnapshot({
      ...base,
      asrEngine: "azure" as never,
      asrLanguage: "ja" as never,
      asrVadSilenceMs: 10,
      asrVadThreshold: 5,
    });
    expect(snapshot.engine).toBe("off");
    expect(snapshot.language).toBe("zh");
    expect(snapshot.vadSilenceMs).toBe(100);
    expect(snapshot.vadThreshold).toBe(0.5);
  });
});
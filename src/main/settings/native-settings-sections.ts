// native 设置窗 section 快照构建器（API 与模型 / 记忆 / 定时任务）。
//
// 纯投影函数：输入主进程数据 → 输出 state.settings 的 api/memory/tasks 子对象。
// 放在这里而不是 core-bootstrap，是为了：可单测、避免 core-bootstrap 依赖
// 模型/记忆/调度三个子系统，且与 native-settings-protocol 的读方向键名同处一地。

import { MODEL_PRESETS } from "../../shared/model-presets";
import { DEFAULT_MOSSLAND_TTS_MODEL } from "../../shared/tts-types";
import type { GeneralSettings } from "./general-settings";
import type { ModelSettings } from "./model-settings";
import type { SavedModelProfile } from "./model-catalog";
import type { ObsidianVaultConfig } from "../memory/obsidian-vault-config";
import type { RendererScheduledTask, SchedulerToolInfo } from "../scheduler/scheduler-actions";

/** L2 事件片段投影上限（防御异常大的记忆库撑爆帧；正常量级远小于此） */
const L2_PROJECTION_LIMIT = 500;

export interface NativeApiVisionSnapshot {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface NativeApiConfigSnapshot {
  provider: string;
  displayName: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  contextWindowTokens: number | null;
  transport: "openai" | "anthropic" | "responses";
  multimodal: boolean;
  thinkingOverride: -1 | 0 | 1;
  disableMaxToken: boolean;
  /** 测试连接超时（ms；timeout-settings.json 的 testTimeout） */
  testTimeout: number;
  embeddingDimensions: number | null;
  customEndpoint: boolean;
  /** 独立视觉模型（全局，不随档案走） */
  vision: NativeApiVisionSnapshot;
}

export interface NativeApiPresetSnapshot {
  provider: string;
  shortName: string;
  baseUrl: string;
  anthropicBaseUrl: string | null;
  transport: "openai" | "anthropic" | "responses";
  mainModels: string[];
  websiteUrl: string | null;
  visionBaseUrl: string | null;
  defaultVisionModel: string | null;
  visionModels: string[];
  customEndpointMode: "cloud" | "local" | null;
  hiddenInPresetList: boolean;
}

export interface NativeApiProfileSnapshot {
  id: string;
  provider: string;
  displayName: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  transport: "openai" | "anthropic" | "responses";
  contextWindowTokens: number | null;
  multimodal: boolean | null;
  isDefault: boolean;
}

export interface NativeApiSnapshot {
  config: NativeApiConfigSnapshot;
  presets: NativeApiPresetSnapshot[];
  profiles: NativeApiProfileSnapshot[];
  defaultProfileId: string;
}

export interface NativeMemoryL2Item {
  content: string;
  triggerText: string;
  status: string;
  weight: number;
  createdAt: number;
}

export interface NativeMemoryData {
  l0: object;
  l1: object;
  l2: unknown[];
  importedDocs: Array<{ importId: string | null; fileName: string; chunkCount: number; lastImportedAt: number }>;
  reflections: Array<{ id: string; title: string; body: string; meta: string }>;
}

export interface NativeMemorySnapshot {
  l0: Record<string, string>;
  l1: Record<string, string>;
  l2: NativeMemoryL2Item[];
  l2Total: number;
  /** L2 被投影上限截断（UI 应提示「仅显示前 N 条」） */
  l2Truncated: boolean;
  /** 读取失败原因（空串=正常）；UI 据此显示错误行而非空态 */
  error: string;
  importedDocs: Array<{ importId: string | null; fileName: string; chunkCount: number; lastImportedAt: number }>;
  reflections: Array<{ id: string; title: string; body: string; meta: string }>;
  vault: { vaultPath: string; autoSync: boolean; lastSyncAt: number };
}

export interface NativeSchedulerHistorySnapshot {
  taskId: string;
  rows: unknown[];
  /** 读取失败原因（空串=成功）；UI 显示错误行而不是空态 */
  error: string;
}

export interface NativeSchedulerSnapshot {
  tasks: RendererScheduledTask[];
  tools: SchedulerToolInfo[];
  pluginRunning: Record<string, boolean>;
  history: NativeSchedulerHistorySnapshot | null;
}

// ── Token 用量（tokens section） ──

export interface NativeTokensDay {
  date: string;
  /** 中文周几（"周一"…；旧版 tooltip/图表 title 用） */
  weekday: string;
  input: number;
  output: number;
  hit: number;
  miss: number;
  /** 缓存创建 token；0 = 未提供 */
  cacheCreation: number;
  requests: number;
  /** 有 usage 回执的请求数（请求数显示 N / M） */
  attemptedRequests: number;
  /** 厂商实际返回缓存统计的请求数；0 = 暂无缓存数据 */
  cacheUsageRequests: number;
}

export interface NativeTokensModel {
  name: string;
  input: number;
  output: number;
  requests: number;
}

export interface NativeTokensSnapshot {
  /** 当前统计窗口（7/14/30 天） */
  days: number;
  daily: NativeTokensDay[];
  models: NativeTokensModel[];
  totals: {
    input: number;
    output: number;
    hit: number;
    miss: number;
    requests: number;
    attemptedRequests: number;
    cacheUsageRequests: number;
  };
}

/** 投影 token 用量报告（不依赖 electron，纯结构类型便于单测）。 */
export function buildTokensSectionSnapshot(
  report: {
    days: Array<{
      date: string;
      weekday: string;
      input: number;
      output: number;
      hit: number;
      miss: number;
      cacheCreation: number;
      requests: number;
      attemptedRequests: number;
      cacheUsageRequests: number;
    }>;
    models: Array<{ model: string; input: number; output: number; requests: number }>;
  },
  days: number,
): NativeTokensSnapshot {
  const daily: NativeTokensDay[] = report.days.map((day) => ({
    date: day.date,
    weekday: day.weekday,
    input: day.input,
    output: day.output,
    hit: day.hit,
    miss: day.miss,
    cacheCreation: day.cacheCreation,
    requests: day.requests,
    attemptedRequests: day.attemptedRequests,
    cacheUsageRequests: day.cacheUsageRequests,
  }));
  const totals = daily.reduce(
    (acc, day) => ({
      input: acc.input + day.input,
      output: acc.output + day.output,
      hit: acc.hit + day.hit,
      miss: acc.miss + day.miss,
      requests: acc.requests + day.requests,
      attemptedRequests: acc.attemptedRequests + day.attemptedRequests,
      cacheUsageRequests: acc.cacheUsageRequests + day.cacheUsageRequests,
    }),
    { input: 0, output: 0, hit: 0, miss: 0, requests: 0, attemptedRequests: 0, cacheUsageRequests: 0 },
  );
  const models: NativeTokensModel[] = report.models.slice(0, 12).map((model) => ({
    name: model.model,
    input: model.input,
    output: model.output,
    requests: model.requests,
  }));
  return { days, daily, models, totals };
}

const str = (value: unknown): string => (typeof value === "string" ? value : "");

// ── 插件 / 内置工具（plugins section） ──

export interface NativePluginsSnapshot {
  weatherEnabled: boolean;
  weatherSource: "open-meteo" | "amap";
  /** 高德 Key（天气与出行共用同一字段） */
  amapKey: string;
  travelEnabled: boolean;
  playwrightMcpEnabled: boolean;
  searchEngine: GeneralSettings["searchEngine"];
  searchBochaKey: string;
  searchTavilyKey: string;
  searchMinimaxKey: string;
  searchAnySearchKey: string;
  emailEnabled: boolean;
  emailSmtpHost: string;
  emailSmtpPort: number;
  emailSmtpSecure: boolean;
  emailSmtpUser: string;
  emailSmtpPass: string;
  emailFromName: string;
  /** 文件/命令访问档位（project-read-only/read-only/scoped/per-action/full） */
  permissionLevel: string;
}

/** 投影「插件」section（内置工具配置 + 权限档位；不依赖 electron）。 */
export function buildPluginsSectionSnapshot(
  settings: Pick<
    GeneralSettings,
    | "weatherEnabled"
    | "weatherSource"
    | "amapKey"
    | "travelEnabled"
    | "playwrightMcpEnabled"
    | "searchEngine"
    | "searchBochaKey"
    | "searchTavilyKey"
    | "searchMinimaxKey"
    | "searchAnySearchKey"
    | "emailEnabled"
    | "emailSmtpHost"
    | "emailSmtpPort"
    | "emailSmtpSecure"
    | "emailSmtpUser"
    | "emailSmtpPass"
    | "emailFromName"
  >,
  permissionLevel: string,
): NativePluginsSnapshot {
  return {
    weatherEnabled: settings.weatherEnabled === true,
    weatherSource: settings.weatherSource === "amap" ? "amap" : "open-meteo",
    amapKey: str(settings.amapKey),
    travelEnabled: settings.travelEnabled === true,
    playwrightMcpEnabled: settings.playwrightMcpEnabled === true,
    searchEngine: settings.searchEngine === "bocha"
      || settings.searchEngine === "tavily"
      || settings.searchEngine === "minimax"
      || settings.searchEngine === "anySearch"
      ? settings.searchEngine
      : "off",
    searchBochaKey: str(settings.searchBochaKey),
    searchTavilyKey: str(settings.searchTavilyKey),
    searchMinimaxKey: str(settings.searchMinimaxKey),
    searchAnySearchKey: str(settings.searchAnySearchKey),
    emailEnabled: settings.emailEnabled === true,
    emailSmtpHost: str(settings.emailSmtpHost),
    emailSmtpPort: Number.isFinite(settings.emailSmtpPort) ? Math.round(settings.emailSmtpPort) : 465,
    emailSmtpSecure: settings.emailSmtpSecure !== false,
    emailSmtpUser: str(settings.emailSmtpUser),
    emailSmtpPass: str(settings.emailSmtpPass),
    emailFromName: str(settings.emailFromName),
    permissionLevel: permissionLevel.length > 0 ? permissionLevel : "read-only",
  };
}

/** L0/L1 只输出字符串字段（渲染投影不需要类型元数据）。 */
function projectProfileFields(raw: object): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

export function buildApiSectionSnapshot(
  settings: ModelSettings,
  profiles: SavedModelProfile[],
  testTimeout = 15_000,
): NativeApiSnapshot {
  const vision = settings.vision;
  const transport = settings.explicitTransport === "anthropic" || settings.explicitTransport === "responses"
    ? settings.explicitTransport
    : "openai";
  const defaultProfileId = settings.defaultModelProfileId ?? "";

  return {
    config: {
      provider: settings.provider,
      displayName: settings.displayName ?? "",
      baseUrl: settings.baseUrl,
      model: settings.model,
      apiKey: settings.apiKey,
      contextWindowTokens: typeof settings.contextWindowTokens === "number" ? settings.contextWindowTokens : null,
      transport,
      multimodal: settings.multimodal !== false,
      thinkingOverride: settings.thinkingOverride === 1 ? 1 : settings.thinkingOverride === -1 ? -1 : 0,
      disableMaxToken: settings.disableMaxToken === true,
      testTimeout,
      embeddingDimensions: typeof settings.embeddingDimensions === "number" ? settings.embeddingDimensions : null,
      customEndpoint: !MODEL_PRESETS.some((preset) => preset.providerName === settings.provider),
      // 视觉配置是全局的（不随档案走）
      vision: {
        baseUrl: vision?.baseUrl ?? "",
        apiKey: vision?.apiKey ?? "",
        model: vision?.model ?? "",
      },
    },
    presets: MODEL_PRESETS.map((preset) => ({
      provider: preset.providerName,
      shortName: preset.shortName,
      baseUrl: preset.baseUrl,
      anthropicBaseUrl: preset.anthropicBaseUrl ?? null,
      transport: preset.transport,
      mainModels: preset.mainModels,
      websiteUrl: preset.websiteUrl ?? null,
      visionBaseUrl: preset.visionBaseUrl ?? null,
      defaultVisionModel: preset.defaultVisionModel ?? null,
      visionModels: preset.visionModels ?? [],
      customEndpointMode: preset.customEndpointMode ?? null,
      hiddenInPresetList: preset.hiddenInPresetList === true,
    })),
    profiles: profiles.map((profile) => ({
      id: profile.id,
      provider: profile.provider,
      displayName: profile.displayName ?? "",
      model: profile.model,
      baseUrl: profile.baseUrl,
      apiKey: profile.apiKey,
      transport: profile.explicitTransport === "anthropic" || profile.explicitTransport === "responses"
        ? profile.explicitTransport
        : "openai",
      contextWindowTokens: typeof profile.contextWindowTokens === "number" ? profile.contextWindowTokens : null,
      multimodal: typeof profile.multimodal === "boolean" ? profile.multimodal : null,
      isDefault: profile.id === defaultProfileId,
    })),
    defaultProfileId,
  };
}

export function buildMemorySectionSnapshot(
  data: NativeMemoryData,
  vault: ObsidianVaultConfig,
  error = "",
): NativeMemorySnapshot {
  const l2: NativeMemoryL2Item[] = [];
  for (const raw of data.l2) {
    if (l2.length >= L2_PROJECTION_LIMIT) break;
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    l2.push({
      content: str(item.content),
      triggerText: str(item.triggerText),
      status: str(item.status),
      weight: typeof item.weight === "number" ? item.weight : 0,
      createdAt: typeof item.createdAt === "number" ? item.createdAt : 0,
    });
  }

  return {
    l0: projectProfileFields(data.l0),
    l1: projectProfileFields(data.l1),
    l2,
    l2Total: data.l2.length,
    l2Truncated: data.l2.length > L2_PROJECTION_LIMIT,
    error,
    importedDocs: data.importedDocs.map((doc) => ({
      importId: doc.importId,
      fileName: doc.fileName,
      chunkCount: doc.chunkCount,
      lastImportedAt: doc.lastImportedAt,
    })),
    reflections: data.reflections.map((item) => ({
      id: item.id,
      title: item.title,
      body: item.body,
      meta: item.meta,
    })),
    vault: {
      vaultPath: vault.vaultPath,
      autoSync: vault.autoSync,
      lastSyncAt: vault.lastSyncAt,
    },
  };
}

export function buildSchedulerSectionSnapshot(
  tasks: RendererScheduledTask[],
  tools: SchedulerToolInfo[],
  pluginRunning: Record<string, boolean>,
  history: NativeSchedulerHistorySnapshot | null,
): NativeSchedulerSnapshot {
  return { tasks, tools, pluginRunning, history };
}

// ── 昔涟设置（cyrene section）：阶段 1 = 状态栏实时更新 + 表情包发送 ──

export interface NativeCyreneSnapshot {
  runtimeSync: "off" | "local" | "llm";
  stickerEnabled: boolean;
  stickerSize: "small" | "standard" | "large";
  stickerSimilarityThreshold: number;
  /** RAG / 文档导入：embedding 模型与维度（null = 自动探测） */
  embeddingModel: "bgem3";
  embeddingDimensions: number | null;
  /** RAG：reranker 模式 + 两个模型的安装状态（来自 model-status 体检） */
  rerankerMode: "standard" | "none";
  embeddingInstalled: boolean;
  rerankerInstalled: boolean;
}

/** 模型安装状态（结构投影；实际探测在 main/rag/model-status，避免本模块依赖 electron）。 */
export interface NativeModelInstallStatus {
  embedding: { bgem3: boolean };
  reranker: { standard: boolean };
}

/**
 * 昔涟设置快照（与渲染页 loadGeneralSettings 读的是同一份 model settings；
 * 写入由 cyrene section 动作 save 走 saveModelSettings，读/写归一化同口径）。
 * status 由调用方传入（getModelInstallStatus()），缺省按未安装。
 */
export function buildCyreneSectionSnapshot(
  settings: Pick<
    ModelSettings,
    | "runtimeSync"
    | "stickerEnabled"
    | "stickerSize"
    | "stickerSimilarityThreshold"
    | "embeddingModel"
    | "embeddingDimensions"
    | "rerankerMode"
  >,
  status?: NativeModelInstallStatus,
): NativeCyreneSnapshot {
  const runtimeSync = settings.runtimeSync === "llm"
    ? "llm"
    : settings.runtimeSync === "local"
      ? "local"
      : "off";
  return {
    runtimeSync,
    stickerEnabled: settings.stickerEnabled !== false,
    stickerSize: settings.stickerSize === "small" || settings.stickerSize === "large"
      ? settings.stickerSize
      : "standard",
    stickerSimilarityThreshold: typeof settings.stickerSimilarityThreshold === "number"
      && Number.isFinite(settings.stickerSimilarityThreshold)
      ? Math.min(0.9, Math.max(0.3, settings.stickerSimilarityThreshold))
      : 0.55,
    embeddingModel: "bgem3",
    embeddingDimensions: typeof settings.embeddingDimensions === "number"
      && Number.isFinite(settings.embeddingDimensions)
      && settings.embeddingDimensions > 0
      ? Math.round(settings.embeddingDimensions)
      : null,
    rerankerMode: settings.rerankerMode === "none" ? "none" : "standard",
    embeddingInstalled: status?.embedding?.bgem3 === true,
    rerankerInstalled: status?.reranker?.standard === true,
  };
}

// ── 语音（tts / asr section） ──────────────────────────────────────────────

export interface NativeTtsSnapshot {
  engine: GeneralSettings["ttsEngine"];
  autoRead: boolean;
  earlyReadSplitEnabled: boolean;
  earlyReadSplitMode: "sentence" | "paragraph";
  speed: number;
  volume: number;
  minimaxKey: string;
  minimaxVoiceId: string;
  minimaxModel: "speech-2.8-hd" | "speech-2.8-turbo";
  streaming: boolean;
  minimaxVocalEnhance: boolean;
  gptsovitsBaseUrl: string;
  gptsovitsRefAudioPath: string;
  gptsovitsPromptText: string;
  gptsovitsFormat: "wav" | "mp3";
  gptsovitsTimeoutMs: number;
  customCloudEndpointUrl: string;
  customCloudApiKey: string;
  customCloudVoiceId: string;
  customCloudFormat: "wav" | "mp3";
  customCloudTimeoutMs: number;
  mimoKey: string;
  mimoVoiceAudioPath: string;
  mimoStylePrompt: string;
  mosslandKey: string;
  mosslandVoiceId: string;
  mosslandModel: string;
  mosslandTestText: string;
  mosslandFormat: "mp3" | "wav";
}

/** TTS 快照的输入子集（tts* 字段；调用方传完整 GeneralSettings 亦可）。 */
export type TtsSettingsView = Pick<
  GeneralSettings,
  | "ttsEngine"
  | "ttsAutoRead"
  | "ttsEarlyReadSplitEnabled"
  | "ttsEarlyReadSplitMode"
  | "ttsSpeed"
  | "ttsVolume"
  | "ttsMinimaxKey"
  | "ttsMinimaxVoiceId"
  | "ttsMinimaxModel"
  | "ttsStreaming"
  | "ttsMinimaxVocalEnhance"
  | "ttsGptsovitsBaseUrl"
  | "ttsGptsovitsRefAudioPath"
  | "ttsGptsovitsPromptText"
  | "ttsGptsovitsFormat"
  | "ttsGptsovitsTimeoutMs"
  | "ttsCustomCloudEndpointUrl"
  | "ttsCustomCloudApiKey"
  | "ttsCustomCloudVoiceId"
  | "ttsCustomCloudFormat"
  | "ttsCustomCloudTimeoutMs"
  | "ttsMimoKey"
  | "ttsMimoVoiceAudioPath"
  | "ttsMimoStylePrompt"
  | "ttsMosslandKey"
  | "ttsMosslandVoiceId"
  | "ttsMosslandModel"
  | "ttsMosslandTestText"
  | "ttsMosslandFormat"
>;

/** TTS 快照：旧页 loadTtsConfig 同款默认回填（缺省/非法值回落旧页默认）。 */
export function buildTtsSectionSnapshot(settings: TtsSettingsView): NativeTtsSnapshot {
  return {
    engine: (["off", "minimax", "gptsovits", "custom-cloud", "mimo", "mossland"] as const)
      .find((engine) => engine === settings.ttsEngine) ?? "off",
    autoRead: settings.ttsAutoRead === true,
    earlyReadSplitEnabled: settings.ttsEarlyReadSplitEnabled !== false,
    earlyReadSplitMode: settings.ttsEarlyReadSplitMode === "paragraph" ? "paragraph" : "sentence",
    speed: clampNumber(settings.ttsSpeed, 0.5, 2) ?? 1,
    volume: clampNumber(settings.ttsVolume, 0, 1) ?? 1,
    minimaxKey: str(settings.ttsMinimaxKey),
    minimaxVoiceId: str(settings.ttsMinimaxVoiceId),
    minimaxModel: settings.ttsMinimaxModel === "speech-2.8-hd" ? "speech-2.8-hd" : "speech-2.8-turbo",
    streaming: settings.ttsStreaming !== false,
    minimaxVocalEnhance: settings.ttsMinimaxVocalEnhance !== false,
    gptsovitsBaseUrl: str(settings.ttsGptsovitsBaseUrl) || "http://localhost:9880",
    gptsovitsRefAudioPath: str(settings.ttsGptsovitsRefAudioPath),
    gptsovitsPromptText: str(settings.ttsGptsovitsPromptText),
    gptsovitsFormat: settings.ttsGptsovitsFormat === "mp3" ? "mp3" : "wav",
    gptsovitsTimeoutMs: clampNumber(settings.ttsGptsovitsTimeoutMs, 10_000, 3_600_000) ?? 180_000,
    customCloudEndpointUrl: str(settings.ttsCustomCloudEndpointUrl),
    customCloudApiKey: str(settings.ttsCustomCloudApiKey),
    customCloudVoiceId: str(settings.ttsCustomCloudVoiceId),
    customCloudFormat: settings.ttsCustomCloudFormat === "wav" ? "wav" : "mp3",
    customCloudTimeoutMs: clampNumber(settings.ttsCustomCloudTimeoutMs, 1_000, 120_000) ?? 30_000,
    mimoKey: str(settings.ttsMimoKey),
    mimoVoiceAudioPath: str(settings.ttsMimoVoiceAudioPath),
    mimoStylePrompt: str(settings.ttsMimoStylePrompt) || "温柔、自然、略带亲近感，像在轻声陪用户聊天。",
    mosslandKey: str(settings.ttsMosslandKey),
    mosslandVoiceId: str(settings.ttsMosslandVoiceId),
    mosslandModel: normalizeMosslandModel(settings.ttsMosslandModel),
    mosslandTestText: str(settings.ttsMosslandTestText) || TTS_TEST_TEXT,
    mosslandFormat: settings.ttsMosslandFormat === "wav" ? "wav" : "mp3",
  };
}

export interface NativeAsrSnapshot {
  engine: GeneralSettings["asrEngine"];
  aliyunAppKey: string;
  aliyunAccessKeyId: string;
  aliyunAccessKeySecret: string;
  mosslandKey: string;
  language: "zh" | "en" | "auto";
  vadSilenceMs: number;
  vadThreshold: number;
  showTranscript: boolean;
}

/** ASR 快照的输入子集（asr* 字段 + 共用的 mossland key）。 */
export type AsrSettingsView = Pick<
  GeneralSettings,
  | "asrEngine"
  | "asrAliyunAppKey"
  | "asrAliyunAccessKeyId"
  | "asrAliyunAccessKeySecret"
  | "ttsMosslandKey"
  | "asrLanguage"
  | "asrVadSilenceMs"
  | "asrVadThreshold"
  | "asrShowTranscript"
>;

/** ASR 快照：旧页 loadAsrConfig 同款默认回填（mossland key 与 TTS 共用）。 */
export function buildAsrSectionSnapshot(settings: AsrSettingsView): NativeAsrSnapshot {
  return {
    engine: (["off", "aliyun", "mossland", "local"] as const)
      .find((engine) => engine === settings.asrEngine) ?? "off",
    aliyunAppKey: str(settings.asrAliyunAppKey),
    aliyunAccessKeyId: str(settings.asrAliyunAccessKeyId),
    aliyunAccessKeySecret: str(settings.asrAliyunAccessKeySecret),
    mosslandKey: str(settings.ttsMosslandKey),
    language: settings.asrLanguage === "en" || settings.asrLanguage === "auto" ? settings.asrLanguage : "zh",
    vadSilenceMs: clampNumber(settings.asrVadSilenceMs, 100, 60_000) ?? 1000,
    vadThreshold: clampNumber(settings.asrVadThreshold, 0.001, 0.5) ?? 0.01,
    showTranscript: settings.asrShowTranscript === true,
  };
}

/** TTS 试听缺省文本（与 native-voice-actions 的 TTS_TEST_TEXT 同句）。 */
const TTS_TEST_TEXT = "你好，我是昔涟，很高兴见到你。";

/** 旧页：ttsMosslandModel 缺省/历史值 "moss-tts" 回落默认模型，其余原样保留。 */
function normalizeMosslandModel(raw: unknown): string {
  const model = str(raw);
  return model && model !== "moss-tts" ? model : DEFAULT_MOSSLAND_TTS_MODEL;
}

function clampNumber(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : null;
}
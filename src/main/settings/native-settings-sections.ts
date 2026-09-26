// native 设置窗 section 快照构建器（API 与模型 / 记忆 / 定时任务）。
//
// 纯投影函数：输入主进程数据 → 输出 state.settings 的 api/memory/tasks 子对象。
// 放在这里而不是 core-bootstrap，是为了：可单测、避免 core-bootstrap 依赖
// 模型/记忆/调度三个子系统，且与 native-settings-protocol 的读方向键名同处一地。

import { MODEL_PRESETS } from "../../shared/model-presets";
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
  input: number;
  output: number;
  hit: number;
  miss: number;
  requests: number;
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
  totals: { input: number; output: number; hit: number; miss: number; requests: number };
}

/** 投影 token 用量报告（不依赖 electron，纯结构类型便于单测）。 */
export function buildTokensSectionSnapshot(
  report: {
    days: Array<{ date: string; input: number; output: number; hit: number; miss: number; requests: number }>;
    models: Array<{ model: string; input: number; output: number; requests: number }>;
  },
  days: number,
): NativeTokensSnapshot {
  const daily: NativeTokensDay[] = report.days.map((day) => ({
    date: day.date,
    input: day.input,
    output: day.output,
    hit: day.hit,
    miss: day.miss,
    requests: day.requests,
  }));
  const totals = daily.reduce(
    (acc, day) => ({
      input: acc.input + day.input,
      output: acc.output + day.output,
      hit: acc.hit + day.hit,
      miss: acc.miss + day.miss,
      requests: acc.requests + day.requests,
    }),
    { input: 0, output: 0, hit: 0, miss: 0, requests: 0 },
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
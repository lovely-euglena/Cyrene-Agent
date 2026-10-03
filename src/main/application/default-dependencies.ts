/**
 * 默认应用依赖装配（真正的组合根胶水层）：
 * 持有全部业务子系统的导入与工厂闭包，把它们按窄依赖喂给各启动阶段。
 * 只有 index.ts 引用本模块；application.ts 与各 bootstrap 模块不感知具体实现。
 *
 * 本文件内的闭包只做构造与委托；任何长期任务都必须由对应启动阶段显式启动。
 */

import { app, BrowserWindow, dialog, screen, shell as electronShell } from "electron";
import * as fs from "node:fs";
import * as path from "path";
import { autoUpdater } from "electron-updater";

import { ensureGpuSandboxAcl } from "../gpu-sandbox-acl";
import { getExternalContentPaths } from "../external-content-paths";
import { migrateStagedExternalContent } from "../external-content-migration";
import { logger, LogTag } from "../logger";
import { renderBanner } from "../../shared/banner";
import { IPC } from "../../shared/ipc-channels";
import { isDev } from "../env";
import {
  loadGeneralSettings,
  saveGeneralSettings,
  onGeneralSettingsChanged,
} from "../settings/settings-facade";
import {
  getCurrentAppIconPath,
  markStartupPhaseReady,
  reactChatWindow,
  setGetCurrentAppIconPath,
  settingsWindow,
  sidebarWindow,
  tasksWindow,
} from "../windows/window-state";
import { loadModelSettings, saveModelSettings, getPublicModelConfig, resolveModelSettingsProfile, listSavedModelProfiles, saveModelProfile, setDefaultModelProfile } from "../settings/model-settings";
import { getConversationTranscriptStore } from "../orchestrator/conversation-transcript-store";
import { getHarnessRunStore } from "../orchestrator/harness/run-store";
import { createModelBackedConversationTranscriptCompactor } from "../orchestrator/conversation-transcript-compactor";
import { ConversationJournalService } from "../orchestrator/conversation-journal-service";
import { activeConversationRegistry } from "../chats/active-conversation-registry";
import { registerSettingsIpc } from "../settings/settings-ipc";
import { registerPortableIpc, applyPortableChange } from "../portable/portable-ipc";
import { registerCacheDirIpc } from "../portable/cache-ipc";
import { registerOcrIpc } from "../ocr/ocr-ipc";
import { registerCloudStorageIpc } from "../cloud-storage/cloud-storage-ipc";
import { resolveCacheDir, setCacheDirOverride } from "../cache-dir";
import { getPortableDataLocationStatus } from "../portable/portable-runtime";
import type { PortableApplyRequest } from "../../shared/portable-mode";
import { registerNewsIpc } from "../news/news-feed";
import {
  applyGeneralSettings,
  handleGeneralSettingsChanged,
  syncVolcanoSearchMcp,
} from "../settings/general-settings-lifecycle";
import { registerMemoryUserToolIpc } from "../memory/memory-user-ipc";
import { configureDocumentIndexQueue } from "../rag/document-index-queue";
import { runDocumentIndexJob } from "../rag/document-index-worker";
import { runDocumentImportJobViaSidecar } from "../rag/document-import-sidecar";
import { isSidecarEnabled } from "../rag/embedding-sidecar";
import { createLlmClient } from "../services/llm/llm-client";
import { createTtsSynthesisService } from "../services/tts/tts-synthesis-service";
import { createEmbeddingIndexService } from "../services/embedding/embedding-index-service";
import { momentsService, registerMomentsMediaMatcher } from "../moments/moments-service";
import {
  addL2MemoryVector,
  deleteUserMemoryVectors,
  flushRAGStore,
  flushRAGStoreSync,
  getEntriesBySource,
  initRAG,
  isUserMemoryVectorStoreReady,
} from "../rag";
import { getEmbeddingProvider, getSceneEmbeddingProvider } from "../rag/embedding";
import { toolRegistry } from "../orchestrator/tools/registry/tool-registry";
import { pluginPromptRegistry } from "../../plugins/prompts";
import type { PluginManager } from "../../plugins/manager";
import { setLive2dWindowSender } from "../orchestrator/tools/built-in-tools";
import { registerAllTools } from "../orchestrator/tools/registry/tool-registration";
import { LspManager } from "../lsp/manager";
import { initSandbox } from "../orchestrator/sandbox/sandbox-exec";
import {
  encodePlanSessionKey,
  enterPlanDiscussing,
  exitPlanMode,
  getPlanState,
  initPlanPaths,
  initPlanStateBroadcaster,
  initPlanStatePersister,
  restorePlanSession,
  type PlanStateSnapshot,
} from "../orchestrator/plan-mode";
import { initMcpManager, pruneMcpServersByIds } from "../orchestrator/mcp-manager";
import { syncPlaywrightMcp, syncFilesystemMcp, REMOVED_BUILTIN_MCP_IDS } from "../sync-mcp-builtin";
import { addMcpServer } from "../orchestrator/mcp-manager";
import { parseCommandLine } from "../../shared/parse-command-line";
import { ACCESS_LEVEL_LABEL, applyLevel, getCurrentLevel } from "../permission";
import { registerAppUpdateIpc } from "../updater/app-update-ipc";
import { createGitHubAppUpdateService, scheduleStartupUpdateCheck } from "../updater/github-app-updater";
import { registerWindowSystemIpc, openChromeGpuWindow } from "../windows/window-system-ipc";
import { enqueueLLMTask } from "../llm-queue";
import {
  registerPrivilegedSchemes,
  registerProtocolHandlers,
} from "../protocols/bootstrap";
import { memoryStore } from "../memory/memory-store";
import { backupMemoryRagFiles, reconcileMemoryRag } from "../memory/memory-rag-reconciliation";
import { broadcastCompactionPhase, registerChatsIpc } from "../chats/chats-ipc";
import { hasActiveConversationRun, registerAgUiIpc } from "../agui-bridge";
import { registerBrowserPanelIpc } from "../browser/browser-panel-ipc";
import { registerMomentsIpc } from "../moments/moments-ipc";
import { registerChatUiIpc, getActiveChatSessionId } from "../chats/chat-ui-ipc";
import { createToastWindowController } from "../toast/toast-window";
import { createToastService } from "../toast/toast-service";
import { toastEvents } from "../toast/toast-events";
import { createToastWindowShell } from "../windows/create-toast-window";
import * as chatsStore from "../chats/chats-store";
import { flush as flushTokenUsage, getUsageReport, clearUsage } from "../token-usage-store";
import { TtsSessionService } from "../tts/tts-session-service";
import { registerTtsIpc } from "../tts/tts-ipc";
import { loadUserProfile, saveUserProfile } from "../settings-store";
import { getAppIconPath } from "../app-icon";
import { updateLocaleContext } from "../locale-context";
import { registerCallIpc } from "../call/call-manager";
import { initSkills, skillRegistry } from "../skills";
import { createSchedulerSubsystem, type SchedulerSubsystem } from "../scheduler/bootstrap";
import { createSchedulerActions } from "../scheduler/scheduler-actions";
import {
  buildApiSectionSnapshot,
  buildAsrSectionSnapshot,
  buildCyreneSectionSnapshot,
  buildMemorySectionSnapshot,
  buildSchedulerSectionSnapshot,
  buildTokensSectionSnapshot,
  buildTtsSectionSnapshot,
  buildPluginsSectionSnapshot,
} from "../settings/native-settings-sections";
import { addUserSticker } from "../sticker-storage";
import { loadMemoryPanelData } from "../memory/panel";
import {
  bindMemoryVault,
  exportMemoryVault,
  getMemoryVaultConfig,
  removeImportedDocEntry,
  saveMemoryL0,
  saveMemoryL1,
  setMemoryVaultAutoSync,
  syncMemoryVaultNow,
  unbindMemoryVault,
} from "../memory/memory-actions";
import { testVendorConnection } from "../orchestrator/vendors/test-connection";
import { testVisionConnection } from "../settings/vision-test";
import { createChannelsSubsystem } from "../channels/bootstrap";
import { registerOpenInAppIpc } from "../chats/open-in-app";
import { registerWorkspaceFilesIpc } from "../chats/workspace-files-ipc";
import { createLifecyclePublisher } from "../plugin-host/lifecycle-publisher";
import { createPendingTurnLifecycle } from "../plugin-host/pending-turn-lifecycle";
import { startPluginRuntime, getPluginMarketService, pickPluginZipFile, clearPluginMarketService } from "../plugin-runtime";
import { createPluginRuntimeShell } from "../../plugins/runtime-shell";
import { ensureCustomStylePrompt } from "../style-prompt";
import { deleteEmbeddingModel } from "../embedding-manager";
import { getModelInstallStatus, getModelInstallStatusDetail, getProjectModelsDir } from "../rag/model-status";
import { pushPluginsSnapshotToNative, pushSettingsNoticeToNative, pushSettingsSnapshotToNative } from "../windows/native-windows-bridge";
import {
  MAX_PLUGIN_MEMORY_LIMIT_MB,
  MAX_PLUGIN_STORAGE_QUOTA_MB,
  resolvePluginMemoryLimitMb,
  resolvePluginStorageQuotaMb,
} from "../../plugins/limits";
import type { PluginUsage } from "../../plugins/manager";
import { createAgentRuntime } from "../orchestrator/agent-runtime";
import { reconcileCrashedInterruptions } from "../orchestrator/conversation-interruption-reconciliation";
import { createRuntimeStateService } from "../orchestrator/runtime-state-service";
import { createTranscriptCompactorGetter } from "./transcript-compaction-wiring";
import { createProactiveLifecycle } from "../proactive/proactive-lifecycle";
import { createCitaService } from "../services/cita/cita-service";
import { createSocialContextService } from "../services/social-context/social-context-service";
import { createGitService } from "../code-git/git-service";
import { resolveGitExecutable, type ResolvedGitExecutable } from "../code-git/git-executable";
import { registerCodeGitIpc } from "../code-git/code-git-ipc";
import { installSingleInstanceGuard } from "../single-instance";
import { migrateLegacyUserData } from "../user-data-migration";
import { createWindowManager } from "../windows/window-manager";
import { createTray } from "../tray";
import { setSidebarWindowVisible, setTasksWindowVisible } from "../windows/create-aux-windows";
import { installChildProcessReaper } from "../child-processes";
import { getTimeoutSettings, saveTimeoutSettings } from "../timeout-manager";
import {
  initNativeWindowsBridge,
  bindNativeDataProviders,
  relayAuxBroadcast,
  spawnNativeWindow,
  disposeNativeWindowsBridge,
  pushWindowRadiusToNative,
} from "../windows/native-windows-bridge";
import { handleMusicAction, openMusicWindow } from "../music/music-manager";
import { connectDetachedTray, showTrayBalloon } from "../tray-detached";
import { openSettingsEntry, openSettingsWindow } from "../windows/settings-router";
import { pickAndImportUiFont, resetUiFont } from "../settings/ui-font";
import { createSplashWindow } from "../startup/create-splash-window";
import { revealStartupWindows } from "../startup/startup-window-reveal";
import { initializeScreenshotService } from "../screenshot/screenshot-lifecycle";
import { bootstrapConfigGetters } from "../startup/bootstrap-config";
import { bootstrapPermission } from "../permission/bootstrap";
import { registerPopQuizIpc, registerPopQuizTool } from "../orchestrator/pop-quiz";
import {
  sanitizeNativeAsrSave,
  sanitizeNativeCyreneSave,
  sanitizeNativeGeneralSetting,
  sanitizeNativePluginsSave,
  sanitizeNativeStickerAdd,
  sanitizeNativeTtsSave,
  sanitizeNativeUserProfile,
} from "../windows/native-settings-protocol";
import {
  cloneNativeMinimaxVoice,
  cloneNativeMosslandVoice,
  listNativeMosslandVoices,
  synthesizeNativeTest,
} from "../settings/native-voice-actions";
import { pickAndSaveUserAvatar } from "../memory/user-avatar";
import { createExamPaperStore } from "../learn/exam-paper-store";
import { createExamDraftStore } from "../learn/exam-draft";
import { registerExamPaperIpc } from "../learn/exam-paper-ipc";
import { registerLearnExamPageIpc } from "../learn/exam-page-ipc";
import { registerLearnExamTools } from "../orchestrator/learn-exam-tools";

import { createIpcScope, type IpcScope } from "./ipc-scope";
import { createShutdownCoordinator } from "./shutdown";
import { createStartupReadiness } from "./readiness";
import { createWindowActivationBroker } from "./window-activation";
import { prepareBeforeReady } from "./pre-ready";
import { startShell } from "./shell-bootstrap";
import { startCore, type CoreServices, type CoreDependencies } from "./core-bootstrap";
import { startBackground } from "./background";
import { installUpdateShutdownFallback, type UpdateLifecycleLike } from "./electron-lifecycle";
import type { ApplicationDependencies } from "./application";

/** Loading 最短展示时长（ms）：从实际 show() 时刻起算。 */
const SPLASH_MIN_MS = 2500;
/** 受控退出总超时（ms）：超时后中止信号并记录未完成资源。 */
const SHUTDOWN_TIMEOUT_MS = 10_000;

function broadcastToAuxWindows(channel: string, payload: unknown): void {
  for (const win of [reactChatWindow, sidebarWindow, tasksWindow, settingsWindow]) {
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
  // native 三件套旁路（未启用时 no-op）：同一数据双路推送。
  // ⚠️ 此调用曾在合并 ffc6322dd 中丢失（native 窗收不到实时状态），勿删。
  relayAuxBroadcast(channel, payload);
}

async function reconcileUserMemoryIndex(): Promise<void> {
  if (!isUserMemoryVectorStoreReady()) {
    console.warn("[Memory/RAG] reconciliation skipped: vector store is not writable");
    return;
  }
  const report = await reconcileMemoryRag({
    getMemories: () => memoryStore.getAllL2(),
    getVectors: () => getEntriesBySource("user_memory"),
    backup: async () => backupMemoryRagFiles(app.getPath("userData")),
    addVector: addL2MemoryVector,
    markSynced: (l2Id, ragId) => memoryStore.markL2SyncStatus(l2Id, "synced", ragId),
    markSyncFailed: (l2Id, error) => memoryStore.markL2SyncStatus(l2Id, "sync_failed", undefined, error),
    deleteVectors: (ids) => deleteUserMemoryVectors(ids),
    warn: (message, error) => console.warn(`[Memory/RAG] ${message}:`, error),
  });
  logger.info(LogTag.RAG, "reconciliation:", report);
}

/**
 * 启动崩溃恢复：扫描 userData/plans/各会话目录/state.json，把中断的非 NORMAL 会话还原。
 * 只恢复事实不恢复执行权——统一降级 PLAN_DISCUSSING，REVIEW/EXECUTING 来源
 * 由 [PLAN_RECOVERY] 注入中断事实，模型先查证工作区再修订计划重新审批。
 * 快照的会话键取自文件内容（原始 conversationId），目录名只是物理位置；
 * 单个快照损坏只跳过该会话，不阻塞其他恢复。
 */
function recoverInterruptedPlanSessions(plansRoot: string): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(plansRoot);
  } catch {
    return; // plans 目录不存在 = 从未用过计划模式
  }
  for (const entry of entries) {
    const stateFile = path.join(plansRoot, entry, "state.json");
    try {
      if (!fs.existsSync(stateFile)) continue;
      const snapshot = JSON.parse(fs.readFileSync(stateFile, "utf8")) as PlanStateSnapshot;
      const conversationId = typeof snapshot.conversationId === "string" ? snapshot.conversationId : entry;
      const result = restorePlanSession(conversationId, snapshot);
      if (result.ok) {
        console.log(`[PlanMode] 恢复中断会话 ${conversationId}: ${snapshot.state} → PLAN_DISCUSSING`);
      } else {
        console.warn(`[PlanMode] 跳过非法快照 ${entry}: ${result.reason}`);
      }
    } catch (err) {
      console.warn(`[PlanMode] 读取快照失败 ${stateFile}:`, err);
    }
  }
}

export function createDefaultApplicationDependencies(): ApplicationDependencies {
  // Agent Runtime 早于插件管理器构造；通过窄闭包在运行期转发宿主事件，避免反转启动顺序。
  let pluginManager: PluginManager | undefined;
  // 自动压缩与 CHATS_COMPACT 必须共享同一个会话级压缩器，避免两条路径各自组装 provider。
  const getTranscriptCompactor = createTranscriptCompactorGetter(() =>
    createModelBackedConversationTranscriptCompactor({
      store: getConversationTranscriptStore(app.getPath("userData")),
      runReader: getHarnessRunStore(app.getPath("userData")),
      loadModelSettings: () => resolveModelSettingsProfile(loadModelSettings()),
      // 压缩阶段推给窗口：自动压缩发生在 run 开始前的主进程侧，
      // 渲染端拿不到 AG-UI 事件，靠这条推送显示消息流尾部的呼吸提示。
      onPhase: (phase, conversationId) => broadcastCompactionPhase(conversationId, phase),
    }));

  // 插件运行时动态启动用：startPlugins 首次调用的实参（core 阶段保存）
  let lastPluginArgs: Parameters<CoreDependencies["startPlugins"]> | null = null;
  // ipc holder：startCore 装配时填充（shell.ipc 生命周期跟随应用）
  let shellIpc: IpcScope | null = null;
  // 未绑定即抛错。历史实现回退到 createIpcScope()，会让「插件列表回退」与
  // 「PluginManager 正式注册」落在不同 IpcScope 上：removeHandler 命不中残留的
  // plugins:list，二次 handle 时 Electron 抛 "Attempted to register a second
  // handler"。绑定由 startCore 包装器在装配前完成。
  const shellIpcRef = (): IpcScope => {
    if (!shellIpc) throw new Error("shell IpcScope 尚未绑定：startCore 装配前不可注册插件 IPC");
    return shellIpc;
  };

  // 插件运行时启动实现（startPlugins 装配与运行期动态启用共用；幂等）
  const startPluginsImpl = async (
    services: CoreServices,
    scheduler: Parameters<CoreDependencies["startPlugins"]>[1],
    runtime: Parameters<CoreDependencies["startPlugins"]>[2],
  ): Promise<PluginManager | null> => {
    if (pluginManager) return pluginManager;
    pluginManager = await startPluginRuntime({
      llmClient: services.llm,
      ipc: shellIpcRef(),
      schedulerStore: scheduler.store,
      agentRuntime: runtime,
      onPluginRunningStateChange: () => scheduler.engine.refreshPluginTasks(),
      getPanelHostWebContents: () => (settingsWindow?.webContents ? [settingsWindow.webContents] : []),
    });
    return pluginManager;
  };

  // ── 插件运行时管理壳：常驻 IPC（运行时未启用也可用） ────────────────
  // 回退注册 + 正式注册的条件互斥逻辑收在 plugins/runtime-shell（可单测）；
  // 这里只提供 manager 引用、真实启动函数与设置读写。
  const pluginRuntimeShell = createPluginRuntimeShell({
    getIpc: () => shellIpcRef(),
    getSettings: () => {
      const general = loadGeneralSettings();
      return {
        pluginRuntimeEnabled: general.pluginRuntimeEnabled,
        pluginStorageQuotaMb: general.pluginStorageQuotaMb,
        pluginMemoryLimitMb: general.pluginMemoryLimitMb,
      };
    },
    saveSettings: (patch) => { saveGeneralSettings(patch); },
    getManager: () => pluginManager,
    setManager: (manager) => { pluginManager = manager; },
    startRuntime: async () => {
      if (!lastPluginArgs) return null;
      return startPluginsImpl(...lastPluginArgs);
    },
    clearMarketService: () => clearPluginMarketService(),
  });

  // 插件快照（.NET 管理窗 state.plugins payload；含运行时开关态）
  // 最近一次插件操作结果（导入 ZIP / 刷新 / 安装失败等）：随快照下发到
  // .NET 管理窗状态行显示；下次操作覆盖。
  let nativePluginNotice: { kind: "ok" | "error"; message: string } | null = null;
  const setPluginNotice = (kind: "ok" | "error", message: string): void => {
    nativePluginNotice = { kind, message };
  };
  /** 正在安装的插件 id（随快照下发 → WPF 市场卡片显示「安装中…」） */
  let nativeInstallingIds: string[] = [];
  const buildPluginSnapshot = async (): Promise<unknown> => {
    const mkt = getPluginMarketService();
    const general = loadGeneralSettings();
    const storageQuotaMb = resolvePluginStorageQuotaMb(general.pluginStorageQuotaMb);
    const memoryLimitMb = resolvePluginMemoryLimitMb(general.pluginMemoryLimitMb);
    // 实际占用与市场列表并行取（占用含 .NET 进程探测，不阻塞市场数据）
    const [market, usage] = await Promise.all([
      pluginManager && mkt ? mkt.listMarket() : Promise.resolve(null),
      pluginManager
        ? pluginManager.collectUsage()
        : Promise.resolve<Record<string, PluginUsage>>({}),
    ]);
    return {
      runtimeEnabled: Boolean(pluginManager),
      plugins: pluginManager
        ? pluginManager.overview().plugins.map((entry) => ({
            ...entry,
            // 展示用实际占用（storageBytes 两轨都有；memoryBytes 仅 .NET 运行中）
            storageBytes: usage[entry.id]?.storageBytes ?? 0,
            memoryBytes: usage[entry.id]?.memoryBytes ?? null,
          }))
        : [],
      // .NET 管理窗把 market 当数组解析：摊平为条目数组（旧实现直接塞
      // listMarket() 结果对象 → ParseList 判非数组 → 市场恒为空）。
      // 源健康/错误另字段下发，供管理器展示多源死活。
      market: market?.plugins ?? [],
      marketSources: market?.sources ?? [],
      marketError: market && !market.ok ? (market.error ?? "") : undefined,
      notice: nativePluginNotice ?? undefined,
      // 安装进行中：WPF 按钮显示「安装中…」并禁用（宿主不推送中途快照时也有反馈）
      installing: nativeInstallingIds,
      // 资源限制（「设置」页）：生效值 + 是否来自设置页（false = 环境变量/默认）
      limits: {
        storageQuotaMb,
        memoryLimitMb,
        storageQuotaConfigured: typeof general.pluginStorageQuotaMb === "number",
        memoryLimitConfigured: typeof general.pluginMemoryLimitMb === "number",
      },
    };
  };

  /** 运行中且声明 speech-input 依赖的插件名（本地 ASR 可用性提示；未启用运行时为空）。 */
  const runningSpeechInputPlugins = (): string[] =>
    pluginManager
      ? pluginManager.overview().plugins
          .filter((entry) => entry.enabled && (entry.deps ?? []).includes("speech-input"))
          .map((entry) => entry.name)
      : [];

  // ── native 设置窗 section（API/记忆/定时任务）：动作与快照数据 ──────
  // 动作层实例在 createScheduler 时建立（core 阶段早于任何 native 动作）
  let nativeSchedulerActions: ReturnType<typeof createSchedulerActions> | null = null;
  /** 最近一次「历史」请求结果（随设置快照推给 WPF；下一次请求覆盖）；error 为空串表示成功 */
  let nativeTaskHistory: { taskId: string; rows: unknown[]; error: string } | null = null;

  /** core 阶段绑定的表情包向量索引（native 昔涟 section 添加表情包后刷新；未绑定=不刷新）。 */
  let stickerEmbeddingIndexService: {
    invalidateStickerEmbeddingIndex(): void;
    refreshStickerEmbeddingIndex(reason: string): void;
  } | null = null;
  /** Token 用量 section 当前统计窗口（7/14/30 天） */
  let nativeTokenDays = 7;

  /** 本地模型安装说明（native 昔涟设置「模型安装说明」与渲染页同一文档）。 */
  // 模型安装说明文档（Gitee 主仓；GitHub 在本机网络不可达，勿换回）
  const LOCAL_MODELS_DOC_URL = "https://gitee.com/ygwill/cyrene-agent/blob/main/docs/local-models.md";

  /**
   * 「昔涟设置」RAG 模型操作（native cyreneAction 与渲染端 IPC 共用）：
   *   open-docs / open-dir / open-site / check-model-update / delete-embedding。
   * 返回可直接展示的反馈；native 侧包一层 notice，渲染端直接展示 message。
   */
  async function runCyreneModelAction(verb: string): Promise<{
    ok: boolean;
    message?: string;
    dir?: string;
    error?: string;
  }> {
    try {
      switch (verb) {
        case "open-docs":
          await electronShell.openExternal(LOCAL_MODELS_DOC_URL);
          return { ok: true, message: "已在浏览器打开模型安装说明" };
        case "open-dir": {
          const dir = getProjectModelsDir();
          fs.mkdirSync(dir, { recursive: true });
          const openError = await electronShell.openPath(dir);
          if (openError) return { ok: false, error: `打开目录失败：${openError}` };
          return { ok: true, message: `已打开模型目录：${dir}`, dir };
        }
        case "open-site": {
          const mirror = loadGeneralSettings().ragDownloadMirror;
          const url = mirror === "hf-mirror"
            ? "https://hf-mirror.com/Xenova/bge-m3"
            : "https://huggingface.co/Xenova/bge-m3";
          await electronShell.openExternal(url);
          return { ok: true, message: `已打开模型下载站（${mirror === "hf-mirror" ? "hf-mirror" : "官方"}）` };
        }
        case "open-model-downloader": {
          const opened = await spawnNativeWindow("model-download", {
            modelsDir: getProjectModelsDir(),
            mirror: loadGeneralSettings().ragDownloadMirror === "hf-mirror" ? "hf-mirror" : "official",
          });
          return opened
            ? { ok: true, message: "已打开模型下载窗口" }
            : { ok: false, error: "原生窗口不可用（未启用 .NET 组件）" };
        }
        case "check-model-update": {
          pushSettingsSnapshotToNative();
          const embedding = getModelInstallStatusDetail("embedding", "bgem3");
          const reranker = getModelInstallStatusDetail("reranker", "standard");
          const embeddingText = embedding.installed
            ? "BGE-M3 已安装"
            : `BGE-M3 未安装${embedding.missingFiles.length > 0 ? `（缺少 ${embedding.missingFiles.join("、")}）` : ""}`;
          const rerankerText = reranker.installed
            ? "bge-reranker-base 已安装"
            : "bge-reranker-base 未安装（可选）";
          return { ok: true, message: `已重新检测：${embeddingText}；${rerankerText}。` };
        }
        case "delete-embedding": {
          const removed = deleteEmbeddingModel("bgem3");
          console.log("[Cyrene] embedding model deleted:", removed.length > 0 ? removed.join("; ") : "(no files found)");
          pushSettingsSnapshotToNative();
          return { ok: true, message: "BGE-M3 模型已删除（项目 models 目录 + HF 缓存；下次使用需重新安装）" };
        }
        default:
          return { ok: false, error: `未知操作：${verb}` };
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  const asStr = (value: unknown): string => (typeof value === "string" ? value : "");
  const asObj = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const clampInt = (value: unknown, min: number, max: number): number | null => {
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    return Math.max(min, Math.min(max, Math.round(value)));
  };
  const transportOf = (value: unknown): "openai" | "anthropic" | "responses" | undefined =>
    value === "openai" || value === "anthropic" || value === "responses" ? value : undefined;

  /** 设置窗 section 反馈（就地状态行展示，不触发 section 重建；窗未开时 no-op） */
  const nativeNotice = (
    section: string,
    level: "ok" | "error" | "info",
    text: string,
    data?: Record<string, unknown>,
  ): void => {
    pushSettingsNoticeToNative({ section, level, text, at: Date.now(), ...(data ? { data } : {}) });
  };

  /** 插件运行态（WPF 定时任务 section 判断"等待插件启用"） */
  const currentPluginRunning = (): Record<string, boolean> => {
    const running: Record<string, boolean> = {};
    const plugins = (pluginManager?.overview().plugins ?? []) as Array<{ id?: unknown; status?: unknown }>;
    for (const plugin of plugins) {
      if (typeof plugin.id === "string") running[plugin.id] = plugin.status === "running";
    }
    return running;
  };

  const broadcastModelChanged = (): void => {
    broadcastToAuxWindows(IPC.MODEL_CONFIG_CHANGED, getPublicModelConfig());
  };

  /** WPF「API 与模型」section 动作（与渲染设置页同口径：档案 saveModelProfile + 全局 saveModelSettings） */
  const nativeApiAction = (verb: string, payload: Record<string, unknown>): void => {
    switch (verb) {
      case "save": {
        const config = asObj(payload.config);
        const vision = asObj(config.vision);
        const profileId = asStr(config.profileId) || undefined;
        const provider = asStr(config.provider) || loadModelSettings().provider;
        const baseUrl = asStr(config.baseUrl);
        const model = asStr(config.model);
        // 宿主侧统一校验（对齐 Electron 保存前校验，WPF 不再写坏档案）
        if (!provider || !model) {
          nativeNotice("api", "error", "保存失败：厂商与模型名不能为空");
          return;
        }
        if (baseUrl && !/^https?:\/\//i.test(baseUrl)) {
          nativeNotice("api", "error", "保存失败：Base URL 必须以 http(s):// 开头");
          return;
        }
        try {
          const existing = profileId
            ? listSavedModelProfiles(loadModelSettings()).find((profile) => profile.id === profileId)
            : undefined;
          const beforeIds = new Set(listSavedModelProfiles(loadModelSettings()).map((profile) => profile.id));
          // 测试连接超时随保存一起落盘（与 Electron 同口径）
          const testTimeout = clampInt(config.testTimeout, 1_000, 600_000);
          if (testTimeout !== null) saveTimeoutSettings({ testTimeout });
          // 不丢推理偏好：payload 未带 reasoning 时保留原档案值（WPF 无该字段 UI，
          // 旧实现重建档案时 normalizeReasoningPreference(undefined) 会把它抹掉）
          const reasoning = config.reasoning !== undefined
            ? (config.reasoning as Parameters<typeof saveModelProfile>[0]["reasoning"])
            : existing?.reasoning;
          const result = saveModelProfile({
            id: profileId,
            provider,
            displayName: asStr(config.displayName),
            baseUrl,
            model,
            apiKey: asStr(config.apiKey),
            explicitTransport: transportOf(config.transport),
            contextWindowTokens: clampInt(config.contextWindowTokens, 4096, 10_000_000) ?? undefined,
            multimodal: config.multimodal === true,
            reasoning,
          });
          const savedProfileId = profileId
            ?? listSavedModelProfiles(result.settings).find((profile) => !beforeIds.has(profile.id))?.id
            ?? "";
          saveModelSettings({
            vision: { baseUrl: asStr(vision.baseUrl), apiKey: asStr(vision.apiKey), model: asStr(vision.model) },
            thinkingOverride: config.thinkingOverride === 1 ? 1 : config.thinkingOverride === -1 ? -1 : 0,
            disableMaxToken: config.disableMaxToken === true,
          });
          broadcastModelChanged();
          nativeNotice(
            "api",
            result.added ? "ok" : "error",
            result.added ? "档案已保存" : "存在相同 Key/模型/BaseURL 的档案，未新增",
            result.added && savedProfileId ? { savedProfileId } : undefined,
          );
        } catch (err) {
          nativeNotice("api", "error", `保存失败：${err instanceof Error ? err.message : String(err)}`);
        }
        pushSettingsSnapshotToNative();
        return;
      }
      case "test": {
        const config = asObj(payload.config);
        void testVendorConnection({
          provider: asStr(config.provider),
          baseUrl: asStr(config.baseUrl),
          model: asStr(config.model),
          apiKey: asStr(config.apiKey),
          explicitTransport: transportOf(config.transport),
        } as Parameters<typeof testVendorConnection>[0]).then((result) => {
          nativeNotice(
            "api",
            result.ok ? "ok" : "error",
            result.ok
              ? `连接成功 · ${result.latency}ms${result.sample ? ` · ${result.sample}` : ""}`
              : `连接失败：${result.error ?? "未知错误"}`,
          );
        }).catch((err) => {
          nativeNotice("api", "error", `连接失败：${err instanceof Error ? err.message : String(err)}`);
        });
        return;
      }
      case "test-vision": {
        const config = asObj(payload.config);
        void testVisionConnection({
          baseUrl: asStr(config.baseUrl),
          apiKey: asStr(config.apiKey),
          model: asStr(config.model),
        }).then((result) => {
          nativeNotice(
            "api",
            result.ok ? "ok" : "error",
            result.ok
              ? `视觉模型连接成功 · ${result.latency}ms${result.sample ? ` · ${result.sample}` : ""}`
              : `视觉模型连接失败：${result.error ?? "未知错误"}`,
          );
        });
        return;
      }
      case "set-default-profile": {
        const id = asStr(payload.id);
        if (!id) return;
        try {
          setDefaultModelProfile(id);
          broadcastModelChanged();
          nativeNotice("api", "ok", "已设为默认模型");
        } catch (err) {
          nativeNotice("api", "error", `设置默认失败：${err instanceof Error ? err.message : String(err)}`);
        }
        pushSettingsSnapshotToNative();
        return;
      }
      case "delete-profile": {
        const id = asStr(payload.id);
        if (!id) return;
        try {
          const settings = loadModelSettings();
          const profiles = listSavedModelProfiles(settings).filter((profile) => profile.id !== id);
          const defaultModelProfileId = settings.defaultModelProfileId === id
            ? profiles[0]?.id
            : settings.defaultModelProfileId;
          saveModelSettings({ modelProfiles: profiles, defaultModelProfileId });
          broadcastModelChanged();
          nativeNotice("api", "ok", "档案已删除");
        } catch (err) {
          nativeNotice("api", "error", `删除失败：${err instanceof Error ? err.message : String(err)}`);
        }
        pushSettingsSnapshotToNative();
        return;
      }
      default:
        console.warn("[NativeSettings] unhandled api action:", verb);
    }
  };

  /** WPF「通用」section 动作（清空聊天记录 / 打开 chrome://gpu）。
   *  返回值用于动作回执：WPF 据此更新状态行并结束「进行中」态。 */
  const nativeGeneralAction = (verb: string, __payload: Record<string, unknown>): unknown => {
    switch (verb) {
      case "clear-chat-history": {
        // 旧版渲染页逐条调 chatStore.delete；宿主侧走同一 chats-store（串行删除）
        try {
          const sessions = chatsStore.listSessions();
          let deleted = 0;
          for (const session of sessions) {
            if (chatsStore.deleteSession(session.id)) deleted++;
          }
          nativeNotice("general", "ok", "所有聊天会话已清空");
          return { ok: true, data: { deleted } };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          nativeNotice("general", "error", "清空失败，请查看终端日志");
          return { ok: false, error: message };
        }
      }
      case "open-gpu-internals": {
        try {
          openChromeGpuWindow();
          return { ok: true };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      }
      default:
        console.warn("[NativeSettings] unhandled general action:", verb);
        return undefined;
    }
  };

  /** WPF「记忆」section 动作（与渲染设置页同口径；实现见 memory/memory-actions.ts）。
   *  返回值用于动作回执：WPF 据此结束「进行中」态并就地显示错误。 */
  const nativeMemoryAction = (verb: string, payload: Record<string, unknown>): unknown => {
    switch (verb) {
      case "save-l0":
      case "save-l1":
        return (async () => {
          const result = verb === "save-l0"
            ? await saveMemoryL0(payload.fields)
            : await saveMemoryL1(payload.fields);
          nativeNotice(
            "memory",
            result.ok ? "ok" : "error",
            result.ok ? (verb === "save-l0" ? "画像已保存" : "近况已保存") : `保存失败：${result.error ?? "未知错误"}`,
          );
          // 失败不推快照：WPF 编辑态保留用户输入，仅成功才刷新
          if (result.ok) pushSettingsSnapshotToNative();
          return { ok: result.ok, ...(result.error ? { error: result.error } : {}) };
        })();
      case "delete-doc": {
        const importId = asStr(payload.importId);
        const fileName = asStr(payload.fileName);
        if (!importId && !fileName) return { ok: false, error: "缺少文档标识" };
        try {
          const deleted = removeImportedDocEntry(importId, fileName || undefined);
          nativeNotice(
            "memory",
            deleted > 0 ? "ok" : "info",
            deleted > 0 ? `已删除（${deleted} 个片段）` : "没有找到可删除的片段",
          );
          pushSettingsSnapshotToNative();
          return { ok: true, data: { deleted } };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          nativeNotice("memory", "error", `删除失败：${message}`);
          return { ok: false, error: message };
        }
      }
      case "vault-bind":
        return bindMemoryVault().then((result) => {
          if (!result.canceled) {
            nativeNotice(
              "memory",
              result.ok ? "ok" : "error",
              result.ok ? `已绑定并同步 ${result.fileCount ?? 0} 个文件` : `绑定失败：${result.error ?? "未知错误"}`,
            );
            pushSettingsSnapshotToNative();
          }
          return result.canceled
            ? { ok: true, data: { canceled: true } }
            : { ok: result.ok, ...(result.error ? { error: result.error } : {}), data: { fileCount: result.fileCount ?? 0 } };
        });
      case "vault-unbind":
        try {
          unbindMemoryVault();
          nativeNotice("memory", "ok", "已解绑（vault 文件夹里的 md 不会被删除）");
          pushSettingsSnapshotToNative();
          return { ok: true };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      case "vault-export":
        return exportMemoryVault().then((result) => {
          if (!result.canceled) {
            nativeNotice(
              "memory",
              result.ok ? "ok" : "error",
              result.ok ? `已导出 ${result.fileCount ?? 0} 个文件` : `导出失败：${result.error ?? "未知错误"}`,
            );
          }
          return result.canceled
            ? { ok: true, data: { canceled: true } }
            : { ok: result.ok, ...(result.error ? { error: result.error } : {}), data: { fileCount: result.fileCount ?? 0 } };
        });
      case "vault-sync":
        return syncMemoryVaultNow().then((result) => {
          nativeNotice(
            "memory",
            result.ok ? "ok" : "error",
            result.ok ? `已同步 ${result.fileCount ?? 0} 个文件` : `同步失败：${result.error ?? "未知错误"}`,
          );
          pushSettingsSnapshotToNative();
          return { ok: result.ok, ...(result.error ? { error: result.error } : {}), data: { fileCount: result.fileCount ?? 0 } };
        });
      case "vault-auto-sync":
        try {
          setMemoryVaultAutoSync(payload.enabled === true);
          nativeNotice("memory", "info", payload.enabled === true ? "已开启自动同步" : "已关闭自动同步");
          pushSettingsSnapshotToNative();
          return { ok: true };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      default:
        console.warn("[NativeSettings] unhandled memory action:", verb);
        return undefined;
    }
  };

  /** WPF「定时任务」section 动作（动作层与 scheduler IPC 共用；写操作自动广播刷新）。
   *  返回值用于动作回执：任务编辑器据此决定关窗（成功）或就地报错（失败）。 */
  const nativeSchedulerAction = (verb: string, payload: Record<string, unknown>): unknown => {
    const actions = nativeSchedulerActions;
    if (!actions) {
      nativeNotice("tasks", "error", "调度器尚未就绪");
      return { ok: false, error: "调度器尚未就绪" };
    }
    switch (verb) {
      case "add": {
        const result = actions.add(asObj(payload.input) as unknown as Parameters<typeof actions.add>[0]);
        nativeNotice("tasks", result.ok ? "ok" : "error", result.ok ? "任务已创建" : `创建失败：${result.error ?? "未知错误"}`);
        return { ok: result.ok, ...(result.error ? { error: result.error } : {}) };
      }
      case "update": {
        const id = asStr(payload.id);
        if (!id) return { ok: false, error: "缺少任务 id" };
        const result = actions.update(id, asObj(payload.patch) as unknown as Parameters<typeof actions.update>[1]);
        nativeNotice("tasks", result.ok ? "ok" : "error", result.ok ? "任务已保存" : `保存失败：${result.error ?? "未知错误"}`);
        return { ok: result.ok, ...(result.error ? { error: result.error } : {}) };
      }
      case "toggle": {
        const id = asStr(payload.id);
        if (!id) return { ok: false, error: "缺少任务 id" };
        const result = actions.toggle(id, payload.enabled === true);
        if (!result.ok) nativeNotice("tasks", "error", `启停失败：${result.error ?? "未知错误"}`);
        return { ok: result.ok, ...(result.error ? { error: result.error } : {}) };
      }
      case "fire": {
        const id = asStr(payload.id);
        if (!id) return { ok: false, error: "缺少任务 id" };
        return actions.fireNow(id).then((result) => {
          if (result.ok) return { ok: true };
          const reason = "reason" in result ? result.reason : undefined;
          const errorText = "error" in result ? result.error : undefined;
          const message = reason === "task already running"
            ? "该任务正在运行中"
            : reason === "plugin not running"
              ? "插件已停用，等待插件启用后再运行"
              : (errorText ?? reason ?? "立即运行失败");
          nativeNotice("tasks", "error", message);
          return { ok: false, error: message };
        });
      }
      case "delete": {
        const id = asStr(payload.id);
        if (!id) return { ok: false, error: "缺少任务 id" };
        const result = actions.remove(id);
        nativeNotice("tasks", result.ok ? "ok" : "error", result.ok ? "任务已删除" : `删除失败：${result.error ?? "未知错误"}`);
        return { ok: result.ok, ...(result.error ? { error: result.error } : {}) };
      }
      case "history": {
        const id = asStr(payload.id);
        if (!id) return { ok: false, error: "缺少任务 id" };
        const result = actions.history(id, 10);
        // 读取失败也写 error：WPF 据此显示错误行（旧实现只存 rows，失败被吞成「暂无运行历史」）
        nativeTaskHistory = {
          taskId: id,
          rows: (result.value ?? []) as unknown[],
          error: result.ok ? "" : (result.error ?? "读取历史失败"),
        };
        pushSettingsSnapshotToNative();
        return { ok: result.ok, ...(result.error ? { error: result.error } : {}) };
      }
      default:
        console.warn("[NativeSettings] unhandled scheduler action:", verb);
        return undefined;
    }
  };

  /** WPF「插件」section 动作：内置工具配置保存 / 权限档位 / 添加 MCP Server。
   *  保存复用 TTS_SAVE_SETTINGS 的副作用（搜索 MCP、Playwright MCP 自动同步）。 */
  const nativePluginsAction = (verb: string, payload: Record<string, unknown>): unknown => {
    switch (verb) {
      case "save": {
        const patch = sanitizeNativePluginsSave(payload);
        if (!patch) return { ok: false, error: "没有可保存的字段" };
        try {
          const saved = saveGeneralSettings({ ...loadGeneralSettings(), ...patch });
          if (Object.prototype.hasOwnProperty.call(patch, "searchEngine")
            || Object.prototype.hasOwnProperty.call(patch, "searchMinimaxKey")) {
            void syncVolcanoSearchMcp(saved);
          }
          if (Object.prototype.hasOwnProperty.call(patch, "playwrightMcpEnabled")) {
            void syncPlaywrightMcp(saved);
          }
          nativeNotice("plugins", "ok", "工具配置已保存（即时生效）");
          pushSettingsSnapshotToNative();
          return { ok: true };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          nativeNotice("plugins", "error", `保存失败：${message}`);
          return { ok: false, error: message };
        }
      }
      case "set-permission-level": {
        const result = applyLevel(asStr(payload.level));
        if (result.ok && result.level) {
          nativeNotice("plugins", "ok", `权限档位已切换：${ACCESS_LEVEL_LABEL[result.level] ?? result.level}`);
        } else {
          nativeNotice("plugins", "error", `切换失败：${result.error ?? "未知错误"}`);
        }
        pushSettingsSnapshotToNative();
        return result;
      }
      case "add-mcp-server": {
        const command = asStr(payload.command).trim();
        const name = asStr(payload.name).trim() || "未命名 MCP";
        if (command.length === 0) return { ok: false, error: "请填写启动命令" };
        const parsed = parseCommandLine(command);
        if (parsed.command.length === 0) return { ok: false, error: "启动命令无效" };
        return addMcpServer({
          id: `mcp-${Date.now()}`,
          name,
          transport: "stdio",
          command: parsed.command,
          args: parsed.args,
        })
          .then((result) => {
            if (result.ok) {
              nativeNotice("plugins", "ok", `已添加「${name}」，发现 ${result.toolIds?.length ?? 0} 个工具`);
            } else {
              nativeNotice("plugins", "error", `添加失败：${result.error ?? "未知错误"}`);
            }
            return {
              ok: result.ok,
              ...(result.error ? { error: result.error } : {}),
              data: { toolCount: result.toolIds?.length ?? 0 },
            };
          })
          .catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            nativeNotice("plugins", "error", `添加失败：${message}`);
            return { ok: false, error: message };
          });
      }
      default:
        console.warn("[NativeSettings] unhandled plugins action:", verb);
        return undefined;
    }
  };

  /** WPF「语音合成 TTS」section 动作：settings 保存 / 试听合成 / 音色克隆 / 音色列表。
   *  试听与克隆复用渲染页同一批引擎函数（native-voice-actions），不复制协议逻辑。 */
  const nativeTtsAction = (verb: string, payload: Record<string, unknown>): unknown => {
    const failed = (err: unknown, label: string): { ok: false; error: string } => {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[NativeSettings] tts ${label} failed:`, message);
      return { ok: false, error: message };
    };
    switch (verb) {
      case "save": {
        const patch = sanitizeNativeTtsSave(payload);
        if (!patch) return { ok: false, error: "没有可保存的字段" };
        try {
          // TTS 字段无搜索 MCP / Playwright 等联动，直接落盘（与 TTS_SAVE_SETTINGS 同存储）
          saveGeneralSettings({ ...loadGeneralSettings(), ...patch });
          return { ok: true };
        } catch (err) {
          return failed(err, "save");
        }
      }
      case "test":
        return synthesizeNativeTest(payload)
          .then((result) => ({ ok: true, data: { filePath: result.filePath, format: result.format } }))
          .catch((err: unknown) => failed(err, "test"));
      case "clone-minimax":
        return cloneNativeMinimaxVoice(payload)
          .then((result) => ({
            ok: true,
            data: {
              voiceId: result.voiceId,
              ...(result.demoFilePath ? { demoFilePath: result.demoFilePath } : {}),
            },
          }))
          .catch((err: unknown) => failed(err, "clone-minimax"));
      case "clone-mossland":
        return cloneNativeMosslandVoice(payload)
          .then((result) => ({ ok: true, data: { voiceId: result.voiceId } }))
          .catch((err: unknown) => failed(err, "clone-mossland"));
      case "list-mossland-voices":
        return listNativeMosslandVoices(payload)
          .then((result) => ({ ok: true, data: { voices: result.voices, hasMore: result.hasMore } }))
          .catch((err: unknown) => failed(err, "list-mossland-voices"));
      default:
        console.warn("[NativeSettings] unhandled tts action:", verb);
        return undefined;
    }
  };

  /** WPF「语音识别 ASR」section 动作：settings 保存（试听/克隆归 TTS 段）。 */
  const nativeAsrAction = (verb: string, payload: Record<string, unknown>): unknown => {
    if (verb !== "save") {
      console.warn("[NativeSettings] unhandled asr action:", verb);
      return undefined;
    }
    const patch = sanitizeNativeAsrSave(payload);
    if (!patch) return { ok: false, error: "没有可保存的字段" };
    try {
      saveGeneralSettings({ ...loadGeneralSettings(), ...patch });
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn("[NativeSettings] asr save failed:", message);
      return { ok: false, error: message };
    }
  };

  // 生命周期事件发布器：插件系统就绪前发布的事件没有监听器，直接丢弃
  const lifecyclePublisher = createLifecyclePublisher({
    publish: (event, payload) => pluginManager
      ? pluginManager.publishHostEvent(event, payload)
      : Promise.resolve(),
  });
  // 桌面轮次协调器：turn:finished 等待"终态 + 渲染端落盘确认"双条件；
  // 计时器均 unref，应用退出前统一清理，不发布任何事件
  const pendingTurnLifecycle = createPendingTurnLifecycle({
    publisher: lifecyclePublisher,
    onAbandon: (runId, reason) => {
      console.warn(`[plugins] 桌面轮次事件放弃发布: runId=${runId} reason=${reason}`);
    },
  });
  app.on("will-quit", () => {
    pendingTurnLifecycle.disposeAll();
  });
  const readiness = createStartupReadiness();
  const activation = createWindowActivationBroker();
  const shutdown = createShutdownCoordinator({ readiness, timeoutMs: SHUTDOWN_TIMEOUT_MS });
  // 原生窗口进程（cyrene-native serve）随宿主退出一并回收：主动结束其 stdin
  // 并杀进程。缺此清理时它只在 stdin EOF 后「无窗口空转」，成为残留进程
  // （用户报「托盘退出时有进程残留」；C# 侧 EOF 自退也已补上，双保险）。
  shutdown.register({
    id: "native-windows",
    phase: "stopLocalResources",
    dispose: () => { disposeNativeWindowsBridge("shutdown"); },
  });

  // 注入应用图标路径 getter（窗口工厂统一读取，避免循环依赖）。
  // 必须在 shell 阶段之前注入：聊天窗口壳与托盘在 shell 阶段创建时就会读取，
  // 若等到 core 阶段再注入，托盘会拿到空路径而显示 Electron 默认图标。
  // getter 为惰性求值，此处注册不触发磁盘读取。
  setGetCurrentAppIconPath(() => getAppIconPath(loadGeneralSettings().uiIcon));

  return {
    app,
    dialog,
    readiness,
    activation,
    shutdown,

    prepare: () => {
      // 退出兜底：主进程崩溃/强杀时统一回收登记过的子进程（taskkill /F /T 整树）
      installChildProcessReaper((listener) => app.on("will-quit", listener));
      return prepareBeforeReady({
      configureDocumentIndex: () =>
        configureDocumentIndexQueue(
          isSidecarEnabled() ? runDocumentImportJobViaSidecar : runDocumentIndexJob,
        ),
      installSingleInstance: (onSecondInstance) => installSingleInstanceGuard(app, onSecondInstance),
      migrateLegacyUserData: () => {
        migrateLegacyUserData({
          appDataPath: app.getPath("appData"),
          targetUserDataPath: app.getPath("userData"),
        });
      },
      registerPrivilegedSchemes,
      configureGpuSwitches: () => {
        if (loadGeneralSettings().disableGpuElectron) {
          app.commandLine.appendSwitch("disable-gpu");
          app.commandLine.appendSwitch("enable-unsafe-swiftshader");
        }
      },
      ensureGpuSandboxAcl: () => ensureGpuSandboxAcl({
        isPackaged: app.isPackaged,
        exeDir: path.dirname(app.getPath("exe")),
        userDataDir: app.getPath("userData"),
      }),
      activation,
      });
    },

    startShell: () => startShell({
      readiness,
      activation,
      shutdown,
      writeStartupLog: () => {
        // banner 是纯文本（无色彩、无日志前缀），与 logger 输出区分开
        process.stdout.write("\n" + renderBanner() + "\n\n");
        logger.info(LogTag.Runtime, "starting Cyrene Agent");
      },
      createIpcScope: () => createIpcScope(),
      createSplashWindow: (options) => createSplashWindow({ isDev, onShown: options.onShown }),
      createWindowManager: () => createWindowManager({
        getCurrentAppIconPath,
        isDev,
        loadPetWindowSettingsSlice: loadGeneralSettings,
        persistPetWindowPosition: ({ x, y }) => saveGeneralSettings({ petWindowX: x, petWindowY: y }),
      }),
      createChatShell: (windowManager) => windowManager.createReactChatWindowShell(),
      registerProtocolHandlers,
      registerShellIpc: ({ ipc, windowManager, live2dWindowLifecycle }) => {
        // quit 由组合根注入（上游 2026-09-24 语义）：窗口系统 IPC 不直接依赖 electron app
        // openSettings 为回退路由：窗口 IPC 默认走聊天窗内设置页（见 window-system-ipc）
        registerWindowSystemIpc({ ipc, windowManager, openSettings: openSettingsWindow, openMusicWindow: () => openMusicWindow(), quit: () => app.quit() });
        registerChatUiIpc({ ipc, live2dWindowLifecycle, windowManager });
      },
      // 托盘/协议激活的设置入口：默认聊天窗内设置页（shell-bootstrap 内实现）；
      // 这里注入的是回退路由（原生 WPF / Electron 裁决见 settings-router）
      openSettings: openSettingsWindow,
      // native 三件套窗口（默认启用）：动作转发回
      // 既有 windowManager / aux 窗口管理；未启用时 initialize 是 no-op
      initializeNativeWindows: (windowManager) => {
        initNativeWindowsBridge({
          // 设置入口（native 状态栏「设置」/「切换模型」）：默认聊天窗内设置页；
          // 失败回退 WPF/Electron（settings-router 统一裁决 + 失败回退）
          openSettings: (section) => {
            openSettingsEntry(section, {
              openInChat: (target) => windowManager.openSettings(target),
              openFallback: (target) => openSettingsWindow(target),
            });
          },
          // native 状态栏「打开聊天」：必须走 openReactChatWindow（建壳+载页+显示）；
          // 只调 createReactChatWindowShell 会创建不可见的空壳，点了没反应。
          openChatWindow: () => { void windowManager.openReactChatWindow(); },
          openCallWindow: () => windowManager.createCallWindow(),
          // 侧栏「音乐」→ 本地音乐播放器（WPF music 窗；配置先下发）
          openMusicWindow: () => { void openMusicWindow(); },
          // 音乐窗设置变更（文件夹/Agent 权限）→ 宿主持久化
          musicAction: (action, payload) => handleMusicAction(action, payload),
          toggleSidebarPin: () => windowManager.createSidebarWindow(),
          onSplashShown: () => { /* onShown 由 spawnNativeSplash 注册的 hook 触发 */ },
          // 窗口圆角：spawn 时随窗口下发（native 进程重启后可恢复）；
          // 变更广播走 handleGeneralSettingsChanged 的 onWindowCornerRadiusChanged
          getWindowCornerRadius: () => loadGeneralSettings().windowCornerRadius,
          // native 设置窗写键：白名单/取值校验统一在 native-settings-protocol；
          // saveGeneralSettings 自动触发 handleGeneralSettingsChanged（桌宠显隐/
          // 置顶、开机自启、主题广播等联动）。
          // 不回推快照：native 控件状态即用户刚写入的值，回推重建会在滑杆/输入
          // 交互后打断焦点；快照仅在 spawn、换头像等需要刷新时推送。
          setSetting: (key, value) => {
            const patch = sanitizeNativeGeneralSetting(key, value);
            if (!patch) return;
            // 显式写 uiIcon 视为用户选择（旧默认迁移只在未选择时生效）
            if (key === "uiIcon") patch.uiIconChosen = true;
            saveGeneralSettings(patch);
            // 运行期联动：状态栏/日程栏开关立即开/关对应窗口（与 Electron 设置页同语义）
            if (key === "sidebarVisible") setSidebarWindowVisible(patch.sidebarVisible === true);
            if (key === "tasksVisible") setTasksWindowVisible(patch.tasksVisible === true);
          },
          // native 设置窗写用户资料：字段白名单 + 时区/性别校验；写后广播给
          // Electron 窗口（聊天/调用链有依赖）；同样不回推快照（避免打断输入）。
          setUserProfile: (profile) => {
            const patch = sanitizeNativeUserProfile(profile);
            if (!patch) return;
            const saved = saveUserProfile(patch);
            broadcastToAuxWindows(IPC.USER_PROFILE_CHANGED, saved);
          },
          // native 设置窗「更换头像」：宿主弹文件框（native 不传路径），完成后重推快照
          pickAvatar: () => {
            void pickAndSaveUserAvatar()
              .then((picked) => {
                if (!picked) return;
                broadcastToAuxWindows(IPC.USER_AVATAR_CHANGED, null);
                pushSettingsSnapshotToNative();
              })
              .catch((err) => console.warn("[NativeSettings] pick avatar failed:", err));
          },
          // native 设置窗占位 section「在旧版设置中打开」→ Electron 设置窗（hash 定位）
          openLegacySettings: (section?: string) => {
            windowManager.createSettingsWindow(section);
          },
          // native 设置窗「插件」section → .NET 插件管理窗；native 不可用/失败回退 Electron 插件区
          openPluginManager: () => {
            void spawnNativeWindow("plugins").then((ok) => {
              if (!ok) windowManager.createSettingsWindow("plugins");
            });
          },
          // WPF 设置窗若干 section 的动作（与渲染设置页同口径，见上方动作函数）
          apiAction: nativeApiAction,
          generalAction: nativeGeneralAction,
          memoryAction: nativeMemoryAction,
          pluginsAction: nativePluginsAction,
          schedulerAction: nativeSchedulerAction,
          // 语音：TTS（保存/试听/克隆/列表）+ ASR（保存）
          ttsAction: nativeTtsAction,
          asrAction: nativeAsrAction,
          // 「通用」section 便携模式：native 窗已完成迁移/覆盖确认（随 payload 下发），
          // 这里只执行；结果走通用 section 状态行反馈（成功路径 800ms 后应用重启）。
          cacheAction: (verb, payload) => {
            if (verb !== "set") return { ok: false, error: "unknown verb" };
            const dir = typeof payload.dir === "string" && payload.dir.trim() ? payload.dir.trim() : null;
            const current = loadGeneralSettings().cacheDirOverride ?? null;
            if ((dir ?? null) === current) {
              nativeNotice("general", "info", "缓存目录未变化");
              return { ok: true, changed: false, restartRequired: false };
            }
            saveGeneralSettings({ cacheDirOverride: dir ?? undefined });
            setCacheDirOverride(dir);
            nativeNotice("general", "ok", dir
              ? `缓存目录已更新（重启后完全生效）：${dir}`
              : "缓存目录已恢复默认策略（重启后完全生效）");
            return { ok: true, changed: true, restartRequired: true };
          },
          portableAction: (verb, payload) => {
            if (verb !== "apply") return;
            const choiceRaw = payload.migrationChoice;
            const migrationChoice =
              choiceRaw === "migrate" || choiceRaw === "switch" || choiceRaw === "cancel"
                ? choiceRaw
                : undefined;
            const request: PortableApplyRequest = {
              enabled: payload.enabled === true,
              dir: typeof payload.dir === "string" ? payload.dir : "",
              ...(migrationChoice ? { migrationChoice } : {}),
              ...(typeof payload.overwrite === "boolean" ? { overwrite: payload.overwrite } : {}),
            };
            void applyPortableChange(request).then((result) => {
              if (result.status === "applied") {
                nativeNotice("general", "ok", `数据目录已更新，应用即将重启：${result.targetDir}`);
              } else if (result.status === "cancelled") {
                nativeNotice("general", "info", "已取消");
              } else if (result.status === "noop") {
                nativeNotice("general", "ok", "数据目录未变化");
              } else {
                nativeNotice("general", "error", result.error);
              }
            });
          },
          // 「高级设置」section：超时（秒→ms）+ 工具并发
          runtimeAction: (verb, payload) => {            if (verb !== "save") return;
            const isBlank = payload.modelRequestTimeoutSec === null
              || payload.modelRequestTimeoutSec === undefined
              || payload.modelRequestTimeoutSec === "";
            const modelRequestTimeoutSec = isBlank
              ? undefined
              : (clampInt(payload.modelRequestTimeoutSec, 10, 600) ?? undefined);
            const choiceSec = clampInt(payload.userChoiceTimeout, 1, 3600);
            const parallel = clampInt(payload.maxParallelToolCalls, 1, 8);
            try {
              saveTimeoutSettings({
                ...(choiceSec !== null ? { userChoiceTimeout: choiceSec * 1000 } : {}),
                ...(modelRequestTimeoutSec === undefined
                  ? { modelRequestTimeoutSec: undefined }
                  : { modelRequestTimeoutSec }),
              });
              if (parallel !== null) saveGeneralSettings({ maxParallelToolCalls: parallel });
              nativeNotice("runtime", "ok", "运行设置已保存（后续请求/任务生效）");
            } catch (err) {
              nativeNotice("runtime", "error", `保存失败：${err instanceof Error ? err.message : String(err)}`);
            }
            pushSettingsSnapshotToNative();
          },
          // 「Token 用量」section：切换统计窗口 / 重置统计
          tokensAction: (verb, payload) => {
            if (verb === "set-days") {
              nativeTokenDays = clampInt(payload.days, 1, 90) ?? 7;
              pushSettingsSnapshotToNative();
              return;
            }
            if (verb === "clear") {
              clearUsage();
              nativeNotice("tokens", "ok", "用量统计已重置");
              pushSettingsSnapshotToNative();
            }
          },
          // 「偏好设置」section：打开自定义 Prompt 文件（旧版 settings.ts 同口径：
          // 确保文件存在后在资源管理器中定位）
          preferencesAction: (verb) => {
            if (verb !== "open-prompt") return;
            try {
              const filePath = ensureCustomStylePrompt();
              electronShell.showItemInFolder(filePath);
              nativeNotice("preferences", "ok", "已在资源管理器中定位自定义 Prompt 文件");
            } catch (err) {
              nativeNotice("preferences", "error", `打开失败：${err instanceof Error ? err.message : String(err)}`);
            }
          },
          // 「昔涟设置」section：状态栏实时更新 + 表情包 + RAG（阶段 2）。
          // 与渲染页 saveConfig 同源（saveModelSettings + model-config 广播）；
          // reranker 模式变更后重新 initReranker（与 RERANKER_SET_MODE IPC 同口径）。
          cyreneAction: (verb, payload) => {
            if (verb === "save") {
              const patch = sanitizeNativeCyreneSave(payload);
              if (!patch) return;
              try {
                saveModelSettings(patch);
                broadcastModelChanged();
                if (patch.rerankerMode) {
                  const mode = patch.rerankerMode;
                  void import("../rag/reranker")
                    .then(({ initReranker }) => initReranker(mode))
                    .then(() => nativeNotice("cyrene", "ok", `重排序已${mode === "none" ? "关闭" : "开启（bge-reranker-base）"}`))
                    .catch((err) =>
                      nativeNotice("cyrene", "error", `重排序初始化失败：${err instanceof Error ? err.message : String(err)}`));
                }
              } catch (err) {
                nativeNotice("cyrene", "error", `保存失败：${err instanceof Error ? err.message : String(err)}`);
              }
              return;
            }
            if (verb === "open-sticker-manager") {
              windowManager.createStickerManagerWindow();
              return;
            }
            // RAG 模型操作（打开说明/目录/下载站、体检、删除缓存）：
            // 与渲染端 IPC（settings:cyrene-model-action）共用 runCyreneModelAction。
            const modelAction = verb === "open-model-docs"
              ? "open-docs"
              : verb === "open-model-dir"
                ? "open-dir"
                : verb === "open-model-site"
                  ? "open-site"
                  : verb;
            if (
              modelAction === "open-docs" ||
              modelAction === "open-dir" ||
              modelAction === "open-site" ||
              modelAction === "open-model-downloader" ||
              modelAction === "check-model-update" ||
              modelAction === "delete-embedding"
            ) {
              void runCyreneModelAction(modelAction).then((result) => {
                nativeNotice(
                  "cyrene",
                  result.ok ? "ok" : "error",
                  result.ok ? (result.message ?? "完成") : (result.error ?? "操作失败"),
                );
              });
              return;
            }
            if (verb === "add-sticker") {
              const parsed = sanitizeNativeStickerAdd(payload);
              if (!parsed.ok) {
                nativeNotice("cyrene", "error", `添加失败：${parsed.error}`);
                return;
              }
              void addUserSticker(
                parsed.payload.sourcePath,
                parsed.payload.id,
                parsed.payload.description,
                parsed.payload.phrases,
              )
                .then(() => {
                  stickerEmbeddingIndexService?.invalidateStickerEmbeddingIndex();
                  stickerEmbeddingIndexService?.refreshStickerEmbeddingIndex("user-sticker-add");
                  nativeNotice("cyrene", "ok", `表情包已添加：${parsed.payload.id}`);
                })
                .catch((err) => {
                  nativeNotice("cyrene", "error", `添加失败：${err instanceof Error ? err.message : String(err)}`);
                });
            }
          },
          // 渠道配置独立弹窗（Electron，用户指定渠道不迁 .NET）
          openChannelsWindow: () => windowManager.createSettingsWindow("channels"),
          // 界面字体导入/恢复（Electron 设置页同口径；宿主弹框/清文件）
          uiFontAction: (verb) => {
            const fontDeps = {
              getGeneralSettings: loadGeneralSettings,
              saveGeneralSettings,
            };
            if (verb === "import") {
              void pickAndImportUiFont(fontDeps).then((result) => {
                if (result.canceled) return;
                nativeNotice(
                  "appearance",
                  result.ok ? "ok" : "error",
                  result.ok ? `字体已导入：${result.displayName ?? ""}` : `导入失败：${result.error ?? "未知错误"}`,
                );
                pushSettingsSnapshotToNative();
              });
              return;
            }
            const result = resetUiFont(fontDeps);
            nativeNotice(
              "appearance",
              result.ok ? "ok" : "error",
              result.ok ? "已恢复默认字体" : `恢复失败：${result.error ?? "未知错误"}`,
            );
            pushSettingsSnapshotToNative();
          },
          // .NET 插件管理窗操作：manager/market 运行期引用（startPlugins 之后可用）
          pluginAction: async (action, id, payload) => {
            const manager = pluginManager;
            const market = getPluginMarketService();
            // 运行时总开关动态起停（.NET 管理窗「未启用」提示条触发）：
            // 记忆开关状态（写回 pluginRuntimeEnabled），与渲染端插件页共用实现
            if (action === "enable-runtime" || action === "disable-runtime") {
              const result = action === "enable-runtime"
                ? await pluginRuntimeShell.enable()
                : await pluginRuntimeShell.disable();
              if (!result.ok) setPluginNotice("error", result.error ?? "插件运行时操作失败");
              await pushPluginsSnapshotToNative(async () => buildPluginSnapshot());
              return;
            }
            // 资源限制（「设置」页）：不依赖插件运行时是否启用，直接持久化设置
            if (action === "set-limits") {
              const storage = clampInt(payload?.storageQuotaMb, 0, MAX_PLUGIN_STORAGE_QUOTA_MB);
              const memory = clampInt(payload?.memoryLimitMb, 0, MAX_PLUGIN_MEMORY_LIMIT_MB);
              if (storage === null || memory === null) {
                setPluginNotice(
                  "error",
                  `资源限制参数非法：存储 0-${MAX_PLUGIN_STORAGE_QUOTA_MB} / 内存 0-${MAX_PLUGIN_MEMORY_LIMIT_MB}（MiB 整数）`,
                );
              } else {
                saveGeneralSettings({ pluginStorageQuotaMb: storage, pluginMemoryLimitMb: memory });
                setPluginNotice("ok", "资源限制已保存（存储配额对后续启动/重启的插件生效）");
              }
              await pushPluginsSnapshotToNative(async () => buildPluginSnapshot());
              return;
            }
            if (!manager) return;
            try {
              if (action === "enable" && id) {
                await manager.setEnabled(id, true);
                setPluginNotice("ok", "已启用");
              } else if (action === "disable" && id) {
                await manager.setEnabled(id, false);
                setPluginNotice("ok", "已停用");
              } else if (action === "uninstall" && id) {
                await manager.uninstall(id);
                setPluginNotice("ok", "已卸载");
              } else if (action === "install" && id) {
                if (!market) {
                  setPluginNotice("error", "插件市场服务不可用");
                } else {
                  // 先推「安装中」快照：下载可能持续数十秒，按钮与状态行立即有反馈
                  //（历史 bug：安装期间无任何快照，失败后按钮悄悄回弹＝「静默失败」）
                  nativeInstallingIds = [id];
                  setPluginNotice("ok", `正在安装：${id} …`);
                  await pushPluginsSnapshotToNative(async () => buildPluginSnapshot());
                  try {
                    const result = await market.installFromMarket(id);
                    setPluginNotice(
                      result.ok ? "ok" : "error",
                      result.ok ? `已安装：${result.plugin.name} ${result.plugin.version}` : `安装失败：${result.error}`,
                    );
                  } finally {
                    nativeInstallingIds = [];
                  }
                }
              } else if (action === "refresh") {
                // 重扫插件目录 + 重拉市场索引（旧版插件页的「刷新」）
                await manager.rescan();
                setPluginNotice("ok", "已刷新（插件目录 + 市场索引）");
              } else if (action === "import-zip") {
                // 旧版插件页的「导入 ZIP」：宿子弹文件框 → 管理器走同一
                // 校验/身份记录管线；成功后重扫并重推快照
                const zipPath = await pickPluginZipFile();
                if (!zipPath) return; // 用户取消
                const result = await manager.installZip(zipPath);
                if (result.canceled) return; // 覆盖确认框取消
                const imported = result.plugin ? `${result.plugin.name} ${result.plugin.version}` : "插件";
                setPluginNotice(
                  result.ok ? "ok" : "error",
                  result.ok ? `已导入：${imported}` : `导入失败：${result.error ?? "未知错误"}`,
                );
              } else if (action === "openWindow" && id) {
                // 插件自有窗口（.NET 轨 = 子进程 WPF；Node 轨 = 宿主 BrowserWindow）
                const result = await manager.open(id);
                if (!result.ok) console.warn("[PluginNative] openWindow failed:", id, result.error);
              } else if (action === "openPanel") {
                // 插件运行时面板归 Electron（首版宿主=设置窗插件 section）
                windowManager.createSettingsWindow("plugins");
                return;
              }
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              setPluginNotice("error", `操作失败：${message}`);
              console.warn("[PluginNative] action failed:", action, id, err);
            }
            // 完成后重推快照（installed ± market 索引；与 spawn 初始推送同一构建器）。
            // 刷新策略：进入推一次 + 插件操作后重推（此处，保留）+ 窗内「刷新」
            // 手动重推；不做定时轮询。
            await pushPluginsSnapshotToNative(async () => buildPluginSnapshot());
          },
        });
      },

createTray: (input) => {
        // 分离托盘（默认优先；CYRENE_DETACHED_TRAY=0 关闭）：
        // 托盘进程在跑（pipe 存在）→ 外部托盘；否则回退内置 Electron Tray
        if (process.env.CYRENE_DETACHED_TRAY !== "0") {
          const detached = connectDetachedTray({
            requestActivation: input.requestActivation,
            togglePetWindow: input.togglePetWindow,
            setPetDragMode: (enabled) => input.setPetDragMode?.(enabled) ?? false,
            quit: () => app.quit(),
          });
          if (detached) return detached;
        }
        return createTray({
          togglePetWindow: input.togglePetWindow,
          requestActivation: input.requestActivation,
          setPetDragMode: (enabled) => input.setPetDragMode?.(enabled) ?? false,
          quit: () => app.quit(),
        });
      },
      flushTokenUsage,
    }),

    startCore: (shell) => {
      // 插件管理壳/运行时与核心 IPC 共用应用级 scope：运行期动态启用时
      // removeHandler / 二次 handle 才能命中同一注册表（否则 plugins:list
      // 回退残留，PluginManager.start() 注册正式实现时抛 second handler）。
      shellIpc = shell.ipc;
      return startCore({
      shell,
      readiness,
      activation,
      shutdown,
      minimumSplashMs: SPLASH_MIN_MS,
      markStartupWindowsReady: () => markStartupPhaseReady(),
      getAppVersion: () => app.getVersion(),
      getTimeoutSettings: () => getTimeoutSettings(),
      // 便携模式 / 数据目录（通用 section 快照）
      getPortableStatus: () => getPortableDataLocationStatus(),
          getCacheDirStatus: () => {
            try {
              const { resolveCacheDir } = require("../cache-dir") as typeof import("../cache-dir");
              const { loadGeneralSettings: lgs } = require("../settings/settings-facade") as typeof import("../settings/settings-facade");
              const { getPortableDataLocationStatus: gps } = require("../portable/portable-runtime") as typeof import("../portable/portable-runtime");
              return {
                effectiveDir: resolveCacheDir(),
                override: lgs().cacheDirOverride ?? null,
                portableActive: gps().enabled,
              };
            } catch {
              return { effectiveDir: "", override: null, portableActive: false };
            }
          },

      // 升级迁移：NSIS 暂存的安装目录用户内容合并进 userData，
      // 必须在任何 prompts/skills 读取（initSkills、prompt 加载）之前执行
      migrateStagedExternalContent: () => migrateStagedExternalContent({
        isPackaged: app.isPackaged,
        ...getExternalContentPaths(),
      }),
      // Skill 系统：扫描双源 skills + 注册 meta-tool
      initSkills,

      createLowCostServices: () => {
        const runtimeStateService = createRuntimeStateService();
        runtimeStateService.onChange(() => {
          broadcastToAuxWindows(IPC.RUNTIME_STATE_CHANGED, runtimeStateService.getState());
        });

        const llmClient = createLlmClient();
        const ttsSynthesisService = createTtsSynthesisService();
        const embeddingIndexService = createEmbeddingIndexService();
        // Moments 配图：贴图 embedding 索引 getter 晚绑定给 moments-service 模块单例（索引未就绪时纯文字降级）
        registerMomentsMediaMatcher({
          getStickerIndex: () => embeddingIndexService.getStickerEmbeddingIndex(),
        });
        const citaService = createCitaService({ llmClient });
        const socialContextService = createSocialContextService({ llmClient, enqueueLLMTask });
        const proactiveLifecycle = createProactiveLifecycle({
          loadGeneralSettings,
          // runReader 接入 harness 运行存储：孤儿工具按运行状态归类，避免误判 not_executed
          conversationJournal: new ConversationJournalService({
            store: getConversationTranscriptStore(app.getPath("userData")),
            runReader: getHarnessRunStore(app.getPath("userData")),
          }),
        });
        // 主动聊天服务初始化是纯装配；触发器由 background 阶段启动
        proactiveLifecycle.initializeProactiveChatService();

        // 崩溃对账：启动时对进程崩溃遗留的 interrupted run 幂等补写 crashed 中断边界。
        // 异步、失败仅日志，不阻塞启动关键路径；两 store 单例在此刻均已就绪。
        void reconcileCrashedInterruptions({
          runStore: getHarnessRunStore(app.getPath("userData")),
          transcriptStore: getConversationTranscriptStore(app.getPath("userData")),
          now: Date.now,
        }).then((result) => {
          if (result.written > 0) {
            console.log(`[CrashReconcile] 补写 ${result.written} 条崩溃边界，跳过 ${result.skipped} 个已有边界的中断 run`);
          }
        }).catch((error) => {
          console.error("[CrashReconcile] 崩溃对账失败（仅日志，不阻塞启动）:", error);
        });

        const ttsSessionService = new TtsSessionService((request, signal, emit) =>
          ttsSynthesisService.synthesizeSession(request, signal, emit),
        );

        // 应用图标 getter 已在工厂体开头注入（早于 shell 阶段的窗口壳/托盘创建）。

        // 内置工具配置 getter
        bootstrapConfigGetters({
          loadGeneralSettings,
          getSceneEmbeddingIndex: () => embeddingIndexService.getSceneEmbeddingIndex(),
        });

        // Locale Context（从 GeneralSettings 的语言配置同步）
        const generalSettings = loadGeneralSettings();
        updateLocaleContext({
          uiLocale: generalSettings.language,
          dateLocale: generalSettings.language,
          asrLanguage: generalSettings.asrLanguage,
        });

        // Live2D 桌宠窗口发送器
        setLive2dWindowSender((channel, payload) => shell.windowManager.sendToPetWindow(channel, payload));

        // Git：服务对象预创建；仓库监听只在打开仓库后启动
        // 探测结果在进程内缓存：成功过一次就不再重复探测，避免启动高峰期
        // 偶发超时导致 Git 面板误报"未检测到可用 Git"；探测失败不缓存，下次自动重试
        let resolvedGit: ResolvedGitExecutable | null = null;
        const git = createGitService({
          getSession: chatsStore.getSessionRecord,
          resolveExecutable: async () => {
            resolvedGit ??= await resolveGitExecutable({
              systemCommand: "git",
              bundledPath: app.isPackaged
                ? path.join(process.resourcesPath, "mingit", "cmd", "git.exe")
                : path.join(app.getAppPath(), "resources", "mingit", "cmd", "git.exe"),
            });
            return resolvedGit;
          },
          // 提交身份来自设置（内置 git 禁全局配置，不注入则 commit 会失败）
          getCommitIdentity: () => {
            const settings = loadGeneralSettings();
            return {
              name: settings.gitCommitAuthorName,
              email: settings.gitCommitAuthorEmail,
            };
          },
        });

        // LSP：管理器预创建；具体语言服务进程按需启动
        const lsp = new LspManager({
          getServerOverrides: () => loadGeneralSettings().lspServerOverrides,
        });

        // 截图：原生 helper IPC、全局热键。预热在 background 阶段执行。
        const initialSettings = loadGeneralSettings();
        const screenshot = initializeScreenshotService({
          initialHotkey: initialSettings.screenshotHotkey ?? "Alt+Shift+S",
          initialBackend: initialSettings.screenshotBackend ?? "builtin",
          initialSnipastePath: initialSettings.snipastePath ?? "",
          getReactChatWindow: () => reactChatWindow,
          capturePetWindow: () => shell.windowManager.capturePetWindow(),
          ipc: shell.ipc,
        });

        // 应用更新服务（检查/下载按需；安装必须先走受控退出）
        const update = createGitHubAppUpdateService({
          currentVersion: app.getVersion(),
          isPackaged: app.isPackaged,
        });

        return {
          runtimeState: runtimeStateService,
          llm: llmClient,
          cita: citaService,
          social: socialContextService,
          tts: ttsSynthesisService,
          ttsSession: ttsSessionService,
          embedding: embeddingIndexService,
          proactive: proactiveLifecycle,
          git,
          lsp,
          screenshot,
          update,
        };
      },

      // SRT 沙箱初始化（检测安装状态，不弹 UAC）：必须在 registerAllTools 前，
      // 让 run_shell 的 workspace_mutation 分支能用上沙箱。失败不阻塞启动。
      initSandbox: () => initSandbox(),

      initPlanMode: () => {
        const plansRoot = path.join(app.getPath("userData"), "plans");
        // 计划模式路径根注入：write_plan / plan.md 读写基于 userData/plans/<会话键>/
        initPlanPaths(app.getPath("userData"));
        // 状态持久化（durable transition）：同步写盘，approvePlan 返回时 state.json 已落盘，
        // 崩溃恢复不丢"执行正在进行"的事实；null = 回 NORMAL，删除 state.json 清尸
        initPlanStatePersister((conversationId, snapshot) => {
          const stateFile = path.join(plansRoot, encodePlanSessionKey(conversationId), "state.json");
          if (!snapshot) {
            fs.rmSync(stateFile, { force: true });
            return;
          }
          fs.mkdirSync(path.dirname(stateFile), { recursive: true });
          fs.writeFileSync(stateFile, JSON.stringify(snapshot, null, 2), "utf8");
        });
        // 计划模式状态广播：所有状态切换都广播到所有窗口
        initPlanStateBroadcaster((conversationId, state) => {
          const payload = { conversationId, state };
          for (const win of BrowserWindow.getAllWindows()) {
            win.webContents.send(IPC.PLAN_STATE_CHANGED, payload);
          }
        });
        // 启动崩溃恢复：非 NORMAL 快照统一降级 PLAN_DISCUSSING，不自动恢复执行权
        recoverInterruptedPlanSessions(plansRoot);
      },

      // 工具注册：集中到一个显式入口（依赖沙箱/Git/LSP 就绪）
      registerAllTools: (services) => registerAllTools({ codeGitService: services.git, lspManager: services.lsp }),

      initRag: async () => {
        const modelSettings = loadModelSettings();
        await initRAG("auto", undefined, undefined, modelSettings.embeddingModel, modelSettings.embeddingDimensions);
        // 注册 RAG 落盘（上游 2026-09-24 语义）：受控退出在 flushPersistence
        // 阶段刷盘；Windows 会话结束（断电/强制关机）走同步紧急落盘兜底
        shutdown.register({
          id: "rag-store",
          phase: "flushPersistence",
          dispose: async () => { await flushRAGStore(); },
        });
        shutdown.registerEmergencyFlush("rag-store", () => flushRAGStoreSync());
        logger.info(LogTag.RAG, "RAG initialized OK");
      },

      createRuntime: (services) => {
        const transcriptCompactor = getTranscriptCompactor();
        return createAgentRuntime({
          runtimeStateService: services.runtimeState,
          llmClient: services.llm,
          enqueueLLMTask,
          loadModelSettings,
          loadGeneralSettings,
          loadUserProfile,
          toolRegistry,
          skillRegistry,
          getStickerEmbeddingIndex: () => services.embedding.getStickerEmbeddingIndex(),
          getSceneEmbeddingIndex: () => services.embedding.getSceneEmbeddingIndex(),
          getSceneEmbeddingProvider,
          getEmbeddingProvider,
          broadcastRuntimeStateChanged: () => {
            broadcastToAuxWindows(IPC.RUNTIME_STATE_CHANGED, services.runtimeState.getState());
          },
          citaService: services.cita,
          socialContextScheduler: services.social.scheduler,
          chatsStore,
          socialAtomStore: services.social.store,
          buildPluginPromptContext: (input) => pluginPromptRegistry.build(input),
          publishPluginHostEvent: (event, payload) => pluginManager
            ? pluginManager.publishHostEvent(event, payload)
            : Promise.resolve(),
          publishToolFinished: (event) => lifecyclePublisher.publishToolFinished(event),
          transcriptCompactor,
        });
      },

      createChannels: (runtime, services) => createChannelsSubsystem({
        agentRuntime: runtime,
        ttsSynthesisService: services.tts,
        getReactChatWindow: () => reactChatWindow,
        ipc: shell.ipc,
        publishLifecycle: lifecyclePublisher,
      }),

      startPlugins: async (services, scheduler, runtime) => {
        // 插件运行时总开关（默认关）：跳过整个插件系统（manager/market）。
        // lastPluginArgs 供运行期动态启动（管理页/管理窗）；管理壳 IPC（状态/
        // 启停/资源限制）常驻注册，保证运行时未启用时管理页也能正常打开。
        lastPluginArgs = [services, scheduler, runtime];
        pluginRuntimeShell.registerControlIpc();
        if (!loadGeneralSettings().pluginRuntimeEnabled) {
          logger.info(LogTag.Runtime, "plugin runtime disabled by settings, skipping");
          pluginRuntimeShell.registerListFallback();
          return null;
        }
        return startPluginsImpl(services, scheduler, runtime);
      },

      // native 三件套数据源绑定（core 阶段调用；未启用时 no-op）。
      // ⚠️ 该键曾在合并 ffc6322dd 中整体丢失（原生窗拿不到数据），勿删。
      // 这里同时装饰设置窗快照：core 提供 general+user，本层拼上
      // api/memory/tasks 三个 section（数据源持有运行期引用，见上方动作函数）。
      bindNativeData: (providers) => bindNativeDataProviders({
        ...providers,
        getSettingsSnapshot: providers.getSettingsSnapshot
          ? async () => {
              const base = (await providers.getSettingsSnapshot!()) as Record<string, unknown>;
              const modelSettings = loadModelSettings();
              const actions = nativeSchedulerActions;
              return {
                ...base,
                api: buildApiSectionSnapshot(
                  modelSettings,
                  listSavedModelProfiles(modelSettings),
                  getTimeoutSettings().testTimeout,
                ),
                // 记忆读取失败不再让整个快照失败：带 error 键下发给 WPF 显示错误行
                memory: await (async () => {
                  try {
                    return buildMemorySectionSnapshot(await loadMemoryPanelData(), getMemoryVaultConfig());
                  } catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    console.warn("[NativeSettings] memory snapshot failed:", message);
                    return buildMemorySectionSnapshot(
                      { l0: {}, l1: {}, l2: [], importedDocs: [], reflections: [] },
                      getMemoryVaultConfig(),
                      message,
                    );
                  }
                })(),
                tasks: buildSchedulerSectionSnapshot(
                  actions?.list().value ?? [],
                  actions?.getTools().value ?? [],
                  currentPluginRunning(),
                  nativeTaskHistory,
                ),
                tokens: buildTokensSectionSnapshot(getUsageReport(nativeTokenDays), nativeTokenDays),
                // 插件 / 内置工具配置 + 文件访问档位
                plugins: buildPluginsSectionSnapshot(loadGeneralSettings(), getCurrentLevel()),
                // 昔涟设置（阶段 1+2）：状态栏实时更新 + 表情包发送 + RAG 模型
                cyrene: buildCyreneSectionSnapshot(modelSettings, getModelInstallStatus(), getProjectModelsDir()),
                // 语音：TTS / ASR 设置（旧页字段，读方向与渲染页 loadTtsConfig/loadAsrConfig 同口径）
                tts: buildTtsSectionSnapshot(loadGeneralSettings()),
                asr: buildAsrSectionSnapshot(loadGeneralSettings(), runningSpeechInputPlugins()),
              };
            }
          : undefined,
      }),
      /** 模型公开配置（native sidebar 模型区订阅用）。 */
      getPublicModelConfig: () => getPublicModelConfig(),
      /** .NET 插件管理窗快照（已装 + 市场索引）。 */
      getPluginsSnapshot: () => buildPluginSnapshot(),

      createScheduler: (runtime) => {
        const subsystem = createSchedulerSubsystem({
          agentRuntime: runtime,
          getReactChatWindow: () => reactChatWindow,
          ipc: shell.ipc,
          publishLifecycle: lifecyclePublisher,
          // runReader 接入 harness 运行存储：孤儿工具按运行状态归类，避免误判 not_executed（上游 2026-09-24 语义）
          conversationJournal: new ConversationJournalService({
            store: getConversationTranscriptStore(app.getPath("userData")),
            runReader: getHarnessRunStore(app.getPath("userData")),
          }),
          getActiveConversation: () => activeConversationRegistry.getMostRecent(),
          // 插件任务只有在所属插件运行中才允许触发；用户任务不受影响。
          canRunTask: (task) => !task.ownerPluginId
            || (pluginManager?.isRunning(task.ownerPluginId) ?? false),
        });
        // native 设置窗「定时任务」动作与快照共用同一动作层（与 scheduler IPC 行为一致）
        nativeSchedulerActions = createSchedulerActions({
          store: subsystem.store,
          engine: subsystem.engine,
          getTools: () => toolRegistry.getAllTools(),
        });
        return subsystem;
      },

      registerCoreIpc: ({ ipc, runtime, services }) => {
        const transcriptCompactor = getTranscriptCompactor();
        // native 昔涟 section「添加表情包」需要刷新贴图向量索引（IPC 同源）
        stickerEmbeddingIndexService = services.embedding;
        // 设置变更反应：窗口/托盘/截图热键/主动服务联动
        onGeneralSettingsChanged((before, after) =>
          handleGeneralSettingsChanged(before, after, {
            windowManager: shell.windowManager,
            tray: shell.tray,
            screenshotService: services.screenshot,
            proactiveLifecycle: services.proactive,
            broadcastToAuxWindows,
            // 圆角变更同步 .NET 原生窗（Electron 侧走 UI_WINDOW_CORNER_RADIUS_CHANGED）
            onWindowCornerRadiusChanged: (radius) => pushWindowRadiusToNative(radius),
          }),
        );

        registerSettingsIpc({
          ipc,
          windowManager: shell.windowManager,
          getGeneralSettings: loadGeneralSettings,
          saveGeneralSettings,
          getModelSettings: loadModelSettings,
          saveModelSettings,
          runtimeStateService: services.runtimeState,
          proactiveLifecycle: services.proactive,
          reconcileUserMemoryIndex,
          embeddingIndexService: services.embedding,
          syncVolcanoSearchMcp,
          syncPlaywrightMcp,
          syncFilesystemMcp,
        });

        // 便携模式：数据目录迁移/覆盖 + 重启（指针文件在程序目录）
        registerPortableIpc({
          ipc,
          getParentWindow: () => settingsWindow,
        });

        // 缓存目录（数据/缓存分离）：查询/选择/覆盖设置
        registerCacheDirIpc({
          ipc,
          getParentWindow: () => settingsWindow,
        });

        // OCR 设置：本地引擎可用性 + 语言列表查询（写入走 save-general）
        registerOcrIpc({ ipc });

        // 云存储设置：档案列表/保存/删除/测试连接（连接与凭据在 --storage-host）
        registerCloudStorageIpc({ ipc });

        // 昔涟设置：RAG 模型操作（渲染端 IPC；与 native cyreneAction 共用实现）
        ipc.handle(IPC.SETTINGS_CYRENE_MODEL_ACTION, (_event, verb: unknown) =>
          runCyreneModelAction(typeof verb === "string" ? verb : ""));

        // 项目公告：渲染端首次打开时拉一次，之后主进程每 6 小时对一次版本
        registerNewsIpc(ipc);

        registerMemoryUserToolIpc({
          ipc,
          windowManager: shell.windowManager,
          embeddingIndexService: services.embedding,
        });

        // ── TTS IPC ──
        registerTtsIpc({ ipc, ttsSessionService: services.ttsSession });

        // 聊天会话存储 IPC（chats-store.initialize 建好 cyrene-chats 目录并加载 index）
        registerChatsIpc(ipc, {
          llmClient: services.llm,
          isPrimaryModelBusy: hasActiveConversationRun,
          transcriptCompactor,
        });
        registerMomentsIpc(ipc);
        registerCodeGitIpc({ ipc, service: services.git });
        // 会话工作区只读文件（右侧面板文件树 / 预览）
        registerWorkspaceFilesIpc(ipc);
        // 工作区右上角"打开"菜单：本机应用探测 + 打开执行
        registerOpenInAppIpc(ipc);
        const examPaperStore = createExamPaperStore(app.getPath("userData"));
        const browserPanel = registerBrowserPanelIpc({
          ipc,
          getWindow: () => reactChatWindow,
          getExamRecord: (examId) => examPaperStore.get(examId),
        });
        shutdown.register({
          id: "browser-panel-session",
          phase: "flushPersistence",
          dispose: async () => { await browserPanel.persistSessionForShutdown(); },
        });

        // AG-UI 事件流桥：渲染进程 invoke(AGUI_RUN) → CyreneAgent 跑 Agent 循环 → 事件透传
        registerAgUiIpc(
          (input) => runtime.buildOptions(input),
          (result, latestUserText, context) => runtime.onRunFinished(result, latestUserText, context),
          () => reactChatWindow,
          services.proactive.proactiveConversationLifecycle,
          ipc,
          pendingTurnLifecycle,
        );

        // 应用更新 IPC：安装走受控退出；autoUpdater 兜底路径进入同一协调器
        registerAppUpdateIpc({
          ipc,
          service: services.update,
          requestControlledShutdown: (input) => shutdown.requestControlledShutdown(input),
        });
        installUpdateShutdownFallback({
          updater: autoUpdater as unknown as UpdateLifecycleLike,
          coordinator: shutdown,
          finalAction: () => services.update.install(),
        });

        // 计划模式开关/查询 IPC
        ipc.handle(IPC.PLAN_SET_MODE, (_event, payload: { conversationId?: string; target?: "on" | "off"; workspaceRoot?: string }) => {
          const conversationId = payload?.conversationId;
          const target = payload?.target;
          if (!conversationId) return { ok: false, reason: "缺少 conversationId" };
          if (target !== "on" && target !== "off") return { ok: false, reason: "target 必须是 on/off" };
          const current = getPlanState(conversationId);
          if (target === "on") {
            if (current !== "NORMAL") return { ok: true, state: current }; // 已激活：no-op
            const t = enterPlanDiscussing(conversationId, payload.workspaceRoot);
            if (!t.ok) return { ok: false, reason: t.reason, state: current };
            return { ok: true, state: getPlanState(conversationId) };
          }
          // target === "off"
          if (current === "EXECUTING") {
            return { ok: false, reason: "计划执行中，不可手动退出", state: current };
          }
          if (current === "NORMAL") return { ok: true, state: current };
          exitPlanMode(conversationId);
          return { ok: true, state: getPlanState(conversationId) };
        });
        ipc.handle(IPC.PLAN_GET_STATE, (_event, payload: { conversationId?: string }) => {
          const conversationId = payload?.conversationId;
          if (!conversationId) return { state: "NORMAL" as const };
          return { state: getPlanState(conversationId) };
        });

        // 权限模块：磁盘加载 + 权限/选择卡片 IPC（必须在 createWindow 之后、任意工具调用之前）
        bootstrapPermission(ipc);
        // pop_quiz 抽查工具：IPC（提交/跳过）与工具注册（learn 模式可见）
        registerPopQuizIpc(ipc);
        registerPopQuizTool();
        // 正式试卷：答案与评分资料仅由主进程存储；Learn 工具负责出卷、取卷批改与保存结果。
        const examDraftStore = createExamDraftStore(app.getPath("userData"), examPaperStore);
        void examDraftStore.deleteExpired().catch((error) => {
          console.warn("[LearnExam] 清理过期出卷草稿失败:", error);
        });
        void examPaperStore.recoverInterruptedGrading().catch((error) => {
          console.warn("[LearnExam] 恢复中断批改状态失败:", error);
        });
        registerExamPaperIpc(examPaperStore, ipc);
        registerLearnExamPageIpc(examPaperStore, ipc);
        registerLearnExamTools(examPaperStore, examDraftStore);
        registerCallIpc(ipc);
      },

      loadGeneralSettings,
      loadUserProfile,
      applyGeneralSettings: (settings, services) => applyGeneralSettings(settings, {
        windowManager: shell.windowManager,
        tray: shell.tray,
        screenshotService: services.screenshot,
        proactiveLifecycle: services.proactive,
        broadcastToAuxWindows,
      }),
      wireToastCenter: ({ ipc, windowManager }) => {
        // 提醒中心组合根：窗口控制器 + 生命周期权威服务 + 事件总线订阅
        // 窗口按需创建（默认）：首个 toast 才建窗+载页，队列空 30s 后回收
        // （启动零 toast 渲染进程，常驻 Chromium 渲染进程 -1）；
        // CYRENE_LAZY_TOAST_WINDOW=0 恢复急切模式（启动预热 + 常驻不销毁）。
        const eagerToastWindow = process.env.CYRENE_LAZY_TOAST_WINDOW === "0";
        const toastWindowController = createToastWindowController({
          createWindow: createToastWindowShell,
          getChatWindow: () => reactChatWindow,
          getDisplayMatching: (bounds) => screen.getDisplayMatching(bounds),
          getCursorScreenPoint: () => screen.getCursorScreenPoint(),
          idleTeardownMs: eagerToastWindow ? null : undefined,
        });
        const toastService = createToastService({
          bus: toastEvents,
          window: toastWindowController,
          activate: (request) => { activation.request(request); },
          openTasksWindow: () => { windowManager.createTasksWindow(); },
          // 音效总开关：设置页可关；每次弹窗时读取，改动即时生效
          isSoundEnabled: () => loadGeneralSettings().toastSoundEnabled,
          shouldSuppressNotify: (event) => {
            // 焦点抑制三条件：事件带会话 + 聊天窗口聚焦 + 激活会话一致。
            // 调度任务结果落在任务历史（无会话落点），恒不抑制。
            if (!event.sessionId) return false;
            const chat = reactChatWindow;
            if (!chat || chat.isDestroyed() || !chat.isFocused()) return false;
            return getActiveChatSessionId() === event.sessionId;
          },
          // 系统级通知：无任何 Cyrene 窗口聚焦时补一条 Windows 托盘气泡，
          // 用户在其他应用里也不错过「等待批准 / 任务完成」。
          // 内置 Tray 与分离托盘都实现 displayBalloon；托盘不可用则静默跳过。
          notifySystem: (item) => {
            if (BrowserWindow.getFocusedWindow()) return;
            showTrayBalloon(shell.tray, {
              title: item.title,
              content: item.summary ?? "",
            });
          },
        });
        toastService.registerIpc(ipc);
        if (eagerToastWindow) {
          // 预创建隐藏窗口，提前加载渲染页，首次弹出零延迟（急切模式）
          toastWindowController.preload();
        }
        shutdown.register({
          id: "toast-center",
          phase: "stopLocalResources",
          dispose: async () => {
            toastService.dispose();
            toastWindowController.dispose();
          },
        });
      },
      revealStartupWindows,
      });
    },

    startBackground: (core) => startBackground({
      core,
      readiness,
      shutdown,
      channels: core.channels,
      scheduler: core.scheduler,
      pruneRemovedMcp: async () => {
        // 一次性清理已下架的内置 MCP（Firecrawl hosted 等）
        const removed = await pruneMcpServersByIds([...REMOVED_BUILTIN_MCP_IDS]);
        if (removed.length > 0) {
          console.log("[Cyrene] 已清理遗留的已下架内置 MCP:", removed.join(", "));
        }
      },
      syncBuiltInMcp: async () => {
        // 内置 MCP 自动连接：Playwright / Filesystem（均默认关闭，选项控制）
        await syncPlaywrightMcp(loadGeneralSettings());
        await syncFilesystemMcp({
          filesystemMcpEnabled: loadGeneralSettings().filesystemMcpEnabled,
          allowedDir: app.getPath("downloads"),
        });
      },
      restoreMcp: (signal) => initMcpManager({ signal }),
      reconcileMemory: async (signal) => {
        if (signal.aborted) return;
        try {
          await reconcileUserMemoryIndex();
        } catch (err) {
          console.warn("[Memory/RAG] startup reconciliation failed:", err);
          throw err;
        }
      },
      scheduleEmbeddingRefresh: async () => {
        core.services.embedding.scheduleStartupRefreshes();
      },
      initializeReranker: async () => {
        // initReranker 内部检测模型是否安装，未安装自动降级为 none
        try {
          const { initReranker } = await import("../rag/reranker");
          const modelSettings = loadModelSettings();
          await initReranker(modelSettings.rerankerMode);
          logger.info(LogTag.Reranker, "initialized with mode:", modelSettings.rerankerMode);
        } catch (err) {
          logger.warn(LogTag.Reranker, "startup init failed:", err);
        }
      },
      prewarmScreenshot: async () => {
        await core.services.screenshot.prewarm();
      },
      scheduleUpdateCheck: async () => {
        const dispose = scheduleStartupUpdateCheck(core.services.update);
        return { dispose };
      },
      startProactiveTrigger: async () => {
        core.services.proactive.initializeProactiveTrigger();
        return { dispose: () => core.services.proactive.stopProactiveTrigger() };
      },
      startMomentsReactionScanner: async () => {
        // 启动即补扫一轮：重启前已逾期的反应任务尽快续上，不等第一个扫描周期
        momentsService.startReactionScanner();
        return { dispose: () => momentsService.stopReactionScanner() };
      },
    }),

    logFatal: (error) => {
      console.error("[Cyrene] fatal startup error:", error);
      logger.error(LogTag.Runtime, "fatal startup error:", error);
    },
  };
}

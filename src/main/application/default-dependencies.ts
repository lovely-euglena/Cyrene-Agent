/**
 * 默认应用依赖装配（真正的组合根胶水层）：
 * 持有全部业务子系统的导入与工厂闭包，把它们按窄依赖喂给各启动阶段。
 * 只有 index.ts 引用本模块；application.ts 与各 bootstrap 模块不感知具体实现。
 *
 * 本文件内的闭包只做构造与委托；任何长期任务都必须由对应启动阶段显式启动。
 */

import { app, BrowserWindow, dialog, screen } from "electron";
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
  sidebarWindow,
  settingsWindow,
  tasksWindow,
} from "../windows/window-state";
import { loadModelSettings, saveModelSettings, getPublicModelConfig } from "../settings/model-settings";
import { registerSettingsIpc } from "../settings/settings-ipc";
import {
  applyGeneralSettings,
  handleGeneralSettingsChanged,
  syncVolcanoSearchMcp,
} from "../settings/general-settings-lifecycle";
import { registerMemoryUserToolIpc } from "../memory/memory-user-ipc";
import { configureDocumentIndexQueue } from "../rag/document-index-queue";
import { runDocumentIndexJob } from "../rag/document-index-worker";
import { createLlmClient } from "../services/llm/llm-client";
import { createTtsSynthesisService } from "../services/tts/tts-synthesis-service";
import { createEmbeddingIndexService } from "../services/embedding/embedding-index-service";
import { momentsService, registerMomentsMediaMatcher } from "../moments/moments-service";
import {
  addL2MemoryVector,
  deleteUserMemoryVectors,
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
  enterPlanDiscussing,
  exitPlanMode,
  getPlanState,
  initPlanPaths,
  initPlanStateBroadcaster,
} from "../orchestrator/plan-mode";
import { initMcpManager, pruneMcpServersByIds } from "../orchestrator/mcp-manager";
import { syncPlaywrightMcp, REMOVED_BUILTIN_MCP_IDS } from "../sync-mcp-builtin";
import { registerAppUpdateIpc } from "../updater/app-update-ipc";
import { createGitHubAppUpdateService, scheduleStartupUpdateCheck } from "../updater/github-app-updater";
import { registerWindowSystemIpc } from "../windows/window-system-ipc";
import { enqueueLLMTask } from "../llm-queue";
import {
  registerPrivilegedSchemes,
  registerProtocolHandlers,
} from "../protocols/bootstrap";
import { memoryStore } from "../memory/memory-store";
import { backupMemoryRagFiles, reconcileMemoryRag } from "../memory/memory-rag-reconciliation";
import { registerChatsIpc } from "../chats/chats-ipc";
import { registerMomentsIpc } from "../moments/moments-ipc";
import { registerChatUiIpc, getActiveChatSessionId } from "../chats/chat-ui-ipc";
import { createToastWindowController } from "../toast/toast-window";
import { createToastService } from "../toast/toast-service";
import { toastEvents } from "../toast/toast-events";
import { createToastWindowShell } from "../windows/create-toast-window";
import * as chatsStore from "../chats/chats-store";
import { flush as flushTokenUsage } from "../token-usage-store";
import { TtsSessionService } from "../tts/tts-session-service";
import { registerTtsIpc } from "../tts/tts-ipc";
import { loadUserProfile, saveUserProfile } from "../settings-store";
import { getAppIconPath } from "../app-icon";
import { registerAgUiIpc } from "../agui-bridge";
import { updateLocaleContext } from "../locale-context";
import { registerCallIpc } from "../call/call-manager";
import { initSkills, skillRegistry } from "../skills";
import { createSchedulerSubsystem } from "../scheduler/bootstrap";
import { createChannelsSubsystem } from "../channels/bootstrap";
import { createLifecyclePublisher } from "../plugin-host/lifecycle-publisher";
import { createPendingTurnLifecycle } from "../plugin-host/pending-turn-lifecycle";
import { startPluginRuntime, getPluginMarketService } from "../plugin-runtime";
import { pushPluginsSnapshotToNative, pushSettingsSnapshotToNative } from "../windows/native-windows-bridge";
import { createAgentRuntime } from "../orchestrator/agent-runtime";
import { createRuntimeStateService } from "../orchestrator/runtime-state-service";
import { createProactiveLifecycle } from "../proactive/proactive-lifecycle";
import { createCitaService } from "../services/cita/cita-service";
import { createSocialContextService } from "../services/social-context/social-context-service";
import { createGitService } from "../code-git/git-service";
import { resolveGitExecutable, type ResolvedGitExecutable } from "../code-git/git-executable";
import { registerCodeGitIpc } from "../code-git/code-git-ipc";
import { installSingleInstanceGuard } from "../single-instance";
import { createWindowManager } from "../windows/window-manager";
import { createTray } from "../tray";
import {
  initNativeWindowsBridge,
  bindNativeDataProviders,
  relayAuxBroadcast,
  spawnNativeWindow,
} from "../windows/native-windows-bridge";
import { connectDetachedTray } from "../tray-detached";
import { createSplashWindow } from "../startup/create-splash-window";
import { revealStartupWindows } from "../startup/startup-window-reveal";
import { initializeScreenshotService } from "../screenshot/screenshot-lifecycle";
import { bootstrapConfigGetters } from "../startup/bootstrap-config";
import { bootstrapPermission } from "../permission/bootstrap";
import { registerPopQuizIpc, registerPopQuizTool } from "../orchestrator/pop-quiz";
import {
  sanitizeNativeGeneralSetting,
  sanitizeNativeUserProfile,
} from "../windows/native-settings-protocol";
import { pickAndSaveUserAvatar } from "../memory/user-avatar";

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

export function createDefaultApplicationDependencies(): ApplicationDependencies {
  // Agent Runtime 早于插件管理器构造；通过窄闭包在运行期转发宿主事件，避免反转启动顺序。
  let pluginManager: PluginManager | undefined;
  // 插件运行时动态启动用：startPlugins 首次调用的实参（core 阶段保存）
  let lastPluginArgs: Parameters<CoreDependencies["startPlugins"]> | null = null;
  // ipc holder：startCore 装配时填充（shell.ipc 生命周期跟随应用）
  let shellIpc: IpcScope | null = null;
  const shellIpcRef = (): IpcScope => shellIpc ?? createIpcScope();

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
      getPanelHostWebContents: () => settingsWindow?.webContents ?? null,
    });
    return pluginManager;
  };

  // 插件快照（.NET 管理窗 state.plugins payload；含运行时开关态）
  const buildPluginSnapshot = async (): Promise<unknown> => {
    const mkt = getPluginMarketService();
    return {
      runtimeEnabled: Boolean(pluginManager),
      plugins: pluginManager ? pluginManager.overview().plugins : [],
      market: pluginManager && mkt ? await mkt.listMarket() : [],
    };
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

    prepare: () => prepareBeforeReady({
      configureDocumentIndex: () => configureDocumentIndexQueue(runDocumentIndexJob),
      installSingleInstance: (onSecondInstance) => installSingleInstanceGuard(app, onSecondInstance),
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
    }),

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
        registerWindowSystemIpc({ ipc, windowManager });
        registerChatUiIpc({ ipc, live2dWindowLifecycle, windowManager });
      },
      // native 三件套窗口（默认启用）：动作转发回
      // 既有 windowManager / aux 窗口管理；未启用时 initialize 是 no-op
      initializeNativeWindows: (windowManager) => {
        initNativeWindowsBridge({
          // native 模式：设置窗走 .NET（spawn native settings）；
          // 渠道 section 例外（保持 Electron，用户指定）→ 直接弹 Electron 设置窗
          openSettings: (section?: string) => {
            if (section === "channels") {
              windowManager.createSettingsWindow(section);
              return;
            }
            void spawnNativeWindow("settings");
          },
          openChatWindow: () => windowManager.createReactChatWindowShell(),
          openCallWindow: () => windowManager.createCallWindow(),
          toggleSidebarPin: () => windowManager.createSidebarWindow(),
          cycleModelProvider: () => {
            // 模型切换：复用 modelConfig 变更广播路径（具体切换逻辑
            // 在 settings IPC 域，此处仅触发 UI 侧可见的下一 provider）
            broadcastToAuxWindows(IPC.MODEL_CONFIG_CHANGED, getPublicModelConfig());
          },
          onSplashShown: () => { /* onShown 由 spawnNativeSplash 注册的 hook 触发 */ },
          // native 设置窗写键：白名单/取值校验统一在 native-settings-protocol；
          // saveGeneralSettings 自动触发 handleGeneralSettingsChanged（桌宠显隐/
          // 置顶、开机自启、主题广播等联动）。
          // 不回推快照：native 控件状态即用户刚写入的值，回推重建会在滑杆/输入
          // 交互后打断焦点；快照仅在 spawn、换头像等需要刷新时推送。
          setSetting: (key, value) => {
            const patch = sanitizeNativeGeneralSetting(key, value);
            if (!patch) return;
            saveGeneralSettings(patch);
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
          // 渠道配置独立弹窗（Electron，用户指定渠道不迁 .NET）
          openChannelsWindow: () => windowManager.createSettingsWindow("channels"),
          // .NET 插件管理窗操作：manager/market 运行期引用（startPlugins 之后可用）
          pluginAction: async (action, id) => {
            const manager = pluginManager;
            const market = getPluginMarketService();
            // 运行时总开关动态起停（.NET 管理窗「未启用」提示条触发）
            if (action === "enable-runtime" || action === "disable-runtime") {
              if (action === "disable-runtime" && manager) {
                await manager.stop();
                pluginManager = undefined;
              }
              if (action === "enable-runtime" && !manager && lastPluginArgs) {
                const [svcs, sched, rt] = lastPluginArgs;
                pluginManager = await startPluginsImpl(svcs, sched, rt) ?? undefined;
              }
              await pushPluginsSnapshotToNative(async () => buildPluginSnapshot());
              return;
            }
            if (!manager) return;
            try {
              if (action === "enable" && id) await manager.setEnabled(id, true);
              else if (action === "disable" && id) await manager.setEnabled(id, false);
              else if (action === "uninstall" && id) await manager.uninstall(id);
              else if (action === "install" && id) await market?.installFromMarket(id);
              else if (action === "openPanel") {
                // 插件运行时面板归 Electron（首版宿主=设置窗插件 section）
                windowManager.createSettingsWindow("plugins");
                return;
              }
              // refresh：仅重拉市场索引
            } catch (err) {
              console.warn("[PluginNative] action failed:", action, id, err);
            }
            // 完成后重推快照（installed ± market 索引）
            await pushPluginsSnapshotToNative(async () => {
              const mkt = getPluginMarketService();
              return {
                plugins: manager.overview().plugins,
                market: mkt ? await mkt.listMarket() : [],
              };
            });
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

    startCore: (shell) => startCore({
      shell,
      readiness,
      activation,
      shutdown,
      minimumSplashMs: SPLASH_MIN_MS,
      markStartupWindowsReady: () => markStartupPhaseReady(),

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
        const proactiveLifecycle = createProactiveLifecycle({ loadGeneralSettings });
        // 主动聊天服务初始化是纯装配；触发器由 background 阶段启动
        proactiveLifecycle.initializeProactiveChatService();

        const ttsSessionService = new TtsSessionService((request, signal, emit) =>
          ttsSynthesisService.synthesizeSession(request, signal, emit),
        );

        // 应用图标 getter 已在工厂体开头注入（早于 shell 阶段的窗口壳/托盘创建）。

        // 内置工具配置 getter（场景向量索引等）
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
          getSession: chatsStore.getSession,
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
        // 计划模式路径根注入：write_plan / plan.md 读写基于 userData/plans/<conversationId>/
        initPlanPaths(app.getPath("userData"));
        // 计划模式状态广播：所有状态切换都广播到所有窗口
        initPlanStateBroadcaster((conversationId, state) => {
          const payload = { conversationId, state };
          for (const win of BrowserWindow.getAllWindows()) {
            win.webContents.send(IPC.PLAN_STATE_CHANGED, payload);
          }
        });
      },

      // 工具注册：集中到一个显式入口（依赖沙箱/Git/LSP 就绪）
      registerAllTools: (services) => registerAllTools({ codeGitService: services.git, lspManager: services.lsp }),

      initRag: async () => {
        const modelSettings = loadModelSettings();
        await initRAG("auto", undefined, undefined, modelSettings.embeddingModel, modelSettings.embeddingDimensions);
        logger.info(LogTag.RAG, "RAG initialized OK");
      },

      createRuntime: (services) => createAgentRuntime({
        runtimeStateService: services.runtimeState,
        llmClient: services.llm,
        enqueueLLMTask,
        loadModelSettings,
        loadGeneralSettings,
        loadUserProfile,
        toolRegistry,
        skillRegistry,
        getSceneEmbeddingIndex: () => services.embedding.getSceneEmbeddingIndex(),
        getStickerEmbeddingIndex: () => services.embedding.getStickerEmbeddingIndex(),
        getEmbeddingProvider,
        getSceneEmbeddingProvider,
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
      }),

      createChannels: (runtime, services) => createChannelsSubsystem({
        agentRuntime: runtime,
        ttsSynthesisService: services.tts,
        getReactChatWindow: () => reactChatWindow,
        ipc: shell.ipc,
        publishLifecycle: lifecyclePublisher,
      }),

      startPlugins: async (services, scheduler, runtime) => {
        // 插件运行时总开关（默认关）：跳过整个插件系统（manager/market/IPC
        // 均不构造）。lastPluginArgs 供运行期动态启动（管理窗 cmd）。
        lastPluginArgs = [services, scheduler, runtime];
        if (!loadGeneralSettings().pluginRuntimeEnabled) {
          logger.info(LogTag.Runtime, "plugin runtime disabled by settings, skipping");
          return null;
        }
        return startPluginsImpl(services, scheduler, runtime);
      },

      // native 三件套数据源绑定（core 阶段调用；未启用时 no-op）。
      // ⚠️ 该键曾在合并 ffc6322dd 中整体丢失（原生窗拿不到数据），勿删。
      bindNativeData: (providers) => bindNativeDataProviders(providers),
      /** 模型公开配置（native sidebar 模型区订阅用）。 */
      getPublicModelConfig: () => getPublicModelConfig(),
      /** .NET 插件管理窗快照（已装 + 市场索引）。 */
      getPluginsSnapshot: () => buildPluginSnapshot(),

      createScheduler: (runtime) => createSchedulerSubsystem({
        agentRuntime: runtime,
        getReactChatWindow: () => reactChatWindow,
        ipc: shell.ipc,
        publishLifecycle: lifecyclePublisher,
        // 插件任务只有在所属插件运行中才允许触发；用户任务不受影响。
        canRunTask: (task) => !task.ownerPluginId
          || (pluginManager?.isRunning(task.ownerPluginId) ?? false),
      }),

      registerCoreIpc: ({ ipc, runtime, services }) => {
        // 设置变更反应：窗口/托盘/截图热键/主动服务联动
        onGeneralSettingsChanged((before, after) =>
          handleGeneralSettingsChanged(before, after, {
            windowManager: shell.windowManager,
            tray: shell.tray,
            screenshotService: services.screenshot,
            proactiveLifecycle: services.proactive,
            broadcastToAuxWindows,
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
        });

        registerMemoryUserToolIpc({
          ipc,
          windowManager: shell.windowManager,
          embeddingIndexService: services.embedding,
        });

        // ── TTS IPC ──
        registerTtsIpc({ ipc, ttsSessionService: services.ttsSession });

        // 聊天会话存储 IPC（chats-store.initialize 建好 cyrene-chats 目录并加载 index）
        registerChatsIpc(ipc);
        registerMomentsIpc(ipc);
        registerCodeGitIpc({ ipc, service: services.git });

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
    }),

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
        // 内置 MCP 自动连接：Playwright（默认关闭，选项控制）
        await syncPlaywrightMcp(loadGeneralSettings());
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

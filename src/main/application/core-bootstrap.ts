/**
 * Core 启动阶段（coreReady）：建立聊天可用所需的最小核心。
 * 按严格依赖顺序构造：迁移 → 技能 → 低成本服务 → 沙箱 → 计划模式 → 工具
 * → RAG（可降级）→ Agent Runtime → scheduler/channels（只装配不启动）
 * → 全部渲染进程可能调用的 IPC → 加载聊天页面 → 桌宠/辅助窗口 → core-ready
 * → reveal → 激活代理放行。
 * 技能/RAG/沙箱失败只记录降级；聊天页面加载失败是致命错误，向上抛出。
 */

import type { IpcScope } from "./ipc-scope";
import type { StartupReadiness } from "./readiness";
import type { ShutdownCoordinator } from "./shutdown";
import type { WindowActivationBroker } from "./window-activation";
import type { ShellResult } from "./shell-bootstrap";
import type { RevealStartupWindowsOptions } from "../startup/startup-window-reveal";
import { closeNativeWindow, markNativeWindowsStartupReady } from "../windows/native-windows-bridge";
import { projectTaskForRenderer } from "../scheduler/scheduler-actions";
import type { AgentRuntime } from "../orchestrator/agent-runtime";
import type { RuntimeStateService } from "../orchestrator/runtime-state-service";
import type { TtsSynthesisService } from "../services/tts/tts-synthesis-service";
import type { TtsSessionService } from "../tts/tts-session-service";
import type { EmbeddingIndexService } from "../services/embedding/embedding-index-service";
import type { ProactiveLifecycle } from "../proactive/proactive-lifecycle";
import type { GitService } from "../code-git/git-service";
import type { LspManager } from "../lsp/manager";
import type { ScreenshotService } from "../screenshot/screenshot-lifecycle";
import type { AppUpdateService } from "../updater/app-update-service";
import type { LlmClient } from "../services/llm/llm-client";
import type { CitaService } from "../cita";
import type { SocialContextService } from "../services/social-context/social-context-service";
import type { ChannelsSubsystem } from "../channels/bootstrap";
import { channelManager } from "../channels/manager";
import type { SchedulerSubsystem } from "../scheduler/bootstrap";
import type { GeneralSettings } from "../settings/general-settings";
import type { UserProfile } from "../settings-store";
import { loadAvatarDataUrl } from "../settings-store";
import { TIMEZONE_OPTIONS } from "../../shared/timezone-options";
import type { WindowManager } from "../windows/window-manager";
import type { PluginManager } from "../../plugins/manager";

export interface CoreServices {
  runtimeState: RuntimeStateService;
  llm: LlmClient;
  cita: CitaService;
  social: SocialContextService;
  tts: TtsSynthesisService;
  ttsSession: TtsSessionService;
  embedding: EmbeddingIndexService;
  proactive: ProactiveLifecycle;
  git: GitService;
  lsp: LspManager;
  screenshot: ScreenshotService;
  update: AppUpdateService;
}

export interface CoreResult {
  runtime: AgentRuntime;
  services: CoreServices;
  channels: ChannelsSubsystem;
  plugins: PluginManager | null;
  scheduler: SchedulerSubsystem;
}

export interface RegisterCoreIpcInput {
  ipc: IpcScope;
  runtime: AgentRuntime;
  services: CoreServices;
  channels: ChannelsSubsystem;
  scheduler: SchedulerSubsystem;
}

export interface CoreDependencies {
  shell: ShellResult;
  readiness: StartupReadiness;
  activation: WindowActivationBroker;
  shutdown: ShutdownCoordinator;
  migrateStagedExternalContent(): void;
  initSkills(): void | Promise<void>;
  /** 低成本服务与配置 getter；只构造，不建立网络连接。 */
  createLowCostServices(): CoreServices;
  /** .NET 插件管理窗快照（已装+市场索引；插件系统就绪前可缺省）。 */
  getPluginsSnapshot?(): Promise<unknown>;
  initSandbox(): void | Promise<void>;
  initPlanMode(): void;
  registerAllTools(services: CoreServices): void;
  initRag(): Promise<void>;
  createRuntime(services: CoreServices): AgentRuntime;
  createChannels(runtime: AgentRuntime, services: CoreServices): ChannelsSubsystem;
  /** 必须在内置渠道适配器注册完成后调用；scheduler 先于本步完成 initialize。 */
  startPlugins(services: CoreServices, scheduler: SchedulerSubsystem, runtime: AgentRuntime): Promise<PluginManager | null>;
  createScheduler(runtime: AgentRuntime, services: CoreServices): SchedulerSubsystem;
  /** native 三件套数据源绑定（core 阶段；未启用时 no-op）。 */
  bindNativeData?(providers: import("../windows/native-windows-bridge").NativeDataProviders): void;
  /** 公开模型配置（getPublicModelConfig；native sidebar 快照用）。 */
  getPublicModelConfig?(): unknown;
  registerCoreIpc(input: RegisterCoreIpcInput): void;
  /** 组合根装配提醒中心：注册 toast IPC、订阅事件总线、按需创建隐藏窗口。 */
  wireToastCenter(input: { ipc: IpcScope; windowManager: WindowManager }): void;
  loadGeneralSettings(): GeneralSettings;
  /** 超时设置（高级设置 section 快照用） */
  getTimeoutSettings?(): { userChoiceTimeout: number; modelRequestTimeoutSec?: number };
  /** 应用版本（打包态用 app.getVersion()；缺省回退环境变量，仅测试桩用） */
  getAppVersion?(): string;
  /** 用户资料（native 设置窗「用户信息」section 快照）。 */
  loadUserProfile(): UserProfile;
  /** 启动期一次性应用通用设置（登录项同步、桌宠偏好等）。 */
  applyGeneralSettings(settings: GeneralSettings, services: CoreServices): void;
  revealStartupWindows(input: RevealStartupWindowsOptions): Promise<void>;
  /** Loading 最短展示时长（ms）。 */
  minimumSplashMs: number;
  /** 放行启动期间 pending 的辅助窗口（window-state 的 STARTUP_READY）。 */
  markStartupWindowsReady(): void;
}

function degradedMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// 启动耗时埋点：无条件打印各阶段耗时与结束时刻（相对进程启动），供启动性能排查
async function timedStep<T>(name: string, fn: () => T | Promise<T>): Promise<T> {
  const start = performance.now();
  try {
    return await fn();
  } finally {
    const end = performance.now();
    console.log(`[StartupTiming] core/${name} ${Math.round(end - start)}ms (at ${Math.round(end)}ms)`);
  }
}

export async function startCore(deps: CoreDependencies): Promise<CoreResult> {
  const { shell, readiness, activation, shutdown } = deps;

  // 升级迁移：必须在任何 prompts/skills 读取之前
  deps.migrateStagedExternalContent();

  // Skill 系统：失败只降级，不阻塞聊天
  try {
    await timedStep("initSkills", () => deps.initSkills());
  } catch (error) {
    console.error("[Core] initSkills failed:", error);
    readiness.markDegraded({ capability: "skills", message: degradedMessage(error), at: Date.now(), error });
  }

  // 低成本服务（runtimeState/tts/embedding/proactive/git/lsp/screenshot/update）
  const services = deps.createLowCostServices();

  // SRT 沙箱：失败不阻塞启动（fallback 到直接 spawn）
  try {
    await timedStep("initSandbox", () => deps.initSandbox());
  } catch (error) {
    console.error("[Core] initSandbox failed at startup:", error);
    readiness.markDegraded({ capability: "sandbox", message: degradedMessage(error), at: Date.now(), error });
  }

  deps.initPlanMode();
  deps.registerAllTools(services);

  // RAG：失败记录降级，聊天仍允许启动
  try {
    await timedStep("initRag", () => deps.initRag());
  } catch (error) {
    console.error("[Core] RAG init FAILED:", error);
    readiness.markDegraded({ capability: "rag", message: degradedMessage(error), at: Date.now(), error });
  }

  const runtime = deps.createRuntime(services);

  // channels 只装配并同步注册内置 adapter；网络启动仍在 background 阶段。
  const channels = deps.createChannels(runtime, services);
  await timedStep("channels-adapters", async () => {
    channels.initialize();
    await channels.adaptersRegistered;
  });

  // scheduler store 先加载并注册 IPC，再启动插件：插件调度服务写入的是
  // 已加载的 store，不会覆盖磁盘任务；插件启停联动也在此时接线。
  const scheduler = deps.createScheduler(runtime, services);
  scheduler.initialize();
  // native 三件套数据源（scheduler store + runtimeState + modelConfig）：
  // core 阶段才可绑定——shell 阶段 initializeNativeWindows 只注入窗口
  // 动作。绑定后 sidebar/tasks 窗 spawn 初始快照与 scheduler 变更旁路
  // 才有数据可推。
  deps.bindNativeData?.({
    getRuntimeState: () => services.runtimeState.getState(),
    getModelConfig: () => deps.getPublicModelConfig?.() ?? null,
    // 与渲染页同一投影口径：插件任务的启停按有效授权状态映射，且剔除
    // approvalFingerprint/pluginUserEnabled 等宿主内部字段——native 日程窗
    // 的过滤/排序/展示以这份 RendererScheduledTask 为准。
    getTasks: async () => scheduler.store.getTasks().map(projectTaskForRenderer) as unknown[],
    // .NET 插件管理窗快照：已装 + 市场索引（manager/market 由运行期闭包提供）
    getPluginsSnapshot: async () => deps.getPluginsSnapshot?.(),
    // native 设置窗快照：通用/外观/关于 + 用户信息（键名与 C# 白名单对齐；
    // 契约见 windows/native-settings-protocol.ts）
    getSettingsSnapshot: async () => {
      const gs = deps.loadGeneralSettings();
      const profile = deps.loadUserProfile();
      return {
        launchAtLogin: gs.launchAtLogin,
        petVisible: gs.petVisible,
        petAlwaysOnTop: gs.petAlwaysOnTop,
        petZoom: gs.petZoom,
        uiIcon: gs.uiIcon,
        uiFont: gs.uiFont,
        windowCornerRadius: gs.windowCornerRadius,
        toastSoundEnabled: gs.toastSoundEnabled,
        chatLineHeight: gs.chatLineHeight,
        assistantBubbleEnabled: gs.assistantBubbleEnabled,
        chatParaSpacing: gs.chatParaSpacing,
        disableGpuElectron: gs.disableGpuElectron === true,
        gitCommitAuthorName: gs.gitCommitAuthorName,
        gitCommitAuthorEmail: gs.gitCommitAuthorEmail,
        sidebarVisible: gs.sidebarVisible,
        tasksVisible: gs.tasksVisible,
        uiTheme: gs.uiTheme,
        language: gs.language,
        // 打包态用 app.getVersion()（旧实现读 npm_package_version，打包后
        // 常缺失 → 显示过期的 1.1.9）
        version: deps.getAppVersion?.() ?? process.env.npm_package_version ?? "0.0.0",
        // 高级设置（api-advanced）快照：超时 + 工具并发
        runtime: (() => {
          const timeout = deps.getTimeoutSettings?.();
          return {
            modelRequestTimeoutSec: typeof timeout?.modelRequestTimeoutSec === "number"
              ? timeout.modelRequestTimeoutSec
              : null,
            userChoiceTimeout: timeout?.userChoiceTimeout ?? 60000,
            maxParallelToolCalls: gs.maxParallelToolCalls,
          };
        })(),
        user: {
          nickname: profile.nickname,
          callPreference: profile.callPreference,
          birthday: profile.birthday,
          defaultCity: profile.defaultCity,
          timezone: profile.timezone,
          gender: profile.gender,
          // 时区白名单与渲染页共用（src/shared/timezone-options.ts）
          timezoneOptions: TIMEZONE_OPTIONS.map((o) => ({ label: o.label, value: o.value })),
          avatarDataUrl: loadAvatarDataUrl(),
        },
        // 偏好设置（preferences section）：与渲染页 saveGeneral 同一批字段。
        // proactiveDelivery 是渠道可用性（渲染页同口径：仅运行中渠道可选，
        // local 恒可选）；defaultChatMode/segmentedOutputMode/citaSemanticEngine
        // 当前为只读展示项。
        preferences: (() => {
          const statuses = channelManager.getAllStatus();
          return {
            screenshotBackend: gs.screenshotBackend,
            snipastePath: gs.snipastePath,
            mobileMessageSegmentation: gs.mobileMessageSegmentation,
            proactiveChatMode: gs.proactiveChatMode,
            proactiveDeliveryTarget: gs.proactiveDeliveryTarget,
            proactiveDelivery: {
              wechat: statuses.wechat?.phase === "running",
              feishu: statuses.feishu?.phase === "running",
            },
            chatSocialContextEnabled: gs.chatSocialContextEnabled,
            momentsEnabled: gs.momentsEnabled,
            cyreneMomentsPostingEnabled: gs.cyreneMomentsPostingEnabled,
            cyreneMomentsReactionsEnabled: gs.cyreneMomentsReactionsEnabled,
            momentsCharacterReactionsEnabled: gs.momentsCharacterReactionsEnabled,
            momentsLiveliness: gs.momentsLiveliness,
            citaEnabled: gs.citaEnabled,
            citaSemanticEngine: gs.citaSemanticEngine,
            customStyle: gs.customStyle,
            defaultChatMode: gs.defaultChatMode,
            segmentedOutputMode: gs.segmentedOutputMode,
          };
        })(),
      };
    },
  });

  // 插件严格晚于内置 adapter id 预留，避免插件抢占 feishu/wechat/qq 等内置 id。
  // pluginRuntimeEnabled=false（默认）时 startPlugins 返回 null：插件系统
  // 整体不构造（省内存），管理窗经 cmd 动态启动。
  const plugins = await timedStep("startPlugins", () => deps.startPlugins(services, scheduler, runtime));

  // 注册聊天渲染进程可能调用的全部 IPC 处理器 —— 必须先于 chat.load()
  deps.registerCoreIpc({ ipc: shell.ipc, runtime, services, channels, scheduler });

  deps.wireToastCenter({ ipc: shell.ipc, windowManager: shell.windowManager });
  // 聊天页面加载：按需启动（CYRENE_LAZY_CHAT_WINDOW=1，默认）时跳过
  // 启动加载——首次激活（tray/桌宠/会话打开）时经 openReactChatWindow
  // 触发 windowManager.openReactChatWindow 的 load+show 链；急切模式
  // （=0）维持原行为：全部处理器就绪后立即加载，失败是致命错误。
  if (!shell.chat.isLazy || process.env.CYRENE_LAZY_CHAT_WINDOW === "0") {
    await shell.chat.load();
  }

  // （lazy-chat 模式下 load 已在上方分支处理：急切模式立即加载，
  //  lazy 模式留待首启激活。页面加载失败是致命错误。）

  // 桌宠：窗口始终创建，petVisible 只决定是否显示（隐藏时不闪现）。
  // 始终创建是为了保证托盘"显示/隐藏桌宠"与设置面板开关随时能把窗口救回来，
  // 且 alwaysOnTop / zoom / live2d 生命周期在隐藏状态下同样完成接线。
  const generalSettings = deps.loadGeneralSettings();
  // 启动期一次性完整应用通用设置（登录项同步等）；此时桌宠未创建，show/hide 为 no-op
  deps.applyGeneralSettings(generalSettings, services);
  // showOnReady=petVisible：页面就绪才显示，避免空窗口闪现；创建本身在核心 IPC 注册之后
  shell.windowManager.createPetWindow(generalSettings.petVisible);
  shell.windowManager.onPetWindowReady((win) => {
    shell.live2dWindowLifecycle.attach(win);
  });
  shell.windowManager.onPetWindowClosed(() => {
    shell.live2dWindowLifecycle.clear();
  });
  shell.windowManager.setPetWindowAlwaysOnTop(generalSettings.petAlwaysOnTop);
  shell.windowManager.applyPetWindowZoom(generalSettings.petZoom);
  if (generalSettings.sidebarVisible) shell.windowManager.createSidebarWindow();
  if (generalSettings.tasksVisible) shell.windowManager.createTasksWindow();

  // 注册核心资源清理（固定阶段）；scheduler/proactive/更新定时器由 background 注册
  shutdown.register({
    id: "plugins",
    phase: "stopActiveWork",
    dispose: async () => { await plugins?.stop(); },
  });
  shutdown.register({
    id: "channels",
    phase: "stopExternalConsumers",
    dispose: async () => { await channels.shutdown(); },
  });
  shutdown.register({
    id: "screenshot",
    phase: "stopLocalResources",
    dispose: async () => { await services.screenshot.shutdown(); },
  });
  shutdown.register({
    id: "lsp",
    phase: "stopLocalResources",
    dispose: async () => { await services.lsp.disposeAll(); },
  });
  shutdown.register({
    id: "git",
    phase: "stopLocalResources",
    dispose: async () => { await services.git.dispose(); },
  });
  readiness.transition("core-ready");

  // 等待最短展示剩余时长 → 关 Loading → 显示聊天 → 放行 pending 辅助窗口
  // 按需启动（CYRENE_LAZY_CHAT_WINDOW≠0）：chatWindow 传 null——reveal 不
  // 物化聊天窗（桌面只留桌宠），首次激活时经 openReactChatWindow 建窗。
  const lazyChat = process.env.CYRENE_LAZY_CHAT_WINDOW !== "0";
  await deps.revealStartupWindows({
    splashWindow: shell.splashWindow,
    // native splash（原生窗口启用时 shell.splashWindow 为 null）
    // 在 reveal 同点关闭；bridge 未启用时 no-op（closeNativeWindow 短路）
    closeSplashWindow: () => { void closeNativeWindow("splash"); },
    chatWindow: lazyChat && !shell.chat.isMaterialized?.() ? null : shell.chat.window,
    loadingShownAt: shell.loadingShownAt,
    minimumDurationMs: deps.minimumSplashMs,
  });
  // 窗口已对用户可见的时刻锚点：在此之后打印结束的后台任务，都是“窗口出来后还在跑”的部分
  console.log(`[StartupTiming] core/windows-revealed (at ${Math.round(performance.now())}ms)`);
  deps.markStartupWindowsReady();
  // native 三件套（sidebar/tasks/settings/plugins）与 BrowserWindow 同点放行：
  // startup 阶段 spawn 的窗口先进 pendingNativeShows，此处统一发 win.show。
  // ⚠️ 此调用曾在合并 ffc6322dd 中丢失（窗口「生成了但永不显示」），勿删；
  // bridge 未启用时 no-op。
  markNativeWindowsStartupReady();

  // 主窗口可激活：消费启动期间排队的激活请求
  await activation.markReady();
  console.log(`[StartupTiming] core/startCore-total ${Math.round(performance.now())}ms`);

  return { runtime, services, channels, plugins, scheduler };
}

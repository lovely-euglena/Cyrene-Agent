// native 窗口桥接层：把现有 IPC 数据流/窗口动作复用到 cyrene-native 进程。
//
// 接入原则（原生窗口默认启用；CYRENE_NATIVE_WINDOWS=0 强制回退）：
//   - 数据推送：在 aux 窗广播的同一数据源上加订阅（runtimeState /
//     modelConfig / scheduler / tokenUsage），双路并存——native 开着就
//     推 native，BrowserWindow 路径不受影响（回退 = 关开关即回原样）
//   - 窗口动作：native cmd 事件转发到既有窗口管理函数（openSettings
//     / openChatWindow 等），主进程零新增逻辑
//   - 布局：computeLayout 结果原样推送（native 侧只认 x/y）
//
// 未启用时所有函数是 no-op（返回 false/null），调用方走原路径。

import { NativeWindowsClient, getNativeWindowsClient, type NativeWindowsHost } from "./native-windows-host";
import { IPC } from "../../shared/ipc-channels";
import { getUsageReport } from "../token-usage-store";
import { debugLog } from "../agent-log";

// ── 宿主动作注入点（由 default-dependencies 装配时提供） ──
export interface NativeBridgeActions {
  openSettings(section?: string): void;
  openChatWindow(): void;
  openCallWindow(): void;
  toggleSidebarPin(): void;
  onSplashShown(): void;
  /** native 设置窗写入设置键（白名单在宿主侧执行）。 */
  setSetting?(key: string, value: unknown): void;
  /** native 设置窗写入用户资料字段（字段白名单/取值校验在宿主侧执行）。 */
  setUserProfile?(profile: unknown): void;
  /** native 设置窗「更换头像」：宿主弹文件框并保存（native 不传路径）。 */
  pickAvatar?(): void;
  /** native 设置窗占位 section「在旧版设置中打开」→ Electron 设置窗（hash 定位）。 */
  openLegacySettings?(section?: string): void;
  /** native 设置窗「插件」section → 打开 .NET 插件管理窗（宿主侧失败可回退 Electron）。 */
  openPluginManager?(): void;
  /**
   * native 设置窗「API 与模型」section 动作。verb:
   * save / test / test-vision / set-default-profile / delete-profile；
   * payload 为对应参数对象（config / id 等）。
   */
  apiAction?(verb: string, payload: Record<string, unknown>): void;
  /** native 设置窗「记忆」section 动作。verb: save-l0/save-l1/delete-doc/vault-bind/vault-unbind/vault-export/vault-sync/vault-auto-sync */
  memoryAction?(verb: string, payload: Record<string, unknown>): void;
  /** native 设置窗「定时任务」section 动作。verb: add/update/toggle/fire/delete/history */
  schedulerAction?(verb: string, payload: Record<string, unknown>): void;
  /** native 设置窗「高级设置」section 动作。verb: save（超时 + 工具并发） */
  runtimeAction?(verb: string, payload: Record<string, unknown>): void;
  /** native 设置窗「Token 用量」section 动作。verb: set-days / clear */
  tokensAction?(verb: string, payload: Record<string, unknown>): void;
  /** 打开 Electron 渠道配置独立弹窗（渠道页保持 Electron，用户指定）。 */
  openChannelsWindow?(): void;
  /** 界面字体导入/恢复（宿主弹文件框/清理文件；native 不传路径）。 */
  uiFontAction?(verb: "import" | "reset"): void;
  /**
   * 插件操作（.NET 插件管理窗 → 主进程）：
   * enable/disable/uninstall/install/openPanel/refresh/import-zip。
   * install/import-zip 为异步（下载或弹框+校验+解压），完成后由宿主重推
   * state.plugins 快照（含操作结果 notice）。
   */
  pluginAction?(action: string, id?: string): Promise<void> | void;
}

let client: NativeWindowsClient | null = null;
let initialized = false;

const asString = (value: unknown): string => (typeof value === "string" ? value : "");
const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

/**
 * 初始化桥接（应用启动时调用一次）。未启用 native 窗口时 no-op。
 * 幂等：重复调用直接返回已有 client。
 */
export function initNativeWindowsBridge(actions: NativeBridgeActions): NativeWindowsClient | null {
  const host: NativeWindowsHost = {
    onCommand(frame) {
      const action = String(frame.action ?? "");
      const section = typeof frame.section === "string" ? frame.section : undefined;
      const frameKind = typeof frame.kind === "string" ? frame.kind : "";
      debugLog(`[NativeWindows] cmd kind=${frameKind} action=${action}${section ? ` section=${section}` : ""}${typeof frame.id === "string" ? ` id=${frame.id}` : ""}`);
      switch (action) {
        case "openSettings": actions.openSettings(section); break;
        case "openChat": actions.openChatWindow(); break;
        case "openCall": actions.openCallWindow(); break;
        case "togglePin": actions.toggleSidebarPin(); break;
        case "modelSwitch":
          // 旧版状态栏「切换模型」= 打开 API 设置页（sidebar.ts: openSettings("api")）
          actions.openSettings("api");
          break;
        case "shown":
          actions.onSplashShown();
          notifyNativeSplashShown();
          break;
        case "set":
          // native 设置窗写设置：{"action":"set","key":...,"value":...}
          if (typeof frame.key === "string") {
            actions.setSetting?.(frame.key, frame.value);
          }
          break;
        case "set-user-profile":
          // native 设置窗写用户资料：{"action":"set-user-profile","profile":{...}}
          actions.setUserProfile?.(frame.profile);
          break;
        case "pick-avatar":
          actions.pickAvatar?.();
          break;
        case "open-legacy":
          // native 设置窗占位 section → Electron 旧版设置页（带 hash 定位）
          actions.openLegacySettings?.(section);
          break;
        case "open":
          // 插件管理窗入口：{"kind":"plugins","action":"open"}
          if (frameKind === "plugins") {
            actions.openPluginManager?.();
          }
          break;
        case "api":
          actions.apiAction?.(asString(frame.verb), asRecord(frame.payload));
          break;
        case "memory":
          actions.memoryAction?.(asString(frame.verb), asRecord(frame.payload));
          break;
        case "scheduler":
          actions.schedulerAction?.(asString(frame.verb), asRecord(frame.payload));
          break;
        case "runtime":
          actions.runtimeAction?.(asString(frame.verb), asRecord(frame.payload));
          break;
        case "tokens":
          actions.tokensAction?.(asString(frame.verb), asRecord(frame.payload));
          break;
        case "openChannels":
          actions.openChannelsWindow?.();
          break;
        case "ui-font-import":
          actions.uiFontAction?.("import");
          break;
        case "ui-font-reset":
          actions.uiFontAction?.("reset");
          break;
        case "enable-runtime":
        case "disable-runtime":
        case "enable":
        case "disable":
        case "uninstall":
        case "install":
        case "openWindow":
        case "openPanel":
        case "refresh":
        case "import-zip":
          // 插件管理窗操作：{"kind":"plugins","action":"install","id":...}
          if (frameKind === "plugins") {
            void actions.pluginAction?.(action, typeof frame.id === "string" ? frame.id : undefined);
          }
          break;
        default:
          console.warn(`[NativeWindows] unhandled cmd action: ${action}`);
      }
    },
  };
  client = getNativeWindowsClient(host);
  initialized = true;
  return client;
}

// ── 数据提供者（core 阶段绑定；shell 阶段 scheduler/runtimeState 尚未建） ──
export interface NativeDataProviders {
  getRuntimeState(): unknown;
  getModelConfig(): unknown;
  getTasks(): Promise<unknown[]>;
  /** native 设置窗快照（general settings 的通用/外观/关于子集）。 */
  getSettingsSnapshot?(): Promise<unknown>;
  /** .NET 插件管理窗快照（已装 + 市场列表）。 */
  getPluginsSnapshot?(): Promise<unknown>;
}

let dataProviders: NativeDataProviders | null = null;

/**
 * core 阶段绑定数据源（default-dependencies 在 startCore 编排里调用）。
 * 未启用 native 窗口时 no-op。绑定后 scheduler 变更旁路与 tasks 窗
 * spawn 初始快照才有数据可推。
 */
/**
 * 重推插件快照到 .NET 插件管理窗（操作完成后调用；窗未开时 no-op）。
 * 快照组装需要 manager/market——由调用方闭包提供以避免本模块依赖插件系统。
 */
export async function pushPluginsSnapshotToNative(
  build?: () => Promise<unknown> | null,
): Promise<void> {
  const c = activeClient();
  if (!c) return;
  let payload: unknown = null;
  if (build) {
    payload = await build();
  }
  if (payload === null) return;
  try {
    await c.pushPlugins(payload);
  } catch {
    /* 窗口未开/进程未起：正常路径，不报错 */
  }
}

export function bindNativeDataProviders(providers: NativeDataProviders): void {
  dataProviders = providers;
}

/** 设置窗 section 反馈消息（保存/测试/同步结果与错误）。 */
export interface NativeSettingsNotice {
  section: string;
  level: "ok" | "error" | "info";
  text: string;
  at: number;
  /** 可选结构化附加数据（如保存成功后回传 savedProfileId 供 WPF 进入编辑态） */
  data?: Record<string, unknown>;
}

/**
 * 推送 section 反馈到 .NET 设置窗（就地更新状态行，不触发 section 重建；
 * 窗未开时 no-op）。
 */
export function pushSettingsNoticeToNative(notice: NativeSettingsNotice): void {
  void activeClient()?.pushSettingsNotice(notice).catch(() => undefined);
}

/**
 * 重推设置快照到 .NET 设置窗（换头像等需要刷新 UI 的写入后调用；窗未开时 no-op）。
 * 快照来源与 spawn 初始推送同一数据源（getSettingsSnapshot），保证读方向一致。
 */
export function pushSettingsSnapshotToNative(): void {
  const c = activeClient();
  if (!c || !dataProviders) return;
  void dataProviders.getSettingsSnapshot?.()
    .then((settings) => c.pushSettings(settings))
    .catch((error) => console.warn("[NativeWindows] settings snapshot push failed:", error));
}

// ── native 显窗门控（window-state.markStartupPhaseReady 的 native 版） ──
const pendingNativeShows = new Set<string>();
let nativeWindowsStartupReady = false;
/**
 * splash 是否已被请求关闭。冷启动时 reveal 的关闭请求可能早于 splash 的
 * win.spawn 落地（native 进程尚在启动）——那次 win.close 会打空，随后
 * spawn 完成才显示 splash，就再也没人关它（启动屏常驻）。用标志记录，
 * spawn 落地后补关。
 */
let splashDismissed = false;

/**
 * 启动就绪后统一显示 native 辅助窗（core-bootstrap 在 reveal 同点、
 * markStartupWindowsReady 之后调用——与 BrowserWindow 的
 * markStartupPhaseReady 同点）。启动后再 spawn 的窗口不经 pending
 * （spawn 即 show）。
 */
export function markNativeWindowsStartupReady(): void {
  if (nativeWindowsStartupReady) return;
  nativeWindowsStartupReady = true;
  const c = activeClient();
  const kinds = [...pendingNativeShows];
  pendingNativeShows.clear();
  for (const kind of kinds) {
    void c?.showWindow(kind).catch(() => undefined);
  }
}

/** scheduler 变更旁路：拉快照推 native（scheduler-ipc 的 broadcastChanged 调用）。 */
export function pushSchedulerSnapshotToNative(): void {
  // native 未启用/未初始化时直接短路：拉快照有成本（scheduler store
  // 读取 + usage 聚合），无消费方就不该拉
  if (!dataProviders || !activeClient()) return;
  void dataProviders.getTasks()
    .then((tasks) => activeClient()?.pushTasks(tasks, getUsageReport(7)))
    .catch((error) => console.warn("[NativeWindows] scheduler snapshot push failed:", error));
}

function activeClient(): NativeWindowsClient | null {
  // 未初始化（单测环境）或开关关闭 → null
  return initialized ? client : null;
}

/** 是否走 native 路径（调用方据此跳过对应 BrowserWindow 创建）。 */
export function isNativeWindowActive(kind: "splash" | "sidebar" | "tasks" | "settings" | "plugins"): boolean {
  const c = activeClient();
  return c !== null;
}

// ── 数据推送（aux 广播同源订阅调用） ──

export function pushRuntimeStateToNative(state: unknown): void {
  void activeClient()?.pushRuntimeState(state).catch(() => undefined);
}

export function pushModelConfigToNative(config: unknown): void {
  void activeClient()?.pushModelConfig(config).catch(() => undefined);
}

export function pushTasksToNative(tasks: unknown, usage: unknown): void {
  void activeClient()?.pushTasks(tasks, usage).catch(() => undefined);
}

export function pushLayoutToNative(layout: unknown): void {
  void activeClient()?.pushLayout(layout).catch(() => undefined);
}

// ── 窗口生命周期（替代 BrowserWindow 创建） ──

export async function spawnNativeWindow(
  kind: "splash" | "sidebar" | "tasks" | "settings" | "plugins",
  layout?: unknown,
): Promise<boolean> {
  const c = activeClient();
  if (!c) return false;
  try {
    await c.spawnWindow(kind, layout);
    debugLog(`[NativeWindows] spawned ${kind}`);
    // 显窗时机（对齐 showWindowWhenStartupReady 语义）：
    // splash 无门控（本来就是启动期首帧）；sidebar/tasks 在
    // startup 阶段先 pending，markStartupPhaseReady 后统一 win.show
    if (kind === "splash") {
      await c.showWindow("splash");
      // 关闭请求早于本次 spawn 落地（冷启动竞态）→ 补发关闭，避免启动屏常驻
      if (splashDismissed) {
        debugLog("[NativeWindows] splash 关闭请求早于 spawn，补发 win.close");
        await c.closeWindow("splash").catch(() => undefined);
      }
    } else if (nativeWindowsStartupReady) {
      await c.showWindow(kind);
    } else {
      pendingNativeShows.add(kind);
    }
    // 初始快照：BrowserWindow 路径由渲染页加载时主动拉
    // （cyreneScheduler.list / tokenUsage.get / runtimeState.get）；
    // native 窗没有 IPC 通道，宿主 spawn 后立即推送，避免空窗
    if (kind === "sidebar" && dataProviders) {
      void c.pushRuntimeState(dataProviders.getRuntimeState()).catch(() => undefined);
      void c.pushModelConfig(dataProviders.getModelConfig()).catch(() => undefined);
    } else if (kind === "settings" && dataProviders) {
      // 初始快照与后续写入重推共用同一路径（读方向键名统一在协议模块）
      pushSettingsSnapshotToNative();
    } else if (kind === "plugins" && dataProviders) {
      void dataProviders.getPluginsSnapshot?.()
        .then((snapshot) => c.pushPlugins(snapshot))
        .catch((error) => console.warn("[NativeWindows] plugins snapshot push failed:", error));
    } else if (kind === "tasks" && dataProviders) {
      void dataProviders.getTasks()
        .then((tasks) => c.pushTasks(tasks, getUsageReport(7)))
        .catch((error) => console.warn("[NativeWindows] tasks snapshot push failed:", error));
    }
    return true;
  } catch (error) {
    console.warn(`[NativeWindows] spawn ${kind} failed:`, error instanceof Error ? error.message : error);
    return false;
  }
}

export async function closeNativeWindow(kind: string): Promise<void> {
  // splash：记录标志——若关闭请求早于 win.spawn 落地，spawn 后补关
  if (kind === "splash") splashDismissed = true;
  debugLog(`[NativeWindows] close requested: ${kind}`);
  await activeClient()?.closeWindow(kind).catch(() => undefined);
}

/**
 * native splash：win.shown 事件到达时回调 ctx.onShown（语义对齐
 * Electron ready-to-show → show → onShown）。
 */
export async function spawnNativeSplash(ctx: {
  onShown?(at: number): void;
  now?: () => number;
}): Promise<boolean> {
  const c = activeClient();
  if (!c) return false;
  const ok = await spawnNativeWindow("splash");
  if (ok) {
    // onShown 由 host 的 cmd "shown" 动作触发（初始化时注入的
    // actions.onSplashShown）——此处注册一次性回调
    splashShownHook = () => {
      try {
        ctx.onShown?.((ctx.now ?? (() => performance.now()))());
      } catch (err) {
        console.error("[NativeSplash] onShown callback failed:", err);
      }
    };
  }
  return ok;
}

let splashShownHook: (() => void) | null = null;

/** native splash win.shown 到达时调用（default-dependencies 装配的 actions.onSplashShown 内转调）。 */
export function notifyNativeSplashShown(): void {
  splashShownHook?.();
  splashShownHook = null;
}

export function disposeNativeWindowsBridge(reason = "shutdown"): void {
  splashDismissed = false;
  client?.disposeSync(reason);
}

// ── IPC channel → native 推送的映射（数据源订阅处复用） ──

/**
 * aux 广播旁路：把 broadcastToAuxWindows 的 channel+payload 同时推给
 * native 窗（认识的数据 channel 自动转 state.* 帧，不认识的忽略）。
 * 在现有广播点旁边调一行即可，零侵入。
 */
export function relayAuxBroadcast(channel: string, payload: unknown): void {
  switch (channel) {
    case IPC.RUNTIME_STATE_CHANGED:
      pushRuntimeStateToNative(payload);
      break;
    case IPC.MODEL_CONFIG_CHANGED:
      pushModelConfigToNative(payload);
      break;
    // SCHEDULER_CHANGED 不在此处理：native 侧无 IPC 通道可"重拉"，
    // {refetch:true} 会被 C# ApplyState 当成空数据清空任务列表。
    // 改由 scheduler-ipc.broadcastChanged 调 pushSchedulerSnapshotToNative
    // （数据就近原则，store.getTasks() 在广播点直接可取）。
    default:
      // TOKEN_USAGE_CHANGED 等低频数据在窗口 spawn 时一次性拉取推送
      break;
  }
}

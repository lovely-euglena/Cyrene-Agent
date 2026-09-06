// native 窗口桥接层：把现有 IPC 数据流/窗口动作复用到 cyrene-native 进程。
//
// 接入原则（灰度开关 CYRENE_NATIVE_WINDOWS=1）：
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

// ── 宿主动作注入点（由 default-dependencies 装配时提供） ──
export interface NativeBridgeActions {
  openSettings(section?: string): void;
  openChatWindow(): void;
  openCallWindow(): void;
  toggleSidebarPin(): void;
  cycleModelProvider(): void;
  onSplashShown(): void;
}

let client: NativeWindowsClient | null = null;
let initialized = false;

/**
 * 初始化桥接（应用启动时调用一次）。未启用 native 窗口时 no-op。
 * 幂等：重复调用直接返回已有 client。
 */
export function initNativeWindowsBridge(actions: NativeBridgeActions): NativeWindowsClient | null {
  const host: NativeWindowsHost = {
    onCommand(frame) {
      const action = String(frame.action ?? "");
      const section = typeof frame.section === "string" ? frame.section : undefined;
      switch (action) {
        case "openSettings": actions.openSettings(section); break;
        case "openChat": actions.openChatWindow(); break;
        case "openCall": actions.openCallWindow(); break;
        case "togglePin": actions.toggleSidebarPin(); break;
        case "modelSwitch": actions.cycleModelProvider(); break;
        case "shown":
          actions.onSplashShown();
          notifyNativeSplashShown();
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

function activeClient(): NativeWindowsClient | null {
  // 未初始化（单测环境）或开关关闭 → null
  return initialized ? client : null;
}

/** 是否走 native 路径（调用方据此跳过对应 BrowserWindow 创建）。 */
export function isNativeWindowActive(kind: "splash" | "sidebar" | "tasks"): boolean {
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
  kind: "splash" | "sidebar" | "tasks",
  layout?: unknown,
): Promise<boolean> {
  const c = activeClient();
  if (!c) return false;
  try {
    await c.spawnWindow(kind, layout);
    return true;
  } catch (error) {
    console.warn(`[NativeWindows] spawn ${kind} failed:`, error instanceof Error ? error.message : error);
    return false;
  }
}

export async function closeNativeWindow(kind: string): Promise<void> {
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
    case IPC.SCHEDULER_CHANGED:
      // scheduler 变更 → native 侧需要重拉任务列表（数据经
      // scheduler:list IPC 获取，此处只发触发信号）
      pushTasksToNative({ refetch: true }, undefined);
      break;
    default:
      // TOKEN_USAGE_CHANGED 等低频数据在窗口 spawn 时一次性拉取推送
      break;
  }
}

import { app, Notification } from "electron";

import { loadGeneralSettings } from "../settings/settings-facade";

/**
 * 系统通知服务（issue #153）：
 * - Electron Notification 统一封装：标题/正文/点击聚焦主窗口；
 * - 触发场景（首批）：agent 任务终态（success / timeout / runtime_error）与等待用户输入
 *   （ask_user / 计划审批卡片）；cancelled 是用户主动行为，不打扰；
 * - 节制：总开关 GeneralSettings.notificationsEnabled + 发起窗口（或聊天窗）聚焦且可见时静默；
 * - Windows 通知中心归属：appUserModelId 与 electron-builder appId（com.cyrene.live2d）对齐。
 */

let initialized = false;
let focusMainWindow: (() => void) | null = null;

/** 主进程启动时调用一次；重复调用是 no-op。 */
export function initDesktopNotifications(input?: { onFocusMainWindow?: () => void }): void {
  if (initialized) return;
  initialized = true;
  focusMainWindow = input?.onFocusMainWindow ?? null;
  // Windows：通知中心归属应用必须设置 AUMID（与 electron-builder.yml appId 一致）。
  // macOS/Linux 下此调用无效果，安全。
  try {
    app.setAppUserModelId("com.cyrene.live2d");
  } catch (err) {
    console.warn("[Notifications] setAppUserModelId 失败:", err instanceof Error ? err.message : err);
  }
}

interface AgentEventNotification {
  title: string;
  body: string;
}

/** 从 AGUI 事件流提取值得通知的场景；非目标事件返回 undefined。 */
export function extractNotification(event: unknown): AgentEventNotification | undefined {
  if (!event || typeof event !== "object") return undefined;
  const e = event as { type?: unknown; result?: { status?: unknown }; name?: unknown };

  if (e.type === "RUN_FINISHED") {
    const status = e.result?.status;
    if (status === "success") return { title: "任务完成", body: "昔涟已完成这轮任务，点击查看结果。" };
    if (status === "timeout") return { title: "任务超时", body: "这轮任务超时中断了，点击查看详情。" };
    if (status === "runtime_error") return { title: "任务出错", body: "这轮任务运行出错，点击查看原因。" };
    return undefined; // cancelled：用户主动取消，不打扰
  }

  if (e.type === "CUSTOM" && e.name === "cyrene.choice") {
    // ask_user / 计划审批等待输入——最有价值的场景：挂着干等回复
    return { title: "等待你的输入", body: "昔涟有问题要问你，点击回到对话。" };
  }

  return undefined;
}

/**
 * AGUI 事件通知入口（由 agui-bridge 的 send() 旁路调用）。
 * 任何内部异常都吞掉——通知是旁路可选项，绝不影响主事件流。
 */
export function notifyAgentEvent(
  event: unknown,
  opts: { isForeground: () => boolean },
): void {
  try {
    if (!initialized) return;
    if (!Notification.isSupported()) return;
    if (!loadGeneralSettings().notificationsEnabled) return;
    if (opts.isForeground()) return; // 前台聚焦且可见时不打扰

    const notification = extractNotification(event);
    if (!notification) return;

    const n = new Notification({
      title: notification.title,
      body: notification.body,
      timeoutType: "default",
    });
    n.on("click", () => {
      try {
        focusMainWindow?.();
      } catch (err) {
        console.warn("[Notifications] 聚焦主窗口失败:", err instanceof Error ? err.message : err);
      }
    });
    n.show();
  } catch (err) {
    console.warn("[Notifications] 派发失败:", err instanceof Error ? err.message : err);
  }
}

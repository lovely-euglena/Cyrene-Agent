/**
 * 后台 Shell 任务终态通知（#182 第一刀）。
 *
 * 上游（Playa-0v0#214）方案是"终态持久化为内部事件 + 空闲自动续轮"；
 * fork 第一刀 = **通知式闭环**：终态事件广播到聊天窗口，ChatPage 在会话
 * 空闲时以轻提示告知用户（"后台任务 xxx 已完成，可让我查看结果"）——
 * 用户一句话即可让 agent 用 shell_job 查询终态与输出，结果进入对话。
 *
 * 不自动续轮的原因：fork 的 run 由 renderer 驱动（消息列表/UI 状态机在
 * renderer），主进程自主发起 run 会脱离 UI 状态机；而把事件伪装成用户
 * 消息违反护栏（不制造用户发言）。自动续轮（内部事件注入 + 空闲守卫）
 * 作为第二刀挂 #182 后续。
 *
 * 护栏（对齐上游五条的 fork 对应）：订阅方异常不影响派发；应用退出
 * （will-quit）先停派发；事件去重由 settleJob 先到先得保证（每任务至多
 * 一发）；不提权（事件本身不携带任何权限）；不制造用户发言（renderer
 * 只做轻提示）。
 */
import { IPC } from "../../shared/ipc-channels";
import { subscribeShellJobTerminal, clearShellJobTerminalSubscribers, type ShellJobTerminalEvent } from "./builtin-tools/shell-job-manager";
import { reactChatWindow } from "../windows/window-state";
import { logger, LogTag } from "../logger";

export interface ShellWakeService {
  /** 应用退出前调用：先停派发（对齐上游资源顺序约定）。 */
  dispose(): void;
}

/** 命令摘要：单行化 + 截断（通知可读性）。 */
function summarizeCommand(command: string): string {
  const oneLine = command.replace(/\s+/g, " ").trim();
  return oneLine.length > 60 ? oneLine.slice(0, 57) + "…" : oneLine;
}

export function initShellWakeService(): ShellWakeService {
  const unsubscribe = subscribeShellJobTerminal((evt: ShellJobTerminalEvent) => {
    const win = reactChatWindow;
    if (!win || win.isDestroyed()) return;
    try {
      win.webContents.send(IPC.SHELL_JOB_TERMINAL, {
        jobId: evt.jobId,
        status: evt.status,
        exitCode: evt.exitCode,
        reason: evt.reason,
        command: summarizeCommand(evt.command),
        logFile: evt.logFile,
      });
    } catch (err) {
      logger.warn(LogTag.BuiltinTools, "[shell-wake] 通知派发失败:", err);
    }
  });
  logger.info(LogTag.BuiltinTools, "[shell-wake] 终态通知服务已挂载");
  return {
    dispose() {
      // 先停派发再清理：与上游"退出时先停通知派发，再清理 Shell"同序
      clearShellJobTerminalSubscribers();
      unsubscribe();
    },
  };
}

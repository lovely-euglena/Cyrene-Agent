// 聊天窗空闲回收：最小化后的聊天窗（渲染进程实测 ~165MB 私有 / ~316MB 工作集）
// 在无人使用时保持常驻没有意义。最小化 + 连续 CHAT_IDLE_RECLAIM_MS 未被
// 恢复/聚焦 → 销毁窗口（连同渲染进程）；下次「打开聊天」由惰性 handle
// （createLazyReactChatWindowHandle）自动重建并重新加载页面。
//
// 语义边界：
// - 只认「最小化」：窗口可见但被其他窗口遮挡时销毁会让用户觉得窗口莫名消失。
// - 计时期间任何 restore / focus / show 都会取消；销毁前再核实一次 isMinimized。
// - 正在生成的回复随窗口销毁而不可见（会话数据由宿主侧持久化，重开可恢复）；
//   15 分钟的窗口足够覆盖「最小化后忘了关」的场景。
// - 调参/实测：环境变量 CYRENE_CHAT_IDLE_RECLAIM_MS 可覆盖时长（毫秒，>=1000）。
import type { BrowserWindow } from "electron";

/** 默认空闲回收时长：最小化后 15 分钟。 */
export const CHAT_IDLE_RECLAIM_MS = 15 * 60_000;

/** 读取空闲回收时长（测试/手动验证可用环境变量覆盖）。 */
export function resolveChatIdleReclaimMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.CYRENE_CHAT_IDLE_RECLAIM_MS);
  return Number.isFinite(raw) && raw >= 1000 ? raw : CHAT_IDLE_RECLAIM_MS;
}

/**
 * 给聊天窗挂上空闲回收。返回取消函数（测试与手动拆卸用）。
 * 传入的窗口销毁后无需手动取消：closed 事件会清掉计时器。
 */
export function attachChatIdleReclaim(
  window: BrowserWindow,
  delayMs: number = resolveChatIdleReclaimMs(),
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const cancel = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
  const schedule = (): void => {
    cancel();
    timer = setTimeout(() => {
      timer = null;
      if (window.isDestroyed() || !window.isMinimized()) return;
      console.info(
        `[ChatWindow] 最小化空闲 ${Math.round(delayMs / 60_000)} 分钟，销毁聊天窗释放渲染进程（下次打开重建）`,
      );
      window.destroy();
    }, delayMs);
    // 计时器不阻止进程退出
    if (typeof timer.unref === "function") timer.unref();
  };
  window.on("minimize", schedule);
  window.on("restore", cancel);
  window.on("focus", cancel);
  window.on("show", cancel);
  window.on("closed", cancel);
  return cancel;
}

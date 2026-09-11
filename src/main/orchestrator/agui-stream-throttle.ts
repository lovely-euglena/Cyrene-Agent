// AGUI 流式事件节流器：固定 100ms 批量吐 token。
//
// 背景：LLM 流式输出单 token 事件频率可达每 tick 数十条，逐条
// IPC → 渲染层（巨型消息列表组件）全量重渲染——聊天窗口卡的主因。
//
// 行为：
//   - CONTENT 类（TEXT_MESSAGE_CONTENT / THINKING_TEXT_MESSAGE_CONTENT /
//     REASONING_MESSAGE_CONTENT）按 messageId 分组，窗口内 delta 拼接成
//     单事件，每 100ms flush 一次（渲染层零改动——delta 语义天然可合并）
//   - 终态类（*_END / RUN_FINISHED / RUN_ERROR）触发立即 flush 后投递，
//     保证「CONTENT 先于对应 END」的顺序约束（渲染端按 END 收尾）
//   - 其他控制类（START/TOOL/RUN_STARTED 等）不攒立即投递
//   - 不可见谓词：flush 到期时目标窗口不可见 → 本轮不吐（数据留在
//     缓冲，等可见性恢复后的下一轮/终态强制 flush——后台不烧渲染）
//
// 非目标：不重排、不改语义、不丢事件；crash 恢复由 run 终态的
// 强制 flush 兜底（flush 是幂等的）。

export interface AguiStreamThrottle {
  /** 尝试入批。返回 true=已入批（或已触发 flush 链）；false=调用方立即投递。 */
  offer(event: unknown): boolean;
  /** 强制 flush（run 终态/错误路径兜底，无视可见性谓词）。幂等。 */
  flush(): void;
  /** 设置投递回调（flush 时批量调用）。 */
  setDeliver(deliver: (events: unknown[]) => void): void;
  /** 设置目标可见性谓词（false=flush 暂缓）。 */
  setTargetVisible(visible: () => boolean): void;
  dispose(): void;
}

const CONTENT_TYPES = new Set([
  "TEXT_MESSAGE_CONTENT",
  "THINKING_TEXT_MESSAGE_CONTENT",
  "REASONING_MESSAGE_CONTENT",
]);

/** 到达即先 flush（保序）再放行的终态类。 */
const BARRIER_TYPES = new Set([
  "TEXT_MESSAGE_END",
  "THINKING_TEXT_MESSAGE_END",
  "REASONING_MESSAGE_END",
  "RUN_FINISHED",
  "RUN_ERROR",
  "TEXT_MESSAGE_START",
  "THINKING_TEXT_MESSAGE_START",
]);

const FLUSH_INTERVAL_MS = 100;

interface PendingContent {
  event: Record<string, unknown>;
  /** 同 messageId 的 delta 拼接缓冲。 */
  delta: string;
}

export function createAguiStreamThrottle(now: () => number = () => Date.now()): AguiStreamThrottle {
  const pending = new Map<string, PendingContent>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let deliver: ((events: unknown[]) => void) | null = null;
  let targetVisible: () => boolean = () => true;

  const flushLocked = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (pending.size === 0) return;
    const events: Record<string, unknown>[] = [];
    for (const p of pending.values()) {
      events.push({ ...p.event, delta: p.delta });
    }
    pending.clear();
    // 空串防御：组内可能 flush 出空 delta（例如仅到达 END）——不发空事件
    const nonEmpty = events.filter((e) => typeof e.delta !== "string" || e.delta.length > 0);
    if (nonEmpty.length > 0) deliver?.(nonEmpty);
  };

  const onTimer = (): void => {
    timer = null;
    // 不可见：本轮不吐（缓冲保留，下一条内容事件重启定时器）
    if (!targetVisible()) return;
    flushLocked();
  };

  const scheduleTimer = (): void => {
    if (timer !== null) return;
    timer = setTimeout(onTimer, FLUSH_INTERVAL_MS);
  };

  return {
    offer(event: unknown): boolean {
      if (!event || typeof event !== "object") return false;
      const record = event as Record<string, unknown>;
      const type = record.type;

      if (typeof type === "string" && CONTENT_TYPES.has(type) && typeof record.delta === "string") {
        const messageId = String(record.messageId ?? `anon-${type}`);
        const existing = pending.get(messageId);
        if (existing) {
          existing.delta += record.delta as string;
        } else {
          pending.set(messageId, { event: record, delta: record.delta as string });
        }
        scheduleTimer();
        return true;
      }

      // 终态/START 屏障：先 flush 攒批再放行（保序）
      if (typeof type === "string" && BARRIER_TYPES.has(type)) {
        flushLocked();
        return false; // 调用方立即投递
      }

      // 其他控制类：立即投递（不攒）
      return false;
    },

    flush(): void {
      flushLocked();
    },

    setDeliver(fn: (events: unknown[]) => void): void {
      deliver = fn;
    },

    setTargetVisible(fn: () => boolean): void {
      targetVisible = fn;
    },

    dispose(): void {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      flushLocked();
      deliver = null;
    },
  };
}

// 显式绑定到 agui-bridge 的工厂名（保持桥层调用点简洁）
export { createAguiStreamThrottle as createStreamingThrottle };

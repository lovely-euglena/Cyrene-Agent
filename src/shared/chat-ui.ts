// 聊天会话列表 UI 层共享代码（settings 💬面板 + react chat 窗口侧栏 都用）。
//
// 这里只放纯展示相关的类型/常量/纯函数——不涉及任何 DOM 构建，
// 因为两个入口的 DOM 结构和交互不同（settings=跨窗口 openInReactChatWindow，
// chat=本地 loadSessionIntoUI），各自 build，但时间格式化/类型/默认标签统一。

/** 对话列表排序口径（#194）：last-opened=打开会话即算（默认）；last-message=发消息才算（旧行为）。 */
export type ConversationSortMode = "last-opened" | "last-message";

/**
 * #194：排序时间键。last-opened 口径回落 updatedAt（旧会话/从未记录打开时间）；
 * last-message 口径直接用 updatedAt（旧行为，仅消息写入刷新）。
 */
export function conversationSortTimeKey(
  meta: { lastOpenedAt?: number; updatedAt: number },
  mode: ConversationSortMode,
): number {
  return mode === "last-opened" ? (meta.lastOpenedAt ?? meta.updatedAt) : meta.updatedAt;
}

/** #196：「全部」视图时间分桶。 */
export type ConversationTimeBucket = "today" | "yesterday" | "last7" | "older";

/**
 * #196：按本地自然日分桶（今天/昨天/最近 7 天/更早）。
 * 边界：now-at < 24h 但跨自然日的归 yesterday 之前的 today 判断在前——即以自然日为准，
 * 「最近 7 天」= 距今不足 7 个自然日（不含今天/昨天）。
 */
export function conversationTimeBucket(at: number, now: number = Date.now()): ConversationTimeBucket {
  const startOfDay = (ts: number): number => {
    const d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  const today = startOfDay(now);
  if (at >= today) return "today";
  if (at >= today - 86_400_000) return "yesterday";
  if (at >= today - 7 * 86_400_000) return "last7";
  return "older";
}

/** #194：非法口径回落「打开就算」。 */
export function normalizeConversationSortMode(value: unknown): ConversationSortMode {
  return value === "last-message" ? "last-message" : "last-opened";
}

export interface ChatSessionMetaUI {
  id: string;
  title: string;
  identityId: string | null;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  purpose?: "proactive-chat";
  mode: "chat" | "work" | "code" | "learn";
}

// 默认 identity 显示名（职位面板未做，所有会话先用这个）

// 微信式相对时间：刚刚 / N 分钟前 / 今天 HH:mm / 昨天 HH:mm / N 天前 / MM-DD / YYYY-MM-DD
export function formatChatRelativeTime(at: number): string {
  const now = Date.now();
  const diff = now - at;
  if (diff < 0) {
    // 极少见的时钟回拨：直接降级到绝对时间
    const d = new Date(at);
    return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  if (diff < 60_000) return "刚刚";
  if (diff < 60 * 60_000) return Math.floor(diff / 60_000) + " 分钟前";

  const target = new Date(at);
  const today = new Date();
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dayDiff = Math.floor((startOfDay(today) - startOfDay(target)) / (24 * 3600 * 1000));

  const hh = String(target.getHours()).padStart(2, "0");
  const mm = String(target.getMinutes()).padStart(2, "0");
  if (dayDiff === 0) return `今天 ${hh}:${mm}`;
  if (dayDiff === 1) return `昨天 ${hh}:${mm}`;
  if (dayDiff < 7) return `${dayDiff} 天前`;

  const sameYear = target.getFullYear() === today.getFullYear();
  const md = `${String(target.getMonth() + 1).padStart(2, "0")}-${String(target.getDate()).padStart(2, "0")}`;
  return sameYear ? md : `${target.getFullYear()}-${md}`;
}

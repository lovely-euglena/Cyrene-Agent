/** 极简 DOM 构造助手（PWA 无运行时依赖；文本一律走 textContent，避免 XSS）。 */

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: Array<Node | string | null | undefined>
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else node.setAttribute(key, value);
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

export function setHidden(node: HTMLElement, hidden: boolean): void {
  node.hidden = hidden;
}

/** 时间戳 → 本地短格式（今天 HH:mm；跨天 M/D HH:mm）。 */
export function formatTime(ts: string | null): string {
  if (!ts) return "";
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  if (date.toDateString() === now.toDateString()) return `${hh}:${mm}`;
  return `${date.getMonth() + 1}/${date.getDate()} ${hh}:${mm}`;
}
